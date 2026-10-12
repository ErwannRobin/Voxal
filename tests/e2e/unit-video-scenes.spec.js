import { test, expect } from './fixtures.js';

// The animated backgrounds (src/video-scenes.js) and what the camera pipeline
// does with them: the five scenes render, move only a little, follow the
// subject's light, take the subject's shadow and spill their own light onto
// the subject's edge.
//
// Inference is stubbed exactly as in unit-video-effects.spec.js — the stub's
// mask is a centred oval — and everything else is the real GL pipeline.

const SCENES = ['office', 'island', 'cybercafe', 'mountain', 'countryside'];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { window.__voxalSegStub = true; });
  await page.goto('/');
  await page.evaluate(() => {
    window.__sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__waitFor = async (fn, ms) => {
      const end = Date.now() + ms;
      while (!fn() && Date.now() < end) await window.__sleep(50);
      return fn();
    };

    // Render one scene, synchronously, and hand back its pixels.
    window.__renderScene = (id, opts = {}) => {
      const W = opts.w || 160, H = opts.h || 90;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const gl = c.getContext('webgl2', { alpha: false, preserveDrawingBuffer: true });
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      const prog = VideoScenes.compileProgram(gl, id);
      const look = Object.assign(VideoScenes.defaultLook(), opts.look || {});
      const out = [];
      for (const t of opts.times || [37]) {
        gl.viewport(0, 0, W, H);
        VideoScenes.setUniforms(gl, prog, W, H, t, look);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const px = new Uint8Array(W * H * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        out.push(Array.from(px));
      }
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return { w: W, h: H, frames: out };
    };
    window.__luma = (px, i) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];

    // A camera whose picture is lit from one side: a horizontal ramp, dark on
    // `dark` and bright on the other side, repainted so the capture keeps
    // producing frames.
    window.__mkLitCamera = (from, to) => {
      const c = document.createElement('canvas');
      c.width = 320; c.height = 240;
      const ctx = c.getContext('2d');
      let n = 0;
      const paint = () => {
        const g = ctx.createLinearGradient(0, 0, 320, 0);
        g.addColorStop(0, from); g.addColorStop(1, to);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 320, 240);
        ctx.fillStyle = '#777';
        ctx.fillRect((n++ * 7) % 320, 0, 2, 2);
      };
      paint();
      const stream = c.captureStream(15);
      const timer = setInterval(paint, 40);
      stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
      return stream;
    };
    window.__pixel = (x, y) => {
      const src = VideoEffects.active().canvas;
      const probe = document.createElement('canvas');
      probe.width = src.width; probe.height = src.height;
      const ctx = probe.getContext('2d');
      ctx.drawImage(src, 0, 0);
      return Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3);
    };
  });
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => { try { VideoEffects.stop(); } catch (e) { /* none running */ } });
});

