import { test, expect } from './fixtures.js';

// The experimental RVM (Robust Video Matting) engine, src/rvm-engine.js.
//
// The real network cannot run here: its weights are GPL-3.0 and never in the
// repository (make rvm-assets stages them locally for the matting bench). So an
// ONNX-Runtime look-alike stands in: a session whose `pha` is a known pattern
// and whose recurrent outputs are tagged, so the feedback can be followed.
// What is real: the input sizing, the half-float conversion, the ceil_mode
// patch, the recurrent state, the engine choice and its fallback, and the mask
// going through the real Processor. How good RVM's matte is, and how fast, is
// scripts/matting-bench.mjs's job (docs/matting-evaluation.md).

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { window.__voxalSegStub = true; });
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('segmentation-engine', 'mediapipe');
    // pha: the left half of the picture is the person (1), the right half not.
    window.__mkOrtStub = function (opts) {
      opts = opts || {};
      const log = { sessions: [], runs: [] };
      class Tensor {
        constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
        dispose() { this.disposed = true; }
      }
      const ort = {
        log,
        env: { wasm: {} },
        Tensor,
        modelBytes: opts.modelBytes || new Uint8Array([1, 2, 3]),
        InferenceSession: {
          create(bytes, o) {
            const ep = o.executionProviders[0];
            log.sessions.push({ ep, bytes: Array.from(bytes) });
            if (opts.failCreate && opts.failCreate.includes(ep)) return Promise.reject(new Error(ep + ' create failed'));
            let n = 0;
            return Promise.resolve({
              release() { this.released = true; },
              run(feeds) {
                const [, , h, w] = feeds.src.dims;
                log.runs.push({ ep, w, h, ratio: feeds.downsample_ratio.data[0], r1: feeds.r1i.tag || 'zero', srcType: feeds.src.type });
                if (opts.failRun && opts.failRun.includes(ep)) return Promise.reject(new Error(ep + ' run failed'));
                const half = feeds.src.type === 'float16';
                const pha = half ? new Uint16Array(w * h) : new Float32Array(w * h);
                const one = half ? 0x3c00 : 1;
                for (let y = 0; y < h; y++) for (let x = 0; x < w / 2; x++) pha[y * w + x] = one;
                const fgr = half ? new Uint16Array(3 * w * h) : new Float32Array(3 * w * h);
                const at = n++;
                const rec = (k) => { const t = new Tensor('float32', new Float32Array(1), [1, 1, 1, 1]); t.tag = ep + ':' + k + ':' + at; return t; };
                return Promise.resolve({ pha: new Tensor(pha, pha, [1, 1, h, w]), fgr: new Tensor(fgr, fgr, [1, 3, h, w]),
                  r1o: rec('r1'), r2o: rec('r2'), r3o: rec('r3'), r4o: rec('r4') });
              }
            });
          }
        }
      };
      return ort;
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
  test('input sizes keep the aspect and stay a multiple of 16 after the downsample', async ({ page }) => {
    const r = await page.evaluate(() => [
      RvmEngine._inputSize(1280, 720, 512, 1),
      RvmEngine._inputSize(640, 360, 512, 1),
      RvmEngine._inputSize(1280, 720, 1280, 0.4),
      RvmEngine._inputSize(720, 1280, 512, 1),
      RvmEngine._autoRatio(512), RvmEngine._autoRatio(1280)
    ]);
    expect(r[0]).toEqual({ width: 512, height: 288 });
    expect(r[1]).toEqual({ width: 512, height: 288 });
    expect(r[2]).toEqual({ width: 1280, height: 720 });
    expect(r[3]).toEqual({ width: 288, height: 512 });
    expect(r[4]).toBe(1);
    expect(r[5]).toBeCloseTo(0.4, 6);
    for (const s of [r[0], r[2], r[3]]) {
      const ratio = s === r[2] ? 0.4 : 1;
      expect((s.width * ratio) % 16).toBeCloseTo(0, 6);
      expect((s.height * ratio) % 16).toBeCloseTo(0, 6);
    }
  });

  test('half floats round-trip what a picture holds', async ({ page }) => {
    const r = await page.evaluate(() => [0, 1, 0.5, 0.25, 1 / 255, 0.7843].map((v) => [v, RvmEngine._fromHalf(RvmEngine._toHalf(v))]));
    for (const [v, back] of r) expect(Math.abs(v - back)).toBeLessThan(Math.max(1e-3, v * 1e-3));
    expect(await page.evaluate(() => RvmEngine._toHalf(1))).toBe(0x3c00);
  });

  test('the ceil_mode patch flips exactly the AveragePool flags that are set', async ({ page }) => {
    const r = await page.evaluate(() => {
      const enc = (s) => Array.from(new TextEncoder().encode(s));
      const attr = (v) => [0x0a, 0x09, ...enc('ceil_mode'), 0x18, v, 0xa0, 0x01, 0x02];
      const other = [0x0a, 0x07, ...enc('strides'), 0x18, 0x01];
      const bytes = new Uint8Array([7, 7, ...attr(1), 9, ...attr(0), ...other, ...attr(1), 7]);
      const before = Array.from(bytes);
      const n = RvmEngine._patchCeilMode(bytes);
      return { n, before, after: Array.from(bytes) };
    });
    expect(r.n).toBe(2);
    const changed = r.before.map((b, i) => (b !== r.after[i] ? i : -1)).filter((i) => i >= 0);
    expect(changed.length).toBe(2);
    for (const i of changed) { expect(r.before[i]).toBe(1); expect(r.after[i]).toBe(0); }
  });
});

