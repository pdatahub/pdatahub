/**
 * Phase 8b (Federation v2) — adversarial two-hub pass.
 *
 * Phase 3 (`federation-call.test.ts`) covers the single-hub rejection
 * suite for `/v1/federation/call` — bad signature, unknown delegation,
 * revoked, expired, wrong peer, wrong tool, clock skew, replayed
 * request_id, no approver, denied, rate-limit. Phase 8b extends that
 * surface with the **cross-process / two-hub** dimension: B signs and
 * sends through a real `/v1/federation/invoke` call to A's
 * `/v1/federation/call`, and we verify both hubs' audit chains end up
 * in the right state.
 *
 * Scenarios:
 *   1. End-to-end revoked-delegation cleanup
 *   2. Expired delegation (1-second TTL, wait, call → 403)
 *   3. Clock skew (-10 min timestamp → 401)
 *   4. Replay across processes (same request_id twice → 409)
 *   5. Rate-limit boundary (10 succeed, 11th → 429)
 *   6. No approver connected (0 clients → fast 503, not 60s timeout)
 *   7. Cross-hub audit consistency (delegated_by / delegated_to /
 *      decision_federated on both sides after success)
 *
 * Most scenarios go through B's `/v1/federation/invoke` so we exercise
 * the real outbound signer (Phase 5). For clock skew + replay we have
 * to bypass B's `/v1/federation/invoke` (which always generates a fresh
 * `request_id` + `timestamp`) and sign raw requests directly against
 * A's `/v1/federation/call` — same wire format B would produce.
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
const HUB_API_TOKEN = 'adversarial-token-8b';

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

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
  const callTool =
    opts.callToolImpl ??
    (async () => ({ content: [{ type: 'text', text: '{"events":[]}' }] }));
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
}

async function startHubSide(opts: {
  hubName: string;
  approvalTimeoutMs?: number;
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
  const approval = new ApprovalStream({
    timeoutMs: opts.approvalTimeoutMs ?? 60_000,
  });
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

function seedPair(hubA: HubSide, hubB: HubSide, opts: {
  delegationId: string;
  plugin?: string;
  tool?: string;
  scope?: string;
  expiresAt?: string;
}): void {
  const plugin = opts.plugin ?? 'google-calendar';
  const tool = opts.tool ?? 'listEvents';
  const scope = opts.scope ?? 'calendar:read';
  const expiresAt = opts.expiresAt ?? new Date(Date.now() + 60 * 60_000).toISOString();

  hubA.delegations.createGranted({
    delegation_id: opts.delegationId,
    peer_verify_key: hubB.hubIdentity.publicKeyB64(),
    peer_hub_name: 'userB',
    plugin,
    tool,
    scope,
    expires_at: expiresAt,
    signature: Buffer.alloc(64),
  });
  hubB.delegations.createReceived({
    delegation_id: opts.delegationId,
    peer_verify_key: hubA.hubIdentity.publicKeyB64(),
    peer_hub_name: 'userA',
    peer_hub_url: `http://127.0.0.1:${hubA.port}`,
    plugin,
    tool,
    scope,
    input_schema: JSON.stringify({ type: 'object', properties: {} }),
    expires_at: expiresAt,
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
  connectApprover?: boolean;
  approvalTimeoutMs?: number;
  callToolImpl?: FakePluginOpts['callToolImpl'];
} = {}): Promise<Harness> {
  process.env.HUB_API_TOKEN = HUB_API_TOKEN;

  const hubA = await startHubSide({
    hubName: 'userA',
    ...(opts.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: opts.approvalTimeoutMs } : {}),
    ...(opts.callToolImpl ? { callToolImpl: opts.callToolImpl } : {}),
  });
  const hubB = await startHubSide({ hubName: 'userB' });

  let approver: WebSocket | null = null;
  if (opts.connectApprover !== false) {
    approver = new WebSocket(`ws://127.0.0.1:${hubA.port}/approval-stream`);
    approver.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8')) as {
        type?: string;
        request_id?: string;
      };
      if (msg.type === 'approval_request' && typeof msg.request_id === 'string') {
        approver!.send(
          JSON.stringify({
            type: 'approval_decided',
            request_id: msg.request_id,
            decision: 'approved',
          }),
        );
      }
    });
    await new Promise<void>((r) => approver!.once('open', () => r()));
  }

  return { hubA, hubB, approver: approver! };
}

async function teardownHarness(h: Harness): Promise<void> {
  if (h.approver) h.approver.close();
  await h.hubA.server.stop();
  await h.hubB.server.stop();
  h.hubA.db.close();
  h.hubB.db.close();
}

async function invokeFederated(
  h: Harness,
  opts: { agentId?: string; tool?: string; arguments?: Record<string, unknown> } = {},
): Promise<{ status: number; body: unknown }> {
  const res = await undiciRequest(`http://127.0.0.1:${h.hubB.port}/v1/federation/invoke`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${HUB_API_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      tool: opts.tool ?? 'federated__userA__listEvents',
      arguments: opts.arguments ?? {},
      agent_id: opts.agentId ?? 'B_local_agent',
    }),
  });
  let parsed: unknown = null;
  try {
    parsed = await res.body.json();
  } catch {
    parsed = null;
  }
  return { status: res.statusCode, body: parsed };
}

/* ─── Scenario 1: end-to-end revoked-delegation cleanup ───────────────── */

