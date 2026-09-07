#!/usr/bin/env node
/**
 * pdatahub-hub — Hub core CLI entry point.
 *
 * Boots Hub core:
 *   1. Load config (CLI args + env)
 *   2. Open SQLite database
 *   3. Initialize stores (grants, audit, tokens)
 *   4. Initialize OAuthFlow + ApprovalStream
 *   5. Create HubServer, start HTTP + WebSocket
 *   6. Load plugins from pluginsDir
 *   7. Handle graceful shutdown on SIGINT/SIGTERM
 *
 * Usage:
 *   pdatahub-hub [--port 8080] [--db-path ./hub.db] --master-key <hex>
 *   pdatahub-hub --passphrase "your-strong-passphrase"
 *
 * Subcommands (run without starting the server):
 *   pdatahub-hub init [--words 12]                # generate mnemonic + master key
 *   pdatahub-hub backup <vault_db> <out_file>     # encrypted backup
 *   pdatahub-hub restore <in_file> <vault_db>     # restore from backup
 *
 * Required:
 *   --master-key <hex>  OR  --passphrase <text>
 */

import Database from 'better-sqlite3';
import { scryptSync } from 'node:crypto';
import { loadConfig } from './config.js';
import { GrantStore } from './grant-store.js';
import { AuditLog } from './audit-log.js';
import { TokenVault } from './token-vault.js';
import { OAuthFlow } from './oauth-flow.js';
import { ApprovalStream } from './approval-stream.js';
import { PluginRegistry } from './plugin-process.js';
import { HubServer, loadClientCredentialsFromEnv } from './server.js';
import { HubIdentity } from './federation/identity.js';
import { logger } from './logger.js';
import { runMigrations } from './migrations.js';
import { checkHubApiTokenRequirement } from './startup.js';
import {
  generateMnemonic,
  mnemonicToMasterKey,
  backup as backupVault,
  restore as restoreVault,
  inspect as inspectBackup,
} from './backup/index.js';

/**
 * Detect which subcommand (if any) was requested.
 * Subcommands are first positional arg, no leading `--`.
 */
const VALUE_FLAGS = new Set([
  '--port',
  '--host',
  '--db-path',
  '--master-key',
  '--passphrase',
  '--hub-name',
  '--words',
  '--oauth-callback-port',
  '--plugins-dir',
  '--config',
]);

function findFirstPositional(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) {
      if (i > 0 && VALUE_FLAGS.has(argv[i - 1])) continue;
      return argv[i];
    }
  }
  return undefined;
}

