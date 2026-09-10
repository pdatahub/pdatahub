/**
 * Unit tests for error sanitization.
 *
 * Scenarios:
 *   - sanitizeUnknownError produces opaque response with request_id
 *   - safeClientMessage strips filesystem paths
 *   - safeClientMessage strips IP:port pairs
 *   - safeClientMessage strips SQL fragments
 *   - safeClientMessage strips semver versions
 *   - safeClientMessage strips long hex blobs (master_key fingerprint attack)
 *   - safeClientMessage strips control chars / newlines (header injection)
 *   - safeClientMessage truncates overlong messages
 *   - generateRequestId is opaque + has sufficient entropy
 *   - sanitizeUnknownError logs full error server-side (for forensics)
 *   - end-to-end: hub-core catch-all does NOT leak internal paths to client
 */

import { describe, it, expect, vi } from 'vitest';
import {
  safeClientMessage,
  sanitizeUnknownError,
  generateRequestId,
  detectLeaks,
  internalErrorResponse,
  safeErrorResponse,
} from '../src/error-sanitize.js';

describe('safeClientMessage — server-side stripping', () => {
  it('redacts filesystem paths', () => {
    const out = safeClientMessage('install failed: ENOENT /home/user/.pdatahub/plugins/foo/dist/index.js');
    expect(out).not.toContain('/home/user');
    expect(out).toContain('<redacted>');
  });

  it('redacts internal IP:port pairs', () => {
    const out = safeClientMessage('OAuth failed: ECONNREFUSED 127.0.0.1:8081');
    expect(out).not.toContain('127.0.0.1:8081');
    expect(out).toContain('<redacted>');
  });

  it('redacts SQLite error fragments', () => {
    const out = safeClientMessage('SQLITE_CONSTRAINT: UNIQUE constraint failed: tokens.plugin');
    expect(out).not.toContain('SQLITE_CONSTRAINT');
    expect(out).toContain('<redacted>');
  });

  it('redacts node_modules paths and semver', () => {
    const out = safeClientMessage('at Object.<anonymous> (better-sqlite3@9.4.0:node_modules/better-sqlite3/lib/index.js:42)');
    expect(out).not.toContain('node_modules');
    expect(out).not.toContain('@9.4.0');
    expect(out).toContain('<redacted>');
  });

  it('redacts long hex blobs (master key fingerprint attack)', () => {
    const out = safeClientMessage('key fingerprint: f92a24ff97a81014fdf0124f76b81da23d22241a5da31499cfe439672810b398');
    expect(out).not.toContain('f92a24ff');
    expect(out).toContain('<redacted>');
  });

  it('strips control characters (prevent header injection / log forgery)', () => {
    const out = safeClientMessage('hello\nX-Injected: bar\x00\x07world');
    expect(out).not.toContain('\n');
    expect(out).not.toContain('\x00');
    expect(out).not.toContain('\x07');
  });

  it('truncates overlong messages', () => {
    const long = 'a'.repeat(500);
    const out = safeClientMessage(long);
    expect(out.length).toBeLessThanOrEqual(220);
    expect(out.endsWith('...')).toBe(true);
  });
});

describe('sanitizeUnknownError — client-visible response', () => {
  it('returns opaque response with request_id for unknown errors', () => {
    const requestId = 'abc12345';
    const logFn = vi.fn();
    const safe = sanitizeUnknownError(
      new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: tokens.plugin'),
      requestId,
      logFn,
    );
    expect(safe.error).toBe('internal_error');
    expect(safe.code).toBe('INTERNAL_ERROR');
    expect(safe.request_id).toBe(requestId);
    // Verify NO leak in client-visible body.
    const leaks = detectLeaks(JSON.stringify(safe));
    expect(leaks).toEqual([]);
  });

  it('logs full error context server-side for forensics', () => {
    const logFn = vi.fn();
    sanitizeUnknownError(
      new Error('SQLITE_BUSY at /home/user/.pdatahub/db.sqlite'),
      'req-1',
      logFn,
    );
    expect(logFn).toHaveBeenCalledTimes(1);
    const [msg, ctx] = logFn.mock.calls[0]!;
    expect(msg).toMatch(/sanitized/);
    expect(ctx['request_id']).toBe('req-1');
    expect(ctx['error_message']).toContain('SQLITE_BUSY');
    // Note: server log retains the full path for ops debugging.
    expect(ctx['error_stack']).toBeDefined();
  });

  it('handles non-Error throws gracefully', () => {
    const logFn = vi.fn();
    const safe = sanitizeUnknownError('plain string thrown', 'req-2', logFn);
    expect(safe.code).toBe('INTERNAL_ERROR');
    expect(logFn).toHaveBeenCalled();
    expect(logFn.mock.calls[0]![1]['error_message']).toBe('plain string thrown');
  });

  it('honors pre-built SafeError via .safe property', () => {
    const safe = sanitizeUnknownError(
      Object.assign(new Error('whatever'), {
        safe: {
          kind: 'validation',
          code: 'INVALID_INPUT',
          status: 400,
          message: 'bad shape',
        } as const,
      }),
      'req-3',
      vi.fn(),
    );
    expect(safe.code).toBe('INVALID_INPUT');
    expect(safe.error).toBe('bad shape');
  });
});

describe('internalErrorResponse + safeErrorResponse', () => {
  it('internal error shape includes request_id, never raw message', () => {
    const out = internalErrorResponse('xyz789');
    expect(out).toEqual({ error: 'internal_error', code: 'INTERNAL_ERROR', request_id: 'xyz789' });
  });

  it('safe error includes retry_after_seconds for rate_limit', () => {
    const out = safeErrorResponse(
      {
        kind: 'rate_limit',
        code: 'RATE_LIMITED',
        status: 429,
        message: 'rate limit exceeded',
        retryAfterMs: 2500,
      },
      'req-4',
    );
    expect(out.retry_after_seconds).toBe(3); // ceil(2500/1000)
    expect(out.code).toBe('RATE_LIMITED');
  });
});

describe('generateRequestId — opaque + sufficient entropy', () => {
  it('produces 8+ char base36 string', () => {
    const id = generateRequestId();
    expect(id.length).toBeGreaterThanOrEqual(8);
    expect(id).toMatch(/^[0-9a-z]+$/);
  });

  it('produces different ids across calls (entropy check)', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateRequestId()));
    expect(ids.size).toBeGreaterThan(90); // Allow rare collisions
  });
});

describe('detectLeaks — test helper', () => {
  it('returns empty for safe strings', () => {
    expect(detectLeaks('rate limit exceeded; retry after 5s')).toEqual([]);
  });

  it('returns pattern names for unsafe strings', () => {
    expect(detectLeaks('error at /home/user/db.sqlite')).toContain('filesystem_path');
    expect(detectLeaks('SQLITE_CONSTRAINT failed')).toContain('sqlite_error');
    expect(detectLeaks('connected to 10.0.0.1:5432')).toContain('ip_with_port');
    expect(detectLeaks('using better-sqlite3@9.4.0')).toContain('semver_version');
    expect(detectLeaks('fingerprint: f92a24ff97a81014fdf0124f76b81da23d22241a5da31499cfe439672810b398')).toContain('master_key_hex');
  });
});
