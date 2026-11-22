import { test, expect } from './fixtures.js';

// The experimental Apple Vision engine, src/vision-engine.js.
//
// Vision only exists behind the Mac app's Tauri command, so a stand-in for the
// IPC call answers with the command's real wire format (12-byte header, then an
// 8-bit mask at the size sent). What is real: the input sizing, the request's
// bytes and headers, the parsing, the engine choice and where it is offered,
// the Mac-app default and the fallback to Longpipe, the swap under a running camera and the mask going through the
// real Processor. The Rust side is covered by `cargo test` (vision.rs), and how
// good Vision's mask is by docs/apple-vision-evaluation.md.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { window.__voxalSegStub = true; });
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('segmentation-engine', 'mediapipe');
    // The command: the left half of the picture is the person (255), the
    // right half not, with a band of 128 down the middle.
    window.__mkVisionStub = function (opts) {
      opts = opts || {};
      const log = { calls: [] };
      const fn = function (cmd, body, o) {
        const w = +o.headers['x-width'], h = +o.headers['x-height'];
        log.calls.push({ cmd, w, h, bytes: body.byteLength, isU8: body instanceof Uint8Array });
        const n = log.calls.length;
        if (opts.failAll || (opts.failAfter !== undefined && n > opts.failAfter)) {
          return Promise.reject('Apple Vision\'s foreground mask needs macOS 14 or later');
        }
        if (opts.short) return Promise.resolve(new ArrayBuffer(20));
        const buf = new ArrayBuffer(12 + w * h);
        const dv = new DataView(buf);
        dv.setUint16(0, w, true); dv.setUint16(2, h, true);
        dv.setUint32(4, 16000, true); dv.setUint32(8, 17000, true);
        const m = new Uint8Array(buf, 12);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) m[y * w + x] = x < w / 2 - 2 ? 255 : (x < w / 2 + 2 ? 128 : 0);
        }
        return Promise.resolve(buf);
      };
      fn.log = log;
      return fn;
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
  test('input sizes keep the aspect, on even sides, and never upscale', async ({ page }) => {
    const r = await page.evaluate(() => [
      VisionEngine._inputSize(1280, 720, 512),
      VisionEngine._inputSize(1920, 1080, 256),
      VisionEngine._inputSize(720, 1280, 384),
      VisionEngine._inputSize(320, 180, 512),
      VisionEngine._inputSize(4000, 100, 256)
    ]);
    expect(r[0]).toEqual({ width: 512, height: 288 });
    expect(r[1]).toEqual({ width: 256, height: 144 });
    expect(r[2]).toEqual({ width: 216, height: 384 });
    expect(r[3]).toEqual({ width: 320, height: 180 });   // smaller than the size: sent as is
    expect(r[4]).toEqual({ width: 256, height: 16 });
  });

  test('the answer is parsed by its header, and a short one is refused', async ({ page }) => {
    const r = await page.evaluate(() => {
      const buf = new ArrayBuffer(12 + 6);
      const dv = new DataView(buf);
      dv.setUint16(0, 3, true); dv.setUint16(2, 2, true); dv.setUint32(4, 12500, true); dv.setUint32(8, 14000, true);
      new Uint8Array(buf, 12).set([0, 64, 128, 192, 255, 7]);
      const m = VisionEngine._parseMask(buf);
      const bad = [new ArrayBuffer(4), new ArrayBuffer(20), null].map((b) => {
        try { VisionEngine._parseMask(b); return 'parsed'; } catch (e) { return 'refused'; }
      });
      return { size: [m.width, m.height], data: Array.from(m.data), vision: m.visionMs, rust: m.rustMs, bad };
    });
    expect(r.size).toEqual([3, 2]);
    expect(r.data).toEqual([0, 64, 128, 192, 255, 7]);
    expect(r.vision).toBe(12.5);
    expect(r.rust).toBe(14);
    expect(r.bad).toEqual(['refused', 'refused', 'refused']);
  });

  test('the size is read from storage, with a safe default', async ({ page }) => {
    const r = await page.evaluate(() => {
      const out = [VisionEngine.config().size];
      localStorage.setItem('vision-size', '256'); out.push(VisionEngine.config().size);
      localStorage.setItem('vision-size', 'huge'); out.push(VisionEngine.config().size);
      localStorage.setItem('vision-size', '9'); out.push(VisionEngine.config().size);
      return out;
    });
    expect(r).toEqual([512, 256, 512, 512]);
  });
});

