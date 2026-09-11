/**
 * Typed fetch wrappers for hub-core's `/v1/*` API.
 *
 * - All requests use the same base URL the page was loaded from
 *   (so the web UI works whether hub is at :8080, behind a reverse proxy,
 *   or via Tailscale magic DNS).
 * - The bearer token is read from a session-scoped writable store
 *   (set on first run via /v1/auth/pin if exposed, or empty for localhost).
 * - Errors throw `HubError` with status + code + request_id for the user
 *   to quote in bug reports.
 */

import type {
  AuditEntry,
  HealthResponse,
  HubErrorResponse,
  IdentityResponse,
  ListAuditResponse,
  ListToolsResponse,
  StatusResponse,
} from './types';
import { getApiToken } from './stores/session';

export class HubError extends Error {
  constructor(
    public readonly status: number,
    public readonly hubCode: string,
    public readonly requestId: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'HubError';
  }
}

interface FetchOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(path: string, opts: FetchOptions = {}): Promise<T> {
  const url = `${window.location.origin}${path}`;
  const headers: Record<string, string> = {};
  const token = getApiToken();
  if (token) headers['authorization'] = `Bearer ${token}`;

  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers,
    body,
    signal: opts.signal,
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new HubError(res.status, 'INVALID_JSON', undefined, `hub returned non-JSON: ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const e = parsed as HubErrorResponse;
    throw new HubError(
      res.status,
      e.code ?? 'UNKNOWN',
      e.request_id,
      e.error ?? `hub returned ${res.status}`,
    );
  }

  return parsed as T;
}

export const api = {
  health: () => request<HealthResponse>('/health'),

  identity: () => request<IdentityResponse>('/v1/identity'),

  status: () => request<StatusResponse>('/v1/status'),

  listTools: () => request<ListToolsResponse>('/v1/tools'),

  listAudit: (params: { limit?: number; offset?: number; plugin?: string; decision?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.offset) qs.set('offset', String(params.offset));
    if (params.plugin) qs.set('plugin', params.plugin);
    if (params.decision) qs.set('decision', params.decision);
    const suffix = qs.toString() ? `?${qs}` : '';
    return request<ListAuditResponse>(`/v1/audit${suffix}`);
  },

  installPlugin: (url: string) =>
    request<{ installed: string }>('/v1/plugins/install', {
      method: 'POST',
      body: { url },
    }),
};
