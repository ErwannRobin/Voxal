#!/usr/bin/env node
// Render the animated background scenes (src/video-scenes.js) to PNG files, so
// they can be looked at — which, for a shader that draws a whole world, is the
// only way to tell whether a change made it better.
//
//   node scripts/scene-preview.mjs                     all six, as a 1280x720 camera shows them, to scene-previews/
//   node scripts/scene-preview.mjs mountain island     just those
//   node scripts/scene-preview.mjs --size 640x360 --long 384   as a phone shows them
//   node scripts/scene-preview.mjs --size 360x640 --long 384   an upright phone
//   node scripts/scene-preview.mjs --look '{"exposure":0.25}'              a dim room: evening
//   node scripts/scene-preview.mjs --look '{"dirX":-0.8,"sideMix":0}'      lit from the left
//   node scripts/scene-preview.mjs --view '{"yaw":0.3,"pitch":-0.1}'       the camera turned (radians), as a tilting phone turns it
//   node scripts/scene-preview.mjs --time 80 --person  a later moment, with a stand-in subject
//   node scripts/scene-preview.mjs --alpha             the nearness channel instead (white = near)
//   node scripts/scene-preview.mjs --live             the clock runs between redraws, as in a call (default: one frozen moment, the best case)
//   node scripts/scene-preview.mjs --raw               one redraw, stretched (what shows if the resolve cannot compile)
//   node scripts/scene-preview.mjs --scenes copy.js    draw from a copy of video-scenes.js (to try a change, or to switch a layer off, without touching src/)
//   node scripts/scene-preview.mjs --nobloom           a scene that has a bloom, without it (to see what it adds)
//   node scripts/scene-preview.mjs --bits --person     and what each costs a video encoder
//   node scripts/scene-preview.mjs --bits --still      what a room that does not move at all costs: the resolve's own churn
//   node scripts/scene-preview.mjs --resolve '{"gain":0.4}'   other settings than RESOLVE's
//
//   node scripts/scene-preview.mjs --gpu               the machine's real GPU (ANGLE/Metal) instead of SwiftShader: seconds, not minutes
//   node scripts/scene-preview.mjs --mirror            the key light on the LEFT (sideMix 0, dirX -0.6)
//   node scripts/scene-preview.mjs --night             a dim room (exposure 0.22: NIGHT is fully on)
//   node scripts/scene-preview.mjs --subject left      the subject (stand-in and look.cx/cy/sx/sy) to the left | center | right
//   node scripts/scene-preview.mjs --matrix --out scene-previews/baseline/matrix
//        the whole validation matrix, per scene, into <out>/<scene>/<case>.png, with a labelled contact sheet
//        <out>/<scene>/sheet.png, a motion strip (live-strip.png / live-strip-night.png: three frames one second
//        apart and the difference between the first two), <out>/overview.png over the catalogue and
//        <out>/stability.json (mean luma change and share of pixels changing by more than 4/255 between frames
//        one second apart, outside and inside the calm zone — the middle 40 % of the width). The stand-in
//        subject is drawn (--noperson to leave it out). --cases a,b keeps the cases whose names contain a or b.
//        --tile 400 is the width of a sheet's tile; --jpeg writes sheets/overview as JPEG.
//
// A picture is made the way a call makes it (video-effects.js drawScene() and
// resolveScene()): the scene is drawn into its small buffer — SCENE_LONG
// (--long, 512) times the scene's `res` on the long side — --frames (24) times
// at the same moment, each redraw through another JITTER point, and resolved
// into a picture of --size, the camera's. --raw shows one redraw stretched
// instead. --bits then encodes --seconds (4) of the scene at its own redraw
// rate, after a warm-up, with VP9 at a fixed quantizer (--q, 32), and prints
// the keyframe's size and the motion's bitrate; --still holds the clock while
// it does, so all that is left to pay for is what the redraws themselves
// change. Compare runs against each other, never against a call's bandwidth.
//
// --person draws an oval head and shoulders over each picture: the middle of the
// frame is covered in a call, and a composition should be judged with it covered.
// Writes one PNG per scene plus sheet.png. Prints how long the first redraw took
// (most drivers compile a shader for real only when it is first drawn with, so
// that is mostly the compile) and a timed redraw (with its resolve, unless --raw):
// on a software GPU that is the scene's relative cost; on a real one, divide by a
// large number.
//
// ONE FUNCTION decides how the scene is drawn: makeDrawer() in the page. With
// VideoScenes.createRenderer (the v2 engine: createRenderer(gl, id, opts) →
// Promise<{draw(fb, w, h, time, look, frame, view), dispose()}>) it uses that;
// without it, the original compileProgram/setUniforms + full-screen triangle.
// Everything after it — the mipmaps, the resolve, the bloom, the stand-in, the
// numbers — is shared, so a before/after run differs in nothing but the engine.
//
// The browser is Playwright's. In a container whose Chromium is not the revision
// the installed Playwright expects, set CHROMIUM_PATH to the executable.

// The functions handed to page.evaluate() run in the page, not in Node.
/* global document, Image, VideoScenes, VideoEncoder, VideoFrame */

import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL = ['office', 'island', 'cybercafe', 'mountain', 'countryside', 'penthouse'];

// What "a dark room" and "mirrored" mean to the scenes (see KNOWLEDGE/scene-engine-v2.md).
const NIGHT_LOOK = { exposure: 0.22 };
const MIRROR_LOOK = { sideMix: 0, side: -1, dirX: -0.6 };
const SUBJECT_X = { left: 0.3, center: 0.5, right: 0.7 };

const args = process.argv.slice(2);
const opt = {
  w: 1280, h: 720, long: 512, frames: 24, t: 37, t2: 95, look: '{}', person: false, alpha: false, raw: false, live: false,
  view: 'null', bits: false, still: false, seconds: 4, q: 32, resolve: null, out: path.join(ROOT, 'scene-previews'),
  gpu: false, mirror: false, night: false, subject: null, matrix: false, noperson: false, cases: null, tile: 400,
  jpeg: false, renderer: '{}' };
