/**
 * Shared types for pdatahub MCP server.
 */

export interface ToolDescriptor {
  /** Abstract tool name (e.g. "calendar.read.events") or
   *  Phase 5 synthetic federated descriptor (`federated__<hub>__<tool>`). */
  name: string;
  /** Human-readable description for AI agents. */
  description: string;
  /** JSON Schema describing the tool's input shape. Metadata only — Hub validates. */
  inputSchema: Record<string, unknown>;
  /** Permission scope (e.g. "calendar:read", "messages:write"). */
  scope: string;
  /** Plugin that implements this tool (e.g. "google-calendar"). */
  plugin: string;
  /** Phase 5 (Federation v2) — `true` for synthetic federated descriptors.
   *  When set, mcp-server dispatches `callTool(name)` to
   *  `/v1/federation/invoke` instead of `/v1/tools/:name/call`. */
  federated?: boolean;
  /** Phase 5 — `peer_delegations.delegation_id`. Synthetic only. */
  delegation_id?: string;
  /** Phase 5 — display name of the peer hub (e.g. "userA"). Synthetic only. */
  peer_hub_name?: string;
  /** Phase 5 — peer hub URL (e.g. "http://userA.tailXXXX.ts.net:8080"). */
  peer_hub_url?: string;
  /** Phase 5 — ISO 8601 delegation expiry. Synthetic only. */
  expires_at?: string;
}

export interface ToolCallResult {
  /** MCP-compatible content blocks. */
  content: Array<{ type: 'text'; text: string }>;
  /** True if the Hub reported a tool-level error. */
  isError?: boolean;
}

export interface HubConfig {
  /** Base URL of the Hub (e.g. "http://192.168.1.10:8080" or via relay). */
  hubUrl: string;
  /** Session token for Hub auth (Bearer). */
  sessionToken: string;
}

export interface ListToolsResponse {
  tools: ToolDescriptor[];
}

export interface CallToolRequest {
  name: string;
  arguments: Record<string, unknown>;
}

export interface CallToolResponse extends ToolCallResult {}

export interface HubErrorResponse {
  error: string;
  code?: string;
}