describe('Scenario 1 — A revokes, B\'s next call → 403 across hubs', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setupHarness();
  });

  afterEach(async () => {
    await teardownHarness(h);
  });

  it('A revokes, B\'s call fails 403, B\'s audit records federated_denied', async () => {
    seedPair(h.hubA, h.hubB, { delegationId: 'del-8b-1' });

    // 1. First call succeeds.
    const first = await invokeFederated(h);
    expect(first.status).toBe(200);

    // 2. A revokes the delegation (A-side state change).
    expect(h.hubA.delegations.revokeGranted('del-8b-1')).toBe(true);

    // 3. B's next call should fail.
    const second = await invokeFederated(h);
    expect(second.status).toBe(403);
    expect((second.body as { code?: string }).code).toBe('DELEGATION_REVOKED');

    await sleep(50);

    // 4. Cross-hub audit chain:
    //    - A logs the rejection (decision=denied, decision_federated=null)
    //    - B logs federated_denied with delegated_to = A_verify_key
    const aAudit = h.hubA.audit.query({ user_id: 'local-user' });
    const aRejected = aAudit.filter(
      (e) => e.delegated_by === h.hubB.hubIdentity.publicKeyB64() && e.decision === 'denied',
    );
    expect(aRejected).toHaveLength(1);
    expect(aRejected[0]!.decision_federated).toBeNull();

    const bAudit = h.hubB.audit.query({ user_id: 'local-user' });
    const bDenied = bAudit.filter(
      (e) => e.delegated_to === h.hubA.hubIdentity.publicKeyB64(),
    );
    expect(bDenied).toHaveLength(2);
    const deniedRow = bDenied.find((e) => e.decision_federated === 'federated_denied');
    expect(deniedRow).toBeDefined();
    expect(deniedRow!.decision).toBe('denied');
  });
});

/* ─── Scenario 2: expired delegation ──────────────────────────────────── */

describe('Scenario 2 — 1-second TTL delegation, wait, call → 403 EXPIRED', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setupHarness();
  });

  afterEach(async () => {
    await teardownHarness(h);
  });

  it('B\'s call after expiry → 403 DELEGATION_EXPIRED + federated_denied on B', async () => {
    seedPair(h.hubA, h.hubB, {
      delegationId: 'del-8b-2',
      expiresAt: new Date(Date.now() + 1_000).toISOString(),
    });

    // Wait for expiry (1s TTL + 200ms buffer for clock granularity).
    await sleep(1_200);

    const res = await invokeFederated(h);
    expect(res.status).toBe(403);
    expect((res.body as { code?: string }).code).toBe('DELEGATION_EXPIRED');

    await sleep(50);

    const bAudit = h.hubB.audit.query({ user_id: 'local-user' });
    const bDenied = bAudit.filter(
      (e) =>
        e.delegated_to === h.hubA.hubIdentity.publicKeyB64() &&
        e.decision_federated === 'federated_denied',
    );
    expect(bDenied).toHaveLength(1);
    expect(bDenied[0]!.error).toMatch(/expired/i);
  });
});

/* ─── Scenario 3: clock skew ──────────────────────────────────────────── */

describe('Scenario 3 — clock skew (timestamp -10min) → 401', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setupHarness();
  });

  afterEach(async () => {
    await teardownHarness(h);
  });

  it('signed request with stale timestamp → 401 CLOCK_SKEW', async () => {
    seedPair(h.hubA, h.hubB, { delegationId: 'del-8b-3' });

    // We bypass /v1/federation/invoke (which auto-generates fresh timestamp)
    // and craft a raw signed request with a -10min timestamp.
    const body = {
      delegation_id: 'del-8b-3',
      tool: 'listEvents',
      arguments: {},
      agent_id: 'B_local_agent',
      request_id: 'r-skew-1',
      timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
    };
    const canonical = JSON.stringify(body);
    const sig = h.hubB.hubIdentity.sign(new TextEncoder().encode(canonical));
    const res = await undiciRequest(`http://127.0.0.1:${h.hubA.port}/v1/federation/call`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-federation-pubkey': h.hubB.hubIdentity.publicKeyB64(),
        'x-federation-signature': bytesToBase64Url(sig),
      },
      body: canonical,
    });
    expect(res.statusCode).toBe(401);
    const json = (await res.body.json()) as { code: string };
    expect(json.code).toBe('CLOCK_SKEW');
  });
});

/* ─── Scenario 4: replay across processes ─────────────────────────────── */

