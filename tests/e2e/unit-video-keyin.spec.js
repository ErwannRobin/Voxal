import { test, expect } from './fixtures.js';

// The keyed stream, receiving half: VideoEffects.keyIn() cuts a peer out of a
// keyed frame and puts them over this device's own render of their scene.
//
// Three layers. A hand-painted keyed source proves the arithmetic and the
// detection exactly (inside is the person, outside and the zones are the
// receiver's own scene, an unmarked frame passes through, the strict and the
// relaxed detector each do their job). The lifecycle tests prove the receiver
// stays out of the user's own pipeline — no `_active`, no segmentation
// runtime, no lingering WebGL contexts. And the codec round trips put real
// VP8 between the two ends, scoring what matters on COLOUR against what the
// sender's own composite would have shown, not on alpha.
//
// CI's GPU is SwiftShader, which canKeyIn() refuses: these tests call keyIn()
// directly (it is the capability, not the call, that is gated), and set the
// overrides only where canKeyIn() itself is under test. Scene compiles cost
// seconds there, so the sources are small and each test starts as few
// handles as it can.

const C = [200, 150, 120];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { window.__voxalSegStub = true; });
  await page.goto('/');
  await page.evaluate(() => {
    window.__sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__waitFor = async (fn, ms) => {
      const end = Date.now() + ms;
      while (!fn() && Date.now() < end) await window.__sleep(40);
      return fn();
    };

    // A keyed source painted by hand, as a sender would produce it: the key,
    // a person of colour C, the two zones. `__srcMode` switches it live to
    // 'plain' (an ordinary picture, no markers) or 'trap' (an ordinary grey
    // picture whose top-left corner happens to be key green and whose
    // top-right has a dark patch in a grey ring — what the strict detector
    // exists to refuse).
    window.__srcMode = 'keyed';
    window.__mkSource = (W = 160, H = 120) => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d', { alpha: false });
      const Z = 0.1 * Math.min(W, H), P = 0.6 * Z;
      let n = 0;
      const paint = () => {
        const mode = window.__srcMode;
        if (mode === 'keyed') {
          ctx.fillStyle = 'rgb(0,255,0)';
          ctx.fillRect(0, 0, W, H);
          ctx.fillStyle = 'rgb(200,150,120)';
          ctx.beginPath();
          ctx.ellipse(W / 2, H * 0.65, W * 0.2, H * 0.35, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#000';
          ctx.fillRect(W - Z + (Z - P) / 2, (Z - P) / 2, P, P);
        } else if (mode === 'plain') {
          const g = ctx.createLinearGradient(0, 0, W, 0);
          g.addColorStop(0, '#406080'); g.addColorStop(1, '#806040');
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, W, H);
        } else {
          ctx.fillStyle = 'rgb(128,128,128)';
          ctx.fillRect(0, 0, W, H);
          ctx.fillStyle = 'rgb(0,255,0)';
          ctx.fillRect(0, 0, Z, Z);
          ctx.fillStyle = '#000';
          ctx.fillRect(W - Z + (Z - P) / 2, (Z - P) / 2, P, P);
        }
        // Something must change or the capture stops producing frames: a
        // pixel of the background colour, on the bottom row.
        ctx.fillStyle = mode === 'keyed' ? 'rgb(0,250,0)' : '#777';
        ctx.fillRect((n++ * 3) % W, H - 1, 1, 1);
      };
      paint();
      const stream = c.captureStream(15);
      const timer = setInterval(paint, 40);
      stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
      return stream;
    };

    window.__offer = (extra) => Object.assign({
      scene: 'office', size: [160, 120], edgeE: 0,
      look: { tint: [1, 1, 1], exposure: 1, dirX: 0.35, dirY: 0.5, hard: 0.45, side: 1 },
    }, extra || {});

    window.__start = async (extra, W, H) => {
      window.__src = window.__mkSource(W, H);
      window.__h = await VideoEffects.keyIn(window.__src, window.__offer(extra), {
        onGiveUp: (why) => (window.__gaveUp = window.__gaveUp || []).push(why),
      });
      window.__p = window.__h.processor;
      return window.__h;
    };

    // The receiver's output, and its own scene underneath, at canvas pixel
    // (x, y). The scene buffer is in GL orientation, bottom row first.
    window.__out = (x, y) => {
      const src = window.__p.canvas;
      const probe = document.createElement('canvas');
      probe.width = src.width; probe.height = src.height;
      const ctx = probe.getContext('2d');
      ctx.drawImage(src, 0, 0);
      return Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3);
    };
    window.__sceneAt = (x, y) => {
      const p = window.__p, gl = p.gl, px = new Uint8Array(4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, p.fbSceneOut[p.sceneOut]);
      gl.readPixels(x, p.canvas.height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return Array.from(px).slice(0, 3);
    };
    // A frame the receiver has drawn since now.
    window.__nextDraw = async () => {
      const t = window.__p.lastDraw;
      await window.__waitFor(() => window.__p.lastDraw > t, 5000);
      await window.__sleep(80);
    };
  });
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => {
    try { window.__h && window.__h.destroy(); } catch (e) { /* ignore */ }
    try { window.__src && window.__src.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
    try { VideoEffects.stop(); } catch (e) { /* ignore */ }
  });
});

const near = (px, want, tol) => px.every((v, i) => Math.abs(v - want[i]) <= tol);

