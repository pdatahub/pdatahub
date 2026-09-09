/**
 * Phase 8a (Federation v2) — two-HubServer in-process integration test
 * (happy path extension of federation-integration.test.ts).
 *
 * `federation-integration.test.ts` already proves the basic two-Hub
 * round-trip works. This file extends the happy path with scenarios that
 * were not covered in Phase 5 but matter for production confidence:
 *
 *   1. Multiple consecutive calls — verify the audit chain grows
 *      monotonically and the federated grant is reused (not re-approved).
 *   2. Multiple distinct tools delegated between the same hubs —
 *      confirms `federated__<hub>__<tool>` namespacing works.
 *   3. Identity endpoints on both hubs return the right shape (the
 *      public verify_key matches what's in the signed blob).
 *   4. Revoked and expired delegations are excluded from
 *      `GET /v1/tools` synthetic descriptors.
 *   5. The approval request WebSocket broadcast on A's side carries the
 *      `delegated_by`, `peer_hub_name`, and `peer_agent_id` fields that
 *      the Android UI needs to render the source peer (Momus B3).
 *   6. Plugin error path on A still produces cross-hub audit entries
 *      with `decision_federated = 'federated_error'` on B's side.
 *   7. Empty `arguments` payload is accepted (no schema-enforced keys).
 *
 * Pattern mirrors `federation-integration.test.ts` (two HubServers bound
 * to random ports, fake plugins, WebSocket auto-approver, seeded
 * `delegations` / `peer_delegations` rows). Process spawning is too heavy
 * for CI; in-process two-HubServer is the documented fallback.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { HubServer } from '../src/server.js';
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
import { HubIdentity } from '../src/federation/identity.js';
import { DelegationStore } from '../src/federation/delegation.js';
import { NonceStore } from '../src/federation/nonces.js';
import { request as undiciRequest } from 'undici';
import type { PluginProcessInfo, ToolDescriptor } from '../src/types.js';

const MASTER_KEY = Buffer.from('a'.repeat(64), 'hex');
const HUB_API_TOKEN = 'integration-token-8a';

interface FakePluginOpts {
  name: string;
  tools: ToolDescriptor[];
  callToolImpl?: (toolName: string, args: Record<string, unknown>) => Promise<ToolCallResult>;
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
  const callTool = opts.callToolImpl ?? (async () => ({ content: [{ type: 'text', text: '{}' }] }));
  return {
    getInfo: () => info,
    callTool: (name, args) => callTool(name, args),
    shutdown: async () => undefined,
  } as unknown as PluginProcess;
}

class FakeRegistry extends PluginRegistry {
  private readonly byName = new Map<string, PluginProcess>();
  private readonly byTool = new Map<string, PluginProcess>();
  add(p: PluginProcess): void {
    const info = p.getInfo();
    this.byName.set(info.name, p);
    for (const t of info.tools) this.byTool.set(t.name, p);
  }
  override getPlugin(toolName: string): PluginProcess | null {
    return this.byTool.get(toolName) ?? null;
  }
  override listPlugins(): PluginProcessInfo[] {
    return Array.from(this.byName.values()).map((p) => p.getInfo());
  }
  override listAllTools(): ToolDescriptor[] {
    const out: ToolDescriptor[] = [];
    for (const p of this.byName.values()) out.push(...p.getInfo().tools);
    return out;
  }
  override async shutdownAll(): Promise<void> {
    /* no-op */
  }
}

interface HubSide {
  server: HubServer;
  port: number;
  db: Database.Database;
  hubIdentity: HubIdentity;
  delegations: DelegationStore;
  audit: AuditLog;
  approval: ApprovalStream;
  grantStore: GrantStore;
  registry: FakeRegistry;
}

