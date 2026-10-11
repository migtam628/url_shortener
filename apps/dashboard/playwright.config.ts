import { defineConfig, devices } from '@playwright/test';

/**
 * One smoke test, deliberately. Its job is to catch "the dashboard is
 * broken" — a build that does not boot, a login that does not work, a
 * destination edit that does not take. Unit and integration coverage lives
 * where it is cheaper to run.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: process.env['DASHBOARD_URL'] ?? 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
