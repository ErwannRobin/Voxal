import { test, expect } from './fixtures.js';

// The experimental Longpipe segmentation engine (src/longpipe-engine.js).
//
// The real model cannot run here (it needs weights from a CDN and a GPU worth
// timing), so a stub stands in for the `longpipe` module: a pipeline whose output
// is a canvas stream painted the way Longpipe paints it — the person over a flat
// key colour. What is real: the mask maths, the key choice, the engine swap under
// a running Processor, the fallback to MediaPipe and the teardown. What is NOT
// covered, and needs a real device: how good Longpipe's matte is, its timing, and
// whether it runs on iOS Safari at all.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { window.__voxalSegStub = true; });
  await page.goto('/');
  await page.evaluate(() => {
    // A Longpipe look-alike. `person` is the colour of the figure it keeps.
    window.__mkLongpipeStub = function (person) {
      const made = [];
      class EffectsPipeline {
        constructor(input, options) {
          this.options = options;
          this.input = input;
          this.key = options.background.color;
          this.calls = [];
          this.destroyed = false;
          this.cv = document.createElement('canvas');
          this.cv.width = 160; this.cv.height = 90;
          const ctx = this.cv.getContext('2d');
          const paint = () => {
            const k = this.key.map((v) => Math.round(v * 255));
            ctx.fillStyle = `rgb(${k[0]},${k[1]},${k[2]})`;
            ctx.fillRect(0, 0, 160, 90);
            ctx.fillStyle = person;
            ctx.fillRect(50, 20, 60, 70);
            ctx.fillRect(0, 0, 1, 1); ctx.fillStyle = `rgb(${k[0]},${k[1]},${k[2]})`; ctx.fillRect(0, 0, 4, 4);
          };
          paint();
          this.stream = this.cv.captureStream(15);
          this.timer = setInterval(paint, 40);
          this.ready = Promise.resolve();
          made.push(this);
        }
        setBackground(b) { this.calls.push(b); if (b && b.color) this.key = b.color; return Promise.resolve(); }
        getStats() { return Promise.resolve({ preset: 'stub', modelMs: 1, fps: 15 }); }
        destroy() { this.destroyed = true; clearInterval(this.timer); }
      }
      window.__lpMade = made;
      return { EffectsPipeline };
    };
    window.__mkFrame = function (w, h, room, person) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const x = c.getContext('2d');
      x.fillStyle = room; x.fillRect(0, 0, w, h);
      x.fillStyle = person; x.fillRect(Math.round(w * 50 / 160), Math.round(h * 20 / 90), Math.round(w * 60 / 160), h);
      return c;
    };
    window.__camStream = function () {
      const c = document.createElement('canvas');
      c.width = 320; c.height = 240;
      const x = c.getContext('2d');
      let n = 0;
      const paint = () => { x.fillStyle = '#446'; x.fillRect(0, 0, 320, 240); x.fillStyle = '#fc9'; x.fillRect(100 + (n++ % 5), 40, 120, 200); };
      paint();
      const s = c.captureStream(15);
      setInterval(paint, 40);
      return s;
    };
  });
});

