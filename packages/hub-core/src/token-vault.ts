/**
 * Token vault — encrypted storage for OAuth tokens.
 *
 * Tokens are NEVER stored in plaintext. AES-256-GCM with per-plugin key.
 * Per-plugin key derived from master key via HKDF (so a leak of one plugin's
 * ciphertext doesn't compromise other plugins' tokens).
 *
 * Plugin NEVER sees raw OAuth token — Hub injects via SDK's httpClient.
 * This module returns plaintext ONLY to internal Hub callers (PluginProcess).
 */

import type Database from 'better-sqlite3';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { request } from 'undici';
import { logger } from './logger.js';

interface RefreshResponse {
  access_token: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
  // Google sometimes rotates the refresh_token (e.g. when scopes change).
  // When absent, the previous refresh_token remains valid.
  refresh_token?: string;
}

export interface TokenInput {
  plugin: string;
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
  scope: string;
}

export interface DecryptedToken {
  plugin: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  scope: string;
}

export class TokenVault {
  private readonly masterKey: Buffer;

  constructor(
    private readonly db: Database.Database,
    masterKey: Buffer,
  ) {
    if (masterKey.length !== 32) {
      throw new Error('master key must be 32 bytes (AES-256)');
    }
    this.masterKey = masterKey;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS token_vault (
        plugin TEXT PRIMARY KEY,
        access_token_enc BLOB NOT NULL,
        access_token_iv BLOB NOT NULL,
        access_token_tag BLOB NOT NULL,
        refresh_token_enc BLOB,
        refresh_token_iv BLOB,
        refresh_token_tag BLOB,
        expires_at TEXT,
        scope TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  /**
   * Derive per-plugin encryption key from master key.
   * HKDF(masterKey, pluginName) → 32-byte AES-256 key.
   */
  private pluginKey(plugin: string): Buffer {
    const derived = hkdfSync(
      'sha256',
      this.masterKey,
      Buffer.from(plugin, 'utf8'),
      Buffer.from('pdatahub-token-vault-v1', 'utf8'),
      32,
    );
    return Buffer.from(derived);
  }

  /**
   * Encrypt plaintext with AES-256-GCM using per-plugin key.
   * Returns { ciphertext, iv, tag }.
   */
  private encrypt(plugin: string, plaintext: string): {
    enc: Buffer;
    iv: Buffer;
    tag: Buffer;
  } {
    const key = this.pluginKey(plugin);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { enc, iv, tag };
  }

  /**
   * Decrypt ciphertext with AES-256-GCM. Throws if tag verification fails.
   */
  private decrypt(plugin: string, enc: Buffer, iv: Buffer, tag: Buffer): string {
    const key = this.pluginKey(plugin);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString('utf8');
  }

  /**
   * Store or update tokens for a plugin. Encrypts before write.
   */
  store(input: TokenInput): void {
    const now = new Date().toISOString();
    const access = this.encrypt(input.plugin, input.access_token);
    const refresh = input.refresh_token
      ? this.encrypt(input.plugin, input.refresh_token)
      : null;

    const existing = this.db.prepare(
      'SELECT plugin FROM token_vault WHERE plugin = ?'
    ).get(input.plugin);

    if (existing) {
      this.db.prepare(`
        UPDATE token_vault SET
          access_token_enc = ?, access_token_iv = ?, access_token_tag = ?,
          refresh_token_enc = ?, refresh_token_iv = ?, refresh_token_tag = ?,
          expires_at = ?, scope = ?, updated_at = ?
        WHERE plugin = ?
      `).run(
        access.enc, access.iv, access.tag,
        refresh?.enc ?? null, refresh?.iv ?? null, refresh?.tag ?? null,
        input.expires_at ?? null, input.scope, now,
        input.plugin,
      );
    } else {
      this.db.prepare(`
        INSERT INTO token_vault (
          plugin, access_token_enc, access_token_iv, access_token_tag,
          refresh_token_enc, refresh_token_iv, refresh_token_tag,
          expires_at, scope, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.plugin,
        access.enc, access.iv, access.tag,
        refresh?.enc ?? null, refresh?.iv ?? null, refresh?.tag ?? null,
        input.expires_at ?? null, input.scope, now, now,
      );
    }
    logger.info('token stored', {
      plugin: input.plugin,
      has_refresh: !!input.refresh_token,
      expires_at: input.expires_at ?? null,
    });
  }

  /**
   * Retrieve and decrypt tokens for a plugin. Returns null if not found.
   * INTERNAL USE ONLY — PluginProcess retrieves on behalf of plugin.
   */
  get(plugin: string): DecryptedToken | null {
    const row = this.db.prepare(`
      SELECT plugin, access_token_enc, access_token_iv, access_token_tag,
             refresh_token_enc, refresh_token_iv, refresh_token_tag,
             expires_at, scope
      FROM token_vault WHERE plugin = ?
    `).get(plugin) as TokenRow | undefined;
    if (!row) return null;

    const access_token = this.decrypt(
      row.plugin,
      row.access_token_enc,
      row.access_token_iv,
      row.access_token_tag,
    );
    const refresh_token = row.refresh_token_enc && row.refresh_token_iv && row.refresh_token_tag
      ? this.decrypt(row.plugin, row.refresh_token_enc, row.refresh_token_iv, row.refresh_token_tag)
      : null;

    return {
      plugin: row.plugin,
      access_token,
      refresh_token,
      expires_at: row.expires_at,
      scope: row.scope,
    };
  }

  /**
   * Delete tokens for a plugin (called on plugin uninstall).
   */
  delete(plugin: string): boolean {
    const result = this.db.prepare(
      'DELETE FROM token_vault WHERE plugin = ?'
    ).run(plugin);
    if (result.changes > 0) {
      logger.info('token deleted', { plugin });
      return true;
    }
    return false;
  }

  /**
   * List all plugins with stored tokens (no secrets leaked).
   */
  listPlugins(): Array<{ plugin: string; scope: string; expires_at: string | null }> {
    const rows = this.db.prepare(`
      SELECT plugin, scope, expires_at FROM token_vault ORDER BY plugin
    `).all() as Array<{ plugin: string; scope: string; expires_at: string | null }>;
    return rows;
  }

  /**
   * Exchange a stored refresh_token for a fresh access_token. Updates the
   * vault with the new access_token (and refresh_token if Google rotated it).
   *
   * Caller passes the OAuth client_id + client_secret for this plugin (read
   * from HUB_CLIENT_<PLUGIN>_ID / _SECRET env or config). The refresh_token
   * stays inside the vault.
   *
   * Throws if the plugin has no refresh_token stored, or if the refresh
   * endpoint returns a non-2xx status.
   */
  async refreshAccessToken(
    plugin: string,
    clientId: string,
    clientSecret: string | undefined,
    tokenUrl: string,
  ): Promise<{ expires_at: string; scope: string }> {
    const existing = this.get(plugin);
    if (!existing) {
      throw new Error(`no token stored for plugin ${plugin}`);
    }
    if (!existing.refresh_token) {
      throw new Error(
        `no refresh_token for plugin ${plugin} — re-authorization required`,
      );
    }

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: existing.refresh_token,
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    });

    const res = await request(tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: params.toString(),
    });

    if (res.statusCode >= 400) {
      const text = await res.body.text();
      throw new Error(`token refresh failed: ${res.statusCode} ${text}`);
    }

    const json = (await res.body.json()) as RefreshResponse;
    const expiresAt = new Date(Date.now() + json.expires_in * 1000).toISOString();
    const scope = json.scope ?? existing.scope;

    // Pass existing.refresh_token when new one is absent so store() preserves it.
    this.store({
      plugin,
      access_token: json.access_token,
      refresh_token: json.refresh_token ?? existing.refresh_token,
      expires_at: expiresAt,
      scope,
    });

    logger.info('OAuth token refreshed', {
      plugin,
      has_new_refresh: !!json.refresh_token,
      expires_in: json.expires_in,
    });

    return { expires_at: expiresAt, scope };
  }

  /**
   * True if the stored access_token will expire within `withinMs` (default
   * 5 minutes). Returns false if there's no expiry or no stored token.
   */
  isExpiringSoon(plugin: string, withinMs = 5 * 60_000): boolean {
    const token = this.get(plugin);
    if (!token?.expires_at) return false;
    const exp = Date.parse(token.expires_at);
    if (Number.isNaN(exp)) return false;
    return exp - Date.now() < withinMs;
  }
}

interface TokenRow {
  plugin: string;
  access_token_enc: Buffer;
  access_token_iv: Buffer;
  access_token_tag: Buffer;
  refresh_token_enc: Buffer | null;
  refresh_token_iv: Buffer | null;
  refresh_token_tag: Buffer | null;
  expires_at: string | null;
  scope: string;
}