test.describe('who may receive', () => {
  test('canKeyIn refuses a software GPU unless a test says otherwise', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const before = VideoEffects.canKeyIn();
      window.__voxalKeyInOnSoftwareGL = true;
      const allowed = VideoEffects.canKeyIn();
      delete window.__voxalKeyInOnSoftwareGL;
      return { before, allowed, after: VideoEffects.canKeyIn() };
    });
    // This container renders with SwiftShader.
    expect(seen).toEqual({ before: false, allowed: true, after: false });
  });

  test('isSoftwareGL also knows Windows\' own rasteriser', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const fake = (name) => ({
        getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 1 }),
        getParameter: () => name,
      });
      return ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), SwiftShader driver)',
        'Microsoft Basic Render Driver', 'ANGLE (Microsoft, WARP, D3D11)', 'llvmpipe (LLVM 15.0.7, 256 bits)',
        'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Apple M2']
        .map((n) => VideoScenes.isSoftwareGL(fake(n)));
    });
    expect(seen).toEqual([true, true, true, true, false, false]);
  });
});

test.describe('another engine', () => {
  test.beforeEach(async ({ page }) => {
    // WebKit says so in its user agent, and has no userAgentData.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'userAgentData', { get: () => undefined });
      Object.defineProperty(navigator, 'userAgent', {
        get: () => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
      });
    });
    await page.goto('/');
  });

  test('is not offered the capability, unless a test says otherwise', async ({ page }) => {
    const seen = await page.evaluate(() => {
      window.__voxalKeyInOnSoftwareGL = true;
      const webkit = VideoEffects.canKeyIn();
      window.__voxalKeyInAnyEngine = true;
      return { webkit, any: VideoEffects.canKeyIn() };
    });
    expect(seen).toEqual({ webkit: false, any: true });
  });
});

test.describe('the round trip', () => {
  test('inside is the person, outside and the zones are the receiver\'s own scene', async ({ page }) => {
    test.setTimeout(90_000);
    const seen = await page.evaluate(async () => {
      const h = await window.__start({ look: { tint: [1.12, 1, 0.9], exposure: 0.6, dirX: -0.7, dirY: 0.2, hard: 0.8, side: -1 } });
      const p = window.__p;
      const resolved = { scene: h.scene(), alive: h.alive(), live: h.stream.getVideoTracks()[0].readyState,
        canvas: [p.canvas.width, p.canvas.height], original: h.stream._effectsOriginal,
        count: VideoEffects.keyInCount() };
      // Shadow and wrap off, so the background is the scene and nothing else.
      p.scene = Object.assign({}, p.scene, { shadow: 0, wrap: 0 });
      await window.__nextDraw();
      h.setPaused(true);
      await window.__sleep(150);
      const W = p.canvas.width;
      const pts = { inside: [80, 78], outside: [10, 60], tl: [5, 5], patch: [W - 6, 6], right: [150, 100] };
      const out = {}, scene = {};
      for (const k in pts) { out[k] = window.__out(...pts[k]); scene[k] = window.__sceneAt(...pts[k]); }
      return { resolved, out, scene,
        look: { exposure: p.look.exposure, tint: p.look.tint, dirX: p.look.dirX, side: p.look.side, sideMix: p.look.sideMix },
        target: { cx: p.lookTarget.cx, cy: p.lookTarget.cy, exposure: p.lookTarget.exposure },
        keyedAt: h.lastKeyedAt(), now: performance.now() };
    });
    expect(seen.resolved).toEqual({ scene: 'office', alive: true, live: 'live', canvas: [160, 120],
      original: undefined, count: 1 });
    expect(near(seen.out.inside, C, 4)).toBe(true);
    for (const k of ['outside', 'tl', 'patch', 'right']) {
      expect(near(seen.out[k], seen.scene[k], 5), `${k}: ${seen.out[k]} vs scene ${seen.scene[k]}`).toBe(true);
      expect(near(seen.out[k], [0, 255, 0], 60)).toBe(false);
    }
    // The look is the sender's, taken whole on the first frame.
    expect(seen.look.exposure).toBeCloseTo(0.6, 5);
    expect(seen.look.tint.map((v) => +v.toFixed(3))).toEqual([1.12, 1, 0.9]);
    expect(seen.look.dirX).toBeCloseTo(-0.7, 5);
    expect(seen.look.side).toBe(-1);
    expect(seen.look.sideMix).toBe(0);
    // Only where the person is was measured here: the ellipse's centre.
    expect(Math.abs(seen.target.cx - 0.5)).toBeLessThan(0.06);
    expect(Math.abs(seen.target.cy - 0.65)).toBeLessThan(0.08);
    expect(seen.target.exposure).toBeCloseTo(0.6, 5);
    // The CPU probe saw keyed frames.
    expect(seen.keyedAt).toBeGreaterThan(0);
    expect(seen.now - seen.keyedAt).toBeLessThan(1500);
  });

  test('an unmarked frame passes through untouched; the strict and the relaxed detectors each do their job', async ({ page }) => {
    test.setTimeout(90_000);
    const seen = await page.evaluate(async () => {
      const h = await window.__start();
      // No shadow: a grey picture read as keyed is "all person", and the
      // contact shadow would darken the scene under the zone.
      window.__p.scene = Object.assign({}, window.__p.scene, { shadow: 0, wrap: 0 });
      const keyedTl = (await window.__nextDraw(), window.__out(5, 5));
      // The sender swapped back to its composite.
      const switched = performance.now();
      window.__srcMode = 'plain';
      await window.__waitFor(() => h.lastUnkeyedAt() > switched, 3000);
      await window.__sleep(700);   // past the "keyed lately" window
      await window.__nextDraw();
      const plain = { mid: window.__out(80, 60), tl: window.__out(5, 5), keyedAt: h.lastKeyedAt(), unkeyedAt: h.lastUnkeyedAt() };

      // An ordinary picture that happens to have a green top-left corner and
      // a dark patch at the top right. Not expecting keyed frames: through.
      window.__srcMode = 'trap';
      await window.__sleep(400);
      await window.__nextDraw();
      const trapStrict = window.__out(5, 5);
      // This receiver has said it is ready: the relaxed test applies, and the
      // same frame reads as keyed — the price of riding out a starved link.
      h.setExpectKeyed(true);
      await window.__nextDraw();
      await window.__nextDraw();
      // Held still, so the picture and the scene under it are read from the
      // same frame.
      h.setPaused(true);
      await window.__sleep(150);
      const trapRelaxed = window.__out(5, 5);
      const scene = window.__sceneAt(5, 5);
      h.setPaused(false);
      // And no latch: a relaxed pass never renews the window that allows it.
      h.setExpectKeyed(false);
      await window.__sleep(700);
      await window.__nextDraw();
      const trapAgain = window.__out(5, 5);
      return { keyedTl, plain, switched, trapStrict, trapRelaxed, scene, trapAgain };
    });
    expect(near(seen.keyedTl, [0, 255, 0], 60)).toBe(false);
    // The plain picture comes out as it went in (#406080 → #806040 gradient).
    expect(near(seen.plain.mid, [96, 96, 96], 8)).toBe(true);
    expect(near(seen.plain.tl, [65, 96, 127], 8)).toBe(true);
    expect(seen.plain.unkeyedAt).toBeGreaterThan(seen.plain.keyedAt);
    expect(near(seen.trapStrict, [0, 255, 0], 8)).toBe(true);
    expect(near(seen.trapRelaxed, [0, 255, 0], 60)).toBe(false);
    expect(near(seen.trapRelaxed, seen.scene, 6)).toBe(true);
    expect(near(seen.trapAgain, [0, 255, 0], 8)).toBe(true);
  });
});

