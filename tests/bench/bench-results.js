// Where a benchmark run is written.
//
// NDJSON, appended one run at a time, rather than a single object assembled in
// memory and written at the end: a run that crashes at size 8 should not cost
// you the sizes that already succeeded, and appending is safe even if the
// suite is ever run with more than one worker.
import { appendFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { cpus, totalmem } from 'node:os';
import { appVersionFromSource } from './app-metrics.js';

export const RESULTS_DIR = process.env.BENCH_OUT_DIR || 'bench-results';

// One id per invocation, so every scenario of one `make bench` lands in one
// file. Exported so the report can name the file it read.
export const RUN_ID =
  process.env.BENCH_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

export const RESULTS_FILE = join(RESULTS_DIR, `${RUN_ID}.ndjson`);

/**
 * Which build was measured.
 *
 * Without this a run is a set of numbers with nothing to compare them to. The
 * version is what the history file is keyed on (docs/bench-history.ndjson) and
 * the commit is what makes a regression findable — a version string only moves
 * on a release, so two runs weeks apart can share one.
 *
 * `dirty` is not a detail: a run measured on an uncommitted tree cannot be
 * reproduced from the commit beside it, and the report says so rather than
 * letting the reader assume otherwise.
 */
let _build = null;
function build() {
  // Memoized: `environment()` runs once per recorded scenario, and shelling out
  // to git twenty times to read a value that cannot change mid-run is waste.
  if (_build) return _build;
  const git = (args, fallback = null) => {
    try {
      return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return fallback; // not a checkout, or no git — a fact, not a failure
    }
  };
  const status = git(['status', '--porcelain'], null);
  _build = {
    ...appVersionFromSource(),
    commit: git(['rev-parse', '--short', 'HEAD']),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirty: status === null ? null : status.length > 0,
  };
  return _build;
}

/** Machine facts that change the numbers and are not visible in them. */
function environment() {
  return {
    build: build(),
    platform: process.platform,
    arch: process.arch,
    cpus: cpus().length,
    cpuModel: cpus()[0]?.model || null,
    totalMemBytes: totalmem(),
    node: process.version,
    // Free-form: set BENCH_LABEL to record the network conditions a run was
    // shaped to (see docs/benchmarking.md). Shaping is done outside the
    // harness — it needs root — so the label is the only record that a run was
    // not on an unshaped loopback.
    label: process.env.BENCH_LABEL || 'unshaped-loopback',
  };
}

export function recordRun(scenario, run) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  appendFileSync(
    RESULTS_FILE,
    JSON.stringify({ scenario, at: new Date().toISOString(), env: environment(), ...run }) + '\n'
  );
}
