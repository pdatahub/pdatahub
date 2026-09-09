/**
 * `POST /v1/federation/call` tests — Phase 3 (Federation v2).
 *
 * Two layers of coverage:
 *   1. **Rejection suite** (one row per design-doc failure mode) — bad
 *      signature, unknown delegation, revoked, expired, wrong peer,
 *      wrong tool, past/future clock skew, replayed request_id, no
 *      approver connected, denied, rate-limit.
 *   2. **Happy path integration** — full B→A signed call, mocked
 *      approval auto-approve, plugin invoked, result returned, cross-hub
 *      audit log rows verified.
 *
 * Helpers:
 *   - `fakePlugin(...)` — a PluginProcess-shaped stub with controllable
 *     `getInfo()` and `callTool()`. Avoids spawning a real subprocess.
 *   - `FakeRegistry` — a PluginRegistry that serves only the fake
 *     plugin, so `getPlugin(toolName)` resolves during the handler.
 *   - `signFederationCall(...)` — builds and signs a complete request
 *     body the way B's hub-core will in Phase 5.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { request as undiciRequest } from 'undici';
import { WebSocket } from 'ws';
import { HubServer } from '../src/server.js';
import { GrantStore } from '../src/grant-store.js';
import { AuditLog } from '../src/audit-log.js';
import { TokenVault } from '../src/token-vault.js';
import { OAuthFlow } from '../src/oauth-flow.js';
import { ApprovalStream } from '../src/approval-stream.js';
import { PluginRegistry, type PluginProcess, type ToolCallResult } from '../src/plugin-process.js';
import { loadConfig } from '../src/config.js';
import { runMigrations } from '../src/migrations.js';
import { HubIdentity } from '../src/federation/identity.js';
import { DelegationStore } from '../src/federation/delegation.js';
import { NonceStore } from '../src/federation/nonces.js';
import type { PluginProcessInfo, ToolDescriptor } from '../src/types.js';

const TEST_TOKEN = 'test-bearer-token-xyz';
const MASTER_KEY = Buffer.from('a'.repeat(64), 'hex');

/* ─── Fake plugin + registry ──────────────────────────────────────────── */

interface FakePluginOpts {
  name: string;
  tools: ToolDescriptor[];
  callToolImpl?: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<ToolCallResult>;
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
  const callTool = opts.callToolImpl ?? (async () => ({
    content: [{ type: 'text', text: '{"events":[]}' }],
  }));
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

/* ─── Federation call request builder ─────────────────────────────────── */

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function bytesToBase64UrlString(s: string): string {
  return bytesToBase64Url(new TextEncoder().encode(s));
}

interface FederationCallBody {
  delegation_id: string;
  tool: string;
  arguments: Record<string, unknown>;
  agent_id: string;
  request_id: string;
  timestamp: string;
  justification?: string | null;
}

function signFederationCall(
  signer: HubIdentity,
  body: FederationCallBody,
): { raw: string; headers: Record<string, string> } {
  const canonical = JSON.stringify(body);
  const sigBytes = signer.sign(new TextEncoder().encode(canonical));
  return {
    raw: canonical,
    headers: {
      'x-federation-pubkey': signer.publicKeyB64(),
      'x-federation-signature': bytesToBase64Url(sigBytes),
    },
  };
}

/* ─── Test harness ────────────────────────────────────────────────────── */

interface Harness {
  server: HubServer;
  port: number;
  db: Database.Database;
  hubAIdentity: HubIdentity;
  hubBIdentity: HubIdentity;
  delegations: DelegationStore;
  nonces: NonceStore;
  grantStore: GrantStore;
  auditLog: AuditLog;
  approval: ApprovalStream;
  registry: FakeRegistry;
}

async function setupHarness(opts: {
  approvalTimeoutMs?: number;
  registerListEvents?: boolean;
  callToolImpl?: FakePluginOpts['callToolImpl'];
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
  const approval = new ApprovalStream({ timeoutMs: opts.approvalTimeoutMs ?? 60_000 });
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
        ...(opts.callToolImpl ? { callToolImpl: opts.callToolImpl } : {}),
      }),
    );
    // T-PERSISTENT-001 mitigation #2 — the server's call path now calls
    // `TokenVault.getAccessToken()` which throws on not_found. Pre-seed
    // a token so the plugin actually runs and the federation tests can
    // exercise the cross-hub audit + approval flow.
    tokens.store({
      plugin: 'google-calendar',
      access_token: 'fake-federation-token',
      scope: 'calendar:read',
    });
  }

  // A's hub identity — used to issue the delegation.
  const hubAIdentity = HubIdentity.generate('userA', MASTER_KEY);
  hubAIdentity.save(db);
  // B's hub identity — used to sign inbound requests.
  const hubBIdentity = HubIdentity.generate('userB', MASTER_KEY);

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
    nonces,
    grantStore,
    auditLog,
    approval,
    registry,
  };
}

