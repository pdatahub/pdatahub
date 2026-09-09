/**
 * Plugin SDK v2 — audit log migration v6 + error columns (Day 5).
 *
 * Covers:
 *   - Fresh DB: v6 applies last, audit_log gains error_class + error_code
 *   - Pre-v6 DB (v5): upgrade path lands v6 cleanly
 *   - Audit rows with error fields persist all 16 columns
 *   - AuditLog.getByErrorCode filters by the stable code column
 *   - Federation v2 columns survive the upgrade (delegated_by /
 *     delegated_to / decision_federated all preserved)
 *   - Pre-existing rows (legacy error_message text) survive upgrade
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { AuditLog } from '../src/audit-log.js';
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
  return -1;
}

describe('audit_log migration v6 — Plugin SDK v2', () => {
  it('fresh DB applies v6 + adds error_class + error_code columns', () => {
    expect(readUserVersion()).toBe(0);
    runMigrations(db);
    expect(readUserVersion()).toBe(7);

    const cols = db.prepare('PRAGMA table_info(audit_log)').all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('error_class');
    expect(names).toContain('error_code');
  });

  it('existing v5 DB upgrades to v7 + gains the error columns (and v7 actor-context columns)', () => {
    // Simulate a hub on the pre-v6 schema (Phase 3, before Plugin SDK v2
    // landed). The audit_log columns are the v1-v5 set.
    db.exec(`
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
    db.pragma('user_version = 5');

    runMigrations(db);

    expect(readUserVersion()).toBe(7);
    const cols = db.prepare('PRAGMA table_info(audit_log)').all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('actor_type');
    expect(names).toContain('actor_id');
    expect(names).toContain('request_id');
    expect(names).toContain('error_class');
    expect(names).toContain('error_code');
    // Federation v2 columns preserved.
    expect(names).toContain('delegated_by');
    expect(names).toContain('delegated_to');
    expect(names).toContain('decision_federated');
  });

  it('error_class column accepts TEXT (round-trips a string)', () => {
    runMigrations(db);
    const audit = new AuditLog(db);
    const entry = audit.append({
      agent_id: 'a1',
      user_id: 'u1',
      tool_name: 't',
      plugin: 'p',
      scope: 's',
      justification: null,
      decision: 'error',
      grant_id: null,
      duration_ms: 0,
      error: 'expired',
      error_class: 'AuthExpiredError',
      error_code: 'AUTH_EXPIRED',
    });
    expect(entry.error_class).toBe('AuthExpiredError');
    const row = db
      .prepare('SELECT error_class, error_code FROM audit_log WHERE id = ?')
      .get(entry.id) as { error_class: string; error_code: string };
    expect(row.error_class).toBe('AuthExpiredError');
    expect(row.error_code).toBe('AUTH_EXPIRED');
  });

  it('error_code column accepts TEXT (round-trips a string)', () => {
    runMigrations(db);
    const audit = new AuditLog(db);
    const entry = audit.append({
      agent_id: 'a1',
      user_id: 'u1',
      tool_name: 't',
      plugin: 'p',
      scope: 's',
      justification: null,
      decision: 'error',
      grant_id: null,
      duration_ms: 0,
      error_class: 'ValidationError',
      error_code: 'VALIDATION_FAILED',
    });
    const row = db
      .prepare('SELECT error_class, error_code FROM audit_log WHERE id = ?')
      .get(entry.id) as { error_class: string; error_code: string };
    expect(row.error_code).toBe('VALIDATION_FAILED');
  });

  it('getByErrorCode returns filtered entries (newest first)', () => {
    runMigrations(db);
    const audit = new AuditLog(db);
    audit.append({
      agent_id: 'a1', user_id: 'u1', tool_name: 't1', plugin: 'p1', scope: 's',
      justification: null, decision: 'error', grant_id: null, duration_ms: 0,
      error_class: 'AuthExpiredError', error_code: 'AUTH_EXPIRED',
    });
    audit.append({
      agent_id: 'a1', user_id: 'u1', tool_name: 't2', plugin: 'p2', scope: 's',
      justification: null, decision: 'error', grant_id: null, duration_ms: 0,
      error_class: 'AuthExpiredError', error_code: 'AUTH_EXPIRED',
    });
    audit.append({
      agent_id: 'a1', user_id: 'u1', tool_name: 't3', plugin: 'p3', scope: 's',
      justification: null, decision: 'error', grant_id: null, duration_ms: 0,
      error_class: 'ValidationError', error_code: 'VALIDATION_FAILED',
    });

    const expired = audit.getByErrorCode('AUTH_EXPIRED');
    expect(expired).toHaveLength(2);
    expect(expired.every((e) => e.error_code === 'AUTH_EXPIRED')).toBe(true);
    expect(expired[0]!.timestamp >= expired[1]!.timestamp).toBe(true);

    const validated = audit.getByErrorCode('VALIDATION_FAILED');
    expect(validated).toHaveLength(1);
    expect(validated[0]!.error_class).toBe('ValidationError');

    expect(audit.getByErrorCode('NEVER_HAPPENED')).toEqual([]);
  });

  it('audit entry with error fields persists all 19 columns', () => {
    runMigrations(db);
    const audit = new AuditLog(db);
    const entry = audit.append({
      agent_id: 'a1',
      user_id: 'u1',
      tool_name: 'listEvents',
      plugin: 'google-calendar',
      scope: 'calendar:read',
      justification: 'user asked for events',
      decision: 'error',
      grant_id: 'g-1',
      duration_ms: 1234,
      error: 'upstream 500',
      delegated_by: 'ed25519:peerA',
      delegated_to: 'ed25519:peerB',
      decision_federated: 'federated_error',
      error_class: 'NetworkError',
      error_code: 'NETWORK_ERROR',
      actor_type: 'agent',
      actor_id: 'a1',
      request_id: 'r-1',
    });
    const row = db
      .prepare(
        `SELECT id, agent_id, user_id, tool_name, plugin, scope, justification,
                decision, grant_id, duration_ms, error,
                delegated_by, delegated_to, decision_federated,
                error_class, error_code,
                actor_type, actor_id, request_id
         FROM audit_log WHERE id = ?`,
      )
      .get(entry.id) as Record<string, unknown>;
    expect(row['agent_id']).toBe('a1');
    expect(row['delegated_by']).toBe('ed25519:peerA');
    expect(row['delegated_to']).toBe('ed25519:peerB');
    expect(row['decision_federated']).toBe('federated_error');
    expect(row['error_class']).toBe('NetworkError');
    expect(row['error_code']).toBe('NETWORK_ERROR');
    // 19 columns verified by checking the explicit list (16 original +
    // actor_type + actor_id + request_id from migration v7).
    expect(Object.keys(row)).toHaveLength(19);
  });
});
