/**
 * AES-256-GCM encryption wrapper + PBKDF2-HMAC-SHA512 key derivation.
 *
 * Used for backup file encryption. The same PBKDF2 algorithm and SHA-512
 * hash are used here as in BIP-39 seed derivation, so the password is
 * the only secret protecting the backup file at rest.
 */

import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
} from 'node:crypto';

const PBKDF2_ITERATIONS = 2048;
const PBKDF2_DIGEST = 'sha512';
const KEY_LEN_BYTES = 32; // AES-256
const IV_LEN_BYTES = 12;  // GCM standard
const SALT_LEN_BYTES = 16;

/**
 * Derive a 32-byte AES-256 key from a passphrase + salt via PBKDF2-HMAC-SHA512.
 */
export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return Buffer.from(
    pbkdf2Sync(
      Buffer.from(passphrase, 'utf8'),
      salt,
      PBKDF2_ITERATIONS,
      KEY_LEN_BYTES,
      PBKDF2_DIGEST,
    ),
  );
}

/**
 * Generate a random per-backup salt (16 bytes).
 */
export function generateSalt(): Buffer {
  return randomBytes(SALT_LEN_BYTES);
}

/**
 * AES-256-GCM encrypt. Returns IV, GCM tag, and ciphertext.
 * IV is 12 random bytes per call (GCM standard).
 */
export function encrypt(plaintext: Buffer, key: Buffer): {
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
} {
  if (key.length !== KEY_LEN_BYTES) {
    throw new Error(`key must be ${KEY_LEN_BYTES} bytes for AES-256`);
  }
  const iv = randomBytes(IV_LEN_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, tag, ciphertext };
}

/**
 * AES-256-GCM decrypt. Throws if GCM tag verification fails (tampering detected).
 */
export function decrypt(
  ciphertext: Buffer,
  key: Buffer,
  iv: Buffer,
  tag: Buffer,
): Buffer {
  if (key.length !== KEY_LEN_BYTES) {
    throw new Error(`key must be ${KEY_LEN_BYTES} bytes for AES-256`);
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