function parseSubcommand(argv: string[]):
  | { kind: 'none' }
  | {
      kind: 'init';
      words: 12 | 15 | 18 | 21 | 24;
      hubName?: string;
      dbPath?: string;
      masterKeyHex?: string;
    }
  | { kind: 'identity-show'; dbPath?: string; masterKeyHex?: string; passphrase?: string }
  | { kind: 'identity-regen'; dbPath?: string; masterKeyHex?: string; passphrase?: string; hubName?: string; yes: boolean }
  | { kind: 'backup'; vaultDb: string; outFile: string }
  | { kind: 'restore'; inFile: string; vaultDb: string }
  | { kind: 'inspect'; inFile: string }
  | { kind: 'help' } {
  const first = findFirstPositional(argv);
  if (!first) {
    return { kind: 'none' };
  }

  switch (first) {
    case 'init': {
      // Optional --words 12|15|18|21|24 (default 12).
      let words: 12 | 15 | 18 | 21 | 24 = 12;
      const wIdx = argv.indexOf('--words');
      if (wIdx !== -1 && argv[wIdx + 1]) {
        const n = parseInt(argv[wIdx + 1], 10);
        if (![12, 15, 18, 21, 24].includes(n)) {
          throw new Error(`--words must be one of 12/15/18/21/24 (got ${n})`);
        }
        words = n as 12 | 15 | 18 | 21 | 24;
      }
      const hIdx = argv.indexOf('--hub-name');
      const hubName = hIdx !== -1 && argv[hIdx + 1] ? argv[hIdx + 1] : undefined;
      const dIdx = argv.indexOf('--db-path');
      const dbPath = dIdx !== -1 && argv[dIdx + 1] ? argv[dIdx + 1] : undefined;
      // --master-key skips fresh mnemonic generation — used when adding
      // identity to an existing hub that already has a master_key.
      const mIdx = argv.indexOf('--master-key');
      const masterKeyHex =
        mIdx !== -1 && argv[mIdx + 1] ? argv[mIdx + 1] : undefined;
      return { kind: 'init', words, hubName, dbPath, masterKeyHex };
    }
    case 'identity': {
      const identityIdx = argv.indexOf('identity');
      const subIdx = identityIdx + 1 < argv.length ? identityIdx + 1 : -1;
      const sub = subIdx !== -1 ? argv[subIdx] : undefined;
      if (sub === 'show') {
        const dIdx = argv.indexOf('--db-path');
        const dbPath = dIdx !== -1 && argv[dIdx + 1] ? argv[dIdx + 1] : undefined;
        const mIdx = argv.indexOf('--master-key');
        const masterKeyHex =
          mIdx !== -1 && argv[mIdx + 1] ? argv[mIdx + 1] : undefined;
        const pIdx = argv.indexOf('--passphrase');
        const passphrase =
          pIdx !== -1 && argv[pIdx + 1] ? argv[pIdx + 1] : undefined;
        return { kind: 'identity-show', dbPath, masterKeyHex, passphrase };
      }
      if (sub === 'regen') {
        const dIdx = argv.indexOf('--db-path');
        const dbPath = dIdx !== -1 && argv[dIdx + 1] ? argv[dIdx + 1] : undefined;
        const mIdx = argv.indexOf('--master-key');
        const masterKeyHex =
          mIdx !== -1 && argv[mIdx + 1] ? argv[mIdx + 1] : undefined;
        const pIdx = argv.indexOf('--passphrase');
        const passphrase =
          pIdx !== -1 && argv[pIdx + 1] ? argv[pIdx + 1] : undefined;
        const hIdx = argv.indexOf('--hub-name');
        const hubName = hIdx !== -1 && argv[hIdx + 1] ? argv[hIdx + 1] : undefined;
        const yes = argv.includes('--yes');
        return { kind: 'identity-regen', dbPath, masterKeyHex, passphrase, hubName, yes };
      }
      throw new Error('usage: pdatahub-hub identity <show|regen>');
    }
    case 'backup': {
      if (argv.length < 3) {
        throw new Error(
          'usage: pdatahub-hub backup <vault_db_path> <out_file>',
        );
      }
      return { kind: 'backup', vaultDb: argv[1], outFile: argv[2] };
    }
    case 'restore': {
      if (argv.length < 3) {
        throw new Error(
          'usage: pdatahub-hub restore <in_file> <vault_db_path>',
        );
      }
      return { kind: 'restore', inFile: argv[1], vaultDb: argv[2] };
    }
    case 'inspect': {
      if (argv.length < 2) {
        throw new Error('usage: pdatahub-hub inspect <backup_file>');
      }
      return { kind: 'inspect', inFile: argv[1] };
    }
    case 'help':
    case '--help':
    case '-h':
      return { kind: 'help' };
    default:
      throw new Error(
        `unknown subcommand: ${first} (try: init, identity, backup, restore, inspect, help)`,
      );
  }
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`pdatahub-hub — privacy-first AI hub

USAGE
  pdatahub-hub [hub flags]                  Start the hub server
  pdatahub-hub init [--words 12] [--hub-name <name>]
                                           Generate BIP-39 mnemonic + master key.
                                           With --hub-name, also init federation
                                           identity in DB (Phase 1).
  pdatahub-hub identity show                Print verify_key + magic_dns + fingerprint
  pdatahub-hub identity regen               DESTRUCTIVE: rotate keypair (y/N)
  pdatahub-hub backup <db> <out>            Encrypt vault DB → backup file
  pdatahub-hub restore <in> <db>            Decrypt backup file → vault DB
  pdatahub-hub inspect <backup>             Show backup metadata (no decrypt)
  pdatahub-hub help                         This message

HUB STARTUP FLAGS
  --port <num>            HTTP port (default 8080)
  --db-path <path>        SQLite DB path (default ./pdatahub-hub.db)
  --master-key <hex>      32-byte hex master key (64 chars)
  --passphrase <text>     Derive master key via scrypt (less secure than --master-key)
  --oauth-callback-port   Fixed port for OAuth redirect URI (default 0 = random)
  --plugins-dir <path>    Plugin directory (each subdir = one plugin)
  --log-level <level>     debug | info | warn | error (default info)

ENV VARS (alternative to flags)
  HUB_PORT, HUB_DB_PATH, HUB_MASTER_KEY, HUB_PASSPHRASE, HUB_LOG_LEVEL,
  HUB_OAUTH_CALLBACK_PORT, HUB_PLUGINS_DIR

INTERACTIVE PROMPTS
  For backup/restore/init, the passphrase (and optional mnemonic) are read
  from stdin if --passphrase/-m flags are not provided.
`);
}

