// Turn a benchmark run's NDJSON into the one model both renderers read.
//
// The markdown report and the HTML dashboard must never disagree about a
// number, so neither of them computes one: this module does it once and hands
// the same object to both.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const RESULTS_DIR = process.env.BENCH_OUT_DIR || 'bench-results';

export function newestRunFile() {
  if (!existsSync(RESULTS_DIR)) return null;
  const files = readdirSync(RESULTS_DIR).filter((f) => f.endsWith('.ndjson')).sort();
  return files.length ? join(RESULTS_DIR, files[files.length - 1]) : null;
}

export function loadRuns(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch {
        console.error(`! skipping unparseable line ${i + 1} of ${file}`);
        return null;
      }
    })
    .filter(Boolean);
}

// ── statistics ───────────────────────────────────────────────────────────────

export function median(values) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/**
 * Least-squares slope of y against x — the marginal cost of one more peer.
 *
 * Reported as the headline because it is the number a room-size decision turns
 * on, and because a slope over the whole sweep is harder to cherry-pick than a
 * ratio between two chosen sizes. Needs at least two distinct x values; returns
 * null rather than a fabricated figure when the sweep was a single size.
 */
export function slope(points) {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 2) return null;
  const n = pts.length;
  const sumX = pts.reduce((s, p) => s + p.x, 0);
  const sumY = pts.reduce((s, p) => s + p.y, 0);
  const sumXY = pts.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = pts.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  return (n * sumXY - sumX * sumY) / denom;
}

// ── formatting ───────────────────────────────────────────────────────────────

export const bits = (bps) => {
  if (bps === null || bps === undefined) return '—';
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(2)} Mb/s`;
  if (bps >= 1000) return `${Math.round(bps / 1000)} kb/s`;
  return `${Math.round(bps)} b/s`;
};
export const mib = (b) => (b === null || b === undefined ? '—' : `${(b / 1048576).toFixed(0)} MiB`);
export const pct = (n) => (n === null || n === undefined ? '—' : `${n.toFixed(0)}%`);
export const ms = (n) => (n === null || n === undefined ? '—' : `${Math.round(n)} ms`);
export const secs = (n) => (n === null || n === undefined ? '—' : `${(n / 1000).toFixed(1)} s`);
export const num = (n, d = 1) => (n === null || n === undefined ? '—' : n.toFixed(d));

// ── model ────────────────────────────────────────────────────────────────────

const byRole = (run, speaking) => run.peers.filter((p) => p.speaking === speaking);
const linkValues = (run, key) => run.peers.flatMap((p) => p.links.map((l) => l[key]));

export function buildModel(runs, file) {
  const env = runs[0]?.env || {};

  const scale = runs
    .filter((r) => r.scenario === 'mesh-scale')
    .sort((a, b) => a.size - b.size || a.speakers - b.speakers)
    .map((run) => ({
      size: run.size,
      speakers: run.speakers,
      allSpeaking: run.speakers === run.size && run.size > 1,
      speakerUp: median(byRole(run, true).map((p) => p.usage.outTotal)),
      listenerUp: median(byRole(run, false).map((p) => p.usage.outTotal)),
      listenerDown: median(byRole(run, false).map((p) => p.usage.inTotal)),
      rttMs: median(linkValues(run, 'rttMs')),
      lossPercent: median(linkValues(run, 'lossPercent')),
      cpuPercent: run.process.measured ? run.process.cpuPercentOfOneCore : null,
      rssBytes: run.process.measured ? run.process.rssBytes : null,
    }));

  // Only the one-speaker runs form the scaling curve: an all-speaking run is a
  // different experiment and putting it on the same line would imply a trend
  // that does not exist between the two points.
  const curve = scale.filter((r) => !r.allSpeaking);

  const ns = runs
    .filter((r) => r.scenario === 'noise-suppression')
    .map((run) => ({
      mode: run.storage['noise-suppression'],
      isDefault: run.storage['noise-suppression'] === 'rnnoise', // the desktop default
      size: run.size,
      speakerUp: median(byRole(run, true).map((p) => p.usage.outTotal)),
      cpuPercent: run.process.measured ? run.process.cpuPercentOfOneCore : null,
      rssBytes: run.process.measured ? run.process.rssBytes : null,
      jsHeapBytes: median(run.peers.map((p) => p.jsHeapBytes)),
    }));

  const joinRuns = runs.filter((r) => r.scenario === 'join-latency');
  const migrationRuns = runs.filter((r) => r.scenario === 'host-migration');

  return {
    file,
    env,
    at: runs[0]?.at || null,
    runCount: runs.length,
    scale,
    curve,
    ns,
    join: joinRuns.map((r) => ({
      size: r.size,
      reps: r.samples.length,
      signalingMs: r.medianSignalingMs,
      audibleMs: r.medianAudibleMs,
    })),
    migration: migrationRuns.map((r) => ({
      size: r.size,
      survivors: r.survivors,
      hostElectedMs: r.hostElectedMs,
      audioRestoredMs: r.audioRestoredMs,
    })),
    // The headline: extra upload a speaker pays for each peer added.
    marginalUploadBps: slope(curve.map((r) => ({ x: r.size, y: r.speakerUp }))),
    missing: ['mesh-scale', 'noise-suppression', 'join-latency', 'host-migration'].filter(
      (s) => !runs.some((r) => r.scenario === s)
    ),
  };
}
