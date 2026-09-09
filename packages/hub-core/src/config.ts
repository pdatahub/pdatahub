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
 *   HUB_MASTER_KEY              32-byte hex (64 chars). INSECURE (process listing).
 *   HUB_PASSPHRASE              Used to derive master key if HUB_MASTER_KEY not set.
 *   HUB_HOST                    default 0.0.0.0 (binds all interfaces)
 *   HUB_LOG_LEVEL               default 'info'
 *   HUB_OAUTH_CALLBACK_PORT     default 0 (= random free port). Set fixed port when
 *                               registering OAuth redirect URIs with providers that
 *                               require exact match (e.g. Google Web-app clients).
 *
 * master_key resolution priority (T-PERSISTENT-001 mitigation #1):
 *   1. --master-key <hex> CLI arg   (INSECURE — visible in /proc/<pid>/cmdline)
 *   2. --passphrase <text> CLI arg  (INSECURE — same)
 *   3. HUB_MASTER_KEY env var       (INSECURE — visible in process env)
 *   4. System keyring               (SECURE — see src/keyring.ts)
 *   5. Interactive prompt on TTY    (SECURE, dev-only — not implemented yet)
 *
 * Insecure paths emit a one-shot warning per startup. Suppress via
 * `--ack-insecure-master-key` after the user has read the threat model.
 * The keyring path is silent (no warning).
 */

import { scryptSync } from 'node:crypto';
import { logger } from './logger.js';
import {
  getMasterKey as getMasterKeyFromKeyring,
  isKeyringAvailable,
  keyringBackendLabel,
  warnKeyringUnavailableOnce,
} from './keyring.js';

export interface HubConfig {
  /** Host to bind HTTP + WebSocket server. */
  host: string;
  /** HTTP port. */
  port: number;
  /** SQLite database path. */
  dbPath: string;
  /** Master encryption key (32 bytes). */
  masterKey: Buffer;
  /**
   * Where the master_key was sourced from. Used for diagnostics
   * (and to decide whether to print the "insecure path" warning).
   */
  masterKeySource: 'cli-arg' | 'passphrase' | 'env' | 'keyring';
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
  /**
   * User has read T-PERSISTENT-001 and explicitly opts out of the
   * "insecure master_key path" warning. Set after a one-time review of
   * docs/threat-model.md — typically for production deploys where the
   * operator has decided CLI args are acceptable (e.g. systemd unit
   * with `DynamicUser=` and `ProtectHome=yes`).
   */
  'ack-insecure-master-key'?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    // Track --keyring-* flags separately since they're not in CliArgs.
    if (key === 'keyring-service' && next && !next.startsWith('--')) {
      i++;
      continue;
    }
    if (key === 'keyring-account' && next && !next.startsWith('--')) {
      i++;
      continue;
    }
    if (!next || next.startsWith('--')) {
      // Flag without value — treat as boolean.
      if (key === 'ack-insecure-master-key') {
        out['ack-insecure-master-key'] = true;
      }
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

function deriveMasterKeyFromPassphrase(passphrase: string): Buffer {
  const salt = Buffer.from('pdatahub-hub-v1', 'utf8');
  return scryptSync(passphrase, salt, 32);
}

/**
 * Read a single `--flag <value>` pair from argv. Returns the value or
 * undefined if the flag isn't present or has no value.
 */
function readArgValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const next = argv[i + 1];
  if (!next || next.startsWith('--')) return undefined;
  return next;
}

/**
 * Resolve master_key per the priority chain in this module's header.
 *
 * Returns { masterKey, source } where `source` lets callers decide
 * whether to print the T-PERSISTENT-001 warning. The keyring path is
 * always silent; CLI/env/passphrase paths emit a one-shot warning
 * unless the user passed `--ack-insecure-master-key`.
 *
 * Throws if no source is available AND no TTY for interactive prompt.
 *
 * Exported for the CLI subcommand paths in index.ts that need to
 * reuse the same priority chain (e.g. `identity show`, `delegate`,
 * `backup`, `restore`).
 */
export async function resolveMasterKey(
  cliMasterKeyHex: string | undefined,
  cliPassphrase: string | undefined,
  envMasterKeyHex: string | undefined,
  ackInsecure: boolean,
  keyringService: string = 'pdatahub-hub',
  keyringAccount: string = 'master-key',
): Promise<{ masterKey: Buffer; source: 'cli-arg' | 'passphrase' | 'env' | 'keyring' }> {
  // Priority 1: --master-key CLI arg (INSECURE).
  if (cliMasterKeyHex) {
    if (cliMasterKeyHex.length !== 64) {
      throw new Error('--master-key must be 32 bytes hex-encoded (64 chars)');
    }
    if (!ackInsecure) {
      logger.warn(
        'master_key sourced from --master-key CLI arg — readable by any local user via /proc/<pid>/cmdline. ' +
          'See docs/threat-model.md §T-PERSISTENT-001. ' +
          'Suppress with --ack-insecure-master-key or migrate to system keyring (--store-keyring <hex>).',
      );
    }
    return { masterKey: Buffer.from(cliMasterKeyHex, 'hex'), source: 'cli-arg' };
  }

  // Priority 2: --passphrase CLI arg (INSECURE — same exposure).
  if (cliPassphrase) {
    if (!ackInsecure) {
      logger.warn(
        'master_key sourced from --passphrase CLI arg — readable by any local user via /proc/<pid>/cmdline. ' +
          'See docs/threat-model.md §T-PERSISTENT-001. ' +
          'Suppress with --ack-insecure-master-key or migrate to system keyring.',
      );
    }
    return {
      masterKey: deriveMasterKeyFromPassphrase(cliPassphrase),
      source: 'passphrase',
    };
  }

  // Priority 3: HUB_MASTER_KEY env var (INSECURE — same exposure).
  if (envMasterKeyHex) {
    if (envMasterKeyHex.length !== 64) {
      throw new Error('--master-key must be 32 bytes hex-encoded (64 chars)');
    }
    if (!ackInsecure) {
      logger.warn(
        'master_key sourced from HUB_MASTER_KEY env var — readable by any local user via /proc/<pid>/environ. ' +
          'See docs/threat-model.md §T-PERSISTENT-001. ' +
          'Suppress with --ack-insecure-master-key or migrate to system keyring.',
      );
    }
    return { masterKey: Buffer.from(envMasterKeyHex, 'hex'), source: 'env' };
  }

  // Priority 4: System keyring (SECURE — no warning).
  const keyringAvailable = await isKeyringAvailable();
  if (keyringAvailable) {
    try {
      const key = await getMasterKeyFromKeyring(keyringService, keyringAccount);
      if (key !== null) {
        // Silent — no warning. This is the recommended path.
        return { masterKey: key, source: 'keyring' };
      }
      // No entry yet — fall through to priority 5.
    } catch (err) {
      // Backend error (daemon down, permissions, etc). Warn and fall back.
      warnKeyringUnavailableOnce(
        (err as Error).message,
        'prompt (TTY) or HUB_MASTER_KEY env',
      );
    }
  } else {
    warnKeyringUnavailableOnce(
      'keyring library failed to load or no backend available',
      'prompt (TTY) or HUB_MASTER_KEY env',
    );
  }

  // Priority 5: Interactive prompt on TTY.
  // Not implemented yet — for now we throw a clear error so users
  // understand the situation. Implementation deferred to a follow-up
  // since the use case (unattended boot) is rare and the warning
  // already steers users toward `pdatahub-hub --store-keyring <hex>`.
  throw new Error(
    'No master_key source available. Options:\n' +
      '  1. Pass --master-key <hex> or HUB_MASTER_KEY=<hex> (INSECURE, see warning above)\n' +
      '  2. Run `pdatahub-hub --store-keyring <hex>` once to store in OS keyring, ' +
      'then start without flags\n' +
      '  3. Interactive mode not yet implemented',
  );
}

/**
 * Synchronous config loader — preserved as the entry point for tests
 * and for the production hot path where all sources are CLI args
 * (priority 1-3 do not need async). When the keyring path is needed,
 * use `loadConfigAsync` instead.
 *
 * For tests: we synthesize a "keyring unavailable" result so the
 * legacy path is exercised. Real users get keyring via `loadConfigAsync`.
 */
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
  const ackInsecure = args['ack-insecure-master-key'] === true;

  // Synchronous fallback — must NOT touch the keyring (async-only API).
  // We resolve synchronously using CLI/env/passphrase only, ignoring the
  // keyring. Callers that need the keyring path should use loadConfigAsync.
  let masterKey: Buffer;
  let masterKeySource: HubConfig['masterKeySource'];
  if (masterKeyHex) {
    if (masterKeyHex.length !== 64) {
      throw new Error('--master-key must be 32 bytes hex-encoded (64 chars)');
    }
    if (!ackInsecure) {
      logger.warn(
        'master_key sourced from --master-key/HUB_MASTER_KEY — readable by any local user via process listing. ' +
          'See docs/threat-model.md §T-PERSISTENT-001. ' +
          'Suppress with --ack-insecure-master-key or migrate to system keyring.',
      );
    }
    masterKey = Buffer.from(masterKeyHex, 'hex');
    masterKeySource = masterKeyHex === args['master-key'] ? 'cli-arg' : 'env';
  } else if (passphrase) {
    if (!ackInsecure) {
      logger.warn(
        'master_key sourced from --passphrase/HUB_PASSPHRASE — readable by any local user via process listing. ' +
          'See docs/threat-model.md §T-PERSISTENT-001. ' +
          'Suppress with --ack-insecure-master-key or migrate to system keyring.',
      );
    }
    masterKey = deriveMasterKeyFromPassphrase(passphrase);
    masterKeySource = 'passphrase';
  } else {
    throw new Error(
      'Must provide --master-key <hex> or --passphrase <text>, or store the master_key in the OS keyring ' +
        '(run `pdatahub-hub --store-keyring <hex>` once). ' +
        'See docs/threat-model.md §T-PERSISTENT-001 for details.',
    );
  }

  return {
    host,
    port,
    dbPath,
    masterKey,
    masterKeySource,
    logLevel,
    pluginsDir,
    pluginIdleTimeoutMs: 5 * 60_000, // 5 min
    pluginHeartbeatMs: 30_000, // 30 sec
    oauthCallbackPort,
  };
}

/**
 * Async config loader that honours the full priority chain including
 * the system keyring. Use this in production startup; `loadConfig`
 * remains for tests that want to assert legacy behaviour without
 * hitting the keyring.
 */
export async function loadConfigAsync(
  argv: string[] = process.argv.slice(2),
): Promise<HubConfig> {
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

  const cliMasterKeyHex = args['master-key'];
  const cliPassphrase = args.passphrase;
  const envMasterKeyHex = process.env.HUB_MASTER_KEY;
  const ackInsecure = args['ack-insecure-master-key'] === true;
  const keyringService = readArgValue(argv, '--keyring-service') ?? 'pdatahub-hub';
  const keyringAccount = readArgValue(argv, '--keyring-account') ?? 'master-key';

  const { masterKey, source } = await resolveMasterKey(
    cliMasterKeyHex,
    cliPassphrase,
    envMasterKeyHex,
    ackInsecure,
    keyringService,
    keyringAccount,
  );

  return {
    host,
    port,
    dbPath,
    masterKey,
    masterKeySource: source,
    logLevel,
    pluginsDir,
    pluginIdleTimeoutMs: 5 * 60_000, // 5 min
    pluginHeartbeatMs: 30_000, // 30 sec
    oauthCallbackPort,
  };
}

/**
 * Re-export for callers that want to log which backend is active.
 */
export { keyringBackendLabel };