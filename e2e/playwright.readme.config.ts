import { defineConfig, devices } from '@playwright/test';

// README capture: screenshots and short screen recordings of a running Monize
// instance that holds the built-in demo data. Not part of the test suite -- the
// main `playwright.config.ts` only looks in `./tests`, so these specs never run
// there. See `readme/README.md` for the prerequisites and the two commands.
//
// The browser is the one Playwright installed, unless PLAYWRIGHT_CHROMIUM_EXECUTABLE
// points at another Chromium (a machine where `playwright install` is not an option).
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;

export default defineConfig({
  testDir: './readme',
  forbidOnly: !!process.env.CI,
  // One worker, files in name order: 01 seeds the showcase data, the rest read it.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { outputFolder: 'playwright-readme-report', open: 'never' }]],
  outputDir: 'test-results-readme',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.BASE_URL || 'http://localhost:3001',
    // The UI locale and the clock's zone are pinned so label-based selectors
    // match the base catalog and a date reads the same on every machine.
    locale: 'en',
    timezoneId: 'UTC',
    colorScheme: 'dark',
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    launchOptions: chromiumExecutable ? { executablePath: chromiumExecutable } : {},
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  // No webServer: the stack is started by hand (see readme/README.md).
});
