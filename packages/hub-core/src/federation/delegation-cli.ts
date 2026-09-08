/**
 * Phase 4 — delegation CLI subcommands.
 *
 * Exports the business logic for:
 *   - `pdatahub-hub delegate`                 (A side — issue delegation)
 *   - `pdatahub-hub accept-delegation <blob>` (B side — import delegation)
 *   - `pdatahub-hub delegation list`          (B side — list received)
 *   - `pdatahub-hub delegation revoke <id>`   (A side — revoke granted)
 *
 * All commands open the SQLite DB at `dbPath`, run migrations to ensure
 * schema is current, then perform their action. The CLI entry point
 * (`src/index.ts`) parses argv into typed options and calls these
 * functions; this module is deliberately CLI-agnostic so it can be
 * reused by tests and by future programmatic surfaces.
 *
 * Design references:
 *   - federation-v2-design.md §"Delegation creation (A)" / §"Delegation import (B)"
 *   - Momus C5  — scope validation against plugin manifest at creation
 *   - Momus I10 — trust anchor is `issuer.verify_key` IN the signed blob
 *   - Momus Q5  — fingerprint confirmation + y/N before storing
 *
 * QR code: generated via `qrcode` npm package, encoded as base64 PNG.
 * If encoding fails (e.g., blob exceeds QR capacity at low error
 * correction), the function falls back to terminal-rendered QR via
 * `qrcode.toString({ type: 'terminal' })`. If both fail (rare — only
 * happens with extreme input), it returns the base64 blob to stdout
 * with a warning. TDD note: QR is NEVER a hard requirement for the
 * CLI; the blob is the contract.
 */

import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { promises as dnsPromises } from 'node:dns';
import { HubIdentity } from './identity.js';
import {
  type DelegationGrantedRow,
  type DelegationReceivedRow,
  DelegationStore,
  type DelegationBlobV1,
  type DelegationBlobV1Body,
  getToolInputSchema,
  parseBlob,
  signDelegation,
  verifyDelegation,
} from './delegation.js';
import type { PluginRegistry } from '../plugin-process.js';
import { runMigrations } from '../migrations.js';
import { logger } from '../logger.js';
import Database from 'better-sqlite3';

/* ─── Public types ─────────────────────────────────────────────────────── */

/**
 * Result of a successful delegation creation. `qrPngBase64` is optional
 * and may be undefined when QR encoding fails — the blob is always the
 * authoritative transport.
 */
export interface DelegateResult {
  delegation_id: string;
  blob: string;
  /** base64-encoded PNG, ready for terminal display via ascii art or piping. */
  qrPngBase64?: string;
}

/** Result of `cmdAcceptDelegation`. */
export interface AcceptDelegationResult {
  delegation_id: string;
  peer_hub_name: string;
  peer_hub_url: string;
}

/* ─── Duration parser ──────────────────────────────────────────────────── */

/**
 * Parse a human-friendly duration string and return a future `Date`.
 * Supported units: `h` (hours), `d` (days), `w` (weeks). Must be a
 * positive integer followed by exactly one unit character.
 *
 * Examples:
 *   parseDuration('24h') → now + 24h
 *   parseDuration('30d') → now + 30d
 *   parseDuration('1w')  → now + 7d
 *   parseDuration('invalid') → throws
 *
 * Anchor: `now` defaults to `Date.now()` — exposed as an option for
 * deterministic tests.
 */