const ids = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--size') { const m = /^(\d+)x(\d+)$/.exec(args[++i] || ''); if (!m) throw new Error('--size WxH'); opt.w = +m[1]; opt.h = +m[2]; }
  else if (a === '--long') opt.long = +args[++i];
  else if (a === '--frames') opt.frames = Math.max(1, +args[++i]);
  else if (a === '--time') opt.t = +args[++i];
  else if (a === '--time2') opt.t2 = +args[++i];
  else if (a === '--look') opt.look = args[++i];
  else if (a === '--view') opt.view = args[++i];
  else if (a === '--out') opt.out = path.resolve(args[++i]);
  else if (a === '--person') opt.person = true;
  else if (a === '--noperson') opt.noperson = true;
  else if (a === '--alpha') opt.alpha = true;
  else if (a === '--raw') opt.raw = true;
  else if (a === '--nobloom') opt.nobloom = true;
  else if (a === '--scenes') opt.scenes = path.resolve(args[++i]);
  else if (a === '--live') opt.live = true;
  else if (a === '--bits') opt.bits = true;
  else if (a === '--still') opt.still = true;
  else if (a === '--seconds') opt.seconds = +args[++i];
  else if (a === '--q') opt.q = +args[++i];
  else if (a === '--resolve') opt.resolve = JSON.parse(args[++i] || '{}');
  else if (a === '--gpu') opt.gpu = true;
  else if (a === '--mirror') opt.mirror = true;
  else if (a === '--night') opt.night = true;
  else if (a === '--subject') {
    opt.subject = args[++i];
    if (!(opt.subject in SUBJECT_X)) throw new Error('--subject left|center|right');
  }
  else if (a === '--matrix') opt.matrix = true;
  else if (a === '--cases') opt.cases = String(args[++i] || '').split(',').filter(Boolean);
  else if (a === '--tile') opt.tile = Math.max(120, +args[++i]);
  else if (a === '--jpeg') opt.jpeg = true;
  else if (a === '--renderer-opts') opt.renderer = args[++i];
  else if (a.startsWith('-')) throw new Error('unknown option ' + a);
  else ids.push(a);
}
const list = ids.length ? ids : ALL;
fs.mkdirSync(opt.out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: opt.gpu
    ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page]', e.message));
