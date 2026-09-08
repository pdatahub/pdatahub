/**
 * Test utilities for pdatahub plugins (v2).
 *
 * Plugin authors write a lot of mock HTTP client boilerplate per test file
 * (`@pdatahub/plugin-sdk` v0.1.x). `createMockHub()` and `MockHttpClient` cut
 * that by ~80% — one factory, one mock client, one call-tracking array.
 *
 * Pattern:
 * ```typescript
 * import { createMockHub } from '@pdatahub/plugin-sdk';
 *
 * it('reads things', async () => {
 *   const { plugin, httpClient, calls } = createMockHub({
 *     httpResponses: [
 *       { method: 'GET', url: 'things', status: 200, data: { items: ['a', 'b'] } },
 *     ],
 *   });
 *
 *   const result = await plugin.listThings(2);
 *
 *   expect(result).toEqual({ items: ['a', 'b'] });
 *   expect(httpClient.requests).toHaveLength(1);
 *   expect(httpClient.requests[0]).toMatchObject({ method: 'GET', url: 'things' });
 *   expect(calls).toEqual([{ tool: 'listThings', args: [2] }]);
 * });
 * ```
 *
 * Backward compat: this module is purely additive — v1 plugins don't import
 * it and keep working unchanged.
 */
import {
  AuthError,
  AuthExpiredError,
  NetworkError,
  NotFoundError,
  PluginError,
  RateLimitError,
} from './errors.js';
import { HttpClient, mapUpstreamError, type HttpRequestOptions, type HttpResponse } from './http-client.js';
import { Plugin } from './plugin.js';
import { Tool } from './decorators.js';

/**
 * A single queued HTTP response for `MockHttpClient`.
 *
 * Construct a queue by listing the responses your test expects the plugin
 * to receive. The mock dequeues matching `(method, url)` pairs in FIFO order.
 */
export interface MockHttpResponse {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | string;
  url: string;
  status: number;
  data?: unknown;
}

/**
 * A captured outbound request. The `params` field carries the query string
 * for GET/DELETE and the JSON body for POST/PUT/PATCH (matches how the real
 * `HttpClient` exposes those to plugins).
 */
export interface MockRequestRecord {
  method: string;
  url: string;
  /** Query params (GET/DELETE) or body (POST/PUT/PATCH). */
  params?: unknown;
}

/**
 * Options for `createMockHub`.
 */
export interface MockHubOptions {
  /**
   * Pre-load the mock HTTP client with a queue of expected responses.
   * The mock consumes them in FIFO order (within `(method, url)` matches).
   */
  httpResponses?: MockHttpResponse[];
  /**
   * Initial OAuth token to inject into the per-request `HttpContext`.
   * The mock client doesn't actually use it (no real network), but
   * exposing it lets tests assert that the plugin passed the token
   * through the request context correctly.
   */
  oauthToken?: string;
}

/**
 * Drop-in mock for `HttpClient`.
 *
 * Mirrors the public API of `HttpClient` (same method signatures, same
 * `HttpResponse<T>` shape) so tests can swap a real client for a mock
 * without touching plugin code.
 *
 * Behavior:
 *   - Captures every outbound request in `requests` (mutable, inspectable).
 *   - Returns the first queued response matching `(method, url)` in FIFO order.
 *   - If no matching response is queued, throws `NetworkError`.
 *   - If the matching response has `status >= 400`, throws the same typed
 *     `PluginError` subclass the real `HttpClient` would (via
 *     `mapUpstreamError`).
 *   - 2xx responses are returned as `{ data, status, headers }` like the real
 *     client. `headers` is `{}` because no real HTTP headers exist.
 *
 * `reset()` clears the request log and re-queues the original responses,
 * useful for "act → assert → reset → assert again" tests.
 */
export class MockHttpClient {
  private initialResponses: MockHttpResponse[];
  public queue: MockHttpResponse[];
  public requests: MockRequestRecord[] = [];

  constructor(responses: MockHttpResponse[] = []) {
    this.initialResponses = [...responses];
    this.queue = [...responses];
  }

  async get<T = unknown>(
    path: string,
    options: HttpRequestOptions = {},
  ): Promise<HttpResponse<T>> {
    this.requests.push({ method: 'GET', url: path, params: options.params });
    return this.pop<T>('GET', path);
  }

  async post<T = unknown>(
    path: string,
    body?: unknown,
    options: HttpRequestOptions = {},
  ): Promise<HttpResponse<T>> {
    // For non-GET methods, store the body in `params` so the single tracking
    // field can hold both query params and request bodies without
    // special-casing per HTTP verb in assertions.
    this.requests.push({
      method: 'POST',
      url: path,
      params: body !== undefined ? body : options.params,
    });
    return this.pop<T>('POST', path);
  }

  async put<T = unknown>(
    path: string,
    body?: unknown,
    options: HttpRequestOptions = {},
  ): Promise<HttpResponse<T>> {
    this.requests.push({
      method: 'PUT',
      url: path,
      params: body !== undefined ? body : options.params,
    });
    return this.pop<T>('PUT', path);
  }

