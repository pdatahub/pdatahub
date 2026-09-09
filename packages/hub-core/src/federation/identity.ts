/**
 * Hub identity — Phase 1 federation foundation.
 *
 * Each hub owns exactly ONE Ed25519 keypair:
 *   - `privateKey` (signing_key, 32 bytes raw) — kept in memory after load;
 *     encrypted at rest under the hub master_key via HKDF-SHA256 + AES-256-GCM.
 *   - `publicKey`  (verify_key,  32 bytes raw) — published via `GET /v1/identity`
 *     and embedded in delegation blobs (Phase 2a).
 *
 * Lifecycle:
 *   1. User runs `pdatahub-hub init --hub-name <name>`.
 *   2. CLI generates keypair + magic_dns, calls `HubIdentity.save(db)` once.
 *   3. Hub start: `HubIdentity.load(db, masterKey)` decrypts signing_key.
 *   4. Sign/verify: `identity.sign(msg)` / `HubIdentity.verify(...)`.
 *
 * SECURITY:
 *   - signing_key NEVER leaves this class in plaintext form except via
 *     `privateKey` (caller's responsibility to keep it in memory only).
 *   - At rest, signing_key is encrypted with a wrapping key derived from
 *     master_key via HKDF-SHA256(salt="pdatahub-federation-v1", info="signing-key").
 *     Different salt/info from the token vault so a leak of one wrapping key
 *     doesn't compromise the other.
 *   - GCM auth tag verifies ciphertext integrity. Wrong master_key → throws.
 *
 * The `federation_keys` table is single-row (id=1) by design: one hub, one
 * identity. Re-issuing identity is destructive (`identity regen`) — see CLI.
 */

import type Database from 'better-sqlite3';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { detectMagicDns } from './magic-dns.js';
import { logger } from '../logger.js';

/**
 * Wire `etc.sha512Sync` so the synchronous `ed.sign` / `ed.getPublicKey`
 * primitives are usable. `@noble/ed25519` v2 requires this — async variants
 * (`signAsync`, `getPublicKeyAsync`) bypass the registration.
 */
ed.etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array => {
  return sha512(ed.etc.concatBytes(...messages));
};

const HKDF_SALT = 'pdatahub-federation-v1';
const HKDF_INFO = 'signing-key';
const FINGERPRINT_BYTES = 8;

/**
 * Public response shape for `GET /v1/identity`. `verify_key` is
 * `ed25519:<base64url(publicKey)>`.
 */
export interface IdentityEndpointResponse {
  verify_key: string;
  hub_name: string;
  magic_dns: string | null;
  fingerprint: string;
}

export { detectMagicDns, type TailscaleStatusResult } from './magic-dns.js';

/* ─── Crypto helpers (wrapping key + AES-256-GCM) ──────────────────────── */

function deriveWrappingKey(masterKey: Buffer): Buffer {
  const derived = hkdfSync(
    'sha256',
    masterKey,
    Buffer.from(HKDF_SALT, 'utf8'),
    Buffer.from(HKDF_INFO, 'utf8'),
    32,
  );
  return Buffer.from(derived);
}

