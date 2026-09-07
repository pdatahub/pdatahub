/**
 * Phase 5 (Federation v2) tests — synthetic tool descriptors + B-side
 * `/v1/federation/invoke` endpoint (Momus B6, B7).
 *
 * Two layers:
 *   1. **GET /v1/tools** — synthetic descriptors emit for active
 *      `peer_delegations` rows. Filter rules (revoked/expired excluded),
 *      name format (`federated__<hub>__<tool>`), tie-break by latest
 *      `expires_at`, and `inputSchema` passthrough from the blob.
 *   2. **POST /v1/federation/invoke** — B-side flow: tool-name parsing,
 *      delegation lookup, signed request body, mocked upstream A,
 *      cross-hub audit populated on B's side.
 *
 * Upstream Hub A is mocked with a tiny HTTP server (`createServer` from
 * node:http) so we don't need a second HubServer process. The mock
 * validates the headers + body shape that B sends, then returns a
 * canned response. Cross-hub assertions live on B's side only — A's
 * inbound behavior is already covered by tests/federation-call.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createServer, type Server as HttpServer } from 'node:http';
import { request as undiciRequest } from 'undici';
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
import type { PluginProcessInfo, ToolDescriptor } from '../src/types.js';

const TEST_TOKEN = 'test-bearer-token-xyz';
const MASTER_KEY = Buffer.from('a'.repeat(64), 'hex');

/* ─── Fake plugin + registry (mirrors federation-call.test.ts) ─────────── */

function fakePlugin(opts: {
  name: string;
  tools: ToolDescriptor[];
  callToolImpl?: (toolName: string, args: Record<string, unknown>) => Promise<ToolCallResult>;
}): PluginProcess {
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

/* ─── Mock upstream Hub A ───────────────────────────────────────────────── */

interface CapturedUpstreamRequest {
  body: string;
  headers: Record<string, string>;
}

interface MockHubA {
  server: HttpServer;
  port: number;
  captured: CapturedUpstreamRequest[];
  /** Status code + body returned by the mock for the next request. */
  respondWith: (status: number, body: unknown) => void;
  stop(): Promise<void>;
}

function startMockHubA(): Promise<MockHubA> {
  return new Promise((resolve) => {
    const captured: CapturedUpstreamRequest[] = [];
    let nextResponse: { status: number; body: unknown } = {
      status: 200,
      body: { content: [{ type: 'text', text: '{"ok":true}' }] },
    };
    const server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        captured.push({
          body: data,
          headers: Object.fromEntries(
            Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : (v ?? '')]),
          ),
        });
        res.statusCode = nextResponse.status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(nextResponse.body));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('mock A did not bind');
      resolve({
        server,
        port: addr.port,
        captured,
        respondWith: (status, body) => {
          nextResponse = { status, body };
        },
        stop: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

/* ─── Harness for Hub B ────────────────────────────────────────────────── */

interface Harness {
  server: HubServer;
  port: number;
  db: Database.Database;
  hubAIdentity: HubIdentity;
  hubBIdentity: HubIdentity;
  delegations: DelegationStore;
  auditLog: AuditLog;
  approval: ApprovalStream;
  registry: FakeRegistry;
}

async function setupHarness(opts: {
  registerListEvents?: boolean;
} = {}): Promise<Harness> {
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
  const auditLog = new AuditLog(db);
  const tokens = new TokenVault(db, config.masterKey);
  const oauth = new OAuthFlow(tokens);
  const approval = new ApprovalStream({ timeoutMs: 60_000 });
  const delegations = new DelegationStore(db);
  const nonces = new NonceStore(db);

  const registry = new FakeRegistry();
  if (opts.registerListEvents !== false) {
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
      }),
    );
  }

  // A's identity — what `peer_delegations.peer_verify_key` references.
  // NOT saved to db — B's hub is the one we're running; A is just a reference.
  const hubAIdentity = HubIdentity.generate('userA', MASTER_KEY);
  // B's identity — saved to db (id=1 row in `federation_keys`), signs outbound
  // requests to A. The harness's HubServer loads this identity by default.
  const hubBIdentity = HubIdentity.generate('userB', MASTER_KEY);
  hubBIdentity.save(db);

  const server = new HubServer({
    config,
    db,
    registry,
    grants: grantStore,
    audit: auditLog,
    tokens,
    oauth,
    approval,
    clientCredentials: new Map(),
    delegations,
    nonces,
  });
  await server.start();
  const addr = server.address();
  if (!addr) throw new Error('server did not bind');
  return {
    server,
    port: addr.port,
    db,
    hubAIdentity,
    hubBIdentity,
    delegations,
    auditLog,
    approval,
    registry,
  };
}