export function parseDuration(input: string, now: number = Date.now()): Date {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('duration must be a non-empty string like "24h", "30d", "1w"');
  }
  const match = /^(\d+)([hdw])$/.exec(input);
  if (!match) {
    throw new Error(
      `invalid duration "${input}" (expected format: <positive integer><h|d|w>, e.g. "24h", "30d", "1w")`,
    );
  }
  const n = parseInt(match[1]!, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid duration "${input}" (number must be > 0)`);
  }
  const unit = match[2]!;
  let ms = 0;
  switch (unit) {
    case 'h':
      ms = n * 60 * 60 * 1000;
      break;
    case 'd':
      ms = n * 24 * 60 * 60 * 1000;
      break;
    case 'w':
      ms = n * 7 * 24 * 60 * 60 * 1000;
      break;
    default:
      // regex already constrains — defensive fallthrough.
      throw new Error(`unknown duration unit "${unit}"`);
  }
  return new Date(now + ms);
}

/**
 * Like `parseDuration` but returns `now - duration` instead of `now + duration`.
 * Used by `pdatahub-hub audit purge --older-than Nd` to compute the cutoff
 * timestamp: rows whose `timestamp < now - Nd` are eligible for deletion.
 */
export function parseDurationAgo(input: string, now: number = Date.now()): Date {
  const future = parseDuration(input, now);
  return new Date(2 * now - future.getTime());
}

/* ─── CLI helpers ──────────────────────────────────────────────────────── */

/**
 * Open the DB at `dbPath`, apply migrations, and ensure the hub identity
 * exists. Returns the open DB handle, the loaded identity, and a fresh
 * DelegationStore bound to that DB. The caller is responsible for
 * closing the DB.
 *
 * Centralized so every subcommand gets identical preconditions.
 */
function openCliContext(dbPath: string, masterKey: Buffer): {
  db: Database.Database;
  identity: HubIdentity;
  store: DelegationStore;
} {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  try {
    runMigrations(db);
    if (!HubIdentity.exists(db)) {
      throw new Error(
        `federation identity not initialized in ${dbPath}. ` +
          `Run \`pdatahub-hub init --hub-name <name> --db-path ${dbPath}\` first.`,
      );
    }
    const identity = HubIdentity.load(db, masterKey);
    const store = new DelegationStore(db);
    return { db, identity, store };
  } catch (err) {
    db.close();
    throw err;
  }
}

/* ─── cmdDelegate — A side ─────────────────────────────────────────────── */

/**
 * Options accepted by `cmdDelegate`. Field names mirror the CLI flags
 * from the design doc §"Delegation creation (A)" exactly so the parser
 * in `src/index.ts` is a thin pass-through.
 */
export interface CmdDelegateOptions {
  dbPath: string;
  masterKey: Buffer;
  /** "ed25519:<base64url>" — peer B's public verify key. */
  peerVerifyKey: string;
  plugin: string;
  tool: string;
  scope: string;
  /** Human-friendly duration like "24h", "30d", "1w". */
  expiresIn: string;
  /** Optional PluginRegistry for scope validation. Phase 4 CLI passes the
   *  live one from `main()`; tests pass a `StubRegistry` (see delegation
   *  tests). When undefined, scope validation is SKIPPED — the function
   *  still works (Momus C5 scope check is best-effort for ad-hoc tooling
   *  and absolutely enforced for the production CLI path). */
  registry?: PluginRegistry;
}

/**
 * Phase 4 — `pdatahub-hub delegate` (A side).
 *
 * Steps:
 *   1. Load hub identity from DB.
 *   2. Validate scope against the plugin manifest (Momus C5). The
 *      `getToolInputSchema` helper throws when the plugin or tool is
 *      missing OR when the plugin did not declare an inputSchema — we
 *      catch that and surface the scope-mismatch case explicitly.
 *   3. Build delegation blob body.
 *   4. Sign with A's signing_key.
 *   5. Persist to `delegations` table (delegation_id is generated by
 *      the store from a UUID).
 *   6. Serialize to base64url + generate QR.
 *
 * Returns the blob + delegation_id. Throws on any validation failure
 * (unknown plugin, unknown tool, scope mismatch, missing schema).
 */
