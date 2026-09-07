/**
 * Startup checks for hub-core.
 *
 * Phase 0.5 (federation v2) — refuses to start when `HUB_API_TOKEN` is
 * unset on a non-loopback bind, because that combination is the wireguard /
 * tailnet deployment surface and historically has allowed unauthenticated
 * access to every `/v1/*` route. With federation, any unauthenticated
 * `/v1/federation/call` would be an instant data-leak primitive, so the
 * hub must fail closed on startup instead.
 *
 * Local development (bind to 127.0.0.1 / ::1 / localhost) keeps the previous
 * "open access" behavior because there is no remote attack surface.
 */

import { logger } from './logger.js';

/**
 * Hosts considered "loopback" — no remote reachability, dev mode preserved.
 * `localhost` is included because Node's `dns.lookup` and OS resolver chains
 * commonly resolve it to 127.0.0.1, and many dev tools bind it literally.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** True iff `host` is a loopback address (no remote reachability). */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * Assert that the hub either has an API token configured OR is bound to a
 * loopback interface (dev mode). Throws with a clear, actionable message
 * otherwise.
 *
 * Must be called BEFORE the HTTP server starts listening so the process
 * exits cleanly with a useful error rather than booting an unauthenticated
 * server that binds a remote-reachable port.
 *
 * Accepts `host` and `apiToken` as separate arguments (rather than reading
 * `process.env` / config directly) so this is a pure function, trivially
 * unit-testable.
 */
export function checkHubApiTokenRequirement(
  host: string,
  apiToken: string | undefined,
): void {
  if (apiToken && apiToken.length > 0) return;
  if (isLoopbackHost(host)) {
    logger.warn(
      'HUB_API_TOKEN not set and bound to loopback — running in dev mode (no auth on /v1/*)',
    );
    return;
  }
  throw new Error(
    'HUB_API_TOKEN must be set when binding to a non-loopback interface. ' +
      'For local development only, bind to 127.0.0.1, ::1, or localhost.',
  );
}