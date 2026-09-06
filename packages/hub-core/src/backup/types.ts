/**
 * Backup module — encrypted vault backups with BIP-39 mnemonic recovery.
 *
 * Format: JSON file with PBKDF2-derived key + AES-256-GCM ciphertext.
 * Encrypted blob contains { master_key, vault_db } — both needed to
 * restore a Hub core installation.
 *
 * The 12-word mnemonic is a *separate* user-facing recovery artifact.
 * It can be used to derive a new master_key from scratch (so a user
 * with only their mnemonic can init a fresh hub and re-do OAuth, even
 * if their backup file is lost).
 *
 * Two layers of security:
 *   1. Password-derived key (PBKDF2 with 2048 iterations) protects the
 *      backup file at rest. Without the password, the backup is opaque.
 *   2. The mnemonic is independent of the password — knowing one without
 *      the other does NOT unlock the backup. You need both.
 */

export interface BackupFile {
  /** Format version. Bump if we ever change layout. */
  version: 1;
  /** ISO 8601 UTC timestamp of backup creation. */
  created_at: string;
  /** Key derivation function parameters. */
  kdf: KdfParams;
  /** Cipher parameters (iv, tag). */
  cipher: CipherParams;
  /** Base64-encoded AES-256-GCM ciphertext of JSON.stringify(BackupPayload). */
  ciphertext: string;
}

export interface KdfParams {
  algorithm: 'pbkdf2-sha512';
  /** Iteration count (BIP-39 standard: 2048). */
  iterations: number;
  /** Random per-backup salt (16 bytes, base64-encoded). */
  salt: string;
  /** Derived key length in bytes (32 = AES-256). */
  key_length: 32;
}

export interface CipherParams {
  algorithm: 'aes-256-gcm';
  /** Random per-backup IV (12 bytes, base64-encoded). */
  iv: string;
  /** GCM authentication tag (16 bytes, base64-encoded). */
  tag: string;
}

/**
 * The plaintext payload encrypted inside a backup file.
 * master_key is the hex-encoded 32-byte AES key used by TokenVault.
 * vault_db is the raw bytes of the SQLite file (base64-encoded).
 */
export interface BackupPayload {
  /** 32-byte master key, hex-encoded (64 chars). Compatible with --master-key. */
  master_key: string;
  /** SQLite vault DB file contents, base64-encoded. */
  vault_db: string;
}
