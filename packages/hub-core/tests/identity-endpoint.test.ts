/**
 * HTTP tests for `GET /v1/identity` — Phase 1 federation.
 *
 * Covers:
 *   - 503 when federation_keys is empty (with actionable error message).
 *   - 200 with the identity payload after HubIdentity.save().
 *   - No Authorization header required (route table has auth: 'none').
 *   - 500 / generic failure path is reachable but not asserted here
 *     (encryption failures need a tampered DB which we don't fabricate).
 *   - Loaded identity's verify_key in response matches the saved one.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { request as undiciRequest } from 'undici';
import { HubServer } from '../src/server.js';
import { GrantStore } from '../src/grant-store.js';
import { AuditLog } from '../src/audit-log.js';
import { TokenVault } from '../src/token-vault.js';
import { OAuthFlow } from '../src/oauth-flow.js';
import { ApprovalStream } from '../src/approval-stream.js';
import { PluginRegistry } from '../src/plugin-process.js';
import { loadConfig } from '../src/config.js';
import { runMigrations } from '../src/migrations.js';
import { HubIdentity } from '../src/federation/identity.js';

const TEST_TOKEN = 'test-bearer-token-xyz';

describe('GET /v1/identity (Phase 1 federation)', () => {
  let db: Database.Database;
  let server: HubServer;
  let port: number;
  let masterKey: Buffer;
  const originalToken = process.env.HUB_API_TOKEN;

  beforeEach(async () => {
    process.env.HUB_API_TOKEN = TEST_TOKEN;
    masterKey = Buffer.from('a'.repeat(64), 'hex');

    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    runMigrations(db);

    const config = loadConfig([
      '--port',
      '0',
      '--host',
      '127.0.0.1',
      '--master-key',
      masterKey.toString('hex'),
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

  async function get(
    path: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: unknown }> {
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

  it('returns 503 with actionable message when federation_keys is empty', async () => {
    const { status, body } = await get('/v1/identity');
    expect(status).toBe(503);
    expect(body).toMatchObject({
      error: expect.stringContaining('Hub identity not initialized') as unknown as string,
      code: 'IDENTITY_NOT_INITIALIZED',
    });
    expect((body as { error: string }).error).toMatch(/pdatahub-hub init/);
  });

  it('returns 503 without an Authorization header (auth: none)', async () => {
    // Confirms the route dispatches to `none` — no 401 from a bearer check.
    const { status } = await get('/v1/identity');
    expect(status).not.toBe(401);
    expect(status).toBe(503);
  });

  it('returns 200 with identity payload after HubIdentity.save()', async () => {
    const identity = HubIdentity.generate('userA', masterKey);
    identity.save(db);

    const { status, body } = await get('/v1/identity');
    expect(status).toBe(200);
    expect(body).toEqual({
      verify_key: identity.publicKeyB64(),
      hub_name: 'userA',
      magic_dns: identity.magicDns,
      fingerprint: identity.fingerprintHex(),
    });
  });

  it('returns 200 even with a garbage Authorization header (auth: none ignores it)', async () => {
    const identity = HubIdentity.generate('userA', masterKey);
    identity.save(db);

    const { status } = await get('/v1/identity', { authorization: 'Bearer garbage' });
    expect(status).toBe(200);
  });

  it('verify_key in response is exactly the saved verify_key', async () => {
    const identity = HubIdentity.generate('userB', masterKey);
    identity.save(db);

    const { body } = await get('/v1/identity');
    expect((body as { verify_key: string }).verify_key).toBe(identity.publicKeyB64());
  });

  it('fingerprint format matches "XX XX XX XX XX XX XX XX" (8 hex byte pairs)', async () => {
    const identity = HubIdentity.generate('userA', masterKey);
    identity.save(db);

    const { body } = await get('/v1/identity');
    expect((body as { fingerprint: string }).fingerprint).toMatch(
      /^([0-9A-F]{2} ){7}[0-9A-F]{2}$/,
    );
  });

  it('returns the latest saved identity after a save→save rotation', async () => {
    const a = HubIdentity.generate('userA', masterKey);
    a.save(db);
    const b = HubIdentity.generate('userA', masterKey);
    b.save(db);
    expect(a.publicKeyB64()).not.toBe(b.publicKeyB64());

    const { body } = await get('/v1/identity');
    expect((body as { verify_key: string }).verify_key).toBe(b.publicKeyB64());
  });
});