async function handleSubcommand(
  cmd: ReturnType<typeof parseSubcommand>,
): Promise<number> {
  if (cmd.kind === 'help') {
    printHelp();
    return 0;
  }

  if (cmd.kind === 'init') {
    let masterKey: Buffer;
    let masterKeyHex: string;
    if (cmd.masterKeyHex) {
      if (cmd.masterKeyHex.length !== 64) {
        throw new Error('--master-key must be 32 bytes hex-encoded (64 chars)');
      }
      masterKey = Buffer.from(cmd.masterKeyHex, 'hex');
      masterKeyHex = cmd.masterKeyHex;
    } else {
      const mnemonic = generateMnemonic(
        cmd.words === 12
          ? 128
          : cmd.words === 15
            ? 160
            : cmd.words === 18
              ? 192
              : cmd.words === 21
                ? 224
                : 256,
      );
      masterKey = mnemonicToMasterKey(mnemonic, '');
      masterKeyHex = masterKey.toString('hex');

      // eslint-disable-next-line no-console
      console.log(`\n=== NEW HUB IDENTITY ===\n`);
      // eslint-disable-next-line no-console
      console.log(`Mnemonic (${cmd.words} words):\n`);
      // eslint-disable-next-line no-console
      console.log(`  ${mnemonic}\n`);
      // eslint-disable-next-line no-console
      console.log(`Master key (hex):\n`);
      // eslint-disable-next-line no-console
      console.log(`  ${masterKeyHex}\n`);
      // eslint-disable-next-line no-console
      console.log(`\x1b[33mWARNING: Write the mnemonic down on paper.\x1b[0m`);
      // eslint-disable-next-line no-console
      console.log(`\x1b[33mAnyone with these 12 words AND your backup passphrase\x1b[0m`);
      // eslint-disable-next-line no-console
      console.log(`\x1b[33mcan restore your hub. Store separately.\x1b[0m\n`);
    }
    // eslint-disable-next-line no-console
    console.log(`To start hub:  pdatahub-hub --master-key ${masterKeyHex}`);
    // eslint-disable-next-line no-console
    console.log(`To backup:     pdatahub-hub backup <db> <out>`);

    if (cmd.hubName && cmd.dbPath) {
      const identity = initFederationIdentity(cmd.dbPath, cmd.hubName, masterKey);
      // eslint-disable-next-line no-console
      console.log(`\n=== FEDERATION IDENTITY ===`);
      // eslint-disable-next-line no-console
      console.log(`Hub name:      ${identity.hubName}`);
      // eslint-disable-next-line no-console
      console.log(`Verify key:    ${identity.publicKeyB64()}`);
      // eslint-disable-next-line no-console
      console.log(`Magic DNS:     ${identity.magicDns ?? '(not detected)'}`);
      // eslint-disable-next-line no-console
      console.log(`Fingerprint:   ${identity.fingerprintHex()}`);
      // eslint-disable-next-line no-console
      console.log(`DB:            ${cmd.dbPath}`);
    }
    return 0;
  }

  if (cmd.kind === 'identity-show') {
    const { masterKey, dbPath } = resolveIdentityContext(cmd.dbPath, cmd.masterKeyHex, cmd.passphrase);
    const identity = loadFederationIdentity(dbPath, masterKey);
    // eslint-disable-next-line no-console
    console.log(`Hub name:    ${identity.hubName}`);
    // eslint-disable-next-line no-console
    console.log(`Verify key:  ${identity.publicKeyB64()}`);
    // eslint-disable-next-line no-console
    console.log(`Magic DNS:   ${identity.magicDns ?? 'not detected'}`);
    // eslint-disable-next-line no-console
    console.log(`Fingerprint: ${identity.fingerprintHex()}`);
    return 0;
  }

  if (cmd.kind === 'identity-regen') {
    if (!cmd.yes) {
      // eslint-disable-next-line no-console
      console.error(
        '\x1b[33mWARNING: This will rotate your hub identity.\x1b[0m',
      );
      // eslint-disable-next-line no-console
      console.error(
        '\x1b[33mAll existing delegations will be INVALIDATED.\x1b[0m',
      );
      // eslint-disable-next-line no-console
      console.error('\x1b[33mRe-issue delegations from peer hubs.\x1b[0m');
      // eslint-disable-next-line no-console
      console.error('Type "yes" to continue, anything else to abort:');
      const readline = await import('node:readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
        terminal: process.stdin.isTTY ?? false,
      });
      const confirmed = await new Promise<string>((resolve) => {
        rl.question('> ', (answer) => {
          rl.close();
          resolve(answer.trim());
        });
      });
      if (confirmed !== 'yes') {
        // eslint-disable-next-line no-console
        console.error('Aborted.');
        return 1;
      }
    }
    const { masterKey, dbPath } = resolveIdentityContext(cmd.dbPath, cmd.masterKeyHex, cmd.passphrase);
    const hubName = cmd.hubName ?? loadFederationIdentity(dbPath, masterKey).hubName;
    const identity = initFederationIdentity(dbPath, hubName, masterKey);
    // eslint-disable-next-line no-console
    console.log(`Rotated federation identity for "${identity.hubName}".`);
    // eslint-disable-next-line no-console
    console.log(`New verify key:  ${identity.publicKeyB64()}`);
    // eslint-disable-next-line no-console
    console.log(`New fingerprint: ${identity.fingerprintHex()}`);
    return 0;
  }

  if (cmd.kind === 'backup') {
    const passphrase = await promptPassphrase('Backup passphrase');
    const masterKeyHex = process.env.HUB_MASTER_KEY;
    if (!masterKeyHex) {
      throw new Error(
        'HUB_MASTER_KEY env var required for backup (or set --master-key)',
      );
    }
    const masterKey = Buffer.from(masterKeyHex, 'hex');
    const result = backupVault(cmd.vaultDb, masterKey, cmd.outFile, passphrase);
    // eslint-disable-next-line no-console
    console.log(`Backup written: ${cmd.outFile}`);
    // eslint-disable-next-line no-console
    console.log(`  version:    ${result.version}`);
    // eslint-disable-next-line no-console
    console.log(`  created_at: ${result.created_at}`);
    // eslint-disable-next-line no-console
    console.log(`  kdf:        ${result.kdf.algorithm} (${result.kdf.iterations} iter)`);
    // eslint-disable-next-line no-console
    console.log(`  cipher:     ${result.cipher.algorithm}`);
    // eslint-disable-next-line no-console
    console.log(`  size:       ${JSON.stringify(result).length} bytes (JSON)`);
    return 0;
  }

  if (cmd.kind === 'restore') {
    const passphrase = await promptPassphrase('Restore passphrase');
    const { masterKey, createdAt } = restoreVault(cmd.inFile, cmd.vaultDb, passphrase);
    // eslint-disable-next-line no-console
    console.log(`Restored vault: ${cmd.vaultDb}`);
    // eslint-disable-next-line no-console
    console.log(`  created_at:  ${createdAt}`);
    // eslint-disable-next-line no-console
    console.log(`  master_key:  ${masterKey.toString('hex')}`);
    // eslint-disable-next-line no-console
    console.log(`\nStart hub with:  pdatahub-hub --master-key ${masterKey.toString('hex')}`);
    return 0;
  }

  if (cmd.kind === 'inspect') {
    const meta = inspectBackup(cmd.inFile);
    // eslint-disable-next-line no-console
    console.log(`Backup: ${cmd.inFile}`);
    // eslint-disable-next-line no-console
    console.log(`  version:    ${meta.version}`);
    // eslint-disable-next-line no-console
    console.log(`  created_at: ${meta.createdAt}`);
    // eslint-disable-next-line no-console
    console.log(`  kdf:        ${meta.kdf.algorithm} (${meta.kdf.iterations} iter)`);
    // eslint-disable-next-line no-console
    console.log(`  cipher:     ${meta.cipher.algorithm}`);
    return 0;
  }

  return 0;
}

