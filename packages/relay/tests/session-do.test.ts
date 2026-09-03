import { describe, it, expect } from 'vitest';
import { doForward, doHandleWebSocket, doInit, type SessionState } from '../src/session-do.js';

interface MockSocket {
  _sent: string[];
  _closed: boolean;
  send(msg: string): void;
  close(): void;
}

function makeMockSocket(): MockSocket {
  const sent: string[] = [];
  const ws: MockSocket = {
    _sent: sent,
    _closed: false,
    send(msg: string) {
      sent.push(msg);
    },
    close() {
      this._closed = true;
    },
  };
  return ws;
}

interface MockState extends SessionState {
  _storage: Map<string, unknown>;
  _sockets: Array<{ ws: WebSocket; tags: string[] }>;
}

function makeMockState(opts: { hubToken?: string; laptopToken?: string } = {}): MockState {
  const storage = new Map<string, unknown>();
  if (opts.hubToken) storage.set('hubToken', opts.hubToken);
  if (opts.laptopToken) storage.set('laptopToken', opts.laptopToken);

  const sockets: Array<{ ws: WebSocket; tags: string[] }> = [];

  const state = {
    _storage: storage,
    _sockets: sockets,
    storage: {
      get: async <T>(key: string): Promise<T | undefined> => storage.get(key) as T | undefined,
      put: async (key: string, value: unknown): Promise<void> => {
        storage.set(key, value);
      },
    },
    getWebSockets: (tag?: string): WebSocket[] => {
      const filtered = tag ? sockets.filter((s) => s.tags.includes(tag)) : sockets;
      return filtered.map((s) => s.ws);
    },
    getTags: (ws: WebSocket): string[] => {
      return sockets.find((s) => s.ws === ws)?.tags ?? [];
    },
    acceptWebSocket: (ws: WebSocket, tags: string[]): void => {
      sockets.push({ ws: ws as unknown as WebSocket, tags });
    },
    waitUntil: async () => {},
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  } as unknown as MockState;

  return state;
}

function makeInitializedState(): MockState {
  return makeMockState({
    hubToken: 'hub-token-1234567890abcdef12345678',
    laptopToken: 'laptop-token-abcdef1234567890abcdef',
  });
}

describe('doInit', () => {
  it('stores both tokens', async () => {
    const state = makeMockState();
    const res = await doInit(state, { hubToken: 'h'.repeat(32), laptopToken: 'l'.repeat(32) });
    expect(res.status).toBe(200);
    expect(await state.storage.get('hubToken')).toBe('h'.repeat(32));
    expect(await state.storage.get('laptopToken')).toBe('l'.repeat(32));
  });

  it('rejects when tokens missing', async () => {
    const state = makeMockState();
    const res = await doInit(state, { hubToken: '', laptopToken: 'l'.repeat(32) });
    expect(res.status).toBe(400);
  });
});

