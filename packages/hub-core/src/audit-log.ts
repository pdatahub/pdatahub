/**
 * Audit log — append-only record of every request/decision.
 *
 * SQLite-backed. No UPDATE or DELETE allowed (immutable by convention).
 * Hub is single source of truth: even if laptop MCP lies, Hub knows what happened.
 *
 * Phase 2b (Federation v2) adds three nullable columns to the audit log:
 *   - `delegated_by` (TEXT) — verify_key of the peer hub that initiated
 *     the call. Populated on A's hub when A receives a federated call from
 *     B. NULL for local calls. Lets "show me what B's hub did on my data"
 *     queries filter by `delegated_by = B_verify_key` instead of scanning
 *     every row.
 *   - `delegated_to` (TEXT) — mirror of `delegated_by`. Populated on B's
 *     hub when B proxies out to A. NULL for local calls and on A's hub.
 *   - `decision_federated` (TEXT) — distinct outcome for federated calls
 *     on the originating (B-side) hub. Values: 'federated_ok',
 *     'federated_denied', 'federated_error'. NULL for local calls and on
 *     A's hub (A uses the standard `decision` column: 'approved' /
 *     'denied' / 'error'). The split (Momus C3) keeps the existing
 *     `decision` column semantically stable: it always means "this hub
 *     made the approval decision". `decision_federated` is the bridge
 *     between "approved by A" and "the result came back from A".
 *
 * Phase 2b only changes the schema and the input shape; the call paths
 * still write NULLs for local calls. Phase 3 (federation_nonces + the
 * /v1/federation/call endpoint) populates the columns for real.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { AuditDecision, AuditEntry } from './types.js';

export interface AuditAppendInput {
  agent_id: string;
  user_id: string;
  tool_name: string;
  plugin: string;
  scope: string;
  justification: string | null;
  decision: AuditDecision;
  grant_id: string | null;
  duration_ms: number;
  error?: string;
  /**
   * Phase 2b — peer verify_key when this hub received a federated call
   * (NULL on local calls). See file header for which hub populates what.
   */
  delegated_by?: string | null;
  /**
   * Phase 2b — peer verify_key when this hub proxied a federated call out
   * (NULL on local calls and on the receiving hub).
   */
  delegated_to?: string | null;
  /**
   * Phase 2b — Momus C3 distinct outcome on the originating hub for
   * federated calls ('federated_ok' | 'federated_denied' | 'federated_error').
   * NULL on local calls and on the receiving hub.
   */
  decision_federated?: string | null;
  /**
   * Plugin SDK v2 — name of the PluginError subclass (e.g.
   * "AuthExpiredError"). Set by the error router when the plugin
   * throws a PluginError; null for non-PluginError failures and
   * successful calls.
   */
  error_class?: string | null;
  /**
   * Plugin SDK v2 — machine-readable error code from `PluginError.code`
   * (e.g. "AUTH_EXPIRED"). Set together with `error_class`.
   */
  error_code?: string | null;
}

export interface AuditQueryOptions {
  /** Filter by agent. */
  agent_id?: string;
  /** Filter by user. */
  user_id?: string;
  /** Filter by tool name. */
  tool_name?: string;
  /** Filter by decision. */
  decision?: AuditDecision;
  /** Maximum entries to return. */
  limit?: number;
  /** Return entries newer than this ISO 8601 timestamp. */
  since?: string;
}

