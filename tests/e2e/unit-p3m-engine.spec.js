import { test, expect } from './fixtures.js';

// The experimental P3M-Net engine, src/p3m-engine.js.
//
// The real network is not in the repository (78 MB at the smallest; `make
// p3m-assets` converts the official checkpoint locally). So an ONNX-Runtime
// look-alike stands in: a session whose `pha` is a known pattern. What is real:
// the input sizing, the engine choice and its fallback, the WebGPU-to-WASM
// move, the cleanup, the swap under a running camera and the matte going
// through the real Processor. How good P3M-Net's matte is, and how fast, is
// scripts/matting-bench.mjs's job (docs/p3m-evaluation.md).

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { window.__voxalSegStub = true; });
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('segmentation-engine', 'mediapipe');
    // pha: the left half of the picture is the person (1), the right half not;
    // a band of 0.5 down the middle, the transition P3M-Net exists for.
    window.__mkOrtStub = function (opts) {
      opts = opts || {};
      const log = { sessions: [], runs: [], released: 0 };
      class Tensor {
        constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
        dispose() { this.disposed = true; }
      }
      return {
        log,
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
                const [, c, h, w] = feeds.src.dims;
                log.runs.push({ ep, w, h, c, type: feeds.src.type, keys: Object.keys(feeds) });
                const failing = (opts.failRun && opts.failRun.includes(ep)) ||
                  (opts.failAfter !== undefined && log.runs.length > opts.failAfter);
                if (failing) return Promise.reject(new Error(ep + ' run failed'));
                const pha = new Float32Array(w * h);
                for (let y = 0; y < h; y++) {
                  for (let x = 0; x < w; x++) pha[y * w + x] = x < w / 2 - 2 ? 1 : (x < w / 2 + 2 ? 0.5 : 0);
                }
                return Promise.resolve({ pha: new Tensor('float32', pha, [1, 1, h, w]) });
              }
            });
          }
        }
      };
    };
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
  });
});

test.describe('pure helpers', () => {
  test('input sizes keep the aspect, on a 32-pixel grid', async ({ page }) => {
    const r = await page.evaluate(() => [
      P3mEngine._inputSize(1280, 720, 384),
      P3mEngine._inputSize(640, 360, 512),
      P3mEngine._inputSize(720, 1280, 384),
      P3mEngine._inputSize(1920, 1080, 256),
      P3mEngine._inputSize(320, 180, 384),
      P3mEngine._inputSize(4000, 100, 256)
    ]);
    expect(r[0]).toEqual({ width: 384, height: 224 });
    expect(r[1]).toEqual({ width: 512, height: 288 });
    expect(r[2]).toEqual({ width: 224, height: 384 });
    expect(r[3]).toEqual({ width: 256, height: 160 });
    expect(r[4]).toEqual({ width: 384, height: 224 });
    expect(r[5]).toEqual({ width: 256, height: 64 });     // never under the network's 64
    for (const s of r) { expect(s.width % 32).toBe(0); expect(s.height % 32).toBe(0); }
  });

  test('the configuration is read from storage, with safe defaults', async ({ page }) => {
    const r = await page.evaluate(() => {
      const d = P3mEngine.config();
      localStorage.setItem('p3m-size', '512');
      localStorage.setItem('p3m-model', 'fp32');
      localStorage.setItem('p3m-ep', 'wasm');
      const set = P3mEngine.config();
      localStorage.setItem('p3m-size', '99999');
      localStorage.setItem('p3m-model', 'nonsense');
      const bad = P3mEngine.config();
      return { d, set, bad };
    });
    expect(r.d).toMatchObject({ model: 'w16', ep: 'webgpu', size: 384, base: './assets/p3m/' });
    expect(r.set).toMatchObject({ model: 'fp32', ep: 'wasm', size: 512 });
    expect(r.bad).toMatchObject({ model: 'w16', size: 384 });
  });
});

