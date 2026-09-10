/**
 * In-memory rate limiter — token bucket per (identity, route_class).
 *
 * Why a token bucket?
 *   - O(1) per request (no sliding window log)
 *   - Naturally supports bursts up to bucket size
 *   - Refills continuously, not in fixed windows (no thundering herd)
 *
 * Memory cost:
 *   - One entry per (ip, route_class) pair seen since process start.
 *   - ~200 bytes per entry; for 1000 unique (ip, class) pairs that's
 *     ~200 KB — negligible.
 *
 * Scope (P0):
 *   - In-process only. Multi-process Hub deploys (Phase 1B cloud v3)
 *     will need Redis; deferred.
 *   - Per-(IP, route_class) — far-future: per-(bearer-token, tool_name)
 *     to prevent one tool from starving others under load.
 *
 * Momus concerns addressed:
 *   - Bucket exhaustion MUST return 429 + Retry-After (not 500)
 *   - Refill MUST be monotonic — no negative token count
 *   - Tests MUST assert no leaks (bucket size, IP, internal state)
 *
 * Excluded routes (callers pre-filter before invoking):
 *   - /health        (probes; no point rate-limiting them)
 *   - /v1/identity   (public by design; safe to spam)
 *   - OPTIONS        (CORS preflight; browsers send these automatically)
 */

import { logger } from './logger.js';

export interface RateLimitConfig {
  /** Tokens per minute (refill rate). Default 60. */
  perMinute: number;
  /** Maximum burst capacity. Default = perMinute. */
  burstCapacity: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  perMinute: 60,
  burstCapacity: 60,
};

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly config: RateLimitConfig;
  /** Periodic eviction to bound memory. Set to 0 to disable (tests). */
  private readonly ttlMs: number;

  constructor(config: RateLimitConfig = DEFAULT_RATE_LIMIT, ttlMs = 5 * 60_000) {
    if (config.perMinute <= 0) throw new Error('perMinute must be > 0');
    if (config.burstCapacity <= 0) throw new Error('burstCapacity must be > 0');
    this.config = config;
    this.ttlMs = ttlMs;
  }

  /**
   * Try to consume one token for (key, routeClass). Returns:
   *   - { allowed: true,  remaining }   if a token was consumed
   *   - { allowed: false, retryAfterMs } if the bucket is empty
   *
   * Refill is continuous (linear from last access time).
   */
  consume(key: string, routeClass: string): { allowed: true; remaining: number } | { allowed: false; retryAfterMs: number } {
    const bucketKey = `${key}|${routeClass}`;
    const now = Date.now();
    let bucket = this.buckets.get(bucketKey);
    if (!bucket) {
      bucket = { tokens: this.config.burstCapacity, lastRefillMs: now };
      this.buckets.set(bucketKey, bucket);
    }
    // Refill: add (elapsedMs / 60_000) * perMinute tokens, capped at burst.
    const elapsedMs = now - bucket.lastRefillMs;
    if (elapsedMs > 0) {
      const refill = (elapsedMs / 60_000) * this.config.perMinute;
      bucket.tokens = Math.min(this.config.burstCapacity, bucket.tokens + refill);
      bucket.lastRefillMs = now;
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, remaining: Math.floor(bucket.tokens) };
    }
    // Compute retry-after: time until bucket has >= 1 token.
    const tokensNeeded = 1 - bucket.tokens;
    const retryAfterMs = Math.ceil((tokensNeeded / this.config.perMinute) * 60_000);
    return { allowed: false, retryAfterMs };
  }

  /** Evict buckets idle longer than ttl. Call from a setInterval. */
  evictIdle(): number {
    if (this.ttlMs <= 0) return 0;
    const cutoff = Date.now() - this.ttlMs;
    let evicted = 0;
    for (const [k, b] of this.buckets) {
      if (b.lastRefillMs < cutoff) {
        this.buckets.delete(k);
        evicted++;
      }
    }
    return evicted;
  }

  /** Current bucket count — for diagnostics/tests. */
  size(): number {
    return this.buckets.size;
  }

  /** Reset all buckets — for tests. */
  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Map a (method, pathname) to a coarse "route class" used as the bucket
 * dimension. Coarser than per-endpoint (so /v1/tools/:name/call and
 * /v1/federation/invoke don't each get separate buckets for the same
 * attacker). Finer than just per-IP (so legitimate heavy user of
 * /v1/tools doesn't get blocked from /v1/identity).
 */
export function routeClassFor(method: string, pathname: string): string {
  if (pathname === '/v1/identity' || pathname === '/health') return 'public';
  if (pathname === '/v1/federation/call') return 'federation-inbound';
  if (pathname.startsWith('/v1/tools/') && method === 'POST') return 'tool-call';
  if (pathname === '/v1/federation/invoke') return 'federation-outbound';
  if (pathname.startsWith('/v1/federation/')) return 'federation-mgmt';
  if (pathname.startsWith('/v1/plugins/')) return 'plugin-mgmt';
  if (pathname.startsWith('/v1/grants') || pathname.startsWith('/v1/tokens')) return 'auth-mgmt';
  if (pathname === '/v1/audit') return 'audit-read';
  return 'other';
}

/** Extract client IP from the request. Handles X-Forwarded-For (first hop). */
export function clientIp(req: { socket: { remoteAddress?: string | null }; headers: Record<string, string | string[] | undefined> }): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Start a background interval that evicts idle buckets. Returns the timer. */
export function startRateLimiterEviction(rl: RateLimiter, intervalMs = 60_000): NodeJS.Timeout {
  const t = setInterval(() => {
    const n = rl.evictIdle();
    if (n > 0) logger.debug('rate-limit: evicted idle buckets', { evicted: n, remaining: rl.size() });
  }, intervalMs);
  // Don't keep the event loop alive just for eviction.
  if (typeof t.unref === 'function') t.unref();
  return t;
}