export class AuditLog {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        plugin TEXT NOT NULL,
        scope TEXT NOT NULL,
        justification TEXT,
        decision TEXT NOT NULL,
        grant_id TEXT,
        duration_ms INTEGER NOT NULL,
        error TEXT,
        delegated_by TEXT,
        delegated_to TEXT,
        decision_federated TEXT,
        error_class TEXT,
        error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_log(agent_id);
      CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_tool ON audit_log(tool_name);
      CREATE INDEX IF NOT EXISTS idx_audit_decision ON audit_log(decision);
    `);
  }

  /**
   * Append a new audit entry. Returns the created entry with id and timestamp.
   */
  append(input: AuditAppendInput): AuditEntry {
    const entry: AuditEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      delegated_by: input.delegated_by ?? null,
      delegated_to: input.delegated_to ?? null,
      decision_federated: input.decision_federated ?? null,
      error_class: input.error_class ?? null,
      error_code: input.error_code ?? null,
      ...input,
    };
    this.db.prepare(`
      INSERT INTO audit_log (id, timestamp, agent_id, user_id, tool_name, plugin, scope,
                             justification, decision, grant_id, duration_ms, error,
                             delegated_by, delegated_to, decision_federated,
                             error_class, error_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.timestamp,
      entry.agent_id,
      entry.user_id,
      entry.tool_name,
      entry.plugin,
      entry.scope,
      entry.justification,
      entry.decision,
      entry.grant_id,
      entry.duration_ms,
      entry.error ?? null,
      entry.delegated_by ?? null,
      entry.delegated_to ?? null,
      entry.decision_federated ?? null,
      entry.error_class ?? null,
      entry.error_code ?? null,
    );
    return entry;
  }

  /**
   * Query audit log with filters. Newest first.
   */
  query(opts: AuditQueryOptions = {}): AuditEntry[] {
    const where: string[] = [];
    const params: unknown[] = [];

    if (opts.agent_id) {
      where.push('agent_id = ?');
      params.push(opts.agent_id);
    }
    if (opts.user_id) {
      where.push('user_id = ?');
      params.push(opts.user_id);
    }
    if (opts.tool_name) {
      where.push('tool_name = ?');
      params.push(opts.tool_name);
    }
    if (opts.decision) {
      where.push('decision = ?');
      params.push(opts.decision);
    }
    if (opts.since) {
      where.push('timestamp > ?');
      params.push(opts.since);
    }

    const limit = opts.limit ?? 100;
    const sql = `
      SELECT id, timestamp, agent_id, user_id, tool_name, plugin, scope,
             justification, decision, grant_id, duration_ms, error,
             delegated_by, delegated_to, decision_federated,
             error_class, error_code
      FROM audit_log
      ${where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY timestamp DESC
      LIMIT ?
    `;
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as AuditRow[];
    return rows.map(rowToEntry);
  }

  /**
   * Plugin SDK v2 — return audit entries whose `error_code` column matches
   * the given stable code (e.g. "AUTH_EXPIRED", "VALIDATION_FAILED").
   * Newest first, capped at `limit` (default 100). Diagnostic helper
   * for the Hub operator / CLI: "show me every AUTH_EXPIRED event in
   * the last 30 days for the google-calendar plugin".
   *
   * Returns `[]` when no rows match (including when `code` is empty /
   * unknown — there is no implicit "all errors" wildcard, the caller
   * can pass `'%'` if they want it).
   */
  getByErrorCode(code: string, limit?: number): AuditEntry[] {
    const cappedLimit = limit ?? 100;
    const rows = this.db
      .prepare(
        `SELECT id, timestamp, agent_id, user_id, tool_name, plugin, scope,
                justification, decision, grant_id, duration_ms, error,
                delegated_by, delegated_to, decision_federated,
                error_class, error_code
         FROM audit_log
         WHERE error_code = ?
         ORDER BY timestamp DESC
         LIMIT ?`,
      )
      .all(code, cappedLimit) as AuditRow[];
    return rows.map(rowToEntry);
  }

  /**
   * Aggregate stats: counts per decision type.
   * Useful for Hub UI dashboard.
   */
  stats(user_id?: string): Record<AuditDecision, number> {
    const where = user_id ? 'WHERE user_id = ?' : '';
    const params = user_id ? [user_id] : [];
    const rows = this.db.prepare(`
      SELECT decision, COUNT(*) as count FROM audit_log ${where} GROUP BY decision
    `).all(...params) as Array<{ decision: AuditDecision; count: number }>;
    const result: Record<AuditDecision, number> = {
      approved: 0,
      denied: 0,
      auto_allowed: 0,
      expired: 0,
      revoked: 0,
      error: 0,
    };
    for (const row of rows) {
      result[row.decision] = row.count;
    }
    return result;
  }

  /**
   * Phase 7b (Federation v2) — audit retention policy.
   *
   * Counts the rows in `audit_log` whose `timestamp < cutoffISO`. Used by
   * the `pdatahub-hub audit purge --older-than Nd` CLI to show the operator
   * what would be deleted (preview mode) and to perform the actual delete
   * (with `--yes`). No background job — manual trigger only.
   *
   * Federation multiplies row volume by 2x per federated call (both hubs
   * log), so the recommended purge cadence is shorter than for a
   * single-hub install. See docs/federation.md §"Audit retention".
   *
   * Returns the count of matching rows. Pure read; no mutations.
   */
  countOlderThan(cutoffISO: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as n FROM audit_log WHERE timestamp < ?`)
      .get(cutoffISO) as { n: number };
    return row.n;
  }

  /**
   * Delete every row in `audit_log` whose `timestamp < cutoffISO`.
   * Parameterized SQL — `cutoffISO` is bound, never interpolated. Returns
   * the number of rows actually deleted (`changes` from the prepared
   * statement), so the CLI can print "Deleted N rows" with confidence.
   *
   * Federation context (`delegated_by`, `delegated_to`,
   * `decision_federated`) on surviving rows is untouched — the purge is
   * column-agnostic and only removes whole rows by timestamp.
   *
   * VACUUM is NOT run after the delete. SQLite's incremental vacuum
   * policy is left at its default; for very large purges (millions of
   * rows) the user can run `VACUUM` manually. We deliberately don't
   * auto-vacuum because it locks the DB and would surprise users with
   * a multi-second pause on every purge.
   */
  purgeOlderThan(cutoffISO: string): number {
    const result = this.db
      .prepare(`DELETE FROM audit_log WHERE timestamp < ?`)
      .run(cutoffISO);
    return result.changes;
  }
}

interface AuditRow {
  id: string;
  timestamp: string;
  agent_id: string;
  user_id: string;
  tool_name: string;
  plugin: string;
  scope: string;
  justification: string | null;
  decision: AuditDecision;
  grant_id: string | null;
  duration_ms: number;
  error: string | null;
  delegated_by: string | null;
  delegated_to: string | null;
  decision_federated: string | null;
  error_class: string | null;
  error_code: string | null;
}

function rowToEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    timestamp: row.timestamp,
    agent_id: row.agent_id,
    user_id: row.user_id,
    tool_name: row.tool_name,
    plugin: row.plugin,
    scope: row.scope,
    justification: row.justification,
    decision: row.decision,
    grant_id: row.grant_id,
    duration_ms: row.duration_ms,
    ...(row.error ? { error: row.error } : {}),
    delegated_by: row.delegated_by,
    delegated_to: row.delegated_to,
    decision_federated: row.decision_federated,
    error_class: row.error_class,
    error_code: row.error_code,
  };
}
