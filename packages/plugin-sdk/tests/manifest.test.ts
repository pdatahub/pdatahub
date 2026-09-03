import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpClient, type RequestFn } from '../src/http-client.js';
import { Logger } from '../src/logger.js';

/**
 * Build a mock request function that captures calls and returns a canned
 * response.
 */
function mockRequest(
  response: { statusCode: number; body: string; headers?: Record<string, string> },
): RequestFn & { calls: Array<{ url: string; opts: unknown }> } {
  const calls: Array<{ url: string; opts: unknown }> = [];
  const fn = vi.fn(async (url: string, opts: unknown) => {
    calls.push({ url, opts });
    return {
      statusCode: response.statusCode,
      body: { text: async () => response.body },
      headers: response.headers ?? {},
    };
  }) as unknown as RequestFn & { calls: Array<{ url: string; opts: unknown }> };
  fn.calls = calls;
  return fn;
}

describe('HttpClient', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('builds URL with base + path', () => {
    const client = new HttpClient({}, { baseUrl: 'https://api.example.com' });
    expect(client).toBeDefined();
  });

  it('handles full URLs (ignores baseUrl)', async () => {
    const reqFn = mockRequest({ statusCode: 200, body: '{"ok":true}' });
    const client = new HttpClient(
      {},
      { baseUrl: 'https://api.example.com', requestFn: reqFn },
    );
    const response = await client.get('https://other.example.com/path');

    expect(response.status).toBe(200);
    expect(response.data).toEqual({ ok: true });
    expect(reqFn.calls[0]!.url).toBe('https://other.example.com/path');
  });

  it('appends query params', async () => {
    const reqFn = mockRequest({ statusCode: 200, body: '{}' });
    const client = new HttpClient(
      {},
      { baseUrl: 'https://api.example.com', requestFn: reqFn },
    );
    await client.get('/search', { params: { q: 'hello', limit: 10 } });

    expect(reqFn.calls[0]!.url).toContain('q=hello');
    expect(reqFn.calls[0]!.url).toContain('limit=10');
  });

  it('skips undefined/null query params', async () => {
    const reqFn = mockRequest({ statusCode: 200, body: '{}' });
    const client = new HttpClient(
      {},
      { baseUrl: 'https://api.example.com', requestFn: reqFn },
    );
    await client.get('/search', { params: { q: 'hello', skip: undefined, also: null } });

    const url = reqFn.calls[0]!.url;
    expect(url).toContain('q=hello');
    expect(url).not.toContain('skip=');
    expect(url).not.toContain('also=');
  });

  it('injects Bearer token when context.token is present', async () => {
    const reqFn = mockRequest({ statusCode: 200, body: '{}' });
    const client = new HttpClient({ token: 'abc123' }, { requestFn: reqFn });
    await client.get('https://api.example.com/me');

    const opts = reqFn.calls[0]!.opts as { headers: Record<string, string> };
    expect(opts.headers['Authorization']).toBe('Bearer abc123');
  });

  it('omits Authorization when no token', async () => {
    const reqFn = mockRequest({ statusCode: 200, body: '{}' });
    const client = new HttpClient({}, { requestFn: reqFn });
    await client.get('https://api.example.com/me');

    const opts = reqFn.calls[0]!.opts as { headers: Record<string, string> };
    expect(opts.headers['Authorization']).toBeUndefined();
  });

  it('serializes JSON body for POST', async () => {
    const reqFn = mockRequest({ statusCode: 201, body: '{"id":1}' });
    const client = new HttpClient({}, { requestFn: reqFn });
    await client.post('https://api.example.com/items', { name: 'test' });

    const opts = reqFn.calls[0]!.opts as {
      method: string;
      headers: Record<string, string>;
      body: string;
    };
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body)).toEqual({ name: 'test' });
  });

  it('does not set Content-Type when no body', async () => {
    const reqFn = mockRequest({ statusCode: 200, body: '{}' });
    const client = new HttpClient({}, { requestFn: reqFn });
    await client.get('https://api.example.com/me');

    const opts = reqFn.calls[0]!.opts as { headers: Record<string, string> };
    expect(opts.headers['Content-Type']).toBeUndefined();
  });

  it('parses JSON response body', async () => {
    const reqFn = mockRequest({ statusCode: 200, body: '{"items":[1,2,3]}' });
    const client = new HttpClient({}, { requestFn: reqFn });
    const response = await client.get<{ items: number[] }>('https://api.example.com/items');
    expect(response.data).toEqual({ items: [1, 2, 3] });
  });

  it('returns raw text when response is not JSON', async () => {
    const reqFn = mockRequest({ statusCode: 200, body: '<html>not json</html>' });
    const client = new HttpClient({}, { requestFn: reqFn });
    const response = await client.get<string>('https://api.example.com/page');
    expect(response.data).toBe('<html>not json</html>');
  });

  it('applies default headers', async () => {
    const reqFn = mockRequest({ statusCode: 200, body: '{}' });
    const client = new HttpClient(
      {},
      { defaultHeaders: { 'X-Plugin': 'pdatahub' }, requestFn: reqFn },
    );
    await client.get('https://api.example.com/me');

    const opts = reqFn.calls[0]!.opts as { headers: Record<string, string> };
    expect(opts.headers['X-Plugin']).toBe('pdatahub');
  });

  it('passes through status code', async () => {
    const reqFn = mockRequest({ statusCode: 404, body: '{"error":"not found"}' });
    const client = new HttpClient({}, { requestFn: reqFn });
    const response = await client.get('https://api.example.com/missing');
    expect(response.status).toBe(404);
  });

  it('supports PUT, PATCH, DELETE methods', async () => {
    const reqFn = mockRequest({ statusCode: 200, body: '{}' });
    const client = new HttpClient({}, { requestFn: reqFn });
    await client.put('https://api.example.com/x', { a: 1 });
    await client.patch('https://api.example.com/x', { b: 2 });
    await client.delete('https://api.example.com/x');

    expect(reqFn.calls).toHaveLength(3);
    const methods = reqFn.calls.map((c) => (c.opts as { method: string }).method);
    expect(methods).toEqual(['PUT', 'PATCH', 'DELETE']);
  });
});

