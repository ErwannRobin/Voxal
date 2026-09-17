// Where a benchmark run is written.
//
// NDJSON, appended one run at a time, rather than a single object assembled in
// memory and written at the end: a run that crashes at size 8 should not cost
// you the sizes that already succeeded, and appending is safe even if the
// suite is ever run with more than one worker.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cpus, totalmem } from 'node:os';

export const RESULTS_DIR = process.env.BENCH_OUT_DIR || 'bench-results';

// One id per invocation, so every scenario of one `make bench` lands in one
// file. Exported so the report can name the file it read.
export const RUN_ID =
  process.env.BENCH_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

export const RESULTS_FILE = join(RESULTS_DIR, `${RUN_ID}.ndjson`);

/** Machine facts that change the numbers and are not visible in them. */
function environment() {
  return {
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
