/**
 * Local mock Hub for manual testing of pdatahub-mcp.
 *
 * Serves a hardcoded tool list and a single fake tool that echoes back its
 * arguments. Run alongside the MCP server to exercise the full stdio flow:
 *
 *   node examples/hub-mock.js &        # mock Hub on :7777
 *   pdatahub-mcp --hub-url http://localhost:7777 --token dev
 *
 * Then in another terminal, drive the MCP server with an AI agent (or any
 * MCP client) to see tool calls land in the mock's logs.
 */

import { createServer } from 'node:http';
import { request as undiciRequest } from 'undici';

const PORT = Number(process.env.PORT ?? 7777);
const TOKEN = process.env.PDAHUB_SESSION_TOKEN ?? 'dev';

const TOOLS = [
  {
    name: 'echo.hello',
    description: 'Echo a greeting back. Useful for smoke testing.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Whom to greet' } },
      required: ['name'],
    },
    scope: 'echo:read',
    plugin: 'mock-echo',
  },
  {
    name: 'time.now',
    description: 'Returns the current server time in ISO 8601 format.',
    inputSchema: { type: 'object', properties: {} },
    scope: 'time:read',
    plugin: 'mock-time',
  },
];

function readJson(req: import('node:http').IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function jsonResponse(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${TOKEN}`) {
    jsonResponse(res, 401, { error: 'unauthorized' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/tools') {
    process.stderr.write(`[mock-hub] GET /v1/tools\n`);
    jsonResponse(res, 200, { tools: TOOLS });
    return;
  }

  const callMatch = url.pathname.match(/^\/v1\/tools\/([^/]+)\/call$/);
  if (req.method === 'POST' && callMatch) {
    const name = decodeURIComponent(callMatch[1]);
    const body = (await readJson(req)) as { arguments?: Record<string, unknown> };
    const args = body.arguments ?? {};
    process.stderr.write(`[mock-hub] call ${name} ${JSON.stringify(args)}\n`);

    let result: { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
    if (name === 'echo.hello') {
      const greeting = args.name ?? 'world';
      result = { content: [{ type: 'text', text: `Hello, ${greeting}!` }] };
    } else if (name === 'time.now') {
      result = { content: [{ type: 'text', text: new Date().toISOString() }] };
    } else {
      result = {
        content: [{ type: 'text', text: `unknown tool: ${name}` }],
        isError: true,
      };
    }
    jsonResponse(res, 200, result);
    return;
  }

  jsonResponse(res, 404, { error: 'not found', path: url.pathname });
});

server.listen(PORT, () => {
  process.stderr.write(`[mock-hub] listening on http://localhost:${PORT}\n`);
  process.stderr.write(`[mock-hub] token: ${TOKEN}\n`);
});

// Keep undici imported so the dependency is explicit.
void undiciRequest;

process.on('SIGINT', () => {
  process.stderr.write('[mock-hub] shutting down\n');
  server.close(() => process.exit(0));
});
