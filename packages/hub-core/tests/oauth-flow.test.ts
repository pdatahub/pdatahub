/**
 * Tests for OAuthFlow class.
 *
 * Covers the architectural fixes from 2026-09-05:
 *   - startFlow returns IMMEDIATELY with authorization_url (does not block
 *     waiting for OAuth callback completion — was the original bug that
 *     hung the HTTP response for 5 minutes).
 *   - callback_port is fixed when fixedCallbackPort > 0 (Google Web-app
 *     OAuth clients require exact redirect_uri match including port).
 *   - authorization_url is well-formed with all required OAuth params.
 *   - callback server is actually listening on the configured port.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { TokenVault } from '../src/token-vault.js';
import { OAuthFlow } from '../src/oauth-flow.js';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { createServer, type Server, type AddressInfo } from 'node:http';
import type { PluginOAuthConfig } from '../src/types.js';

const masterKey = Buffer.from('a'.repeat(64), 'hex');

let db: Database.Database;
let dbPath: string;
let vault: TokenVault;

const sampleOauth: PluginOAuthConfig = {
  authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_url: 'https://oauth2.googleapis.com/token',
  scopes: [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events',
  ],
};

beforeEach(() => {
  dbPath = join(tmpdir(), `oauth-test-${randomBytes(4).toString('hex')}.db`);
  db = new Database(dbPath);
  vault = new TokenVault(db, masterKey);
});

afterEach(() => {
  db.close();
  if (existsSync(dbPath)) rmSync(dbPath);
});

describe('OAuthFlow.startFlow — immediate resolve', () => {
  it('returns within 100ms with authorization_url (does NOT block 5min)', async () => {
    const flow = new OAuthFlow(vault);
    const start = Date.now();
    const result = await flow.startFlow({
      plugin: 'google-calendar',
      oauth: sampleOauth,
      client: { client_id: 'test.apps.googleusercontent.com', client_secret: 'secret' },
    });
    const elapsed = Date.now() - start;

    expect(result.authorization_url).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(result.state).toMatch(/^[a-f0-9]{32}$/);
    expect(elapsed).toBeLessThan(100);
  });

  it('authorization_url contains redirect_uri, scope, state, response_type, client_id', async () => {
    const flow = new OAuthFlow(vault);
    const result = await flow.startFlow({
      plugin: 'google-calendar',
      oauth: sampleOauth,
      client: { client_id: 'my-client.apps.googleusercontent.com', client_secret: 's' },
    });

    const url = new URL(result.authorization_url);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('my-client.apps.googleusercontent.com');
    expect(url.searchParams.get('state')).toBe(result.state);
    expect(url.searchParams.get('scope')).toContain('calendar.readonly');
    expect(url.searchParams.get('scope')).toContain('calendar.events');
    expect(url.searchParams.get('redirect_uri')).toMatch(/127\.0\.0\.1:\d+\/callback$/);
  });

  it('uses fixed callback port when configured', async () => {
    const flow = new OAuthFlow(vault, 18081);
    const result = await flow.startFlow({
      plugin: 'google-calendar',
      oauth: sampleOauth,
      client: { client_id: 'c', client_secret: 's' },
    });

    expect(result.callback_port).toBe(18081);

    const url = new URL(result.authorization_url);
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:18081/callback');
  });

  it('uses random callback port when fixedCallbackPort=0', async () => {
    const flow = new OAuthFlow(vault, 0);
    const result = await flow.startFlow({
      plugin: 'google-calendar',
      oauth: sampleOauth,
      client: { client_id: 'c', client_secret: 's' },
    });

    expect(result.callback_port).toBeGreaterThan(1024);
    expect(result.callback_port).toBeLessThan(65536);
  });

  it('callback server is actually listening on the configured port', async () => {
    const flow = new OAuthFlow(vault, 18082);
    const result = await flow.startFlow({
      plugin: 'google-calendar',
      oauth: sampleOauth,
      client: { client_id: 'c', client_secret: 's' },
    });

    try {
      const res = await fetch(
        `http://127.0.0.1:${result.callback_port}/callback?state=${result.state}`,
      );
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toBe('Missing code');
    } finally {
      await fetch(
        `http://127.0.0.1:${result.callback_port}/callback?error=user_cancelled&state=${result.state}`,
      ).catch(() => {});
    }
  });
});

describe('OAuthFlow — error handling on callback', () => {
  it('rejects with provider error when error param present', async () => {
    const flow = new OAuthFlow(vault, 18083);
    const result = await flow.startFlow({
      plugin: 'google-calendar',
      oauth: sampleOauth,
      client: { client_id: 'c', client_secret: 's' },
    });

    const callbackRes = await fetch(
      `http://127.0.0.1:${result.callback_port}/callback?error=access_denied&state=${result.state}`,
    );
    expect(callbackRes.status).toBe(400);
    expect(await callbackRes.text()).toContain('access_denied');
  });

  it('rejects with state mismatch when state does not match', async () => {
    const flow = new OAuthFlow(vault, 18084);
    const result = await flow.startFlow({
      plugin: 'google-calendar',
      oauth: sampleOauth,
      client: { client_id: 'c', client_secret: 's' },
    });

    const callbackRes = await fetch(
      `http://127.0.0.1:${result.callback_port}/callback?code=abc&state=wrongstate`,
    );
    expect(callbackRes.status).toBe(400);
    expect(await callbackRes.text()).toBe('State mismatch');
  });

  it('rejects with actionable message when fixed callback port is busy', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(19090, '127.0.0.1', () => resolve()));

    try {
      const flow = new OAuthFlow(vault, 19090);
      const err = await flow.startFlow({
        plugin: 'google-calendar',
        oauth: sampleOauth,
        client: { client_id: 'c', client_secret: 's' },
      }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/OAuth callback port 19090 is already in use/);
      expect(err.message).toMatch(/time out/);
      expect(err.message).toMatch(/restart hub-core/);
      expect(err.message).toMatch(/random port/);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe('OAuthFlow — full integration (mock Google token endpoint)', () => {
  let mockTokenServer: Server;
  let mockTokenPort: number;
  let receivedParams: URLSearchParams | null = null;
  let receivedHeaders: Record<string, string | string[] | undefined> | null = null;

  beforeEach(async () => {
    receivedParams = null;
    receivedHeaders = null;
    mockTokenServer = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        receivedParams = new URLSearchParams(body);
        receivedHeaders = req.headers;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          access_token: 'ya29.fake-access-token-xyz',
          refresh_token: '1//fake-refresh-token-abc',
          expires_in: 3600,
          scope: sampleOauth.scopes.join(' '),
          token_type: 'Bearer',
        }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      mockTokenServer.once('error', reject);
      mockTokenServer.listen(0, '127.0.0.1', () => resolve());
    });
    mockTokenPort = (mockTokenServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => mockTokenServer.close(() => resolve()));
  });

  it('callback → exchangeCode → tokenVault.store end-to-end', async () => {
    const flow = new OAuthFlow(vault, 18086);
    const oauthWithMockToken: PluginOAuthConfig = {
      ...sampleOauth,
      token_url: `http://127.0.0.1:${mockTokenPort}/token`,
    };

    const result = await flow.startFlow({
      plugin: 'google-calendar',
      oauth: oauthWithMockToken,
      client: { client_id: 'integration-test.apps.googleusercontent.com', client_secret: 'test-secret-123' },
    });

    const callbackRes = await fetch(
      `http://127.0.0.1:${result.callback_port}/callback?code=fake-auth-code&state=${result.state}`,
    );
    expect(callbackRes.status).toBe(200);

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !vault.get('google-calendar')) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const stored = vault.get('google-calendar');
    expect(stored).not.toBeNull();
    expect(stored?.access_token).toBe('ya29.fake-access-token-xyz');
    expect(stored?.refresh_token).toBe('1//fake-refresh-token-abc');
    expect(stored?.expires_at).toBeTruthy();
    const expiresAt = new Date(stored!.expires_at!).getTime();
    const expectedExpiry = Date.now() + 3600 * 1000;
    expect(Math.abs(expiresAt - expectedExpiry)).toBeLessThan(5000);
    expect(stored?.scope).toBe(sampleOauth.scopes.join(' '));

    expect(receivedParams?.get('grant_type')).toBe('authorization_code');
    expect(receivedParams?.get('code')).toBe('fake-auth-code');
    expect(receivedParams?.get('client_id')).toBe('integration-test.apps.googleusercontent.com');
    expect(receivedParams?.get('client_secret')).toBe('test-secret-123');
    expect(receivedParams?.get('redirect_uri')).toBe(
      `http://127.0.0.1:18086/callback`,
    );

    expect(receivedHeaders?.['content-type']).toBe('application/x-www-form-urlencoded');
    expect(receivedHeaders?.['accept']).toBe('application/json');
  });

  it('does NOT store token when token endpoint returns error', async () => {
    const errorServer = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Bad authorization code',
        }));
      });
    });
    await new Promise<void>((resolve) => errorServer.listen(0, '127.0.0.1', () => resolve()));
    const errorPort = (errorServer.address() as AddressInfo).port;

    try {
      const flow = new OAuthFlow(vault, 18087);
      const oauthWithErrorToken: PluginOAuthConfig = {
        ...sampleOauth,
        token_url: `http://127.0.0.1:${errorPort}/token`,
      };

      const result = await flow.startFlow({
        plugin: 'google-calendar',
        oauth: oauthWithErrorToken,
        client: { client_id: 'c', client_secret: 's' },
      });

      await fetch(
        `http://127.0.0.1:${result.callback_port}/callback?code=bad-code&state=${result.state}`,
      );

      await new Promise((r) => setTimeout(r, 200));

      expect(vault.get('google-calendar')).toBeNull();
    } finally {
      await new Promise<void>((resolve) => errorServer.close(() => resolve()));
    }
  });
});
