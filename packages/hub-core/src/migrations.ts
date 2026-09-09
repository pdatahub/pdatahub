/**
 * Schema migrations for hub-core.
 *
 * Phase 0.5 (federation v2) introduces a versioned migration runner using
 * SQLite's `PRAGMA user_version`. Each migration:
 *   - Has a monotonically-increasing integer `version`.
 *   - Provides an `up(db)` function that mutates schema.
 *   - Must be idempotent OR guarded by the `user_version` check at the top
 *     of `runMigrations` (since the runner only applies `version > current`).
 *
 * Migration 1 creates the three tables that audit-log.ts, grant-store.ts,
 * and token-vault.ts still also create inline (`CREATE TABLE IF NOT EXISTS`).
 * Both paths are idempotent — running `runMigrations` on a fresh DB and then
 * constructing the stores is safe. Phase 2b will remove the inline CREATE
 * TABLE statements from those three classes, after which `runMigrations`
 * becomes the sole schema owner.
 *
* Migration 2 (Phase 1) creates `federation_keys` for the hub's persistent
 * Ed25519 identity. Single-row table (id=1) by design — one hub, one
 * identity. Re-issue via `pdatahub-hub identity regen`.
 *
 * Migration 3 (Phase 2a) creates the two delegation tables that book-end
 * the signed delegation lifecycle: `delegations` (rows "I granted this"
 * from the issuer hub's perspective — populated when A creates a delegation)
 * and `peer_delegations` (rows "I have received this delegation from a peer
 * hub" — populated when B imports the signed blob). The two tables are
 * mirrored on purpose so A can revoke and B can invoke independently. No
 * `peer_signature_checked` column — once accepted, the signature is valid
 * by definition (Momus C4).
 *
 * Migration 4 (Phase 2b — user_id semantics + grant match key fix, Momus C1)
 * adds the federation-context columns that the audit log and grants need to
 * safely record cross-hub calls. `delegated_by` carries the verify_key of the
 * peer that initiated the call (NULL for local calls); `delegated_to` is the
 * mirror — populated on the originating hub when its hub proxies the call
 * out to a peer (Phase 3 sets it). `decision_federated` is the distinct
 * audit outcome on the originating hub for federated calls (e.g.
 * 'federated_ok', 'federated_denied' — Momus C3) so that downstream
 * analytics can separate "this hub approved" from "this hub proxied a peer
 * call that the peer approved".
 *
 * The columns are NULLable on purpose: Phase 2b only changes the schema, not
 * the call paths — every existing local call keeps writing user_id =
 * 'local-user' with delegated_by/delegated_to/decision_federated = NULL.
 * Phase 3 populates them when it lands /v1/federation/call.
 *
 * Critically, `grants.delegated_by` participates in the `ensureGrant` match
 * key (server.ts → GrantStore.findActive). Before this column existed, a
 * LOCAL grant could be reused to satisfy a FEDERATED call, bypassing the
 * approval flow entirely (Momus C1 — critical security hole). With
 * delegated_by in the match key, a federated call from B with
 * delegated_by = B_verify_key cannot match a local grant (delegated_by =
 * NULL), forcing a fresh approval.
 *
 * Subsequent migrations:
 *   - v5 (Phase 3): `federation_nonces` table for `request_id` replay dedup
 *                   (10-min lazy sweep). See federation-v2-design.md
 *                   §"Protocol flow" Step 4 — the `federation_nonces`
 *                   table stores the `request_id` of every accepted
 *                   federated call. The hub checks `seen_at > now - 600s`
 *                   at query time (lazy sweep, no background task). Table
 *                   size ≈ max-concurrent-active-requests × 1.
 *   - v6 (Plugin SDK v2 integration): adds `error_class` + `error_code`
 *                   columns to `audit_log` so the hub can record the typed
 *                   PluginError that caused a call to fail. The columns are
 *                   NULL by default — only populated when the plugin throws
 *                   a PluginError subclass (the SDK's 9 typed error classes
 *                   each set `name` → `error_class` and `code` →
 *                   `error_code`). Existing federation v2 columns
 *                   (`delegated_by`, `delegated_to`, `decision_federated`)
 *                   are NOT modified — v6 only ADDS.
 *
 *   - v7 (T-PERSISTENT-001 mitigation #2 — audit log of every vault
 *                   decryption): adds three actor-context columns to
 *                   `audit_log` so the Hub can record WHO triggered each
 *                   token decryption, with WHAT tool, under WHICH request:
 *                     - `actor_type` TEXT  — 'agent' | 'user' | 'system'
 *                     - `actor_id`   TEXT  — agent identifier / user / 'local-user'
 *                     - `request_id` TEXT  — correlation ID from the
 *                       originating `/v1/tools/:name/call` so the Android
 *                       UI can join the vault-decryption row with its
 *                       tool-call audit row.
 *                   All three are NULLable and purely additive. The new
 *                   `TokenVault.getAccessToken(plugin, opts)` call path
 *                   populates them on a `decision = 'vault_access'` row
 *                   that broadcasts to Android over `/approval-stream`
 *                   for live monitoring (closes the second attack vector
 *                   for T-PERSISTENT-001 — detects post-extraction re-use
 *                   of the vault via hub-core itself).
 */
