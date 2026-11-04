import { test, expect } from './fixtures.js';

// Compare engines (VideoEffects.compareStart(), or the Engines tab of the
// segmentation diagnostic): every segmentation engine handed the same frames at
// once, and your own video split into one tile per engine — each tile the full
// composite drawn with that engine's mask.
//
// No real model runs here (`__voxalSegStub`, see unit-seg-diagnostic.spec.js), so
// every engine is a stand-in. That is enough to pin what is OURS: which engines
// are offered, that guests are fed the primary's frames and can be paused,
// failed or closed without touching the picture, that a failing engine is
// REPORTED rather than replaced by another model, that each tile is drawn from
// the right engine's mask and laid out the right way round, and that the call is
// sent exactly what it is sent without any of it.

async function installHelpers(page) {
  await page.evaluate(() => {
    window.__mkStream = function () {
      const c = document.createElement('canvas');
      c.width = 320; c.height = 240;
      const ctx = c.getContext('2d');
      let n = 0;
      const paint = () => {
        ctx.fillStyle = '#0a0';
        ctx.fillRect(0, 0, 320, 240);
        ctx.fillStyle = '#0f0';
        ctx.fillRect((n++ * 7) % 320, 0, 2, 2);
      };
      paint();
      const stream = c.captureStream(15);
      const timer = setInterval(paint, 40);
      stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
      return stream;
    };
    window.__until = async function (fn, ms = 10000) {
      for (let i = 0; i < ms / 50; i++) {
        if (fn()) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    };
    // A guest that answers with `maskFn(w, h)` and counts its calls and closes.
    window.__guest = function (maskFn, log) {
      return {
        close() { log.closed++; },
        segmentForVideo(frame, ts, cb) {
          log.calls++;
          const w = frame.width, h = frame.height;
          const data = maskFn(w, h);
          cb({ confidenceMasks: [{ width: w, height: h, getAsUint8Array: () => data }] });
        },
      };
    };
    // The split view's canvas: the canvas behind the self-view's stream.
    window.__splitCanvas = function () {
      const s = VideoEffects.selfView(window.__out);
      const t = s && s.getVideoTracks()[0];
      return t && t.canvas;
    };
    // A pixel of one engine's tile, at (fx, fy) as fractions of the tile.
    window.__tilePx = function (name, fx, fy) {
      const tile = VideoEffects.compareState().split.tiles.find((t) => t.name === name);
      const cv = window.__splitCanvas();
      const x = Math.floor(tile.x + tile.w * fx), y = Math.floor(tile.y + tile.h * fy);
      return Array.from(cv.getContext('2d').getImageData(x, y, 1, 1).data);
    };
    // Resolves once the split has drawn `n` more frames.
    window.__splitFrames = async function (n) {
      const f0 = VideoEffects.compareState().split.frames;
      return window.__until(() => VideoEffects.compareState().split.frames >= f0 + n);
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { window.__voxalSegStub = true; });
  await page.goto('/');
  await installHelpers(page);
});

async function start(page) {
  await page.evaluate(async () => {
    window.__out = await VideoEffects.wrap(window.__mkStream(), 'blur');
  });
  await page.waitForFunction(() => (window.__voxalSegCalls || 0) > 2);
}

const state = (page) => page.evaluate(() => VideoEffects.compareState());

test('off by default: no guest, nothing painted, the camera runs on its own', async ({ page }) => {
  await start(page);
  const s = await state(page);
  expect(s.on).toBe(false);
  expect(s.entries).toEqual([]);
});

test('the Engines tab runs every engine this build has, the driving one first', async ({ page }) => {
  await start(page);
  await page.evaluate(() => VideoEffects.openDiagnostic('compare'));
  expect(await page.evaluate(() => window.__until(() =>
    VideoEffects.compareState().entries.length >= 4 &&
    VideoEffects.compareState().entries.every((e) => e.masks > 0)))).toBe(true);
  const s = await state(page);
  expect(s.on).toBe(true);
  expect(s.entries.map((e) => e.name)).toEqual(['mediapipe', 'longpipe', 'rvm', 'p3m']);
  expect(s.entries[0].primary).toBe(true);
  expect(s.entries.slice(1).every((e) => !e.primary && e.state === 'running')).toBe(true);
  expect(s.reference).toBe('mediapipe');
  // The stand-ins all draw the same oval: every guest agrees with the reference.
  for (const e of s.entries.slice(1)) expect(e.iou).toBeGreaterThan(0.98);
  await expect(page.locator('#seg-diagnostic [aria-pressed="true"]').first()).toHaveText('Engines');
  await expect(page.locator('#seg-diagnostic table tr[data-engine="p3m"]')).toBeVisible();
});

test('leaving the compare view closes every guest; the camera is untouched', async ({ page }) => {
  await start(page);
  const r = await page.evaluate(async () => {
    const log = { closed: 0, calls: 0 };
    window.__voxalCompareStub = (name) => (name === 'rvm' ? window.__guest((w, h) => new Uint8Array(w * h).fill(255), log) : null);
    VideoEffects.openDiagnostic('compare');
    await window.__until(() => log.calls > 3);
    const during = log.calls;
    VideoEffects.setDiagnosticView('grid');
    const after = VideoEffects.compareState();
    const callsAtLeave = log.calls;
    await new Promise((r) => setTimeout(r, 600));
    return { during, closed: log.closed, on: after.on, entries: after.entries.length,
             stillFed: log.calls - callsAtLeave, track: window.__out.getVideoTracks()[0].readyState };
  });
  expect(r.during).toBeGreaterThan(3);
  expect(r.closed).toBe(1);
  expect(r.on).toBe(false);
  expect(r.entries).toBe(0);
  expect(r.stillFed).toBe(0);
  expect(r.track).toBe('live');
});

test('an engine that cannot start is reported with its reason, and the others carry on', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    window.__voxalRvmStub = { InferenceSession: { create: () => Promise.reject(new Error('no weights here')) }, env: { wasm: {} } };
    window.__voxalCompareStub = null;
    VideoEffects.openDiagnostic('compare');
  });
  expect(await page.evaluate(() => window.__until(() =>
    VideoEffects.compareState().entries.some((e) => e.name === 'rvm' && e.state === 'failed')))).toBe(true);
  const s = await state(page);
  const rvm = s.entries.find((e) => e.name === 'rvm');
  expect(rvm.error).not.toBe('');
  // Reported, not swapped for another model: no mask was ever drawn for it.
  expect(rvm.masks).toBe(0);
  expect(s.entries.find((e) => e.name === 'longpipe').state).toBe('running');
  await expect(page.locator('#seg-diagnostic tr[data-engine="rvm"]')).toContainText('failed');
  expect(await page.evaluate(() => VideoEffects.engine())).toBe('mediapipe');
});