test.describe('staying out of the user\'s own pipeline', () => {
  test('never _active, never the segmentation runtime, and destroy stops only its own tracks', async ({ page }) => {
    test.setTimeout(120_000);
    const requests = [];
    page.on('request', (r) => { if (/\/assets\/seg\//.test(r.url())) requests.push(r.url()); });
    const seen = await page.evaluate(async () => {
      // The user's own camera, running. On blur: what is under test is that the
      // receiver never reaches for the user's pipeline, and two scenes
      // ray-marched at once on a software GPU starve the receiver's warm-up of
      // frames on a busy machine.
      const cam = (() => {
        const c = document.createElement('canvas'); c.width = 160; c.height = 120;
        const ctx = c.getContext('2d'); let n = 0;
        const paint = () => { ctx.fillStyle = '#c89678'; ctx.fillRect(0, 0, 160, 120); ctx.fillStyle = '#334'; ctx.fillRect((n++ * 3) % 160, 118, 2, 2); };
        paint(); const s = c.captureStream(15); setInterval(paint, 40); return s;
      })();
      const local = await VideoEffects.wrap(cam, 'blur');
      const lp = VideoEffects.active();
      const localGl = lp.gl;
      let localDraws = 0;
      const localDraw = lp.draw;
      lp.draw = function (now) { localDraws++; return localDraw.call(this, now); };
      // From here on nothing may reach for the real runtime, or report into
      // the picker's progress bar.
      const progress = [];
      VideoEffects.onLoadProgress((e) => progress.push(e.phase));
      window.__voxalSegStub = false;
      const h = await window.__start();
      const p = window.__p;
      const remoteTrack = window.__src.getVideoTracks()[0];
      const outTrack = h.stream.getVideoTracks()[0];
      const drawn = localDraws;
      await window.__sleep(600);
      const during = { same: VideoEffects.active() === lp, localLost: localGl.isContextLost(),
        localDrawing: localDraws > drawn, reference: VideoEffects.hasReference(),
        keyInIsActive: VideoEffects.active() === p, count: VideoEffects.keyInCount() };
      const keyGl = p.gl;
      h.destroy();
      const after = { remote: remoteTrack.readyState, out: outTrack.readyState, lost: keyGl.isContextLost(),
        canvas: [p.canvas.width, p.canvas.height], alive: h.alive(), count: VideoEffects.keyInCount(),
        same: VideoEffects.active() === lp, localLost: localGl.isContextLost(), localStream: local.getVideoTracks()[0].readyState };
      window.__h = null;
      return { during, after, progress };
    });
    expect(seen.during).toEqual({ same: true, localLost: false, localDrawing: true, reference: false,
      keyInIsActive: false, count: 1 });
    expect(seen.after).toEqual({ remote: 'live', out: 'ended', lost: true, canvas: [0, 0], alive: false,
      count: 0, same: true, localLost: false, localStream: 'live' });
    expect(seen.progress).toEqual([]);
    expect(requests).toEqual([]);
  });

  test('twenty receivers come and go and the user\'s own context survives them all', async ({ page }) => {
    test.setTimeout(120_000);
    const seen = await page.evaluate(async () => {
      const cam = (() => {
        const c = document.createElement('canvas'); c.width = 160; c.height = 120;
        const ctx = c.getContext('2d'); let n = 0;
        const paint = () => { ctx.fillStyle = '#c89678'; ctx.fillRect(0, 0, 160, 120); ctx.fillStyle = '#334'; ctx.fillRect((n++ * 3) % 160, 118, 2, 2); };
        paint(); const s = c.captureStream(15); setInterval(paint, 40); return s;
      })();
      await VideoEffects.wrap(cam, 'blur');
      const lp = VideoEffects.active();
      const localGl = lp.gl;
      // Each receiver gets as far as its own context and programs, then its
      // scene fails to compile — the start rejects and must release what it
      // made. Without loseContext() Chromium evicts the oldest context at the
      // seventeenth: the user's camera.
      const real = VideoScenes.compileProgramAsync;
      VideoScenes.compileProgramAsync = () => Promise.reject(new Error('no scene for you'));
      const src = window.__mkSource();
      window.__src = src;
      const errors = [];
      let contexts = 0;
      const realGet = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind, attrs) {
        if (kind === 'webgl2') contexts++;
        return realGet.call(this, kind, attrs);
      };
      for (let i = 0; i < 20; i++) {
        try { await VideoEffects.keyIn(src, window.__offer()); } catch (e) { errors.push(e.message); }
      }
      HTMLCanvasElement.prototype.getContext = realGet;
      VideoScenes.compileProgramAsync = real;
      let localDraws = 0;
      const localDraw = lp.draw;
      lp.draw = function (now) { localDraws++; return localDraw.call(this, now); };
      await window.__sleep(500);
      return { errors: errors.length, contexts, lost: localGl.isContextLost(), count: VideoEffects.keyInCount(),
        stillActive: VideoEffects.active() === lp, gl: !!lp.gl, drawing: localDraws > 0 };
    });
    expect(seen.errors).toBe(20);
    expect(seen.contexts).toBeGreaterThanOrEqual(20);
    expect(seen.lost).toBe(false);
    expect(seen.count).toBe(0);
    expect(seen.stillActive).toBe(true);
    expect(seen.gl).toBe(true);
    expect(seen.drawing).toBe(true);
  });

  test('a receiver that fails its self-test is never handed out, and releases its context', async ({ page }) => {
    test.setTimeout(90_000);
    const seen = await page.evaluate(async () => {
      // A 2D path that reads every single pixel back as black: the GPU's view
      // of the frame no longer agrees with the canvas's.
      const real = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = function (x, y, w, h) {
        const d = real.call(this, x, y, w, h);
        if (h === 1 && w <= 5) d.data.fill(0);
        return d;
      };
      let err = null;
      try { await window.__start(); } catch (e) { err = e.message; }
      CanvasRenderingContext2D.prototype.getImageData = real;
      return { err, count: VideoEffects.keyInCount() };
    });
    expect(seen.err).toMatch(/self-test failed: texture/);
    expect(seen.count).toBe(0);
  });

  test('without a scene, or without a stream, there is nothing to start', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      const out = [];
      for (const args of [[null, {}], [window.__mkSource(), { scene: null }], [window.__mkSource(), { scene: 'nowhere' }]]) {
        try { await VideoEffects.keyIn(args[0], args[1]); out.push('resolved'); } catch (e) { out.push(e.message); }
      }
      return { out, count: VideoEffects.keyInCount() };
    });
    expect(seen.out).toEqual(['key-in needs a stream', 'key-in needs a scene', 'key-in needs a scene']);
    expect(seen.count).toBe(0);
  });
});