// A secure origin, because VideoEncoder (--bits) exists only in one; nothing is
// fetched from it.
await page.route('https://scene-preview.test/**', (r) =>
  r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>scenes</title>' }));
await page.goto('https://scene-preview.test/');
await page.addScriptTag({ path: opt.scenes || path.join(ROOT, 'src', 'video-scenes.js') });

// ---------------------------------------------------------------------------
// The page's side: window.SP. Installed once; a session holds one GL context
// and one compiled scene, so a matrix pays the compile once per scene however
// many sizes and moments it draws.
// ---------------------------------------------------------------------------
function installLib() {
  const SP = (globalThis.SP = { sessions: {} });

  // --- the stand-in subject: shoulders, neck, head. Landscape keeps the
  // proportions this script has always drawn; an upright frame is sized by its
  // width, so the head is the same size in pixels and the shoulders run off
  // the sides, the way a phone held at arm's length frames a person.
  const shapesFor = (W, H, cxFrac) => {
    const c = cxFrac * W, s = [];
    if (W >= H) {
      s.push({ k: 'e', x: c, y: H * 1.08, rx: W * 0.24, ry: H * 0.28, col: '#2c3038' });
      s.push({ k: 'r', x: c - W * 0.04, y: H * 0.62, w: W * 0.08, h: H * 0.2, col: '#96705c' });
      s.push({ k: 'e', x: c, y: H * 0.5, rx: W * 0.085, ry: H * 0.2, col: '#a87e68' });
    } else {
      const u = W, hc = H * 0.42, ry = 0.28 * u, top = hc + 0.3 * u, mid = top + ry;
      s.push({ k: 'e', x: c, y: mid, rx: 0.427 * u, ry, col: '#2c3038' });
      s.push({ k: 'r', x: c - 0.427 * u, y: mid, w: 0.854 * u, h: Math.max(0, H - mid + 1), col: '#2c3038' });
      s.push({ k: 'r', x: c - 0.07 * u, y: hc + 0.12 * u, w: 0.14 * u, h: top + 0.05 * u - (hc + 0.12 * u), col: '#96705c' });
      s.push({ k: 'e', x: c, y: hc, rx: 0.151 * u, ry: 0.2 * u, col: '#a87e68' });
    }
    return s;
  };
  const drawShapes = (ctx, shapes, flat) => {
    for (const s of shapes) {
      ctx.fillStyle = flat || s.col;
      if (s.k === 'e') { ctx.beginPath(); ctx.ellipse(s.x, s.y, s.rx, s.ry, 0, 0, Math.PI * 2); ctx.fill(); }
      else ctx.fillRect(s.x, s.y, s.w, s.h);
    }
  };
  // Where the stand-in is, measured the way measureSubject() measures a person
  // (centroid, spread*2, y down), so look.cx/cy/sx/sy are what a call would say.
  SP.subjectLook = (W, H, cxFrac) => {
    const mw = 64, mh = Math.max(8, Math.round(64 * H / W));
    const cv = document.createElement('canvas'); cv.width = mw; cv.height = mh;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, mw, mh);
    ctx.scale(mw / W, mh / H);
    drawShapes(ctx, shapesFor(W, H, cxFrac), '#fff');
    const d = ctx.getImageData(0, 0, mw, mh).data;
    let ws = 0, sx = 0, sy = 0;
    for (let i = 0; i < mw * mh; i++) {
      const w = d[i * 4] / 255; if (!w) continue;
      ws += w; sx += w * (i % mw); sy += w * Math.floor(i / mw);
    }
    const cx = sx / ws, cy = sy / ws;
    let vx = 0, vy = 0;
    for (let i = 0; i < mw * mh; i++) {
      const w = d[i * 4] / 255; if (!w) continue;
      const x = i % mw, y = Math.floor(i / mw);
      vx += w * (x - cx) * (x - cx); vy += w * (y - cy) * (y - cy);
    }
    return { cx: (cx + 0.5) / mw, cy: (cy + 0.5) / mh, sx: Math.sqrt(vx / ws) * 2 / mw, sy: Math.sqrt(vy / ws) * 2 / mh };
  };

  // --- GL plumbing
  const mkProgram = (gl, fs) => {
    const sh = (type, src) => {
      const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o);
      if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o));
      return o;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, '#version 300 es\nin vec2 aPos;\nout vec2 vUv;\n' +
      'void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }\n'));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  };
  const mkTarget = (gl, w, h, mips) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    // The pipeline's scene buffer is mipmapped (ensureScene() in video-effects.js).
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return { t, f, w, h };
  };
  const freeTarget = (gl, o) => { if (o) { gl.deleteFramebuffer(o.f); gl.deleteTexture(o.t); } };
  const bindTex = (gl, p, name, unit, t) => {
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.uniform1i(gl.getUniformLocation(p, name), unit);
  };

  // --- THE ADAPTER. "Draw one redraw of scene `id` into framebuffer `fb`,
  // which is already w x h." The only place that knows which engine is loaded.
  const makeDrawer = async (gl, id, vao, rendererOpts) => {
    if (typeof VideoScenes.createRenderer === 'function') {
      const r = await VideoScenes.createRenderer(gl, id, rendererOpts);
      return {
        engine: 'new',
        draw: (fb, w, h, time, look, frame, view) => r.draw(fb, w, h, time, look, frame, view),
        dispose: () => { if (r.dispose) r.dispose(); },
      };
    }
    const prog = VideoScenes.compileProgram(gl, id);
    return {
      engine: 'old',
      draw: (fb, w, h, time, look, frame, view) => {
        gl.bindVertexArray(vao);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.viewport(0, 0, w, h);
        VideoScenes.setUniforms(gl, prog, w, h, time, look, frame, view);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
      dispose: () => {},
    };
  };

  SP.open = async (id, o) => {
    const cv = document.createElement('canvas');
    cv.width = 16; cv.height = 16;
    const gl = cv.getContext('webgl2', { alpha: false, preserveDrawingBuffer: true });
    if (!gl) return { error: 'no WebGL2' };
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const s = { id, gl, cv, vao, key: '' };
    try {
      const t0 = performance.now();
      s.drawer = await makeDrawer(gl, id, vao, o.rendererOpts);
      s.compileMs = performance.now() - t0;
      const resolveSrc = o.resolve ? VideoScenes.resolveSource(o.resolve) : VideoScenes.RESOLVE_FRAG;
      s.hasResolve = !!resolveSrc;
      // No resolve in this build: a plain read of the redraw stands in for it.
      s.pResolve = mkProgram(gl, resolveSrc ||
        '#version 300 es\nprecision highp float;\nin vec2 vUv;\nout vec4 outColor;\nuniform sampler2D uCur;\n' +
        'void main() { outColor = texture(uCur, vUv); }\n');
      // The picture onto the canvas: colour, or the nearness as grey.
      s.pShow = mkProgram(gl, '#version 300 es\nprecision highp float;\nin vec2 vUv;\nout vec4 o;\nuniform sampler2D uT;\n' +
        'uniform float uAlpha;\nvoid main() { vec4 c = texture(uT, vUv); o = vec4(uAlpha > 0.5 ? vec3(c.a) : c.rgb, 1.0); }\n');
    } catch (e) { return { error: String(e.message || e).slice(0, 2000) }; }
    SP.sessions[id] = s;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return { engine: s.drawer.engine, compileMs: s.compileMs, hasResolve: s.hasResolve,
      renderer: info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)) };
  };

  SP.close = (id) => {
    const s = SP.sessions[id];
    if (!s) return;
    if (s.drawer) s.drawer.dispose();
    s.gl.getExtension('WEBGL_lose_context')?.loseContext();
    delete SP.sessions[id];
  };

  // One picture: c = { W, H, long, t, look, view, person, deriveSubject, subjectX, alpha, raw,
  // live, frames, nobloom, strip, bits, seconds, q, still }.
  SP.render = async (id, c) => {
    const s = SP.sessions[id];
    const { gl, cv, vao, drawer } = s;
    const W = c.W, H = c.H;
    // The scene's buffer, sized the way video-effects.js ensureScene() sizes it.
    const k = Math.min(1, c.long * (VideoScenes.byId(id).res || 1) / Math.max(W, H));
    const bw = Math.max(2, Math.round(W * k)), bh = Math.max(2, Math.round(H * k));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const key = [W, H, bw, bh].join('x');
    if (s.key !== key) {
      freeTarget(gl, s.small); if (s.pic) s.pic.forEach((p) => freeTarget(gl, p));
      s.small = mkTarget(gl, bw, bh, true);
      s.pic = [mkTarget(gl, W, H), mkTarget(gl, W, H)];
      s.key = key;
    }
    const small = s.small, pic = s.pic, pResolve = s.pResolve, pShow = s.pShow;
    const look = Object.assign(VideoScenes.defaultLook(),
      c.deriveSubject ? SP.subjectLook(W, H, c.subjectX) : {}, c.look);
    // Angles left out are zero (viewMatrix() takes a missing one for "no view").
    const view = c.view && Object.assign({ yaw: 0, pitch: 0, roll: 0 }, c.view);
    const bloom = c.nobloom ? 0 : (VideoScenes.byId(id).bloom || 0);
    // Whatever the scene's renderer left bound, the harness's own passes start clean.
    const prep = () => {
      gl.bindVertexArray(vao);
      gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.CULL_FACE);
      gl.colorMask(true, true, true, true);
    };
    // One redraw, as a call makes it: the scene through the next JITTER point
    // into its buffer, then resolved into the picture (or, with --raw, the
    // buffer alone, as it is).
    let from = 0, age = 0;
    const redraw = (t) => {
      const at = c.raw ? null : VideoScenes.JITTER[age % VideoScenes.JITTER.length];
      drawer.draw(small.f, bw, bh, t, look, at ? { jitter: at, detail: H } : null, view);
      prep();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, small.t);
      gl.generateMipmap(gl.TEXTURE_2D);
      if (at) {
        gl.useProgram(pResolve);
        bindTex(gl, pResolve, 'uCur', 0, small.t);
        if (s.hasResolve) {
          bindTex(gl, pResolve, 'uHist', 1, pic[from].t);
          gl.uniform2f(gl.getUniformLocation(pResolve, 'uCurRes'), bw, bh);
          gl.uniform2f(gl.getUniformLocation(pResolve, 'uOutRes'), W, H);
          gl.uniform2f(gl.getUniformLocation(pResolve, 'uJitter'), at[0], at[1]);
          gl.uniform1f(gl.getUniformLocation(pResolve, 'uAge'), Math.min(age, 255));
          gl.uniform1f(gl.getUniformLocation(pResolve, 'uBloom'), bloom);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, pic[1 - from].f);
        gl.viewport(0, 0, W, H);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        from = 1 - from;
      }
      age++;
    };
    const px = new Uint8Array(W * H * 4);
    const show = () => {
      prep();
      gl.useProgram(pShow);
      bindTex(gl, pShow, 'uT', 0, c.raw ? small.t : pic[from].t);
      gl.uniform1f(gl.getUniformLocation(pShow, 'uAlpha'), c.alpha ? 1 : 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    };
    // GL is bottom-up; the picture is not.
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const ctx = out.getContext('2d');
    const img = ctx.createImageData(W, H);
    const shapes = c.person ? shapesFor(W, H, c.subjectX) : null;
    const paint = (src) => {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const sI = ((H - 1 - y) * W + x) * 4, d = (y * W + x) * 4;
          img.data[d] = src[sI]; img.data[d + 1] = src[sI + 1]; img.data[d + 2] = src[sI + 2];
          img.data[d + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      if (shapes) drawShapes(ctx, shapes);
    };
    // A room holding still: --frames redraws of the same moment.
    const liveHz = VideoScenes.byId(id).hz[0];
    const at = (i) => c.t + (c.live ? i / liveHz : 0);
    const t0 = performance.now(); redraw(at(0)); show(); const first = performance.now() - t0;
    const t1 = performance.now(); redraw(at(1)); show(); const timed = performance.now() - t1;
    let n = 2;
    for (; n < (c.raw ? 1 : c.frames); n++) redraw(at(n));
    n = Math.max(n, 2);
    show();
    // How the picture is lit, as numbers: the mean luma, the share of crushed
    // blacks and of clipped whites, and the mean luma of a 6 x 3 grid (top
    // row first). A person covers the middle of it, so judge a composition
    // by the picture, not by these: they are for noticing that it went dark.
    const luma = (i) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    const grid = new Float64Array(18), cnt = new Float64Array(18);
    let sum = 0, lo = 0, hi = 0, edge = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const l = luma(((H - 1 - y) * W + x) * 4);
        if (x + 1 < W) edge += Math.abs(l - luma(((H - 1 - y) * W + x + 1) * 4));
        sum += l; if (l < 4) lo++; if (l > 250) hi++;
        const g = Math.min(2, Math.floor(y * 3 / H)) * 6 + Math.min(5, Math.floor(x * 6 / W));
        grid[g] += l; cnt[g]++;
      }
    }
    const stats = { mean: sum / (W * H), lo: lo / (W * H), hi: hi / (W * H), edge: edge / (W * H),
      grid: Array.from(grid, (v, i) => Math.round(v / cnt[i])) };
    paint(px);
    const url = out.toDataURL('image/png');

    // --- the motion strip: the room as a call shows it, redrawn at its own rate
    // with the clock running. Frames one second apart; how much a pixel changes
    // between them is what every receiver's encoder pays for, and what the eye
    // reads as shimmer. Measured on the scene alone (the stand-in is not in it),
    // outside and inside the calm zone — the middle 40 % of the width.
    let strip = null;
    if (c.strip && !c.raw) {
      const frames = [], times = [];
      const grab = () => {
        const l = new Float32Array(W * H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) l[y * W + x] = luma(((H - 1 - y) * W + x) * 4);
        frames.push({ px: px.slice(), l });
        times.push(c.t + (n - 1) / liveHz);
      };
      grab();
      const per = Math.max(1, Math.round(liveHz));
      for (let f = 1; f < c.strip; f++) {
        for (let j = 0; j < per; j++) redraw(c.t + (n++) / liveHz);
        show(); grab();
      }
      const x0 = Math.floor(W * 0.3), x1 = Math.ceil(W * 0.7);
      const zone = () => ({ sum: 0, n: 0, over: 0 });
      const measure = (a, b) => {
        const Z = { outside: zone(), inside: zone(), all: zone() };
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const d = Math.abs(a[y * W + x] - b[y * W + x]);
            for (const z of [x >= x0 && x < x1 ? Z.inside : Z.outside, Z.all]) { z.sum += d; z.n++; if (d > 4) z.over++; }
          }
        }
        const r = {};
        for (const key2 in Z) r[key2] = { mean: Z[key2].sum / Z[key2].n, pct: 100 * Z[key2].over / Z[key2].n };
        return r;
      };
      const pairs = [];
      for (let f = 1; f < frames.length; f++) pairs.push(measure(frames[f - 1].l, frames[f].l));
      const avg = {};
      for (const key2 of ['outside', 'inside', 'all']) {
        avg[key2] = { mean: pairs.reduce((p, q) => p + q[key2].mean, 0) / pairs.length,
          pct: pairs.reduce((p, q) => p + q[key2].pct, 0) / pairs.length };
      }
      const urls = frames.map((f) => { paint(f.px); return out.toDataURL('image/png'); });
      // |change| x 8 between the first two frames, with the calm zone's edges.
      const dd = ctx.createImageData(W, H);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const v = Math.min(255, Math.abs(frames[0].l[y * W + x] - frames[1].l[y * W + x]) * 8);
          const o2 = (y * W + x) * 4;
          dd.data[o2] = v; dd.data[o2 + 1] = v; dd.data[o2 + 2] = v; dd.data[o2 + 3] = 255;
        }
      }
      ctx.putImageData(dd, 0, 0);
      ctx.fillStyle = 'rgba(0,200,255,0.8)';
      ctx.fillRect(x0, 0, 2, H); ctx.fillRect(x1 - 2, 0, 2, H);
      const diffUrl = out.toDataURL('image/png');
      strip = { urls, diffUrl, pairs, avg, times };
    }

    // --bits: what the picture costs the encoder. A few seconds at the scene's
    // own redraw rate through VP9 at a FIXED quantizer, so the bytes are the
    // content's difficulty and nothing else: the first frame is the detail (a
    // keyframe), the rest is the motion. The picture has been running for a
    // while first, as it has in a call. A call's encoder works to a bitrate
    // cap instead, so there the same difficulty shows up as a blurrier picture
    // of the person rather than as more bytes.
    let bits = null;
    if (c.bits) {
      const hz = VideoScenes.byId(id).hz[0];
      const nn = Math.max(2, Math.round(c.seconds * hz));
      const when = (i) => c.t + (c.still ? 0 : i / hz);
      for (let i = 16; i > 0; i--) redraw(when(-i));
      const sizes = [];
      let failed = null;
      const enc = new VideoEncoder({
        output: (chunk) => sizes.push(chunk.byteLength),
        error: (e) => { failed = e.message; },
      });
      enc.configure({ codec: 'vp09.00.10.08', width: W, height: H, bitrateMode: 'quantizer', framerate: hz });
      for (let i = 0; i < nn; i++) {
        redraw(when(i)); show(); paint(px);
        const frame = new VideoFrame(out, { timestamp: Math.round(i * 1e6 / hz) });
        enc.encode(frame, { keyFrame: i === 0, vp9: { quantizer: c.q } });
        frame.close();
        await enc.flush();
      }
      enc.close();
      if (failed) return { error: 'encoder: ' + failed };
      const rest = sizes.slice(1).reduce((a, b) => a + b, 0);
      bits = { keyKB: sizes[0] / 1024, kbps: rest * 8 / 1000 / ((nn - 1) / hz), frames: nn, hz };
    }
    return { url, first, timed, bits, stats, strip, buffer: bw + 'x' + bh, look };
  };

  // Tiles with a label band above each, and headings, onto one canvas.
  //   items: { url, x, y, w, h, label } | { text, x, y, size, color } | { missing: true, x, y, w, h, label }
  SP.compose = async (items, W, H, o) => {
    o = o || {};
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = o.bg || '#14161b'; ctx.fillRect(0, 0, W, H);
    const imgs = await Promise.all(items.map((it) => it.url ? new Promise((done, fail) => {
      const im = new Image();
      im.onload = () => done(im);
      im.onerror = () => fail(new Error('bad image for ' + (it.label || it.text)));
      im.src = it.url;
    }) : null));
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    items.forEach((it, i) => {
      const mono = 'ui-monospace, Menlo, Consolas, monospace';
      if (it.text !== undefined) {
        ctx.font = 'bold ' + (it.size || 16) + 'px ' + mono; ctx.textBaseline = 'top';
        ctx.fillStyle = it.color || '#9fb4ff'; ctx.fillText(it.text, it.x, it.y);
        return;
      }
      if (it.label) {
        ctx.fillStyle = '#232734'; ctx.fillRect(it.x, it.y - 22, it.w, 22);
        ctx.font = '12px ' + mono; ctx.textBaseline = 'middle';
        ctx.fillStyle = it.color || '#e9ecf5'; ctx.fillText(it.label, it.x + 6, it.y - 10, it.w - 12);
      }
      if (imgs[i]) ctx.drawImage(imgs[i], it.x, it.y, it.w, it.h);
      else {
        ctx.fillStyle = '#2a1b1b'; ctx.fillRect(it.x, it.y, it.w, it.h);
        ctx.fillStyle = '#e07070'; ctx.font = '14px ' + mono; ctx.textBaseline = 'middle';
        ctx.fillText('missing', it.x + 10, it.y + it.h / 2);
      }
    });
    return o.jpeg ? cv.toDataURL('image/jpeg', 0.9) : cv.toDataURL('image/png');
  };
}
await page.evaluate(installLib);

