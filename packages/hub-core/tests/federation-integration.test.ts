/**
 * Phase 5 (Federation v2) end-to-end integration — two real HubServer
 * instances (A and B) talking over real HTTP.
 *
 * Wires together the two halves that the unit tests cover separately:
 *   - B's `/v1/federation/invoke` (Momus B6) — signs the outbound body
 *     with B's identity, POSTs to A's `/v1/federation/call`.
 *   - A's `/v1/federation/call` (Phase 3) — verifies the signature,
 *     looks up the delegation, runs the approval flow, invokes the
 *     plugin, returns the result.
 *
 * Both sides audit-log the call:
 *   - A's `audit_log.delegated_by = B_verify_key` (verified in
 *     federation-call.test.ts; asserted here again on the same run).
 *   - B's `audit_log.delegated_to = A_verify_key` +
 *     `decision_federated = 'federated_ok'`.
 *
 * The fake plugin on A's side records what it received so we can
 * assert that B's arguments flowed through the signed request to A
 * unchanged. No HTTP mocking — both hubs bind real ports.
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
  callToolImpl?: FakePluginOpts['callToolImpl'];
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
  registry.add(
    fakePlugin({
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
      ...(opts.callToolImpl ? { callToolImpl: opts.callToolImpl } : {}),
    }),
  );

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

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('Phase 5 end-to-end — real Hub A + real Hub B over HTTP', () => {
  let hubA: HubSide;
  let hubB: HubSide;
  let approver: WebSocket;
  let pluginArgsSeen: { tool: string; args: Record<string, unknown> } | null;
  const originalToken = process.env.HUB_API_TOKEN;

  beforeEach(async () => {
    process.env.HUB_API_TOKEN = 'integration-token';
    pluginArgsSeen = null;

    hubA = await startHubSide({
      hubName: 'userA',
      callToolImpl: async (tool, args) => {
        pluginArgsSeen = { tool, args };
        return {
          content: [{ type: 'text', text: '{"events":[{"id":"e1"}]}' }],
        };
      },
    });

    hubB = await startHubSide({ hubName: 'userB' });

    // Auto-approve on A's side so the federated call doesn't hang.
    approver = new WebSocket(`ws://127.0.0.1:${hubA.port}/approval-stream`);
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
  });

  afterEach(async () => {
    approver.close();
    await hubA.server.stop();
    await hubB.server.stop();
    hubA.db.close();
    hubB.db.close();
    if (originalToken === undefined) delete process.env.HUB_API_TOKEN;
    else process.env.HUB_API_TOKEN = originalToken;
  });

  it('GET /v1/tools on B includes federated descriptors; full /v1/federation/invoke round-trip succeeds', async () => {
    // Seed both sides of the delegation — A needs a `delegations` row
    // (granted by me) to authorize the inbound call; B needs a
    // `peer_delegations` row (received from peer) to know which peer
    // hub to call. In production, these are linked via the signed
    // blob exchange; the test just creates matching rows.
    const delegationId = 'del-integration-1';
    hubA.delegations.createGranted({
      delegation_id: delegationId,
      peer_verify_key: hubB.hubIdentity.publicKeyB64(),
      peer_hub_name: 'userB',
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      signature: Buffer.alloc(64),
    });
    hubB.delegations.createReceived({
      delegation_id: delegationId,
      peer_verify_key: hubA.hubIdentity.publicKeyB64(),
      peer_hub_name: 'userA',
      peer_hub_url: `http://127.0.0.1:${hubA.port}`,
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
      input_schema: JSON.stringify({ type: 'object', properties: { from: { type: 'string' } } }),
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      signature: Buffer.alloc(64),
    });

    // 1. GET /v1/tools on B returns the synthetic descriptor.
    const toolsRes = await undiciRequest(`http://127.0.0.1:${hubB.port}/v1/tools`, {
      method: 'GET',
      headers: { authorization: 'Bearer integration-token' },
    });
    expect(toolsRes.statusCode).toBe(200);
    const toolsBody = (await toolsRes.body.json()) as { tools: ToolDescriptor[] };
    const federated = toolsBody.tools.find(
      (t) => t.name === 'federated__userA__listEvents',
    );
    expect(federated).toBeDefined();
    expect(federated!.federated).toBe(true);
    expect(federated!.peer_hub_name).toBe('userA');
    expect(federated!.peer_hub_url).toBe(`http://127.0.0.1:${hubA.port}`);

    // 2. POST /v1/federation/invoke on B → round-trip → result.
    const invokeRes = await undiciRequest(`http://127.0.0.1:${hubB.port}/v1/federation/invoke`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer integration-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        tool: 'federated__userA__listEvents',
        arguments: { from: '2026-09-01', to: '2026-09-07' },
        agent_id: 'B_local_agent',
        justification: 'Schedule meeting for userA',
      }),
    });
    expect(invokeRes.statusCode).toBe(200);
    const invokeBody = (await invokeRes.body.json()) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(invokeBody.content[0]?.text).toContain('e1');

    // 3. Plugin received the args verbatim — proves the signed body made
    //    it through A's signature verification.
    expect(pluginArgsSeen).toEqual({
      tool: 'listEvents',
      args: { from: '2026-09-01', to: '2026-09-07' },
    });

    // Give A's audit-broadcast a moment to flush.
    await sleep(50);

    // 4. B-side audit: delegated_to = A_verify_key, decision_federated = federated_ok.
    const bAudit = hubB.audit.query({ user_id: 'local-user' });
    const bFed = bAudit.filter(
      (e) => e.delegated_to === hubA.hubIdentity.publicKeyB64(),
    );
    expect(bFed).toHaveLength(1);
    expect(bFed[0]!.decision_federated).toBe('federated_ok');
    expect(bFed[0]!.decision).toBe('approved');
    expect(bFed[0]!.delegated_by).toBeNull();
    expect(bFed[0]!.tool_name).toBe('listEvents');
    expect(bFed[0]!.agent_id).toBe('B_local_agent');
    expect(bFed[0]!.justification).toBe('Schedule meeting for userA');

    // 5. A-side audit: delegated_by = B_verify_key, decision = approved,
    //    decision_federated = NULL (A doesn't know about the B-side outcome
    //    — Phase 5 records this on B only).
    const aAudit = hubA.audit.query({ user_id: 'local-user' });
    const aFed = aAudit.filter(
      (e) => e.delegated_by === hubB.hubIdentity.publicKeyB64(),
    );
    expect(aFed).toHaveLength(1);
    expect(aFed[0]!.decision).toBe('approved');
    expect(aFed[0]!.decision_federated).toBeNull();
    expect(aFed[0]!.delegated_to).toBeNull();
    expect(aFed[0]!.tool_name).toBe('listEvents');
    expect(aFed[0]!.agent_id).toBe('B_local_agent');
  });
});
