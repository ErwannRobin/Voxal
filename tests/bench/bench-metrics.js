// Measurement helpers for the benchmark harness.
//
// Split from the spec so the spec reads as scenarios and this file holds the
// "how do we get an honest number" decisions — most of which are decisions
// about what NOT to trust.
//
// Everything read out of the page comes from the shipped code path
// (`networkUsageSnapshot()`, `conn.webrtcStats`), never a test-only sampler. A
// benchmark that measures its own instrumentation measures nothing.
import { execFileSync } from 'node:child_process';

// ── Aggregation ──────────────────────────────────────────────────────────────

export function median(values) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

export function percentile(values, p) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const idx = Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1));
  return xs[idx];
}

export function mean(values) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

// ── In-page snapshot ─────────────────────────────────────────────────────────

/**
 * Everything one peer knows about its own call, read from the app's own state.
 *
 * `usage` is the whole rolling history rather than the current sample: a single
 * 5s tick lands wherever it lands, and the interesting number is the steady
 * state across the hold window. The caller trims and reduces it.
 */
export function peerSnapshot(page) {
  return page.evaluate(() => {
    const links = [];
    connections.forEach((conn, id) => {
      const s = conn.webrtcStats || {};
      links.push({
        peerId: id,
        rttMs: typeof s.rttMs === 'number' ? s.rttMs : null,
        jitterMs: typeof s.jitterMs === 'number' ? s.jitterMs : null,
        lossPercent: typeof s.lossPercent === 'number' ? s.lossPercent : null,
        outLossPercent: typeof s.outLossPercent === 'number' ? s.outLossPercent : null,
        peakLossPercent: typeof s.peakLossPercent === 'number' ? s.peakLossPercent : null,
        iceType: s.iceType || null,
        playoutDelayMs: typeof s.playoutDelayMs === 'number' ? s.playoutDelayMs : null,
        // The mesh's real cost: how many peer connections this ONE peer holds
        // open for this ONE other peer, per kind.
        audioPcs: audioPeerConnections(conn).length,
        videoPcs: videoPeerConnections(conn).length,
        screenPcs: screenPeerConnections(conn).length,
      });
    });

    return {
      peerId: peer ? peer.id : null,
      isHost: !!isHost,
      inRoom: !!inRoom,
      peers: connections.size,
      links,
      usage: networkUsageSnapshot(),
      // Chromium-only, and the JS heap is not the process RSS — the real memory
      // number comes from the process tree on the Node side. Kept because the
      // JS heap is the part this app's own code is responsible for.
      jsHeapBytes: performance.memory ? performance.memory.usedJSHeapSize : null,
      audioElements: document.querySelectorAll('audio[id^="audio-"]').length,
    };
  });
}

/** How many remote peers this one can actually hear right now. */
export function audibleCount(page) {
  return page.evaluate(
    () =>
      Array.from(document.querySelectorAll('audio[id^="audio-"]')).filter(
        (el) => el.srcObject && el.srcObject.getAudioTracks().some((t) => t.readyState === 'live')
      ).length
  );
}

/**
 * Reduce one peer's usage history to steady-state bits/second.
 *
 * Two samples are deliberately thrown away. The first sample inside the window
 * covers a 5s delta that STARTED before the window did, so it is contaminated
 * by whatever the room was doing while peers were still arriving. And any
 * sample at all is dropped if it has no baseline — `_pcByteDelta()` returns
 * null the first time it sees a peer connection rather than counting that
 * connection's lifetime bytes as one tick's traffic.
 *
 * Median, not mean: a peer joining mid-window puts a step in the series, and
 * one step should not move the reported steady state.
 */
export function reduceUsage(usage, windowStartMs) {
  const kinds = ['audio', 'camera', 'screen'];
  const inWindow = (usage?.history || []).filter((s) => s.at >= windowStartMs);
  const samples = inWindow.slice(1); // drop the straddling first delta

  const out = { samples: samples.length, in: {}, out: {} };
  for (const dir of ['in', 'out']) {
    for (const kind of kinds) {
      out[dir][kind] = median(samples.map((s) => s[dir][kind])) ?? 0;
    }
    out[`${dir}Total`] = median(
      samples.map((s) => kinds.reduce((sum, k) => sum + (s[dir][k] || 0), 0))
    ) ?? 0;
  }
  return out;
}

// ── Process cost (Node side) ─────────────────────────────────────────────────
//
// Per-process CPU is not exposed to any browser or WebView — there is no API
// (KNOWLEDGE/learning.md). So it is measured from outside, on the Chromium
// process tree, exactly the way the app's own Tauri `get_device_stats` command
// has to do it natively.
//
// IMPORTANT, and stated in the report: one Chromium serves every peer context,
// so this is the cost of running all N peers on one machine. It is NOT per-peer
// and must never be divided by N and presented as one. What it is good for is
// the SHAPE of the curve as N grows, and comparing two configurations at the
// same N (RNNoise on vs off, camera on vs off).

