/**
 * Plugin SDK v2 — error routing tests (Day 5 of plugin-sdk-v2-design.md).
 *
 * Three layers:
 *   1. Pure helper tests — `mapErrorToHttpStatus`, `mapErrorToMcpError`,
 *      `buildPluginReauthNotification` against every PluginError subclass.
 *   2. End-to-end — HubServer.handleCallTool with a fake plugin that
 *      throws each PluginError, asserting the HTTP status, the audit
 *      `error_class` / `error_code` capture, and the broadcast call.
 *   3. Backward compat — non-PluginError throws keep the existing 500
 *      path with no error_class / error_code set.
 *
 * No real subprocess — the fake plugin's `callTool` throws the typed
 * error synchronously, so the routing logic is exercised without
 * requiring `node dist/index.js` of the plugin-sdk.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { request as undiciRequest } from 'undici';
import {
  AuthError,
  AuthExpiredError,
  NetworkError,
  NotFoundError,
  PluginError,
  RateLimitError,
  ScopeError,
  TimeoutError,
  ValidationError,
} from '@pdatahub/plugin-sdk';
import {
  HubServer,
  buildPluginReauthNotification,
  mapErrorToHttpStatus,
  mapErrorToMcpError,
} from '../src/server.js';
import { GrantStore } from '../src/grant-store.js';
import { AuditLog } from '../src/audit-log.js';
import { TokenVault } from '../src/token-vault.js';
import { OAuthFlow } from '../src/oauth-flow.js';
import { ApprovalStream } from '../src/approval-stream.js';
import {
  PluginRegistry,
  type PluginProcess,
  type ToolCallResult,
} from '../src/plugin-process.js';
import { loadConfig } from '../src/config.js';
import { runMigrations } from '../src/migrations.js';
import type { PluginProcessInfo, ToolDescriptor } from '../src/types.js';

const TEST_TOKEN = 'error-routing-test-token';

function fakePlugin(opts: {
  name: string;
  toolName: string;
  scope?: string;
  throw?: () => Promise<ToolCallResult>;
}): PluginProcess {
  const info: PluginProcessInfo = {
    name: opts.name,
    version: '0.0.0',
    description: '',
    entry_path: '',
    pid: 0,
    tools: [
      {
        name: opts.toolName,
        description: `fake ${opts.toolName}`,
        inputSchema: null,
        scope: opts.scope ?? 'plugin:read',
        plugin: opts.name,
      },
    ],
    started_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
  };
  const throwImpl = opts.throw ?? (async () => ({
    content: [{ type: 'text', text: '{"ok":true}' }],
  }));
  return {
    getInfo: () => info,
    callTool: async () => throwImpl(),
    shutdown: async () => undefined,
  } as unknown as PluginProcess;
}

class FakeRegistry extends PluginRegistry {
  private readonly byTool = new Map<string, PluginProcess>();
  add(p: PluginProcess): void {
    for (const t of p.getInfo().tools) this.byTool.set(t.name, p);
  }
  override getPlugin(toolName: string): PluginProcess | null {
    return this.byTool.get(toolName) ?? null;
  }
  override listPlugins(): PluginProcessInfo[] {
    return Array.from(new Set(this.byTool.values())).map((p) => p.getInfo());
  }
  override listAllTools(): ToolDescriptor[] {
    const out: ToolDescriptor[] = [];
    for (const p of new Set(this.byTool.values())) out.push(...p.getInfo().tools);
    return out;
  }
  override async shutdownAll(): Promise<void> {
    /* no-op */
  }
}

/* ─── Pure helper tests ────────────────────────────────────────────────── */

