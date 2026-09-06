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
import { loadConfig } from './config.js';
import { GrantStore } from './grant-store.js';
import { AuditLog } from './audit-log.js';
import { TokenVault } from './token-vault.js';
import { OAuthFlow } from './oauth-flow.js';
import { ApprovalStream } from './approval-stream.js';
import { PluginRegistry } from './plugin-process.js';
import { HubServer, loadClientCredentialsFromEnv } from './server.js';
import { logger } from './logger.js';
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
function parseSubcommand(argv: string[]):
  | { kind: 'none' }
  | { kind: 'init'; words: 12 | 15 | 18 | 21 | 24 }
  | { kind: 'backup'; vaultDb: string; outFile: string }
  | { kind: 'restore'; inFile: string; vaultDb: string }
  | { kind: 'inspect'; inFile: string }
  | { kind: 'help' } {
  // No subcommand → start hub.
  const first = argv[0];
  if (!first || first.startsWith('--')) {
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
      return { kind: 'init', words };
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
      throw new Error(`unknown subcommand: ${first} (try: init, backup, restore, inspect, help)`);
  }
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`pdatahub-hub — privacy-first AI hub

USAGE
  pdatahub-hub [hub flags]                  Start the hub server
  pdatahub-hub init [--words 12]            Generate BIP-39 mnemonic + master key
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
    const mnemonic = generateMnemonic(cmd.words === 12 ? 128 : cmd.words === 15 ? 160 : cmd.words === 18 ? 192 : cmd.words === 21 ? 224 : 256);
    const masterKey = mnemonicToMasterKey(mnemonic, '');

    // eslint-disable-next-line no-console
    console.log(`\n=== NEW HUB IDENTITY ===\n`);
    // eslint-disable-next-line no-console
    console.log(`Mnemonic (${cmd.words} words):\n`);
    // eslint-disable-next-line no-console
    console.log(`  ${mnemonic}\n`);
    // eslint-disable-next-line no-console
    console.log(`Master key (hex):\n`);
    // eslint-disable-next-line no-console
    console.log(`  ${masterKey.toString('hex')}\n`);
    // eslint-disable-next-line no-console
    console.log(`\x1b[33mWARNING: Write the mnemonic down on paper.\x1b[0m`);
    // eslint-disable-next-line no-console
    console.log(`\x1b[33mAnyone with these 12 words AND your backup passphrase\x1b[0m`);
    // eslint-disable-next-line no-console
    console.log(`\x1b[33mcan restore your hub. Store separately.\x1b[0m\n`);
    // eslint-disable-next-line no-console
    console.log(`To start hub:  pdatahub-hub --master-key ${masterKey.toString('hex')}`);
    // eslint-disable-next-line no-console
    console.log(`To backup:     pdatahub-hub backup <db> <out>`);
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

  // Open SQLite (WAL mode for concurrent reads + writes)
  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

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
