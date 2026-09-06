/**
 * Tests for backup module — BIP-39 mnemonic, seed derivation, AES-GCM cipher,
 * end-to-end backup/restore roundtrip.
 *
 * Uses the official BIP-39 test vectors for mnemonic + seed derivation.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateMnemonic,
  entropyToMnemonic,
  mnemonicToEntropy,
  validateMnemonic,
  mnemonicToSeed,
  mnemonicToMasterKey,
  deriveKey,
  encrypt,
  decrypt,
  backup as backupVault,
  restore as restoreVault,
  inspect as inspectBackup,
  validatePassphrase,
} from '../src/backup/index.js';

let tempDir: string;

beforeAll(() => {
  tempDir = join(tmpdir(), `pdatahub-backup-test-${process.pid}-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterAll(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ============================================================
// BIP-39 mnemonic
// ============================================================

describe('BIP-39 mnemonic', () => {
  it('generates 12-word mnemonic with 128-bit entropy', () => {
    const m = generateMnemonic(128);
    const words = m.split(' ');
    expect(words).toHaveLength(12);
    expect(validateMnemonic(m)).toBe(true);
  });

  it('generates 24-word mnemonic with 256-bit entropy', () => {
    const m = generateMnemonic(256);
    const words = m.split(' ');
    expect(words).toHaveLength(24);
    expect(validateMnemonic(m)).toBe(true);
  });

  it('roundtrips entropy → mnemonic → entropy', () => {
    // Use deterministic test entropy (all zeros = 128 bits).
    const ent = Buffer.alloc(16); // 128 bits
    const m = entropyToMnemonic(ent);
    expect(m.split(' ')).toHaveLength(12);
    const recovered = mnemonicToEntropy(m);
    expect(recovered.equals(ent)).toBe(true);
  });

  it('roundtrips 256-bit entropy → mnemonic → entropy', () => {
    const ent = Buffer.from([
      0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
      0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
      0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
      0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
    ]);
    const m = entropyToMnemonic(ent);
    expect(m.split(' ')).toHaveLength(24);
    const recovered = mnemonicToEntropy(m);
    expect(recovered.equals(ent)).toBe(true);
  });

  it('throws on invalid entropy size', () => {
    expect(() => entropyToMnemonic(Buffer.alloc(7))).toThrow(/invalid entropy size/);
  });

  it('throws on wrong word count', () => {
    expect(() => mnemonicToEntropy('abandon abandon abandon')).toThrow(/word count/);
  });

  it('throws on unknown word', () => {
    expect(() => mnemonicToEntropy('notaword abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon')).toThrow(/unknown word/);
  });

  it('throws on bad checksum (deterministic bad mnemonic)', () => {
    // Construct a known-bad mnemonic: change last word of canonical "abandon" vector.
    // Probability of accidental valid checksum after a single word swap is ~6.25%,
    // so a random swap is flaky — use a fixed input instead.
    const valid = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    expect(validateMnemonic(valid)).toBe(true);
    const invalid = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ability';
    expect(validateMnemonic(invalid)).toBe(false);
  });

  it('validateMnemonic accepts BIP-39 reference vector', () => {
    // Standard BIP-39 test vector from the spec.
    // entropy: 00000000000000000000000000000000 → "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    const m = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    expect(validateMnemonic(m)).toBe(true);
    const recovered = mnemonicToEntropy(m);
    expect(recovered.equals(Buffer.alloc(16))).toBe(true);
  });

  it('roundtrip works for many random mnemonics (fuzz test)', () => {
    // Run 50 random mnemonics through entropy→mnemonic→entropy roundtrip.
    for (let i = 0; i < 50; i++) {
      const m = generateMnemonic(128);
      const recovered = mnemonicToEntropy(m);
      const reencoded = entropyToMnemonic(recovered);
      expect(reencoded).toBe(m);
      expect(validateMnemonic(m)).toBe(true);
    }
  });
});

// ============================================================
// BIP-39 seed derivation (PBKDF2-HMAC-SHA512, 2048 iter)
// ============================================================

describe('BIP-39 seed derivation', () => {
  it('derives known seed for official test vector (empty passphrase)', () => {
    // From BIP-39 spec test vectors:
    // mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    // passphrase: "TREZOR"
    // seed:     c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04
    const m = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const seed = mnemonicToSeed(m, 'TREZOR');
    expect(seed.toString('hex')).toBe(
      'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04',
    );
  });

  it('derives different seeds for different passphrases', () => {
    const m = generateMnemonic(128);
    const s1 = mnemonicToSeed(m, '');
    const s2 = mnemonicToSeed(m, 'something');
    expect(s1.equals(s2)).toBe(false);
  });

  it('first 32 bytes of seed == master key', () => {
    const m = generateMnemonic(128);
    const seed = mnemonicToSeed(m);
    const mk = mnemonicToMasterKey(m);
    expect(seed.subarray(0, 32).equals(mk)).toBe(true);
    expect(mk.length).toBe(32);
  });

  it('master key is deterministic for same mnemonic + passphrase', () => {
    const m = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const k1 = mnemonicToMasterKey(m, 'TREZOR');
    const k2 = mnemonicToMasterKey(m, 'TREZOR');
    expect(k1.equals(k2)).toBe(true);
  });

  it('throws on invalid mnemonic', () => {
    expect(() => mnemonicToSeed('not a real mnemonic')).toThrow(/invalid mnemonic/);
  });
});

// ============================================================
// AES-256-GCM cipher wrapper
// ============================================================

describe('AES-256-GCM cipher', () => {
  it('roundtrips plaintext with derived key', () => {
    const salt = Buffer.alloc(16, 0x42);
    const key = deriveKey('correct horse battery staple', salt);
    expect(key.length).toBe(32);

    const plaintext = Buffer.from('Hello pdatahub world', 'utf8');
    const { iv, tag, ciphertext } = encrypt(plaintext, key);

    expect(iv.length).toBe(12);
    expect(tag.length).toBe(16);
    expect(ciphertext.length).toBe(plaintext.length);

    const decrypted = decrypt(ciphertext, key, iv, tag);
    expect(decrypted.toString('utf8')).toBe(plaintext.toString('utf8'));
  });

  it('produces different IV each call (so different ciphertext for same plaintext)', () => {
    const key = deriveKey('pass', Buffer.alloc(16));
    const pt = Buffer.from('same plaintext');
    const a = encrypt(pt, key);
    const b = encrypt(pt, key);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);

    // But both decrypt to same plaintext.
    expect(decrypt(a.ciphertext, key, a.iv, a.tag).toString('utf8')).toBe('same plaintext');
    expect(decrypt(b.ciphertext, key, b.iv, b.tag).toString('utf8')).toBe('same plaintext');
  });

  it('throws when GCM tag is tampered with', () => {
    const key = deriveKey('pass', Buffer.alloc(16));
    const pt = Buffer.from('secret');
    const { iv, tag, ciphertext } = encrypt(pt, key);

    // Flip one byte of the tag.
    tag[0] ^= 0xff;

    expect(() => decrypt(ciphertext, key, iv, tag)).toThrow();
  });

  it('throws on wrong key length', () => {
    expect(() => encrypt(Buffer.from('x'), Buffer.alloc(16))).toThrow(/must be 32 bytes/);
    expect(() => encrypt(Buffer.from('x'), Buffer.alloc(64))).toThrow(/must be 32 bytes/);
  });
});

// ============================================================
// Backup file format
// ============================================================

describe('Backup file format', () => {
  it('passes passphrase validation for ≥8 characters', () => {
    expect(() => validatePassphrase('correct-horse')).not.toThrow();
    expect(() => validatePassphrase('short')).toThrow(/at least 8/);
    expect(() => validatePassphrase('')).toThrow(/at least 8/);
    expect(() => validatePassphrase('1234567')).toThrow(/at least 8/);
  });

  it('rejects non-string passphrase', () => {
    expect(() => validatePassphrase(undefined as unknown as string)).toThrow(/string/);
    expect(() => validatePassphrase(123 as unknown as string)).toThrow(/string/);
  });

  it('roundtrips backup → restore with correct passphrase', () => {
    // Create a fake vault DB.
    const dbPath = join(tempDir, 'vault.db');
    const fakeVault = Buffer.from('SQLite-format-3 fake vault data with secrets');
    writeFileSync(dbPath, fakeVault);

    // Create a master key.
    const masterKey = Buffer.alloc(32, 0xab);
    const passphrase = 'super-secret-passphrase';

    // Backup.
    const backupPath = join(tempDir, 'backup.enc');
    const backupMeta = backupVault(dbPath, masterKey, backupPath, passphrase);
    expect(backupMeta.version).toBe(1);
    expect(backupMeta.kdf.algorithm).toBe('pbkdf2-sha512');
    expect(backupMeta.kdf.iterations).toBe(2048);
    expect(backupMeta.cipher.algorithm).toBe('aes-256-gcm');
    expect(existsSync(backupPath)).toBe(true);

    // Restore to a different path.
    const restoredPath = join(tempDir, 'vault-restored.db');
    const { masterKey: recovered, createdAt } = restoreVault(
      backupPath,
      restoredPath,
      passphrase,
    );

    expect(recovered.equals(masterKey)).toBe(true);
    expect(createdAt).toBe(backupMeta.created_at);

    // Vault contents should match.
    const restoredBytes = readFileSync(restoredPath);
    expect(restoredBytes.equals(fakeVault)).toBe(true);
  });

  it('rejects restore with wrong passphrase (GCM tag check)', () => {
    const dbPath = join(tempDir, 'vault-wrong-pp.db');
    writeFileSync(dbPath, Buffer.from('test'));
    const masterKey = Buffer.alloc(32, 0x01);
    const backupPath = join(tempDir, 'wrong-pp.enc');

    backupVault(dbPath, masterKey, backupPath, 'right-passphrase-1');

    expect(() =>
      restoreVault(backupPath, join(tempDir, 'restored.db'), 'wrong-passphrase-2'),
    ).toThrow(/decryption failed/);
  });

  it('rejects corrupted backup file', () => {
    const dbPath = join(tempDir, 'vault-corrupt.db');
    writeFileSync(dbPath, Buffer.from('test'));
    const masterKey = Buffer.alloc(32, 0x02);
    const backupPath = join(tempDir, 'corrupt.enc');
    backupVault(dbPath, masterKey, backupPath, 'good-passphrase-3');

    // Tamper with the ciphertext (flip a byte).
    const data = JSON.parse(readFileSync(backupPath, 'utf8'));
    const ct = Buffer.from(data.ciphertext, 'base64');
    ct[0] ^= 0xff;
    data.ciphertext = ct.toString('base64');
    writeFileSync(backupPath, JSON.stringify(data));

    expect(() =>
      restoreVault(backupPath, join(tempDir, 'restored2.db'), 'good-passphrase-3'),
    ).toThrow(/decryption failed/);
  });

  it('inspect() shows metadata without decrypting', () => {
    const dbPath = join(tempDir, 'vault-inspect.db');
    writeFileSync(dbPath, Buffer.from('test'));
    const masterKey = Buffer.alloc(32, 0x03);
    const backupPath = join(tempDir, 'inspect.enc');

    const meta = backupVault(dbPath, masterKey, backupPath, 'inspect-passphrase-4');
    const inspected = inspectBackup(backupPath);

    expect(inspected.version).toBe(meta.version);
    expect(inspected.createdAt).toBe(meta.created_at);
    expect(inspected.kdf.algorithm).toBe('pbkdf2-sha512');
    expect(inspected.kdf.iterations).toBe(2048);
    expect(inspected.cipher.algorithm).toBe('aes-256-gcm');
  });

  it('rejects unsupported version', () => {
    const backupPath = join(tempDir, 'future-version.enc');
    writeFileSync(
      backupPath,
      JSON.stringify({
        version: 999,
        created_at: new Date().toISOString(),
        kdf: { algorithm: 'pbkdf2-sha512', iterations: 2048, salt: 'AAAA', key_length: 32 },
        cipher: { algorithm: 'aes-256-gcm', iv: 'AAAA', tag: 'AAAA' },
        ciphertext: 'AAAA',
      }),
    );

    expect(() => restoreVault(backupPath, 'vault-future.db', 'any-passphrase-5')).toThrow(
      /unsupported backup version/,
    );
  });

  it('rejects unsupported KDF', () => {
    const backupPath = join(tempDir, 'wrong-kdf.enc');
    writeFileSync(
      backupPath,
      JSON.stringify({
        version: 1,
        created_at: new Date().toISOString(),
        kdf: { algorithm: 'argon2', iterations: 1, salt: 'AAAA', key_length: 32 },
        cipher: { algorithm: 'aes-256-gcm', iv: 'AAAA', tag: 'AAAA' },
        ciphertext: 'AAAA',
      }),
    );

    expect(() => restoreVault(backupPath, 'vault-kdf.db', 'any-passphrase-6')).toThrow(
      /unsupported KDF/,
    );
  });

  it('rejects unsupported cipher', () => {
    const backupPath = join(tempDir, 'wrong-cipher.enc');
    writeFileSync(
      backupPath,
      JSON.stringify({
        version: 1,
        created_at: new Date().toISOString(),
        kdf: { algorithm: 'pbkdf2-sha512', iterations: 2048, salt: 'AAAA', key_length: 32 },
        cipher: { algorithm: 'aes-256-cbc', iv: 'AAAA', tag: 'AAAA' },
        ciphertext: 'AAAA',
      }),
    );

    expect(() => restoreVault(backupPath, 'vault-cipher.db', 'any-passphrase-7')).toThrow(
      /unsupported cipher/,
    );
  });

  it('handles realistic vault size (10 KB encrypted JSON)', () => {
    const dbPath = join(tempDir, 'large-vault.db');
    const bigDb = Buffer.alloc(10_000);
    for (let i = 0; i < bigDb.length; i++) {
      bigDb[i] = (i * 31 + 7) & 0xff;
    }
    writeFileSync(dbPath, bigDb);

    const masterKey = Buffer.alloc(32, 0x04);
    const backupPath = join(tempDir, 'large.enc');
    backupVault(dbPath, masterKey, backupPath, 'big-passphrase-8');

    const restoredPath = join(tempDir, 'large-restored.db');
    const { masterKey: mk2 } = restoreVault(backupPath, restoredPath, 'big-passphrase-8');
    expect(mk2.equals(masterKey)).toBe(true);
    expect(readFileSync(restoredPath).equals(bigDb)).toBe(true);
  });
});
