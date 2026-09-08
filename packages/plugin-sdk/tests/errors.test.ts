import { describe, it, expect } from 'vitest';
import {
  PluginError,
  AuthError,
  AuthExpiredError,
  ScopeError,
  NetworkError,
  ValidationError,
  TimeoutError,
  NotFoundError,
  RateLimitError,
  type PluginErrorPayload,
} from '../src/errors.js';

describe('PluginError', () => {
  it('stores code, retryable, details, and sets name to constructor name', () => {
    const err = new PluginError('CUSTOM', 'something went wrong', true, {
      foo: 'bar',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PluginError);
    expect(err.code).toBe('CUSTOM');
    expect(err.retryable).toBe(true);
    expect(err.details).toEqual({ foo: 'bar' });
    expect(err.message).toBe('something went wrong');
    expect(err.name).toBe('PluginError');
  });

  it('toJSON() produces the canonical payload shape', () => {
    const err = new PluginError('CUSTOM', 'msg', false, { a: 1 });
    const json = err.toJSON();
    expect(json.name).toBe('PluginError');
    expect(json.code).toBe('CUSTOM');
    expect(json.message).toBe('msg');
    expect(json.retryable).toBe(false);
    expect(json.details).toEqual({ a: 1 });
    expect(typeof json.stack).toBe('string');
    const typed: PluginErrorPayload = json;
    expect(typed.code).toBe('CUSTOM');
  });
});

describe('AuthError', () => {
  it('uses code AUTH_FAILED and is not retryable', () => {
    const err = new AuthError('bad creds');
    expect(err.code).toBe('AUTH_FAILED');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('bad creds');
    expect(err.name).toBe('AuthError');
    expect(err).toBeInstanceOf(PluginError);
  });

  it('preserves optional details', () => {
    const err = new AuthError('forbidden', { reason: 'role' });
    expect(err.details).toEqual({ reason: 'role' });
  });
});

describe('AuthExpiredError', () => {
  it('uses code AUTH_EXPIRED and is retryable', () => {
    const err = new AuthExpiredError();
    expect(err.code).toBe('AUTH_EXPIRED');
    expect(err.retryable).toBe(true);
    expect(err.name).toBe('AuthExpiredError');
  });

  it('stores expiresAt as ISO string in details when provided', () => {
    const when = new Date('2026-09-08T10:00:00Z');
    const err = new AuthExpiredError(when);
    expect(err.expiresAt).toBe(when);
    expect(err.details).toEqual({ expiresAt: '2026-09-08T10:00:00.000Z' });
  });

  it('handles missing expiresAt (undefined)', () => {
    const err = new AuthExpiredError();
    expect(err.expiresAt).toBeUndefined();
    expect(err.details).toEqual({ expiresAt: undefined });
  });
});

describe('ScopeError', () => {
  it('stores requiredScope and grantedScopes', () => {
    const err = new ScopeError('messages.write', ['messages.read']);
    expect(err.code).toBe('SCOPE_MISSING');
    expect(err.retryable).toBe(false);
    expect(err.requiredScope).toBe('messages.write');
    expect(err.grantedScopes).toEqual(['messages.read']);
    expect(err.message).toContain('messages.write');
    expect(err.message).toContain('messages.read');
  });

  it('handles multiple granted scopes', () => {
    const err = new ScopeError('admin', ['read', 'write', 'delete']);
    expect(err.grantedScopes).toHaveLength(3);
    expect(err.details).toEqual({
      requiredScope: 'admin',
      grantedScopes: ['read', 'write', 'delete'],
    });
  });

  it('handles empty granted scopes', () => {
    const err = new ScopeError('anything', []);
    expect(err.grantedScopes).toEqual([]);
    expect(err.message).toContain('only granted: ');
  });
});

describe('NetworkError', () => {
  it('uses code NETWORK_ERROR and is retryable', () => {
    const err = new NetworkError('connection refused');
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.retryable).toBe(true);
    expect(err.cause).toBeUndefined();
  });

  it('wraps a cause and stores its name in details', () => {
    const inner = new TypeError('ECONNRESET');
    const err = new NetworkError('upstream dropped', inner);
    expect(err.cause).toBe(inner);
    expect(err.details).toEqual({ causeName: 'TypeError' });
  });
});

describe('ValidationError', () => {
  it('stores field, value, constraint and is not retryable', () => {
    const err = new ValidationError('channel', 42, 'must be string');
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.retryable).toBe(false);
    expect(err.field).toBe('channel');
    expect(err.value).toBe(42);
    expect(err.constraint).toBe('must be string');
    expect(err.message).toContain('channel');
    expect(err.message).toContain('must be string');
  });

  it('handles nested field path', () => {
    const err = new ValidationError('address.street', undefined, 'required');
    expect(err.field).toBe('address.street');
    expect(err.details).toEqual({
      field: 'address.street',
      value: undefined,
      constraint: 'required',
    });
  });
});

describe('TimeoutError', () => {
  it('stores timeoutMs and operation, retryable', () => {
    const err = new TimeoutError(5000, 'listMessages');
    expect(err.code).toBe('TIMEOUT');
    expect(err.retryable).toBe(true);
    expect(err.timeoutMs).toBe(5000);
    expect(err.operation).toBe('listMessages');
    expect(err.message).toContain('listMessages');
    expect(err.message).toContain('5000');
  });
});

describe('NotFoundError', () => {
  it('stores resourceType and resourceId, not retryable', () => {
    const err = new NotFoundError('message', 'abc123');
    expect(err.code).toBe('NOT_FOUND');
    expect(err.retryable).toBe(false);
    expect(err.resourceType).toBe('message');
    expect(err.resourceId).toBe('abc123');
    expect(err.message).toContain('message');
    expect(err.message).toContain('abc123');
  });
});

describe('RateLimitError', () => {
  it('uses code RATE_LIMITED and is retryable', () => {
    const err = new RateLimitError();
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryable).toBe(true);
    expect(err.name).toBe('RateLimitError');
  });

  it('stores retryAfterMs when provided', () => {
    const err = new RateLimitError(2000);
    expect(err.retryAfterMs).toBe(2000);
    expect(err.message).toContain('2000');
    expect(err.details).toEqual({ retryAfterMs: 2000 });
  });
});

describe('error chaining & instanceof checks', () => {
  it('all subclasses are instanceof PluginError and Error', () => {
    const all = [
      new AuthError('x'),
      new AuthExpiredError(),
      new ScopeError('s', []),
      new NetworkError('x'),
      new ValidationError('f', 0, 'c'),
      new TimeoutError(1, 'o'),
      new NotFoundError('r', 'i'),
      new RateLimitError(),
    ];
    for (const err of all) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(PluginError);
    }
  });

  it('preserves cause across the chain (NetworkError wrapping a Node error)', () => {
    const inner = new Error('ECONNREFUSED 127.0.0.1:443');
    inner.name = 'Error';
    const outer = new NetworkError('request failed', inner);
    expect(outer.cause).toBe(inner);
    expect((outer.cause as Error).message).toBe('ECONNREFUSED 127.0.0.1:443');
  });

  it('toJSON round-trips the essential fields', () => {
    const err = new ValidationError('foo', null, 'must be defined');
    const json = err.toJSON();
    expect(json.code).toBe('VALIDATION_FAILED');
    expect(json.retryable).toBe(false);
    expect(json.details).toEqual({ field: 'foo', value: null, constraint: 'must be defined' });
  });
});