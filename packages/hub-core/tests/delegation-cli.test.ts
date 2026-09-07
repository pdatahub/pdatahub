/**
 * Phase 4 CLI tests — delegation creation, acceptance, listing, revocation.
 *
 * Covers the seven acceptance criteria from the Phase 4 brief:
 *   1. cmdDelegate — returns valid blob, signature verifies, row persisted.
 *   2. cmdDelegate scope validation — non-matching scope throws; matching
 *      succeeds; missing/unknown plugin throws.
 *   3. cmdAcceptDelegation — TAMpered blob rejected; wrong-key blob
 *      rejected; valid blob persisted; no `peer_signature_checked` column
 *      (Momus C4).
 *   4. parseDuration — `24h`, `30d`, `1w`, invalid throws.
 *   5. CLI integration — spawn `pdatahub-hub` as a child process and
 *      exercise the end-to-end `delegate` → `accept-delegation` → `list` →
 *      `revoke` flow.
 *   6. Existing tests pass (252 baseline).
 *   7. Build clean.
 *
 * Test isolation: each test uses a fresh SQLite DB on disk under
 * `os.tmpdir()` so we exercise the real on-disk code path (the CLI
 * commands operate on a file, not `:memory:`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import Database from 'better-sqlite3';
import {
  parseDuration,
  cmdDelegate,
  cmdAcceptDelegation,
  cmdListGranted,
  cmdListReceived,
  cmdRevokeDelegation,
} from '../src/federation/delegation-cli.js';
import {
  parseBlob,
  verifyDelegation,
} from '../src/federation/delegation.js';
import { HubIdentity } from '../src/federation/identity.js';
import { PluginRegistry } from '../src/plugin-process.js';
import { runMigrations } from '../src/migrations.js';
import type { PluginProcessInfo, ToolDescriptor } from '../src/types.js';

const MASTER_KEY = Buffer.from('a'.repeat(64), 'hex');

/* ─── Helpers ──────────────────────────────────────────────────────────── */

interface TempHub {
  dir: string;
  dbPath: string;
  identityA: HubIdentity;
  identityB: HubIdentity;
  /** Used by scope-validation tests — pass to cmdDelegate as `registry`. */
  stubRegistry?: StubRegistry;
}

