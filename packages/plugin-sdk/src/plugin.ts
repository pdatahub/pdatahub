/**
 * Plugin base class for pdatahub.
 *
 * Subclass this and decorate your methods with @Tool to expose them as
 * callable tools. Decorate the class with @OAuth if your plugin requires
 * authentication.
 *
 * Example:
 * ```typescript
 * @OAuth({
 *   authorizationUrl: 'https://slack.com/oauth/authorize',
 *   tokenUrl: 'https://slack.com/api/oauth.token',
 *   scopes: ['channels:history'],
 * })
 * class SlackPlugin extends Plugin {
 *   name = 'slack';
 *   version = '0.1.0';
 *   protocolVersion = 2 as const;
 *
 *   @Tool({ scope: 'messages.read', description: 'Read recent messages' })
 *   async readMessages(channel: string) {
 *     const r = await this.http!.get('conversations.history', { params: { channel } });
 *     return r.data;
 *   }
 * }
 *
 * new SlackPlugin().start();
 * ```
 */
import { HttpClient } from './http-client.js';
import { Logger } from './logger.js';
import { buildManifest } from './manifest.js';
import { StdioTransport } from './transport.js';
import type {
  InitializeParams,
  JsonRpcRequest,
  JsonRpcResponse,
  LifeCycleHook,
  LifeCycleParams,
  LifeCycleResult,
  PluginManifest,
  ToolCallParams,
  ToolCallResult,
} from './types.js';

/**
 * Lifecycle hooks (v2).
 *
 * Subclasses override these to react to install/activate/deactivate/uninstall
 * events from the Hub and to expose a health probe. All defaults are no-ops
 * so v1 plugins continue to work unchanged.
 *
 * The Hub invokes these via a single JSON-RPC method `plugin.lifecycle`
 * with `{ hook: 'install' | 'uninstall' | ... }`. `Plugin.dispatch()`
 * routes those calls to the matching method on the subclass instance.
 */
export interface PluginLifecycle {
  /** Called once when the plugin is installed (after OAuth setup). */
  onInstall?(): Promise<void>;
  /** Called when the plugin is uninstalled (before cleanup). */
  onUninstall?(): Promise<void>;
  /** Called when the plugin subprocess starts (after manifest sent). */
  onActivate?(): Promise<void>;
  /** Called before the subprocess exits (SIGTERM, user shutdown). */
  onDeactivate?(): Promise<void>;
  /**
   * Optional health check. Called by the Hub every 5 min.
   * `degraded`/`unhealthy` statuses surface to the user; `healthy` is silent.
   */
  health?(): Promise<{ status: 'healthy' | 'degraded' | 'unhealthy'; message?: string }>;
}

/**
 * Map from lifecycle hook name to the method on the plugin class that
 * implements it. Used by `Plugin.dispatch()` to route `plugin.lifecycle`
 * JSON-RPC requests.
 */
const LIFECYCLE_HOOK_TO_METHOD: Record<LifeCycleHook, string> = {
  install: 'onInstall',
  uninstall: 'onUninstall',
  activate: 'onActivate',
  deactivate: 'onDeactivate',
  health: 'health',
};

/** Default timeout for lifecycle hooks (ms). Health uses a shorter timeout. */
const LIFECYCLE_DEFAULT_TIMEOUT_MS = 30_000;
const LIFECYCLE_HEALTH_TIMEOUT_MS = 5_000;

/**
 * Abstract base class for pdatahub plugins.
 *
 * Subclasses MUST set `name` and `version` as instance fields.
 * v2 plugins additionally set `protocolVersion = 2 as const` to opt in to
 * typed errors, schema validation, and lifecycle hooks.
 */
export abstract class Plugin implements PluginLifecycle {
  abstract name: string;
  abstract version: string;
  description?: string;

  /**
   * SDK protocol version. Defaults to `1` (v0.1.x compat) for backward
   * compatibility — v1 plugins keep working unchanged. To opt in to v2
   * features (typed errors, schema validation, lifecycle hooks), set
   * `protocolVersion = 2 as const` in your subclass.
   */
  protocolVersion: 1 | 2 = 1;

  /** HTTP client for the current tool invocation. Set per-request by handleToolCall. */
  protected httpClient: HttpClient | undefined;

  /** Logger instance. Initialized in start(). */
  protected logger: Logger | undefined;

