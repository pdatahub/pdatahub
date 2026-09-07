/**
 * NonceStore — replay dedup for `/v1/federation/call` requests (Phase 3,
 * Momus I4).
 *
 * Stores the `request_id` of every accepted federated call in the
 * `federation_nonces` table (created by migration v5). The retention
 * window is 600s (10 minutes) — matching the symmetric clock-skew
 * window of `|now - timestamp| <= 300s` plus a generous safety margin
 * for clock drift between hubs.
 *
 * Sweep strategy is LAZY at both query time and insert time:
 *   - `isSeenRecently(request_id)` filters by `seen_at > now - 600s`
 *     in SQL. Old rows simply don't match. No DELETE happens here.
 *   - `record(request_id)` first DELETEs rows older than the window
 *     in the same transaction, then INSERTs the new row. This keeps
 *     the table bounded without a background sweep.
 *
 * Table size estimate: ≈ max concurrent active requests × 1. A busy hub
 * at 1000 federated calls/min accumulates ~10k rows in the 10-min window
 * — SQLite handles this trivially (single-row PK lookup by request_id).
 *
 * Concurrency: better-sqlite3 is synchronous + serialized at the
 * statement level. No locking concerns.
 */

import type Database from 'better-sqlite3';
import { logger } from '../logger.js';

/** Retention window for replay dedup (10 minutes — see design doc §Protocol flow Step 4). */
export const NONCE_TTL_MS = 600_000;

/** Test-only injection point for `now`. Defaults to `Date.now`. */
export type NowFn = () => number;

export class NonceStore {
  private readonly now: NowFn;

  constructor(
    private readonly db: Database.Database,
    opts: { now?: NowFn } = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Record `request_id` as seen. Idempotent on duplicate `request_id`
   * (`INSERT OR IGNORE` — the first call wins, the second is a no-op).
   *
   * Also opportunistically deletes rows older than the retention window
   * in the same transaction. The sweep is bounded by the natural
   * write rate — no DELETE when the table is already small.
   */
  record(request_id: string): void {
    const nowIso = new Date(this.now()).toISOString();
    const cutoffIso = new Date(this.now() - NONCE_TTL_MS).toISOString();
    const sweep = this.db.prepare(
      `DELETE FROM federation_nonces WHERE seen_at < ?`,
    );
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO federation_nonces (request_id, seen_at) VALUES (?, ?)`,
    );
    const tx = this.db.transaction((args: { cutoff: string; rid: string; now: string }) => {
      sweep.run(args.cutoff);
      insert.run(args.rid, args.now);
    });
    tx({ cutoff: cutoffIso, rid: request_id, now: nowIso });
    logger.debug('federation nonce recorded', { request_id });
  }

  /**
   * True iff `request_id` was recorded within the last `NONCE_TTL_MS`
   * milliseconds. Filters at the SQL layer (no JS-side timestamp math
   * needed). Returns false for unknown or expired request_ids.
   */
  isSeenRecently(request_id: string): boolean {
    const cutoffIso = new Date(this.now() - NONCE_TTL_MS).toISOString();
    const row = this.db
      .prepare(
        `SELECT 1 AS x FROM federation_nonces
          WHERE request_id = ? AND seen_at > ? LIMIT 1`,
      )
      .get(request_id, cutoffIso) as { x: number } | undefined;
    return row !== undefined;
  }
}
