import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildManifest } from '../src/manifest.js';
import { OAuth, Tool } from '../src/decorators.js';
import { Plugin } from '../src/plugin.js';

describe('buildManifest', () => {
  it('builds manifest from a plugin with @Tool methods', () => {
    class TestPlugin extends Plugin {
      name = 'test';
      version = '1.2.3';
      description = 'A test plugin';

      @Tool({ scope: 'a.read', description: 'A read' })
      async readA() {
        return 1;
      }

      @Tool({ scope: 'a.write', description: 'A write' })
      async writeA() {
        return 2;
      }
    }

    const instance = new TestPlugin();
    const manifest = buildManifest(instance);

    expect(manifest.name).toBe('test');
    expect(manifest.version).toBe('1.2.3');
    expect(manifest.description).toBe('A test plugin');
    expect(manifest.tools).toHaveLength(2);
    expect(manifest.tools[0]).toEqual({
      name: 'readA',
      scope: 'a.read',
      description: 'A read',
    });
    expect(manifest.tools[1]).toEqual({
      name: 'writeA',
      scope: 'a.write',
      description: 'A write',
    });
    expect(manifest.oauth).toBeUndefined();
  });

  it('includes OAuth config when present', () => {
    @OAuth({
      authorizationUrl: 'https://example.com/auth',
      tokenUrl: 'https://example.com/token',
      scopes: ['read'],
    })
    class OAuthPlugin extends Plugin {
      name = 'oauth';
      version = '0.1.0';
    }

    const instance = new OAuthPlugin();
    const manifest = buildManifest(instance);

    expect(manifest.oauth).toBeDefined();
    expect(manifest.oauth?.tokenUrl).toBe('https://example.com/token');
  });

  it('uses description parameter over instance field', () => {
    class DescPlugin extends Plugin {
      name = 'd';
      version = '1.0.0';
      description = 'instance desc';
    }
    const instance = new DescPlugin();
    const manifest = buildManifest(instance, 'override desc');
    expect(manifest.description).toBe('override desc');
  });

  it('throws if name is missing', () => {
    class NoName extends Plugin {
      name = '' as unknown as string; // empty string fails the check
      version = '1.0.0';
    }
    const instance = new NoName();
    expect(() => buildManifest(instance)).toThrow(/must set `name`/);
  });

  it('throws if version is missing', () => {
    class NoVersion extends Plugin {
      name = 'x';
      version = '' as unknown as string;
    }
    const instance = new NoVersion();
    expect(() => buildManifest(instance)).toThrow(/must set `version`/);
  });

  it('handles a plugin with no tools (empty array)', () => {
    class NoTools extends Plugin {
      name = 'empty';
      version = '0.0.1';
    }
    const instance = new NoTools();
    const manifest = buildManifest(instance);
    expect(manifest.tools).toEqual([]);
  });
});

describe('Plugin.dispatch', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    delete process.env['PDHUB_DEBUG'];
  });

  class DispatchPlugin extends Plugin {
    name = 'dispatch';
    version = '0.1.0';

    @Tool({ scope: 'echo', description: 'Echo a value' })
    async echo(value: string) {
      return { echoed: value };
    }

    @Tool({ scope: 'sum', description: 'Sum numbers' })
    async sum(a: number, b: number) {
      return a + b;
    }
  }

  it('handles initialize and returns manifest', async () => {
    const p = new DispatchPlugin();
    const response = await p.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { hubVersion: '1.0.0' },
    });

    expect(response).not.toBeNull();
    expect(response?.result).toBeDefined();
    const result = response?.result as { name: string; tools: unknown[] };
    expect(result.name).toBe('dispatch');
    expect(result.tools).toHaveLength(2);
  });

  it('handles tools/call with positional arguments', async () => {
    const p = new DispatchPlugin();
    const response = await p.dispatch({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'echo', arguments: ['hello'] },
    });

    expect(response?.result).toEqual({ data: { echoed: 'hello' } });
  });

  it('handles tools/call with multiple positional arguments', async () => {
    const p = new DispatchPlugin();
    const response = await p.dispatch({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'sum', arguments: [3, 4] },
    });

    expect(response?.result).toEqual({ data: 7 });
  });

  it('returns error for unknown tool', async () => {
    const p = new DispatchPlugin();
    const response = await p.dispatch({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'nonexistent', arguments: [] },
    });

    expect(response?.error).toBeDefined();
    expect(response?.error?.code).toBe(-32602);
  });

  it('returns error for unknown method', async () => {
    const p = new DispatchPlugin();
    const response = await p.dispatch({
      jsonrpc: '2.0',
      id: 5,
      method: 'unknown/method',
      params: {},
    });

    expect(response?.error?.code).toBe(-32601);
  });

  it('catches tool errors and returns JSON-RPC error', async () => {
    class FailingPlugin extends Plugin {
      name = 'fail';
      version = '0.1.0';

      @Tool({ scope: 'break', description: 'Throw' })
      async breakIt() {
        throw new Error('intentional failure');
      }
    }
    const p = new FailingPlugin();
    const response = await p.dispatch({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'breakIt', arguments: [] },
    });

    expect(response?.error).toBeDefined();
    expect(response?.error?.message).toBe('intentional failure');
  });

  it('provides HttpClient via httpClient property', async () => {
    let captured: unknown = null;
    class HttpPlugin extends Plugin {
      name = 'http';
      version = '0.1.0';

      @Tool({ scope: 'check', description: 'Check http' })
      async checkHttp() {
        captured = this.httpClient;
        return { hasClient: this.httpClient !== undefined };
      }
    }
    const p = new HttpPlugin();
    const response = await p.dispatch({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'checkHttp',
        arguments: [],
        context: { token: 'test-token' },
      },
    });

    expect(response?.result).toEqual({ data: { hasClient: true } });
    expect(captured).toBeDefined();
  });

  it('calls onStart on initialize', async () => {
    let called = false;
    class LifecyclePlugin extends Plugin {
      name = 'life';
      version = '0.1.0';

      async onStart() {
        called = true;
      }
    }
    const p = new LifecyclePlugin();
    await p.dispatch({
      jsonrpc: '2.0',
      id: 8,
      method: 'initialize',
      params: { hubVersion: '1.0.0' },
    });
    expect(called).toBe(true);
  });

  it('calls onShutdown on shutdown request', async () => {
    let called = false;
    let exitCalled: number | null = null;
    class ShutdownPlugin extends Plugin {
      name = 'sd';
      version = '0.1.0';

      async onShutdown() {
        called = true;
      }

      // Override to prevent the test runner from exiting.
      exit(code: number): never {
        exitCalled = code;
        return undefined as never;
      }
    }
    const p = new ShutdownPlugin();
    await p.dispatch({
      jsonrpc: '2.0',
      id: 9,
      method: 'shutdown',
      params: {},
    });
    // Wait long enough for setImmediate to fire.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(called).toBe(true);
    expect(exitCalled).toBe(0);
  });

  it('handles tools/list by returning manifest tools', async () => {
    const p = new DispatchPlugin();
    const response = await p.dispatch({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/list',
      params: {},
    });

    expect(response?.result).toBeDefined();
    const result = response?.result as { tools: unknown[] };
    expect(result.tools).toHaveLength(2);
  });
});