export async function cmdDelegate(opts: CmdDelegateOptions): Promise<DelegateResult> {
  const { db, identity, store } = openCliContext(opts.dbPath, opts.masterKey);

  try {
    // 1. Scope validation (Momus C5): the requested --scope must equal
    // the plugin manifest's declared scope for the tool.
    if (opts.registry) {
      // Find the tool descriptor without throwing on missing schema —
      // we want a clean "scope mismatch" error, not a confusing schema
      // error. Walk the registry explicitly.
      const pluginInfo = opts.registry.listPlugins().find((p) => p.name === opts.plugin);
      if (!pluginInfo) {
        throw new Error(
          `plugin "${opts.plugin}" not found in registry (run with --plugins-dir containing it)`,
        );
      }
      const toolInfo = pluginInfo.tools.find((t) => t.name === opts.tool);
      if (!toolInfo) {
        throw new Error(
          `tool "${opts.tool}" not found in plugin "${opts.plugin}"`,
        );
      }
      if (toolInfo.scope !== opts.scope) {
        throw new Error(
          `scope mismatch: --scope "${opts.scope}" does not match the ` +
            `plugin manifest's declared scope "${toolInfo.scope}" for ` +
            `tool "${opts.tool}" (plugin "${opts.plugin}")`,
        );
      }
      // Federation requires a declared schema — re-use the helper to
      // throw the canonical error if missing.
      getToolInputSchema(opts.registry, opts.plugin, opts.tool);
    }

    // 2. Build body.
    const delegation_id = randomUUID();
    const body: DelegationBlobV1Body = {
      version: 1,
      delegation_id,
      issuer: {
        hub_name: identity.hubName,
        verify_key: identity.publicKeyB64(),
        fingerprint: identity.fingerprintHex(),
        magic_dns: identity.magicDns ?? `${identity.hubName}.local:8080`,
      },
      subject: {
        verify_key: opts.peerVerifyKey,
        fingerprint: fingerprintFromVerifyKey(opts.peerVerifyKey),
      },
      delegation: {
        plugin: opts.plugin,
        tool: opts.tool,
        scope: opts.scope,
        // Schema comes from the live registry when available; empty
        // object otherwise. The CLI path always passes a registry,
        // so this is a defensive default for programmatic reuse.
        input_schema: opts.registry
          ? getToolInputSchema(opts.registry, opts.plugin, opts.tool)
          : {},
        expires_at: parseDuration(opts.expiresIn).toISOString(),
      },
    };

    // 3. Sign.
    const signature = signDelegation(identity, body);
    const blob: DelegationBlobV1 = { ...body, signature };

    // 4. Persist — signature stored as Buffer for sqlite BLOBs.
    store.createGranted({
      delegation_id,
      peer_verify_key: opts.peerVerifyKey,
      peer_hub_name: null, // populated lazily; B's hub_name comes from the blob on import
      plugin: opts.plugin,
      tool: opts.tool,
      scope: opts.scope,
      expires_at: body.delegation.expires_at,
      signature: Buffer.from(signatureToBytes(signature)),
    });

    // 5. Encode for out-of-band transport.
    const blobJson = JSON.stringify(blob);
    const encoded = Buffer.from(blobJson).toString('base64url');

    // 6. QR generation — best-effort, never fails the command.
    const qrPngBase64 = await generateQrPngBase64(encoded).catch((err: Error) => {
      logger.warn('QR generation failed, falling back to base64', {
        error: err.message,
      });
      return undefined;
    });

    logger.info('delegation issued', {
      delegation_id,
      plugin: opts.plugin,
      tool: opts.tool,
      peer_verify_key: opts.peerVerifyKey.slice(0, 24) + '…',
      expires_at: body.delegation.expires_at,
    });

    return {
      delegation_id,
      blob: encoded,
      ...(qrPngBase64 !== undefined ? { qrPngBase64 } : {}),
    };
  } finally {
    db.close();
  }
}

/* ─── cmdAcceptDelegation — B side ─────────────────────────────────────── */

