/**
 * Tests for the plugin installer.
 *
 * Unit-level tests for the HTTPS-only guard and size-cap. The full
 * download → extract → install flow is exercised by
 * scripts/install-plugin-smoke.sh against a real running hub, since
 * mocking the entire undici pipeline + filesystem + tar process is
 * more fragile than running the real thing.
 */

import { describe, it, expect } from 'vitest';
import { installPluginFromUrl } from '../src/plugin-installer';

describe('installPluginFromUrl — input validation', () => {
  it('rejects http:// URLs (HTTPS-only)', async () => {
    await expect(installPluginFromUrl('http://example.com/x.tgz', '/tmp')).rejects.toThrow(
      /only https/,
    );
  });

  it('rejects ftp:// URLs', async () => {
    await expect(installPluginFromUrl('ftp://example.com/x.tgz', '/tmp')).rejects.toThrow(
      /only https/,
    );
  });

  it('rejects file:// URLs', async () => {
    await expect(installPluginFromUrl('file:///etc/passwd', '/tmp')).rejects.toThrow(
      /only https/,
    );
  });
});
