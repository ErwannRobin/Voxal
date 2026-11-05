import { test, expect } from './fixtures.js';

// The experimental BackgroundMattingV2 engine, src/bgm-engine.js, and the
// Processor's rule for it (syncBgm(): MediaPipe until the empty room has been
// photographed, BackgroundMattingV2 while that picture matches, MediaPipe again
// when it stops matching).
//
// The real network is not in the repository (`make bgm-assets` converts the
// official checkpoint locally). An ONNX-Runtime look-alike stands in: a
// session that records what it was fed (both pictures) and returns a known
// alpha and foreground. How good the real matte is, and how fast, is
// scripts/matting-bench.mjs's job (docs/bgm-evaluation.md).

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { window.__voxalSegStub = true; });
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('segmentation-engine', 'mediapipe');
    // pha: the left half of the picture is the person (1), the right half
    // not, with a band of 0.5 down the middle; fgr: a flat 0.25 grey. With
    // `cover`, the whole picture is "person" (a plate that no longer matches).
    window.__mkOrtStub = function (opts) {
      opts = opts || {};
      const log = { sessions: [], runs: [], released: 0 };
      class Tensor {
        constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
        dispose() { this.disposed = true; }
      }
      const mean = (d, n, c) => { let s = 0; for (let i = 0; i < n; i++) s += d[c * n + i]; return s / n; };
      return {
        log,
        opts,
        env: { wasm: {} },
        Tensor,
        modelBytes: new Uint8Array([1, 2, 3]),
        InferenceSession: {
          create(bytes, o) {
            const ep = o.executionProviders[0];
            log.sessions.push({ ep, size: bytes.length });
            if (opts.failCreate && opts.failCreate.includes(ep)) return Promise.reject(new Error(ep + ' create failed'));
            return Promise.resolve({
              release() { log.released++; },
              run(feeds) {
                const [, c, h, w] = feeds.src.dims, n = w * h;
                const b = feeds.bgr.data;
                log.runs.push({
                  ep, w, h, c, keys: Object.keys(feeds).sort(), bgrDims: feeds.bgr.dims,
                  bgrMean: [mean(b, n, 0), mean(b, n, 1), mean(b, n, 2)],
                  // The far corner's red: a plate clipped by a too-small
                  // canvas reads back black exactly there.
                  bgrCorner: b[n - 1]
                });
                if (opts.failAfter !== undefined && log.runs.length > opts.failAfter) return Promise.reject(new Error(ep + ' run failed'));
                const pha = new Float32Array(n), fgr = new Float32Array(3 * n).fill(0.25);
                for (let y = 0; y < h; y++) {
                  for (let x = 0; x < w; x++) {
                    pha[y * w + x] = opts.cover ? 1 : (x < w / 2 - 2 ? 1 : (x < w / 2 + 2 ? 0.5 : 0));
                  }
                }
                return Promise.resolve({ pha: new Tensor('float32', pha, [1, 1, h, w]), fgr: new Tensor('float32', fgr, [1, 3, h, w]) });
              }
            });
          }
        }
      };
    };
    // The camera: a flat #446 room, a #fc9 "person" in the middle.
    window.__camStream = function () {
      const c = document.createElement('canvas');
      c.width = 320; c.height = 180;
      const x = c.getContext('2d');
      const paint = () => { x.fillStyle = '#446'; x.fillRect(0, 0, 320, 180); x.fillStyle = '#fc9'; x.fillRect(100, 40, 120, 140); };
      paint();
      const s = c.captureStream(15);
      setInterval(paint, 40);
      return s;
    };
    // A plate: w x h of one colour.
    window.__plate = function (w, h, rgb, gain) {
      const rgba = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) { rgba[i * 4] = rgb[0]; rgba[i * 4 + 1] = rgb[1]; rgba[i * 4 + 2] = rgb[2]; rgba[i * 4 + 3] = 255; }
      return { w, h, rgba, gain: gain || [1, 1, 1] };
    };
    window.__waitFor = async function (fn, ms) {
      const t0 = performance.now();
      while (performance.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 30)); }
      return !!fn();
    };
    // An empty room for the reference capture, then somebody back in it.
    window.__captureRoom = async function () {
      window.__voxalSegStub = { empty: true };
      await new Promise((r) => setTimeout(r, 300));
      const r = await VideoEffects.captureReference();
      window.__voxalSegStub = true;
      return r;
    };
  });
});