  /**
   * Override to handle OAuth code exchange.
   *
   * Default implementation throws. Override to:
   * 1. Exchange the `code` for an access token by calling your `tokenUrl`
   * 2. Store the token somewhere persistent (the Hub typically handles this,
   *    but if you want plugin-side storage, do it here)
   * 3. Return the access token info
   */
  async handleOAuthCallback(
    _code: string,
    _redirectUri?: string,
  ): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
  }> {
    throw new Error(
      'handleOAuthCallback() not implemented. Override this method in your plugin subclass.',
    );
  }

  /**
   * Lifecycle hook: called once after `initialize`, before any tools/call.
   *
   * Use for setup, fetching initial state, warming caches, etc.
   * Default: no-op.
   */
  async onStart(): Promise<void> {
    // Default: no-op
  }

  /**
   * Exit the process. Called via setImmediate after handling `shutdown`,
   * giving the JSON-RPC response time to be written first.
   *
   * Override in tests to prevent the test runner from exiting.
   */
  exit(code: number): never {
    return process.exit(code);
  }

  /**
   * Lifecycle hook: called when Hub sends `shutdown` notification.
   *
   * Use for cleanup (close DB connections, flush logs, etc.).
   * Default: no-op.
   */
  async onShutdown(): Promise<void> {
    // Default: no-op
  }

  /**
   * Lifecycle hook: called after each successful tool invocation.
   *
   * Default: no-op.
   */
  async onToolResult(_name: string, _result: unknown): Promise<void> {
    // Default: no-op
  }

  // v2 lifecycle hooks — all no-ops by default. Subclasses override.
  async onInstall(): Promise<void> {
    // Default: no-op
  }
  async onUninstall(): Promise<void> {
    // Default: no-op
  }
  async onActivate(): Promise<void> {
    // Default: no-op
  }
  async onDeactivate(): Promise<void> {
    // Default: no-op
  }
  async health(): Promise<{ status: 'healthy' }> {
    return { status: 'healthy' };
  }

  /**
   * Start the plugin: listen for JSON-RPC requests on stdin.
   *
   * This is the main entry point. It runs for the lifetime of the process.
   */
  async start(): Promise<void> {
    const transport = new StdioTransport(this.name);
    this.logger = new Logger(this.name);

    this.logger.info(`Plugin ${this.name} v${this.version} starting...`);

    await transport.listen(async (req: JsonRpcRequest): Promise<JsonRpcResponse | null> => {
      return this.dispatch(req);
    });
  }

  /**
   * Dispatch a JSON-RPC request to the appropriate handler.
   *
   * Exposed for testing — production code uses `start()` which calls this.
   */
  async dispatch(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    switch (req.method) {
      case 'initialize': {
        const params = (req.params ?? {}) as InitializeParams;
        this.logger?.info(`initialize (hub ${params.hubVersion})`);
        await this.onStart();

        let manifest: PluginManifest;
        try {
          manifest = buildManifest(this, this.description);
        } catch (err) {
          return this.errorResponse(req.id, -32603, (err as Error).message);
        }

        this.logger?.info(`Initialized with ${manifest.tools.length} tools`);
        return {
          jsonrpc: '2.0',
          id: req.id ?? null,
          result: manifest,
        };
      }

      case 'tools/call': {
        return await this.handleToolCall(req);
      }

      case 'shutdown': {
        await this.onShutdown();
        this.logger?.info('Shutdown complete');
        // Schedule exit after the current microtask so the response can be
        // written first. Override `exit()` in tests to prevent real exit.
        setImmediate(() => this.exit(0));
        return {
          jsonrpc: '2.0',
          id: req.id ?? null,
          result: { ok: true },
        };
      }

      case 'tools/list': {
        // Optional: Hub can ask for the manifest again at runtime.
        try {
          const manifest = buildManifest(this, this.description);
          return {
            jsonrpc: '2.0',
            id: req.id ?? null,
            result: { tools: manifest.tools },
          };
        } catch (err) {
          return this.errorResponse(req.id, -32603, (err as Error).message);
        }
      }

      case 'plugin.lifecycle': {
        return await this.handleLifecycle(req);
      }

      default:
        return this.errorResponse(
          req.id,
          -32601,
          `Method not found: ${req.method}`,
        );
    }
  }

  /**
   * Handle a `plugin.lifecycle` JSON-RPC request.
   *
   * Looks up the requested hook (install/uninstall/activate/deactivate/health),
   * invokes the corresponding method on the plugin instance with an
   * appropriate timeout (5s for health, 30s for others), and wraps any
   * thrown error as a JSON-RPC error response preserving the PluginError
   * payload if present.
   *
   * Backward compat: if the plugin subclass does not override the
   * lifecycle method, the base class no-op fires and we return success
   * (so v1 plugins handle the RPC without special-casing).
   */
  private async handleLifecycle(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = (req.params ?? {}) as LifeCycleParams;
    const hook = params.hook;

    if (!hook || !(hook in LIFECYCLE_HOOK_TO_METHOD)) {
      return this.errorResponse(
        req.id,
        -32602,
        `Unknown lifecycle hook: ${String(hook)}`,
      );
    }

    const methodName = LIFECYCLE_HOOK_TO_METHOD[hook];
    const method = (this as unknown as Record<string, unknown>)[methodName];
    if (typeof method !== 'function') {
      return this.errorResponse(
        req.id,
        -32602,
        `Lifecycle method not implemented: ${methodName}`,
      );
    }

    const fn = method as () => Promise<unknown>;
    const timeoutMs = hook === 'health'
      ? LIFECYCLE_HEALTH_TIMEOUT_MS
      : LIFECYCLE_DEFAULT_TIMEOUT_MS;

    this.logger?.info(`Lifecycle hook: ${hook}`);

    try {
      const result = await this.withTimeout(fn.call(this), timeoutMs, hook);
      // For health hook, surface the status; for other hooks, return ok.
      if (hook === 'health') {
        const healthResult = result as LifeCycleResult;
        return {
          jsonrpc: '2.0',
          id: req.id ?? null,
          result: healthResult ?? { status: 'healthy' },
        };
      }
      return {
        jsonrpc: '2.0',
        id: req.id ?? null,
        result: { ok: true },
      };
    } catch (err) {
      const e = err as Error & { code?: string; retryable?: boolean; details?: unknown };
      this.logger?.error(`Lifecycle ${hook} failed: ${e.message}`);
      // Preserve PluginError metadata in error.data so the Hub can route.
      const data: Record<string, unknown> = { hook };
      if (typeof e.code === 'string') data['errorCode'] = e.code;
      if (typeof e.retryable === 'boolean') data['retryable'] = e.retryable;
      if (e.details) data['details'] = e.details;
      return {
        jsonrpc: '2.0',
        id: req.id ?? null,
        error: {
          code: -32000,
          message: e.message || `Lifecycle ${hook} failed`,
          data,
        },
      };
    }
  }

  /**
   * Wrap a promise in a timeout. Rejects with a TimeoutError when the
   * timeout elapses; the underlying promise is left to settle on its own
   * (we can't cancel it without AbortController plumbing that would
   * require touching HttpClient).
   */
  private withTimeout<T>(p: Promise<T>, ms: number, hook: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Lifecycle hook "${hook}" timed out after ${ms}ms`));
      }, ms);
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  private async handleToolCall(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = (req.params ?? {}) as ToolCallParams;
    const { name, arguments: args = [], context = {} } = params;

    const method = (this as unknown as Record<string, unknown>)[name];
    if (typeof method !== 'function') {
      return this.errorResponse(
        req.id,
        -32602,
        `Tool not found: ${name}`,
      );
    }

    // Set up per-request HTTP client with auth context.
    this.httpClient = new HttpClient(context);

    const fn = method as (...a: unknown[]) => Promise<unknown>;
    this.logger?.info(`Calling tool: ${name}(${JSON.stringify(args)})`);

    try {
      const result = await fn.apply(this, args);
      await this.onToolResult(name, result);
      this.logger?.info(`Tool ${name} succeeded`);
      const callResult: ToolCallResult = {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
      return {
        jsonrpc: '2.0',
        id: req.id ?? null,
        result: callResult,
      };
    } catch (err) {
      const e = err as Error;
      this.logger?.error(`Tool ${name} failed: ${e.message}`);
      return {
        jsonrpc: '2.0',
        id: req.id ?? null,
        error: {
          code: -32000,
          message: e.message,
          data: process.env['PDHUB_DEBUG'] === '1'
            ? { tool: name, stack: e.stack }
            : { tool: name },
        },
      };
    }
  }

  private errorResponse(
    id: number | string | null | undefined,
    code: number,
    message: string,
  ): JsonRpcResponse {
    return {
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code, message },
    };
  }
}

/**
 * Re-export HttpClient so subclasses can type-annotate fields.
 */
export type { HttpClient };