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
  PluginManifest,
  ToolCallParams,
  ToolCallResult,
} from './types.js';

/**
 * Abstract base class for pdatahub plugins.
 *
 * Subclasses MUST set `name` and `version` as instance fields.
 */
export abstract class Plugin {
  abstract name: string;
  abstract version: string;
  description?: string;

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

      default:
        return this.errorResponse(
          req.id,
          -32601,
          `Method not found: ${req.method}`,
        );
    }
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
      const callResult: ToolCallResult = { data: result };
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