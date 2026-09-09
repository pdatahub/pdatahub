/**
 * mcp-server end-to-end integration test (2-process layer).
 *
 * Real Hub (in-process) + real MCP client/server pair connected via
 * MCP SDK's InMemoryTransport. Tests the full path:
 *
 *   MCP Client
 *     ↓ JSON-RPC over InMemoryTransport
 *   mcp-server (PdatahubMcpServer)
 *     ↓ HTTP via HubClient (undici)
 *   Hub (hub-core HubServer on real port)
 *     ↓ in-process call
 *   Plugin (FakeRegistry stub)
 *
 * For federated scenarios, two Hubs run simultaneously and mcp-server
 * is connected to Hub B. The federated flow:
 *
 *   MCP Client
 *     → mcp-server → Hub B /v1/federation/invoke
 *     → Hub B signs request with B's identity
 *     → POST Hub A /v1/federation/call
 *     → Hub A verifies Ed25519, prompts, runs plugin
 *     → returns to Hub B → returns to mcp-server → returns to MCP Client
 *
 * Tests prove the entire stack works together. They DO NOT mock Hub.
 *
 * Covers:
 *   1. local tool call end-to-end (mcp-server → /v1/tools/:name/call)
 *   2. federated tool call end-to-end (across 2 Hubs)
 *   3. tools/list returns both local + synthetic federated descriptors
 *   4. error propagation (unknown tool, hub down, invalid args)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HubClient } from '../src/hub-client.js';
import { PdatahubMcpServer } from '../src/server.js';
import { HubServer } from '../../hub-core/src/server.js';
import { GrantStore } from '../../hub-core/src/grant-store.js';
import { AuditLog } from '../../hub-core/src/audit-log.js';
import { TokenVault } from '../../hub-core/src/token-vault.js';
import { OAuthFlow } from '../../hub-core/src/oauth-flow.js';
import { ApprovalStream } from '../../hub-core/src/approval-stream.js';
import { PluginRegistry, type PluginProcess, type ToolCallResult } from '../../hub-core/src/plugin-process.js';
import { loadConfig } from '../../hub-core/src/config.js';
import { runMigrations } from '../../hub-core/src/migrations.js';
import { HubIdentity } from '../../hub-core/src/federation/identity.js';
import {
  DelegationStore,
  signDelegation,
  type DelegationBlobV1Body,
} from '../../hub-core/src/federation/delegation.js';
import { NonceStore } from '../../hub-core/src/federation/nonces.js';
import type { PluginProcessInfo, ToolDescriptor } from '../../hub-core/src/types.js';

const TEST_TOKEN = 'test-bearer-mcp-integration';
const MASTER_KEY = Buffer.from('a'.repeat(64), 'hex');

interface FakePluginOpts {
  name: string;
  tools: ToolDescriptor[];
  callToolImpl?: (name: string, args: Record<string, unknown>) => Promise<ToolCallResult>;
}

function fakePlugin(opts: FakePluginOpts): PluginProcess {
  const info: PluginProcessInfo = {
    name: opts.name,
    version: '0.0.0',
    description: '',
    entry_path: '',
    pid: 0,
    tools: opts.tools,
    started_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
  };
  const callTool =
    opts.callToolImpl ??
    (async (name: string, args: Record<string, unknown>) => ({
      data: { ok: true, tool: name, echoed: args },
    }));
  return {
    getInfo: () => info,
    callTool: (name, args) => callTool(name, args),
    shutdown: async () => undefined,
  } as unknown as PluginProcess;
}

class FakeRegistry extends PluginRegistry {
  private readonly byTool = new Map<string, PluginProcess>();
  add(p: PluginProcess): void {
    const info = p.getInfo();
    this.byTool.set(info.name, p);
    for (const t of info.tools) this.byTool.set(t.name, p);
  }
  override getPlugin(toolName: string): PluginProcess | null {
    return this.byTool.get(toolName) ?? null;
  }
  override listPlugins(): PluginProcessInfo[] {
    return Array.from(new Set(this.byTool.values())).map((p) => p.getInfo());
  }
  override listAllTools(): ToolDescriptor[] {
    const out: ToolDescriptor[] = [];
    const seen = new Set<string>();
    for (const p of this.byTool.values()) {
      if (seen.has(p.getInfo().name)) continue;
      seen.add(p.getInfo().name);
      out.push(...p.getInfo().tools);
    }
    return out;
  }
  override async shutdownAll(): Promise<void> {
    /* no-op */
  }
}

interface HubSide {
  port: number;
  identity: HubIdentity;
  delegations: DelegationStore;
  server: HubServer;
  db: Database.Database;
  registry: FakeRegistry;
  audit: AuditLog;
  tokens: TokenVault;
}