test.describe('pure helpers', () => {
  test('input sizes keep the aspect on an 8-pixel grid, and never upscale the camera', async ({ page }) => {
    const r = await page.evaluate(() => [
      BgmEngine._inputSize(1280, 720, 640),
      BgmEngine._inputSize(720, 1280, 640),
      BgmEngine._inputSize(1920, 1080, 960),
      BgmEngine._inputSize(320, 180, 640),
      BgmEngine._inputSize(4000, 100, 640)
    ]);
    expect(r[0]).toEqual({ width: 640, height: 360 });
    expect(r[1]).toEqual({ width: 360, height: 640 });
    expect(r[2]).toEqual({ width: 960, height: 544 });
    expect(r[3]).toEqual({ width: 320, height: 184 });   // a 320-wide camera stays 320 wide (180 → the nearest 8)
    expect(r[4]).toEqual({ width: 640, height: 64 });    // never under 64
    for (const s of r) { expect(s.width % 8).toBe(0); expect(s.height % 8).toBe(0); }
  });

  test('the configuration is read from storage, with safe defaults', async ({ page }) => {
    const r = await page.evaluate(() => {
      const d = BgmEngine.config();
      localStorage.setItem('bgm-size', '1280');
      localStorage.setItem('bgm-model', 'fp32');
      localStorage.setItem('bgm-scale', '50');
      localStorage.setItem('bgm-ep', 'wasm');
      const set = BgmEngine.config();
      localStorage.setItem('bgm-size', '99999');
      localStorage.setItem('bgm-model', 'nonsense');
      localStorage.setItem('bgm-scale', '33');
      const bad = BgmEngine.config();
      return { d, set, bad };
    });
    expect(r.d).toMatchObject({ model: 'w16', scale: '25', ep: 'webgpu', size: 640, base: './assets/bgm/' });
    expect(r.set).toMatchObject({ model: 'fp32', scale: '50', ep: 'wasm', size: 1280 });
    expect(r.bad).toMatchObject({ model: 'w16', scale: '25', size: 640 });
  });
});

test.describe('stray islands', () => {
  // A 40x30 matte: the person (a big block touching the bottom edge), a hand
  // coming in at the right edge, a small patch floating in the room, and a
  // second person, large and not touching any edge.
  test('clears small floating islands, keeps the person, a hand at the edge and a second person', async ({ page }) => {
    const r = await page.evaluate(() => {
      const w = 40, h = 30, m = new Uint8Array(w * h);
      const fill = (x0, y0, x1, y1, v) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = v; };
      fill(5, 10, 20, 30, 255);   // the person: 300 px, touches the bottom
      fill(4, 10, 5, 30, 60);     // its soft rim (>= 32: part of the same island)
      fill(36, 2, 40, 5, 255);    // a hand at the right edge: 12 px, touches it
      fill(28, 3, 31, 6, 255);    // a stray patch: 9 px, floating
      fill(24, 12, 34, 24, 200);  // a second person: 120 px, floating, 40% of the first
      fill(26, 26, 27, 27, 20);   // a faint speck under the island level: untouched
      const cleared = BgmEngine._dropStrayIslands(m, w, h);
      const at = (x, y) => m[y * w + x];
      return { cleared, person: at(10, 20), rim: at(4, 15), hand: at(38, 3), stray: at(29, 4), second: at(28, 18), speck: at(26, 26) };
    });
    expect(r).toEqual({ cleared: 9, person: 255, rim: 60, hand: 255, stray: 0, second: 200, speck: 20 });
  });

  test('a matte with one island, or none, is left alone', async ({ page }) => {
    const r = await page.evaluate(() => {
      const one = new Uint8Array(100).fill(0); one[55] = 255;
      const none = new Uint8Array(100);
      return [BgmEngine._dropStrayIslands(one, 10, 10), one[55], BgmEngine._dropStrayIslands(none, 10, 10)];
    });
    expect(r).toEqual([0, 255, 0]);
  });
});

