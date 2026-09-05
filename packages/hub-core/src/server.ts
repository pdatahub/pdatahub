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
  CallToolRequest,
  CallToolResponse,
  HubErrorResponse,
  ListToolsResponse,
  PluginProcessInfo,
} from './types.js';
import { logger } from './logger.js';

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
}

export class HubServer {
  private readonly opts: HubServerOptions;
  private server: Server | null = null;
  /** Default user_id for single-user self-hosted MVP. */
  private readonly defaultUserId = 'local-user';

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

      this.sendError(res, 404, `not found: ${req.method} ${url.pathname}`, 'NOT_FOUND');
    } catch (err) {
      logger.error('request handler error', { error: (err as Error).message });
      this.sendError(res, 500, `internal error: ${(err as Error).message}`, 'INTERNAL_ERROR');
    }
  }

  private checkAuth(req: IncomingMessage): boolean {
    const expected = process.env.HUB_API_TOKEN;
    if (!expected) {
      // No token configured = open access (dev mode)
      logger.warn('HUB_API_TOKEN not set, allowing unauthenticated access (dev only)');
      return true;
    }
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return false;
    return auth.slice(7) === expected;
  }

  private async handleListTools(res: ServerResponse): Promise<void> {
    const tools = this.opts.registry.listAllTools();
    const body: ListToolsResponse = { tools };
    this.sendJson(res, 200, body);
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
      });
      this.sendError(res, 403, `approval denied: ${(err as Error).message}`, 'APPROVAL_DENIED');
      return;
    }

    // Inject token from vault
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
   * Ensure a valid grant exists for this (tool, agent). Requests approval if not.
   * Returns the grant (creates one if approved).
   */
  private async ensureGrant(opts: {
    tool_name: string;
    plugin: string;
    agent_id: string;
    user_id: string;
  }): Promise<import('./types.js').Grant> {
    // Check existing grants (re-use if same agent + scope matches)
    const existing = this.opts.grants
      .listActiveForUser(opts.user_id)
      .find(
        (g) =>
          g.tool_name === opts.tool_name &&
          g.agent_id === opts.agent_id &&
          g.plugin === opts.plugin,
      );
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