interface PeerDelegationSeed {
  delegation_id?: string;
  peer_hub_name?: string;
  peer_hub_url: string;
  peer_verify_key?: string;
  plugin?: string;
  tool: string;
  scope?: string;
  input_schema?: string | null;
  expires_at: string;
  revoked?: boolean;
}

function seedReceivedDelegation(
  h: Harness,
  seed: PeerDelegationSeed,
): string {
  const id = seed.delegation_id ?? `del-${Math.random().toString(36).slice(2, 10)}`;
  h.delegations.createReceived({
    delegation_id: id,
    peer_verify_key: seed.peer_verify_key ?? h.hubAIdentity.publicKeyB64(),
    peer_hub_name: seed.peer_hub_name ?? 'userA',
    peer_hub_url: seed.peer_hub_url,
    plugin: seed.plugin ?? 'google-calendar',
    tool: seed.tool,
    scope: seed.scope ?? 'calendar:read',
    input_schema:
      seed.input_schema !== undefined
        ? seed.input_schema
        : JSON.stringify({ type: 'object', properties: {} }),
    expires_at: seed.expires_at,
    signature: Buffer.alloc(64),
  });
  if (seed.revoked) h.delegations.revokeReceived(id);
  return id;
}

interface HttpResult {
  status: number;
  body: unknown;
}

async function get(h: Harness, path: string, headers: Record<string, string> = {}): Promise<HttpResult> {
  const res = await undiciRequest(`http://127.0.0.1:${h.port}${path}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${TEST_TOKEN}`, ...headers },
  });
  const text = await res.body.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep as text */
  }
  return { status: res.statusCode, body: parsed };
}