test('unticking an engine stops feeding it; ticking resumes', async ({ page }) => {
  await start(page);
  const r = await page.evaluate(async () => {
    const log = { closed: 0, calls: 0 };
    window.__voxalCompareStub = (name) => (name === 'longpipe' ? window.__guest((w, h) => new Uint8Array(w * h), log) : null);
    VideoEffects.openDiagnostic('compare');
    await window.__until(() => log.calls > 2);
    VideoEffects.comparePause('longpipe', true);
    const at = log.calls;
    await new Promise((x) => setTimeout(x, 500));
    const paused = log.calls - at;
    const state = VideoEffects.compareState().entries.find((e) => e.name === 'longpipe').state;
    VideoEffects.comparePause('longpipe', false);
    await new Promise((x) => setTimeout(x, 500));
    return { paused, state, resumed: log.calls - at, refusedPrimary: VideoEffects.comparePause('mediapipe', true) };
  });
  expect(r.paused).toBe(0);
  expect(r.state).toBe('paused');
  expect(r.resumed).toBeGreaterThan(0);
  expect(r.refusedPrimary).toBe(false);   // the one driving the picture cannot be paused
});

test('your own video is split by engine, the driving one first; nobody else gets the split', async ({ page }) => {
  await start(page);
  const r = await page.evaluate(async () => {
    let changes = 0;
    VideoEffects.onSelfViewChange(() => changes++);
    const before = VideoEffects.selfView(window.__out);
    VideoEffects.openDiagnostic('compare');
    await window.__until(() => VideoEffects.compareState().entries.every((e) => e.masks > 0));
    await window.__splitFrames(3);
    const during = VideoEffects.selfView(window.__out);
    const st = VideoEffects.compareState().split;
    const other = VideoEffects.selfView(new MediaStream());
    VideoEffects.setDiagnosticView('grid');
    return {
      before: before === window.__out, during: during !== window.__out && !!during, other: other !== during,
      after: VideoEffects.selfView(window.__out) === window.__out,
      ended: during.getVideoTracks()[0].readyState, changes,
      tiles: st.tiles.map((t) => t.name), ready: st.tiles.every((t) => t.ready), w: st.width, h: st.height,
      geo: st.tiles.map((t) => [t.x, t.y, t.w, t.h]),
      published: window.__out.getVideoTracks()[0].readyState,
    };
  });
  expect(r.before).toBe(true);
  expect(r.during).toBe(true);
  expect(r.other).toBe(true);       // only the camera pipeline's own stream is swapped
  expect(r.after).toBe(true);
  expect(r.ended).toBe('ended');     // leaving the tab ends the split
  expect(r.changes).toBe(2);         // once on, once off
  expect(r.tiles).toEqual(['mediapipe', 'longpipe', 'rvm', 'p3m']);
  expect(r.ready).toBe(true);
  // 2x2, each a quarter of the picture, MediaPipe (driving) top-left.
  expect(r.geo[0]).toEqual([0, 0, r.w / 2, r.h / 2]);
  expect(r.geo[1]).toEqual([r.w / 2, 0, r.w / 2, r.h / 2]);
  expect(r.geo[3]).toEqual([r.w / 2, r.h / 2, r.w / 2, r.h / 2]);
  expect(r.published).toBe('live');
});