test.describe('the catalogue', () => {
  test('five scenes, each with a label, a swatch and its own shader', async ({ page }) => {
    const seen = await page.evaluate(() => VideoScenes.SCENES.map((s) => ({
      id: s.id, label: !!s.label, swatch: /gradient/.test(s.swatch),
      source: !!VideoScenes.fragmentSource(s.id),
    })));
    expect(seen.map((s) => s.id)).toEqual(SCENES);
    for (const s of seen) expect(s).toMatchObject({ label: true, swatch: true, source: true });
  });

  // "Purely generated, no assets": nothing a scene draws is fetched.
  test('a scene references no image, font or file', async ({ page }) => {
    const sources = await page.evaluate(() => VideoScenes.SCENES.map((s) => VideoScenes.fragmentSource(s.id)));
    for (const src of sources) {
      expect(src).not.toMatch(/sampler2D|texture\(|\.(png|webp|jpe?g|svg)\b|url\(/);
    }
  });
});

test.describe('every scene', () => {
  for (const id of SCENES) {
    test(`${id} compiles and draws a picture, not a flat field`, async ({ page }) => {
      const stats = await page.evaluate((id) => {
        const r = window.__renderScene(id);
        const px = r.frames[0];
        let sum = 0, sum2 = 0;
        const n = r.w * r.h;
        for (let i = 0; i < n; i++) { const l = window.__luma(px, i * 4); sum += l; sum2 += l * l; }
        const mean = sum / n;
        return { mean, sd: Math.sqrt(sum2 / n - mean * mean) };
      }, id);
      expect(stats.mean).toBeGreaterThan(25);
      expect(stats.mean).toBeLessThan(235);
      expect(stats.sd).toBeGreaterThan(10);
    });

    // Alive, but quiet: something moves in a second, and very little does. A
    // busy background would be a distraction in a working call and a bitrate
    // cost for everyone receiving it.
    test(`${id} moves, but only a little`, async ({ page }) => {
      const d = await page.evaluate((id) => {
        const r = window.__renderScene(id, { times: [37, 38] });
        const [a, b] = r.frames;
        let sum = 0, big = 0;
        const n = r.w * r.h;
        for (let i = 0; i < n * 4; i += 4) {
          const diff = Math.abs(window.__luma(a, i) - window.__luma(b, i));
          sum += diff;
          if (diff > 12) big++;
        }
        return { mean: sum / n, bigShare: big / n };
      }, id);
      expect(d.mean).toBeGreaterThan(0);
      expect(d.mean).toBeLessThan(3);
      expect(d.bigShare).toBeLessThan(0.05);
    });

    // The layout is authored with the light on the right and mirrored when
    // it is on the left — exactly mirrored, subject and all.
    test(`${id} puts its light on the subject's light side`, async ({ page }) => {
      const err = await page.evaluate((id) => {
        const right = window.__renderScene(id, { look: { dirX: 0.8, sideMix: 1, cx: 0.4 } });
        const left = window.__renderScene(id, { look: { dirX: -0.8, sideMix: 0, cx: 0.6 } });
        const a = right.frames[0], b = left.frames[0];
        const W = right.w, H = right.h;
        let sum = 0;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4, j = (y * W + (W - 1 - x)) * 4;
            sum += Math.abs(window.__luma(a, i) - window.__luma(b, j));
          }
        }
        return sum / (W * H);
      }, id);
      expect(err).toBeLessThan(1.5);
    });
  }

  test('a dim subject gets a dim scene', async ({ page }) => {
    const ratio = await page.evaluate(() => {
      const mean = (r) => {
        let s = 0;
        for (let i = 0; i < r.frames[0].length; i += 4) s += window.__luma(r.frames[0], i);
        return s / (r.frames[0].length / 4);
      };
      return mean(window.__renderScene('countryside', { look: { exposure: 0.35 } })) /
             mean(window.__renderScene('countryside', { look: { exposure: 1 } }));
    });
    expect(ratio).toBeLessThan(0.8);
  });

  test('a warm room gets a warm scene', async ({ page }) => {
    const shift = await page.evaluate(() => {
      const rb = (r) => {
        let red = 0, blue = 0;
        for (let i = 0; i < r.frames[0].length; i += 4) { red += r.frames[0][i]; blue += r.frames[0][i + 2]; }
        return red / blue;
      };
      return rb(window.__renderScene('office', { look: { tint: [1.15, 0.98, 0.82] } })) /
             rb(window.__renderScene('office', { look: { tint: [1, 1, 1] } }));
    });
    expect(shift).toBeGreaterThan(1.05);
  });

  // A dark enough room turns the office to evening: the lamp comes on, so the
  // scene is not just the daytime picture scaled down.
  test('in a dark room the lights come on', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const r = window.__renderScene('office', { look: { exposure: 0.25 }, w: 320, h: 180 });
      const px = r.frames[0];
      // The lamp sits on the top shelf near the left edge; find the brightest
      // pixel in the left quarter against the median of that quarter.
      const vals = [];
      for (let y = 0; y < r.h; y++) {
        for (let x = 0; x < r.w / 4; x++) vals.push(window.__luma(px, (y * r.w + x) * 4));
      }
      vals.sort((a, b) => a - b);
      return { max: vals[vals.length - 1], median: vals[vals.length >> 1] };
    });
    expect(seen.max).toBeGreaterThan(seen.median * 2);
  });
});