describe('mapErrorToHttpStatus', () => {
  it('AUTH_EXPIRED → 401', () => {
    expect(mapErrorToHttpStatus(new AuthExpiredError())).toBe(401);
  });

  it('AUTH_FAILED → 403', () => {
    expect(mapErrorToHttpStatus(new AuthError('bad creds'))).toBe(403);
  });

  it('SCOPE_MISSING → 403', () => {
    expect(mapErrorToHttpStatus(new ScopeError('calendar:write', []))).toBe(403);
  });

  it('VALIDATION_FAILED → 400', () => {
    expect(
      mapErrorToHttpStatus(new ValidationError('start_date', 'not-a-date', 'must be ISO 8601')),
    ).toBe(400);
  });

  it('NOT_FOUND → 404', () => {
    expect(mapErrorToHttpStatus(new NotFoundError('event', 'evt_123'))).toBe(404);
  });

  it('RATE_LIMITED / TIMEOUT / NETWORK_ERROR / UPSTREAM_ERROR → 502', () => {
    expect(mapErrorToHttpStatus(new RateLimitError(5000))).toBe(502);
    expect(mapErrorToHttpStatus(new TimeoutError(30000, 'listEvents'))).toBe(502);
    expect(mapErrorToHttpStatus(new NetworkError('econnreset'))).toBe(502);
    // UPSTREAM_ERROR has no dedicated class — use the base PluginError
    // with that code (plugins may throw it directly).
    expect(mapErrorToHttpStatus(new PluginError('UPSTREAM_ERROR', 'upstream 500', true))).toBe(502);
  });

  it('arbitrary PluginError (unknown code) → 500 (fallback)', () => {
    class CustomError extends PluginError {
      constructor() {
        super('WEIRD_THING', 'weird', false);
      }
    }
    expect(mapErrorToHttpStatus(new CustomError())).toBe(500);
  });
});

describe('mapErrorToMcpError', () => {
  it('preserves code, message, retryable, and details', () => {
    const err = new ValidationError('foo', 42, 'must be string');
    expect(mapErrorToMcpError(err)).toEqual({
      code: 'VALIDATION_FAILED',
      message: err.message,
      retryable: false,
      details: { field: 'foo', value: 42, constraint: 'must be string' },
    });
  });

  it('omits details when the PluginError has no details', () => {
    const err = new PluginError('CUSTOM', 'no details', false);
    const mapped = mapErrorToMcpError(err);
    expect(mapped.code).toBe('CUSTOM');
    expect(mapped.retryable).toBe(false);
    expect(mapped.details).toBeUndefined();
    expect('details' in mapped).toBe(false);
  });
});

describe('buildPluginReauthNotification', () => {
  it('returns the notification for AuthExpiredError', () => {
    const notif = buildPluginReauthNotification(new AuthExpiredError(), 'google-calendar');
    expect(notif).toEqual({
      type: 'plugin_reauth',
      plugin: 'google-calendar',
      reason: 'AUTH_EXPIRED',
      message: 'Authentication expired',
    });
  });

  it('returns null for non-AUTH_EXPIRED PluginErrors', () => {
    expect(buildPluginReauthNotification(new AuthError('bad'), 'p')).toBeNull();
    expect(buildPluginReauthNotification(new ScopeError('s', []), 'p')).toBeNull();
    expect(buildPluginReauthNotification(new ValidationError('f', 'v', 'c'), 'p')).toBeNull();
  });
});

/* ─── End-to-end handleCallTool routing ────────────────────────────────── */