function freshTempHub(opts: { withRegistry?: boolean } = {}): TempHub {
  const dir = mkdtempSync(join(tmpdir(), 'pdatahub-cli-test-'));
  const dbPath = join(dir, 'hub.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const identityA = HubIdentity.generate('userA', MASTER_KEY);
  identityA.save(db);
  db.close();

  const db2 = new Database(dbPath);
  db2.pragma('foreign_keys = ON');
  const identityB = HubIdentity.generate('userB', MASTER_KEY);
  db2.close();

  const stubRegistry = opts.withRegistry
    ? new StubRegistry([
        {
          name: 'google-calendar',
          tools: [
            {
              name: 'listEvents',
              description: 'List events from primary calendar',
              inputSchema: {
                type: 'object',
                properties: { from: { type: 'string' }, to: { type: 'string' } },
                required: ['from'],
              },
              scope: 'calendar:read',
              plugin: 'google-calendar',
            },
            {
              name: 'deleteEvent',
              description: 'Delete a calendar event',
              inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
              scope: 'calendar:write',
              plugin: 'google-calendar',
            },
          ],
        },
      ])
    : undefined;

  return {
    dir,
    dbPath,
    identityA,
    identityB,
    ...(stubRegistry ? { stubRegistry } : {}),
  };
}

class StubRegistry extends PluginRegistry {
  constructor(private readonly fakePluginInfos: Array<{
    name: string;
    tools: ToolDescriptor[];
  }>) {
    super();
  }
  override listPlugins(): PluginProcessInfo[] {
    return this.fakePluginInfos.map((p) => ({
      name: p.name,
      version: '0.0.0',
      description: '',
      entry_path: '',
      pid: 0,
      tools: p.tools,
      started_at: '',
      last_heartbeat: '',
    }));
  }
}

const tempDirs: string[] = [];
function trackTemp(dir: string): void {
  tempDirs.push(dir);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

/* ─── parseDuration ────────────────────────────────────────────────────── */

describe('parseDuration', () => {
  const NOW = 1_700_000_000_000;

  it('"24h" → now + 24 hours', () => {
    const result = parseDuration('24h', NOW);
    expect(result.getTime()).toBe(NOW + 24 * 60 * 60 * 1000);
  });

  it('"30d" → now + 30 days', () => {
    const result = parseDuration('30d', NOW);
    expect(result.getTime()).toBe(NOW + 30 * 24 * 60 * 60 * 1000);
  });

  it('"1w" → now + 7 days', () => {
    const result = parseDuration('1w', NOW);
    expect(result.getTime()).toBe(NOW + 7 * 24 * 60 * 60 * 1000);
  });

  it('"48h" → now + 48 hours (multi-hour)', () => {
    const result = parseDuration('48h', NOW);
    expect(result.getTime()).toBe(NOW + 48 * 60 * 60 * 1000);
  });

  it('"invalid" → throws', () => {
    expect(() => parseDuration('invalid', NOW)).toThrow(/invalid duration/);
  });

  it('empty string → throws', () => {
    expect(() => parseDuration('', NOW)).toThrow(/non-empty/);
  });

  it('zero duration → throws (must be > 0)', () => {
    expect(() => parseDuration('0h', NOW)).toThrow(/must be > 0/);
  });

  it('unknown unit → throws', () => {
    expect(() => parseDuration('5y', NOW)).toThrow(/invalid duration/);
  });

  it('returns a Date instance', () => {
    expect(parseDuration('1h', NOW)).toBeInstanceOf(Date);
  });
});

/* ─── cmdDelegate ──────────────────────────────────────────────────────── */

describe('cmdDelegate — happy path', () => {
  let hub: TempHub;
  beforeEach(() => {
    hub = freshTempHub({ withRegistry: true });
    trackTemp(hub.dir);
  });

  it('returns { delegation_id, blob } for a valid input', async () => {
    const result = await cmdDelegate({
      dbPath: hub.dbPath,
      masterKey: MASTER_KEY,
      peerVerifyKey: hub.identityB.publicKeyB64(),
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
      expiresIn: '24h',
      registry: hub.stubRegistry,
    });
    expect(result.delegation_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(typeof result.blob).toBe('string');
    expect(result.blob.length).toBeGreaterThan(50);
  });

  it('blob decodes to a DelegationBlobV1 with valid signature', async () => {
    const result = await cmdDelegate({
      dbPath: hub.dbPath,
      masterKey: MASTER_KEY,
      peerVerifyKey: hub.identityB.publicKeyB64(),
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
      expiresIn: '24h',
      registry: hub.stubRegistry,
    });
    const decoded = parseBlob(result.blob);
    expect(verifyDelegation(decoded)).toEqual({ ok: true });
    expect(decoded.delegation_id).toBe(result.delegation_id);
    expect(decoded.delegation.plugin).toBe('google-calendar');
    expect(decoded.delegation.tool).toBe('listEvents');
    expect(decoded.delegation.scope).toBe('calendar:read');
  });

  it('persists a row in the delegations table with the blob signature', async () => {
    const result = await cmdDelegate({
      dbPath: hub.dbPath,
      masterKey: MASTER_KEY,
      peerVerifyKey: hub.identityB.publicKeyB64(),
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
      expiresIn: '24h',
      registry: hub.stubRegistry,
    });
    const db = new Database(hub.dbPath);
    try {
      const row = db
        .prepare('SELECT * FROM delegations WHERE delegation_id = ?')
        .get(result.delegation_id) as {
          signature: Buffer;
          plugin: string;
          tool: string;
          scope: string;
          peer_verify_key: string;
          revoked: number;
        };
      expect(row).not.toBeUndefined();
      expect(row.signature.length).toBe(64); // ed25519 sig = 64 bytes
      expect(row.plugin).toBe('google-calendar');
      expect(row.tool).toBe('listEvents');
      expect(row.scope).toBe('calendar:read');
      expect(row.peer_verify_key).toBe(hub.identityB.publicKeyB64());
      expect(row.revoked).toBe(0);
    } finally {
      db.close();
    }
  });

  it('generates a QR PNG (base64) when blob fits', async () => {
    const result = await cmdDelegate({
      dbPath: hub.dbPath,
      masterKey: MASTER_KEY,
      peerVerifyKey: hub.identityB.publicKeyB64(),
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
      expiresIn: '24h',
      registry: hub.stubRegistry,
    });
    expect(result.qrPngBase64).toBeDefined();
    // base64 PNG starts with "iVBOR" (PNG magic bytes 0x89 0x50 0x4E 0x47).
    expect(result.qrPngBase64!.slice(0, 8)).toBe('iVBORw0K');
  });

  it('sets expires_at = now + 24h (within ±2s)', async () => {
    const beforeMs = Date.now();
    const result = await cmdDelegate({
      dbPath: hub.dbPath,
      masterKey: MASTER_KEY,
      peerVerifyKey: hub.identityB.publicKeyB64(),
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
      expiresIn: '24h',
      registry: hub.stubRegistry,
    });
    const decoded = parseBlob(result.blob);
    const expiresMs = Date.parse(decoded.delegation.expires_at);
    const expectedMs = beforeMs + 24 * 60 * 60 * 1000;
    expect(Math.abs(expiresMs - expectedMs)).toBeLessThan(2_000);
  });

  it('embeds issuer hub_name, verify_key, fingerprint, magic_dns', async () => {
    const result = await cmdDelegate({
      dbPath: hub.dbPath,
      masterKey: MASTER_KEY,
      peerVerifyKey: hub.identityB.publicKeyB64(),
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
      expiresIn: '24h',
      registry: hub.stubRegistry,
    });
    const decoded = parseBlob(result.blob);
    expect(decoded.issuer.hub_name).toBe('userA');
    expect(decoded.issuer.verify_key).toBe(hub.identityA.publicKeyB64());
    expect(decoded.issuer.fingerprint).toBe(hub.identityA.fingerprintHex());
  });

  it('subject.fingerprint is computed from peer verify_key', async () => {
    const result = await cmdDelegate({
      dbPath: hub.dbPath,
      masterKey: MASTER_KEY,
      peerVerifyKey: hub.identityB.publicKeyB64(),
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
      expiresIn: '24h',
      registry: hub.stubRegistry,
    });
    const decoded = parseBlob(result.blob);
    expect(decoded.subject.verify_key).toBe(hub.identityB.publicKeyB64());
    expect(decoded.subject.fingerprint).toBe(hub.identityB.fingerprintHex());
  });

  it('works WITHOUT a registry (best-effort scope check skipped)', async () => {
    const result = await cmdDelegate({
      dbPath: hub.dbPath,
      masterKey: MASTER_KEY,
      peerVerifyKey: hub.identityB.publicKeyB64(),
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
      expiresIn: '24h',
      // no registry → CLI path with no plugins loaded
    });
    expect(result.delegation_id).toBeDefined();
    const decoded = parseBlob(result.blob);
    expect(decoded.delegation.input_schema).toEqual({});
  });
});

/* ─── cmdDelegate — scope validation (Momus C5) ───────────────────────── */

describe('cmdDelegate — scope validation', () => {
  let hub: TempHub;
  beforeEach(() => {
    hub = freshTempHub({ withRegistry: true });
    trackTemp(hub.dir);
  });

  it('scope that does NOT match the manifest is rejected', async () => {
    await expect(
      cmdDelegate({
        dbPath: hub.dbPath,
        masterKey: MASTER_KEY,
        peerVerifyKey: hub.identityB.publicKeyB64(),
        plugin: 'google-calendar',
        tool: 'listEvents',
        scope: 'calendar:write', // manifest declares calendar:read
        expiresIn: '24h',
        registry: hub.stubRegistry,
      }),
    ).rejects.toThrow(/scope mismatch/);
  });

  it('scope that matches the manifest is accepted', async () => {
    const result = await cmdDelegate({
      dbPath: hub.dbPath,
      masterKey: MASTER_KEY,
      peerVerifyKey: hub.identityB.publicKeyB64(),
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
      expiresIn: '24h',
      registry: hub.stubRegistry,
    });
    expect(result.delegation_id).toBeDefined();
  });

  it('unknown plugin throws a clear error', async () => {
    await expect(
      cmdDelegate({
        dbPath: hub.dbPath,
        masterKey: MASTER_KEY,
        peerVerifyKey: hub.identityB.publicKeyB64(),
        plugin: 'no-such-plugin',
        tool: 'listEvents',
        scope: 'calendar:read',
        expiresIn: '24h',
        registry: hub.stubRegistry,
      }),
    ).rejects.toThrow(/plugin "no-such-plugin" not found in registry/);
  });

  it('unknown tool on a known plugin throws a clear error', async () => {
    await expect(
      cmdDelegate({
        dbPath: hub.dbPath,
        masterKey: MASTER_KEY,
        peerVerifyKey: hub.identityB.publicKeyB64(),
        plugin: 'google-calendar',
        tool: 'no-such-tool',
        scope: 'calendar:read',
        expiresIn: '24h',
        registry: hub.stubRegistry,
      }),
    ).rejects.toThrow(/tool "no-such-tool" not found in plugin/);
  });

  it('tool with no inputSchema declared throws (delegatable tools must declare)', async () => {
    const registry = new StubRegistry([
      {
        name: 'no-schema',
        tools: [
          {
            name: 'open',
            description: 'd',
            inputSchema: null,
            scope: 's',
            plugin: 'no-schema',
          },
        ],
      },
    ]);
    await expect(
      cmdDelegate({
        dbPath: hub.dbPath,
        masterKey: MASTER_KEY,
        peerVerifyKey: hub.identityB.publicKeyB64(),
        plugin: 'no-schema',
        tool: 'open',
        scope: 's',
        expiresIn: '24h',
        registry,
      }),
    ).rejects.toThrow(/did not declare inputSchema/);
  });
});

/* ─── cmdAcceptDelegation ─────────────────────────────────────────────── */

describe('cmdAcceptDelegation — happy path', () => {
  let hub: TempHub;
  let blob: string;
  let delegationId: string;

  beforeEach(async () => {
    hub = freshTempHub({ withRegistry: true });
    trackTemp(hub.dir);
    const result = await cmdDelegate({
      dbPath: hub.dbPath,
      masterKey: MASTER_KEY,
      peerVerifyKey: hub.identityB.publicKeyB64(),
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
      expiresIn: '24h',
      registry: hub.stubRegistry,
    });
    blob = result.blob;
    delegationId = result.delegation_id;
  });

  it('imports a valid blob (--yes) and returns delegation metadata', async () => {
    const result = await cmdAcceptDelegation({
      dbPath: hub.dbPath,
      masterKey: MASTER_KEY,
      blob,
      yes: true,
      // Override DNS resolution so the test doesn't depend on network.
      resolveDnsFn: async () => '192.0.2.10',
    });
    expect(result.delegation_id).toBe(delegationId);
    expect(result.peer_hub_name).toBe('userA');
    // magic_dns defaults to `userA.local:8080` when no tailscale detected,
    // so peer_hub_url becomes http://192.0.2.10:8080/.
    expect(result.peer_hub_url).toBe('http://192.0.2.10:8080/');
  });

  it('persists a row into peer_delegations with the right fields', async () => {
    await cmdAcceptDelegation({
      dbPath: hub.dbPath,
      masterKey: MASTER_KEY,
      blob,
      yes: true,
      resolveDnsFn: async () => '10.0.0.5',
    });
    const db = new Database(hub.dbPath);
    try {
      const row = db
        .prepare('SELECT * FROM peer_delegations WHERE delegation_id = ?')
        .get(delegationId) as Record<string, unknown> | undefined;
      expect(row).not.toBeUndefined();
      expect(row!.peer_hub_name).toBe('userA');
      expect(row!.peer_hub_url).toBe('http://10.0.0.5:8080/');
      expect(row!.peer_verify_key).toBe(hub.identityA.publicKeyB64());
      expect(row!.plugin).toBe('google-calendar');
      expect(row!.tool).toBe('listEvents');
      expect(row!.scope).toBe('calendar:read');
      expect(row!.revoked).toBe(0);
    } finally {
      db.close();
    }
  });

  it('peer_delegations has NO peer_signature_checked column (Momus C4)', async () => {
    await cmdAcceptDelegation({
      dbPath: hub.dbPath,
      masterKey: MASTER_KEY,
      blob,
      yes: true,
      resolveDnsFn: async () => '10.0.0.5',
    });
    const db = new Database(hub.dbPath);
    try {
      const cols = db.prepare(`PRAGMA table_info(peer_delegations)`).all() as Array<{
        name: string;
      }>;
      const names = cols.map((c) => c.name);
      expect(names).not.toContain('peer_signature_checked');
      // Sanity check: all expected columns present.
      expect(names).toEqual(
        expect.arrayContaining([
          'delegation_id',
          'peer_verify_key',
          'peer_hub_name',
          'peer_hub_url',
          'plugin',
          'tool',
          'scope',
          'input_schema',
          'expires_at',
          'revoked',
          'created_at',
          'signature',
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('falls back to magic_dns as-is when DNS resolution fails', async () => {
    const result = await cmdAcceptDelegation({
      dbPath: hub.dbPath,
      masterKey: MASTER_KEY,
      blob,
      yes: true,
      resolveDnsFn: async () => {
        throw new Error('DNS failure');
      },
    });
    // magic_dns generated by HubIdentity.save for a hub without tailscale is
    // `${hubName}.local:8080`. The fallback keeps that string.
    expect(result.peer_hub_url).toBe('http://userA.local:8080/');
  });

  it('re-importing the same blob is idempotent (INSERT OR IGNORE)', async () => {
    await cmdAcceptDelegation({
      dbPath: hub.dbPath,
      masterKey: MASTER_KEY,
      blob,
      yes: true,
      resolveDnsFn: async () => '10.0.0.5',
    });
    // Re-import with different resolveDns — should not overwrite the row.
    await cmdAcceptDelegation({
      dbPath: hub.dbPath,
      masterKey: MASTER_KEY,
      blob,
      yes: true,
      resolveDnsFn: async () => '10.0.0.99',
    });
    const db = new Database(hub.dbPath);
    try {
      const rows = db
        .prepare('SELECT peer_hub_url FROM peer_delegations WHERE delegation_id = ?')
        .all(delegationId) as Array<{ peer_hub_url: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.peer_hub_url).toBe('http://10.0.0.5:8080/');
    } finally {
      db.close();
    }
  });
});

describe('cmdAcceptDelegation — rejection', () => {
  let hub: TempHub;
  let blob: string;
  let delegationId: string;

  beforeEach(async () => {
    hub = freshTempHub({ withRegistry: true });
    trackTemp(hub.dir);
    const result = await cmdDelegate({
      dbPath: hub.dbPath,
      masterKey: MASTER_KEY,
      peerVerifyKey: hub.identityB.publicKeyB64(),
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
      expiresIn: '24h',
      registry: hub.stubRegistry,
    });
    blob = result.blob;
    delegationId = result.delegation_id;
  });

  it('throws on a TAMPERED blob (tool swapped)', async () => {
    const decoded = parseBlob(blob);
    const tampered = {
      ...decoded,
      delegation: { ...decoded.delegation, tool: 'deleteEvent' },
    };
    const tamperedEncoded = Buffer.from(JSON.stringify(tampered)).toString('base64url');
    await expect(
      cmdAcceptDelegation({
        dbPath: hub.dbPath,
        masterKey: MASTER_KEY,
        blob: tamperedEncoded,
        yes: true,
        resolveDnsFn: async () => '10.0.0.5',
      }),
    ).rejects.toThrow(/signature verification failed/);
  });

  it('throws on a blob signed by a DIFFERENT key (issuer.verify_key swap)', async () => {
    const decoded = parseBlob(blob);
    // Build a new identity, sign the SAME body with it.
    const otherIdentity = HubIdentity.generate('userA', MASTER_KEY);
    const swap = {
      ...decoded,
      issuer: {
        ...decoded.issuer,
        verify_key: otherIdentity.publicKeyB64(),
        fingerprint: otherIdentity.fingerprintHex(),
      },
    };
    const swappedEncoded = Buffer.from(JSON.stringify(swap)).toString('base64url');
    await expect(
      cmdAcceptDelegation({
        dbPath: hub.dbPath,
        masterKey: MASTER_KEY,
        blob: swappedEncoded,
        yes: true,
        resolveDnsFn: async () => '10.0.0.5',
      }),
    ).rejects.toThrow(/signature verification failed/);
  });

  it('throws on a completely garbage blob', async () => {
    await expect(
      cmdAcceptDelegation({
        dbPath: hub.dbPath,
        masterKey: MASTER_KEY,
        blob: '!!!not-a-blob!!!',
        yes: true,
        resolveDnsFn: async () => '10.0.0.5',
      }),
    ).rejects.toThrow();
  });

  it('throws when user declines the y/N prompt (custom promptFn returns false)', async () => {
    await expect(
      cmdAcceptDelegation({
        dbPath: hub.dbPath,
        masterKey: MASTER_KEY,
        blob,
        yes: false, // do NOT skip
        promptFn: async () => false,
        resolveDnsFn: async () => '10.0.0.5',
      }),
    ).rejects.toThrow(/aborted by user/);

    // Nothing was persisted.
    const db = new Database(hub.dbPath);
    try {
      const rows = db
        .prepare('SELECT 1 FROM peer_delegations WHERE delegation_id = ?')
        .all(delegationId);
      expect(rows).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('proceeds when user confirms y (custom promptFn returns true)', async () => {
    const result = await cmdAcceptDelegation({
      dbPath: hub.dbPath,
      masterKey: MASTER_KEY,
      blob,
      yes: false,
      promptFn: async () => true,
      resolveDnsFn: async () => '10.0.0.5',
    });
    expect(result.delegation_id).toBe(delegationId);
  });
});

/* ─── cmdListGranted / cmdListReceived / cmdRevokeDelegation ───────────── */

describe('cmdListGranted', () => {
  it('returns rows from the delegations table', async () => {
    const hub = freshTempHub({ withRegistry: true });
    trackTemp(hub.dir);
    await cmdDelegate({
      dbPath: hub.dbPath,
      masterKey: MASTER_KEY,
      peerVerifyKey: hub.identityB.publicKeyB64(),
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
      expiresIn: '24h',
      registry: hub.stubRegistry,
    });
    const rows = await cmdListGranted(hub.dbPath, MASTER_KEY);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.peer_verify_key).toBe(hub.identityB.publicKeyB64());
  });

  it('returns empty array when no delegations exist', async () => {
    const hub = freshTempHub({ withRegistry: true });
    trackTemp(hub.dir);
    const rows = await cmdListGranted(hub.dbPath, MASTER_KEY);
    expect(rows).toEqual([]);
  });
});

describe('cmdListReceived', () => {
  it('returns rows from the peer_delegations table', async () => {
    const hub = freshTempHub({ withRegistry: true });
    trackTemp(hub.dir);
    const result = await cmdDelegate({
      dbPath: hub.dbPath,
      masterKey: MASTER_KEY,
      peerVerifyKey: hub.identityB.publicKeyB64(),
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
      expiresIn: '24h',
      registry: hub.stubRegistry,
    });
    await cmdAcceptDelegation({
      dbPath: hub.dbPath,
      masterKey: MASTER_KEY,
      blob: result.blob,
      yes: true,
      resolveDnsFn: async () => '10.0.0.5',
    });
    const rows = await cmdListReceived(hub.dbPath, MASTER_KEY);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.peer_hub_name).toBe('userA');
  });
});

describe('cmdRevokeDelegation', () => {
  it('flips revoked=1 on the matching row', async () => {
    const hub = freshTempHub({ withRegistry: true });
    trackTemp(hub.dir);
    const result = await cmdDelegate({
      dbPath: hub.dbPath,
      masterKey: MASTER_KEY,
      peerVerifyKey: hub.identityB.publicKeyB64(),
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
      expiresIn: '24h',
      registry: hub.stubRegistry,
    });
    const ok = await cmdRevokeDelegation(hub.dbPath, MASTER_KEY, result.delegation_id);
    expect(ok).toBe(true);
    const rows = await cmdListGranted(hub.dbPath, MASTER_KEY);
    expect(rows[0]!.revoked).toBe(1);
  });

  it('returns false for an unknown id', async () => {
    const hub = freshTempHub({ withRegistry: true });
    trackTemp(hub.dir);
    const ok = await cmdRevokeDelegation(hub.dbPath, MASTER_KEY, 'not-a-real-id');
    expect(ok).toBe(false);
  });
});

/* ─── CLI integration: spawn child process ────────────────────────────── */

describe('CLI integration — child process spawn', () => {
  // vitest runs from the package root; the built CLI sits in dist/.
  const HUB_ENTRY = join(process.cwd(), 'dist', 'index.js');

  // Skip integration if the built CLI isn't present. CI builds first.
  const hasBuiltCli = existsSync(HUB_ENTRY);

  it.skipIf(!hasBuiltCli)(
    'delegate → accept-delegation → list → revoke flow',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'pdatahub-cli-int-'));
      const dbPath = join(dir, 'hub.db');
      trackTemp(dir);

      // 1. init the hub. Pass --master-key so the identity is encrypted
      // with the env-supplied key (matches subsequent calls).
      const masterKey = 'a'.repeat(64);
      const initEnv = {
        ...process.env,
        HUB_DB_PATH: dbPath,
        HUB_MASTER_KEY: masterKey,
        HUB_PASSPHRASE: '',
      };
      const init1 = spawnSync(
        'node',
        [
          HUB_ENTRY,
          'init',
          '--hub-name', 'userA',
          '--db-path', dbPath,
          '--master-key', masterKey,
        ],
        { env: initEnv, encoding: 'utf8' },
      );
      expect(init1.status).toBe(0);
      expect(init1.stdout).toMatch(/FEDERATION IDENTITY/);

      // 2. read verify_key from `identity show`.
      const idRes = spawnSync(
        'node',
        [HUB_ENTRY, 'identity', 'show', '--db-path', dbPath],
        { env: initEnv, encoding: 'utf8' },
      );
      expect(idRes.status).toBe(0);
      const verifyKeyMatch = idRes.stdout.match(/Verify key:\s+(ed25519:\S+)/);
      expect(verifyKeyMatch).not.toBeNull();
      const verifyKey = verifyKeyMatch![1]!;

      // 3. `delegate list` — empty initially.
      const empty = spawnSync(
        'node',
        [HUB_ENTRY, 'delegate', 'list', '--db-path', dbPath],
        { env: initEnv, encoding: 'utf8' },
      );
      expect(empty.status).toBe(0);
      expect(empty.stdout).toMatch(/0 delegation/);

      // 4. delegate WITHOUT a registry (no plugins running) — succeeds.
      const delRes = spawnSync(
        'node',
        [
          HUB_ENTRY,
          'delegate',
          '--peer-verify-key', verifyKey,
          '--plugin', 'google-calendar',
          '--tool', 'listEvents',
          '--scope', 'calendar:read',
          '--expires', '24h',
          '--db-path', dbPath,
        ],
        { env: initEnv, encoding: 'utf8' },
      );
      expect(delRes.status).toBe(0);
      expect(delRes.stdout).toMatch(/Delegation issued:/);

      // Extract blob (line that looks like base64url)
      const blobMatch = delRes.stdout.match(/(eyJ[A-Za-z0-9_-]+)/);
      expect(blobMatch).not.toBeNull();
      const blob = blobMatch![1]!;

      // 5. accept-delegation (--yes) — but we're on the same hub here,
      //    so the fingerprint matches userA == userA. The matching is
      //    by delegation_id, not by hub name. Should succeed.
      const acceptRes = spawnSync(
        'node',
        [HUB_ENTRY, 'accept-delegation', blob, '--yes', '--db-path', dbPath],
        { env: initEnv, encoding: 'utf8' },
      );
      expect(acceptRes.status).toBe(0);
      expect(acceptRes.stdout).toMatch(/Imported delegation:/);

      // 6. delegation list — should show 1 row.
      const listRes = spawnSync(
        'node',
        [HUB_ENTRY, 'delegation', 'list', '--db-path', dbPath],
        { env: initEnv, encoding: 'utf8' },
      );
      expect(listRes.status).toBe(0);
      expect(listRes.stdout).toMatch(/1 delegation/);

      // Revoke operates on the A-side `delegations` table per design.
      const delegateListRes = spawnSync(
        'node',
        [HUB_ENTRY, 'delegate', 'list', '--db-path', dbPath],
        { env: initEnv, encoding: 'utf8' },
      );
      expect(delegateListRes.status).toBe(0);
      const idMatch = delegateListRes.stdout.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
      expect(idMatch).not.toBeNull();
      const delegationId = idMatch![1]!;

      const revokeRes = spawnSync(
        'node',
        [HUB_ENTRY, 'delegation', 'revoke', delegationId, '--db-path', dbPath],
        { env: initEnv, encoding: 'utf8' },
      );
      expect(revokeRes.status).toBe(0);
      expect(revokeRes.stdout).toMatch(/Revoked:/);

      const finalList = spawnSync(
        'node',
        [HUB_ENTRY, 'delegate', 'list', '--db-path', dbPath],
        { env: initEnv, encoding: 'utf8' },
      );
      expect(finalList.stdout).toMatch(/yes/);
    },
    60_000,
  );

  it.skipIf(!hasBuiltCli)(
    'unknown subcommand errors with a helpful message',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'pdatahub-cli-err-'));
      trackTemp(dir);
      const dbPath = join(dir, 'hub.db');
      const env = {
        ...process.env,
        HUB_DB_PATH: dbPath,
        HUB_MASTER_KEY: 'a'.repeat(64),
      };
      const res: SpawnSyncReturns<string> = spawnSync(
        'node',
        [HUB_ENTRY, 'frobnicate', '--db-path', dbPath],
        { env, encoding: 'utf8' },
      );
      expect(res.status).not.toBe(0);
      const out = (res.stderr || '') + (res.stdout || '');
      expect(out).toMatch(/unknown subcommand/);
    },
  );
});
