/**
 * Phase 2a (Federation v2) — delegation data model.
 *
 * Provides:
 *   - CanonicalJson.canonicalize()   — RFC 8785 JSON serialization
 *   - DelegationBlobV1 type           — out-of-band delegation payload
 *   - serializeBlob / parseBlob       — base64url JSON transport helpers
 *   - signDelegation / verifyDelegation — Ed25519 sign/verify over canonical JSON
 *   - DelegationStore                 — CRUD on `delegations` + `peer_delegations`
 *   - isExpired / isRevoked           — small predicates
 *   - getToolInputSchema()            — fetch a tool's JSON Schema from the registry
 *
 * NOT IMPLEMENTED HERE (Phase 3 / Phase 4):
 *   - POST /v1/federation/delegate endpoint
 *   - POST /v1/federation/call endpoint
 *   - POST /v1/federation/invoke endpoint
 *   - QR code generation
 *   - CLI subcommands (`delegate`, `accept-delegation`, ...)
 *
 * Design references:
 *   - federation-v2-design.md §"Identity model" / §"Delegation model"
 *   - Momus I10 — trust anchor is `issuer.verify_key` IN the signed blob,
 *     NOT `/v1/identity`
 *   - Momus C4  — `peer_signature_checked` column deliberately omitted; a
 *     stored `peer_delegations` row implies a valid signature at import time
 *   - Momus Q4  — multiple active delegations for the same (peer, tool) are
 *     tied together by latest `expires_at`
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { HubIdentity } from './identity.js';
import type { PluginRegistry } from '../plugin-process.js';
import { logger } from '../logger.js';

/* ─── Base64url helpers (RFC 4648 §5) ──────────────────────────────────── */

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlToBytes(input: string): Uint8Array {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('base64url: empty input');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(input)) {
    throw new Error('base64url: invalid character (allowed: A-Z, a-z, 0-9, -, _)');
  }
  const padded =
    input.length % 4 === 0
      ? input
      : input + '='.repeat(4 - (input.length % 4));
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

/* ─── Canonical JSON (RFC 8785) ───────────────────────────────────────── */

/**
 * RFC 8785 JSON Canonicalization Scheme.
 *
 * Hand-rolled — pdatahub blobs only carry ASCII data so surrogate / NFC
 * normalization (the genuinely tricky parts of 8785) are unnecessary. Swap
 * this module out for a library if that assumption ever breaks.
 *
 * Rules enforced:
 *   - Object keys sorted lexicographically at every depth (UTF-16 code units)
 *   - No whitespace
 *   - Numbers serialized via JSON.stringify (includes -0, rejects NaN/Infinity)
 *   - Strings escape per RFC 8259 via JSON.stringify
 *   - Rejects `undefined` as a value or inside an object
 *   - Arrays preserve order
 */
export const CanonicalJson = {
  canonicalize: serializeCanonical,
};

function serializeCanonical(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) {
    throw new Error('CanonicalJson: undefined values are not permitted');
  }
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error(`CanonicalJson: non-finite number ${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) parts.push(serializeCanonical(item));
    return `[${parts.join(',')}]`;
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = obj[key];
      if (v === undefined) {
        throw new Error(`CanonicalJson: undefined value at key '${key}'`);
      }
      parts.push(`${JSON.stringify(key)}:${serializeCanonical(v)}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new Error(`CanonicalJson: unsupported type ${t}`);
}

/* ─── Delegation blob v1 ──────────────────────────────────────────────── */

/**
 * Canonical delegation blob, wire format that travels out-of-band from issuer
 * hub A to receiver hub B. Serialized to canonical JSON, then base64url.
 *
 * The signature covers every field EXCEPT `signature` itself. The trust
 * anchor is `issuer.verify_key` inside the blob (Momus I10) — a hub can lie
 * about `/v1/identity` but cannot forge A's Ed25519 signature.
 */