test("each tile is drawn from that engine's own mask, through the whole pipeline", async ({ page }) => {
  await start(page);
  await page.evaluate(async () => {
    // longpipe: only the LEFT half is person; every other stand-in draws the
    // centred oval (x 28-72%, y 15-100%).
    window.__voxalCompareStub = (name) => (name === 'longpipe'
      ? window.__guest((w, h) => { const d = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w / 2; x++) d[y * w + x] = 255; return d; },
        { closed: 0, calls: 0 })
      : null);
    VideoEffects.compareSetView('matte');
    VideoEffects.openDiagnostic('compare');
    await window.__until(() => VideoEffects.compareState().entries.every((e) => e.masks > 3));
    await window.__splitFrames(4);
  });
  const px = (n, x, y) => page.evaluate(([a, b, c]) => window.__tilePx(a, b, c), [n, x, y]);
  // The matte: white is the person, black the room, grey (R = G = B).
  const oval = await px('mediapipe', 0.5, 0.6);
  expect(oval[0]).toBeGreaterThan(235);
  expect(Math.abs(oval[0] - oval[2])).toBeLessThan(3);
  expect((await px('mediapipe', 0.92, 0.6))[0]).toBeLessThan(20);
  expect((await px('rvm', 0.5, 0.6))[0]).toBeGreaterThan(235);
  // longpipe's tile is its own mask: left half white, right half black.
  expect((await px('longpipe', 0.2, 0.6))[0]).toBeGreaterThan(235);
  expect((await px('longpipe', 0.85, 0.6))[0]).toBeLessThan(20);
  const s = await state(page);
  const lp = s.entries.find((e) => e.name === 'longpipe');
  expect(lp.iou).toBeGreaterThan(0.2);
  expect(lp.iou).toBeLessThan(0.7);
  expect(lp.person).toBeGreaterThan(0.45);
  expect(lp.person).toBeLessThan(0.55);

  // The result view is the composite: the green camera, not a grey matte.
  await page.evaluate(async () => { VideoEffects.compareSetView('result'); await window.__splitFrames(3); });
  const res = await px('longpipe', 0.2, 0.6);
  expect(res[1]).toBeGreaterThan(120);
  expect(res[0]).toBeLessThan(80);
});