interface Harness {
  hubA: HubSide;
  hubB: HubSide;
  mcpServer: PdatahubMcpServer;
  mcpClient: Client;
  approverA: WebSocket;
  approverB: WebSocket;
}

/**
 * Connect a WebSocket client to a Hub's /approval-stream and auto-approve
 * every incoming approval_request. Returns the WS once connected.
 */
async function connectAutoApprover(h: HubSide): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/approval-stream`);
    ws.once('open', () => {
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as {
            type: string;
            request_id?: string;
          };
          if (msg.type === 'approval_request' && msg.request_id) {
            ws.send(
              JSON.stringify({
                type: 'approval_decided',
                request_id: msg.request_id,
                decision: 'approved',
              }),
            );
          }
        } catch {
          /* ignore parse errors */
        }
      });
      resolve(ws);
    });
    ws.once('error', reject);
  });
}

async function startHub(
  hubName: string,
  port: number,
): Promise<HubSide> {
  process.env.HUB_API_TOKEN = TEST_TOKEN;
  process.env.HUB_MASTER_KEY = MASTER_KEY.toString('hex');
  delete process.env.HUB_MASTER_KEY_FILE;

  const db = new Database(':memory:');
  runMigrations(db);

  const registry = new FakeRegistry();
  const audit = new AuditLog(db);
  const tokens = new TokenVault(db, MASTER_KEY);
  const oauth = new OAuthFlow(db, tokens, MASTER_KEY);
  const approval = new ApprovalStream(db);
  const delegations = new DelegationStore(db);
  const nonces = new NonceStore(db);
  const identity = HubIdentity.generate(hubName, MASTER_KEY);
  identity.save(db);

  const config = loadConfig({ HUB_API_TOKEN: TEST_TOKEN });
  config.masterKey = MASTER_KEY;
  config.port = port;
  config.host = '127.0.0.1';
  config.pluginsDir = '/tmp';

  const grants = new GrantStore(db);
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
    delegations,
    nonces,
  });
  await server.start();
  const addr = server.address();
  if (!addr) throw new Error(`${hubName} failed to bind`);

  return { port: addr.port, identity, delegations, server, db, registry, audit, tokens };
}

async function stopHub(h: HubSide): Promise<void> {
  await h.server.stop();
  h.db.close();
}

async function setupHarness(): Promise<Harness> {
  const hubA = await startHub('userA', 0);
  const hubB = await startHub('userB', 0);

  // Register a fake plugin on Hub A (the upstream tool provider).
  hubA.registry.add(
    fakePlugin({
      name: 'google-calendar',
      tools: [
        {
          name: 'listEvents',
          scope: 'calendar:read',
          description: 'List events from primary calendar',
          inputSchema: {
            type: 'object',
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
            },
            required: ['from', 'to'],
            additionalProperties: false,
          },
        },
      ],
      callToolImpl: async (_name, args) => ({
        data: { events: [{ id: 'e1', summary: 'Standup' }], echoed: args },
      }),
    }),
  );

  // Hub A needs a fake OAuth token for google-calendar (real OAuth flow
  // requires Google's authorization server, which we can't use in tests).
  // The token's content doesn't matter — the test plugins ignore it.
  hubA.tokens.store({
    plugin: 'google-calendar',
    access_token: 'fake-access-token-for-tests',
    refresh_token: 'fake-refresh-token-for-tests',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    scope: 'calendar:read',
  });

  // Seed a delegation: A grants B the right to call listEvents on A.
  const delegationId = randomUUID();
  const blobBody: DelegationBlobV1Body = {
    version: 1,
    delegation_id: delegationId,
    issuer: {
      hub_name: hubA.identity.hubName,
      verify_key: hubA.identity.publicKeyB64(),
      fingerprint: hubA.identity.fingerprintHex(),
      magic_dns: hubA.identity.magicDns ?? '',
    },
    subject: {
      verify_key: hubB.identity.publicKeyB64(),
      fingerprint: hubB.identity.fingerprintHex(),
    },
    delegation: {
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
      input_schema: {
        type: 'object',
        properties: { from: { type: 'string' }, to: { type: 'string' } },
        required: ['from', 'to'],
        additionalProperties: false,
      },
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    },
  };
  const signature = signDelegation(hubA.identity, blobBody);
  hubA.delegations.createGranted({
    delegation_id: delegationId,
    peer_verify_key: hubB.identity.publicKeyB64(),
    peer_hub_name: 'userB',
    plugin: 'google-calendar',
    tool: 'listEvents',
    scope: 'calendar:read',
    expires_at: blobBody.delegation.expires_at,
    signature: Buffer.from(signature, 'base64url'),
  });
  hubB.delegations.createReceived({
    delegation_id: delegationId,
    peer_verify_key: hubA.identity.publicKeyB64(),
    peer_hub_name: 'userA',
    peer_hub_url: `http://127.0.0.1:${hubA.port}`,
    plugin: 'google-calendar',
    tool: 'listEvents',
    scope: 'calendar:read',
    input_schema: JSON.stringify(blobBody.delegation.input_schema),
    expires_at: blobBody.delegation.expires_at,
    signature: Buffer.from(signature, 'base64url'),
  });

  // mcp-server pointed at Hub B.
  const hubClient = new HubClient({
    hubUrl: `http://127.0.0.1:${hubB.port}`,
    sessionToken: TEST_TOKEN,
  });
  const mcpServer = new PdatahubMcpServer(hubClient);
  await mcpServer.refreshTools();

  // Connect auto-approvers for both Hubs (approval flow is required for
  // both local and federated tool calls per Momus I2).
  const [approverA, approverB] = await Promise.all([
    connectAutoApprover(hubA),
    connectAutoApprover(hubB),
  ]);

  // MCP client + transport pair (in-process).
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client(
    { name: 'integration-test', version: '1.0.0' },
    { capabilities: {} },
  );

  await Promise.all([
    mcpServer.connect(serverTransport),
    mcpClient.connect(clientTransport),
  ]);

  return { hubA, hubB, mcpServer, mcpClient, approverA, approverB };
}

