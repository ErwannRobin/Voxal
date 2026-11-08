import { test, expect } from './fixtures.js';

// The matting lab, src/lab-engine.js: one engine that runs any candidate model
// of its registry (docs/matting-candidates.md).
//
// No candidate is in the repository (`make lab-assets` downloads and converts
// them locally, some under licences Voxal cannot ship). So an ONNX-Runtime
// look-alike stands in: a session whose output is a known pattern in the
// layout the chosen candidate declares. What is real: the input sizing and
// normalisation, the half-float path, the four output decodings, the engine
// choice and its fallback, the matte-or-segmentation treatment in the real
// Processor, the model swap under a running camera. How good each candidate
// is, and how fast, is scripts/matting-bench.mjs's job.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { window.__voxalSegStub = true; });
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('segmentation-engine', 'mediapipe');
    // out(w, h): the value at each pixel of the model's own output, in the
    // layout it returns. Default: the left half is the person.
    window.__mkLabOrt = function (opts) {
      opts = opts || {};
      const log = { sessions: [], runs: [], released: 0 };
      class Tensor {
        constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
        dispose() { this.disposed = true; }
      }
      const out = opts.out || ((w, h) => {
        const a = new Float32Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = x < w / 2 ? 1 : 0;
        return { data: a, dims: [1, 1, h, w], type: 'float32' };
      });
      return {
        log,
        env: { wasm: {} },
        Tensor,
        modelBytes: new Uint8Array([1, 2, 3]),
        InferenceSession: {
          create(bytes, o) {
            const ep = o.executionProviders[0];
            log.sessions.push({ ep });
            return Promise.resolve({
              inputNames: [opts.inName || 'input'],
              outputNames: [opts.outName || 'output'],
              inputMetadata: [{ name: opts.inName || 'input', type: opts.inType || 'float32' }],
              release() { log.released++; },
              run(feeds) {
                const k = Object.keys(feeds)[0], t = feeds[k];
                const [, c, h, w] = t.dims;
                log.runs.push({ ep, key: k, w, h, c, type: t.type, first: Array.from(t.data.slice(0, 3)) });
                if (opts.failAfter !== undefined && log.runs.length > opts.failAfter) return Promise.reject(new Error(ep + ' run failed'));
                const o2 = out(w, h);
                const r = {};
                r[opts.outName || 'output'] = new Tensor(o2.type, o2.data, o2.dims);
                return Promise.resolve(r);
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
      const paint = () => { x.fillStyle = '#808080'; x.fillRect(0, 0, 320, 180); };
      paint();
      const s = c.captureStream(15);
      setInterval(paint, 40);
      return s;
    };
    window.__grey = function (w, h) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const x = c.getContext('2d');
      x.fillStyle = 'rgb(255,0,0)'; x.fillRect(0, 0, w, h);
      return c;
    };
  });
});

test.describe('pure helpers', () => {
  test('input sizes: the frame\'s aspect on a grid, or the model\'s fixed size', async ({ page }) => {
    const r = await page.evaluate(() => {
      const M = LabEngine.MODELS;
      return [
        LabEngine._inputSize(M.modnet, 1280, 720),
        LabEngine._inputSize(M.modnet, 1280, 720, 384),
        LabEngine._inputSize(M.sghm, 1280, 720),
        LabEngine._inputSize(M['pphs-v2-lite'], 1280, 720),
        LabEngine._inputSize(M['ppmatting-v2'], 640, 360),
        LabEngine._inputSize(M.modnet, 720, 1280)
      ];
    });
    expect(r[0]).toEqual({ width: 512, height: 288 });
    expect(r[1]).toEqual({ width: 384, height: 224 });
    expect(r[2]).toEqual({ width: 768, height: 448 });   // SGHM: a 64-pixel grid
    expect(r[3]).toEqual({ width: 256, height: 144 });
    expect(r[4]).toEqual({ width: 512, height: 512 });
    expect(r[5]).toEqual({ width: 288, height: 512 });
  });

  test('half floats round-trip what a network is fed', async ({ page }) => {
    const r = await page.evaluate(() => [0, 1, -1, 0.5, 2.1179, -2.1179, 0.0001, 65504, 1e6]
      .map((v) => LabEngine._fromHalf(LabEngine._toHalf(v))));
    expect(r[0]).toBe(0);
    expect(r[1]).toBe(1);
    expect(r[2]).toBe(-1);
    expect(r[3]).toBe(0.5);
    expect(Math.abs(r[4] - 2.1179)).toBeLessThan(2e-3);
    expect(Math.abs(r[5] + 2.1179)).toBeLessThan(2e-3);
    expect(Math.abs(r[6] - 0.0001)).toBeLessThan(1e-5);
    expect(r[7]).toBe(65504);
    expect(r[8]).toBe(Infinity);
  });

  test('the model is chosen by storage or the URL, with a safe default', async ({ page }) => {
    const r = await page.evaluate(() => {
      const d = LabEngine.config();
      localStorage.setItem('lab-model', 'sghm');
      localStorage.setItem('lab-size', '1024');
      const s = LabEngine.config();
      localStorage.setItem('lab-model', 'no-such-model');
      localStorage.setItem('lab-size', '99999');
      const bad = LabEngine.config();
      return { d: [d.model, d.size, d.ep, d.base], s: [s.model, s.size], bad: [bad.model, bad.size] };
    });
    expect(r.d).toEqual(['modnet', null, 'webgpu', './assets/lab/']);
    expect(r.s).toEqual(['sghm', 1024]);
    expect(r.bad).toEqual(['modnet', null]);
  });
});

test.describe('one inference', () => {
  test('the input is normalised as the candidate asks, NCHW', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const res = {};
      for (const m of ['modnet', 'sghm', 'birefnet-lite']) {
        window.__voxalLabStub = window.__mkLabOrt();
        localStorage.setItem('lab-model', m);
        const seg = await LabEngine.create(null, null);
        await seg.inferFrame(window.__grey(64, 36));
        const run = window.__voxalLabStub.log.runs[0];
        res[m] = { first: run.first.map((v) => Math.round(v * 1000) / 1000), c: run.c, type: run.type };
        seg.close();
      }
      return res;
    });
    // A red picture: R = 1 in the first plane.
    expect(r.modnet.first).toEqual([1, 1, 1]);                          // (1 - 0.5) / 0.5
    expect(r.sghm.first).toEqual([1, 1, 1]);                            // 0-1 as is
    expect(r['birefnet-lite'].first).toEqual([2.249, 2.249, 2.249]);   // ImageNet
    expect(r.modnet.c).toBe(3);
    expect(r.modnet.type).toBe('float32');
  });

  test('a float16 graph is fed half floats', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalLabStub = window.__mkLabOrt({ inType: 'float16' });
      const seg = await LabEngine.create(null, null);
      await seg.inferFrame(window.__grey(64, 36));
      const run = window.__voxalLabStub.log.runs[0];
      seg.close();
      return { type: run.type, first: run.first.map((h) => LabEngine._fromHalf(h)) };
    });
    expect(r.type).toBe('float16');
    expect(r.first).toEqual([1, 1, 1]);
  });

  test('each output kind decodes to the same matte', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const left = (w, h, v1, v0) => {
        const a = new Float32Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = x < w / 2 ? v1 : v0;
        return a;
      };
      const cases = {
        modnet: (w, h) => ({ data: left(w, h, 1, 0), dims: [1, 1, h, w], type: 'float32' }),
        'birefnet-lite': (w, h) => ({ data: left(w, h, 20, -20), dims: [1, 1, h, w], type: 'float32' }),
        'rmbg-1.4': (w, h) => ({ data: left(w, h, 0.7, 0.2), dims: [1, 1, h, w], type: 'float32' }),
        'pphs-v2-lite': (w, h) => {
          const a = new Float32Array(2 * w * h);
          a.set(left(w, h, 0, 1), 0);           // channel 0: background
          a.set(left(w, h, 1, 0), w * h);       // channel 1: the person
          return { data: a, dims: [1, 2, h, w], type: 'float32' };
        }
      };
      const res = {};
      for (const m of Object.keys(cases)) {
        window.__voxalLabStub = window.__mkLabOrt({ out: cases[m] });
        localStorage.setItem('lab-model', m);
        const seg = await LabEngine.create(null, null);
        const out = await seg.inferFrame(window.__grey(320, 180));
        res[m] = { w: out.width, h: out.height, l: out.data[0], r: out.data[out.width - 1] };
        seg.close();
      }
      return res;
    });
    for (const m of Object.keys(r)) {
      expect(r[m].l, m).toBe(255);
      expect(r[m].r, m).toBe(0);
    }
    expect([r['pphs-v2-lite'].w, r['pphs-v2-lite'].h]).toEqual([256, 144]);
    expect([r.modnet.w, r.modnet.h]).toEqual([512, 288]);
  });

  test('no navigator.gpu: refuses, and the camera stays on MediaPipe', async ({ page }) => {
    const r = await page.evaluate(async () => {
      Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
      window.__voxalLabStub = window.__mkLabOrt();
      let refused = null;
      try { await LabEngine.create(null, null); } catch (e) { refused = e.message; }
      localStorage.setItem('segmentation-engine', 'lab');
      const out = await VideoEffects.wrap(window.__camStream(), 'blur');
      const engine = VideoEffects.engine();
      VideoEffects.stop(out);
      return { refused, engine };
    });
    expect(r.refused).toContain('needs WebGPU');
    expect(r.engine).toBe('mediapipe');
  });
});

