/**
 * Minimal WebSocket client for pdatahub relay.
 *
 * Used by Hub (Android/Kotlin eventually) and laptop (via pdatahub-mcp).
 *
 * For stub purposes the client is plain TypeScript — works in Node and
 * browsers. Kotlin equivalent will live in the Android app.
 *
 * Usage:
 *   const client = new RelayClient({
 *     url: 'wss://relay.example.com/sessions/abc/ws',
 *     role: 'hub',
 *     token: 'xyz',
 *   });
 *   await client.connect();
 *   client.onMessage((msg) => { ... });
 *   client.send({ type: 'forward', payload: { foo: 'bar' } });
 */

import type { ClientMessage, Role } from './messages.js';

export interface RelayClientOptions {
  url: string;
  role: Role;
  token: string;
  WebSocketImpl?: typeof WebSocket;
}

export type MessageHandler = (raw: string) => void;

export class RelayClient {
  private ws: WebSocket | null = null;
  private readonly handlers: MessageHandler[] = [];
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((err: Error) => void) | null = null;

  constructor(private readonly opts: RelayClientOptions) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;

      const Ctor = this.opts.WebSocketImpl ?? globalThis.WebSocket;
      const url = new URL(this.opts.url);
      url.searchParams.set('role', this.opts.role);
      url.searchParams.set('token', this.opts.token);

      const ws = new Ctor(url.toString());
      this.ws = ws;

      ws.addEventListener('open', () => {
        this.resolveConnect?.();
        this.resolveConnect = null;
        this.rejectConnect = null;
      });
      ws.addEventListener('error', (event: unknown) => {
        const err = new Error(
          `WebSocket error: ${(event as { message?: string }).message ?? 'unknown'}`,
        );
        if (this.rejectConnect) {
          this.rejectConnect(err);
          this.rejectConnect = null;
          this.resolveConnect = null;
        }
      });
      ws.addEventListener('message', (event: MessageEvent) => {
        const data = typeof event.data === 'string' ? event.data : String(event.data);
        for (const h of this.handlers) h(data);
      });
    });
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  send(msg: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== 1 /* OPEN */) {
      throw new Error('WebSocket not open');
    }
    this.ws.send(JSON.stringify(msg));
  }

  close(code = 1000, reason = 'client closing'): void {
    this.ws?.close(code, reason);
  }
}
