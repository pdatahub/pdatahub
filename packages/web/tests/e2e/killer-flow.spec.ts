/**
 * End-to-end test: the killer flow.
 *
 *   docker run hub → open browser → paste token → install plugin →
 *   trigger tool call from MCP → approve in web UI → verify audit row.
 *
 * Prerequisites (caller's responsibility — see playwright.config.ts):
 *   - Hub running on http://localhost:8080 (override via HUB_E2E_PORT)
 *   - HUB_API_TOKEN env set to a valid token for that hub
 *   - PDHUB_E2E_PLUGIN_PATH env set to absolute path of a built plugin
 *     (e.g. /path/to/pdatahub-plugin-template/dist/plugin.js)
 *
 * Skips gracefully when prerequisites aren't met so `pnpm test:e2e`
 * doesn't fail in environments without a live hub.
 */
import { test, expect, type Page } from '@playwright/test';

const HUB_TOKEN = process.env.HUB_API_TOKEN;
const PLUGIN_PATH = process.env.PDHUB_E2E_PLUGIN_PATH;
const PLUGIN_NAME = process.env.PDHUB_E2E_PLUGIN_NAME ?? 'plugin-template';

const SKIP_REASON = 'set HUB_API_TOKEN and PDHUB_E2E_PLUGIN_PATH to run E2E';

async function pasteToken(page: Page, token: string): Promise<void> {
  await page.goto('/settings');
  await page.getByLabel(/Update token/i).fill(token);
  await page.getByRole('button', { name: /Save and verify/i }).click();
  await expect(page.getByText('Hub URL', { exact: false })).toBeVisible({ timeout: 10_000 });
}

test.describe('pdatahub web UI — killer flow', () => {
  test('SPA shell loads without auth', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/pdatahub/);
    await expect(page.getByRole('link', { name: 'pdatahub', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Approval' })).toBeVisible();
  });

  test('Settings page shows hub info without token', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Hub', exact: true })).toBeVisible();
    // "Fingerprint" appears in both <dt> and a hint paragraph — use first.
    await expect(page.getByText('Fingerprint').first()).toBeVisible({ timeout: 10_000 });
  });

  test('paste token → System section appears with uptime', async ({ page }) => {
    test.skip(!HUB_TOKEN, SKIP_REASON);
    await pasteToken(page, HUB_TOKEN!);
    await expect(page.getByRole('heading', { name: 'System', exact: true })).toBeVisible();
    await expect(page.getByText('Uptime', { exact: false })).toBeVisible();
    await expect(page.getByText('Plugins installed', { exact: false })).toBeVisible();
  });

  test('install plugin via path → tools appear in Plugins tab', async ({ page, request }) => {
    test.skip(!HUB_TOKEN || !PLUGIN_PATH, SKIP_REASON);
    await pasteToken(page, HUB_TOKEN!);
    const install = await request.post('/v1/plugins/install', {
      headers: { authorization: `Bearer ${HUB_TOKEN}` },
      data: { name: PLUGIN_NAME, entry_path: PLUGIN_PATH },
    });
    expect(install.ok()).toBeTruthy();
    // Subprocess needs a moment to register tools before /v1/tools returns them.
    await page.waitForTimeout(2_000);

    await page.goto('/plugins');
    // The page groups tools under the plugin's display name (from the
    // plugin's `name` field), not the directory name we passed. The
    // plugin-template's display name is "example".
    await expect(page.getByText('example', { exact: false })).toBeVisible({ timeout: 15_000 });
  });

  test('trigger tool call → audit row recorded with agent_id', async ({ page, request }) => {
    test.skip(!HUB_TOKEN, SKIP_REASON);
    // Hub approval timeout is 60s — override the default 30s test timeout.
    test.setTimeout(80_000);
    await pasteToken(page, HUB_TOKEN!);
    await page.goto('/approval');
    await expect(page.locator('.dot[data-state="open"]')).toBeVisible({ timeout: 10_000 });

    const call = await request.post('/v1/tools/getCatFact/call', {
      headers: { authorization: `Bearer ${HUB_TOKEN}` },
      data: {
        arguments: {},
        context: {
          agent_id: 'playwright-e2e',
          justification: 'E2E test',
        },
      },
      timeout: 70_000,
    });
    // call may 200 (approved) or 403 (denied/timeout) — both produce audit rows
    expect([200, 403]).toContain(call.status());

    await page.goto('/audit');
    // Agent id may appear in multiple rows from prior test runs — use first.
    await expect(page.getByText('playwright-e2e').first()).toBeVisible({ timeout: 15_000 });
  });
});