export interface DelegationBlobV1 {
  version: 1;
  /** UUID v4. */
  delegation_id: string;
  issuer: {
    hub_name: string;
    /** "ed25519:<base64url(publicKey)>" */
    verify_key: string;
    /** "AB CD EF 01 23 45 67 89" — 8-byte hex pairs. */
    fingerprint: string;
    /** "userA.tailXXXXXX.ts.net:8080" — might be stale; resolver catches. */
    magic_dns: string;
  };
  subject: {
    /** "ed25519:<base64url(publicKey)>" — peer B's verify_key. */
    verify_key: string;
    fingerprint: string;
  };
  delegation: {
    plugin: string;
    tool: string;
    scope: string;
    /** Arbitrary JSON Schema. */
    input_schema: unknown;
    /** ISO8601 UTC with trailing Z. */
    expires_at: string;
  };
  /** base64url(ed25519 signature over canonical JSON of all other fields). */
  signature: string;
}

/** Body of a delegation blob — every field except `signature`. */
export type DelegationBlobV1Body = Omit<DelegationBlobV1, 'signature'>;

/**
 * Serialize the unsigned body of a delegation blob to canonical JSON.
 * Used both for signing (the bytes to sign) and for verification (recompute
 * and compare against the embedded signature).
 */
export function serializeBlob(body: DelegationBlobV1Body): string {
  return CanonicalJson.canonicalize(body);
}

/**
 * Decode a base64url-encoded delegation blob into its full structured form.
 * Does NOT validate the signature — the caller MUST call `verifyDelegation`
 * before trusting any field.
 */
export function parseBlob(encoded: string): DelegationBlobV1 {
  const json = new TextDecoder().decode(base64UrlToBytes(encoded));
  return JSON.parse(json) as DelegationBlobV1;
}

/* ─── Sign / verify ───────────────────────────────────────────────────── */

/**
 * Sign a delegation blob body with the issuing hub's Ed25519 identity.
 * Returns the signature as base64url bytes; the caller attaches it to
 * `body` as `body.signature = signDelegation(...)` to form a complete blob.
 */
export function signDelegation(
  identity: HubIdentity,
  body: DelegationBlobV1Body,
): string {
  const canonical = serializeBlob(body);
  const bytes = new TextEncoder().encode(canonical);
  const sig = identity.sign(bytes);
  return bytesToBase64Url(sig);
}

/**
 * Verify a delegation blob's signature against `issuer.verify_key` embedded
 * in the blob. Returns a discriminated union — NEVER throws, so the caller
 * decides how to surface failure (HTTP code, log line, revoke, ...).
 *
 * Defense layers:
 *   1. Reject unsupported `version` values.
 *   2. Decode + length-check `issuer.verify_key` (must be 32 bytes raw).
 *   3. Decode + length-check `signature` (must be 64 bytes raw).
 *   4. Recompute canonical JSON of the unsigned body.
 *   5. Hand to `HubIdentity.verify` (Ed25519).
 */
export function verifyDelegation(
  blob: DelegationBlobV1,
): { ok: true } | { ok: false; reason: string } {
  if (blob.version !== 1) {
    return { ok: false, reason: `unsupported version: ${String(blob.version)}` };
  }
  const { signature, ...rest } = blob;
  if (typeof signature !== 'string' || signature.length === 0) {
    return { ok: false, reason: 'missing signature field' };
  }
  const verifyKeyStr = blob.issuer.verify_key;
  if (typeof verifyKeyStr !== 'string' || !verifyKeyStr.startsWith('ed25519:')) {
    return { ok: false, reason: 'issuer.verify_key must be "ed25519:<base64url>"' };
  }
  let publicKey: Uint8Array;
  try {
    publicKey = base64UrlToBytes(verifyKeyStr.slice('ed25519:'.length));
  } catch (err) {
    return { ok: false, reason: `issuer.verify_key: ${(err as Error).message}` };
  }
  if (publicKey.length !== 32) {
    return {
      ok: false,
      reason: `issuer.verify_key has wrong length (got ${publicKey.length}, expected 32)`,
    };
  }
  let sigBytes: Uint8Array;
  try {
    sigBytes = base64UrlToBytes(signature);
  } catch (err) {
    return { ok: false, reason: `signature encoding: ${(err as Error).message}` };
  }
  if (sigBytes.length !== 64) {
    return {
      ok: false,
      reason: `signature has wrong length (got ${sigBytes.length}, expected 64)`,
    };
  }
  let canonical: string;
  try {
    canonical = serializeBlob(rest);
  } catch (err) {
    return { ok: false, reason: `canonical serialization: ${(err as Error).message}` };
  }
  const bytes = new TextEncoder().encode(canonical);
  const valid = HubIdentity.verify(bytes, sigBytes, publicKey);
  if (!valid) return { ok: false, reason: 'signature mismatch' };
  return { ok: true };
}

