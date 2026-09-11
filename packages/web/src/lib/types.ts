/**
 * Hub-core API response types.
 *
 * Mirror of types defined in hub-core/src/server.ts. Kept inline here
 * rather than sharing via @pdatahub/types so the web package stays
 * zero-dep at runtime (it's a static SPA served by hub-core).
 */

export interface IdentityResponse {
  hub_name: string;
  verify_key: string;
  public_key_b64?: string;
  magic_dns?: string | null;
  fingerprint?: string;
}

export interface StatusResponse {
  uptime_sec: number;
  plugin_count: number;
  ws_clients: number;
  audit_count: number;
  federation_enabled: boolean;
  rate_limit_enabled: boolean;
  hub_version: string;
}

export interface HealthResponse {
  status: 'ok';
  service: string;
}

export interface ToolDescriptor {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  scope?: string;
  plugin: string;
  federated?: boolean;
  peer_hub_name?: string;
}

export interface ListToolsResponse {
  tools: ToolDescriptor[];
}

export interface AuditEntry {
  id: number;
  ts: string;
  agent_id: string;
  user_id: string;
  tool_name: string | null;
  plugin: string | null;
  scope: string | null;
  justification: string | null;
  decision: 'approved' | 'denied' | 'error';
  grant_id: number | null;
  duration_ms: number | null;
  error?: string | null;
}

export interface ListAuditResponse {
  entries: AuditEntry[];
  total: number;
}

export interface ApprovalRequest {
  type: 'approval_request';
  request_id: string;
  tool_name: string;
  plugin: string;
  scope: string;
  agent_id: string;
  justification?: string;
}

export interface HubErrorResponse {
  error: string;
  code: string;
  request_id?: string;
}

export interface OAuthStatusResponse {
  plugin: string;
  requires_oauth: boolean;
  configured: boolean;
  connected: boolean;
  expires_at?: string;
}

export interface OAuthStartResponse {
  authorization_url: string;
  state: string;
  callback_port: number;
}

/**
 * PUT body for OAuth credentials. Use EITHER the raw fields OR the
 * Google JSON dump, not both — the hub picks whichever is set.
 */
export interface OAuthCredentialsInput {
  client_id?: string;
  client_secret?: string;
  google_oauth_client_json?: string;
}
