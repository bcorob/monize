import { defineConfig, devices } from '@playwright/test';

// Browser/worker integration only: no database, application build or external push service.
export default defineConfig({
  testDir: './push',
  forbidOnly: !!process.env.CI,
  workers: 1,
  retries: 0,
  timeout: 30000,
  reporter: [['list'], ['html', { outputFolder: 'playwright-push-report', open: 'never' }]],
  outputDir: 'test-results-push',
  // `channel: 'chromium'` launches the full browser. Without it Playwright runs
  // `chrome-headless-shell` for a headless chromium, and the shell implements no
  // Notifications API: `registration.showNotification()` resolves, nothing is
  // shown, and `getNotifications()` answers []. Every test here begins by
  // waiting for a notification, so all nine timed out on the same line while the
  // worker was behaving correctly -- the suite could not have caught a real
  // defect in the code it exists to test.
  use: {
    ...devices['Desktop Chrome'],
    channel: 'chromium',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
