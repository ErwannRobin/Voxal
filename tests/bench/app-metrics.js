// Measurement helpers for the APP-level benchmark — the numbers that describe
// the product before anybody has said a word into it: how long the app takes to
// become usable, how long it takes to be in a call, and what it is holding in
// memory while it sits there.
//
// Same rule as bench-metrics.js, applied to a different layer: nothing here is
// a stopwatch this harness invented. Startup comes from the browser's own
// Navigation Timing and Paint Timing, memory and DOM size come from the same
// CDP counters DevTools shows, and the connect timings are wall-clock around
// the app's OWN `createRoom()` / `joinRoom()` / audible-track check. A
// benchmark that measures its own instrumentation measures nothing.
import { readFileSync } from 'node:fs';

// ── Startup ──────────────────────────────────────────────────────────────────

/**
 * The load, as the browser recorded it.
 *
 * `domContentLoadedEventEnd` is this app's readiness and not an approximation
 * of it: `main.js` is a classic script at the end of `<body>` (no `defer`, no
 * module), so parsing blocks on it, and the bootstrap runs in a
 * `DOMContentLoaded` listener — which has to return before that mark is taken.
 * By then `createRoom()` exists, the home screen is wired and a click does
 * something. `loadEventEnd` is later and means something else: every
 * sub-resource in too, including ones the user never waits for.
 *
 * LCP needs a buffered observer rather than `getEntriesByType` — it is not in
 * the performance timeline as a normal entry — so it is collected here and
 * reported as null wherever the browser does not support it.
 */
export async function navigationTiming(page) {
  return page.evaluate(async () => {
    const nav = performance.getEntriesByType('navigation')[0];
    const paint = Object.fromEntries(
      performance.getEntriesByType('paint').map((e) => [e.name, e.startTime])
    );

    // One frame of grace: LCP is reported asynchronously, so an observer
    // created and read in the same tick can come back empty on a page that
    // has plainly painted.
    const lcp = await new Promise((resolve) => {
      let last = null;
      let obs;
      try {
        obs = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) last = e.startTime;
        });
        obs.observe({ type: 'largest-contentful-paint', buffered: true });
      } catch (_) {
        resolve(null);
        return;
      }
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          try { obs.disconnect(); } catch (_) { /* already gone */ }
          resolve(last);
        })
      );
    });

    // What the shell cost on the wire. `transferSize` is 0 for a resource
    // served from the memory cache, which is exactly what makes the warm
    // reload's figure meaningful rather than a repeat of the cold one.
    const resources = performance.getEntriesByType('resource');
    const weigh = (entries) => ({
      count: entries.length,
      transferBytes: entries.reduce((s, r) => s + (r.transferSize || 0), 0),
      decodedBytes: entries.reduce((s, r) => s + (r.decodedBodySize || 0), 0),
    });

    return {
      // Server and network, on loopback: a floor, and reported so a slow
      // machine is not mistaken for a slow app.
      responseEndMs: nav ? nav.responseEnd : null,
      domInteractiveMs: nav ? nav.domInteractive : null,
      // The one that means "the app is usable" — see above.
      interactiveMs: nav ? nav.domContentLoadedEventEnd : null,
      loadMs: nav ? nav.loadEventEnd : null,
      firstPaintMs: paint['first-paint'] ?? null,
      fcpMs: paint['first-contentful-paint'] ?? null,
      lcpMs: lcp,
      // The document itself is counted apart from everything it pulls in: the
      // HTML is one number a release can move on purpose, and the scripts are
      // the number that grows by accident.
      documentBytes: nav ? nav.transferSize || 0 : null,
      resources: weigh(resources),
      scripts: weigh(resources.filter((r) => r.initiatorType === 'script')),
      // PeerJS, the emoji catalog and the effects pipeline are the shell's
      // three heavy guests. Named so a regression can be attributed rather
      // than merely noticed.
      byFile: resources
        .map((r) => ({
          name: r.name.replace(/^https?:\/\/[^/]+\//, ''),
          transferBytes: r.transferSize || 0,
          decodedBytes: r.decodedBodySize || 0,
          durationMs: r.duration,
        }))
        .sort((a, b) => b.decodedBytes - a.decodedBytes)
        .slice(0, 12),
    };
  });
}

// ── Memory and DOM size ──────────────────────────────────────────────────────

