/**
 * Tests for the static file + SPA fallback handler.
 *
 * Verifies the four behaviors that matter for the Docker deployment:
 *   1. `/v1/*`, `/health`, `/approval-stream` → not intercepted (handler returns false)
 *   2. Path with existing extension → serves the file with correct MIME + cache headers
 *   3. Path without extension (e.g. `/approval`) → serves index.html (SPA fallback)
 *   4. Path traversal (`..`) → 403
 *
 * Uses Node's native `node:http` IncomingMessage/ServerResponse mocks
 * rather than spinning up a real server — these are unit tests of the
 * helper, not integration tests of HubServer (those live elsewhere).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import {
  isApiPath,
  getMimeType,
  resolveSafePath,
  serveStatic,
} from '../src/static';

class FakeResponse {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  ended = false;

  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }

  end(chunk?: string): void {
    if (chunk !== undefined) this.body += chunk;
    this.ended = true;
  }
}

describe('isApiPath', () => {
  it('matches /v1/*', () => {
    expect(isApiPath('/v1/tools')).toBe(true);
    expect(isApiPath('/v1/audit?limit=10')).toBe(true);
    expect(isApiPath('/v1/federation/delegate')).toBe(true);
  });

  it('matches /health exactly', () => {
    expect(isApiPath('/health')).toBe(true);
  });

  it('matches /approval-stream', () => {
    expect(isApiPath('/approval-stream')).toBe(true);
  });

  it('does not match web UI routes', () => {
    expect(isApiPath('/')).toBe(false);
    expect(isApiPath('/approval')).toBe(false);
    expect(isApiPath('/settings')).toBe(false);
    expect(isApiPath('/plugins')).toBe(false);
    expect(isApiPath('/_app/immutable/x.js')).toBe(false);
    expect(isApiPath('/favicon.ico')).toBe(false);
  });

  it('does not false-positive on /v1 (no slash)', () => {
    // /v1foo is NOT an API path — only /v1/... is.
    expect(isApiPath('/v1foo')).toBe(false);
    expect(isApiPath('/v1identity')).toBe(false);
  });

  it('does not false-positive on /health prefix collisions', () => {
    expect(isApiPath('/healthcheck')).toBe(false);
    expect(isApiPath('/health-foo')).toBe(false);
    expect(isApiPath('/approval-stream-foo')).toBe(false);
  });
});

describe('getMimeType', () => {
  it('returns the right MIME for common SvelteKit outputs', () => {
    expect(getMimeType('/path/index.html')).toBe('text/html; charset=utf-8');
    expect(getMimeType('/path/x.js')).toBe('text/javascript; charset=utf-8');
    expect(getMimeType('/path/x.mjs')).toBe('text/javascript; charset=utf-8');
    expect(getMimeType('/path/x.css')).toBe('text/css; charset=utf-8');
    expect(getMimeType('/path/x.json')).toBe('application/json; charset=utf-8');
    expect(getMimeType('/path/x.svg')).toBe('image/svg+xml');
    expect(getMimeType('/path/x.woff2')).toBe('font/woff2');
  });

  it('falls back to application/octet-stream', () => {
    expect(getMimeType('/path/x.unknown')).toBe('application/octet-stream');
    expect(getMimeType('/path/Makefile')).toBe('application/octet-stream');
  });
});

describe('resolveSafePath', () => {
  let webRoot: string;

  beforeEach(() => {
    webRoot = mkdtempSync(join(tmpdir(), 'pdh-static-'));
  });

  afterEach(() => {
    rmSync(webRoot, { recursive: true, force: true });
  });

  it('returns the resolved path inside webRoot for plain requests', () => {
    expect(resolveSafePath(webRoot, '/favicon.ico')).toBe(join(webRoot, 'favicon.ico'));
    expect(resolveSafePath(webRoot, '/_app/immutable/x.js')).toBe(
      join(webRoot, '_app', 'immutable', 'x.js'),
    );
  });

  it('rejects path traversal via ..', () => {
    expect(resolveSafePath(webRoot, '/../etc/passwd')).toBeNull();
    expect(resolveSafePath(webRoot, '/foo/../../etc/passwd')).toBeNull();
  });
});

describe('serveStatic', () => {
  let webRoot: string;

  beforeEach(() => {
    webRoot = mkdtempSync(join(tmpdir(), 'pdh-static-'));
    mkdirSync(join(webRoot, '_app', 'immutable'), { recursive: true });
    writeFileSync(join(webRoot, 'index.html'), '<html>SPA shell</html>');
    writeFileSync(join(webRoot, 'favicon.ico'), 'fake-ico-bytes');
    writeFileSync(join(webRoot, '_app', 'immutable', 'app.js'), 'console.log(1)');
  });

  afterEach(() => {
    rmSync(webRoot, { recursive: true, force: true });
  });

  it('returns false for /v1/* so dispatch handles it', () => {
    const res = new FakeResponse();
    const handled = serveStatic(res as unknown as ServerResponse, webRoot, '/v1/tools');
    expect(handled).toBe(false);
    expect(res.statusCode).toBe(0); // untouched
  });

  it('returns false for /health and /approval-stream', () => {
    const res1 = new FakeResponse();
    expect(serveStatic(res1 as unknown as ServerResponse, webRoot, '/health')).toBe(false);
    const res2 = new FakeResponse();
    expect(serveStatic(res2 as unknown as ServerResponse, webRoot, '/approval-stream')).toBe(false);
  });

  it('serves index.html for /', () => {
    const res = new FakeResponse();
    const handled = serveStatic(res as unknown as ServerResponse, webRoot, '/');
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.body).toBe('<html>SPA shell</html>');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('serves index.html for SPA routes (no extension)', () => {
    const res = new FakeResponse();
    const handled = serveStatic(res as unknown as ServerResponse, webRoot, '/approval');
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<html>SPA shell</html>');
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
  });

  it('serves /favicon.ico with the right MIME', () => {
    const res = new FakeResponse();
    const handled = serveStatic(res as unknown as ServerResponse, webRoot, '/favicon.ico');
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/x-icon');
    expect(res.body).toBe('fake-ico-bytes');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('serves hashed /_app/* assets with long-cache + immutable', () => {
    const res = new FakeResponse();
    const handled = serveStatic(
      res as unknown as ServerResponse,
      webRoot,
      '/_app/immutable/app.js',
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.body).toBe('console.log(1)');
  });

  it('returns 404 for missing assets', () => {
    const res = new FakeResponse();
    const handled = serveStatic(res as unknown as ServerResponse, webRoot, '/missing.png');
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 on path traversal', () => {
    const res = new FakeResponse();
    const handled = serveStatic(res as unknown as ServerResponse, webRoot, '/../etc/passwd');
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(403);
  });

  it('returns 500 when index.html is missing (SPA fallback impossible)', () => {
    rmSync(join(webRoot, 'index.html'));
    const res = new FakeResponse();
    const handled = serveStatic(res as unknown as ServerResponse, webRoot, '/approval');
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatch(/web UI not built/);
  });
});
