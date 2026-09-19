// Room construction and the shape of one benchmark run.
//
// Built on the mesh fixtures rather than beside them: the benchmark has to
// drive the SAME createRoom/joinRoom/setTalking path the mesh tests do, or it
// is measuring a second implementation. Only the measurement is new here.
import { createRoom, joinRoom, getState } from '../e2e/mesh-helpers.js';
import {
  peerSnapshot, audibleCount, reduceUsage, sampleProcessTree, cpuPercentBetween,
  visibleVideoCount, visibleScreenCount, videoQuality, effectsState,
} from './bench-metrics.js';

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

/**
 * What a video scenario starts with, on top of BASE_STORAGE.
 *
 * `video-mode-enabled` is the room's own switch — a benchmark that called
 * startVideoShare() behind a room that has video turned off would be measuring
 * a state the product cannot be in.
 *
 * `video-routing-mode` stays `p2p-only`, inherited: the SFU is the *other*
 * topology and it is not in this harness (there is no Cloudflare Realtime here,
 * and a benchmark must state its topology rather than let a cached
 * availability hint pick one mid-sweep). What this measures is the full mesh,
 * which is what the app does below three participants anyway and what it does
 * at every size for a user who chose `p2p-only`. See docs/video-routing.md.
 */
export const VIDEO_STORAGE = {
  ...BASE_STORAGE,
  'video-mode-enabled': 'true',
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

/**
 * Turn the camera on for the first `count` peers and wait until everybody else
 * can actually see them.
 *
 * The wait is the point. `startVideoShare()` resolves once the local capture is
 * published, which on a mesh is long before N-1 other peers have negotiated an
 * inbound track — and a bandwidth window opened at that moment would catch the
 * mesh mid-build and report a video call that costs almost nothing.
 */
export async function openCameras(pages, expect, count = pages.length) {
  const sharers = pages.slice(0, Math.min(count, pages.length));
  for (const page of sharers) await page.evaluate(() => window.startVideoShare());

  for (const page of pages) {
    const expected = sharers.filter((p) => p !== page).length;
    await expect.poll(() => visibleVideoCount(page), POLL).toBe(expected);
  }
  return sharers;
}

/**
 * Share a screen from one peer and wait until the others see it.
 *
 * Needs `--auto-select-desktop-capture-source` on the browser (set for the
 * bench project in playwright.config.js): getDisplayMedia() otherwise waits on
 * a picker no automation can click. Throws rather than skipping quietly if the
 * capture is refused — the spec decides what to do about that, since "screens
 * cannot be captured here" is a fact about the machine and belongs in the
 * report, not in a silent pass.
 */
export async function openScreenShare(pages, expect, sharerIndex = 0) {
  const sharer = pages[sharerIndex];
  const started = await sharer.evaluate(async () => {
    await window.startScreenShare();
    return !!(typeof localScreenStream !== 'undefined' && localScreenStream);
  });
  if (!started) throw new Error('getDisplayMedia() produced no stream on this machine');

  for (const page of pages) {
    if (page === sharer) continue;
    await expect.poll(() => visibleScreenCount(page), POLL).toBe(1);
  }
  return sharer;
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
  cameras = 0,
  screenShare = false,
  base = BASE_STORAGE,
  storage = {},
  warmupMs = 8000,
  holdMs = 30_000,
  label,
}) {
  const { code, pages } = await buildRoom(makePeer, { size, storage: { ...base, ...storage } });
  await openAudioMesh(pages, expect);

  // Cameras before the speakers start, and before the warm-up: the video mesh
  // takes longer to form than the audio one, and everything after this point
  // assumes a room that is fully built.
  const cameraCount = cameras === 'all' ? pages.length : Math.min(cameras, pages.length);
  if (cameraCount) await openCameras(pages, expect, cameraCount);
  if (screenShare) await openScreenShare(pages, expect, 0);

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
  // Taken at the end of the window, not the start: the encoder's answer to
  // "what resolution could this machine actually sustain" is the one it settled
  // on after 30 seconds of the whole room competing for the same cores.
  const cameraQuality = cameraCount
    ? await Promise.all(pages.map((page) => videoQuality(page, 'camera')))
    : null;
  const screenQuality = screenShare
    ? await Promise.all(pages.map((page) => videoQuality(page, 'screen')))
    : null;
  const effects = cameraCount ? await Promise.all(pages.map(effectsState)) : null;
  for (const release of releases) await release();

  const peers = snapshots.map((snap, i) => ({
    index: i,
    role: i === 0 ? 'host' : 'peer',
    speaking: speakerIdx.has(i),
    sharingCamera: i < cameraCount,
    sharingScreen: screenShare && i === 0,
    peers: snap.peers,
    jsHeapBytes: snap.jsHeapBytes,
    usage: reduceUsage(snap.usage, windowStart),
    links: snap.links,
    video: cameraQuality ? cameraQuality[i] : null,
    screen: screenQuality ? screenQuality[i] : null,
    // Whether the background effect this scenario asked for is really running.
    // Recorded per peer rather than assumed from the setting, because
    // maybeApplyVideoEffects() falls back to the raw camera in silence.
    effects: effects ? effects[i] : null,
  }));

  return {
    label,
    size,
    speakers: speakerCount,
    cameras: cameraCount,
    screenShare: !!screenShare,
    storage: { ...base, ...storage },
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
