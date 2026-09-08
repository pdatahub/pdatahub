/**
 * Phase 7b (Federation v2) — audit retention policy tests.
 *
 * Two layers:
 *   1. **SQL primitives** — direct tests for `AuditLog.countOlderThan` and
 *      `AuditLog.purgeOlderThan`. The CLI is a thin wrapper over these.
 *   2. **CLI integration** — spawn `pdatahub-hub audit purge` as a child
 *      process (same pattern as `delegation-cli.test.ts`). Skipped when
 *      `dist/index.js` is not built.
 *
 * Federation context columns (`delegated_by`, `delegated_to`,
 * `decision_federated`) are explicitly tested to survive a purge — the
 * purge is column-agnostic and only filters on `timestamp`. Surviving
 * rows must keep their federation context for downstream queries like
 * "show me what userB's hub did in the last 30 days".
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { AuditLog } from '../src/audit-log.js';
import { runMigrations } from '../src/migrations.js';
import { parseDurationAgo } from '../src/federation/delegation-cli.js';

const MASTER_KEY = 'a'.repeat(64);

let dbPath: string;
let dir: string;
let db: Database.Database;
const originalToken = process.env.HUB_API_TOKEN;
const tempDirs: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pdatahub-audit-purge-'));
  dbPath = join(dir, 'hub.db');
  tempDirs.push(dir);
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  runMigrations(db);
});

afterEach(() => {
  db.close();
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  if (originalToken === undefined) delete process.env.HUB_API_TOKEN;
  else process.env.HUB_API_TOKEN = originalToken;
});

/**
 * Append a row with a specific timestamp so the cutoff math is
 * deterministic. Bypasses `AuditLog.append` (which always uses
 * `new Date().toISOString()`).
 */
function appendAt(timestamp: string, fields: {
  decision: 'approved' | 'denied';
  delegated_by?: string | null;
  delegated_to?: string | null;
  decision_federated?: string | null;
}): void {
  db.prepare(`
    INSERT INTO audit_log (
      id, timestamp, agent_id, user_id, tool_name, plugin, scope,
      justification, decision, grant_id, duration_ms, error,
      delegated_by, delegated_to, decision_federated
    ) VALUES (
      ?, ?, 'a1', 'local-user', 'listEvents', 'google-calendar', 'calendar:read',
      NULL, ?, 'g1', 100, NULL,
      ?, ?, ?
    )
  `).run(
    randomBytes(16).toString('hex'),
    timestamp,
    fields.decision,
    fields.delegated_by ?? null,
    fields.delegated_to ?? null,
    fields.decision_federated ?? null,
  );
}

/* ─── SQL primitives ────────────────────────────────────────────────────── */

describe('Phase 7b — AuditLog.countOlderThan / purgeOlderThan', () => {
  it('countOlderThan returns matching rows without mutating', () => {
    const audit = new AuditLog(db);
    appendAt('2026-01-01T00:00:00Z', { decision: 'approved' });
    appendAt('2026-02-01T00:00:00Z', { decision: 'approved' });
    appendAt('2026-09-01T00:00:00Z', { decision: 'approved' });
    expect(audit.countOlderThan('2026-06-01T00:00:00Z')).toBe(2);
    expect(db.prepare('SELECT COUNT(*) as n FROM audit_log').get()).toEqual({ n: 3 });
  });

  it('purgeOlderThan deletes only rows older than the cutoff; preserves newer rows', () => {
    const audit = new AuditLog(db);
    appendAt('2026-01-01T00:00:00Z', { decision: 'approved' });
    appendAt('2026-02-01T00:00:00Z', { decision: 'denied' });
    appendAt('2026-08-01T00:00:00Z', { decision: 'approved' });
    appendAt('2026-09-01T00:00:00Z', { decision: 'approved' });

    const deleted = audit.purgeOlderThan('2026-06-01T00:00:00Z');
    expect(deleted).toBe(2);

    const survivors = db
      .prepare('SELECT timestamp, decision FROM audit_log ORDER BY timestamp ASC')
      .all() as Array<{ timestamp: string; decision: string }>;
    expect(survivors).toEqual([
      { timestamp: '2026-08-01T00:00:00Z', decision: 'approved' },
      { timestamp: '2026-09-01T00:00:00Z', decision: 'approved' },
    ]);
  });

  it('purgeOlderThan preserves federation context columns on surviving rows', () => {
    const audit = new AuditLog(db);
    appendAt('2026-09-01T00:00:00Z', {
      decision: 'approved',
      delegated_by: 'ed25519:peer-B',
      delegated_to: null,
      decision_federated: null,
    });
    appendAt('2026-09-02T00:00:00Z', {
      decision: 'approved',
      delegated_by: null,
      delegated_to: 'ed25519:peer-A',
      decision_federated: 'federated_ok',
    });
    appendAt('2026-01-01T00:00:00Z', {
      decision: 'approved',
      delegated_by: 'ed25519:old-peer',
      delegated_to: null,
      decision_federated: null,
    });

    audit.purgeOlderThan('2026-06-01T00:00:00Z');

    const survivors = db
      .prepare(`
        SELECT timestamp, delegated_by, delegated_to, decision_federated
        FROM audit_log ORDER BY timestamp ASC
      `)
      .all() as Array<{
        timestamp: string;
        delegated_by: string | null;
        delegated_to: string | null;
        decision_federated: string | null;
      }>;
    expect(survivors).toEqual([
      {
        timestamp: '2026-09-01T00:00:00Z',
        delegated_by: 'ed25519:peer-B',
        delegated_to: null,
        decision_federated: null,
      },
      {
        timestamp: '2026-09-02T00:00:00Z',
        delegated_by: null,
        delegated_to: 'ed25519:peer-A',
        decision_federated: 'federated_ok',
      },
    ]);
  });

  it('purgeOlderThan returns 0 when no rows match', () => {
    const audit = new AuditLog(db);
    appendAt('2026-09-01T00:00:00Z', { decision: 'approved' });
    expect(audit.purgeOlderThan('2026-01-01T00:00:00Z')).toBe(0);
    expect(db.prepare('SELECT COUNT(*) as n FROM audit_log').get()).toEqual({ n: 1 });
  });
});