test.describe('measuring the subject', () => {
  // A 32x18 probe with an oval subject in the middle, whose pixels are lit by
  // `shade(x, y)` (0–255 grey) and whose room is `room`.
  async function measure(page, spec) {
    return page.evaluate((spec) => {
      const W = 32, H = 18;
      const rgba = new Uint8ClampedArray(W * H * 4);
      const mask = new Uint8Array(W * H);
      const shade = new Function('x', 'y', 'return ' + spec.shade);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const dx = (x + 0.5 - W / 2) / (W * 0.2), dy = (y + 0.5 - H * 0.6) / (H * 0.45);
          const inside = dx * dx + dy * dy < 1;
          mask[i] = inside ? 255 : 0;
          const v = inside ? shade(x, y) : spec.room;
          const c = spec.cast || [1, 1, 1];
          rgba[i * 4] = v * c[0]; rgba[i * 4 + 1] = v * c[1]; rgba[i * 4 + 2] = v * c[2]; rgba[i * 4 + 3] = 255;
        }
      }
      const stats = VideoScenes.measureSubject(rgba, W, H, mask, null);
      return { stats, look: VideoScenes.lookFromStats(stats, null) };
    }, spec);
  }

  test('a face brighter on its right is lit from the right', async ({ page }) => {
    // A window to one side: the lit cheek about twice the shadowed one.
    const { look } = await measure(page, { shade: '20 + x * 8', room: 120 });
    expect(look.dirX).toBeGreaterThan(0.35);
    expect(look.side).toBe(1);
  });

  test('a face brighter on its left is lit from the left', async ({ page }) => {
    const { look } = await measure(page, { shade: '270 - x * 8', room: 120 });
    expect(look.dirX).toBeLessThan(-0.35);
    expect(look.side).toBe(-1);
  });

  test('exposure follows the subject, not the room around it', async ({ page }) => {
    const dim = await measure(page, { shade: '60', room: 250 });
    const lit = await measure(page, { shade: '125', room: 20 });
    expect(dim.look.exposure).toBeLessThan(0.45);
    expect(lit.look.exposure).toBeGreaterThan(0.9);
  });

  test('the tint follows the room\'s cast, only partly, and is never a brightness', async ({ page }) => {
    const { look } = await measure(page, { shade: '140', room: 140, cast: [1.0, 0.75, 0.5] });
    const [r, g, b] = look.tint;
    expect(r).toBeGreaterThan(b);
    // Partial: a strong cast moves the tint, but not all the way.
    expect(r / b).toBeLessThan(1.6);
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    expect(luminance).toBeCloseTo(1, 3);
  });

  test('nobody in the picture keeps the last answer', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const W = 32, H = 18;
      const stats = VideoScenes.measureSubject(new Uint8ClampedArray(W * H * 4).fill(128), W, H,
                                               new Uint8Array(W * H), null);
      const prev = Object.assign(VideoScenes.defaultLook(), { exposure: 0.6, dirX: -0.7, side: -1, measured: true, motion: 0.8 });
      const look = VideoScenes.lookFromStats(stats, prev);
      return { stats, exposure: look.exposure, side: look.side, motion: look.motion };
    });
    expect(seen.stats).toBe(null);
    expect(seen.exposure).toBe(0.6);
    expect(seen.side).toBe(-1);
    expect(seen.motion).toBe(0);
  });

  // A head turned toward a second screen must not move the window across the
  // room: the side changes only past a clear threshold.
  test('the window changes sides only when the light clearly has', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const prev = Object.assign(VideoScenes.defaultLook(), { side: 1, measured: true });
      const base = { luma: 0.48, gray: [0.2, 0.2, 0.2], asymY: 0, cx: 0.5, cy: 0.5, sx: 0.2, sy: 0.3, cover: 0.2, motion: 0 };
      const flip = VideoScenes._lookConfig.sideFlip;
      const weak = VideoScenes.lookFromStats(Object.assign({}, base, { asymX: -flip / 3.2 * 0.6 }), prev);
      const strong = VideoScenes.lookFromStats(Object.assign({}, base, { asymX: -0.3 }), prev);
      return { weak: weak.side, strong: strong.side };
    });
    expect(seen.weak).toBe(1);
    expect(seen.strong).toBe(-1);
  });

  test('movement is felt at once and settles slowly; the room turns, it never jumps', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const cur = Object.assign(VideoScenes.defaultLook(), { measured: true, side: 1, sideMix: 1 });
      const target = Object.assign(VideoScenes.defaultLook(), { measured: true, motion: 1, side: -1 });
      VideoScenes.easeLook(cur, target, 0.1);
      const rose = cur.motion;
      const turning = cur.sideMix;
      target.motion = 0;
      VideoScenes.easeLook(cur, target, 0.1);
      const after = cur.motion;
      for (let i = 0; i < 30; i++) VideoScenes.easeLook(cur, target, 0.1);
      return { rose, after, turning, turned: cur.sideMix };
    });
    expect(seen.rose).toBeGreaterThan(0.3);
    expect(seen.after).toBeGreaterThan(seen.rose * 0.8);
    expect(seen.turning).toBeGreaterThan(0);
    expect(seen.turning).toBeLessThan(1);
    expect(seen.turned).toBe(0);
  });

  test('a moving silhouette registers as motion, a still one does not', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const W = 32, H = 18;
      const rgba = new Uint8ClampedArray(W * H * 4).fill(128);
      const oval = (cx) => {
        const m = new Uint8Array(W * H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const dx = (x + 0.5 - cx) / 6, dy = (y + 0.5 - 10) / 8;
          m[y * W + x] = dx * dx + dy * dy < 1 ? 255 : 0;
        }
        return m;
      };
      const still = VideoScenes.measureSubject(rgba, W, H, oval(16), oval(16));
      const moved = VideoScenes.measureSubject(rgba, W, H, oval(19), oval(16));
      return {
        still: VideoScenes.lookFromStats(still, null).motion,
        moved: VideoScenes.lookFromStats(moved, null).motion,
      };
    });
    expect(seen.still).toBe(0);
    expect(seen.moved).toBeGreaterThan(0.5);
  });
});

