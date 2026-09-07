/**
 * Shared types for pdatahub Hub core.
 *
 * MUST match @pdatahub/mcp-server/src/types.ts for ToolDescriptor + CallTool shapes
 * (Hub is the source of truth, MCP server is thin proxy).
 */

/* ─── Public API (matches mcp-server contract) ──────────────────────────── */

/**
 * Hub-core's canonical tool descriptor. Matches @pdatahub/mcp-server's shape.
 *
 * Plugins return @pdatahub/plugin-sdk's `ToolDefinition[]` from their manifest.
 * Hub-core augments each with `plugin` (own name) and `inputSchema` (from the
 * manifest, or `null` when the plugin omitted it) before exposing via /v1/tools.
 *
 * `inputSchema` is `null` exactly when the plugin did not declare a schema.
 * Federation v2 (Phase 2a) refuses to delegate a tool whose schema is `null`
 * because the receiving hub has no signed input description to expose to its
 * AI. Local calls are unaffected.
 *
 * Phase 5 (Federation v2) — synthetic descriptors for federated tools extend
 * this shape with optional fields. mcp-server uses `federated: true` to
 * dispatch the call to `/v1/federation/invoke` instead of
 * `/v1/tools/:name/call`; `delegation_id` + `peer_hub_name` carry the routing
 * context. `expires_at` is the federated tool's expiry (NOT the same as a
 * local plugin's lifetime — see `peer_delegations.expires_at`).
 */
export interface ToolDescriptor {
  /** Abstract tool name (e.g. "calendar.read.events" or
   *  "federated__userA__listEvents" for Phase 5 synthetic entries). */
  name: string;
  /** Human-readable description for AI agents. */
  description: string;
  /** JSON Schema for the tool. `null` ⇒ plugin did not declare one. */
  inputSchema: Record<string, unknown> | null;
  /** Permission scope (e.g. "calendar:read", "messages:write"). */
  scope: string;
  /** Plugin that implements this tool (e.g. "google-calendar"). */
  plugin: string;
  /** Phase 5 — `true` for synthetic federated descriptors. Omitted for local. */
  federated?: boolean;
  /** Phase 5 — `peer_delegations.delegation_id` (UUID). Synthetic only. */
  delegation_id?: string;
  /** Phase 5 — display name of the peer hub (e.g. "userA"). Synthetic only. */
  peer_hub_name?: string;
  /** Phase 5 — peer hub URL (e.g. "http://userA.tailXXXX.ts.net:8080"). */
  peer_hub_url?: string;
  /** Phase 5 — ISO 8601 delegation expiry. Synthetic only. */
  expires_at?: string;
}

export interface ListToolsResponse {
  tools: ToolDescriptor[];
}

export interface CallToolRequest {
  name: string;
  arguments: Record<string, unknown>;
  /** Optional client-provided context (agent_id, justification, etc.). */
  context?: ToolCallContext;
}

export interface CallToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface ToolCallContext {
  /** AI agent identifier (e.g. "ed25519:abc123"). */
  agent_id?: string;
  /** Human-readable justification from AI agent ("user asked me to summarize today's meetings"). */
  justification?: string;
  /** Request ID for tracing (uuid v4). */
  request_id?: string;
}

export interface HubErrorResponse {
  error: string;
  code?: string;
}

/* ─── Internal: grants ──────────────────────────────────────────────────── */

/**
 * An active grant — time-bounded permission for an AI agent to invoke a tool.
 * Created when user approves a request. Revoked when expires_at passed or
 * user manually revokes.
 */
export interface Grant {
  grant_id: string;
  /** Abstract tool name (e.g. "calendar.read.events"). */
  tool_name: string;
  /** Plugin that implements the tool (e.g. "google-calendar"). */
  plugin: string;
  /** Granted scope (e.g. "calendar:read"). */
  scope: string;
  /** AI agent that requested access. */
  agent_id: string;
  /** User who owns the data. */
  user_id: string;
  /** ISO 8601 timestamp when grant was created. */
  created_at: string;
  /** ISO 8601 timestamp when grant auto-expires. */
  expires_at: string;
  /** True after manual revoke or auto-expiry. */
  revoked: boolean;
  /**
   * Phase 2b (Federation v2) — verify_key of the peer hub that initiated
   * the call (`null` for local calls). Participates in the `ensureGrant`
   * match key (Momus C1) so a local grant cannot satisfy a federated
   * call (and vice versa).
   */
  delegated_by: string | null;
}

/* ─── Internal: audit log ───────────────────────────────────────────────── */

export type AuditDecision =
  | 'approved'
  | 'denied'
  | 'auto_allowed'
  | 'expired'
  | 'revoked'
  | 'error';

