#!/usr/bin/env node
// Render the animated background scenes (src/video-scenes.js) to PNG files, so
// they can be looked at — which, for a shader that draws a whole world, is the
// only way to tell whether a change made it better.
//
//   node scripts/scene-preview.mjs                     all five, 512x288, to scene-previews/
//   node scripts/scene-preview.mjs mountain island     just those
//   node scripts/scene-preview.mjs --size 1024x576     bigger (the buffer in a call is ~400 wide)
//   node scripts/scene-preview.mjs --look '{"exposure":0.25}'              a dim room: evening
//   node scripts/scene-preview.mjs --look '{"dirX":-0.8,"sideMix":0}'      lit from the left
//   node scripts/scene-preview.mjs --size 216x384      an upright phone
//   node scripts/scene-preview.mjs --time 80 --person  a later moment, with a stand-in subject
//
// --person draws an oval head and shoulders over each picture: the middle of the
// frame is covered in a call, and a composition should be judged with it covered.
// Writes one PNG per scene plus sheet.png. Prints how long the first draw and a
// timed draw took (on a software GPU that is the scene's relative cost; on a real
// one, divide by a large number).
//
// The browser is Playwright's. In a container whose Chromium is not the revision
// the installed Playwright expects, set CHROMIUM_PATH to the executable.

// The functions handed to page.evaluate() run in the page, not in Node.
/* global document, Image, VideoScenes */

import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL = ['office', 'island', 'cybercafe', 'mountain', 'countryside'];

const args = process.argv.slice(2);
const opt = { w: 512, h: 288, t: 37, look: '{}', person: false, out: path.join(ROOT, 'scene-previews') };
const ids = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--size') { const m = /^(\d+)x(\d+)$/.exec(args[++i] || ''); if (!m) throw new Error('--size WxH'); opt.w = +m[1]; opt.h = +m[2]; }
  else if (a === '--time') opt.t = +args[++i];
  else if (a === '--look') opt.look = args[++i];
  else if (a === '--out') opt.out = path.resolve(args[++i]);
  else if (a === '--person') opt.person = true;
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
await page.goto('about:blank');
await page.addScriptTag({ path: path.join(ROOT, 'src', 'video-scenes.js') });

const tiles = [];
for (const id of list) {
  const res = await page.evaluate(({ id, opt }) => {
    const W = opt.w, H = opt.h;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const gl = c.getContext('webgl2', { alpha: false, preserveDrawingBuffer: true });
    if (!gl) return { error: 'no WebGL2' };
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    let prog;
    try { prog = VideoScenes.compileProgram(gl, id); } catch (e) { return { error: String(e.message).slice(0, 2000) }; }
    const look = Object.assign(VideoScenes.defaultLook(), JSON.parse(opt.look));
    gl.viewport(0, 0, W, H);
    const px = new Uint8Array(W * H * 4);
    const draw = () => {
      VideoScenes.setUniforms(gl, prog, W, H, opt.t, look);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    };
    const t0 = performance.now(); draw(); const first = performance.now() - t0;
    const t1 = performance.now(); draw(); const timed = performance.now() - t1;
    // GL is bottom-up; the picture is not.
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const ctx = out.getContext('2d');
    const img = ctx.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const s = ((H - 1 - y) * W + x) * 4, d = (y * W + x) * 4;
        img.data[d] = px[s]; img.data[d + 1] = px[s + 1]; img.data[d + 2] = px[s + 2]; img.data[d + 3] = 255;
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
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { url: out.toDataURL('image/png'), first, timed };
  }, { id, opt });
  if (res.error) { console.error(`${id}: ${res.error}`); continue; }
  fs.writeFileSync(path.join(opt.out, `${id}.png`), Buffer.from(res.url.split(',')[1], 'base64'));
  tiles.push(res.url);
  console.log(`${id.padEnd(12)} first draw ${res.first.toFixed(0)} ms, timed draw ${res.timed.toFixed(0)} ms`);
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