test.describe('a running receiver', () => {
  test('a new offer: a new scene once it compiles, a failed one keeps the old, the look eases in', async ({ page }) => {
    test.setTimeout(120_000);
    const seen = await page.evaluate(async () => {
      const h = await window.__start();
      const p = window.__p;
      const look = { tint: [1, 1, 1], exposure: 1.3, dirX: 0.35, dirY: 0.5, hard: 0.45, side: 1 };
      // The same scene, another light: no compile, so this resolves at once,
      // and the exposure eases toward the new value over the next frames
      // rather than jumping to it.
      const from = p.look.exposure;
      await h.setOffer(window.__offer({ look }));
      const atOnce = p.look.exposure;
      for (let i = 0; i < 3; i++) await window.__nextDraw();
      const easing = { from, atOnce, later: p.look.exposure, target: p.lookTarget.exposure };
      const moved = await h.setOffer(window.__offer({ scene: 'mountain', look }));
      const afterMove = { got: moved, scene: h.scene(), target: p.lookTarget.exposure };

      const real = VideoScenes.compileProgramAsync;
      VideoScenes.compileProgramAsync = (gl, id) => id === 'island' ? Promise.reject(new Error('cannot draw an island'))
        : real(gl, id);
      let failed = null;
      try { await h.setOffer(window.__offer({ scene: 'island' })); } catch (e) { failed = e.message; }
      VideoScenes.compileProgramAsync = real;
      const t = p.lastDraw;
      await window.__waitFor(() => p.lastDraw > t, 5000);
      const nullOffer = await h.setOffer(window.__offer({ scene: null }));
      return { afterMove, easing, failed, sceneAfterFail: h.scene(), stillDrawing: p.lastDraw > t,
        nullOffer, sceneAfterNull: h.scene(), alive: h.alive() };
    });
    expect(seen.afterMove).toEqual({ got: 'mountain', scene: 'mountain', target: 1.3 });
    // Eased toward the new exposure, not jumped to it.
    expect(seen.easing.from).toBeCloseTo(1, 5);
    expect(seen.easing.target).toBeCloseTo(1.3, 5);
    expect(seen.easing.atOnce).toBeCloseTo(1, 5);
    expect(seen.easing.later).toBeGreaterThan(1.0);
    expect(seen.easing.later).toBeLessThan(1.3);
    expect(seen.failed).toMatch(/cannot draw an island/);
    expect(seen.sceneAfterFail).toBe('mountain');
    expect(seen.stillDrawing).toBe(true);
    // A scene-less offer (the sender is on blur): stay, and keep drawing.
    expect(seen.nullOffer).toBe('mountain');
    expect(seen.sceneAfterNull).toBe('mountain');
    expect(seen.alive).toBe(true);
  });

  test('sized from the offer, resized only for a new shape, and never past 1280x720', async ({ page }) => {
    test.setTimeout(120_000);
    const seen = await page.evaluate(async () => {
      const h = await window.__start();
      const p = window.__p;
      const progs = [p.pKeyComp, p.pKeyMask, p.sceneProgs.office];
      const gl = p.gl;
      // Twice the size, same shape: the picture arriving bigger is not news.
      const bigger = window.__mkSource(320, 240);
      h.setSource(bigger);
      await window.__sleep(600);
      const sameShape = [p.canvas.width, p.canvas.height];
      // Another shape: the canvas follows it, keeping the offer's long side.
      const wide = window.__mkSource(160, 90);
      h.setSource(wide);
      await window.__waitFor(() => p.canvas.height === 90, 5000);
      await window.__nextDraw();
      const newShape = [p.canvas.width, p.canvas.height];
      const kept = progs[0] === p.pKeyComp && progs[1] === p.pKeyMask && progs[2] === p.sceneProgs.office && gl === p.gl;
      const sceneSize = [p.texSceneOut ? 1 : 0, p.sceneW <= 160];
      const out = h.stream.getVideoTracks()[0].readyState;
      p.applyOffer({ size: [1920, 1080] });
      const capped = p.sizeFor(1920, 1080);
      p.applyOffer({ size: [1080, 1920] });
      const portrait = p.sizeFor(1080, 1920);
      [bigger, wide].forEach((s) => s.getTracks().forEach((t) => t.stop()));
      return { sameShape, newShape, kept, sceneSize, out, capped, portrait, alive: h.alive() };
    });
    expect(seen.sameShape).toEqual([160, 120]);
    expect(seen.newShape).toEqual([160, 90]);
    expect(seen.kept).toBe(true);
    expect(seen.sceneSize).toEqual([1, true]);
    expect(seen.out).toBe('live');
    expect(seen.capped).toEqual({ w: 1280, h: 720 });
    expect(seen.portrait).toEqual({ w: 720, h: 1280 });
    expect(seen.alive).toBe(true);
  });

  test('over budget it gives up, the probe keeps watching, and a lost context gives up too', async ({ page }) => {
    test.setTimeout(120_000);
    const seen = await page.evaluate(async () => {
      const h = await window.__start();
      const p = window.__p;
      // Every frame now costs 10 ms of main thread.
      const draw = p.draw;
      p.draw = function (now) { const end = performance.now() + 10; while (performance.now() < end) { /* busy */ } return draw.call(this, now); };
      const t0 = performance.now();
      await window.__waitFor(() => (window.__gaveUp || []).length > 0, 15000);
      const after = performance.now() - t0;
      const gave = (window.__gaveUp || []).slice();
      const dead = { alive: h.alive(), keyedAt: h.lastKeyedAt() };
      const drawn = p.lastDraw;
      await window.__sleep(800);
      return { gave, after, dead, probeStill: h.lastKeyedAt() > dead.keyedAt, drewAfter: p.lastDraw > drawn };
    });
    expect(seen.gave).toEqual(['budget']);
    expect(seen.after).toBeGreaterThan(4000);
    expect(seen.dead.alive).toBe(false);
    expect(seen.probeStill).toBe(true);
    expect(seen.drewAfter).toBe(false);
  });

  test('a context the browser takes away is a give-up, reported once', async ({ page }) => {
    test.setTimeout(90_000);
    const seen = await page.evaluate(async () => {
      const h = await window.__start();
      window.__p.gl.getExtension('WEBGL_lose_context').loseContext();
      await window.__waitFor(() => (window.__gaveUp || []).length > 0, 3000);
      await window.__sleep(300);
      return { gave: window.__gaveUp, alive: h.alive() };
    });
    expect(seen.gave).toEqual(['context-lost']);
    expect(seen.alive).toBe(false);
  });
});

