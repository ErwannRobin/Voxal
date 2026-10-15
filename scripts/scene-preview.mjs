#!/usr/bin/env node
// Render the animated background scenes (src/video-scenes.js) to PNG files, so
// they can be looked at — which, for a shader that draws a whole world, is the
// only way to tell whether a change made it better.
//
//   node scripts/scene-preview.mjs                     all five, as a 1280x720 camera shows them, to scene-previews/
//   node scripts/scene-preview.mjs mountain island     just those
//   node scripts/scene-preview.mjs --size 640x360 --long 384   as a phone shows them
//   node scripts/scene-preview.mjs --size 360x640 --long 384   an upright phone
//   node scripts/scene-preview.mjs --look '{"exposure":0.25}'              a dim room: evening
//   node scripts/scene-preview.mjs --look '{"dirX":-0.8,"sideMix":0}'      lit from the left
//   node scripts/scene-preview.mjs --time 80 --person  a later moment, with a stand-in subject
//   node scripts/scene-preview.mjs --alpha             the nearness channel instead (white = near)
//   node scripts/scene-preview.mjs --raw               one redraw, stretched (what shows if the resolve cannot compile)
//   node scripts/scene-preview.mjs --bits --person     and what each costs a video encoder
//   node scripts/scene-preview.mjs --bits --still      what a room that does not move at all costs: the resolve's own churn
//   node scripts/scene-preview.mjs --resolve '{"gain":0.4}'   other settings than RESOLVE's
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
// The browser is Playwright's. In a container whose Chromium is not the revision
// the installed Playwright expects, set CHROMIUM_PATH to the executable.

// The functions handed to page.evaluate() run in the page, not in Node.
/* global document, Image, VideoScenes, VideoEncoder, VideoFrame */

import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL = ['office', 'island', 'cybercafe', 'mountain', 'countryside'];

const args = process.argv.slice(2);
const opt = {
  w: 1280, h: 720, long: 512, frames: 24, t: 37, look: '{}', person: false, alpha: false, raw: false,
  bits: false, still: false, seconds: 4, q: 32, resolve: null, out: path.join(ROOT, 'scene-previews') };
