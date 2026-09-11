/**
 * Persistent storage for plugin OAuth client credentials (client_id, client_secret).
 *
 * Before this module, OAuth credentials were passed in-memory via
 * `HubServerOptions.clientCredentials: Map<string, PluginClientConfig>`,
 * which meant operators had to set env vars and restart the hub to
 * configure a new plugin. Now credentials live in the hub DB, encrypted
 * with the hub master key, and the web UI can manage them via
 * `PUT /v1/plugins/:name/oauth/credentials`.
 *
 * Encryption: AES-256-GCM with a per-plugin HKDF-derived key.
 * Same construction as TokenVault — different HKDF info string
 * (`pdatahub-oauth-credentials-v1` vs `pdatahub-token-vault-v1`) so a
 * vault compromise doesn't leak credentials and vice versa.
 *
 * Storage layout matches TokenVault's encrypted-BLOB columns. One row
 * per plugin. `client_secret` is nullable because OAuth providers like
 * Google support PKCE-only flows without a secret (public clients).
 */

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import type Database from 'better-sqlite3';
import { logger } from './logger.js';

export interface OAuthCredentialsInput {
  client_id: string;
  client_secret?: string | null;
}

export interface OAuthCredentials {
  plugin: string;
  client_id: string;
  client_secret: string | null;
  created_at: string;
  updated_at: string;
}

export class PluginOAuthStore {
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
      CREATE TABLE IF NOT EXISTS plugin_oauth_credentials (
        plugin TEXT PRIMARY KEY,
        client_id_enc BLOB NOT NULL,
        client_id_iv BLOB NOT NULL,
        client_id_tag BLOB NOT NULL,
        client_secret_enc BLOB,
        client_secret_iv BLOB,
        client_secret_tag BLOB,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  private pluginKey(plugin: string): Buffer {
    const derived = hkdfSync(
      'sha256',
      this.masterKey,
      Buffer.from(plugin, 'utf8'),
      Buffer.from('pdatahub-oauth-credentials-v1', 'utf8'),
      32,
    );
    return Buffer.from(derived);
  }

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

  private decrypt(
    plugin: string,
    enc: Buffer,
    iv: Buffer,
    tag: Buffer,
  ): string {
    const key = this.pluginKey(plugin);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString('utf8');
  }

  /**
   * Store or replace OAuth credentials for a plugin. Encrypts client_id and
   * (if provided) client_secret before write.
   */
  set(plugin: string, input: OAuthCredentialsInput): void {
    const now = new Date().toISOString();
    const clientIdEnc = this.encrypt(plugin, input.client_id);
    const clientSecretEnc = input.client_secret
      ? this.encrypt(plugin, input.client_secret)
      : null;

    const existing = this.db.prepare(
      'SELECT plugin FROM plugin_oauth_credentials WHERE plugin = ?',
    ).get(plugin);

    if (existing) {
      this.db.prepare(`
        UPDATE plugin_oauth_credentials SET
          client_id_enc = ?, client_id_iv = ?, client_id_tag = ?,
          client_secret_enc = ?, client_secret_iv = ?, client_secret_tag = ?,
          updated_at = ?
        WHERE plugin = ?
      `).run(
        clientIdEnc.enc, clientIdEnc.iv, clientIdEnc.tag,
        clientSecretEnc?.enc ?? null,
        clientSecretEnc?.iv ?? null,
        clientSecretEnc?.tag ?? null,
        now, plugin,
      );
    } else {
      this.db.prepare(`
        INSERT INTO plugin_oauth_credentials (
          plugin, client_id_enc, client_id_iv, client_id_tag,
          client_secret_enc, client_secret_iv, client_secret_tag,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        plugin,
        clientIdEnc.enc, clientIdEnc.iv, clientIdEnc.tag,
        clientSecretEnc?.enc ?? null,
        clientSecretEnc?.iv ?? null,
        clientSecretEnc?.tag ?? null,
        now, now,
      );
    }
    logger.info('OAuth credentials stored', { plugin });
  }

  /**
   * Read OAuth credentials for a plugin. Returns null if not configured.
   * Use `peek()` if you only need to know whether credentials exist
   * (avoids decrypting on hot paths).
   */
  get(plugin: string): OAuthCredentials | null {
    const row = this.db.prepare(
      'SELECT * FROM plugin_oauth_credentials WHERE plugin = ?',
    ).get(plugin) as {
      plugin: string;
      client_id_enc: Buffer;
      client_id_iv: Buffer;
      client_id_tag: Buffer;
      client_secret_enc: Buffer | null;
      client_secret_iv: Buffer | null;
      client_secret_tag: Buffer | null;
      created_at: string;
      updated_at: string;
    } | undefined;
    if (!row) return null;

    const clientId = this.decrypt(plugin, row.client_id_enc, row.client_id_iv, row.client_id_tag);
    let clientSecret: string | null = null;
    if (row.client_secret_enc && row.client_secret_iv && row.client_secret_tag) {
      clientSecret = this.decrypt(
        plugin,
        row.client_secret_enc,
        row.client_secret_iv,
        row.client_secret_tag,
      );
    }

    return {
      plugin: row.plugin,
      client_id: clientId,
      client_secret: clientSecret,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /** Cheap check whether credentials are configured for a plugin. */
  has(plugin: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM plugin_oauth_credentials WHERE plugin = ?',
    ).get(plugin);
    return row !== undefined;
  }

  /**
   * Remove OAuth credentials for a plugin. Returns true if a row was deleted.
   * Does NOT revoke the existing OAuth token — that's a separate concern
   * (`/v1/plugins/:name/revoke` if it exists, or have the user manually
   * revoke in the provider's console).
   */
  delete(plugin: string): boolean {
    const result = this.db.prepare(
      'DELETE FROM plugin_oauth_credentials WHERE plugin = ?',
    ).run(plugin);
    if (result.changes > 0) {
      logger.info('OAuth credentials deleted', { plugin });
      return true;
    }
    return false;
  }

  /** List plugin names that have credentials configured. */
  list(): string[] {
    const rows = this.db.prepare(
      'SELECT plugin FROM plugin_oauth_credentials ORDER BY plugin',
    ).all() as Array<{ plugin: string }>;
    return rows.map((r) => r.plugin);
  }
}