test.describe('where it is offered', () => {
  test('never on the web: not available, never selected, even when stored', async ({ page }) => {
    const r = await page.evaluate(async () => {
      localStorage.setItem('segmentation-engine', 'vision');
      const res = { available: VisionEngine.available(), selected: VisionEngine.selected(), engine: VideoEffects.engine() };
      let rejected = null;
      try { await VisionEngine.create(null, null); } catch (e) { rejected = e.message; }
      res.rejected = rejected;
      const box = document.createElement('div');
      VideoEffects.renderDebugOptions(box);
      res.offered = !!box.querySelector('option[value="vision"]');
      return res;
    });
    expect(r.available).toBe(false);
    expect(r.selected).toBe(false);
    expect(r.engine).toBe('longpipe');
    expect(r.rejected).toContain('desktop app on macOS');
    expect(r.offered).toBe(false);
  });

  test('in the Mac app: offered in the engine list, with its own size setting', async ({ page }) => {
    await page.addInitScript(() => {
      window.__TAURI__ = { core: { invoke: () => Promise.reject(new Error('no command')) } };
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    });
    await page.goto('/');
    const r = await page.evaluate(() => {
      const box = document.createElement('div');
      VideoEffects.renderDebugOptions(box);
      return { available: VisionEngine.available(), offered: !!box.querySelector('option[value="vision"]'),
        text: box.textContent.includes('Apple Vision input size') };
    });
    expect(r).toEqual({ available: true, offered: true, text: true });
  });

  test('the default in the Mac app; any other choice is stored, Longpipe included', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalVisionStub = window.__mkVisionStub();
      localStorage.removeItem('segmentation-engine');
      const res = { dflt: [VideoEffects.engine(), VisionEngine.selected()] };
      await VideoEffects.setEngine('longpipe');
      res.longpipe = [VideoEffects.engine(), localStorage.getItem('segmentation-engine'), VisionEngine.selected()];
      await VideoEffects.setEngine('p3m');
      res.p3m = [VideoEffects.engine(), localStorage.getItem('segmentation-engine'), VisionEngine.selected()];
      await VideoEffects.setEngine('mediapipe');
      res.mp = [VideoEffects.engine(), localStorage.getItem('segmentation-engine')];
      await VideoEffects.setEngine('vision');
      res.back = [VideoEffects.engine(), localStorage.getItem('segmentation-engine'), P3mEngine.selected()];
      return res;
    });
    expect(r.dflt).toEqual(['vision', true]);
    // An absent key now means Vision, so Longpipe has to be written out.
    expect(r.longpipe).toEqual(['longpipe', 'longpipe', false]);
    expect(r.p3m).toEqual(['p3m', 'p3m', false]);
    expect(r.mp).toEqual(['mediapipe', 'mediapipe']);
    expect(r.back).toEqual(['vision', 'vision', false]);
  });

  test('a visit\'s ?segengine= outranks the default either way', async ({ page }) => {
    await page.addInitScript(() => { window.__voxalVisionStub = () => Promise.reject(new Error('unused')); });
    await page.goto('/?segengine=longpipe');
    const a = await page.evaluate(() => { localStorage.removeItem('segmentation-engine'); return [VisionEngine.selected(), VideoEffects.engine()]; });
    await page.goto('/?segengine=vision');
    const b = await page.evaluate(() => { localStorage.setItem('segmentation-engine', 'mediapipe'); return [VisionEngine.selected(), VideoEffects.engine()]; });
    expect(a).toEqual([false, 'longpipe']);
    expect(b).toEqual([true, 'vision']);
  });

  test('a stored Longpipe choice keeps Longpipe on a Mac, and the web is untouched', async ({ page }) => {
    const web = await page.evaluate(() => {
      localStorage.removeItem('segmentation-engine');
      VisionEngine.setSelected(false);   // what setEngine() does last, off the Mac app
      return [localStorage.getItem('segmentation-engine'), VideoEffects.engine()];
    });
    expect(web).toEqual([null, 'longpipe']);   // absent stays absent: still Longpipe's default
    const mac = await page.evaluate(() => {
      window.__voxalVisionStub = window.__mkVisionStub();
      localStorage.setItem('segmentation-engine', 'longpipe');
      return [VisionEngine.selected(), VideoEffects.engine(), LongpipeEngine.selected()];
    });
    expect(mac).toEqual([false, 'longpipe', 'longpipe']);
  });

  test('a Vision that cannot start tries Longpipe first, and keeps its own reason', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalVisionStub = window.__mkVisionStub({ failAll: true });
      // A Longpipe that cannot start either: proves it was tried.
      window.__voxalLongpipeStub = { EffectsPipeline: class { constructor() { throw new Error('no WebGL2'); } } };
      localStorage.removeItem('segmentation-engine');
      const out = await VideoEffects.wrap(window.__camStream(), 'blur');
      const s = await VideoEffects.engineStats();
      const res = { engine: VideoEffects.engine(), fallback: s.fallback, live: out.getVideoTracks()[0].readyState };
      VideoEffects.stop(out);
      return res;
    });
    expect(r.engine).toBe('mediapipe');
    expect(r.fallback).toMatch(/macOS 14.*; .*no WebGL2/);
    expect(r.live).toBe('live');
  });

  test('a command that errors (macOS 13, not a Mac) leaves the camera on MediaPipe and says why', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalVisionStub = window.__mkVisionStub({ failAll: true });
      localStorage.setItem('segmentation-engine', 'vision');
      const out = await VideoEffects.wrap(window.__camStream(), 'blur');
      const s = await VideoEffects.engineStats();
      const res = { engine: VideoEffects.engine(), fallback: s.fallback, live: out.getVideoTracks()[0].readyState };
      VideoEffects.stop(out);
      return res;
    });
    expect(r.engine).toBe('mediapipe');
    expect(r.fallback).toContain('macOS 14');
    expect(r.live).toBe('live');
  });
});

