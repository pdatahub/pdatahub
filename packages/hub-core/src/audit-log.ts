/**
 * Audit log — append-only record of every request/decision.
 *
 * SQLite-backed. No UPDATE or DELETE allowed (immutable by convention).
 * Hub is single source of truth: even if laptop MCP lies, Hub knows what happened.
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
        error TEXT
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
      ...input,
    };
    this.db.prepare(`
      INSERT INTO audit_log (id, timestamp, agent_id, user_id, tool_name, plugin, scope,
                             justification, decision, grant_id, duration_ms, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
             justification, decision, grant_id, duration_ms, error
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
  };
}
