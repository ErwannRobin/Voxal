import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:8080',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npx --yes serve src -l 8080',
    url: 'http://127.0.0.1:8080',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});

