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

async function main(): Promise<void> {
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
  const oauth = new OAuthFlow(tokens);
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
