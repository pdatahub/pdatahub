/**
 * Vitest setup — polyfills Cloudflare Workers globals that don't exist in
 * plain Node.js. Tests use these globals indirectly via the public API.
 *
 * WebSocketPair is a Workers-only constructor that returns [client, server]
 * WebSockets. For unit tests we don't need real network semantics — we just
 * need both objects to be capturable, send()-able, and the server one to be
 * passable to state.acceptWebSocket().
 */

function makeStubWs(): WebSocket {
  const sent: string[] = [];
  const handlers = new Map<string, Array<(event: unknown) => void>>();
  return {
    send(msg: string) {
      sent.push(msg);
    },
    close() {
      sent.length = 0;
    },
    addEventListener(type: string, listener: (event: unknown) => void) {
      const arr = handlers.get(type) ?? [];
      arr.push(listener);
      handlers.set(type, arr);
    },
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
    readyState: 1,
    bufferedAmount: 0,
    url: '',
    protocol: '',
    extensions: '',
    binaryType: 'blob' as BinaryType,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    _sent: sent,
  } as unknown as WebSocket;
}

class WebSocketPair {
  0: WebSocket;
  1: WebSocket;
  constructor() {
    this[0] = makeStubWs();
    this[1] = makeStubWs();
  }
}

if (typeof globalThis.WebSocketPair === 'undefined') {
  (globalThis as unknown as { WebSocketPair: typeof WebSocketPair }).WebSocketPair =
    WebSocketPair;
}