/* ─── parseDurationAgo ──────────────────────────────────────────────────── */

describe('Phase 7b — parseDurationAgo', () => {
  it('subtracts hours from now', () => {
    const now = 1_700_000_000_000;
    expect(parseDurationAgo('24h', now).getTime()).toBe(now - 24 * 60 * 60 * 1000);
  });

  it('subtracts days from now', () => {
    const now = 1_700_000_000_000;
    expect(parseDurationAgo('7d', now).getTime()).toBe(now - 7 * 24 * 60 * 60 * 1000);
  });

  it('subtracts weeks from now', () => {
    const now = 1_700_000_000_000;
    expect(parseDurationAgo('1w', now).getTime()).toBe(now - 7 * 24 * 60 * 60 * 1000);
  });

  it('rejects invalid formats', () => {
    expect(() => parseDurationAgo('30')).toThrow(/invalid duration/);
    expect(() => parseDurationAgo('30x')).toThrow(/invalid duration/);
    expect(() => parseDurationAgo('')).toThrow(/non-empty string/);
  });
});

/* ─── CLI integration: child process spawn ───────────────────────────────── */

describe('CLI integration — audit purge child process', () => {
  const HUB_ENTRY = join(process.cwd(), 'dist', 'index.js');
  const hasBuiltCli = existsSync(HUB_ENTRY);

  function runCli(args: string[]): SpawnSyncReturns<string> {
    const env = {
      ...process.env,
      HUB_DB_PATH: dbPath,
      HUB_MASTER_KEY: MASTER_KEY,
    };
    return spawnSync('node', [HUB_ENTRY, ...args], { env, encoding: 'utf8' });
  }

  function seedMixed(): void {
    appendAt('2026-01-01T00:00:00Z', { decision: 'approved' });
    appendAt('2026-02-01T00:00:00Z', { decision: 'denied' });
    appendAt('2026-09-01T00:00:00Z', { decision: 'approved' });
  }

  it.skipIf(!hasBuiltCli)(
    'preview mode (no --yes) reports the count without deleting',
    () => {
      seedMixed();
      const res = runCli(['audit', 'purge', '--older-than', '180d', '--db-path', dbPath]);
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/Preview: 2 audit row.* would be deleted/);
      expect(res.stdout).toMatch(/Run with --yes to actually delete/);
      expect(db.prepare('SELECT COUNT(*) as n FROM audit_log').get()).toEqual({ n: 3 });
    },
  );

  it.skipIf(!hasBuiltCli)(
    'delete mode (--yes) removes old rows and reports the post-count',
    () => {
      seedMixed();
      const res = runCli([
        'audit', 'purge',
        '--older-than', '180d',
        '--yes',
        '--db-path', dbPath,
      ]);
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/Deleted 2 audit row.* \(older than 180d\)/);
      expect(res.stdout).toMatch(/1 remaining audit row/);

      const survivors = db
        .prepare('SELECT timestamp FROM audit_log ORDER BY timestamp ASC')
        .all() as Array<{ timestamp: string }>;
      expect(survivors).toEqual([{ timestamp: '2026-09-01T00:00:00Z' }]);
    },
  );

  it.skipIf(!hasBuiltCli)(
    'delete mode with no matching rows is a no-op',
    () => {
      appendAt('2026-09-01T00:00:00Z', { decision: 'approved' });
      const res = runCli([
        'audit', 'purge',
        '--older-than', '365d',
        '--yes',
        '--db-path', dbPath,
      ]);
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/Deleted 0 audit row/);
      expect(res.stdout).toMatch(/1 remaining audit row/);
    },
  );

  it.skipIf(!hasBuiltCli)(
    'missing --older-than flag errors with a helpful message',
    () => {
      const res = runCli(['audit', 'purge', '--db-path', dbPath]);
      expect(res.status).not.toBe(0);
      const stderr = res.stderr ?? '';
      expect(stderr).toMatch(/--older-than/);
    },
  );
});
