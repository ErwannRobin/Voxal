#!/usr/bin/env node
// Test footage WITH ground truth for the matting evaluation
// (docs/matting-evaluation.md, scripts/matting-bench.mjs).
//
// A segmentation model can only be scored against a known alpha, and a webcam
// recording has none. So the footage is built: a person filmed in front of a
// green screen is keyed (alpha + foreground colour), then composited in LINEAR
// light — as a lens mixes light — over ordinary room photos. The engines see a
// person in a room; the scorer knows, to the pixel, how much of each pixel is
// the person. Every engine gets byte-identical frames.
//
//   node scripts/matting-footage.mjs              (make matting-footage)
//   node scripts/matting-footage.mjs --preview    one contact sheet, no frames
//
// Sources (downloaded once, sha256-pinned, never committed):
//   person  "All of this filming of Anna is just for a few seconds in an
//           upcoming video!" — Voice of America Learning English, public
//           domain (Wikimedia Commons). Curly hair over green, a waving hand,
//           and a jump onto a chair: hair, hands, fast motion.
//   rooms   CC0 photos from Wikimedia Commons (living room, kitchen) and a
//           synthetic plain wall (the easy case).
//
// Output: bench-results/matting/footage/
//   manifest.json
//   gt/alpha/NNNN.png   ground-truth alpha, 8-bit grey, 1280x720
//   gt/fg/NNNN.png      foreground colour (unpremultiplied, despilled, sRGB)
//   <room>/NNNN.jpg     the camera frame: person over that room (q=2 JPEG)
//
// The key is a plain difference keyer (e = g - max(r, b) against the screen's
// own measured colour) followed by keeping only the largest connected blob, so
// the studio's lamp stand and the burnt-in Instagram handle are not "person".
// Its alpha is only as good as a keyer's: wispy hair on a lit screen is
// plausible, not perfect, and that is the same for every engine scored on it.

import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'bench-results', 'matting', 'footage');
const SRC = join(ROOT, 'bench-results', 'matting', 'source');
const W = 1280, H = 720, FPS = 30;

const SOURCES = {
  person: {
    url: 'https://upload.wikimedia.org/wikipedia/commons/2/23/All_of_this_filming_of_Anna_is_just_for_a_few_seconds_in_an_upcoming_video%21.webm',
    file: 'anna.webm',
    licence: 'Public domain (Voice of America), Wikimedia Commons'
  },
  living: {
    url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/3/36/Living_room_in_apartment_of_Condom%C3%ADnio_do_Edif%C3%ADcio_Zaher%2C_Le_Blond%2C_Rio_de_Janeiro%2C_Brazil.jpg/1920px-Living_room_in_apartment_of_Condom%C3%ADnio_do_Edif%C3%ADcio_Zaher%2C_Le_Blond%2C_Rio_de_Janeiro%2C_Brazil.jpg',
    file: 'living.jpg',
    licence: 'CC0, Wikimedia Commons'
  },
  kitchen: {
    url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/2/26/Blue_white_kitchen_interior_%28Unsplash%29.jpg/1920px-Blue_white_kitchen_interior_%28Unsplash%29.jpg',
    file: 'kitchen.jpg',
    licence: 'CC0 (Unsplash), Wikimedia Commons'
  },
  // The output background for the composite comparison (not a camera room).
  target: {
    url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/6/6b/Living_room_of_a_typical_rural_house_in_northeast_Brazil.jpg/1920px-Living_room_of_a_typical_rural_house_in_northeast_Brazil.jpg',
    file: 'target.jpg',
    licence: 'CC0, Wikimedia Commons'
  }
};