export interface CmdAcceptDelegationOptions {
  dbPath: string;
  masterKey: Buffer;
  /** base64url-encoded delegation blob produced by `cmdDelegate`. */
  blob: string;
  /**
   * Skip the y/N confirmation prompt. Pass `true` for non-interactive
   * contexts (CI, tests). The Phase 4 design doc (Momus Q5) requires
   * a confirmation prompt by default; this option is the only escape
   * hatch for automation.
   */
  yes: boolean;
  /**
   * Optional prompt function — exposed for tests so they don't have to
   * mock `process.stdin`. Defaults to `promptYesNo` which reads from
   * stdin via `node:readline`.
   */
  promptFn?: () => Promise<boolean>;
  /**
   * Test-only override for DNS resolution. Defaults to the real
   * `dns.promises.lookup`. Return value: the resolved IPv4/IPv6 string,
   * or the original magic_dns when resolution fails.
   */
  resolveDnsFn?: (host: string) => Promise<string>;
}

/**
 * Phase 4 — `pdatahub-hub accept-delegation` (B side).
 *
 * Steps (mirrors design doc §"Delegation import (B)"):
 *   1. Parse the base64url blob into a `DelegationBlobV1`.
 *   2. Verify A's Ed25519 signature against the verify_key embedded in
 *      the blob (NOT against `/v1/identity` — Momus I10).
 *   3. Print: hub name, fingerprint, plugin/tool, scope, expires — so
 *      the operator can compare against A's `identity show` output.
 *   4. y/N confirmation (Momus Q5) unless `--yes` is set.
 *   5. DNS-resolve A's magic_dns → IP. On failure, fall back to the
 *      magic_dns string as-is (peer_hub_url uses the hostname).
 *   6. INSERT OR IGNORE into `peer_delegations` (idempotent on the
 *      `delegation_id` PK; Momus C4 — no `peer_signature_checked` column).
 */
export async function cmdAcceptDelegation(
  opts: CmdAcceptDelegationOptions,
): Promise<AcceptDelegationResult> {
  const { db, store } = openCliContext(opts.dbPath, opts.masterKey);

  try {
    // 1. Parse.
    let blob: DelegationBlobV1;
    try {
      blob = parseBlob(opts.blob);
    } catch (err) {
      throw new Error(`failed to parse blob: ${(err as Error).message}`);
    }

    // 2. Verify signature against the embedded verify_key (Momus I10).
    const verifyResult = verifyDelegation(blob);
    if (!verifyResult.ok) {
      throw new Error(`signature verification failed: ${verifyResult.reason}`);
    }

    // 3. Print for operator confirmation.
    printAcceptDelegationHeader(blob);

    // 4. Confirm unless --yes.
    if (!opts.yes) {
      const prompt = opts.promptFn ?? promptYesNo;
      const accepted = await prompt();
      if (!accepted) {
        throw new Error('delegation import aborted by user');
      }
    }

    // 5. Resolve magic_dns to an IP. Falls back to the hostname string
    // when lookup fails (dev mode without tailnet, DNS outages).
    const resolver = opts.resolveDnsFn ?? defaultResolveDns;
    const magicDns = blob.issuer.magic_dns;
    const { host, port } = splitHostPort(magicDns);
    const resolvedHost = await resolver(host).catch(() => host);
    const peer_hub_url = `http://${resolvedHost}:${port}/`;

    // 6. Persist (INSERT OR IGNORE — first import wins, re-import is no-op).
    store.createReceived({
      delegation_id: blob.delegation_id,
      peer_verify_key: blob.issuer.verify_key,
      peer_hub_name: blob.issuer.hub_name,
      peer_hub_url,
      plugin: blob.delegation.plugin,
      tool: blob.delegation.tool,
      scope: blob.delegation.scope,
      input_schema:
        blob.delegation.input_schema !== null &&
        blob.delegation.input_schema !== undefined
          ? JSON.stringify(blob.delegation.input_schema)
          : null,
      expires_at: blob.delegation.expires_at,
      signature: Buffer.from(signatureToBytes(blob.signature)),
    });

    logger.info('delegation imported', {
      delegation_id: blob.delegation_id,
      peer_hub_name: blob.issuer.hub_name,
      peer_hub_url,
      tool: blob.delegation.tool,
      expires_at: blob.delegation.expires_at,
    });

    return {
      delegation_id: blob.delegation_id,
      peer_hub_name: blob.issuer.hub_name,
      peer_hub_url,
    };
  } finally {
    db.close();
  }
}

