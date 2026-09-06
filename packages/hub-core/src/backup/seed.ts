/**
 * BIP-39 seed derivation + master key derivation from mnemonic.
 *
 * Spec: PBKDF2-HMAC-SHA512 with 2048 iterations, 64-byte output.
 * Salt = "mnemonic" + passphrase (NFKD normalized).
 *
 * From the 64-byte seed we derive a 32-byte master key (first 32 bytes).
 * The remaining 32 bytes are reserved for future use (e.g. chain code
 * in a BIP-32-style hierarchical scheme).
 *
 * BIP-39 spec: https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki
 */

import { pbkdf2Sync } from 'node:crypto';
import { validateMnemonic } from './mnemonic.js';

const PBKDF2_ITERATIONS = 2048;
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = 'sha512';
const SALT_PREFIX = 'mnemonic';

/**
 * UTF-8 NFKD normalize (per BIP-39 § "Word List"). Node.js has this
 * built into String.prototype.normalize since Node 6.
 */
function normalize(text: string): string {
  return text.normalize('NFKD');
}

/**
 * Derive a 64-byte BIP-39 seed from a mnemonic and optional passphrase.
 * Throws if the mnemonic fails checksum validation.
 */
export function mnemonicToSeed(mnemonic: string, passphrase = ''): Buffer {
  if (!validateMnemonic(mnemonic)) {
    throw new Error('invalid mnemonic (bad word, count, or checksum)');
  }
  const normalizedMnemonic = normalize(mnemonic);
  const salt = normalize(SALT_PREFIX + passphrase);

  return Buffer.from(
    pbkdf2Sync(
      Buffer.from(normalizedMnemonic, 'utf8'),
      Buffer.from(salt, 'utf8'),
      PBKDF2_ITERATIONS,
      PBKDF2_KEYLEN,
      PBKDF2_DIGEST,
    ),
  );
}

/**
 * Derive a 32-byte AES-256 master key from a mnemonic and optional passphrase.
 *
 * This is what gets passed to TokenVault via --master-key. With a fresh
 * passphrase you get a fresh key — so the mnemonic alone is NOT enough
 * to recover an existing vault. You need both mnemonic AND passphrase.
 */
export function mnemonicToMasterKey(mnemonic: string, passphrase = ''): Buffer {
  const seed = mnemonicToSeed(mnemonic, passphrase);
  return Buffer.from(seed.subarray(0, 32));
}
