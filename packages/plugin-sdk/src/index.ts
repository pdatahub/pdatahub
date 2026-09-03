/**
 * Public API for @pdatahub/plugin-sdk.
 *
 * Plugins import from this entrypoint:
 * ```typescript
 * import { Plugin, Tool, OAuth } from '@pdatahub/plugin-sdk';
 * ```
 */
export { Plugin } from './plugin.js';
export { Tool, OAuth, getToolsForClass, getOAuthForClass } from './decorators.js';
export { HttpClient } from './http-client.js';
export type { HttpClientOptions, HttpRequestOptions, HttpResponse } from './http-client.js';
export { Logger } from './logger.js';
export { StdioTransport } from './transport.js';
export type { StdioTransportOptions, RequestHandler } from './transport.js';
export { buildManifest } from './manifest.js';

export type {
  ToolDefinition,
  ToolOptions,
  OAuthConfig,
  HttpContext,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  PluginManifest,
  ToolCallParams,
  ToolCallResult,
  InitializeParams,
} from './types.js';