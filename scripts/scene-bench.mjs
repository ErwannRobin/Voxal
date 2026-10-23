#!/usr/bin/env node
// Performance and leak bench for the animated background scenes
// (src/video-scenes.js) — the numbers a rewrite of the scene engine has to be
// held against. It draws scenes the way the camera pipeline does (a scene
// buffer, then the resolve pass up to the camera's size), outside any call, so
// the figures are the scene's own cost and nothing else.
//
//   node scripts/scene-bench.mjs                      all six scenes, SwiftShader (software GL)
//   node scripts/scene-bench.mjs --gpu                the real GPU (ANGLE over Metal on a Mac)
//   node scripts/scene-bench.mjs office penthouse     just those
//   node scripts/scene-bench.mjs --only init,steady   phases: init | steady | leaks   (default: all three)
//   node scripts/scene-bench.mjs --cases 720p-d512    redraw cases (see CASES below; --cases all for every one)
//   node scripts/scene-bench.mjs --samples 60 --warmup 4 --budget-ms 8000
//   node scripts/scene-bench.mjs --cycles 20          create/dispose cycles for the leak phase (default 20)
//   node scripts/scene-bench.mjs --cold               also time init with every fragment shader's source made unique, defeating the OS/driver shader cache
//                                                     (macOS keeps compiled Metal pipelines on disk: a plain GPU init is cache-WARM; a shader never
//                                                     compiled on this machine pays more the first time. SwiftShader has no such cache.)
//   node scripts/scene-bench.mjs --bits               also: VP9 fixed-quantizer cost, via scripts/scene-preview.mjs (see below); --bits-gpu draws it on the real GPU (minutes -> seconds)
//   node scripts/scene-bench.mjs --only bits --bits    the bitrate alone
//   node scripts/scene-bench.mjs --scenes a.js,b.js   draw from other scene library files (a rewrite under test)
//   node scripts/scene-bench.mjs --engine renderer    force the adapter (default: detected at runtime)
//   node scripts/scene-bench.mjs --label new-gpu --out scene-previews/reports
//   node scripts/scene-bench.mjs --render run.json    print the markdown of a saved run again
//   node scripts/scene-bench.mjs --compare base.json new.json [--limit-p95 1.25 --limit-init 1.5]
//
// What it measures, per scene
//
//   init      Cold shader compile and first draw, each in a FRESH browser (the
//             driver caches compiled programs for the life of the process, so a
//             second compile in the same browser measures the cache). Split into
//             `compile` (the library call that returns a usable scene — for the
//             legacy engine compileProgram() / compileProgramAsync()) and the
//             first and second fenced draw (the lazy half of a compile that
//             some drivers only finish at the first draw). `block` is the
//             longest gap a 2 ms timer saw while all of that ran: how long the
//             page froze. `warm` is a second compile in a second context of the
//             same browser, i.e. what a keyed receiver or a re-pick pays.
//             Both the 'sync' and the 'async' (KHR_parallel_shader_compile)
//             paths are measured when the engine has both.
//   steady    Redraw time, p50 / p95 over --samples redraws (at least 6, and as
//             many as fit in --budget-ms per cell), fenced with a 1-px
//             readPixels so the GPU work is inside the figure:
//               scene     the redraw into its buffer + generateMipmap (no jitter)
//               +resolve  the same, plus the resolve pass into the camera-size picture
//               resolve   the resolve pass alone
//             and, where EXT_disjoint_timer_query_webgl2 exists, the GPU's own
//             time for `+resolve`. Cases (CASES) give the camera and the scene
//             buffer's long side the pipeline would use: 512 desktop, 768 =
//             the desktop pipeline's actual starting step (SCENE_SCALE 1.5),
//             1152 = what a keyed receiver starts at (KEYIN_SCENE_SCALE),
//             384 phone. buffer = long x scene.res on the long side.
//   leaks     (a) --cycles acquire/draw/release cycles on ONE context: live GL
//             objects (counted by wrapping gl.create*/delete*) must not grow;
//             (b) --cycles create-context / acquire / draw / release /
//             loseContext cycles: JS heap (CDP, after a forced GC, baselined
//             after the first cycle), DOM nodes and listeners must not grow,
//             live contexts must stay at one, and nothing the library made may
//             survive its own release. Also: contexts the library created
//             behind the caller's back during acquire().
//
// Bitrate (--bits) is NOT measured here: it is scripts/scene-preview.mjs's
// method — the scene is drawn the way a call draws it, encoded with VP9 at a
// FIXED quantizer through VideoEncoder, and the keyframe's size and the motion's
// kb/s are printed. Run it yourself, or let --bits do it:
//
//   node scripts/scene-preview.mjs --bits --person    # a moving room, person drawn over it
//   node scripts/scene-preview.mjs --bits --still     # the room frozen: the resolve's own churn
//
// (add --out scene-previews/reports/bits-x so the PNGs stay out of the way).
// Compare runs with each other, never with a call's bandwidth. scene-preview is
// always SwiftShader; the figures are the content's difficulty, not the
// driver's, so that is fine.
//
// The adapter. Everything that knows HOW a scene is drawn lives in the one
// ADAPTER block inside harness() below: acquire() / drawRedraw() / release()
// (and resolveProgram()). It is detected at runtime:
//   legacy    VideoScenes.compileProgram[Async](gl, id) + setUniforms(...) into a
//             framebuffer the caller binds, then generateMipmap (today)
//   renderer  VideoScenes.createRenderer(gl, id) -> { draw(fb, w, h, t, look,
//             frame, view), dispose() }  (a rewrite; the awaited result may also
//             carry `ready`)
// Switching engines means editing only that block.
//
// Honesty notes. Software GL timings are CPU time and move with whatever else
// the machine is doing (load averages are recorded in the report, before and
// after); GPU timings are ANGLE's, on one machine; on both, every redraw here
// is alone on the context, where a call also runs segmentation and the
// composite. The figures are for comparing two engines back to back, on one
// machine, not for quoting.

/* global window, document, WebGL2RenderingContext, HTMLCanvasElement, OffscreenCanvas */