test.describe('the CPU probe on its own', () => {
  test('keyProbe watches a stream for keyed frames without a WebGL context', async ({ page }) => {
    test.setTimeout(30_000);
    const seen = await page.evaluate(async () => {
      let contexts = 0;
      const realGet = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind, attrs) {
        if (/webgl/.test(kind)) contexts++;
        return realGet.call(this, kind, attrs);
      };
      window.__srcMode = 'plain';
      const src = window.__mkSource();
      window.__src = src;
      const probe = VideoEffects.keyProbe(src);
      await window.__waitFor(() => probe.lastUnkeyedAt() > 0, 3000);
      const plain = [probe.lastKeyedAt(), probe.lastUnkeyedAt() > 0];
      const at = performance.now();
      window.__srcMode = 'keyed';
      await window.__waitFor(() => probe.lastKeyedAt() > at, 3000);
      const keyed = probe.lastKeyedAt() > at;
      // A new stream object behind the same probe.
      window.__srcMode = 'plain';
      const other = window.__mkSource();
      probe.setSource(other);
      const at2 = performance.now();
      await window.__waitFor(() => probe.lastUnkeyedAt() > at2, 3000);
      probe.destroy();
      const frozen = probe.lastUnkeyedAt();
      await window.__sleep(600);
      HTMLCanvasElement.prototype.getContext = realGet;
      other.getTracks().forEach((t) => t.stop());
      return { plain, keyed, switched: probe.lastUnkeyedAt() > at2, stopped: probe.lastUnkeyedAt() === frozen,
        contexts, count: VideoEffects.keyInCount(), live: src.getVideoTracks()[0].readyState };
    });
    expect(seen.plain).toEqual([0, true]);
    expect(seen.keyed).toBe(true);
    expect(seen.switched).toBe(true);
    expect(seen.stopped).toBe(true);
    expect(seen.contexts).toBe(0);
    expect(seen.count).toBe(0);
    expect(seen.live).toBe('live');
  });
});

