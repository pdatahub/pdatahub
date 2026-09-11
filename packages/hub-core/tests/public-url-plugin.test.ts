/**
 * Tests that plugins without an OAuth declaration (public URLs, local data
 * sources, etc.) can be called without vault operations.
 *
 * Regression test for the bug where the hub tried to fetch a token from the
 * vault for every plugin, throwing `No token stored for plugin: <name>` and
 * emitting a bogus `vault_access` audit row for plugins that never needed
 * OAuth in the first place.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Server } from 'node:http';

import { HubServer } from '../src/server.js';
import { PluginRegistry } from '../src/plugin-process.js';
import { TokenVault } from '../src/token-vault.js';
import { GrantStore } from '../src/grant-store.js';
import { AuditLog } from '../src/audit-log.js';
import { ApprovalStream } from '../src/approval-stream.js';
import { OAuthFlow } from '../src/oauth-flow.js';
import { loadConfig } from '../src/config.js';
import { runMigrations } from '../src/migrations.js';
import type {
  PluginProcess,
  PluginProcessInfo,
  ToolDescriptor,
} from '../src/types.js';

const TEST_TOKEN = 'public-url-test-token';

function makePublicPlugin(opts: {
  name: string;
  toolName: string;
  scope?: string;
}): PluginProcess {
  const info: PluginProcessInfo = {
    name: opts.name,
    version: '0.0.0',
    description: 'public API plugin (no OAuth)',
    entry_path: '',
    pid: 0,
    // Deliberately no `oauth` field — this is the entire point of the test.
    tools: [
      {
        name: opts.toolName,
        description: `public ${opts.toolName}`,
        inputSchema: null,
        scope: opts.scope ?? 'public:read',
        plugin: opts.name,
      },
    ],
    started_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
  };
  return {
    getInfo: () => info,
    callTool: async () => ({
      content: [{ type: 'text', text: '{"fact":"cats are great"}' }],
    }),
    shutdown: async () => undefined,
  } as unknown as PluginProcess;
}

class TestRegistry extends PluginRegistry {
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
}

describe('HubServer.handleCallTool — public URL plugins (no OAuth)', () => {
  let db: Database.Database;
  let server: HubServer;
  let port: number;
  let registry: TestRegistry;
  let grants: GrantStore;
  let audit: AuditLog;
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
      '/tmp/nonexistent-plugins-public-url',
    ]);
    grants = new GrantStore(db);
    audit = new AuditLog(db);
    const tokens = new TokenVault(db, config.masterKey);
    const oauth = new OAuthFlow(tokens);
    const approval = new ApprovalStream({ timeoutMs: 500 });
    registry = new TestRegistry();

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
      scope: 'public:read',
      agent_id: 'agent-1',
      user_id: 'local-user',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      delegated_by: null,
    });
  }

  it('calls a public-URL plugin without throwing "no token stored"', async () => {
    const plugin = makePublicPlugin({
      name: 'catfact',
      toolName: 'getCatFact',
    });
    registry.add(plugin);
    pregrant('getCatFact', 'catfact');

    const res = await fetch(`http://127.0.0.1:${port}/v1/tools/getCatFact/call`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        arguments: {},
        context: { agent_id: 'agent-1', request_id: 'req-1' },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      content: Array<{ type: string; text: string }>;
    };
    expect(body.content[0]?.text).toContain('cats are great');
  });

  it('writes a tool_call audit row but no vault_access row', async () => {
    const plugin = makePublicPlugin({
      name: 'catfact',
      toolName: 'getCatFact',
    });
    registry.add(plugin);
    pregrant('getCatFact', 'catfact');

    await fetch(`http://127.0.0.1:${port}/v1/tools/getCatFact/call`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        arguments: {},
        context: { agent_id: 'agent-1', request_id: 'req-audit' },
      }),
    });

    const rows = audit.query({ limit: 100 });
    const toolRows = rows.filter((r) => r.tool_name === 'getCatFact');
    const vaultRows = rows.filter((r) => r.scope === 'vault:decrypt');

    // The successful tool call is audited exactly once.
    expect(toolRows).toHaveLength(1);
    expect(toolRows[0]?.decision).toBe('approved');

    // Crucially: no vault access was attempted for a plugin that never
    // declared OAuth. This was the original bug — every call emitted a
    // bogus "vault_access" row even for public-URL plugins.
    expect(vaultRows).toHaveLength(0);
  });

  it('handles a plugin with @OAuth() differently — vault ops still happen', async () => {
    // Sanity check: when a plugin DOES declare OAuth, the vault path is
    // still exercised (and fails with the expected error because there's
    // no token stored for it). This proves the gate is plugin-specific,
    // not a blanket "skip vault everywhere" change.
    //
    // We only assert the HTTP error here — the vault-access audit row is
    // written via setImmediate (see safeRecordVaultAccess), which makes
    // timing-based assertions on it flaky. error-routing.test.ts already
    // covers the OAuth plugin + audit behavior in detail.
    const oauthInfo: PluginProcessInfo = {
      name: 'google-calendar',
      version: '0.0.0',
      description: 'plugin with OAuth',
      entry_path: '',
      pid: 0,
      oauth: {
        token_url: 'https://oauth2.googleapis.com/token',
        authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth',
        scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
        client_id_env: 'GOOGLE_CLIENT_ID',
        client_secret_env: 'GOOGLE_CLIENT_SECRET',
      },
      tools: [
        {
          name: 'listEvents',
          description: 'list calendar events',
          inputSchema: null,
          scope: 'calendar:read',
          plugin: 'google-calendar',
        },
      ],
      started_at: new Date().toISOString(),
      last_heartbeat: new Date().toISOString(),
    };
    const oauthPlugin: PluginProcess = {
      getInfo: () => oauthInfo,
      callTool: async () => ({
        content: [{ type: 'text', text: '{}' }],
      }),
      shutdown: async () => undefined,
    } as unknown as PluginProcess;
    registry.add(oauthPlugin);
    pregrant('listEvents', 'google-calendar');

    const res = await fetch(`http://127.0.0.1:${port}/v1/tools/listEvents/call`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        arguments: {},
        context: { agent_id: 'agent-1', request_id: 'req-oauth' },
      }),
    });

    // Vault threw "No token stored for plugin: google-calendar" — hub
    // caught it and returned 500. Proves the OAuth path still runs.
    expect(res.status).toBe(500);
  });
});