test.describe('the engine choice', () => {
  test('never chosen unless asked for by name; choosing it clears the others', async ({ page }) => {
    const r = await page.evaluate(async () => {
      localStorage.removeItem('segmentation-engine');
      const res = { dflt: VideoEffects.engine(), bgm0: BgmEngine.selected() };
      await VideoEffects.setEngine('bgm');
      res.chosen = [VideoEffects.engine(), localStorage.getItem('segmentation-engine'), P3mEngine.selected(), RvmEngine.selected()];
      await VideoEffects.setEngine('p3m');
      res.p3m = [VideoEffects.engine(), BgmEngine.selected()];
      await VideoEffects.setEngine('longpipe');
      res.back = [VideoEffects.engine(), localStorage.getItem('segmentation-engine'), BgmEngine.selected()];
      return res;
    });
    expect(r.dflt).toBe('longpipe');
    expect(r.bgm0).toBe(false);
    expect(r.chosen).toEqual(['bgm', 'bgm', false, false]);
    expect(r.p3m).toEqual(['p3m', false]);
    expect(r.back).toEqual(['longpipe', null, false]);
  });

  test('?segengine=bgm selects it for the visit, and only it', async ({ page }) => {
    await page.goto('/?segengine=bgm');
    const r = await page.evaluate(() => [BgmEngine.selected(), P3mEngine.selected(), RvmEngine.selected()]);
    expect(r).toEqual([true, false, false]);
  });

  test('without staged files it cannot open', async ({ page }) => {
    const r = await page.evaluate(async () => {
      localStorage.setItem('bgm-assets-url', '/no-bgm-here/');
      try { await BgmEngine.create(null, null); return 'opened'; } catch (e) { return 'rejected'; }
    });
    expect(r).toBe('rejected');
  });
});

