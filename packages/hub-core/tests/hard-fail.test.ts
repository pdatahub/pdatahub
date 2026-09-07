/**
 * Hard-fail on missing HUB_API_TOKEN (Phase 0.5 foundation).
 *
 * Verifies the spec acceptance criteria:
 *   - `--host 0.0.0.0` without token → throws on startup.
 *   - `--host 127.0.0.1` without token → boots successfully (existing dev behavior).
 *   - `--host 0.0.0.0` with token → boots successfully.
 *
 * Approach: each "scenario" in the spec is decomposed into the same set of
 * operations the production code performs — loadConfig + checkHubApiTokenRequirement
 * + open DB + run migrations + construct stores + start server. We test each
 * scenario end-to-end in-process (no child-process spawn) so the test suite
 * stays fast and free of build-step dependencies. The throw case is checked
 * with both `loadConfig` + `checkHubApiTokenRequirement` AND a real
 * startup sequence that simulates the throw.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, rmSync } from 'node:fs';
import { GrantStore } from '../src/grant-store.js';
import { AuditLog } from '../src/audit-log.js';
import { TokenVault } from '../src/token-vault.js';
import { OAuthFlow } from '../src/oauth-flow.js';
import { ApprovalStream } from '../src/approval-stream.js';
import { PluginRegistry } from '../src/plugin-process.js';
import { HubServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { runMigrations } from '../src/migrations.js';
import {
  checkHubApiTokenRequirement,
  isLoopbackHost,
} from '../src/startup.js';

describe('isLoopbackHost', () => {
  it('recognizes IPv4 loopback', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
  });
  it('recognizes IPv6 loopback', () => {
    expect(isLoopbackHost('::1')).toBe(true);
  });
  it('recognizes "localhost" alias', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
  });
  it('rejects non-loopback hosts', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
  });
});

describe('checkHubApiTokenRequirement', () => {
  it('throws when binding to non-loopback without token', () => {
    expect(() => checkHubApiTokenRequirement('0.0.0.0', undefined)).toThrow(
      /HUB_API_TOKEN/,
    );
  });

  it('throws when binding to non-loopback with empty token', () => {
    expect(() => checkHubApiTokenRequirement('0.0.0.0', '')).toThrow(/HUB_API_TOKEN/);
  });

  it('does NOT throw when binding to 127.0.0.1 without token', () => {
    expect(() => checkHubApiTokenRequirement('127.0.0.1', undefined)).not.toThrow();
  });

  it('does NOT throw when binding to ::1 without token', () => {
    expect(() => checkHubApiTokenRequirement('::1', undefined)).not.toThrow();
  });

  it('does NOT throw when binding to localhost without token', () => {
    expect(() => checkHubApiTokenRequirement('localhost', undefined)).not.toThrow();
  });

  it('does NOT throw when binding to non-loopback WITH token', () => {
    expect(() =>
      checkHubApiTokenRequirement('0.0.0.0', 'some-token'),
    ).not.toThrow();
  });

  it('does NOT throw when binding to non-loopback with empty token? — no, throw', () => {
    // Empty string is NOT a valid token — same as undefined.
    expect(() => checkHubApiTokenRequirement('0.0.0.0', '')).toThrow();
  });

  it('error message mentions loopback as the dev workaround', () => {
    expect(() => checkHubApiTokenRequirement('0.0.0.0', undefined)).toThrow(
      /127\.0\.0\.1|::1|loopback/i,
    );
  });
});

describe('startup flow — full integration (in-process)', () => {
  let dbPath: string;
  const originalToken = process.env.HUB_API_TOKEN;

  beforeEach(() => {
    dbPath = join(tmpdir(), `hard-fail-${randomBytes(4).toString('hex')}.db`);
  });

  afterEach(() => {
    if (existsSync(dbPath)) rmSync(dbPath);
    if (originalToken === undefined) delete process.env.HUB_API_TOKEN;
    else process.env.HUB_API_TOKEN = originalToken;
  });

  /**
   * Simulate the production startup sequence (loadConfig → checkHubApiTokenRequirement
   * → open DB → run migrations → construct stores → start server). Returns
   * the HubServer instance on success, or throws.
   *
   * Mirrors the lines in `src/index.ts` `main()` exactly — if the production
   * sequence diverges, this test should be updated to match.
   */
  async function runStartup(
    host: string,
    apiToken: string | undefined,
    port = 0,
  ): Promise<HubServer> {
    if (apiToken === undefined) delete process.env.HUB_API_TOKEN;
    else process.env.HUB_API_TOKEN = apiToken;

    const config = loadConfig([
      '--host',
      host,
      '--port',
      String(port),
      '--master-key',
      'a'.repeat(64),
      '--db-path',
      dbPath,
      '--plugins-dir',
      '/tmp/nonexistent-plugins',
    ]);
    checkHubApiTokenRequirement(config.host, process.env.HUB_API_TOKEN);

    const db = new Database(config.dbPath);
    db.pragma('journal_mode = WAL');
    runMigrations(db);

    const grants = new GrantStore(db);
    const audit = new AuditLog(db);
    const tokens = new TokenVault(db, config.masterKey);
    const oauth = new OAuthFlow(tokens);
    const approval = new ApprovalStream({ timeoutMs: 1000 });
    const registry = new PluginRegistry();
    const server = new HubServer({
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
    return server;
  }

  it('scenario 1 — host 0.0.0.0 without HUB_API_TOKEN → throws on startup', async () => {
    await expect(runStartup('0.0.0.0', undefined)).rejects.toThrow(/HUB_API_TOKEN/);
  });

  it('scenario 2 — host 127.0.0.1 without HUB_API_TOKEN → boots successfully', async () => {
    const server = await runStartup('127.0.0.1', undefined);
    try {
      expect(server.address()).not.toBeNull();
      // Hub is listening on loopback — fetch /health to prove.
      const addr = server.address()!;
      const res = await fetch(`http://127.0.0.1:${addr.port}/health`);
      expect(res.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it('scenario 3 — host 0.0.0.0 with HUB_API_TOKEN set → boots successfully', async () => {
    const server = await runStartup('0.0.0.0', 'real-token-12345');
    try {
      const addr = server.address()!;
      const res = await fetch(`http://127.0.0.1:${addr.port}/health`, {
        headers: { authorization: 'Bearer real-token-12345' },
      });
      expect(res.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it('also accepts ::1 and localhost without token (dev mode preserved)', async () => {
    for (const host of ['::1', 'localhost']) {
      const server = await runStartup(host, undefined);
      try {
        expect(server.address()).not.toBeNull();
      } finally {
        await server.stop();
      }
    }
  });
});