// --- through a real codec --------------------------------------------------
//
// VideoEncoder/VideoDecoder (VP8, the codec PeerJS negotiates first), with the
// receiver's own passes run on each decoded frame through the processor's
// synthPass() — the same matte, soft mask and composite a live frame gets,
// read back synchronously, so nothing depends on frame timing.

test.describe('through VP8', () => {
  test.beforeEach(async ({ page }) => {
    await page.evaluate(() => {
      // A person as a sender's pipeline would produce one: a face with a
      // gradient and hair, a shirt, a silhouette feathered and pushed through
      // the composite's smoothstep, floored, with sensor grain. `frames` holds
      // the keyed frame and — for the frames scored — the camera and m.
      window.__person = (W, H, n, opts = {}) => {
        const s = W / 1280;
        const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return [c, c.getContext('2d', { willReadFrequently: true })]; };
        const [, pc] = mk(), [mcv, mc] = mk(), [, tc] = mk();
        let seed = 99;
        const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
        const draw = (ctx, t, mask) => {
          const dx = W * 0.03 * Math.sin(2 * Math.PI * t / 3.5), dy = H * 0.01 * Math.sin(2 * Math.PI * t / 1.7);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
          ctx.translate(dx, dy);
          const col = (c) => (mask ? '#fff' : c);
          let g = col('#3c4c96');
          if (!mask) { g = ctx.createLinearGradient(0, H * 0.75, 0, H); g.addColorStop(0, '#3c4c96'); g.addColorStop(1, '#28345e'); }
          ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(W * 0.5, H * 1.08, W * 0.25, H * 0.3, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = col('#a8785e'); ctx.fillRect(W * 0.46, H * 0.62, W * 0.08, H * 0.2);
          if (mask) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.ellipse(W * 0.5, H * 0.47, W * 0.09, H * 0.22, 0, 0, Math.PI * 2); ctx.fill(); }
          else {
            const gg = ctx.createRadialGradient(W * 0.47, H * 0.45, 5 * s, W * 0.5, H * 0.5, H * 0.24);
            gg.addColorStop(0, '#d8a888'); gg.addColorStop(1, '#a87458');
            ctx.fillStyle = gg; ctx.beginPath(); ctx.ellipse(W * 0.5, H * 0.47, W * 0.09, H * 0.22, 0, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#2e2018'; ctx.beginPath(); ctx.ellipse(W * 0.5, H * 0.33, W * 0.093, H * 0.095, 0, Math.PI, Math.PI * 2); ctx.fill();
          }
          ctx.setTransform(1, 0, 0, 1, 0, 0);
        };
        const Z = 0.1 * Math.min(W, H), P = 0.6 * Z;
        const sst = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
        const frames = [];
        const band = [];
        for (let i = 0; i < n; i++) {
          const t = 37 + i / 30;
          draw(pc, t, false);
          draw(mc, t, true);
          tc.filter = `blur(${Math.max(1, 7 * s).toFixed(1)}px)`;
          tc.fillStyle = '#000'; tc.fillRect(0, 0, W, H);
          tc.drawImage(mcv, 0, 0);
          tc.filter = 'none';
          const P8 = pc.getImageData(0, 0, W, H).data, M8 = tc.getImageData(0, 0, W, H).data;
          const keep = !opts.keep || opts.keep.includes(i);
          const out = new ImageData(W, H), d = out.data;
          const m = keep ? new Float32Array(W * H) : null, cam = keep ? new Float32Array(W * H * 3) : null;
          for (let j = 0; j < W * H; j++) {
            const x = j % W, y = (j / W) | 0;
            let a = sst(0.12, 0.78, M8[j * 4] / 255);
            if (a < 0.06) a = 0;
            const inTL = x < Z && y < Z, inTR = x >= W - Z && y < Z;
            if (inTL || inTR) a = 0;
            const gn = (rnd() - 0.5) * 8;
            const cv = [0, 1, 2].map((ch) => Math.min(255, Math.max(0, P8[j * 4 + ch] + gn)));
            if (cam) { cam[j * 3] = cv[0] / 255; cam[j * 3 + 1] = cv[1] / 255; cam[j * 3 + 2] = cv[2] / 255; m[j] = a; }
            if (a > 0.3 && a < 0.98 && (j % 3) === 0) band.push((cv[1] - Math.max(cv[0], cv[2])) / 255);
            const patch = inTR && Math.abs(x + 0.5 - (W - Z / 2)) < P / 2 && Math.abs(y + 0.5 - Z / 2) < P / 2;
            d[j * 4] = patch ? 0 : cv[0] * a;
            d[j * 4 + 1] = patch ? 0 : 255 * (1 - a) + cv[1] * a;
            d[j * 4 + 2] = patch ? 0 : cv[2] * a;
            d[j * 4 + 3] = 255;
          }
          frames.push({ keyed: out, m, cam });
        }
        band.sort((a, b) => a - b);
        // What the sender would put in its offer as edgeE.
        const edgeE = Math.min(0, band[band.length >> 1] || 0);
        return { frames, edgeE };
      };

      // A detailed, slowly drifting picture: the composite a sender sends
      // before it switches a peer to keyed.
      window.__composite = (W, H, t) => {
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const ctx = c.getContext('2d');
        const nz = document.createElement('canvas'); nz.width = 256; nz.height = 256;
        const nc = nz.getContext('2d'), id = nc.createImageData(256, 256);
        let seed = 3; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
        for (let i = 0; i < id.data.length; i += 4) { id.data[i] = 60 + rnd() * 160; id.data[i + 1] = 60 + rnd() * 140; id.data[i + 2] = 50 + rnd() * 150; id.data[i + 3] = 255; }
        nc.putImageData(id, 0, 0);
        ctx.drawImage(nz, -32 - 8 * Math.sin(t * 0.3), -32, W + 64, H + 64);
        return ctx.getImageData(0, 0, W, H);
      };

      // Encode `images` (ImageData[]) as one VP8 stream at `bitrate` and hand
      // back every decoded frame as ImageData.
      window.__vp8 = async (images, W, H, bitrate) => {
        const decoded = [];
        let failed = null, bytes = 0;
        const dc = document.createElement('canvas'); dc.width = W; dc.height = H;
        const dctx = dc.getContext('2d', { willReadFrequently: true });
        const dec = new VideoDecoder({
          output: (f) => { dctx.drawImage(f, 0, 0, W, H); decoded[Math.round(f.timestamp * 30 / 1e6)] = dctx.getImageData(0, 0, W, H); f.close(); },
          error: (e) => { failed = e.message; },
        });
        dec.configure({ codec: 'vp8', codedWidth: W, codedHeight: H });
        const enc = new VideoEncoder({
          output: (chunk) => { bytes += chunk.byteLength; dec.decode(chunk); },
          error: (e) => { failed = e.message; },
        });
        enc.configure({ codec: 'vp8', width: W, height: H, framerate: 30, bitrate, bitrateMode: 'constant', latencyMode: 'realtime' });
        const fc = document.createElement('canvas'); fc.width = W; fc.height = H;
        const fctx = fc.getContext('2d');
        for (let i = 0; i < images.length; i++) {
          fctx.putImageData(images[i], 0, 0);
          const f = new VideoFrame(fc, { timestamp: Math.round(i * 1e6 / 30) });
          enc.encode(f, { keyFrame: i === 0 });
          f.close();
          await enc.flush();
        }
        await dec.flush();
        enc.close(); dec.close();
        if (failed) throw new Error(failed);
        return { decoded, kbps: Math.round(bytes * 8 / 1000 / (images.length / 30)) };
      };

      window.__canvasOf = (img) => {
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        c.getContext('2d').putImageData(img, 0, 0);
        return c;
      };
      window.__keyLike = (px) => px[1] > 0.75 * 255 && px[0] < 0.25 * 255 && px[2] < 0.25 * 255;

      // A receiver to run frames through, paused so only synthPass() draws,
      // with the scene's shadow and wrap off so its background is the scene.
      window.__receiver = async (W, H) => {
        const h = await window.__start();
        const p = window.__p;
        h.setPaused(true);
        await window.__sleep(100);
        // After the resize: ensureScene() puts the catalogue's scene back.
        if (W && H) p.resize(W, H);
        p.scene = Object.assign({}, p.scene, { shadow: 0, wrap: 0 });
        return p;
      };
    });
  });

  test('the edge band, scored on colour against the sender\'s composite', async ({ page }) => {
    test.setTimeout(180_000);
    const seen = await page.evaluate(async () => {
      const W = 640, H = 360, PICK = [20, 30, 40];
      const p = await window.__receiver(W, H);
      const person = window.__person(W, H, 45, { keep: PICK });
      p.edgeE = person.edgeE;
      const scene = new Uint8Array(W * H * 4);
      const score = (decodedAt) => {
        const all = { band: [], inside: [], outside: [] };
        for (const fi of PICK) {
          const out = p.synthPass(window.__canvasOf(decodedAt(fi)), null, true);
          const gl = p.gl;
          gl.bindFramebuffer(gl.FRAMEBUFFER, p.fbSceneOut[p.sceneOut]);
          gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, scene);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          const { m, cam } = person.frames[fi];
          for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
              const j = y * W + x, mm = m[j], so = ((H - 1 - y) * W + x) * 4;
              let err = 0;
              for (let c = 0; c < 3; c++) {
                const truth = scene[so + c] * (1 - mm) + cam[j * 3 + c] * 255 * mm;
                err = Math.max(err, Math.abs(out[j * 4 + c] - truth));
              }
              if (mm > 0.02 && mm < 0.98) all.band.push(err);
              else if (mm >= 0.98) all.inside.push(err);
              else if ((x + y) % 7 === 0) all.outside.push(err);
            }
          }
        }
        const pct = (a, q) => { const s = Float32Array.from(a).sort(); return +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(1); };
        const mean = (a) => +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(1);
        return { bandMean: mean(all.band), bandP95: pct(all.band, 0.95), bandMax: pct(all.band, 0.999),
          insideP99: pct(all.inside, 0.99), outsideP99: pct(all.outside, 0.99), bandPixels: all.band.length };
      };
      const none = score((fi) => person.frames[fi].keyed);
      const vp8 = await window.__vp8(person.frames.map((f) => f.keyed), W, H, 450000);
      const coded = score((fi) => vp8.decoded[fi]);
      return { edgeE: +person.edgeE.toFixed(3), none, vp8: Object.assign({ kbps: vp8.kbps }, coded) };
    });
    console.log('[keyed band colour error, levels]', JSON.stringify(seen));
    expect(seen.edgeE).toBeLessThan(0);
    expect(seen.none.bandPixels).toBeGreaterThan(5000);
    // The formula alone (no codec) and through VP8 at 450 kb/s, 640x360.
    // Measured at 13 and 27 levels. The ramp re-stretched over 0.06-0.94
    // scored 17 and 30, and the design's first formula 36 and 42 in the
    // critique's version of this measurement: the first bound is what keeps
    // the receiver honouring the sender's floor exactly.
    expect(seen.none.bandP95).toBeLessThanOrEqual(16);
    expect(seen.vp8.bandP95).toBeLessThanOrEqual(30);
    // Away from the edge the codec is all there is.
    expect(seen.vp8.insideP99).toBeLessThanOrEqual(24);
    expect(seen.vp8.outsideP99).toBeLessThanOrEqual(16);
  });

  test('the markers survive a starved encoder at 320x180 and 160x90', async ({ page }) => {
    test.setTimeout(180_000);
    const seen = await page.evaluate(async () => {
      const p = await window.__receiver();
      const out = {};
      for (const [W, H, bitrate] of [[320, 180, 100000], [160, 90, 40000]]) {
        const person = window.__person(W, H, 60, { keep: [] });
        const vp8 = await window.__vp8(person.frames.map((f) => f.keyed), W, H, bitrate);
        const Z = 0.1 * Math.min(W, H), zone = [Z / 2 / W, Z / 2 / H];
        let strict = 0, relaxed = 0, n = 0;
        // Steady state: past the first keyframe's settling.
        for (let i = 10; i < vp8.decoded.length; i++) {
          if (!vp8.decoded[i]) continue;
          const c = window.__canvasOf(vp8.decoded[i]);
          n++;
          if (!window.__keyLike(p.synthPass(c, [zone], false)[0])) strict++;
          if (!window.__keyLike(p.synthPass(c, [zone], true)[0])) relaxed++;
        }
        out[W + 'x' + H] = { kbps: vp8.kbps, frames: n, strict, relaxed };
      }
      return out;
    });
    console.log('[marker detection through VP8]', JSON.stringify(seen));
    for (const k of ['320x180', '160x90']) {
      expect(seen[k].frames).toBeGreaterThan(40);
      // A receiver that has said it is ready never misses a keyed frame.
      expect(seen[k].relaxed).toBe(seen[k].frames);
    }
    // And one that has not still finds the whole pattern at 320x180.
    expect(seen['320x180'].strict).toBe(seen['320x180'].frames);
  });

  test('a switch from the composite to keyed on a starved link shows no green screen', async ({ page }) => {
    test.setTimeout(180_000);
    const seen = await page.evaluate(async () => {
      const W = 320, H = 180, SWITCH = 30, N = 75;
      const p = await window.__receiver();
      const person = window.__person(W, H, N - SWITCH, { keep: [] });
      const images = [];
      for (let i = 0; i < SWITCH; i++) images.push(window.__composite(W, H, i / 30));
      person.frames.forEach((f) => images.push(f.keyed));
      // The background region, either side of the person.
      const pts = [];
      for (let y = 0.15; y < 0.95; y += 0.08) for (const x of [0.06, 0.12, 0.18, 0.24, 0.76, 0.82, 0.88, 0.94]) pts.push([x, y]);
      const out = {};
      for (const bitrate of [60000, 112000]) {
        const vp8 = await window.__vp8(images, W, H, bitrate);
        let worst = 0, keyedFrames = 0, frames = 0;
        for (let i = SWITCH; i < N; i++) {
          if (!vp8.decoded[i]) continue;
          frames++;
          const px = p.synthPass(window.__canvasOf(vp8.decoded[i]), pts, true);
          const green = px.filter((c) => c[1] - Math.max(c[0], c[2]) > 0.45 * 255).length / pts.length;
          worst = Math.max(worst, green);
          if (!window.__keyLike(p.synthPass(window.__canvasOf(vp8.decoded[i]), [[0.05 * H / W, 0.05]], true)[0])) keyedFrames++;
        }
        out[bitrate] = { kbps: vp8.kbps, frames, keyedFrames, worstGreenShare: +worst.toFixed(3) };
      }
      return out;
    });
    console.log('[composite -> keyed switch]', JSON.stringify(seen));
    for (const b of ['60000', '112000']) {
      expect(seen[b].frames).toBeGreaterThan(40);
      expect(seen[b].worstGreenShare).toBeLessThanOrEqual(0.15);
      expect(seen[b].keyedFrames).toBeGreaterThan(seen[b].frames - 10);
    }
  });
});
