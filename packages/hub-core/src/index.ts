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
import { loadConfigAsync, resolveMasterKey } from './config.js';
import { GrantStore } from './grant-store.js';
import { AuditLog } from './audit-log.js';
import { TokenVault } from './token-vault.js';
import { OAuthFlow } from './oauth-flow.js';
import { ApprovalStream } from './approval-stream.js';
import { PluginRegistry } from './plugin-process.js';
import { HubServer, loadClientCredentialsFromEnv } from './server.js';
import { HubIdentity } from './federation/identity.js';
import { DelegationStore } from './federation/delegation.js';
import { NonceStore } from './federation/nonces.js';
import {
  cmdAcceptDelegation,
  cmdDelegate,
  cmdListGranted,
  cmdListReceived,
  cmdRevokeDelegation,
  parseDurationAgo,
} from './federation/delegation-cli.js';
import {
  FederationHttpClient,
  resolveHubUrl,
  resolveApiToken,
  FederationHttpError,
  type DelegateHttpResult,
  type ListDelegationsHttpResult,
  type RevokeHttpResult,
} from './federation/federation-http.js';
import { logger } from './logger.js';
import { runMigrations } from './migrations.js';
import { checkHubApiTokenRequirement } from './startup.js';
import {
  deleteMasterKey,
  hasMasterKey,
  isKeyringAvailable,
  keyringBackendLabel,
  setMasterKey as setMasterKeyInKeyring,
} from './keyring.js';
import {
  generateMnemonic,
  mnemonicToMasterKey,
  backup as backupVault,
  restore as restoreVault,
  inspect as inspectBackup,
} from './backup/index.js';

/** Default keyring service name. Used by --keyring-service and pdatahub-hub keyring subcommand. */
const DEFAULT_KEYRING_SERVICE = 'pdatahub-hub';
const DEFAULT_KEYRING_ACCOUNT = 'master-key';

function readKeyringNames(argv: string[]): { service: string; account: string } {
  const sIdx = argv.indexOf('--keyring-service');
  const service = sIdx !== -1 && argv[sIdx + 1] ? argv[sIdx + 1] : DEFAULT_KEYRING_SERVICE;
  const aIdx = argv.indexOf('--keyring-account');
  const account = aIdx !== -1 && argv[aIdx + 1] ? argv[aIdx + 1] : DEFAULT_KEYRING_ACCOUNT;
  return { service, account };
}

function hasAckInsecure(argv: string[]): boolean {
  return argv.includes('--ack-insecure-master-key');
}

/**
 * Tell the user where their master_key lives (keyring vs CLI arg vs env)
 * after a successful `backup`. The keyring path is the recommended
 * secure flow per T-PERSISTENT-001.
 */
async function printKeyringHint(argv: string[]): Promise<void> {
  const { service, account } = readKeyringNames(argv);
  // eslint-disable-next-line no-console
  console.log('');
  if (await isKeyringAvailable()) {
    // eslint-disable-next-line no-console
    console.log(
      `Master key is stored in: ${service}/${account} (via ${keyringBackendLabel()}).`,
    );
    // eslint-disable-next-line no-console
    console.log(`Use \`pdatahub-hub keyring show\` to verify.`);
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `WARNING: master_key NOT in keyring. Backup was sourced from --master-key/HUB_MASTER_KEY ` +
        `(insecure — visible to any local user via process listing).`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `Install libsecret + gnome-keyring (Linux), then run: pdatahub-hub --store-keyring <hex>`,
    );
  }
}

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
  '--keyring-service',
  '--keyring-account',
  '--store-keyring',
  '--legacy-master-key',
  '--hub-url',
  '--api-token',
  '--format',
  '--filter',
  '--expires',
  '--peer-verify-key',
  '--plugin',
  '--tool',
  '--scope',
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

/**
 * Common flags shared by federation subcommands. Pass them via
 * `--hub-url <url>`, `--api-token <token>`, `--format <table|json>`,
 * `--filter <granted|received|all>`. Hub URL also read from PDHUB_URL env.
 *
 * Behavior:
 *   - If `hubUrl` is set (or PDHUB_URL env is set), the CLI talks to the
 *     running hub via HTTP. `apiToken` (or PDHUB_API_TOKEN/HUB_API_TOKEN env)
 *     is REQUIRED in HTTP mode.
 *   - If `hubUrl` is unset, the CLI uses direct DB access (requires
 *     master_key resolution via the legacy path). Useful for offline
 *     management or for hubs without HUB_API_TOKEN configured.
 *   - `format` defaults to `table`; `json` is for scripting.
 *   - `filter` defaults to `all`; `granted` shows A-side, `received` shows B-side.
 */