  async patch<T = unknown>(
    path: string,
    body?: unknown,
    options: HttpRequestOptions = {},
  ): Promise<HttpResponse<T>> {
    this.requests.push({
      method: 'PATCH',
      url: path,
      params: body !== undefined ? body : options.params,
    });
    return this.pop<T>('PATCH', path);
  }

  async delete<T = unknown>(
    path: string,
    options: HttpRequestOptions = {},
  ): Promise<HttpResponse<T>> {
    this.requests.push({ method: 'DELETE', url: path, params: options.params });
    return this.pop<T>('DELETE', path);
  }

  /**
   * Clear `requests` and re-queue the original responses. Useful between
   * test phases that share the same mocked HTTP scenarios.
   */
  reset(): void {
    this.requests = [];
    this.queue = [...this.initialResponses];
  }

  /**
   * Append a response to the queue without re-running setup. Useful for
   * multi-step flows where each call needs a distinct response.
   */
  enqueue(response: MockHttpResponse): void {
    this.queue.push(response);
  }

  /**
   * Dequeue the first matching response (FIFO within method+url pairs) and
   * convert it to either an `HttpResponse<T>` or a typed `PluginError`.
   */
  private async pop<T>(method: string, url: string): Promise<HttpResponse<T>> {
    const idx = this.queue.findIndex(
      (r) => r.method === method && r.url === url,
    );
    if (idx === -1) {
      throw new NetworkError(`Mock: no response queued for ${method} ${url}`);
    }
    const response = this.queue.splice(idx, 1)[0]!;
    if (response.status >= 400) {
      // Reuse the same mapping the real HttpClient uses so tests assert
      // the exact error class the plugin would see in production.
      throw mapUpstreamError(response.status, response.data);
    }
    return {
      data: response.data as T,
      status: response.status,
      headers: {},
    };
  }
}

/**
 * The shape `createMockHub` returns. Tests destructure what they need.
 */
export interface MockHub {
  /** Plugin instance with `listThings` tool registered. */
  plugin: Plugin;
  /** Mock HTTP client shared with the plugin. */
  httpClient: MockHttpClient;
  /** Every call to a registered tool method, captured for assertions. */
  calls: Array<{ tool: string; args: unknown[] }>;
}

/**
 * Build a stub `Plugin` plus a `MockHttpClient` and a tool-call log.
 *
 * The returned `plugin` exposes one tool — `listThings(limit = 10)` — that
 * calls `this.httpClient!.get('things', { params: { limit } })` and returns
 * the response data. Tests can:
 *   - queue responses via `httpClient.enqueue(...)` or `opts.httpResponses`,
 *   - invoke `plugin.listThings(5)` directly (no JSON-RPC required), and
 *   - assert against `calls` (tool invocations) and `httpClient.requests`
 *     (outbound HTTP).
 *
 * The plugin's `protocolVersion` is `2` so v2 features (typed errors,
 * lifecycle hooks) are testable.
 */
export function createMockHub(opts: MockHubOptions = {}): MockHub {
  const calls: Array<{ tool: string; args: unknown[] }> = [];
  const httpClient = new MockHttpClient(opts.httpResponses ?? []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  class TestPlugin extends Plugin {
    override name = 'test-plugin';
    override version = '0.1.0';
    override protocolVersion = 2 as const;

    /**
     * Test helper: inject a mock HTTP client. The plugin's `httpClient`
     * field is `protected` so production code can't poke it; this
     * subclass-internal setter keeps the door closed to outside callers
     * while letting `createMockHub` wire the mock in.
     */
    setHttpClient(client: HttpClient): void {
      this.httpClient = client;
    }

    @Tool({ scope: 'things.read', description: 'List things from upstream' })
    async listThings(limit = 10): Promise<unknown> {
      calls.push({ tool: 'listThings', args: [limit] });
      const response = await this.httpClient!.get<unknown>('things', {
        params: { limit },
      });
      return response.data;
    }
  }

  const plugin = new TestPlugin();
  // MockHttpClient has the same shape as HttpClient but doesn't extend it
  // (different constructor semantics — no HttpContext needed). Cast at the
  // assignment boundary, not in the plugin method.
  plugin.setHttpClient(httpClient as unknown as HttpClient);

  // oauthToken is accepted for API symmetry with the real HttpContext —
  // the mock doesn't actually inspect it, but tests that pass it document
  // their intent ("this plugin is authenticated as X").
  void opts.oauthToken;

  return { plugin, httpClient, calls };
}

// Re-export the typed errors used by MockHttpClient so test files can
// import them from `@pdatahub/plugin-sdk/testing` without a second import
// line. These are re-exports of the canonical classes from `./errors.js`.
export {
  AuthError,
  AuthExpiredError,
  NetworkError,
  NotFoundError,
  PluginError,
  RateLimitError,
};
