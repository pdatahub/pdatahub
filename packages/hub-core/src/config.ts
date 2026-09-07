/**
 * Configuration for Hub core (CLI args + env vars).
 *
 * Usage:
 *   pdatahub-hub [--port 8080] [--db-path ./hub.db] [--master-key <hex>]
 *                [--oauth-callback-port 8081]
 *
 * Env vars:
 *   HUB_PORT                    default 8080
 *   HUB_DB_PATH                 default ./pdatahub-hub.db
 *   HUB_MASTER_KEY              32-byte hex (64 chars). If absent, derived from passphrase.
 *   HUB_PASSPHRASE              Used to derive master key if HUB_MASTER_KEY not set.
 *   HUB_HOST                    default 0.0.0.0 (binds all interfaces)
 *   HUB_LOG_LEVEL               default 'info'
 *   HUB_OAUTH_CALLBACK_PORT     default 0 (= random free port). Set fixed port when
 *                               registering OAuth redirect URIs with providers that
 *                               require exact match (e.g. Google Web-app clients).
 */

import { scryptSync } from 'node:crypto';
import { logger } from './logger.js';

export interface HubConfig {
  /** Host to bind HTTP + WebSocket server. */
  host: string;
  /** HTTP port. */
  port: number;
  /** SQLite database path. */
  dbPath: string;
  /** Master encryption key (32 bytes, hex-encoded). */
  masterKey: Buffer;
  /** Log level. */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Path to plugins directory (each subdir = one plugin). */
  pluginsDir: string;
  /** Plugin subprocess idle timeout (ms) before kill. */
  pluginIdleTimeoutMs: number;
  /** Plugin subprocess heartbeat interval (ms). */
  pluginHeartbeatMs: number;
  /**
   * OAuth callback server port. 0 = random free port per flow (RFC 8252 §7.3).
   * Set fixed when OAuth provider requires exact redirect_uri match (Google Web-app).
   */
  oauthCallbackPort: number;
}

interface CliArgs {
  port?: number;
  host?: string;
  'db-path'?: string;
  'master-key'?: string;
  passphrase?: string;
  'log-level'?: 'debug' | 'info' | 'warn' | 'error';
  'plugins-dir'?: string;
  'oauth-callback-port'?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      // Flag without value
      continue;
    }
    switch (key) {
      case 'port': out.port = parseInt(next, 10); i++; break;
      case 'host': out.host = next; i++; break;
      case 'db-path': out['db-path'] = next; i++; break;
      case 'master-key': out['master-key'] = next; i++; break;
      case 'passphrase': out.passphrase = next; i++; break;
      case 'log-level': out['log-level'] = next as CliArgs['log-level']; i++; break;
      case 'plugins-dir': out['plugins-dir'] = next; i++; break;
      case 'oauth-callback-port': out['oauth-callback-port'] = parseInt(next, 10); i++; break;
      default: break;
    }
  }
  return out;
}

function deriveMasterKey(passphrase: string): Buffer {
  const salt = Buffer.from('pdatahub-hub-v1', 'utf8');
  return scryptSync(passphrase, salt, 32);
}

export function loadConfig(argv: string[] = process.argv.slice(2)): HubConfig {
  const args = parseArgs(argv);

  const port = args.port ?? parseInt(process.env.HUB_PORT ?? '8080', 10);
  const host = args.host ?? process.env.HUB_HOST ?? '0.0.0.0';
  const dbPath = args['db-path'] ?? process.env.HUB_DB_PATH ?? './pdatahub-hub.db';
  const logLevel = args['log-level'] ?? (process.env.HUB_LOG_LEVEL as HubConfig['logLevel']) ?? 'info';
  const pluginsDir = args['plugins-dir'] ?? process.env.HUB_PLUGINS_DIR ?? './plugins';
  const oauthCallbackPort =
    args['oauth-callback-port'] ??
    (process.env.HUB_OAUTH_CALLBACK_PORT !== undefined
      ? parseInt(process.env.HUB_OAUTH_CALLBACK_PORT, 10)
      : 0);

  const masterKeyHex = args['master-key'] ?? process.env.HUB_MASTER_KEY;
  const passphrase = args.passphrase ?? process.env.HUB_PASSPHRASE;

  let masterKey: Buffer;
  if (masterKeyHex) {
    if (masterKeyHex.length !== 64) {
      throw new Error('--master-key must be 32 bytes hex-encoded (64 chars)');
    }
    masterKey = Buffer.from(masterKeyHex, 'hex');
  } else if (passphrase) {
    logger.warn('Deriving master key from passphrase (scrypt). Set HUB_MASTER_KEY for production.');
    masterKey = deriveMasterKey(passphrase);
  } else {
    throw new Error('Must provide --master-key <hex> or --passphrase <text>');
  }

  return {
    host,
    port,
    dbPath,
    masterKey,
    logLevel,
    pluginsDir,
    pluginIdleTimeoutMs: 5 * 60_000, // 5 min
    pluginHeartbeatMs: 30_000, // 30 sec
    oauthCallbackPort,
  };
}
