import { test, expect } from './fixtures.js';

// The segmentation diagnostic (VideoEffects.openDiagnostic()): a panel that
// shows what each stage between MediaPipe and the screen produced for one
// inference.
//
// MediaPipe cannot run here (see unit-video-effects.spec.js), so
// `__voxalSegStub` stands in for the model with a hard-edged centred oval —
// white inside, black outside. That is enough to pin everything that is OURS:
// which texture each pane reads, its orientation, that nothing extra is
// inferred, that the published frame is untouched, that the numbers are right
// and that closing frees what opening made. What it cannot say is how the real
// model behaves; that needs the visual check described in docs/video-effects.md.

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
    // Resolves once n inferences have been ingested by the panel.
    window.__untilInferences = async function (n) {
      for (let i = 0; i < 200; i++) {
        if (VideoEffects.diagnosticState().inference >= n) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    };
    // The panel canvas's pixel at (fx, fy) as fractions of its size.
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

async function start(page, mode = 'blur') {
  await page.evaluate(async (m) => {
    window.__out = await VideoEffects.wrap(window.__mkStream(), m);
  }, mode);
}

test('off by default: no panel, no diagnostic resources, nothing recorded', async ({ page }) => {
  await start(page);
  await page.waitForFunction(() => (window.__voxalSegCalls || 0) > 3);
  const s = await page.evaluate(() => ({
    panel: !!document.getElementById('seg-diagnostic'),
    state: VideoEffects.diagnosticState(),
    dg: VideoEffects.active()._dg,
  }));
  expect(s.panel).toBe(false);
  expect(s.state.on).toBe(false);
  expect(s.dg == null).toBe(true);
});

test('opens from ?segdiag=1 when the camera effect starts', async ({ page }) => {
  await page.goto('/?segdiag=1');
  await installHelpers(page);
  await start(page);
  await expect(page.locator('#seg-diagnostic')).toBeVisible();
  expect(await page.evaluate(() => VideoEffects.diagnosticState().on)).toBe(true);
});

test('adds no inference: one ingest per segmentForVideo call', async ({ page }) => {
  await start(page);
  await page.waitForFunction(() => (window.__voxalSegCalls || 0) > 2);
  const r = await page.evaluate(async () => {
    const calls0 = window.__voxalSegCalls;
    VideoEffects.openDiagnostic('grid');
    await window.__untilInferences(6);
    const calls1 = window.__voxalSegCalls;
    return { calls: calls1 - calls0, seen: VideoEffects.diagnosticState().inference };
  });
  // Opened between two calls, read at another: off by at most the one in flight.
  expect(Math.abs(r.calls - r.seen)).toBeLessThanOrEqual(2);
});

test('raw view shows the mask as the model returned it, upright', async ({ page }) => {
  await start(page);
  await page.evaluate(() => VideoEffects.openDiagnostic('raw'));
  expect(await page.evaluate(() => window.__untilInferences(3))).toBe(true);
  // The stub's oval is centred at x 50%, y 60%: white there, black in the
  // top-right corner and — the orientation check — black at 50%/10%, white at
  // 50%/60%.
  const mid = await page.evaluate(() => window.__panelPx(0.5, 0.6));
  const corner = await page.evaluate(() => window.__panelPx(0.9, 0.1));
  const above = await page.evaluate(() => window.__panelPx(0.5, 0.1));
  expect(mid[0]).toBeGreaterThan(240);
  expect(corner[0]).toBeLessThan(15);
  expect(above[0]).toBeLessThan(15);
  // Grey, not a tinted picture: R = G = B.
  expect(Math.abs(mid[0] - mid[1])).toBeLessThan(3);
});

test('grid shows A (camera), B (raw mask), C (processed) and D (final) of one inference', async ({ page }) => {
  await start(page);
  await page.evaluate(() => VideoEffects.openDiagnostic('grid'));
  expect(await page.evaluate(() => window.__untilInferences(3))).toBe(true);
  // Quadrants: A top-left, B top-right, C bottom-left, D bottom-right. Sample
  // each at its oval centre (50%, 60% of the quadrant).
  const A = await page.evaluate(() => window.__panelPx(0.25, 0.30));
  const B = await page.evaluate(() => window.__panelPx(0.75, 0.30));
  const C = await page.evaluate(() => window.__panelPx(0.25, 0.80));
  const D = await page.evaluate(() => window.__panelPx(0.75, 0.80));
  // A: the camera is green (#0a0 with a 2px moving dot), nothing like grey.
  expect(A[1]).toBeGreaterThan(140);
  expect(A[0]).toBeLessThan(40);
  // B and C: the oval is white in the middle.
  expect(B[0]).toBeGreaterThan(240);
  expect(C[0]).toBeGreaterThan(240);
  // D: the final render of a green camera is green.
  expect(D[1]).toBeGreaterThan(140);
  expect(D[0]).toBeLessThan(60);
});

test('stages view prints raw, blend, dilated, feathered, matte and final', async ({ page }) => {
  await start(page);
  await page.evaluate(() => VideoEffects.openDiagnostic('stages'));
  expect(await page.evaluate(() => window.__untilInferences(3))).toBe(true);
  // 3 columns x 2 rows. Each pane's own oval centre is at 50% / 60% of the pane.
  // The panel canvas is exactly the panes' region, so fractions are plain.
  const px = (col, row) => page.evaluate(([c, r]) =>
    window.__panelPx((c + 0.5) / 3, (r + 0.6) / 2), [col, row]);
  for (const [col, row] of [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1]]) {
    const p = await px(col, row);
    expect(p[0], `mask pane ${col},${row} centre`).toBeGreaterThan(235);
  }
  // The matte (C4) is the composite's own `m`: grey like the masks, white inside.
  const matte = await px(1, 1);
  expect(Math.abs(matte[0] - matte[2])).toBeLessThan(3);
  // D, last pane: the green picture.
  const D = await px(2, 1);
  expect(D[1]).toBeGreaterThan(140);
  // A far corner of the dilated pane (top row, third column) stays black.
  const corner = await page.evaluate(() => window.__panelPx(2.9 / 3, 0.05 / 2));
  expect(corner[0]).toBeLessThan(15);
});

