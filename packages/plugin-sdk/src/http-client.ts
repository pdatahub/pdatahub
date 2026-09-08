/**
 * Authenticated HTTP client used inside plugin tool methods.
 *
 * Plugin developers use `this.httpClient!.get(...)`, `this.httpClient!.post(...)`, etc.
 * The client automatically injects the OAuth bearer token from the request
 * context, so developers never touch auth directly.
 *
 * Backed by `undici` (the same HTTP/1.1 client used by Node.js core fetch),
 * exposed via the `request()` function. The request function can be overridden
 * for testing or for custom HTTP backends.
 *
 * Error handling (v2):
 *   - Non-2xx responses are converted to typed `PluginError` subclasses
 *     via {@link mapUpstreamError} (401/403 → `AuthError` or `AuthExpiredError`,
 *     404 → `NotFoundError`, 429 → `RateLimitError`, 5xx → retryable
 *     `PluginError('UPSTREAM_ERROR')`, other 4xx → non-retryable
 *     `PluginError('CLIENT_ERROR')`).
 *   - undici timeout errors (`HeadersTimeoutError`, `BodyTimeoutError`) are
 *     wrapped in `TimeoutError` with the configured `timeoutMs`.
 *   - All other request failures (connection refused, DNS failure, etc.) are
 *     wrapped in `NetworkError` with the original error preserved as `cause`.
 */
import { request as undiciRequest } from 'undici';
import {
  AuthError,
  AuthExpiredError,
  NetworkError,
  NotFoundError,
  PluginError,
  RateLimitError,
  TimeoutError,
} from './errors.js';
import type { HttpContext } from './types.js';

export interface HttpClientOptions {
  /** Base URL prepended to relative paths. */
  baseUrl?: string;
  /** Headers added to every request. */
  defaultHeaders?: Record<string, string>;
  /** Total request timeout in milliseconds (default: 30000). */
  timeoutMs?: number;
  /**
   * Override the request function. Defaults to `undici.request`.
   * Useful for testing or for routing through a custom HTTP backend.
   */
  requestFn?: RequestFn;
}

export interface HttpRequestOptions {
  /** Query string params, appended to the URL. */
  params?: Record<string, unknown>;
}

export interface HttpResponse<T> {
  /** Parsed JSON body (or raw text if not JSON). */
  data: T;
  /** HTTP status code. */
  status: number;
  /** Response headers (lowercase keys). */
  headers: Record<string, string | string[] | undefined>;
}

/**
 * The shape of the request function we use. Mirrors undici.request's signature.
 */
export type RequestFn = (
  url: string,
  opts: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    headersTimeout: number;
    bodyTimeout: number;
  },
) => Promise<{
  statusCode: number;
  body: { text: () => Promise<string> };
  headers: Record<string, string | string[] | undefined>;
}>;

/**
 * HTTP client that automatically attaches the OAuth access token.
 *
 * Created by the Plugin base class per tool invocation. Each tool call gets
 * its own HttpClient with the current request's auth context.
 */
export class HttpClient {
  private readonly context: HttpContext;
  private readonly options: HttpClientOptions;
  private readonly requestFn: RequestFn;

  constructor(context: HttpContext, options: HttpClientOptions = {}) {
    this.context = context;
    this.options = options;
    this.requestFn = (options.requestFn ?? undiciRequest) as unknown as RequestFn;
  }

  async get<T = unknown>(
    path: string,
    options: HttpRequestOptions = {},
  ): Promise<HttpResponse<T>> {
    return this.request<T>('GET', path, options);
  }

  async post<T = unknown>(
    path: string,
    body?: unknown,
    options: HttpRequestOptions = {},
  ): Promise<HttpResponse<T>> {
    return this.request<T>('POST', path, { ...options, body });
  }

  async put<T = unknown>(
    path: string,
    body?: unknown,
    options: HttpRequestOptions = {},
  ): Promise<HttpResponse<T>> {
    return this.request<T>('PUT', path, { ...options, body });
  }

  async patch<T = unknown>(
    path: string,
    body?: unknown,
    options: HttpRequestOptions = {},
  ): Promise<HttpResponse<T>> {
    return this.request<T>('PATCH', path, { ...options, body });
  }

  async delete<T = unknown>(
    path: string,
    options: HttpRequestOptions = {},
  ): Promise<HttpResponse<T>> {
    return this.request<T>('DELETE', path, options);
  }