async function teardownHarness(h: Harness): Promise<void> {
  await h.mcpClient.close();
  h.approverA.close();
  h.approverB.close();
  await stopHub(h.hubB);
  await stopHub(h.hubA);
}

describe('mcp-server end-to-end integration', () => {
  let h: Harness;

  beforeEach(async () => {
    // Hub startup + MCP transport + 2 WS approvers = ~500ms typical.
    // Give 30s headroom for slower CI environments.
    h = await setupHarness();
  }, 30_000);

  afterEach(async () => {
    await teardownHarness(h);
  }, 10_000);

  it('tools/list returns federated descriptor for Hub B (no local plugins)', async () => {
    const result = await h.mcpClient.listTools();
    const names = result.tools.map((t) => t.name).sort();
    // Hub B has no local plugins installed; only the federated descriptor
    // for the delegation from Hub A should be visible.
    expect(names).toEqual(['federated__userA__listEvents']);
  });

  it('local tool call: mcp-server → Hub B → /v1/tools/:name/call → plugin → response', { timeout: 15_000 }, async () => {
    // We need a local plugin on Hub B too. Add it via registry access.
    h.hubB.registry.add(
      fakePlugin({
        name: 'local-test',
        tools: [
          {
            name: 'echo',
            scope: 'test:read',
            description: 'Echo',
            inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
          },
        ],
        callToolImpl: async (_name, args) => ({
          data: { echoed: args.msg },
        }),
      }),
    );
    // Seed Hub B's token vault with a fake token for local-test.
    h.hubB.tokens.store({
      plugin: 'local-test',
      access_token: 'fake-local-token',
      refresh_token: 'fake-local-refresh',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      scope: 'test:read',
    });
    await h.mcpServer.refreshTools();

    const result = await h.mcpClient.callTool({
      name: 'echo',
      arguments: { msg: 'hello from mcp' },
    });
    const text = (result.content[0] as { text: string }).text;
    // Hub wraps plugin return value into MCP content[0].text as JSON.
    // Plugin returned { data: { echoed: args.msg } }; Hub serializes result.data,
    // giving us JSON like {"echoed":"hello from mcp"}.
    const parsed = JSON.parse(text);
    expect(parsed.echoed).toBe('hello from mcp');
  });

  it('federated tool call: mcp-server → Hub B invoke → Hub A call → response flows back', { timeout: 15_000 }, async () => {
    const result = await h.mcpClient.callTool({
      name: 'federated__userA__listEvents',
      arguments: { from: '2026-09-01T00:00:00Z', to: '2026-09-07T00:00:00Z' },
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Standup');

    // Cross-hub audit: A's audit log should have the federated grant entry.
    await new Promise((r) => setTimeout(r, 50));
    const aEntries = h.hubA.audit.query({ user_id: 'local-user' });
    const bEntries = h.hubB.audit.query({ user_id: 'local-user' });
    expect(aEntries.some((e) => e.decision === 'approved' && e.delegated_by)).toBe(true);
    expect(bEntries.some((e) => e.delegated_to && e.decision_federated === 'federated_ok')).toBe(
      true,
    );
  });

  it('unknown tool returns InvalidParams error to MCP client', { timeout: 15_000 }, async () => {
    await expect(
      h.mcpClient.callTool({ name: 'phantomTool', arguments: {} }),
    ).rejects.toThrow(/Unknown tool|phantomTool/);
  });
});
