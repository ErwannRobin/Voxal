import { test, expect } from '../e2e/mesh-fixtures.js';
import { joinRoom, getState, killPeer, waitForSharedDeputy } from '../e2e/mesh-helpers.js';
import { audibleCount, sampleProcessTree, cpuPercentBetween, median } from './bench-metrics.js';
import { runScenario, buildRoom, openAudioMesh, startTalking, BASE_STORAGE } from './bench-room.js';
import { recordRun, RESULTS_FILE } from './bench-results.js';

// Performance benchmark — real PeerJS signaling and real WebRTC between
// isolated Chromium contexts, driven through the local PeerServer broker, with
// the app's OWN instrumentation read back out.
//
// Tagged @bench and kept in its own Playwright project with its own testDir, so
// it can never leak into `make test` or `make test-mesh`. It is not a test:
// nothing here asserts a performance threshold, because a number measured on a
// shared CI runner would fail for reasons that have nothing to do with the
// code. The assertions present are liveness only — they establish that the run
// measured a working call, so a zero in the report means "it cost nothing",
// never "it never connected".
//
// Read docs/benchmarking.md before drawing a conclusion from the output. In
// particular: this runs every peer of a room inside ONE browser on ONE machine
// over loopback, so latency is a floor and CPU is a whole-room total.

const SIZES = (process.env.BENCH_SIZES || '2,3,4,6')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n >= 2);

const HOLD_MS = parseInt(process.env.BENCH_HOLD_MS || '30000', 10);
const REPS = parseInt(process.env.BENCH_REPS || '3', 10);
const POLL = { timeout: 45_000, intervals: [200, 400, 800] };

test.describe('bench @bench', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(() => {
    console.log(`\n→ benchmark results: ${RESULTS_FILE}\n`);
  });

  // ── Scenario A: how the mesh scales ────────────────────────────────────────
  //
  // The headline. Audio is full mesh always, so a peer's upload is expected to
  // grow with the room while an SFU-based product's stays flat — this is the
  // curve that either shows that or refutes it.
  for (const size of SIZES) {
    test(`mesh scale — ${size} peers, 1 speaker`, async ({ makePeer }) => {
      test.setTimeout(HOLD_MS + 180_000);
      const run = await runScenario({
        makePeer, expect, size, speakers: 1, holdMs: HOLD_MS, label: `scale-${size}`,
      });
      // Liveness: every peer held every link open for the whole window.
      for (const peer of run.peers) expect(peer.peers).toBe(size - 1);
      expect(median(run.peers.map((p) => p.usage.outTotal))).toBeGreaterThan(0);
      recordRun('mesh-scale', run);
    });
  }

  // Worst case for the mesh: everybody talking at once. The gap between this
  // and the single-speaker run above is what silence suppression buys — and
  // since the app forces `usedtx=0`, it should be smaller than intuition says.
  test(`mesh scale — ${Math.max(...SIZES)} peers, all speaking`, async ({ makePeer }) => {
    const size = Math.max(...SIZES);
    test.setTimeout(HOLD_MS + 180_000);
    const run = await runScenario({
      makePeer, expect, size, speakers: 'all', holdMs: HOLD_MS, label: `scale-${size}-all`,
    });
    for (const peer of run.peers) expect(peer.peers).toBe(size - 1);
    recordRun('mesh-scale', run);
  });

  // ── Scenario B: what noise suppression costs ───────────────────────────────
  //
  // Held at one room size with everything else pinned, because the question is
  // the delta between the three modes, not their absolute values. RNNoise is
  // the desktop default, so its cost is a cost the product pays by default.
  for (const mode of ['off', 'browser', 'rnnoise']) {
    test(`noise suppression — ${mode}`, async ({ makePeer }) => {
      test.setTimeout(HOLD_MS + 180_000);
      const size = Math.min(3, Math.max(...SIZES));
      const run = await runScenario({
        makePeer, expect, size, speakers: 'all', holdMs: HOLD_MS,
        storage: { 'noise-suppression': mode },
        label: `ns-${mode}`,
      });
      recordRun('noise-suppression', run);
    });
  }

  // ── Scenario C: join → first audio ─────────────────────────────────────────
  //
  // Measured from the join, not from opening the browser: a real user's browser
  // is already running. The room is already live and talking, which is the
  // situation the number is about — walking into a conversation in progress.
  test('join latency — time until a new peer hears a live room', async ({ makePeer }) => {
    test.setTimeout(240_000);
    const size = 3;
    const { code, pages } = await buildRoom(makePeer, { size });
    await openAudioMesh(pages, expect);
    const release = await startTalking(pages[0]);

    const samples = [];
    for (let rep = 0; rep < REPS; rep++) {
      // Context creation and page load happen BEFORE the clock starts.
      const joiner = await makePeer({ pseudo: `Late${rep}`, storage: BASE_STORAGE });
      const t0 = Date.now();
      await joinRoom(joiner, code);
      const signalingMs = Date.now() - t0;
      await expect.poll(() => audibleCount(joiner), POLL).toBeGreaterThan(0);
      samples.push({ rep, signalingMs, audibleMs: Date.now() - t0 });
      await joiner.evaluate(() => window.leaveRoom());
    }
    await release();

    expect(samples.length).toBe(REPS);
    recordRun('join-latency', {
      size,
      samples,
      medianSignalingMs: median(samples.map((s) => s.signalingMs)),
      medianAudibleMs: median(samples.map((s) => s.audibleMs)),
    });
  });

  // ── Scenario D: host migration ─────────────────────────────────────────────
  //
  // Voxal's own feature, and nothing to benchmark it against — no SFU product
  // has to do this, because their server never leaves. Measured anyway because
  // it is the one outage a mesh design owns: how long the room is leaderless.
  //
  // Two clocks, deliberately. Agreeing on a new host is cheap; getting audio
  // flowing again is the number a user would recognise as "the call came back".
  test('host migration — time to recover after the host vanishes', async ({ makePeer }) => {
    test.setTimeout(240_000);
    const size = Math.min(4, Math.max(...SIZES));
    const { pages } = await buildRoom(makePeer, { size });
    await openAudioMesh(pages, expect);

    const survivors = pages.slice(1);
    // Migration is undefined if the succession chain never propagated, so wait
    // for it the way the mesh tests do rather than racing it.
    await waitForSharedDeputy(expect, pages, POLL);

    const cpuBefore = sampleProcessTree();
    const t0 = Date.now();
    await killPeer(pages[0]);

    await expect
      .poll(async () => {
        const states = await Promise.all(survivors.map(getState));
        return states.filter((s) => s.isHost).length;
      }, POLL)
      .toBe(1);
    const hostElectedMs = Date.now() - t0;

    for (const page of survivors) {
      await expect.poll(() => audibleCount(page), POLL).toBe(survivors.length - 1);
    }
    const audioRestoredMs = Date.now() - t0;
    const cpuAfter = sampleProcessTree();

    recordRun('host-migration', {
      size,
      survivors: survivors.length,
      hostElectedMs,
      audioRestoredMs,
      process: { cpuPercentOfOneCore: cpuPercentBetween(cpuBefore, cpuAfter) },
    });
  });
});
