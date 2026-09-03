import { describe, it, expect, vi } from 'vitest';
import worker from '../src/index.js';

interface MockStub {
  fetch: ReturnType<typeof vi.fn>;
}

function makeMockEnv(): { SESSION_DO: { idFromName: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> } } {
  const stubs = new Map<string, MockStub>();
  const env = {
    SESSION_DO: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn((id: string) => {
        if (!stubs.has(id)) {
          stubs.set(id, {
            fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
          });
        }
        return stubs.get(id)!;
      }),
    },
  };
  return env;
}

async function callWorker(
  request: Request,
  env: ReturnType<typeof makeMockEnv>,
): Promise<Response> {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext;
  return (worker.fetch as (req: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>)(
    request,
    env,
    ctx,
  );
}

describe('Worker entry', () => {
  it('GET /health returns ok', async () => {
    const env = makeMockEnv();
    const res = await callWorker(new Request('https://relay/health'), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.service).toBe('pdatahub-relay');
  });

  it('GET / returns ok', async () => {
    const env = makeMockEnv();
    const res = await callWorker(new Request('https://relay/'), env);
    expect(res.status).toBe(200);
  });

  it('POST /sessions creates a session and initializes the DO', async () => {
    const env = makeMockEnv();
    const res = await callWorker(new Request('https://relay/sessions', { method: 'POST' }), env);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      sessionId: string;
      hubToken: string;
      laptopToken: string;
    };
    expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.hubToken).toHaveLength(32);
    expect(body.laptopToken).toHaveLength(32);
    expect(env.SESSION_DO.idFromName).toHaveBeenCalledWith(body.sessionId);
  });

  it('GET /sessions/:id/health returns ok', async () => {
    const env = makeMockEnv();
    const res = await callWorker(
      new Request('https://relay/sessions/abc-123/health'),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; status: string };
    expect(body.sessionId).toBe('abc-123');
    expect(body.status).toBe('ok');
  });

  it('WS upgrade routes to the DO', async () => {
    const env = makeMockEnv();
    const wsRes = await callWorker(
      new Request('https://relay/sessions/test-id/ws?role=hub&token=tok'),
      env,
    );
    expect(env.SESSION_DO.idFromName).toHaveBeenCalledWith('test-id');
    expect(env.SESSION_DO.get).toHaveBeenCalledWith('test-id');
    // The DO stub returns ok response, so worker passes through.
    expect(wsRes.status).toBe(200);
  });

  it('404s on unknown routes', async () => {
    const env = makeMockEnv();
    const res = await callWorker(new Request('https://relay/some/random/path'), env);
    expect(res.status).toBe(404);
  });
});
