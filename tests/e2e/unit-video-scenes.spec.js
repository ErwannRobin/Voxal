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

    // Resolve a stand-in scene into a bigger picture through RESOLVE_FRAG, as
    // video-effects.js resolveScene() does. `frag` draws from uv the way a
    // scene does (uRes, uJitter; uX is the test's own), w x h small, and each
    // entry of `steps` is one redraw ({ x }) added into the W x H picture.
    // Hands back, as RGBA bytes bottom row first: the picture and the one
    // before it, `frag` drawn straight at W x H (what a big buffer would show),
    // and the last moment drawn small without jitter and stretched by the
    // hardware's bilinear filter (what the small one shows).
    window.__resolve = ({ frag, w, h, W, H, steps, opts }) => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const gl = c.getContext('webgl2', { alpha: false, preserveDrawingBuffer: true });
      const sh = (type, text) => {
        const o = gl.createShader(type); gl.shaderSource(o, text); gl.compileShader(o);
        if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o));
        return o;
      };
      const mk = (fs) => {
        const p = gl.createProgram();
        gl.attachShader(p, sh(gl.VERTEX_SHADER, '#version 300 es\nin vec2 aPos;\nout vec2 vUv;\n' +
          'void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }\n'));
        gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
        gl.bindAttribLocation(p, 0, 'aPos');
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        return p;
      };
      const scene = mk(frag);
      const resolve = mk(opts ? VideoScenes.resolveSource(opts) : VideoScenes.RESOLVE_FRAG);
      const blit = mk('#version 300 es\nprecision highp float;\nin vec2 vUv;\nout vec4 o;\n' +
        'uniform sampler2D uT;\nvoid main() { o = texture(uT, vUv); }\n');
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      const target = (tw, th) => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, tw, th, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const f = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, f);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
        return { t, f, w: tw, h: th };
      };
      const small = target(w, h), big = target(W, H), stretched = target(W, H);
      const pic = [target(W, H), target(W, H)];
      const draw = (to) => { gl.bindFramebuffer(gl.FRAMEBUFFER, to.f); gl.viewport(0, 0, to.w, to.h); gl.drawArrays(gl.TRIANGLES, 0, 3); };
      const bind = (p, name, unit, t) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(gl.getUniformLocation(p, name), unit); };
      const drawScene = (to, x, j) => {
        gl.useProgram(scene);
        gl.uniform2f(gl.getUniformLocation(scene, 'uRes'), to.w, to.h);
        gl.uniform2f(gl.getUniformLocation(scene, 'uJitter'), j[0], j[1]);
        gl.uniform1f(gl.getUniformLocation(scene, 'uX'), x || 0);
        draw(to);
      };
      let from = 0;
      steps.forEach((st, i) => {
        const j = VideoScenes.JITTER[i % VideoScenes.JITTER.length];
        drawScene(small, st.x, j);
        gl.useProgram(resolve);
        bind(resolve, 'uCur', 0, small.t);
        bind(resolve, 'uHist', 1, pic[from].t);
        gl.uniform2f(gl.getUniformLocation(resolve, 'uCurRes'), w, h);
        gl.uniform2f(gl.getUniformLocation(resolve, 'uOutRes'), W, H);
        gl.uniform2f(gl.getUniformLocation(resolve, 'uJitter'), j[0], j[1]);
        gl.uniform1f(gl.getUniformLocation(resolve, 'uAge'), Math.min(i, 255));
        draw(pic[1 - from]);
        from = 1 - from;
      });
      const last = steps[steps.length - 1];
      drawScene(big, last.x, [0, 0]);
      // The stretched baseline is one redraw with no jitter, as a call draws
      // the scene when the resolve is missing. The last step's buffer would be
      // off by its own jitter, and the baseline worse than it really is.
      drawScene(small, last.x, [0, 0]);
      gl.useProgram(blit);
      bind(blit, 'uT', 0, small.t);
      draw(stretched);
      const read = (t) => {
        const px = new Uint8Array(W * H * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.f);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return Array.from(px);
      };
      // `prev` is the picture one redraw earlier.
      const res = { out: read(pic[from]), prev: read(pic[1 - from]), big: read(big), stretched: read(stretched) };
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return res;
    };
    // Root-mean-square difference of two pictures' luma (or alpha), inside a
    // margin of `m` pixels.
    window.__rms = (a, b, W, H, m = 4, alpha = false) => {
      let se = 0, n = 0;
      for (let y = m; y < H - m; y++) {
        for (let x = m; x < W - m; x++) {
          const i = (y * W + x) * 4;
          const d = alpha ? a[i + 3] - b[i + 3] : window.__luma(a, i) - window.__luma(b, i);
          se += d * d; n++;
        }
      }
      return Math.sqrt(se / n);
    };
    // How much fine detail a picture holds: the mean luma step between
    // horizontal neighbours, over the columns [x0, x1).
    window.__detail = (px, W, H, x0 = 0, x1 = W) => {
      let sum = 0, n = 0;
      for (let y = 0; y < H; y++) {
        for (let x = Math.max(1, x0); x < x1; x++) {
          const i = (y * W + x) * 4;
          sum += Math.abs(window.__luma(px, i) - window.__luma(px, i - 4));
          n++;
        }
      }
      return sum / n;
    };

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

  // "Purely generated, no assets": nothing a scene draws is fetched. The one
  // texture a scene reads is the lattice of random bytes the module fills in
  // from a fixed seed (noiseTexture()) — read with texelFetch, never sampled
  // from a picture, and never the only thing that decides what is drawn.
  test('a scene references no image, font or file', async ({ page }) => {
    const sources = await page.evaluate(() => VideoScenes.SCENES.map((s) => VideoScenes.fragmentSource(s.id)));
    for (const src of sources) {
      expect(src).not.toMatch(/\.(png|webp|jpe?g|svg)\b|url\(|fetch\(|XMLHttpRequest|\bImage\(/);
      expect(src).not.toMatch(/\btexture\(/);
      const samplers = src.match(/uniform\s+sampler2D\s+\w+/g) || [];
      expect(samplers).toEqual(['uniform sampler2D uNoise']);
    }
  });

  // The scenes cost what they cost to draw, and the catalogue is how the
  // pipeline learns it: a buffer size and a redraw ladder, each scene its own.
  test('each scene says how big and how often it is drawn', async ({ page }) => {
    const seen = await page.evaluate(() => VideoScenes.SCENES.map((s) => ({ id: s.id, res: s.res, hz: s.hz })));
    for (const s of seen) {
      expect(s.res, s.id).toBeGreaterThan(0.4);
      expect(s.res, s.id).toBeLessThanOrEqual(1);
      expect(s.hz.length, s.id).toBeGreaterThanOrEqual(2);
      expect(s.hz[0], s.id).toBeLessThanOrEqual(20);
      expect(s.hz[1], s.id).toBeLessThan(s.hz[0]);
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

    // A frame is a function of the clock, the look and the jitter point, and
    // nothing else: no random numbers of its own, so two renders agree. (A
    // call changes the jitter point with every redraw and adds them up; what
    // that costs a still room is pinned in 'sharp at the size it is shown'.)
    test(`${id} draws the same picture twice`, async ({ page }) => {
      const diff = await page.evaluate((id) => {
        const a = window.__renderScene(id, { times: [37] }).frames[0];
        const b = window.__renderScene(id, { times: [37] }).frames[0];
        let n = 0;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
        return n;
      }, id);
      expect(diff).toBe(0);
    });

    // The camera's shoulder: a bright light rolls off instead of clipping, so
    // no scene is a wash of flat white (or a hole of flat black) at its
    // default light.
    test(`${id} is exposed like a photograph, not clipped`, async ({ page }) => {
      const share = await page.evaluate((id) => {
        const r = window.__renderScene(id);
        const px = r.frames[0];
        let hi = 0, lo = 0;
        const n = r.w * r.h;
        for (let i = 0; i < n; i++) {
          const l = window.__luma(px, i * 4);
          if (l > 250) hi++;
          if (l < 4) lo++;
        }
        return { hi: hi / n, lo: lo / n };
      }, id);
      expect(share.hi).toBeLessThan(0.12);
      expect(share.lo).toBeLessThan(0.25);
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

  // What makes these worlds and not wallpaper is that things in them obey the
  // light. Each of these pins one such behaviour.
  test('the office is lit through its window: a soft light leaves the sun patch dimmer', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const region = (r) => {
        // Where the sun lands on the back wall, right of centre and low.
        let s = 0, n = 0;
        for (let y = Math.floor(r.h * 0.55); y < Math.floor(r.h * 0.9); y++) {
          for (let x = Math.floor(r.w * 0.55); x < Math.floor(r.w * 0.8); x++) {
            s += window.__luma(r.frames[0], ((r.h - 1 - y) * r.w + x) * 4); n++;
          }
        }
        return s / n;
      };
      const hard = window.__renderScene('office', { w: 256, h: 144, look: { dirX: 0.95 } });
      const soft = window.__renderScene('office', { w: 256, h: 144, look: { dirX: 0.05 } });
      return { hard: region(hard), soft: region(soft) };
    });
    expect(seen.hard).toBeGreaterThan(seen.soft * 1.1);
  });

  test('at night the sun has set over the island: the sky is warm, not blue', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const sky = (r) => {
        // The band just above the horizon, away from the palm.
        let red = 0, blue = 0;
        for (let y = Math.floor(r.h * 0.30); y < Math.floor(r.h * 0.45); y++) {
          for (let x = Math.floor(r.w * 0.55); x < Math.floor(r.w * 0.75); x++) {
            const i = ((r.h - 1 - y) * r.w + x) * 4;
            red += r.frames[0][i]; blue += r.frames[0][i + 2];
          }
        }
        return red / blue;
      };
      return {
        day: sky(window.__renderScene('island', { w: 256, h: 144 })),
        night: sky(window.__renderScene('island', { w: 256, h: 144, look: { exposure: 0.25 } })),
      };
    });
    expect(seen.night).toBeGreaterThan(seen.day * 1.4);
  });

  // The lake is a mirror: below the horizon the picture is the one above it,
  // upside down, so a row of the water follows the same ups and downs along x
  // as the row of sky and ridge the same distance above the horizon.
  test('the mountain lake mirrors the range', async ({ page }) => {
    const corr = await page.evaluate(() => {
      const r = window.__renderScene('mountain', { w: 320, h: 180 });
      const row = (y) => {
        const v = [];
        for (let x = 0; x < r.w; x++) v.push(window.__luma(r.frames[0], ((r.h - 1 - y) * r.w + x) * 4));
        return v;
      };
      const horizon = Math.round(r.h * 0.5 + r.h * 0.03 * 1.07);   // pitch 0.03 rad, focal 1.07
      const out = [];
      for (const k of [12, 20, 28]) {
        const a = row(horizon - k), b = row(horizon + k);
        const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
        let sab = 0, saa = 0, sbb = 0;
        for (let i = 0; i < a.length; i++) {
          sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2;
        }
        out.push(sab / Math.sqrt(saa * sbb + 1e-9));
      }
      return out;
    });
    // Positive and clear on the average; the ripples and the foreground take the rest.
    expect(corr.reduce((s, v) => s + v, 0) / corr.length).toBeGreaterThan(0.25);
  });

  // Regression: at dusk a few skyline pixels used to come out pure white (a
  // negative near-miss was taken for "no hit", and shaded at minus a kilometre).
  test('the mountain at dusk has no white fringe on its ridges', async ({ page }) => {
    const white = await page.evaluate(() => {
      const r = window.__renderScene('mountain', { w: 320, h: 180, look: { exposure: 0.25 } });
      let n = 0;
      for (let y = 0; y < Math.floor(r.h * 0.5); y++) {
        for (let x = 0; x < r.w; x++) {
          const i = ((r.h - 1 - y) * r.w + x) * 4;
          if (r.frames[0][i] === 255 && r.frames[0][i + 1] === 255 && r.frames[0][i + 2] === 255) n++;
        }
      }
      return n;
    });
    expect(white).toBe(0);
  });

  // Things near you answer your movement: the palm's fronds sway more.
  test('the palm stirs when you move', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const change = (motion) => {
        const r = window.__renderScene('island', { w: 160, h: 90, times: [37, 37.7], look: { motion } });
        const [a, b] = r.frames;
        let sum = 0, n = 0;
        // The upper right, where the crown is.
        for (let y = 0; y < Math.floor(r.h * 0.45); y++) {
          for (let x = Math.floor(r.w * 0.6); x < r.w; x++) {
            const i = ((r.h - 1 - y) * r.w + x) * 4;
            sum += Math.abs(window.__luma(a, i) - window.__luma(b, i)); n++;
          }
        }
        return sum / n;
      };
      return { still: change(0), moving: change(1) };
    });
    expect(seen.moving).toBeGreaterThan(seen.still * 1.5);
  });

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