import { chromium } from '@playwright/test';
import { spawnSync, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL = ['office', 'island', 'cybercafe', 'mountain', 'countryside', 'penthouse'];

// name: [camera width, camera height, the scene buffer's long side before `res`]
const CASES = {
  '360p-d512': { W: 640, H: 360, long: 512, note: '640x360 camera, desktop base step' },
  '720p-d512': { W: 1280, H: 720, long: 512, note: '1280x720 camera, desktop base step (the old baseline)' },
  '720p-d768': { W: 1280, H: 720, long: 768, note: '1280x720 camera, desktop pipeline start (SCENE_SCALE 1.5)' },
  'rx720p-d1152': { W: 1280, H: 720, long: 1152, note: 'keyed receiver start (KEYIN_SCENE_SCALE 2.25) at 1280x720' },
  'portrait-p384': { W: 720, H: 1280, long: 384, note: 'portrait phone camera 720x1280, phone base step' },
  'portrait-p480': { W: 720, H: 1280, long: 480, note: 'portrait phone camera, phone pipeline start (1.25)' },
  '1080p-d1152': { W: 1920, H: 1080, long: 1152, note: 'Full HD desktop (SCENE_SCALE_MAX)' },
};
const DEFAULT_CASES = ['360p-d512', '720p-d512', '720p-d768', 'rx720p-d1152', 'portrait-p384'];

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const opt = {
  gpu: false, samples: 30, warmup: 3, budgetMs: 6000, cycles: 20, label: null,
  out: path.join(ROOT, 'scene-previews', 'reports'), only: ['init', 'steady', 'leaks'],
  cases: DEFAULT_CASES, scenes: [path.join(ROOT, 'src', 'video-scenes.js')], engine: 'auto',
  bits: false, bitsOut: null, cold: false, render: null, bitsGpu: false, compare: null, limitP95: 1.25, limitInit: 1.5, gpuTimer: true,
};
const ids = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => { if (i + 1 >= args.length) throw new Error(a + ' needs a value'); return args[++i]; };
  if (a === '--gpu') opt.gpu = true;
  else if (a === '--samples') opt.samples = Math.max(3, +next());
  else if (a === '--warmup') opt.warmup = Math.max(1, +next());
  else if (a === '--budget-ms') opt.budgetMs = Math.max(500, +next());
  else if (a === '--cycles') opt.cycles = Math.max(2, +next());
  else if (a === '--label') opt.label = next();
  else if (a === '--out') opt.out = path.resolve(next());
  else if (a === '--only') opt.only = next().split(',').filter(Boolean);
  else if (a === '--cases') {
    const v = next();
    opt.cases = v === 'all' ? Object.keys(CASES) : v.split(',').filter(Boolean);
    for (const c of opt.cases) if (!CASES[c]) throw new Error('unknown case ' + c + ' (have ' + Object.keys(CASES).join(', ') + ')');
  }
  else if (a === '--scenes') opt.scenes = next().split(',').filter(Boolean).map((p) => path.resolve(p));
  else if (a === '--engine') opt.engine = next();
  else if (a === '--bits') opt.bits = true;
  else if (a === '--bits-out') opt.bitsOut = path.resolve(next());
  else if (a === '--cold') opt.cold = true;
  else if (a === '--bits-gpu') opt.bitsGpu = true;
  else if (a === '--render') opt.render = path.resolve(next());
  else if (a === '--no-gpu-timer') opt.gpuTimer = false;
  else if (a === '--compare') { opt.compare = [path.resolve(next()), path.resolve(next())]; }
  else if (a === '--limit-p95') opt.limitP95 = +next();
  else if (a === '--limit-init') opt.limitInit = +next();
  else if (a === '-h' || a === '--help') {
    const head = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
    console.log(head.slice(1, head.findIndex((l, n) => n > 0 && !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(0);
  }
  else if (a.startsWith('-')) throw new Error('unknown option ' + a);
  else ids.push(a);
}
const list = ids.length ? ids : ALL;
const label = opt.label || ((opt.engine === 'auto' ? 'run' : opt.engine) + '-' + (opt.gpu ? 'gpu' : 'swiftshader'));

// ---------------------------------------------------------------------------
// compare two saved runs
// ---------------------------------------------------------------------------

if (opt.compare) {
  process.exit(compareRuns(opt.compare[0], opt.compare[1], opt));
}

// ---------------------------------------------------------------------------
// the page side
// ---------------------------------------------------------------------------

// Installed before any script runs: counts every GL object a page creates and
// deletes, per context, and every context created and lost. Wrapping the
// prototypes is how a library's own allocations show up without it knowing.
function glTracker() {
  const T = window.__glt = {
    objs: new Map(),                 // live object -> { kind, gl }
    created: {}, deleted: {}, orphaned: {},
    ctxLive: new Set(), ctxCreated: 0, ctxLost: 0, ctxEvicted: 0, ctxMax: 0,
  };
  const kinds = ['Texture', 'Program', 'Shader', 'Framebuffer', 'Buffer', 'Renderbuffer', 'VertexArray', 'Sampler', 'Query', 'TransformFeedback'];
  const owner = (name) => {
    let p = WebGL2RenderingContext.prototype;
    while (p && !Object.prototype.hasOwnProperty.call(p, name)) p = Object.getPrototypeOf(p);
    return p;
  };
  for (const k of kinds) {
    const cn = 'create' + k, dn = 'delete' + k;
    const cp = owner(cn), dp = owner(dn);
    if (!cp || !dp) continue;
    const c = cp[cn], d = dp[dn];
    cp[cn] = function () {
      const o = c.apply(this, arguments);
      if (o) { T.objs.set(o, { kind: k, gl: this }); T.created[k] = (T.created[k] || 0) + 1; }
      return o;
    };
    dp[dn] = function (o) {
      if (o && T.objs.delete(o)) T.deleted[k] = (T.deleted[k] || 0) + 1;
      return d.apply(this, arguments);
    };
  }
  const orphan = (gl) => {
    for (const [o, m] of Array.from(T.objs)) {
      if (m.gl === gl) { T.orphaned[m.kind] = (T.orphaned[m.kind] || 0) + 1; T.objs.delete(o); }
    }
  };
  const forget = (gl) => {
    if (T.ctxLive.delete(gl)) { T.ctxLost++; orphan(gl); }
  };
  const ge = owner('getExtension').getExtension;
  owner('getExtension').getExtension = function (name) {
    const e = ge.call(this, name);
    if (e && name === 'WEBGL_lose_context' && !e.__wrapped) {
      const lc = e.loseContext.bind(e), gl = this;
      e.loseContext = function () { forget(gl); return lc(); };
      e.__wrapped = true;
    }
    return e;
  };
  const wrapGetContext = (proto) => {
    if (!proto) return;
    const gc = proto.getContext;
    proto.getContext = function (kind) {
      const gl = gc.apply(this, arguments);
      if (gl && kind === 'webgl2' && !T.ctxLive.has(gl)) {
        T.ctxLive.add(gl); T.ctxCreated++; T.ctxMax = Math.max(T.ctxMax, T.ctxLive.size);
        try {
          this.addEventListener('webglcontextlost', () => { if (T.ctxLive.has(gl)) { T.ctxEvicted++; forget(gl); } });
        } catch (e) { /* offscreen */ }
      }
      return gl;
    };
  };
  wrapGetContext(HTMLCanvasElement.prototype);
  if (typeof OffscreenCanvas !== 'undefined') wrapGetContext(OffscreenCanvas.prototype);
  T.live = (gl) => {
    const out = {};
    for (const m of T.objs.values()) if (!gl || m.gl === gl) out[m.kind] = (out[m.kind] || 0) + 1;
    return out;
  };
  T.snapshot = () => ({
    live: T.live(), ctxLive: T.ctxLive.size, ctxCreated: T.ctxCreated, ctxLost: T.ctxLost,
    ctxEvicted: T.ctxEvicted, ctxMax: T.ctxMax, orphaned: Object.assign({}, T.orphaned),
  });
}

// Installed only for a cold init (--cold): makes every fragment shader's text
// unique, so no on-disk or in-process program cache can answer for it. The
// original main() is kept as sbMain() and called from a new one that adds
// (uniform, never set: 0) x a unique literal to the output's alpha: the text
// differs, the picture does not, and no translator can fold the term away.
function bustCache() {
  const n = window.__sbBust;
  if (!n) return;
  const proto = WebGL2RenderingContext.prototype;
  const ss = proto.shaderSource;
  proto.shaderSource = function (sh, src) {
    if (/void\s+main\s*\(\s*\)/.test(src) && !/gl_Position/.test(src)) {
      const m = /\bout\s+(?:highp\s+|mediump\s+|lowp\s+)?vec4\s+(\w+)\s*;/.exec(src);
      if (m) {
        src = src.replace(/void\s+main\s*\(\s*\)/, 'void sbMain()') +
          '\nuniform float uSbBust;\nvoid main() { sbMain(); ' + m[1] + '.a += uSbBust * ' + n + '; }\n';
      }
    }
    return ss.call(this, sh, src);
  };
}

// Defines window.__sb. Self-contained: it is serialised into the page.
function harness() {
  const sb = window.__sb = {};
  const GLT = window.__glt;
  const ATTRS = { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false };
  const VERT = '#version 300 es\nin vec2 aPos;\nout vec2 vUv;\nvoid main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }\n';
  const PX1 = new Uint8Array(4);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // One context set up as the camera pipeline sets its own: the state it
  // assumes (blend and depth off, unpack alignment 1), one full-screen
  // triangle in a VAO.
  function mkGL() {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const gl = canvas.getContext('webgl2', ATTRS);
    if (!gl) throw new Error('no WebGL2');
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return { gl, canvas, buf, vao };
  }
  function freeGL(ctx) {
    const gl = ctx.gl;
    try { gl.deleteVertexArray(ctx.vao); gl.deleteBuffer(ctx.buf); } catch (e) { /* gone */ }
    try { if (VS && VS.releaseContext) VS.releaseContext(gl); } catch (e) { /* v2 engine's per-context state */ }
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
  }
  function program(gl, fs) {
    const sh = (type, src) => {
      const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o);
      if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o));
      return o;
    };
    const vs = sh(gl.VERTEX_SHADER, VERT), f = sh(gl.FRAGMENT_SHADER, fs);
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, f);
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    gl.deleteShader(vs); gl.deleteShader(f);
    return p;
  }
  // A colour target, optionally mipmapped like the pipeline's scene buffer.
  function target(gl, w, h, mips) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (mips) gl.generateMipmap(gl.TEXTURE_2D);
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return { t, f, w, h };
  }
  function freeTarget(gl, x) { gl.deleteFramebuffer(x.f); gl.deleteTexture(x.t); }
  // Wait for everything queued on this context: a 1-px read of the framebuffer.
  function fence(gl, fb) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, PX1);
  }

  const VS = window.VideoScenes;
  const halton = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
  const JITTER = (VS && VS.JITTER) || Array.from({ length: 256 }, (_, i) => [halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5]);
  const baseLook = () => Object.assign({
    exposure: 1, tint: [1, 1, 1], dirX: 0.35, dirY: 0.5, hard: 0.45, cx: 0.5, cy: 0.55, sx: 0.2, sy: 0.4,
    motion: 0, side: 1, sideMix: 1, measured: false,
  }, VS && VS.defaultLook ? VS.defaultLook() : {});
  const catalogue = (id) => (VS && VS.byId && VS.byId(id)) || {};

  // =========================================================================
  // ADAPTER — the only code that knows how a scene is drawn.
  //
  //   kind                 'legacy' | 'renderer'
  //   acquire(ctx, id, mode)   -> handle (maybe a promise). mode 'sync' | 'async' is
  //                           honoured where the engine has both.
  //   drawRedraw(h, ctx, tgt, t, look, frame, view)
  //                        draws ONE redraw of the scene into `tgt` ({f, t, w, h}:
  //                        framebuffer, texture, size) and leaves its mip chain
  //                        built, as video-effects.js drawScene() does.
  //   resolveProgram(gl)   the program that adds a redraw into the camera-size
  //                        picture, or null when the engine has none.
  //   release(ctx, h)      gives back everything acquire() made.
  // =========================================================================
  const forced = window.__sbEngine;
  const ADAPTER = {
    kind: forced && forced !== 'auto' ? forced : (VS && typeof VS.createRenderer === 'function' ? 'renderer' : 'legacy'),
    modes: null,
    async acquire(ctx, id, mode) {
      if (this.kind === 'renderer') {
        const r = await VS.createRenderer(ctx.gl, id);
        if (r && r.ready && typeof r.ready.then === 'function') await r.ready;
        return { renderer: r };
      }
      if (mode === 'sync') return { prog: VS.compileProgram(ctx.gl, id) };
      return { prog: await VS.compileProgramAsync(ctx.gl, id) };
    },
    drawRedraw(h, ctx, tgt, t, look, frame, view) {
      const gl = ctx.gl;
      if (this.kind === 'renderer') {
        gl.bindVertexArray(ctx.vao);
        h.renderer.draw(tgt.f, tgt.w, tgt.h, t, look, frame, view);
        gl.bindVertexArray(null);
        gl.bindTexture(gl.TEXTURE_2D, tgt.t);          // the pipeline builds the mip chain, not the scene
        gl.generateMipmap(gl.TEXTURE_2D);
        return;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, tgt.f);
      gl.viewport(0, 0, tgt.w, tgt.h);
      VS.setUniforms(gl, h.prog, tgt.w, tgt.h, t, look, frame, view);
      gl.bindVertexArray(ctx.vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
      gl.bindTexture(gl.TEXTURE_2D, tgt.t);
      gl.generateMipmap(gl.TEXTURE_2D);
    },
    resolveProgram(gl) {
      const src = VS && (VS.RESOLVE_FRAG || (VS.resolveSource && VS.resolveSource()));
      return src ? program(gl, src) : null;
    },
    release(ctx, h) {
      if (this.kind === 'renderer') { if (h.renderer && h.renderer.dispose) h.renderer.dispose(); return; }
      ctx.gl.deleteProgram(h.prog.program);
    },
  };
  // ======================== end of the adapter ============================

  // One resolve pass, as video-effects.js resolveScene() does it.
  function resolvePass(ctx, resP, small, pic, from, at, age, bloom, W, H) {
    const gl = ctx.gl;
    gl.useProgram(resP);
    const bind = (name, unit, tex) => {
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(gl.getUniformLocation(resP, name), unit);
    };
    bind('uCur', 0, small.t);
    bind('uHist', 1, pic[from].t);
    gl.uniform2f(gl.getUniformLocation(resP, 'uCurRes'), small.w, small.h);
    gl.uniform2f(gl.getUniformLocation(resP, 'uOutRes'), W, H);
    gl.uniform2f(gl.getUniformLocation(resP, 'uJitter'), at[0], at[1]);
    gl.uniform1f(gl.getUniformLocation(resP, 'uAge'), Math.min(age, 255));
    gl.uniform1f(gl.getUniformLocation(resP, 'uBloom'), bloom);
    gl.bindFramebuffer(gl.FRAMEBUFFER, pic[1 - from].f);
    gl.viewport(0, 0, W, H);
    gl.bindVertexArray(ctx.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }

  const stats = (a) => {
    if (!a.length) return null;
    const s = a.slice().sort((x, y) => x - y), q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { n: s.length, p50: q(0.5), p95: q(0.95), min: s[0], max: s[s.length - 1], mean: s.reduce((x, y) => x + y, 0) / s.length };
  };

  sb.env = () => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2', ATTRS);
    if (!gl) return { error: 'no WebGL2' };
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const out = {
      renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      vendor: info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      version: gl.getParameter(gl.VERSION),
      parallelCompile: !!gl.getExtension('KHR_parallel_shader_compile'),
      timerQuery: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'),
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      software: VS && VS.isSoftwareGL ? VS.isSoftwareGL(gl) : null,
      engine: ADAPTER.kind,
      sceneIds: VS && VS.SCENES ? VS.SCENES.map((s) => s.id) : [],
      userAgent: navigator.userAgent,
    };
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return out;
  };

  // --- init: a cold compile, in a fresh browser ----------------------------
  sb.init = async ({ id, mode, bw, bh }) => {
    let last = performance.now(), maxGap = 0;
    const wd = setInterval(() => { const n = performance.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 2);
    const look = baseLook();
    const out = { id, mode, engine: ADAPTER.kind };
    try {
      const ctx = mkGL(), gl = ctx.gl;
      const small = target(gl, bw, bh, true);
      // Set the context up before the clock starts: a trivial program, drawn.
      const warm = program(gl, '#version 300 es\nprecision highp float;\nin vec2 vUv;\nout vec4 o;\nvoid main() { o = vec4(vUv, 0.0, 1.0); }\n');
      gl.useProgram(warm); gl.bindFramebuffer(gl.FRAMEBUFFER, small.f); gl.viewport(0, 0, bw, bh);
      gl.bindVertexArray(ctx.vao); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);
      fence(gl, small.f);
      await sleep(60);
      last = performance.now(); maxGap = 0;
      const ctxBefore = GLT.ctxCreated;
      const t0 = performance.now();
      const p = ADAPTER.acquire(ctx, id, mode);
      out.startMs = performance.now() - t0;             // main-thread cost of asking
      const h = await p;
      out.compileMs = performance.now() - t0;           // until a usable scene is in hand
      out.extraContexts = GLT.ctxCreated - ctxBefore;
      const d1 = performance.now();
      ADAPTER.drawRedraw(h, ctx, small, 37, look, null, null); fence(gl, small.f);
      out.draw1Ms = performance.now() - d1;
      const d2 = performance.now();
      ADAPTER.drawRedraw(h, ctx, small, 37.1, look, null, null); fence(gl, small.f);
      out.draw2Ms = performance.now() - d2;
      out.totalMs = out.compileMs + out.draw1Ms;
      await sleep(10);
      out.blockMs = maxGap;
      // A second context in the same browser: what the driver's cache makes of it.
      ADAPTER.release(ctx, h);
      const ctx2 = mkGL(), gl2 = ctx2.gl;
      const small2 = target(gl2, bw, bh, true);
      const w0 = performance.now();
      const h2 = await ADAPTER.acquire(ctx2, id, mode);
      out.warmCompileMs = performance.now() - w0;
      const w1 = performance.now();
      ADAPTER.drawRedraw(h2, ctx2, small2, 37, look, null, null); fence(gl2, small2.f);
      out.warmDrawMs = performance.now() - w1;
      ADAPTER.release(ctx2, h2);
      freeTarget(gl2, small2); freeGL(ctx2);
      gl.deleteProgram(warm); freeTarget(gl, small); freeGL(ctx);
    } catch (e) {
      out.error = String((e && e.message) || e).slice(0, 600);
    } finally {
      clearInterval(wd);
    }
    return out;
  };

  // --- steady: redraw time per case and mode --------------------------------
  sb.steady = async ({ id, cases, samples, warmup, budgetMs, gpuTimer }) => {
    const ctx = mkGL(), gl = ctx.gl;
    const out = [];
    let h, resP;
    try {
      h = await ADAPTER.acquire(ctx, id, 'async');
      resP = ADAPTER.resolveProgram(gl);
      const info = catalogue(id), hz = (info.hz && info.hz[0]) || 12, bloom = info.bloom || 0;
      const look = baseLook();
      const ext = gpuTimer ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
      for (const c of cases) {
        const k = Math.min(1, c.long * (info.res || 1) / Math.max(c.W, c.H));
        const bw = Math.max(2, Math.round(c.W * k)), bh = Math.max(2, Math.round(c.H * k));
        const small = target(gl, bw, bh, true);
        const pic = [target(gl, c.W, c.H, false), target(gl, c.W, c.H, false)];
        const cell = { id, case: c.name, cam: [c.W, c.H], buffer: [bw, bh], long: c.long, hz, engine: ADAPTER.kind };
        const run = async (mode, lk) => {
          const L = lk ? Object.assign({}, look, lk) : look;
          let age = 0, from = 0, i = 0;
          const times = [], qs = [];
          const redraw = () => {
            const t = 37 + i / hz, at = JITTER[i % JITTER.length];
            if (mode === 'scene') {
              ADAPTER.drawRedraw(h, ctx, small, t, L, null, null);
            } else if (mode === 'resolve') {
              resolvePass(ctx, resP, small, pic, from, at, age, bloom, c.W, c.H);
              from = 1 - from;
            } else {                                   // scene + resolve (and the batch)
              ADAPTER.drawRedraw(h, ctx, small, t, L, { jitter: at, detail: c.H }, null);
              resolvePass(ctx, resP, small, pic, from, at, age, bloom, c.W, c.H);
              from = 1 - from;
            }
            age++; i++;
          };
          const last = () => (mode === 'scene' ? small.f : pic[from].f);
          const one = (timed) => {
            let q = null;
            if (timed && ext && mode === 'sceneResolve') { q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); }
            const t0 = performance.now();
            redraw();
            fence(gl, last());
            const dt = performance.now() - t0;
            if (q) { gl.endQuery(ext.TIME_ELAPSED_EXT); qs.push(q); }
            return dt;
          };
          if (mode === 'resolve') {                    // give the resolve a redraw to read
            ADAPTER.drawRedraw(h, ctx, small, 37, look, { jitter: JITTER[0], detail: c.H }, null);
          }
          for (let w = 0; w < warmup; w++) one(false);
          const start = performance.now();
          while (times.length < samples && (times.length < 6 || performance.now() - start < budgetMs)) times.push(one(true));
          // A query's result is only there once the task has ended.
          const gpu = [];
          if (qs.length) {
            await sleep(30);
            const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
            for (const q of qs) {
              if (!disjoint && gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
              gl.deleteQuery(q);
            }
          }
          const res = { ms: stats(times), gpuMs: stats(gpu) };
          // Pipelined: K redraws, one fence. On a GPU this drops the round trip
          // of the fence and the 0.1 ms clock; on software GL (K = 1) it is skipped.
          const K = Math.min(8, Math.floor(25 / Math.max(0.05, res.ms.p50)));
          if (mode === 'sceneResolve' && K >= 2) {
            const reps = [], bs = performance.now();
            while (reps.length < Math.max(6, Math.ceil(samples / 2)) && (reps.length < 6 || performance.now() - bs < budgetMs)) {
              const t0 = performance.now();
              for (let j = 0; j < K; j++) redraw();
              fence(gl, last());
              reps.push((performance.now() - t0) / K);
            }
            res.batch = Object.assign(stats(reps), { k: K });
          }
          return res;
        };
        try {
          cell.scene = (await run('scene')).ms;
          cell.sceneMix = (await run('scene', { sideMix: 0.5, side: 1 })).ms;   // mid-crossfade: both layouts are drawn
          cell.sceneNight = (await run('scene', { exposure: 0.22 })).ms;       // a dark room: the lights come on
          if (resP) {
            const r = await run('sceneResolve');
            cell.sceneResolve = r.ms; cell.gpuSceneResolve = r.gpuMs; cell.sceneResolveBatch = r.batch || null;
            cell.resolve = (await run('resolve')).ms;
          }
          cell.glError = gl.getError();
        } catch (e) { cell.error = String((e && e.message) || e).slice(0, 400); }
        freeTarget(gl, small); freeTarget(gl, pic[0]); freeTarget(gl, pic[1]);
        out.push(cell);
        await sleep(0);
      }
    } catch (e) {
      out.push({ id, error: String((e && e.message) || e).slice(0, 600) });
    } finally {
      try { if (h) ADAPTER.release(ctx, h); if (resP) gl.deleteProgram(resP); } catch (e) { /* ignore */ }
      freeGL(ctx);
    }
    return out;
  };

  // --- leaks ------------------------------------------------------------------
  // One cycle on a context of its own: make it, acquire, draw a few redraws
  // through the resolve, give back everything, and lose the context as the
  // pipeline's destroy() does. `residual` is what the library left alive after
  // its own release() and before the context went (the harness freed all of its
  // own objects first).
  sb.cycleContext = async ({ id }) => {
    const ctx = mkGL(), gl = ctx.gl;
    const info = catalogue(id);
    const W = 320, H = 180, k = Math.min(1, 192 * (info.res || 1) / W);
    const bw = Math.max(2, Math.round(W * k)), bh = Math.max(2, Math.round(H * k));
    const base = GLT.live(gl);
    const ctxBefore = GLT.ctxCreated;
    const h = await ADAPTER.acquire(ctx, id, 'async');
    const extraContexts = GLT.ctxCreated - ctxBefore;
    const resP = ADAPTER.resolveProgram(gl);
    const small = target(gl, bw, bh, true), pic = [target(gl, W, H, false), target(gl, W, H, false)];
    const look = baseLook();
    let from = 0;
    for (let i = 0; i < 3; i++) {
      const at = JITTER[i];
      ADAPTER.drawRedraw(h, ctx, small, 37 + i * 0.1, look, { jitter: at, detail: H }, null);
      if (resP) { resolvePass(ctx, resP, small, pic, from, at, i, info.bloom || 0, W, H); from = 1 - from; }
    }
    fence(gl, pic[from].f);
    const glError = gl.getError();
    ADAPTER.release(ctx, h);
    if (resP) gl.deleteProgram(resP);
    freeTarget(gl, small); freeTarget(gl, pic[0]); freeTarget(gl, pic[1]);
    // The harness's own plumbing (the triangle's buffer and VAO) is in `base`.
    const after = GLT.live(gl);
    const residual = {};
    for (const kk of Object.keys(after)) { const d = after[kk] - (base[kk] || 0); if (d) residual[kk] = d; }
    // The v2 engine keeps per-context state (shared three.js renderer, noise
    // textures) that releaseContext(gl) gives back; measure what is left after it.
    let residual2 = null;
    if (VS && VS.releaseContext) {
      VS.releaseContext(gl);
      const end = GLT.live(gl);
      residual2 = {};
      for (const kk of Object.keys(end)) { const d = end[kk] - (base[kk] || 0); if (d) residual2[kk] = d; }
    }
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return { id, residual, residual2, extraContexts, glError, ctxLive: GLT.ctxLive.size };
  };

  let same = null;
  sb.sameOpen = () => { same = { ctx: mkGL(), resP: null }; same.resP = ADAPTER.resolveProgram(same.ctx.gl); return { live: GLT.live(same.ctx.gl) }; };
  // One acquire / draw / release on the shared context, the way a scene switch
  // does it; the buffers are made and freed with it.
  sb.sameCycle = async ({ id }) => {
    const { ctx, resP } = same, gl = ctx.gl;
    const info = catalogue(id);
    const W = 320, H = 180, k = Math.min(1, 192 * (info.res || 1) / W);
    const bw = Math.max(2, Math.round(W * k)), bh = Math.max(2, Math.round(H * k));
    const h = await ADAPTER.acquire(ctx, id, 'async');
    const small = target(gl, bw, bh, true), pic = [target(gl, W, H, false), target(gl, W, H, false)];
    const look = baseLook();
    let from = 0;
    for (let i = 0; i < 3; i++) {
      const at = JITTER[i];
      ADAPTER.drawRedraw(h, ctx, small, 37 + i * 0.1, look, { jitter: at, detail: H }, null);
      if (resP) { resolvePass(ctx, resP, small, pic, from, at, i, info.bloom || 0, W, H); from = 1 - from; }
    }
    fence(gl, pic[from].f);
    ADAPTER.release(ctx, h);
    freeTarget(gl, small); freeTarget(gl, pic[0]); freeTarget(gl, pic[1]);
    return { live: GLT.live(gl), glError: gl.getError() };
  };
  sb.sameClose = () => {
    const { ctx, resP } = same;
    if (resP) ctx.gl.deleteProgram(resP);
    const live = GLT.live(ctx.gl);
    freeGL(ctx); same = null;
    return { live };
  };
  sb.snapshot = () => GLT.snapshot();
}