// ---------------------------------------------------------------------------
// Node's side
// ---------------------------------------------------------------------------
const dataToFile = (file, url) => fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
const fileToData = (file) => 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
const ext = opt.jpeg ? 'jpg' : 'png';
const compose = (items, W, H) => page.evaluate(({ items, W, H, jpeg }) => globalThis.SP.compose(items, W, H, { jpeg }), { items, W, H, jpeg: opt.jpeg });
const rendererOpts = JSON.parse(opt.renderer);
const fmt = (v, d = 2) => v.toFixed(d);

// The plain mode: one picture per scene at --size, exactly as it always was.
async function plainRun() {
  const tiles = [];
  const subjectX = SUBJECT_X[opt.subject || 'center'];
  for (const id of list) {
    const lookOver = Object.assign({}, opt.night ? NIGHT_LOOK : {}, opt.mirror ? MIRROR_LOOK : {}, JSON.parse(opt.look));
    const derive = !!(opt.subject && opt.person);
    if (opt.subject && !derive) lookOver.cx = lookOver.cx ?? subjectX;
    const c = {
      W: opt.w, H: opt.h, long: opt.long, t: opt.t, look: lookOver, view: JSON.parse(opt.view),
      person: opt.person, subjectX, deriveSubject: derive, alpha: opt.alpha, raw: opt.raw,
      live: opt.live, frames: opt.frames, nobloom: opt.nobloom, bits: opt.bits, seconds: opt.seconds, q: opt.q, still: opt.still,
    };
    // With a stand-in, the look carries its cx/cy/sx/sy (as measureSubject() would say them); an explicit --look still wins.
    const o = await page.evaluate(({ id, resolve, rendererOpts }) => globalThis.SP.open(id, { resolve, rendererOpts }), { id, resolve: opt.resolve, rendererOpts });
    if (o.error) { console.error(`${id}: ${o.error}`); continue; }
    const res = await page.evaluate(({ id, c }) => globalThis.SP.render(id, c), { id, c });
    await page.evaluate((id) => globalThis.SP.close(id), id);
    if (res.error) { console.error(`${id}: ${res.error}`); continue; }
    fs.writeFileSync(path.join(opt.out, `${id}.png`), Buffer.from(res.url.split(',')[1], 'base64'));
    tiles.push(res.url);
    const st = res.stats;
    console.log(`${' '.repeat(12)} luma mean ${st.mean.toFixed(1)}, detail ${st.edge.toFixed(2)}, crushed ${(st.lo * 100).toFixed(0)}%, clipped ${(st.hi * 100).toFixed(1)}%, ` +
      `rows ${[0, 6, 12].map((q) => st.grid.slice(q, q + 6).join(' ')).join(' | ')}`);
    console.log(`${id.padEnd(12)} buffer ${res.buffer}, first redraw ${res.first.toFixed(0)} ms, timed redraw ${res.timed.toFixed(0)} ms` +
      (res.bits ? `, keyframe ${res.bits.keyKB.toFixed(1)} KB, motion ${res.bits.kbps.toFixed(0)} kb/s ` +
        `(${res.bits.frames} frames at ${res.bits.hz} Hz, q${opt.q})` : ''));
  }

  // A contact sheet, two across.
  if (tiles.length > 1) {
    const sheet = await page.evaluate(async ({ tiles, w, h }) => {
      const cols = 2, rows = Math.ceil(tiles.length / cols);
      const c = document.createElement('canvas');
      c.width = w * cols; c.height = h * rows;
      const ctx = c.getContext('2d');
      await Promise.all(tiles.map((u, i) => new Promise((done) => {
        const im = new Image();
        im.onload = () => { ctx.drawImage(im, (i % cols) * w, Math.floor(i / cols) * h); done(); };
        im.src = u;
      })));
      return c.toDataURL('image/png');
    }, { tiles, w: opt.w, h: opt.h });
    fs.writeFileSync(path.join(opt.out, 'sheet.png'), Buffer.from(sheet.split(',')[1], 'base64'));
  }
  console.log(`wrote ${tiles.length} picture${tiles.length === 1 ? '' : 's'} to ${path.relative(ROOT, opt.out) || '.'}`);
}

