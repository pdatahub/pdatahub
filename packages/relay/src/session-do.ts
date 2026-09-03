/**
 * Session Durable Object.
 *
 * One DO per session_id. Holds at most two WebSocket connections:
 *   - one tagged "hub"
 *   - one tagged "laptop"
 *
 * On any message from a Hub-socket, forwards to all laptop-sockets in the DO
 * (and vice versa). Uses Cloudflare WebSocket hibernation so the DO can be
 * evicted from memory while WS connections stay alive.
 *
 * Logic is split into pure helpers that take state explicitly — this keeps the
 * DO class thin and the logic unit-testable with a plain Node.js mock state.
 * The 101 (WebSocket upgrade) Response is built only in the DO class so tests
 * don't depend on Cloudflare-only Response extensions.
 */

const HUB_TAG = 'hub';
const LAPTOP_TAG = 'laptop';

export interface DoStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

export interface DoWebSocketHibernation {
  acceptWebSocket(ws: WebSocket, tags: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  getTags(ws: WebSocket): string[];
}

export type SessionState = DurableObjectState & DoStorage & DoWebSocketHibernation;

export class SessionDO implements DurableObject {
  constructor(private readonly state: SessionState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname.endsWith('/init')) {
      return doInit(this.state, (await request.json()) as { hubToken: string; laptopToken: string });
    }

    if (request.method === 'GET' && url.pathname.endsWith('/ws')) {
      const result = await doHandleWebSocket(this.state, request);
      if (result.kind === 'error') return result.response;
      return new Response(null, { status: 101, webSocket: result.client });
    }

    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const message = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    doForward(this.state, ws, message);
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    try {
      ws.close(1011, 'internal error');
    } catch {
      // Already closed.
    }
  }
}

export async function doInit(
  state: SessionState,
  body: { hubToken?: string; laptopToken?: string },
): Promise<Response> {
  if (!body.hubToken || !body.laptopToken) {
    return new Response('missing tokens', { status: 400 });
  }
  await state.storage.put('hubToken', body.hubToken);
  await state.storage.put('laptopToken', body.laptopToken);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

export type HandleWebSocketResult =
  | { kind: 'ok'; client: WebSocket }
  | { kind: 'error'; response: Response };

export async function doHandleWebSocket(
  state: SessionState,
  request: Request,
): Promise<HandleWebSocketResult> {
  const url = new URL(request.url);
  const role = url.searchParams.get('role');
  const token = url.searchParams.get('token');

  if (role !== HUB_TAG && role !== LAPTOP_TAG) {
    return {
      kind: 'error',
      response: new Response('role must be hub or laptop', { status: 400 }),
    };
  }
  if (!token) {
    return { kind: 'error', response: new Response('token required', { status: 400 }) };
  }

  const storedKey = role === HUB_TAG ? 'hubToken' : 'laptopToken';
  const expected = (await state.storage.get<string>(storedKey)) ?? '';
  if (expected === '') {
    return {
      kind: 'error',
      response: new Response('session not initialized', { status: 404 }),
    };
  }
  if (expected !== token) {
    return { kind: 'error', response: new Response('unauthorized', { status: 401 }) };
  }

  const existing = state.getWebSockets(role);
  if (existing.length > 0) {
    return {
      kind: 'error',
      response: new Response(`role ${role} already connected`, { status: 409 }),
    };
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

  state.acceptWebSocket(server, [role]);
  server.send(JSON.stringify({ type: 'registered', sessionId: '', role }));

  return { kind: 'ok', client };
}

export function doForward(
  state: SessionState,
  sourceWs: WebSocket,
  message: string,
): void {
  const sourceTag = tagOf(state, sourceWs);
  if (!sourceTag) return;

  const targetTag = sourceTag === HUB_TAG ? LAPTOP_TAG : HUB_TAG;
  const targets = state.getWebSockets(targetTag);
  if (targets.length === 0) return;

  for (const target of targets) {
    try {
      target.send(message);
    } catch {
      // Peer is closing; ignore.
    }
  }
}

function tagOf(state: SessionState, ws: WebSocket): 'hub' | 'laptop' | undefined {
  const tags = state.getTags(ws);
  return tags.find((t): t is 'hub' | 'laptop' => t === HUB_TAG || t === LAPTOP_TAG);
}