test.describe('the adapter', () => {
  test('feeds the camera and the plate as two float32 pictures of the same size', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalBgmStub = window.__mkOrtStub();
      const seg = await BgmEngine.create(null, null);
      const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
      c.getContext('2d').fillRect(0, 0, 1280, 720);
      let noPlate = 'resolved';
      try { await seg.inferFrame(c); } catch (e) { noPlate = e.message; }
      // The app keeps its picture of the room at 640 wide; the engine scales it.
      seg.setPlate(window.__plate(640, 360, [128, 64, 32]));
      const a = await seg.inferFrame(c);
      await seg.inferFrame(c);
      const st = await seg.stats();
      seg.close();
      return { noPlate, run: window.__voxalBgmStub.log.runs[0], size: [a.width, a.height],
        left: a.data[10], right: a.data[a.width - 10], band: a.data[a.width / 2],
        fg: Array.from(a.fg.slice(0, 4)), st, released: window.__voxalBgmStub.log.released };
    });
    expect(r.noPlate).toBe('no plate');
    expect(r.run).toMatchObject({ ep: 'webgpu', w: 640, h: 360, c: 3, keys: ['bgr', 'src'], bgrDims: [1, 3, 360, 640] });
    // The whole plate, corner to corner: not clipped to a default-sized canvas.
    expect(r.run.bgrMean[0]).toBeCloseTo(128 / 255, 2);
    expect(r.run.bgrMean[1]).toBeCloseTo(64 / 255, 2);
    expect(r.run.bgrMean[2]).toBeCloseTo(32 / 255, 2);
    expect(r.run.bgrCorner).toBeCloseTo(128 / 255, 2);
    expect(r.size).toEqual([640, 360]);
    expect([r.left, r.right, r.band]).toEqual([255, 0, 128]);
    expect(r.fg).toEqual([64, 64, 64, 255]);              // the foreground colour comes back as RGBA
    expect(r.st).toMatchObject({ engine: 'bgm', model: 'w16', scale: '25', input: '640x360', plate: '640x360', frames: 2 });
    expect(r.released).toBe(1);
  });

  test('the plate carries the camera\'s gain, and is rebuilt only when it changes', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalBgmStub = window.__mkOrtStub();
      const seg = await BgmEngine.create(null, null);
      const c = document.createElement('canvas'); c.width = 320; c.height = 180;
      const p = window.__plate(320, 180, [100, 100, 100], [1.2, 1, 0.8]);
      seg.setPlate(p);
      await seg.inferFrame(c);
      const t1 = seg.bgr;
      seg.setPlate({ w: p.w, h: p.h, rgba: p.rgba, gain: [1.201, 1, 0.8] });   // the same, to within 0.5%
      await seg.inferFrame(c);
      const same = seg.bgr === t1 && seg.plateSets === 1;
      seg.setPlate({ w: p.w, h: p.h, rgba: p.rgba, gain: [1, 1, 1] });
      await seg.inferFrame(c);
      seg.close();
      return { first: window.__voxalBgmStub.log.runs[0].bgrMean, last: window.__voxalBgmStub.log.runs[2].bgrMean, same };
    });
    expect(r.first[0]).toBeCloseTo(100 / 255 * 1.2, 2);
    expect(r.first[1]).toBeCloseTo(100 / 255, 2);
    expect(r.first[2]).toBeCloseTo(100 / 255 * 0.8, 2);
    expect(r.same).toBe(true);
    expect(r.last[0]).toBeCloseTo(100 / 255, 2);
  });

  test('no WebGPU: refuses rather than run on the main thread, unless WASM is asked for', async ({ page }) => {
    const r = await page.evaluate(async () => {
      Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
      window.__voxalBgmStub = window.__mkOrtStub();
      let refused = null;
      try { await BgmEngine.create(null, null); } catch (e) { refused = e.message; }
      localStorage.setItem('bgm-ep', 'wasm');
      const seg = await BgmEngine.create(null, null);
      seg.close();
      return { refused, eps: window.__voxalBgmStub.log.sessions.map((s) => s.ep) };
    });
    expect(r.refused).toContain('needs WebGPU');
    expect(r.eps).toEqual(['wasm']);
  });
});

