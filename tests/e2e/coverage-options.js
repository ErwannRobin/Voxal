// Shared monocart-coverage-reports options, used by BOTH the per-test collector
// (tests/e2e/fixtures.js) and the global teardown that generates the report
// (tests/e2e/coverage-teardown.js). entryFilter must be applied where .add()
// runs so vendored entries are dropped before they are cached.
export const coverageOptions = {
  name: 'Voxal E2E Coverage',
  outputDir: './coverage',
  // Report only our own application source, not the vendored peerjs bundle.
  entryFilter: (entry) => /\/(main|version)\.js$/.test(entry.url),
  reports: ['v8', 'console-details'],
  lcov: true,
};
