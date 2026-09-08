/**
 * Tests for `HttpClient` typed error mapping.
 *
 * Uses a real in-process `node:http` server so the full undici pipeline
 * (DNS resolve, TCP connect, request, response, body parse) runs end-to-end.
 * Mocking undici would defeat the purpose of these tests — the goal is
 * to verify that real upstream responses (any HTTP server, any framework)
 * flow through the same error mapping the Hub will see in production.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type AddressInfo, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { HttpClient } from '../src/http-client.js';
import {
  AuthError,
  AuthExpiredError,
  NetworkError,
  NotFoundError,
  PluginError,
  RateLimitError,
  TimeoutError,
} from '../src/errors.js';

interface RecordedRequest {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

let server: Server;
let baseUrl: string;
let lastRequest: RecordedRequest | null = null;

/**
 * Start an HTTP server that records the most recent request and responds
 * with whatever the test's `respond` function decides.
 */
async function startServer(
  respond: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<void> {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      lastRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        body,
        headers: req.headers,
      };
      respond(req, res);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
  lastRequest = null;
}

async function stopServer(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

beforeEach(() => {
  lastRequest = null;
});

afterEach(async () => {
  await stopServer();
});

describe('HttpClient — 2xx success path', () => {
  it('returns parsed JSON data on 200', async () => {
    await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ items: [1, 2, 3] }));
    });

    const client = new HttpClient({ token: 'tok' }, { baseUrl });
    const r = await client.get<{ items: number[] }>('/items');

    expect(r.status).toBe(200);
    expect(r.data).toEqual({ items: [1, 2, 3] });
    expect(r.headers['content-type']).toContain('application/json');
  });

  it('injects Bearer token from context', async () => {
    await startServer((_req, res) => {
      res.writeHead(200);
      res.end('{}');
    });

    const client = new HttpClient({ token: 'secret-token-abc' }, { baseUrl });
    await client.get('/me');

    expect(lastRequest).not.toBeNull();
    const auth = lastRequest!.headers['authorization'];
    expect(auth).toBe('Bearer secret-token-abc');
  });

  it('serializes POST body as JSON', async () => {
    await startServer((_req, res) => {
      res.writeHead(201);
      res.end('{}');
    });

    const client = new HttpClient({}, { baseUrl });
    await client.post('/items', { name: 'thing', qty: 7 });

    expect(lastRequest!.method).toBe('POST');
    expect(lastRequest!.headers['content-type']).toBe('application/json');
    expect(JSON.parse(lastRequest!.body)).toEqual({ name: 'thing', qty: 7 });
  });
});

describe('HttpClient — 4xx error mapping', () => {
  it('401 → AuthError', async () => {
    await startServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });

    const client = new HttpClient({}, { baseUrl });
    const err = await client.get('/me').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as PluginError).code).toBe('AUTH_FAILED');
    expect((err as PluginError).retryable).toBe(false);
  });

  it('401 with expires_at → AuthExpiredError (retryable)', async () => {
    await startServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'token_expired',
          expires_at: '2026-09-08T10:00:00Z',
        }),
      );
    });

    const client = new HttpClient({}, { baseUrl });
    const err = await client.get('/me').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthExpiredError);
    expect((err as PluginError).code).toBe('AUTH_EXPIRED');
    expect((err as PluginError).retryable).toBe(true);
    expect((err as AuthExpiredError).expiresAt).toBeInstanceOf(Date);
  });

  it('401 with error: expired (no expires_at) → AuthExpiredError', async () => {
    await startServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'access_token_expired' }));
    });

    const client = new HttpClient({}, { baseUrl });
    await expect(client.get('/me')).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it('403 → AuthError (no expires_at → not AuthExpiredError)', async () => {
    await startServer((_req, res) => {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
    });

    const client = new HttpClient({}, { baseUrl });
    const err = await client.get('/admin').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err).not.toBeInstanceOf(AuthExpiredError);
  });

  it('404 → NotFoundError', async () => {
    await startServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    const client = new HttpClient({}, { baseUrl });
    const err = await client.get('/missing').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as PluginError).code).toBe('NOT_FOUND');
    expect((err as PluginError).retryable).toBe(false);
  });

  it('429 → RateLimitError with parsed retry_after', async () => {
    await startServer((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'rate_limited', retry_after: 30 }));
    });

    const client = new HttpClient({}, { baseUrl });
    const err = await client.get('/me').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as PluginError).code).toBe('RATE_LIMITED');
    expect((err as PluginError).retryable).toBe(true);
    expect((err as RateLimitError).retryAfterMs).toBe(30_000);
  });

  it('400 → PluginError(CLIENT_ERROR, retryable=false)', async () => {
    await startServer((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad_request', field: 'limit' }));
    });

    const client = new HttpClient({}, { baseUrl });
    const err = await client.get('/items').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect((err as PluginError).code).toBe('CLIENT_ERROR');
    expect((err as PluginError).retryable).toBe(false);
  });

  it('422 → PluginError(CLIENT_ERROR, retryable=false)', async () => {
    await startServer((_req, res) => {
      res.writeHead(422, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unprocessable' }));
    });

    const client = new HttpClient({}, { baseUrl });
    const err = await client.post('/items', { bad: true }).catch((e: unknown) => e);
    expect((err as PluginError).code).toBe('CLIENT_ERROR');
    expect((err as PluginError).retryable).toBe(false);
  });

  it('error.details captures response body and status', async () => {
    const body = { error: 'nope', hint: 'try again later' };
    await startServer((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });

    const client = new HttpClient({}, { baseUrl });
    const err = await client.get('/x').catch((e: unknown) => e) as PluginError;
    expect(err.details).toBeDefined();
    expect(err.details!['status']).toBe(400);
    expect(err.details!['body']).toEqual(body);
  });
});

