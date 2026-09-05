/**
 * OAuth 2.0 flow coordinator.
 *
 * Plugin declares authorization_url, token_url, scopes (in manifest).
 * Hub stores client_id, client_secret (NOT in plugin — separation of concerns).
 *
 * Flow (authorization code with PKCE optional):
 *   1. Hub: startFlow() → generates state + (optional) PKCE verifier
 *   2. Hub: returns authorization_url with code_challenge
 *   3. User: opens URL in browser, approves
 *   4. Provider: redirects to loopback http://127.0.0.1:PORT/callback?code=...&state=...
 *   5. Hub: exchanges code → access_token + refresh_token
 *   6. Hub: stores tokens via TokenVault
 *
 * Loopback redirect: Hub starts a tiny HTTP server on a random port to receive
 * the callback. Matches RFC 8252 §7.3 for native apps.
 */

import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { request } from 'undici';
import type { PluginOAuthConfig } from './types.js';
import type { TokenVault } from './token-vault.js';
import { logger } from './logger.js';

export interface PluginClientConfig {
  client_id: string;
  client_secret?: string; // Optional for public clients (PKCE-only)
}

export interface OAuthStartResult {
  authorization_url: string;
  state: string;
  callback_port: number;
}

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number; // seconds
  scope?: string;
  token_type?: string;
}

export class OAuthFlow {
  private readonly pendingFlows = new Map<string, {
    plugin: string;
    oauth: PluginOAuthConfig;
    client: PluginClientConfig;
    callback_port: number;
    created_at: number;
    resolve: (code: string) => void;
    reject: (err: Error) => void;
    server: Server;
  }>();

  constructor(private readonly tokenVault: TokenVault) {}

  /**
   * Start OAuth flow: generate state, spin up loopback callback server, return auth URL.
   * Caller (Hub UI or server) redirects user to authorization_url.
   */
  async startFlow(opts: {
    plugin: string;
    oauth: PluginOAuthConfig;
    client: PluginClientConfig;
  }): Promise<OAuthStartResult> {
    const state = randomBytes(16).toString('hex');
    const callback_port = await this.getFreePort();

    const server = createServer((req, res) => {
      void this.handleCallback(req, res, state);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(callback_port, '127.0.0.1', () => resolve());
    });

    const codeVerifier = opts.oauth.use_pkce ? randomBytes(32).toString('base64url') : null;
    const codeChallenge = codeVerifier
      ? await sha256Base64Url(codeVerifier)
      : null;

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: opts.client.client_id,
      redirect_uri: `http://127.0.0.1:${callback_port}/callback`,
      scope: opts.oauth.scopes.join(' '),
      state,
      ...(codeChallenge ? {
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      } : {}),
    });

    const authorization_url = `${opts.oauth.authorization_url}?${params}`;

    return new Promise<OAuthStartResult>((resolveStart, rejectStart) => {
      const flow = {
        plugin: opts.plugin,
        oauth: opts.oauth,
        client: opts.client,
        callback_port,
        created_at: Date.now(),
        resolve: async (code: string) => {
          try {
            const tokens = await this.exchangeCode({
              oauth: opts.oauth,
              client: opts.client,
              code,
              callback_port,
              code_verifier: codeVerifier,
            });
            this.tokenVault.store({
              plugin: opts.plugin,
              access_token: tokens.access_token,
              ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
              ...(tokens.expires_in ? {
                expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
              } : {}),
              scope: tokens.scope ?? opts.oauth.scopes.join(' '),
            });
            resolveStart({
              authorization_url,
              state,
              callback_port,
            });
          } catch (err) {
            rejectStart(err as Error);
          } finally {
            this.cleanup(state);
          }
        },
        reject: (err: Error) => {
          this.cleanup(state);
          rejectStart(err);
        },
        server,
      };
      this.pendingFlows.set(state, flow);
      // Timeout: 5 minutes
      setTimeout(() => {
        if (this.pendingFlows.has(state)) {
          this.cleanup(state);
          rejectStart(new Error('OAuth flow timeout (5 min)'));
        }
      }, 5 * 60_000);
    });
  }

  /* ─── Private ─────────────────────────────────────────────────────────── */

  private async handleCallback(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    expectedState: string,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      res.statusCode = 400;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<h1>OAuth error</h1><p>${error}</p><p>You can close this window.</p>`);
      const flow = this.pendingFlows.get(expectedState);
      flow?.reject(new Error(`OAuth provider returned error: ${error}`));
      return;
    }
    if (state !== expectedState) {
      res.statusCode = 400;
      res.end('State mismatch');
      return;
    }
    if (!code) {
      res.statusCode = 400;
      res.end('Missing code');
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<h1>Success</h1><p>You can close this window and return to pdatahub.</p>');
    const flow = this.pendingFlows.get(state);
    flow?.resolve(code);
  }

  private cleanup(state: string): void {
    const flow = this.pendingFlows.get(state);
    if (flow) {
      flow.server.close();
      this.pendingFlows.delete(state);
    }
  }

  private async exchangeCode(opts: {
    oauth: PluginOAuthConfig;
    client: PluginClientConfig;
    code: string;
    callback_port: number;
    code_verifier: string | null;
  }): Promise<OAuthTokens> {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: `http://127.0.0.1:${opts.callback_port}/callback`,
      client_id: opts.client.client_id,
      ...(opts.client.client_secret ? { client_secret: opts.client.client_secret } : {}),
      ...(opts.code_verifier ? { code_verifier: opts.code_verifier } : {}),
    });

    const res = await request(opts.oauth.token_url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: params.toString(),
    });

    if (res.statusCode >= 400) {
      const text = await res.body.text();
      throw new Error(`Token exchange failed: ${res.statusCode} ${text}`);
    }
    const json = (await res.body.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      token_type?: string;
    };
    logger.info('OAuth tokens received', {
      has_refresh: !!json.refresh_token,
      expires_in: json.expires_in,
    });
    return {
      access_token: json.access_token,
      ...(json.refresh_token ? { refresh_token: json.refresh_token } : {}),
      ...(json.expires_in !== undefined ? { expires_in: json.expires_in } : {}),
      ...(json.scope ? { scope: json.scope } : {}),
      ...(json.token_type ? { token_type: json.token_type } : {}),
    };
  }

  private async getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          server.close();
          reject(new Error('failed to get free port'));
          return;
        }
        const port = addr.port;
        server.close(() => resolve(port));
      });
    });
  }
}

async function sha256Base64Url(input: string): Promise<string> {
  const crypto = await import('node:crypto');
  return crypto.createHash('sha256').update(input).digest('base64url');
}