/**
 * Open DB at `dbPath`, run migrations, and ensure federation_keys has a
 * fresh HubIdentity row. Refuses if already initialized (callers must use
 * `identity regen` to rotate).
 */
function initFederationIdentity(
  dbPath: string,
  hubName: string,
  masterKey: Buffer,
): HubIdentity {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  try {
    runMigrations(db);
    if (HubIdentity.exists(db)) {
      throw new Error(
        `federation identity already initialized in ${dbPath}. ` +
          `Run \`pdatahub-hub identity regen\` to rotate.`,
      );
    }
    const identity = HubIdentity.generate(hubName, masterKey);
    identity.save(db);
    return identity;
  } finally {
    db.close();
  }
}

function resolveIdentityContext(
  dbPathFlag: string | undefined,
  masterKeyHexFlag: string | undefined,
  passphraseFlag: string | undefined,
): { masterKey: Buffer; dbPath: string } {
  const dbPath = dbPathFlag ?? process.env.HUB_DB_PATH ?? './pdatahub-hub.db';
  const masterKeyHex =
    masterKeyHexFlag ?? process.env.HUB_MASTER_KEY ?? undefined;
  const passphrase = passphraseFlag ?? process.env.HUB_PASSPHRASE ?? undefined;
  let masterKey: Buffer;
  if (masterKeyHex) {
    if (masterKeyHex.length !== 64) {
      throw new Error('--master-key must be 32 bytes hex-encoded (64 chars)');
    }
    masterKey = Buffer.from(masterKeyHex, 'hex');
  } else if (passphrase) {
    // Treat as passphrase — matches config.ts deriveMasterKey (scrypt+salt).
    const salt = Buffer.from('pdatahub-hub-v1', 'utf8');
    masterKey = scryptSync(passphrase, salt, 32);
  } else {
    throw new Error(
      'Provide --master-key <hex>, --passphrase <text>, ' +
        'HUB_MASTER_KEY, or HUB_PASSPHRASE env var.',
    );
  }
  return { masterKey, dbPath };
}

