import { test, expect } from './fixtures.js';

// Compare engines (VideoEffects.compareStart(), or the "Compare engines" view of
// the segmentation diagnostic): every segmentation engine handed the same frames
// at once, side by side, to judge them live.
//
// No real model runs here (`__voxalSegStub`, see unit-seg-diagnostic.spec.js), so
// every engine is a stand-in. That is enough to pin what is OURS: which engines
// are offered, that guests are fed the primary's frames and can be paused,
// failed or closed without touching the picture, that a failing engine is
// REPORTED rather than replaced by another model, and that the panes and the
// numbers are drawn from the right masks.

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
    window.__panelPx = function (fx, fy) {
      const cv = document.querySelector('#seg-diagnostic canvas');
      const x = Math.floor(cv.width * fx), y = Math.floor(cv.height * fy);
      return Array.from(cv.getContext('2d').getImageData(x, y, 1, 1).data);
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

test('the compare view runs every engine this build has, the driving one first', async ({ page }) => {
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
  await expect(page.locator('#seg-diagnostic [aria-pressed="true"]').first()).toHaveText('Compare engines');
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

test('masks are drawn upright from each engine, and the diff says who disagrees', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    // longpipe: only the LEFT half is person; the stand-in oval is centred.
    window.__voxalCompareStub = (name) => (name === 'longpipe'
      ? window.__guest((w, h) => { const d = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w / 2; x++) d[y * w + x] = 255; return d; },
        { closed: 0, calls: 0 })
      : null);
    VideoEffects.compareSetView('mask');
    VideoEffects.openDiagnostic('compare');
  });
  expect(await page.evaluate(() => window.__until(() =>
    VideoEffects.compareState().entries.every((e) => e.masks > 0)))).toBe(true);
  await page.waitForTimeout(400);
  // 2x2 panes: mediapipe top-left, longpipe top-right. The oval's centre is at
  // 50%/60% of its pane, the corner is background.
  const oval = await page.evaluate(() => window.__panelPx(0.25, 0.3));
  const cornerBg = await page.evaluate(() => window.__panelPx(0.05, 0.1));
  expect(oval[0]).toBeGreaterThan(240);
  expect(cornerBg[0]).toBeLessThan(15);
  // longpipe's left half is white, its right half black.
  expect((await page.evaluate(() => window.__panelPx(0.55, 0.2)))[0]).toBeGreaterThan(240);
  expect((await page.evaluate(() => window.__panelPx(0.95, 0.2)))[0]).toBeLessThan(15);

  await page.evaluate(() => VideoEffects.compareSetView('diff'));
  await page.waitForTimeout(400);
  // Where only longpipe says person (its left half, off the oval): red. Where
  // only the reference does (the oval's right part): blue.
  const onlyThis = await page.evaluate(() => window.__panelPx(0.52, 0.05));
  const onlyRef = await page.evaluate(() => window.__panelPx(0.81, 0.3));
  expect(onlyThis[0]).toBeGreaterThan(200); expect(onlyThis[2]).toBeLessThan(100);
  expect(onlyRef[2]).toBeGreaterThan(200); expect(onlyRef[0]).toBeLessThan(100);
  const s = await state(page);
  const lp = s.entries.find((e) => e.name === 'longpipe');
  expect(lp.iou).toBeGreaterThan(0.2);
  expect(lp.iou).toBeLessThan(0.7);
  expect(lp.person).toBeGreaterThan(0.45);
  expect(lp.person).toBeLessThan(0.55);
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

test('a click on a picture enlarges it, a second puts it back; a grid pane opens its view', async ({ page }) => {
  await start(page);
  await page.evaluate(() => VideoEffects.openDiagnostic('compare'));
  expect(await page.evaluate(() => window.__until(() => VideoEffects.compareState().entries.length === 4))).toBe(true);
  await page.waitForTimeout(300);
  const cv = page.locator('#seg-diagnostic canvas');
  const box = await cv.boundingBox();
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.25);   // top right = longpipe
  expect((await state(page)).focus).toBe('longpipe');
  await page.waitForTimeout(300);
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  expect((await state(page)).focus).toBe(null);

  await page.evaluate(() => VideoEffects.setDiagnosticView('grid'));
  await page.waitForFunction(() => VideoEffects.diagnosticState().inference >= 2);
  await page.waitForTimeout(300);
  const box2 = await cv.boundingBox();
  await page.mouse.click(box2.x + box2.width * 0.75, box2.y + box2.height * 0.25);  // grid: B, the raw mask
  expect(await page.evaluate(() => VideoEffects.diagnosticState().view)).toBe('raw');
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

test('the published frame is byte-identical with the comparison running', async ({ page }) => {
  await start(page);
  const same = await page.evaluate(async () => {
    const p = VideoEffects.active();
    const gl = p.gl, w = p.canvas.width, h = p.canvas.height;
    const read = () => { const b = new Uint8Array(w * h * 4); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b); return b; };
    VideoEffects.openDiagnostic('compare');
    await window.__until(() => VideoEffects.compareState().entries.every((e) => e.masks > 0));
    // One task, so the camera frame is the same for both draws: only the
    // comparison differs between them.
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
    return { a, closedAfterStop: log.closed, on: VideoEffects.compareState().on };
  });
  expect(r.a).toEqual({ closed: 1, on: false });
  expect(r.closedAfterStop).toBe(2);
  expect(r.on).toBe(false);
});

test('without a camera the compare view says so and costs nothing', async ({ page }) => {
  await page.evaluate(() => VideoEffects.openDiagnostic('compare'));
  const s = await state(page);
  expect(s.on).toBe(false);
  await expect(page.locator('#seg-diagnostic')).toBeVisible();
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
