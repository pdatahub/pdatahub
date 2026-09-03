/**
 * JSON-RPC 2.0 over stdio transport.
 *
 * Reads newline-delimited JSON-RPC requests from stdin, dispatches them to
 * a handler, and writes newline-delimited JSON-RPC responses to stdout.
 *
 * Logs go to stderr (see logger.ts).
 *
 * Protocol flow:
 *   1. Hub sends `initialize` request on plugin's stdin
 *   2. Plugin replies with manifest on stdout
 *   3. Hub sends `tools/call` requests as needed
 *   4. Plugin replies with results on stdout
 *   5. Hub sends `shutdown` notification (no response expected)
 *   6. Plugin process terminates
 */
import { Logger } from './logger.js';
import type { JsonRpcRequest, JsonRpcResponse } from './types.js';

/**
 * Handler signature for incoming JSON-RPC requests.
 *
 * Returns a JsonRpcResponse if a response should be sent. Returns null for
 * notifications (where no response is expected). Throwing an Error causes
 * an internal-error response to be sent automatically.
 */
export type RequestHandler = (
  req: JsonRpcRequest,
) => Promise<JsonRpcResponse | null> | JsonRpcResponse | null;

/**
 * Options for StdioTransport.
 */
export interface StdioTransportOptions {
  /** Override stdin (defaults to process.stdin). Useful for testing. */
  stdin?: NodeJS.ReadableStream;
  /** Override stdout (defaults to process.stdout). Useful for testing. */
  stdout?: NodeJS.WritableStream;
}

/**
 * Stdio-based JSON-RPC transport.
 *
 * The transport is intentionally minimal: it handles framing (one JSON object
 * per line) and error wrapping, nothing else. Domain logic lives in the handler.
 */
export class StdioTransport {
  private readonly logger: Logger;
  private buffer = '';
  private running = false;

  constructor(
    loggerName: string,
    private readonly options: StdioTransportOptions = {},
  ) {
    this.logger = new Logger(loggerName);
  }

  /**
   * Start listening for requests on stdin.
   *
   * Resolves when stdin closes (EOF). Each parsed request is dispatched to
   * the handler; responses are written to stdout automatically.
   *
   * Most plugins call this once and let it run for the lifetime of the
   * process.
   */
  async listen(handler: RequestHandler): Promise<void> {
    if (this.running) {
      throw new Error('StdioTransport.listen() called twice');
    }
    this.running = true;

    const stdin = this.options.stdin ?? process.stdin;
    const stdout = this.options.stdout ?? process.stdout;

    stdin.setEncoding('utf8');

    for await (const chunk of stdin as AsyncIterable<string>) {
      this.buffer += chunk;
      let newlineIdx = this.buffer.indexOf('\n');

      while (newlineIdx !== -1) {
        const line = this.buffer.slice(0, newlineIdx).trim();
        this.buffer = this.buffer.slice(newlineIdx + 1);

        if (line.length > 0) {
          await this.processLine(line, handler, stdout);
        }

        newlineIdx = this.buffer.indexOf('\n');
      }
    }
  }

  /**
   * Send a JSON-RPC response on stdout.
   *
   * Public so tests and the Plugin lifecycle can send ad-hoc messages.
   */
  sendResponse(res: JsonRpcResponse, stdout?: NodeJS.WritableStream): void {
    const target = stdout ?? this.options.stdout ?? process.stdout;
    target.write(JSON.stringify(res) + '\n');
  }

  /**
   * Send a JSON-RPC notification (no `id`, no response expected).
   */
  sendNotification(method: string, params?: unknown, stdout?: NodeJS.WritableStream): void {
    const notification: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      params,
    };
    const target = stdout ?? this.options.stdout ?? process.stdout;
    target.write(JSON.stringify(notification) + '\n');
  }

  private async processLine(
    line: string,
    handler: RequestHandler,
    stdout: NodeJS.WritableStream,
  ): Promise<void> {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line) as JsonRpcRequest;
    } catch (err) {
      // Malformed JSON — log and skip. Per JSON-RPC 2.0, we can't reply because
      // we don't have an id. The Hub will likely close stdin.
      this.logger.error(`Failed to parse JSON line: ${(err as Error).message}`);
      return;
    }

    if (req.jsonrpc !== '2.0') {
      this.logger.warn(
        `Skipping non-JSON-RPC-2.0 message: ${line.slice(0, 100)}`,
      );
      return;
    }

    await this.handleRequest(req, handler, stdout);
  }

  private async handleRequest(
    req: JsonRpcRequest,
    handler: RequestHandler,
    stdout: NodeJS.WritableStream,
  ): Promise<void> {
    // Notification: no `id`, no response expected.
    if (req.id === undefined || req.id === null) {
      try {
        await handler(req);
      } catch (err) {
        this.logger.error(
          `Notification handler error: ${(err as Error).message}`,
        );
      }
      return;
    }

    // Request: must respond with matching `id`.
    try {
      const result = await handler(req);
      if (result !== null) {
        this.sendResponse(result, stdout);
      } else {
        // Handler returned null even though id was present. That means
        // "I handled it but have no response to send" — unusual, but possible
        // if the handler is buffering and will reply asynchronously. Log a
        // warning so the plugin author notices.
        this.logger.warn(
          `Handler for ${req.method} returned null with non-null id — no response sent`,
        );
      }
    } catch (err) {
      const e = err as Error;
      this.sendResponse(
        {
          jsonrpc: '2.0',
          id: req.id,
          error: {
            code: -32603,
            message: e.message || 'Internal error',
            data: process.env['PDHUB_DEBUG'] === '1' ? e.stack : undefined,
          },
        },
        stdout,
      );
    }
  }
}