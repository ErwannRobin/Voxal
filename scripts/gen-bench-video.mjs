// Generate the deterministic "video call" scene the benchmark feeds to
// Chromium's fake camera (`--use-file-for-fake-video-capture`).
//
// Same argument as scripts/gen-bench-audio.mjs, one layer up. Chromium's
// built-in fake camera is a rolling gradient with a bouncing ball: flat colour,
// no texture, and a motion field an encoder predicts almost perfectly. Measured
// against it a camera would appear to cost a fraction of `CAMERA_MAX_BITRATE`,
// and every video number in the report would flatter the app.
//
// So we synthesise a scene with a *video call's* statistics rather than its
// meaning: a head-and-shoulders foreground that moves the way a person in front
// of a laptop moves, over a textured room that stays put, plus per-frame sensor
// grain. That gives the encoder what a real webcam gives it — a moving subject,
// a static background it can predict, and noise it cannot — so it sits in its
// normal operating range instead of idling.
//
// The shape also matters for the background-effects scenario: MediaPipe's
// selfie segmenter has to find a person to cut out, and its cost is only
// representative when it does.
//
// Y4M (I420) because that is the one raw format Chromium's file-backed fake
// capture reads. It is enormous and uncompressed — ~1.4 MB a frame at 720p —
// which is why the loop is short, the file is gitignored, and it is generated
// on demand by `make bench-video` rather than committed.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// 1280x720x30 is what CAMERA_CAPTURE_CAP asks a desktop camera for, so the
// benchmark measures the encode the app actually requests. Overridable because
// the file is ~1.4 MB per frame and a smaller machine may not want 83 MB of it.
const WIDTH = parseInt(process.env.BENCH_VIDEO_WIDTH || '1280', 10);
const HEIGHT = parseInt(process.env.BENCH_VIDEO_HEIGHT || '720', 10);
const FPS = parseInt(process.env.BENCH_VIDEO_FPS || '30', 10);
// Chromium loops the file, so this is a period, not a duration. Two seconds is
// long enough that the loop seam is a small fraction of any measurement window
// and short enough to stay under 100 MB.
const SECONDS = Number(process.env.BENCH_VIDEO_SECONDS || '2');
const SEED = 0x2b9d4e17;

const FRAMES = Math.max(1, Math.round(FPS * SECONDS));
const CW = WIDTH >> 1;
const CH = HEIGHT >> 1;

/** xorshift32 — seeded, so the generated file is identical on every machine. */
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 0x100000000; // [0, 1)
  };
}

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/**
 * The room behind the subject: a soft vertical light gradient, a few blocks of
 * furniture, and fixed per-pixel texture.
 *
 * Built ONCE and reused by every frame, because that is what a real background
 * is — the thing the encoder learns and then stops paying for. Regenerating it
 * per frame would make the whole picture novel every frame and roughly double
 * the bitrate for no reason a webcam would recognise.
 */
function buildBackground() {
  const rand = makeRandom(SEED);
  const y = new Uint8Array(WIDTH * HEIGHT);
  const u = new Uint8Array(CW * CH);
  const v = new Uint8Array(CW * CH);

  // Furniture: rectangles of their own luma, so the frame has real edges for
  // the encoder to code and for the segmenter's mask to be judged against.
  const blocks = [];
  for (let i = 0; i < 7; i++) {
    blocks.push({
      x0: Math.floor(rand() * WIDTH * 0.9),
      y0: Math.floor(rand() * HEIGHT * 0.9),
      w: Math.floor(WIDTH * (0.06 + rand() * 0.18)),
      h: Math.floor(HEIGHT * (0.06 + rand() * 0.24)),
      luma: 40 + Math.floor(rand() * 90),
    });
  }

  for (let py = 0; py < HEIGHT; py++) {
    const lift = 96 + 52 * (1 - py / HEIGHT); // window light from above
    for (let px = 0; px < WIDTH; px++) {
      let luma = lift;
      for (const b of blocks) {
        if (px >= b.x0 && px < b.x0 + b.w && py >= b.y0 && py < b.y0 + b.h) luma = b.luma;
      }
      luma += (rand() - 0.5) * 26; // wall texture, fixed for the whole run
      y[py * WIDTH + px] = clamp8(luma);
    }
  }
  // A cool, low-saturation room: the subject's warmth has to stand out from it
  // or a segmenter is being asked an easier question than a real one.
  for (let i = 0; i < CW * CH; i++) {
    u[i] = clamp8(140 + (rand() - 0.5) * 8);
    v[i] = clamp8(118 + (rand() - 0.5) * 8);
  }
  return { y, u, v };
}

