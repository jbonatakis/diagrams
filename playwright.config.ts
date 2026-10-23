import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  use: {
    baseURL: process.env.DIAGRAMS_TEST_URL ?? 'http://127.0.0.1:4180',
    // Uses installed Chrome by default. Set PLAYWRIGHT_CHANNEL=chromium to use a downloaded browser.
    channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: process.env.DIAGRAMS_TEST_URL ? undefined : {
    command: 'go run ./cmd/diagrams',
    url: 'http://127.0.0.1:4180/healthz',
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      GOCACHE: resolve('.cache/go-build'),
      DIAGRAMS_ADDR: '127.0.0.1:4180',
      DIAGRAMS_PUBLIC_URL: 'http://127.0.0.1:4180',
      DIAGRAMS_DB: ':memory:',
    },
  },
});
