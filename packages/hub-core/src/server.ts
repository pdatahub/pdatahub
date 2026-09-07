/**
 * Hub core HTTP server.
 *
 * Routes (all under /v1):
 *   GET  /tools                    → list available tools
 *   POST /tools/:name/call         → invoke a tool (triggers approval flow)
 *   GET  /audit                    → query audit log (with filters)
 *   GET  /grants                   → list active grants for user
 *   POST /grants/:id/revoke        → manually revoke grant
 *   GET  /plugins                  → list installed plugins
 *   POST /plugins/install          → install plugin (start subprocess)
 *   POST /plugins/:name/authenticate → start OAuth flow
 *   GET  /tokens                   → list plugins with stored tokens (no secrets)
 *   DELETE /tokens/:plugin         → delete stored tokens
 *
 * Auth: Bearer token from HUB_API_TOKEN env or --api-token CLI flag.
 *
 * WebSocket: /approval-stream (handled by ApprovalStream)
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { request as undiciRequest } from 'undici';
import type Database from 'better-sqlite3';
import type { PluginRegistry } from './plugin-process.js';
import { PluginProcess as PluginProcessClass } from './plugin-process.js';
import type { GrantStore } from './grant-store.js';
import type { AuditLog, AuditQueryOptions } from './audit-log.js';
import type { TokenVault } from './token-vault.js';
import type { OAuthFlow, PluginClientConfig } from './oauth-flow.js';
import type { ApprovalStream } from './approval-stream.js';
import type { HubConfig } from './config.js';
import type {
  AuditEntry,
  CallToolRequest,
  CallToolResponse,
  HubErrorResponse,
  ListToolsResponse,
  PluginProcessInfo,
  ToolDescriptor,
} from './types.js';
import { HubIdentity } from './federation/identity.js';
import {
  DelegationStore,
  isExpired,
  isRevoked,
  type DelegationReceivedRow,
} from './federation/delegation.js';
import { NonceStore } from './federation/nonces.js';
import { logger } from './logger.js';

/**
 * Per-route authentication strategy.
 *
 * `none`    — no auth required (e.g. `/health`, public identity endpoint).
 * `bearer`  — existing HUB_API_TOKEN Bearer check (default for unlisted routes).
 * `ed25519` — verify X-Federation-Pubkey + X-Federation-Signature. NOT YET
 *             IMPLEMENTED in Phase 0.5; Phase 3 will replace the pass-through.
 *             Listed as a placeholder so the route table is the single source
 *             of truth for future federation endpoints.
 */
export type AuthStrategy = 'none' | 'bearer' | 'ed25519';

export interface RouteAuth {
  method: string;
  /** Path pattern, supports `:name` placeholders. */
  path: string;
  auth: AuthStrategy;
}

/**
 * Routes not listed default to `bearer` (fail-closed). `/approval-stream`
 * WebSocket connections bypass `handleRequest` entirely (handled by
 * `ApprovalStream`), so they are not in this table — no auth on WS by design.
 */
export const routeAuth: RouteAuth[] = [
  { method: 'GET', path: '/health', auth: 'none' },
  { method: 'GET', path: '/v1/identity', auth: 'none' },
  { method: 'GET', path: '/v1/tools', auth: 'bearer' },
  { method: 'POST', path: '/v1/tools/:name/call', auth: 'bearer' },
  // Phase 5 — B-side endpoint where mcp-server invokes a federated tool.
  // Bearer-authenticated (the mcp-server holds HUB_API_TOKEN). hub-core
  // looks up the matching `peer_delegations` row, signs the outbound body
  // with B's identity, and POSTs to A's `/v1/federation/call` (which is
  // ed25519-authenticated on the receiving side — see below).
  { method: 'POST', path: '/v1/federation/invoke', auth: 'bearer' },
  // Phase 3 — inbound federated calls from peer hubs. Signed with Ed25519;
  // X-Federation-Pubkey + X-Federation-Signature validated in
  // handleFederationCall (NOT Bearer). The dispatch in `checkAuth` lets
  // `ed25519` routes through; the actual signature check happens in the
  // handler where we have access to the raw body.
  { method: 'POST', path: '/v1/federation/call', auth: 'ed25519' },
];

/**
 * Resolve the auth strategy for a (method, pathname). Returns `'bearer'`
 * (fail-closed default) when no entry matches. Linear scan — fine for the
 * ≤ 10-entry table.
 */
export function lookupAuthStrategy(
  method: string,
  pathname: string,
  table: RouteAuth[] = routeAuth,
): AuthStrategy {
  for (const route of table) {
    if (route.method !== method) continue;
    if (pathToRegex(route.path).test(pathname)) return route.auth;
  }
  return 'bearer';
}

/** `:name` placeholders become `([^/]+)`; regex metachars in literals are escaped. */
function pathToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+*?^$()|[\]\\]/g, '\\$&')
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '([^/]+)');
  return new RegExp(`^${escaped}$`);
}

const TOOL_GRANT_TTL_MS = 60 * 60 * 1000; // 1 hour default

export interface HubServerOptions {
  config: HubConfig;
  db: Database.Database;
  registry: PluginRegistry;
  grants: GrantStore;
  audit: AuditLog;
  tokens: TokenVault;
  oauth: OAuthFlow;
  approval: ApprovalStream;
  /** Map plugin name → client_id/secret (from env or config). */
  clientCredentials: Map<string, PluginClientConfig>;
  /** Phase 3 — delegations + replay dedup. Optional for backwards compat
   *  with tests that don't exercise federation. */
  delegations?: DelegationStore;
  nonces?: NonceStore;
}

export class HubServer {
  private readonly opts: HubServerOptions;
  private server: Server | null = null;
  /** Default user_id for single-user self-hosted MVP. */
  private readonly defaultUserId = 'local-user';

  /**
   * Phase 3 (Momus I5) — per-(peer_verify_key, agent_id) rate limit.
   * Tracks recent federated approval requests so a malicious B with N
   * delegations cannot spam A's phone by distributing across delegation
   * IDs. Trim window: 60s, threshold: 10 pending requests.
   *
   * In-memory only — no DB round-trip in the hot path. Per-process, so a
   * restart resets the window. Acceptable: a 1-second restart gap at the
   * 10/min ceiling is not a meaningful DoS reduction.
   */
  private readonly federatedRateLimits = new Map<string, number[]>();

  constructor(opts: HubServerOptions) {
    this.opts = opts;
  }