test.describe('sharp at the size it is shown', () => {
  // A stand-in scene: fine ripples, a third finer than the small buffer can
  // hold once stretched three times, with nearness that ripples with them.
  const RIPPLES = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform vec2 uRes;
uniform vec2 uJitter;
uniform float uX;
void main() {
  vec2 uv = vUv + uJitter / uRes;
  float v = 0.5 + 0.5 * sin(uv.x * 6.2832 * 40.0 + uv.y * 6.0);
  outColor = vec4(vec3(v), v);
}`;
  // A bright bar on black at uX: what moves.
  const BAR = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform vec2 uRes;
uniform vec2 uJitter;
uniform float uX;
void main() {
  vec2 uv = vUv + uJitter / uRes;
  float v = abs(uv.x - uX) < 0.06 ? 1.0 : 0.0;
  outColor = vec4(vec3(v), 1.0);
}`;

  // A flat wall whose colour turns warmer at uX = 1 without getting brighter:
  // what a relight does to the room (uTint is luminance 1).
  const WARMER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform vec2 uRes;
uniform vec2 uJitter;
uniform float uX;
void main() {
  outColor = vec4(0.5 + 0.1 * uX, 0.5, 0.5 - 0.1 * uX, 1.0);
}`;

  // Redraws of a room that holds still add up to the detail of a buffer three
  // times bigger: much nearer to it than the small buffer stretched, colour
  // and nearness alike.
  test('a still room comes out as detailed as a buffer three times bigger', async ({ page }) => {
    const seen = await page.evaluate((frag) => {
      const W = 320, H = 180;
      const r = window.__resolve({ frag, w: 107, h: 60, W, H, steps: Array.from({ length: 32 }, () => ({})) });
      return {
        resolved: window.__rms(r.out, r.big, W, H),
        stretched: window.__rms(r.stretched, r.big, W, H),
        nearResolved: window.__rms(r.out, r.big, W, H, 4, true),
        nearStretched: window.__rms(r.stretched, r.big, W, H, 4, true),
        detail: window.__detail(r.out, W, H) / window.__detail(r.big, W, H),
      };
    }, RIPPLES);
    expect(seen.resolved).toBeLessThan(seen.stretched * 0.5);
    expect(seen.nearResolved).toBeLessThan(seen.nearStretched * 0.5);
    expect(seen.detail).toBeGreaterThan(0.75);
  });

  // What moves is shown where it is, not where it was: three redraws after
  // the bar jumps, nothing of it is left behind. The control resolves the
  // same redraws with the movement test switched off, and keeps a ghost, so
  // it is that test, not the redraws' own weight, that clears it.
  test('what moves leaves no ghost behind', async ({ page }) => {
    const seen = await page.evaluate((frag) => {
      const W = 320, H = 180, y = H >> 1;
      const steps = [...Array.from({ length: 24 }, () => ({ x: 0.3 })), ...Array.from({ length: 3 }, () => ({ x: 0.7 }))];
      const at = (px, fx) => window.__luma(px, (y * W + Math.round(fx * W)) * 4);
      const r = window.__resolve({ frag, w: 107, h: 60, W, H, steps });
      const blind = window.__resolve({ frag, w: 107, h: 60, W, H, steps, opts: { tol: 100 } });
      return { was: at(r.out, 0.3), is: at(r.out, 0.7), blindWas: at(blind.out, 0.3) };
    }, BAR);
    expect(seen.blindWas).toBeGreaterThan(80);
    expect(seen.was).toBeLessThan(25);
    expect(seen.is).toBeGreaterThan(200);
  });

  // A relight is movement even when it changes only the colour: the room
  // takes its new colour within a redraw or two, as the light wrap on the
  // person does. The control judges brightness alone and is still on its
  // way there.
  test('a room that turns warmer follows at once', async ({ page }) => {
    const seen = await page.evaluate((frag) => {
      const W = 320, H = 180;
      const steps = [...Array.from({ length: 24 }, () => ({ x: 0 })), ...Array.from({ length: 2 }, () => ({ x: 1 }))];
      const red = (px) => { let s = 0, n = 0; for (let i = 0; i < px.length; i += 4) { s += px[i]; n++; } return s / n; };
      const r = window.__resolve({ frag, w: 107, h: 60, W, H, steps });
      const blind = window.__resolve({ frag, w: 107, h: 60, W, H, steps, opts: { tolColour: 100 } });
      return { red: red(r.out), blindRed: red(blind.out) };
    }, WARMER);
    // 0.5 is 128, 0.6 is 153.
    expect(seen.red).toBeGreaterThan(150);
    expect(seen.blindRed).toBeLessThan(145);
  });

  // A room that holds still is a picture that holds still: once it has
  // settled, a redraw (another jitter point, so another look at every pixel)
  // changes it by only a level or two, because the encoder pays for every
  // pixel that changes, in every frame. The control adds each look in whole,
  // with no steady share, and churns, so it is the share that keeps it still.
  test('a settled room barely changes from one redraw to the next', async ({ page }) => {
    const seen = await page.evaluate((frag) => {
      const W = 320, H = 180, steps = Array.from({ length: 64 }, () => ({}));
      const r = window.__resolve({ frag, w: 107, h: 60, W, H, steps });
      const whole = window.__resolve({ frag, w: 107, h: 60, W, H, steps, opts: { gain: 1 } });
      return {
        churn: window.__rms(r.out, r.prev, W, H),
        nearChurn: window.__rms(r.out, r.prev, W, H, 4, true),
        wholeChurn: window.__rms(whole.out, whole.prev, W, H),
      };
    }, RIPPLES);
    expect(seen.wholeChurn).toBeGreaterThan(6);
    expect(seen.churn).toBeLessThan(1.5);
    expect(seen.nearChurn).toBeLessThan(1.5);
  });

  // The very first redraw is already a whole picture (the redraw itself,
  // smoothed), not a black frame waiting to fill.
  test('the first redraw is a whole picture', async ({ page }) => {
    const seen = await page.evaluate((frag) => {
      const W = 320, H = 180;
      const r = window.__resolve({ frag, w: 107, h: 60, W, H, steps: [{}] });
      let s = 0;
      for (let i = 0; i < r.out.length; i += 4) s += window.__luma(r.out, i);
      return s / (r.out.length / 4);
    }, RIPPLES);
    expect(seen).toBeGreaterThan(100);
    expect(seen).toBeLessThan(155);
  });
});

test.describe('in the camera pipeline', () => {
  // Blur and images must not pay for scenes: no scene buffer until one is
  // picked — the same rule that makes "off" free.
  test('scene buffers exist only once a scene is picked', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      await VideoEffects.wrap(window.__mkLitCamera('#555', '#555'), 'blur');
      await window.__sleep(300);
      const p = VideoEffects.active();
      const blur = { scene: !!p.texScene, soft: !!p.texSoftA, resolve: !!p.pResolve, out: !!p.texSceneOut };
      await VideoEffects.setMode('preset:office');
      await window.__sleep(300);
      return { blur, scene: !!p.texScene, resolve: !!p.pResolve, out: p.texSceneOut && p.texSceneOut.length, id: p.sceneId };
    });
    expect(seen.blur).toEqual({ scene: false, soft: false, resolve: false, out: false });
    expect(seen.scene).toBe(true);
    expect(seen.resolve).toBe(true);
    expect(seen.out).toBe(2);
    expect(seen.id).toBe('office');
  });

  // The scene the composite reads is resolved at the camera's own size, from
  // the very first frame of a pick (the redraw itself; an incomplete
  // mipmapped texture would sample as black), and a room that holds still
  // comes out nearer to the same scene drawn straight at that size than the
  // small buffer it is drawn into, stretched, and then stays nearly still.
  test('the scene is resolved at the camera\'s size, and sharpens as it holds still', async ({ page }) => {
    test.setTimeout(90_000);
    const seen = await page.evaluate(async () => {
      // A camera bigger than the scene's buffer, so there is detail to gain.
      const c = document.createElement('canvas');
      c.width = 640; c.height = 360;
      const ctx = c.getContext('2d');
      const paint = () => { ctx.fillStyle = '#666'; ctx.fillRect(0, 0, 640, 360); };
      paint();
      const stream = c.captureStream(15);
      const timer = setInterval(paint, 66);
      stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
      await VideoEffects.wrap(stream, 'blur');
      const p = VideoEffects.active();
      await window.__sleep(300);
      const gl = p.gl, W = p.canvas.width, H = p.canvas.height;
      const read = (fb, w, h) => {
        const px = new Uint8Array(w * h * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return px;
      };
      const mean = (px) => { let s = 0; for (let i = 0; i < px.length; i += 4) s += window.__luma(px, i); return s / (px.length / 4); };
      // Synchronously, so no other frame can be drawn in between.
      p.ensureScene('office');
      const first = mean(read(p.fbSceneOut[p.sceneOut], W, H));
      // The same moment again and again: a room holding still.
      const T = performance.now();
      for (let i = 0; i < 12; i++) { p.lastScene = 0; p.drawScene(T); }
      const settled = read(p.fbSceneOut[p.sceneOut], W, H);
      // One whole camera frame more, with a redraw in it: the composite shows
      // the picture that redraw was just added to, not the small buffer, and
      // not the picture before it. And the room has barely changed.
      const bindTex = p.bindTex;
      let shown = null;
      p.bindTex = function (prog, name, unit, tex) {
        if (prog === this.pComp && name === 'uScene') shown = tex;
        return bindTex.apply(this, arguments);
      };
      p.lastScene = 0;
      p.draw(T);
      p.bindTex = bindTex;
      const showsResolved = shown === p.texSceneOut[p.sceneOut];
      const churn = window.__rms(read(p.fbSceneOut[p.sceneOut], W, H), settled, W, H);
      // The same moment drawn once with no jitter, as it is when the resolve
      // is missing, and stretched to the same size.
      const t = VideoScenes.THUMB_TIME + (T - p.sceneStart) / 1000;
      VideoScenes.setUniforms(gl, p.sceneProgs.office, p.sceneW, p.sceneH, t, p.look, null);
      p.drawQuad(p.fbScene, p.sceneW, p.sceneH);
      const small = read(p.fbScene, p.sceneW, p.sceneH);
      // Opaque: a 2D canvas would premultiply by the nearness otherwise.
      for (let i = 3; i < small.length; i += 4) small[i] = 255;
      const sc = document.createElement('canvas');
      sc.width = p.sceneW; sc.height = p.sceneH;
      const img = sc.getContext('2d').createImageData(p.sceneW, p.sceneH);
      img.data.set(small);
      sc.getContext('2d').putImageData(img, 0, 0);
      const big = document.createElement('canvas');
      big.width = W; big.height = H;
      const bctx = big.getContext('2d');
      bctx.imageSmoothingEnabled = true;
      bctx.drawImage(sc, 0, 0, W, H);
      const stretched = bctx.getImageData(0, 0, W, H).data;
      // The same moment, in the same light, drawn straight at the camera's size.
      const ref = window.__renderScene('office', { w: W, h: H, times: [t], look: p.look }).frames[0];
      return {
        size: [W, H], buffer: [p.sceneW, p.sceneH], first, age: p.sceneAge, showsResolved, churn,
        settled: window.__rms(settled, ref, W, H), stretched: window.__rms(stretched, ref, W, H),
      };
    });
    expect(seen.buffer[0]).toBeLessThan(seen.size[0]);
    expect(seen.first).toBeGreaterThan(25);
    expect(seen.age).toBe(14);
    expect(seen.showsResolved).toBe(true);
    expect(seen.churn).toBeLessThan(0.8);
    expect(seen.settled).toBeLessThan(seen.stretched * 0.9);
  });

  test('stopping the camera releases the resolved scene with it', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      await VideoEffects.wrap(window.__mkLitCamera('#555', '#999'), 'preset:cybercafe');
      const p = VideoEffects.active();
      await window.__sleep(300);
      const before = { resolve: !!p.pResolve, out: !!p.texSceneOut };
      VideoEffects.stop();
      return { before, resolve: p.pResolve, out: p.texSceneOut, fb: p.fbSceneOut };
    });
    expect(seen.before).toEqual({ resolve: true, out: true });
    expect(seen.resolve).toBeUndefined();
    expect(seen.out).toBeNull();
    expect(seen.fb).toBeNull();
  });

  test('the subject\'s light is measured from the camera', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      await VideoEffects.wrap(window.__mkLitCamera('#202020', '#e0e0e0'), 'preset:office');
      const p = VideoEffects.active();
      await window.__waitFor(() => p.look.measured && p.look.dirX > 0.3, 12000);
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
      await window.__waitFor(() => p.look.measured && p.look.dirX > 0.3, 12000);
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
      await window.__waitFor(() => p.look.measured, 12000);
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
      await window.__waitFor(() => p.look.measured, 12000);
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
  // Each scene brings its own size and its own redraw ladder: the cheap café
  // is drawn full size, the mountain smaller, and a pick re-sizes the buffer.
  test('a scene is drawn at its own size and its own rate', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      // A camera big enough that the scene buffers are limited by SCENE_LONG
      // and not by the camera (the helper's 320 x 240 is smaller than any).
      const c = document.createElement('canvas');
      c.width = 1280; c.height = 720;
      const ctx = c.getContext('2d');
      let n = 0;
      const paint = () => { ctx.fillStyle = '#666'; ctx.fillRect(0, 0, 1280, 720); ctx.fillStyle = '#777'; ctx.fillRect((n++ * 7) % 1280, 0, 2, 2); };
      paint();
      const stream = c.captureStream(15);
      const timer = setInterval(paint, 66);
      stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
      await VideoEffects.wrap(stream, 'preset:cybercafe');
      const p = VideoEffects.active();
      await window.__sleep(300);
      const cafe = { w: p.sceneW, hz: p.sceneHzSteps.slice() };
      await VideoEffects.setMode('preset:mountain');
      await window.__sleep(300);
      const mountain = { w: p.sceneW, hz: p.sceneHzSteps.slice(), step: p.sceneStep };
      return { cafe, mountain, cam: p.canvas.width };
    });
    expect(seen.mountain.w).toBeLessThan(seen.cafe.w);
    expect(seen.mountain.hz).toEqual([10, 5]);
    expect(seen.cafe.hz).toEqual([15, 8]);
    expect(seen.mountain.step).toBe(0);
  });

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
  // The other half of that: left alone, a software GPU is not asked to render
  // them (and nothing else in the picker waits for them).
  test('a software GPU keeps the swatches and renders no thumbnails', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      const probe = document.createElement('canvas').getContext('webgl2');
      const software = VideoScenes.isSoftwareGL(probe);
      const thumbs = await VideoScenes.thumbnails();
      return { software, thumbs: Object.keys(thumbs).length };
    });
    // Only meaningful where the test machine is itself a software renderer,
    // which is what CI and this container are; on a real GPU it is the other test.
    test.skip(!seen.software, 'this machine has a real GPU');
    expect(seen.thumbs).toBe(0);
  });

  test('each scene chip gets a thumbnail rendered from its own shader', async ({ page }) => {
    // On a software GPU (this machine's) the picker keeps its gradient swatches
    // and renders no thumbnails: five ray-marched shaders compiled on the CPU
    // would freeze the page for a quarter of a minute. This test asks for them
    // anyway, which takes a good while here and a blink on a real GPU.
    test.setTimeout(120_000);
    await page.evaluate(() => { window.__voxalThumbsOnSoftwareGL = true; });
    await page.click('#btn-open-settings');
    await page.click('#modal-settings [data-target="settings-video"]');
    const chips = page.locator('#settings-bg-picker .bg-chip-scene');
    await expect(chips).toHaveCount(5);
    await expect.poll(() => page.evaluate(() =>
      Array.from(document.querySelectorAll('#settings-bg-picker .bg-chip-scene'))
        .filter((c) => /url\("(blob|data):/.test(c.style.backgroundImage)).length), { timeout: 100_000 })
      .toBe(5);
    const labels = await chips.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    expect(labels).toEqual(['Office', 'Island', 'Cyber café', 'Mountain', 'Countryside']);
  });
});
