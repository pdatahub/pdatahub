/**
 * Unit tests for the in-memory rate limiter.
 *
 * Scenarios:
 *   - allows first N requests (burst capacity)
 *   - returns 429 + retry_after_seconds on exhaustion
 *   - refills tokens linearly over time
 *   - per-(IP, route_class) isolation (one spammer doesn't starve others)
 *   - eviction bounds memory
 *   - safeClientMessage strips leaks (filesystem, IP:port, semver, hex)
 */

import { describe, it, expect } from 'vitest';
import {
  RateLimiter,
  DEFAULT_RATE_LIMIT,
  routeClassFor,
  clientIp,
} from '../src/rate-limit.js';

describe('RateLimiter — token bucket mechanics', () => {
  it('allows burst up to capacity, then 429 with retry-after', () => {
    const rl = new RateLimiter({ perMinute: 60, burstCapacity: 3 });
    // First 3 consume succeeds.
    for (let i = 0; i < 3; i++) {
      const r = rl.consume('1.2.3.4', 'tool-call');
      expect(r.allowed).toBe(true);
      if (r.allowed) {
        expect(r.remaining).toBeGreaterThanOrEqual(0);
      }
    }
    // 4th hits empty bucket.
    const fourth = rl.consume('1.2.3.4', 'tool-call');
    expect(fourth.allowed).toBe(false);
    if (!fourth.allowed) {
      // 1 token @ 60/min = 1s. Allow a generous upper bound for CI jitter.
      expect(fourth.retryAfterMs).toBeGreaterThan(0);
      expect(fourth.retryAfterMs).toBeLessThanOrEqual(1500);
    }
  });

  it('refills tokens linearly over time', async () => {
    // 60/min = 1 token/sec. Burst 1.
    const rl = new RateLimiter({ perMinute: 60, burstCapacity: 1 });
    const first = rl.consume('ip', 'x');
    expect(first.allowed).toBe(true);
    const second = rl.consume('ip', 'x');
    expect(second.allowed).toBe(false);
    // Wait > 1s for refill.
    await new Promise((r) => setTimeout(r, 1100));
    const third = rl.consume('ip', 'x');
    expect(third.allowed).toBe(true);
  });

  it('isolates buckets per (IP, route_class)', () => {
    const rl = new RateLimiter({ perMinute: 60, burstCapacity: 2 });
    // Exhaust IP A on tool-call.
    expect(rl.consume('a', 'tool-call').allowed).toBe(true);
    expect(rl.consume('a', 'tool-call').allowed).toBe(true);
    expect(rl.consume('a', 'tool-call').allowed).toBe(false);
    // IP B on same route has its own bucket.
    expect(rl.consume('b', 'tool-call').allowed).toBe(true);
    // IP A on different route has its own bucket.
    expect(rl.consume('a', 'plugin-mgmt').allowed).toBe(true);
  });

  it('caps refill at burstCapacity (no infinite bucket growth)', { timeout: 10_000 }, async () => {
    // 600/min = 10 tokens/sec. Burst 3.
    const rl = new RateLimiter({ perMinute: 600, burstCapacity: 3 });
    // Consume once.
    rl.consume('ip', 'x');
    // Idle for 1.5s → would refill 15 tokens at 10/s, capped at 3.
    await new Promise((r) => setTimeout(r, 1_500));
    // Should have 3 tokens (burst cap), so 3 more consumes succeed, 4th fails.
    expect(rl.consume('ip', 'x').allowed).toBe(true);
    expect(rl.consume('ip', 'x').allowed).toBe(true);
    expect(rl.consume('ip', 'x').allowed).toBe(true);
    expect(rl.consume('ip', 'x').allowed).toBe(false);
  });

  it('eviction removes idle buckets', async () => {
    const rl = new RateLimiter({ perMinute: 60, burstCapacity: 5 }, 50);
    rl.consume('a', 'x');
    rl.consume('b', 'y');
    expect(rl.size()).toBe(2);
    await new Promise((r) => setTimeout(r, 100));
    const evicted = rl.evictIdle();
    expect(evicted).toBe(2);
    expect(rl.size()).toBe(0);
  });

  it('rejects invalid config', () => {
    expect(() => new RateLimiter({ perMinute: 0, burstCapacity: 1 })).toThrow();
    expect(() => new RateLimiter({ perMinute: 60, burstCapacity: 0 })).toThrow();
  });

  it('DEFAULT_RATE_LIMIT is 60 req/min', () => {
    expect(DEFAULT_RATE_LIMIT.perMinute).toBe(60);
    expect(DEFAULT_RATE_LIMIT.burstCapacity).toBe(60);
  });
});

describe('routeClassFor — bucket dimension', () => {
  it('classifies public endpoints as "public"', () => {
    expect(routeClassFor('GET', '/health')).toBe('public');
    expect(routeClassFor('GET', '/v1/identity')).toBe('public');
  });

  it('classifies tool calls separately from federation', () => {
    expect(routeClassFor('POST', '/v1/tools/listEvents/call')).toBe('tool-call');
    expect(routeClassFor('POST', '/v1/federation/call')).toBe('federation-inbound');
    expect(routeClassFor('POST', '/v1/federation/invoke')).toBe('federation-outbound');
    expect(routeClassFor('POST', '/v1/federation/delegate')).toBe('federation-mgmt');
    expect(routeClassFor('GET', '/v1/federation/delegations')).toBe('federation-mgmt');
  });

  it('classifies plugin management separately', () => {
    expect(routeClassFor('POST', '/v1/plugins/install')).toBe('plugin-mgmt');
    expect(routeClassFor('POST', '/v1/plugins/foo/authenticate')).toBe('plugin-mgmt');
  });
});

describe('clientIp — X-Forwarded-For handling', () => {
  it('firsts XFF hop when present', () => {
    expect(clientIp({
      socket: { remoteAddress: '127.0.0.1' },
      headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1, 10.0.0.2' },
    })).toBe('203.0.113.5');
  });

  it('falls back to socket.remoteAddress when no XFF', () => {
    expect(clientIp({
      socket: { remoteAddress: '127.0.0.1' },
      headers: {},
    })).toBe('127.0.0.1');
  });

  it('returns "unknown" when nothing available', () => {
    expect(clientIp({
      socket: { remoteAddress: null },
      headers: {},
    })).toBe('unknown');
  });
});