test.describe('in the camera pipeline', () => {
  // Blur and images must not pay for scenes: no scene buffer until one is
  // picked — the same rule that makes "off" free.
  test('scene buffers exist only once a scene is picked', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      await VideoEffects.wrap(window.__mkLitCamera('#555', '#555'), 'blur');
      await window.__sleep(300);
      const blur = { scene: !!VideoEffects.active().texScene, soft: !!VideoEffects.active().texSoftA };
      await VideoEffects.setMode('preset:office');
      await window.__sleep(300);
      return { blur, scene: !!VideoEffects.active().texScene, id: VideoEffects.active().sceneId };
    });
    expect(seen.blur).toEqual({ scene: false, soft: false });
    expect(seen.scene).toBe(true);
    expect(seen.id).toBe('office');
  });

  test('the subject\'s light is measured from the camera', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      await VideoEffects.wrap(window.__mkLitCamera('#202020', '#e0e0e0'), 'preset:office');
      const p = VideoEffects.active();
      await window.__waitFor(() => p.look.measured && p.look.dirX > 0.3, 4000);
      return { measured: p.look.measured, dirX: p.look.dirX, side: p.look.side };
    });
    expect(seen.measured).toBe(true);
    expect(seen.dirX).toBeGreaterThan(0.3);
    expect(seen.side).toBe(1);
  });

  // Lit from the right, the subject throws a shadow to the left onto the wall
  // behind: just outside the silhouette, the left side is darkened more than
  // the right. Compared against the same frame with the shadow switched off,
  // so the scene's own unevenness cancels out.
  test('the subject casts a shadow away from the light', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      await VideoEffects.wrap(window.__mkLitCamera('#202020', '#e0e0e0'), 'preset:office');
      const p = VideoEffects.active();
      await window.__waitFor(() => p.look.measured && p.look.dirX > 0.3, 4000);
      await window.__sleep(400);
      const L = [Math.round(320 * 0.25), Math.round(240 * 0.6)];
      const R = [Math.round(320 * 0.75), Math.round(240 * 0.6)];
      const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      const on = { l: lum(window.__pixel(...L)), r: lum(window.__pixel(...R)) };
      const plan = p.shadowPlan();
      p.scene = Object.assign({}, p.scene, { shadow: 0 });
      await window.__sleep(300);
      const off = { l: lum(window.__pixel(...L)), r: lum(window.__pixel(...R)) };
      return { plan, left: on.l / off.l, right: on.r / off.r };
    });
    expect(seen.plan.offX).toBeGreaterThan(0);
    expect(seen.plan.cast).toBeGreaterThan(0);
    expect(seen.left).toBeLessThan(0.95);
    expect(seen.left).toBeLessThan(seen.right);
  });

  // A scene with nothing near enough to take a shadow casts none.
  test('a distant landscape takes no shadow', async ({ page }) => {
    const plan = await page.evaluate(async () => {
      await VideoEffects.wrap(window.__mkLitCamera('#202020', '#e0e0e0'), 'preset:mountain');
      await window.__sleep(300);
      return VideoEffects.active().shadowPlan();
    });
    expect(plan.cast).toBe(0);
    expect(plan.contact).toBe(0);
  });

  // The light wrap only ever adds light: a dark subject in front of a bright
  // sky gets a brighter outline, and the middle of the subject is untouched.
  test('the scene\'s light spills onto the subject\'s edge', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      await VideoEffects.wrap(window.__mkLitCamera('#181818', '#181818'), 'preset:island');
      const p = VideoEffects.active();
      await window.__waitFor(() => p.look.measured, 4000);
      await window.__sleep(400);
      const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      // Just inside the oval's top, and its middle.
      const edge = [160, Math.round(240 * (0.6 - 0.45) + 6)];
      const mid = [160, Math.round(240 * 0.6)];
      const on = { edge: lum(window.__pixel(...edge)), mid: lum(window.__pixel(...mid)) };
      p.scene = Object.assign({}, p.scene, { wrap: 0 });
      await window.__sleep(300);
      const off = { edge: lum(window.__pixel(...edge)), mid: lum(window.__pixel(...mid)) };
      return { on, off };
    });
    expect(seen.on.edge).toBeGreaterThan(seen.off.edge + 4);
    expect(Math.abs(seen.on.mid - seen.off.mid)).toBeLessThan(2);
  });

  test('moving in front of the camera stirs the scene', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      await VideoEffects.wrap(window.__mkLitCamera('#606060', '#a0a0a0'), 'preset:countryside');
      const p = VideoEffects.active();
      await window.__waitFor(() => p.look.measured, 4000);
      await window.__sleep(800);
      const still = p.look.motion;
      // Step in and out of the picture a few times.
      for (let i = 0; i < 6; i++) {
        window.__voxalSegStub = { empty: i % 2 === 0 };
        await window.__sleep(280);
      }
      window.__voxalSegStub = true;
      return { still, moving: p.look.motion };
    });
    expect(seen.still).toBeLessThan(0.05);
    expect(seen.moving).toBeGreaterThan(0.2);
  });

  // Picking a scene is a compile, and the compile is off the frame's path: the
  // old background keeps drawing until the new one is ready, and nothing on
  // the wire changes.
  test('switching scenes keeps the same published track', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      const stream = await VideoEffects.wrap(window.__mkLitCamera('#555', '#999'), 'preset:office');
      const track = stream.getVideoTracks()[0];
      const ids = [];
      for (const id of ['island', 'cybercafe', 'mountain', 'countryside', 'office']) {
        await VideoEffects.setMode('preset:' + id);
        ids.push(VideoEffects.active().sceneId);
      }
      return { ids, same: stream.getVideoTracks()[0] === track, live: track.readyState };
    });
    expect(seen.ids).toEqual(['island', 'cybercafe', 'mountain', 'countryside', 'office']);
    expect(seen.same).toBe(true);
    expect(seen.live).toBe('live');
  });

  // Under load the scene is the second thing to give: segmentation steps down
  // first, then the scene redraws at half rate, and only then does the effect
  // give up.
  test('under load the scene slows down before the effect gives up', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      await VideoEffects.wrap(window.__mkLitCamera('#555', '#999'), 'preset:office');
      const p = VideoEffects.active();
      p.segStep = p.segHzSteps.length - 1;
      const slow = (t) => { p.frames = 1; p.windowStart = t - 5000; p.measure(t); };
      const t0 = performance.now() + 100000;
      slow(t0);
      const first = { sceneStep: p.sceneStep, gaveUp: !!p.gaveUp };
      VideoEffects.onOverload(() => {});
      slow(t0 + 6000);
      return { first, gaveUp: !!p.gaveUp, hz: VideoEffects._sceneConfig.hz };
    });
    expect(seen.first).toEqual({ sceneStep: 1, gaveUp: false });
    expect(seen.gaveUp).toBe(true);
    expect(seen.hz[1]).toBeLessThan(seen.hz[0]);
  });
});

test.describe('the picker', () => {
  test('each scene chip gets a thumbnail rendered from its own shader', async ({ page }) => {
    await page.click('#btn-open-settings');
    await page.click('#modal-settings [data-target="settings-video"]');
    const chips = page.locator('#settings-bg-picker .bg-chip-scene');
    await expect(chips).toHaveCount(5);
    await expect.poll(() => page.evaluate(() =>
      Array.from(document.querySelectorAll('#settings-bg-picker .bg-chip-scene'))
        .filter((c) => /url\("(blob|data):/.test(c.style.backgroundImage)).length), { timeout: 15000 })
      .toBe(5);
    const labels = await chips.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    expect(labels).toEqual(['Office', 'Island', 'Cyber café', 'Mountain', 'Countryside']);
  });
});
