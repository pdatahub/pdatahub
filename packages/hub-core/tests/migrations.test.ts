/**
 * Tests for the migration framework (Phase 0.5 foundation + Phase 1 + Phase 2a).
 *
 * Covers:
 *   - Fresh DB: runMigrations creates audit_log / grants / token_vault /
 *     federation_keys / delegations / peer_delegations tables and sets
 *     user_version to 3.
 *   - Idempotency: running twice on the same DB is a no-op (no error,
 *     version unchanged, no duplicate tables).
 *   - PRAGMA reading: readUserVersion handles both `{user_version: N}`
 *     (typical better-sqlite3 return) and bare numbers.
 *   - Per-phase upgrade paths (v1 → v3, v2 → v3).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/migrations.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
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

function tableNames(): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

describe('runMigrations', () => {
  it('sets user_version to 4 on a fresh DB (Phase 0.5 + 1 + 2a + 2b applied)', () => {
    expect(readUserVersion()).toBe(0);
    const result = runMigrations(db);
    expect(result).toBe(4);
    expect(readUserVersion()).toBe(4);
  });

  it('creates audit_log, grants, token_vault tables on a fresh DB', () => {
    runMigrations(db);
    const names = tableNames();
    expect(names).toContain('audit_log');
    expect(names).toContain('grants');
    expect(names).toContain('token_vault');
  });

  it('creates the expected indexes for audit_log and grants', () => {
    runMigrations(db);
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    // audit_log indexes
    expect(names).toContain('idx_audit_timestamp');
    expect(names).toContain('idx_audit_agent');
    expect(names).toContain('idx_audit_user');
    expect(names).toContain('idx_audit_tool');
    expect(names).toContain('idx_audit_decision');
    // grants indexes
    expect(names).toContain('idx_grants_agent');
    expect(names).toContain('idx_grants_tool');
    expect(names).toContain('idx_grants_expires');
  });

  it('is idempotent — second run does not throw or change version', () => {
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    expect(readUserVersion()).toBe(4);
  });

  it('idempotent run does not duplicate tables', () => {
    runMigrations(db);
    runMigrations(db);
    // SQLite has no table per-schema, so we count by name — should still
    // be exactly the five migration-managed tables (delegations,
    // peer_delegations live alongside the v1 trio and federation_keys).
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('audit_log','grants','token_vault','federation_keys','delegations','peer_delegations')",
      )
      .all() as Array<{ name: string }>;
    expect(rows).toHaveLength(6);
  });

  it('leaves existing rows alone on a DB that already has data', () => {
    // Insert a row into audit_log before running migrations — simulates a
    // hub upgraded from a Phase 0 install (no migration history).
    db.exec(`
      CREATE TABLE audit_log (
        id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, agent_id TEXT NOT NULL,
        user_id TEXT NOT NULL, tool_name TEXT NOT NULL, plugin TEXT NOT NULL,
        scope TEXT NOT NULL, justification TEXT, decision TEXT NOT NULL,
        grant_id TEXT, duration_ms INTEGER NOT NULL, error TEXT
      );
    `);
    db.prepare(
      `INSERT INTO audit_log (id, timestamp, agent_id, user_id, tool_name,
        plugin, scope, justification, decision, grant_id, duration_ms)
       VALUES ('pre-existing', '2026-01-01T00:00:00Z', 'a', 'u', 't', 'p',
        's', NULL, 'approved', NULL, 0)`,
    ).run();

    runMigrations(db);

    // Row survives — IF NOT EXISTS preserved the original table.
    const row = db
      .prepare("SELECT id FROM audit_log WHERE id = 'pre-existing'")
      .get();
    expect(row).toBeDefined();
    expect(readUserVersion()).toBe(4);
  });
});

describe('runMigrations — Phase 1 (federation identity)', () => {
  it('sets user_version to 4 on a fresh DB (after v2)', () => {
    const result = runMigrations(db);
    expect(result).toBe(4);
    expect(readUserVersion()).toBe(4);
  });

  it('creates federation_keys table with all expected columns', () => {
    runMigrations(db);
    const cols = db
      .prepare("PRAGMA table_info(federation_keys)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    for (const expected of [
      'id',
      'verify_key',
      'signing_key_enc',
      'signing_key_iv',
      'signing_key_tag',
      'hub_name',
      'magic_dns',
      'fingerprint',
      'created_at',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('id column enforces CHECK (id = 1) on insert', () => {
    runMigrations(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO federation_keys (id, verify_key, signing_key_enc,
             signing_key_iv, signing_key_tag, hub_name, fingerprint, created_at)
           VALUES (2, 'ed25519:abc', ?, ?, ?, 'u', 'FP', '2026-01-01T00:00:00Z')`,
        )
        .run(Buffer.alloc(32), Buffer.alloc(12), Buffer.alloc(16)),
    ).toThrow(/CHECK/);
  });

  it('runs v1 → v2 → v3 → v4 in order', () => {
    runMigrations(db);
    expect(readUserVersion()).toBe(4);
    const names = tableNames();
    expect(names).toContain('audit_log');
    expect(names).toContain('grants');
    expect(names).toContain('token_vault');
    expect(names).toContain('federation_keys');
    expect(names).toContain('delegations');
    expect(names).toContain('peer_delegations');
  });

  it('idempotent — second run is a no-op (version stays 4, no duplicate tables)', () => {
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    expect(readUserVersion()).toBe(4);
    const count = db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='federation_keys'",
      )
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('preserves v1 data when migrating forward to v3', () => {
    db.exec(`
      CREATE TABLE audit_log (
        id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, agent_id TEXT NOT NULL,
        user_id TEXT NOT NULL, tool_name TEXT NOT NULL, plugin TEXT NOT NULL,
        scope TEXT NOT NULL, justification TEXT, decision TEXT NOT NULL,
        grant_id TEXT, duration_ms INTEGER NOT NULL, error TEXT
      );
    `);
    db.prepare(
      `INSERT INTO audit_log (id, timestamp, agent_id, user_id, tool_name,
        plugin, scope, justification, decision, grant_id, duration_ms)
       VALUES ('pre-existing', '2026-01-01T00:00:00Z', 'a', 'u', 't', 'p',
        's', NULL, 'approved', NULL, 0)`,
    ).run();

    runMigrations(db);

    const row = db
      .prepare("SELECT id FROM audit_log WHERE id = 'pre-existing'")
      .get();
    expect(row).toBeDefined();
    expect(readUserVersion()).toBe(4);
  });

  it('upgrades a v1 DB (user_version=1) to v4', () => {
    db.exec(`
      CREATE TABLE audit_log (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL);
      CREATE TABLE grants (grant_id TEXT PRIMARY KEY, tool_name TEXT NOT NULL);
      CREATE TABLE token_vault (plugin TEXT PRIMARY KEY, scope TEXT NOT NULL);
    `);
    db.pragma('user_version = 1');

    runMigrations(db);

    expect(readUserVersion()).toBe(4);
    const names = tableNames();
    expect(names).toContain('federation_keys');
    expect(names).toContain('delegations');
    expect(names).toContain('peer_delegations');
    const auditCols = db.prepare("PRAGMA table_info(audit_log)").all() as Array<{ name: string }>;
    expect(auditCols.map((c) => c.name)).toEqual(
      expect.arrayContaining(['delegated_by', 'delegated_to', 'decision_federated']),
    );
    const grantCols = db.prepare("PRAGMA table_info(grants)").all() as Array<{ name: string }>;
    expect(grantCols.map((c) => c.name)).toEqual(expect.arrayContaining(['delegated_by']));
  });

  it('upgrades a v2 DB (user_version=2) to v4', () => {
    // Simulates a hub that initialized federation identity (Phase 1) before
    // Phase 2a + 2b landed — should pick up the new delegation tables +
    // federation-context columns.
    db.exec(`
      CREATE TABLE audit_log (
        id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, agent_id TEXT NOT NULL,
        user_id TEXT NOT NULL, tool_name TEXT NOT NULL, plugin TEXT NOT NULL,
        scope TEXT NOT NULL, justification TEXT, decision TEXT NOT NULL,
        grant_id TEXT, duration_ms INTEGER NOT NULL, error TEXT
      );
      CREATE TABLE grants (
        grant_id TEXT PRIMARY KEY, tool_name TEXT NOT NULL, plugin TEXT NOT NULL,
        scope TEXT NOT NULL, agent_id TEXT NOT NULL, user_id TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE token_vault (plugin TEXT PRIMARY KEY, scope TEXT NOT NULL);
      CREATE TABLE federation_keys (
        id INTEGER PRIMARY KEY CHECK (id = 1), verify_key TEXT NOT NULL,
        signing_key_enc BLOB NOT NULL, signing_key_iv BLOB NOT NULL,
        signing_key_tag BLOB NOT NULL, hub_name TEXT NOT NULL, magic_dns TEXT,
        fingerprint TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
    db.pragma('user_version = 2');

    runMigrations(db);

    expect(readUserVersion()).toBe(4);
    const names = tableNames();
    expect(names).toContain('delegations');
    expect(names).toContain('peer_delegations');
    // Pre-existing tables preserved.
    expect(names).toContain('audit_log');
    expect(names).toContain('federation_keys');
  });

  it('upgrades a v2 DB (with federation_keys) to v4', () => {
    db.exec(`
      CREATE TABLE audit_log (
        id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, agent_id TEXT NOT NULL,
        user_id TEXT NOT NULL, tool_name TEXT NOT NULL, plugin TEXT NOT NULL,
        scope TEXT NOT NULL, justification TEXT, decision TEXT NOT NULL,
        grant_id TEXT, duration_ms INTEGER NOT NULL, error TEXT
      );
      CREATE TABLE grants (
        grant_id TEXT PRIMARY KEY, tool_name TEXT NOT NULL, plugin TEXT NOT NULL,
        scope TEXT NOT NULL, agent_id TEXT NOT NULL, user_id TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE token_vault (plugin TEXT PRIMARY KEY, scope TEXT NOT NULL);
      CREATE TABLE federation_keys (
        id INTEGER PRIMARY KEY CHECK (id = 1), verify_key TEXT NOT NULL,
        signing_key_enc BLOB NOT NULL, signing_key_iv BLOB NOT NULL,
        signing_key_tag BLOB NOT NULL, hub_name TEXT NOT NULL, magic_dns TEXT,
        fingerprint TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
    db.pragma('user_version = 2');

    runMigrations(db);

    expect(readUserVersion()).toBe(4);
    const names = tableNames();
    expect(names).toContain('delegations');
    expect(names).toContain('peer_delegations');
    // Pre-existing tables preserved.
    expect(names).toContain('audit_log');
    expect(names).toContain('federation_keys');
  });
});

describe('runMigrations — Phase 2a (delegation data model)', () => {
  it('creates the delegations table with all expected columns', () => {
    runMigrations(db);
    const cols = db
      .prepare("PRAGMA table_info(delegations)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    for (const expected of [
      'delegation_id',
      'peer_verify_key',
      'peer_hub_name',
      'plugin',
      'tool',
      'scope',
      'expires_at',
      'revoked',
      'created_at',
      'signature',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('creates the peer_delegations table with all expected columns', () => {
    runMigrations(db);
    const cols = db
      .prepare("PRAGMA table_info(peer_delegations)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    for (const expected of [
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
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('creates the expected indexes on delegations', () => {
    runMigrations(db);
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='delegations' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_delegations_peer');
    expect(names).toContain('idx_delegations_expires');
  });

  it('does NOT create a peer_signature_checked column (Momus C4 — removed)', () => {
    runMigrations(db);
    const cols = db
      .prepare("PRAGMA table_info(peer_delegations)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).not.toContain('peer_signature_checked');
    expect(names).not.toContain('signature_checked');
  });

  it('primary key on delegations.delegation_id rejects duplicates', () => {
    runMigrations(db);
    db.prepare(
      `INSERT INTO delegations (delegation_id, peer_verify_key, plugin, tool,
         scope, expires_at, created_at, signature)
       VALUES ('dup', 'ed25519:abc', 'p', 't', 's',
         '2027-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?)`,
    ).run(Buffer.alloc(64));
    expect(() =>
      db
        .prepare(
          `INSERT INTO delegations (delegation_id, peer_verify_key, plugin, tool,
             scope, expires_at, created_at, signature)
           VALUES ('dup', 'ed25519:def', 'p', 't', 's',
             '2027-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?)`,
        )
        .run(Buffer.alloc(64)),
    ).toThrow(/UNIQUE|PRIMARY/i);
  });

  it('primary key on peer_delegations.delegation_id allows INSERT OR IGNORE', () => {
    runMigrations(db);
    db.prepare(
      `INSERT INTO peer_delegations (delegation_id, peer_verify_key, peer_hub_name,
         peer_hub_url, plugin, tool, scope, input_schema, expires_at, created_at, signature)
       VALUES ('dup', 'ed25519:abc', 'userA', 'http://a:8080', 'p', 't', 's', '{}',
         '2027-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?)`,
    ).run(Buffer.alloc(64));
    // Second insert with same PK must fail (raw INSERT — the OR IGNORE lives
    // in DelegationStore.createReceived, not in the schema).
    expect(() =>
      db
        .prepare(
          `INSERT INTO peer_delegations (delegation_id, peer_verify_key, peer_hub_name,
             peer_hub_url, plugin, tool, scope, input_schema, expires_at, created_at, signature)
           VALUES ('dup', 'ed25519:def', 'userA', 'http://a:8080', 'p', 't', 's', '{}',
             '2027-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?)`,
        )
        .run(Buffer.alloc(64)),
    ).toThrow(/UNIQUE|PRIMARY/i);
  });

  it('peer_hub_name is nullable on delegations (set lazily)', () => {
    runMigrations(db);
    // No error when peer_hub_name is null at grant time.
    expect(() =>
      db
        .prepare(
          `INSERT INTO delegations (delegation_id, peer_verify_key, peer_hub_name,
             plugin, tool, scope, expires_at, created_at, signature)
           VALUES ('n1', 'ed25519:abc', NULL, 'p', 't', 's',
             '2027-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?)`,
        )
        .run(Buffer.alloc(64)),
    ).not.toThrow();
  });
});
