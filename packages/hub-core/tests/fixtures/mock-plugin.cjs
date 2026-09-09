#!/usr/bin/env node
// Mock plugin for lifecycle RPC tests.
// Reads JSON-RPC from stdin, responds to `plugin.lifecycle` calls,
// writes each received hook to a trace file (so tests assert the exact
// set of hooks the Hub invoked). Honors MOCK_LIFECYCLE_MODE and
// MOCK_LIFECYCLE_DELAY_MS env vars to simulate throw/hang scenarios.
//
// Used by tests/lifecycle-rpc.test.ts. See that file for protocol details.
//
// Note: written as CommonJS because /tmp/opencode/lifecycle-test/ has no
// package.json so Node.js defaults .js files there to CJS. ESM `import`
// would crash with "Unexpected token 'export'" on startup.

const fs = require('node:fs');

const TRACE_FILE = process.env.MOCK_LIFECYCLE_TRACE_FILE;
const MODE = process.env.MOCK_LIFECYCLE_MODE || 'ok';
const DELAY_MS = Number(process.env.MOCK_LIFECYCLE_DELAY_MS || '0');

function stderr(line) {
  process.stderr.write('[mock-plugin] ' + line + '\n');
}

function appendTrace(hook) {
  if (TRACE_FILE) {
    try {
      fs.appendFileSync(TRACE_FILE, hook + '\n');
    } catch (err) {
      stderr('trace write failed: ' + (err && err.message));
    }
  }
}

let buffer = '';

process.stdin.on('data', async (chunk) => {
  buffer += chunk.toString('utf8');

  let newlineIdx;
  while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIdx);
    buffer = buffer.slice(newlineIdx + 1);

    let req;
    try {
      req = JSON.parse(line);
    } catch {
      stderr('bad JSON: ' + line.slice(0, 120));
      continue;
    }

    const id = req.id;
    const method = req.method;
    const params = req.params || {};

    if (method === 'plugin.lifecycle') {
      const hook = params.hook;
      appendTrace(hook);

      if (DELAY_MS > 0) {
        await new Promise((r) => setTimeout(r, DELAY_MS));
      }

      if (MODE === 'throw') {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: id,
            error: {
              code: -32603,
              message: 'mock failure for ' + hook,
              data: { code: 'MOCK_THROW', retryable: false },
            },
          }) + '\n',
        );
        continue;
      }

      const result = hook === 'health' ? { status: 'healthy' } : null;

      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: id,
          result: result,
        }) + '\n',
      );
    }
    // Unknown methods: silently ignore (matches real plugin behavior for
    // methods the mock doesn't implement).
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});
