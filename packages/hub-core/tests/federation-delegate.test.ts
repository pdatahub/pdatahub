/**
 * Phase 4 (Federation v2) — `POST /v1/federation/delegate`,
 * `GET /v1/federation/delegations`, `POST /v1/federation/delegations/:id/revoke`.
 *
 * Tests the A-side delegation management endpoints that were missing
 * before commit `d2c19cd`. Without these endpoints, users had no way to
 * create/list/revoke delegations end-to-end (only test fixtures calling
 * `DelegationStore.createGranted()` directly).
 *
 * Coverage:
 *   - delegate: happy path, scope mismatch, unknown tool, invalid
 *     pubkey, past expires_at, missing fields
 *   - list: empty, after create
 *   - revoke: valid id, unknown id, idempotency
 *   - blob integrity: signature is valid Ed25519 over canonical JSON
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { request as undiciRequest } from 'undici';
import { HubServer } from '../src/server.js';
import { AuditLog } from '../src/audit-log.js';
import { TokenVault } from '../src/token-vault.js';
import { OAuthFlow } from '../src/oauth-flow.js';
import { ApprovalStream } from '../src/approval-stream.js';
import { PluginRegistry, type PluginProcess, type ToolCallResult } from '../src/plugin-process.js';
import { loadConfig } from '../src/config.js';
import { runMigrations } from '../src/migrations.js';
import { HubIdentity } from '../src/federation/identity.js';
import {
  DelegationStore,
  parseBlob,
  verifyDelegation,
} from '../src/federation/delegation.js';
import { NonceStore } from '../src/federation/nonces.js';
import type { PluginProcessInfo, ToolDescriptor } from '../src/types.js';

const TEST_TOKEN = 'test-bearer-delegate';
const MASTER_KEY = Buffer.from('a'.repeat(64), 'hex');

interface FakePluginOpts {
  name: string;
  tools: ToolDescriptor[];
  callToolImpl?: (name: string, args: Record<string, unknown>) => Promise<ToolCallResult>;
}

function fakePlugin(opts: FakePluginOpts): PluginProcess {
  const info: PluginProcessInfo = {
    name: opts.name,
    version: '0.0.0',
    description: '',
    entry_path: '',
    pid: 0,
    tools: opts.tools,
    started_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
  };
  const callTool = opts.callToolImpl ?? (async () => ({
    data: { ok: true },
  }));
  return {
    getInfo: () => info,
    callTool: (name, args) => callTool(name, args),
    shutdown: async () => undefined,
  } as unknown as PluginProcess;
}

class FakeRegistry extends PluginRegistry {
  private readonly byTool = new Map<string, PluginProcess>();
  add(p: PluginProcess): void {
    const info = p.getInfo();
    this.byTool.set(info.name, p);
    for (const t of info.tools) this.byTool.set(t.name, p);
  }
  override getPlugin(toolName: string): PluginProcess | null {
    return this.byTool.get(toolName) ?? null;
  }
  override listPlugins(): PluginProcessInfo[] {
    return Array.from(new Set(this.byTool.values())).map((p) => p.getInfo());
  }
  override listAllTools(): ToolDescriptor[] {
    const out: ToolDescriptor[] = [];
    const seen = new Set<string>();
    for (const p of this.byTool.values()) {
      if (seen.has(p.getInfo().name)) continue;
      seen.add(p.getInfo().name);
      out.push(...p.getInfo().tools);
    }
    return out;
  }
  override async shutdownAll(): Promise<void> {
    /* no-op */
  }
}

interface Harness {
  server: HubServer;
  registry: FakeRegistry;
  delegations: DelegationStore;
  identity: HubIdentity;
  port: number;
  db: Database.Database;
}

