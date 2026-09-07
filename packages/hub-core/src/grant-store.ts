/**
 * Grant store — time-bounded permissions for AI agent tool calls.
 *
 * SQLite-backed. Lazy expiration: every read checks expires_at vs now().
 * Revoked grants stay in DB (audit trail) but isValid() returns false.
 *
 * Phase 2b (federation v2) adds `delegated_by` to the match key for
 * `ensureGrant`. Without it, a LOCAL grant could satisfy a FEDERATED call
 * (both share the same `tool_name + agent_id + plugin` tuple but differ in
 * who initiated the request) — bypassing A's approval flow entirely
 * (Momus C1 — critical security hole). With `delegated_by` in the match
 * key:
 *   - Local grants have `delegated_by = NULL`
 *   - Federated grants from peer B have `delegated_by = 'ed25519:B_pub...'`
 * The match key is `(tool_name, plugin, agent_id, delegated_by)`. The
 * NULL/value distinction is enforced at the SQL layer via `IS ?` (which
 * correctly matches both NULL and value parameters in SQLite), so the
 * caller's `null` or `string` value passes through as-is.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Grant } from './types.js';
import { logger } from './logger.js';

export class GrantStore {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS grants (
        grant_id TEXT PRIMARY KEY,
        tool_name TEXT NOT NULL,
        plugin TEXT NOT NULL,
        scope TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        delegated_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_grants_agent ON grants(agent_id);
      CREATE INDEX IF NOT EXISTS idx_grants_tool ON grants(tool_name);
      CREATE INDEX IF NOT EXISTS idx_grants_expires ON grants(expires_at);
    `);
  }

  /**
   * Create a new active grant. Caller passes created/expires timestamps.
   * `delegated_by` defaults to null — local grants always have NULL.
   */
  create(input: {
    tool_name: string;
    plugin: string;
    scope: string;
    agent_id: string;
    user_id: string;
    expires_at: string;
    /** Peer verify_key for federated calls (null for local). */
    delegated_by?: string | null;
  }): Grant {
    const delegatedBy = input.delegated_by ?? null;
    const grant: Grant = {
      grant_id: randomUUID(),
      tool_name: input.tool_name,
      plugin: input.plugin,
      scope: input.scope,
      agent_id: input.agent_id,
      user_id: input.user_id,
      created_at: new Date().toISOString(),
      expires_at: input.expires_at,
      revoked: false,
      delegated_by: delegatedBy,
    };
    this.db.prepare(`
      INSERT INTO grants (grant_id, tool_name, plugin, scope, agent_id, user_id, created_at, expires_at, revoked, delegated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      grant.grant_id,
      grant.tool_name,
      grant.plugin,
      grant.scope,
      grant.agent_id,
      grant.user_id,
      grant.created_at,
      grant.expires_at,
      delegatedBy,
    );
    logger.info('grant created', {
      grant_id: grant.grant_id,
      tool: grant.tool_name,
      agent: grant.agent_id,
      delegated_by: delegatedBy,
      expires_at: grant.expires_at,
    });
    return grant;
  }

  /**
   * Look up grant by ID. Returns null if not found.
   */
  getById(grant_id: string): Grant | null {
    const row = this.db.prepare(`
      SELECT grant_id, tool_name, plugin, scope, agent_id, user_id, created_at, expires_at, revoked, delegated_by
      FROM grants WHERE grant_id = ?
    `).get(grant_id) as GrantRow | undefined;
    return row ? rowToGrant(row) : null;
  }

  /**
   * Check if grant is valid: exists, not revoked, not expired.
   * If expired AND not revoked, mark as revoked (lazy cleanup).
   */
  isValid(grant_id: string): boolean {
    const grant = this.getById(grant_id);
    if (!grant) return false;
    if (grant.revoked) return false;
    const now = Date.now();
    const expiresMs = Date.parse(grant.expires_at);
    if (now >= expiresMs) {
      // Lazy expiration: mark as revoked
      this.revoke(grant_id);
      logger.info('grant auto-expired', { grant_id });
      return false;
    }
    return true;
  }

  /**
   * Revoke a grant (manual or auto-expiry).
   */
  revoke(grant_id: string): boolean {
    const result = this.db.prepare(`
      UPDATE grants SET revoked = 1 WHERE grant_id = ?
    `).run(grant_id);
    if (result.changes > 0) {
      logger.info('grant revoked', { grant_id });
      return true;
    }
    return false;
  }

  /**
   * List all active grants for a user.
   */
  listActiveForUser(user_id: string): Grant[] {
    const rows = this.db.prepare(`
      SELECT grant_id, tool_name, plugin, scope, agent_id, user_id, created_at, expires_at, revoked, delegated_by
      FROM grants
      WHERE user_id = ? AND revoked = 0 AND expires_at > ?
      ORDER BY created_at DESC
    `).all(user_id, new Date().toISOString()) as GrantRow[];
    return rows.map(rowToGrant);
  }

  /**
   * Phase 2b — find an active grant for the given (tool, plugin, agent,
   * delegated_by) tuple.
   *
   * This is the core of `ensureGrant`. The match key MUST distinguish
   * local grants from federated grants — see Momus C1 for the original
   * security hole this prevents:
   *
   *   - Without `delegated_by` in the key: a local grant on
   *     (listEvents, A_local_agent, google-calendar) would satisfy a
   *     federated call from B with the same tool/agent/plugin — B's call
   *     bypasses A's approval flow.
   *   - With `delegated_by` in the key: the federated call passes
   *     `delegated_by = 'ed25519:B_pub...'`, which does not match the
   *     local grant (`delegated_by = NULL`), forcing fresh approval.
   *
   * The same logic applies in reverse: a federated grant with
   * `delegated_by = B_pub` does not satisfy a local call from A's AI
   * (which passes `delegated_by = null`).
   *
   * SQL: `delegated_by IS ?` is the idiomatic SQLite form for
   * "match this value or NULL if ? is NULL" — better-sqlite3 binds a JS
   * `null` parameter as SQL NULL, and SQLite's `IS NULL` evaluates true
   * when both operands are NULL. Verified in tests/find-active.test.ts.
   *
   * Returns null when no active grant matches — caller falls through to
   * the approval flow.
   */
  findActive(input: {
    tool_name: string;
    plugin: string;
    agent_id: string;
    delegated_by: string | null;
  }): Grant | null {
    const row = this.db.prepare(`
      SELECT grant_id, tool_name, plugin, scope, agent_id, user_id, created_at, expires_at, revoked, delegated_by
      FROM grants
      WHERE tool_name = ?
        AND plugin = ?
        AND agent_id = ?
        AND delegated_by IS ?
        AND revoked = 0
        AND expires_at > ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(
      input.tool_name,
      input.plugin,
      input.agent_id,
      input.delegated_by,
      new Date().toISOString(),
    ) as GrantRow | undefined;
    return row ? rowToGrant(row) : null;
  }
}

interface GrantRow {
  grant_id: string;
  tool_name: string;
  plugin: string;
  scope: string;
  agent_id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  revoked: number;
  delegated_by: string | null;
}

function rowToGrant(row: GrantRow): Grant {
  return {
    grant_id: row.grant_id,
    tool_name: row.tool_name,
    plugin: row.plugin,
    scope: row.scope,
    agent_id: row.agent_id,
    user_id: row.user_id,
    created_at: row.created_at,
    expires_at: row.expires_at,
    revoked: row.revoked === 1,
    delegated_by: row.delegated_by,
  };
}