/* ─── Predicates ──────────────────────────────────────────────────────── */

/**
 * Test whether `expires_at` is in the past relative to `now` (default
 * `Date.now()`). Boundary: a timestamp equal to `now` is treated as expired.
 *
 * `expires_at` must be ISO8601; malformed inputs return `true` (fail-closed).
 */
export function isExpired(
  expires_at: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (typeof expires_at !== 'string' || expires_at.length === 0) return true;
  const ts = Date.parse(expires_at);
  if (Number.isNaN(ts)) return true;
  return ts <= now;
}

/** Test whether a stored delegation row has been revoked. */
export function isRevoked(
  row: { revoked: number | boolean | null | undefined } | null | undefined,
): boolean {
  if (!row) return false;
  return row.revoked === 1 || row.revoked === true;
}

/* ─── Stored row shapes (mirrors of the `delegations` / `peer_delegations` tables) ─ */

export interface DelegationGrantedRow {
  delegation_id: string;
  peer_verify_key: string;
  peer_hub_name: string | null;
  plugin: string;
  tool: string;
  scope: string;
  expires_at: string;
  revoked: number;
  created_at: string;
  signature: Buffer;
}

export interface DelegationReceivedRow {
  delegation_id: string;
  peer_verify_key: string;
  peer_hub_name: string;
  peer_hub_url: string;
  plugin: string;
  tool: string;
  scope: string;
  input_schema: string | null;
  expires_at: string;
  revoked: number;
  created_at: string;
  signature: Buffer;
}

/* ─── DelegationStore ─────────────────────────────────────────────────── */

/**
 * Inputs are minimal because the issuance flow (Phase 4) constructs the blob
 * externally — `signature` is the precomputed blob signature (NOT the result
 * of `signDelegation` here; this method is purely persistence).
 */
export interface CreateGrantedInput {
  peer_verify_key: string;
  peer_hub_name?: string | null;
  plugin: string;
  tool: string;
  scope: string;
  expires_at: string;
  signature: Buffer;
}

export interface CreateReceivedInput {
  /** Caller-supplied; typically `blob.delegation_id` so re-import is idempotent. */
  delegation_id: string;
  peer_verify_key: string;
  peer_hub_name: string;
  peer_hub_url: string;
  plugin: string;
  tool: string;
  scope: string;
  /** JSON.stringify'd JSON Schema from the blob, or null. */
  input_schema: string | null;
  expires_at: string;
  /** A's signature (must already have been verified by the caller). */
  signature: Buffer;
}

/**
 * SQLite-backed store for both `delegations` (rows this hub has granted) and
 * `peer_delegations` (rows this hub has received from a peer). The split
 * mirrors Momus's two-table model so A can revoke independently of B's usage.
 */
export class DelegationStore {
  constructor(private readonly db: Database.Database) {}

  createGranted(input: CreateGrantedInput): string {
    const delegation_id = randomUUID();
    const created_at = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO delegations (
           delegation_id, peer_verify_key, peer_hub_name, plugin, tool, scope,
           expires_at, revoked, created_at, signature
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        delegation_id,
        input.peer_verify_key,
        input.peer_hub_name ?? null,
        input.plugin,
        input.tool,
        input.scope,
        input.expires_at,
        created_at,
        input.signature,
      );
    return delegation_id;
  }

