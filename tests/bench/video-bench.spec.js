import { test, expect } from '../e2e/mesh-fixtures.js';
import { joinRoom } from '../e2e/mesh-helpers.js';
import { audibleCount, decodedVideoCount, median } from './bench-metrics.js';
import {
  runScenario, buildRoom, openAudioMesh, openCameras, startTalking, VIDEO_STORAGE,
} from './bench-room.js';
import { recordRun } from './bench-results.js';

// Performance benchmark — the camera and screen-share half.
//
// Same rules as mesh-bench.spec.js, which measures voice: real PeerJS, real
// WebRTC between isolated Chromium contexts, the app's own instrumentation read
// back out, and no performance threshold anywhere. The assertions are liveness
// only, so a zero in the report means "this cost nothing", never "this never
// connected".
//
// Why video needs its own file rather than another scenario in that one: the
// question is different. Voice is a full mesh at any size, under every setting,
// so its benchmark asks how far the mesh stretches. Camera and screen are a
// mesh *by default* and may take the SFU instead above two participants — so
// what this file measures is one of two topologies, and it says which
// (`video-routing-mode: p2p-only`, pinned in VIDEO_STORAGE). The relayed side
// is not measured here at all; there is no Cloudflare Realtime in the harness.
// See docs/video-routing.md and docs/benchmarking.md §5.
//
// Also: video is heavy. Every peer of an N-person room encodes N-1 copies of
// 720p in ONE browser on ONE machine, so the sweep defaults smaller than the
// audio one and the report prints the resolution the encoder actually
// sustained — a room that fell to 320x180 is a fact about this machine, and it
// must be visible rather than hidden inside a flattering bandwidth figure.

const SIZES = (process.env.BENCH_VIDEO_SIZES || '2,3,4')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n >= 2);

const HOLD_MS = parseInt(process.env.BENCH_HOLD_MS || '30000', 10);
const REPS = parseInt(process.env.BENCH_REPS || '3', 10);
const POLL = { timeout: 60_000, intervals: [200, 400, 800] };
const MAX_SIZE = Math.max(...SIZES);