/**
 * Where the subject is in frame at time t.
 *
 * Two sine terms at incommensurate rates, so the motion never repeats inside
 * the loop and the encoder cannot predict it from period alone — that is the
 * closest cheap analogue of someone shifting in a chair.
 */
function subjectAt(t) {
  return {
    cx: WIDTH * (0.5 + 0.035 * Math.sin(2 * Math.PI * 0.23 * t) + 0.012 * Math.sin(2 * Math.PI * 0.71 * t)),
    cy: HEIGHT * (0.46 + 0.028 * Math.sin(2 * Math.PI * 0.31 * t)),
    scale: 1 + 0.04 * Math.sin(2 * Math.PI * 0.17 * t),
  };
}

/** One frame: the fixed room, the subject painted over it, then sensor grain. */
function renderFrame(bg, frameIndex, grain) {
  const t = frameIndex / FPS;
  const { cx, cy, scale } = subjectAt(t);

  const y = Uint8Array.from(bg.y);
  const u = Uint8Array.from(bg.u);
  const v = Uint8Array.from(bg.v);

  const headRx = WIDTH * 0.105 * scale;
  const headRy = HEIGHT * 0.20 * scale;
  const headCy = cy - HEIGHT * 0.06;
  const shoulderY = headCy + headRy * 0.85;
  const shoulderRx = WIDTH * 0.22 * scale;
  // Deliberately tall enough to run off the bottom of the frame: a torso that
  // ends inside the picture reads as an object, not as somebody sitting there.
  const shoulderRy = HEIGHT * 0.78 * scale;

  for (let py = 0; py < HEIGHT; py++) {
    for (let px = 0; px < WIDTH; px++) {
      const dxh = (px - cx) / headRx;
      const dyh = (py - headCy) / headRy;
      const inHead = dxh * dxh + dyh * dyh <= 1;
      const dxs = (px - cx) / shoulderRx;
      const dys = (py - shoulderY) / shoulderRy;
      const inBody = py >= shoulderY && dxs * dxs + dys * dys <= 1;
      if (!inHead && !inBody) continue;

      const i = py * WIDTH + px;
      // Face lit from the screen, torso darker — a flat silhouette would give
      // the encoder nothing to code inside the subject.
      const shade = inHead ? 168 + 46 * (1 - Math.abs(dxh)) : 96 + 24 * (1 - Math.abs(dxs));
      y[i] = clamp8(shade + (grain() - 0.5) * 10);

      const ci = (py >> 1) * CW + (px >> 1);
      if (inHead) { u[ci] = 112; v[ci] = 154; }  // skin: warm
      else { u[ci] = 132; v[ci] = 124; }          // clothing: neutral
    }
  }

  // Sensor grain, fresh every frame. This is the part an encoder genuinely
  // cannot predict, and leaving it out is most of why a synthetic source
  // understates a camera's bitrate.
  for (let i = 0; i < y.length; i++) y[i] = clamp8(y[i] + (grain() - 0.5) * 9);

  return { y, u, v };
}

function generate(target) {
  const bg = buildBackground();
  const grain = makeRandom(SEED ^ 0x9e3779b9);
  const header = Buffer.from(`YUV4MPEG2 W${WIDTH} H${HEIGHT} F${FPS}:1 Ip A1:1 C420mpeg2\n`, 'ascii');
  const frameHeader = Buffer.from('FRAME\n', 'ascii');

  const parts = [header];
  for (let f = 0; f < FRAMES; f++) {
    const { y, u, v } = renderFrame(bg, f, grain);
    parts.push(frameHeader, Buffer.from(y.buffer, 0, y.length), Buffer.from(u.buffer, 0, u.length), Buffer.from(v.buffer, 0, v.length));
  }
  const buf = Buffer.concat(parts);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, buf);
  return buf.length;
}

const target = process.argv[2] || 'tests/bench/assets/bench-scene.y4m';
const bytes = generate(target);
console.log(
  `→ ${target} (${WIDTH}x${HEIGHT}, ${FPS} fps, ${FRAMES} frames, ` +
    `${(bytes / 1048576).toFixed(0)} MiB — looped by Chromium)`
);