test.describe('the adapter', () => {
  test('open sends a probe frame; each inference sends raw RGBA at the input size and gets the mask back', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalVisionStub = window.__mkVisionStub();
      const seg = await VisionEngine.create(null, null);
      const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
      c.getContext('2d').fillRect(0, 0, 1280, 720);
      const a = await seg.inferFrame(c);
      await seg.inferFrame(c);
      const st = await seg.stats();
      seg.close();
      return { calls: window.__voxalVisionStub.log.calls, size: [a.width, a.height],
        left: a.data[10], right: a.data[a.width - 10], band: a.data[a.width / 2], st };
    });
    expect(r.calls[0]).toEqual({ cmd: 'vision_foreground_mask', w: 64, h: 36, bytes: 64 * 36 * 4, isU8: true });
    expect(r.calls[1]).toEqual({ cmd: 'vision_foreground_mask', w: 512, h: 288, bytes: 512 * 288 * 4, isU8: true });
    expect(r.size).toEqual([512, 288]);
    expect(r.left).toBe(255);
    expect(r.right).toBe(0);
    expect(r.band).toBe(128);
    expect(r.st).toMatchObject({ engine: 'vision', input: '512x288', frames: 2, visionMsP50: 16 });
    expect(r.st.initMs).not.toBeNull();
    expect(r.st.inferMsP50).not.toBeNull();
  });

  test('a malformed answer is an error, not a mask', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalVisionStub = window.__mkVisionStub({ short: true });
      try { await VisionEngine.create(null, null); return 'opened'; } catch (e) { return e.message; }
    });
    expect(r).toContain('Vision mask');
  });
});