function encryptBytes(masterKey: Buffer, plaintext: Uint8Array): {
  enc: Buffer;
  iv: Buffer;
  tag: Buffer;
} {
  const key = deriveWrappingKey(masterKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { enc, iv, tag };
}

function decryptBytes(
  masterKey: Buffer,
  enc: Buffer,
  iv: Buffer,
  tag: Buffer,
): Uint8Array {
  const key = deriveWrappingKey(masterKey);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

/* ─── Encoding helpers ──────────────────────────────────────────────────── */

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/** Format the first `byteCount` bytes as uppercase hex pairs separated by spaces. */
export function bytesToSpacedHex(bytes: Uint8Array, byteCount: number): string {
  const limit = Math.min(byteCount, bytes.length);
  const pairs: string[] = [];
  for (let i = 0; i < limit; i++) {
    pairs.push(bytes[i]!.toString(16).padStart(2, '0').toUpperCase());
  }
  return pairs.join(' ');
}

/* ─── HubIdentity class ────────────────────────────────────────────────── */

export class HubIdentity {
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly hubName: string;
  readonly magicDns: string | null;
  readonly fingerprint: string;

  private readonly masterKey: Buffer;

  private constructor(params: {
    privateKey: Uint8Array;
    publicKey: Uint8Array;
    hubName: string;
    magicDns: string | null;
    fingerprint: string;
    masterKey: Buffer;
  }) {
    this.privateKey = params.privateKey;
    this.publicKey = params.publicKey;
    this.hubName = params.hubName;
    this.magicDns = params.magicDns;
    this.fingerprint = params.fingerprint;
    this.masterKey = params.masterKey;
  }

  static generate(hubName: string, masterKey: Buffer): HubIdentity {
    if (masterKey.length !== 32) {
      throw new Error('master key must be 32 bytes (AES-256)');
    }
    if (!hubName || hubName.trim().length === 0) {
      throw new Error('hubName must be non-empty');
    }
    const privateKey = ed.utils.randomPrivateKey();
    const publicKey = ed.getPublicKey(privateKey);
    const magicDns = detectMagicDns();
    const fingerprint = bytesToSpacedHex(publicKey, FINGERPRINT_BYTES);
    return new HubIdentity({
      privateKey,
      publicKey,
      hubName: hubName.trim(),
      magicDns,
      fingerprint,
      masterKey,
    });
  }

  static load(db: Database.Database, masterKey: Buffer): HubIdentity {
    if (masterKey.length !== 32) {
      throw new Error('master key must be 32 bytes (AES-256)');
    }
    const row = db
      .prepare(
        `SELECT verify_key, signing_key_enc, signing_key_iv, signing_key_tag,
                hub_name, magic_dns, fingerprint
           FROM federation_keys
          WHERE id = 1`,
      )
      .get() as FederationKeyRow | undefined;
    if (!row) {
      throw new Error('hub identity not initialized');
    }
    const privateKey = decryptBytes(
      masterKey,
      Buffer.from(row.signing_key_enc),
      Buffer.from(row.signing_key_iv),
      Buffer.from(row.signing_key_tag),
    );
    if (privateKey.length !== 32) {
      throw new Error('decrypted signing_key has unexpected length');
    }
    // Recompute publicKey from privateKey — defense in depth against row tampering.
    const publicKey = ed.getPublicKey(privateKey);
    const expectedVerifyKey = `ed25519:${bytesToBase64Url(publicKey)}`;
    if (row.verify_key !== expectedVerifyKey) {
      throw new Error('verify_key mismatch with decrypted signing_key');
    }
    const rowMagic = (row.magic_dns ?? null) as string | null;
    return new HubIdentity({
      privateKey,
      publicKey,
      hubName: row.hub_name,
      magicDns: rowMagic,
      fingerprint: row.fingerprint,
      masterKey,
    });
  }

  static exists(db: Database.Database): boolean {
    const row = db
      .prepare('SELECT 1 AS x FROM federation_keys WHERE id = 1 LIMIT 1')
      .get() as { x: number } | undefined;
    return row !== undefined;
  }

  save(db: Database.Database): void {
    const { enc, iv, tag } = encryptBytes(this.masterKey, this.privateKey);
    const verifyKey = this.publicKeyB64();
    const createdAt = new Date().toISOString();
    db.prepare(
      `INSERT OR REPLACE INTO federation_keys (
         id, verify_key, signing_key_enc, signing_key_iv, signing_key_tag,
         hub_name, magic_dns, fingerprint, created_at
       ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      verifyKey,
      enc,
      iv,
      tag,
      this.hubName,
      this.magicDns,
      this.fingerprint,
      createdAt,
    );
    logger.info('hub identity saved', {
      hub_name: this.hubName,
      verify_key: verifyKey.slice(0, 24) + '…',
      magic_dns: this.magicDns,
      fingerprint: this.fingerprint,
    });
  }

  sign(message: Uint8Array): Uint8Array {
    return ed.sign(message, this.privateKey);
  }

  static verify(
    message: Uint8Array,
    signature: Uint8Array,
    publicKey: Uint8Array,
  ): boolean {
    return ed.verify(signature, message, publicKey);
  }

  publicKeyB64(): string {
    return `ed25519:${bytesToBase64Url(this.publicKey)}`;
  }

  fingerprintHex(): string {
    return bytesToSpacedHex(this.publicKey, FINGERPRINT_BYTES);
  }

  toIdentityEndpointResponse(): IdentityEndpointResponse {
    return {
      verify_key: this.publicKeyB64(),
      hub_name: this.hubName,
      magic_dns: this.magicDns,
      fingerprint: this.fingerprintHex(),
    };
  }
}

interface FederationKeyRow {
  verify_key: string;
  signing_key_enc: Buffer;
  signing_key_iv: Buffer;
  signing_key_tag: Buffer;
  hub_name: string;
  magic_dns: string | null;
  fingerprint: string;
  created_at: string;
}
