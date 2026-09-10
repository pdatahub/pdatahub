/**
 * Unit tests for FederationHttpClient.
 *
 * Uses undici's `MockAgent` to intercept HTTP requests without binding
 * to a real port. Tests cover:
 *   - Bearer token injection
 *   - Correct endpoint routing for delegate / list / revoke / accept
 *   - Error response parsing (FederationHttpError carries hub's request_id)
 *   - Non-JSON body handling
 *   - Health probe (/health, no auth)
 *   - Hub URL normalization (trailing slash)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import {
  FederationHttpClient,
  FederationHttpError,
  resolveHubUrl,
  resolveApiToken,
} from '../src/federation/federation-http.js';

describe('FederationHttpClient', () => {
  let mockAgent: MockAgent;
  let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    await mockAgent.close();
    setGlobalDispatcher(originalDispatcher);
  });

  it('injects bearer token and routes POST /v1/federation/delegate', async () => {
    const mockPool = mockAgent.get('http://127.0.0.1:8080');
    mockPool.intercept({
      method: 'POST',
      path: '/v1/federation/delegate',
      headers: { authorization: 'Bearer test-token-abc' },
    }).reply(200, {
      delegation_id: 'del-1',
      blob: 'base64-blob-here',
      issuer: 'ed25519:Q57eg1Nre...',
    });

    const client = new FederationHttpClient({
      baseUrl: 'http://127.0.0.1:8080',
      apiToken: 'test-token-abc',
    });
    const result = await client.delegate({
      peer_verify_key: 'ed25519:peer...',
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
      expires_in: '24h',
    });

    expect(result.delegation_id).toBe('del-1');
    expect(result.blob).toBe('base64-blob-here');
    expect(result.issuer).toMatch(/^ed25519:/);
  });

  it('routes GET /v1/federation/delegations (no body sent)', async () => {
    const mockPool = mockAgent.get('http://127.0.0.1:8080');
    mockPool.intercept({
      method: 'GET',
      path: '/v1/federation/delegations',
    }).reply(200, { granted: [], received: [] });

    const client = new FederationHttpClient({
      baseUrl: 'http://127.0.0.1:8080',
      apiToken: 'tok',
    });
    const result = await client.listDelegations();
    expect(result.granted).toEqual([]);
    expect(result.received).toEqual([]);
  });

  it('routes POST /v1/federation/delegations/:id/revoke with URL encoding', async () => {
    const mockPool = mockAgent.get('http://127.0.0.1:8080');
    mockPool.intercept({
      method: 'POST',
      path: '/v1/federation/delegations/del-with-special%2Fchars/revoke',
    }).reply(200, { revoked: true, delegation_id: 'del-with-special/chars' });

    const client = new FederationHttpClient({
      baseUrl: 'http://127.0.0.1:8080',
      apiToken: 'tok',
    });
    const result = await client.revokeDelegation('del-with-special/chars');
    expect(result.revoked).toBe(true);
    expect(result.delegation_id).toBe('del-with-special/chars');
  });

  it('throws FederationHttpError on 4xx with hub error body', async () => {
    const mockPool = mockAgent.get('http://127.0.0.1:8080');
    mockPool.intercept({
      method: 'POST',
      path: '/v1/federation/delegate',
    }).reply(400, {
      error: 'invalid body',
      code: 'INVALID_BODY',
      request_id: 'abc12345',
    }).persist();

    const client = new FederationHttpClient({
      baseUrl: 'http://127.0.0.1:8080',
      apiToken: 'tok',
    });
    await expect(
      client.delegate({
        peer_verify_key: 'k',
        plugin: 'p',
        tool: 't',
        scope: 's',
        expires_in: '1h',
      }),
    ).rejects.toThrow(FederationHttpError);

    try {
      await client.delegate({
        peer_verify_key: 'k',
        plugin: 'p',
        tool: 't',
        scope: 's',
        expires_in: '1h',
      });
    } catch (err) {
      const e = err as FederationHttpError;
      expect(e.status).toBe(400);
      expect(e.hubError.code).toBe('INVALID_BODY');
      expect(e.hubError.request_id).toBe('abc12345');
    }
  });

  it('handles 404 with no request_id (defensive)', async () => {
    const mockPool = mockAgent.get('http://127.0.0.1:8080');
    mockPool.intercept({
      method: 'GET',
      path: '/v1/federation/delegations',
    }).reply(404, { error: 'not found', code: 'NOT_FOUND' });

    const client = new FederationHttpClient({
      baseUrl: 'http://127.0.0.1:8080',
      apiToken: 'tok',
    });
    await expect(client.listDelegations()).rejects.toThrow(/hub returned 404/);
  });

  it('handles non-JSON error body gracefully', async () => {
    const mockPool = mockAgent.get('http://127.0.0.1:8080');
    mockPool.intercept({
      method: 'GET',
      path: '/v1/federation/delegations',
    }).reply(500, 'Internal Server Error - upstream proxy down');

    const client = new FederationHttpClient({
      baseUrl: 'http://127.0.0.1:8080',
      apiToken: 'tok',
    });
    await expect(client.listDelegations()).rejects.toThrow(/non-JSON body/);
  });

  it('health probe /health works without auth header', async () => {
    const mockPool = mockAgent.get('http://127.0.0.1:8080');
    mockPool.intercept({
      method: 'GET',
      path: '/health',
    }).reply(200, { status: 'ok', service: 'pdatahub-hub' });

    const client = new FederationHttpClient({
      baseUrl: 'http://127.0.0.1:8080',
      apiToken: 'tok',
    });
    const result = await client.ping();
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('health probe fails on non-200', async () => {
    const mockPool = mockAgent.get('http://127.0.0.1:8080');
    mockPool.intercept({
      method: 'GET',
      path: '/health',
    }).reply(503, { error: 'not ready' });

    const client = new FederationHttpClient({
      baseUrl: 'http://127.0.0.1:8080',
      apiToken: 'tok',
    });
    await expect(client.ping()).rejects.toThrow(/returned 503/);
  });

  it('normalizes trailing slash in baseUrl', async () => {
    const mockPool = mockAgent.get('http://127.0.0.1:8080');
    mockPool.intercept({
      method: 'GET',
      path: '/health',
    }).reply(200, { status: 'ok' });

    const client = new FederationHttpClient({
      baseUrl: 'http://127.0.0.1:8080///',
      apiToken: 'tok',
    });
    await client.ping();
    // Should not throw — trailing slashes stripped.
  });

  it('rejects missing baseUrl or apiToken', () => {
    expect(() => new FederationHttpClient({ baseUrl: '', apiToken: 'x' })).toThrow();
    expect(() => new FederationHttpClient({ baseUrl: 'http://x', apiToken: '' })).toThrow();
  });
});

describe('resolveHubUrl', () => {
  it('flag wins over env', () => {
    process.env.PDHUB_URL = 'http://from-env';
    expect(resolveHubUrl('http://from-flag')).toBe('http://from-flag');
    delete process.env.PDHUB_URL;
  });

  it('env used when no flag', () => {
    process.env.PDHUB_URL = 'http://from-env';
    expect(resolveHubUrl(undefined)).toBe('http://from-env');
    delete process.env.PDHUB_URL;
  });

  it('undefined when neither set', () => {
    delete process.env.PDHUB_URL;
    expect(resolveHubUrl(undefined)).toBeUndefined();
  });
});

describe('resolveApiToken', () => {
  const savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    savedEnv.PDHUB_API_TOKEN = process.env.PDHUB_API_TOKEN;
    savedEnv.HUB_API_TOKEN = process.env.HUB_API_TOKEN;
    delete process.env.PDHUB_API_TOKEN;
    delete process.env.HUB_API_TOKEN;
  });
  afterEach(() => {
    if (savedEnv.PDHUB_API_TOKEN !== undefined) process.env.PDHUB_API_TOKEN = savedEnv.PDHUB_API_TOKEN;
    if (savedEnv.HUB_API_TOKEN !== undefined) process.env.HUB_API_TOKEN = savedEnv.HUB_API_TOKEN;
  });

  it('flag wins over env', async () => {
    process.env.PDHUB_API_TOKEN = 'from-env';
    expect(await resolveApiToken('from-flag')).toBe('from-flag');
  });

  it('PDHUB_API_TOKEN used when no flag', async () => {
    process.env.PDHUB_API_TOKEN = 'from-env';
    expect(await resolveApiToken(undefined)).toBe('from-env');
  });

  it('falls back to HUB_API_TOKEN', async () => {
    process.env.HUB_API_TOKEN = 'from-hub-env';
    expect(await resolveApiToken(undefined)).toBe('from-hub-env');
  });

  it('returns undefined when nothing set', async () => {
    expect(await resolveApiToken(undefined)).toBeUndefined();
  });
});
