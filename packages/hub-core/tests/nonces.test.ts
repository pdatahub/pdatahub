/**
 * NonceStore tests — Phase 3 (Momus I4) replay dedup.
 *
 * Covers:
 *   - Migration v5 creates federation_nonces + the seen_at index.
 *   - record() is idempotent on duplicate request_id.
 *   - isSeenRecently() is true right after record(), false before record.
 *   - Lazy sweep: rows older than NONCE_TTL_MS are filtered at query time
 *     and deleted at insert time (mocked `now` for deterministic timing).
 *   - Index on seen_at is created.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/migrations.js';
import { NonceStore, NONCE_TTL_MS } from '../src/federation/nonces.js';

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
  return -1;
}

describe('Migration v5 — federation_nonces table', () => {
  it('sets user_version to 6 on a fresh DB (after Plugin SDK v2 migration)', () => {
    expect(readUserVersion()).toBe(6);
  });

  it('creates the federation_nonces table', () => {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(names.map((r) => r.name)).toContain('federation_nonces');
  });

  it('creates the expected columns (request_id, seen_at)', () => {
    const cols = db
      .prepare("PRAGMA table_info(federation_nonces)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('request_id');
    expect(names).toContain('seen_at');
  });

  it('creates the idx_federation_nonces_seen_at index', () => {
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_federation_nonces_seen_at'",
      )
      .all() as Array<{ name: string }>;
    expect(indexes).toHaveLength(1);
  });

  it('is idempotent — second runMigrations does not throw or change version', () => {
    expect(() => runMigrations(db)).not.toThrow();
    expect(readUserVersion()).toBe(6);
    const count = db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='federation_nonces'",
      )
      .get() as { n: number };
    expect(count.n).toBe(1);
  });
});

describe('NonceStore — record / isSeenRecently', () => {
  it('isSeenRecently returns false before any record()', () => {
    const store = new NonceStore(db);
    expect(store.isSeenRecently('nope')).toBe(false);
  });

  it('record() then isSeenRecently() returns true', () => {
    const store = new NonceStore(db);
    store.record('req-1');
    expect(store.isSeenRecently('req-1')).toBe(true);
  });

  it('record() is idempotent on duplicate request_id — second call does not throw', () => {
    const store = new NonceStore(db);
    store.record('req-dup');
    expect(() => store.record('req-dup')).not.toThrow();
    expect(store.isSeenRecently('req-dup')).toBe(true);
    // Still only one row.
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM federation_nonces WHERE request_id = ?")
      .get('req-dup') as { n: number };
    expect(row.n).toBe(1);
  });

  it('multiple distinct request_ids are tracked independently', () => {
    const store = new NonceStore(db);
    store.record('req-a');
    store.record('req-b');
    store.record('req-c');
    expect(store.isSeenRecently('req-a')).toBe(true);
    expect(store.isSeenRecently('req-b')).toBe(true);
    expect(store.isSeenRecently('req-c')).toBe(true);
    expect(store.isSeenRecently('req-d')).toBe(false);
  });

  it('NONCE_TTL_MS is the 10-minute window from the design doc', () => {
    expect(NONCE_TTL_MS).toBe(600_000);
  });
});

describe('NonceStore — lazy TTL sweep (mocked now)', () => {
  it('isSeenRecently returns false when now advances past the TTL window', () => {
    // Mock `now` to a fixed starting point so the test is deterministic.
    let mocked = 1_700_000_000_000;
    const store = new NonceStore(db, { now: () => mocked });
    store.record('req-aging');

    // Within window — seen.
    expect(store.isSeenRecently('req-aging')).toBe(true);

    // Just inside TTL boundary.
    mocked += NONCE_TTL_MS - 1;
    expect(store.isSeenRecently('req-aging')).toBe(true);

    // Past TTL — not seen anymore (query-time filter).
    mocked += 2;
    expect(store.isSeenRecently('req-aging')).toBe(false);
  });

  it('record() with a mocked `now` deletes rows older than the TTL', () => {
    let mocked = 1_700_000_000_000;
    const store = new NonceStore(db, { now: () => mocked });

    store.record('req-old');
    // Advance time past the TTL window.
    mocked += NONCE_TTL_MS + 1_000;
    // Inserting a fresh request_id should sweep the old one.
    store.record('req-new');

    const rows = db
      .prepare("SELECT request_id FROM federation_nonces ORDER BY request_id")
      .all() as Array<{ request_id: string }>;
    expect(rows.map((r) => r.request_id)).toEqual(['req-new']);
  });

  it('record() with no old rows just inserts (sweep DELETE is a no-op)', () => {
    let mocked = 1_700_000_000_000;
    const store = new NonceStore(db, { now: () => mocked });
    store.record('req-a');
    store.record('req-b');
    store.record('req-c');
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM federation_nonces")
      .get() as { n: number };
    expect(row.n).toBe(3);
  });
});