/**
 * Create a valid active delegation from A → B for `listEvents`.
 * Returns the `delegation_id` for inclusion in the request body.
 */
function seedDelegation(h: Harness, overrides: Partial<{
  tool: string;
  expiresAt: string;
  revoked: boolean;
  peerVerifyKey: string;
}> = {}): string {
  const id = h.delegations.createGranted({
    peer_verify_key: overrides.peerVerifyKey ?? h.hubBIdentity.publicKeyB64(),
    peer_hub_name: 'userB',
    plugin: 'google-calendar',
    tool: overrides.tool ?? 'listEvents',
    scope: 'calendar:read',
    expires_at: overrides.expiresAt ?? new Date(Date.now() + 60 * 60_000).toISOString(),
    signature: Buffer.alloc(64),
  });
  if (overrides.revoked) {
    h.delegations.revokeGranted(id);
  }
  return id;
}

interface CallResult {
  status: number;
  body: unknown;
}

async function postFederationCall(
  h: Harness,
  body: FederationCallBody,
  headers: Record<string, string> = {},
): Promise<CallResult> {
  const signed = signFederationCall(h.hubBIdentity, body);
  const res = await undiciRequest(`http://127.0.0.1:${h.port}/v1/federation/call`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...signed.headers,
      ...headers,
    },
    body: signed.raw,
  });
  const text = await res.body.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep as text
  }
  return { status: res.statusCode, body: parsed };
}

/**
 * Open a WebSocket to `/approval-stream` and auto-approve (or auto-deny)
 * every incoming `approval_request` based on `decide`. Resolves the
 * WebSocket immediately; cleanup happens in afterEach via server.stop().
 */