describe('HubServer.handleCallTool — PluginError routing', () => {
  let db: Database.Database;
  let server: HubServer;
  let approval: ApprovalStream;
  let audit: AuditLog;
  let grants: GrantStore;
  let tokens: TokenVault;
  let port: number;
  let registry: FakeRegistry;
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
      '/tmp/nonexistent-plugins-error-routing',
    ]);
    grants = new GrantStore(db);
    audit = new AuditLog(db);
    tokens = new TokenVault(db, config.masterKey);
    const oauth = new OAuthFlow(tokens);
    approval = new ApprovalStream({ timeoutMs: 500 });
    registry = new FakeRegistry();

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

  function pregrant(toolName: string, pluginName: string): void {
    grants.create({
      tool_name: toolName,
      plugin: pluginName,
      scope: 'plugin:read',
      agent_id: 'a1',
      user_id: 'local-user',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      delegated_by: null,
    });
  }

  async function callTool(
    toolName: string,
    plugin: PluginProcess,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    registry.add(plugin);
    pregrant(toolName, plugin.getInfo().name);
    // T-PERSISTENT-001 mitigation #2 — store a token so
    // `TokenVault.getAccessToken()` succeeds inside the server's
    // call path (it now throws on not_found; the error-routing
    // tests need the plugin to be CALLED so it can throw its
    // typed PluginError).
    tokens.store({
      plugin: plugin.getInfo().name,
      access_token: 'fake-token-for-routing-test',
      scope: plugin.getInfo().tools.find((t) => t.name === toolName)?.scope ?? 'plugin:read',
    });
    const res = await undiciRequest(
      `http://127.0.0.1:${port}/v1/tools/${encodeURIComponent(toolName)}/call`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: toolName,
          arguments: { foo: 'bar' },
          context: { agent_id: 'a1', justification: 'test' },
        }),
        headersTimeout: 5000,
        bodyTimeout: 5000,
      },
    );
    const text = await res.body.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* keep empty */
    }
    return { status: res.statusCode, body };
  }

  it('ValidationError → 400 + error_class=ValidationError + error_code=VALIDATION_FAILED', async () => {
    const { status, body } = await callTool(
      't1',
      fakePlugin({
        name: 'p1',
        toolName: 't1',
        throw: async () => {
          throw new ValidationError('start_date', 'oops', 'must be ISO 8601');
        },
      }),
    );
    expect(status).toBe(400);
    expect(body['code']).toBe('VALIDATION_FAILED');
    const rows = audit.getByErrorCode('VALIDATION_FAILED');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.error_class).toBe('ValidationError');
    expect(rows[0]!.error_code).toBe('VALIDATION_FAILED');
  });

  it('AuthError → 403 + error_code=AUTH_FAILED (no phone notification)', async () => {
    const broadcastSpy = vi.spyOn(approval, 'broadcastPluginReauth');
    const { status, body } = await callTool(
      't2',
      fakePlugin({
        name: 'p2',
        toolName: 't2',
        throw: async () => {
          throw new AuthError('token revoked');
        },
      }),
    );
    expect(status).toBe(403);
    expect(body['code']).toBe('AUTH_FAILED');
    const rows = audit.getByErrorCode('AUTH_FAILED');
    expect(rows[0]!.error_class).toBe('AuthError');
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('AuthExpiredError → 401 + broadcasts plugin_reauth + audit AUTH_EXPIRED', async () => {
    const broadcastSpy = vi.spyOn(approval, 'broadcastPluginReauth');
    const { status, body } = await callTool(
      't3',
      fakePlugin({
        name: 'google-calendar',
        toolName: 't3',
        throw: async () => {
          throw new AuthExpiredError(new Date('2026-01-01T00:00:00Z'));
        },
      }),
    );
    expect(status).toBe(401);
    expect(body['code']).toBe('AUTH_EXPIRED');
    const rows = audit.getByErrorCode('AUTH_EXPIRED');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.error_class).toBe('AuthExpiredError');
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    const notif = broadcastSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(notif['type']).toBe('plugin_reauth');
    expect(notif['plugin']).toBe('google-calendar');
    expect(notif['reason']).toBe('AUTH_EXPIRED');
  });

  it('ScopeError → 403 + error_code=SCOPE_MISSING (no phone notification)', async () => {
    const broadcastSpy = vi.spyOn(approval, 'broadcastPluginReauth');
    const { status, body } = await callTool(
      't4',
      fakePlugin({
        name: 'p4',
        toolName: 't4',
        throw: async () => {
          throw new ScopeError('messages:write', ['messages:read']);
        },
      }),
    );
    expect(status).toBe(403);
    expect(body['code']).toBe('SCOPE_MISSING');
    const rows = audit.getByErrorCode('SCOPE_MISSING');
    expect(rows[0]!.error_class).toBe('ScopeError');
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('NotFoundError → 404 + error_code=NOT_FOUND', async () => {
    const { status, body } = await callTool(
      't5',
      fakePlugin({
        name: 'p5',
        toolName: 't5',
        throw: async () => {
          throw new NotFoundError('event', 'evt_999');
        },
      }),
    );
    expect(status).toBe(404);
    expect(body['code']).toBe('NOT_FOUND');
    const rows = audit.getByErrorCode('NOT_FOUND');
    expect(rows[0]!.error_class).toBe('NotFoundError');
  });

  it('RateLimitError → 502 + error_code=RATE_LIMITED (retryable hint preserved)', async () => {
    const { status, body } = await callTool(
      't6',
      fakePlugin({
        name: 'p6',
        toolName: 't6',
        throw: async () => {
          throw new RateLimitError(1000);
        },
      }),
    );
    expect(status).toBe(502);
    const pluginError = body['plugin_error'] as { code: string; retryable: boolean };
    expect(pluginError.code).toBe('RATE_LIMITED');
    expect(pluginError.retryable).toBe(true);
    const rows = audit.getByErrorCode('RATE_LIMITED');
    expect(rows[0]!.error_class).toBe('RateLimitError');
  });

  it('NetworkError → 502 + error_code=NETWORK_ERROR (retryable)', async () => {
    const { status, body } = await callTool(
      't7',
      fakePlugin({
        name: 'p7',
        toolName: 't7',
        throw: async () => {
          throw new NetworkError('econnreset');
        },
      }),
    );
    expect(status).toBe(502);
    const pluginError = body['plugin_error'] as { code: string; retryable: boolean };
    expect(pluginError.code).toBe('NETWORK_ERROR');
    expect(pluginError.retryable).toBe(true);
  });

  it('TimeoutError → 502 + error_code=TIMEOUT (retryable)', async () => {
    const { status, body } = await callTool(
      't8',
      fakePlugin({
        name: 'p8',
        toolName: 't8',
        throw: async () => {
          throw new TimeoutError(30000, 'listEvents');
        },
      }),
    );
    expect(status).toBe(502);
    const pluginError = body['plugin_error'] as { code: string; retryable: boolean };
    expect(pluginError.code).toBe('TIMEOUT');
    expect(pluginError.retryable).toBe(true);
  });

  it('arbitrary PluginError (unknown code) → 500 (fallback preserves generic 500)', async () => {
    class CustomError extends PluginError {
      constructor() {
        super('WEIRD_THING', 'weird failure', false);
      }
    }
    const { status, body } = await callTool(
      'ta',
      fakePlugin({
        name: 'pa',
        toolName: 'ta',
        throw: async () => {
          throw new CustomError();
        },
      }),
    );
    expect(status).toBe(500);
    expect(body['code']).toBe('WEIRD_THING');
    const rows = audit.getByErrorCode('WEIRD_THING');
    expect(rows[0]!.error_class).toBe('CustomError');
  });

  it('non-PluginError failure → 500 PLUGIN_ERROR with no error_class/error_code', async () => {
    const { status, body } = await callTool(
      'tb',
      fakePlugin({
        name: 'pb',
        toolName: 'tb',
        throw: async () => {
          throw new Error('v1 plugin-style plain Error');
        },
      }),
    );
    expect(status).toBe(500);
    expect(body['code']).toBe('PLUGIN_ERROR');
    // T-PERSISTENT-001 mitigation #2 — there are now TWO audit rows:
    //   1. The vault_access row written by TokenVault.getAccessToken()
    //      (non-blocking via setImmediate).
    //   2. The plugin error row written by handleCallTool's catch block.
    // Filter to the plugin error row by `decision != 'vault_access'`
    // before asserting on the typed error fields.
    const all = audit.query();
    const pluginRow = all.find((r) => r.decision !== 'vault_access');
    expect(pluginRow).toBeDefined();
    expect(pluginRow!.error_class).toBeNull();
    expect(pluginRow!.error_code).toBeNull();
  });
});