import type Database from 'better-sqlite3';
import { logger } from './logger.js';

/**
 * A single versioned schema migration.
 *
 * `version` must be a positive integer, unique, monotonically increasing.
 * `up(db)` applies the schema change. The migration runner guarantees `up`
 * is invoked exactly once per DB lifetime, in ascending version order.
 */
export interface Migration {
  version: number;
  up: (db: Database.Database) => void;
}

/**
 * Migration 1 — baseline schema for hub-core as it exists today.
 *
 * Creates `audit_log`, `grants`, and `token_vault` tables (and their indexes)
 * with the exact same DDL used in `audit-log.ts`, `grant-store.ts`, and
 * `token-vault.ts`. Kept verbatim (NOT extracted from those files) because
 * Phase 0.5 must not modify them — Phase 2b will consolidate.
 */
const auditLogSchema = `
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
`;

const grantStoreSchema = `
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
`;

const tokenVaultSchema = `
  CREATE TABLE IF NOT EXISTS token_vault (
    plugin TEXT PRIMARY KEY,
    access_token_enc BLOB NOT NULL,
    access_token_iv BLOB NOT NULL,
    access_token_tag BLOB NOT NULL,
    refresh_token_enc BLOB,
    refresh_token_iv BLOB,
    refresh_token_tag BLOB,
    expires_at TEXT,
    scope TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

/**
 * Single-row table for the hub's persistent Ed25519 identity. signing_key
 * is encrypted at rest under a wrapping key derived from master_key via
 * HKDF — see `federation/identity.ts` for the derivation. magic_dns may
 * be NULL for hubs that don't run tailscale.
 */
const federationKeysSchema = `
  CREATE TABLE IF NOT EXISTS federation_keys (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    verify_key      TEXT NOT NULL,
    signing_key_enc BLOB NOT NULL,
    signing_key_iv  BLOB NOT NULL,
    signing_key_tag BLOB NOT NULL,
    hub_name        TEXT NOT NULL,
    magic_dns       TEXT,
    fingerprint     TEXT NOT NULL,
    created_at      TEXT NOT NULL
  );