test('two engines stand side by side, each showing the middle of the picture', async ({ page }) => {
  await start(page);
  await page.evaluate(async () => {
    VideoEffects.compareSetView('matte');
    VideoEffects.openDiagnostic('compare');
    await window.__until(() => VideoEffects.compareState().entries.every((e) => e.state === 'running'));
    VideoEffects.comparePause('rvm', true);
    VideoEffects.comparePause('p3m', true);
    await window.__splitFrames(4);
  });
  const st = (await state(page)).split;
  expect(st.tiles.map((t) => t.name)).toEqual(['mediapipe', 'longpipe']);
  expect(st.tiles[0]).toMatchObject({ x: 0, y: 0, w: st.width / 2, h: st.height });
  expect(st.tiles[1]).toMatchObject({ x: st.width / 2, y: 0, w: st.width / 2, h: st.height });
  // The tile shows the middle half of the frame at full scale: 12% into the
  // tile is 31% of the frame — inside the oval (28-72%). Squeezed instead, it
  // would be 12% of the frame: the room.
  expect((await page.evaluate(() => window.__tilePx('mediapipe', 0.12, 0.6)))[0]).toBeGreaterThan(200);
});

test('a front camera is shown mirrored, so the tiles are laid out mirrored to read the right way', async ({ page }) => {
  await start(page);
  await page.evaluate(async () => {
    VideoEffects.openDiagnostic('compare');
    VideoEffects.selfView(window.__out, true);
    await window.__until(() => VideoEffects.compareState().split.tiles.length === 4);
    await window.__splitFrames(2);
  });
  const st = (await state(page)).split;
  expect(st.mirror).toBe(true);
  const at = (n) => st.tiles.find((t) => t.name === n);
  // Seen through the self-view's mirror, the driving engine is top-left again.
  expect(at('mediapipe').x).toBe(st.width / 2);
  expect(at('longpipe').x).toBe(0);
});

test('a name shows that engine alone on your video; again, all of them', async ({ page }) => {
  await start(page);
  await page.evaluate(() => VideoEffects.openDiagnostic('compare'));
  expect(await page.evaluate(() => window.__until(() =>
    VideoEffects.compareState().entries.every((e) => e.state === 'running')))).toBe(true);
  await page.getByRole('button', { name: 'Show only Longpipe' }).click();
  await page.evaluate(() => window.__splitFrames(2));
  let st = await state(page);
  expect(st.focus).toBe('longpipe');
  expect(st.split.tiles.map((t) => [t.name, t.x, t.y, t.w, t.h])).toEqual([['longpipe', 0, 0, st.split.width, st.split.height]]);
  await page.getByRole('button', { name: 'Show only Longpipe' }).click();
  await page.evaluate(() => window.__splitFrames(2));
  st = await state(page);
  expect(st.focus).toBe(null);
  expect(st.split.tiles.length).toBe(4);
});

test('Use moves the call to that engine', async ({ page }) => {
  await start(page);
  await page.evaluate(() => VideoEffects.openDiagnostic('compare'));
  expect(await page.evaluate(() => window.__until(() =>
    VideoEffects.compareState().entries.every((e) => e.state === 'running')))).toBe(true);
  await expect(page.locator('#seg-diagnostic tr[data-engine="mediapipe"] button.sd-use')).toHaveText('In call');
  await expect(page.locator('#seg-diagnostic tr[data-engine="mediapipe"] button.sd-use')).toBeDisabled();
  await page.getByRole('button', { name: 'Use Longpipe for the call' }).click();
  // The stand-in runtime has no Longpipe to swap to, so what is pinned is the
  // request: the choice is stored, exactly as the Tuning list stores it.
  expect(await page.evaluate(() => window.__until(() => LongpipeEngine.selected() === 'longpipe'))).toBe(true);
});

