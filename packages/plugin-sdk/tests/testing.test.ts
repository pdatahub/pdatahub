/**
 * Tests for the test-utility helpers in `src/testing.ts`.
 *
 * Coverage targets (per Day 4 spec):
 *   - createMockHub returns expected shape (plugin, httpClient, calls)
 *   - Plugin manifest exposes `listThings` as a tool
 *   - MockHttpClient FIFO queue + request tracking
 *   - Typed error mapping: 401/403/404/429/5xx
 *   - Missing response → NetworkError
 *   - Multiple sequential calls consume queue in order
 *   - httpResponses option pre-loads queue
 *   - Plugin tool call results pass through
 *   - Call tracking captures all invocations
 *   - reset() / enqueue() replay mechanism
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildManifest } from '../src/manifest.js';
import {
  createMockHub,
  MockHttpClient,
  type MockHttpResponse,
} from '../src/testing.js';
import {
  AuthError,
  AuthExpiredError,
  NetworkError,
  NotFoundError,
  PluginError,
  RateLimitError,
} from '../src/errors.js';

describe('createMockHub', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('returns expected shape with plugin, httpClient, and calls array', () => {
    const hub = createMockHub();
    expect(hub.plugin).toBeDefined();
    expect(hub.httpClient).toBeInstanceOf(MockHttpClient);
    expect(hub.calls).toEqual([]);
  });

  it('plugin manifest exposes listThings as a tool', () => {
    const hub = createMockHub();
    const manifest = buildManifest(hub.plugin);
    expect(manifest.name).toBe('test-plugin');
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.protocolVersion).toBe(2);
    expect(manifest.tools).toHaveLength(1);
    expect(manifest.tools[0]).toEqual({
      name: 'listThings',
      scope: 'things.read',
      description: 'List things from upstream',
    });
  });

  it('listThings returns response data and records the call', async () => {
    const hub = createMockHub({
      httpResponses: [
        {
          method: 'GET',
          url: 'things',
          status: 200,
          data: { items: ['a', 'b', 'c'] },
        },
      ],
    });

    const result = await hub.plugin.listThings(2);

    expect(result).toEqual({ items: ['a', 'b', 'c'] });
    expect(hub.calls).toEqual([{ tool: 'listThings', args: [2] }]);
    expect(hub.httpClient.requests).toHaveLength(1);
    expect(hub.httpClient.requests[0]).toMatchObject({
      method: 'GET',
      url: 'things',
      params: { limit: 2 },
    });
  });

  it('call tracking captures all invocations in order', async () => {
    const hub = createMockHub({
      httpResponses: [
        { method: 'GET', url: 'things', status: 200, data: [] },
        { method: 'GET', url: 'things', status: 200, data: [] },
        { method: 'GET', url: 'things', status: 200, data: [] },
      ],
    });

    await hub.plugin.listThings(1);
    await hub.plugin.listThings(5);
    await hub.plugin.listThings();

    expect(hub.calls).toEqual([
      { tool: 'listThings', args: [1] },
      { tool: 'listThings', args: [5] },
      { tool: 'listThings', args: [10] },
    ]);
    expect(hub.httpClient.requests).toHaveLength(3);
  });

  it('httpResponses option pre-loads the queue', () => {
    const responses: MockHttpResponse[] = [
      { method: 'GET', url: 'a', status: 200, data: 1 },
      { method: 'POST', url: 'b', status: 201, data: 2 },
    ];
    const hub = createMockHub({ httpResponses: responses });
    expect(hub.httpClient.queue).toHaveLength(2);
    expect(hub.httpClient.queue[0]).toEqual(responses[0]);
    expect(hub.httpClient.queue[1]).toEqual(responses[1]);
  });
});

describe('MockHttpClient — FIFO queue', () => {
  it('consumes responses in FIFO order for identical (method, url)', async () => {
    const client = new MockHttpClient([
      { method: 'GET', url: 'a', status: 200, data: { n: 1 } },
      { method: 'GET', url: 'a', status: 200, data: { n: 2 } },
      { method: 'GET', url: 'a', status: 200, data: { n: 3 } },
    ]);

    const r1 = await client.get<{ n: number }>('a');
    const r2 = await client.get<{ n: number }>('a');
    const r3 = await client.get<{ n: number }>('a');

    expect(r1.data).toEqual({ n: 1 });
    expect(r2.data).toEqual({ n: 2 });
    expect(r3.data).toEqual({ n: 3 });
    expect(client.queue).toHaveLength(0);
  });

  it('matches by (method, url) — different urls get different responses', async () => {
    const client = new MockHttpClient([
      { method: 'GET', url: 'a', status: 200, data: { which: 'a1' } },
      { method: 'GET', url: 'b', status: 200, data: { which: 'b1' } },
      { method: 'GET', url: 'a', status: 200, data: { which: 'a2' } },
    ]);

    const r1 = await client.get<{ which: string }>('a');
    const r2 = await client.get<{ which: string }>('b');
    const r3 = await client.get<{ which: string }>('a');

    expect(r1.data).toEqual({ which: 'a1' });
    expect(r2.data).toEqual({ which: 'b1' });
    expect(r3.data).toEqual({ which: 'a2' });
  });
});

describe('MockHttpClient — request tracking', () => {
  it('records method, url, and query params for GET', async () => {
    const client = new MockHttpClient([
      { method: 'GET', url: 'x', status: 200, data: null },
    ]);
    await client.get('x', { params: { q: 'hi', limit: 5 } });

    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]).toEqual({
      method: 'GET',
      url: 'x',
      params: { q: 'hi', limit: 5 },
    });
  });

  it('records body for POST/PUT/PATCH', async () => {
    const client = new MockHttpClient([
      { method: 'POST', url: 'x', status: 201, data: null },
      { method: 'PUT', url: 'x', status: 200, data: null },
      { method: 'PATCH', url: 'x', status: 200, data: null },
    ]);

    await client.post('x', { a: 1 });
    await client.put('x', { b: 2 });
    await client.patch('x', { c: 3 });

    expect(client.requests.map((r) => r.method)).toEqual([
      'POST',
      'PUT',
      'PATCH',
    ]);
    expect(client.requests.map((r) => r.params)).toEqual([
      { a: 1 },
      { b: 2 },
      { c: 3 },
    ]);
  });

  it('records query params for DELETE', async () => {
    const client = new MockHttpClient([
      { method: 'DELETE', url: 'x', status: 204, data: null },
    ]);
    await client.delete('x', { params: { force: true } });

    expect(client.requests[0]).toEqual({
      method: 'DELETE',
      url: 'x',
      params: { force: true },
    });
  });
});

describe('MockHttpClient — typed error mapping', () => {
  it('throws AuthError on 401', async () => {
    const client = new MockHttpClient([
      { method: 'GET', url: 'me', status: 401, data: { error: 'unauthorized' } },
    ]);
    await expect(client.get('me')).rejects.toBeInstanceOf(AuthError);
  });

  it('throws AuthError on 403', async () => {
    const client = new MockHttpClient([
      { method: 'GET', url: 'admin', status: 403, data: { error: 'forbidden' } },
    ]);
    await expect(client.get('admin')).rejects.toBeInstanceOf(AuthError);
  });

  it('throws AuthExpiredError on 401 with expires_at', async () => {
    const client = new MockHttpClient([
      {
        method: 'GET',
        url: 'me',
        status: 401,
        data: { error: 'token_expired', expires_at: '2026-09-08T10:00:00Z' },
      },
    ]);
    await expect(client.get('me')).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it('throws NotFoundError on 404', async () => {
    const client = new MockHttpClient([
      { method: 'GET', url: 'missing', status: 404, data: 'not found' },
    ]);
    await expect(client.get('missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws RateLimitError on 429', async () => {
    const client = new MockHttpClient([
      { method: 'GET', url: 'me', status: 429, data: { retry_after: 30 } },
    ]);
    await expect(client.get('me')).rejects.toBeInstanceOf(RateLimitError);
  });

  it('throws retryable PluginError on 500', async () => {
    const client = new MockHttpClient([
      { method: 'GET', url: 'oops', status: 500, data: { error: 'internal' } },
    ]);
    const err = await client.get('oops').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err).toBeInstanceOf(Error);
    expect((err as PluginError).code).toBe('UPSTREAM_ERROR');
    expect((err as PluginError).retryable).toBe(true);
  });

  it('throws NetworkError when no response is queued', async () => {
    const client = new MockHttpClient([]);
    await expect(client.get('unmapped')).rejects.toBeInstanceOf(NetworkError);
    await expect(client.get('unmapped')).rejects.toThrow(
      /no response queued for GET unmapped/,
    );
  });
});

describe('MockHttpClient — reset and enqueue', () => {
  it('reset() clears request log and re-queues original responses', async () => {
    const client = new MockHttpClient([
      { method: 'GET', url: 'a', status: 200, data: { n: 1 } },
    ]);

    await client.get('a');
    expect(client.requests).toHaveLength(1);
    expect(client.queue).toHaveLength(0);

    client.reset();

    expect(client.requests).toHaveLength(0);
    expect(client.queue).toHaveLength(1);

    const r = await client.get<{ n: number }>('a');
    expect(r.data).toEqual({ n: 1 });
  });

  it('enqueue() adds a response to the queue mid-test', async () => {
    const client = new MockHttpClient();
    client.enqueue({ method: 'GET', url: 'late', status: 200, data: 'ok' });
    const r = await client.get<string>('late');
    expect(r.data).toBe('ok');
  });
});
