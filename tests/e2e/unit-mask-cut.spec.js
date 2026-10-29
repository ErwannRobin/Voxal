import { test, expect } from './fixtures.js';

// The confidence cut: a raw mask value at or below MASK_CUT (78%) is
// background, outright, before the temporal blend, dilate and feather ever see
// it. The model says 20-70% where it is unsure (a lamp over the head, a
// shoulder rim) and the composite's window used to keep a visible share of all
// of it.
//
// Inference is stubbed (see unit-video-effects.spec.js); these tests hand the
// pipeline crafted mask values directly, so what is pinned is OUR arithmetic,
// not the model. How it looks on a person needs a real camera.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { window.__voxalSegStub = true; });
  await page.goto('/');
  await page.evaluate(() => {
    window.__mkStream = function () {
      const c = document.createElement('canvas');
      c.width = 320; c.height = 240;
      const ctx = c.getContext('2d');
      let n = 0;
      const paint = () => {
        ctx.fillStyle = '#0a0'; ctx.fillRect(0, 0, 320, 240);
        ctx.fillStyle = '#0f0'; ctx.fillRect((n++ * 7) % 320, 0, 2, 2);
      };
      paint();
      const stream = c.captureStream(15);
      const timer = setInterval(paint, 40);
      stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
      return stream;
    };
  });
});

async function start(page) {
  await page.evaluate(async () => {
    window.__out = await VideoEffects.wrap(window.__mkStream(), 'blur');
  });
  await page.waitForFunction(() => (window.__voxalSegCalls || 0) > 2);
}

// Raw values to feed, as 0-255, and where they end up in the blend state.
const LEVELS = [0.20, 0.50, 0.70, 0.78, 0.81, 0.90, 1.0];

async function feed(page, cut) {
  return page.evaluate(({ levels, cut }) => {
    const p = VideoEffects.active(), gl = p.gl;
    p.paused = true;                       // the live loop must not interleave
    p.maskCut = cut;
    p.maskPrimed = false;                  // the first mask is taken whole: S = what the cut made
    const W = p.segW, H = p.segH, n = W * H;
    const data = new Uint8Array(n);
    const band = Math.floor(W / levels.length);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = Math.min(levels.length - 1, Math.floor(x / band));
        data[y * W + x] = Math.round(levels[i] * 255);
      }
    }
    p.uploadMask(data, W, H);
    const read = (tex) => {
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const b = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, b);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      // One value per band, read at the band's centre row.
      const row = Math.floor(H / 2), out = [];
      for (let k = 0; k < levels.length; k++) out.push(b[(row * W + Math.floor((k + 0.5) * band)) * 4]);
      return out;
    };
    return { raw: read(p.texMaskRaw), blended: read(p.texMaskS) };
  }, { levels: LEVELS, cut });
}

test('the cut: everything at or under 78% is background, above ~84% is kept whole', async ({ page }) => {
  await start(page);
  const r = await feed(page, 0.78);
  // 0.20, 0.50, 0.70 and 0.78 itself: gone.
  expect(r.blended.slice(0, 4)).toEqual([0, 0, 0, 0]);
  // Inside the short ramp above the cut: partial.
  expect(r.blended[4]).toBeGreaterThan(0);
  expect(r.blended[4]).toBeLessThan(255);
  // Confident: whole.
  expect(r.blended[5]).toBe(255);
  expect(r.blended[6]).toBe(255);
});

test('the raw mask the diagnostic shows is never the cut one', async ({ page }) => {
  await start(page);
  const r = await feed(page, 0.78);
  // texMaskRaw is B: exactly what was fed, 0.50 -> 128, while the blend state is 0.
  expect(r.raw[1]).toBe(128);
  expect(r.blended[1]).toBe(0);
});

test('a cut of 0 turns it off: the blend sees the raw values, as before', async ({ page }) => {
  await start(page);
  const r = await feed(page, 0);
  expect(r.blended).toEqual(r.raw);
});

test('?maskcut= and window.__voxalMaskCut move it, and it is clamped', async ({ page }) => {
  const r = await page.evaluate(() => {
    const read = VideoEffects._maskCut.read;
    const out = { def: read(), cfg: VideoEffects._maskCut.cut };
    window.__voxalMaskCut = 0; out.off = read();
    window.__voxalMaskCut = 0.6; out.moved = read();
    window.__voxalMaskCut = 7; out.clamped = read();
    window.__voxalMaskCut = 'nonsense'; out.junk = read();
    return out;
  });
  expect(r.def).toBe(0.78);
  expect(r.cfg).toBe(0.78);
  expect(r.off).toBe(0);
  expect(r.moved).toBe(0.6);
  expect(r.clamped).toBeLessThanOrEqual(0.94);
  expect(r.junk).toBe(0.78);

  await page.goto('/?maskcut=0.5');
  expect(await page.evaluate(() => VideoEffects._maskCut.read())).toBe(0.5);
  await page.goto('/?maskcut=0');
  expect(await page.evaluate(() => VideoEffects._maskCut.read())).toBe(0);
});

test('a clean 0/255 mask is unchanged by the cut: the published frame is identical', async ({ page }) => {
  await start(page);
  const r = await page.evaluate(() => {
    const p = VideoEffects.active(), gl = p.gl, w = p.canvas.width, h = p.canvas.height;
    p.paused = true;
    const read = () => {
      const b = new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b);
      return b;
    };
    const W = p.segW, H = p.segH, data = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const dx = (x - W / 2) / (W * 0.22), dy = (y - H * 0.6) / (H * 0.45);
        data[y * W + x] = dx * dx + dy * dy < 1 ? 255 : 0;
      }
    }
    const frame = (cut) => {
      p.maskCut = cut; p.maskPrimed = false;
      p.uploadMask(data, W, H);
      p.draw(performance.now());
      return read();
    };
    const off = frame(0), on = frame(0.78);
    let diff = 0;
    for (let i = 0; i < off.length; i++) if (off[i] !== on[i]) diff++;
    return diff;
  });
  expect(r).toBe(0);
});