// Two stretches of the clip: talking with binoculars and a wave (hair, hands),
// then sweeping arms (fast motion). Crop = the part of the portrait
// frame that is all green screen behind her, 16:9, in source pixels.
// Both from the stretch where the camera holds still, so one crop: the part of
// the portrait frame that is all green screen behind her, 16:9, in source
// pixels. `text` is where the clip's burnt-in Instagram handle sits during a
// segment (source pixels, null when it is outside the crop): a waving hand
// passes under it, so neither the key nor the engines can be right there, and
// the box (grown by 24 px) is excluded from every score (`ignore` in the
// manifest).
const CROP = { x: 70, y: 205, w: 560, h: 315 };
const SEGMENTS = [
  { from: 2.0, to: 8.0, text: { x0: 465, y0: 320, x1: 675, y1: 420 } },
  { from: 11.0, to: 15.0, text: null }
];

const ROOMS = ['wall', 'living', 'kitchen'];

const KEY_LO = 0.04;     // e at or below: fully person
const KEY_HI = 0.80;     // share of the screen's own e at or above: fully screen
const CC_THRESH = 0.1;   // alpha that counts as "connected" to the person

function sha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }

function download(name) {
  const s = SOURCES[name];
  const path = join(SRC, s.file);
  if (!existsSync(path)) {
    process.stdout.write('  ↓ ' + s.file + '\n');
    execFileSync('curl', ['-sfL', '--retry', '3', '-A', 'voxal-matting-bench/1.0', '-o', path, s.url]);
  }
  return { path, sha256: sha256(path) };
}

// --- colour ------------------------------------------------------------------

const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function enc(l) {
  l = l <= 0 ? 0 : l >= 1 ? 1 : l;
  const c = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  return Math.round(c * 255);
}

// --- ffmpeg pipes --------------------------------------------------------------

function readFrames(args, frameBytes, onFrame) {
  return new Promise((res, rej) => {
    const ff = spawn('ffmpeg', ['-loglevel', 'error', ...args, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    let buf = Buffer.alloc(0), n = 0;
    ff.stdout.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= frameBytes) {
        onFrame(buf.subarray(0, frameBytes), n++);
        buf = buf.subarray(frameBytes);
      }
    });
    ff.stderr.on('data', (d) => process.stderr.write(d));
    ff.on('close', (code) => code === 0 ? res(n) : rej(new Error('ffmpeg exited ' + code)));
  });
}

function writeImage(path, pixFmt, w, h, data, extra = []) {
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', pixFmt,
    '-s', w + 'x' + h, '-i', '-', ...extra, '-frames:v', '1', path], { input: data });
}

function loadStill(path, w, h) {
  // Cover-fit the photo to WxH, then decode it once.
  const out = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', path, '-vf',
    `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h}`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20 });
  return out;
}

// A plain painted wall: warm off-white, a soft light falloff and a little
// sensor-like grain, so it is not a perfectly flat field.
function wallPlate(w, h) {
  const out = Buffer.alloc(w * h * 3);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (x - w * 0.35) / w, dy = (y - h * 0.2) / h;
    const f = 1 - 0.35 * Math.min(1, Math.sqrt(dx * dx + dy * dy));
    const g = (rnd() - 0.5) * 6;
    const i = (y * w + x) * 3;
    out[i] = Math.max(0, Math.min(255, 214 * f + g));
    out[i + 1] = Math.max(0, Math.min(255, 204 * f + g));
    out[i + 2] = Math.max(0, Math.min(255, 186 * f + g));
  }
  return out;
}

// --- the key -------------------------------------------------------------------

function screenColour(px, n) {
  // Median of clearly-green pixels: the screen as it is lit in THIS frame.
  const rs = [], gs = [], bs = [];
  for (let i = 0; i < n; i += 7) {
    const r = px[i * 3] / 255, g = px[i * 3 + 1] / 255, b = px[i * 3 + 2] / 255;
    if (g - Math.max(r, b) > 0.25) { rs.push(r); gs.push(g); bs.push(b); }
  }
  const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
  return [med(rs), med(gs), med(bs)];
}

