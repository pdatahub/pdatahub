/**
 * Plugin subprocess manager.
 *
 * Each plugin runs as a Node.js subprocess (spawned by Hub). Communication
 * via JSON-RPC 2.0 over stdio (newline-delimited JSON on each line).
 *
 * Lifecycle:
 *   1. Hub spawns plugin: `node <entry_path>`
 *   2. Hub sends `initialize` request
 *   3. Plugin returns manifest: { name, version, tools, oauth? }
 *   4. Hub registers tools (routing: tool_name → plugin)
 *   5. Hub sends periodic `ping` for heartbeat
 *   6. On `tools/call`: Hub sends request, plugin returns result
 *   7. On shutdown: Hub sends `shutdown` notification, kills subprocess
 *
 * CRITICAL: stdout = JSON-RPC only, stderr = logs. This matches SDK convention.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import readline from 'node:readline';
import type { ToolDefinition } from '@pdatahub/plugin-sdk';
import type {
  PluginOAuthConfig,
  PluginProcessInfo,
  ToolDescriptor,
} from './types.js';
import { logger } from './logger.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface PluginManifest {
  name: string;
  version: string;
  description: string;
  tools: ToolDefinition[];
  oauth?: PluginOAuthConfig;
}

export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export class PluginProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly entryPath: string;
  private readonly onExit: (name: string) => void;
  private info: PluginProcessInfo;
  private nextId = 1;
  private pending = new Map<number | string, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastPong = 0;

  constructor(opts: {
    entry_path: string;
    heartbeatMs: number;
    onExit: (name: string) => void;
  }) {
    this.entryPath = resolve(opts.entry_path);
    this.onExit = opts.onExit;

    if (!existsSync(this.entryPath)) {
      throw new Error(`Plugin entry path does not exist: ${this.entryPath}`);
    }

    logger.info('spawning plugin', { entry: this.entryPath });
    this.child = spawn('node', [this.entryPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PDATAHUB_HUB_PORT: String(process.env.HUB_PORT ?? '8080'),
      },
    });

    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on('line', (line) => this.handleLine(line));

    this.child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) logger.debug('plugin stderr', { pid: this.child.pid, text });
    });

    this.child.on('exit', (code, signal) => {
      logger.info('plugin exited', {
        pid: this.child.pid,
        name: this.info?.name,
        code,
        signal,
      });
      this.cleanup();
      this.onExit(this.info?.name ?? 'unknown');
    });

    this.child.on('error', (err) => {
      logger.error('plugin process error', {
        pid: this.child.pid,
        error: err.message,
      });
    });

    this.startHeartbeat(opts.heartbeatMs);
    this.info = {
      name: 'unknown',
      version: '0.0.0',
      description: '',
      entry_path: this.entryPath,
      pid: this.child.pid ?? -1,
      tools: [],
      started_at: new Date().toISOString(),
      last_heartbeat: new Date().toISOString(),
    };
  }

  /**
   * Send initialize handshake. Returns manifest. Resolves once plugin responds.
   */
  async initialize(): Promise<PluginManifest> {
    const result = await this.request<PluginManifest>('initialize', {
      protocol_version: '1.0',
      hub_version: '0.1.0',
      capabilities: ['tools', 'oauth'],
    });
    const tools: ToolDescriptor[] = result.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: {},
      scope: t.scope,
      plugin: result.name,
    }));
    this.info = {
      ...this.info,
      name: result.name,
      version: result.version,
      description: result.description,
      tools,
      oauth: result.oauth,
    };
    this.notify('notifications/initialized', {});
    logger.info('plugin initialized', {
      name: result.name,
      version: result.version,
      tools: tools.length,
      oauth: !!result.oauth,
    });
    return result;
  }

  /**
   * Call a tool on this plugin. Resolves with the tool's result.
   * Hub injects the OAuth token via `context.token` (SDK's httpClient uses it).
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    context: { agent_id: string; request_id: string; token?: string },
  ): Promise<ToolCallResult> {
    return this.request<ToolCallResult>('tools/call', {
      name,
      arguments: args,
      context,
    });
  }

  /**
   * Graceful shutdown: send notification, wait, kill if needed.
   */
  async shutdown(timeoutMs = 5000): Promise<void> {
    try {
      this.notify('shutdown', {});
      // Give plugin time to clean up
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          logger.warn('plugin shutdown timeout, killing', { name: this.info.name });
          this.child.kill('SIGKILL');
          resolve();
        }, timeoutMs);
        this.child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } catch (err) {
      logger.error('shutdown error', { error: (err as Error).message });
      this.child.kill('SIGKILL');
    }
    this.cleanup();
  }

  getInfo(): PluginProcessInfo {
    return { ...this.info };
  }

  /* ─── Private ─────────────────────────────────────────────────────────── */

  private startHeartbeat(heartbeatMs: number): void {
    this.heartbeatTimer = setInterval(() => {
      // Send ping, wait briefly for pong, mark stale if no response
      const pingId = randomUUID();
      const timer = setTimeout(() => {
        if (this.lastPong < Date.now() - 2 * heartbeatMs) {
          logger.warn('plugin heartbeat stale, killing', {
            name: this.info.name,
            pid: this.child.pid,
          });
          this.child.kill('SIGKILL');
        }
      }, heartbeatMs);
      this.pending.set(pingId, {
        resolve: () => {
          clearTimeout(timer);
          this.lastPong = Date.now();
          this.info.last_heartbeat = new Date().toISOString();
        },
        reject: () => clearTimeout(timer),
        timer,
      });
      this.write({ jsonrpc: '2.0', id: pingId, method: 'ping' });
    }, heartbeatMs);
  }

  private cleanup(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('plugin process terminated'));
      this.pending.delete(id);
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(trimmed) as JsonRpcResponse;
    } catch (err) {
      logger.warn('invalid JSON from plugin', { line: trimmed.slice(0, 200) });
      return;
    }
    // Notification (no id, has method)
    if (!('id' in msg) && 'method' in msg) {
      logger.debug('plugin notification', {
        method: (msg as unknown as JsonRpcNotification).method,
      });
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) {
      logger.warn('unexpected response id from plugin', { id: msg.id });
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(new PluginError(msg.error.message, msg.error.code, msg.error.data));
    } else {
      pending.resolve(msg.result);
    }
  }

  private write(msg: JsonRpcRequest | JsonRpcNotification): void {
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  private request<T>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`plugin request timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }
}

export class PluginError extends Error {
  constructor(
    message: string,
    public code: number,
    public data?: unknown,
  ) {
    super(message);
    this.name = 'PluginError';
  }
}

/* ─── Plugin registry — routes tool_name → PluginProcess ───────────────── */

export class PluginRegistry {
  private readonly plugins = new Map<string, PluginProcess>();
  private readonly toolToPlugin = new Map<string, string>(); // tool_name → plugin name

  register(plugin: PluginProcess, manifest: PluginManifest): void {
    this.plugins.set(manifest.name, plugin);
    for (const tool of manifest.tools) {
      // If a tool name is already registered, last writer wins (warn)
      if (this.toolToPlugin.has(tool.name)) {
        logger.warn('tool name conflict, overwriting', {
          tool: tool.name,
          old_plugin: this.toolToPlugin.get(tool.name),
          new_plugin: manifest.name,
        });
      }
      this.toolToPlugin.set(tool.name, manifest.name);
    }
    logger.info('plugin registered', {
      name: manifest.name,
      tool_count: manifest.tools.length,
    });
  }

  unregister(name: string): void {
    const plugin = this.plugins.get(name);
    if (!plugin) return;
    this.plugins.delete(name);
    // Remove all tool routes pointing to this plugin
    for (const [tool, pluginName] of this.toolToPlugin.entries()) {
      if (pluginName === name) this.toolToPlugin.delete(tool);
    }
    logger.info('plugin unregistered', { name });
  }

  getPlugin(toolName: string): PluginProcess | null {
    const pluginName = this.toolToPlugin.get(toolName);
    if (!pluginName) return null;
    return this.plugins.get(pluginName) ?? null;
  }

  listAllTools(): ToolDescriptor[] {
    const out: ToolDescriptor[] = [];
    for (const plugin of this.plugins.values()) {
      out.push(...plugin.getInfo().tools);
    }
    return out;
  }

  listPlugins(): PluginProcessInfo[] {
    return Array.from(this.plugins.values()).map((p) => p.getInfo());
  }

  async shutdownAll(): Promise<void> {
    await Promise.all(Array.from(this.plugins.values()).map((p) => p.shutdown()));
  }
}
