// V8 JS-coverage helpers shared by the base auto fixture (single page) and the
// mesh peer factory (many pages). No-ops unless COVERAGE=1 and the page is
// Chromium (page.coverage is Chromium-only). The dependency is imported lazily
// so a checkout without it can still run the normal suite.
const COVERAGE = !!process.env.COVERAGE;

export async function startCoverage(page) {
  if (!COVERAGE || !page.coverage) return;
  // resetOnNavigation:false keeps coverage across the test's page.goto('/').
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
}

export async function addCoverage(page) {
  if (!COVERAGE || !page.coverage) return;
  let coverage;
  try {
    coverage = await page.coverage.stopJSCoverage();
  } catch {
    return; // page already closed
  }
  const { CoverageReport } = await import('monocart-coverage-reports');
  const { coverageOptions } = await import('./coverage-options.js');
  await new CoverageReport(coverageOptions).add(coverage);
}
