import { defineConfig, devices } from '@playwright/test';

/**
 * UAT harness config. Captures trace/video/screenshot, console + network logs, and
 * emits HTML + JSON reports consumed by scripts/update_excel.py & gen_reports.py.
 *
 * URLs default to the local dev stack and are overridable by env:
 *   CUSTOMER_URL (storefront, :3000) · ADMIN_URL (:3002) · API_URL (:3001/api/v1)
 */
const CUSTOMER_URL = process.env.CUSTOMER_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './tests',
  outputDir: './artifacts/test-output',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'reports/html', open: 'never' }],
    ['json', { outputFile: 'reports/results.json' }],
  ],
  use: {
    baseURL: CUSTOMER_URL,
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // Auth setup mints customer + admin sessions (see fixtures/auth.setup.ts).
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
  ],
});
