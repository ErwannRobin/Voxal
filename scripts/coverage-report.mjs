#!/usr/bin/env node
//
// Turn the three coverage runs into one human-readable report, and (with
// --write-badge) into the number on the README badge.
//
//   node scripts/coverage-report.mjs                  # markdown to stdout
//   node scripts/coverage-report.mjs --write-badge    # also rewrite the badge
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
// The headline number — the one on the badge — is main.js's *line* coverage as
// monocart reports it: the `main.js` row of the table `make coverage-e2e`
// prints. (The Summary row differs by a hair, because it also counts the
// four-line version.js.) Any other denominator would make the badge disagree
// with what a contributor sees locally, which is worse than no badge.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const FRONTEND_JSON = path.join(ROOT, 'coverage/coverage-report.json');
const FRONTEND_MD = path.join(ROOT, 'coverage/coverage-summary.md');
const API_LCOV = path.join(ROOT, 'coverage-api/lcov.info');
const RUST_LCOV = path.join(ROOT, 'src-tauri/target/llvm-cov/lcov.info');
const README = path.join(ROOT, 'README.md');

const BADGE_START = '<!-- coverage-badge -->';
const BADGE_END = '<!-- /coverage-badge -->';

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

/** The colour shields.io should use, on the same scale the HTML report uses. */
function badgeColor(pct) {
  if (pct >= 90) return 'brightgreen';
  if (pct >= 80) return 'green';
  if (pct >= 70) return 'yellowgreen';
  if (pct >= 60) return 'yellow';
  if (pct >= 50) return 'orange';
  return 'red';
}

function badgeMarkdown(pct) {
  const label = encodeURIComponent('main.js coverage');
  const value = encodeURIComponent(`${pct.toFixed(1)}%`);
  const url = `https://img.shields.io/badge/${label}-${value}-${badgeColor(pct)}`;
  return `[![main.js coverage](${url})](https://github.com/ErwannRobin/Voxal/actions/workflows/tests.yml)`;
}

/**
 * Rewrite the badge between its markers. Returns 'updated' | 'unchanged' |
 * 'no-markers' so the caller can skip a commit that would change nothing.
 */
function writeBadge(pct) {
  const readme = fs.readFileSync(README, 'utf8');
  const start = readme.indexOf(BADGE_START);
  const end = readme.indexOf(BADGE_END);
  if (start === -1 || end === -1 || end < start) return 'no-markers';

  const before = readme.slice(0, start + BADGE_START.length);
  const after = readme.slice(end);
  const next = `${before}\n${badgeMarkdown(pct)}\n${after}`;
  if (next === readme) return 'unchanged';
  fs.writeFileSync(README, next);
  return 'updated';
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
    `Badge figure: **${front.lines.pct} %** — the \`main.js\` line coverage, the ` +
      'same figure the `main.js` row of `make coverage-e2e` prints locally.',
    ''
  );
}

process.stdout.write(`${lines.join('\n')}\n`);

// ── Badge ────────────────────────────────────────────────────────────────────

if (process.argv.includes('--write-badge')) {
  if (!front) {
    process.stderr.write('coverage-report: no frontend report, leaving the badge alone\n');
    process.exit(0);
  }
  const result = writeBadge(front.lines.pct);
  process.stderr.write(`coverage-report: badge ${result} (${front.lines.pct} %)\n`);
  // Surface the outcome so a workflow can skip an empty commit.
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `badge=${result}\npct=${front.lines.pct}\n`);
  }
}