describe('Logger', () => {
  it('writes timestamped log lines to stderr', () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
      writes.push(String(s));
      return true;
    });

    const logger = new Logger('myplugin');
    logger.info('hello world');

    expect(writes).toHaveLength(1);
    const line = writes[0]!;
    expect(line).toMatch(/^\[[^\]]+\] \[INFO\] \[myplugin\] hello world\n$/);

    spy.mockRestore();
  });

  it('uses correct level for each method', () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
      writes.push(String(s));
      return true;
    });

    const logger = new Logger('p');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(writes[0]).toContain('[INFO]');
    expect(writes[1]).toContain('[WARN]');
    expect(writes[2]).toContain('[ERROR]');

    spy.mockRestore();
  });

  it('suppresses debug logs by default', () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
      writes.push(String(s));
      return true;
    });

    const logger = new Logger('p');
    logger.debug('hidden');
    expect(writes).toHaveLength(0);

    spy.mockRestore();
  });

  it('emits debug logs when PDHUB_DEBUG=1', () => {
    process.env['PDHUB_DEBUG'] = '1';
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
      writes.push(String(s));
      return true;
    });

    const logger = new Logger('p');
    logger.debug('visible');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('[DEBUG]');

    delete process.env['PDHUB_DEBUG'];
    spy.mockRestore();
  });

  it('serializes non-string args as JSON', () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
      writes.push(String(s));
      return true;
    });

    const logger = new Logger('p');
    logger.info('event', { action: 'click' }, 42);

    expect(writes[0]).toContain('{"action":"click"}');
    expect(writes[0]).toContain('42');

    spy.mockRestore();
  });

  it('handles circular refs without crashing', () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
      writes.push(String(s));
      return true;
    });

    const circular: Record<string, unknown> = { name: 'x' };
    circular['self'] = circular;

    const logger = new Logger('p');
    expect(() => logger.info('event', circular)).not.toThrow();
    expect(writes).toHaveLength(1);

    spy.mockRestore();
  });
});