function loadFederationIdentity(dbPath: string, masterKey: Buffer): HubIdentity {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  try {
    runMigrations(db);
    if (!HubIdentity.exists(db)) {
      throw new Error(
        `federation identity not initialized in ${dbPath}. ` +
          `Run \`pdatahub-hub init --hub-name <name>\` first.`,
      );
    }
    return HubIdentity.load(db, masterKey);
  } finally {
    db.close();
  }
}

/**
 * Prompt for a passphrase via stdin. Echo is suppressed (TTY-only).
 * For non-TTY (CI/script), reads first line from stdin directly.
 */
async function promptPassphrase(prompt: string): Promise<string> {
  // Allow env override for automation.
  if (process.env.HUB_PASSPHRASE) {
    return process.env.HUB_PASSPHRASE;
  }

  if (!process.stdin.isTTY) {
    // Non-interactive: read first line.
    const readline = await import('node:readline');
    const rl = readline.createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      rl.close();
      return line.trim();
    }
    throw new Error('no passphrase provided via stdin');
  }

  const readline = await import('node:readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  return new Promise((resolve) => {
    // eslint-disable-next-line no-console
    rl.question(`${prompt}: `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  // Subcommand dispatch.
  const sub = parseSubcommand(process.argv.slice(2));
  if (sub.kind !== 'none') {
    const code = await handleSubcommand(sub);
    process.exit(code);
  }

  // Default: start hub.
  const config = loadConfig();
  logger.info('starting pdatahub-hub', {
    host: config.host,
    port: config.port,
    db_path: config.dbPath,
    plugins_dir: config.pluginsDir,
  });

  // Phase 0.5 — refuse to start without HUB_API_TOKEN on a non-loopback bind.
  // Loopback hosts (127.0.0.1, ::1, localhost) preserve dev-mode behavior.
  checkHubApiTokenRequirement(config.host, process.env.HUB_API_TOKEN);

  // Open SQLite (WAL mode for concurrent reads + writes)
  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Phase 0.5 — apply versioned schema migrations (idempotent, no-op on
  // existing DBs). Constructs the baseline tables. AuditLog / GrantStore /
  // TokenVault constructors still also run their inline CREATE TABLE IF NOT
  // EXISTS — both paths are idempotent; Phase 2b will remove the inline DDL.
  const finalVersion = runMigrations(db);
  logger.info('schema migrations applied', { user_version: finalVersion });

  // Phase 1 — warn on missing identity. Don't auto-generate: hub_name
  // requires explicit user input (also prints mnemonic + master_key).
  if (!HubIdentity.exists(db)) {
    logger.warn(
      'federation identity not initialized — `GET /v1/identity` will 503. ' +
        'Run `pdatahub-hub init --hub-name <name> --db-path ' +
        config.dbPath +
        '` to set it up.',
    );
  }

  // Initialize stores
  const grants = new GrantStore(db);
  const audit = new AuditLog(db);
  const tokens = new TokenVault(db, config.masterKey);

  // Initialize OAuth + approval stream
  const oauth = new OAuthFlow(tokens, config.oauthCallbackPort);
  const approval = new ApprovalStream({ timeoutMs: 60_000 });

  // Plugin registry
  const registry = new PluginRegistry();

  // Load client credentials from env
  const clientCredentials = loadClientCredentialsFromEnv();
  logger.info('client credentials loaded', {
    plugins: Array.from(clientCredentials.keys()),
  });

  // Create + start server
  const server = new HubServer({
    config,
    db,
    registry,
    grants,
    audit,
    tokens,
    oauth,
    approval,
    clientCredentials,
  });
  await server.start();

  // Load plugins from pluginsDir
  try {
    await server.loadPluginsFromDir();
  } catch (err) {
    logger.error('plugin loading failed', { error: (err as Error).message });
  }

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`received ${signal}, shutting down gracefully`);
    await registry.shutdownAll();
    await server.stop();
    db.close();
    logger.info('shutdown complete');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('fatal error', { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