function connectAutoApprover(
  h: Harness,
  decide: (requestId: string) => 'approved' | 'denied' = () => 'approved',
): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}/approval-stream`);
  ws.on('open', () => {
    /* ready */
  });
  ws.on('message', (raw) => {
    let msg: { type?: string; request_id?: string };
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (msg?.type === 'approval_request' && typeof msg.request_id === 'string') {
      const decision = decide(msg.request_id);
      ws.send(JSON.stringify({
        type: 'approval_decided',
        request_id: msg.request_id,
        decision,
      }));
    }
  });
  ws.on('error', () => { /* tolerate */ });
  return ws;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* ─── Rejection suite ─────────────────────────────────────────────────── */

describe('POST /v1/federation/call — rejection suite (Phase 3)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setupHarness({ approvalTimeoutMs: 500 });
  });

  afterEach(async () => {
    await h.server.stop();
    h.db.close();
  });

  it('rejects when X-Federation-Pubkey or X-Federation-Signature is missing', async () => {
    const delegationId = seedDelegation(h);
    const body: FederationCallBody = {
      delegation_id: delegationId,
      tool: 'listEvents',
      arguments: {},
      agent_id: 'B_local_agent',
      request_id: 'r-1',
      timestamp: new Date().toISOString(),
    };
    const signed = signFederationCall(h.hubBIdentity, body);
    // Send WITHOUT headers.
    const res = await undiciRequest(`http://127.0.0.1:${h.port}/v1/federation/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: signed.raw,
    });
    expect(res.statusCode).toBe(401);
    const json = (await res.body.json()) as { code: string };
    expect(json.code).toBe('MISSING_FEDERATION_HEADERS');
  });

  it('bad signature → 401 INVALID_SIGNATURE', async () => {
    const delegationId = seedDelegation(h);
    const body: FederationCallBody = {
      delegation_id: delegationId,
      tool: 'listEvents',
      arguments: {},
      agent_id: 'B_local_agent',
      request_id: 'r-bad-sig',
      timestamp: new Date().toISOString(),
    };
    const signed = signFederationCall(h.hubBIdentity, body);
    // Flip a single byte of the signature.
    const tamperedSig = Buffer.from(signed.headers['x-federation-signature']!, 'base64url');
    tamperedSig[0] = tamperedSig[0]! ^ 0x01;
    const res = await undiciRequest(`http://127.0.0.1:${h.port}/v1/federation/call`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...signed.headers,
        'x-federation-signature': bytesToBase64Url(tamperedSig),
      },
      body: signed.raw,
    });
    expect(res.statusCode).toBe(401);
    const json = (await res.body.json()) as { code: string };
    expect(json.code).toBe('INVALID_SIGNATURE');
  });

  it('signature from a different identity → 401 INVALID_SIGNATURE', async () => {
    const delegationId = seedDelegation(h);
    const body: FederationCallBody = {
      delegation_id: delegationId,
      tool: 'listEvents',
      arguments: {},
      agent_id: 'B_local_agent',
      request_id: 'r-other-signer',
      timestamp: new Date().toISOString(),
    };
    const evilIdentity = HubIdentity.generate('evil', MASTER_KEY);
    const signed = signFederationCall(evilIdentity, body);
    const res = await undiciRequest(`http://127.0.0.1:${h.port}/v1/federation/call`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...signed.headers,
        // Peer mismatch is checked AFTER signature — we still expect
        // signature failure because the peer in delegation is hubBIdentity.
        'x-federation-pubkey': h.hubBIdentity.publicKeyB64(),
      },
      body: signed.raw,
    });
    expect(res.statusCode).toBe(401);
    const json = (await res.body.json()) as { code: string };
    expect(json.code).toBe('INVALID_SIGNATURE');
  });

  it('unknown delegation_id → 403 DELEGATION_NOT_FOUND', async () => {
    const body: FederationCallBody = {
      delegation_id: 'unknown-delegation-id',
      tool: 'listEvents',
      arguments: {},
      agent_id: 'B_local_agent',
      request_id: 'r-no-deleg',
      timestamp: new Date().toISOString(),
    };
    const res = await postFederationCall(h, body);
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe('DELEGATION_NOT_FOUND');
  });

  it('revoked delegation → 403 DELEGATION_REVOKED', async () => {
    const delegationId = seedDelegation(h, { revoked: true });
    const body: FederationCallBody = {
      delegation_id: delegationId,
      tool: 'listEvents',
      arguments: {},
      agent_id: 'B_local_agent',
      request_id: 'r-revoked',
      timestamp: new Date().toISOString(),
    };
    const res = await postFederationCall(h, body);
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe('DELEGATION_REVOKED');
  });

  it('expired delegation → 403 DELEGATION_EXPIRED', async () => {
    const delegationId = seedDelegation(h, {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const body: FederationCallBody = {
      delegation_id: delegationId,
      tool: 'listEvents',
      arguments: {},
      agent_id: 'B_local_agent',
      request_id: 'r-expired',
      timestamp: new Date().toISOString(),
    };
    const res = await postFederationCall(h, body);
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe('DELEGATION_EXPIRED');
  });

  it('wrong peer (X-Federation-Pubkey != delegation.peer_verify_key) → 403 PEER_MISMATCH', async () => {
    // Seed delegation bound to hubBIdentity.
    const delegationId = seedDelegation(h);
    // Sign with a DIFFERENT identity, but set its pubkey in the header.
    const imposter = HubIdentity.generate('imposter', MASTER_KEY);
    const body: FederationCallBody = {
      delegation_id: delegationId,
      tool: 'listEvents',
      arguments: {},
      agent_id: 'B_local_agent',
      request_id: 'r-peer-mm',
      timestamp: new Date().toISOString(),
    };
    const signed = signFederationCall(imposter, body);
    const res = await undiciRequest(`http://127.0.0.1:${h.port}/v1/federation/call`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...signed.headers, // imposter's pubkey + imposter's signature
      },
      body: signed.raw,
    });
    expect(res.statusCode).toBe(403);
    const json = (await res.body.json()) as { code: string };
    expect(json.code).toBe('PEER_MISMATCH');
  });

  it('body.tool != delegation.tool → 403 TOOL_MISMATCH', async () => {
    const delegationId = seedDelegation(h, { tool: 'listEvents' });
    const body: FederationCallBody = {
      delegation_id: delegationId,
      tool: 'deleteAllEvents', // not what was delegated
      arguments: {},
      agent_id: 'B_local_agent',
      request_id: 'r-tool-mm',
      timestamp: new Date().toISOString(),
    };
    const res = await postFederationCall(h, body);
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe('TOOL_MISMATCH');
  });

  it('timestamp -10min (past) → 401 CLOCK_SKEW', async () => {
    const delegationId = seedDelegation(h);
    const body: FederationCallBody = {
      delegation_id: delegationId,
      tool: 'listEvents',
      arguments: {},
      agent_id: 'B_local_agent',
      request_id: 'r-past',
      timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
    };
    const res = await postFederationCall(h, body);
    expect(res.status).toBe(401);
    expect((res.body as { code: string }).code).toBe('CLOCK_SKEW');
  });

  it('timestamp +10min (future) → 401 CLOCK_SKEW', async () => {
    const delegationId = seedDelegation(h);
    const body: FederationCallBody = {
      delegation_id: delegationId,
      tool: 'listEvents',
      arguments: {},
      agent_id: 'B_local_agent',
      request_id: 'r-future',
      timestamp: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
    const res = await postFederationCall(h, body);
    expect(res.status).toBe(401);
    expect((res.body as { code: string }).code).toBe('CLOCK_SKEW');
  });

  it('replayed request_id (second call) → 409 REPLAY', async () => {
    // Set up approval flow (will be invoked twice — second call should fail
    // BEFORE reaching the approval flow).
    const ws = connectAutoApprover(h);
    const delegationId = seedDelegation(h);
    const body: FederationCallBody = {
      delegation_id: delegationId,
      tool: 'listEvents',
      arguments: {},
      agent_id: 'B_local_agent',
      request_id: 'r-replay-1',
      timestamp: new Date().toISOString(),
    };

    const first = await postFederationCall(h, body);
    expect(first.status).toBe(200);

    // Second call with same request_id (different timestamp OK).
    const body2: FederationCallBody = { ...body, timestamp: new Date().toISOString() };
    const second = await postFederationCall(h, body2);
    expect(second.status).toBe(409);
    expect((second.body as { code: string }).code).toBe('REPLAY');
    ws.close();
  });

  it('no approver connected (clients.size === 0) → 503 NO_APPROVER_CONNECTED', async () => {
    // Do NOT connectAutoApprover here — clients.size stays at 0.
    const delegationId = seedDelegation(h);
    const body: FederationCallBody = {
      delegation_id: delegationId,
      tool: 'listEvents',
      arguments: {},
      agent_id: 'B_local_agent',
      request_id: 'r-no-phone',
      timestamp: new Date().toISOString(),
    };
    const startedAt = Date.now();
    const res = await postFederationCall(h, body);
    const elapsed = Date.now() - startedAt;
    expect(res.status).toBe(503);
    expect((res.body as { code: string }).code).toBe('NO_APPROVER_CONNECTED');
    // Fast path — must NOT have waited for the 500ms approval timeout.
    expect(elapsed).toBeLessThan(400);
  });

  it('approval denied by user → 403 APPROVAL_DENIED', async () => {
    const ws = connectAutoApprover(h, () => 'denied');
    const delegationId = seedDelegation(h);
    const body: FederationCallBody = {
      delegation_id: delegationId,
      tool: 'listEvents',
      arguments: {},
      agent_id: 'B_local_agent',
      request_id: 'r-denied',
      timestamp: new Date().toISOString(),
    };
    const res = await postFederationCall(h, body);
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe('APPROVAL_DENIED');
    ws.close();
  });

  it('11th call in 60s (same peer, same agent) → 429 RATE_LIMIT', async () => {
    const ws = connectAutoApprover(h);
    const delegationId = seedDelegation(h);
    const results: number[] = [];
    for (let i = 0; i < 11; i++) {
      const body: FederationCallBody = {
        delegation_id: delegationId,
        tool: 'listEvents',
        arguments: {},
        agent_id: 'B_local_agent',
        request_id: `r-rl-${i}`,
        timestamp: new Date().toISOString(),
      };
      const res = await postFederationCall(h, body);
      results.push(res.status);
    }
    ws.close();
    // First 10 must succeed (200), 11th must be rate-limited (429).
    expect(results.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(results[10]).toBe(429);
  });
});

