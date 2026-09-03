/**
 * MCP server that bridges AI agents (OpenCode/Claude Code) to pdatahub Hub.
 *
 * Flow:
 *   1. Connect to Hub, fetch available tools
 *   2. Register each tool with the MCP server (passes inputSchema through)
 *   3. On `tools/call` from AI agent → forward to Hub → return result
 *
 * Hub is the source of truth for tool contracts. This server is a thin proxy.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { HubClient } from './hub-client.js';
import { logger } from './logger.js';
import type { ToolDescriptor } from './types.js';

export interface McpServerOptions {
  name?: string;
  version?: string;
}

export class PdatahubMcpServer {
  private readonly server: McpServer;
  private readonly hub: HubClient;
  private tools: Map<string, ToolDescriptor> = new Map();

  constructor(hub: HubClient, options: McpServerOptions = {}) {
    this.hub = hub;
    this.server = new McpServer({
      name: options.name ?? 'pdatahub-mcp',
      version: options.version ?? '0.1.0',
    });
  }

  /**
   * Fetch tool list from Hub and register each with the MCP server.
   * Replaces previously registered tools (for refresh flows).
   */
  async refreshTools(): Promise<ToolDescriptor[]> {
    const tools = await this.hub.listTools();
    this.tools = new Map(tools.map((t) => [t.name, t]));
    logger.info(`Loaded ${tools.length} tools from Hub`);
    return tools;
  }

  /**
   * Register a static set of tools. Used for tests and for
   * refresh-and-re-register flows.
   */
  registerTools(tools: ToolDescriptor[]): void {
    for (const tool of tools) {
      this.registerOne(tool);
    }
  }

  private registerOne(tool: ToolDescriptor): void {
    this.server.registerTool(
      tool.name,
      {
        description: this.buildDescription(tool),
        // Stub: accept any object. Hub validates real inputs.
        // We construct a passthrough Zod schema so the MCP SDK accepts
        // arbitrary args without rejecting. Tight schemas come from Hub later.
        inputSchema: z.object({}).passthrough(),
      },
      async (args) => {
        logger.debug('tool call', { name: tool.name, args });
        try {
          const result = await this.hub.callTool(tool.name, args as Record<string, unknown>);
          if (result.isError) {
            return {
              content: result.content,
              isError: true,
            };
          }
          return { content: result.content };
        } catch (err) {
          const msg = (err as Error).message;
          logger.error('tool call failed', { name: tool.name, error: msg });
          return {
            content: [{ type: 'text', text: `Hub error: ${msg}` }],
            isError: true,
          };
        }
      },
    );
    logger.debug('registered tool', { name: tool.name, scope: tool.scope, plugin: tool.plugin });
    this.tools.set(tool.name, tool);
  }

  private buildDescription(tool: ToolDescriptor): string {
    const meta = `[scope: ${tool.scope}, plugin: ${tool.plugin}]`;
    return `${tool.description} ${meta}`;
  }

  /**
   * Connect MCP server to a transport (typically stdio for AI-agent use).
   * Tools must be registered before calling this.
   */
  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
    logger.info('MCP server connected');
  }

  /**
   * Convenience: connect to stdio and wait for the transport to close.
   * Returns when the AI agent disconnects.
   */
  async serveStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.connect(transport);
    // The stdio transport fires 'close' on the underlying streams.
    await new Promise<void>((resolve) => {
      const cleanup = () => resolve();
      process.stdin.once('close', cleanup);
      process.stdout.once('close', cleanup);
      process.stdin.once('end', cleanup);
      process.stdout.once('end', cleanup);
    });
    logger.info('MCP server disconnected');
  }

  /**
   * Get a snapshot of currently registered tools. For tests and introspection.
   */
  getTools(): ToolDescriptor[] {
    return Array.from(this.tools.values());
  }
}
