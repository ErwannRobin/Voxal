// Shared monocart-coverage-reports options, used by BOTH the per-test collector
// (tests/e2e/fixtures.js) and the global teardown that generates the report
// (tests/e2e/coverage-teardown.js). entryFilter must be applied where .add()
// runs so vendored entries are dropped before they are cached.
export const coverageOptions = {
  name: 'Voxal E2E Coverage',
  outputDir: './coverage',
  // Report only our own application source, not the vendored peerjs bundle.
  entryFilter: (entry) => /\/(main|version)\.js$/.test(entry.url),
  // v8            — the browsable HTML report (coverage/index.html)
  // console-details — the per-file table printed at the end of a local run
  // markdown-summary/v8-json — machine-readable outputs for CI: the first is
  //   dropped straight into the job summary, the second is where the README
  //   badge number is read from. Both are cheap and land next to the HTML.
  reports: ['v8', 'console-details', 'markdown-summary', 'v8-json'],
  lcov: true,
};
