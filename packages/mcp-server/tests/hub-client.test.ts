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
});