test.describe('the engine choice', () => {
  test('P3M-Net is never chosen unless asked for by name, and the default stays Longpipe', async ({ page }) => {
    const r = await page.evaluate(async () => {
      localStorage.removeItem('segmentation-engine');
      const res = { dflt: VideoEffects.engine(), p3m0: P3mEngine.selected() };
      await VideoEffects.setEngine('p3m');
      res.chosen = [VideoEffects.engine(), localStorage.getItem('segmentation-engine'), RvmEngine.selected()];
      await VideoEffects.setEngine('rvm');
      res.rvm = [VideoEffects.engine(), P3mEngine.selected()];
      await VideoEffects.setEngine('longpipe');
      res.back = [VideoEffects.engine(), localStorage.getItem('segmentation-engine'), P3mEngine.selected()];
      return res;
    });
    expect(r.dflt).toBe('longpipe');
    expect(r.p3m0).toBe(false);
    expect(r.chosen).toEqual(['p3m', 'p3m', false]);
    expect(r.rvm).toEqual(['rvm', false]);
    expect(r.back).toEqual(['longpipe', null, false]);
  });

  test('?segengine=p3m selects it for the visit, and only it', async ({ page }) => {
    await page.goto('/?segengine=p3m');
    const r = await page.evaluate(() => [P3mEngine.selected(), RvmEngine.selected(), LongpipeEngine.selected()]);
    expect(r).toEqual([true, false, 'mediapipe']);
  });

  test('without staged files P3M-Net cannot open', async ({ page }) => {
    const r = await page.evaluate(async () => {
      localStorage.setItem('p3m-assets-url', '/no-p3m-here/');
      try { await P3mEngine.create(null, null); return 'opened'; } catch (e) { return 'rejected'; }
    });
    expect(r).toBe('rejected');
  });

  test('a P3M-Net that cannot start leaves the camera on MediaPipe and says why', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalP3mStub = window.__mkOrtStub({ failCreate: ['webgpu', 'wasm'] });
      localStorage.setItem('segmentation-engine', 'p3m');
      const out = await VideoEffects.wrap(window.__camStream(), 'blur');
      const s = await VideoEffects.engineStats();
      const res = { engine: VideoEffects.engine(), fallback: s.fallback, live: out.getVideoTracks()[0].readyState };
      VideoEffects.stop(out);
      return res;
    });
    expect(r.engine).toBe('mediapipe');
    expect(r.fallback).toContain('create failed');
    expect(r.live).toBe('live');
  });
});

test.describe('the adapter', () => {
  test('one plain float32 input, a 0-255 matte at the input size, the timings recorded', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalP3mStub = window.__mkOrtStub();
      const seg = await P3mEngine.create(null, null);
      const c = document.createElement('canvas'); c.width = 640; c.height = 360;
      c.getContext('2d').fillRect(0, 0, 640, 360);
      const a = await seg.inferFrame(c);
      await seg.inferFrame(c);
      await seg.inferFrame(c);
      const st = await seg.stats();
      seg.close();
      const mid = a.width / 2;
      return { run: window.__voxalP3mStub.log.runs[0], size: [a.width, a.height],
        left: a.data[10], right: a.data[a.width - 10], band: a.data[mid], st,
        released: window.__voxalP3mStub.log.released, bytesKept: seg.modelBytes };
    });
    expect(r.run).toMatchObject({ ep: 'webgpu', w: 384, h: 224, c: 3, type: 'float32', keys: ['src'] });
    expect(r.size).toEqual([384, 224]);
    expect(r.left).toBe(255);
    expect(r.right).toBe(0);
    expect(r.band).toBe(128);                  // the transition survives as a partial value
    expect(r.st).toMatchObject({ engine: 'p3m', model: 'w16', ep: 'webgpu', frames: 3, input: '384x224' });
    expect(r.st.firstRunMs).not.toBeNull();
    expect(r.st.inferMsP50).not.toBeNull();    // runs after the first (the shader compile is not a timing)
    expect(r.released).toBe(1);                // close() releases the session
    expect(r.bytesKept).toBeNull();            // and the model's bytes are not held
  });

  test('a kernel WebGPU cannot run fails the engine at once — no silent move to WASM', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalP3mStub = window.__mkOrtStub({ failRun: ['webgpu'] });
      const seg = await P3mEngine.create(null, null);
      let failed = null;
      seg.onFail = (e) => { failed = e.message; };
      const c = document.createElement('canvas'); c.width = 320; c.height = 180;
      let res = 'resolved';
      try { await seg.inferFrame(c); } catch (e) { res = 'rejected'; }
      seg.close();
      return { res, failed, eps: window.__voxalP3mStub.log.sessions.map((s) => s.ep) };
    });
    expect(r.res).toBe('rejected');
    expect(r.failed).toContain('webgpu run failed');
    expect(r.eps).toEqual(['webgpu']);
  });

  test('no navigator.gpu: refuses (the camera stays on MediaPipe) unless WASM is asked for', async ({ page }) => {
    const r = await page.evaluate(async () => {
      Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
      window.__voxalP3mStub = window.__mkOrtStub();
      let refused = null;
      try { await P3mEngine.create(null, null); } catch (e) { refused = e.message; }
      localStorage.setItem('p3m-ep', 'wasm');
      const seg = await P3mEngine.create(null, null);
      seg.close();
      localStorage.removeItem('p3m-ep');
      localStorage.setItem('segmentation-engine', 'p3m');
      const out = await VideoEffects.wrap(window.__camStream(), 'blur');
      const engine = VideoEffects.engine();
      VideoEffects.stop(out);
      return { refused, eps: window.__voxalP3mStub.log.sessions.map((s) => s.ep), engine };
    });
    expect(r.refused).toContain('needs WebGPU');
    expect(r.eps).toEqual(['wasm']);
    expect(r.engine).toBe('mediapipe');
  });
});