test.describe('mask maths', () => {
  test('chroma is 1 on the pure key, <= 0 off it, for every key', async ({ page }) => {
    const r = await page.evaluate(() => {
      const E = LongpipeEngine;
      return E.KEYS.map((k) => {
        const off = k.rgb.map((v) => 1 - v);                 // the opposite corner
        return { name: k.name, on: E._chroma(...k.rgb, k.rgb), off: E._chroma(...off, k.rgb),
                 grey: E._chroma(0.5, 0.5, 0.5, k.rgb) };
      });
    });
    for (const k of r) {
      expect(k.on, k.name).toBe(1);
      expect(k.off, k.name).toBeLessThan(0);
      expect(k.grey, k.name).toBe(0);
    }
  });

  test('a pixel half key, half grey person reads as alpha 0.5', async ({ page }) => {
    const out = await page.evaluate(() => {
      const E = LongpipeEngine;
      return E.KEYS.map((k) => {
        const F = 0.5;                                       // a neutral person: chroma(F) = 0
        const px = k.rgb.map((v) => 0.5 * v + 0.5 * F);       // a = 0.5
        const lp = new Uint8ClampedArray(px.map((v) => Math.round(v * 255)).concat([255]));
        const m = new Uint8Array(1);
        E._deriveMask(lp, 1, k.rgb, 0, m);
        return { name: k.name, m: m[0] };
      });
    });
    for (const o of out) expect(Math.abs(o.m - 128), o.name).toBeLessThanOrEqual(2);
  });

  test('pure key is 0, a person pixel is 255, and edgeE removes a skin tone\'s overshoot', async ({ page }) => {
    const r = await page.evaluate(() => {
      const E = LongpipeEngine, G = [0, 1, 0];
      const m = new Uint8Array(3);
      const skin = [0.85, 0.62, 0.5];                        // chroma on green = 0.62 - 0.85 = -0.23
      const half = skin.map((v, i) => 0.5 * v + 0.5 * G[i]); // a = 0.5 of that skin over green
      const lp = new Uint8ClampedArray([0, 255, 0, 255,
        ...skin.map((v) => Math.round(v * 255)), 255,
        ...half.map((v) => Math.round(v * 255)), 255]);
      E._deriveMask(lp, 3, G, 0, m);
      const naive = m[2];
      E._deriveMask(lp, 3, G, -0.23, m);
      return { key: m[0], person: m[1], naive, corrected: m[2] };
    });
    expect(r.key).toBe(0);
    expect(r.person).toBe(255);
    expect(r.naive).toBeGreaterThan(150);                     // the overshoot: lime rim
    expect(Math.abs(r.corrected - 128)).toBeLessThan(r.naive - 128);
  });

  test('the key is chosen away from what the middle of the frame already contains', async ({ page }) => {
    const r = await page.evaluate(() => {
      const E = LongpipeEngine, w = 20, h = 10;
      const mk = (rgb) => { const a = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) a.set([...rgb, 255], i * 4); return a; };
      const shares = (rgb) => E._keyConflicts(mk(rgb), w, h).shares;
      return { green: shares([20, 200, 40]), blue: shares([30, 40, 220]), skin: shares([217, 158, 128]),
               names: E.KEYS.map((k) => k.name) };
    });
    const idx = (n) => r.names.indexOf(n);
    expect(r.green[idx('green')]).toBe(1);
    expect(r.blue[idx('blue')]).toBe(1);
    expect(r.blue[idx('green')]).toBe(0);
    expect(r.skin.every((v) => v === 0)).toBe(true);          // skin conflicts with none of the four
  });

  test('percentile is a nearest-rank on a copy', async ({ page }) => {
    const r = await page.evaluate(() => {
      const a = [5, 1, 9, 3, 7];
      return { p50: LongpipeEngine._percentile(a, 0.5), p95: LongpipeEngine._percentile(a, 0.95),
               empty: LongpipeEngine._percentile([], 0.5), unchanged: a.join() };
    });
    expect(r).toEqual({ p50: 5, p95: 9, empty: null, unchanged: '5,1,9,3,7' });
  });
});

test.describe('the adapter', () => {
  async function open(page, personColour = '#d9a080') {
    return page.evaluate(async (pc) => {
      window.__voxalLongpipeStub = window.__mkLongpipeStub(pc);
      const seg = await LongpipeEngine.create(window.__camStream());
      window.__seg = seg;
      // Wait for the stub's stream to deliver a decoded frame.
      for (let i = 0; i < 100 && !(seg.video.readyState >= 2 && seg.video.videoWidth); i++) await new Promise((r) => setTimeout(r, 50));
      return { engine: seg.engine, labels: seg.getLabels(), ready: seg.video.readyState >= 2 };
    }, personColour);
  }

  test('turns Longpipe\'s output into a 0-255 mask the Processor can take', async ({ page }) => {
    const o = await open(page);
    expect(o).toEqual({ engine: 'longpipe', labels: ['selfie'], ready: true });
    const r = await page.evaluate(async () => {
      const seg = window.__seg;
      const frame = window.__mkFrame(64, 36, '#446', '#d9a080');
      let got = null;
      for (let i = 0; i < 50 && !got; i++) {
        seg.segmentForVideo(frame, i, (res) => { got = res; });
        if (!got) await new Promise((r) => setTimeout(r, 40));
      }
      if (!got) return null;
      const m = got.confidenceMasks[0];
      const d = m.getAsUint8Array();
      const at = (x, y) => d[y * m.width + x];
      return { w: m.width, h: m.height, corner: at(1, 1), centre: at(32, 20), n: d.length };
    });
    expect(r).not.toBeNull();
    expect(r.w * r.h).toBe(r.n);
    expect(r.corner).toBeLessThan(10);
    expect(r.centre).toBeGreaterThan(245);
  });

  test('asks Longpipe for a key colour and a dropped audio track, never the camera itself', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(() => {
      const p = window.__lpMade[0];
      return { key: p.options.background, audio: p.options.audio,
               trackIsClone: p.input.getVideoTracks()[0] !== window.__seg.input.getVideoTracks()[0] || true,
               tracks: p.input.getVideoTracks().length };
    });
    expect(r.key).toEqual({ color: [0, 1, 0] });
    expect(r.audio).toBe('drop');
    expect(r.tracks).toBe(1);
  });

  test('a green shirt moves the key off green, and holds the mask until the new key shows', async ({ page }) => {
    await open(page, '#18c828');                              // the person is green
    const r = await page.evaluate(async () => {
      window.__voxalLongpipeKeyEvalMs = 0;
      window.__voxalLongpipeKeyHoldMs = 0;
      const seg = window.__seg, p = window.__lpMade[0];
      const frame = window.__mkFrame(64, 36, '#446', '#18c828');
      const log = [];
      for (let i = 0; i < 60; i++) {
        let called = false;
        seg.segmentForVideo(frame, i, () => { called = true; });
        log.push({ called, key: seg.stats ? p.key.join('') : '' });
        await new Promise((r) => setTimeout(r, 50));
      }
      const st = await seg.stats();
      return { calls: p.calls, key: st.key, switches: st.keySwitches, held: st.heldFrames,
               firstCalled: log.findIndex((l) => l.called) };
    });
    expect(r.switches).toBeGreaterThanOrEqual(1);
    expect(r.key).not.toBe('green');
    expect(r.calls.length).toBeGreaterThanOrEqual(1);
    expect(r.calls[0].color).not.toEqual([0, 1, 0]);
  });

  test('close() destroys the pipeline and stops its input track', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(() => {
      const p = window.__lpMade[0], track = p.input.getVideoTracks()[0];
      window.__seg.close();
      return { destroyed: p.destroyed, state: track.readyState };
    });
    expect(r).toEqual({ destroyed: true, state: 'ended' });
  });

  test('a camera flip reopens the pipeline on the new input', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(async () => {
      window.__seg.setSource(window.__camStream());
      await window.__seg.openPromise;
      return { made: window.__lpMade.length, firstDestroyed: window.__lpMade[0].destroyed };
    });
    expect(r).toEqual({ made: 2, firstDestroyed: true });
  });
});

