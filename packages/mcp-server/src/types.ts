/**
 * Shared types for pdatahub MCP server.
 */

export interface ToolDescriptor {
  /** Abstract tool name (e.g. "calendar.read.events"). */
  name: string;
  /** Human-readable description for AI agents. */
  description: string;
  /** JSON Schema describing the tool's input shape. Metadata only — Hub validates. */
  inputSchema: Record<string, unknown>;
  /** Permission scope (e.g. "calendar:read", "messages:write"). */
  scope: string;
  /** Plugin that implements this tool (e.g. "google-calendar"). */
  plugin: string;
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
