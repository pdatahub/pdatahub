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
 *
 * `inputSchema` is an OPTIONAL JSON Schema describing the tool's input shape.
 * Used to expose the tool over MCP-style endpoints and required when the
 * tool participates in Phase 2a Federation v2 delegations — the Hub embeds
 * the schema in the signed delegation blob so the receiving hub can describe
 * the tool to its AI without trusting out-of-band metadata. When undefined,
 * the Hub treats the tool as "no schema declared" and refuses to federate it.
 */
export interface ToolOptions {
  scope: string;
  description: string;
  /** JSON Schema (object). Omit only when the tool accepts arbitrary input. */
  inputSchema?: Record<string, unknown>;
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
 * Protocol version constants for the plugin ↔ Hub wire format.
 *
 *   - `1` — v0.1.x SDK (current baseline). No typed errors, no schema
 *     validation, no lifecycle hooks. Hub falls back to string-error
 *     handling.
 *   - `2` — v0.2.x SDK (this release). Typed errors, JSON Schema input
 *     validation, lifecycle hooks, health checks.
 *
 * Plugins opt in by setting `protocolVersion = 2` on the subclass. The
 * default (when not set) is `1` for backward compatibility — existing
 * plugins keep working unchanged.
 */
export type ProtocolVersion = 1 | 2;

/**
 * Plugin capability flags reported in the manifest.
 *
 * Each flag indicates the plugin uses a v2 feature so the Hub can
 * negotiate behavior. Capabilities are advisory — the Hub may enable
 * a feature even without the flag (e.g., always parse JSON-RPC error.data
 * as a PluginErrorPayload), but the flag is a clear signal.
 */
export type PluginCapability =
  | 'typed-errors'      // Plugin throws PluginError subclasses
  | 'schema-validation' // Plugin uses inputSchema in @Tool
  | 'lifecycle-hooks'   // Plugin implements lifecycle methods
  | 'health-check';     // Plugin implements health()

/**
 * Names of lifecycle hooks the Hub may invoke over the `plugin.lifecycle`
 * JSON-RPC method. The transport does not know about lifecycle itself;
 * `Plugin.dispatch()` routes `plugin.lifecycle` requests to the matching
 * method on the plugin instance.
 */
export type LifeCycleHook =
  | 'install'
  | 'uninstall'
  | 'activate'
  | 'deactivate'
  | 'health';

/**
 * Params for a `plugin.lifecycle` JSON-RPC request.
 */
export interface LifeCycleParams {
  hook: LifeCycleHook;
}

/**
 * Result of a `plugin.lifecycle` JSON-RPC request.
 *
 * For `health` hook, `result` carries the plugin's health status.
 * For other hooks, `result` is `null` (or omitted) on success.
 */
export interface LifeCycleResult {
  /** Present only for the `health` hook. */
  status?: 'healthy' | 'degraded' | 'unhealthy';
  /** Human-readable message accompanying the status (especially for non-healthy). */
  message?: string;
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
  /**
   * SDK protocol version. `1` for v0.1.x (default), `2` for v0.2.x.
   * Required to be present in the manifest when the plugin opts in to v2;
   * the manifest builder defaults to `1` for backward compatibility.
   */
  protocolVersion: ProtocolVersion;
  tools: ToolDefinition[];
  oauth?: OAuthConfig;
  /**
   * Optional list of v2 capabilities the plugin uses. Advisory — the Hub
   * may warn on unknown capabilities but does not reject.
   */
  capabilities?: PluginCapability[];
}

/**
 * A single tool definition in the manifest.
 *
 * `inputSchema` is JSON Schema for the tool's input. Optional — `undefined`
 * means the plugin did not declare a schema (Hub blocks federation for such
 * tools but still permits local calls).
 */
export interface ToolDefinition {
  name: string;
  scope: string;
  description: string;
  inputSchema?: Record<string, unknown>;
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
  * MCP-compliant content array. Plugin tool methods return arbitrary
  * data; the SDK wraps it into this format before sending to the Hub
  * over JSON-RPC. Plugins should NOT construct this type themselves —
  * they write normal tool methods returning whatever shape they want.
   */
export interface ToolCallResult {
  /**
   * Plugin's raw return value (v2 single-object args pattern). The Hub
   * wraps this into MCP `content` format before forwarding to
   * mcp-server. Tests assert against this field directly.
   */
  data: unknown;
  /**
   * Optional MCP content array. v1 plugins returned this directly;
   * kept optional so test fixtures and legacy plugins still typecheck.
   * Hub prefers `data` when present, falls back to `content`.
   */
  content?: Array<{ type: 'text'; text: string }>;
  /** Set true when the tool ran but reported a logical error. */
  isError?: boolean;
}