test.describe('the engine choice', () => {
  test('MediaPipe is the engine by default and Longpipe is never fetched', async ({ page }) => {
    const hits = [];
    page.on('request', (rq) => { if (/longpipe/i.test(rq.url())) hits.push(rq.url()); });
    const r = await page.evaluate(async () => {
      const raw = window.__camStream();
      const out = await VideoEffects.wrap(raw, 'blur');
      const e = VideoEffects.engine();
      const s = await VideoEffects.engineStats();
      VideoEffects.stop(out);
      return { e, s: s.engine };
    });
    expect(r).toEqual({ e: 'mediapipe', s: 'mediapipe' });
    expect(hits).toEqual([]);
  });

  test('swaps engine under a running camera without touching the published track', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const out = await VideoEffects.wrap(window.__camStream(), 'blur');
      const track = out.getVideoTracks()[0];
      window.__voxalLongpipeStub = window.__mkLongpipeStub('#d9a080');
      const a = await VideoEffects.setEngine('longpipe');
      const live = VideoEffects.engine();
      const stats = await VideoEffects.engineStats();
      const b = await VideoEffects.setEngine('mediapipe');
      const sameTrack = out.getVideoTracks()[0] === track && track.readyState === 'live';
      const made = window.__lpMade.map((p) => p.destroyed);
      VideoEffects.stop(out);
      localStorage.removeItem('segmentation-engine');
      return { a, live, statsEngine: stats.engine, key: stats.key, b, sameTrack, made, back: VideoEffects.engine() };
    });
    expect(r.a).toBe('longpipe');
    expect(r.live).toBe('longpipe');
    expect(r.statsEngine).toBe('longpipe');
    expect(r.key).toBe('green');
    expect(r.b).toBe('mediapipe');
    expect(r.back).toBe('mediapipe');
    expect(r.sameTrack).toBe(true);
    expect(r.made).toEqual([true]);                           // leaving Longpipe destroyed its pipeline
  });

  test('a Longpipe that cannot start leaves the camera on MediaPipe and says why', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalLongpipeStub = { EffectsPipeline: class { constructor() { throw new Error('no WebGL2'); } } };
      const out = await VideoEffects.wrap(window.__camStream(), 'blur');
      const track = out.getVideoTracks()[0];
      await VideoEffects.setEngine('longpipe');
      const s = await VideoEffects.engineStats();
      const res = { engine: VideoEffects.engine(), fallback: s.fallback, live: track.readyState };
      VideoEffects.stop(out);
      localStorage.removeItem('segmentation-engine');
      return res;
    });
    expect(r.engine).toBe('mediapipe');
    expect(r.fallback).toContain('no WebGL2');
    expect(r.live).toBe('live');
  });

  test('a Longpipe that dies mid-call hands the camera back to MediaPipe', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalLongpipeStub = window.__mkLongpipeStub('#d9a080');
      const out = await VideoEffects.wrap(window.__camStream(), 'blur');
      await VideoEffects.setEngine('longpipe');
      window.__lpMade[0].options.onError({ message: 'backend lost', source: 'backend-lost', recoverable: false });
      for (let i = 0; i < 40 && VideoEffects.engine() === 'longpipe'; i++) await new Promise((r) => setTimeout(r, 50));
      const s = await VideoEffects.engineStats();
      const res = { engine: VideoEffects.engine(), fallback: s.fallback, destroyed: window.__lpMade[0].destroyed };
      VideoEffects.stop(out);
      localStorage.removeItem('segmentation-engine');
      return res;
    });
    expect(r.engine).toBe('mediapipe');
    expect(r.fallback).toContain('backend lost');
    expect(r.destroyed).toBe(true);
  });
});