async function setupHarness(): Promise<Harness> {
  process.env.HUB_API_TOKEN = TEST_TOKEN;
  process.env.HUB_MASTER_KEY = MASTER_KEY.toString('hex');
  delete process.env.HUB_MASTER_KEY_FILE;
  const db = new Database(':memory:');
  runMigrations(db);

  const registry = new FakeRegistry();
  const audit = new AuditLog(db);
  const tokens = new TokenVault(db, MASTER_KEY);
  const oauth = new OAuthFlow(db, tokens, MASTER_KEY);
  const approval = new ApprovalStream(db);
  const delegations = new DelegationStore(db);
  const nonces = new NonceStore(db);
  const identity = HubIdentity.generate('userA', MASTER_KEY);
  identity.save(db);

  const config = loadConfig({ HUB_API_TOKEN: TEST_TOKEN });
  config.masterKey = MASTER_KEY;
  config.port = 0;
  config.host = '127.0.0.1';
  config.pluginsDir = '/tmp';

  const server = new HubServer({
    config,
    db,
    registry,
    grants: {} as never,
    audit,
    tokens,
    oauth,
    approval,
    clientCredentials: new Map(),
    delegations,
    nonces,
  });

  registry.add(
    fakePlugin({
      name: 'google-calendar',
      tools: [
        {
          name: 'listEvents',
          scope: 'calendar:read',
          description: 'List events',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'createEvent',
          scope: 'calendar:write',
          description: 'Create event',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    }),
  );

  await server.start();
  const addr = server.address();
  if (!addr) throw new Error('server failed to bind');

  return { server, registry, delegations, identity, port: addr.port, db };
}

async function teardownHarness(h: Harness): Promise<void> {
  await h.server.stop();
  h.db.close();
}

async function post(h: Harness, path: string, body: unknown): Promise<{
  status: number;
  body: unknown;
}> {
  const res = await undiciRequest(`http://127.0.0.1:${h.port}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  let parsed: unknown = null;
  try {
    parsed = await res.body.json();
  } catch {
    /* ignore */
  }
  return { status: res.statusCode, body: parsed };
}

async function get(
  h: Harness,
  path: string,
  withAuth = true,
): Promise<{ status: number; body: unknown }> {
  const res = await undiciRequest(`http://127.0.0.1:${h.port}${path}`, {
    method: 'GET',
    headers: withAuth ? { authorization: `Bearer ${TEST_TOKEN}` } : {},
  });
  let parsed: unknown = null;
  try {
    parsed = await res.body.json();
  } catch {
    /* ignore */
  }
  return { status: res.statusCode, body: parsed };
}

const futureIso = (ms: number): string =>
  new Date(Date.now() + ms).toISOString();

describe('POST /v1/federation/delegate', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setupHarness();
  });
  afterEach(async () => {
    await teardownHarness(h);
  });

  it('valid request returns 200 with delegation_id + signed blob', async () => {
    const res = await post(h, '/v1/federation/delegate', {
      peer_verify_key: 'ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      peer_hub_name: 'userB',
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
      expires_at: futureIso(60 * 60_000),
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      delegation_id: string;
      blob: string;
      issuer: { hub_name: string; verify_key: string; fingerprint: string };
    };
    expect(body.delegation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.blob).toBeTruthy();
    expect(body.issuer.hub_name).toBe('userA');

    // Decode + verify signature.
    const blobJson = Buffer.from(body.blob, 'base64url').toString('utf8');
    const parsed = parseBlob(body.blob);
    expect(parsed.version).toBe(1);
    expect(parsed.delegation_id).toBe(body.delegation_id);
    expect(parsed.issuer.verify_key).toBe(h.identity.publicKeyB64());

    // Verify Ed25519 signature over canonical JSON.
    const verification = verifyDelegation(parsed);
    expect(verification.ok).toBe(true);

    // Persisted to delegations table.
    const row = h.delegations.getGranted(body.delegation_id);
    expect(row).not.toBeNull();
    expect(row!.plugin).toBe('google-calendar');
    expect(row!.tool).toBe('listEvents');
    expect(row!.revoked).toBe(0);

    // No blob JSON garbage.
    expect(blobJson).toContain(body.delegation_id);
  });

  it('rejects missing fields with INVALID_BODY', async () => {
    const res = await post(h, '/v1/federation/delegate', {
      peer_verify_key: 'ed25519:AAA',
      plugin: 'google-calendar',
    });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('INVALID_BODY');
  });

  it('rejects peer_verify_key without ed25519: prefix', async () => {
    const res = await post(h, '/v1/federation/delegate', {
      peer_verify_key: 'base64stringwithoutprefix',
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
      expires_at: futureIso(60 * 60_000),
    });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('INVALID_PUBKEY');
  });

  it('rejects past expires_at', async () => {
    const res = await post(h, '/v1/federation/delegate', {
      peer_verify_key: 'ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('EXPIRED_AT_IN_PAST');
  });

  it('rejects unparseable expires_at', async () => {
    const res = await post(h, '/v1/federation/delegate', {
      peer_verify_key: 'ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
      expires_at: 'not-a-date',
    });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('INVALID_TIMESTAMP');
  });

  it('rejects scope mismatch (Momus C5)', async () => {
    const res = await post(h, '/v1/federation/delegate', {
      peer_verify_key: 'ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:write',
      expires_at: futureIso(60 * 60_000),
    });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('SCOPE_MISMATCH');
  });

  it('rejects plugin name mismatch with tool', async () => {
    const res = await post(h, '/v1/federation/delegate', {
      peer_verify_key: 'ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      plugin: 'wrong-plugin',
      tool: 'listEvents',
      scope: 'calendar:read',
      expires_at: futureIso(60 * 60_000),
    });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('PLUGIN_MISMATCH');
  });

  it('rejects unknown tool', async () => {
    const res = await post(h, '/v1/federation/delegate', {
      peer_verify_key: 'ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      plugin: 'google-calendar',
      tool: 'phantomTool',
      scope: 'calendar:read',
      expires_at: futureIso(60 * 60_000),
    });
    expect(res.status).toBe(404);
    expect((res.body as { code: string }).code).toBe('UNKNOWN_TOOL');
  });

  it('rejects without auth (Bearer token missing)', async () => {
    const res = await undiciRequest(
      `http://127.0.0.1:${h.port}/v1/federation/delegate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ peer_verify_key: 'ed25519:AAA' }),
      },
    );
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /v1/federation/delegations', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setupHarness();
  });
  afterEach(async () => {
    await teardownHarness(h);
  });

  it('returns empty list when no delegations', async () => {
    const res = await get(h, '/v1/federation/delegations');
    expect(res.status).toBe(200);
    expect((res.body as { delegations: unknown[] }).delegations).toEqual([]);
  });

  it('returns list with one entry after create', async () => {
    const created = await post(h, '/v1/federation/delegate', {
      peer_verify_key: 'ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      peer_hub_name: 'userB',
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
      expires_at: futureIso(60 * 60_000),
    });
    expect(created.status).toBe(200);

    const res = await get(h, '/v1/federation/delegations');
    expect(res.status).toBe(200);
    const body = res.body as {
      delegations: Array<{
        delegation_id: string;
        peer_verify_key: string;
        peer_hub_name: string | null;
        plugin: string;
        tool: string;
        scope: string;
        expires_at: string;
        revoked: number;
      }>;
    };
    expect(body.delegations).toHaveLength(1);
    expect(body.delegations[0]!.plugin).toBe('google-calendar');
    expect(body.delegations[0]!.tool).toBe('listEvents');
    expect(body.delegations[0]!.scope).toBe('calendar:read');
    expect(body.delegations[0]!.revoked).toBe(0);
    expect(body.delegations[0]!.peer_hub_name).toBe('userB');
  });

  it('rejects without auth', async () => {
    const res = await get(h, '/v1/federation/delegations', false);
    expect(res.status).toBe(401);
  });
});

describe('POST /v1/federation/delegations/:id/revoke', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setupHarness();
  });
  afterEach(async () => {
    await teardownHarness(h);
  });

  it('revokes existing delegation and returns 200', async () => {
    const created = await post(h, '/v1/federation/delegate', {
      peer_verify_key: 'ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
      expires_at: futureIso(60 * 60_000),
    });
    const delegationId = (created.body as { delegation_id: string }).delegation_id;

    const res = await post(
      h,
      `/v1/federation/delegations/${delegationId}/revoke`,
      {},
    );
    expect(res.status).toBe(200);
    expect((res.body as { revoked: string }).revoked).toBe(delegationId);

    const row = h.delegations.getGranted(delegationId);
    expect(row!.revoked).toBe(1);
  });

  it('returns 404 for unknown delegation_id', async () => {
    const res = await post(
      h,
      '/v1/federation/delegations/00000000-0000-0000-0000-000000000000/revoke',
      {},
    );
    expect(res.status).toBe(404);
    expect((res.body as { code: string }).code).toBe('DELEGATION_NOT_FOUND');
  });

  it('idempotent: revoking already-revoked returns 200', async () => {
    const created = await post(h, '/v1/federation/delegate', {
      peer_verify_key: 'ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
      expires_at: futureIso(60 * 60_000),
    });
    const delegationId = (created.body as { delegation_id: string }).delegation_id;

    const first = await post(
      h,
      `/v1/federation/delegations/${delegationId}/revoke`,
      {},
    );
    expect(first.status).toBe(200);

    const second = await post(
      h,
      `/v1/federation/delegations/${delegationId}/revoke`,
      {},
    );
    expect(second.status).toBe(200);
  });
});