`;

/**
 * `delegations` — rows this hub has GRANTED to peer hubs. Created on the
 * issuer hub (A) when A runs `pdatahub-hub delegate`. A stores these so it
 * can list and revoke. `peer_hub_name` is nullable because the issuing CLI
 * only knows the peer's verify_key at grant time; the name is denormalized
 * for display and may be filled in lazily.
 */
const delegationsGrantedSchema = `
  CREATE TABLE IF NOT EXISTS delegations (
    delegation_id    TEXT PRIMARY KEY,
    peer_verify_key  TEXT NOT NULL,
    peer_hub_name    TEXT,
    plugin           TEXT NOT NULL,
    tool             TEXT NOT NULL,
    scope            TEXT NOT NULL,
    expires_at       TEXT NOT NULL,
    revoked          INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    signature        BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_delegations_peer ON delegations(peer_verify_key);
  CREATE INDEX IF NOT EXISTS idx_delegations_expires ON delegations(expires_at);
`;

/**
 * `peer_delegations` — rows this hub has RECEIVED from peer hubs (B's hub
 * side of Momus's mirror model). B imports a signed delegation blob from A,
 * verifies A's signature against the issuer's verify_key IN THE BLOB
 * (Momus I10 — not against `/v1/identity`), then stores it. INSERT OR IGNORE
 * guards against re-importing the same `delegation_id`. `peer_hub_url` is
 * resolved from the blob's `issuer.magic_dns` at import time. `input_schema`
 * is JSON.stringify'd JSON Schema — signed by A as part of the blob.
 */
const peerDelegationsReceivedSchema = `
  CREATE TABLE IF NOT EXISTS peer_delegations (
    delegation_id    TEXT PRIMARY KEY,
    peer_verify_key  TEXT NOT NULL,
    peer_hub_name    TEXT NOT NULL,
    peer_hub_url     TEXT NOT NULL,
    plugin           TEXT NOT NULL,
    tool             TEXT NOT NULL,
    scope            TEXT NOT NULL,
    input_schema     TEXT,
    expires_at       TEXT NOT NULL,
    revoked          INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    signature        BLOB NOT NULL
  );
`;

/**
 * `federation_nonces` — replay dedup for inbound `/v1/federation/call`
 * requests (Momus I4). One row per accepted `request_id`. The 10-min
 * retention window is enforced lazily at QUERY time (the `isSeenRecently`
 * check filters by `seen_at > now - 600s`) AND at INSERT time (the
 * `record()` method DELETEs rows older than the window in the same
 * transaction). No background sweep — keeps Phase 3 simple. A busy hub
 * at 1000 federated calls/min grows the table by ~10k rows over the
 * window, which SQLite handles trivially.
 */
const federationNoncesSchema = `
  CREATE TABLE IF NOT EXISTS federation_nonces (
    request_id TEXT PRIMARY KEY,
    seen_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_federation_nonces_seen_at ON federation_nonces(seen_at);
`;

const migrations: Migration[] = [
  {
    version: 1,
    up: (db) => {
      // Order mirrors the order the original constructors created them:
      // token-vault → grants → audit-log. Future migrations can assume
      // all three tables exist on a DB at user_version >= 1.
      db.exec(tokenVaultSchema);
      db.exec(grantStoreSchema);
      db.exec(auditLogSchema);
    },
  },
  {
    version: 2,
    up: (db) => {
      db.exec(federationKeysSchema);
    },
  },
  {
    version: 3,
    up: (db) => {
      db.exec(delegationsGrantedSchema);
      db.exec(peerDelegationsReceivedSchema);
    },
  },
  {
    version: 4,
    up: (db) => {
      // Phase 2b — federation-context columns. Idempotency is the runner's
      // job (not the SQL's) — SQLite does not support `ALTER TABLE ... ADD
      // COLUMN IF NOT EXISTS` (PostgreSQL extension).
      //
      // `audit_log.delegated_by`     populated on A's hub (NULL on local)
      // `audit_log.delegated_to`     populated on B's hub (NULL on local)
      // `audit_log.decision_federated` Momus C3, populated on B's hub
      //                               ('federated_ok' / 'federated_denied')
      // `grants.delegated_by`        match key for `ensureGrant` (Momus C1)
      db.exec(`
        ALTER TABLE audit_log ADD COLUMN delegated_by TEXT;
        ALTER TABLE audit_log ADD COLUMN delegated_to TEXT;
        ALTER TABLE audit_log ADD COLUMN decision_federated TEXT;
        ALTER TABLE grants ADD COLUMN delegated_by TEXT;
      `);
    },
  },
  {
    version: 5,
    up: (db) => {
      // Phase 3 — replay dedup table for `/v1/federation/call`. See
      // `federation/nonces.ts` (NonceStore) for read/write semantics.
      db.exec(federationNoncesSchema);
    },
  },
  {
    version: 6,
    up: (db) => {
      // Plugin SDK v2 (Day 5 of plugin-sdk-v2-design.md) — captures the
      // typed PluginError class + machine-readable code on every error
      // audit row. The Hub's error router (`server.handleCallTool`) sets
      // these from `err.name` and `err.code` when the plugin throws a
      // PluginError subclass; non-PluginError failures leave the columns
      // NULL. Federation v2 columns are untouched — v6 is purely additive.
      db.exec(`
        ALTER TABLE audit_log ADD COLUMN error_class TEXT;
        ALTER TABLE audit_log ADD COLUMN error_code TEXT;
      `);
    },
  },
  {
    version: 7,
    up: (db) => {
      // T-PERSISTENT-001 mitigation #2 — audit log of every vault
      // decryption. Three actor-context columns on `audit_log` so the
      // Hub records WHO triggered each getAccessToken() call, with WHAT
      // tool, under WHICH request_id. NULLable + additive — existing
      // rows keep their (NULL) values, existing audit writers don't
      // need to change. The new TokenVault.getAccessToken(plugin, opts)
      // call path populates them via AuditLog.recordVaultAccess(), which
      // also broadcasts a `vault_access` WebSocket message to Android
      // clients (`ApprovalStream.broadcastVaultAccess`) for live
      // monitoring. Closes Path B of T-PERSISTENT-001 (attacker uses
      // stolen keyring via hub-core instead of calling Google directly).
      db.exec(`
        ALTER TABLE audit_log ADD COLUMN actor_type TEXT;
        ALTER TABLE audit_log ADD COLUMN actor_id TEXT;
        ALTER TABLE audit_log ADD COLUMN request_id TEXT;
      `);
    },
  },
];

