// PROTOTYPE probe (docs/apple-vision-evaluation.md): what the webview -> Rust ->
// Apple Vision -> webview round trip costs, in the real Tauri app.
//
// Inert unless the app was started with VOXAL_VISION_BENCH=<path to a JPEG
// frame> (`vision_bench_frame` answers "off" otherwise), so it costs one failed
// IPC call at startup on the desktop app and nothing anywhere else. It is not
// part of the product: remove it once the bridge is built for real.
(function () {
  'use strict';
  var invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
  if (!invoke) return;

  function pct(a, p) {
    var s = a.slice().sort(function (x, y) { return x - y; });
    return s[Math.min(s.length - 1, Math.floor(s.length * p))];
  }
  function stat(a) {
    var m = a.reduce(function (x, y) { return x + y; }, 0) / a.length;
    return m.toFixed(1) + ' (p95 ' + pct(a, 0.95).toFixed(1) + ')';
  }
  function say(t) { try { console.log('[vision-bench] ' + t); } catch (e) {} return invoke('vision_bench_report', { text: t }); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function round(ctx, bmp, w, h) {
    var t0 = performance.now();
    ctx.drawImage(bmp, 0, 0, w, h);
    var px = ctx.getImageData(0, 0, w, h).data;               // RGBA8, what a video frame becomes
    var t1 = performance.now();
    var buf = await invoke('vision_foreground_mask', new Uint8Array(px.buffer, px.byteOffset, px.byteLength),
      { headers: { 'x-width': String(w), 'x-height': String(h) } });
    var t2 = performance.now();
    var dv = new DataView(buf);
    var mw = dv.getUint16(0, true), mh = dv.getUint16(2, true);
    var m = new Uint8Array(buf, 12);
    var on = 0;
    for (var i = 0; i < m.length; i++) if (m[i] > 127) on++;
    var t3 = performance.now();
    return {
      capture: t1 - t0, invoke: t2 - t1, read: t3 - t2,
      vision: dv.getUint32(4, true) / 1000, rust: dv.getUint32(8, true) / 1000,
      mw: mw, mh: mh, cover: m.length ? on / m.length : 0, mbytes: buf.byteLength
    };
  }

  function setup(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c.getContext('2d', { willReadFrequently: true });
  }

  async function backToBack(bmp, w, h) {
    var ctx = setup(w, h);
    var i;
    for (i = 0; i < 8; i++) await round(ctx, bmp, w, h);      // model load and warm-up

    // 1. back to back: the best latency a frame can have
    var A = { capture: [], invoke: [], read: [], vision: [], rust: [] }, last;
    for (i = 0; i < 150; i++) {
      last = await round(ctx, bmp, w, h);
      for (var k in A) A[k].push(last[k]);
    }
    var total = A.capture.map(function (v, j) { return v + A.invoke[j] + A.read[j]; });
    var overhead = A.invoke.map(function (v, j) { return v - A.rust[j]; });
    await say(w + 'x' + h + ' back-to-back (ms, mean (p95)): total ' + stat(total) +
      ' | capture ' + stat(A.capture) + ' | invoke ' + stat(A.invoke) + ' | of which Vision ' + stat(A.vision) +
      ', Rust ' + stat(A.rust) + ', IPC+copies ' + stat(overhead) + ' | read ' + stat(A.read) +
      ' | mask ' + last.mw + 'x' + last.mh + ' (' + last.mbytes + ' B), ' + (last.cover * 100).toFixed(0) + '% person');

  }

  // paced at 30 Hz, with a 4 ms timer watching for main-thread stalls
  async function paced(bmp, w, h) {
    var ctx = setup(w, h);
    for (var i = 0; i < 8; i++) await round(ctx, bmp, w, h);
    if (document.hidden) { await say(w + 'x' + h + ' paced 30 Hz: skipped, the window is hidden (its timers are frozen)'); return; }
    var lag = [], prev = performance.now();
    var watch = setInterval(function () { var n = performance.now(); lag.push(n - prev - 4); prev = n; }, 4);
    var done = 0, late = 0, inflight = false, ticks = 0, tt = [];
    var t = setInterval(async function () {
      ticks++;
      if (inflight) { late++; return; }                          // a frame is still out: skip, as the pipeline would
      inflight = true;
      var s = performance.now();
      try { await round(ctx, bmp, w, h); done++; tt.push(performance.now() - s); } finally { inflight = false; }
    }, 1000 / 30);
    await sleep(10000);
    clearInterval(t); clearInterval(watch);
    await sleep(200);
    await say(w + 'x' + h + ' paced 30 Hz, 10 s: ' + done + ' masks, ' + late + ' ticks skipped of ' + ticks +
      ' | round trip ' + stat(tt) + ' ms | main-thread timer lag p50 ' + pct(lag, 0.5).toFixed(1) +
      ' p95 ' + pct(lag, 0.95).toFixed(1) + ' max ' + Math.max.apply(null, lag).toFixed(1) + ' ms');
  }

  (async function () {
    var jpeg;
    try { jpeg = await invoke('vision_bench_frame'); } catch (e) { return; }   // "off": the usual case
    try {
      // A backgrounded or occluded WKWebView freezes its timers, which stalls the paced run:
      // bring the window forward first.
      try { await window.__TAURI__.window.getCurrentWindow().setFocus(); } catch (e) { /* best effort */ }
      await say('start, visibility ' + document.visibilityState + ', frame ' + (jpeg.byteLength || jpeg.length) + ' B, ' + navigator.userAgent);
      var bmp = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
      var sizes = [[256, 144], [512, 288], [640, 360]];
      for (var s of sizes) await backToBack(bmp, s[0], s[1]);
      for (var s2 of sizes) await paced(bmp, s2[0], s2[1]);
      await say('done');
    } catch (e) {
      await say('failed: ' + (e && e.message || e));
    }
  })();
})();