for (const view of ['matte', 'stages', 'grid', 'raw']) {
  test(`the published frame is byte-identical with the panel open or closed (${view})`, async ({ page }) => {
    await start(page);
    await page.waitForFunction(() => (window.__voxalSegCalls || 0) > 3);
    const same = await page.evaluate((v) => {
      const p = VideoEffects.active();
      const gl = p.gl, w = p.canvas.width, h = p.canvas.height;
      const read = () => {
        const b = new Uint8Array(w * h * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b);
        return b;
      };
      // Same task, so the camera frame and every texture are the same for all
      // three. The baseline is taken BEFORE the panel was ever opened: a frame
      // compared only with one drawn after closing could not see state that
      // the panel left behind in the program.
      p.draw(performance.now());
      const baseline = read();
      VideoEffects.openDiagnostic(v);
      p.diagEnsure();
      p._dg.fresh = true;             // force the panes to be drawn this frame
      p.draw(performance.now());
      const withPanel = read();
      // The panes really were drawn in that pass: the fresh flag is consumed by
      // diagBegin() only when the panel takes a picture.
      const drew = p._dg.fresh === false;
      VideoEffects.closeDiagnostic();
      p.draw(performance.now());
      const after = read();
      let diff = 0;
      for (let i = 0; i < baseline.length; i++) {
        if (withPanel[i] !== baseline[i] || after[i] !== baseline[i]) diff++;
      }
      return { diff, drew };
    }, view);
    expect(same.drew).toBe(true);
    expect(same.diff).toBe(0);
  });
}

test('stability numbers: an unchanged mask is stable, a changed one is counted', async ({ page }) => {
  await start(page);
  await page.waitForFunction(() => (window.__voxalSegCalls || 0) > 2);
  const r = await page.evaluate(() => {
    VideoEffects.openDiagnostic('raw');
    const p = VideoEffects.active();
    const W = p.segW, H = p.segH, n = W * H;
    const a = new Uint8Array(n);                 // all background
    const b = new Uint8Array(n);
    for (let i = 0; i < n / 10; i++) b[i] = 255; // 10% flip to person
    const c = new Uint8Array(n);
    for (let i = 0; i < n; i++) c[i] = 100;      // 100/255 ~ 39%: mid-confidence
    const out = {};
    // One synchronous task: the live stub cannot interleave its own ingests.
    p.diagIngest(a, W, H); out.first = p._dg.last;
    p.diagIngest(a, W, H); out.same = p._dg.last;
    p.diagIngest(b, W, H); out.tenth = p._dg.last;
    p.diagIngest(b, W, H); out.again = p._dg.last;
    p.diagIngest(c, W, H); out.mid = p._dg.last;
    return out;
  });
  // The first has nothing to be compared with: no change figures at all.
  expect(r.first.mean).toBeUndefined();
  expect(r.same.flips).toBe(0);
  expect(r.same.changed).toBe(0);
  expect(r.tenth.flips).toBeCloseTo(0.1, 2);
  expect(r.tenth.changed).toBeCloseTo(0.1, 2);
  expect(r.tenth.mean).toBeCloseTo(0.1, 2);
  expect(r.tenth.person).toBeCloseTo(0.1, 2);
  expect(r.again.flips).toBe(0);
  // 100/255 sits inside the composite's smoothstep window: every pixel is "mid".
  expect(r.mid.mid).toBeCloseTo(1, 2);
});

