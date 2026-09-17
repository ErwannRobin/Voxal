// Room construction and the shape of one benchmark run.
//
// Built on the mesh fixtures rather than beside them: the benchmark has to
// drive the SAME createRoom/joinRoom/setTalking path the mesh tests do, or it
// is measuring a second implementation. Only the measurement is new here.
import { createRoom, joinRoom, getState } from '../e2e/mesh-helpers.js';
import { peerSnapshot, audibleCount, reduceUsage, sampleProcessTree, cpuPercentBetween } from './bench-metrics.js';

/**
 * Settings every benchmark peer starts with, before the scenario's own.
 *
 * These are pinned rather than left at their defaults because each one would
 * otherwise vary the thing being measured:
 *
 *  - `noise-suppression: off` — the default on desktop is `rnnoise`, whose
 *    worklet would gate the synthetic source as non-speech and leave us timing
 *    silence. RNNoise's cost is worth measuring, but as its own scenario, with
 *    everything else held still.
 *  - `video-routing-mode: p2p-only` — pins the topology to full mesh so a run
 *    cannot silently become an SFU run. There is no SFU in the harness, but a
 *    benchmark should state its topology, not inherit it.
 *  - `jitter-buffer: auto` — the shipped adaptive behaviour. Naming it stops a
 *    stale localStorage value from a previous scenario carrying over.
 */
export const BASE_STORAGE = {
  'noise-suppression': 'off',
  'video-routing-mode': 'p2p-only',
  'jitter-buffer': 'auto',
  'video-mode-enabled': 'false',
};

const POLL = { timeout: 45_000, intervals: [200, 400, 800] };

/** Host creates, the rest join in order. Resolves once everyone is in. */
export async function buildRoom(makePeer, { size, storage = {} }) {
  const merged = { ...BASE_STORAGE, ...storage };
  const host = await makePeer({ pseudo: 'P0', storage: merged });
  const code = await createRoom(host);
  if (!code) throw new Error('host failed to create a room');

  const pages = [host];
  for (let i = 1; i < size; i++) {
    const page = await makePeer({ pseudo: `P${i}`, storage: merged });
    await joinRoom(page, code);
    pages.push(page);
  }
  return { code, host, pages };
}

/**
 * Open the full audio mesh.
 *
 * Necessary because of "join muted": `getMicStream()` is not called until a
 * peer first speaks, so before this the room has signaling but no
 * MediaConnections at all — and a bandwidth measurement taken there would
 * report a mesh that costs nothing.
 */
export async function openAudioMesh(pages, expect) {
  await Promise.all(
    pages.map((page) =>
      page.evaluate(
        () =>
          new Promise((resolve) => {
            window.setTalking(true);
            setTimeout(() => { window.setTalking(false); resolve(); }, 400);
          })
      )
    )
  );
  for (const page of pages) {
    await expect.poll(() => audibleCount(page), POLL).toBe(pages.length - 1);
  }
}

/** Hold the talk button down. Returns the function that releases it. */
export async function startTalking(page) {
  await page.evaluate(() => window.setTalking(true));
  return () => page.evaluate(() => window.setTalking(false)).catch(() => {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One measured run: build the room, open the mesh, let the chosen speakers
 * talk, hold, and reduce what the app recorded over the hold window.
 *
 * `warmupMs` exists for two separate reasons and both are required. The
 * encoder needs a few seconds to settle at its target bitrate after the first
 * onset, and `_pcByteDelta()` returns null until it has seen a peer connection
 * twice — so without the warmup the first samples in the window would be
 * missing rather than merely noisy.
 */
export async function runScenario({
  makePeer,
  expect,
  size,
  speakers = 1,
  storage = {},
  warmupMs = 8000,
  holdMs = 30_000,
  label,
}) {
  const { code, pages } = await buildRoom(makePeer, { size, storage });
  await openAudioMesh(pages, expect);

  const speakerCount = speakers === 'all' ? pages.length : Math.min(speakers, pages.length);
  const speakerIdx = new Set([...Array(speakerCount).keys()]);
  const releases = [];
  for (const i of speakerIdx) releases.push(await startTalking(pages[i]));

  await sleep(warmupMs);

  const cpuBefore = sampleProcessTree();
  const windowStart = Date.now();
  await sleep(holdMs);
  const cpuAfter = sampleProcessTree();

  const snapshots = await Promise.all(pages.map(peerSnapshot));
  for (const release of releases) await release();

  const peers = snapshots.map((snap, i) => ({
    index: i,
    role: i === 0 ? 'host' : 'peer',
    speaking: speakerIdx.has(i),
    peers: snap.peers,
    jsHeapBytes: snap.jsHeapBytes,
    usage: reduceUsage(snap.usage, windowStart),
    links: snap.links,
  }));

  return {
    label,
    size,
    speakers: speakerCount,
    storage: { ...BASE_STORAGE, ...storage },
    holdMs,
    roomCode: code,
    process: {
      // All `size` peers share one Chromium, so this is the cost of the whole
      // room on one machine — never divide it by size and call it per-peer.
      cpuPercentOfOneCore: cpuPercentBetween(cpuBefore, cpuAfter),
      rssBytes: cpuAfter.ok ? cpuAfter.rssBytes : null,
      processes: cpuAfter.ok ? cpuAfter.processes : null,
      measured: !!(cpuBefore.ok && cpuAfter.ok),
    },
    peers,
  };
}