interface FederationCommonFlags {
  hubUrl?: string;
  apiToken?: string;
  format: 'table' | 'json';
  filter: 'all' | 'granted' | 'received';
}

function parseCommonFederationFlags(argv: string[]): FederationCommonFlags {
  const hubUrlIdx = argv.indexOf('--hub-url');
  const hubUrl = hubUrlIdx !== -1 && argv[hubUrlIdx + 1] ? argv[hubUrlIdx + 1] : undefined;
  const apiTokenIdx = argv.indexOf('--api-token');
  const apiToken = apiTokenIdx !== -1 && argv[apiTokenIdx + 1] ? argv[apiTokenIdx + 1] : undefined;
  const formatIdx = argv.indexOf('--format');
  const formatRaw = formatIdx !== -1 && argv[formatIdx + 1] ? argv[formatIdx + 1] : 'table';
  const format: 'table' | 'json' = formatRaw === 'json' ? 'json' : 'table';
  const filterIdx = argv.indexOf('--filter');
  const filterRaw = filterIdx !== -1 && argv[filterIdx + 1] ? argv[filterIdx + 1] : 'all';
  const filter: 'all' | 'granted' | 'received' =
    filterRaw === 'granted' || filterRaw === 'received' ? filterRaw : 'all';
  return { hubUrl, apiToken, format, filter };
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
  | {
      kind: 'delegate';
      peerVerifyKey: string;
      plugin: string;
      tool: string;
      scope: string;
      expires: string;
      dbPath?: string;
      masterKeyHex?: string;
      common: FederationCommonFlags;
    }
  | {
      kind: 'accept-delegation';
      blob: string;
      yes: boolean;
      dbPath?: string;
      masterKeyHex?: string;
    }
  | {
      kind: 'delegate-list';
      dbPath?: string;
      masterKeyHex?: string;
      common: FederationCommonFlags;
    }
  | {
      kind: 'delegation-list';
      dbPath?: string;
      masterKeyHex?: string;
      common: FederationCommonFlags;
    }
  | {
      kind: 'delegation-revoke';
      delegationId: string;
      dbPath?: string;
      masterKeyHex?: string;
      common: FederationCommonFlags;
    }
  | {
      kind: 'audit-purge';
      olderThan: string;
      yes: boolean;
      dbPath?: string;
    }
  | { kind: 'keyring-show'; }
  | { kind: 'keyring-clear'; }
  | { kind: 'keyring-store'; masterKeyHex: string }
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
    case 'delegate': {
      // Sub-sub-command: `delegate list` (lists granted). Otherwise
      // `delegate` with flags creates a new delegation.
      const delegateIdx = argv.indexOf('delegate');
      const nextIdx = delegateIdx + 1 < argv.length ? delegateIdx + 1 : -1;
      const next = nextIdx !== -1 ? argv[nextIdx] : undefined;
      if (next === 'list') {
        const dIdx = argv.indexOf('--db-path');
        const dbPath = dIdx !== -1 && argv[dIdx + 1] ? argv[dIdx + 1] : undefined;
        const mIdx = argv.indexOf('--master-key');
        const masterKeyHex =
          mIdx !== -1 && argv[mIdx + 1] ? argv[mIdx + 1] : undefined;
        return { kind: 'delegate-list', dbPath, masterKeyHex, common: parseCommonFederationFlags(argv) };
      }
      // Required flags.
      const reqFlag = (name: string): string => {
        const i = argv.indexOf(name);
        const v = i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
        if (!v) {
          throw new Error(`missing required flag ${name}`);
        }
        return v;
      };
      const dIdx = argv.indexOf('--db-path');
      const dbPath = dIdx !== -1 && argv[dIdx + 1] ? argv[dIdx + 1] : undefined;
      const mIdx = argv.indexOf('--master-key');
      const masterKeyHex =
        mIdx !== -1 && argv[mIdx + 1] ? argv[mIdx + 1] : undefined;
      return {
        kind: 'delegate',
        peerVerifyKey: reqFlag('--peer-verify-key'),
        plugin: reqFlag('--plugin'),
        tool: reqFlag('--tool'),
        scope: reqFlag('--scope'),
        expires: reqFlag('--expires'),
        dbPath,
        masterKeyHex,
        common: parseCommonFederationFlags(argv),
      };
    }
    case 'accept-delegation': {
      // First positional after 'accept-delegation' is the blob.
      const accIdx = argv.indexOf('accept-delegation');
      const nextIdx = accIdx + 1 < argv.length ? accIdx + 1 : -1;
      const blob = nextIdx !== -1 ? argv[nextIdx] : undefined;
      if (!blob || blob.startsWith('--')) {
        throw new Error(
          'usage: pdatahub-hub accept-delegation <blob> [--yes]',
        );
      }
      const dIdx = argv.indexOf('--db-path');
      const dbPath = dIdx !== -1 && argv[dIdx + 1] ? argv[dIdx + 1] : undefined;
      const mIdx = argv.indexOf('--master-key');
      const masterKeyHex =
        mIdx !== -1 && argv[mIdx + 1] ? argv[mIdx + 1] : undefined;
      const yes = argv.includes('--yes');
      return { kind: 'accept-delegation', blob, yes, dbPath, masterKeyHex };
    }
    case 'delegation': {
      const dlgIdx = argv.indexOf('delegation');
      const nextIdx = dlgIdx + 1 < argv.length ? dlgIdx + 1 : -1;
      const sub = nextIdx !== -1 ? argv[nextIdx] : undefined;
      if (sub === 'list') {
        const dIdx = argv.indexOf('--db-path');
        const dbPath = dIdx !== -1 && argv[dIdx + 1] ? argv[dIdx + 1] : undefined;
        const mIdx = argv.indexOf('--master-key');
        const masterKeyHex =
          mIdx !== -1 && argv[mIdx + 1] ? argv[mIdx + 1] : undefined;
        return { kind: 'delegation-list', dbPath, masterKeyHex, common: parseCommonFederationFlags(argv) };
      }
      if (sub === 'revoke') {
        const idIdx = dlgIdx + 2 < argv.length ? dlgIdx + 2 : -1;
        const delegationId = idIdx !== -1 ? argv[idIdx] : undefined;
        if (!delegationId || delegationId.startsWith('--')) {
          throw new Error(
            'usage: pdatahub-hub delegation revoke <delegation_id>',
          );
        }
        const dIdx = argv.indexOf('--db-path');
        const dbPath = dIdx !== -1 && argv[dIdx + 1] ? argv[dIdx + 1] : undefined;
        const mIdx = argv.indexOf('--master-key');
        const masterKeyHex =
          mIdx !== -1 && argv[mIdx + 1] ? argv[mIdx + 1] : undefined;
        return { kind: 'delegation-revoke', delegationId, dbPath, masterKeyHex, common: parseCommonFederationFlags(argv) };
      }
      throw new Error('usage: pdatahub-hub delegation <list|revoke>');
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
    case 'audit': {
      const aIdx = argv.indexOf('audit');
      const nextIdx = aIdx + 1 < argv.length ? aIdx + 1 : -1;
      const sub = nextIdx !== -1 ? argv[nextIdx] : undefined;
      if (sub !== 'purge') {
        throw new Error('usage: pdatahub-hub audit purge --older-than <duration> [--yes]');
      }
      const oIdx = argv.indexOf('--older-than');
      const olderThan = oIdx !== -1 && argv[oIdx + 1] ? argv[oIdx + 1] : undefined;
      if (!olderThan) {
        throw new Error('missing required flag --older-than (e.g. --older-than 365d)');
      }
      const dIdx = argv.indexOf('--db-path');
      const dbPath = dIdx !== -1 && argv[dIdx + 1] ? argv[dIdx + 1] : undefined;
      const yes = argv.includes('--yes');
      return { kind: 'audit-purge', olderThan, yes, dbPath };
    }
    case 'keyring': {
      const kIdx = argv.indexOf('keyring');
      const subIdx = kIdx + 1 < argv.length ? kIdx + 1 : -1;
      const sub = subIdx !== -1 ? argv[subIdx] : undefined;
      if (sub === 'show' || sub === 'status') {
        return { kind: 'keyring-show' };
      }
      if (sub === 'clear' || sub === 'delete') {
        return { kind: 'keyring-clear' };
      }
      throw new Error(
        'usage: pdatahub-hub keyring <show|clear> [--keyring-service <s>] [--keyring-account <a>]',
      );
    }
    case 'help':
    case '--help':
    case '-h':
      return { kind: 'help' };
    default:
      throw new Error(
        `unknown subcommand: ${first} (try: init, identity, delegate, accept-delegation, delegation, audit, keyring, backup, restore, inspect, help, or pass --store-keyring <hex>)`,
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
  pdatahub-hub delegate [flags]             Issue a delegation (Phase 4, A side)
  pdatahub-hub delegate list                List granted delegations
  pdatahub-hub accept-delegation <blob>     Import a delegation (Phase 4, B side)
  pdatahub-hub delegation list              List received delegations
  pdatahub-hub delegation revoke <id>       Revoke a granted delegation
  pdatahub-hub audit purge --older-than <d> Delete audit rows older than <d> (Nd|Nh|Nw)
                                           With --yes: actually delete. Without: preview only.
  pdatahub-hub keyring show                 Show OS keyring status (service/account)
  pdatahub-hub keyring clear                Remove master_key from OS keyring
  pdatahub-hub --store-keyring <hex>        Store master_key in OS keyring, then exit
  pdatahub-hub backup <db> <out>            Encrypt vault DB → backup file
  pdatahub-hub restore <in> <db>            Decrypt backup file → vault DB
  pdatahub-hub inspect <backup>             Show backup metadata (no decrypt)
  pdatahub-hub help                         This message

DELEGATE FLAGS
  --peer-verify-key <key>   Peer's ed25519 verify_key (from 'identity show')
  --plugin <name>           Plugin name (e.g. google-calendar)
  --tool <name>             Tool name (e.g. listEvents)
  --scope <scope>           Required scope (must match plugin manifest)
  --expires <duration>      Duration like "24h", "30d", "1w"
  --yes                     Skip y/N confirmation (accept-delegation only)

REMOTE HUB MODE (delegate, delegate list, delegation list, delegation revoke)
  --hub-url <url>           Talk to a running hub via HTTP instead of direct DB
                            access. Also reads from PDHUB_URL env.
  --api-token <token>       Bearer token for HTTP mode. Also reads from
                            PDHUB_API_TOKEN / HUB_API_TOKEN env.
  --format <fmt>            Output format: table (default) | json
  --filter <kind>           For list commands: all (default) | granted | received

  When --hub-url is set, the CLI does NOT touch the SQLite database directly —
  master_key never enters the CLI process. Useful for managing a hub running
  on another machine (Cloud v3 future) or for scripting without holding the
  master key locally.
  When --hub-url is unset, the CLI uses direct DB access (requires master_key
  resolution via --master-key, env, or keyring). accept-delegation is
  always DB-direct — it requires DNS resolution + interactive confirmation
  that are not exposed over HTTP.

HUB STARTUP FLAGS
  --port <num>            HTTP port (default 8080)
  --db-path <path>        SQLite DB path (default ./pdatahub-hub.db)
  --master-key <hex>      32-byte hex master key (64 chars). INSECURE — see --ack-insecure-master-key.
  --passphrase <text>     Derive master key via scrypt. INSECURE — same warning as --master-key.
  --oauth-callback-port   Fixed port for OAuth redirect URI (default 0 = random)
  --plugins-dir <path>    Plugin directory (each subdir = one plugin)
  --log-level <level>     debug | info | warn | error (default info)
  --ack-insecure-master-key  Suppress the T-PERSISTENT-001 insecure-path warning
                              (CLI arg / env). Use after reading docs/threat-model.md.
  --keyring-service <s>   OS keyring service name (default pdatahub-hub)
  --keyring-account <a>   OS keyring account/username (default master-key)
  --store-keyring <hex>   One-shot: store this master_key in OS keyring, exit

ENV VARS (alternative to flags)
  HUB_PORT, HUB_DB_PATH, HUB_MASTER_KEY, HUB_PASSPHRASE, HUB_LOG_LEVEL,
  HUB_OAUTH_CALLBACK_PORT, HUB_PLUGINS_DIR

INTERACTIVE PROMPTS
  For backup/restore/init, the passphrase (and optional mnemonic) are read
  from stdin if --passphrase/-m flags are not provided.

SECURITY — T-PERSISTENT-001 (docs/threat-model.md)
  Passing master_key via CLI arg or env var exposes it to any local user
  via /proc/<pid>/cmdline or /proc/<pid>/environ. To migrate to a more
  secure flow:

    1. Generate: pdatahub-hub init --hub-name <name>  (prints mnemonic + hex)
    2. Store:    pdatahub-hub --store-keyring <hex>   (writes to OS keyring)
    3. Start:    pdatahub-hub                        (reads from OS keyring)

  Linux: requires libsecret + a keyring daemon (gnome-keyring, KWallet).
  macOS / Windows: built-in.
`);
}

/**
 * Try to build a FederationHttpClient for the given common flags.
 *
 * Returns null when no hub URL is configured (caller should fall back
 * to DB-direct). Throws when a hub URL IS configured but no API token
 * can be resolved — silent fallback to DB would be a footgun (operator
 * thinks the action succeeded when it was ignored).
 */
async function maybeFederationHttp(
  common: FederationCommonFlags,
): Promise<FederationHttpClient | null> {
  const baseUrl = resolveHubUrl(common.hubUrl);
  if (!baseUrl) return null;
  const apiToken = await resolveApiToken(common.apiToken);
  if (!apiToken) {
    throw new Error(
      `hub URL is set (${baseUrl}) but no API token found. ` +
        `Pass --api-token <hex>, set PDHUB_API_TOKEN env, or set HUB_API_TOKEN env.`,
    );
  }
  return new FederationHttpClient({ baseUrl, apiToken });
}

/**
 * Load delegations from HTTP (running hub) or DB-direct (offline).
 * Unifies the two paths into a single `{granted, received}` shape so
 * the printer doesn't care where the data came from.
 */
async function loadDelegations(
  cmd: Extract<
    ReturnType<typeof parseSubcommand>,
    { kind: 'delegate-list' | 'delegation-list' }
  >,
): Promise<ListDelegationsHttpResult> {
  const http = await maybeFederationHttp(cmd.common);
  if (http) {
    try {
      return await http.listDelegations();
    } catch (err) {
      if (err instanceof FederationHttpError) throw err;
      throw new Error(`list delegations via hub failed: ${(err as Error).message}`);
    }
  }
  const { masterKey, dbPath } = await resolveIdentityContext(
    cmd.dbPath,
    cmd.masterKeyHex,
    undefined,
  );
  const [granted, received] = await Promise.all([
    cmdListGranted(dbPath, masterKey),
    cmdListReceived(dbPath, masterKey),
  ]);
  return { granted, received };
}

/** Print the delegate-created output (works for both HTTP and DB paths). */
function printDelegateResult(
  result: DelegateHttpResult,
  plugin: string,
  tool: string,
  scope: string,
  expires: string,
): void {
  // eslint-disable-next-line no-console
  console.log(`Delegation issued: ${result.delegation_id}`);
  // eslint-disable-next-line no-console
  console.log(`Plugin: ${plugin} / ${tool}   Scope: ${scope}`);
  // eslint-disable-next-line no-console
  console.log(`Expires: ${expires}`);
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(`Blob (base64url, share this with the peer):`);
  // eslint-disable-next-line no-console
  console.log(result.blob);
  if (result.qr_png_base64) {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(`QR (base64 PNG, ${result.qr_png_base64.length} chars):`);
    // eslint-disable-next-line no-console
    console.log(result.qr_png_base64);
  } else {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(`(QR generation skipped — blob is the authoritative transport)`);
  }
}

/** Print delegations in table or JSON format, honoring --filter. */
function printDelegations(
  data: ListDelegationsHttpResult,
  format: 'table' | 'json',
  filter: 'all' | 'granted' | 'received',
): void {
  if (format === 'json') {
    const filtered =
      filter === 'granted'
        ? { granted: data.granted, received: [] }
        : filter === 'received'
          ? { granted: [], received: data.received }
          : data;
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }
  // Table format
  if (filter === 'all' || filter === 'granted') {
    // eslint-disable-next-line no-console
    console.log(`\nGRANTED (you issued these to peer hubs):`);
    // eslint-disable-next-line no-console
    console.log(
      `${'ID'.padEnd(38)} ${'Plugin'.padEnd(22)} ${'Tool'.padEnd(16)} ${'Scope'.padEnd(18)} ${'Expires'.padEnd(22)} ${'Revoked'}`,
    );
    for (const r of data.granted) {
      // eslint-disable-next-line no-console
      console.log(
        `${r.delegation_id.padEnd(38)} ${r.plugin.padEnd(22)} ${r.tool.padEnd(16)} ${r.scope.padEnd(18)} ${r.expires_at.padEnd(22)} ${r.revoked === 1 ? 'yes' : 'no'}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(`\n${data.granted.length} granted delegation(s).`);
  }
  if (filter === 'all' || filter === 'received') {
    // eslint-disable-next-line no-console
    console.log(`\nRECEIVED (peer hubs issued these to you):`);
    // eslint-disable-next-line no-console
    console.log(
      `${'ID'.padEnd(38)} ${'Peer'.padEnd(16)} ${'Plugin'.padEnd(22)} ${'Tool'.padEnd(16)} ${'Scope'.padEnd(18)} ${'Expires'.padEnd(22)} ${'Revoked'}`,
    );
    for (const r of data.received) {
      // eslint-disable-next-line no-console
      console.log(
        `${r.delegation_id.padEnd(38)} ${r.peer_hub_name.padEnd(16)} ${r.plugin.padEnd(22)} ${r.tool.padEnd(16)} ${r.scope.padEnd(18)} ${r.expires_at.padEnd(22)} ${r.revoked === 1 ? 'yes' : 'no'}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(`\n${data.received.length} received delegation(s).`);
  }
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
    const { masterKey, dbPath } = await resolveIdentityContext(cmd.dbPath, cmd.masterKeyHex, cmd.passphrase);
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
    const { masterKey, dbPath } = await resolveIdentityContext(cmd.dbPath, cmd.masterKeyHex, cmd.passphrase);
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
    const argv = process.argv.slice(2);
    const { masterKey } = await resolveMasterKey(
      argv.includes('--master-key') ? argv[argv.indexOf('--master-key') + 1] : undefined,
      argv.includes('--passphrase') ? argv[argv.indexOf('--passphrase') + 1] : undefined,
      process.env.HUB_MASTER_KEY,
      hasAckInsecure(argv),
    );
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
    await printKeyringHint(argv);
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
    console.log('');
    // eslint-disable-next-line no-console
    console.log(`Start hub with:  pdatahub-hub --master-key ${masterKey.toString('hex')}`);
    // eslint-disable-next-line no-console
    console.log(`Or store in keyring (recommended):`);
    // eslint-disable-next-line no-console
    console.log(`  pdatahub-hub --store-keyring ${masterKey.toString('hex')}`);
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

  if (cmd.kind === 'delegate') {
    const http = await maybeFederationHttp(cmd.common);
    if (http) {
      let result: DelegateHttpResult;
      try {
        result = await http.delegate({
          peer_verify_key: cmd.peerVerifyKey,
          plugin: cmd.plugin,
          tool: cmd.tool,
          scope: cmd.scope,
          expires_in: cmd.expires,
        });
      } catch (err) {
        if (err instanceof FederationHttpError) throw err;
        throw new Error(`delegate via hub failed: ${(err as Error).message}`);
      }
      printDelegateResult(result, cmd.plugin, cmd.tool, cmd.scope, cmd.expires);
      return 0;
    }
    const { masterKey, dbPath } = await resolveIdentityContext(
      cmd.dbPath,
      cmd.masterKeyHex,
      undefined,
    );
    // Scope validation (Momus C5) requires a loaded PluginRegistry. The
    // CLI does not start the hub server, so plugins are not running here;
    // skipping scope check at the CLI is the documented best-effort path
    // (Phase 4 design §"Delegation creation"). The HTTP `/v1/federation/
    // call` handler enforces scope at call time against the live registry.
    const result = await cmdDelegate({
      dbPath,
      masterKey,
      peerVerifyKey: cmd.peerVerifyKey,
      plugin: cmd.plugin,
      tool: cmd.tool,
      scope: cmd.scope,
      expiresIn: cmd.expires,
    });
    printDelegateResult(
      {
        delegation_id: result.delegation_id,
        blob: result.blob,
        issuer: '',
        ...(result.qrPngBase64 ? { qr_png_base64: result.qrPngBase64 } : {}),
      },
      cmd.plugin,
      cmd.tool,
      cmd.scope,
      cmd.expires,
    );
    return 0;
  }

  if (cmd.kind === 'delegate-list' || cmd.kind === 'delegation-list') {
    const data = await loadDelegations(cmd);
    printDelegations(data, cmd.common.format, cmd.common.filter);
    return 0;
  }

  if (cmd.kind === 'accept-delegation') {
    const { masterKey, dbPath } = await resolveIdentityContext(
      cmd.dbPath,
      cmd.masterKeyHex,
      undefined,
    );
    const result = await cmdAcceptDelegation({
      dbPath,
      masterKey,
      blob: cmd.blob,
      yes: cmd.yes,
    });
    // eslint-disable-next-line no-console
    console.log(`\nImported delegation: ${result.delegation_id}`);
    // eslint-disable-next-line no-console
    console.log(`Peer:    ${result.peer_hub_name}`);
    // eslint-disable-next-line no-console
    console.log(`Hub URL: ${result.peer_hub_url}`);
    // eslint-disable-next-line no-console
    console.log(`\nUse "pdatahub-hub delegation list" to view received delegations.`);
    return 0;
  }

  if (cmd.kind === 'delegation-revoke') {
    const http = await maybeFederationHttp(cmd.common);
    if (http) {
      let result: RevokeHttpResult;
      try {
        result = await http.revokeDelegation(cmd.delegationId);
      } catch (err) {
        if (err instanceof FederationHttpError) throw err;
        throw new Error(`revoke via hub failed: ${(err as Error).message}`);
      }
      // eslint-disable-next-line no-console
      console.log(`Revoked: ${result.delegation_id}`);
      return 0;
    }
    const { masterKey, dbPath } = await resolveIdentityContext(
      cmd.dbPath,
      cmd.masterKeyHex,
      undefined,
    );
    const ok = await cmdRevokeDelegation(dbPath, masterKey, cmd.delegationId);
    if (ok) {
      // eslint-disable-next-line no-console
      console.log(`Revoked: ${cmd.delegationId}`);
      return 0;
    }
    // eslint-disable-next-line no-console
    console.error(`No delegation found with id: ${cmd.delegationId}`);
    return 1;
  }

  if (cmd.kind === 'audit-purge') {
    const dbPath = cmd.dbPath ?? process.env.HUB_DB_PATH ?? './pdatahub-hub.db';
    const cutoffDate = parseDurationAgo(cmd.olderThan);
    const cutoffISO = cutoffDate.toISOString();
    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    try {
      runMigrations(db);
      const audit = new AuditLog(db);
      const matching = audit.countOlderThan(cutoffISO);
      if (!cmd.yes) {
        // eslint-disable-next-line no-console
        console.log(
          `Preview: ${matching} audit row${matching === 1 ? '' : 's'} older than ${cmd.olderThan} would be deleted.`,
        );
        // eslint-disable-next-line no-console
        console.log(`Run with --yes to actually delete.`);
        return 0;
      }
      const deleted = audit.purgeOlderThan(cutoffISO);
      const remaining = (db
        .prepare('SELECT COUNT(*) as n FROM audit_log')
        .get() as { n: number }).n;
      // eslint-disable-next-line no-console
      console.log(`Deleted ${deleted} audit row${deleted === 1 ? '' : 's'} (older than ${cmd.olderThan}).`);
      // eslint-disable-next-line no-console
      console.log(`${remaining} remaining audit row${remaining === 1 ? '' : 's'}.`);
      return 0;
    } finally {
      db.close();
    }
  }

  if (cmd.kind === 'keyring-show') {
    const argv = process.argv.slice(2);
    const { service, account } = readKeyringNames(argv);
    if (!(await isKeyringAvailable())) {
      // eslint-disable-next-line no-console
      console.log(`Keyring: UNAVAILABLE (backend: ${keyringBackendLabel()})`);
      // eslint-disable-next-line no-console
      console.log(`On Linux: ensure libsecret and a keyring daemon (gnome-keyring, KWallet) are running.`);
      return 1;
    }
    const present = await hasMasterKey(service, account);
    // eslint-disable-next-line no-console
    console.log(`Keyring:    ${keyringBackendLabel()}`);
    // eslint-disable-next-line no-console
    console.log(`Service:    ${service}`);
    // eslint-disable-next-line no-console
    console.log(`Account:    ${account}`);
    // eslint-disable-next-line no-console
    console.log(`Has master_key: ${present ? 'yes' : 'no'}`);
    if (present) {
      // eslint-disable-next-line no-console
      console.log(`Hint: remove with 'pdatahub-hub keyring clear'.`);
    } else {
      // eslint-disable-next-line no-console
      console.log(`Hint: store with 'pdatahub-hub --store-keyring <hex>'.`);
    }
    return 0;
  }

  if (cmd.kind === 'keyring-clear') {
    const argv = process.argv.slice(2);
    const { service, account } = readKeyringNames(argv);
    if (!(await isKeyringAvailable())) {
      // eslint-disable-next-line no-console
      console.error(`Keyring unavailable on this platform (${keyringBackendLabel()}).`);
      return 1;
    }
    const removed = await deleteMasterKey(service, account);
    if (removed) {
      // eslint-disable-next-line no-console
      console.log(`Removed master_key from keyring (${service}/${account}).`);
      return 0;
    }
    // eslint-disable-next-line no-console
    console.log(`No master_key was stored at ${service}/${account}.`);
    return 0;
  }

  if (cmd.kind === 'keyring-store') {
    const argv = process.argv.slice(2);
    const { service, account } = readKeyringNames(argv);
    if (!(await isKeyringAvailable())) {
      // eslint-disable-next-line no-console
      console.error(`Keyring unavailable on this platform (${keyringBackendLabel()}).`);
      // eslint-disable-next-line no-console
      console.error(`Install libsecret + gnome-keyring (Linux), use macOS Keychain, or Credential Manager (Windows).`);
      return 1;
    }
    if (cmd.masterKeyHex.length !== 64) {
      throw new Error('--store-keyring must be 32 bytes hex-encoded (64 chars)');
    }
    const key = Buffer.from(cmd.masterKeyHex, 'hex');
    await setMasterKeyInKeyring(key, service, account);
    // eslint-disable-next-line no-console
    console.log(`Stored master_key in keyring: ${service}/${account} (via ${keyringBackendLabel()})`);
    // eslint-disable-next-line no-console
    console.log(`You can now run 'pdatahub-hub' without --master-key.`);
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

async function resolveIdentityContext(
  dbPathFlag: string | undefined,
  masterKeyHexFlag: string | undefined,
  passphraseFlag: string | undefined,
): Promise<{ masterKey: Buffer; dbPath: string }> {
  const dbPath = dbPathFlag ?? process.env.HUB_DB_PATH ?? './pdatahub-hub.db';
  const argv = process.argv.slice(2);
  const { masterKey } = await resolveMasterKey(
    masterKeyHexFlag,
    passphraseFlag,
    process.env.HUB_MASTER_KEY,
    hasAckInsecure(argv),
  );
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
  const argv = process.argv.slice(2);

  // One-shot: `pdatahub-hub --store-keyring <hex>` writes the master_key
  // to the OS keyring and exits. Handled before subcommand dispatch so
  // it works without a positional arg.
  const storeIdx = argv.indexOf('--store-keyring');
  if (storeIdx !== -1 && argv[storeIdx + 1]) {
    const code = await handleSubcommand({
      kind: 'keyring-store',
      masterKeyHex: argv[storeIdx + 1],
    });
    process.exit(code);
  }

  // Subcommand dispatch.
  const sub = parseSubcommand(argv);
  if (sub.kind !== 'none') {
    const code = await handleSubcommand(sub);
    process.exit(code);
  }

  // Default: start hub.
  const config = await loadConfigAsync();
  logger.info('starting pdatahub-hub', {
    host: config.host,
    port: config.port,
    db_path: config.dbPath,
    plugins_dir: config.pluginsDir,
    master_key_source: config.masterKeySource,
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
  const tokens = new TokenVault(db, config.masterKey, audit);

  // Phase 3 + 4 — wire federation stores (delegations + nonces). Without
  // these, /v1/federation/call returns 503 FEDERATION_NOT_INITIALIZED
  // even with valid config (Phase 3 deviation #4 fix).
  const delegations = new DelegationStore(db);
  const nonces = new NonceStore(db);

  // Initialize OAuth + approval stream
  const oauth = new OAuthFlow(tokens, config.oauthCallbackPort);
  const approval = new ApprovalStream({ timeoutMs: 60_000 });

  // T-PERSISTENT-001 mitigation #2 — wire the WebSocket broadcaster
  // onto the audit log so every vault-decryption event (written by
  // TokenVault.getAccessToken) gets pushed live to the Android UI
  // over `/approval-stream`. ApprovalStream satisfies the structural
  // VaultAccessBroadcaster interface via its broadcastVaultAccess
  // method. Wiring happens BEFORE server.start() so the first
  // incoming MCP call already has a broadcaster attached.
  audit.setBroadcaster(approval);

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
    delegations,
    nonces,
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