/**
 * Apply pending migrations to `db` in version order.
 *
 * Reads `PRAGMA user_version` (0 on a fresh DB), iterates `migrations`, and
 * applies each `up` whose `version` is greater than the current version.
 * After applying each migration, writes `PRAGMA user_version = <version>` so
 * subsequent invocations skip already-applied work.
 *
 * Idempotent: calling this on a DB already at the latest version is a no-op.
 * Throws if the migration array has gaps (e.g. version 1, version 3 but no
 * version 2) so we never silently skip a migration by mistake.
 *
 * Returns the final `user_version` after the run (useful for tests).
 */
export function runMigrations(db: Database.Database): number {
  const current = readUserVersion(db);
  let applied = current;

  // Defensive: catch accidental version gaps before skipping over them.
  for (let i = 0; i < migrations.length; i++) {
    const m = migrations[i];
    if (!m) continue;
    if (m.version <= current) continue;
    if (i > 0) {
      const prev = migrations[i - 1];
      if (prev && m.version !== prev.version + 1) {
        throw new Error(
          `migration gap: cannot apply v${m.version} after v${prev.version} ` +
            `(missing intermediate migration)`,
        );
      }
    }

    logger.info('applying migration', { version: m.version });
    m.up(db);
    db.pragma(`user_version = ${m.version}`);
    applied = m.version;
  }

  return applied;
}

/**
 * Read the current `user_version` pragma. better-sqlite3 returns an ARRAY
 * of rows (one per declared column), e.g. `[{ user_version: 0 }]`. Narrow
 * defensively to handle either the array form or, for safety, an object.
 */
function readUserVersion(db: Database.Database): number {
  const raw = db.pragma('user_version') as unknown;
  if (Array.isArray(raw)) {
    const first = raw[0] as { user_version?: unknown } | undefined;
    if (first && typeof first.user_version === 'number') return first.user_version;
    return 0;
  }
  if (raw && typeof raw === 'object' && 'user_version' in raw) {
    const v = (raw as { user_version: unknown }).user_version;
    if (typeof v === 'number') return v;
  }
  if (typeof raw === 'number') return raw;
  return 0;
}