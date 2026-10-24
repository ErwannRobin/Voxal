import { test, expect } from './fixtures.js';

// The scene engine (src/scenes/engine.js): Three.js drawing on a context made
// like the camera pipeline's, and handing it back as the pipeline expects.
// A small scene defined here (a lit room, a glowing strip, a sky) exercises
// the contract every module scene relies on — whatever the catalogue's own
// scenes look like.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const E = await import('/scenes/engine.js');
    const K = await import('/scenes/kit.js');
    window.__E = E;
    window.__K = K;
    // A context like the Processor's, with its one-time state.
    window.__ctx = (W = 256, H = 144) => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const gl = c.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
      gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { gl, fb, W, H, canvas: c };
    };
    window.__read = (gl, fb, W, H) => {
      const px = new Uint8Array(W * H * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    window.__look = (o) => Object.assign({ sideMix: 1, dirX: 0.6, dirY: 0, motion: 0, tint: [1, 1, 1], exposure: 1, cx: 0.5, cy: 0.62, sx: 0.2, sy: 0.3 }, o || {});
    // An asymmetric room: a red ball on the right, a cyan strip on the left,
    // sky through an opening at the top right.
    window.__def = {
      id: 'engine-test',
      camera: { pos: [0, 1.2, 0], target: [0, 1.1, -3], fov: 50, near: 0.05, far: 500 },
      nearness: [1, 10],
      build(k) {
        const T = k.THREE;
        K.sky(k, { sunDir: [0.6, 0.4, -0.7] });
        const room = new T.Mesh(new T.BoxGeometry(6, 3, 8), k.std({ color: 0xd8cfc0, roughness: 0.9, side: T.BackSide }));
        room.position.set(-1.5, 1.5, -2);
        room.receiveShadow = true;
        k.scene.add(room);
        const ball = new T.Mesh(new T.SphereGeometry(0.4, 24, 12), k.std({ color: 0x8a3020, roughness: 0.3, receiver: 0.5 }));
        ball.position.set(1.0, 0.4, -3);
        ball.castShadow = true;
        k.scene.add(ball);
        const strip = new T.Mesh(new T.BoxGeometry(0.05, 2.5, 0.05), k.glow(0x3fe0ff, 6));
        strip.position.set(-2.8, 1.5, -5.5);
        k.scene.add(strip);
        const sun = new T.DirectionalLight(0xfff0dd, 4);
        sun.position.set(4, 5, 2);
        sun.target.position.set(0, 0, -3);
        sun.castShadow = true;
        k.scene.add(sun, sun.target);
        k.scene.add(new T.HemisphereLight(0xbcd0ff, 0x403020, 0.6));
        return { ball };
      },
      update(k, s, t) { s.ball.position.y = 0.4 + 0.02 * Math.sin(t); }
    };
  });
});

test('draws into the pipeline\'s framebuffer and hands the context back as it found it', async ({ page }) => {
  const seen = await page.evaluate(async () => {
    const { gl, fb, W, H } = window.__ctx();
    const r = window.__E.createRenderer(gl, window.__def, {});
    await r.compile(W, H);
    r.draw(fb, W, H, 37, window.__look(), { jitter: [0.2, -0.3], detail: 720 }, { yaw: 0.05, pitch: 0, roll: 0 });
    const state = {
      error: gl.getError(),
      unpack: gl.getParameter(gl.UNPACK_ALIGNMENT),
      flipY: gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL),
      premul: gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL),
      blend: gl.isEnabled(gl.BLEND), depth: gl.isEnabled(gl.DEPTH_TEST),
      cull: gl.isEnabled(gl.CULL_FACE), scissor: gl.isEnabled(gl.SCISSOR_TEST),
      fbBound: gl.getParameter(gl.FRAMEBUFFER_BINDING) === fb,
      vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING)
    };
    // What the Processor does next still works: an odd-width R8 mask upload.
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 3, 3, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(9));
    state.maskUpload = gl.getError();
    const px = window.__read(gl, fb, W, H);
    let mean = 0;
    for (let i = 0; i < px.length; i += 4) mean += px[i] + px[i + 1] + px[i + 2];
    state.mean = mean / (W * H * 3);
    r.dispose();
    window.__E.releaseContext(gl);
    return state;
  });
  expect(seen).toMatchObject({ error: 0, unpack: 1, flipY: false, premul: false, blend: false, depth: false, cull: false, scissor: false, fbBound: true, vao: null, maskUpload: 0 });
  expect(seen.mean).toBeGreaterThan(30);
  expect(seen.mean).toBeLessThan(230);
});

