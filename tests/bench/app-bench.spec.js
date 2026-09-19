import { test, expect } from '../e2e/mesh-fixtures.js';
import { audibleCount, median, percentile, sampleProcessTree } from './bench-metrics.js';
import {
  navigationTiming, openCdp, settledFootprint, appVersion,
} from './app-metrics.js';
import { buildRoom, openAudioMesh, startTalking, BASE_STORAGE } from './bench-room.js';
import { createRoom, joinRoom, getState } from '../e2e/mesh-helpers.js';
import { recordRun, RESULTS_FILE } from './bench-results.js';

// App-level benchmark — the cost of the product before anybody speaks.
//
// mesh-bench.spec.js and video-bench.spec.js ask what a CALL costs. This file
// asks what the APP costs: how long it takes to become usable, how long it
// takes to be in a room from a standing start, and what it is holding in
// memory while it sits there. Those are the numbers that drift version by
// version without any single change looking expensive, which is why they are
// the ones worth a history file (docs/bench-history.ndjson, written by
// `make bench-publish`).
//
// Same contract as the rest of the harness, and it matters more here than
// anywhere else because these numbers are cheap to fake: nothing below asserts
// a performance threshold. The assertions are liveness only — that the page
// really loaded, that the room really connected — so a small number in the
// report means "this was fast", never "this never happened".
//
// Read docs/benchmarking.md before quoting any of it. In particular: the static
// file server is on loopback with no compression and no TLS, so the transfer
// half of every startup figure is a floor. What the startup numbers are honestly
// good for is the SHAPE — parse and boot cost, asset weight, and the delta
// between two versions measured the same way.