test("with Longpipe's own blur published, its tile is that picture and the call still gets it", async ({ page }) => {
  await start(page);
  const r = await page.evaluate(async () => {
    const p = VideoEffects.active();
    const red = document.createElement('canvas');
    red.width = 320; red.height = 240;
    const rc = red.getContext('2d'); rc.fillStyle = '#f00'; rc.fillRect(0, 0, 320, 240);
    const seg = window.__guest((w, h) => new Uint8Array(w * h).fill(255), { closed: 0, calls: 0 });
    seg.engine = 'longpipe';
    seg.directFrame = () => red;
    const old = p.segmenter;
    p.segmenter = null;
    old.close();
    p.adoptSegmenter(seg);
    VideoEffects.openDiagnostic('compare');
    await window.__until(() => VideoEffects.compareState().entries.length === 4 &&
      VideoEffects.compareState().split.tiles.every((t) => t.ready));
    await window.__splitFrames(3);
    const gl = p.gl, w = p.canvas.width, h = p.canvas.height;
    p.draw(performance.now());
    const b = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(Math.floor(w / 2), Math.floor(h / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b);
    return { published: Array.from(b), tile: window.__tilePx('longpipe', 0.5, 0.6), guest: window.__tilePx('mediapipe', 0.5, 0.6),
             first: VideoEffects.compareState().split.tiles[0].name };
  });
  expect(r.first).toBe('longpipe');
  expect(r.published[0]).toBeGreaterThan(240);   // the call: Longpipe's own picture
  expect(r.published[1]).toBeLessThan(15);
  expect(r.tile[0]).toBeGreaterThan(240);        // its tile: the same
  expect(r.tile[1]).toBeLessThan(15);
  expect(r.guest[1]).toBeGreaterThan(120);       // a guest's tile: our composite of the green camera
});

test('a new engine driving the picture becomes the reference; the old one a guest', async ({ page }) => {
  await start(page);
  await page.evaluate(() => VideoEffects.openDiagnostic('compare'));
  expect(await page.evaluate(() => window.__until(() => VideoEffects.compareState().entries.length === 4))).toBe(true);
  await page.evaluate(() => {
    const p = VideoEffects.active();
    const log = { closed: 0, calls: 0 };
    const seg = window.__guest((w, h) => new Uint8Array(w * h).fill(255), log);
    seg.engine = 'rvm';
    const old = p.segmenter;
    p.segmenter = null;
    old.close();
    p.adoptSegmenter(seg);
  });
  const s = await state(page);
  expect(s.entries[0]).toMatchObject({ name: 'rvm', primary: true });
  expect(s.entries.find((e) => e.name === 'mediapipe').primary).toBe(false);
  expect(s.entries.length).toBe(4);
  expect(s.reference === 'rvm' || s.reference === null).toBe(true);
});

test('a click on a pane of the pipeline overview opens that stage', async ({ page }) => {
  await start(page);
  await page.evaluate(() => VideoEffects.openDiagnostic('grid'));
  await page.waitForFunction(() => VideoEffects.diagnosticState().inference >= 2);
  await page.waitForTimeout(300);
  const box = await page.locator('#seg-diagnostic canvas').boundingBox();
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.25);  // grid: B, the raw mask
  expect(await page.evaluate(() => VideoEffects.diagnosticState().view)).toBe('raw');
  await expect(page.locator('#seg-diagnostic').getByLabel('One stage')).toHaveValue('raw');
});

test('the report names the device, the engine and every compared engine', async ({ page }) => {
  await start(page);
  await page.evaluate(() => VideoEffects.openDiagnostic('compare'));
  expect(await page.evaluate(() => window.__until(() => VideoEffects.compareState().entries.every((e) => e.masks > 0)))).toBe(true);
  await page.waitForFunction(() => VideoEffects.diagnosticState().inference >= 2);
  const text = await page.evaluate(() => VideoEffects.diagnosticReport());
  expect(text).toContain('Voxal segmentation report');
  expect(text).toContain('engines compared');
  for (const n of ['mediapipe', 'longpipe', 'rvm', 'p3m']) expect(text).toContain(n);
  expect(text).toContain('(drives the picture)');
  await page.getByRole('button', { name: 'Copy report' }).click();
  await expect(page.getByRole('button', { name: /Copied|Copy failed/ })).toBeVisible();
});