test('the dilated pane is the dilated mask, not the feathered one', async ({ page }) => {
  await start(page);
  await page.evaluate(() => VideoEffects.openDiagnostic('dilated'));
  expect(await page.evaluate(() => window.__untilInferences(3))).toBe(true);
  // Reads the diag texture straight back and compares it with the work texture
  // after a fresh inference's dilate: the dilated oval is hard (0/255) while the
  // feathered one has grey texels on its rim.
  const r = await page.evaluate(() => {
    const p = VideoEffects.active(), gl = p.gl;
    const W = p.segW, H = p.segH;
    const read = (tex) => {
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const b = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, b);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      let grey = 0;
      for (let i = 0; i < W * H; i++) if (b[i * 4] > 8 && b[i * 4] < 247) grey++;
      return grey;
    };
    return { dilatedGrey: read(p._dg.texDil), featheredGrey: read(p.texMaskA) };
  });
  expect(r.dilatedGrey).toBe(0);
  expect(r.featheredGrey).toBeGreaterThan(0);
});

test('closing removes the panel and frees every GL object it made', async ({ page }) => {
  await start(page);
  await page.evaluate(() => VideoEffects.openDiagnostic('stages'));
  expect(await page.evaluate(() => window.__untilInferences(2))).toBe(true);
  const r = await page.evaluate(() => {
    const p = VideoEffects.active(), gl = p.gl, d = p._dg;
    const made = [d.texIn, d.texDil, d.texHeat];
    const prog = d.prog;
    const before = made.every((t) => gl.isTexture(t)) && gl.isProgram(prog);
    VideoEffects.closeDiagnostic();
    return {
      before,
      texturesGone: made.every((t) => !gl.isTexture(t)),
      programGone: !gl.isProgram(prog),
      panel: !!document.getElementById('seg-diagnostic'),
      dg: p._dg,
      on: VideoEffects.diagnosticState().on,
    };
  });
  expect(r.before).toBe(true);
  expect(r.texturesGone).toBe(true);
  expect(r.programGone).toBe(true);
  expect(r.panel).toBe(false);
  expect(r.dg).toBeNull();
  expect(r.on).toBe(false);
});

test('reopening and closing repeatedly does not accumulate panels or GL objects', async ({ page }) => {
  await start(page);
  await page.waitForFunction(() => (window.__voxalSegCalls || 0) > 2);
  const r = await page.evaluate(async () => {
    const p = VideoEffects.active(), gl = p.gl;
    let leaked = 0;
    for (let i = 0; i < 6; i++) {
      VideoEffects.openDiagnostic(i % 2 ? 'grid' : 'stages');
      await window.__untilInferences(1);
      const d = p._dg;
      const objs = [d.texIn, d.texDil, d.texHeat];
      VideoEffects.closeDiagnostic();
      leaked += objs.filter((t) => gl.isTexture(t)).length;
    }
    return { leaked, panels: document.querySelectorAll('#seg-diagnostic').length };
  });
  expect(r.leaked).toBe(0);
  expect(r.panels).toBe(0);
});

test('no per-frame console output while the panel is open', async ({ page }) => {
  const lines = [];
  page.on('console', (m) => { if (/seg-diagnostic/.test(m.text())) lines.push(m.text()); });
  await start(page);
  await page.evaluate(() => VideoEffects.openDiagnostic('grid'));
  expect(await page.evaluate(() => window.__untilInferences(12))).toBe(true);
  expect(lines.length).toBeLessThanOrEqual(1);
});

test('a changed view applies to the next inference; an unknown view is refused', async ({ page }) => {
  await start(page);
  const r = await page.evaluate(async () => {
    VideoEffects.openDiagnostic('grid');
    await window.__untilInferences(2);
    const refused = VideoEffects.setDiagnosticView('nope');
    const ok = VideoEffects.setDiagnosticView('heat');
    return { refused, ok, view: VideoEffects.diagnosticState().view,
             select: document.querySelector('#seg-diagnostic select').value };
  });
  expect(r.refused).toBe(false);
  expect(r.ok).toBe(true);
  expect(r.view).toBe('heat');
  expect(r.select).toBe('heat');
});
