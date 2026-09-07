/**
 * HTTP client to the pdatahub Hub.
 *
 * Talks JSON over HTTP. Endpoints:
 *   GET  /v1/tools                  → list available tools
 *   POST /v1/tools/:name/call       → invoke a LOCAL tool
 *   POST /v1/federation/invoke      → invoke a FEDERATED tool
 *                                     (Phase 5, Momus B6 — synthetic
 *                                     `federated__<hub>__<tool>` names)
 *
 * Auth: Bearer token from config.
 */

import { request } from 'undici';
import type {
  CallToolRequest,
  CallToolResponse,
  HubConfig,
  ListToolsResponse,
  ToolDescriptor,
} from './types.js';
import { logger } from './logger.js';

export class HubError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = 'HubError';
  }
}

export class HubClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(config: HubConfig, options: { timeoutMs?: number } = {}) {
    this.baseUrl = config.hubUrl.replace(/\/+$/, '');
    this.token = config.sessionToken;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async listTools(): Promise<ToolDescriptor[]> {
    const url = `${this.baseUrl}/v1/tools`;
    logger.debug('GET /v1/tools', { url });
    const res = await this.request('GET', url);
    const body = (await res.body.json()) as ListToolsResponse;
    return body.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResponse> {
    const url = `${this.baseUrl}/v1/tools/${encodeURIComponent(name)}/call`;
    const payload: CallToolRequest = { name, arguments: args };
    logger.debug('POST /v1/tools/:name/call', { url, name });
    const res = await this.request('POST', url, payload);
    const body = (await res.body.json()) as CallToolResponse;
    return {
      content: body.content ?? [],
      isError: body.isError ?? false,
    };
  }

  /**
   * Phase 5 — invoke a federated tool (Momus B6). hub-core looks up the
   * matching `peer_delegations` row, signs the outbound body with B's
   * identity, and POSTs to A's `/v1/federation/call`.
   *
   * `toolName` must be a synthetic federated descriptor name (the format
   * `federated__<hub>__<tool>`); hub-core rejects any other shape with
   * `INVALID_FEDERATED_NAME`. mcp-server routes here automatically based
   * on the prefix — see `PdatahubMcpServer.refreshTools`.
   *
   * The request shape (request body sent to `/v1/federation/invoke`) is
   * `{ tool, arguments, agent_id, justification? }`. `agent_id` is set
   * by hub-core from the originating MCP session; mcp-server doesn't
   * forward one explicitly. hub-core defaults to `unknown-agent` if the
   * call lacks it — see server.ts → handleFederationInvoke.
   */
  async invokeFederated(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResponse> {
    const url = `${this.baseUrl}/v1/federation/invoke`;
    const payload = { tool: toolName, arguments: args };
    logger.debug('POST /v1/federation/invoke', { url, tool: toolName });
    const res = await this.request('POST', url, payload);
    const body = (await res.body.json()) as CallToolResponse;
    return {
      content: body.content ?? [],
      isError: body.isError ?? false,
    };
  }

  private async request(
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
  ): Promise<{ statusCode: number; body: { json: () => Promise<unknown> } }> {
    let res;
    try {
      res = await request(url, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        headersTimeout: this.timeoutMs,
        bodyTimeout: this.timeoutMs,
      });
    } catch (err) {
      throw new HubError(
        `Hub request failed: ${(err as Error).message}`,
        0,
        'NETWORK_ERROR',
      );
    }
    if (res.statusCode >= 400) {
      let errorMsg = `Hub returned ${res.statusCode}`;
      try {
        const errBody = (await res.body.json()) as { error?: string; code?: string };
        if (errBody.error) errorMsg = errBody.error;
        throw new HubError(errorMsg, res.statusCode, errBody.code);
      } catch (parseErr) {
        if (parseErr instanceof HubError) throw parseErr;
        throw new HubError(errorMsg, res.statusCode);
      }
    }
    return res;
  }
}