  getGranted(delegation_id: string): DelegationGrantedRow | null {
    const row = this.db
      .prepare(`SELECT * FROM delegations WHERE delegation_id = ?`)
      .get(delegation_id) as DelegationGrantedRow | undefined;
    return row ?? null;
  }

  listGranted(): DelegationGrantedRow[] {
    return this.db
      .prepare(`SELECT * FROM delegations ORDER BY created_at DESC`)
      .all() as DelegationGrantedRow[];
  }

  revokeGranted(delegation_id: string): boolean {
    const result = this.db
      .prepare(`UPDATE delegations SET revoked = 1 WHERE delegation_id = ?`)
      .run(delegation_id);
    const ok = result.changes > 0;
    if (ok) logger.info('delegation revoked', { delegation_id });
    return ok;
  }

  /**
   * INSERT OR IGNORE so re-importing a delegation with the same
   * `delegation_id` is a no-op (the first imported version "wins"). Phase 4
   * CLI uses this behavior to make `accept-delegation` idempotent.
   */
  createReceived(input: CreateReceivedInput): void {
    const created_at = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO peer_delegations (
           delegation_id, peer_verify_key, peer_hub_name, peer_hub_url, plugin,
           tool, scope, input_schema, expires_at, revoked, created_at, signature
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        input.delegation_id,
        input.peer_verify_key,
        input.peer_hub_name,
        input.peer_hub_url,
        input.plugin,
        input.tool,
        input.scope,
        input.input_schema,
        input.expires_at,
        created_at,
        input.signature,
      );
  }

  getReceived(delegation_id: string): DelegationReceivedRow | null {
    const row = this.db
      .prepare(`SELECT * FROM peer_delegations WHERE delegation_id = ?`)
      .get(delegation_id) as DelegationReceivedRow | undefined;
    return row ?? null;
  }

  /**
   * Return active (not revoked, not expired) received delegations matching
   * `(peer_hub_name, tool)`, sorted by `expires_at` DESC so Momus's
   * latest-expires tie-break winner is at index 0.
   */
  findReceivedMatch(
    peer_hub_name: string,
    tool: string,
  ): DelegationReceivedRow[] {
    const now = new Date().toISOString();
    return this.db
      .prepare(
        `SELECT * FROM peer_delegations
          WHERE peer_hub_name = ? AND tool = ? AND revoked = 0 AND expires_at > ?
          ORDER BY expires_at DESC`,
      )
      .all(peer_hub_name, tool, now) as DelegationReceivedRow[];
  }

  listReceived(): DelegationReceivedRow[] {
    return this.db
      .prepare(`SELECT * FROM peer_delegations ORDER BY created_at DESC`)
      .all() as DelegationReceivedRow[];
  }

  revokeReceived(delegation_id: string): boolean {
    const result = this.db
      .prepare(`UPDATE peer_delegations SET revoked = 1 WHERE delegation_id = ?`)
      .run(delegation_id);
    return result.changes > 0;
  }
}

/* ─── Tool input schema fetch ─────────────────────────────────────────── */

/**
 * Look up a tool's JSON Schema from the plugin registry. THROWS rather than
 * returning null/undefined when the plugin or tool is missing OR the plugin
 * did not declare an inputSchema — Federation v2 requires every delegatable
 * tool to carry a signed input description, and silent NULL fallback would
 * mask Phase 4 failures by giving a blob with no schema.
 */
export function getToolInputSchema(
  registry: PluginRegistry,
  plugin: string,
  tool: string,
): Record<string, unknown> {
  for (const info of registry.listPlugins()) {
    if (info.name !== plugin) continue;
    const t = info.tools.find((x) => x.name === tool);
    if (!t) {
      throw new Error(`tool "${tool}" not found in plugin "${plugin}"`);
    }
    if (t.inputSchema === null || t.inputSchema === undefined) {
      throw new Error(
        `plugin "${plugin}" did not declare inputSchema for tool "${tool}" ` +
          `(federation requires a schema for every delegatable tool)`,
      );
    }
    return t.inputSchema;
  }
  throw new Error(`plugin "${plugin}" not found in registry`);
}
