/**
 * T-PERSISTENT-001 mitigation #2 — audit log of every vault decryption,
 * streamed live to Android.
 *
 * Covers:
 *   - recordVaultAccess writes the correct `decision = 'vault_access'` row
 *     with actor_type / actor_id / request_id populated.
 *   - recordVaultAccess broadcasts `vault_access` to the wired broadcaster
 *     on success and on error.
 *   - recordVaultAccess does NOT block on the broadcast or audit write
 *     (returns synchronously; rows land via setImmediate).
 *   - TokenVault.getAccessToken writes audit rows on success, not_found,
 *     and decrypt error — and continues to throw the original error.
 *   - Multiple concurrent vault accesses each get their own audit row
 *     (no deduplication with the tool-call audit row).
 *   - Migration v7 adds the three actor-context columns cleanly on both
 *     fresh DBs and pre-v7 (v6) DBs.
 *   - Broadcast failures don't break the vault read.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { AuditLog, type VaultAccessBroadcaster } from '../src/audit-log.js';
import { ApprovalStream } from '../src/approval-stream.js';
import { TokenVault } from '../src/token-vault.js';
import { runMigrations } from '../src/migrations.js';
import type { VaultAccessUpdate } from '../src/types.js';

const MASTER_KEY = Buffer.alloc(32, 0xa5);

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

function readUserVersion(): number {
  const raw = db.pragma('user_version') as unknown;
  if (Array.isArray(raw)) {
    const first = raw[0] as { user_version?: number } | undefined;
    return first?.user_version ?? -1;
  }
  if (raw && typeof raw === 'object' && 'user_version' in raw) {
    return (raw as { user_version: number }).user_version;
  }
  return -1;
}

describe('migration v7 — T-PERSISTENT-001 mitigation #2', () => {
  it('fresh DB lands at user_version 7 with actor_context columns on audit_log', () => {
    expect(readUserVersion()).toBe(8);
    const cols = db.prepare('PRAGMA table_info(audit_log)').all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('actor_type');
    expect(names).toContain('actor_id');
    expect(names).toContain('request_id');
  });

  it('pre-v6 (v5) DB upgrades to v7 and gains the three columns', () => {
    // The shared `db` already had runMigrations applied in beforeEach,
    // so we need a fresh DB to simulate a pre-v7 hub. Use a one-off
    // in-memory DB scoped to this test.
    const freshDb = new Database(':memory:');
    try {
      // Simulate a hub on the pre-Plugin-SDK-v2 schema (just the
      // original v1 + federation v2 columns). Migration v7 must still
      // land cleanly.
      freshDb.exec(`
        CREATE TABLE audit_log (
          id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, agent_id TEXT NOT NULL,
          user_id TEXT NOT NULL, tool_name TEXT NOT NULL, plugin TEXT NOT NULL,
          scope TEXT NOT NULL, justification TEXT, decision TEXT NOT NULL,
          grant_id TEXT, duration_ms INTEGER NOT NULL, error TEXT,
          delegated_by TEXT, delegated_to TEXT, decision_federated TEXT
        );
        CREATE TABLE grants (
          grant_id TEXT PRIMARY KEY, tool_name TEXT NOT NULL, plugin TEXT NOT NULL,
          scope TEXT NOT NULL, agent_id TEXT NOT NULL, user_id TEXT NOT NULL,
          created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
          revoked INTEGER NOT NULL DEFAULT 0, delegated_by TEXT
        );
        CREATE TABLE token_vault (plugin TEXT PRIMARY KEY, scope TEXT NOT NULL);
        CREATE TABLE federation_keys (
          id INTEGER PRIMARY KEY CHECK (id = 1), verify_key TEXT NOT NULL,
          signing_key_enc BLOB NOT NULL, signing_key_iv BLOB NOT NULL,
          signing_key_tag BLOB NOT NULL, hub_name TEXT NOT NULL, magic_dns TEXT,
          fingerprint TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE delegations (
          delegation_id TEXT PRIMARY KEY, peer_verify_key TEXT NOT NULL,
          peer_hub_name TEXT, plugin TEXT NOT NULL, tool TEXT NOT NULL,
          scope TEXT NOT NULL, expires_at TEXT NOT NULL,
          revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
          signature BLOB NOT NULL
        );
        CREATE TABLE peer_delegations (
          delegation_id TEXT PRIMARY KEY, peer_verify_key TEXT NOT NULL,
          peer_hub_name TEXT NOT NULL, peer_hub_url TEXT NOT NULL,
          plugin TEXT NOT NULL, tool TEXT NOT NULL, scope TEXT NOT NULL,
          input_schema TEXT, expires_at TEXT NOT NULL,
          revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
          signature BLOB NOT NULL
        );
        CREATE TABLE federation_nonces (
          request_id TEXT PRIMARY KEY, seen_at TEXT NOT NULL
        );
      `);
      freshDb.pragma('user_version = 6');
      // Re-run migrations on the simulated hub; v7 should land and add
      // the 3 actor-context columns.
      runMigrations(freshDb);
      const raw = freshDb.pragma('user_version') as unknown;
      const v = Array.isArray(raw) ? (raw[0] as { user_version?: number })?.user_version ?? -1 : -1;
      expect(v).toBe(8);
      const cols = freshDb
        .prepare('PRAGMA table_info(audit_log)')
        .all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      expect(names).toContain('actor_type');
      expect(names).toContain('actor_id');
      expect(names).toContain('request_id');
      // Federation v2 columns preserved through the upgrade.
      expect(names).toContain('delegated_by');
      expect(names).toContain('delegated_to');
      expect(names).toContain('decision_federated');
    } finally {
      freshDb.close();
    }
  });
});

describe('AuditLog.recordVaultAccess', () => {
  it('writes a decision="vault_access" row with actor_type / actor_id / request_id', () => {
    const audit = new AuditLog(db);
    audit.recordVaultAccessSync({
      plugin: 'google-calendar',
      actor_type: 'agent',
      actor_id: 'opencode/agent-1',
      tool_name: 'listEvents',
      request_id: 'req-abc-123',
      result: 'success',
    });
    const rows = audit.query({ tool_name: 'listEvents' });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.decision).toBe('vault_access');
    expect(row.plugin).toBe('google-calendar');
    expect(row.actor_type).toBe('agent');
    expect(row.actor_id).toBe('opencode/agent-1');
    expect(row.request_id).toBe('req-abc-123');
    expect(row.error).toBeUndefined();
  });

  it('persists error_message on not_found / error / denied results', () => {
    const audit = new AuditLog(db);
    audit.recordVaultAccessSync({
      plugin: 'slack',
      actor_type: 'system',
      actor_id: 'local-user',
      request_id: null,
      result: 'not_found',
    });
    audit.recordVaultAccessSync({
      plugin: 'github',
      actor_type: 'user',
      actor_id: 'alice',
      request_id: null,
      result: 'error',
      error_message: 'AES GCM tag verification failed',
    });
    audit.recordVaultAccessSync({
      plugin: 'admin',
      actor_type: 'system',
      actor_id: 'local-user',
      request_id: null,
      result: 'denied',
    });
    const rows = audit.query({ decision: 'vault_access' });
    expect(rows).toHaveLength(3);
    const byPlugin = new Map(rows.map((r) => [r.plugin, r]));
    expect(byPlugin.get('slack')!.error).toMatch(/no_token_for_plugin:slack/);
    expect(byPlugin.get('github')!.error).toBe('AES GCM tag verification failed');
    expect(byPlugin.get('admin')!.error).toBe('denied_by_policy');
  });

  it('does NOT block the caller (returns synchronously, row lands later)', async () => {
    const audit = new AuditLog(db);
    const start = Date.now();
    audit.recordVaultAccess({
      plugin: 'p',
      actor_type: 'agent',
      actor_id: 'a1',
      request_id: 'r1',
      result: 'success',
    });
    const elapsed = Date.now() - start;
    // The call should return within a few ms even though SQLite + the
    // broadcaster (if set) will run later via setImmediate.
    expect(elapsed).toBeLessThan(10);

    // Let the microtask + setImmediate queues drain, then assert the row.
    await new Promise<void>((r) => setImmediate(r));
    const rows = audit.query({ decision: 'vault_access' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.request_id).toBe('r1');
  });

  it('broadcasts vault_access via WebSocket on success and on error', () => {
    const audit = new AuditLog(db);
    const calls: VaultAccessUpdate[] = [];
    const broadcaster: VaultAccessBroadcaster = {
      broadcastVaultAccess: (notif) => calls.push(notif),
    };
    audit.setBroadcaster(broadcaster);
    audit.recordVaultAccessSync({
      plugin: 'google-calendar',
      actor_type: 'agent',
      actor_id: 'a1',
      tool_name: 'listEvents',
      request_id: 'r1',
      result: 'success',
    });
    audit.recordVaultAccessSync({
      plugin: 'google-calendar',
      actor_type: 'agent',
      actor_id: 'a1',
      tool_name: 'listEvents',
      request_id: 'r2',
      result: 'error',
      error_message: 'decrypt blew up',
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.type).toBe('vault_access');
    expect(calls[0]!.entry.decision).toBe('vault_access');
    expect(calls[0]!.entry.request_id).toBe('r1');
    expect(calls[1]!.entry.result === undefined).toBe(true);
    expect(calls[1]!.entry.error).toBe('decrypt blew up');
  });

  it('a broadcast that throws does NOT break the audit write', () => {
    const audit = new AuditLog(db);
    const failing: VaultAccessBroadcaster = {
      broadcastVaultAccess: () => {
        throw new Error('WebSocket closed unexpectedly');
      },
    };
    audit.setBroadcaster(failing);
    expect(() =>
      audit.recordVaultAccessSync({
        plugin: 'p',
        actor_type: 'agent',
        actor_id: 'a1',
        request_id: 'r1',
        result: 'success',
      }),
    ).not.toThrow();
    // Audit row was still written.
    const rows = audit.query({ decision: 'vault_access' });
    expect(rows).toHaveLength(1);
  });

  it('a wired ApprovalStream satisfies VaultAccessBroadcaster (no missing methods)', () => {
    const audit = new AuditLog(db);
    const approval = new ApprovalStream({ timeoutMs: 5000 });
    // Type-only assertion: ApprovalStream must satisfy the structural
    // VaultAccessBroadcaster interface so server.ts can wire it via
    // `audit.setBroadcaster(approval)`.
    audit.setBroadcaster(approval);
    audit.recordVaultAccessSync({
      plugin: 'p',
      actor_type: 'agent',
      actor_id: 'a1',
      request_id: 'r1',
      result: 'success',
    });
    expect(audit.query({ decision: 'vault_access' })).toHaveLength(1);
  });
});

describe('TokenVault.getAccessToken — vault audit integration', () => {
  it('writes a success audit row and returns the decrypted token', () => {
    const audit = new AuditLog(db);
    const vault = new TokenVault(db, MASTER_KEY, audit);
    vault.store({
      plugin: 'google-calendar',
      access_token: 'real-token-XYZ',
      scope: 'calendar:read',
    });
    const tok = vault.getAccessToken('google-calendar', {
      actor_type: 'agent',
      actor_id: 'claude-code/agent-1',
      tool_name: 'listEvents',
      request_id: 'req-1',
    });
    expect(tok.access_token).toBe('real-token-XYZ');
    // Wait for setImmediate to drain so we can observe the row.
    return new Promise<void>((resolve) => setImmediate(() => {
      const rows = audit.query({ decision: 'vault_access' });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor_type).toBe('agent');
      expect(rows[0]!.actor_id).toBe('claude-code/agent-1');
      expect(rows[0]!.tool_name).toBe('listEvents');
      expect(rows[0]!.request_id).toBe('req-1');
      expect(rows[0]!.error).toBeUndefined();
      resolve();
    }));
  });

  it('writes a not_found audit row and throws when no token is stored', () => {
    const audit = new AuditLog(db);
    const vault = new TokenVault(db, MASTER_KEY, audit);
    expect(() =>
      vault.getAccessToken('slack', {
        actor_type: 'agent',
        actor_id: 'opencode/agent-2',
        tool_name: 'postMessage',
        request_id: 'req-2',
      }),
    ).toThrow(/No token stored for plugin: slack/);

    return new Promise<void>((resolve) => setImmediate(() => {
      const rows = audit.query({ decision: 'vault_access' });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.plugin).toBe('slack');
      expect(rows[0]!.actor_id).toBe('opencode/agent-2');
      expect(rows[0]!.error).toMatch(/no_token_for_plugin:slack/);
      resolve();
    }));
  });

  it('writes an error audit row and throws when the ciphertext tag is tampered', () => {
    const audit = new AuditLog(db);
    const vault = new TokenVault(db, MASTER_KEY, audit);
    vault.store({
      plugin: 'google-calendar',
      access_token: 'real-token',
      scope: 'calendar:read',
    });
    // Tamper with the GCM tag → decrypt() will throw with "Unsupported
    // state or unable to authenticate data".
    db.prepare('UPDATE token_vault SET access_token_tag = ? WHERE plugin = ?')
      .run(Buffer.alloc(16, 0xff), 'google-calendar');

    expect(() =>
      vault.getAccessToken('google-calendar', {
        actor_type: 'agent',
        actor_id: 'a1',
        tool_name: 'listEvents',
        request_id: 'req-3',
      }),
    ).toThrow(/authenticate|tag/i);

    return new Promise<void>((resolve) => setImmediate(() => {
      const rows = audit.query({ decision: 'vault_access' });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.plugin).toBe('google-calendar');
      expect(rows[0]!.error).toBeDefined();
      resolve();
    }));
  });

  it('defaults actor_type to "system" and actor_id to "local-user" when opts omitted', () => {
    const audit = new AuditLog(db);
    const vault = new TokenVault(db, MASTER_KEY, audit);
    vault.store({ plugin: 'p', access_token: 't', scope: 's' });
    const tok = vault.getAccessToken('p'); // ← no opts
    expect(tok.access_token).toBe('t');
    return new Promise<void>((resolve) => setImmediate(() => {
      const rows = audit.query({ decision: 'vault_access' });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor_type).toBe('system');
      expect(rows[0]!.actor_id).toBe('local-user');
      expect(rows[0]!.tool_name).toBe(''); // not provided → empty
      resolve();
    }));
  });

  it('writes a separate audit row per concurrent call (no dedup)', async () => {
    const audit = new AuditLog(db);
    const vault = new TokenVault(db, MASTER_KEY, audit);
    vault.store({ plugin: 'p', access_token: 't', scope: 's' });
    await Promise.all([
      Promise.resolve(vault.getAccessToken('p', { actor_type: 'agent', actor_id: 'a1', request_id: 'r1', tool_name: 't1' })),
      Promise.resolve(vault.getAccessToken('p', { actor_type: 'agent', actor_id: 'a2', request_id: 'r2', tool_name: 't2' })),
      Promise.resolve(vault.getAccessToken('p', { actor_type: 'agent', actor_id: 'a3', request_id: 'r3', tool_name: 't3' })),
    ]);
    await new Promise<void>((r) => setImmediate(r));
    const rows = audit.query({ decision: 'vault_access' });
    expect(rows).toHaveLength(3);
    const ids = new Set(rows.map((r) => r.actor_id));
    expect(ids).toEqual(new Set(['a1', 'a2', 'a3']));
  });

  it('keeps working without an AuditLog (vault read proceeds silently)', () => {
    const vault = new TokenVault(db, MASTER_KEY); // ← no audit log
    vault.store({ plugin: 'p', access_token: 't', scope: 's' });
    expect(() => vault.getAccessToken('p')).not.toThrow();
    expect(vault.getAccessToken('p').access_token).toBe('t');
    // No audit rows were written.
    const audit = new AuditLog(db);
    expect(audit.query({ decision: 'vault_access' })).toHaveLength(0);
  });
});
