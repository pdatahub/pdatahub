/**
 * Grant store — time-bounded permissions for AI agent tool calls.
 *
 * SQLite-backed. Lazy expiration: every read checks expires_at vs now().
 * Revoked grants stay in DB (audit trail) but isValid() returns false.
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
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_grants_agent ON grants(agent_id);
      CREATE INDEX IF NOT EXISTS idx_grants_tool ON grants(tool_name);
      CREATE INDEX IF NOT EXISTS idx_grants_expires ON grants(expires_at);
    `);
  }

  /**
   * Create a new active grant. Caller passes created/expires timestamps.
   */
  create(input: {
    tool_name: string;
    plugin: string;
    scope: string;
    agent_id: string;
    user_id: string;
    expires_at: string;
  }): Grant {
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
    };
    this.db.prepare(`
      INSERT INTO grants (grant_id, tool_name, plugin, scope, agent_id, user_id, created_at, expires_at, revoked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      grant.grant_id,
      grant.tool_name,
      grant.plugin,
      grant.scope,
      grant.agent_id,
      grant.user_id,
      grant.created_at,
      grant.expires_at,
    );
    logger.info('grant created', {
      grant_id: grant.grant_id,
      tool: grant.tool_name,
      agent: grant.agent_id,
      expires_at: grant.expires_at,
    });
    return grant;
  }

  /**
   * Look up grant by ID. Returns null if not found.
   */
  getById(grant_id: string): Grant | null {
    const row = this.db.prepare(`
      SELECT grant_id, tool_name, plugin, scope, agent_id, user_id, created_at, expires_at, revoked
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
      SELECT grant_id, tool_name, plugin, scope, agent_id, user_id, created_at, expires_at, revoked
      FROM grants
      WHERE user_id = ? AND revoked = 0 AND expires_at > ?
      ORDER BY created_at DESC
    `).all(user_id, new Date().toISOString()) as GrantRow[];
    return rows.map(rowToGrant);
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
  };
}
