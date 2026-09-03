#!/usr/bin/env node
/**
 * pdatahub-mcp CLI entry point.
 *
 * Usage:
 *   pdatahub-mcp --hub-url <url> --token <token>
 *   PDAHUB_HUB_URL=... PDAHUB_SESSION_TOKEN=... pdatahub-mcp
 */

import { loadConfig, ConfigError } from './config.js';
import { HubClient } from './hub-client.js';
import { PdatahubMcpServer } from './server.js';
import { logger } from './logger.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Configuration error: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  logger.info('Starting pdatahub-mcp', { hubUrl: config.hubUrl, logLevel: config.logLevel });

  const hub = new HubClient(config);
  const server = new PdatahubMcpServer(hub);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down`);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await server.refreshTools();
    await server.serveStdio();
  } catch (err) {
    logger.error('Fatal error', { error: (err as Error).message });
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`Unhandled error: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