test('a light on the left is the same picture, mirrored', async ({ page }) => {
  const d = await page.evaluate(async () => {
    const { gl, fb, W, H } = window.__ctx();
    const r = window.__E.createRenderer(gl, window.__def, {});
    // The subject in the middle, so mirroring it changes nothing.
    r.draw(fb, W, H, 37, window.__look({ sideMix: 1 }), null, null);
    const a = window.__read(gl, fb, W, H);
    r.draw(fb, W, H, 37, window.__look({ sideMix: 0, dirX: -0.6 }), null, null);
    const b = window.__read(gl, fb, W, H);
    // Halfway through a change of side: the picture and its mirror image.
    r.draw(fb, W, H, 37, window.__look({ sideMix: 0.5 }), null, null);
    const m = window.__read(gl, fb, W, H);
    r.dispose();
    window.__E.releaseContext(gl);
    let err = 0, sym = 0, n = 0, outside = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, j = (y * W + (W - 1 - x)) * 4;
      for (let c = 0; c < 3; c++) {
        err += Math.abs(a[i + c] - b[j + c]);
        sym += Math.abs(a[i + c] - a[j + c]);
        // Mixed in light, before the tone curve: between the two, not their average.
        if (m[i + c] < Math.min(a[i + c], b[i + c]) - 2 || m[i + c] > Math.max(a[i + c], b[i + c]) + 2) outside++;
      }
      n += 3;
    }
    return { err: err / n, asym: sym / n, outside: outside / n };
  });
  // Exact up to the fixed dither, which is not mirrored.
  expect(d.err).toBeLessThan(1.5);
  // ...and the room is not symmetric, so the test means something.
  expect(d.asym).toBeGreaterThan(8);
  expect(d.outside).toBeLessThan(0.002);
});

test('alpha is the subject\'s shadow weight: near walls take it, the sky and glows do not', async ({ page }) => {
  const a = await page.evaluate(async () => {
    const { gl, fb, W, H } = window.__ctx();
    const def = Object.assign({}, window.__def, { camera: { pos: [0, 1.2, 0], target: [0, 1.6, -3], fov: 50, near: 0.05, far: 500 } });
    const r = window.__E.createRenderer(gl, def, {});
    r.draw(fb, W, H, 37, window.__look(), null, null);
    const px = window.__read(gl, fb, W, H);
    r.dispose();
    window.__E.releaseContext(gl);
    const at = (fx, fy) => px[(Math.floor(fy * (H - 1)) * W + Math.floor(fx * (W - 1))) * 4 + 3];
    // The glowing strip is a pixel or two wide: the least alpha around it.
    let strip = 255;
    for (let y = Math.floor(0.25 * H); y < Math.floor(0.5 * H); y++) {
      for (let x = Math.floor(0.12 * W); x < Math.floor(0.26 * W); x++) strip = Math.min(strip, px[(y * W + x) * 4 + 3]);
    }
    return { floorNear: at(0.5, 0.02), backWall: at(0.55, 0.6), strip };
  });
  // Nearer surfaces take more of the subject's shadow than farther ones
  // (the floor at ~4 m against the back wall at ~6 m), a glow takes none.
  expect(a.floorNear).toBeGreaterThan(a.backWall + 20);
  expect(a.backWall).toBeGreaterThan(10);
  expect(a.strip).toBe(0);
});