const REPS = parseInt(process.env.BENCH_REPS || '3', 10);
// How many join → leave cycles the churn check runs. Five is enough to turn a
// per-room leak into a slope and short enough to stay inside one test timeout.
const CHURN_CYCLES = parseInt(process.env.BENCH_CHURN_CYCLES || '5', 10);
const POLL = { timeout: 45_000, intervals: [200, 400, 800] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Median plus the worst of the reps — a startup figure nobody sees is p50 only. */
const summarize = (samples, key) => ({
  p50: median(samples.map((s) => s[key])),
  p95: percentile(samples.map((s) => s[key]), 95),
  max: samples.length ? Math.max(...samples.map((s) => s[key] ?? 0)) : null,
});

test.describe('app bench @bench', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(() => {
    console.log(`\n→ benchmark results: ${RESULTS_FILE}\n`);
  });

  // ── Scenario E: startup ────────────────────────────────────────────────────
  //
  // Two loads, because they are two different users. A COLD load is somebody
  // opening voxal for the first time, with an empty HTTP cache — it pays for
  // every byte of the shell. A WARM load is the same person the next day: the
  // bytes are in the cache, so what is left is parse, execute and boot, which
  // is the half a release can make worse without anybody noticing the download
  // got no bigger.
  //
  // Each rep is its own browser context, so "cold" is genuinely cold rather
  // than a reload with a primed cache.
  test('startup — cold and warm load of the app shell', async ({ makePeer }) => {
    test.setTimeout(180_000);

    const cold = [];
    const warm = [];
    let version = { version: null, buildDate: null };
    let shell = null;

    for (let rep = 0; rep < REPS; rep++) {
      // makePeer() opens a fresh context and navigates to '/', so the load is
      // already over by the time it resolves — which is why the timings are
      // read back out of the page rather than wall-clocked around the call.
      const page = await makePeer({ pseudo: `Boot${rep}`, storage: BASE_STORAGE });
      const cdp = await openCdp(page);

      const nav = await navigationTiming(page);
      const foot = await settledFootprint(page, cdp);
      // Liveness: the app is wired, not merely painted. `createRoom` is the
      // first thing a user can do and it only exists once main.js has run.
      expect(await page.evaluate(() => typeof window.createRoom === 'function')).toBe(true);
      expect(nav.interactiveMs).toBeGreaterThan(0);

      if (rep === 0) {
        version = await appVersion(page);
        shell = { resources: nav.resources, scripts: nav.scripts, documentBytes: nav.documentBytes, byFile: nav.byFile };
      }
      cold.push({ rep, ...nav, heapBytes: foot.heapBytes, domNodes: foot.domNodes, listeners: foot.listeners });

      // The warm half: same context, so the HTTP cache is primed. Everything
      // still-transferred here is something the cache could not keep.
      await page.reload({ waitUntil: 'load' });
      const navWarm = await navigationTiming(page);
      const footWarm = await settledFootprint(page, cdp);
      warm.push({ rep, ...navWarm, heapBytes: footWarm.heapBytes, domNodes: footWarm.domNodes, listeners: footWarm.listeners });
    }

    recordRun('app-startup', {
      app: version,
      reps: REPS,
      shell,
      cold: {
        samples: cold,
        interactiveMs: summarize(cold, 'interactiveMs'),
        fcpMs: summarize(cold, 'fcpMs'),
        lcpMs: summarize(cold, 'lcpMs'),
        loadMs: summarize(cold, 'loadMs'),
        responseEndMs: summarize(cold, 'responseEndMs'),
        heapBytes: median(cold.map((s) => s.heapBytes)),
        domNodes: median(cold.map((s) => s.domNodes)),
        listeners: median(cold.map((s) => s.listeners)),
      },
      warm: {
        samples: warm,
        interactiveMs: summarize(warm, 'interactiveMs'),
        fcpMs: summarize(warm, 'fcpMs'),
        loadMs: summarize(warm, 'loadMs'),
        transferBytes: median(warm.map((s) => s.resources.transferBytes)),
      },
    });
  });

  // ── Scenario F: cold path to a live call ───────────────────────────────────
  //
  // The existing `join-latency` scenario starts its clock at the join, because
  // a user in a call already has the app open. This one starts it at the open,
  // because a user who was sent a link does not: page load, then broker, then
  // ICE, then the first audio. It is the number a link recipient experiences
  // and the only one that can regress because the shell got heavier.
  //
  // Two of them, and they are not the same journey: creating a room needs only
  // the broker, while joining one needs the broker, a data connection, a
  // peer-list and a media connection that actually carries sound.
  test('cold connect — opening the app through to a live call', async ({ makePeer }) => {
    test.setTimeout(300_000);

    // A live room to walk into. Somebody has to be talking: with "join muted"
    // no MediaConnection exists until a peer first speaks, so a joiner that
    // arrives in a silent room would be timed against audio nobody is sending.
    const { code, pages } = await buildRoom(makePeer, { size: 2 });
    await openAudioMesh(pages, expect);
    const release = await startTalking(pages[0]);

    const creates = [];
    const joins = [];

    for (let rep = 0; rep < REPS; rep++) {
      // Create: a fresh app, straight to hosting a room of its own.
      const host = await makePeer({ pseudo: `ColdHost${rep}`, storage: BASE_STORAGE });
      const hostNav = await navigationTiming(host);
      const t0 = Date.now();
      const ownCode = await createRoom(host);
      const createMs = Date.now() - t0;
      expect(ownCode).toBeTruthy();
      creates.push({
        rep,
        loadMs: hostNav.interactiveMs,
        createMs,
        // What the user waited: the app becoming usable, then the broker
        // handing back an id. Added rather than measured end to end because
        // the two halves regress for entirely different reasons.
        totalMs: (hostNav.interactiveMs || 0) + createMs,
      });
      await host.evaluate(() => window.leaveRoom());

      // Join: a fresh app, into the room that is already talking.
      const guest = await makePeer({ pseudo: `ColdGuest${rep}`, storage: BASE_STORAGE });
      const guestNav = await navigationTiming(guest);
      const t1 = Date.now();
      await joinRoom(guest, code);
      const signalingMs = Date.now() - t1;
      await expect.poll(() => audibleCount(guest), POLL).toBeGreaterThan(0);
      const audibleMs = Date.now() - t1;
      joins.push({
        rep,
        loadMs: guestNav.interactiveMs,
        signalingMs,
        audibleMs,
        totalMs: (guestNav.interactiveMs || 0) + audibleMs,
      });
      await guest.evaluate(() => window.leaveRoom());
    }

    await release();
    expect(creates.length).toBe(REPS);
    expect(joins.length).toBe(REPS);

    recordRun('app-connect', {
      reps: REPS,
      roomSize: 2,
      create: {
        samples: creates,
        loadMs: median(creates.map((s) => s.loadMs)),
        actionMs: median(creates.map((s) => s.createMs)),
        totalMs: median(creates.map((s) => s.totalMs)),
      },
      join: {
        samples: joins,
        loadMs: median(joins.map((s) => s.loadMs)),
        signalingMs: median(joins.map((s) => s.signalingMs)),
        audibleMs: median(joins.map((s) => s.audibleMs)),
        totalMs: median(joins.map((s) => s.totalMs)),
      },
    });
  });

  // ── Scenario G: memory footprint ───────────────────────────────────────────
  //
  // Three states and a churn check, and the churn check is the point. An idle
  // figure and an in-room figure are useful for sizing a device; what actually
  // breaks a long day of calls is a room that is left and rejoined leaving
  // something behind each time — roster rows, chat rows, `<audio>` elements
  // and listeners on all of them.
  //
  // Every figure is taken after `HeapProfiler.collectGarbage`, because the
  // difference between two un-collected heaps is dominated by what the
  // allocator has not swept yet, which looks exactly like a leak. And the
  // churn baseline is taken after the FIRST cycle, never before it: a room's
  // first join allocates structures that are then reused, and counting that
  // one-time cost as growth would report a leak in a page that has none.
  test('memory — idle, in a room, and across join/leave churn', async ({ makePeer }) => {
    test.setTimeout(300_000);

    // Idle: the app open on the home screen, having done nothing.
    const idlePage = await makePeer({ pseudo: 'Idle', storage: BASE_STORAGE });
    const idleCdp = await openCdp(idlePage);
    const idle = await settledFootprint(idlePage, idleCdp);
    expect(idle.domNodes).toBeGreaterThan(0);

    // In a room: a real 3-peer mesh with audio flowing, held long enough for
    // the stats poller and the roster to reach their steady state.
    const size = 3;
    const { code, pages } = await buildRoom(makePeer, { size });
    await openAudioMesh(pages, expect);
    const release = await startTalking(pages[0]);
    await sleep(8000);

    const cdps = await Promise.all(pages.map(openCdp));
    const inRoom = [];
    for (let i = 0; i < pages.length; i++) {
      inRoom.push({ index: i, role: i === 0 ? 'host' : 'peer', ...(await settledFootprint(pages[i], cdps[i])) });
    }
    await release();

    // Churn: one extra peer joins and leaves the live room, over and over.
    const churnPage = await makePeer({ pseudo: 'Churn', storage: BASE_STORAGE });
    const churnCdp = await openCdp(churnPage);
    const cycles = [];
    let baseline = null;
    for (let c = 0; c < CHURN_CYCLES; c++) {
      await joinRoom(churnPage, code);
      // `inRoom` is a `let` at the top level of main.js, so it is a lexical
      // global and NOT a property of `window` — hence getState(), which reads
      // it as a bare identifier the way the rest of the harness does.
      await expect.poll(async () => (await getState(churnPage)).inRoom, POLL).toBe(true);
      await sleep(1500);
      await churnPage.evaluate(() => window.leaveRoom());
      await expect.poll(async () => (await getState(churnPage)).inRoom, POLL).toBe(false);
      await sleep(500);

      const shot = await settledFootprint(churnPage, churnCdp);
      cycles.push({ cycle: c + 1, heapBytes: shot.heapBytes, domNodes: shot.domNodes, listeners: shot.listeners, audioElements: shot.audioElements });
      if (c === 0) baseline = shot;
    }

    const last = cycles[cycles.length - 1];
    // Liveness for the churn loop itself: a page that never got into the room
    // would leak nothing and look perfect.
    expect(cycles.length).toBe(CHURN_CYCLES);

    recordRun('app-memory', {
      size,
      churnCycles: CHURN_CYCLES,
      idle: {
        heapBytes: idle.heapBytes,
        heapSource: idle.heapSource,
        collected: idle.collected,
        domNodes: idle.domNodes,
        listeners: idle.listeners,
        documents: idle.documents,
      },
      room: {
        heapBytes: median(inRoom.map((p) => p.heapBytes)),
        domNodes: median(inRoom.map((p) => p.domNodes)),
        listeners: median(inRoom.map((p) => p.listeners)),
        audioElements: median(inRoom.map((p) => p.audioElements)),
        peers: inRoom,
      },
      churn: {
        cycles,
        // Growth per rejoin, measured from the first cycle rather than from a
        // never-joined page. Null when there is only one cycle to compare.
        baseline: baseline
          ? { heapBytes: baseline.heapBytes, domNodes: baseline.domNodes, listeners: baseline.listeners }
          : null,
        heapGrowthBytes:
          baseline && last && baseline.heapBytes !== null && last.heapBytes !== null
            ? last.heapBytes - baseline.heapBytes
            : null,
        nodeGrowth:
          baseline && last && baseline.domNodes !== null && last.domNodes !== null
            ? last.domNodes - baseline.domNodes
            : null,
        listenerGrowth:
          baseline && last && baseline.listeners !== null && last.listeners !== null
            ? last.listeners - baseline.listeners
            : null,
        // Per cycle after the first, which is the shape that matters: a fixed
        // step is a one-off, a constant per-cycle figure is a leak.
        perCycleHeapBytes:
          baseline && last && baseline.heapBytes !== null && last.heapBytes !== null && cycles.length > 1
            ? (last.heapBytes - baseline.heapBytes) / (cycles.length - 1)
            : null,
      },
      // The whole browser, for scale: every peer above shares it, so this is
      // the room's total on one machine and never a per-peer figure.
      process: (() => {
        const shot = sampleProcessTree();
        return { rssBytes: shot.ok ? shot.rssBytes : null, processes: shot.ok ? shot.processes : null };
      })(),
    });
  });
});
