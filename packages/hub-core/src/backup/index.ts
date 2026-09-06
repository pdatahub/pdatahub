/**
 * Backup module — public exports.
 */

export * from './types.js';
export {
  generateMnemonic,
  entropyToMnemonic,
  mnemonicToEntropy,
  validateMnemonic,
  WORDS_BY_ENTROPY,
  type EntropyBits,
} from './mnemonic.js';
export { mnemonicToSeed, mnemonicToMasterKey } from './seed.js';
export {
  deriveKey,
  generateSalt,
  encrypt,
  decrypt,
} from './cipher.js';
export {
  backup,
  restore,
  inspect,
  validatePassphrase,
} from './backup.js';
