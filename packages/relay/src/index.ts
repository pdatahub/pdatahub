/**
 * Cloudflare Worker entry point for pdatahub relay.
 *
 * Routes:
 *   POST /sessions                create a new pairing session
 *   GET  /sessions/:id/ws         WebSocket upgrade (Hub or laptop)
 *   GET  /sessions/:id/health     lightweight health check
 *
 * All other paths → 404.
 */

import { SessionDO } from './session-do.js';
import type { CreateSessionResponse, InitSessionRequest, Role } from './messages.js';
import { CreateSessionResponseSchema } from './messages.js';

export { SessionDO };

interface Env {
  SESSION_DO: DurableObjectNamespace;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function randomToken(): string {
  // 32 hex chars ≈ 128 bits of entropy.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function createSession(env: Env): Promise<Response> {
  const sessionId = crypto.randomUUID();
  const hubToken = randomToken();
  const laptopToken = randomToken();

  const doId = env.SESSION_DO.idFromName(sessionId);
  const stub = env.SESSION_DO.get(doId);
  const initBody: InitSessionRequest = { hubToken, laptopToken };
  const initRes = await stub.fetch(
    `https://relay-internal/sessions/${sessionId}/init`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(initBody),
    },
  );
  if (!initRes.ok) {
    return jsonResponse({ error: 'failed to initialize session' }, 500);
  }

  const response: CreateSessionResponse = {
    sessionId,
    hubToken,
    laptopToken,
  };
  const parsed = CreateSessionResponseSchema.safeParse(response);
  if (!parsed.success) {
    return jsonResponse({ error: 'invalid response shape' }, 500);
  }
  return jsonResponse(parsed.data, 201);
}

async function handleWebSocketUpgrade(
  request: Request,
  env: Env,
  sessionId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const role = url.searchParams.get('role') as Role | null;
  if (role !== 'hub' && role !== 'laptop') {
    return new Response('role query must be hub or laptop', { status: 400 });
  }
  if (!url.searchParams.get('token')) {
    return new Response('token query required', { status: 400 });
  }

  const doId = env.SESSION_DO.idFromName(sessionId);
  const stub = env.SESSION_DO.get(doId);
  return stub.fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/sessions') {
      return createSession(env);
    }

    const wsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/ws$/);
    if (wsMatch && request.method === 'GET') {
      return handleWebSocketUpgrade(request, env, wsMatch[1]);
    }

    const healthMatch = url.pathname.match(/^\/sessions\/([^/]+)\/health$/);
    if (healthMatch && request.method === 'GET') {
      return jsonResponse({ sessionId: healthMatch[1], status: 'ok' });
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return jsonResponse({ status: 'ok', service: 'pdatahub-relay' });
    }

    return new Response('Not found', { status: 404 });
  },
};