async function post(
  h: Harness,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  const res = await undiciRequest(`http://127.0.0.1:${h.port}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.body.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep as text */
  }
  return { status: res.statusCode, body: parsed };
}

/* ─── GET /v1/tools — synthetic descriptors ────────────────────────────── */

describe('GET /v1/tools — synthetic federated descriptors (Phase 5, Momus B7)', () => {
  let h: Harness;
  const originalToken = process.env.HUB_API_TOKEN;

  beforeEach(async () => {
    process.env.HUB_API_TOKEN = TEST_TOKEN;
    h = await setupHarness();
  });

  afterEach(async () => {
    await h.server.stop();
    h.db.close();
    if (originalToken === undefined) delete process.env.HUB_API_TOKEN;
    else process.env.HUB_API_TOKEN = originalToken;
  });

  it('returns local tools when no peer_delegations exist', async () => {
    const res = await get(h, '/v1/tools');
    expect(res.status).toBe(200);
    const tools = (res.body as { tools: ToolDescriptor[] }).tools;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('listEvents');
    expect(tools[0]?.federated).toBeUndefined();
  });

  it('emits a synthetic descriptor with federated__<hub>__<tool> name for an active peer_delegation', async () => {
    seedReceivedDelegation(h, {
      peer_hub_name: 'userA',
      peer_hub_url: 'http://userA.tail:8080',
      tool: 'listEvents',
      input_schema: JSON.stringify({
        type: 'object',
        properties: { from: { type: 'string' } },
      }),
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    const res = await get(h, '/v1/tools');
    expect(res.status).toBe(200);
    const tools = (res.body as { tools: ToolDescriptor[] }).tools;
    const federated = tools.find((t) => t.name.startsWith('federated__'));
    expect(federated).toBeDefined();
    expect(federated!.name).toBe('federated__userA__listEvents');
    expect(federated!.federated).toBe(true);
    expect(federated!.peer_hub_name).toBe('userA');
    expect(federated!.peer_hub_url).toBe('http://userA.tail:8080');
    expect(federated!.inputSchema).toEqual({
      type: 'object',
      properties: { from: { type: 'string' } },
    });
  });

  it('omits revoked peer_delegations', async () => {
    seedReceivedDelegation(h, {
      peer_hub_name: 'userA',
      peer_hub_url: 'http://userA:8080',
      tool: 'listEvents',
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      revoked: true,
    });
    const res = await get(h, '/v1/tools');
    const tools = (res.body as { tools: ToolDescriptor[] }).tools;
    expect(tools.find((t) => t.name.startsWith('federated__'))).toBeUndefined();
  });

  it('omits expired peer_delegations', async () => {
    seedReceivedDelegation(h, {
      peer_hub_name: 'userA',
      peer_hub_url: 'http://userA:8080',
      tool: 'listEvents',
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const res = await get(h, '/v1/tools');
    const tools = (res.body as { tools: ToolDescriptor[] }).tools;
    expect(tools.find((t) => t.name.startsWith('federated__'))).toBeUndefined();
  });

  it('tie-breaks multiple delegations for the same (hub, tool) by latest expires_at (Momus Q4)', async () => {
    const earlier = new Date(Date.now() + 30 * 60_000).toISOString();
    const later = new Date(Date.now() + 60 * 60_000).toISOString();
    // Seed LATER first to ensure ORDER BY expires_at DESC is actually doing the work.
    seedReceivedDelegation(h, {
      delegation_id: 'del-later',
      peer_hub_name: 'userA',
      peer_hub_url: 'http://userA-LATER:8080',
      tool: 'listEvents',
      expires_at: later,
    });
    seedReceivedDelegation(h, {
      delegation_id: 'del-earlier',
      peer_hub_name: 'userA',
      peer_hub_url: 'http://userA-EARLIER:8080',
      tool: 'listEvents',
      expires_at: earlier,
    });
    const res = await get(h, '/v1/tools');
    const tools = (res.body as { tools: ToolDescriptor[] }).tools;
    const federated = tools.filter((t) => t.name.startsWith('federated__'));
    expect(federated).toHaveLength(1);
    expect(federated[0]!.delegation_id).toBe('del-later');
    expect(federated[0]!.peer_hub_url).toBe('http://userA-LATER:8080');
  });

  it('emits one descriptor per unique (hub, tool) tuple', async () => {
    seedReceivedDelegation(h, {
      delegation_id: 'del-1',
      peer_hub_name: 'userA',
      peer_hub_url: 'http://userA:8080',
      tool: 'listEvents',
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    seedReceivedDelegation(h, {
      delegation_id: 'del-2',
      peer_hub_name: 'userB',
      peer_hub_url: 'http://userB:8080',
      tool: 'sendMessage',
      plugin: 'messenger',
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    const res = await get(h, '/v1/tools');
    const tools = (res.body as { tools: ToolDescriptor[] }).tools;
    const federated = tools.filter((t) => t.name.startsWith('federated__'));
    expect(federated.map((t) => t.name).sort()).toEqual([
      'federated__userA__listEvents',
      'federated__userB__sendMessage',
    ]);
  });

  it('falls back to null inputSchema when peer_delegation has no input_schema', async () => {
    seedReceivedDelegation(h, {
      peer_hub_name: 'userA',
      peer_hub_url: 'http://userA:8080',
      tool: 'listEvents',
      input_schema: null,
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    const res = await get(h, '/v1/tools');
    const tools = (res.body as { tools: ToolDescriptor[] }).tools;
    const federated = tools.find((t) => t.name.startsWith('federated__'))!;
    expect(federated.inputSchema).toBeNull();
  });

  it('returns [] synthetic descriptors when DelegationStore is not wired', async () => {
    // Spin up a hub with delegations: undefined (matches "no federation"
    // deployment, e.g. dev mode without init).
    const db = new Database(':memory:');
    runMigrations(db);
    const config = loadConfig([
      '--port', '0',
      '--host', '127.0.0.1',
      '--master-key', 'a'.repeat(64),
      '--plugins-dir', '/tmp/nonexistent-plugins',
    ]);
    const grantStore = new GrantStore(db);
    const auditLog = new AuditLog(db);
    const tokens = new TokenVault(db, config.masterKey);
    const oauth = new OAuthFlow(tokens);
    const approval = new ApprovalStream({ timeoutMs: 60_000 });
    const nonces = new NonceStore(db);

    const registry = new FakeRegistry();
    registry.add(
      fakePlugin({
        name: 'google-calendar',
        tools: [
          {
            name: 'listEvents',
            description: 'List events',
            inputSchema: {},
            scope: 'calendar:read',
            plugin: 'google-calendar',
          },
        ],
      }),
    );

    const server = new HubServer({
      config,
      db,
      registry,
      grants: grantStore,
      audit: auditLog,
      tokens,
      oauth,
      approval,
      clientCredentials: new Map(),
      // delegations intentionally omitted
      nonces,
    });
    await server.start();
    try {
      const addr = server.address();
      const res = await undiciRequest(`http://127.0.0.1:${addr!.port}/v1/tools`, {
        method: 'GET',
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      const body = (await res.body.json()) as { tools: ToolDescriptor[] };
      expect(res.statusCode).toBe(200);
      expect(body.tools.every((t) => !t.federated)).toBe(true);
    } finally {
      await server.stop();
      db.close();
    }
  });
});

