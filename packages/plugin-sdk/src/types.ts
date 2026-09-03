/**
 * Shared types for the pdatahub plugin SDK.
 *
 * These types describe the wire protocol between a plugin and the Hub.
 * Plugins communicate with the Hub via JSON-RPC 2.0 over stdio.
 */

/**
 * Options passed to the @Tool decorator.
 *
 * `scope` declares what the tool does (e.g., "messages.read") — the Hub uses
 * it to prompt the user for consent before invoking the tool.
 *
 * `description` is shown to the AI agent so it knows when to use the tool.
 */
export interface ToolOptions {
  scope: string;
  description: string;
}

/**
 * OAuth flow configuration.
 *
 * Describes how the Hub should perform authorization with the external service.
 */
export interface OAuthConfig {
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** HTTP method for token exchange (default: POST) */
  tokenMethod?: 'GET' | 'POST';
  /** Additional params to send with token request */
  extraTokenParams?: Record<string, string>;
}

/**
 * HTTP request metadata passed to plugin tools.
 *
 * Populated by the Hub on each tools/call invocation. Plugins should
 * read `token` to authenticate against the external service.
 */
export interface HttpContext {
  /** OAuth access token (if plugin authenticated) */
  token?: string;
  /** Hub base URL for plugin-to-hub calls (e.g., audit log) */
  hubUrl?: string;
  /** Current request ID (for tracing) */
  requestId?: string;
}

/**
 * JSON-RPC 2.0 request.
 *
 * Sent over stdin (one per line). If `id` is undefined/null, it's a notification
 * (no response expected). Otherwise, the Hub expects a response with the same id.
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: unknown;
}

/**
 * JSON-RPC 2.0 response.
 *
 * Sent over stdout (one per line). Either `result` or `error` must be present,
 * never both.
 */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

/**
 * JSON-RPC 2.0 error object.
 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * Plugin manifest: returned to the Hub on `initialize`.
 *
 * The manifest tells the Hub what the plugin is, what version, and what tools
 * it exposes. The Hub uses this for display, permission prompts, and tool
 * registration with AI agents.
 */
export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  tools: ToolDefinition[];
  oauth?: OAuthConfig;
}

/**
 * A single tool definition in the manifest.
 */
export interface ToolDefinition {
  name: string;
  scope: string;
  description: string;
}

/**
 * Shape of the params for a `tools/call` request.
 *
 * Sent by the Hub when it wants the plugin to invoke one of its tools.
 */
export interface ToolCallParams {
  /** Name of the tool to invoke (matches a method decorated with @Tool) */
  name: string;
  /** Arguments to pass to the tool method (positional, in declaration order) */
  arguments?: unknown[];
  /** Per-request context (auth token, hub URL, etc.) */
  context?: HttpContext;
}

/**
 * Shape of the params for an `initialize` request.
 */
export interface InitializeParams {
  /** Hub protocol version (semver) */
  hubVersion: string;
  /** Optional client info for debugging */
  clientInfo?: {
    name: string;
    version: string;
  };
}

/**
 * Result of a `tools/call` invocation.
 *
 * Wraps the tool's actual return so we can attach metadata (latency, etc.)
 * later without breaking the tool contract.
 */
export interface ToolCallResult {
  /** Whatever the tool method returned */
  data: unknown;
}