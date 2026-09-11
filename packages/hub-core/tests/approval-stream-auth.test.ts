/**
 * Tests for /approval-stream WebSocket authentication.
 *
 * Regression coverage for the bug where /approval-stream accepted any
 * connection (relied entirely on Tailscale trust). Now requires
 * `?token=<HUB_API_TOKEN>` as a query parameter. Mismatch closes with
 * code 4001.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import Database from 'better-sqlite3';

import { ApprovalStream } from '../src/approval-stream.js';
import { runMigrations } from '../src/migrations.js';

const TEST_TOKEN = 'approval-stream-auth-test-token';

describe('ApprovalStream — /approval-stream token verification', () => {
  let stream: ApprovalStream;
  let port: number;
  let originalToken: string | undefined;

  beforeEach(async () => {
    // Unused DB — ApprovalStream doesn't touch storage. We only need it
    // because other tests in the suite import migrations for setup.
    void new Database(':memory:');

    originalToken = process.env.HUB_API_TOKEN;
    process.env.HUB_API_TOKEN = TEST_TOKEN;
    stream = new ApprovalStream({ timeoutMs: 500 });

    await new Promise<void>((resolve) => {
      const httpServer = createServer();
      stream.attach(httpServer);
      httpServer.listen(0, '127.0.0.1', () => {
        const addr = httpServer.address();
        if (!addr || typeof addr === 'string') {
          throw new Error('server did not bind to a port');
        }
        port = addr.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await stream.close();
    if (originalToken === undefined) delete process.env.HUB_API_TOKEN;
    else process.env.HUB_API_TOKEN = originalToken;
  });

  it('accepts connection with correct token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/approval-stream?token=${TEST_TOKEN}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 2000);
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('rejects connection with wrong token (closes 4001)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/approval-stream?token=wrong-token`);
    const closeCode = await new Promise<number>((resolve, reject) => {
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => {/* expected before close */});
      setTimeout(() => reject(new Error('timeout')), 2000);
    });
    expect(closeCode).toBe(4001);
  });

  it('rejects connection with no token (closes 4001)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/approval-stream`);
    const closeCode = await new Promise<number>((resolve, reject) => {
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => {/* expected before close */});
      setTimeout(() => reject(new Error('timeout')), 2000);
    });
    expect(closeCode).toBe(4001);
  });

  it('does not add rejected connections to the client set', async () => {
    // Spawn several bad connections in parallel
    const badConns = Array.from({ length: 5 }, () =>
      new WebSocket(`ws://127.0.0.1:${port}/approval-stream?token=bad`),
    );
    await Promise.all(
      badConns.map(
        (ws) =>
          new Promise<void>((resolve) => {
            ws.on('close', () => resolve());
            ws.on('error', () => resolve());
          }),
      ),
    );
    expect(stream.connectedClients()).toBe(0);

    // Now a good connection should still work and be counted
    const goodWs = new WebSocket(`ws://127.0.0.1:${port}/approval-stream?token=${TEST_TOKEN}`);
    await new Promise<void>((resolve, reject) => {
      goodWs.on('open', () => resolve());
      goodWs.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 2000);
    });
    expect(stream.connectedClients()).toBe(1);
    goodWs.close();
  });
});

describe('ApprovalStream — dev mode (no HUB_API_TOKEN configured)', () => {
  let stream: ApprovalStream;
  let port: number;
  let originalToken: string | undefined;

  beforeEach(async () => {
    originalToken = process.env.HUB_API_TOKEN;
    delete process.env.HUB_API_TOKEN;
    stream = new ApprovalStream({ timeoutMs: 500 });

    await new Promise<void>((resolve) => {
      const httpServer = createServer();
      stream.attach(httpServer);
      httpServer.listen(0, '127.0.0.1', () => {
        const addr = httpServer.address();
        if (!addr || typeof addr === 'string') {
          throw new Error('server did not bind to a port');
        }
        port = addr.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await stream.close();
    if (originalToken !== undefined) process.env.HUB_API_TOKEN = originalToken;
  });

  it('accepts connection without token when HUB_API_TOKEN unset (dev mode)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/approval-stream`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 2000);
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});