/* ─── POST /v1/federation/invoke — B-side endpoint ─────────────────────── */

describe('POST /v1/federation/invoke — B-side endpoint (Phase 5, Momus B6)', () => {
  let h: Harness;
  let mockA: MockHubA;
  const originalToken = process.env.HUB_API_TOKEN;

  beforeEach(async () => {
    process.env.HUB_API_TOKEN = TEST_TOKEN;
    h = await setupHarness({ registerListEvents: false });
    mockA = await startMockHubA();
  });

  afterEach(async () => {
    await mockA.stop();
    await h.server.stop();
    h.db.close();
    if (originalToken === undefined) delete process.env.HUB_API_TOKEN;
    else process.env.HUB_API_TOKEN = originalToken;
  });

  it('rejects malformed tool name with 400 INVALID_FEDERATED_NAME', async () => {
    seedReceivedDelegation(h, {
      peer_hub_name: 'userA',
      peer_hub_url: `http://127.0.0.1:${mockA.port}`,
      tool: 'listEvents',
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    const res = await post(h, '/v1/federation/invoke', {
      tool: 'notFederatedPrefix',
      arguments: {},
      agent_id: 'agent-1',
    });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('INVALID_FEDERATED_NAME');
    expect(mockA.captured).toHaveLength(0);
  });

  it('returns 404 DELEGATION_NOT_FOUND when no peer_delegation matches', async () => {
    const res = await post(h, '/v1/federation/invoke', {
      tool: 'federated__userA__listEvents',
      arguments: {},
      agent_id: 'agent-1',
    });
    expect(res.status).toBe(404);
    expect((res.body as { code: string }).code).toBe('DELEGATION_NOT_FOUND');
    expect(mockA.captured).toHaveLength(0);
  });

  it('returns 404 DELEGATION_NOT_FOUND for locally revoked peer_delegation', async () => {
    // `peer_delegations.revoked = 1` is filtered at the SQL layer by
    // DelegationStore.findReceivedMatch — B's hub sees no delegation, not
    // a revoked-but-present one. A's revocation of a delegation B doesn't
    // know about yet is covered by the `A returns 403 → federated_denied`
    // path in another test below.
    seedReceivedDelegation(h, {
      peer_hub_name: 'userA',
      peer_hub_url: `http://127.0.0.1:${mockA.port}`,
      tool: 'listEvents',
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      revoked: true,
    });
    const res = await post(h, '/v1/federation/invoke', {
      tool: 'federated__userA__listEvents',
      arguments: {},
      agent_id: 'agent-1',
    });
    expect(res.status).toBe(404);
    expect((res.body as { code: string }).code).toBe('DELEGATION_NOT_FOUND');
    expect(mockA.captured).toHaveLength(0);
  });

  it('returns 404 DELEGATION_NOT_FOUND for expired peer_delegation', async () => {
    // Same as the revoked case — `expires_at <= now` is filtered at the SQL
    // layer. The DELEGATION_EXPIRED code is only meaningful from A's hub
    // (Phase 3); B just sees "no active delegation for this tool".
    seedReceivedDelegation(h, {
      peer_hub_name: 'userA',
      peer_hub_url: `http://127.0.0.1:${mockA.port}`,
      tool: 'listEvents',
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const res = await post(h, '/v1/federation/invoke', {
      tool: 'federated__userA__listEvents',
      arguments: {},
      agent_id: 'agent-1',
    });
    expect(res.status).toBe(404);
    expect((res.body as { code: string }).code).toBe('DELEGATION_NOT_FOUND');
    expect(mockA.captured).toHaveLength(0);
  });

  it('signs and POSTs to A on success; writes B-side audit with delegated_to = A_verify_key', async () => {
    seedReceivedDelegation(h, {
      peer_hub_name: 'userA',
      peer_hub_url: `http://127.0.0.1:${mockA.port}`,
      tool: 'listEvents',
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    mockA.respondWith(200, {
      content: [{ type: 'text', text: '{"events":[{"id":"e1"}]}' }],
      isError: false,
    });
    const res = await post(h, '/v1/federation/invoke', {
      tool: 'federated__userA__listEvents',
      arguments: { from: '2026-09-01' },
      agent_id: 'B_local_agent',
      justification: 'Read A\'s calendar',
    });
    expect(res.status).toBe(200);
    expect((res.body as { content: Array<{ text: string }> }).content[0]?.text).toContain('e1');

    expect(mockA.captured).toHaveLength(1);
    const captured = mockA.captured[0]!;
    // Headers — B's identity proves the signing_key matches hubBIdentity.
    expect(captured.headers['x-federation-pubkey']).toBe(h.hubBIdentity.publicKeyB64());
    expect(captured.headers['x-federation-signature']).toMatch(/^[A-Za-z0-9_-]+$/);
    // Verify the signature against the exact bytes sent.
    const bodyBytes = new TextEncoder().encode(captured.body);
    const sigBytes = Buffer.from(captured.headers['x-federation-signature']!, 'base64url');
    expect(HubIdentity.verify(bodyBytes, new Uint8Array(sigBytes), h.hubBIdentity.publicKey)).toBe(true);

    // Body shape.
    const sent = JSON.parse(captured.body) as Record<string, unknown>;
    expect(sent['tool']).toBe('listEvents');
    expect(sent['agent_id']).toBe('B_local_agent');
    expect(sent['arguments']).toEqual({ from: '2026-09-01' });
    expect(typeof sent['request_id']).toBe('string');
    expect((sent['request_id'] as string).length).toBeGreaterThanOrEqual(8);
    expect(typeof sent['timestamp']).toBe('string');
    expect(sent['justification']).toBe('Read A\'s calendar');

    // B-side audit: delegated_to = A_verify_key, decision_federated = federated_ok.
    const audit = h.auditLog.query({ user_id: 'local-user' });
    const fed = audit.filter((e) => e.delegated_to === h.hubAIdentity.publicKeyB64());
    expect(fed).toHaveLength(1);
    expect(fed[0]!.decision_federated).toBe('federated_ok');
    expect(fed[0]!.decision).toBe('approved');
    expect(fed[0]!.tool_name).toBe('listEvents');
    expect(fed[0]!.delegated_by).toBeNull();
  });

  it('records federated_denied on B-side when A returns 403', async () => {
    seedReceivedDelegation(h, {
      peer_hub_name: 'userA',
      peer_hub_url: `http://127.0.0.1:${mockA.port}`,
      tool: 'listEvents',
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    mockA.respondWith(403, {
      error: 'approval denied',
      code: 'APPROVAL_DENIED',
    });
    const res = await post(h, '/v1/federation/invoke', {
      tool: 'federated__userA__listEvents',
      arguments: {},
      agent_id: 'agent-1',
    });
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe('APPROVAL_DENIED');

    const audit = h.auditLog.query({ user_id: 'local-user' });
    const fed = audit.filter((e) => e.delegated_to === h.hubAIdentity.publicKeyB64());
    expect(fed).toHaveLength(1);
    expect(fed[0]!.decision_federated).toBe('federated_denied');
  });

  it('records federated_error on B-side when A returns 5xx', async () => {
    seedReceivedDelegation(h, {
      peer_hub_name: 'userA',
      peer_hub_url: `http://127.0.0.1:${mockA.port}`,
      tool: 'listEvents',
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    mockA.respondWith(503, { error: 'no approver connected', code: 'NO_APPROVER_CONNECTED' });
    const res = await post(h, '/v1/federation/invoke', {
      tool: 'federated__userA__listEvents',
      arguments: {},
      agent_id: 'agent-1',
    });
    expect(res.status).toBe(503);

    const audit = h.auditLog.query({ user_id: 'local-user' });
    const fed = audit.filter((e) => e.delegated_to === h.hubAIdentity.publicKeyB64());
    expect(fed).toHaveLength(1);
    expect(fed[0]!.decision_federated).toBe('federated_error');
  });

  it('returns 502 FEDERATION_UPSTREAM_ERROR when A is unreachable', async () => {
    seedReceivedDelegation(h, {
      peer_hub_name: 'userA',
      peer_hub_url: 'http://127.0.0.1:1', // closed port
      tool: 'listEvents',
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    const res = await post(h, '/v1/federation/invoke', {
      tool: 'federated__userA__listEvents',
      arguments: {},
      agent_id: 'agent-1',
    });
    expect(res.status).toBe(502);
    expect((res.body as { code: string }).code).toBe('FEDERATION_UPSTREAM_ERROR');

    const audit = h.auditLog.query({ user_id: 'local-user' });
    const fed = audit.filter((e) => e.delegated_to === h.hubAIdentity.publicKeyB64());
    expect(fed).toHaveLength(1);
    expect(fed[0]!.decision_federated).toBe('federated_error');
    expect(fed[0]!.error).toMatch(/unreachable/i);
  });

  it('tie-break: latest expires_at wins when multiple delegations match', async () => {
    seedReceivedDelegation(h, {
      delegation_id: 'del-earlier',
      peer_hub_name: 'userA',
      peer_hub_url: `http://127.0.0.1:${mockA.port}`,
      tool: 'listEvents',
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    seedReceivedDelegation(h, {
      delegation_id: 'del-later',
      peer_hub_name: 'userA',
      peer_hub_url: `http://127.0.0.1:${mockA.port}`,
      tool: 'listEvents',
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    mockA.respondWith(200, { content: [{ type: 'text', text: '{}' }] });
    const res = await post(h, '/v1/federation/invoke', {
      tool: 'federated__userA__listEvents',
      arguments: {},
      agent_id: 'agent-1',
    });
    expect(res.status).toBe(200);
    expect(mockA.captured).toHaveLength(1);
    const sent = JSON.parse(mockA.captured[0]!.body) as Record<string, unknown>;
    expect(sent['delegation_id']).toBe('del-later');
  });

  it('requires authentication (Bearer)', async () => {
    const res = await undiciRequest(`http://127.0.0.1:${h.port}/v1/federation/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'federated__userA__listEvents', arguments: {} }),
    });
    expect(res.statusCode).toBe(401);
  });
});
