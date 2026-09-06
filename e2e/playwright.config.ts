import { defineConfig, devices } from '@playwright/test';
import { E2E_BACKEND_PORT, E2E_FRONTEND_PORT } from './fixtures/global-setup';

/**
 * UAT harness config. Captures trace/video/screenshot, console + network logs, and
 * emits HTML + JSON reports consumed by scripts/update_excel.py & gen_reports.py.
 *
 * ISOLATION IS THE DEFAULT (PAXELBOX-61AG.3.16). Playwright starts its own
 * disposable stack — MySQL 8.4 container, isolated Nest backend with the Google
 * and Paxel transports stubbed, and the real frontend pointed at it. Previously
 * the suite ran against whatever was listening on :3001, which in practice was
 * the shared development database with live providers behind it.
 *
 * To run against a stack you started yourself instead, set:
 *   E2E_EXTERNAL_STACK=1
 * and supply CUSTOMER_URL / ADMIN_URL / API_URL. That path is deliberately
 * opt-in: the unsafe option should require a decision, not the safe one.
 */
const EXTERNAL_STACK = process.env.E2E_EXTERNAL_STACK === '1';

const CUSTOMER_URL = EXTERNAL_STACK
  ? (process.env.CUSTOMER_URL ?? 'http://localhost:3000')
  : `http://localhost:${E2E_FRONTEND_PORT}`;

export default defineConfig({
  testDir: './tests',
  outputDir: './artifacts/test-output',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 7_000 },

  // Owned lifecycle: provision the disposable stack before anything runs, and
  // destroy it afterwards even when the run fails.
  ...(EXTERNAL_STACK
    ? {}
    : {
        globalSetup: require.resolve('./fixtures/global-setup'),
        globalTeardown: require.resolve('./fixtures/global-teardown'),
        // The REAL frontend, pointed at the isolated backend. reuseExistingServer
        // is false on purpose: a stray dev server must never be adopted, because
        // it would be wired to the developer's own backend and database.
        webServer: {
          command: `npx next dev -p ${E2E_FRONTEND_PORT}`,
          cwd: '../frontend',
          url: CUSTOMER_URL,
          reuseExistingServer: false,
          timeout: 180_000,
          stdout: 'ignore',
          stderr: 'pipe',
          env: {
            // Overrides frontend/.env: inline values win over dotenv files, so the
            // browser talks to the isolated backend and nothing else.
            NEXT_PUBLIC_API_URL: `http://localhost:${E2E_BACKEND_PORT}`,
          },
        },
      }),

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
    // Auth setup mints customer + admin sessions (see tests/auth.setup.ts).
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
  ],
});