describe('HttpClient — 5xx error mapping', () => {
  it('500 → PluginError(UPSTREAM_ERROR, retryable=true)', async () => {
    await startServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal' }));
    });

    const client = new HttpClient({}, { baseUrl });
    const err = await client.get('/oops').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect((err as PluginError).code).toBe('UPSTREAM_ERROR');
    expect((err as PluginError).retryable).toBe(true);
  });

  it('503 → PluginError(UPSTREAM_ERROR, retryable=true)', async () => {
    await startServer((_req, res) => {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('Service Unavailable');
    });

    const client = new HttpClient({}, { baseUrl });
    const err = await client.get('/oops').catch((e: unknown) => e);
    expect((err as PluginError).code).toBe('UPSTREAM_ERROR');
    expect((err as PluginError).retryable).toBe(true);
    expect((err as PluginError).message).toContain('503');
    expect((err as PluginError).message).toContain('Service Unavailable');
  });
});

describe('HttpClient — request body preserved on error', () => {
  it('POST body still arrives at server even when server returns 4xx', async () => {
    await startServer((_req, res) => {
      res.writeHead(422, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid' }));
    });

    const client = new HttpClient({}, { baseUrl });
    const payload = { name: 'widget', qty: 99 };
    await client.post('/items', payload).catch(() => {
      /* expected */
    });

    expect(lastRequest).not.toBeNull();
    expect(JSON.parse(lastRequest!.body)).toEqual(payload);
  });
});

describe('HttpClient — works across HTTP methods', () => {
  const cases = [
    { method: 'GET' as const, path: '/x' },
    { method: 'POST' as const, path: '/x' },
    { method: 'PUT' as const, path: '/x' },
    { method: 'DELETE' as const, path: '/x' },
    { method: 'PATCH' as const, path: '/x' },
  ];

  for (const { method, path } of cases) {
    it(`maps ${method} 404 to NotFoundError`, async () => {
      await startServer((req, res) => {
        if (req.url !== path) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      });

      const client = new HttpClient({}, { baseUrl });
      const verb = method.toLowerCase() as 'get';
      const err = await client[verb](path).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotFoundError);
    });
  }
});

describe('HttpClient — timeout → TimeoutError', () => {
  it('throws TimeoutError when server delays past timeout', async () => {
    await startServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      }, 1000);
    });

    const client = new HttpClient({}, { baseUrl, timeoutMs: 50 });
    const err = await client.get('/slow').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).timeoutMs).toBe(50);
    expect((err as TimeoutError).operation).toContain('GET');
    expect((err as TimeoutError).operation).toContain('/slow');
    expect((err as PluginError).retryable).toBe(true);
  });
});

describe('HttpClient — network failures → NetworkError', () => {
  it('throws NetworkError with cause when target port is closed', async () => {
    // Bind a server, capture its port, then close it — guaranteed dead.
    const dead = createServer();
    await new Promise<void>((resolve) =>
      dead.listen(0, '127.0.0.1', () => resolve()),
    );
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));

    const client = new HttpClient({});
    const err = await client
      .get(`http://127.0.0.1:${port}/anything`)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NetworkError);
    expect((err as PluginError).code).toBe('NETWORK_ERROR');
    expect((err as PluginError).retryable).toBe(true);
    expect((err as NetworkError).cause).toBeInstanceOf(Error);
  });

  it('throws NetworkError when DNS resolution fails', async () => {
    const client = new HttpClient({});
    // `localhost.invalid` is guaranteed not to resolve (`.invalid` is the
    // RFC-reserved TLD for non-existent domains).
    const err = await client
      .get('http://localhost.invalid/anything')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NetworkError);
    expect((err as PluginError).code).toBe('NETWORK_ERROR');
    expect((err as NetworkError).cause).toBeInstanceOf(Error);
  });

  it('preserves original error name in details.causeName', async () => {
    const dead = createServer();
    await new Promise<void>((resolve) =>
      dead.listen(0, '127.0.0.1', () => resolve()),
    );
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));

    const client = new HttpClient({});
    const err = await client
      .get(`http://127.0.0.1:${port}/x`)
      .catch((e: unknown) => e) as NetworkError;
    expect(typeof err.details?.['causeName']).toBe('string');
    expect((err.details!['causeName'] as string).length).toBeGreaterThan(0);
  });
});

describe('HttpClient — no automatic retry (per current SDK contract)', () => {
  it('a 500 does not retry; only one server hit occurs', async () => {
    let hits = 0;
    await startServer((_req, res) => {
      hits += 1;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal' }));
    });

    const client = new HttpClient({}, { baseUrl });
    await client.get('/x').catch(() => {
      /* expected */
    });

    expect(hits).toBe(1);
  });
});
