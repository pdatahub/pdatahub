/**
 * High-level backup and restore of a vault database.
 *
 * The backup file is a self-describing JSON document containing:
 *   - format version
 *   - KDF parameters (PBKDF2 with random per-backup salt)
 *   - cipher parameters (AES-256-GCM IV + tag)
 *   - ciphertext (AES-256-GCM of JSON.stringify(BackupPayload))
 *
 * The encrypted payload is { master_key, vault_db } — both needed to
 * restore a Hub installation. master_key is hex (matches --master-key
 * CLI flag), vault_db is base64-encoded SQLite file bytes.
 *
 * Same passphrase derives the same key only if the same salt is reused.
 * Each backup uses a fresh random salt — so backups are independent
 * and one compromised salt doesn't weaken others.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { decrypt, deriveKey, encrypt, generateSalt } from './cipher.js';
import type { BackupFile, BackupPayload } from './types.js';

const MIN_PASSPHRASE_LENGTH = 8;
const SUPPORTED_VERSIONS: number[] = [1];

/**
 * Validate a passphrase meets minimum security requirements.
 */
export function validatePassphrase(passphrase: string): void {
  if (typeof passphrase !== 'string') {
    throw new Error('passphrase must be a string');
  }
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(
      `passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters (got ${passphrase.length})`,
    );
  }
}

/**
 * Backup a vault DB to an encrypted file.
 *
 * Reads vault DB, encrypts {master_key, vault_db} with password-derived key,
 * writes JSON wrapper to outFile. Returns the BackupFile object (without
 * writing if writing fails — atomic write via writeFileSync).
 */
export function backup(
  vaultDbPath: string,
  masterKey: Buffer,
  outFile: string,
  passphrase: string,
): BackupFile {
  validatePassphrase(passphrase);
  if (masterKey.length !== 32) {
    throw new Error('master key must be 32 bytes (AES-256)');
  }

  const dbBytes = readFileSync(vaultDbPath);

  const payload: BackupPayload = {
    master_key: masterKey.toString('hex'),
    vault_db: dbBytes.toString('base64'),
  };
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');

  const salt = generateSalt();
  const key = deriveKey(passphrase, salt);
  const { iv, tag, ciphertext } = encrypt(plaintext, key);

  const backupFile: BackupFile = {
    version: 1,
    created_at: new Date().toISOString(),
    kdf: {
      algorithm: 'pbkdf2-sha512',
      iterations: 2048,
      salt: salt.toString('base64'),
      key_length: 32,
    },
    cipher: {
      algorithm: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
    },
    ciphertext: ciphertext.toString('base64'),
  };

  writeFileSync(outFile, JSON.stringify(backupFile, null, 2), { mode: 0o600 });
  return backupFile;
}

/**
 * Restore a vault DB from an encrypted backup.
 *
 * Decrypts the file with the supplied passphrase, writes the vault DB
 * to vaultDbPath, and returns the master_key (so caller can pass it
 * via --master-key when starting Hub core).
 *
 * Throws on:
 *   - unsupported version
 *   - wrong passphrase (GCM tag mismatch)
 *   - corrupted file
 */
export function restore(
  inFile: string,
  vaultDbPath: string,
  passphrase: string,
): { masterKey: Buffer; createdAt: string } {
  validatePassphrase(passphrase);

  const raw = readFileSync(inFile, 'utf8');
  let backupFile: BackupFile;
  try {
    backupFile = JSON.parse(raw) as BackupFile;
  } catch (err) {
    throw new Error(
      `failed to parse backup file: ${(err as Error).message}`,
    );
  }

  if (!SUPPORTED_VERSIONS.includes(backupFile.version)) {
    throw new Error(
      `unsupported backup version: ${backupFile.version} (supported: ${SUPPORTED_VERSIONS.join(', ')})`,
    );
  }
  if (backupFile.kdf.algorithm !== 'pbkdf2-sha512') {
    throw new Error(
      `unsupported KDF: ${backupFile.kdf.algorithm} (only pbkdf2-sha512 supported)`,
    );
  }
  if (backupFile.cipher.algorithm !== 'aes-256-gcm') {
    throw new Error(
      `unsupported cipher: ${backupFile.cipher.algorithm} (only aes-256-gcm supported)`,
    );
  }

  const salt = Buffer.from(backupFile.kdf.salt, 'base64');
  const iv = Buffer.from(backupFile.cipher.iv, 'base64');
  const tag = Buffer.from(backupFile.cipher.tag, 'base64');
  const ciphertext = Buffer.from(backupFile.ciphertext, 'base64');

  const key = deriveKey(passphrase, salt);

  let plaintext: Buffer;
  try {
    plaintext = decrypt(ciphertext, key, iv, tag);
  } catch (err) {
    throw new Error(
      `decryption failed (wrong passphrase or corrupted file): ${(err as Error).message}`,
    );
  }

  let payload: BackupPayload;
  try {
    payload = JSON.parse(plaintext.toString('utf8')) as BackupPayload;
  } catch (err) {
    throw new Error(
      `failed to parse decrypted payload: ${(err as Error).message}`,
    );
  }

  if (typeof payload.master_key !== 'string' || payload.master_key.length !== 64) {
    throw new Error('invalid master_key in backup payload');
  }
  const masterKey = Buffer.from(payload.master_key, 'hex');
  if (masterKey.length !== 32) {
    throw new Error('master_key is not 32 bytes');
  }

  const dbBytes = Buffer.from(payload.vault_db, 'base64');
  writeFileSync(vaultDbPath, dbBytes, { mode: 0o600 });

  return { masterKey, createdAt: backupFile.created_at };
}

/**
 * Inspect a backup file without decrypting it.
 * Returns metadata (version, created_at, sizes) but NOT the master key.
 * Useful for "ls backups" style commands.
 */
export function inspect(inFile: string): {
  version: number;
  createdAt: string;
  kdf: { algorithm: string; iterations: number };
  cipher: { algorithm: string };
} {
  const raw = readFileSync(inFile, 'utf8');
  const backupFile = JSON.parse(raw) as BackupFile;
  if (!SUPPORTED_VERSIONS.includes(backupFile.version)) {
    throw new Error(`unsupported backup version: ${backupFile.version}`);
  }
  return {
    version: backupFile.version,
    createdAt: backupFile.created_at,
    kdf: {
      algorithm: backupFile.kdf.algorithm,
      iterations: backupFile.kdf.iterations,
    },
    cipher: {
      algorithm: backupFile.cipher.algorithm,
    },
  };
}