test('the sky writes no shadow weight', async ({ page }) => {
  const a = await page.evaluate(async () => {
    const { gl, fb, W, H } = window.__ctx();
    const def = {
      id: 'sky-only', camera: { pos: [0, 1, 0], target: [0, 1.5, -3], fov: 50, far: 500 }, nearness: [1, 10],
      build(k) { window.__K.sky(k, {}); return {}; }
    };
    const r = window.__E.createRenderer(gl, def, {});
    r.draw(fb, W, H, 37, window.__look(), null, null);
    const px = window.__read(gl, fb, W, H);
    r.dispose();
    window.__E.releaseContext(gl);
    let max = 0;
    for (let i = 3; i < px.length; i += 4) max = Math.max(max, px[i]);
    return max;
  });
  expect(a).toBe(0);
});

test('a second context draws the very same picture (a keyed receiver rebuilds the sender\'s scene)', async ({ page }) => {
  const d = await page.evaluate(async () => {
    const one = window.__ctx(), two = window.__ctx();
    const ra = window.__E.createRenderer(one.gl, window.__def, {});
    const rb = window.__E.createRenderer(two.gl, window.__def, {});
    ra.draw(one.fb, one.W, one.H, 41.5, window.__look(), { jitter: [0.1, 0.2], detail: 720 }, null);
    rb.draw(two.fb, two.W, two.H, 41.5, window.__look(), { jitter: [0.1, 0.2], detail: 720 }, null);
    const a = window.__read(one.gl, one.fb, one.W, one.H), b = window.__read(two.gl, two.fb, two.W, two.H);
    ra.dispose(); rb.dispose();
    window.__E.releaseContext(one.gl); window.__E.releaseContext(two.gl);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
    return diff;
  });
  expect(d).toBeLessThanOrEqual(1);
});

test('the jitter moves the picture by the sub-pixel the resolve expects', async ({ page }) => {
  const e = await page.evaluate(async () => {
    const { gl, fb, W, H } = window.__ctx();
    const r = window.__E.createRenderer(gl, window.__def, {});
    const shot = (j) => { r.draw(fb, W, H, 37, window.__look(), { jitter: j, detail: H }, null); return window.__read(gl, fb, W, H); };
    const base = shot([0, 0]), right = shot([1, 0]), up = shot([0, 1]);
    r.dispose();
    window.__E.releaseContext(gl);
    // A redraw looked at +1 px is the base picture moved by one pixel: which
    // way, compared both ways.
    const cmp = (a, b, dx, dy) => {
      let s = 0, n = 0;
      for (let y = 4; y < H - 4; y++) for (let x = 4; x < W - 4; x++) {
        const i = (y * W + x) * 4, j = ((y + dy) * W + (x + dx)) * 4;
        s += Math.abs(a[i] - b[j]) + Math.abs(a[i + 1] - b[j + 1]); n += 2;
      }
      return s / n;
    };
    return { xMatch: cmp(right, base, 1, 0), xWrong: cmp(right, base, -1, 0), yMatch: cmp(up, base, 0, 1), yWrong: cmp(up, base, 0, -1) };
  });
  // Looking 1 px to the right of each pixel's centre shows what the base
  // picture has one pixel to the right; y is up, as in the resolve.
  expect(e.xMatch).toBeLessThan(e.xWrong * 0.6);
  expect(e.yMatch).toBeLessThan(e.yWrong * 0.6);
});