describe('Scenario 4 — replayed request_id across hubs → 409', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setupHarness();
  });

  afterEach(async () => {
    await teardownHarness(h);
  });

  it('first call 200, same request_id replayed → 409 REPLAY', async () => {
    seedPair(h.hubA, h.hubB, { delegationId: 'del-8b-4' });

    const sharedRequestId = 'r-replay-8b-4';

    // First call — sign directly so we control request_id.
    const first = async () => {
      const body = {
        delegation_id: 'del-8b-4',
        tool: 'listEvents',
        arguments: {},
        agent_id: 'B_local_agent',
        request_id: sharedRequestId,
        timestamp: new Date().toISOString(),
      };
      const canonical = JSON.stringify(body);
      const sig = h.hubB.hubIdentity.sign(new TextEncoder().encode(canonical));
      return undiciRequest(`http://127.0.0.1:${h.hubA.port}/v1/federation/call`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-federation-pubkey': h.hubB.hubIdentity.publicKeyB64(),
          'x-federation-signature': bytesToBase64Url(sig),
        },
        body: canonical,
      });
    };

    const r1 = await first();
    expect(r1.statusCode).toBe(200);
    await r1.body.text();

    // Second call with same request_id but fresh timestamp.
    const r2 = await first();
    expect(r2.statusCode).toBe(409);
    const j2 = (await r2.body.json()) as { code: string };
    expect(j2.code).toBe('REPLAY');
  });
});

/* ─── Scenario 5: rate-limit boundary ─────────────────────────────────── */

describe('Scenario 5 — 10 calls succeed, 11th returns 429', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setupHarness();
  });

  afterEach(async () => {
    await teardownHarness(h);
  });

  it('11th call in <60s for same (peer, agent) → 429 RATE_LIMIT', async () => {
    seedPair(h.hubA, h.hubB, { delegationId: 'del-8b-5' });

    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await invokeFederated(h, { agentId: 'B_local_agent' });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

/* ─── Scenario 6: no approver → fast 503 ──────────────────────────────── */

describe('Scenario 6 — 0 clients on /approval-stream → fast 503', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setupHarness({ connectApprover: false });
  });

  afterEach(async () => {
    await teardownHarness(h);
  });

  it('returns 503 NO_APPROVER_CONNECTED in <400ms (not 60s timeout)', async () => {
    seedPair(h.hubA, h.hubB, { delegationId: 'del-8b-6' });

    const startedAt = Date.now();
    const res = await invokeFederated(h);
    const elapsed = Date.now() - startedAt;

    expect(res.status).toBe(503);
    expect((res.body as { code?: string }).code).toBe('NO_APPROVER_CONNECTED');
    expect(elapsed).toBeLessThan(400);

    await sleep(50);

    const bAudit = h.hubB.audit.query({ user_id: 'local-user' });
    const bErr = bAudit.filter(
      (e) =>
        e.delegated_to === h.hubA.hubIdentity.publicKeyB64() &&
        e.decision_federated === 'federated_error',
    );
    expect(bErr).toHaveLength(1);
  });
});

/* ─── Scenario 7: cross-hub audit consistency ─────────────────────────── */

describe('Scenario 7 — cross-hub audit consistency after success', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setupHarness();
  });

  afterEach(async () => {
    await teardownHarness(h);
  });

  it('A: delegated_by=B_pub, decision=approved; B: delegated_to=A_pub, decision_federated=federated_ok', async () => {
    seedPair(h.hubA, h.hubB, {
      delegationId: 'del-8b-7',
      tool: 'listEvents',
    });

    const res = await invokeFederated(h, { agentId: 'B_local_agent' });
    expect(res.status).toBe(200);

    await sleep(50);

    const aAudit = h.hubA.audit.query({ user_id: 'local-user' });
    const aFed = aAudit.filter(
      (e) => e.delegated_by === h.hubB.hubIdentity.publicKeyB64(),
    );
    expect(aFed).toHaveLength(1);
    expect(aFed[0]!.tool_name).toBe('listEvents');
    expect(aFed[0]!.decision).toBe('approved');
    expect(aFed[0]!.decision_federated).toBeNull();
    expect(aFed[0]!.delegated_to).toBeNull();
    expect(aFed[0]!.agent_id).toBe('B_local_agent');

    const bAudit = h.hubB.audit.query({ user_id: 'local-user' });
    const bFed = bAudit.filter(
      (e) => e.delegated_to === h.hubA.hubIdentity.publicKeyB64(),
    );
    expect(bFed).toHaveLength(1);
    expect(bFed[0]!.tool_name).toBe('listEvents');
    expect(bFed[0]!.decision_federated).toBe('federated_ok');
    expect(bFed[0]!.decision).toBe('approved');
    expect(bFed[0]!.delegated_by).toBeNull();
    expect(bFed[0]!.agent_id).toBe('B_local_agent');

    // The federated grant created on A has delegated_by = B_pub (Momus C1).
    const grant = h.hubA.grantStore.getById(aFed[0]!.grant_id!);
    expect(grant?.delegated_by).toBe(h.hubB.hubIdentity.publicKeyB64());
  });
});