test.describe('through the real Processor', () => {
  test('a matting candidate is uncut and undilated; a segmentation candidate gets MediaPipe\'s cut', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const res = {};
      const want = { modnet: 512, 'pphs-v2-lite': 256 };
      for (const m of ['modnet', 'pphs-v2-lite']) {
        window.__voxalLabStub = window.__mkLabOrt();
        localStorage.setItem('segmentation-engine', 'lab');
        localStorage.setItem('lab-model', m);
        const out = await VideoEffects.wrap(window.__camStream(), 'blur');
        const p = VideoEffects.active();
        for (let i = 0; i < 60 && (p.segW !== want[m] || !window.__voxalLabStub.log.runs.length); i++) await new Promise((ok) => setTimeout(ok, 50));
        res[m] = { engine: p.engine, maskCut: p.maskCut, seg: [p.segW, p.segH], dilate: p.edge.dilate };
        VideoEffects.stop(out);
      }
      return res;
    });
    expect(r.modnet.engine).toBe('lab');
    expect(r.modnet.maskCut).toBe(0);
    expect(r.modnet.dilate).toBe(0);
    expect(r.modnet.seg).toEqual([512, 288]);
    expect(r['pphs-v2-lite'].engine).toBe('lab');
    expect(r['pphs-v2-lite'].maskCut).toBeGreaterThan(0);
    expect(r['pphs-v2-lite'].dilate).toBeGreaterThan(0);
    expect(r['pphs-v2-lite'].seg).toEqual([256, 144]);
  });

  test('a model change rebuilds the session under the running camera', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalLabStub = window.__mkLabOrt();
      localStorage.setItem('segmentation-engine', 'lab');
      const out = await VideoEffects.wrap(window.__camStream(), 'blur');
      const p = VideoEffects.active();
      for (let i = 0; i < 60 && p.segW !== 512; i++) await new Promise((ok) => setTimeout(ok, 50));
      VideoEffects.setDebug('lab-model', 'pphs-v2-lite');
      for (let i = 0; i < 60 && p.segW !== 256; i++) await new Promise((ok) => setTimeout(ok, 50));
      const res = { seg: [p.segW, p.segH], engine: p.engine, maskCut: p.maskCut,
        sessions: window.__voxalLabStub.log.sessions.length, released: window.__voxalLabStub.log.released,
        live: out.getVideoTracks()[0].readyState };
      VideoEffects.stop(out);
      return res;
    });
    expect(r.engine).toBe('lab');
    expect(r.seg).toEqual([256, 144]);
    expect(r.sessions).toBe(2);
    expect(r.released).toBe(1);
    expect(r.live).toBe('live');
  });

  test('a candidate that dies mid-call hands the camera back to MediaPipe', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalLabStub = window.__mkLabOrt({ failAfter: 2 });
      localStorage.setItem('segmentation-engine', 'lab');
      const out = await VideoEffects.wrap(window.__camStream(), 'blur');
      for (let i = 0; i < 100 && VideoEffects.engine() === 'lab'; i++) await new Promise((ok) => setTimeout(ok, 50));
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