test.describe('bench video @bench', () => {
  // Deliberately NOT serial, unlike the voice spec. The benchmark already runs
  // one worker, so ordering is guaranteed anyway, and serial mode's real effect
  // here would be to SKIP every remaining scenario when one fails — losing the
  // background, screen and join measurements because a heavy 4-peer camera room
  // did not form on a small machine. Each scenario stands on its own, and a
  // scenario that could not be measured should be absent from the report, not
  // take the others with it.

  // ── Scenario E: how the video mesh scales ──────────────────────────────────
  //
  // The video headline, and the mirror of `mesh-scale`. Camera is a full mesh
  // under this preference, so a sharer encodes and uploads one stream per other
  // peer — the same O(N-1) shape as audio, but at twenty times the bitrate.
  //
  // Everyone is on camera, because that is what a video call is. The
  // one-presenter case gets its own run below.
  for (const size of SIZES) {
    test(`video scale — ${size} peers, all cameras`, async ({ makePeer }) => {
      test.setTimeout(HOLD_MS + 300_000);
      const run = await runScenario({
        makePeer, expect, size, speakers: 1, cameras: 'all',
        base: VIDEO_STORAGE, holdMs: HOLD_MS, label: `video-${size}`,
      });
      // Liveness: every peer held every link open, and could see everyone else.
      for (const peer of run.peers) {
        expect(peer.peers).toBe(size - 1);
        expect(peer.links.filter((l) => l.videoPcs > 0).length).toBe(size - 1);
      }
      expect(median(run.peers.map((p) => p.usage.out.camera))).toBeGreaterThan(0);
      recordRun('video-scale', run);
    });
  }

  // One camera in a room of N — the presenter, and the shape most meetings
  // actually have. The gap against the all-cameras run at the same size is what
  // a room pays for everybody turning their camera on.
  test(`video scale — ${MAX_SIZE} peers, one camera`, async ({ makePeer }) => {
    test.setTimeout(HOLD_MS + 300_000);
    const run = await runScenario({
      makePeer, expect, size: MAX_SIZE, speakers: 1, cameras: 1,
      base: VIDEO_STORAGE, holdMs: HOLD_MS, label: `video-${MAX_SIZE}-one`,
    });
    for (const peer of run.peers) expect(peer.peers).toBe(MAX_SIZE - 1);
    recordRun('video-scale', run);
  });

  // ── Scenario F: what a camera background costs ─────────────────────────────
  //
  // The mirror of `noise-suppression`, and the same question: a feature that
  // runs on every frame of every call that turns it on. Segmentation is
  // MediaPipe in WebAssembly on the GPU plus a WebGL composite, so the cost
  // lands on CPU and on the frame rate the encoder is handed — not on the wire.
  //
  // Held at one room size with everything else pinned, because the number that
  // matters is the delta between off and on, not either absolute.
  //
  // `blur` rather than an image: an image preset would also measure a download
  // and a texture upload that a blur does not do, and the blur is what most
  // people leave on.
  for (const background of ['off', 'blur']) {
    test(`video background — ${background}`, async ({ makePeer }) => {
      test.setTimeout(HOLD_MS + 300_000);
      const size = Math.min(2, MAX_SIZE);
      const run = await runScenario({
        makePeer, expect, size, speakers: 1,
        // ONE camera, not both: the question is what one background costs, and
        // two segmenters sharing one GPU would measure them competing with each
        // other rather than the feature.
        cameras: 1,
        base: VIDEO_STORAGE,
        // `video-background` is VideoEffects.STORAGE_KEY — the key is declared
        // in video-effects.js and nowhere else (see CLAUDE.md), so it is
        // written literally here rather than imported from a module this
        // classic-script app does not have.
        storage: background === 'off' ? {} : { 'video-background': background },
        holdMs: HOLD_MS,
        label: `bg-${background}`,
      });

      // Still liveness only. An effect that never started, or that the app's own
      // overload guard turned off mid-run because the machine could not sustain
      // it, is a RESULT — and one worth publishing, since it is exactly what a
      // weak device does. So it is recorded and reported (the report's
      // "Still running" column), never asserted: failing here would throw away the
      // measurement that says the machine gave up.
      if (background === 'blur' && !run.peers.some((p) => p.effects && p.effects.engaged)) {
        console.warn(
          '! background effect was not running at the end of this run — ' +
            'either it never started (no WebGL / missing runtime, see `make seg-assets`) ' +
            'or VideoEffects gave up on this machine. Reported as 0 engaged.'
        );
      }
      recordRun('video-background', run);
    });
  }

  // ── Scenario G: screen share ───────────────────────────────────────────────
  //
  // Its own scenario because a screen is not a camera: SCREEN_MAX_BITRATE is
  // 1.5 Mb/s against the camera's 600 kb/s, the sender is pinned to
  // `maintain-resolution` (dropping frames instead of letters), and
  // `videoScaleForPeerCount()` never touches it. One sharer, because that is
  // how screen sharing is used and because N simultaneous screens is not a
  // room, it is a stress test of the harness.
  //
  // Note the sharer's microphone opens: startScreenShare() turns hands-free on,
  // which is real product behaviour and shows up in that peer's audio column.
  test('screen share — one sharer, a room watching', async ({ makePeer }) => {
    test.setTimeout(HOLD_MS + 300_000);
    const size = Math.min(3, MAX_SIZE);
    let run;
    try {
      run = await runScenario({
        makePeer, expect, size, speakers: 1, screenShare: true,
        base: VIDEO_STORAGE, holdMs: HOLD_MS, label: `screen-${size}`,
      });
    } catch (e) {
      // getDisplayMedia() needs a desktop to capture and an auto-selected
      // source. Where there is neither, say so and leave the scenario out of
      // the report rather than recording a room that shared nothing.
      //
      // Only that failure is skippable, and it is matched narrowly: a room that
      // could not be built, or a mesh that never formed, is a real failure and
      // must not be laundered into "this machine has no screen".
      if (!/getDisplayMedia/.test(e.message)) throw e;
      test.skip(true, `screen capture unavailable on this machine: ${e.message}`);
      return;
    }
    expect(median(run.peers.map((p) => p.usage.in.screen + p.usage.out.screen))).toBeGreaterThan(0);
    recordRun('screen-share', run);
  });

  // ── Scenario H: join a room that is already on camera ──────────────────────
  //
  // The mirror of `join-latency`, and the reason it is separate: audio arrives
  // over a MediaConnection that is already negotiated by the time signaling is
  // open, while a picture needs its own call per sharer, a keyframe, and a
  // decoder. "How long until I can see them" is a different number from "how
  // long until I can hear them", and both are what walking into a meeting
  // feels like.
  test('video join latency — time until a new peer sees a live room', async ({ makePeer }) => {
    test.setTimeout(REPS * 90_000 + 120_000);
    const size = Math.min(3, MAX_SIZE);
    const { code, pages } = await buildRoom(makePeer, { size, storage: VIDEO_STORAGE });
    await openAudioMesh(pages, expect);
    await openCameras(pages, expect, pages.length);
    const release = await startTalking(pages[0]);

    const samples = [];
    for (let rep = 0; rep < REPS; rep++) {
      // The context and the page load happen BEFORE the clock starts: a real
      // user already has a browser open.
      const joiner = await makePeer({ pseudo: `Late${rep}`, storage: VIDEO_STORAGE });
      const t0 = Date.now();
      await joinRoom(joiner, code);
      const signalingMs = Date.now() - t0;
      await expect.poll(() => audibleCount(joiner), POLL).toBeGreaterThan(0);
      const audibleMs = Date.now() - t0;
      // Every camera in the room, not the first one: a tile arriving is not the
      // same as the room being there, and the mesh builds them one call at a
      // time. And a DECODED frame, not merely an attached track — a tile that
      // is on screen and still black is not "seeing the room".
      await expect.poll(() => decodedVideoCount(joiner), POLL).toBe(size);
      samples.push({ rep, signalingMs, audibleMs, visibleMs: Date.now() - t0 });
      await joiner.evaluate(() => window.leaveRoom());
    }
    await release();

    expect(samples.length).toBe(REPS);
    recordRun('video-join-latency', {
      size,
      cameras: size,
      samples,
      medianSignalingMs: median(samples.map((s) => s.signalingMs)),
      medianAudibleMs: median(samples.map((s) => s.audibleMs)),
      medianVisibleMs: median(samples.map((s) => s.visibleMs)),
    });
  });
});