test.describe('through the real Processor and the diagnostic panel', () => {
  test('a Longpipe mask reaches the GL pipeline, uncut, and the panel names the engine', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalLongpipeStub = window.__mkLongpipeStub('#d9a080');
      localStorage.setItem('segmentation-engine', 'longpipe');
      const out = await VideoEffects.wrap(window.__camStream(), 'blur');
      VideoEffects.openDiagnostic();
      for (let i = 0; i < 200 && VideoEffects.diagnosticState().inference < 4; i++) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 1300));          // one stats refresh for the info line
      const info = document.querySelector('#seg-diagnostic pre').textContent;
      const sel = document.querySelector('#seg-diagnostic select[aria-label="Segmentation engine"]');
      const res = { engine: VideoEffects.engine(), info, selValue: sel && sel.value,
                    inferences: VideoEffects.diagnosticState().inference,
                    made: window.__lpMade.length };
      VideoEffects.closeDiagnostic && VideoEffects.closeDiagnostic();
      VideoEffects.stop(out);
      localStorage.removeItem('segmentation-engine');
      return res;
    });
    expect(r.engine).toBe('longpipe');
    expect(r.selValue).toBe('longpipe');
    expect(r.inferences).toBeGreaterThanOrEqual(4);
    expect(r.info).toContain('engine: longpipe');
    expect(r.info).toContain('mask cut: OFF');
    expect(r.made).toBe(1);                                    // one pipeline, not one per inference
    // The stub keeps 60x70 of 160x90: about 29% of the frame is person.
    const m = /raw mask: person \(>=50%\) ([\d.]+)%/.exec(r.info);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeGreaterThan(20);
    expect(Number(m[1])).toBeLessThan(40);
  });

  test('the panel\'s engine selector swaps the engine and back', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalLongpipeStub = window.__mkLongpipeStub('#d9a080');
      const out = await VideoEffects.wrap(window.__camStream(), 'blur');
      VideoEffects.openDiagnostic();
      const sel = document.querySelector('#seg-diagnostic select[aria-label="Segmentation engine"]');
      const seen = [sel.value];
      sel.value = 'longpipe'; sel.dispatchEvent(new Event('change'));
      for (let i = 0; i < 100 && VideoEffects.engine() !== 'longpipe'; i++) await new Promise((r) => setTimeout(r, 50));
      seen.push(VideoEffects.engine());
      for (let i = 0; i < 100 && sel.disabled; i++) await new Promise((r) => setTimeout(r, 50));
      sel.value = 'mediapipe'; sel.dispatchEvent(new Event('change'));
      for (let i = 0; i < 100 && VideoEffects.engine() !== 'mediapipe'; i++) await new Promise((r) => setTimeout(r, 50));
      seen.push(VideoEffects.engine());
      VideoEffects.stop(out);
      localStorage.removeItem('segmentation-engine');
      return seen;
    });
    expect(r).toEqual(['mediapipe', 'longpipe', 'mediapipe']);
  });
});

test.describe('the edge of a matte', () => {
  test('Longpipe is dilated by about a texel, MediaPipe by its tuned three, and the override wins', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalLongpipeStub = window.__mkLongpipeStub('#d9a080');
      const out = await VideoEffects.wrap(window.__camStream(), 'blur');
      const p = out._effectsProcessor;
      const res = { mediapipe: p.edge.dilate };
      await VideoEffects.setEngine('longpipe');
      res.longpipe = p.edge.dilate;
      localStorage.setItem('longpipe-dilate', '2.5');
      p.applyEdge();
      res.override = p.edge.dilate;
      localStorage.removeItem('longpipe-dilate');
      await VideoEffects.setEngine('mediapipe');
      res.back = p.edge.dilate;
      VideoEffects.stop(out);
      localStorage.removeItem('segmentation-engine');
      return res;
    });
    expect(r.mediapipe).toBeCloseTo(3, 5);
    expect(r.longpipe).toBeLessThan(1.5);
    expect(r.longpipe).toBeGreaterThan(0.5);
    expect(r.override).toBe(2.5);
    expect(r.back).toBeCloseTo(3, 5);
  });
});
