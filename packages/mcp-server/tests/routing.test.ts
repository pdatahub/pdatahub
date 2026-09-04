/**
 * Regression test for MCP routing (fixed in commit 4b06fcf).
 *
 * Why: MCP SDK 1.30.0 McpServer wrapper has a bug where tools/list and
 * tools/call return -32601 to MCP clients even when handlers ARE registered.
 * Server.ts was rewritten to use low-level Server class directly. This test
 * ensures the rewrite stays in place — if someone refactors back to McpServer
 * or breaks the setRequestHandler wiring, this test fails.
 *
 * Uses MCP SDK's InMemoryTransport (no subprocess, no bash, deterministic).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PdatahubMcpServer } from '../src/server.js';
import type { ToolDescriptor } from '../src/types.js';

class FakeHub {
  constructor(
    private readonly tools: ToolDescriptor[],
    private readonly handler: (name: string, args: Record<string, unknown>) => Promise<{
      content: Array<{ type: 'text'; text: string }>;
      isError?: boolean;
    }>,
  ) {}
  async listTools(): Promise<ToolDescriptor[]> {
    return this.tools;
  }
  async callTool(name: string, args: Record<string, unknown>) {
    return this.handler(name, args);
  }
}

const sampleTools: ToolDescriptor[] = [
  {
    name: 'echo.hello',
    description: 'Echo a greeting',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    scope: 'echo:read',
    plugin: 'mock',
  },
  {
    name: 'time.now',
    description: 'Current server time',
    inputSchema: { type: 'object' },
    scope: 'time:read',
    plugin: 'mock',
  },
];

describe('PdatahubMcpServer routing (regression for commit 4b06fcf)', () => {
  let server: PdatahubMcpServer;
  let client: Client;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;

  beforeEach(async () => {
    const hub = new FakeHub(sampleTools, async (name, args) => {
      if (name === 'echo.hello') {
        return { content: [{ type: 'text', text: `Hello, ${args.name ?? 'world'}!` }] };
      }
      if (name === 'time.now') {
        return { content: [{ type: 'text', text: new Date().toISOString() }] };
      }
      return {
        content: [{ type: 'text', text: `unknown tool: ${name}` }],
        isError: true,
      };
    });

    server = new PdatahubMcpServer(hub as unknown as ConstructorParameters<typeof PdatahubMcpServer>[0]);
    await server.refreshTools();

    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client(
      { name: 'routing-test', version: '1.0.0' },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
  });

  it('listTools returns all tools from Hub', async () => {
    const result = await client.listTools();
    expect(result.tools).toHaveLength(2);
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(['echo.hello', 'time.now']);
  });

  it('listTools includes description with scope and plugin metadata', async () => {
    const result = await client.listTools();
    const echo = result.tools.find((t) => t.name === 'echo.hello');
    expect(echo).toBeDefined();
    expect(echo!.description).toContain('Echo a greeting');
    expect(echo!.description).toContain('echo:read');
    expect(echo!.description).toContain('mock');
  });

  it('callTool dispatches to Hub and returns content', async () => {
    const result = await client.callTool({
      name: 'echo.hello',
      arguments: { name: 'pdatahub' },
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      { type: 'text', text: 'Hello, pdatahub!' },
    ]);
  });

  it('callTool handles args correctly for second tool', async () => {
    const result = await client.callTool({
      name: 'time.now',
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.type).toBe('text');
    expect(result.content[0]?.text).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('callTool propagates Hub errors with isError', async () => {
    const errorHub = new FakeHub(sampleTools, async () => ({
      content: [{ type: 'text', text: 'hub is down' }],
      isError: true,
    }));
    const errorServer = new PdatahubMcpServer(
      errorHub as unknown as ConstructorParameters<typeof PdatahubMcpServer>[0],
    );
    await errorServer.refreshTools();
    const [c2, s2] = InMemoryTransport.createLinkedPair();
    await errorServer.connect(s2);
    const c = new Client({ name: 't', version: '1' }, { capabilities: {} });
    await c.connect(c2);

    const result = await c.callTool({
      name: 'echo.hello',
      arguments: { name: 'x' },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('hub is down');
    await c.close();
    await s2.close();
  });

  it('callTool to unknown tool throws InvalidParams (no false success)', async () => {
    // Even if a client tries to call a tool that's not registered, the
    // server must reject — not return a fake success.
    await expect(
      client.callTool({
        name: 'nonexistent.tool',
        arguments: {},
      }),
    ).rejects.toThrow(/Unknown tool|nonexistent\.tool/);
  });

  afterEach(async () => {
    await client?.close();
    await serverTransport?.close();
  });
});