test.describe('the engine choice', () => {
  test('RVM is never chosen unless asked for by name, and asking does not disturb Longpipe\'s default', async ({ page }) => {
    const r = await page.evaluate(async () => {
      localStorage.removeItem('segmentation-engine');
      const res = { dflt: VideoEffects.engine(), rvm0: RvmEngine.selected() };
      await VideoEffects.setEngine('rvm');
      res.chosen = [VideoEffects.engine(), localStorage.getItem('segmentation-engine')];
      await VideoEffects.setEngine('longpipe');
      res.back = [VideoEffects.engine(), localStorage.getItem('segmentation-engine'), RvmEngine.selected()];
      await VideoEffects.setEngine('mediapipe');
      res.mp = [VideoEffects.engine(), localStorage.getItem('segmentation-engine')];
      return res;
    });
    expect(r.dflt).toBe('longpipe');
    expect(r.rvm0).toBe(false);
    expect(r.chosen).toEqual(['rvm', 'rvm']);
    expect(r.back).toEqual(['longpipe', null, false]);
    expect(r.mp).toEqual(['mediapipe', 'mediapipe']);
  });

  test('without staged weights RVM cannot open', async ({ page }) => {
    const r = await page.evaluate(async () => {
      localStorage.setItem('rvm-assets-url', '/no-rvm-here/');
      try { await RvmEngine.create(null, null); return 'opened'; } catch (e) { return 'rejected'; }
    });
    expect(r).toBe('rejected');
  });

  test('an RVM that cannot start leaves the camera on MediaPipe and says why', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalRvmStub = window.__mkOrtStub({ failCreate: ['webgpu', 'wasm'] });
      localStorage.setItem('segmentation-engine', 'rvm');
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
  test('feeds the recurrent state back, frame after frame, and starts afresh for a new source', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalRvmStub = window.__mkOrtStub();
      const seg = await RvmEngine.create(null, null);
      const c = document.createElement('canvas'); c.width = 640; c.height = 360;
      c.getContext('2d').fillRect(0, 0, 640, 360);
      const a = await seg.inferFrame(c);
      await seg.inferFrame(c);
      seg.setSource();
      await seg.inferFrame(c);
      const st = await seg.stats();
      seg.close();
      return { runs: window.__voxalRvmStub.log.runs, size: [a.width, a.height], left: a.data[10], right: a.data[a.width - 10], st };
    });
    expect(r.runs.map((x) => x.r1)).toEqual(['zero', 'webgpu:r1:0', 'zero']);
    expect(r.runs[0]).toMatchObject({ w: 512, h: 288, ratio: 1, srcType: 'float32' });
    expect(r.size).toEqual([512, 288]);
    expect(r.left).toBe(255);
    expect(r.right).toBe(0);
    expect(r.st).toMatchObject({ engine: 'rvm', model: 'mobilenetv3_fp32', frames: 3, input: '512x288' });
  });

  test('WebGPU gets the ceil_mode-patched model; a kernel it cannot run moves it to WASM once', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const enc = (s) => Array.from(new TextEncoder().encode(s));
      const model = new Uint8Array([0x0a, 0x09, ...enc('ceil_mode'), 0x18, 0x01]);
      window.__voxalRvmStub = window.__mkOrtStub({ modelBytes: model, failRun: ['webgpu'] });
      const seg = await RvmEngine.create(null, null);
      const c = document.createElement('canvas'); c.width = 320; c.height = 180;
      const m = await seg.inferFrame(c);
      const st = await seg.stats();
      seg.close();
      const log = window.__voxalRvmStub.log;
      return { eps: log.sessions.map((s) => [s.ep, s.bytes[s.bytes.length - 1]]), runs: log.runs.map((x) => x.ep), ok: !!m, st };
    });
    // The patched copy went to WebGPU, the original to WASM.
    expect(r.eps).toEqual([['webgpu', 0], ['wasm', 1]]);
    expect(r.runs).toEqual(['webgpu', 'wasm']);
    expect(r.ok).toBe(true);
    expect(r.st.ep).toBe('wasm');
  });

  test('the fp16 models are fed and read in half floats', async ({ page }) => {
    const r = await page.evaluate(async () => {
      localStorage.setItem('rvm-model', 'mobilenetv3_fp16');
      window.__voxalRvmStub = window.__mkOrtStub();
      const seg = await RvmEngine.create(null, null);
      const c = document.createElement('canvas'); c.width = 320; c.height = 180;
      const m = await seg.inferFrame(c);
      seg.close();
      return { type: window.__voxalRvmStub.log.runs[0].srcType, left: m.data[5], right: m.data[m.width - 5] };
    });
    expect(r).toEqual({ type: 'float16', left: 255, right: 0 });
  });
});

test.describe('through the real Processor', () => {
  test('the matte reaches the GL pipeline uncut, at its own size, with a matte\'s edge', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalRvmStub = window.__mkOrtStub();
      localStorage.setItem('segmentation-engine', 'rvm');
      const out = await VideoEffects.wrap(window.__camStream(), 'blur');
      const p = VideoEffects.active();
      for (let i = 0; i < 60 && !(p.segW === 512); i++) await new Promise((res) => setTimeout(res, 50));
      const res = { engine: p.engine, maskCut: p.maskCut, seg: [p.segW, p.segH], dilate: p.edge.dilate,
        live: out.getVideoTracks()[0].readyState };
      await VideoEffects.setEngine('mediapipe');
      res.mp = { engine: VideoEffects.engine(), maskCut: p.maskCut, dilate: p.edge.dilate };
      VideoEffects.stop(out);
      return res;
    });
    expect(r.engine).toBe('rvm');
    expect(r.maskCut).toBe(0);
    expect(r.seg).toEqual([512, 288]);
    expect(r.dilate).toBeLessThan(r.mp.dilate);
    expect(r.live).toBe('live');
    expect(r.mp.engine).toBe('mediapipe');
    expect(r.mp.maskCut).toBeGreaterThan(0);
  });
});
