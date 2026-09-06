/**
 * BIP-39 mnemonic — entropy ↔ word phrase conversion.
 *
 * Spec: https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki
 *
 * Word counts ↔ entropy bits:
 *   12 words = 128 bits entropy + 4 bits checksum
 *   15 words = 160 bits entropy + 5 bits checksum
 *   18 words = 192 bits entropy + 6 bits checksum
 *   21 words = 224 bits entropy + 7 bits checksum
 *   24 words = 256 bits entropy + 8 bits checksum
 *
 * Checksum = SHA256(entropy)[0 : ENT/32 bits], appended after entropy
 * before splitting into 11-bit word indices.
 */

import { createHash, randomBytes } from 'node:crypto';
import { BIP39_WORDLIST_ENGLISH } from './wordlist.js';

export type EntropyBits = 128 | 160 | 192 | 224 | 256;

// Word count for each supported entropy size.
export const WORDS_BY_ENTROPY: Record<EntropyBits, number> = {
  128: 12,
  160: 15,
  192: 18,
  224: 21,
  256: 24,
};

// Reverse lookup for mnemonic → index (faster than indexOf in a 2048-entry array).
const WORD_INDEX: Map<string, number> = new Map();
for (let i = 0; i < BIP39_WORDLIST_ENGLISH.length; i++) {
  WORD_INDEX.set(BIP39_WORDLIST_ENGLISH[i], i);
}

/**
 * Generate a fresh mnemonic from crypto-grade random entropy.
 * Defaults to 128-bit (12 words) which is standard for BIP-39 wallets.
 */
export function generateMnemonic(entropyBits: EntropyBits = 128): string {
  const ent = randomBytes(entropyBits / 8);
  return entropyToMnemonic(ent);
}

/**
 * Convert raw entropy bytes to a BIP-39 mnemonic phrase.
 * Throws if entropy size is not one of the 5 supported values.
 */
export function entropyToMnemonic(entropy: Buffer): string {
  const ent = entropy.length * 8;
  const supportedBits: number[] = [128, 160, 192, 224, 256];
  if (!supportedBits.includes(ent)) {
    throw new Error(`invalid entropy size: ${ent} bits (must be 128/160/192/224/256)`);
  }

  const csBits = ent / 32;
  const checksumHash = createHash('sha256').update(entropy).digest();

  // Build the bit stream: entropy bits (MSB-first per byte) + checksum bits.
  const totalBits = ent + csBits;
  const bitStream: number[] = [];

  for (let byteIdx = 0; byteIdx < entropy.length; byteIdx++) {
    const b = entropy[byteIdx];
    for (let bit = 7; bit >= 0; bit--) {
      bitStream.push((b >> bit) & 1);
    }
  }
  // Append checksum bits (MSB-first from SHA256).
  for (let i = 0; i < csBits; i++) {
    const byteIdx = Math.floor(i / 8);
    const bit = 7 - (i % 8);
    bitStream.push((checksumHash[byteIdx] >> bit) & 1);
  }

  // Group into 11-bit chunks → word indices.
  const wordCount = (totalBits / 11) | 0;
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    let idx = 0;
    for (let b = 0; b < 11; b++) {
      idx = (idx << 1) | bitStream[i * 11 + b];
    }
    words.push(BIP39_WORDLIST_ENGLISH[idx]);
  }
  return words.join(' ');
}

/**
 * Convert a BIP-39 mnemonic phrase back to raw entropy bytes.
 * Throws on bad word count, unknown words, or invalid checksum.
 */
export function mnemonicToEntropy(mnemonic: string): Buffer {
  const words = mnemonic.trim().toLowerCase().split(/\s+/);
  const expectedCounts = [12, 15, 18, 21, 24];
  if (!expectedCounts.includes(words.length)) {
    throw new Error(
      `invalid mnemonic word count: ${words.length} (must be one of ${expectedCounts.join('/')})`,
    );
  }

  // Word count → entropy bits: ENT = (wordCount * 11 * 32) / 33 (integral).
  // For 12:  (12*11*32)/33 = 4224/33 = 128
  // For 24:  (24*11*32)/33 = 8448/33 = 256
  const entBits = (words.length * 11 * 32) / 33;
  const entBytes = entBits / 8;
  const csBits = words.length * 11 - entBits;

  // Map words to indices.
  const indices: number[] = [];
  for (const word of words) {
    const idx = WORD_INDEX.get(word);
    if (idx === undefined) {
      throw new Error(`unknown word in mnemonic: "${word}"`);
    }
    indices.push(idx);
  }

  // Reconstruct bit stream from indices.
  const bitStream: number[] = [];
  for (const idx of indices) {
    for (let b = 10; b >= 0; b--) {
      bitStream.push((idx >> b) & 1);
    }
  }

  // Extract entropy bytes (first entBits bits).
  const entropy = Buffer.alloc(entBytes);
  for (let i = 0; i < entBits; i++) {
    const byteIdx = (i / 8) | 0;
    const bit = 7 - (i % 8);
    if (bitStream[i]) {
      entropy[byteIdx] |= 1 << bit;
    }
  }

  // Extract checksum bits (next csBits bits).
  let extractedCs = 0;
  for (let i = 0; i < csBits; i++) {
    extractedCs = (extractedCs << 1) | bitStream[entBits + i];
  }

  // Compute expected checksum from entropy.
  const expectedHash = createHash('sha256').update(entropy).digest();
  let expectedCs = 0;
  for (let i = 0; i < csBits; i++) {
    const byteIdx = (i / 8) | 0;
    const bit = 7 - (i % 8);
    expectedCs = (expectedCs << 1) | ((expectedHash[byteIdx] >> bit) & 1);
  }

  if (extractedCs !== expectedCs) {
    throw new Error('invalid mnemonic checksum');
  }

  return entropy;
}

/**
 * Validate a BIP-39 mnemonic (correct word count, all words known, checksum ok).
 * Returns true/false, never throws.
 */
export function validateMnemonic(mnemonic: string): boolean {
  try {
    mnemonicToEntropy(mnemonic);
    return true;
  } catch {
    return false;
  }
}
