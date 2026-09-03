/**
 * HTTP client to the pdatahub Hub.
 *
 * Talks JSON over HTTP. Two endpoints:
 *   GET  /v1/tools            → list available tools
 *   POST /v1/tools/:name/call → invoke a tool
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
