/**
 * Demo video recorder — Playwright screencast of the full killer flow.
 *
 * Prerequisites:
 *   1. Hub running on http://localhost:8080 with identity initialized
 *      (run: docker run -d -p 8080:8080 -e HUB_RATE_LIMIT_PER_MIN=0 \
 *            -v /path/to/pdatahub-plugin-template:/plugins/plugin-template:ro \
 *            --name pdatahub-demo pdatahub/hub:test-web)
 *   2. Hub identity initialized (run: docker exec pdatahub-demo \
 *      node /app/dist/index.js init --hub-name demo --db-path /data/pdatahub-hub.db \
 *      --master-key $(docker exec pdatahub-demo cat /data/.env | grep HUB_MASTER_KEY | cut -d= -f2-))
 *   3. Env vars set:
 *      - HUB_API_TOKEN: valid token from `docker logs pdatahub-demo | grep 'API TOKEN' -A 1`
 *      - PDHUB_PLUGIN_PATH: path to a built plugin (e.g. /plugins/plugin-template/dist/plugin.js)
 *      - VIDEO_DIR: output directory (default: ./demo-videos)
 *
 * Output: webm video at $VIDEO_DIR/<timestamp>.webm (typically 30-60 seconds)
 *
 * Usage:
 *   pnpm exec tsx packages/web/scripts/record-demo.ts
 */
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const HUB_URL = process.env.HUB_E2E_URL ?? 'http://127.0.0.1:8080';
const TOKEN = process.env.HUB_API_TOKEN;
const PLUGIN_PATH = process.env.PDHUB_PLUGIN_PATH;
const VIDEO_DIR = process.env.VIDEO_DIR ?? join(process.cwd(), 'demo-videos');

if (!TOKEN || !PLUGIN_PATH) {
  console.error('ERROR: set HUB_API_TOKEN and PDHUB_PLUGIN_PATH');
  process.exit(1);
}

if (!existsSync(VIDEO_DIR)) mkdirSync(VIDEO_DIR, { recursive: true });

async function step(page: Page, label: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n=== ${label} ===`);
  await fn();
  await page.waitForTimeout(800); // pause for viewer comprehension
}

async function main(): Promise<void> {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 800 } },
    });
    const page = await context.newPage();

    await step(page, '1. Open pdatahub web UI (no auth required)', async () => {
      await page.goto(HUB_URL);
      await page.waitForSelector('text=Dashboard');
    });

    await step(page, '2. Settings → hub identity (public, no token)', async () => {
      await page.goto(`${HUB_URL}/settings`);
      await page.waitForSelector('text=Fingerprint', { timeout: 10_000 });
    });

    await step(page, '3. Paste API token → System section appears', async () => {
      await page.getByLabel(/Update token/i).fill(TOKEN!);
      await page.getByRole('button', { name: /Save and verify/i }).click();
      await page.waitForSelector('text=Uptime', { timeout: 10_000 });
    });

    await step(page, '4. Plugins → install via path', async () => {
      await page.goto(`${HUB_URL}/plugins`);
      // Trigger install via API (the form is for URL installs).
      const res = await page.request.post(`${HUB_URL}/v1/plugins/install`, {
        headers: { authorization: `Bearer ${TOKEN}` },
        data: { name: 'plugin-template', entry_path: PLUGIN_PATH },
      });
      if (!res.ok()) throw new Error(`install failed: ${res.status()} ${await res.text()}`);
      await page.waitForTimeout(2_000); // subprocess startup
      await page.reload();
      await page.waitForSelector('text=Installed', { timeout: 10_000 });
    });

    await step(page, '5. Approval tab → WS connects', async () => {
      await page.goto(`${HUB_URL}/approval`);
      await page.waitForSelector('.dot[data-state="open"]', { timeout: 10_000 });
    });

    await step(page, '6. Trigger tool call (from MCP side)', async () => {
      void page.request.post(`${HUB_URL}/v1/tools/getCatFact/call`, {
        headers: { authorization: `Bearer ${TOKEN}` },
        data: {
          arguments: {},
          context: { agent_id: 'demo-agent', justification: 'demo recording' },
        },
        timeout: 70_000,
      });
    });

    await step(page, '7. Click Allow in the web UI', async () => {
      await page.waitForSelector('button:has-text("Allow")', { timeout: 65_000 });
      await page.click('button:has-text("Allow")');
      await page.waitForTimeout(1_000); // let audit row flush
    });

    await step(page, '8. Audit tab → row visible', async () => {
      await page.goto(`${HUB_URL}/audit`);
      await page.waitForSelector('text=demo-agent', { timeout: 10_000 });
    });

    await step(page, '9. Close — video saved', async () => {
      // Brief pause so the final frame is captured cleanly.
      await page.waitForTimeout(1_500);
    });
  } finally {
    // Closing the context flushes the video to disk.
    if (context) await context.close();
    if (browser) await browser.close();
  }

  console.log(`\n✓ Video saved to ${VIDEO_DIR}`);
  console.log('Convert to MP4 with:');
  console.log(`  ffmpeg -i ${VIDEO_DIR}/*.webm -c:v libx264 -crf 23 demo.mp4`);
}

main().catch((err) => {
  console.error('demo recording failed:', err);
  process.exit(1);
});
