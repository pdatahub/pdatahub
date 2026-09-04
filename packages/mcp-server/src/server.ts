/**
 * MCP server that bridges AI agents (OpenCode/Claude Code) to pdatahub Hub.
 *
 * Flow:
 *   1. Connect to Hub, fetch available tools
 *   2. Register each tool with the MCP server (passes inputSchema through)
 *   3. On `tools/call` from AI agent → forward to Hub → return result
 *
 * Hub is the source of truth for tool contracts. This server is a thin proxy.
 *
 * Implementation note: uses MCP SDK's low-level `Server` class directly,
 * NOT the `McpServer` wrapper. SDK 1.30.0's `McpServer.setToolRequestHandlers()`
 * has a bug where handlers are registered in `_requestHandlers` Map but routing
 * returns -32601 "Method not found" for `tools/list` / `tools/call`. Low-level
 * Server works correctly (verified via /tmp/low-level-{server,client}.mjs).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { HubClient } from './hub-client.js';
import { logger } from './logger.js';
import type { ToolDescriptor } from './types.js';

export interface McpServerOptions {
  name?: string;
  version?: string;
}

type CallToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

export class PdatahubMcpServer {
  private readonly server: Server;
  private readonly hub: HubClient;
  private tools: Map<string, ToolDescriptor> = new Map();
  private toolHandlers: Map<string, ToolHandler> = new Map();

  constructor(hub: HubClient, options: McpServerOptions = {}) {
    this.hub = hub;
    this.server = new Server(
      {
        name: options.name ?? 'pdatahub-mcp',
        version: options.version ?? '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: Array.from(this.tools.values()).map((tool) => ({
          name: tool.name,
          description: this.buildDescription(tool),
          inputSchema: tool.inputSchema,
        })),
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const toolName = request.params.name;
      const handler = this.toolHandlers.get(toolName);
      if (!handler) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${toolName}`);
      }
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      return handler(args);
    });
  }

  /**
   * Fetch tool list from Hub and register each with the MCP server.
   * Replaces previously registered tools (for refresh flows).
   */
  async refreshTools(): Promise<ToolDescriptor[]> {
    const tools = await this.hub.listTools();
    this.tools = new Map(tools.map((t) => [t.name, t]));
    this.toolHandlers = new Map();
    for (const tool of tools) {
      this.toolHandlers.set(tool.name, async (args) => {
        try {
          return await this.hub.callTool(tool.name, args);
        } catch (err) {
          logger.error('tool call failed', { name: tool.name, error: (err as Error).message });
          throw new McpError(
            ErrorCode.InternalError,
            `Hub call failed: ${(err as Error).message}`,
          );
        }
      });
    }
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
    this.tools.set(tool.name, tool);
    this.toolHandlers.set(tool.name, async (args) => {
      return this.hub.callTool(tool.name, args);
    });
  }

  buildDescription(tool: ToolDescriptor): string {
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
