#!/usr/bin/env node
//
// Turn the three coverage runs into one human-readable report.
//
//   node scripts/coverage-report.mjs                  # markdown to stdout
//
// Each source is optional: a run that did not happen is reported as skipped
// rather than failing the script, so the CI job can degrade to whatever it
// managed to produce (the Rust leg, in particular, is the slow one).
//
//   frontend  coverage/coverage-report.json   monocart, from the E2E run
//   api       coverage-api/lcov.info          node --test --experimental-test-coverage
//   rust      src-tauri/target/llvm-cov/lcov.info
//
// The API report deliberately lands in its own directory: monocart CLEARS
// `coverage/` when it generates, so anything else written there is destroyed by
// the next E2E run.
//
// The headline number is main.js's *line* coverage as monocart reports it: the
// `main.js` row of the table `make coverage-e2e` prints. (The Summary row
// differs by a hair, because it also counts the four-line version.js.) Any
// other denominator would make this report disagree with what a contributor
// sees locally.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const FRONTEND_JSON = path.join(ROOT, 'coverage/coverage-report.json');
const FRONTEND_MD = path.join(ROOT, 'coverage/coverage-summary.md');
const API_LCOV = path.join(ROOT, 'coverage-api/lcov.info');
const RUST_LCOV = path.join(ROOT, 'src-tauri/target/llvm-cov/lcov.info');

/** Line coverage across every file in an lcov report, as a percentage. */
function lcovLinePct(file) {
  if (!fs.existsSync(file)) return null;
  let found = 0;
  let hit = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    // LF/LH are the per-file totals lcov already computed; summing them avoids
    // double-counting a line listed under two records.
    if (line.startsWith('LF:')) found += Number(line.slice(3)) || 0;
    else if (line.startsWith('LH:')) hit += Number(line.slice(3)) || 0;
  }
  if (!found) return null;
  return { pct: round2((hit / found) * 100), covered: hit, total: found };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** main.js's own summary out of the monocart report. */
function frontendSummary() {
  if (!fs.existsSync(FRONTEND_JSON)) return null;
  let report;
  try {
    report = JSON.parse(fs.readFileSync(FRONTEND_JSON, 'utf8'));
  } catch {
    return null;
  }
  const main = (report.files || []).find((f) => String(f.sourcePath || '').endsWith('main.js'));
  if (!main || !main.summary) return null;
  return main.summary;
}

// ── Report ───────────────────────────────────────────────────────────────────

const front = frontendSummary();
const api = lcovLinePct(API_LCOV);
const rust = lcovLinePct(RUST_LCOV);

const lines = ['## Coverage', ''];

if (front) {
  lines.push(
    '### Frontend (`src/main.js`)',
    '',
    fs.existsSync(FRONTEND_MD)
      // The reporter writes its own H2 title; drop it so this nests correctly.
      ? fs.readFileSync(FRONTEND_MD, 'utf8').trim().split('\n').filter((l) => !l.startsWith('## ')).join('\n')
      : `Lines ${front.lines.pct} %`,
    ''
  );
} else {
  lines.push('### Frontend (`src/main.js`)', '', '_Not measured in this run._', '');
}

lines.push('### Other suites', '', '| Suite | Line coverage | Covered / total |', '| :--- | ---: | ---: |');
lines.push(
  api
    ? `| API handlers (\`api/\`) | ${api.pct} % | ${api.covered} / ${api.total} |`
    : '| API handlers (`api/`) | — | _not measured_ |'
);
lines.push(
  rust
    ? `| Rust (\`src-tauri/\`) | ${rust.pct} % | ${rust.covered} / ${rust.total} |`
    : '| Rust (`src-tauri/`) | — | _not measured_ |'
);
lines.push('');

if (front) {
  lines.push(
    `Headline figure: **${front.lines.pct} %** — the \`main.js\` line coverage, the ` +
      'same figure the `main.js` row of `make coverage-e2e` prints locally.',
    ''
  );
}

process.stdout.write(`${lines.join('\n')}\n`);