test('the published frame is byte-identical with the split view running', async ({ page }) => {
  await start(page);
  const same = await page.evaluate(async () => {
    const p = VideoEffects.active();
    const gl = p.gl, w = p.canvas.width, h = p.canvas.height;
    const read = () => { const b = new Uint8Array(w * h * 4); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b); return b; };
    VideoEffects.openDiagnostic('compare');
    await window.__until(() => VideoEffects.compareState().entries.every((e) => e.masks > 0) &&
      VideoEffects.compareState().split.tiles.every((t) => t.ready));
    // One task, so the camera frame is the same for both draws: only the
    // comparison (and the split it draws first) differs between them.
    p.draw(performance.now());
    const during = read();
    VideoEffects.closeDiagnostic();
    p.draw(performance.now());
    const after = read();
    let diff = 0;
    for (let i = 0; i < during.length; i++) if (during[i] !== after[i]) diff++;
    return diff;
  });
  expect(same).toBe(0);
});

test('stopping the camera frees the guests; closing the panel does too', async ({ page }) => {
  await start(page);
  const r = await page.evaluate(async () => {
    const log = { closed: 0, calls: 0 };
    window.__voxalCompareStub = (name) => (name === 'p3m' ? window.__guest((w, h) => new Uint8Array(w * h), log) : null);
    VideoEffects.openDiagnostic('compare');
    await window.__until(() => log.calls > 2);
    VideoEffects.closeDiagnostic();
    const a = { closed: log.closed, on: VideoEffects.compareState().on };
    VideoEffects.openDiagnostic('compare');
    await window.__until(() => log.calls > 5);
    VideoEffects.stop(window.__out);
    return { a, closedAfterStop: log.closed, on: VideoEffects.compareState().on,
             split: VideoEffects.compareState().split.on, self: VideoEffects.selfView(window.__out) === window.__out };
  });
  expect(r.a).toEqual({ closed: 1, on: false });
  expect(r.closedAfterStop).toBe(2);
  expect(r.on).toBe(false);
  expect(r.split).toBe(false);
  expect(r.self).toBe(true);
});

test('without a camera the compare view says so and costs nothing', async ({ page }) => {
  await page.evaluate(() => VideoEffects.openDiagnostic('compare'));
  const s = await state(page);
  expect(s.on).toBe(false);
  expect(s.split.on).toBe(false);
  await expect(page.locator('#seg-diagnostic')).toContainText('Start the camera with a background effect');
  // Starting the camera afterwards picks the comparison up.
  await start(page);
  expect(await page.evaluate(() => window.__until(() => VideoEffects.compareState().entries.length === 4))).toBe(true);
});

test('?segdiag=compare opens the comparison when the camera starts', async ({ page }) => {
  await page.goto('/?segdiag=compare');
  await installHelpers(page);
  await start(page);
  expect(await page.evaluate(() => window.__until(() => VideoEffects.compareState().entries.length === 4))).toBe(true);
  expect(await page.evaluate(() => VideoEffects.diagnosticState().view)).toBe('compare');
});

test('the panel can be resized and dragged, and stays on screen', async ({ page }) => {
  await start(page);
  await page.evaluate(() => VideoEffects.openDiagnostic('grid'));
  const panel = page.locator('#seg-diagnostic');
  const w0 = (await panel.boundingBox()).width;
  await page.getByRole('button', { name: 'Panel size' }).click();      // M -> L
  const w1 = (await panel.boundingBox()).width;
  expect(w1).toBeGreaterThan(w0);
  // The panel stands on the bottom of the window and grows upwards as its
  // picture and numbers arrive: grab its title bar once it has settled.
  await page.waitForFunction(() => VideoEffects.diagnosticState().inference >= 3);
  await page.waitForTimeout(400);
  const before = await panel.boundingBox();
  await page.mouse.move(before.x + 20, before.y + 14);
  await page.mouse.down();
  await page.mouse.move(before.x + 120, before.y - 60, { steps: 4 });
  await page.mouse.up();
  const after = await panel.boundingBox();
  expect(after.y).toBeLessThan(before.y);
  expect(after.x).toBeGreaterThan(before.x);
  expect(after.x).toBeGreaterThanOrEqual(0);
  expect(after.y).toBeGreaterThanOrEqual(0);
});
