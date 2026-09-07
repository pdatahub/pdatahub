/**
 * Per-route auth dispatch tests (Phase 0.5 foundation).
 *
 * Verifies that HubServer dispatches auth by route:
 *   - `/health` → `none` (200 without auth header)
 *   - `/v1/tools` → `bearer` (401 without, 200 with valid token)
 *   - `/unknown-route` → fall-through to bearer (401 without token)
 *
 * Also verifies the pure `lookupAuthStrategy` helper for each pattern type:
 * exact path, parameterized path (`/v1/tools/:name/call`), method mismatch,
 * and miss → default `bearer`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { request as undiciRequest } from 'undici';
import { HubServer, lookupAuthStrategy, type RouteAuth } from '../src/server.js';
import { GrantStore } from '../src/grant-store.js';
import { AuditLog } from '../src/audit-log.js';
import { TokenVault } from '../src/token-vault.js';
import { OAuthFlow } from '../src/oauth-flow.js';
import { ApprovalStream } from '../src/approval-stream.js';
import { PluginRegistry } from '../src/plugin-process.js';
import { loadConfig } from '../src/config.js';
import { runMigrations } from '../src/migrations.js';

const TEST_TOKEN = 'test-bearer-token-xyz';

describe('lookupAuthStrategy (pure function)', () => {
  const table: RouteAuth[] = [
    { method: 'GET', path: '/health', auth: 'none' },
    { method: 'GET', path: '/v1/identity', auth: 'none' },
    { method: 'GET', path: '/v1/tools', auth: 'bearer' },
    { method: 'POST', path: '/v1/tools/:name/call', auth: 'bearer' },
  ];

  it('returns `none` for exact-match `none` routes', () => {
    expect(lookupAuthStrategy('GET', '/health', table)).toBe('none');
    expect(lookupAuthStrategy('GET', '/v1/identity', table)).toBe('none');
  });

  it('returns `bearer` for exact-match `bearer` routes', () => {
    expect(lookupAuthStrategy('GET', '/v1/tools', table)).toBe('bearer');
  });

  it('matches parameterized paths (`:name` placeholder)', () => {
    expect(lookupAuthStrategy('POST', '/v1/tools/listEvents/call', table)).toBe(
      'bearer',
    );
    expect(
      lookupAuthStrategy('POST', '/v1/tools/google-calendar.listEvents/call', table),
    ).toBe('bearer');
  });

  it('method mismatch does not match (same path, different verb)', () => {
    expect(lookupAuthStrategy('POST', '/health', table)).toBe('bearer');
    expect(lookupAuthStrategy('GET', '/v1/tools/listEvents/call', table)).toBe(
      'bearer',
    );
  });

  it('falls back to `bearer` for any path not in the table', () => {
    expect(lookupAuthStrategy('GET', '/v1/audit', table)).toBe('bearer');
    expect(lookupAuthStrategy('GET', '/v1/totally/unknown', table)).toBe('bearer');
  });

  it('does not match parameterized path with wrong segment count', () => {
    expect(lookupAuthStrategy('POST', '/v1/tools', table)).toBe('bearer');
    expect(lookupAuthStrategy('POST', '/v1/tools/x', table)).toBe('bearer');
    expect(lookupAuthStrategy('POST', '/v1/tools/x/call/extra', table)).toBe(
      'bearer',
    );
  });

  it('does not match partial segments', () => {
    // `/v1/toolsextra` must NOT match `/v1/tools` (full-path anchored).
    expect(lookupAuthStrategy('GET', '/v1/toolsextra', table)).toBe('bearer');
  });
});

describe('HubServer auth dispatch (real HTTP)', () => {
  let db: Database.Database;
  let server: HubServer;
  let port: number;
  const originalToken = process.env.HUB_API_TOKEN;

  beforeEach(async () => {
    process.env.HUB_API_TOKEN = TEST_TOKEN;
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    runMigrations(db);

    const config = loadConfig([
      '--port',
      '0',
      '--host',
      '127.0.0.1',
      '--master-key',
      'a'.repeat(64),
      '--plugins-dir',
      '/tmp/nonexistent-plugins',
    ]);
    const grants = new GrantStore(db);
    const audit = new AuditLog(db);
    const tokens = new TokenVault(db, config.masterKey);
    const oauth = new OAuthFlow(tokens);
    const approval = new ApprovalStream({ timeoutMs: 1000 });
    const registry = new PluginRegistry();

    server = new HubServer({
      config,
      db,
      registry,
      grants,
      audit,
      tokens,
      oauth,
      approval,
      clientCredentials: new Map(),
    });
    await server.start();
    const addr = server.address();
    if (!addr) throw new Error('server did not bind');
    port = addr.port;
  });

  afterEach(async () => {
    await server.stop();
    db.close();
    if (originalToken === undefined) delete process.env.HUB_API_TOKEN;
    else process.env.HUB_API_TOKEN = originalToken;
  });

  async function get(path: string, headers: Record<string, string> = {}): Promise<{
    status: number;
    body: unknown;
  }> {
    const res = await undiciRequest(`http://127.0.0.1:${port}${path}`, {
      method: 'GET',
      headers,
    });
    const text = await res.body.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // keep as text
    }
    return { status: res.statusCode, body };
  }

  it('GET /health without auth header → 200 (none strategy)', async () => {
    const { status, body } = await get('/health');
    expect(status).toBe(200);
    expect((body as { status?: string }).status).toBe('ok');
  });

  it('GET /health with garbage Authorization header → still 200 (none ignores auth)', async () => {
    const { status } = await get('/health', { authorization: 'Bearer garbage' });
    expect(status).toBe(200);
  });

  it('GET /v1/tools without auth header → 401 (bearer strategy)', async () => {
    const { status } = await get('/v1/tools');
    expect(status).toBe(401);
  });

  it('GET /v1/tools with WRONG bearer → 401', async () => {
    const { status } = await get('/v1/tools', {
      authorization: 'Bearer wrong-token',
    });
    expect(status).toBe(401);
  });

  it('GET /v1/tools with valid bearer → 200', async () => {
    const { status } = await get('/v1/tools', {
      authorization: `Bearer ${TEST_TOKEN}`,
    });
    expect(status).toBe(200);
  });

  it('GET /unknown-route without auth header → 401 (fail-closed default)', async () => {
    const { status } = await get('/v1/totally-unknown-route');
    expect(status).toBe(401);
  });

  it('GET /unknown-route with valid bearer → 404 (passed auth, no route)', async () => {
    const { status } = await get('/v1/totally-unknown-route', {
      authorization: `Bearer ${TEST_TOKEN}`,
    });
    expect(status).toBe(404);
  });
});