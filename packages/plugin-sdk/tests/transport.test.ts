import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { StdioTransport } from '../src/transport.js';

/**
 * Build a pair of in-memory stdin/stdout streams for testing.
 */
function makeStreams(): {
  stdin: Readable;
  stdout: Writable;
  writes: string[];
  pushInput: (s: string) => void;
} {
  const writes: string[] = [];
  const stdin = new Readable({ read() {} });
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      writes.push(chunk.toString());
      cb();
    },
  });
  return {
    stdin,
    stdout,
    writes,
    pushInput: (s: string) => {
      stdin.push(s);
    },
  };
}

describe('StdioTransport', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('parses a single request and writes a response', async () => {
    const { stdin, stdout, writes } = makeStreams();
    const transport = new StdioTransport('test', { stdin, stdout });

    const handler = vi.fn(async (req: { id: number; method: string }) => ({
      jsonrpc: '2.0' as const,
      id: req.id,
      result: { ok: true },
    }));

    const promise = transport.listen(handler);
    stdin.push('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');

    // Wait for the handler to be called and response written.
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(writes).toHaveLength(1);
    });

    expect(writes[0]).toBe('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');

    stdin.push(null); // EOF
    await promise;
  });

  it('handles multiple sequential requests on the same stream', async () => {
    const { stdin, stdout, writes } = makeStreams();
    const transport = new StdioTransport('test', { stdin, stdout });

    const handler = vi.fn(async (req: { id: number; method: string }) => ({
      jsonrpc: '2.0' as const,
      id: req.id,
      result: { id: req.id },
    }));

    const promise = transport.listen(handler);

    stdin.push('{"jsonrpc":"2.0","id":1,"method":"a"}\n');
    stdin.push('{"jsonrpc":"2.0","id":2,"method":"b"}\n');
    stdin.push('{"jsonrpc":"2.0","id":3,"method":"c"}\n');

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(3);
    });
    await vi.waitFor(() => {
      expect(writes).toHaveLength(3);
    });

    expect(writes).toEqual([
      '{"jsonrpc":"2.0","id":1,"result":{"id":1}}\n',
      '{"jsonrpc":"2.0","id":2,"result":{"id":2}}\n',
      '{"jsonrpc":"2.0","id":3,"result":{"id":3}}\n',
    ]);

    stdin.push(null);
    await promise;
  });

  it('handles chunked input across newline boundaries', async () => {
    const { stdin, stdout, writes } = makeStreams();
    const transport = new StdioTransport('test', { stdin, stdout });

    const handler = vi.fn(async (req: { id: number }) => ({
      jsonrpc: '2.0' as const,
      id: req.id,
      result: 'ok',
    }));

    const promise = transport.listen(handler);

    // Push a single request split across two chunks.
    stdin.push('{"jsonrpc":"2.0","id":42');
    await new Promise((r) => setTimeout(r, 20));
    expect(handler).not.toHaveBeenCalled();

    stdin.push(',"method":"x"}\n');

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(writes).toHaveLength(1);
    });

    stdin.push(null);
    await promise;
  });

  it('handles notifications (no id) without sending response', async () => {
    const { stdin, stdout, writes } = makeStreams();
    const transport = new StdioTransport('test', { stdin, stdout });

    const handler = vi.fn(async () => null); // notifications return null

    const promise = transport.listen(handler);

    stdin.push('{"jsonrpc":"2.0","method":"log","params":{"msg":"hi"}}\n');

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });
    // Give it time to (not) write a response.
    await new Promise((r) => setTimeout(r, 20));
    expect(writes).toHaveLength(0);

    stdin.push(null);
    await promise;
  });

  it('catches handler errors and returns JSON-RPC internal error', async () => {
    const { stdin, stdout, writes } = makeStreams();
    const transport = new StdioTransport('test', { stdin, stdout });

    const handler = async () => {
      throw new Error('boom');
    };

    const promise = transport.listen(handler);
    stdin.push('{"jsonrpc":"2.0","id":99,"method":"explode"}\n');

    await vi.waitFor(() => {
      expect(writes).toHaveLength(1);
    });

    const response = JSON.parse(writes[0]!.trim()) as {
      jsonrpc: string;
      id: number;
      error: { code: number; message: string };
    };
    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(99);
    expect(response.error.code).toBe(-32603);
    expect(response.error.message).toBe('boom');

    stdin.push(null);
    await promise;
  });

  it('skips malformed JSON lines without crashing', async () => {
    const { stdin, stdout, writes } = makeStreams();
    const transport = new StdioTransport('test', { stdin, stdout });

    const handler = vi.fn(async (req: { id: number }) => ({
      jsonrpc: '2.0' as const,
      id: req.id,
      result: 'ok',
    }));

    const promise = transport.listen(handler);

    stdin.push('this is not json\n');
    stdin.push('{"jsonrpc":"2.0","id":1,"method":"good"}\n');

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(writes).toHaveLength(1);
    });

    stdin.push(null);
    await promise;
  });

  it('skips messages without jsonrpc: "2.0"', async () => {
    const { stdin, stdout, writes } = makeStreams();
    const transport = new StdioTransport('test', { stdin, stdout });

    const handler = vi.fn(async (req: { id: number }) => ({
      jsonrpc: '2.0' as const,
      id: req.id,
      result: 'ok',
    }));

    const promise = transport.listen(handler);

    stdin.push('{"jsonrpc":"1.0","id":1,"method":"legacy"}\n');
    stdin.push('{"jsonrpc":"2.0","id":2,"method":"modern"}\n');

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(writes).toHaveLength(1);
    });

    stdin.push(null);
    await promise;
  });

  it('throws if listen() is called twice', async () => {
    const { stdin, stdout } = makeStreams();
    const transport = new StdioTransport('test', { stdin, stdout });

    const promise = transport.listen(async () => null);

    await expect(transport.listen(async () => null)).rejects.toThrow(/twice/);

    stdin.push(null);
    await promise;
  });

  it('sendResponse writes a newline-terminated JSON line', () => {
    const { stdout, writes } = makeStreams();
    const transport = new StdioTransport('test', { stdout });

    transport.sendResponse(
      { jsonrpc: '2.0', id: 7, result: { hello: 'world' } },
      stdout,
    );

    expect(writes).toEqual(['{"jsonrpc":"2.0","id":7,"result":{"hello":"world"}}\n']);
  });

  it('sendNotification omits the id field', () => {
    const { stdout, writes } = makeStreams();
    const transport = new StdioTransport('test', { stdout });

    transport.sendNotification('progress', { percent: 50 }, stdout);

    const parsed = JSON.parse(writes[0]!.trim()) as { jsonrpc: string; method: string; id?: unknown };
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.method).toBe('progress');
    expect(parsed.id).toBeUndefined();
  });
});