test.describe('through the real Processor', () => {
  test('the mask reaches the GL pipeline uncut, at its own size, not dilated, with half the feather', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalVisionStub = window.__mkVisionStub();
      const out = await VideoEffects.wrap(window.__camStream(), 'blur');
      const p = VideoEffects.active();
      const mpFeather = p.edge.feather;
      await VideoEffects.setEngine('vision');
      for (let i = 0; i < 60 && !(p.segW === 320); i++) await new Promise((res) => setTimeout(res, 50));
      const res = { engine: p.engine, maskCut: p.maskCut, seg: [p.segW, p.segH], dilate: p.edge.dilate,
        featherRatio: p.edge.feather / mpFeather, live: out.getVideoTracks()[0].readyState };
      VideoEffects.stop(out);
      return res;
    });
    expect(r.engine).toBe('vision');
    expect(r.maskCut).toBe(0);
    expect(r.seg).toEqual([320, 180]);   // the camera is 320x180: sent, and answered, at its own size
    expect(r.dilate).toBe(0);
    expect(r.featherRatio).toBeCloseTo(0.5, 5);
    expect(r.live).toBe('live');
  });

  test('switching MediaPipe → Vision → MediaPipe keeps the same live track and Processor', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalVisionStub = window.__mkVisionStub();
      const out = await VideoEffects.wrap(window.__camStream(), 'blur');
      const track = out.getVideoTracks()[0];
      const p = VideoEffects.active();
      const seen = [VideoEffects.engine()];
      await VideoEffects.setEngine('vision');
      seen.push(VideoEffects.engine());
      for (let i = 0; i < 40 && window.__voxalVisionStub.log.calls.length < 3; i++) await new Promise((res) => setTimeout(res, 50));
      const ran = window.__voxalVisionStub.log.calls.length;
      await VideoEffects.setEngine('mediapipe');
      seen.push(VideoEffects.engine());
      const res = { seen, ran, same: out.getVideoTracks()[0] === track, live: track.readyState,
        processor: VideoEffects.active() === p };
      VideoEffects.stop(out);
      return res;
    });
    expect(r.seen).toEqual(['mediapipe', 'vision', 'mediapipe']);
    expect(r.ran).toBeGreaterThanOrEqual(3);   // the probe, then frames
    expect(r.same).toBe(true);
    expect(r.live).toBe('live');
    expect(r.processor).toBe(true);
  });

  test('a size change re-opens the engine under the running camera', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalVisionStub = window.__mkVisionStub();
      localStorage.setItem('segmentation-engine', 'vision');
      const big = document.createElement('canvas'); big.width = 1280; big.height = 720;
      const x = big.getContext('2d');
      const paint = () => { x.fillStyle = '#446'; x.fillRect(0, 0, 1280, 720); };
      paint(); setInterval(paint, 40);
      const out = await VideoEffects.wrap(big.captureStream(15), 'blur');
      const p = VideoEffects.active();
      for (let i = 0; i < 60 && p.segW !== 512; i++) await new Promise((res) => setTimeout(res, 50));
      const first = [p.segW, p.segH];
      VideoEffects.setDebug('vision-size', '256');
      for (let i = 0; i < 60 && p.segW !== 256; i++) await new Promise((res) => setTimeout(res, 50));
      const res = { first, seg: [p.segW, p.segH], engine: p.engine, live: out.getVideoTracks()[0].readyState };
      VideoEffects.stop(out);
      return res;
    });
    expect(r.engine).toBe('vision');
    expect(r.first).toEqual([512, 288]);
    expect(r.seg).toEqual([256, 144]);
    expect(r.live).toBe('live');
  });

  test('a Vision that dies mid-call hands the camera back to MediaPipe', async ({ page }) => {
    const r = await page.evaluate(async () => {
      // The probe and two frames, then every call fails.
      window.__voxalVisionStub = window.__mkVisionStub({ failAfter: 3 });
      localStorage.setItem('segmentation-engine', 'vision');
      const out = await VideoEffects.wrap(window.__camStream(), 'blur');
      for (let i = 0; i < 100 && VideoEffects.engine() === 'vision'; i++) await new Promise((res) => setTimeout(res, 50));
      const s = await VideoEffects.engineStats();
      const res = { engine: VideoEffects.engine(), fallback: s.fallback, live: out.getVideoTracks()[0].readyState };
      VideoEffects.stop(out);
      return res;
    });
    expect(r.engine).toBe('mediapipe');
    expect(r.fallback).toContain('macOS 14');
    expect(r.live).toBe('live');
  });

  test('mid-call, a dead Vision hands over to Longpipe, not straight to MediaPipe', async ({ page }) => {
    const r = await page.evaluate(async () => {
      window.__voxalVisionStub = window.__mkVisionStub({ failAfter: 3 });
      window.__voxalLongpipeStub = { EffectsPipeline: class { constructor() { throw new Error('no WebGL2'); } } };
      localStorage.setItem('segmentation-engine', 'vision');
      const out = await VideoEffects.wrap(window.__camStream(), 'blur');
      for (let i = 0; i < 100 && VideoEffects.engine() === 'vision'; i++) await new Promise((res) => setTimeout(res, 50));
      const s = await VideoEffects.engineStats();
      const res = { engine: VideoEffects.engine(), fallback: s.fallback };
      VideoEffects.stop(out);
      return res;
    });
    expect(r.engine).toBe('mediapipe');
    expect(r.fallback).toContain('no WebGL2');   // Longpipe was asked, and could not start
  });
});