describe('doHandleWebSocket', () => {
  function makeWsRequest(role: string, token: string | null, path = '/ws'): Request {
    const url = new URL(`https://relay/${path}`);
    url.searchParams.set('role', role);
    if (token !== null) url.searchParams.set('token', token);
    return new Request(url.toString(), {
      method: 'GET',
      headers: { upgrade: 'websocket' },
    });
  }

  it('rejects when role is invalid', async () => {
    const state = makeInitializedState();
    const result = await doHandleWebSocket(state, makeWsRequest('alien', 'tok'));
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.response.status).toBe(400);
  });

  it('rejects when token missing', async () => {
    const state = makeInitializedState();
    const result = await doHandleWebSocket(state, makeWsRequest('hub', null));
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.response.status).toBe(400);
  });

  it('rejects when session not initialized', async () => {
    const state = makeMockState();
    const result = await doHandleWebSocket(state, makeWsRequest('hub', 'anything'));
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.response.status).toBe(404);
  });

  it('rejects when token is wrong', async () => {
    const state = makeInitializedState();
    const result = await doHandleWebSocket(
      state,
      makeWsRequest('hub', 'wrong-token'),
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.response.status).toBe(401);
  });

  it('accepts a hub WebSocket with correct token', async () => {
    const state = makeInitializedState();
    const result = await doHandleWebSocket(
      state,
      makeWsRequest('hub', 'hub-token-1234567890abcdef12345678'),
    );
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(state.getWebSockets('hub')).toHaveLength(1);
      // client and server are real WebSocket stubs
      expect(result.client).toBeDefined();
    }
  });

  it('accepts a laptop WebSocket with correct token', async () => {
    const state = makeInitializedState();
    const result = await doHandleWebSocket(
      state,
      makeWsRequest('laptop', 'laptop-token-abcdef1234567890abcdef'),
    );
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(state.getWebSockets('laptop')).toHaveLength(1);
    }
  });

  it('rejects a second hub WebSocket with 409', async () => {
    const state = makeInitializedState();
    await doHandleWebSocket(state, makeWsRequest('hub', 'hub-token-1234567890abcdef12345678'));
    const result = await doHandleWebSocket(
      state,
      makeWsRequest('hub', 'hub-token-1234567890abcdef12345678'),
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.response.status).toBe(409);
  });

  it('sends registered message to the accepted socket', async () => {
    const state = makeInitializedState();
    const result = await doHandleWebSocket(
      state,
      makeWsRequest('hub', 'hub-token-1234567890abcdef12345678'),
    );
    expect(result.kind).toBe('ok');
    const hubSockets = state.getWebSockets('hub');
    const sent = (hubSockets[0] as unknown as MockSocket)._sent;
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toEqual({
      type: 'registered',
      sessionId: '',
      role: 'hub',
    });
  });
});

describe('doForward', () => {
  it('forwards hub → laptop', () => {
    const state = makeInitializedState();
    const hubWs = makeMockSocket();
    const laptopWs = makeMockSocket();
    state.acceptWebSocket(hubWs as unknown as WebSocket, ['hub']);
    state.acceptWebSocket(laptopWs as unknown as WebSocket, ['laptop']);

    doForward(state, hubWs as unknown as WebSocket, '{"type":"forward","payload":"hi"}');

    expect(hubWs._sent).toEqual([]);
    expect(laptopWs._sent).toEqual(['{"type":"forward","payload":"hi"}']);
  });

  it('forwards laptop → hub', () => {
    const state = makeInitializedState();
    const hubWs = makeMockSocket();
    const laptopWs = makeMockSocket();
    state.acceptWebSocket(hubWs as unknown as WebSocket, ['hub']);
    state.acceptWebSocket(laptopWs as unknown as WebSocket, ['laptop']);

    doForward(state, laptopWs as unknown as WebSocket, '{"type":"forward","payload":"ack"}');

    expect(laptopWs._sent).toEqual([]);
    expect(hubWs._sent).toEqual(['{"type":"forward","payload":"ack"}']);
  });

  it('does nothing when source socket has no tag', () => {
    const state = makeInitializedState();
    const hubWs = makeMockSocket();
    const laptopWs = makeMockSocket();
    state.acceptWebSocket(hubWs as unknown as WebSocket, ['hub']);
    state.acceptWebSocket(laptopWs as unknown as WebSocket, ['laptop']);

    const orphan = makeMockSocket() as unknown as WebSocket;
    doForward(state, orphan, '{"x":1}');

    expect(hubWs._sent).toEqual([]);
    expect(laptopWs._sent).toEqual([]);
  });

  it('does nothing when no peer is connected', () => {
    const state = makeInitializedState();
    const hubWs = makeMockSocket();
    state.acceptWebSocket(hubWs as unknown as WebSocket, ['hub']);

    doForward(state, hubWs as unknown as WebSocket, '{"x":1}');

    expect(hubWs._sent).toEqual([]);
  });

  it('ignores peer.send() errors', () => {
    const state = makeInitializedState();
    const hubWs = makeMockSocket();
    const laptopWs = {
      _sent: [] as string[],
      send(): void {
        throw new Error('closed');
      },
      close(): void {},
    };
    state.acceptWebSocket(hubWs as unknown as WebSocket, ['hub']);
    state.acceptWebSocket(laptopWs as unknown as WebSocket, ['laptop']);

    expect(() => doForward(state, hubWs as unknown as WebSocket, '{"x":1}')).not.toThrow();
    expect(laptopWs._sent).toEqual([]);
  });
});
