import { test, expect } from './fixtures.js';

// Holes and dropouts in the mask.
//
//   * A pocket of low confidence ENCLOSED by person (a pattern on a shirt, a
//     pair of glasses) is filled; a channel that opens to the room (the gap
//     between a raised arm and the torso) is not.
//   * A pixel that was confidently person and is dropped outright lets go
//     slowly while the camera's picture has not changed under it, and at the
//     normal pace when it has.
//
// Inference is stubbed (see unit-mask-cut.spec.js): these tests hand the
// pipeline crafted masks, so what is pinned is OUR arithmetic, not the model.

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
  await page.evaluate(async () => {
    window.__out = await VideoEffects.wrap(window.__mkStream(), 'blur');
  });
  await page.waitForFunction(() => (window.__voxalSegCalls || 0) > 2);
});

// Upload `fill(x, y, W, H)` (0-1) as the mask and read a texture's value at the
// given places (fractions of the mask's width and height). `primed` = false takes the mask whole, true blends into the last.
function run(page, { fill, texture, at, primed, camera, flags }) {
  return page.evaluate(({ fillSrc, texture, at, primed, camera, flags }) => {
    const p = VideoEffects.active(), gl = p.gl;
    p.paused = true;
    p.maskCut = 0;
    Object.keys(flags || {}).forEach((k) => { window[k] = flags[k]; });
    if (camera) {
      const c = p.segCanvas.getContext('2d');
      c.fillStyle = camera; c.fillRect(0, 0, p.segCanvas.width, p.segCanvas.height);
    }
    const W = p.segW, H = p.segH;
    const f = new Function('x', 'y', 'W', 'H', 'return (' + fillSrc + ')(x, y, W, H);');
    const data = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = Math.round(255 * f(x, y, W, H));
    if (primed === false) p.maskPrimed = false;
    p.uploadMask(data, W, H);
    const tex = p[texture];
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const b = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, b);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    Object.keys(flags || {}).forEach((k) => { delete window[k]; });
    return at.map(([fx, fy]) => b[(Math.floor(fy * H) * W + Math.floor(fx * W)) * 4]);
  }, { fillSrc: fill.toString(), texture, at, primed, camera, flags });
}

// A disc of person, with whatever `extra` carves out of it.
const disc = (extra) => `(x, y, W, H) => {
  const dx = x - W / 2, dy = y - H / 2;
  if (dx * dx + dy * dy > 40 * 40) return 0;
  return (${extra})(x, y, W, H);
}`;

const POCKET = `(x, y, W, H) => (Math.abs(x - W / 2) < 5 && Math.abs(y - H / 2) < 5 ? 0.3 : 1)`;
// A channel 9 texels wide from the middle of the disc out through its right edge.
const CHANNEL = `(x, y, W, H) => (y > H / 2 - 5 && y < H / 2 + 5 && x > W / 2 ? 0 : 1)`;

test('a pocket enclosed by person is filled', async ({ page }) => {
  const [v] = await run(page, { fill: disc(POCKET), texture: 'texMaskA', at: [[0.5, 0.5]], primed: false });
  expect(v).toBeGreaterThan(230);
});

test('with hole filling off the same pocket stays open', async ({ page }) => {
  const [v] = await run(page, { fill: disc(POCKET), texture: 'texMaskA', at: [[0.5, 0.5]], primed: false,
    flags: { __voxalHoleFill: false } });
  // 0.3 in the blend, 151 once the feather has mixed the person in from the sides.
  expect(v).toBeLessThan(200);
});

test('a channel that opens to the room is not closed', async ({ page }) => {
  // Deep in the channel (22 texels in, well inside the disc), and just beside its mouth's inner end.
  const [inside, rim] = await run(page, { fill: disc(CHANNEL), texture: 'texMaskA', at: [[0.586, 0.5], [0.47, 0.5]], primed: false });
  expect(inside).toBeLessThan(120);
  expect(rim).toBeGreaterThan(230);
});

test('the filled pocket is derived, never written back to the blend state', async ({ page }) => {
  const [v] = await run(page, { fill: disc(POCKET), texture: 'texMaskS', at: [[0.5, 0.5]], primed: false });
  expect(v).toBeLessThan(120);
});

// --- the hold ---------------------------------------------------------------

const ALL = '() => 1';
const GONE = '(x, y, W, H) => (x > W / 2 ? 0 : 1)';

async function holdAfterDrop(page, { cameraChanges, flags }) {
  await run(page, { fill: ALL, texture: 'texMaskS', at: [[0.78, 0.5]], primed: false, camera: '#123456' });
  await run(page, { fill: ALL, texture: 'texMaskS', at: [[0.78, 0.5]], primed: true, camera: '#123456' });
  const [v] = await run(page, { fill: GONE, texture: 'texMaskS', at: [[0.78, 0.5]], primed: true,
    camera: cameraChanges ? '#d0b060' : '#123456', flags });
  return v;
}

test('a confident pixel dropped under an unchanged picture lets go slowly', async ({ page }) => {
  const held = await holdAfterDrop(page, { cameraChanges: false });
  // 255 -> 255 * (1 - 0.6 * 0.3) = 209.
  expect(held).toBeGreaterThan(190);
});

test('the same drop under a changed picture goes at the normal pace', async ({ page }) => {
  const moved = await holdAfterDrop(page, { cameraChanges: true });
  // 255 * (1 - 0.6) = 102.
  expect(moved).toBeLessThan(120);
});

test('window.__voxalHold = false turns the hold off', async ({ page }) => {
  const off = await holdAfterDrop(page, { cameraChanges: false, flags: { __voxalHold: false } });
  expect(off).toBeLessThan(120);
});