// The validation matrix. One factor at a time off the reference tile
// (landscape, day, key right, subject centre, t = opt.t), plus the combinations
// that break things: a mirrored room with the subject on the window side, a dark
// room mirrored. Portrait and 640x360 are drawn into a phone's buffer (long 384).
const SIZES = {
  landscape: { W: 1280, H: 720, long: 512 },
  small: { W: 640, H: 360, long: 384 },
  portrait: { W: 720, H: 1280, long: 384 },
};
const CASES = [
  { name: 'landscape-day', size: 'landscape' },
  { name: 'landscape-night', size: 'landscape', night: true },
  { name: 'landscape-mirror', size: 'landscape', mirror: true },
  { name: 'landscape-night-mirror', size: 'landscape', night: true, mirror: true },
  { name: 'landscape-subject-left', size: 'landscape', subject: 'left' },
  { name: 'landscape-mirror-subject-right', size: 'landscape', mirror: true, subject: 'right' },
  { name: 'landscape-t95', size: 'landscape', later: true },
  { name: 'landscape-nobloom', size: 'landscape', nobloom: true, bloomOnly: true },
  { name: 'small-day', size: 'small' },
  { name: 'small-night', size: 'small', night: true },
  { name: 'portrait-day', size: 'portrait' },
  { name: 'portrait-night', size: 'portrait', night: true },
  { name: 'portrait-mirror', size: 'portrait', mirror: true },
  { name: 'portrait-subject-left', size: 'portrait', subject: 'left' },
  { name: 'portrait-t95', size: 'portrait', later: true },
];
const STRIPS = [
  { name: 'live-strip', key: 'day', night: false },
  { name: 'live-strip-night', key: 'night', night: true },
];