  /**
   * Start HTTP server on configured host:port.
   */
  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));
      this.opts.approval.attach(this.server);
      this.server.listen(this.opts.config.port, this.opts.config.host, () => {
        logger.info('Hub server listening', {
          host: this.opts.config.host,
          port: this.opts.config.port,
          ws_path: '/approval-stream',
        });
        resolve();
      });
    });
  }

  /**
   * Stop server gracefully.
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.opts.approval.close().then(() => {
        if (this.server) {
          this.server.close(() => resolve());
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Return the bound address of the HTTP server, or `null` if not yet
   * started. Useful for tests that bind to port 0 (random free port).
   */
  address(): { address: string; family: string; port: number } | null {
    if (!this.server) return null;
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') return null;
    return addr as { address: string; family: string; port: number };
  }

  /**
   * Scan plugins directory and start each plugin subprocess.
   * Each subdir in pluginsDir = one plugin (must contain dist/index.js).
   */
  async loadPluginsFromDir(): Promise<void> {
    const dir = this.opts.config.pluginsDir;
    if (!existsSync(dir)) {
      logger.warn('plugins dir does not exist, skipping auto-load', { dir });
      return;
    }
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const pluginDir = join(dir, entry);
      if (!statSync(pluginDir).isDirectory()) continue;
      const entryPath = join(pluginDir, 'dist', 'index.js');
      if (!existsSync(entryPath)) {
        logger.warn('plugin missing dist/index.js, skipping', { plugin: entry, entryPath });
        continue;
      }
      await this.startPlugin(entry, entryPath);
    }
  }

  async startPlugin(name: string, entryPath: string): Promise<PluginProcessInfo> {
    void name;
    const plugin = new PluginProcessClass({
      entry_path: entryPath,
      heartbeatMs: this.opts.config.pluginHeartbeatMs,
      onExit: (n) => {
        this.opts.registry.unregister(n);
      },
    });
    try {
      const manifest = await plugin.initialize();
      this.opts.registry.register(plugin, manifest);
      return plugin.getInfo();
    } catch (err) {
      logger.error('plugin failed to initialize', {
        entry: entryPath,
        error: (err as Error).message,
      });
      await plugin.shutdown();
      throw err;
    }
  }

  /* ─── Request handling ────────────────────────────────────────────────── */

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS for local dev
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    // Auth check
    if (!this.checkAuth(req)) {
      this.sendError(res, 401, 'unauthorized', 'INVALID_TOKEN');
      return;
    }

    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      // /v1/tools
      if (req.method === 'GET' && url.pathname === '/v1/tools') {
        await this.handleListTools(res);
        return;
      }
      // /v1/tools/:name/call
      const callMatch = url.pathname.match(/^\/v1\/tools\/([^/]+)\/call$/);
      if (req.method === 'POST' && callMatch) {
        await this.handleCallTool(req, res, decodeURIComponent(callMatch[1]));
        return;
      }
      // /v1/audit
      if (req.method === 'GET' && url.pathname === '/v1/audit') {
        await this.handleAudit(res, url.searchParams);
        return;
      }
      // /v1/grants
      if (req.method === 'GET' && url.pathname === '/v1/grants') {
        await this.handleListGrants(res);
        return;
      }
      // /v1/grants/:id/revoke
      const revokeMatch = url.pathname.match(/^\/v1\/grants\/([^/]+)\/revoke$/);
      if (req.method === 'POST' && revokeMatch) {
        await this.handleRevokeGrant(res, decodeURIComponent(revokeMatch[1]));
        return;
      }
      // /v1/plugins
      if (req.method === 'GET' && url.pathname === '/v1/plugins') {
        await this.handleListPlugins(res);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/plugins/install') {
        await this.handleInstallPlugin(req, res);
        return;
      }
      // /v1/plugins/:name/authenticate
      const authMatch = url.pathname.match(/^\/v1\/plugins\/([^/]+)\/authenticate$/);
      if (req.method === 'POST' && authMatch) {
        await this.handleAuthenticatePlugin(res, decodeURIComponent(authMatch[1]));
        return;
      }
      // /v1/tokens
      if (req.method === 'GET' && url.pathname === '/v1/tokens') {
        await this.handleListTokens(res);
        return;
      }
      const tokenDeleteMatch = url.pathname.match(/^\/v1\/tokens\/([^/]+)$/);
      if (req.method === 'DELETE' && tokenDeleteMatch) {
        await this.handleDeleteToken(res, decodeURIComponent(tokenDeleteMatch[1]));
        return;
      }
      // /health
      if (req.method === 'GET' && url.pathname === '/health') {
        this.sendJson(res, 200, { status: 'ok', service: 'pdatahub-hub' });
        return;
      }
      // /v1/identity — public by design (federation-v2-design.md Momus I10).
      // The trust anchor for delegations is the verify_key INSIDE the signed
      // delegation blob, not this endpoint — a hub can lie here but cannot
      // forge A's signatures.
      if (req.method === 'GET' && url.pathname === '/v1/identity') {
        await this.handleGetIdentity(res);
        return;
      }

      // /v1/federation/call — Phase 3. Inbound from peer hubs, signed with
      // Ed25519. Reads raw body (signature is over the exact bytes sent,
      // not a re-serialized object).
      if (req.method === 'POST' && url.pathname === '/v1/federation/call') {
        await this.handleFederationCall(req, res);
        return;
      }

      // /v1/federation/invoke — Phase 5. mcp-server's B-side entry point.
      // Bearer-authenticated; hub-core looks up the peer_delegations row,
      // signs the outbound body with B's identity, and POSTs to A's
      // /v1/federation/call. A-side ed25519 auth happens on A.
      if (req.method === 'POST' && url.pathname === '/v1/federation/invoke') {
        await this.handleFederationInvoke(req, res);
        return;
      }

      this.sendError(res, 404, `not found: ${req.method} ${url.pathname}`, 'NOT_FOUND');
    } catch (err) {
      logger.error('request handler error', { error: (err as Error).message });
      this.sendError(res, 500, `internal error: ${(err as Error).message}`, 'INTERNAL_ERROR');
    }
  }

  private checkAuth(req: IncomingMessage): boolean {
    const expected = process.env.HUB_API_TOKEN;
    if (!expected) {
      // No token configured = open access (dev mode). Preserved as-is from
      // Phase 0.5: the hard-fail in startup.ts handles the non-loopback case
      // before we ever get here, so by the time we're listening with no
      // token, the host must be loopback.
      logger.warn('HUB_API_TOKEN not set, allowing unauthenticated access (dev only)');
      return true;
    }

    // Token is configured — dispatch by route. Default for unlisted routes
    // is `'bearer'` (fail-closed) via `lookupAuthStrategy`.
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const strategy = lookupAuthStrategy(req.method ?? '', url.pathname);

    if (strategy === 'none' || strategy === 'ed25519') {
      // `ed25519` is a Phase 3 placeholder — currently passes. Phase 3 will
      // add X-Federation-Pubkey / X-Federation-Signature verification here.
      return true;
    }

    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return false;
    return auth.slice(7) === expected;
  }

  private async handleListTools(res: ServerResponse): Promise<void> {
    const tools = this.opts.registry.listAllTools();
    const federated = this.listFederatedToolDescriptors();
    const body: ListToolsResponse = { tools: [...tools, ...federated] };
    this.sendJson(res, 200, body);
  }

  /**
   * Build synthetic `ToolDescriptor` entries for every active
   * `peer_delegations` row (Phase 5, Momus B7). Active = not revoked AND
   * `expires_at > now`.
   *
   * Tool name format: `federated__<peer_hub_name>__<tool>` (uses `__` so the
   * name satisfies MCP's `^[a-zA-Z0-9_-]{1,64}$` constraint — colons would
   * not). mcp-server's `refreshTools` sees `federated: true` and routes the
   * call to `/v1/federation/invoke` instead of `/v1/tools/:name/call`.
   *
   * Tie-break: when multiple `peer_delegations` rows match the same
   * `(peer_hub_name, tool)` tuple, pick the one with the latest
   * `expires_at` (Momus Q4). The query in `DelegationStore.findReceivedMatch`
   * is already `ORDER BY expires_at DESC`; we de-duplicate by name in JS.
   *
   * Returns `[]` if `DelegationStore` was not wired (e.g. tests that don't
   * exercise federation).
   */
  private listFederatedToolDescriptors(): ToolDescriptor[] {
    const delegations = this.opts.delegations;
    if (!delegations) return [];
    const now = new Date().toISOString();
    const rows = delegations
      .listReceived()
      .filter((row) => row.revoked === 0 && row.expires_at > now);
    const byName = new Map<string, DelegationReceivedRow>();
    for (const row of rows) {
      const name = `federated__${row.peer_hub_name}__${row.tool}`;
      const prev = byName.get(name);
      if (!prev || row.expires_at > prev.expires_at) byName.set(name, row);
    }
    const out: ToolDescriptor[] = [];
    for (const [name, row] of byName) {
      let inputSchema: Record<string, unknown> | null = null;
      if (row.input_schema) {
        try {
          inputSchema = JSON.parse(row.input_schema) as Record<string, unknown>;
        } catch (err) {
          logger.warn('peer_delegation input_schema is not valid JSON', {
            delegation_id: row.delegation_id,
            error: (err as Error).message,
          });
        }
      }
      out.push({
        name,
        description: `Federated call to ${row.tool} on ${row.peer_hub_name}'s ${row.plugin} hub (expires ${row.expires_at})`,
        inputSchema,
        scope: row.scope,
        plugin: row.plugin,
        federated: true,
        delegation_id: row.delegation_id,
        peer_hub_name: row.peer_hub_name,
        peer_hub_url: row.peer_hub_url,
        expires_at: row.expires_at,
      });
    }
    return out;
  }

  private async handleGetIdentity(res: ServerResponse): Promise<void> {
    if (!HubIdentity.exists(this.opts.db)) {
      this.sendError(
        res,
        503,
        'Hub identity not initialized. Run `pdatahub-hub init`.',
        'IDENTITY_NOT_INITIALIZED',
      );
      return;
    }
    try {
      const identity = HubIdentity.load(this.opts.db, this.opts.config.masterKey);
      this.sendJson(res, 200, identity.toIdentityEndpointResponse());
    } catch (err) {
      logger.error('failed to load hub identity', { error: (err as Error).message });
      this.sendError(
        res,
        500,
        `failed to load identity: ${(err as Error).message}`,
        'IDENTITY_LOAD_FAILED',
      );
    }
  }

  private async handleCallTool(
    req: IncomingMessage,
    res: ServerResponse,
    toolName: string,
  ): Promise<void> {
    const body = await this.readBody<CallToolRequest>(req);
    const plugin = this.opts.registry.getPlugin(toolName);
    if (!plugin) {
      this.sendError(res, 404, `unknown tool: ${toolName}`, 'UNKNOWN_TOOL');
      return;
    }
    const agentId = body.context?.agent_id ?? 'unknown-agent';
    const justification = body.context?.justification ?? null;
    const requestId = body.context?.request_id ?? randomBytes(8).toString('hex');
    const startedAt = Date.now();

    // Approval flow
    let grant;
    try {
      grant = await this.ensureGrant({
        tool_name: toolName,
        plugin: plugin.getInfo().name,
        agent_id: agentId,
        user_id: this.defaultUserId,
      });
    } catch (err) {
      this.opts.audit.append({
        agent_id: agentId,
        user_id: this.defaultUserId,
        tool_name: toolName,
        plugin: plugin.getInfo().name,
        scope: plugin.getInfo().tools.find((t) => t.name === toolName)?.scope ?? 'unknown',
        justification,
        decision: 'denied',
        grant_id: null,
        duration_ms: Date.now() - startedAt,
        error: (err as Error).message,
        delegated_by: null,
        delegated_to: null,
        decision_federated: null,
      });
      this.sendError(res, 403, `approval denied: ${(err as Error).message}`, 'APPROVAL_DENIED');
      return;
    }

    // Proactive refresh: if access_token expires within 5 minutes, swap it
    // for a fresh one via refresh_token. Prevents 401 mid-call.
    if (this.opts.tokens.isExpiringSoon(grant.plugin)) {
      const clientCreds = this.opts.clientCredentials.get(grant.plugin);
      const oauthConfig = plugin.getInfo().oauth;
      if (clientCreds && oauthConfig) {
        try {
          await this.opts.tokens.refreshAccessToken(
            grant.plugin,
            clientCreds.client_id,
            clientCreds.client_secret,
            oauthConfig.token_url,
          );
        } catch (err) {
          logger.warn('proactive token refresh failed, continuing with existing token', {
            plugin: grant.plugin,
            error: (err as Error).message,
          });
        }
      }
    }

    const tokens = this.opts.tokens.get(grant.plugin);

    // Call plugin
    try {
      const result = await plugin.callTool(toolName, body.arguments ?? {}, {
        agent_id: agentId,
        request_id: requestId,
        ...(tokens?.access_token ? { token: tokens.access_token } : {}),
      });
      const auditEntry = this.opts.audit.append({
        agent_id: agentId,
        user_id: this.defaultUserId,
        tool_name: toolName,
        plugin: grant.plugin,
        scope: grant.scope,
        justification,
        decision: 'approved',
        grant_id: grant.grant_id,
        duration_ms: Date.now() - startedAt,
        delegated_by: null,
        delegated_to: null,
        decision_federated: null,
      });
      this.opts.approval.broadcastAudit(auditEntry);
      const response: CallToolResponse = {
        content: result.content,
        ...(result.isError !== undefined ? { isError: result.isError } : {}),
      };
      this.sendJson(res, 200, response);
    } catch (err) {
      const auditEntry = this.opts.audit.append({
        agent_id: agentId,
        user_id: this.defaultUserId,
        tool_name: toolName,
        plugin: grant.plugin,
        scope: grant.scope,
        justification,
        decision: 'error',
        grant_id: grant.grant_id,
        duration_ms: Date.now() - startedAt,
        error: (err as Error).message,
        delegated_by: null,
        delegated_to: null,
        decision_federated: null,
      });
      this.opts.approval.broadcastAudit(auditEntry);
      this.sendError(
        res,
        500,
        `plugin call failed: ${(err as Error).message}`,
        'PLUGIN_ERROR',
      );
    }
  }

  /**
   * Ensure a valid grant exists for this (tool, agent, delegated_by).
   * Requests approval if not. Returns the grant (creates one if approved).
   *
   * Phase 2b: the match key now includes `delegated_by` (Momus C1). Without
   * it, a local grant (delegated_by = null) could be reused to satisfy a
   * federated call from B (which carries delegated_by = B_verify_key),
   * bypassing A's approval flow. The match key is enforced at the SQL
   * layer in `GrantStore.findActive`.
   *
   * Phase 2b only routes local calls here — `delegated_by` defaults to
   * null. Phase 3 (the /v1/federation/call endpoint) routes federated
   * calls through this same method with `delegated_by = peer_verify_key`.
   */
  private async ensureGrant(opts: {
    tool_name: string;
    plugin: string;
    agent_id: string;
    user_id: string;
    /** Phase 2b — peer verify_key for federated calls (null for local). */
    delegated_by?: string | null;
  }): Promise<import('./types.js').Grant> {
    const delegatedBy = opts.delegated_by ?? null;

    const existing = this.opts.grants.findActive({
      tool_name: opts.tool_name,
      plugin: opts.plugin,
      agent_id: opts.agent_id,
      delegated_by: delegatedBy,
    });
    if (existing) return existing;

    // Request approval
    const plugin = this.opts.registry.getPlugin(opts.tool_name);
    const scope = plugin?.getInfo().tools.find((t) => t.name === opts.tool_name)?.scope ?? 'unknown';

    const decision = await this.opts.approval.requestApproval({
      agent_id: opts.agent_id,
      tool_name: opts.tool_name,
      scope,
      justification: null,
    });
    if (decision.decision !== 'approved') {
      throw new Error('user denied approval');
    }

    // Create grant (1 hour TTL)
    return this.opts.grants.create({
      tool_name: opts.tool_name,
      plugin: opts.plugin,
      scope,
      agent_id: opts.agent_id,
      user_id: opts.user_id,
      expires_at: new Date(Date.now() + TOOL_GRANT_TTL_MS).toISOString(),
      delegated_by: delegatedBy,
    });
  }

  private async handleAudit(res: ServerResponse, params: URLSearchParams): Promise<void> {
    const opts: AuditQueryOptions = {};
    const agent = params.get('agent_id');
    if (agent) opts.agent_id = agent;
    const user = params.get('user_id');
    if (user) opts.user_id = user;
    const tool = params.get('tool_name');
    if (tool) opts.tool_name = tool;
    const limit = params.get('limit');
    if (limit) opts.limit = parseInt(limit, 10);
    const since = params.get('since');
    if (since) opts.since = since;
    const entries = this.opts.audit.query(opts);
    this.sendJson(res, 200, { entries });
  }

  private async handleListGrants(res: ServerResponse): Promise<void> {
    const grants = this.opts.grants.listActiveForUser(this.defaultUserId);
    this.sendJson(res, 200, { grants });
  }

  private async handleRevokeGrant(res: ServerResponse, grantId: string): Promise<void> {
    const ok = this.opts.grants.revoke(grantId);
    if (ok) {
      this.opts.approval.broadcastRevocation(grantId);
      this.sendJson(res, 200, { revoked: grantId });
    } else {
      this.sendError(res, 404, `grant not found: ${grantId}`, 'GRANT_NOT_FOUND');
    }
  }

  private async handleListPlugins(res: ServerResponse): Promise<void> {
    const plugins = this.opts.registry.listPlugins();
    this.sendJson(res, 200, { plugins });
  }

  private async handleInstallPlugin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody<{ name: string; entry_path: string }>(req);
    try {
      const info = await this.startPlugin(body.name, body.entry_path);
      this.sendJson(res, 200, { installed: info });
    } catch (err) {
      this.sendError(res, 500, `install failed: ${(err as Error).message}`, 'INSTALL_FAILED');
    }
  }

  private async handleAuthenticatePlugin(res: ServerResponse, pluginName: string): Promise<void> {
    const plugin = this.opts.registry.listPlugins().find((p) => p.name === pluginName);
    if (!plugin) {
      this.sendError(res, 404, `plugin not found: ${pluginName}`, 'PLUGIN_NOT_FOUND');
      return;
    }
    if (!plugin.oauth) {
      this.sendError(res, 400, 'plugin does not require OAuth', 'NO_OAUTH_CONFIG');
      return;
    }
    const client = this.opts.clientCredentials.get(pluginName);
    if (!client) {
      this.sendError(
        res,
        500,
        `no client credentials configured for plugin ${pluginName} (set HUB_CLIENT_${pluginName.toUpperCase().replace(/-/g, '_')}_ID env or config)`,
        'MISSING_CREDENTIALS',
      );
      return;
    }
    try {
      const result = await this.opts.oauth.startFlow({
        plugin: pluginName,
        oauth: plugin.oauth,
        client,
      });
      this.sendJson(res, 200, result);
    } catch (err) {
      this.sendError(res, 500, `OAuth failed: ${(err as Error).message}`, 'OAUTH_FAILED');
    }
  }

  private async handleListTokens(res: ServerResponse): Promise<void> {
    const list = this.opts.tokens.listPlugins();
    this.sendJson(res, 200, { tokens: list });
  }

  private async handleDeleteToken(res: ServerResponse, plugin: string): Promise<void> {
    const ok = this.opts.tokens.delete(plugin);
    if (ok) this.sendJson(res, 200, { deleted: plugin });
    else this.sendError(res, 404, `no tokens for plugin: ${plugin}`, 'NO_TOKENS');
  }

  /**
   * Phase 3 — `POST /v1/federation/call` handler. The full inbound
   * security model from federation-v2-design.md §"Protocol flow" Step 4:
   *
   *   1. Read X-Federation-Pubkey + X-Federation-Signature + raw body.
   *   2. Decode the peer's verify_key from `ed25519:<base64url>`.
   *   3. Symmetric clock skew check `|now - timestamp| <= 300s`
   *      (Momus I7). Past or future beyond the window → 401.
   *   4. Ed25519-verify the signature against the EXACT raw bytes
   *      (no re-serialization, or signatures would always fail).
   *   5. NonceStore replay dedup — second call with the same
   *      request_id within 10 min → 409 REPLAY (Momus I4).
   *   6. Look up the delegation; check (revoked, expired, peer key,
   *      tool name) — see design doc failure modes.
   *   7. Fast 503 NO_APPROVER_CONNECTED when no phone is connected
   *      (Momus I2) — don't burn the 120s budget.
   *   8. Per-(peer, agent_id) rate limit: > 10 pending in 60s → 429.
   *   9. Proactive OAuth refresh (existing pattern from handleCallTool).
   *  10. Approval flow with 120s budget and federated metadata.
   *  11. ensureGrant with delegated_by = peer_verify_key (Momus C1).
   *  12. Invoke plugin; return result.
   *  13. Cross-hub audit: A side → delegated_by = peer_verify_key.
   *      (B side is the originating hub, not this one — Phase 5.)
   */
  private async handleFederationCall(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const startedAt = Date.now();
    const delegations = this.opts.delegations;
    const nonces = this.opts.nonces;
    if (!delegations || !nonces) {
      this.sendError(
        res,
        503,
        'federation not initialized on this hub',
        'FEDERATION_NOT_INITIALIZED',
      );
      return;
    }

    // 1. Read raw body + headers.
    const pubkeyHeader = this.headerStr(req.headers['x-federation-pubkey']);
    const sigHeader = this.headerStr(req.headers['x-federation-signature']);
    if (!pubkeyHeader || !sigHeader) {
      this.sendError(
        res,
        401,
        'missing X-Federation-Pubkey or X-Federation-Signature',
        'MISSING_FEDERATION_HEADERS',
      );
      return;
    }

    let raw: string;
    let json: unknown;
    try {
      const body = await this.readRawBody(req);
      raw = body.raw;
      json = body.json;
    } catch (err) {
      this.sendError(res, 400, (err as Error).message, 'INVALID_BODY');
      return;
    }

    // 2. Decode verify_key from base64url.
    if (!pubkeyHeader.startsWith('ed25519:')) {
      this.sendError(res, 401, 'invalid pubkey prefix', 'INVALID_PUBKEY');
      return;
    }
    let pubkeyBytes: Uint8Array;
    try {
      pubkeyBytes = this.b64urlDecode(pubkeyHeader.slice('ed25519:'.length));
    } catch (err) {
      this.sendError(res, 401, `pubkey decode: ${(err as Error).message}`, 'INVALID_PUBKEY');
      return;
    }
    if (pubkeyBytes.length !== 32) {
      this.sendError(res, 401, `pubkey wrong length (${pubkeyBytes.length})`, 'INVALID_PUBKEY');
      return;
    }

    // 3. Symmetric clock skew check.
    const bodyObj = json as Record<string, unknown> | null;
    const delegationId = this.stringField(bodyObj, 'delegation_id');
    const toolName = this.stringField(bodyObj, 'tool');
    const agentId = this.stringField(bodyObj, 'agent_id');
    const requestId = this.stringField(bodyObj, 'request_id');
    const timestamp = this.stringField(bodyObj, 'timestamp');
    const justification = this.stringField(bodyObj, 'justification') ?? null;
    const args = this.recordField(bodyObj, 'arguments');

    if (!delegationId || !toolName || !agentId || !requestId || !timestamp) {
      this.sendError(
        res,
        400,
        'body must include delegation_id, tool, agent_id, request_id, timestamp',
        'INVALID_BODY',
      );
      return;
    }
    const ts = Date.parse(timestamp);
    if (Number.isNaN(ts)) {
      this.sendError(res, 400, 'invalid timestamp', 'INVALID_TIMESTAMP');
      return;
    }
    const skewMs = Math.abs(Date.now() - ts);
    if (skewMs > 300_000) {
      this.sendError(res, 401, `clock skew ${skewMs}ms exceeds 300s`, 'CLOCK_SKEW');
      return;
    }

    // 4. Ed25519 verify against raw bytes (no re-serialization).
    let sigBytes: Uint8Array;
    try {
      sigBytes = this.b64urlDecode(sigHeader);
    } catch (err) {
      this.sendError(res, 401, `signature decode: ${(err as Error).message}`, 'INVALID_SIGNATURE');
      return;
    }
    if (sigBytes.length !== 64) {
      this.sendError(res, 401, 'signature wrong length', 'INVALID_SIGNATURE');
      return;
    }
    const bodyBytes = new TextEncoder().encode(raw);
    if (!HubIdentity.verify(bodyBytes, sigBytes, pubkeyBytes)) {
      this.sendError(res, 401, 'signature mismatch', 'INVALID_SIGNATURE');
      return;
    }

    // 5. Nonce replay dedup — record before delegation lookup so a
    // replay of an already-rejected request also bounces.
    if (nonces.isSeenRecently(requestId)) {
      this.sendError(res, 409, 'request_id already seen within replay window', 'REPLAY');
      return;
    }

    // 6. Look up delegation.
    const delegation = delegations.getGranted(delegationId);
    if (!delegation) {
      // No nonce record: a malformed request never consumes the
      // request_id slot, so an attacker probing for valid IDs is
      // limited only by signature checks.
      this.sendError(res, 403, 'unknown delegation', 'DELEGATION_NOT_FOUND');
      return;
    }
    if (isRevoked(delegation)) {
      this.sendError(res, 403, 'delegation revoked', 'DELEGATION_REVOKED');
      return;
    }
    if (isExpired(delegation.expires_at)) {
      this.sendError(res, 403, 'delegation expired', 'DELEGATION_EXPIRED');
      return;
    }
    if (delegation.peer_verify_key !== pubkeyHeader) {
      // Defense in depth: the signature was already verified above,
      // but the pubkey in the header must also match the delegation's
      // bound peer. Caught here too in case delegation.peer_verify_key
      // was tampered with after import.
      this.sendError(res, 403, 'X-Federation-Pubkey does not match delegation', 'PEER_MISMATCH');
      return;
    }
    if (delegation.tool !== toolName) {
      this.sendError(res, 403, 'body.tool does not match delegation', 'TOOL_MISMATCH');
      return;
    }

    // From here on, the request is valid — record the nonce so a replay
    // is rejected even if the rest of the flow completes.
    nonces.record(requestId);

    // 7. Fast 503 when no phone connected (Momus I2).
    if (this.opts.approval.connectedClients() === 0) {
      this.opts.audit.append({
        agent_id: agentId,
        user_id: this.defaultUserId,
        tool_name: toolName,
        plugin: delegation.plugin,
        scope: delegation.scope,
        justification,
        decision: 'denied',
        grant_id: null,
        duration_ms: Date.now() - startedAt,
        error: 'no approver connected',
        delegated_by: pubkeyHeader,
        delegated_to: null,
        decision_federated: null,
      });
      this.sendError(res, 503, 'no approver connected', 'NO_APPROVER_CONNECTED');
      return;
    }

    // 8. Per-(peer, agent_id) rate limit.
    const rl = this.checkFederatedRateLimit(pubkeyHeader, agentId);
    if (rl) {
      this.sendError(
        res,
        429,
        `rate limit exceeded; retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`,
        'RATE_LIMIT',
      );
      return;
    }

    // 9. Look up the local plugin (mirrors handleCallTool).
    const plugin = this.opts.registry.getPlugin(toolName);
    if (!plugin) {
      this.sendError(res, 404, `unknown tool: ${toolName}`, 'UNKNOWN_TOOL');
      return;
    }
    const pluginInfo = plugin.getInfo();

    // 10. Proactive OAuth refresh (existing pattern).
    if (this.opts.tokens.isExpiringSoon(pluginInfo.name)) {
      const clientCreds = this.opts.clientCredentials.get(pluginInfo.name);
      const oauthConfig = pluginInfo.oauth;
      if (clientCreds && oauthConfig) {
        try {
          await this.opts.tokens.refreshAccessToken(
            pluginInfo.name,
            clientCreds.client_id,
            clientCreds.client_secret,
            oauthConfig.token_url,
          );
        } catch (err) {
          logger.warn('proactive token refresh failed, continuing with existing token', {
            plugin: pluginInfo.name,
            error: (err as Error).message,
          });
        }
      }
    }
    const tokens = this.opts.tokens.get(pluginInfo.name);

    // 11. Approval flow with 120s budget + federated metadata.
    let decision: import('./approval-stream.js').ApprovalDecision;
    try {
      decision = await this.opts.approval.requestApproval({
        agent_id: agentId,
        tool_name: toolName,
        scope: delegation.scope,
        justification,
        delegated_by: pubkeyHeader,
        peer_hub_name: delegation.peer_hub_name,
        peer_agent_id: agentId,
        timeoutMsOverride: 120_000,
      });
    } catch (err) {
      const auditEntry = this.opts.audit.append({
        agent_id: agentId,
        user_id: this.defaultUserId,
        tool_name: toolName,
        plugin: pluginInfo.name,
        scope: delegation.scope,
        justification,
        decision: 'denied',
        grant_id: null,
        duration_ms: Date.now() - startedAt,
        error: (err as Error).message,
        delegated_by: pubkeyHeader,
        delegated_to: null,
        decision_federated: 'federated_timeout',
      });
      this.opts.approval.broadcastAudit(auditEntry);
      this.sendError(res, 403, `approval denied: ${(err as Error).message}`, 'APPROVAL_DENIED');
      return;
    }

    if (decision.decision !== 'approved') {
      const auditEntry = this.opts.audit.append({
        agent_id: agentId,
        user_id: this.defaultUserId,
        tool_name: toolName,
        plugin: pluginInfo.name,
        scope: delegation.scope,
        justification,
        decision: 'denied',
        grant_id: null,
        duration_ms: Date.now() - startedAt,
        delegated_by: pubkeyHeader,
        delegated_to: null,
        decision_federated: 'federated_denied',
      });
      this.opts.approval.broadcastAudit(auditEntry);
      this.sendError(res, 403, 'approval denied', 'APPROVAL_DENIED');
      return;
    }

    // 12. ensureGrant with delegated_by (Momus C1).
    let grant;
    try {
      grant = await this.ensureGrant({
        tool_name: toolName,
        plugin: pluginInfo.name,
        agent_id: agentId,
        user_id: this.defaultUserId,
        delegated_by: pubkeyHeader,
      });
    } catch (err) {
      const auditEntry = this.opts.audit.append({
        agent_id: agentId,
        user_id: this.defaultUserId,
        tool_name: toolName,
        plugin: pluginInfo.name,
        scope: delegation.scope,
        justification,
        decision: 'denied',
        grant_id: null,
        duration_ms: Date.now() - startedAt,
        error: (err as Error).message,
        delegated_by: pubkeyHeader,
        delegated_to: null,
        decision_federated: 'federated_denied',
      });
      this.opts.approval.broadcastAudit(auditEntry);
      this.sendError(res, 403, `approval denied: ${(err as Error).message}`, 'APPROVAL_DENIED');
      return;
    }

    // 13. Invoke plugin with A's decrypted token.
    try {
      const result = await plugin.callTool(toolName, args ?? {}, {
        agent_id: agentId,
        request_id: requestId,
        ...(tokens?.access_token ? { token: tokens.access_token } : {}),
      });
      const auditEntry = this.opts.audit.append({
        agent_id: agentId,
        user_id: this.defaultUserId,
        tool_name: toolName,
        plugin: grant.plugin,
        scope: grant.scope,
        justification,
        decision: 'approved',
        grant_id: grant.grant_id,
        duration_ms: Date.now() - startedAt,
        delegated_by: pubkeyHeader,
        delegated_to: null,
        decision_federated: null,
      });
      this.opts.approval.broadcastAudit(auditEntry);
      const response: CallToolResponse = {
        content: result.content,
        ...(result.isError !== undefined ? { isError: result.isError } : {}),
      };
      this.sendJson(res, 200, response);
    } catch (err) {
      const auditEntry = this.opts.audit.append({
        agent_id: agentId,
        user_id: this.defaultUserId,
        tool_name: toolName,
        plugin: grant.plugin,
        scope: grant.scope,
        justification,
        decision: 'error',
        grant_id: grant.grant_id,
        duration_ms: Date.now() - startedAt,
        error: (err as Error).message,
        delegated_by: pubkeyHeader,
        delegated_to: null,
        decision_federated: null,
      });
      this.opts.approval.broadcastAudit(auditEntry);
      this.sendError(
        res,
        500,
        `plugin call failed: ${(err as Error).message}`,
        'PLUGIN_ERROR',
      );
    }
  }

  /**
   * Phase 5 — `POST /v1/federation/invoke` handler (Momus B6). mcp-server
   * posts here when the AI calls a synthetic `federated__<hub>__<tool>`.
   * B's hub:
   *
   *   1. Parses `federated__<hub>__<tool>` → `(peer_hub_name, tool)`.
   *   2. Looks up `peer_delegations` (active rows only — revoked/expired
   *      omitted at the SQL layer). Tie-breaks by latest `expires_at`
   *      (Momus Q4).
   *   3. Builds the federation request body (mirrors the inbound schema
   *      that `handleFederationCall` expects from B):
   *         { delegation_id, tool, arguments, agent_id, request_id,
   *           timestamp, justification? }
   *   4. Signs the body with B's identity; POSTs to A's
   *      `/v1/federation/call` with `X-Federation-Pubkey` +
   *      `X-Federation-Signature`. Ed25519 auth happens on A.
   *   5. Returns A's response to mcp-server (200 / error).
   *   6. Cross-hub audit (Momus §"Protocol flow" Step 5): on B's hub we
   *      write `delegated_to = A_verify_key` + `decision_federated =
   *      'federated_ok' | 'federated_denied' | 'federated_error'`.
   *
   * Body schema (request): `{ tool: string, arguments: object, agent_id:
   * string, justification?: string }`.
   *
   * Body schema (response, when A returns 200): `{ content: [...],
   * isError?: boolean }` — same as `/v1/tools/:name/call`.
   *
   * Failure modes mapped to design doc §"Failure modes":
   *   - A unreachable          → 502 FEDERATION_UPSTREAM_ERROR
   *   - A returns 403 (denied) → 403 FEDERATION_DENIED
   *   - A returns 5xx          → 502 FEDERATION_UPSTREAM_ERROR
   *   - No matching delegation → 404 DELEGATION_NOT_FOUND
   *   - Delegation revoked/expired → 403 DELEGATION_REVOKED / DELEGATION_EXPIRED
   *   - malformed tool name    → 400 INVALID_FEDERATED_NAME
   */
  private async handleFederationInvoke(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const startedAt = Date.now();
    const delegations = this.opts.delegations;
    if (!delegations) {
      this.sendError(
        res,
        503,
        'federation not initialized on this hub',
        'FEDERATION_NOT_INITIALIZED',
      );
      return;
    }
    if (!HubIdentity.exists(this.opts.db)) {
      this.sendError(
        res,
        503,
        'Hub identity not initialized. Run `pdatahub-hub init`.',
        'IDENTITY_NOT_INITIALIZED',
      );
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = (await this.readBody<Record<string, unknown>>(req)) ?? {};
    } catch (err) {
      this.sendError(res, 400, (err as Error).message, 'INVALID_BODY');
      return;
    }
    const toolName = typeof body['tool'] === 'string' ? (body['tool'] as string) : '';
    const args = this.recordField(body, 'arguments') ?? {};
    const agentId =
      typeof body['agent_id'] === 'string' ? (body['agent_id'] as string) : 'unknown-agent';
    const justificationRaw = body['justification'];
    const justification = typeof justificationRaw === 'string' ? justificationRaw : null;

    const parsed = this.parseFederatedToolName(toolName);
    if (!parsed) {
      this.sendError(
        res,
        400,
        `tool name must match federated__<hub>__<tool>: ${toolName}`,
        'INVALID_FEDERATED_NAME',
      );
      return;
    }
    const matches = delegations.findReceivedMatch(parsed.peerHubName, parsed.tool);
    if (matches.length === 0) {
      this.sendError(
        res,
        404,
        `no active delegation for ${parsed.peerHubName}/${parsed.tool}`,
        'DELEGATION_NOT_FOUND',
      );
      return;
    }
    const delegation = matches[0]!; // ORDER BY expires_at DESC; latest wins
    if (isRevoked(delegation)) {
      this.sendError(
        res,
        403,
        `delegation ${delegation.delegation_id} revoked`,
        'DELEGATION_REVOKED',
      );
      return;
    }
    if (isExpired(delegation.expires_at)) {
      this.sendError(
        res,
        403,
        `delegation ${delegation.delegation_id} expired`,
        'DELEGATION_EXPIRED',
      );
      return;
    }

    let identity: HubIdentity;
    try {
      identity = HubIdentity.load(this.opts.db, this.opts.config.masterKey);
    } catch (err) {
      this.sendError(
        res,
        500,
        `failed to load identity: ${(err as Error).message}`,
        'IDENTITY_LOAD_FAILED',
      );
      return;
    }

    const requestId = randomBytes(8).toString('hex');
    const timestamp = new Date().toISOString();
    const outboundBody = {
      delegation_id: delegation.delegation_id,
      tool: delegation.tool,
      arguments: args,
      agent_id: agentId,
      request_id: requestId,
      timestamp,
      ...(justification ? { justification } : {}),
    };
    const raw = JSON.stringify(outboundBody);
    const sigBytes = identity.sign(new TextEncoder().encode(raw));
    const sigHeader = Buffer.from(sigBytes)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');

    const upstreamUrl = `${delegation.peer_hub_url.replace(/\/+$/, '')}/v1/federation/call`;
    let upstream: Awaited<ReturnType<typeof undiciRequest>>;
    try {
      upstream = await undiciRequest(upstreamUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-federation-pubkey': identity.publicKeyB64(),
          'x-federation-signature': sigHeader,
        },
        body: raw,
        headersTimeout: 130_000, // > A's 120s approval budget + margin
        bodyTimeout: 130_000,
      });
    } catch (err) {
      const entry = this.writeFederatedAudit({
        delegations,
        audit: this.opts.audit,
        delegation,
        agentId,
        justification,
        decisionFederated: 'federated_error',
        errorMessage: `upstream unreachable: ${(err as Error).message}`,
        startedAt,
      });
      this.opts.approval.broadcastAudit(entry);
      this.sendError(
        res,
        502,
        `federation upstream unreachable: ${(err as Error).message}`,
        'FEDERATION_UPSTREAM_ERROR',
      );
      return;
    }

    const text = await upstream.body.text();
    let parsedUpstream: Record<string, unknown> | null = null;
    try {
      parsedUpstream = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Leave as null — handled below by status code only.
    }
    const upstreamStatus = upstream.statusCode;

    if (upstreamStatus >= 200 && upstreamStatus < 300) {
      const entry = this.writeFederatedAudit({
        delegations,
        audit: this.opts.audit,
        delegation,
        agentId,
        justification,
        decisionFederated: 'federated_ok',
        errorMessage: null,
        startedAt,
      });
      this.opts.approval.broadcastAudit(entry);
      const response: CallToolResponse = {
        content:
          (parsedUpstream &&
            Array.isArray(parsedUpstream['content']) &&
            (parsedUpstream['content'] as Array<{ type: 'text'; text: string }>)) ||
          [],
        ...(parsedUpstream && typeof parsedUpstream['isError'] === 'boolean'
          ? { isError: parsedUpstream['isError'] as boolean }
          : {}),
      };
      this.sendJson(res, 200, response);
      return;
    }

    // Upstream returned 4xx/5xx — log cross-hub audit + forward.
    const code =
      parsedUpstream && typeof parsedUpstream['code'] === 'string'
        ? (parsedUpstream['code'] as string)
        : undefined;
    const upstreamError =
      parsedUpstream && typeof parsedUpstream['error'] === 'string'
        ? (parsedUpstream['error'] as string)
        : text || `upstream returned ${upstreamStatus}`;
    const decisionFederated =
      upstreamStatus === 403
        ? 'federated_denied'
        : upstreamStatus >= 500
          ? 'federated_error'
          : 'federated_error';
    const entry = this.writeFederatedAudit({
      delegations,
      audit: this.opts.audit,
      delegation,
      agentId,
      justification,
      decisionFederated,
      errorMessage: upstreamError,
      startedAt,
    });
    this.opts.approval.broadcastAudit(entry);
    this.sendError(res, upstreamStatus, upstreamError, code ?? 'FEDERATION_UPSTREAM_ERROR');
  }

  /**
   * Parse a tool name of the form `federated__<hub>__<tool>`. Returns
   * `null` when the name does not match — the caller should reject the
   * request. The peer_hub_name and tool are returned verbatim (no
   * further validation), so the delegation lookup will surface unknown
   * peer/tool combinations as `DELEGATION_NOT_FOUND`.
   */
  private parseFederatedToolName(
    name: string,
  ): { peerHubName: string; tool: string } | null {
    if (!name.startsWith('federated__')) return null;
    const rest = name.slice('federated__'.length);
    const sep = rest.indexOf('__');
    if (sep < 0) return null;
    const peerHubName = rest.slice(0, sep);
    const tool = rest.slice(sep + 2);
    if (peerHubName.length === 0 || tool.length === 0) return null;
    return { peerHubName, tool };
  }

  /**
   * Append a cross-hub audit entry on B's hub for a federated call
   * attempt. Populates `delegated_to = A_verify_key` and the appropriate
   * `decision_federated` value (Momus §"Protocol flow" Step 5). Used by
   * `handleFederationInvoke` for both successful and failed upstream
   * responses. Returns the appended entry so the caller can broadcast it
   * to live UI subscribers via `ApprovalStream.broadcastAudit`.
   */
  private writeFederatedAudit(opts: {
    delegations: DelegationStore;
    audit: AuditLog;
    delegation: DelegationReceivedRow;
    agentId: string;
    justification: string | null;
    decisionFederated: 'federated_ok' | 'federated_denied' | 'federated_error';
    errorMessage: string | null;
    startedAt: number;
  }): AuditEntry {
    const decision: 'approved' | 'denied' | 'error' =
      opts.decisionFederated === 'federated_ok' ? 'approved' : 'denied';
    return opts.audit.append({
      agent_id: opts.agentId,
      user_id: this.defaultUserId,
      tool_name: opts.delegation.tool,
      plugin: opts.delegation.plugin,
      scope: opts.delegation.scope,
      justification: opts.justification,
      decision,
      grant_id: null,
      duration_ms: Date.now() - opts.startedAt,
      ...(opts.errorMessage ? { error: opts.errorMessage } : {}),
      delegated_by: null,
      delegated_to: opts.delegation.peer_verify_key,
      decision_federated: opts.decisionFederated,
    });
  }

  /**
   * Decode an HTTP header value (which is `string | string[] | undefined`)
   * to a string. Concatenates array values with `, ` per RFC 7230. Phase 3
   * federation headers are always single-valued, so this only matters for
   * defense.
   */
  private headerStr(value: string | string[] | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (Array.isArray(value)) return value.join(', ');
    return value;
  }

  /**
   * Strict base64url decode. Throws on invalid characters or padding
   * mismatch (RFC 4648 §5).
   */
  private b64urlDecode(input: string): Uint8Array {
    if (!/^[A-Za-z0-9_-]+$/.test(input)) {
      throw new Error('invalid base64url character');
    }
    const padded =
      input.length % 4 === 0
        ? input
        : input + '='.repeat(4 - (input.length % 4));
    return new Uint8Array(Buffer.from(padded, 'base64'));
  }

  /**
   * Narrow a possibly-undefined field to a string, returning undefined
   * if the value is missing or not a string. Used for parsing the
   * JSON body of `/v1/federation/call` defensively.
   */
  private stringField(obj: Record<string, unknown> | null, key: string): string | undefined {
    if (!obj) return undefined;
    const v = obj[key];
    return typeof v === 'string' ? v : undefined;
  }

  private recordField(
    obj: Record<string, unknown> | null,
    key: string,
  ): Record<string, unknown> | undefined {
    if (!obj) return undefined;
    const v = obj[key];
    if (v === undefined) return undefined;
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  }

  /* ─── Helpers ─────────────────────────────────────────────────────────── */

  private readBody<T>(req: IncomingMessage): Promise<T> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => {
        if (!data) return resolve({} as T);
        try {
          resolve(JSON.parse(data) as T);
        } catch (err) {
          reject(new Error(`invalid JSON: ${(err as Error).message}`));
        }
      });
      req.on('error', reject);
    });
  }

  /**
   * Read the raw request body as a string AND a parsed object. The
   * Ed25519 signature is verified over the exact bytes B sent, so the
   * handler cannot use the typed `readBody<T>` helper (which re-serializes
   * through `JSON.parse`, breaking the signature).
   */
  private readRawBody(req: IncomingMessage): Promise<{ raw: string; json: unknown }> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => {
        if (!data) return resolve({ raw: '', json: {} });
        try {
          resolve({ raw: data, json: JSON.parse(data) as unknown });
        } catch (err) {
          reject(new Error(`invalid JSON: ${(err as Error).message}`));
        }
      });
      req.on('error', reject);
    });
  }

  /**
   * Increment-and-check the per-(peer_verify_key, agent_id) rate limit.
   * Returns `null` if the call is allowed (after inserting the current
   * timestamp), or a `{ retryAfterMs }` value if it exceeds the 10/min
   * ceiling (Momus I5).
   *
   * Map value is the array of recent timestamps (ms). Entries older than
   * the 60s window are trimmed on every call.
   */
  private checkFederatedRateLimit(peerVerifyKey: string, agentId: string): { retryAfterMs: number } | null {
    const key = `${peerVerifyKey}:${agentId}`;
    const now = Date.now();
    const cutoff = now - 60_000;
    const existing = this.federatedRateLimits.get(key) ?? [];
    const fresh = existing.filter((t) => t > cutoff);
    if (fresh.length >= 10) {
      const oldest = fresh[0] ?? now;
      this.federatedRateLimits.set(key, fresh);
      return { retryAfterMs: oldest + 60_000 - now };
    }
    fresh.push(now);
    this.federatedRateLimits.set(key, fresh);
    return null;
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  }

  private sendError(
    res: ServerResponse,
    status: number,
    message: string,
    code: string,
  ): void {
    const body: HubErrorResponse = { error: message, code };
    this.sendJson(res, status, body);
  }
}

/**
 * Read client credentials from environment variables.
 * Format: HUB_CLIENT_<PLUGIN_NAME>_ID, HUB_CLIENT_<PLUGIN_NAME>_SECRET
 * Example: HUB_CLIENT_GOOGLE_CALENDAR_ID, HUB_CLIENT_GOOGLE_CALENDAR_SECRET
 */
export function loadClientCredentialsFromEnv(): Map<string, PluginClientConfig> {
  const result = new Map<string, PluginClientConfig>();
  for (const [key, value] of Object.entries(process.env)) {
    const idMatch = key.match(/^HUB_CLIENT_(.+)_ID$/);
    if (idMatch && value) {
      const pluginName = idMatch[1].toLowerCase().replace(/_/g, '-');
      const secretKey = `HUB_CLIENT_${idMatch[1]}_SECRET`;
      const secret = process.env[secretKey];
      result.set(pluginName, {
        client_id: value,
        ...(secret ? { client_secret: secret } : {}),
      });
    }
  }
  return result;
}
