// Test fixtures. Re-exports Playwright's `test`/`expect` so every spec imports
// from here, which lets us layer in optional V8 JS-coverage collection without
// touching individual tests.
//
// Coverage is OFF by default (zero overhead). It turns on only when COVERAGE=1
// is set in the environment — see `make coverage-e2e`. When on, each test's
// Chromium V8 coverage is captured and cached by monocart-coverage-reports;
// the report is generated in the global teardown (tests/e2e/coverage-teardown.js).
import { test as base, expect } from '@playwright/test';
import { startCoverage, addCoverage } from './coverage-util.js';

export const test = base.extend({
  // Auto fixture: wraps every test to collect coverage for the default page.
  _coverage: [
    async ({ page }, use) => {
      await startCoverage(page);
      await use();
      await addCoverage(page);
    },
    { auto: true },
  ],
});

export { expect };
