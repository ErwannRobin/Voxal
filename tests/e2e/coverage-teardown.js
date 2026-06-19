// Playwright global teardown — merges the per-test V8 coverage cached by
// monocart-coverage-reports and writes the final report. Only registered when
// COVERAGE=1 (see playwright.config.js), so the dependency is never loaded for
// normal test runs.
import { CoverageReport } from 'monocart-coverage-reports';
import { coverageOptions } from './coverage-options.js';

export default async function generateCoverage() {
  await new CoverageReport(coverageOptions).generate();
}
