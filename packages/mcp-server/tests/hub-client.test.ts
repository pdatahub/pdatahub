import { describe, it, expect, vi } from 'vitest';
import { HubClient, HubError } from '../src/hub-client.js';

function mockResponse(statusCode: number, body: unknown): Response {
  return {
    statusCode,
    body: {
      json: async () => body,
    },
  } as unknown as Response;
}

const validConfig = { hubUrl: 'http://hub:8080', sessionToken: 'tok' };

describe('HubClient', () => {
  it('listTools fetches /v1/tools and returns array', async () => {
    const client = new HubClient(validConfig);
    const requestSpy = vi.fn().mockResolvedValue(
      mockResponse(200, {
        tools: [
          {
            name: 'calendar.read.events',
            description: 'Read events',
            inputSchema: {},
            scope: 'calendar:read',
            plugin: 'google-calendar',
          },
        ],
      }),
    );
    (client as unknown as { request: typeof requestSpy }).request = requestSpy;

    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('calendar.read.events');
  });

  it('listTools returns [] when Hub returns no tools', async () => {
    const client = new HubClient(validConfig);
    const requestSpy = vi.fn().mockResolvedValue(mockResponse(200, { tools: [] }));
    (client as unknown as { request: typeof requestSpy }).request = requestSpy;

    const tools = await client.listTools();
    expect(tools).toEqual([]);
  });

  it('callTool POSTs args and returns content', async () => {
    const client = new HubClient(validConfig);
    const requestSpy = vi.fn().mockResolvedValue(
      mockResponse(200, {
        content: [{ type: 'text', text: 'ok' }],
      }),
    );
    (client as unknown as { request: typeof requestSpy }).request = requestSpy;

    const result = await client.callTool('ping', { hello: 'world' });
    expect(result.content[0]?.text).toBe('ok');
    expect(result.isError).toBe(false);
  });

  it('callTool surfaces Hub errors with status', async () => {
    const client = new HubClient(validConfig);
    const requestSpy = vi.fn().mockRejectedValue(
      new HubError('tool not found', 404, 'NOT_FOUND'),
    );
    (client as unknown as { request: typeof requestSpy }).request = requestSpy;

    await expect(client.callTool('missing', {})).rejects.toThrow(HubError);
  });

  // Phase 5 (Federation v2, Momus B6) — invokeFederated routes synthetic
  // federated tool names to `/v1/federation/invoke` instead of
  // `/v1/tools/:name/call`. The transport-level concern (URL, headers,
  // body) lives here; the routing decision on the MCP side lives in
  // server.test.ts below.
  it('invokeFederated POSTs to /v1/federation/invoke with the synthetic tool name and arguments', async () => {
    const client = new HubClient(validConfig);
    const requestSpy = vi.fn().mockResolvedValue(
      mockResponse(200, {
        content: [{ type: 'text', text: '{"ok":true}' }],
      }),
    );
    (client as unknown as { request: typeof requestSpy }).request = requestSpy;

    const result = await client.invokeFederated(
      'federated__userA__listEvents',
      { from: '2026-09-01' },
    );
    expect(result.content[0]?.text).toBe('{"ok":true}');
    expect(requestSpy).toHaveBeenCalledWith(
      'POST',
      'http://hub:8080/v1/federation/invoke',
      { tool: 'federated__userA__listEvents', arguments: { from: '2026-09-01' } },
    );
  });

  it('invokeFederated returns isError when Hub reports failure', async () => {
    const client = new HubClient(validConfig);
    const requestSpy = vi.fn().mockResolvedValue(
      mockResponse(200, {
        content: [{ type: 'text', text: 'federation upstream unreachable' }],
        isError: true,
      }),
    );
    (client as unknown as { request: typeof requestSpy }).request = requestSpy;

    const result = await client.invokeFederated('federated__userA__listEvents', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('federation upstream unreachable');
  });

  it('invokeFederated surfaces Hub errors with status', async () => {
    const client = new HubClient(validConfig);
    const requestSpy = vi.fn().mockRejectedValue(
      new HubError('delegation not found', 404, 'DELEGATION_NOT_FOUND'),
    );
    (client as unknown as { request: typeof requestSpy }).request = requestSpy;

    await expect(
      client.invokeFederated('federated__userA__listEvents', {}),
    ).rejects.toThrow(HubError);
  });
});