function keyFrame(px) {
  const n = W * H;
  const K = screenColour(px, n);
  const eK = K[1] - Math.max(K[0], K[2]);
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = px[i * 3] / 255, g = px[i * 3 + 1] / 255, b = px[i * 3 + 2] / 255;
    const e = g - Math.max(r, b);
    const a = 1 - (e - KEY_LO) / (eK * KEY_HI - KEY_LO);
    alpha[i] = a < 0 ? 0 : a > 1 ? 1 : a;
  }
  // Largest 4-connected blob above CC_THRESH is the person; anything else
  // (the lamp stand at the edge, the burnt-in handle) is not.
  const label = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  let best = -1, bestSize = 0, id = 0;
  for (let s = 0; s < n; s++) {
    if (label[s] !== -1 || alpha[s] <= CC_THRESH) continue;
    let sp = 0, size = 0;
    stack[sp++] = s; label[s] = id;
    while (sp) {
      const p = stack[--sp]; size++;
      const x = p % W, y = (p / W) | 0;
      if (x > 0 && label[p - 1] === -1 && alpha[p - 1] > CC_THRESH) { label[p - 1] = id; stack[sp++] = p - 1; }
      if (x < W - 1 && label[p + 1] === -1 && alpha[p + 1] > CC_THRESH) { label[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && label[p - W] === -1 && alpha[p - W] > CC_THRESH) { label[p - W] = id; stack[sp++] = p - W; }
      if (y < H - 1 && label[p + W] === -1 && alpha[p + W] > CC_THRESH) { label[p + W] = id; stack[sp++] = p + W; }
    }
    if (size > bestSize) { bestSize = size; best = id; }
    id++;
  }
  // Below the threshold a pixel keeps its alpha only next to the person (a
  // faint strand), judged by a 2-pixel neighbourhood in the label map.
  for (let i = 0; i < n; i++) {
    if (label[i] === best) continue;
    if (label[i] >= 0) { alpha[i] = 0; continue; }
    if (alpha[i] === 0) continue;
    const x = i % W, y = (i / W) | 0;
    let near = false;
    for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < W && yy >= 0 && yy < H && label[yy * W + xx] === best) { near = true; break; }
    }
    if (!near) alpha[i] = 0;
  }
  // Foreground: what is left of the pixel once the screen's share is taken
  // out, in linear light, then despilled (green no higher than the mean of red
  // and blue — she wears nothing green; skin and red hair are below it).
  const Kl = K.map((c) => LIN[Math.round(c * 255)]);
  const fgLin = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = alpha[i];
    if (a <= 0) continue;
    let r = (LIN[px[i * 3]] - (1 - a) * Kl[0]) / a;
    let g = (LIN[px[i * 3 + 1]] - (1 - a) * Kl[1]) / a;
    let b = (LIN[px[i * 3 + 2]] - (1 - a) * Kl[2]) / a;
    r = Math.max(0, Math.min(1, r)); g = Math.max(0, Math.min(1, g)); b = Math.max(0, Math.min(1, b));
    g = Math.min(g, (r + b) / 2 + 0.02);
    fgLin[i * 3] = r; fgLin[i * 3 + 1] = g; fgLin[i * 3 + 2] = b;
  }
  return { alpha, fgLin, K };
}

// --- main ----------------------------------------------------------------------

const preview = process.argv.includes('--preview');
mkdirSync(SRC, { recursive: true });
const got = {};
for (const k of Object.keys(SOURCES)) got[k] = download(k);

const plates = {
  wall: wallPlate(W, H),
  living: loadStill(got.living.path, W, H),
  kitchen: loadStill(got.kitchen.path, W, H)
};
const platesLin = {};
for (const r of ROOMS) {
  const p = plates[r], l = new Float32Array(W * H * 3);
  for (let i = 0; i < l.length; i++) l[i] = LIN[p[i]];
  platesLin[r] = l;
}

for (const d of ['gt/alpha', 'gt/fg', ...ROOMS]) mkdirSync(join(OUT, d), { recursive: true });
writeImage(join(OUT, 'target.png'), 'rgb24', W, H, loadStill(got.target.path, W, H));
// The rooms as they are behind her: the scorer measures how much of the old
// room leaks into a composite.
for (const r of ROOMS) writeImage(join(OUT, r, 'plate.png'), 'rgb24', W, H, plates[r]);
if (process.argv.includes('--plates-only')) process.exit(0);