/* ─── Happy path integration ──────────────────────────────────────────── */

describe('POST /v1/federation/call — happy path integration', () => {
  let h: Harness;
  let ws: WebSocket;

  beforeEach(async () => {
    h = await setupHarness({
      approvalTimeoutMs: 5_000,
      callToolImpl: async () => ({
        content: [{ type: 'text', text: '{"events":[{"id":"e1"}]}' }],
      }),
    });
    ws = connectAutoApprover(h);
    // Wait briefly for the WebSocket handshake to complete so clients.size > 0.
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));
  });

  afterEach(async () => {
    ws.close();
    await h.server.stop();
    h.db.close();
  });

  it('full flow: signed request → approval → plugin → result → cross-hub audit', async () => {
    const delegationId = seedDelegation(h);
    const body: FederationCallBody = {
      delegation_id: delegationId,
      tool: 'listEvents',
      arguments: { from: '2026-09-01', to: '2026-09-07' },
      agent_id: 'B_local_agent',
      request_id: 'r-happy-1',
      timestamp: new Date().toISOString(),
      justification: 'Read A\'s calendar for scheduling',
    };
    const res = await postFederationCall(h, body);
    expect(res.status).toBe(200);
    const payload = res.body as { content: Array<{ type: string; text: string }> };
    expect(payload.content[0]?.text).toContain('e1');

    // Give the audit-broadcast a moment to flush.
    await sleep(50);

    // A-side audit row has delegated_by = B_verify_key.
    const allAudit = h.auditLog.query({ user_id: 'local-user' });
    const federated = allAudit.filter((e) => e.delegated_by === h.hubBIdentity.publicKeyB64());
    expect(federated).toHaveLength(1);
    const entry = federated[0]!;
    expect(entry.tool_name).toBe('listEvents');
    expect(entry.decision).toBe('approved');
    expect(entry.decision_federated).toBeNull();
    expect(entry.delegated_to).toBeNull();
    expect(entry.justification).toBe('Read A\'s calendar for scheduling');
    expect(entry.grant_id).toBeTruthy();

    // The federated grant was created with delegated_by = B_verify_key.
    const grant = h.grantStore.getById(entry.grant_id!);
    expect(grant?.delegated_by).toBe(h.hubBIdentity.publicKeyB64());
  });

  it('a second call from the same peer+agent reuses the federated grant (no re-approval)', async () => {
    const delegationId = seedDelegation(h);
    const baseBody: FederationCallBody = {
      delegation_id: delegationId,
      tool: 'listEvents',
      arguments: {},
      agent_id: 'B_local_agent',
      request_id: 'r-happy-2',
      timestamp: new Date().toISOString(),
    };
    const first = await postFederationCall(h, baseBody);
    expect(first.status).toBe(200);

    // Second call — same request_id would 409, so use a different one.
    const second = await postFederationCall(h, {
      ...baseBody,
      request_id: 'r-happy-3',
    });
    expect(second.status).toBe(200);

    await sleep(50);

    const allAudit = h.auditLog.query({ user_id: 'local-user' });
    const federated = allAudit.filter((e) => e.delegated_by === h.hubBIdentity.publicKeyB64());
    expect(federated).toHaveLength(2);
    const grantIds = new Set(federated.map((e) => e.grant_id));
    expect(grantIds.size).toBe(1); // same grant reused (Phase 2b Momus C1)
  });

  it('approval request broadcast contains delegated_by + peer_hub_name + peer_agent_id', async () => {
    const delegationId = seedDelegation(h);
    const captured: unknown[] = [];
    const inspectWs = new WebSocket(`ws://127.0.0.1:${h.port}/approval-stream`);
    inspectWs.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8'));
      if (msg.type === 'approval_request') captured.push(msg);
      // Auto-approve so the test doesn't hang.
      if (msg.type === 'approval_request') {
        inspectWs.send(JSON.stringify({
          type: 'approval_decided',
          request_id: msg.request_id,
          decision: 'approved',
        }));
      }
    });
    await new Promise<void>((r) => inspectWs.once('open', () => r()));

    await postFederationCall(h, {
      delegation_id: delegationId,
      tool: 'listEvents',
      arguments: {},
      agent_id: 'B_local_agent',
      request_id: 'r-broadcast-meta',
      timestamp: new Date().toISOString(),
    });

    // Give the broadcast a tick to arrive.
    await sleep(50);
    inspectWs.close();
    expect(captured.length).toBeGreaterThan(0);
    const req = captured[0] as {
      delegated_by?: string;
      peer_hub_name?: string;
      peer_agent_id?: string;
      agent_id: string;
    };
    expect(req.delegated_by).toBe(h.hubBIdentity.publicKeyB64());
    expect(req.peer_hub_name).toBe('userB');
    expect(req.peer_agent_id).toBe('B_local_agent');
  });
});
