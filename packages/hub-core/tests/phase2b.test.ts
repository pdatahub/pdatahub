/**
 * Phase 2b (Federation v2) tests — Momus C1 security hole fix + audit log
 * federation-context columns.
 *
 * The CRITICAL test is `findActive does NOT reuse a local grant for a
 * federated call` (and its mirror: `does NOT reuse a federated grant for a
 * local call`). Without `delegated_by` in the match key, a federated call
 * from peer B with `(tool, plugin, agent, B_verify_key)` would satisfy a
 * local grant `(tool, plugin, agent, NULL)`, bypassing A's approval flow
 * entirely. This test locks that fix in.
 *
 * Plus: audit log round-trip for the new `delegated_by` / `delegated_to` /
 * `decision_federated` columns (Phase 3 will populate them; Phase 2b
 * establishes the schema and the input shape).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/migrations.js';
import { GrantStore } from '../src/grant-store.js';
import { AuditLog } from '../src/audit-log.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

function futureIso(): string {
  return new Date(Date.now() + 60 * 60_000).toISOString();
}

const B_VERIFY_KEY = 'ed25519:B_public_key_phase_2b_test';
const C_VERIFY_KEY = 'ed25519:C_public_key_phase_2b_test';

const SHARED_GRANT_INPUT = {
  tool_name: 'listEvents',
  plugin: 'google-calendar',
  scope: 'calendar:read',
  agent_id: 'A_local_agent',
  user_id: 'local-user',
  expires_at: futureIso(),
} as const;

describe('GrantStore.findActive — Momus C1 security hole fix', () => {
  it('returns the local grant when a local call asks for it', () => {
    const grants = new GrantStore(db);
    const g = grants.create(SHARED_GRANT_INPUT);
    const found = grants.findActive({
      tool_name: SHARED_GRANT_INPUT.tool_name,
      plugin: SHARED_GRANT_INPUT.plugin,
      agent_id: SHARED_GRANT_INPUT.agent_id,
      delegated_by: null,
    });
    expect(found?.grant_id).toBe(g.grant_id);
    expect(found?.delegated_by).toBeNull();
  });

  it('CRITICAL: does NOT reuse a local grant for a federated call', () => {
    // Given: a local grant exists for the (tool, plugin, agent) tuple with
    // delegated_by = NULL (A previously approved a local call).
    const grants = new GrantStore(db);
    grants.create(SHARED_GRANT_INPUT);

    // When: a federated call comes in from B with delegated_by = B_key.
    const found = grants.findActive({
      tool_name: SHARED_GRANT_INPUT.tool_name,
      plugin: SHARED_GRANT_INPUT.plugin,
      agent_id: SHARED_GRANT_INPUT.agent_id,
      delegated_by: B_VERIFY_KEY,
    });

    // Then: no grant matches — caller must run the approval flow on A's hub.
    expect(found).toBeNull();
  });

  it('CRITICAL: does NOT reuse a federated grant for a local call (mirror)', () => {
    // Given: a federated grant exists from B for the (tool, plugin, agent)
    // tuple with delegated_by = B_key.
    const grants = new GrantStore(db);
    grants.create({ ...SHARED_GRANT_INPUT, delegated_by: B_VERIFY_KEY });

    // When: a LOCAL call comes in with delegated_by = NULL.
    const found = grants.findActive({
      tool_name: SHARED_GRANT_INPUT.tool_name,
      plugin: SHARED_GRANT_INPUT.plugin,
      agent_id: SHARED_GRANT_INPUT.agent_id,
      delegated_by: null,
    });

    // Then: no grant matches — local calls are NEVER satisfied by a
    // federated grant (otherwise a peer could pre-establish authority that
    // local agents would inherit).
    expect(found).toBeNull();
  });

  it('returns the federated grant when a federated call from the same peer asks for it', () => {
    // Given: federated grant from B for the tuple.
    const grants = new GrantStore(db);
    const g = grants.create({ ...SHARED_GRANT_INPUT, delegated_by: B_VERIFY_KEY });

    // When: another federated call from B asks.
    const found = grants.findActive({
      tool_name: SHARED_GRANT_INPUT.tool_name,
      plugin: SHARED_GRANT_INPUT.plugin,
      agent_id: SHARED_GRANT_INPUT.agent_id,
      delegated_by: B_VERIFY_KEY,
    });

    // Then: the federated grant is reused — user only approves once per
    // (peer_verify_key, agent_id) pair.
    expect(found?.grant_id).toBe(g.grant_id);
    expect(found?.delegated_by).toBe(B_VERIFY_KEY);
  });

  it('does NOT confuse a federated grant from B with one from C', () => {
    // Given: a federated grant from B.
    const grants = new GrantStore(db);
    const gB = grants.create({ ...SHARED_GRANT_INPUT, delegated_by: B_VERIFY_KEY });
    grants.create({ ...SHARED_GRANT_INPUT, delegated_by: C_VERIFY_KEY });

    // When: a federated call from B asks.
    const found = grants.findActive({
      tool_name: SHARED_GRANT_INPUT.tool_name,
      plugin: SHARED_GRANT_INPUT.plugin,
      agent_id: SHARED_GRANT_INPUT.agent_id,
      delegated_by: B_VERIFY_KEY,
    });

    // Then: only B's grant matches. C's grant does not.
    expect(found?.grant_id).toBe(gB.grant_id);
    expect(found?.delegated_by).toBe(B_VERIFY_KEY);
  });

  it('returns null when tool_name differs (sanity, match key still works)', () => {
    const grants = new GrantStore(db);
    grants.create(SHARED_GRANT_INPUT);
    const found = grants.findActive({
      tool_name: 'differentTool',
      plugin: SHARED_GRANT_INPUT.plugin,
      agent_id: SHARED_GRANT_INPUT.agent_id,
      delegated_by: null,
    });
    expect(found).toBeNull();
  });

  it('skips revoked grants even when match key matches', () => {
    const grants = new GrantStore(db);
    const g = grants.create(SHARED_GRANT_INPUT);
    grants.revoke(g.grant_id);
    const found = grants.findActive({
      tool_name: SHARED_GRANT_INPUT.tool_name,
      plugin: SHARED_GRANT_INPUT.plugin,
      agent_id: SHARED_GRANT_INPUT.agent_id,
      delegated_by: null,
    });
    expect(found).toBeNull();
  });

  it('skips expired grants even when match key matches', () => {
    const grants = new GrantStore(db);
    grants.create({
      ...SHARED_GRANT_INPUT,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const found = grants.findActive({
      tool_name: SHARED_GRANT_INPUT.tool_name,
      plugin: SHARED_GRANT_INPUT.plugin,
      agent_id: SHARED_GRANT_INPUT.agent_id,
      delegated_by: null,
    });
    expect(found).toBeNull();
  });
});

describe('GrantStore.create — delegated_by round-trip', () => {
  it('defaults delegated_by to null when not provided', () => {
    const grants = new GrantStore(db);
    const g = grants.create(SHARED_GRANT_INPUT);
    expect(g.delegated_by).toBeNull();
  });

  it('stores and retrieves delegated_by verbatim', () => {
    const grants = new GrantStore(db);
    const g = grants.create({ ...SHARED_GRANT_INPUT, delegated_by: B_VERIFY_KEY });
    expect(g.delegated_by).toBe(B_VERIFY_KEY);
    const fetched = grants.getById(g.grant_id);
    expect(fetched?.delegated_by).toBe(B_VERIFY_KEY);
  });

  it('listActiveForUser surfaces delegated_by on every row', () => {
    const grants = new GrantStore(db);
    grants.create(SHARED_GRANT_INPUT);
    grants.create({ ...SHARED_GRANT_INPUT, agent_id: 'A_other_agent', delegated_by: B_VERIFY_KEY });
    const active = grants.listActiveForUser(SHARED_GRANT_INPUT.user_id);
    expect(active).toHaveLength(2);
    const byAgent = (a: string) => active.find((g) => g.agent_id === a);
    expect(byAgent(SHARED_GRANT_INPUT.agent_id)?.delegated_by).toBeNull();
    expect(byAgent('A_other_agent')?.delegated_by).toBe(B_VERIFY_KEY);
  });
});

describe('AuditLog — federation-context columns (Phase 2b schema, Phase 3 populates)', () => {
  it('appends a local entry with NULL delegation fields when not provided', () => {
    const audit = new AuditLog(db);
    const entry = audit.append({
      agent_id: 'a',
      user_id: 'local-user',
      tool_name: 't',
      plugin: 'p',
      scope: 's',
      justification: null,
      decision: 'approved',
      grant_id: 'g',
      duration_ms: 10,
    });
    expect(entry.delegated_by).toBeNull();
    expect(entry.delegated_to).toBeNull();
    expect(entry.decision_federated).toBeNull();
  });

  it('appends an A-side federated entry with delegated_by populated (Phase 3 example)', () => {
    const audit = new AuditLog(db);
    // A's hub received a federated call from B and approved it.
    const entry = audit.append({
      agent_id: 'A_local_agent',
      user_id: 'local-user',
      tool_name: 'listEvents',
      plugin: 'google-calendar',
      scope: 'calendar:read',
      justification: 'Read A\'s calendar for scheduling',
      decision: 'approved',
      grant_id: 'grant_uuid',
      duration_ms: 450,
      delegated_by: B_VERIFY_KEY,
      delegated_to: null,
      decision_federated: null,
    });
    expect(entry.delegated_by).toBe(B_VERIFY_KEY);
    expect(entry.delegated_to).toBeNull();
    expect(entry.decision_federated).toBeNull();
  });

  it('appends a B-side federated entry with delegated_to + decision_federated (Phase 3 example)', () => {
    const audit = new AuditLog(db);
    // B's hub proxied out to A — A approved.
    const entry = audit.append({
      agent_id: 'B_local_agent',
      user_id: 'local-user',
      tool_name: 'listEvents',
      plugin: 'google-calendar',
      scope: 'calendar:read',
      justification: 'Read A\'s calendar via federation',
      decision: 'approved',
      grant_id: null,
      duration_ms: 450,
      delegated_by: null,
      delegated_to: 'ed25519:A_public_key',
      decision_federated: 'federated_ok',
    });
    expect(entry.delegated_by).toBeNull();
    expect(entry.delegated_to).toBe('ed25519:A_public_key');
    expect(entry.decision_federated).toBe('federated_ok');
  });

  it('appends a B-side federated_denied entry (A denied the request)', () => {
    const audit = new AuditLog(db);
    const entry = audit.append({
      agent_id: 'B_local_agent',
      user_id: 'local-user',
      tool_name: 'listEvents',
      plugin: 'google-calendar',
      scope: 'calendar:read',
      justification: null,
      decision: 'denied',
      grant_id: null,
      duration_ms: 5,
      delegated_by: null,
      delegated_to: 'ed25519:A_public_key',
      decision_federated: 'federated_denied',
    });
    expect(entry.decision_federated).toBe('federated_denied');
  });

  it('query() returns the federation columns populated as written', () => {
    const audit = new AuditLog(db);
    audit.append({
      agent_id: 'B_local_agent',
      user_id: 'local-user',
      tool_name: 'listEvents',
      plugin: 'google-calendar',
      scope: 'calendar:read',
      justification: null,
      decision: 'approved',
      grant_id: null,
      duration_ms: 450,
      delegated_to: 'ed25519:A_public_key',
      decision_federated: 'federated_ok',
    });
    const all = audit.query({ user_id: 'local-user' });
    expect(all).toHaveLength(1);
    const e = all[0];
    expect(e?.delegated_to).toBe('ed25519:A_public_key');
    expect(e?.decision_federated).toBe('federated_ok');
    expect(e?.delegated_by).toBeNull();
  });
});

describe('Migration v4 (Phase 2b) — schema additions', () => {
  it('adds the four federation-context columns on a fresh DB', () => {
    // Use a fresh DB (beforeEach already ran runMigrations).
    const auditCols = db
      .prepare("PRAGMA table_info(audit_log)")
      .all() as Array<{ name: string }>;
    const auditNames = auditCols.map((c) => c.name);
    for (const col of ['delegated_by', 'delegated_to', 'decision_federated']) {
      expect(auditNames).toContain(col);
    }
    const grantCols = db
      .prepare("PRAGMA table_info(grants)")
      .all() as Array<{ name: string }>;
    expect(grantCols.map((c) => c.name)).toContain('delegated_by');
  });

  it('columns are nullable (no NOT NULL constraint)', () => {
    // Insert a row with all federation columns NULL — should succeed.
    expect(() =>
      db.prepare(`
        INSERT INTO audit_log (
          id, timestamp, agent_id, user_id, tool_name, plugin, scope,
          justification, decision, grant_id, duration_ms, error,
          delegated_by, delegated_to, decision_federated
        ) VALUES (
          'id1', '2026-01-01T00:00:00Z', 'a', 'u', 't', 'p', 's',
          NULL, 'approved', NULL, 0, NULL,
          NULL, NULL, NULL
        )
      `).run(),
    ).not.toThrow();
    expect(() =>
      db.prepare(`
        INSERT INTO grants (
          grant_id, tool_name, plugin, scope, agent_id, user_id,
          created_at, expires_at, revoked, delegated_by
        ) VALUES (
          'g1', 't', 'p', 's', 'a', 'u',
          '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 0, NULL
        )
      `).run(),
    ).not.toThrow();
  });

  it('upgrades a v3-only DB (Phase 2a only) — adds v4 columns in-place', () => {
    const v3 = new Database(':memory:');
    try {
      // Simulate Phase 2a-only install: Phase 0.5 + 1 + 2a migrations applied.
      v3.exec(`
        CREATE TABLE audit_log (
          id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, agent_id TEXT NOT NULL,
          user_id TEXT NOT NULL, tool_name TEXT NOT NULL, plugin TEXT NOT NULL,
          scope TEXT NOT NULL, justification TEXT, decision TEXT NOT NULL,
          grant_id TEXT, duration_ms INTEGER NOT NULL, error TEXT
        );
        CREATE TABLE grants (
          grant_id TEXT PRIMARY KEY, tool_name TEXT NOT NULL, plugin TEXT NOT NULL,
          scope TEXT NOT NULL, agent_id TEXT NOT NULL, user_id TEXT NOT NULL,
          created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
          revoked INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE token_vault (
          plugin TEXT PRIMARY KEY, access_token_enc BLOB NOT NULL,
          access_token_iv BLOB NOT NULL, access_token_tag BLOB NOT NULL,
          refresh_token_enc BLOB, refresh_token_iv BLOB, refresh_token_tag BLOB,
          expires_at TEXT, scope TEXT NOT NULL, created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
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
      `);
      v3.pragma('user_version = 3');

      runMigrations(v3);

      // v4 ALTER TABLEs succeeded — columns now exist.
      const auditCols = v3
        .prepare("PRAGMA table_info(audit_log)")
        .all() as Array<{ name: string }>;
      const auditNames = auditCols.map((c) => c.name);
      expect(auditNames).toEqual(
        expect.arrayContaining(['delegated_by', 'delegated_to', 'decision_federated']),
      );
      const grantCols = v3
        .prepare("PRAGMA table_info(grants)")
        .all() as Array<{ name: string }>;
      expect(grantCols.map((c) => c.name)).toContain('delegated_by');
    } finally {
      v3.close();
    }
  });

  it('re-running runMigrations on a v4 DB is a no-op (idempotent at runner level)', () => {
    runMigrations(db);
    // Re-running should NOT throw even though the column already exists —
    // the runner short-circuits on `user_version >= 4`.
    expect(() => runMigrations(db)).not.toThrow();
  });
});
