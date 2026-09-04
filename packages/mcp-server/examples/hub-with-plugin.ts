/**
 * Hub-with-real-plugin: mimics what Hub does on Android, but in pure Node.
 *
 * Mirrors Hub's `PluginProcess.kt` (Kotlin) for stdio JSON-RPC, and
 * `McpHttpServer.kt` (Ktor) for HTTP endpoints. Used to verify the WIRE PROTOCOL
 * between Hub and a real plugin subprocess WITHOUT needing an Android device.
 *
 * If this works end-to-end, the Kotlin Hub side just needs to do the same
 * `ProcessBuilder(node, entryPath).start()` + JSON-RPC over stdio pattern.
 *
 * Usage:
 *   node examples/hub-with-plugin.js [plugin-entry-path]
 *
 * Default plugin entry: ~/Programs/AI/pdatahub-plugin-google-calendar/dist/index.js
 *
 * What it does:
 *   1. Spawns the plugin as subprocess (mirrors PluginProcess.kt)
 *   2. Sends JSON-RPC `initialize` → reads manifest
 *   3. Starts HTTP server on :7778 with /v1/tools and /v1/tools/:name/call
 *      (mirrors McpHttpServer.kt's endpoints)
 *   4. Forwards each call to plugin subprocess, returns response
 *
 * Required env vars for real Calendar plugin calls:
 *   PDAHUB_TEST_ACCESS_TOKEN — Google OAuth access token (for listEvents etc.)
 *   Without it, only `echo.hello` and `time.now` style test tools will work.
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { request as undiciRequest } from 'undici';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const PORT = Number(process.env.PORT ?? 7778);
const TOKEN = process.env.PDAHUB_HUB_TOKEN ?? 'dev';
const DEFAULT_PLUGIN_ENTRY = process.env.PDAHUB_CALENDAR_PLUGIN ??
  resolve(process.env.HOME + '/Programs/AI/pdatahub-plugin-google-calendar/dist/index.js');
const PLUGIN_ENTRY = process.argv[2] ?? DEFAULT_PLUGIN_ENTRY;

// ---------- JSON-RPC over stdio (mirrors PluginProcess.kt) ----------
class PluginProcess {
  constructor() {
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.manifest = null;
    this.name = 'plugin';
  }

  start(entryPath) {
    if (!existsSync(entryPath)) {
      throw new Error(`Plugin entry not found: ${entryPath}`);
    }
    process.stderr.write(`[hub-with-plugin] spawning: node ${entryPath}\n`);

    // Mirror PluginProcess.kt:73 — ProcessBuilder(node, entryPath).start()
    // We're using Node to spawn Node here, but Hub uses `node` Termux binary.
    const proc = spawn('node', [entryPath], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdoutBuf = '';
    proc.stdout.on('data', (d) => {
      stdoutBuf += d.toString();
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const resp = JSON.parse(line);
          const pending = this.pending.get(resp.id);
          if (pending) {
            this.pending.delete(resp.id);
            pending.resolve(resp);
          }
        } catch (e) {
          process.stderr.write(`[hub-with-plugin] parse error: ${e.message} on line: ${line.slice(0, 100)}\n`);
        }
      }
    });

    proc.stderr.on('data', (d) => process.stderr.write(`[plugin] ${d}`));
    proc.on('exit', (code) => process.stderr.write(`[hub-with-plugin] plugin exited code=${code}\n`));

    this.proc = proc;
  }

  sendRequest(method, params = null) {
    const id = this.nextId++;
    const req = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify(req) + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`plugin timeout after 5s for ${method}`));
        }
      }, 5000);
    });
  }

  async initialize() {
    // Mirror PluginProcess.kt:89-93 — sends initialize, reads manifest
    const resp = await this.sendRequest('initialize', { hubVersion: '0.1.0' });
    if (resp.error) throw new Error(`plugin init error: ${resp.error.message}`);
    this.manifest = resp.result;
    process.stderr.write(`[hub-with-plugin] manifest: ${JSON.stringify(this.manifest)}\n`);
    return this.manifest;
  }

  async callTool(name, args, accessToken = null) {
    // Mirror PluginProcess.kt:100-115 — sends tools/call with context.token
    const params = { name, arguments: args ?? {} };
    if (accessToken) params.context = { token: accessToken };
    const resp = await this.sendRequest('tools/call', params);
    if (resp.error) throw new Error(`plugin callTool error: ${resp.error.message}`);
    return resp.result;
  }

  shutdown() {
    this.proc?.kill();
  }
}

// ---------- HTTP server (mirrors McpHttpServer.kt) ----------
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function jsonResponse(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function main() {
  const plugin = new PluginProcess();
  plugin.start(PLUGIN_ENTRY);
  const manifest = await plugin.initialize();
  const tools = manifest.tools ?? [];

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${TOKEN}`) {
      return jsonResponse(res, 401, { error: 'unauthorized' });
    }

    // GET /v1/tools — mirrors McpHttpServer.kt
    if (req.method === 'GET' && url.pathname === '/v1/tools') {
      return jsonResponse(res, 200, { tools });
    }

    // POST /v1/tools/:name/call — mirrors McpHttpServer.kt
    const callMatch = url.pathname.match(/^\/v1\/tools\/([^/]+)\/call$/);
    if (req.method === 'POST' && callMatch) {
      const name = decodeURIComponent(callMatch[1]);
      const body = await readJson(req);
      const args = body.arguments ?? {};
      const accessToken = process.env.PDAHUB_TEST_ACCESS_TOKEN;
      process.stderr.write(`[hub-with-plugin] forwarding ${name} to plugin subprocess\n`);
      try {
        const result = await plugin.callTool(name, args, accessToken);
        jsonResponse(res, 200, result);
      } catch (e) {
        jsonResponse(res, 500, { content: [{ type: 'text', text: e.message }], isError: true });
      }
      return;
    }

    jsonResponse(res, 404, { error: 'not found' });
  });

  httpServer.listen(PORT, () => {
    process.stderr.write(`\n[hub-with-plugin] ════════════════════════════════════════════\n`);
    process.stderr.write(`[hub-with-plugin] HTTP server on http://localhost:${PORT}\n`);
    process.stderr.write(`[hub-with-plugin] Plugin: ${PLUGIN_ENTRY}\n`);
    process.stderr.write(`[hub-with-plugin] Manifest: ${tools.length} tools loaded\n`);
    for (const t of tools) {
      process.stderr.write(`[hub-with-plugin]   - ${t.name} [${t.scope ?? 'no-scope'}] plugin=${t.plugin ?? '?'}\n`);
    }
    process.stderr.write(`[hub-with-plugin] Token: ${TOKEN}\n`);
    process.stderr.write(`[hub-with-plugin] Test:\n`);
    process.stderr.write(`[hub-with-plugin]   curl -H "Authorization: Bearer ${TOKEN}" http://localhost:${PORT}/v1/tools\n`);
    process.stderr.write(`[hub-with-plugin]   curl -X POST -H "Authorization: Bearer ${TOKEN}" -H "content-type: application/json" \\\n`);
    process.stderr.write(`[hub-with-plugin]     -d '{"name":"<tool>","arguments":{...}}' http://localhost:${PORT}/v1/tools/<tool>/call\n`);
    process.stderr.write(`[hub-with-plugin] ════════════════════════════════════════════\n\n`);
  });

  process.on('SIGINT', () => {
    process.stderr.write('[hub-with-plugin] shutting down...\n');
    plugin.shutdown();
    httpServer.close(() => process.exit(0));
  });
}

// Keep undici import explicit
void undiciRequest;

main().catch((err) => {
  process.stderr.write(`[hub-with-plugin] FATAL: ${err.message}\n`);
  process.stderr.write(err.stack + '\n');
  process.exit(1);
});
