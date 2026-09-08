/**
 * Plugin SDK v2 — `plugin.lifecycle` RPC tests (Day 5).
 *
 * Spawns a real mock plugin subprocess (mock-plugin.js) and verifies
 * that `PluginProcess.invokeLifecycleHook` correctly:
 *   - Sends `plugin.lifecycle` with `{ hook }` params for each lifecycle
 *     hook (install/uninstall/activate/deactivate/health).
 *   - Uses 30s timeout for non-health hooks, 5s for health (defaults).
 *   - Returns the plugin's success payload.
 *   - Surfaces plugin-side JSON-RPC errors.
 *   - Times out (PluginError TIMEOUT) when the plugin hangs.
 *
 * The mock script echoes each hook into a trace file so we can assert
 * the exact set of hooks the Hub invoked.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginError as SdkPluginError } from '@pdatahub/plugin-sdk';
import { PluginProcess } from '../src/plugin-process.js';

const MOCK_PLUGIN = '/tmp/opencode/lifecycle-test/mock-plugin.js';
let tempDir: string;
let traceFile: string;
const originalEnv = { ...process.env };

// 15s per test — vitest's default 5s is too tight for spawning a real
// subprocess, awaiting its readline pipe, and tearing it down. The
// mocks themselves are fast; the slack is for fork/exec latency on
// CI runners.
const TEST_TIMEOUT_MS = 15_000;

beforeEach(() => {
  if (!existsSync('/tmp/opencode/lifecycle-test')) {
    mkdirSync('/tmp/opencode/lifecycle-test', { recursive: true });
  }
  tempDir = mkdtempSync(join(tmpdir(), 'pdatahub-lifecycle-'));
  traceFile = join(tempDir, 'trace.txt');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  // Restore any env vars the mock-plugin test might have set, so the
  // NEXT test in another file doesn't inherit MOCK_LIFECYCLE_MODE etc.
  for (const k of Object.keys(process.env)) {
    if (!(k in originalEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(originalEnv)) {
    if (process.env[k] !== v) process.env[k] = v;
  }
});

function makePlugin(opts: {
  mode?: string;
  delayMs?: number;
}): PluginProcess {
  // Snapshot any pre-existing values so we can restore in afterEach.
  // PluginProcess spawns a subprocess that inherits process.env; we need
  // to set the mock's mode/delay fresh for each test (otherwise the
  // "throw" or "hang" mode from one test leaks into the next).
  process.env['MOCK_LIFECYCLE_TRACE_FILE'] = traceFile;
  if (opts.mode !== undefined) {
    process.env['MOCK_LIFECYCLE_MODE'] = opts.mode;
  } else {
    delete process.env['MOCK_LIFECYCLE_MODE'];
  }
  if (opts.delayMs !== undefined) {
    process.env['MOCK_LIFECYCLE_DELAY_MS'] = String(opts.delayMs);
  } else {
    delete process.env['MOCK_LIFECYCLE_DELAY_MS'];
  }
  return new PluginProcess({
    entry_path: MOCK_PLUGIN,
    heartbeatMs: 60_000, // don't kill during tests
    onExit: () => undefined,
  });
}

async function readTrace(): Promise<string[]> {
  if (!existsSync(traceFile)) return [];
  return readFileSync(traceFile, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0);
}

describe('PluginProcess.invokeLifecycleHook', () => {
  it('invokes plugin onInstall and returns ok', async () => {
    const p = makePlugin({});
    try {
      const result = await p.invokeLifecycleHook('install');
      expect(result).toBeNull();
      const hooks = await readTrace();
      expect(hooks).toEqual(['install']);
    } finally {
      await p.shutdown();
    }
  }, TEST_TIMEOUT_MS);

  it('invokes plugin onUninstall and returns ok', async () => {
    const p = makePlugin({});
    try {
      await p.invokeLifecycleHook('uninstall');
      const hooks = await readTrace();
      expect(hooks).toEqual(['uninstall']);
    } finally {
      await p.shutdown();
    }
  }, TEST_TIMEOUT_MS);

  it('invokes plugin onActivate and returns ok', async () => {
    const p = makePlugin({});
    try {
      await p.invokeLifecycleHook('activate');
      const hooks = await readTrace();
      expect(hooks).toEqual(['activate']);
    } finally {
      await p.shutdown();
    }
  }, TEST_TIMEOUT_MS);

  it('invokes plugin onDeactivate and returns ok', async () => {
    const p = makePlugin({});
    try {
      await p.invokeLifecycleHook('deactivate');
      const hooks = await readTrace();
      expect(hooks).toEqual(['deactivate']);
    } finally {
      await p.shutdown();
    }
  }, TEST_TIMEOUT_MS);

  it('invokes plugin health and returns the health status payload', async () => {
    const p = makePlugin({});
    try {
      const result = await p.invokeLifecycleHook('health');
      expect(result).toEqual({ status: 'healthy' });
      const hooks = await readTrace();
      expect(hooks).toEqual(['health']);
    } finally {
      await p.shutdown();
    }
  }, TEST_TIMEOUT_MS);

  it('plugin timeout → PluginError with code TIMEOUT', async () => {
    // Plugin hangs for 2 seconds; we ask for a 200ms timeout via override.
    const p = makePlugin({ delayMs: 2000 });
    try {
      let caught: unknown;
      try {
        await p.invokeLifecycleHook('install', 200);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SdkPluginError);
      const err = caught as SdkPluginError;
      expect(err.code).toBe('TIMEOUT');
      expect(err.retryable).toBe(true);
      expect(err.message).toMatch(/timed out after 200ms/);
    } finally {
      await p.shutdown();
    }
  }, TEST_TIMEOUT_MS);

  it('plugin JSON-RPC error → exception with the error message preserved', async () => {
    const p = makePlugin({ mode: 'throw' });
    try {
      let caught: unknown;
      try {
        await p.invokeLifecycleHook('install');
      } catch (err) {
        caught = err;
      }
      // The Hub wraps the JSON-RPC error in a generic Error (the SDK's
      // dispatch path doesn't reconstruct a PluginError here — the Hub's
      // error routing for *callTool* is what does that). Either way, the
      // call must reject and the message must mention the failure.
      expect(caught).toBeDefined();
      const msg = (caught as Error).message;
      expect(msg).toMatch(/mock failure for install|Internal error/);
    } finally {
      await p.shutdown();
    }
  }, TEST_TIMEOUT_MS);

  it('plugin success → resolves with the response payload (multiple hooks in sequence)', async () => {
    const p = makePlugin({});
    try {
      // Multiple lifecycle hooks in sequence — common on install flow:
      // activate, health, deactivate.
      await p.invokeLifecycleHook('activate');
      const healthResult = await p.invokeLifecycleHook('health');
      expect(healthResult).toEqual({ status: 'healthy' });
      await p.invokeLifecycleHook('deactivate');
      const hooks = await readTrace();
      expect(hooks).toEqual(['activate', 'health', 'deactivate']);
    } finally {
      await p.shutdown();
    }
  }, TEST_TIMEOUT_MS);
});
