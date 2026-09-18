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
export const res = (r) =>
  r && r.width && r.height ? `${Math.round(r.width)}×${Math.round(r.height)}` : '—';
export const fps = (n) => (n === null || n === undefined ? '—' : `${Math.round(n)} fps`);
export const secs = (n) => (n === null || n === undefined ? '—' : `${(n / 1000).toFixed(1)} s`);
export const num = (n, d = 1) => (n === null || n === undefined ? '—' : n.toFixed(d));

// ── model ────────────────────────────────────────────────────────────────────

const byRole = (run, speaking) => run.peers.filter((p) => p.speaking === speaking);
const linkValues = (run, key) => run.peers.flatMap((p) => p.links.map((l) => l[key]));

// ── video helpers ────────────────────────────────────────────────────────────

const sharers = (run, kind = 'camera') =>
  run.peers.filter((p) => (kind === 'screen' ? p.sharingScreen : p.sharingCamera));
const watchers = (run, kind = 'camera') =>
  run.peers.filter((p) => !(kind === 'screen' ? p.sharingScreen : p.sharingCamera));

/** What the encoders settled on, across every outgoing link of every sharer. */
function sentPicture(run, kind = 'camera') {
  const sends = run.peers.flatMap((p) => ((kind === 'screen' ? p.screen : p.video) || {}).send || []);
  if (!sends.length) return null;
  return {
    width: median(sends.map((s) => s.width)),
    height: median(sends.map((s) => s.height)),
    fps: median(sends.map((s) => s.fps)),
    // The honest half: `cpu` means the machine ran out, not that the app is
    // thrifty, so it outranks every other reason in the summary.
    limitation: sends.some((s) => s.limitation === 'cpu')
      ? 'cpu'
      : sends.some((s) => s.limitation === 'bandwidth')
        ? 'bandwidth'
        : sends.some((s) => s.limitation && s.limitation !== 'none')
          ? 'other'
          : 'none',
    encoder: sends.find((s) => s.encoder)?.encoder || null,
    links: sends.length,
  };
}

/**
 * Whether the background effect this run asked for was still running at the end
 * of it — counted over the peers that had a camera on, since a peer with no
 * camera trivially has no effect.
 *
 * Two ways it can be false, and the report needs both. The runtime may never
 * have started (no WebGL, missing WASM), or the app's own overload guard may
 * have turned it off mid-run because the machine could not sustain it —
 * `VideoEffects.onOverload` → `applyVideoBackground('off')`, which also clears
 * the stored mode, so the peer's `mode` reads `off` after a drop. Either way
 * the run's CPU figure is not the cost of the effect, and the column says so.
 */
function effectsEngaged(run) {
  const on = sharers(run).map((p) => p.effects).filter(Boolean);
  if (!on.length) return null;
  const requested = run.storage['video-background'] || 'off';
  return {
    sharers: on.length,
    engaged: on.filter((s) => s.engaged).length,
    dropped: requested === 'off' ? 0 : on.filter((s) => !s.engaged && s.mode === 'off').length,
  };
}

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

  // ── video ──────────────────────────────────────────────────────────────────
  //
  // Camera and screen are their own mesh, independent of audio's, so every
  // figure below is the `camera`/`screen` column of the app's own bandwidth
  // sampler — never the totals, which would fold the voice call back in.
  const video = runs
    .filter((r) => r.scenario === 'video-scale')
    .sort((a, b) => a.size - b.size || a.cameras - b.cameras)
    .map((run) => ({
      size: run.size,
      cameras: run.cameras,
      allCameras: run.cameras === run.size,
      sharerUp: median(sharers(run).map((p) => p.usage.out.camera)),
      sharerDown: median(sharers(run).map((p) => p.usage.in.camera)),
      watcherDown: median(watchers(run).map((p) => p.usage.in.camera)),
      // What a peer in this room DOWNLOADS: the watchers' figure when there are
      // watchers, otherwise the sharers' own — in an everybody-on-camera room
      // there is nobody who is only watching, and leaving the column blank
      // would hide the download side of the mesh entirely.
      receiverDown:
        median(watchers(run).map((p) => p.usage.in.camera)) ??
        median(sharers(run).map((p) => p.usage.in.camera)),
      audioUp: median(run.peers.map((p) => p.usage.out.audio)),
      picture: sentPicture(run),
      cpuPercent: run.process.measured ? run.process.cpuPercentOfOneCore : null,
      rssBytes: run.process.measured ? run.process.rssBytes : null,
    }));

  // Only the every-camera runs form the curve, for the same reason the audio
  // curve drops the all-speaking run: one camera in a room of six is a
  // different experiment, not a point on this line.
  const videoCurve = video.filter((r) => r.allCameras);

  const videoBackground = runs
    .filter((r) => r.scenario === 'video-background')
    .map((run) => ({
      mode: run.storage['video-background'] || 'off',
      isDefault: !run.storage['video-background'], // absent = off = the default
      size: run.size,
      cameras: run.cameras,
      effects: effectsEngaged(run),
      sharerUp: median(sharers(run).map((p) => p.usage.out.camera)),
      picture: sentPicture(run),
      cpuPercent: run.process.measured ? run.process.cpuPercentOfOneCore : null,
      rssBytes: run.process.measured ? run.process.rssBytes : null,
      jsHeapBytes: median(run.peers.map((p) => p.jsHeapBytes)),
    }));

  const screen = runs
    .filter((r) => r.scenario === 'screen-share')
    .map((run) => ({
      size: run.size,
      sharerUp: median(sharers(run, 'screen').map((p) => p.usage.out.screen)),
      watcherDown: median(watchers(run, 'screen').map((p) => p.usage.in.screen)),
      picture: sentPicture(run, 'screen'),
      cpuPercent: run.process.measured ? run.process.cpuPercentOfOneCore : null,
      rssBytes: run.process.measured ? run.process.rssBytes : null,
    }));

  const videoJoinRuns = runs.filter((r) => r.scenario === 'video-join-latency');

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
    video,
    videoCurve,
    videoBackground,
    screen,
    videoJoin: videoJoinRuns.map((r) => ({
      size: r.size,
      reps: r.samples.length,
      signalingMs: r.medianSignalingMs,
      audibleMs: r.medianAudibleMs,
      visibleMs: r.medianVisibleMs,
    })),
    // The headline: extra upload a speaker pays for each peer added.
    marginalUploadBps: slope(curve.map((r) => ({ x: r.size, y: r.speakerUp }))),
    // Its video twin, and the bigger number by an order of magnitude — one
    // camera stream per other peer, at twenty times an Opus stream's bitrate.
    marginalVideoUploadBps: slope(videoCurve.map((r) => ({ x: r.size, y: r.sharerUp }))),
    // Whether any video run drove the machine to within a fifth of its total
    // capacity. Reported separately from `qualityLimitationReason`, because the
    // encoder blames its own bitrate cap ("bandwidth") long before it blames
    // the CPU — so a room that collapsed to 4 fps on a saturated host can be
    // labelled `bandwidth` and look like a deliberate trade. This catches that.
    videoSaturatedMachine: !!(
      env.cpus &&
      video.some((r) => r.cpuPercent !== null && r.cpuPercent >= env.cpus * 80)
    ),
    missing: [
      'mesh-scale', 'noise-suppression', 'join-latency', 'host-migration',
      'video-scale', 'video-background', 'screen-share', 'video-join-latency',
    ].filter((s) => !runs.some((r) => r.scenario === s)),
  };
}
