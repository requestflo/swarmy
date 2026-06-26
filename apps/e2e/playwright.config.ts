import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke tests run against the marketing site (no backend required).
 * To exercise the dashboard end-to-end, point baseURL at :3003 and start
 * `bun dev` (controller + app) with Postgres up.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4000',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Use the environment's pre-installed Chromium when present.
        launchOptions: process.env.PW_CHROMIUM_PATH
          ? { executablePath: process.env.PW_CHROMIUM_PATH }
          : {},
      },
    },
  ],
  webServer: {
    command: 'bun --filter @swarmy/web dev',
    url: 'http://localhost:4000',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