const frameBytes = W * H * 3;
let index = 0;
const sheet = [];
const ignore = [];
for (const seg of SEGMENTS) {
  const c = CROP, sx = W / c.w, sy = H / c.h;
  const vf = `crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${W}:${H}:flags=lanczos,fps=${FPS}`;
  const args = ['-ss', String(seg.from), '-t', String(seg.to - seg.from), '-i', got.person.path, '-vf', vf];
  const frames = [];
  await readFrames(args, frameBytes, (buf) => frames.push(Buffer.from(buf)));
  if (seg.text) {
    ignore.push({ first: index, last: index + frames.length - 1, rect: [
      Math.max(0, Math.floor((seg.text.x0 - c.x) * sx) - 24), Math.max(0, Math.floor((seg.text.y0 - c.y) * sy) - 24),
      Math.min(W, Math.ceil((seg.text.x1 - c.x) * sx) + 24), Math.min(H, Math.ceil((seg.text.y1 - c.y) * sy) + 24)] });
  }
  for (let f = 0; f < frames.length; f++, index++) {
    if (preview && f % 45 !== 0) continue;
    const { alpha, fgLin } = keyFrame(frames[f]);
    const name = String(index).padStart(4, '0');
    const a8 = Buffer.alloc(W * H), fg8 = Buffer.alloc(W * H * 3);
    for (let i = 0; i < W * H; i++) {
      a8[i] = Math.round(alpha[i] * 255);
      fg8[i * 3] = enc(fgLin[i * 3]); fg8[i * 3 + 1] = enc(fgLin[i * 3 + 1]); fg8[i * 3 + 2] = enc(fgLin[i * 3 + 2]);
    }
    if (!preview) {
      writeImage(join(OUT, 'gt/alpha', name + '.png'), 'gray', W, H, a8);
      writeImage(join(OUT, 'gt/fg', name + '.png'), 'rgb24', W, H, fg8);
    }
    for (const r of ROOMS) {
      const bl = platesLin[r], out = Buffer.alloc(W * H * 3);
      for (let i = 0; i < W * H; i++) {
        const a = alpha[i];
        for (let c = 0; c < 3; c++) out[i * 3 + c] = enc(a * fgLin[i * 3 + c] + (1 - a) * bl[i * 3 + c]);
      }
      if (preview) sheet.push({ name: r + '-' + name, data: out });
      else writeImage(join(OUT, r, name + '.jpg'), 'rgb24', W, H, out, ['-q:v', '2']);
      if (preview && r === 'wall') {
        const g3 = Buffer.alloc(W * H * 3);
        for (let i = 0; i < W * H; i++) g3[i * 3] = g3[i * 3 + 1] = g3[i * 3 + 2] = a8[i];
        sheet.push({ name: 'alpha-' + name, data: g3 });
      }
    }
    if (!preview && index % 30 === 0) process.stdout.write(`  frame ${index}\n`);
  }
}

if (preview) {
  const dir = join(ROOT, 'bench-results', 'matting');
  sheet.forEach((s, i) => writeImage(join(dir, `preview-${String(i).padStart(2, '0')}-${s.name}.png`), 'rgb24', W, H, s.data, ['-vf', 'scale=640:-2']));
  console.log('→ previews in ' + dir);
} else {
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({
    width: W, height: H, fps: FPS, frames: index, rooms: ROOMS,
    segments: SEGMENTS, crop: CROP, ignore, key: { lo: KEY_LO, hi: KEY_HI, cc: CC_THRESH },
    compositing: 'linear light (sRGB transfer), foreground despilled',
    sources: Object.fromEntries(Object.entries(SOURCES).map(([k, s]) => [k, { url: s.url, licence: s.licence, sha256: got[k].sha256 }]))
  }, null, 2));
  console.log(`→ ${index} frames x ${ROOMS.length} rooms in ${OUT}`);
}