// ---------------------------------------------------------------------------
// the Node side
// ---------------------------------------------------------------------------

const t00 = Date.now();
const log = (...a) => console.error(`[${((Date.now() - t00) / 1000).toFixed(0).padStart(4)}s]`, ...a);
const GPU_ARGS = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'];
const SOFT_ARGS = ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

async function open(o = {}) {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: opt.gpu ? GPU_ARGS : SOFT_ARGS,
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('[page]', e.message));
  // Scene modules (src/scenes/*.js) and Three are import()ed from this origin.
  await page.route('https://scene-bench.test/**', (r) => {
    const u = new URL(r.request().url());
    const SRC = path.join(ROOT, 'src');
    const f = path.join(SRC, decodeURIComponent(u.pathname));
    if (u.pathname !== '/' && f.startsWith(SRC + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile()) {
      return r.fulfill({ path: f, contentType: f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
    }
    return r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>scene bench</title>' });
  });
  await page.addInitScript(`window.__sbEngine = ${JSON.stringify(opt.engine)};`);
  await page.addInitScript('(' + glTracker.toString() + ')()');
  if (o.bust) {
    await page.addInitScript(`window.__sbBust = ${JSON.stringify((0.1 + Math.random() * 0.9).toExponential(9))};`);
    await page.addInitScript('(' + bustCache.toString() + ')()');
  }
  await page.goto('https://scene-bench.test/');
  for (const f of opt.scenes) await page.addScriptTag({ path: f });
  await page.addScriptTag({ content: '(' + harness.toString() + ')()' });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  return { browser, ctx, page, cdp };
}

async function metrics(s) {
  await s.cdp.send('HeapProfiler.collectGarbage');
  await s.cdp.send('HeapProfiler.collectGarbage');
  const m = await s.cdp.send('Performance.getMetrics');
  const o = {};
  for (const x of m.metrics) o[x.name] = x.value;
  return { heapKB: o.JSHeapUsedSize / 1024, nodes: o.Nodes, listeners: o.JSEventListeners, documents: o.Documents };
}

const withTimeout = (p, ms, what) => {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
};
const loads = () => os.loadavg().map((v) => +v.toFixed(2));
const r1 = (v) => (v == null ? '-' : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));

function git(...a) { try { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch (e) { return null; } }

const report = {
  meta: {
    label, date: new Date().toISOString(), host: os.hostname(), cpus: os.cpus().length, cpuModel: os.cpus()[0].model,
    node: process.version, loadavgStart: loads(), gpuFlag: opt.gpu, chromiumArgs: opt.gpu ? GPU_ARGS : SOFT_ARGS,
    git: { head: git('rev-parse', '--short', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'), dirtySrc: (git('status', '--short', 'src') || '').split('\n').filter(Boolean) },
    scenes: opt.scenes.map((f) => ({ file: path.relative(ROOT, f), sha1: crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 10) })),
    options: { samples: opt.samples, warmup: opt.warmup, budgetMs: opt.budgetMs, cycles: opt.cycles, cases: opt.cases, ids: list, only: opt.only },
  },
  env: null, init: [], steady: [], leaks: null, bits: null,
};

if (opt.render) {
  console.log(renderMarkdown(JSON.parse(fs.readFileSync(opt.render, 'utf8'))));
  process.exit(0);
}

let s = await open();
report.env = await s.page.evaluate(() => window.__sb.env());
report.meta.chromium = s.browser.version();
log(`${label}: ${report.env.renderer} | engine ${report.env.engine} | parallel compile ${report.env.parallelCompile} | timer query ${report.env.timerQuery}`);
if (report.env.error) { console.error(report.env.error); await s.browser.close(); process.exit(2); }
const catalogueIds = report.env.sceneIds;
for (const id of list) if (catalogueIds.length && !catalogueIds.includes(id)) throw new Error(`scene ${id} is not in this library (${catalogueIds.join(', ')})`);
const resOf = await s.page.evaluate((ids) => Object.fromEntries(ids.map((id) => [id, (window.VideoScenes.byId(id) || {}).res || 1])), list);
await s.browser.close();

// --- init ---------------------------------------------------------------------
if (opt.only.includes('init')) {
  // Each measure in a browser of its own: the driver keeps what it compiled.
  const modes = report.env.engine === 'renderer' ? ['async'] : ['sync', 'async'];
  for (const cold of opt.cold ? [false, true] : [false]) {
    for (const id of list) {
      for (const mode of modes) {
        const c = CASES['720p-d512'];
        const k = Math.min(1, 512 * resOf[id] / Math.max(c.W, c.H));
        const bw = Math.max(2, Math.round(c.W * k)), bh = Math.max(2, Math.round(c.H * k));
        const cs = await open({ bust: cold });
        try {
          const r = await withTimeout(cs.page.evaluate((a) => window.__sb.init(a), { id, mode, bw, bh }), 180_000, `init ${id}/${mode}`);
          r.buffer = [bw, bh]; r.cold = cold;
          report.init.push(r);
          log(`init${cold ? '*' : ' '}${id.padEnd(11)} ${mode.padEnd(5)} ${r.error ? 'ERROR ' + r.error : `compile ${r1(r.compileMs)} ms, draw1 ${r1(r.draw1Ms)}, draw2 ${r1(r.draw2Ms)}, block ${r1(r.blockMs)}, warm ${r1(r.warmCompileMs)}`}`);
        } catch (e) {
          report.init.push({ id, mode, cold, error: String(e.message) });
          log(`init ${id} ${mode} FAILED ${e.message}`);
        }
        await cs.browser.close().catch(() => {});
      }
    }
  }
}

// --- steady -------------------------------------------------------------------
if (opt.only.includes('steady')) {
  const cases = opt.cases.map((n) => Object.assign({ name: n }, CASES[n]));
  s = await open();
  for (const id of list) {
    try {
      const cells = await withTimeout(s.page.evaluate((a) => window.__sb.steady(a), {
        id, cases, samples: opt.samples, warmup: opt.warmup, budgetMs: opt.budgetMs, gpuTimer: opt.gpuTimer,
      }), 900_000, `steady ${id}`);
      for (const c of cells) {
        report.steady.push(c);
        if (c.error) log(`steady ${id} ${c.case || ''} ERROR ${c.error}`);
        else log(`steady ${id.padEnd(11)} ${c.case.padEnd(13)} ${c.buffer.join('x').padEnd(9)} scene p50 ${r1(c.scene && c.scene.p50)} p95 ${r1(c.scene && c.scene.p95)} | +resolve p50 ${r1(c.sceneResolve && c.sceneResolve.p50)} p95 ${r1(c.sceneResolve && c.sceneResolve.p95)} | resolve p50 ${r1(c.resolve && c.resolve.p50)}`);
      }
    } catch (e) {
      report.steady.push({ id, error: String(e.message) });
      log(`steady ${id} FAILED ${e.message}`);
      await s.browser.close().catch(() => {});
      s = await open();
    }
  }
  await s.browser.close().catch(() => {});
}

// --- leaks --------------------------------------------------------------------
if (opt.only.includes('leaks')) {
  s = await open();
  const L = { cycles: opt.cycles, same: null, contexts: null };
  try {
    // (a) one context, scene after scene.
    await s.page.evaluate(() => window.__sb.sameOpen());
    const rounds = Math.max(2, Math.ceil(opt.cycles / list.length));
    const live = [];
    let n = 0;
    for (let r = 0; r < rounds + 1; r++) {            // round 0 is the baseline
      for (const id of list) {
        const x = await withTimeout(s.page.evaluate((a) => window.__sb.sameCycle(a), { id }), 300_000, `same-context cycle ${id}`);
        if (r === 0 && id === list[list.length - 1]) live.push({ at: 'baseline', live: x.live });
        n++;
        if (r === rounds && id === list[list.length - 1]) live.push({ at: 'end', live: x.live });
      }
    }
    const closed = await s.page.evaluate(() => window.__sb.sameClose());
    const a = live[0].live, b = live[1].live;
    const kinds = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]));
    L.same = { cycles: n, baseline: a, end: b, growth: Object.fromEntries(kinds.map((k) => [k, (b[k] || 0) - (a[k] || 0)]).filter(([, v]) => v)), afterClose: closed.live };
    log(`leaks same-context: ${n} cycles, growth ${JSON.stringify(L.same.growth)}`);

    // (b) a context per cycle, heap tracked.
    const residualMax = {};
    let residual2Max = null;   // set only when the library has releaseContext()
    let base = null, extra = 0, errs = 0;
    for (let i = 0; i < opt.cycles; i++) {
      const id = list[i % list.length];
      const x = await withTimeout(s.page.evaluate((a) => window.__sb.cycleContext(a), { id }), 300_000, `context cycle ${id}`);
      for (const [k, v] of Object.entries(x.residual)) residualMax[k] = Math.max(residualMax[k] || 0, v);
      if (x.residual2) { residual2Max = residual2Max || {}; for (const [k, v] of Object.entries(x.residual2)) residual2Max[k] = Math.max(residual2Max[k] || 0, v); }
      extra += x.extraContexts; errs += x.glError ? 1 : 0;
      if (i === Math.min(list.length, opt.cycles) - 1) base = await metrics(s);   // every scene once: warm
    }
    const end = await metrics(s);
    const snap = await s.page.evaluate(() => window.__sb.snapshot());
    L.contexts = {
      cycles: opt.cycles, baseline: base, end,
      heapGrowthKB: end.heapKB - base.heapKB, nodesGrowth: end.nodes - base.nodes, listenersGrowth: end.listeners - base.listeners,
      documentsGrowth: end.documents - base.documents,
      residualAfterRelease: residualMax, residualAfterReleaseContext: residual2Max, extraContexts: extra, glErrorCycles: errs,
      contextsCreated: snap.ctxCreated, contextsLost: snap.ctxLost, contextsEvicted: snap.ctxEvicted, maxLiveContexts: snap.ctxMax,
      liveObjectsAtEnd: snap.live, orphanedByContextLoss: snap.orphaned,
    };
    log(`leaks contexts: heap ${r1(L.contexts.heapGrowthKB)} KB, max live contexts ${snap.ctxMax}, evicted ${snap.ctxEvicted}, residual ${JSON.stringify(residualMax)}`);
  } catch (e) {
    L.error = String(e.message);
    log('leaks FAILED ' + e.message);
  }
  report.leaks = L;
  await s.browser.close().catch(() => {});
}