async function matrixRun() {
  const base = { night: opt.night, mirror: opt.mirror, subject: opt.subject || 'center' };
  const userLook = JSON.parse(opt.look);
  const jsonFile = path.join(opt.out, 'stability.json');
  let doc = { meta: {}, scenes: {} };
  try { doc = JSON.parse(fs.readFileSync(jsonFile, 'utf8')); } catch { /* first run */ }
  doc.scenes = doc.scenes || {};
  const summary = [];
  let meta = null;

  const caseCfg = (cs, strip) => {
    const merged = Object.assign({}, base, cs);
    const size = SIZES[merged.size];
    const subject = merged.subject;
    const look = Object.assign({}, merged.night ? NIGHT_LOOK : {}, merged.mirror ? MIRROR_LOOK : {}, userLook);
    const t = merged.later ? opt.t2 : opt.t;
    const c = {
      W: size.W, H: size.H, long: size.long, t, look, view: JSON.parse(opt.view),
      person: !opt.noperson, subjectX: SUBJECT_X[subject], deriveSubject: !opt.noperson,
      alpha: opt.alpha, raw: opt.raw, live: !!strip, frames: strip ? Math.max(opt.frames, 96) : opt.frames, nobloom: !!merged.nobloom,
      strip: strip ? 3 : 0,
    };
    const exp = look.exposure ?? 1;
    const mirrored = (look.sideMix ?? 1) < 0.5;
    const label = `${cs.name || strip.name}  ${size.W}x${size.H}  t=${t}  exp ${exp}  key ${mirrored ? 'LEFT (mirrored)' : 'right'}  subject ${subject}` +
      (merged.nobloom ? '  NO BLOOM' : '');
    return { c, label, t, exp, mirrored, subject };
  };

  for (const id of list) {
    const hasBloom = await page.evaluate((x) => ((VideoScenes.byId(x) || {}).bloom || 0) > 0, id);
    const o = await page.evaluate(({ id, resolve, rendererOpts }) => globalThis.SP.open(id, { resolve, rendererOpts }), { id, resolve: opt.resolve, rendererOpts });
    if (o.error) { console.error(`${id}: ${o.error}`); continue; }
    if (!meta) {
      meta = { engine: o.engine, renderer: o.renderer, gpu: opt.gpu, frames: opt.frames, date: new Date().toISOString(), resolve: o.hasResolve };
      console.log(`engine ${o.engine}, GL ${o.renderer}${opt.gpu ? ' (--gpu)' : ''}`);
    }
    const dir = path.join(opt.out, id);
    fs.mkdirSync(dir, { recursive: true });
    const entry = { compileMs: Math.round(o.compileMs), cases: {} };
    const tiles = [];
    for (const cs of CASES) {
      if (cs.bloomOnly && !hasBloom) continue;
      if (opt.cases && !opt.cases.some((x) => cs.name.includes(x))) continue;
      const { c, label } = caseCfg(cs, null);
      let res;
      try { res = await page.evaluate(({ id, c }) => globalThis.SP.render(id, c), { id, c }); }
      catch (e) { console.error(`${id} ${cs.name}: ${String(e.message).slice(0, 400)}`); continue; }
      if (res.error) { console.error(`${id} ${cs.name}: ${res.error}`); continue; }
      dataToFile(path.join(dir, `${cs.name}.png`), res.url);
      const st = res.stats;
      const lk = res.look;
      entry.cases[cs.name] = { subject: [lk.cx, lk.cy, lk.sx, lk.sy].map((v) => +v.toFixed(2)), mean: +st.mean.toFixed(1), crushed: +(st.lo * 100).toFixed(1), clipped: +(st.hi * 100).toFixed(2), detail: +st.edge.toFixed(2), buffer: res.buffer, firstMs: Math.round(res.first), timedMs: Math.round(res.timed) };
      if (!entry.buffer && cs.name === 'landscape-day') { entry.buffer = res.buffer; entry.firstMs = Math.round(res.first); entry.timedMs = Math.round(res.timed); }
      const sub = `buf ${res.buffer}  luma ${st.mean.toFixed(0)}  crushed ${(st.lo * 100).toFixed(0)}%`;
      tiles.push({ cs, c, label: `${label}  |  ${sub}`, url: res.url });
      const dim = (c.look.exposure ?? 1) < 0.3 && (st.mean <= 25 || st.lo >= 0.25);
      console.log(`${id.padEnd(12)} ${cs.name.padEnd(32)} luma ${st.mean.toFixed(1).padStart(5)}, crushed ${(st.lo * 100).toFixed(0).padStart(2)}%, clipped ${(st.hi * 100).toFixed(1)}%, redraw ${res.timed.toFixed(0)} ms` +
        (dim ? '   <-- night floor missed (mean > 25, crushed < 25%)' : ''));
      if (dim) entry.cases[cs.name].nightFloorMissed = true;
    }

    // The motion strips.
    const strips = {};
    for (const sp of STRIPS) {
      if (opt.cases && !opt.cases.some((x) => 'live'.includes(x) || sp.name.includes(x))) continue;
      const cs = { name: sp.name, size: 'landscape', night: sp.night };
      const { c, label } = caseCfg(cs, sp);
      let res;
      try { res = await page.evaluate(({ id, c }) => globalThis.SP.render(id, c), { id, c }); }
      catch (e) { console.error(`${id} ${sp.name}: ${String(e.message).slice(0, 400)}`); continue; }
      if (res.error || !res.strip) { console.error(`${id} ${sp.name}: ${res.error || 'no strip'}`); continue; }
      const a = res.strip.avg;
      strips[sp.key] = a;
      entry[sp.key] = {
        outside: { mean: +a.outside.mean.toFixed(3), pct: +a.outside.pct.toFixed(3) },
        inside: { mean: +a.inside.mean.toFixed(3), pct: +a.inside.pct.toFixed(3) },
        all: { mean: +a.all.mean.toFixed(3), pct: +a.all.pct.toFixed(3) },
        pairs: res.strip.pairs.map((p) => ({ outside: +p.outside.mean.toFixed(3), inside: +p.inside.mean.toFixed(3) })),
      };
      const hz = await page.evaluate((x) => VideoScenes.byId(x).hz[0], id);
      const items = [];
      const TW = opt.tile, TH = Math.round(opt.tile * 9 / 16), G = 10, M = 10;
      items.push({ text: `${id} - ${sp.name}: frames one second apart (${hz} Hz redraws, live clock), then |change| x8 (cyan = calm zone)`, x: M, y: M, size: 14 });
      res.strip.urls.forEach((u, i) => items.push({ url: u, x: M + i * (TW + G), y: 62, w: TW, h: TH,
        label: `frame ${i + 1}/3  t=${res.strip.times[i].toFixed(2)} s` + (i ? '' : `  ${label.split('  ').slice(3).join('  ')}`) }));
      items.push({ url: res.strip.diffUrl, x: M + 3 * (TW + G), y: 62, w: TW, h: TH,
        label: `|change| 0->1 x8   outside ${fmt(a.outside.mean)}/255 ${fmt(a.outside.pct, 1)}%>4   inside ${fmt(a.inside.mean)} ${fmt(a.inside.pct, 1)}%` });
      const W = 4 * TW + 3 * G + 2 * M, H = 62 + TH + M;
      const url = await compose(items, W, H);
      dataToFile(path.join(dir, `${sp.name}.${ext}`), url);
    }

    // The contact sheet: the 1280x720 tiles first, then the portrait ones, with the
    // 640x360 pair stacked in the space to their right.
    const TW = opt.tile, TH = Math.round(opt.tile * 9 / 16), G = 10, M = 10, BAND = 22;
    const land = tiles.filter((t) => t.c.W > 640 && t.c.W > t.c.H);
    const small = tiles.filter((t) => t.c.W <= 640 && t.c.W > t.c.H);
    const port = tiles.filter((t) => t.c.W < t.c.H);
    const cols = 4, SW = cols * TW + (cols - 1) * G + 2 * M;
    const items = [];
    let y = M;
    const head = `${id}   engine ${meta?.engine}   ${meta?.renderer || ''}   frozen moment, ${opt.frames} redraws, stand-in subject ${opt.noperson ? 'off' : 'on'}`;
    items.push({ text: head, x: M, y, size: 15 });
    y += 30 + BAND;
    land.forEach((t, i) => {
      const r = Math.floor(i / cols), q = i % cols;
      items.push({ url: t.url, x: M + q * (TW + G), y: y + r * (BAND + TH + G), w: TW, h: TH, label: t.label });
    });
    y += Math.ceil(land.length / cols) * (BAND + TH + G);
    const PW = Math.round(TW * 9 / 16 * 0.9), PH = Math.round(PW * 16 / 9);
    let rowH = 0, endX = M;
    port.forEach((t, i) => {
      const per = Math.max(1, Math.floor((SW - 2 * M + G) / (PW + G)));
      const r = Math.floor(i / per), q = i % per;
      items.push({ url: t.url, x: M + q * (PW + G), y: y + BAND + r * (BAND + PH + G), w: PW, h: PH, label: t.label.split('  ').slice(0, 4).join(' ') });
      rowH = Math.max(rowH, (r + 1) * (BAND + PH + G));
      endX = Math.max(endX, M + (q + 1) * (PW + G));
    });
    // The small tiles go to the right of the portrait ones when there is room, under them otherwise.
    const room = SW - M - endX;
    const sw = Math.min(TW, room >= 200 ? room : TW), sh = Math.round(sw * 9 / 16);
    small.forEach((t, i) => {
      if (room >= 200) {
        items.push({ url: t.url, x: endX, y: y + BAND + i * (BAND + sh + G), w: sw, h: sh, label: t.label.split('  ').slice(0, 5).join(' ') });
        rowH = Math.max(rowH, (i + 1) * (BAND + sh + G));
      } else {
        items.push({ url: t.url, x: M + i * (TW + G), y: y + BAND + rowH + BAND, w: TW, h: TH, label: t.label });
      }
    });
    if (small.length && room < 200) rowH += BAND + TH + G + BAND;
    y += rowH + (port.length || small.length ? BAND : 0);
    if (tiles.length) {
      const url = await compose(items, SW, y + M);
      dataToFile(path.join(dir, `sheet.${ext}`), url);
    }
    await page.evaluate((x) => globalThis.SP.close(x), id);

    doc.scenes[id] = entry;
    const dn = entry.day, ni = entry.night;
    summary.push({ id, entry });
    console.log(`${id.padEnd(12)} compile ${entry.compileMs} ms, buffer ${entry.buffer}` +
      (dn ? `, stability day out ${fmt(dn.outside.mean)}/${fmt(dn.outside.pct, 1)}% in ${fmt(dn.inside.mean)}/${fmt(dn.inside.pct, 1)}%` : '') +
      (ni ? `, night out ${fmt(ni.outside.mean)}/${fmt(ni.outside.pct, 1)}% in ${fmt(ni.inside.mean)}/${fmt(ni.inside.pct, 1)}%` : ''));
  }

  // The overview: the day tile and the portrait tile of every scene, labelled,
  // rebuilt from whatever is on disk so a run of one scene refreshes its row.
  const rows = ALL.filter((id) => fs.existsSync(path.join(opt.out, id, 'landscape-day.png')));
  if (rows.length) {
    const TW = Math.round(opt.tile * 1.2), TH = Math.round(TW * 9 / 16), PH = TH, PW = Math.round(PH * 9 / 16);
    const G = 10, M = 10, BAND = 22, HEAD = 30;
    const items = [{ text: `Scene catalogue overview - ${opt.out.split(path.sep).slice(-2).join('/')}   engine ${doc.meta?.engine || meta?.engine}   landscape-day + portrait-day, stand-in on`, x: M, y: M, size: 14 }];
    const cols = 2, cellW = TW + G + PW + G * 3;
    rows.forEach((id, i) => {
      const r = Math.floor(i / cols), q = i % cols;
      const x = M + q * cellW, y = M + HEAD + BAND + r * (BAND + TH + G * 2);
      const stab = doc.scenes?.[id]?.day;
      const lfile = path.join(opt.out, id, 'landscape-day.png'), pfile = path.join(opt.out, id, 'portrait-day.png');
      items.push({ url: fileToData(lfile), x, y, w: TW, h: TH, label: `${id}  landscape-day 1280x720` + (stab ? `   shimmer ${fmt(stab.all.mean)}/255` : '') });
      if (fs.existsSync(pfile)) items.push({ url: fileToData(pfile), x: x + TW + G, y, w: PW, h: PH, label: 'portrait' });
    });
    const W = cols * cellW + M, H = M + HEAD + Math.ceil(rows.length / cols) * (BAND + TH + G * 2);
    dataToFile(path.join(opt.out, `overview.${ext}`), await compose(items, W, H));
  }

  doc.meta = Object.assign({}, doc.meta, meta || {});
  fs.writeFileSync(jsonFile, JSON.stringify(doc, null, 2) + '\n');

  // The table: mean |change| in 1/255 levels, and the share of pixels moving by more than 4.
  console.log('\nstability (frames 1 s apart, live clock; mean |dY| /255 and % of pixels > 4/255)');
  console.log('scene'.padEnd(13) + ['day out', 'day in', 'night out', 'night in'].map((s) => s.padStart(16)).join(''));
  for (const { id, entry } of summary) {
    const cell = (z) => (z ? `${fmt(z.mean)} / ${fmt(z.pct, 1)}%${z.mean >= 3 ? '!' : ' '}` : '-').padStart(16);
    console.log(id.padEnd(13) + cell(entry.day?.outside) + cell(entry.day?.inside) + cell(entry.night?.outside) + cell(entry.night?.inside));
  }
  console.log('("!" = at or over the 3/255 the tests pin)');
  console.log(`wrote ${summary.length} scene${summary.length === 1 ? '' : 's'} to ${path.relative(ROOT, opt.out) || '.'}`);
}

if (opt.matrix) await matrixRun(); else await plainRun();
await browser.close();
