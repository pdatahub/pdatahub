/**
 * Authenticated HTTP client used inside plugin tool methods.
 *
 * Plugin developers use `this.http!.get(...)`, `this.http!.post(...)`, etc.
 * The client automatically injects the OAuth bearer token from the request
 * context, so developers never touch auth directly.
 *
 * Backed by `undici` (the same HTTP/1.1 client used by Node.js core fetch),
 * exposed via the `request()` function. The request function can be overridden
 * for testing or for custom HTTP backends.
 */
import { request as undiciRequest } from 'undici';
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

    const response = await this.requestFn(url, {
      method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      headers,
      body,
      headersTimeout: timeout,
      bodyTimeout: timeout,
    });

    const text = await response.body.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
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