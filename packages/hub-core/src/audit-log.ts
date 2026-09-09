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
 *
 * T-PERSISTENT-001 mitigation #2 — three more actor-context columns on
 * `audit_log`, populated by `recordVaultAccess()` for every
 * `TokenVault.getAccessToken()` call (whether successful or not):
 *   - `actor_type` (TEXT) — 'agent' | 'user' | 'system'
 *   - `actor_id`   (TEXT) — agent_id / user id / 'local-user'
 *   - `request_id` (TEXT) — correlation ID from the originating MCP call
 *
 * The corresponding audit row uses `decision = 'vault_access'` and is
 * broadcast live to the Android UI via `ApprovalStream.broadcastVaultAccess`
 * (wired through `setBroadcaster`). Writing + broadcasting happens in a
 * `setImmediate` callback so the vault read returns to its caller without
 * waiting on SQLite + WebSocket I/O — see T-PERSISTENT-001 mitigation #2
 * requirement "non-blocking".
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { AuditDecision, AuditEntry, VaultAccessUpdate } from './types.js';
import { logger } from './logger.js';

/**
 * T-PERSISTENT-001 mitigation #2 — broadcaster interface for vault-access
 * audit rows. Only `broadcastVaultAccess` is required; the existing
 * server.ts audit-broadcast path is unaffected (it uses
 * `ApprovalStream.broadcastAudit` directly).
 *
 * Defined as a structural type (not a class import) so this file doesn't
 * circular-depend on `approval-stream.ts` (which imports `AuditEntry`
 * from `types.ts`). `ApprovalStream` satisfies this interface at the
 * `setBroadcaster` call site (server.ts / hub startup).
 */
export interface VaultAccessBroadcaster {
  broadcastVaultAccess(notif: VaultAccessUpdate): void;
}

/**
 * Result code for a `TokenVault.getAccessToken()` call. Stored implicitly
 * via the `decision` (always `'vault_access'`) + `error` (NULL for
 * success, populated with a short message for the other three) columns.
 *
 * `'denied'` is reserved for future policy hooks (e.g. require extra
 * approval for a sensitive plugin's tokens). Today, no caller passes it.
 */
export type VaultAccessResult = 'success' | 'denied' | 'not_found' | 'error';