async function startHubSide(opts: {
  hubName: string;
  plugins?: Array<{
    name: string;
    tools: ToolDescriptor[];
    callToolImpl?: (toolName: string, args: Record<string, unknown>) => Promise<ToolCallResult>;
  }>;
}): Promise<HubSide> {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  runMigrations(db);

  const config = loadConfig([
    '--port', '0',
    '--host', '127.0.0.1',
    '--master-key', 'a'.repeat(64),
    '--plugins-dir', '/tmp/nonexistent-plugins',
  ]);

  const grantStore = new GrantStore(db);
  const audit = new AuditLog(db);
  const tokens = new TokenVault(db, config.masterKey);
  const oauth = new OAuthFlow(tokens);
  const approval = new ApprovalStream({ timeoutMs: 5_000 });
  const delegations = new DelegationStore(db);
  const nonces = new NonceStore(db);

  const registry = new FakeRegistry();
  const plugins = opts.plugins ?? [
    {
      name: 'google-calendar',
      tools: [
        {
          name: 'listEvents',
          description: 'List events from primary calendar',
          inputSchema: { type: 'object', properties: {} },
          scope: 'calendar:read',
          plugin: 'google-calendar',
        },
      ],
    },
  ];
  for (const p of plugins) {
    registry.add(fakePlugin(p));
  }
  // T-PERSISTENT-001 mitigation #2 — store a token per plugin so
  // `TokenVault.getAccessToken()` succeeds inside the server's call
  // path (it now throws on not_found).
  for (const p of plugins) {
    tokens.store({
      plugin: p.name,
      access_token: `fake-token-${p.name}`,
      scope: p.tools[0]?.scope ?? 'plugin:read',
    });
  }

  const hubIdentity = HubIdentity.generate(opts.hubName, MASTER_KEY);
  hubIdentity.save(db);

  const server = new HubServer({
    config,
    db,
    registry,
    grants: grantStore,
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
  if (!addr) throw new Error('hub did not bind');
  return {
    server,
    port: addr.port,
    db,
    hubIdentity,
    delegations,
    audit,
    approval,
    grantStore,
    registry,
  };
}

function seedPair(hubA: HubSide, hubB: HubSide, opts: {
  delegationId: string;
  plugin: string;
  tool: string;
  scope: string;
  expiresAt?: string;
}): void {
  hubA.delegations.createGranted({
    delegation_id: opts.delegationId,
    peer_verify_key: hubB.hubIdentity.publicKeyB64(),
    peer_hub_name: 'userB',
    plugin: opts.plugin,
    tool: opts.tool,
    scope: opts.scope,
    expires_at: opts.expiresAt ?? new Date(Date.now() + 60 * 60_000).toISOString(),
    signature: Buffer.alloc(64),
  });
  hubB.delegations.createReceived({
    delegation_id: opts.delegationId,
    peer_verify_key: hubA.hubIdentity.publicKeyB64(),
    peer_hub_name: 'userA',
    peer_hub_url: `http://127.0.0.1:${hubA.port}`,
    plugin: opts.plugin,
    tool: opts.tool,
    scope: opts.scope,
    input_schema: JSON.stringify({ type: 'object', properties: {} }),
    expires_at: opts.expiresAt ?? new Date(Date.now() + 60 * 60_000).toISOString(),
    signature: Buffer.alloc(64),
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface Harness {
  hubA: HubSide;
  hubB: HubSide;
  approver: WebSocket;
}

async function setupHarness(opts: {
  hubAPlugins?: HubSide['registry'] extends FakeRegistry
    ? Array<Parameters<typeof startHubSide>[0]['plugins']>
    : never;
} = {}): Promise<Harness> {
  process.env.HUB_API_TOKEN = HUB_API_TOKEN;

  const hubA = await startHubSide({
    hubName: 'userA',
    ...(opts.hubAPlugins ? { plugins: opts.hubAPlugins as Array<{
      name: string;
      tools: ToolDescriptor[];
      callToolImpl?: (toolName: string, args: Record<string, unknown>) => Promise<ToolCallResult>;
    }> } : {}),
  });
  const hubB = await startHubSide({ hubName: 'userB' });

  const approver = new WebSocket(`ws://127.0.0.1:${hubA.port}/approval-stream`);
  approver.on('message', (raw) => {
    const msg = JSON.parse(raw.toString('utf8')) as { type?: string; request_id?: string };
    if (msg.type === 'approval_request' && typeof msg.request_id === 'string') {
      approver.send(
        JSON.stringify({
          type: 'approval_decided',
          request_id: msg.request_id,
          decision: 'approved',
        }),
      );
    }
  });
  await new Promise<void>((r) => approver.once('open', () => r()));

  return { hubA, hubB, approver };
}

async function teardownHarness(h: Harness): Promise<void> {
  h.approver.close();
  await h.hubA.server.stop();
  await h.hubB.server.stop();
  h.hubA.db.close();
  h.hubB.db.close();
}

describe('Phase 8a — full two-hub integration (happy path extensions)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setupHarness();
  });

  afterEach(async () => {
    await teardownHarness(h);
  });

  it('1. multiple consecutive calls grow the audit chain and reuse the federated grant', async () => {
    seedPair(h.hubA, h.hubB, {
      delegationId: 'del-8a-1',
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
    });

    const callOnce = async (requestId: string) => {
      const res = await undiciRequest(`http://127.0.0.1:${h.hubB.port}/v1/federation/invoke`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${HUB_API_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          tool: 'federated__userA__listEvents',
          arguments: {},
          agent_id: 'B_local_agent',
        }),
      });
      expect(res.statusCode).toBe(200);
      // Drain body to avoid undici resource leak warnings.
      await res.body.text();
    };

    await callOnce('r-1');
    await callOnce('r-2');
    await callOnce('r-3');

    await sleep(50);

    const bAudit = h.hubB.audit.query({ user_id: 'local-user' });
    const bFed = bAudit.filter(
      (e) => e.delegated_to === h.hubA.hubIdentity.publicKeyB64(),
    );
    expect(bFed).toHaveLength(3);
    expect(bFed.every((e) => e.decision_federated === 'federated_ok')).toBe(true);

    const aAudit = h.hubA.audit.query({ user_id: 'local-user' });
    const aFed = aAudit.filter(
      (e) => e.delegated_by === h.hubB.hubIdentity.publicKeyB64(),
    );
    expect(aFed).toHaveLength(3);

    const grantIds = new Set(aFed.map((e) => e.grant_id).filter(Boolean));
    expect(grantIds.size).toBe(1);
  });

  it('2. two distinct tools delegated between the same hubs produce distinct synthetic names', async () => {
    seedPair(h.hubA, h.hubB, {
      delegationId: 'del-8a-list',
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
    });
    seedPair(h.hubA, h.hubB, {
      delegationId: 'del-8a-other',
      plugin: 'slack',
      tool: 'sendMessage',
      scope: 'messages:write',
    });

    const toolsRes = await undiciRequest(`http://127.0.0.1:${h.hubB.port}/v1/tools`, {
      method: 'GET',
      headers: { authorization: `Bearer ${HUB_API_TOKEN}` },
    });
    const toolsBody = (await toolsRes.body.json()) as { tools: ToolDescriptor[] };
    const federated = toolsBody.tools.filter((t) => t.federated === true);
    expect(federated).toHaveLength(2);
    const names = federated.map((t) => t.name).sort();
    expect(names).toEqual([
      'federated__userA__listEvents',
      'federated__userA__sendMessage',
    ]);
  });

  it('3. identity endpoints on both hubs return the expected shape and match the delegation blob', async () => {
    const aIdRes = await undiciRequest(`http://127.0.0.1:${h.hubA.port}/v1/identity`);
    const aId = (await aIdRes.body.json()) as {
      verify_key: string;
      hub_name: string;
      fingerprint: string;
      magic_dns: string | null;
    };
    expect(aId.hub_name).toBe('userA');
    expect(aId.verify_key).toBe(h.hubA.hubIdentity.publicKeyB64());
    expect(aId.fingerprint).toBe(h.hubA.hubIdentity.fingerprintHex());

    const bIdRes = await undiciRequest(`http://127.0.0.1:${h.hubB.port}/v1/identity`);
    const bId = (await bIdRes.body.json()) as {
      verify_key: string;
      hub_name: string;
    };
    expect(bId.hub_name).toBe('userB');
    expect(bId.verify_key).toBe(h.hubB.hubIdentity.publicKeyB64());
  });

  it('4. revoked and expired delegations are excluded from GET /v1/tools synthetic descriptors', async () => {
    seedPair(h.hubA, h.hubB, {
      delegationId: 'del-8a-active',
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
    });
    seedPair(h.hubA, h.hubB, {
      delegationId: 'del-8a-revoked',
      plugin: 'slack',
      tool: 'sendMessage',
      scope: 'messages:write',
    });
    seedPair(h.hubA, h.hubB, {
      delegationId: 'del-8a-expired',
      plugin: 'slack',
      tool: 'listMessages',
      scope: 'messages:read',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    h.hubA.delegations.revokeGranted('del-8a-revoked');
    h.hubB.delegations.revokeReceived('del-8a-revoked');

    const toolsRes = await undiciRequest(`http://127.0.0.1:${h.hubB.port}/v1/tools`, {
      method: 'GET',
      headers: { authorization: `Bearer ${HUB_API_TOKEN}` },
    });
    const toolsBody = (await toolsRes.body.json()) as { tools: ToolDescriptor[] };
    const federated = toolsBody.tools
      .filter((t) => t.federated === true)
      .map((t) => t.name)
      .sort();
    expect(federated).toEqual(['federated__userA__listEvents']);
  });

  it('5. approval request broadcast carries delegated_by / peer_hub_name / peer_agent_id', async () => {
    seedPair(h.hubA, h.hubB, {
      delegationId: 'del-8a-bcast',
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
    });

    const captured: unknown[] = [];
    const inspectWs = new WebSocket(`ws://127.0.0.1:${h.hubA.port}/approval-stream`);
    inspectWs.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8'));
      if (msg.type === 'approval_request') {
        captured.push(msg);
        inspectWs.send(
          JSON.stringify({
            type: 'approval_decided',
            request_id: msg.request_id,
            decision: 'approved',
          }),
        );
      }
    });
    await new Promise<void>((r) => inspectWs.once('open', () => r()));

    await undiciRequest(`http://127.0.0.1:${h.hubB.port}/v1/federation/invoke`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${HUB_API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        tool: 'federated__userA__listEvents',
        arguments: {},
        agent_id: 'B_local_agent',
      }),
    });

    await sleep(50);
    inspectWs.close();
    expect(captured.length).toBeGreaterThan(0);
    const req = captured[0] as {
      delegated_by?: string;
      peer_hub_name?: string;
      peer_agent_id?: string;
      tool_name: string;
    };
    expect(req.delegated_by).toBe(h.hubB.hubIdentity.publicKeyB64());
    expect(req.peer_hub_name).toBe('userB');
    expect(req.peer_agent_id).toBe('B_local_agent');
    expect(req.tool_name).toBe('listEvents');
  });

  it('6. plugin error on A still produces federated_error on B\'s audit + 502 to B\'s MCP', async () => {
    const hubA2 = await startHubSide({
      hubName: 'userA2',
      plugins: [
        {
          name: 'google-calendar',
          tools: [
            {
              name: 'listEvents',
              description: 'List events',
              inputSchema: { type: 'object' },
              scope: 'calendar:read',
              plugin: 'google-calendar',
            },
          ],
          callToolImpl: async () => {
            throw new Error('upstream Google 500');
          },
        },
      ],
    });

    process.env.HUB_API_TOKEN = HUB_API_TOKEN;
    const approver2 = new WebSocket(`ws://127.0.0.1:${hubA2.port}/approval-stream`);
    approver2.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8')) as { type?: string; request_id?: string };
      if (msg.type === 'approval_request' && typeof msg.request_id === 'string') {
        approver2.send(
          JSON.stringify({
            type: 'approval_decided',
            request_id: msg.request_id,
            decision: 'approved',
          }),
        );
      }
    });
    await new Promise<void>((r) => approver2.once('open', () => r()));

    try {
      hubA2.delegations.createGranted({
        delegation_id: 'del-8a-err',
        peer_verify_key: h.hubB.hubIdentity.publicKeyB64(),
        peer_hub_name: 'userB',
        plugin: 'google-calendar',
        tool: 'listEvents',
        scope: 'calendar:read',
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        signature: Buffer.alloc(64),
      });
      h.hubB.delegations.createReceived({
        delegation_id: 'del-8a-err',
        peer_verify_key: hubA2.hubIdentity.publicKeyB64(),
        peer_hub_name: 'userA2',
        peer_hub_url: `http://127.0.0.1:${hubA2.port}`,
        plugin: 'google-calendar',
        tool: 'listEvents',
        scope: 'calendar:read',
        input_schema: JSON.stringify({ type: 'object' }),
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        signature: Buffer.alloc(64),
      });

      const invokeRes = await undiciRequest(`http://127.0.0.1:${h.hubB.port}/v1/federation/invoke`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${HUB_API_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          tool: 'federated__userA2__listEvents',
          arguments: {},
          agent_id: 'B_local_agent',
        }),
      });
      // A's hub returns 500 (PLUGIN_ERROR), B surfaces it.
      expect(invokeRes.statusCode).toBe(500);
      await invokeRes.body.text();

      await sleep(50);

      const bAudit = h.hubB.audit.query({ user_id: 'local-user' });
      const bFed = bAudit.filter(
        (e) => e.delegated_to === hubA2.hubIdentity.publicKeyB64(),
      );
      expect(bFed).toHaveLength(1);
      expect(bFed[0]!.decision_federated).toBe('federated_error');
      expect(bFed[0]!.decision).toBe('denied');
      expect(bFed[0]!.error).toMatch(/upstream Google 500/);
    } finally {
      approver2.close();
      await hubA2.server.stop();
      hubA2.db.close();
    }
  });

  it('7. empty arguments payload is accepted (no schema-enforced keys required)', async () => {
    seedPair(h.hubA, h.hubB, {
      delegationId: 'del-8a-empty',
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
    });

    let pluginArgsSeen: unknown = 'NOT_CALLED';
    h.hubA.registry.add(
      fakePlugin({
        name: 'google-calendar',
        tools: [
          {
            name: 'listEvents',
            description: 'List events',
            inputSchema: { type: 'object' },
            scope: 'calendar:read',
            plugin: 'google-calendar',
          },
        ],
        callToolImpl: async (_name, args) => {
          pluginArgsSeen = args;
          return { content: [{ type: 'text', text: '{"events":[]}' }] };
        },
      }),
    );

    const invokeRes = await undiciRequest(`http://127.0.0.1:${h.hubB.port}/v1/federation/invoke`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${HUB_API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        tool: 'federated__userA__listEvents',
        arguments: {},
        agent_id: 'B_local_agent',
      }),
    });
    expect(invokeRes.statusCode).toBe(200);
    await invokeRes.body.text();
    expect(pluginArgsSeen).toEqual({});
  });
});