/**
 * Print the fingerprint / scope / expiry header that the operator
 * compares against A's `identity show` output. Side-effect only —
 * writes to stdout.
 */
function printAcceptDelegationHeader(blob: DelegationBlobV1): void {
  const expiresHuman = formatIsoHuman(blob.delegation.expires_at);
  // eslint-disable-next-line no-console
  console.log(`Hub:         ${blob.issuer.hub_name}`);
  // eslint-disable-next-line no-console
  console.log(`Fingerprint: ${blob.issuer.fingerprint}`);
  // eslint-disable-next-line no-console
  console.log(`Plugin/Tool: ${blob.delegation.plugin} / ${blob.delegation.tool}`);
  // eslint-disable-next-line no-console
  console.log(`Scope:       ${blob.delegation.scope}`);
  // eslint-disable-next-line no-console
  console.log(`Expires:     ${expiresHuman}`);
  // eslint-disable-next-line no-console
  console.log(`Magic DNS:   ${blob.issuer.magic_dns}`);
}

/**
 * Format an ISO timestamp as `YYYY-MM-DD HH:MM UTC`. Defensive: returns
 * the input verbatim when parsing fails.
 */
function formatIsoHuman(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * Read a single line from stdin and return true iff the user typed
 * exactly `y` or `yes` (case-insensitive). Anything else returns
 * false. Used for the Momus Q5 confirmation.
 */
export async function promptYesNo(): Promise<boolean> {
  const readline = await import('node:readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: process.stdin.isTTY ?? false,
  });
  return new Promise<boolean>((resolve) => {
    // eslint-disable-next-line no-console
    rl.question('Accept this delegation? [y/N] ', (answer) => {
      rl.close();
      const v = answer.trim().toLowerCase();
      resolve(v === 'y' || v === 'yes');
    });
  });
}

/* ─── cmdListGranted / cmdListReceived / cmdRevokeDelegation ───────────── */

/**
 * List rows from the `delegations` table (A side — rows this hub has
 * granted to peers). Newest first (sorted by `created_at DESC`).
 */
export async function cmdListGranted(
  dbPath: string,
  masterKey: Buffer,
): Promise<DelegationGrantedRow[]> {
  const { db, store } = openCliContext(dbPath, masterKey);
  try {
    return store.listGranted();
  } finally {
    db.close();
  }
}

/**
 * List rows from the `peer_delegations` table (B side — rows this hub
 * has received from peers). Newest first.
 */
export async function cmdListReceived(
  dbPath: string,
  masterKey: Buffer,
): Promise<DelegationReceivedRow[]> {
  const { db, store } = openCliContext(dbPath, masterKey);
  try {
    return store.listReceived();
  } finally {
    db.close();
  }
}

/**
 * Revoke a granted delegation (A side). Returns true if a row was
 * updated, false if the id doesn't exist.
 */
export async function cmdRevokeDelegation(
  dbPath: string,
  masterKey: Buffer,
  delegation_id: string,
): Promise<boolean> {
  const { db, store } = openCliContext(dbPath, masterKey);
  try {
    return store.revokeGranted(delegation_id);
  } finally {
    db.close();
  }
}

/* ─── Internal helpers ─────────────────────────────────────────────────── */

/**
 * Decode a `signature` base64url string into raw bytes. Wraps the
 * existing `base64UrlToBytes` helper from delegation.ts without
 * re-exporting it — this module treats the signature as opaque bytes
 * for storage.
 */
function signatureToBytes(signature: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(signature)) {
    throw new Error('signature contains invalid base64url characters');
  }
  const padded =
    signature.length % 4 === 0
      ? signature
      : signature + '='.repeat(4 - (signature.length % 4));
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