  private async request<T>(
    method: string,
    path: string,
    options: HttpRequestOptions & { body?: unknown } = {},
  ): Promise<HttpResponse<T>> {
    const url = this.buildUrl(path, options.params);
    const headers: Record<string, string> = {
      ...(this.options.defaultHeaders ?? {}),
    };

    if (this.context.token) {
      headers['Authorization'] = `Bearer ${this.context.token}`;
    }

    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    const timeout = this.options.timeoutMs ?? 30000;

    let response: Awaited<ReturnType<RequestFn>>;
    try {
      response = await this.requestFn(url, {
        method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        headers,
        body,
        headersTimeout: timeout,
        bodyTimeout: timeout,
      });
    } catch (err) {
      const e = err as Error;
      if (isUndiciTimeoutError(e)) {
        throw new TimeoutError(timeout, `${method} ${path}`);
      }
      throw new NetworkError(
        `Network failure during ${method} ${path}: ${e.message}`,
        e,
      );
    }

    const text = await response.body.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw mapUpstreamError(response.statusCode, data);
    }

    return {
      data: data as T,
      status: response.statusCode,
      headers: response.headers,
    };
  }

  private buildUrl(path: string, params?: Record<string, unknown>): string {
    let url = path.startsWith('http')
      ? path
      : `${this.options.baseUrl ?? ''}${path}`;

    if (params && Object.keys(params).length > 0) {
      const search = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        search.append(k, String(v));
      }
      const qs = search.toString();
      if (qs.length > 0) {
        const separator = url.includes('?') ? '&' : '?';
        url += separator + qs;
      }
    }

    return url;
  }
}

/**
 * Map an upstream HTTP error status + body to the matching typed
 * `PluginError` subclass. Exported so {@link MockHttpClient} can share
 * the same mapping (mock and real HTTP raise identical errors).
 *
 * Mapping (matches the design doc § 6):
 *   - 401/403 with `expires_at` or `error: 'expired'` → `AuthExpiredError`
 *   - 401/403 (other)                                 → `AuthError` (non-retryable)
 *   - 404                                            → `NotFoundError`
 *   - 429                                            → `RateLimitError` (parses `retry_after`)
 *   - 5xx                                            → `PluginError('UPSTREAM_ERROR', retryable=true)`
 *   - other 4xx                                      → `PluginError('CLIENT_ERROR', retryable=false)`
 */
export function mapUpstreamError(status: number, body: unknown): PluginError {
  const bodyObj = (body && typeof body === 'object'
    ? (body as Record<string, unknown>)
    : null);
  const bodyStr =
    typeof body === 'string'
      ? body
      : body !== undefined && body !== null
        ? JSON.stringify(body)
        : '';

  if (status === 401 || status === 403) {
    const errField =
      typeof bodyObj?.['error'] === 'string' ? bodyObj['error'] : undefined;
    const expiresAtField =
      typeof bodyObj?.['expires_at'] === 'string'
        ? bodyObj['expires_at']
        : undefined;
    if (
      (typeof errField === 'string' && errField.includes('expired')) ||
      expiresAtField !== undefined
    ) {
      return new AuthExpiredError(
        expiresAtField ? new Date(expiresAtField) : undefined,
      );
    }
    return new AuthError(`HTTP ${status}: ${bodyStr}`, { status, body });
  }

  if (status === 404) {
    return new NotFoundError('upstream', String(body));
  }

  if (status === 429) {
    const retryAfterRaw =
      typeof bodyObj?.['retry_after'] === 'number'
        ? (bodyObj['retry_after'] as number)
        : typeof bodyObj?.['retryAfter'] === 'number'
          ? (bodyObj['retryAfter'] as number)
          : undefined;
    const retryAfterMs =
      retryAfterRaw !== undefined ? Math.round(retryAfterRaw * 1000) : undefined;
    return new RateLimitError(retryAfterMs);
  }

  if (status >= 500) {
    return new PluginError(
      'UPSTREAM_ERROR',
      `Upstream ${status}: ${bodyStr}`,
      true,
      { status, body },
    );
  }

  return new PluginError(
    'CLIENT_ERROR',
    `HTTP ${status}: ${bodyStr}`,
    false,
    { status, body },
  );
}

/**
 * Detect undici timeout errors by class name.
 *
 * undici exports `HeadersTimeoutError` and `BodyTimeoutError` as named
 * classes; the cleanest portable check is `error.name` because we don't
 * want to import undici's internal type re-exports just for an `instanceof`.
 */
function isUndiciTimeoutError(err: Error): boolean {
  return (
    err.name === 'HeadersTimeoutError' ||
    err.name === 'BodyTimeoutError' ||
    err.name === 'SocketTimeoutError'
  );
}