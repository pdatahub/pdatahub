/**
 * Playwright config for pdatahub web UI E2E tests.
 *
 * Assumes a running hub-core on http://localhost:8080. Set HUB_E2E_PORT
 * to override. Tests in `tests/e2e/` exercise the SPA against the live
 * API — no mocking.
 *
 * For CI, run in this order:
 *   1. docker run -d -p 8080:8080 -e HUB_RATE_LIMIT_PER_MIN=0 \
 *        --name pdatahub-e2e pdatahub/hub:test-web
 *   2. pnpm --filter @pdatahub/web test:e2e
 *   3. docker rm -f pdatahub-e2e
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = process.env.HUB_E2E_PORT ?? '8080';
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