test('twenty scenes made and disposed on one context leave no GL objects behind', async ({ page }) => {
  const seen = await page.evaluate(async () => {
    const { gl, fb, W, H } = window.__ctx();
    const live = { tex: 0, buf: 0, prog: 0, fb: 0, rb: 0, vao: 0 };
    const wrap = (mk, del, key) => {
      const m = gl[mk].bind(gl), d = gl[del].bind(gl);
      gl[mk] = (...a) => { live[key]++; return m(...a); };
      gl[del] = (o) => { if (o) live[key]--; return d(o); };
    };
    wrap('createTexture', 'deleteTexture', 'tex'); wrap('createBuffer', 'deleteBuffer', 'buf');
    wrap('createProgram', 'deleteProgram', 'prog'); wrap('createFramebuffer', 'deleteFramebuffer', 'fb');
    wrap('createRenderbuffer', 'deleteRenderbuffer', 'rb'); wrap('createVertexArray', 'deleteVertexArray', 'vao');
    const counts = [];
    for (let i = 0; i < 20; i++) {
      const r = window.__E.createRenderer(gl, window.__def, {});
      r.draw(fb, W, H, 37 + i, window.__look(), { jitter: [0.1, 0.1], detail: 720 }, null);
      r.dispose();
      if (i === 1 || i === 19) counts.push(Object.assign({}, live));
    }
    window.__E.releaseContext(gl);
    const after = Object.assign({}, live);
    return { second: counts[0], last: counts[1], after, error: gl.getError() };
  });
  // After the first scene the engine (renderer, targets, output pass) is
  // warm; later scenes add nothing that stays.
  expect(seen.last).toEqual(seen.second);
  // Releasing the context's engine gives back its targets and buffers; what
  // stays is what Three's renderer makes once in its constructor (a handful
  // of placeholder textures, three framebuffers) and never frees: it goes
  // with the context, which the pipeline loses right after.
  expect(seen.after.tex).toBeLessThan(seen.second.tex);
  expect(seen.after.tex).toBeLessThanOrEqual(6);
  expect(seen.after.fb).toBeLessThanOrEqual(3);
  expect(seen.after.rb).toBe(0);
  expect(seen.after.vao).toBe(0);
  expect(seen.error).toBe(0);
});

// Every renderer but a thumbnail is drawn at the scene's best — the camera's,
// a keyed peer's, the preview — on a phone as on a computer; only the
// multisampling differs (8 / 4, none on a software rasteriser like this
// machine's SwiftShader, where the samples would cost the CPU).
test('quality: full everywhere but a thumbnail, and no multisampling on a software rasteriser', async ({ page }) => {
  const seen = await page.evaluate(() => {
    const { gl } = window.__ctx();
    const q = (opts) => {
      const r = window.__E.createRenderer(gl, window.__def, opts);
      const out = Object.assign({}, r._scene.quality);
      r.dispose();
      return out;
    };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
    return {
      software: /swiftshader|llvmpipe|software/i.test(name),
      full: q({ quality: 'full' }), phone: q({ quality: 'full', mobile: true }),
      receiver: q({ quality: 'receiver', mobile: true }), preview: q({ quality: 'preview' }),
      thumb: q({ quality: 'thumb' })
    };
  });
  const best = { shadow: 2048, mirror: 0.5, particles: 1 };
  for (const k of ['full', 'phone', 'receiver', 'preview']) expect(seen[k]).toMatchObject(best);
  expect(seen.thumb).toMatchObject({ shadow: 512, mirror: 0, particles: 0.4, samples: 0 });
  if (seen.software) {
    for (const k of ['full', 'phone', 'receiver', 'preview']) expect(seen[k]).toMatchObject({ samples: 0, software: true });
  } else {
    expect(seen.full.samples).toBeGreaterThan(seen.phone.samples - 1);
    expect(seen.phone.samples).toBeLessThanOrEqual(4);
  }
});

// The context's HDR target is kept per size, two of them: a context that
// alternates between two sizes (the preview and its cost probe) must not
// reallocate on every draw.
test('two sizes on one context keep their own targets', async ({ page }) => {
  const seen = await page.evaluate(() => {
    const { gl, fb } = window.__ctx(256, 144);
    const r = window.__E.createRenderer(gl, window.__def, { quality: 'full' });
    const L = window.__look();
    const eng = r._scene.eng;
    r.draw(fb, 256, 144, 37, L, null, null);
    const a = eng.rt;
    r.draw(fb, 128, 72, 37, L, null, null);
    const b = eng.rt;
    r.draw(fb, 256, 144, 37, L, null, null);
    const a2 = eng.rt;
    r.draw(fb, 64, 36, 37, L, null, null);
    const kept = eng.rts.length;
    r.dispose();
    return { sameA: a === a2, differ: a !== b, kept };
  });
  expect(seen).toEqual({ sameA: true, differ: true, kept: 2 });
});
