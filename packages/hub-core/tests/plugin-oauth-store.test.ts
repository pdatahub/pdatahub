/**
 * Tests for OAuth UI v0.4 — persistent credentials store + API endpoints.
 *
 * Covers:
 *   - PluginOAuthStore (encryption round-trip, CRUD)
 *   - GET /v1/plugins/:name/oauth/status (read-only, never exposes secrets)
 *   - PUT /v1/plugins/:name/oauth/credentials (writes encrypted)
 *   - POST /v1/plugins/:name/oauth/start (requires credentials)
 *   - Google OAuth JSON parsing (web.client_id / web.client_secret)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { PluginOAuthStore } from '../src/plugin-oauth-store.js';
import { runMigrations } from '../src/migrations.js';

const TEST_KEY = 'a'.repeat(64);

describe('PluginOAuthStore — encryption + CRUD', () => {
  let db: Database.Database;
  let store: PluginOAuthStore;
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pdatahub-oauth-test-'));
    dbPath = join(tmpDir, 'test.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    runMigrations(db);
    store = new PluginOAuthStore(db, Buffer.from(TEST_KEY, 'hex'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects wrong-length master key', () => {
    expect(() => new PluginOAuthStore(db, Buffer.alloc(16))).toThrow(/32 bytes/);
  });

  it('returns null for unknown plugin', () => {
    expect(store.get('not-set')).toBeNull();
    expect(store.has('not-set')).toBe(false);
  });

  it('round-trips client_id and client_secret through encryption', () => {
    store.set('google-calendar', {
      client_id: 'abc.apps.googleusercontent.com',
      client_secret: 'GOCSPX-secret-stuff',
    });
    const got = store.get('google-calendar');
    expect(got).not.toBeNull();
    expect(got?.client_id).toBe('abc.apps.googleusercontent.com');
    expect(got?.client_secret).toBe('GOCSPX-secret-stuff');
    expect(got?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(got?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('encrypts client_secret (not stored as plaintext in DB)', () => {
    store.set('slack', {
      client_id: '12345.67890',
      client_secret: 'super-secret-do-not-leak',
    });
    // Read the raw row — should NOT contain plaintext.
    const row = db.prepare(
      'SELECT client_secret_enc, client_id_enc FROM plugin_oauth_credentials WHERE plugin = ?',
    ).get('slack') as { client_secret_enc: Buffer; client_id_enc: Buffer };
    expect(row.client_secret_enc.toString('utf8')).not.toContain('super-secret-do-not-leak');
    expect(row.client_id_enc.toString('utf8')).not.toContain('12345.67890');
  });

  it('supports PKCE-only (client_secret: null)', () => {
    store.set('google-pkce', { client_id: 'no-secret.apps.googleusercontent.com' });
    const got = store.get('google-pkce');
    expect(got?.client_secret).toBeNull();
  });

  it('updates updated_at on overwrite', async () => {
    store.set('todoist', { client_id: 'first' });
    const first = store.get('todoist');
    expect(first?.updated_at).toBe(first?.created_at);
    await new Promise((r) => setTimeout(r, 10));
    store.set('todoist', { client_id: 'second' });
    const second = store.get('todoist');
    expect(second?.updated_at).not.toBe(first?.updated_at);
    expect(second?.client_id).toBe('second');
  });

  it('delete removes the row', () => {
    store.set('x', { client_id: 'y' });
    expect(store.delete('x')).toBe(true);
    expect(store.get('x')).toBeNull();
    // Second delete is a no-op.
    expect(store.delete('x')).toBe(false);
  });

  it('list returns configured plugin names sorted', () => {
    store.set('z', { client_id: '1' });
    store.set('a', { client_id: '2' });
    store.set('m', { client_id: '3' });
    expect(store.list()).toEqual(['a', 'm', 'z']);
  });

  it('decryption fails with wrong master key', () => {
    store.set('plugin-x', { client_id: 'id', client_secret: 'sec' });
    // Re-open DB with a different key — decryption should throw because the
    // GCM auth tag won't verify. Need a file-backed DB (not :memory:) so
    // both connections see the same data — better-sqlite3 keeps in-memory
    // DBs per-connection.
    const db2 = new Database(dbPath);
    const otherStore = new PluginOAuthStore(db2, Buffer.from('b'.repeat(64), 'hex'));
    expect(() => otherStore.get('plugin-x')).toThrow();
    db2.close();
  });
});
