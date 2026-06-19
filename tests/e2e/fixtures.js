// Test fixtures. Re-exports Playwright's `test`/`expect` so every spec imports
// from here, which lets us layer in optional V8 JS-coverage collection without
// touching individual tests.
//
// Coverage is OFF by default (zero overhead). It turns on only when COVERAGE=1
// is set in the environment — see `make coverage-e2e`. When on, each test's
// Chromium V8 coverage is captured and cached by monocart-coverage-reports;
// the report is generated in the global teardown (tests/e2e/coverage-teardown.js).
import { test as base, expect } from '@playwright/test';

const COVERAGE = !!process.env.COVERAGE;

export const test = base.extend({
  // Auto fixture: wraps every test to collect coverage when enabled.
  _coverage: [
    async ({ page, browserName }, use) => {
      const collect = COVERAGE && browserName === 'chromium' && !!page.coverage;
      if (collect) {
        // resetOnNavigation:false keeps coverage across the test's page.goto('/').
        await page.coverage.startJSCoverage({ resetOnNavigation: false });
      }

      await use();

      if (collect) {
        const coverage = await page.coverage.stopJSCoverage();
        // Dynamic import so a checkout without the dev dependency can still run
        // the normal (non-coverage) test suite.
        const { CoverageReport } = await import('monocart-coverage-reports');
        const { coverageOptions } = await import('./coverage-options.js');
        await new CoverageReport(coverageOptions).add(coverage);
      }
    },
    { auto: true },
  ],
});

export { expect };