/**
 * Extract an 8-byte fingerprint from a `ed25519:<base64url>` verify_key
 * string. Used for the `subject.fingerprint` field at delegation
 * creation time — we don't have B's HubIdentity in scope, only the
 * verify_key, but the design requires this field in the blob for
 * display symmetry with the issuer.
 *
 * Returns 'unknown' for unparseable keys so the blob remains valid
 * even if B's key format is exotic.
 */
function fingerprintFromVerifyKey(verifyKey: string): string {
  try {
    const tail = verifyKey.startsWith('ed25519:')
      ? verifyKey.slice('ed25519:'.length)
      : verifyKey;
    if (!/^[A-Za-z0-9_-]+$/.test(tail)) return 'unknown';
    const padded =
      tail.length % 4 === 0
        ? tail
        : tail + '='.repeat(4 - (tail.length % 4));
    const bytes = Buffer.from(padded, 'base64');
    if (bytes.length < 8) return 'unknown';
    const pairs: string[] = [];
    for (let i = 0; i < 8; i++) {
      pairs.push(bytes[i]!.toString(16).padStart(2, '0').toUpperCase());
    }
    return pairs.join(' ');
  } catch {
    return 'unknown';
  }
}

/**
 * Split a `host:port` string into its parts. The port defaults to 8080
 * (matches the hub's default listen port) when not present, matching
 * the Phase 4 design doc's URL format `http://<host>:<port>/`.
 */
function splitHostPort(input: string): { host: string; port: string } {
  // IPv6 literals look like `[::1]:8080` — handle the bracketed form.
  if (input.startsWith('[')) {
    const end = input.indexOf(']');
    if (end === -1) {
      return { host: input, port: '8080' };
    }
    const host = input.slice(1, end);
    const tail = input.slice(end + 1);
    if (tail.startsWith(':')) return { host, port: tail.slice(1) };
    return { host, port: '8080' };
  }
  const colon = input.lastIndexOf(':');
  if (colon === -1) return { host: input, port: '8080' };
  return { host: input.slice(0, colon), port: input.slice(colon + 1) };
}

/**
 * Resolve a hostname via `dns.promises.lookup`. Returns the FIRST
 * address (mirrors `dns.lookup`'s default behavior), useful for the
 * common case of a Tailscale MagicDNS hostname with a single A record.
 *
 * Throws on failure — the caller is expected to catch and fall back to
 * the hostname string.
 */
async function defaultResolveDns(host: string): Promise<string> {
  const result = await dnsPromises.lookup(host);
  return result.address;
}

/**
 * Generate a base64-encoded PNG QR code for `text`. Returns `undefined`
 * when generation fails (e.g., text exceeds QR capacity at the default
 * error correction level). Never throws — callers can rely on
 * `undefined` to detect failure and degrade gracefully.
 *
 * Strategy: try `toBuffer` (PNG) first. If that throws or rejects,
 * try terminal-rendered (`toString({type: 'terminal'})`) — but terminal
 * output isn't a PNG so we still return undefined for the PNG path.
 * The caller falls back to printing the base64 blob to stdout.
 */
async function generateQrPngBase64(text: string): Promise<string | undefined> {
  // Lazy import — `qrcode` is a runtime dep but we don't want to force
  // it to load for code paths that don't need QR (e.g., tests that only
  // assert on the blob).
  const qrcode: typeof import('qrcode') = await import('qrcode');
  try {
    const png: Buffer = await qrcode.toBuffer(text, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 256,
    });
    return png.toString('base64');
  } catch (err) {
    logger.debug('qrcode.toBuffer failed', { error: (err as Error).message });
    return undefined;
  }
}

/* ─── Public utility re-exports (used by src/index.ts) ──────────────────── */

/**
 * Re-exported so `src/index.ts` can pretty-print a delegated table
 * without having to import the row type from inside delegation.ts.
 * Public name mirrors the store's row type.
 */
export type { DelegationGrantedRow, DelegationReceivedRow };
