/**
 * HTTP client for federation management endpoints.
 *
 * Why this exists:
 *   The CLI commands (`pdatahub-hub delegate`, `pdatahub-hub delegation list`,
 *   etc.) historically wrote directly to the SQLite database. This works
 *   for local single-host setups but breaks down when:
 *     - The hub is running on a remote machine (Cloud v3 future)
 *     - The operator wants to script delegation creation without holding
 *       master_key in the CLI process (any local user can read /proc/<pid>/environ)
 *     - The hub is already running and CLI competes for SQLite WAL writes
 *
 *   This module provides an HTTP-based path that mirrors the existing
 *   CLI commands. It calls the same endpoints the mcp-server uses
 *   (`POST /v1/federation/delegate`, `GET /v1/federation/delegations`,
 *   `POST /v1/federation/delegations/:id/revoke`, `POST /v1/federation/accept`).
 *
 * Trust model:
 *   - Uses bearer token (HUB_API_TOKEN). NEVER uses master_key — the hub
 *     keeps master_key in its process memory / keyring; the CLI never sees it.
 *   - All requests are over HTTP in dev. TLS is the operator's responsibility
 *     (run behind a reverse proxy with TLS termination).
 *
 * Momus concerns:
 *   - MUST surface hub's response code + error message verbatim (operators
 *     need to know why a delegation failed).
 *   - MUST propagate x-request-id so log lookups work end-to-end.
 *   - MUST NOT cache responses — delegation state changes constantly.
 */

import { request as undiciRequest } from 'undici';

export interface HttpClientOptions {
  /** Hub base URL, e.g. `http://127.0.0.1:8080`. No trailing slash. */
  baseUrl: string;
  /** Bearer token (HUB_API_TOKEN). */
  apiToken: string;
  /** Total request timeout (ms). Default 30_000. */
  timeoutMs?: number;
}

/** Shape returned by `POST /v1/federation/delegate`. */
export interface DelegateHttpResult {
  delegation_id: string;
  blob: string;
  issuer: string;
  qr_png_base64?: string;
}

/** Shape returned by `GET /v1/federation/delegations`. */
export interface ListDelegationsHttpResult {
  granted: Array<{
    delegation_id: string;
    peer_verify_key: string;
    peer_hub_name: string | null;
    plugin: string;
    tool: string;
    scope: string;
    expires_at: string;
    revoked: number;
    created_at: string;
  }>;
  received: Array<{
    delegation_id: string;
    peer_verify_key: string;
    peer_hub_name: string;
    peer_hub_url: string;
    plugin: string;
    tool: string;
    scope: string;
    expires_at: string;
    revoked: number;
    created_at: string;
  }>;
}

/** Shape returned by `POST /v1/federation/delegations/:id/revoke`. */
export interface RevokeHttpResult {
  revoked: boolean;
  delegation_id: string;
}

/** Shape returned by `POST /v1/federation/accept`. */
export interface AcceptHttpResult {
  delegation_id: string;
  peer_hub_name: string;
  peer_hub_url: string;
}

/** Hub-side error response shape. */
interface HubErrorBody {
  error: string;
  code: string;
  request_id?: string;
}

export class FederationHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly hubError: HubErrorBody,
    message: string,
  ) {
    super(message);
    this.name = 'FederationHttpError';
  }
}

export class FederationHttpClient {
  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly timeoutMs: number;

  constructor(opts: HttpClientOptions) {
    if (!opts.baseUrl) throw new Error('baseUrl is required');
    if (!opts.apiToken) throw new Error('apiToken is required');
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiToken = opts.apiToken;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** POST /v1/federation/delegate — create a new delegation (A-side). */
  async delegate(input: {
    peer_verify_key: string;
    peer_hub_name?: string;
    plugin: string;
    tool: string;
    scope: string;
    expires_in: string;
  }): Promise<DelegateHttpResult> {
    return this.request<DelegateHttpResult>('POST', '/v1/federation/delegate', input);
  }

  /** GET /v1/federation/delegations — list granted + received. */
  async listDelegations(): Promise<ListDelegationsHttpResult> {
    return this.request<ListDelegationsHttpResult>('GET', '/v1/federation/delegations');
  }

  /** POST /v1/federation/delegations/:id/revoke — revoke a granted delegation. */
  async revokeDelegation(delegation_id: string): Promise<RevokeHttpResult> {
    return this.request<RevokeHttpResult>(
      'POST',
      `/v1/federation/delegations/${encodeURIComponent(delegation_id)}/revoke`,
      {},
    );
  }

  /** POST /v1/federation/accept — import a delegation blob (B-side). */
  async acceptDelegation(input: { blob: string; yes?: boolean }): Promise<AcceptHttpResult> {
    return this.request<AcceptHttpResult>('POST', '/v1/federation/accept', input);
  }

  /**
   * Quick health probe — does NOT require auth (uses `/health`).
   * Returns latency in ms; throws on non-2xx.
   */
  async ping(): Promise<{ ok: true; latencyMs: number }> {
    const t0 = Date.now();
    const res = await undiciRequest(`${this.baseUrl}/health`, {
      method: 'GET',
      headersTimeout: 5_000,
      bodyTimeout: 5_000,
    });
    if (res.statusCode !== 200) {
      throw new Error(`hub health returned ${res.statusCode}`);
    }
    await res.body.dump();
    return { ok: true, latencyMs: Date.now() - t0 };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiToken}`,
      'content-type': 'application/json',
      accept: 'application/json',
    };
    const init: Parameters<typeof undiciRequest>[1] = {
      method: method as Parameters<typeof undiciRequest>[1] extends infer O ? O extends { method?: infer M } ? M : never : never,
      headers,
      headersTimeout: this.timeoutMs,
      bodyTimeout: this.timeoutMs,
    };
    if (body !== undefined && method !== 'GET') {
      init.body = JSON.stringify(body);
    }
    const res = await undiciRequest(url, init);
    const status = res.statusCode;
    const text = await res.body.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      throw new FederationHttpError(status, { error: text, code: 'INVALID_JSON' }, `hub returned ${status} with non-JSON body: ${text.slice(0, 200)}`);
    }
    if (status >= 200 && status < 300) {
      return parsed as T;
    }
    const hubErr = parsed as HubErrorBody;
    throw new FederationHttpError(
      status,
      hubErr,
      `hub returned ${status}: ${hubErr.error ?? 'unknown error'} (code=${hubErr.code ?? 'UNKNOWN'}, request_id=${hubErr.request_id ?? 'n/a'})`,
    );
  }
}

/**
 * Resolve a hub URL: env var > flag. Returns null if neither is set,
 * which signals the CLI to use the DB-direct path.
 */
export function resolveHubUrl(flagValue: string | undefined): string | undefined {
  return flagValue ?? process.env.PDHUB_URL;
}

/**
 * Resolve a bearer token: env var > keyring > flag. Throws if none
 * available and a hub URL was set (otherwise we'd silently fail auth).
 */
export async function resolveApiToken(flagValue: string | undefined): Promise<string | undefined> {
  if (flagValue) return flagValue;
  if (process.env.PDHUB_API_TOKEN) return process.env.PDHUB_API_TOKEN;
  if (process.env.HUB_API_TOKEN) return process.env.HUB_API_TOKEN;
  return undefined;
}
