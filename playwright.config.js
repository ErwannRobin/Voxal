import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  // V8 JS-coverage report (opt-in via COVERAGE=1 — see `make coverage-e2e`).
  globalTeardown: process.env.COVERAGE ? './tests/e2e/coverage-teardown.js' : undefined,
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
  projects: [
    // Fast, deterministic suite (pure-logic unit tests + UI flows). Excludes the
    // multi-peer mesh tests so it stays quick and flake-free.
    {
      name: 'unit',
      grepInvert: /@mesh/,
    },
    // Multi-peer mesh tests: real PeerJS + WebRTC between isolated Chromium
    // contexts. Needs fake media and loopback host ICE candidates. Allowed to
    // retry since real WebRTC negotiation can be momentarily slow.
    {
      name: 'mesh',
      grep: /@mesh/,
      retries: 2,
      // Headroom for heartbeat-timeout host-loss detection (~7s) plus connect
      // retries, including tests that chain two sequential migrations.
      timeout: 90_000,
      use: {
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
            // Use real loopback host candidates instead of mDNS-hidden ones, so
            // peer-to-peer ICE actually connects under automation.
            '--disable-features=WebRtcHideLocalIpsWithMdns',
          ],
        },
      },
    },
  ],
});