const ids = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--size') { const m = /^(\d+)x(\d+)$/.exec(args[++i] || ''); if (!m) throw new Error('--size WxH'); opt.w = +m[1]; opt.h = +m[2]; }
  else if (a === '--long') opt.long = +args[++i];
  else if (a === '--frames') opt.frames = Math.max(1, +args[++i]);
  else if (a === '--time') opt.t = +args[++i];
  else if (a === '--look') opt.look = args[++i];
  else if (a === '--out') opt.out = path.resolve(args[++i]);
  else if (a === '--person') opt.person = true;
  else if (a === '--alpha') opt.alpha = true;
  else if (a === '--raw') opt.raw = true;
  else if (a === '--bits') opt.bits = true;
  else if (a === '--still') opt.still = true;
  else if (a === '--seconds') opt.seconds = +args[++i];
  else if (a === '--q') opt.q = +args[++i];
  else if (a === '--resolve') opt.resolve = JSON.parse(args[++i] || '{}');
  else if (a.startsWith('-')) throw new Error('unknown option ' + a);
  else ids.push(a);
}
const list = ids.length ? ids : ALL;
fs.mkdirSync(opt.out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page]', e.message));
// A secure origin, because VideoEncoder (--bits) exists only in one; nothing is
// fetched from it.
await page.route('https://scene-preview.test/**', (r) =>
  r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>scenes</title>' }));
await page.goto('https://scene-preview.test/');
await page.addScriptTag({ path: path.join(ROOT, 'src', 'video-scenes.js') });

const tiles = [];
for (const id of list) {
  const res = await page.evaluate(async ({ id, opt }) => {
    const W = opt.w, H = opt.h;
    // The scene's buffer, sized the way video-effects.js ensureScene() sizes it.
    const k = Math.min(1, opt.long * (VideoScenes.byId(id).res || 1) / Math.max(W, H));
    const bw = Math.max(2, Math.round(W * k)), bh = Math.max(2, Math.round(H * k));
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const gl = c.getContext('webgl2', { alpha: false, preserveDrawingBuffer: true });
    if (!gl) return { error: 'no WebGL2' };
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const mk = (fs) => {
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
    const target = (w, h) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      return { t, f, w, h };
    };
    let prog, pResolve, pShow;
    try {
      prog = VideoScenes.compileProgram(gl, id);
      pResolve = mk(opt.resolve ? VideoScenes.resolveSource(opt.resolve) : VideoScenes.RESOLVE_FRAG);
      // The picture onto the canvas: colour, or the nearness as grey.
      pShow = mk('#version 300 es\nprecision highp float;\nin vec2 vUv;\nout vec4 o;\nuniform sampler2D uT;\n' +
        'uniform float uAlpha;\nvoid main() { vec4 c = texture(uT, vUv); o = vec4(uAlpha > 0.5 ? vec3(c.a) : c.rgb, 1.0); }\n');
    } catch (e) { return { error: String(e.message).slice(0, 2000) }; }
    const small = target(bw, bh), pic = [target(W, H), target(W, H)];
    const look = Object.assign(VideoScenes.defaultLook(), JSON.parse(opt.look));
    const bind = (p, name, unit, t) => {
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(gl.getUniformLocation(p, name), unit);
    };
    // One redraw, as a call makes it: the scene through the next JITTER point
    // into its buffer, then resolved into the picture (or, with --raw, the
    // buffer alone, as it is).
    let from = 0, age = 0;
    const redraw = (t) => {
      const at = opt.raw ? null : VideoScenes.JITTER[age % VideoScenes.JITTER.length];
      gl.bindFramebuffer(gl.FRAMEBUFFER, small.f);
      gl.viewport(0, 0, bw, bh);
      VideoScenes.setUniforms(gl, prog, bw, bh, t, look, at ? { jitter: at, detail: H } : null);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (at) {
        gl.useProgram(pResolve);
        bind(pResolve, 'uCur', 0, small.t);
        bind(pResolve, 'uHist', 1, pic[from].t);
        gl.uniform2f(gl.getUniformLocation(pResolve, 'uCurRes'), bw, bh);
        gl.uniform2f(gl.getUniformLocation(pResolve, 'uOutRes'), W, H);
        gl.uniform2f(gl.getUniformLocation(pResolve, 'uJitter'), at[0], at[1]);
        gl.uniform1f(gl.getUniformLocation(pResolve, 'uAge'), Math.min(age, 255));
        gl.bindFramebuffer(gl.FRAMEBUFFER, pic[1 - from].f);
        gl.viewport(0, 0, W, H);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        from = 1 - from;
      }
      age++;
    };
    const px = new Uint8Array(W * H * 4);
    const show = () => {
      gl.useProgram(pShow);
      bind(pShow, 'uT', 0, opt.raw ? small.t : pic[from].t);
      gl.uniform1f(gl.getUniformLocation(pShow, 'uAlpha'), opt.alpha ? 1 : 0);
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
    const paint = () => {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const s = ((H - 1 - y) * W + x) * 4, d = (y * W + x) * 4;
          img.data[d] = px[s]; img.data[d + 1] = px[s + 1]; img.data[d + 2] = px[s + 2];
          img.data[d + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      if (opt.person) {
        ctx.fillStyle = '#2c3038';
        ctx.beginPath(); ctx.ellipse(W * 0.5, H * 1.08, W * 0.24, H * 0.28, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#96705c';
        ctx.fillRect(W * 0.46, H * 0.62, W * 0.08, H * 0.2);
        ctx.fillStyle = '#a87e68';
        ctx.beginPath(); ctx.ellipse(W * 0.5, H * 0.5, W * 0.085, H * 0.2, 0, 0, Math.PI * 2); ctx.fill();
      }
    };
    // A room holding still: --frames redraws of the same moment.
    const t0 = performance.now(); redraw(opt.t); show(); const first = performance.now() - t0;
    const t1 = performance.now(); redraw(opt.t); show(); const timed = performance.now() - t1;
    for (let i = 2; i < (opt.raw ? 1 : opt.frames); i++) redraw(opt.t);
    show();
    paint();
    const url = out.toDataURL('image/png');
    // --bits: what the picture costs the encoder. A few seconds at the scene's
    // own redraw rate through VP9 at a FIXED quantizer, so the bytes are the
    // content's difficulty and nothing else: the first frame is the detail (a
    // keyframe), the rest is the motion. The picture has been running for a
    // while first, as it has in a call. A call's encoder works to a bitrate
    // cap instead, so there the same difficulty shows up as a blurrier picture
    // of the person rather than as more bytes.
    let bits = null;
    if (opt.bits) {
      const hz = VideoScenes.byId(id).hz[0];
      const n = Math.max(2, Math.round(opt.seconds * hz));
      const when = (i) => opt.t + (opt.still ? 0 : i / hz);
      for (let i = 16; i > 0; i--) redraw(when(-i));
      const sizes = [];
      let failed = null;
      const enc = new VideoEncoder({
        output: (chunk) => sizes.push(chunk.byteLength),
        error: (e) => { failed = e.message; },
      });
      enc.configure({ codec: 'vp09.00.10.08', width: W, height: H, bitrateMode: 'quantizer', framerate: hz });
      for (let i = 0; i < n; i++) {
        redraw(when(i)); show(); paint();
        const frame = new VideoFrame(out, { timestamp: Math.round(i * 1e6 / hz) });
        enc.encode(frame, { keyFrame: i === 0, vp9: { quantizer: opt.q } });
        frame.close();
        await enc.flush();
      }
      enc.close();
      if (failed) return { error: 'encoder: ' + failed };
      const rest = sizes.slice(1).reduce((a, b) => a + b, 0);
      bits = { keyKB: sizes[0] / 1024, kbps: rest * 8 / 1000 / ((n - 1) / hz), frames: n, hz };
    }
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { url, first, timed, bits, buffer: bw + 'x' + bh };
  }, { id, opt });
  if (res.error) { console.error(`${id}: ${res.error}`); continue; }
  fs.writeFileSync(path.join(opt.out, `${id}.png`), Buffer.from(res.url.split(',')[1], 'base64'));
  tiles.push(res.url);
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
await browser.close();