export interface AuditEntry {
  /** UUID v4. */
  id: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** AI agent identifier. */
  agent_id: string;
  /** User whose data was accessed. */
  user_id: string;
  /** Tool invoked (e.g. "calendar.read.events"). */
  tool_name: string;
  /** Plugin that handled the tool. */
  plugin: string;
  /** Granted scope. */
  scope: string;
  /** AI agent's justification (or null if denied without review). */
  justification: string | null;
  /** Outcome of the request. */
  decision: AuditDecision;
  /** Grant used (null if request was denied without creating grant). */
  grant_id: string | null;
  /** How long the call took (ms). */
  duration_ms: number;
  /** Error message if decision === 'error'. */
  error?: string;
  /**
   * Phase 2b — peer verify_key when this hub received a federated call
   * (null on local calls and on the originating hub).
   */
  delegated_by: string | null;
  /**
   * Phase 2b — peer verify_key when this hub proxied a federated call out
   * (null on local calls and on the receiving hub).
   */
  delegated_to: string | null;
  /**
   * Phase 2b — Momus C3 distinct outcome on the originating hub for
   * federated calls ('federated_ok' | 'federated_denied' |
   * 'federated_error'). Null on local calls and on the receiving hub.
   */
  decision_federated: string | null;
}

/* ─── Internal: token vault ─────────────────────────────────────────────── */

/**
 * Stored OAuth token record. Encrypted at rest with AES-256-GCM.
 * Plugin NEVER sees raw token — Hub injects via SDK's httpClient.
 */
export interface TokenRecord {
  /** Plugin name (e.g. "google-calendar"). */
  plugin: string;
  /** OAuth access token (encrypted). */
  access_token_enc: Buffer;
  /** OAuth refresh token (encrypted, optional). */
  refresh_token_enc: Buffer | null;
  /** GCM auth tag for access_token. */
  access_token_tag: Buffer;
  /** GCM auth tag for refresh_token (if present). */
  refresh_token_tag: Buffer | null;
  /** GCM IV for access_token (12 bytes). */
  access_token_iv: Buffer;
  /** GCM IV for refresh_token (if present). */
  refresh_token_iv: Buffer | null;
  /** ISO 8601 timestamp when access_token expires. */
  expires_at: string | null;
  /** OAuth scopes (space-separated, as per RFC 6749). */
  scope: string;
  /** ISO 8601 timestamp when record was created. */
  created_at: string;
  /** ISO 8601 timestamp when record was last updated. */
  updated_at: string;
}

/* ─── Internal: plugin process ──────────────────────────────────────────── */

/**
 * Runtime info for a spawned plugin subprocess. Mirrors PluginManager.kt.
 */
export interface PluginProcessInfo {
  /** Plugin name (from manifest). */
  name: string;
  /** Plugin version. */
  version: string;
  /** Plugin description. */
  description: string;
  /** Absolute path to plugin entry point (dist/index.js). */
  entry_path: string;
  /** Subprocess PID. */
  pid: number;
  /** Tools exposed by this plugin (from manifest). */
  tools: ToolDescriptor[];
  /** OAuth config from manifest (if plugin needs OAuth). */
  oauth?: PluginOAuthConfig;
  /** Subprocess start time (ISO 8601). */
  started_at: string;
  /** Last heartbeat (ISO 8601). Hub kills if stale. */
  last_heartbeat: string;
}

/**
 * Plugin manifest OAuth config. Plugin declares (in SDK OAuthConfig camelCase),
 * Hub stores secrets. snake_case here for hub-core internal convention.
 */
export interface PluginOAuthConfig {
  authorization_url: string;
  token_url: string;
  scopes: string[];
  use_pkce?: boolean;
  token_method?: 'GET' | 'POST';
  extra_token_params?: Record<string, string>;
}

/* ─── Internal: approval stream (WebSocket to Android UI) ───────────────── */

export type ApprovalStreamMessage =
  | {
      type: 'approval_request';
      request_id: string;
      agent_id: string;
      tool_name: string;
      scope: string;
      justification: string | null;
      created_at: string;
      /**
       * Phase 3 (Federation v2) — verify_key of the peer hub that
       * initiated this call. Present ONLY for federated calls (i.e.
       * when A's hub received `/v1/federation/call` from B). Local
       * calls leave this undefined.
       */
      delegated_by?: string;
      /**
       * Phase 3 — display name of the peer hub (e.g. "userB"). UI uses
       * this to show "userB's agent X requests Y". Undefined for local.
       */
      peer_hub_name?: string;
      /**
       * Phase 3 — the agent_id from B's side of the call. When a
       * federated call arrives, `agent_id` above holds the LOCAL-side
       * identifier (the data owner's identity on A's hub) — this field
       * preserves B's original `agent_id` for the audit log.
       */
      peer_agent_id?: string;
    }
  | {
      type: 'approval_decided';
      request_id: string;
      decision: 'approved' | 'denied';
      grant_id?: string;
    }
  | {
      type: 'audit_update';
      entry: AuditEntry;
    }
  | {
      type: 'grant_revoked';
      grant_id: string;
    }
  | {
      type: 'pong';
    };