/** `[[DD-]HH:]MM:SS[.ss]` — the `ps` TIME column, on both Linux and macOS. */
function parseCpuTime(text) {
  const raw = String(text).trim();
  if (!raw) return null;
  const [days, rest] = raw.includes('-') ? raw.split('-') : ['0', raw];
  const parts = rest.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  const [h, m, s] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  return Number(days) * 86400 + h * 3600 + m * 60 + s;
}

// macOS `ps` reads `-e` as "show the environment too", not "every process", so
// the selector differs by platform. BSD-style `-axo` is accepted by Linux procps
// as well, which makes it the fallback rather than a second special case.
// macOS `ps` reads `-e` as "show the environment too", not "every process", so
// the selector differs by platform. BSD-style `-axo` is accepted by Linux procps
// as well, which makes it the fallback rather than a second special case.
const PS_COLUMNS = 'pid=,ppid=,rss=,time=,args=';
const PS_ARGS = process.platform === 'darwin'
  ? [['-axo', PS_COLUMNS]]
  : [['-eo', PS_COLUMNS], ['-axo', PS_COLUMNS]];

function psTable() {
  let text = null;
  for (const args of PS_ARGS) {
    try {
      text = execFileSync('ps', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      break;
    } catch {
      text = null; // try the next selector
    }
  }
  // No usable ps: report nulls rather than guessing. A benchmark that invents a
  // number it could not measure is worse than one that admits the gap.
  if (!text) return null;

  const rows = new Map();
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    rows.set(Number(m[1]), {
      ppid: Number(m[2]),
      rssBytes: Number(m[3]) * 1024, // ps reports KiB on both platforms
      cpuSeconds: parseCpuTime(m[4]),
      args: m[5],
    });
  }
  return rows;
}

// Playwright always launches with a pipe-based DevTools transport, which no
// other Chromium on the machine is likely to be using — that is what keeps a
// developer's own open browser out of the measurement.
const BROWSER_RE = /(chrome|chromium|headless_shell)/i;
const PLAYWRIGHT_RE = /--remote-debugging-(pipe|port)/;

function descendantsOf(rows, rootPid) {
  const children = new Map();
  for (const [pid, row] of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(pid);
  }
  const seen = new Set();
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of children.get(pid) || []) stack.push(child);
  }
  seen.delete(rootPid);
  return seen;
}

/**
 * Cumulative CPU seconds and current RSS for the Chromium processes this test
 * run owns — all of them, since one browser is several OS processes (the app,
 * the renderer per context, the GPU/media process and the network process).
 *
 * Found by walking this Node process's own descendants rather than by asking
 * Playwright: `browser.process()` is not exposed on the test runner's `browser`
 * fixture. Node, the static file server and the PeerServer broker are excluded
 * on purpose — the broker stands in for a remote signaling server, so its cost
 * is not the client's.
 *
 * CPU is taken as cumulative time, sampled twice and differenced by the caller,
 * never as `ps %cpu` — that column is an average over the process's whole
 * lifetime, so on a browser that has been up for two minutes it would report
 * roughly nothing no matter how hard the measured window worked it.
 */
export function sampleProcessTree(rootPid = process.pid) {
  const rows = psTable();
  const empty = { at: Date.now(), ok: false, processes: 0, rssBytes: null, cpuSeconds: null };
  if (!rows) return empty;

  let pids = [...descendantsOf(rows, rootPid)].filter((pid) => BROWSER_RE.test(rows.get(pid).args));
  // Fallback for a browser that is not our descendant (a reused server, a
  // future change to how the fixtures launch it).
  if (!pids.length) {
    pids = [...rows.keys()].filter(
      (pid) => BROWSER_RE.test(rows.get(pid).args) && PLAYWRIGHT_RE.test(rows.get(pid).args)
    );
  }
  if (!pids.length) return empty;

  let rssBytes = 0;
  let cpuSeconds = 0;
  let missingCpu = false;
  for (const pid of pids) {
    const row = rows.get(pid);
    rssBytes += row.rssBytes;
    if (row.cpuSeconds === null) missingCpu = true;
    else cpuSeconds += row.cpuSeconds;
  }

  return {
    at: Date.now(),
    ok: true,
    processes: pids.length,
    rssBytes,
    cpuSeconds: missingCpu ? null : cpuSeconds,
  };
}

/**
 * Average CPU across the window, as a percentage of ONE core. Above 100 means
 * genuine parallelism across the browser's processes, not an error — which is
 * why it is not clamped and why the report prints the core count beside it.
 */
export function cpuPercentBetween(before, after) {
  if (!before?.ok || !after?.ok) return null;
  if (before.cpuSeconds === null || after.cpuSeconds === null) return null;
  const elapsed = (after.at - before.at) / 1000;
  if (elapsed <= 0) return null;
  return ((after.cpuSeconds - before.cpuSeconds) / elapsed) * 100;
}