// --- bits ---------------------------------------------------------------------
if (opt.bits) {
  report.bits = {};
  for (const kind of ['person', 'still']) {
    const out = opt.bitsOut || path.join(opt.out, 'bits-' + kind + '-' + label);
    const a = ['scripts/scene-preview.mjs', '--bits', kind === 'still' ? '--still' : '--person', '--out', out];
    if (opt.scenes.length === 1 && opt.scenes[0] !== path.join(ROOT, 'src', 'video-scenes.js')) a.push('--scenes', opt.scenes[0]);
    if (opt.bitsGpu) a.push('--gpu');
    a.push(...list);
    log(`bits ${kind}: node ${a.join(' ')}`);
    const r = spawnSync('node', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
    const rows = {};
    for (const line of (r.stdout || '').split('\n')) {
      const m = /^(\w+)\s+buffer (\d+x\d+), first redraw (\d+) ms, timed redraw (\d+) ms, keyframe ([\d.]+) KB, motion (\d+) kb\/s \((\d+) frames at (\d+) Hz, q(\d+)\)/.exec(line);
      if (m) rows[m[1]] = { buffer: m[2], firstMs: +m[3], timedMs: +m[4], keyKB: +m[5], kbps: +m[6], frames: +m[7], hz: +m[8], q: +m[9] };
    }
    report.bits[kind] = { rows, status: r.status, stderr: (r.stderr || '').slice(-400) };
  }
}

report.meta.loadavgEnd = loads();
report.meta.wallSeconds = Math.round((Date.now() - t00) / 1000);

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

const md = renderMarkdown(report);
fs.mkdirSync(opt.out, { recursive: true });
const base = path.join(opt.out, 'D-scene-bench-' + label);
fs.writeFileSync(base + '.json', JSON.stringify(report, null, 2));
fs.writeFileSync(base + '.md', md);
console.log(md);
console.error(`wrote ${path.relative(ROOT, base)}.json and .md`);
process.exit(0);   // nothing is left to wait for

// ---------------------------------------------------------------------------

function renderMarkdown(R) {
  const L = [];
  const e = R.env, m = R.meta;
  L.push(`# Scene bench: ${m.label}`, '');
  L.push(`- ${m.date}; ${m.cpuModel} x${m.cpus}; load average ${m.loadavgStart.join('/')} at start, ${(m.loadavgEnd || []).join('/')} at end; ${m.wallSeconds} s`);
  L.push(`- GL: ${e.renderer} (${e.version}); software: ${e.software}; KHR_parallel_shader_compile: ${e.parallelCompile}; timer query: ${e.timerQuery}`);
  L.push(`- Chromium ${m.chromium}; args \`${m.chromiumArgs.join(' ')}\``);
  L.push(`- Engine adapter: **${e.engine}**; scene library ${m.scenes.map((x) => `\`${x.file}\`@${x.sha1}`).join(', ')}; git ${m.git.head} on ${m.git.branch}${m.git.dirtySrc.length ? ' (src dirty: ' + m.git.dirtySrc.join('; ') + ')' : ''}`);
  L.push(`- samples ${m.options.samples} (min 6, budget ${m.options.budgetMs} ms per cell), warmup ${m.options.warmup}, cycles ${m.options.cycles}`, '');

  if (R.init.length) {
    L.push('## Init (a fresh browser per row; ms)', '');
    L.push('| scene | path | cache | compile | draw 1 | draw 2 | compile+draw1 | page blocked | warm (2nd context) compile+draw | extra ctx |');
    L.push('|---|---|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const r of R.init) {
      if (r.error) { L.push(`| ${r.id} | ${r.mode} | ${r.cold ? 'busted' : 'as-is'} | ERROR: ${r.error.replace(/\|/g, '/').slice(0, 80)} | | | | | | |`); continue; }
      L.push(`| ${r.id} | ${r.mode} | ${r.cold ? 'busted' : 'as-is'} | ${r1(r.compileMs)} | ${r1(r.draw1Ms)} | ${r1(r.draw2Ms)} | ${r1(r.totalMs)} | ${r1(r.blockMs)} | ${r1(r.warmCompileMs + (r.warmDrawMs || 0))} | ${r.extraContexts} |`);
    }
    L.push('', '`cache` as-is = the shader text the library ships (a driver or OS cache may answer for it: macOS keeps compiled Metal pipelines on disk, so a GPU as-is row is cache-warm); busted (--cold) = unique text, a true first compile. `compile` = until a usable scene is in hand (sync: compileProgram returns; async: compileProgramAsync resolves). `page blocked` = longest gap of a 2 ms timer during compile and the first two draws.', '');
  }
  if (R.steady.length) {
    L.push('## Steady redraw (ms; p50 / p95, fenced)', '');
    L.push('| scene | case | camera | buffer | scene | + resolve | resolve only | pipelined (+resolve) | GPU timer (+resolve) | budget at hz0 |');
    L.push('|---|---|---|---|---:|---:|---:|---:|---:|---:|');
    for (const c of R.steady) {
      if (c.error) { L.push(`| ${c.id} | ${c.case || ''} | ERROR: ${c.error.replace(/\|/g, '/').slice(0, 80)} | | | | | | |`); continue; }
      const pp = (x) => (x ? `${r1(x.p50)} / ${r1(x.p95)}` : '-');
      const budget = c.sceneResolve ? `${(100 * c.sceneResolve.p50 / (1000 / c.hz)).toFixed(0)}% of ${(1000 / c.hz).toFixed(0)} ms` : '-';
      const bt = c.sceneResolveBatch ? `${r1(c.sceneResolveBatch.p50)} / ${r1(c.sceneResolveBatch.p95)} (x${c.sceneResolveBatch.k})` : '-';
      L.push(`| ${c.id} | ${c.case} | ${c.cam.join('x')} | ${c.buffer.join('x')} | ${pp(c.scene)} | ${pp(c.sceneResolve)} | ${pp(c.resolve)} | ${bt} | ${pp(c.gpuSceneResolve)} | ${budget} |`);
    }
    L.push('', '### Look variants (scene only, p50 / p95 ms)', '');
    L.push('| scene | case | day | mirror crossfade (sideMix 0.5) | night (exposure 0.22) |', '|---|---|---:|---:|---:|');
    for (const c of R.steady) {
      if (c.error) continue;
      const pp = (x) => (x ? `${r1(x.p50)} / ${r1(x.p95)}` : '-');
      L.push(`| ${c.id} | ${c.case} | ${pp(c.scene)} | ${pp(c.sceneMix)} | ${pp(c.sceneNight)} |`);
    }
    L.push('', '`pipelined` = K redraws+resolves queued behind one fence, ms per redraw (GPU throughput; skipped where a redraw is slow). `GPU timer` = EXT_disjoint_timer_query_webgl2, where it answers. `budget` = the scene+resolve p50 as a share of the redraw interval at the scene\'s top rate (hz[0]); on software GL it is CPU time shared with everything else.', '');
  }
  if (R.leaks) {
    const k = R.leaks;
    L.push('## Leaks', '');
    if (k.error) L.push('ERROR: ' + k.error, '');
    if (k.same) {
      L.push(`- One context, ${k.same.cycles} acquire/draw/release cycles over the scenes: live GL objects at baseline ${JSON.stringify(k.same.baseline)}, at end ${JSON.stringify(k.same.end)}; **growth ${JSON.stringify(k.same.growth)}**`);
    }
    if (k.contexts) {
      const c = k.contexts;
      L.push(`- ${c.cycles} context-per-cycle runs: JS heap ${r1(c.baseline.heapKB)} -> ${r1(c.end.heapKB)} KB (**${c.heapGrowthKB >= 0 ? '+' : ''}${r1(c.heapGrowthKB)} KB**), nodes ${c.nodesGrowth >= 0 ? '+' : ''}${c.nodesGrowth}, listeners ${c.listenersGrowth >= 0 ? '+' : ''}${c.listenersGrowth}, documents ${c.documentsGrowth >= 0 ? '+' : ''}${c.documentsGrowth}`);
      L.push(`- Contexts: created ${c.contextsCreated}, lost by us ${c.contextsLost}, evicted by the browser ${c.contextsEvicted}, **max live ${c.maxLiveContexts}**; created by the library behind our back during acquire(): **${c.extraContexts}**`);
      if (c.residualAfterReleaseContext) L.push(`- ...and after VideoScenes.releaseContext(gl): **${JSON.stringify(c.residualAfterReleaseContext)}**`);
      L.push(`- Left alive by the library after its own release() (per cycle, worst): **${JSON.stringify(c.residualAfterRelease)}**; GL errors in ${c.glErrorCycles} cycle(s); orphaned by context loss ${JSON.stringify(c.orphanedByContextLoss)}`);
    }
    L.push('');
  }
  if (R.bits) {
    L.push('## Bitrate (scripts/scene-preview.mjs --bits, VP9 fixed quantizer, 1280x720, SwiftShader)', '');
    L.push('| scene | buffer | --person: key KB | --person: kb/s | --still: key KB | --still: kb/s | hz |');
    L.push('|---|---|---:|---:|---:|---:|---:|');
    const rows = Object.keys((R.bits.person || {}).rows || {});
    for (const id of rows.length ? rows : Object.keys((R.bits.still || {}).rows || {})) {
      const p = (R.bits.person.rows || {})[id], st = (R.bits.still.rows || {})[id];
      L.push(`| ${id} | ${(p || st).buffer} | ${p ? p.keyKB.toFixed(1) : '-'} | ${p ? p.kbps : '-'} | ${st ? st.keyKB.toFixed(1) : '-'} | ${st ? st.kbps : '-'} | ${(p || st).hz} |`);
    }
    L.push('');
  }
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// compare two JSON reports: new / baseline, with the limits the validation
// plan uses. Exit status 1 when a limit is exceeded.
// ---------------------------------------------------------------------------

function compareRuns(aFile, bFile, o) {
  const A = JSON.parse(fs.readFileSync(aFile, 'utf8')), B = JSON.parse(fs.readFileSync(bFile, 'utf8'));
  let bad = 0;
  const rows = [];
  const ratio = (n, d) => (n != null && d != null && d > 0 ? n / d : null);
  const mark = (v, lim) => (v == null ? '-' : v.toFixed(2) + 'x' + (v > lim ? ' !' : ''));
  // init: total (compile + first draw), per path
  const ai = new Map(A.init.filter((r) => !r.error).map((r) => [r.id + '/' + r.mode + '/' + !!r.cold, r]));
  const initRows = [];
  for (const r of B.init) {
    const a = ai.get(r.id + '/' + r.mode + '/' + !!r.cold) || ai.get(r.id + '/async/' + !!r.cold);
    if (r.error) { initRows.push(`| ${r.id} | ${r.mode}${r.cold ? '*' : ''} | ERROR ${r.error.slice(0, 60)} | | |`); bad++; continue; }
    const q = a ? ratio(r.totalMs, a.totalMs) : null;
    if (q != null && q > o.limitInit) bad++;
    initRows.push(`| ${r.id} | ${r.mode}${r.cold ? '*' : ''} | ${a ? r1(a.totalMs) : '-'} | ${r1(r.totalMs)} | ${mark(q, o.limitInit)} |`);
  }
  rows.push('## Init (compile + first draw, ms; * = cache busted)', '', '| scene | path | baseline | new | new/baseline |', '|---|---|---:|---:|---:|', ...initRows, '');
  const as = new Map(A.steady.filter((r) => !r.error).map((r) => [r.id + '/' + r.case, r]));
  const sRows = [];
  for (const r of B.steady) {
    if (r.error) { sRows.push(`| ${r.id} | ${r.case || ''} | ERROR | | |`); bad++; continue; }
    const a = as.get(r.id + '/' + r.case);
    const q1 = a && a.sceneResolve && r.sceneResolve ? ratio(r.sceneResolve.p95, a.sceneResolve.p95) : null;
    const q2 = a && a.scene && r.scene ? ratio(r.scene.p95, a.scene.p95) : null;
    if ((q1 != null && q1 > o.limitP95)) bad++;
    sRows.push(`| ${r.id} | ${r.case} | ${a && a.sceneResolve ? r1(a.sceneResolve.p95) : '-'} | ${r.sceneResolve ? r1(r.sceneResolve.p95) : '-'} | ${mark(q1, o.limitP95)} | ${mark(q2, o.limitP95)} |`);
  }
  rows.push('## Steady redraw p95 (ms)', '', '| scene | case | baseline +resolve | new +resolve | new/baseline | scene only new/baseline |', '|---|---|---:|---:|---:|---:|', ...sRows, '');
  if (B.leaks) {
    const k = B.leaks;
    const grew = k.same && Object.keys(k.same.growth).length;
    const resid = k.contexts && Object.keys(k.contexts.residualAfterRelease).filter((x) => k.contexts.residualAfterRelease[x] > ((A.leaks && A.leaks.contexts && A.leaks.contexts.residualAfterRelease[x]) || 0));
    rows.push('## Leaks (new)', '',
      `- live GL object growth over the same-context cycles: ${k.same ? JSON.stringify(k.same.growth) : 'n/a'}${grew ? ' !' : ''}`,
      `- residual after release: ${k.contexts ? JSON.stringify(k.contexts.residualAfterRelease) : 'n/a'} (baseline ${A.leaks && A.leaks.contexts ? JSON.stringify(A.leaks.contexts.residualAfterRelease) : 'n/a'})${resid && resid.length ? ' !' : ''}`,
      `- JS heap growth ${k.contexts ? r1(k.contexts.heapGrowthKB) : 'n/a'} KB; max live contexts ${k.contexts ? k.contexts.maxLiveContexts : 'n/a'}; extra contexts from acquire ${k.contexts ? k.contexts.extraContexts : 'n/a'}`, '');
    if (grew || (resid && resid.length) || (k.contexts && (k.contexts.maxLiveContexts > 1 || k.contexts.extraContexts > 0))) bad++;
  }
  console.log([`# Compare ${path.basename(aFile)} (baseline) vs ${path.basename(bFile)} (new)`, '', `limits: p95 <= ${o.limitP95}x, init <= ${o.limitInit}x; \`!\` marks a breach`, '', ...rows].join('\n'));
  return bad ? 1 : 0;
}