test.describe('through the real Processor', () => {
  test('MediaPipe until the empty room is photographed, then BackgroundMattingV2 on that picture', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalBgmStub = window.__mkOrtStub();
      localStorage.setItem('segmentation-engine', 'bgm');
      const out = await VideoEffects.wrap(window.__camStream(), 'blur');
      const p = VideoEffects.active();
      await new Promise((res) => setTimeout(res, 300));
      const before = { engine: p.engine, sessions: window.__voxalBgmStub.log.sessions.length };
      const cap = await window.__captureRoom();
      const switched = await window.__waitFor(() => p.engine === 'bgm' && p.segW === 320, 4000);
      await window.__waitFor(() => window.__voxalBgmStub.log.runs.length >= 2, 3000);
      const run = window.__voxalBgmStub.log.runs[0];
      const res = { before, cap, switched, engine: p.engine, maskCut: p.maskCut, dilate: p.edge.dilate,
        seg: [p.segW, p.segH], fgReady: !!p.fgReady, refSource: p.referenceSource(),
        // What the capture photographed is what the model is handed.
        bgr: run.bgrMean, live: out.getVideoTracks()[0].readyState };
      VideoEffects.stop(out);
      return res;
    });
    expect(r.before).toEqual({ engine: 'mediapipe', sessions: 0 });
    expect(r.cap).toEqual({ ok: true });
    expect(r.switched).toBe(true);
    expect(r.engine).toBe('bgm');
    expect(r.maskCut).toBe(0);
    expect(r.dilate).toBe(0);
    expect(r.seg).toEqual([320, 184]);
    expect(r.fgReady).toBe(true);                 // its foreground colour reaches the composite
    expect(r.refSource).toBeNull();               // the cruder reference pass stands down
    // The picture the capture took: the #446 room with the camera's #fc9
    // block (120x140 of 320x180) in it — what the camera saw, averaged.
    const f = (120 * 140) / (320 * 180);
    expect(r.bgr[0]).toBeCloseTo((0x44 * (1 - f) + 0xff * f) / 255, 1);
    expect(r.bgr[2]).toBeCloseTo((0x66 * (1 - f) + 0x99 * f) / 255, 1);
    expect(r.live).toBe('live');
  });

  test('a stale picture, a new capture or the reference switched off hands the camera back to MediaPipe', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalBgmStub = window.__mkOrtStub();
      localStorage.setItem('segmentation-engine', 'bgm');
      const out = await VideoEffects.wrap(window.__camStream(), 'blur');
      const p = VideoEffects.active();
      await window.__captureRoom();
      const res = { up: await window.__waitFor(() => p.engine === 'bgm', 4000) };
      // The camera moved: the reference statistics call the picture stale.
      p.refStale = true; p.emitReference();
      res.stale = await window.__waitFor(() => p.engine === 'mediapipe', 4000);
      p.refStale = false; p.emitReference();
      res.fresh = await window.__waitFor(() => p.engine === 'bgm', 4000);
      // A new picture is being taken: MediaPipe decides whether the room is empty.
      window.__voxalSegStub = { empty: true };
      const again = VideoEffects.captureReference();
      res.capturing = await window.__waitFor(() => p.engine === 'mediapipe', 4000);
      res.again = await again;
      window.__voxalSegStub = true;
      res.afterCapture = await window.__waitFor(() => p.engine === 'bgm', 4000);
      VideoEffects.setReference(false);
      res.off = await window.__waitFor(() => p.engine === 'mediapipe', 4000);
      res.live = out.getVideoTracks()[0].readyState;
      res.released = window.__voxalBgmStub.log.released;
      VideoEffects.stop(out);
      return res;
    });
    expect(r).toMatchObject({ up: true, stale: true, fresh: true, capturing: true, again: { ok: true },
                              afterCapture: true, off: true, live: 'live' });
    expect(r.released).toBeGreaterThanOrEqual(3);
  });

  test('a matte that covers the whole picture is a stale plate, not a person: back to MediaPipe, held off', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalBgmStub = window.__mkOrtStub({ cover: true });
      localStorage.setItem('segmentation-engine', 'bgm');
      const out = await VideoEffects.wrap(window.__camStream(), 'blur');
      const p = VideoEffects.active();
      await window.__captureRoom();
      const up = await window.__waitFor(() => p.engine === 'bgm', 4000);
      const back = await window.__waitFor(() => p.engine === 'mediapipe', 5000);
      const res = { up, back, stale: p.refStale, held: p.bgmHoldUntil > performance.now(),
                    live: out.getVideoTracks()[0].readyState };
      // The room still matches, but the engine is held off: no flapping.
      p.refStale = false; p.emitReference();
      await new Promise((res2) => setTimeout(res2, 500));
      res.stillMp = p.engine === 'mediapipe';
      VideoEffects.stop(out);
      return res;
    });
    expect(r).toEqual({ up: true, back: true, stale: true, held: true, live: 'live', stillMp: true });
  });

  test('a BackgroundMattingV2 that cannot start leaves MediaPipe running and is not retried on every update', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalBgmStub = window.__mkOrtStub({ failCreate: ['webgpu', 'wasm'] });
      localStorage.setItem('segmentation-engine', 'bgm');
      const out = await VideoEffects.wrap(window.__camStream(), 'blur');
      const p = VideoEffects.active();
      await window.__captureRoom();
      await new Promise((res) => setTimeout(res, 1500));   // several reference updates
      const s = await VideoEffects.engineStats();
      const res = { engine: p.engine, gaveUp: p.bgmGaveUp, tries: window.__voxalBgmStub.log.sessions.length,
                    fallback: s.fallback, live: out.getVideoTracks()[0].readyState };
      VideoEffects.stop(out);
      return res;
    });
    expect(r.engine).toBe('mediapipe');
    expect(r.gaveUp).toBe(true);
    expect(r.tries).toBe(1);
    expect(r.fallback).toContain('create failed');
    expect(r.live).toBe('live');
  });
});