/**
 * A CDP session on this page, or null where one cannot be had.
 *
 * Chromium-only by construction. Every caller treats a null as "not measured"
 * rather than as zero — the JS heap the app is responsible for is worth
 * reporting honestly or not at all.
 */
export async function openCdp(page) {
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable').catch(() => {});
    await cdp.send('HeapProfiler.enable').catch(() => {});
    return cdp;
  } catch (_) {
    return null;
  }
}

/**
 * Ask the collector to run, and wait for it.
 *
 * Required before any heap figure that will be compared with another one.
 * Without it the difference between two samples is dominated by whatever the
 * allocator happened not to have swept yet, which is noise that looks exactly
 * like a leak.
 */
export async function collectGarbage(cdp) {
  if (!cdp) return false;
  try {
    await cdp.send('HeapProfiler.collectGarbage');
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * What this one page is holding: heap, DOM nodes, listeners, detached documents.
 *
 * The heap comes from CDP rather than from `performance.memory`, which is
 * quantized to 100 KB buckets unless Chromium is launched with
 * `--enable-precise-memory-info` — a bucket wide enough to hide a whole room's
 * worth of growth. `performance.memory` stays as the fallback, and the record
 * says which one produced the number.
 *
 * `Nodes` and `JSEventListeners` are here because they are the two counters
 * that catch the leak this app could plausibly have: a room that is left and
 * rejoined builds roster rows, chat rows, `<audio>` elements and listeners on
 * all of them. A heap figure alone can stay flat while those grow.
 */
export async function pageFootprint(page, cdp) {
  let metrics = null;
  if (cdp) {
    try {
      const { metrics: rows } = await cdp.send('Performance.getMetrics');
      metrics = Object.fromEntries(rows.map((r) => [r.name, r.value]));
    } catch (_) {
      metrics = null;
    }
  }

  const inPage = await page.evaluate(() => ({
    heapBytes: performance.memory ? performance.memory.usedJSHeapSize : null,
    domNodes: document.getElementsByTagName('*').length,
    audioElements: document.querySelectorAll('audio[id^="audio-"]').length,
    videoElements: document.querySelectorAll('video').length,
    chatMessages: document.querySelectorAll('#chat-messages .chat-msg').length,
  }));

  return {
    // `JSHeapUsedSize` is exact; `performance.memory` is bucketed. Which one
    // was used is recorded, because a report that compares an exact figure
    // with a bucketed one is comparing two different measurements.
    heapBytes: metrics?.JSHeapUsedSize ?? inPage.heapBytes,
    heapSource: metrics?.JSHeapUsedSize !== undefined ? 'cdp' : inPage.heapBytes === null ? null : 'performance.memory',
    heapTotalBytes: metrics?.JSHeapTotalSize ?? null,
    domNodes: metrics?.Nodes ?? inPage.domNodes,
    listeners: metrics?.JSEventListeners ?? null,
    documents: metrics?.Documents ?? null,
    layoutCount: metrics?.LayoutCount ?? null,
    audioElements: inPage.audioElements,
    videoElements: inPage.videoElements,
    chatMessages: inPage.chatMessages,
  };
}

/** Footprint with the collector run first — the only kind worth differencing. */
export async function settledFootprint(page, cdp) {
  const collected = await collectGarbage(cdp);
  const shot = await pageFootprint(page, cdp);
  return { ...shot, collected };
}

// ── Version stamp ────────────────────────────────────────────────────────────

/**
 * The version string the running app would print about itself.
 *
 * Read out of the loaded page, not out of `src/version.js` on disk: what the
 * history file has to be keyed on is the build that was measured. They are the
 * same file in this harness and they will not be the day somebody benchmarks a
 * deployed URL.
 */
export function appVersion(page) {
  return page.evaluate(() => ({
    version: typeof VOXAL_VERSION === 'string' ? VOXAL_VERSION : null,
    buildDate: typeof VOXAL_BUILD_DATE === 'string' ? VOXAL_BUILD_DATE : null,
  }));
}

/** The same, from the source tree, for the Node side of the harness. */
export function appVersionFromSource(file = 'src/version.js') {
  try {
    const text = readFileSync(file, 'utf8');
    const version = text.match(/VOXAL_VERSION\s*=\s*'([^']+)'/)?.[1] ?? null;
    const buildDate = text.match(/VOXAL_BUILD_DATE\s*=\s*'([^']+)'/)?.[1] ?? null;
    return { version, buildDate };
  } catch (_) {
    return { version: null, buildDate: null };
  }
}
