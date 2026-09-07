/**
 * Magic DNS detection — Phase 1 federation.
 *
 * Detects this hub's `*.ts.net` hostname from `tailscale status --json`,
 * format `<MagicDNSName>:<port>`. Returns `null` on any failure (no
 * tailscale, no internet, parse error, timeout) — federation must work
 * without tailscale (dev mode, port-forward to localhost, etc.).
 *
 * Implementation uses `child_process.spawnSync` with a 2-second timeout.
 * The runner is exposed as a mutable module-level function so tests can
 * inject a stub via `_setTailscaleRunnerForTests`.
 */

import { spawnSync } from 'node:child_process';
import { logger } from '../logger.js';

const TAILSCALE_TIMEOUT_MS = 2_000;
const DEFAULT_PORT = 8080;

export interface TailscalePeer {
  HostName?: string;
  MagicDNSName?: string;
  Name?: string;
  OS?: string;
  TailscaleIPs?: string[];
  Online?: boolean;
  UserID?: number;
  NodeID?: string;
}

export interface TailscaleStatusPayload {
  MagicDNSSuffix?: string;
  SelfNodeID?: string;
  Node?: TailscalePeer;
  Peer?: Record<string, TailscalePeer>;
  User?: Record<string, unknown>;
}

/**
 * Result of a `tailscale status --json` invocation. `ok=false` means the
 * caller should return `null` from `detectMagicDns`. The error reason is
 * logged at debug level but never propagates to the caller.
 */
export interface TailscaleStatusResult {
  ok: boolean;
  payload?: TailscaleStatusPayload;
  reason?: string;
}

function defaultTailscaleRunner(): TailscaleStatusResult {
  const res = spawnSync('tailscale', ['status', '--json'], {
    timeout: TAILSCALE_TIMEOUT_MS,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.error) {
    return { ok: false, reason: `spawn failed: ${res.error.message}` };
  }
  if (res.status !== 0) {
    return {
      ok: false,
      reason: `tailscale exited ${res.status}: ${(res.stderr ?? '').slice(0, 200)}`,
    };
  }
  const out = res.stdout ?? '';
  if (!out.trim()) {
    return { ok: false, reason: 'empty tailscale output' };
  }
  try {
    const payload = JSON.parse(out) as TailscaleStatusPayload;
    return { ok: true, payload };
  } catch (err) {
    return { ok: false, reason: `invalid JSON: ${(err as Error).message}` };
  }
}

let _tailscaleRunner: () => TailscaleStatusResult = defaultTailscaleRunner;

/** Test-only override. Production code MUST NOT call this. */
export function _setTailscaleRunnerForTests(
  fn: (() => TailscaleStatusResult) | null,
): void {
  _tailscaleRunner = fn ?? defaultTailscaleRunner;
}

/**
 * Detect this hub's Magic DNS name. Format: `<host>.<suffix>:<port>`.
 * Prefers `SelfNode.MagicDNSName` (canonical for this device), falls back
 * to `SelfNode.HostName` + `MagicDNSSuffix` (some tailscale setups), and
 * finally `SelfNode.Name` (user-defined label, only if no suffix).
 */
export function detectMagicDns(port = DEFAULT_PORT): string | null {
  let result: TailscaleStatusResult;
  try {
    result = _tailscaleRunner();
  } catch (err) {
    logger.debug('magic DNS detection runner threw', { error: (err as Error).message });
    return null;
  }
  if (!result.ok || !result.payload) {
    logger.debug('magic DNS detection skipped', { reason: result.reason ?? 'unknown' });
    return null;
  }
  const payload = result.payload;
  const suffix = payload.MagicDNSSuffix ?? '';
  const selfNode = payload.Node;

  let name: string | undefined;
  if (selfNode?.MagicDNSName) {
    name = selfNode.MagicDNSName.replace(`.${suffix}`, '');
  } else if (selfNode?.HostName && suffix) {
    name = selfNode.HostName;
  } else if (selfNode?.Name) {
    name = selfNode.Name;
    if (suffix && !name.endsWith(`.${suffix}`)) {
      name = `${name}.${suffix}`;
    }
  }

  if (!name) {
    logger.debug('magic DNS detection: no host name found in tailscale status');
    return null;
  }

  const fqdn = name.includes('.') || !suffix ? name : `${name}.${suffix}`;
  return `${fqdn}:${port}`;
}