export interface VaultAccessInput {
  plugin: string;
  actor_type: 'agent' | 'user' | 'system';
  actor_id: string;
  tool_name?: string | null;
  request_id?: string | null;
  result: VaultAccessResult;
  error_message?: string | null;
}

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
  /**
   * T-PERSISTENT-001 mitigation #2 — who triggered the vault decryption
   * (only set on `decision = 'vault_access'` rows). `'agent'` for an MCP
   * call from an AI agent, `'user'` for direct hub-initiated OAuth flows,
   * `'system'` for proactive refreshes and other internal callers.
   */
  actor_type?: string | null;
  /**
   * T-PERSISTENT-001 mitigation #2 — identifier of the actor above
   * (e.g. the agent_id from the MCP request, or 'local-user').
   */
  actor_id?: string | null;
  /**
   * T-PERSISTENT-001 mitigation #2 — correlation ID from the originating
   * MCP call. Lets the Android UI join a vault-decryption row with its
   * matching tool-call audit row in the live stream.
   */
  request_id?: string | null;
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
  /**
   * T-PERSISTENT-001 mitigation #2 — optional broadcaster for vault-access
   * audit rows. Set via `setBroadcaster()` from hub startup. When unset
   * (tests, CLI tools), `recordVaultAccess()` still writes to SQLite but
   * skips the WebSocket broadcast.
   */
  private broadcaster: VaultAccessBroadcaster | null = null;

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
        error_code TEXT,
        actor_type TEXT,
        actor_id TEXT,
        request_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_log(agent_id);
      CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_tool ON audit_log(tool_name);
      CREATE INDEX IF NOT EXISTS idx_audit_decision ON audit_log(decision);
    `);
  }

  /**
   * T-PERSISTENT-001 mitigation #2 — wire the WebSocket broadcaster used
   * by `recordVaultAccess()`. Pass `null` to disable broadcasting (e.g.
   * in tests or CLI tools that don't run an `/approval-stream` server).
   * Safe to call multiple times (e.g. when hub reloads its approval
   * stream).
   */
  setBroadcaster(broadcaster: VaultAccessBroadcaster | null): void {
    this.broadcaster = broadcaster;
  }

  /**
   * T-PERSISTENT-001 mitigation #2 — record one vault-decryption event.
   *
   * Writes a `decision = 'vault_access'` row to `audit_log` and, if a
   * broadcaster is wired, pushes a `vault_access` WebSocket frame to
   * connected Android clients (filtered by `userAgent === 'android-hub'`
   * inside `ApprovalStream.broadcastVaultAccess`).
   *
   * Non-blocking: the SQLite write + WebSocket broadcast happen inside
   * a `setImmediate` callback so the calling `TokenVault.getAccessToken`
   * returns to its caller without waiting on disk I/O. The `result` is
   * encoded as follows:
   *
   *   - `'success'`   — no `error` column (plain success row).
   *   - `'not_found'` — `error = 'no_token_for_plugin:<plugin>'`. The
   *                     caller still throws the original error.
   *   - `'denied'`    — reserved for future policy hooks (no caller
   *                     passes it today; writes `error =
   *                     'denied_by_policy'`).
   *   - `'error'`     — `error = <input.error_message ?? 'decrypt_failed'>`.
   *
   * `setImmediate` callbacks can be flushed before process exit; for the
   * daemonized hub this is fine (the audit write happens milliseconds
   * after the decrypt returns and is persisted by the SQLite WAL). For
   * short-lived tests we expose a synchronous variant via
   * `recordVaultAccessSync()` that callers can await when ordering matters.
   */
  recordVaultAccess(input: VaultAccessInput): void {
    setImmediate(() => {
      const errorValue =
        input.result === 'success'
          ? null
          : input.error_message ??
            (input.result === 'not_found'
              ? `no_token_for_plugin:${input.plugin}`
              : input.result === 'denied'
                ? 'denied_by_policy'
                : 'decrypt_failed');

      let entry: AuditEntry;
      try {
        entry = this.append({
          agent_id: input.actor_id,
          user_id: 'local-user',
          tool_name: input.tool_name ?? '',
          plugin: input.plugin,
          scope: 'vault:decrypt',
          justification: null,
          decision: 'vault_access',
          grant_id: null,
          duration_ms: 0,
          ...(errorValue ? { error: errorValue } : {}),
          delegated_by: null,
          delegated_to: null,
          decision_federated: null,
          actor_type: input.actor_type,
          actor_id: input.actor_id,
          request_id: input.request_id ?? null,
        });
      } catch (err) {
        logger.error('vault audit write failed', {
          plugin: input.plugin,
          error: (err as Error).message,
        });
        return;
      }

      if (this.broadcaster) {
        try {
          this.broadcaster.broadcastVaultAccess({ type: 'vault_access', entry });
        } catch (err) {
          logger.warn('vault audit broadcast failed', {
            plugin: input.plugin,
            error: (err as Error).message,
          });
        }
      }
    });
  }

  /**
   * T-PERSISTENT-001 mitigation #2 — synchronous variant of
   * `recordVaultAccess()` for tests that need to assert on the written
   * row before the test ends. Production code paths use
   * `recordVaultAccess()` (non-blocking). The broadcaster is called
   * inline here so tests can observe the WebSocket frame too.
   */
  recordVaultAccessSync(input: VaultAccessInput): AuditEntry {
    const errorValue =
      input.result === 'success'
        ? null
        : input.error_message ??
          (input.result === 'not_found'
            ? `no_token_for_plugin:${input.plugin}`
            : input.result === 'denied'
              ? 'denied_by_policy'
              : 'decrypt_failed');

    const entry = this.append({
      agent_id: input.actor_id,
      user_id: 'local-user',
      tool_name: input.tool_name ?? '',
      plugin: input.plugin,
      scope: 'vault:decrypt',
      justification: null,
      decision: 'vault_access',
      grant_id: null,
      duration_ms: 0,
      ...(errorValue ? { error: errorValue } : {}),
      delegated_by: null,
      delegated_to: null,
      decision_federated: null,
      actor_type: input.actor_type,
      actor_id: input.actor_id,
      request_id: input.request_id ?? null,
    });

    if (this.broadcaster) {
      try {
        this.broadcaster.broadcastVaultAccess({ type: 'vault_access', entry });
      } catch (err) {
        logger.warn('vault audit broadcast failed', {
          plugin: input.plugin,
          error: (err as Error).message,
        });
      }
    }

    return entry;
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
      actor_type: input.actor_type ?? null,
      actor_id: input.actor_id ?? null,
      request_id: input.request_id ?? null,
      ...input,
    };
    this.db.prepare(`
      INSERT INTO audit_log (id, timestamp, agent_id, user_id, tool_name, plugin, scope,
                             justification, decision, grant_id, duration_ms, error,
                             delegated_by, delegated_to, decision_federated,
                             error_class, error_code,
                             actor_type, actor_id, request_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      entry.actor_type ?? null,
      entry.actor_id ?? null,
      entry.request_id ?? null,
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
             error_class, error_code,
             actor_type, actor_id, request_id
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
                error_class, error_code,
                actor_type, actor_id, request_id
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
      vault_access: 0,
      token_rotation: 0,
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

  /**
   * T-PERSISTENT-001 mitigation #3 — log a refresh_token rotation event.
   *
   * Google rotates `refresh_token` when:
   *   - scopes change (user re-consents to expanded scope)
   *   - the previous refresh_token has been idle for >6 months
   *   - explicit `prompt=consent` re-auth (always rotates)
   *
   * When rotation happens, the OLD refresh_token is invalidated by
   * Google. If an attacker had extracted the old refresh_token
   * (T-PERSISTENT-001 attack), that extracted token is now useless.
   *
   * This audit row is written synchronously because:
   *   - the event is rare (not every refresh rotates)
   *   - we want the row visible immediately in `getRecent()` for
   *     incident response queries
   *   - the audit row is small (no token bytes — only metadata)
   */
  recordTokenRotation(input: {
    plugin: string;
    rotated: boolean;
    expires_at: string;
    scope: string;
  }): AuditEntry {
    return this.append({
      agent_id: 'system:token-refresh',
      user_id: 'local-user',
      tool_name: 'refreshAccessToken',
      plugin: input.plugin,
      scope: input.scope,
      justification: null,
      decision: 'token_rotation',
      grant_id: null,
      duration_ms: 0,
      ...(input.rotated ? {} : { error: 'no_rotation' }),
    });
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
  actor_type: string | null;
  actor_id: string | null;
  request_id: string | null;
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
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    request_id: row.request_id,
  };
}