test.describe('through the real Processor', () => {
  test('the matte reaches the GL pipeline uncut, at its own size, not dilated, and blended', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalP3mStub = window.__mkOrtStub();
      localStorage.setItem('segmentation-engine', 'p3m');
      const out = await VideoEffects.wrap(window.__camStream(), 'blur');
      const p = VideoEffects.active();
      for (let i = 0; i < 60 && !(p.segW === 384); i++) await new Promise((res) => setTimeout(res, 50));
      const res = { engine: p.engine, maskCut: p.maskCut, seg: [p.segW, p.segH], dilate: p.edge.dilate,
        live: out.getVideoTracks()[0].readyState };
      await VideoEffects.setEngine('mediapipe');
      res.mp = { engine: VideoEffects.engine(), maskCut: p.maskCut, dilate: p.edge.dilate };
      VideoEffects.stop(out);
      return res;
    });
    expect(r.engine).toBe('p3m');
    expect(r.maskCut).toBe(0);
    expect(r.seg).toEqual([384, 224]);
    expect(r.dilate).toBe(0);
    expect(r.live).toBe('live');
    expect(r.mp.engine).toBe('mediapipe');
    expect(r.mp.maskCut).toBeGreaterThan(0);
    expect(r.mp.dilate).toBeGreaterThan(0);
  });

  test('switching MediaPipe → P3M-Net → MediaPipe keeps the same live track and releases the session', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalP3mStub = window.__mkOrtStub();
      const out = await VideoEffects.wrap(window.__camStream(), 'blur');
      const track = out.getVideoTracks()[0];
      const p = VideoEffects.active();
      const seen = [VideoEffects.engine()];
      await VideoEffects.setEngine('p3m');
      seen.push(VideoEffects.engine());
      for (let i = 0; i < 40 && window.__voxalP3mStub.log.runs.length < 2; i++) await new Promise((res) => setTimeout(res, 50));
      const ran = window.__voxalP3mStub.log.runs.length;
      await VideoEffects.setEngine('mediapipe');
      seen.push(VideoEffects.engine());
      const res = { seen, ran, same: out.getVideoTracks()[0] === track, live: track.readyState,
        released: window.__voxalP3mStub.log.released, processor: VideoEffects.active() === p };
      VideoEffects.stop(out);
      return res;
    });
    expect(r.seen).toEqual(['mediapipe', 'p3m', 'mediapipe']);
    expect(r.ran).toBeGreaterThanOrEqual(2);
    expect(r.same).toBe(true);
    expect(r.live).toBe('live');
    expect(r.released).toBe(1);
    expect(r.processor).toBe(true);
  });

  test('a size change rebuilds the session under the running camera', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalP3mStub = window.__mkOrtStub();
      localStorage.setItem('segmentation-engine', 'p3m');
      const out = await VideoEffects.wrap(window.__camStream(), 'blur');
      const p = VideoEffects.active();
      for (let i = 0; i < 60 && p.segW !== 384; i++) await new Promise((res) => setTimeout(res, 50));
      VideoEffects.setDebug('p3m-size', '256');
      for (let i = 0; i < 60 && p.segW !== 256; i++) await new Promise((res) => setTimeout(res, 50));
      const res = { seg: [p.segW, p.segH], engine: p.engine, sessions: window.__voxalP3mStub.log.sessions.length,
        released: window.__voxalP3mStub.log.released, live: out.getVideoTracks()[0].readyState };
      VideoEffects.stop(out);
      return res;
    });
    expect(r.engine).toBe('p3m');
    expect(r.seg).toEqual([256, 160]);
    expect(r.sessions).toBe(2);
    expect(r.released).toBe(1);
    expect(r.live).toBe('live');
  });

  test('a P3M-Net that dies mid-call hands the camera back to MediaPipe', async ({ page }) => {
    const r = await page.evaluate(async () => {
      // Two good mattes, then every run fails.
      window.__voxalP3mStub = window.__mkOrtStub({ failAfter: 2 });
      localStorage.setItem('segmentation-engine', 'p3m');
      const out = await VideoEffects.wrap(window.__camStream(), 'blur');
      for (let i = 0; i < 100 && VideoEffects.engine() === 'p3m'; i++) await new Promise((res) => setTimeout(res, 50));
      const s = await VideoEffects.engineStats();
      const res = { engine: VideoEffects.engine(), fallback: s.fallback, live: out.getVideoTracks()[0].readyState };
      VideoEffects.stop(out);
      return res;
    });
    expect(r.engine).toBe('mediapipe');
    expect(r.fallback).toContain('run failed');
    expect(r.live).toBe('live');
  });
});
