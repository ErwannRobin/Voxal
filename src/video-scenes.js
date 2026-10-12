// video-scenes.js — the animated virtual backgrounds: five generated rooms and
// landscapes that the camera pipeline in video-effects.js draws behind you.
//
// Loaded as a plain classic script by BOTH index.html and settings.html, BEFORE
// video-effects.js (which reads VideoScenes when it is built). It declares
// exactly one global, `VideoScenes`.
//
// ---------------------------------------------------------------------------
// What a scene is
// ---------------------------------------------------------------------------
//
// One fragment shader. No image, no model, no font, nothing downloaded: every
// wall, cloud and leaf is computed from the pixel's position and the time.
// That is a requirement, not a stylistic choice — it costs nothing to ship,
// there is no artwork to license, and it is what lets the scene be relit to
// match YOU, which a photograph can never be.
//
// Each scene is drawn the same way:
//
//   * in linear light, with its key light (window, sun, lamp) placed on the
//     side the camera says YOUR light is coming from. The layout is authored
//     with the key light on the right and mirrored when it is on the left, so
//     a window never appears on the side your face is in shadow;
//   * scaled to your exposure and tinted by your room's white balance, so a
//     dim warm room gets a dim warm office rather than a sunlit one pasted
//     behind a face lit by a desk lamp. A dark enough room turns the scene to
//     evening — the city lights come on outside the office window;
//   * with its alpha channel saying how near each surface is. The composite
//     darkens near surfaces with YOUR soft shadow (a wall a metre behind you
//     takes one; a mountain ten kilometres away does not), and spills the
//     scene's own light onto the edge of your silhouette.
//
// Movement is deliberately slow and small — a cloud, a leaf, the dappled light
// in a sunbeam, rain on a window — for two reasons. It is a backdrop to a
// working call, not a screensaver; and every pixel that changes is a pixel the
// video encoder has to spend bits on, so a busy background would cost everyone
// in the room bandwidth. Things near you also answer your movement: dust in the
// sunbeam swirls, leaves stir, steam bends.
//
// The scene is rendered into a small buffer (512 on its long side) and
// upscaled. That is cheaper, and it is also the look: a real camera focused on
// a face shows the room behind it slightly soft.

var VideoScenes = (function () {
  'use strict';

  // --- the catalogue --------------------------------------------------------
  //
  // shadow: how dark your shadow gets on the scene's near surfaces (0 = the
  //         scene has none — everything in it is far away).
  // wrap:   how much of the scene's light spills onto your outline.
  // swatch: what the chip shows until its real thumbnail has been rendered,
  //         and where WebGL2 is not available to render one at all.
  var SCENES = [
    { id: 'office', label: 'Office', shadow: 0.55, wrap: 0.22,
      swatch: 'linear-gradient(120deg,#d9d0c3 0%,#e8e1d6 55%,#a9c3da 100%)' },
    { id: 'island', label: 'Island', shadow: 0.30, wrap: 0.30,
      swatch: 'linear-gradient(180deg,#7fb2df 0%,#cfe6ef 48%,#3fa3a6 52%,#e9dcbc 100%)' },
    { id: 'cybercafe', label: 'Cyber café', shadow: 0.45, wrap: 0.42,
      swatch: 'linear-gradient(120deg,#2a1714 0%,#5a2a3c 50%,#1d3550 100%)' },
    { id: 'mountain', label: 'Mountain', shadow: 0, wrap: 0.28,
      swatch: 'linear-gradient(180deg,#8fb4d9 0%,#e6eef5 45%,#5f7387 70%,#2f4a35 100%)' },
    { id: 'countryside', label: 'Countryside', shadow: 0, wrap: 0.28,
      swatch: 'linear-gradient(180deg,#9cc4e6 0%,#dceaf2 45%,#86a957 65%,#4f7a2c 100%)' }
  ];

  // The image presets these scenes replaced, so a stored `preset:aurora` keeps
  // a background rather than silently turning the effect off.
  var LEGACY = { aurora: 'mountain', dusk: 'island', studio: 'office', linen: 'countryside' };

  function byId(id) {
    for (var i = 0; i < SCENES.length; i++) if (SCENES[i].id === id) return SCENES[i];
    return null;
  }

  // A scene id from anything that might be stored: a current id, a legacy one,
  // or nonsense (null).
  function resolveId(id) {
    id = String(id || '');
    if (byId(id)) return id;
    if (Object.prototype.hasOwnProperty.call(LEGACY, id)) return LEGACY[id];
    return null;
  }

  // --- matching the subject's light ----------------------------------------
  //
  // Measured on the CPU from a 32-wide copy of the camera frame and the mask the
  // segmenter has just produced, a few times a second. Three things are read:
  //
  //   * exposure — the subject's own brightness. The scene is scaled to it in
  //     linear light, so a dim room gets a dim scene. Measured on YOU, not on
  //     the frame: the frame's average is mostly the room the scene replaces.
  //   * direction — the subject's right half against its left half. Which side
  //     of your face is brighter is which side your light is on, and the scene
  //     puts its window or its sun there.
  //   * tint — gray-world over the whole frame. The camera has already white-
  //     balanced, so what is left is the cast it could not remove (a warm lamp
  //     at night, a blue screen glow), and only part of that is followed:
  //     a green wall must not turn the sky green.
  //
  // And one thing for the interactions: how much the mask moved since the last
  // sample, which is how much the dust in the sunbeam swirls.
  var LOOK_REF_LUMA  = 0.48;   // encoded luma of a well-lit face: exposure 1
  var LOOK_EXP_CURVE = 1.6;    // ratio^curve: linear light, slightly compressed
  var LOOK_EXP_MIN   = 0.22;
  var LOOK_EXP_MAX   = 1.35;
  var LOOK_DIR_GAIN  = 3.2;    // half-face asymmetry → direction, -1..1
  var LOOK_TINT_FOLLOW = 0.5;  // how much of the measured cast the scene takes
  var LOOK_TINT_MIN  = 0.84;
  var LOOK_TINT_MAX  = 1.18;
  var LOOK_SIDE_FLIP = 0.35;   // |direction| that moves the window to the other side
  var LOOK_MIN_COVER = 0.03;   // less of the frame than this is "nobody there"
  var LOOK_SMOOTH_S  = 1.4;    // time constant of the per-frame ease, seconds
  var LOOK_SIDE_S    = 1.1;    // how long the scene takes to mirror itself

  function defaultLook() {
    return {
      exposure: 1, tint: [1, 1, 1], dirX: 0.35, dirY: 0.5, hard: 0.45,
      cx: 0.5, cy: 0.55, sx: 0.2, sy: 0.4, motion: 0,
      side: 1, sideMix: 1, measured: false
    };
  }

  // rgba: probe pixels (pw × ph, 0–255). mask: the same grid, 0–255, the
  // segmenter's confidence. prev: the previous sample's mask grid, or null.
  // Returns null when there is not enough of a person in the frame to say
  // anything — the caller keeps its last answer.
  function measureSubject(rgba, pw, ph, mask, prev) {
    var n = pw * ph;
    var gr = 0, gg = 0, gb = 0;            // gray world, linear
    var ws = 0, ls = 0, sx = 0, sy = 0;    // subject weight, luma, centroid
    var i, x, y;
    for (i = 0; i < n; i++) {
      var r = rgba[i * 4] / 255, g = rgba[i * 4 + 1] / 255, b = rgba[i * 4 + 2] / 255;
      gr += r * r; gg += g * g; gb += b * b;
      var m = mask[i] / 255;
      // A confident core only: the edge is half room, and the room's light is
      // exactly what this must not measure.
      var w = m <= 0.55 ? 0 : m >= 0.9 ? 1 : (m - 0.55) / 0.35;
      if (!w) continue;
      x = i % pw; y = (i / pw) | 0;
      ws += w;
      ls += w * (0.2126 * r + 0.7152 * g + 0.0722 * b);
      sx += w * x; sy += w * y;
    }
    var cover = ws / n;
    if (cover < LOOK_MIN_COVER) return null;
    var cx = sx / ws, cy = sy / ws;

    // Spread, left/right and top/bottom halves, around the centroid.
    var vx = 0, vy = 0, lL = 0, wL = 0, lR = 0, wR = 0, lT = 0, wT = 0, lB = 0, wB = 0;
    for (i = 0; i < n; i++) {
      var mm = mask[i] / 255;
      var ww = mm <= 0.55 ? 0 : mm >= 0.9 ? 1 : (mm - 0.55) / 0.35;
      if (!ww) continue;
      x = i % pw; y = (i / pw) | 0;
      var rr = rgba[i * 4] / 255, gg2 = rgba[i * 4 + 1] / 255, bb = rgba[i * 4 + 2] / 255;
      var l = 0.2126 * rr + 0.7152 * gg2 + 0.0722 * bb;
      vx += ww * (x - cx) * (x - cx); vy += ww * (y - cy) * (y - cy);
      if (x < cx) { lL += ww * l; wL += ww; } else { lR += ww * l; wR += ww; }
      if (y < cy) { lT += ww * l; wT += ww; } else { lB += ww * l; wB += ww; }
    }
    var mL = wL ? lL / wL : 0, mR = wR ? lR / wR : 0;
    var mT = wT ? lT / wT : 0, mB = wB ? lB / wB : 0;

    var motion = 0;
    if (prev && prev.length === n) {
      var diff = 0, tot = 0;
      for (i = 0; i < n; i++) { diff += Math.abs(mask[i] - prev[i]); tot += mask[i]; }
      motion = tot ? diff / tot : 0;
    }

    return {
      luma: ls / ws,
      gray: [gr / n, gg / n, gb / n],
      asymX: (mR + mL) > 0.02 ? (mR - mL) / (mR + mL) : 0,
      // Up is positive: a brighter top half is light from above.
      asymY: (mT + mB) > 0.02 ? (mT - mB) / (mT + mB) : 0,
      cx: (cx + 0.5) / pw, cy: (cy + 0.5) / ph,
      sx: Math.sqrt(vx / ws) * 2 / pw, sy: Math.sqrt(vy / ws) * 2 / ph,
      cover: cover,
      motion: motion
    };
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // What the scene should aim for, given a measurement. `prev` is the current
  // target, for the side's hysteresis: the window moves to the other side only
  // when the light has clearly moved, never on a borderline reading, or a head
  // turned toward a second screen would flip the room back and forth.
  function lookFromStats(s, prev) {
    var out = {};
    prev = prev || defaultLook();
    if (!s) {
      for (var k in prev) out[k] = prev[k];
      out.motion = 0;
      return out;
    }
    out.exposure = clamp(Math.pow(Math.max(s.luma, 0.001) / LOOK_REF_LUMA, LOOK_EXP_CURVE),
                         LOOK_EXP_MIN, LOOK_EXP_MAX);

    var y = 0.2126 * s.gray[0] + 0.7152 * s.gray[1] + 0.0722 * s.gray[2];
    var tint = [1, 1, 1];
    if (y > 0.0005) {
      for (var c = 0; c < 3; c++) {
        tint[c] = clamp(1 + (s.gray[c] / y - 1) * LOOK_TINT_FOLLOW, LOOK_TINT_MIN, LOOK_TINT_MAX);
      }
      // Renormalise: the tint is a colour, never a brightness — exposure is.
      var ty = 0.2126 * tint[0] + 0.7152 * tint[1] + 0.0722 * tint[2];
      for (c = 0; c < 3; c++) tint[c] /= ty;
    }
    out.tint = tint;

    out.dirX = clamp(s.asymX * LOOK_DIR_GAIN, -1, 1);
    out.dirY = clamp(0.35 + s.asymY * LOOK_DIR_GAIN, -1, 1);
    // A strongly one-sided light is a hard light: a sharper, darker shadow.
    out.hard = clamp(0.25 + Math.abs(out.dirX) * 0.75, 0, 1);

    out.cx = s.cx; out.cy = s.cy; out.sx = s.sx; out.sy = s.sy;
    out.motion = clamp((s.motion - 0.03) * 4, 0, 1);

    var side = prev.measured ? prev.side : (out.dirX < 0 ? -1 : 1);
    if (out.dirX > LOOK_SIDE_FLIP) side = 1;
    else if (out.dirX < -LOOK_SIDE_FLIP) side = -1;
    out.side = side;
    out.sideMix = prev.sideMix;
    out.measured = true;
    return out;
  }

  // Ease the look actually drawn toward its target. Per frame, by elapsed time,
  // so 30 fps and 15 fps converge equally fast. The first measurement is taken
  // whole — easing in from the default would show the room relighting itself
  // for the first two seconds of every call.
  function easeLook(cur, target, dt) {
    if (target.measured && !cur.measured) {
      for (var k in target) cur[k] = Array.isArray(target[k]) ? target[k].slice() : target[k];
      cur.sideMix = target.side > 0 ? 1 : 0;
      cur.measured = true;
      return cur;
    }
    var a = 1 - Math.exp(-Math.max(0, dt) / LOOK_SMOOTH_S);
    cur.exposure += (target.exposure - cur.exposure) * a;
    for (var c = 0; c < 3; c++) cur.tint[c] += (target.tint[c] - cur.tint[c]) * a;
    cur.dirX += (target.dirX - cur.dirX) * a;
    cur.dirY += (target.dirY - cur.dirY) * a;
    cur.hard += (target.hard - cur.hard) * a;
    cur.cx += (target.cx - cur.cx) * a * 2;
    cur.cy += (target.cy - cur.cy) * a * 2;
    cur.sx += (target.sx - cur.sx) * a;
    cur.sy += (target.sy - cur.sy) * a;
    // Movement is felt at once and settles slowly, like air does.
    var up = target.motion > cur.motion;
    cur.motion += (target.motion - cur.motion) * (up ? Math.min(1, a * 6) : a * 0.6);
    cur.side = target.side;
    var want = target.side > 0 ? 1 : 0;
    var step = Math.max(0, dt) / LOOK_SIDE_S;
    if (cur.sideMix < want) cur.sideMix = Math.min(want, cur.sideMix + step);
    else if (cur.sideMix > want) cur.sideMix = Math.max(want, cur.sideMix - step);
    return cur;
  }

  // --- the shaders ----------------------------------------------------------
  //
  // GLSL ES 3.00, highp (guaranteed in a WebGL2 fragment shader — and needed:
  // the noise hashes and the clock both lose their low bits in mediump).

  var HEADER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform vec2  uRes;       // the scene buffer, px
uniform float uTime;      // seconds
uniform float uSideMix;   // 1: key light on the right, 0: on the left
uniform vec3  uLook;      // directionality 0..1, elevation -1..1, motion 0..1
uniform vec3  uTint;      // the room's white-balance cast, luminance 1
uniform float uExposure;  // linear gain matching the subject
uniform vec4  uSubject;   // centroid (uv, y up) and half extent (uv)

float T, KEY, ELEV, MOTION, NIGHT, PX, HX;
vec2 SUBJ, SUBJR;

vec3 lin(vec3 c) { return c * c; }
// x², for a gaussian. Never pow(x, 2.0): pow of a negative base is undefined
// in GLSL, and some drivers really do return NaN for it.
float sq(float x) { return x * x; }
// smoothstep, written out. The built-in is undefined for edge0 >= edge1, and
// a falling edge (sstep(0.9, 0.1, x)) is used all over these scenes.
float sstep(float a, float b, float x) {
  float t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return s;
}
float fbm3(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * noise(p); p = p * 2.07 + vec2(11.3, 5.7); a *= 0.5; }
  return s / 0.875;
}
// Ridged: sharp crests, soft valleys — mountains.
float ridged(vec2 p) {
  float s = 0.0, a = 0.55;
  for (int i = 0; i < 6; i++) {
    float n = 1.0 - abs(noise(p) * 2.0 - 1.0);
    s += a * n * n;
    p = p * 2.1 + vec2(3.7, 1.3); a *= 0.47;
  }
  return s;
}
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
float sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
// Coverage of a signed distance, with a soft edge s wide. Every edge in a
// scene is soft by at least a texel: this is a backdrop, focused past.
float fill(float d, float s) { return 1.0 - sstep(-s, s, d); }
// A leaf in its own frame: x along the blade from 0 to len, y across.
float sdLeaf(vec2 q, float len, float wid) {
  float x = clamp(q.x / len, 0.0, 1.0);
  float w = wid * 2.0 * sqrt(x * (1.0 - x)) * (1.0 - 0.25 * x);
  return max(abs(q.y) - w, max(-q.x, q.x - len));
}
// How much the subject's movement pushes the air at p: a small displacement
// away from the subject, strongest close to it.
vec2 stir(vec2 p, float reach) {
  vec2 d = (p - SUBJ) / max(SUBJR, vec2(0.05));
  float r = length(d);
  float k = MOTION * exp(-max(r - 1.0, 0.0) * 2.5) * reach;
  return normalize(d + 1e-4) * k + vec2(sin(T * 2.1 + p.y * 9.0), cos(T * 1.7 + p.x * 7.0)) * k * 0.6;
}
// Sparse soft specks drifting on their own slow orbits: dust, pollen, spray.
float specks(vec2 p, float density, float size, float drift) {
  vec2 q = p * density + vec2(sin(T * 0.07) * 0.6, T * drift);
  vec2 cell = floor(q);
  float a = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 c = cell + vec2(float(i), float(j));
      vec2 h = hash22(c);
      if (h.x > 0.4) continue;
      vec2 o = 0.5 + 0.32 * vec2(sin(T * 0.21 + h.y * 6.283), cos(T * 0.17 + h.x * 6.283));
      float d = length(q - c - o);
      float tw = 0.55 + 0.45 * sin(T * 0.6 + h.y * 31.0);
      a += tw * sstep(size, size * 0.2, d);
    }
  }
  return a;
}
`;

  // --- the office -----------------------------------------------------------
  //
  // A corner of a bright room. The back wall carries shelves; the side wall,
  // drawn in perspective, carries the window the light comes in by — on the
  // side your own light is on — and that light lands on the back wall as a
  // sunlit spot, dappled by a tree outside that moves in the wind. Dust drifts
  // in the beam. A fiddle-leaf fig stands in the corner. In a dim room it is
  // evening: the spot is gone, the city is lit, and the shelf lamp is on.
  var OFFICE = `
vec3 officeOutside(vec2 p) {
  float sy = clamp(p.y * 1.4 + 0.3, 0.0, 1.0);
  vec3 day = mix(lin(vec3(0.86, 0.91, 0.95)), lin(vec3(0.55, 0.73, 0.92)), sy);
  vec3 dusk = mix(lin(vec3(0.95, 0.62, 0.45)), lin(vec3(0.20, 0.25, 0.45)), sy);
  vec3 sky = mix(day, dusk, NIGHT);
  float cl = sstep(0.5, 0.75, fbm(vec2(p.x * 3.0 + T * 0.012, p.y * 6.0)));
  sky = mix(sky, mix(lin(vec3(0.98)), lin(vec3(0.55, 0.45, 0.55)), NIGHT), cl * 0.6);
  // A skyline, far and hazy.
  float col = floor(p.x * 16.0);
  float top = -0.08 + 0.16 * hash11(col * 3.1) * hash11(col + 7.0);
  float bld = fill(p.y - top, 0.006);
  vec3 bc = mix(lin(vec3(0.66, 0.72, 0.80)), lin(vec3(0.10, 0.12, 0.20)), NIGHT);
  // Lit windows at dusk: a grid, about one in three on.
  vec2 wg = vec2(p.x * 160.0, p.y * 110.0);
  float lit = step(0.66, hash12(floor(wg))) * step(0.3, fract(wg.x)) * step(0.35, fract(wg.y));
  bc += lin(vec3(1.0, 0.8, 0.5)) * lit * NIGHT * 0.7;
  return mix(sky, bc, bld);
}

vec4 scene(vec2 p, out vec3 emit) {
  emit = vec3(0.0);
  float xc = HX * 0.62;              // the corner between back and side wall
  float vy = 0.04;                   // eye level
  vec3 sunCol = lin(vec3(1.0, 0.92, 0.78));
  float sun = KEY * (1.0 - NIGHT);
  vec3 wallAlb = lin(vec3(0.91, 0.88, 0.83));
  vec3 col;
  float recv;

  if (p.x < xc) {
    // ---- the back wall
    float toward = sstep(-HX, xc, p.x);
    float light = 0.50 + 0.20 * toward * (0.5 + 0.5 * KEY) + 0.06 * (0.5 - abs(p.y));
    light *= 1.0 - 0.22 * exp(-(xc - p.x) * 40.0);           // the corner
    light *= 1.0 - 0.18 * sstep(0.30, 0.5, p.y);         // under the ceiling
    // The window, projected onto this wall by the sun: a skewed spot, cut by
    // the mullions, dappled by leaves outside that sway.
    vec2 q = p - vec2(xc - 0.43, -0.03 - 0.07 * ELEV);
    q.y -= q.x * 0.42;
    float spot = fill(sdBox(q, vec2(0.165, 0.24)), 0.03);
    spot *= 1.0 - 0.85 * fill(abs(q.x) - 0.007, 0.012);
    spot *= 1.0 - 0.85 * fill(abs(q.y - 0.03) - 0.007, 0.012);
    vec2 lq = q * 6.5 + vec2(0.12 * sin(T * 0.33), 0.08 * sin(T * 0.26 + 1.0));
    float dapple = sstep(0.40, 0.66, fbm(lq + vec2(T * 0.015, 0.0)));
    spot *= 1.0 - 0.6 * dapple;
    col = wallAlb * (light + sunCol * spot * sun * 1.15);

    // Evening: a lamp on the top shelf, and its pool of light on the wall.
    vec2 lampP = vec2(-HX * 0.86, 0.215);
    float lg = exp(-length((p - lampP) * vec2(1.0, 1.6)) * 7.0);
    col += wallAlb * lin(vec3(1.0, 0.72, 0.42)) * lg * NIGHT * 0.9;
    recv = 1.0;

    // ---- shelves
    for (int s = 0; s < 2; s++) {
      float sy = s == 0 ? 0.14 : -0.10;
      float x0 = -HX * 0.94, x1 = -HX * 0.30;
      float hw = (x1 - x0) * 0.5, cx = (x0 + x1) * 0.5;
      // The board's shadow on the wall, thrown away from the light.
      float sh = fill(sdBox(p - vec2(cx - 0.012 * KEY, sy - 0.022), vec2(hw, 0.010)), 0.018);
      col *= 1.0 - 0.35 * sh;
      // Books standing on the board, with a soft shadow just above them
      // where they block the light from the window.
      float bx = (p.x - x0) / 0.024;
      float bi = floor(bx);
      float h1 = hash11(bi * 1.7 + float(s) * 13.0);
      float h2 = hash11(bi * 3.3 + float(s) * 7.0 + 1.0);
      bool slot = bi >= 0.0 && p.x < x1 - 0.10 && h1 > 0.14;
      float bh = 0.055 + 0.055 * h2;
      if (slot && p.y > sy && p.y < sy + bh + 0.012) {
        vec3 pal[5];
        pal[0] = vec3(0.62, 0.30, 0.22); pal[1] = vec3(0.45, 0.55, 0.45);
        pal[2] = vec3(0.20, 0.27, 0.40); pal[3] = vec3(0.86, 0.80, 0.66);
        pal[4] = vec3(0.78, 0.60, 0.25);
        vec3 bc = lin(pal[int(mod(bi + float(s) * 2.0, 5.0))]) * (0.75 + 0.35 * h1);
        float spine = fill(p.y - sy - bh, 0.002);
        float gap = sstep(0.0, 0.08, fract(bx)) * sstep(1.0, 0.92, fract(bx));
        float lit = 0.55 + 0.25 * toward + 0.12 * KEY * fract(bx);
        col = mix(col, bc * lit * (0.6 + 0.4 * gap), spine);
      } else if (slot && p.y > sy && p.y < sy + bh + 0.03) {
        col *= 1.0 - 0.18 * fill(p.y - sy - bh - 0.012, 0.012) * KEY;
      }
      // A small trailing plant at the end of the shelf: three vines hanging
      // over the edge. They stir as you move.
      vec2 pp = p - vec2(x1 - 0.055, sy);
      float pot = fill(sdBox(pp - vec2(0.0, 0.022), vec2(0.024 - pp.y * 0.15, 0.022)), 0.002);
      col = mix(col, lin(vec3(0.82, 0.55, 0.40)) * (0.55 + 0.35 * toward), pot);
      for (int v = 0; v < 3; v++) {
        float fv = float(v);
        float reach = 0.10 + 0.07 * fv;
        for (int k = 0; k < 9; k++) {
          float fk = float(k);
          float d = (fk + 0.5) / 9.0 * reach;               // how far down the vine
          float sway = (0.004 * sin(T * 0.5 + fv * 2.0 + float(s)) +
                        0.010 * MOTION * sin(T * 2.2 + fk * 0.8)) * d * 25.0;
          vec2 at = vec2(-0.016 + 0.016 * fv + 0.006 * sin(d * 30.0 + fv * 2.0) + sway,
                         0.040 - d * 1.05);
          float alt = mod(fk, 2.0) * 2.0 - 1.0;
          vec2 lq = rot(-(alt * 0.9 - 1.5708 + sway * 3.0)) * (pp - at);
          float lf = fill(sdLeaf(lq, 0.020 - fk * 0.0006, 0.010), 0.0018);
          vec3 lc = lin(vec3(0.26, 0.46, 0.20)) * (0.55 + 0.45 * toward + 0.12 * alt);
          col = mix(col, lc, lf);
        }
      }
      if (s == 0) {
        // The lamp: a drum shade, glowing at night.
        vec2 lq3 = p - lampP;
        float shade = fill(sdBox(lq3, vec2(0.026 - lq3.y * 0.15, 0.022)), 0.002);
        float stem = fill(sdBox(lq3 + vec2(0.0, 0.05), vec2(0.003, 0.03)), 0.002);
        vec3 shc = mix(lin(vec3(0.85, 0.82, 0.76)) * 0.7, lin(vec3(1.0, 0.82, 0.55)), NIGHT);
        col = mix(col, lin(vec3(0.25, 0.22, 0.2)), stem);
        col = mix(col, shc, shade);
        emit += lin(vec3(1.0, 0.75, 0.45)) * shade * NIGHT * 0.9;
      }
      float board = fill(sdBox(p - vec2(cx, sy - 0.006), vec2(hw, 0.007)), 0.002);
      col = mix(col, lin(vec3(0.62, 0.46, 0.32)) * (0.55 + 0.35 * toward), board);
    }
  } else {
    // ---- the side wall, in perspective toward the vanishing point
    float d = xc / max(p.x, 1e-3);           // 1 at the corner, smaller nearer
    float h = (p.y - vy) * d;                // height on the wall
    vec2 wq = vec2(d, h);
    float ceil = sstep(0.44, 0.45, h);
    float light = 0.42 + 0.18 * exp(-abs(d - 0.78) * 6.0);
    col = wallAlb * light;
    col = mix(col, wallAlb * 0.8, ceil);
    vec2 wc = wq - vec2(0.77, 0.06);
    float frameD = sdBox(wc, vec2(0.17, 0.31));
    float aa = fwidth(frameD) * 1.5 + 0.002;
    float win = fill(frameD, aa);
    float glass = fill(sdBox(wc, vec2(0.155, 0.295)), aa);
    float mull = max(fill(abs(wc.x) - 0.007, aa), fill(abs(wc.y - 0.06) - 0.007, aa));
    glass *= 1.0 - mull;
    col = mix(col, lin(vec3(0.93, 0.92, 0.90)) * 0.75, win);
    vec3 outside = officeOutside(p);
    col = mix(col, vec3(0.0), glass);
    emit += outside * glass * (1.25 - 0.4 * NIGHT);
    recv = 0.7 * (1.0 - glass);
  }

  // The fiddle-leaf fig in the corner, swaying a little — more when you move.
  vec2 fp = p - vec2(xc - 0.10, -0.5);
  float trunk = fill(abs(fp.x - 0.01 * sin(fp.y * 9.0)) - 0.0045, 0.002) * step(fp.y, 0.56);
  col = mix(col, lin(vec3(0.38, 0.29, 0.21)) * (0.6 + 0.3 * KEY), trunk);
  float pot = fill(sdBox(fp - vec2(0.0, 0.05), vec2(0.055 - fp.y * 0.12, 0.06)), 0.002);
  for (int k = 0; k < 12; k++) {
    float fk = float(k);
    float side = mod(fk, 2.0) * 2.0 - 1.0;
    float ly = 0.17 + fk * 0.033 + 0.012 * hash11(fk * 7.0);
    vec2 at = vec2(0.01 * sin(ly * 9.0), ly);
    float wind = 0.03 * sin(T * 0.45 + fk * 0.9) + 0.08 * MOTION * sin(T * 1.9 + fk * 1.7);
    float ang = 1.5708 - side * (0.70 + 0.45 * hash11(fk * 3.1) - fk * 0.025) + wind;
    vec2 rel = fp - at;
    vec2 lq = vec2(dot(rel, vec2(cos(ang), sin(ang))), dot(rel, vec2(-sin(ang), cos(ang))));
    float len = 0.105 - fk * 0.003;
    float lf = fill(sdLeaf(lq, len, 0.045 - fk * 0.0012), 0.0025);
    float vein = fill(abs(lq.y) - 0.0011, 0.001) * step(0.0, lq.x);
    // Two-tone, like a real leaf: the half turned to the light is brighter.
    float lit = 0.40 + 0.30 * KEY * step(0.0, lq.y * cos(ang)) + 0.12 * hash11(fk) + 0.18 * (1.0 - KEY);
    vec3 lc = mix(lin(vec3(0.17, 0.33, 0.13)), lin(vec3(0.26, 0.46, 0.18)), hash11(fk * 5.0)) * lit;
    lc = mix(lc, lc * 1.5, vein * 0.5);
    col = mix(col, lc, lf);
    recv = mix(recv, 0.6, lf);
  }
  col = mix(col, lin(vec3(0.85, 0.83, 0.79)) * (0.45 + 0.25 * KEY), pot);

  // Dust in the beam, drifting on the air you stir.
  vec2 dp = p + stir(p, 0.05);
  float beam = sstep(xc - 0.75, xc - 0.25, p.x) * sstep(xc + 0.25, xc - 0.05, p.x) *
               sstep(-0.35, 0.0, p.y + (p.x - xc) * 0.4);
  emit += sunCol * specks(dp, 26.0, 0.09, 0.012) * beam * sun * 0.06;
  return vec4(col, recv);
}
`;

  // --- the island -----------------------------------------------------------
  //
  // A lagoon from the shade of the beach: turquoise shallows, a reef line, a
  // hazy islet on the horizon and a sail crossing it — slowly enough that it
  // takes a call to notice. Low cumulus over the sea, the sun on your light's
  // side with its glitter path under it, the shore lapping at the sand, and a
  // palm whose fronds move in the trade wind.
  var ISLAND = `
vec4 scene(vec2 p, out vec3 emit) {
  emit = vec3(0.0);
  float hy = 0.04;
  vec2 sunP = vec2(HX * 0.70, 0.60 + 0.10 * ELEV);
  vec3 col;
  float recv = 0.0;
  vec3 sunCol = lin(vec3(1.0, 0.95, 0.86));

  // ---- sky
  float sy = clamp((p.y - hy) / (0.5 - hy), 0.0, 1.0);
  vec3 sky = mix(lin(vec3(0.84, 0.92, 0.95)), lin(vec3(0.36, 0.62, 0.88)), pow(sy, 0.65));
  float sd = length(p - sunP);
  sky += sunCol * (0.55 * exp(-sd * 4.0) + 0.20 * exp(-sd * 1.3)) * (0.35 + 0.65 * KEY);
  // Cumulus, banked low over the sea and lit from the sun's side.
  vec2 cq = vec2(p.x * 2.2 + T * 0.006, (p.y - hy) * 5.0);
  float band = sstep(0.0, 0.25, p.y - hy) * sstep(0.42, 0.14, p.y - hy);
  float dens = fbm(cq * 1.6) * band;
  float dens2 = fbm((cq + normalize(sunP - p) * vec2(0.08, 0.2)) * 1.6) * band;
  float cl = sstep(0.30, 0.52, dens);
  float shade = clamp(0.62 + (dens - dens2) * 4.0, 0.35, 1.0);
  vec3 cloud = mix(lin(vec3(0.70, 0.76, 0.84)), lin(vec3(1.0, 0.99, 0.96)), shade);
  sky = mix(sky, cloud, cl * 0.92);
  col = sky;

  // ---- the islet and its palms, hazy with distance
  float ix = (p.x + HX * 0.52) / 0.20;
  float isl = fill(p.y - (hy + 0.028 * exp(-ix * ix) + 0.004 * noise(vec2(p.x * 40.0, 1.0))), 0.0015);
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    float px = -HX * 0.52 + (fk - 1.0) * 0.05 + 0.012 * hash11(fk);
    float pix = (px + HX * 0.52) / 0.20;
    vec2 b0 = vec2(px, hy + 0.028 * exp(-pix * pix) - 0.003);
    vec2 top = b0 + vec2(0.005 * (fk - 1.0), 0.026 + 0.008 * hash11(fk * 3.0));
    float tr = fill(sdSeg(p, b0, top) - 0.0011, 0.0009);
    vec2 cq = p - top;
    float crown = fill(abs(cq.y + 0.9 * cq.x * cq.x / 0.012) - 0.0028, 0.0012) * step(abs(cq.x), 0.014);
    isl = max(isl, max(tr, crown));
  }
  vec3 haze = lin(vec3(0.60, 0.72, 0.72));
  col = mix(col, haze, isl * step(hy - 0.002, p.y));

  // ---- the sea
  float shoreY = -0.27 + 0.012 * sin(p.x * 4.0 + 1.0) + 0.006 * sin(T * 0.35 + p.x * 2.0);
  if (p.y < hy) {
    float z = clamp((hy - p.y) / (hy - shoreY), 0.0, 1.0);   // 0 horizon, 1 shore
    vec3 deep = lin(vec3(0.12, 0.38, 0.58));
    vec3 lagoon = lin(vec3(0.20, 0.72, 0.74));
    vec3 shallow = lin(vec3(0.58, 0.88, 0.82));
    vec3 sea = mix(deep, lagoon, sstep(0.15, 0.6, z));
    sea = mix(sea, shallow, sstep(0.75, 1.0, z));
    // The reef line: a band of paler water and soft surf.
    float reef = exp(-sq((z - 0.28) * 14.0));
    sea = mix(sea, lin(vec3(0.75, 0.90, 0.92)), reef * (0.25 + 0.15 * noise(vec2(p.x * 30.0 + T * 0.3, 2.0))));
    // Swell: long bands, compressed toward the horizon, rolling in.
    float persp = 1.0 / (z + 0.06);
    float sw = noise(vec2(p.x * 9.0 * persp * 0.25, persp * 2.0 - T * 0.25));
    sea *= 0.92 + 0.12 * sw;
    // The sky in the water near the horizon.
    sea = mix(sea, sky * 0.9, (1.0 - sstep(0.0, 0.25, z)) * 0.45);
    // Glitter under the sun: sparse, and slow enough not to cost the encoder.
    float gx = exp(-sq((p.x - sunP.x) * (2.6 + 2.0 * z)));
    float g = noise(vec2(p.x * 70.0 * persp * 0.2, persp * 9.0 + T * 0.6));
    emit += sunCol * pow(g, 9.0) * gx * KEY * (1.0 - z) * 2.2;
    col = sea;
  }
  // ---- shore and sand
  float wet = sstep(shoreY + 0.004, shoreY - 0.03, p.y);
  float foam = fill(abs(p.y - shoreY - 0.002) - 0.003, 0.004) *
               (0.55 + 0.45 * noise(vec2(p.x * 35.0 + T * 0.4, T * 0.2)));
  if (p.y < shoreY + 0.004) {
    vec3 sand = lin(vec3(0.94, 0.88, 0.75)) * (0.9 + 0.1 * noise(p * 90.0));
    // Wet sand: darker in a band the lapping water has just left.
    sand = mix(sand, lin(vec3(0.80, 0.72, 0.58)), wet * 0.35 * sstep(shoreY - 0.06, shoreY, p.y));
    float lit = 0.9 + 0.1 * KEY;
    col = sand * lit;
    recv = 0.45;
  }
  col = mix(col, lin(vec3(0.97)), foam * 0.8);

  // ---- the sail, crossing the horizon
  float bx = -HX - 0.1 + mod(T * 0.004 + 0.4, 2.0 * HX + 0.2);
  vec2 bq = p - vec2(bx, hy + 0.001);
  float sail = fill(max(max(-bq.y, bq.y - 0.026), abs(bq.x + bq.y * 0.35) - (0.026 - bq.y) * 0.25), 0.0012);
  float hull = fill(sdBox(bq + vec2(0.0, 0.001), vec2(0.012, 0.0018)), 0.0012);
  col = mix(col, lin(vec3(0.97, 0.97, 0.95)), sail * 0.9);
  col = mix(col, lin(vec3(0.25, 0.28, 0.32)), hull * 0.8);

  // ---- the palm, on the sun's side, leaning in
  vec2 base = vec2(HX * 1.05, -0.56);
  vec2 ctrl = vec2(HX * 0.98, 0.02);
  vec2 crownP = vec2(HX * 0.75, 0.33);
  // The trunk: a quadratic curve, sampled.
  float td = 1e3, tt = 0.0;
  for (int k = 0; k < 10; k++) {
    float a = float(k) / 10.0, b = float(k + 1) / 10.0;
    vec2 pa = mix(mix(base, ctrl, a), mix(ctrl, crownP, a), a);
    vec2 pb = mix(mix(base, ctrl, b), mix(ctrl, crownP, b), b);
    float dd = sdSeg(p, pa, pb);
    if (dd < td) { td = dd; tt = a + 0.1 * clamp(dot(p - pa, pb - pa) / dot(pb - pa, pb - pa), 0.0, 1.0); }
  }
  float tw = 0.021 - tt * 0.008;
  float trunk = fill(td - tw, 0.002);
  float rings = 0.82 + 0.18 * sstep(0.2, 0.8, fract(tt * 38.0));
  vec3 bark = lin(vec3(0.58, 0.48, 0.36)) * rings * (0.65 + 0.35 * KEY);
  col = mix(col, bark, trunk);
  recv = mix(recv, 0.3, trunk);
  // Coconuts, tucked under the crown.
  for (int k = 0; k < 3; k++) {
    vec2 cp = crownP + vec2(-0.012 + 0.012 * float(k), -0.016 - 0.004 * float(k == 1));
    float nut = fill(length(p - cp) - 0.0085, 0.002);
    col = mix(col, lin(vec3(0.42, 0.34, 0.16)) * (0.7 + 0.3 * KEY), nut);
  }
  // Fronds: drooping spines, each a comb of leaflets raked toward its tip.
  for (int k = 0; k < 9; k++) {
    float fk = float(k);
    float wind = 0.035 * sin(T * 0.7 + fk * 1.3) + 0.02 * sin(T * 1.6 + fk * 0.7) +
                 0.07 * MOTION * sin(T * 2.4 + fk * 2.0);
    float ang = mix(-0.15, 3.25, fk / 8.0) + 0.18 * sin(fk * 3.7) + wind;
    float len = 0.25 + 0.08 * hash11(fk * 1.7);
    float droop = 1.1 + 0.8 * hash11(fk * 2.3);
    vec2 dir = vec2(cos(ang), sin(ang));
    float best = 1e3, bu = 0.0, bv = 0.0;
    vec2 prev = crownP;
    for (int j = 1; j <= 6; j++) {
      float s = float(j) / 6.0 * len;
      vec2 cur = crownP + dir * s - vec2(0.0, droop * s * s);
      vec2 pa = p - prev, ba = cur - prev;
      float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
      vec2 r = pa - ba * h;
      float d = length(r);
      if (d < best) {
        best = d;
        bu = (float(j - 1) + h) / 6.0;
        vec2 t = normalize(ba);
        bv = t.x * r.y - t.y * r.x;
      }
      prev = cur;
    }
    if (best > 0.09) continue;
    float w = 0.07 * sin(3.1416 * pow(bu, 0.6)) * (1.0 - 0.35 * bu);
    // Leaflets hang: the lower side of the spine carries longer ones.
    w *= bv < 0.0 ? 1.15 : 0.8;
    float comb = fract(bu * len * 85.0 - abs(bv) * 40.0);
    float leaflet = sstep(0.15, 0.35, comb) * sstep(0.95, 0.75, comb);
    float cover = fill(best - w, 0.003) * mix(1.0, leaflet, sstep(0.003, 0.009, best));
    cover = max(cover, fill(best - 0.0028, 0.0015) * step(bu, 0.98));
    vec3 fc = mix(lin(vec3(0.15, 0.32, 0.11)), lin(vec3(0.40, 0.55, 0.18)), bu * 0.55 + 0.15 * hash11(fk));
    fc *= 0.6 + 0.45 * KEY * (0.5 + 0.5 * dir.x) + 0.15 * step(0.0, bv);
    col = mix(col, fc, cover);
    recv = mix(recv, 0.0, cover);
  }
  return vec4(col, recv);
}
`;

  // --- the cyber café -------------------------------------------------------
  //
  // Evening in a brick-walled café: a neon cup on the wall, a row of screens on
  // the counter with code scrolling by, pendant lamps, a string of bulbs, and a
  // street window where rain runs down the glass over the city's lights. The
  // neon breathes; it never flashes.
  var CAFE = `
float sdArc(vec2 p, float r, float a0, float a1) {
  float a = clamp(atan(p.y, p.x), a0, a1);
  return length(p - r * vec2(cos(a), sin(a)));
}
vec4 scene(vec2 p, out vec3 emit) {
  emit = vec3(0.0);
  vec3 col;
  float recv = 0.85;
  float winX = HX * 0.56;

  // ---- light falling on the wall
  vec3 lamp = lin(vec3(1.0, 0.70, 0.40));
  vec2 l1 = vec2(HX * 0.30, 0.30), l2 = vec2(-HX * 0.70, 0.33);
  float sway1 = 0.006 * sin(T * 0.5), sway2 = 0.005 * sin(T * 0.43 + 1.0);
  l1.x += sway1; l2.x += sway2;
  float pool1 = exp(-sq((p.x - l1.x) / 0.16)) * exp(-max(l1.y - p.y, 0.0) * 2.2) * sstep(l1.y + 0.03, l1.y - 0.05, p.y);
  float pool2 = exp(-sq((p.x - l2.x) / 0.14)) * exp(-max(l2.y - p.y, 0.0) * 2.4) * sstep(l2.y + 0.03, l2.y - 0.05, p.y);
  vec3 neonA = lin(vec3(1.0, 0.32, 0.62));
  vec3 neonB = lin(vec3(0.30, 0.88, 1.0));
  vec2 nc = vec2(-HX * 0.30, 0.17);
  float breathe = 0.93 + 0.07 * sin(T * 0.9);
  float nGlow = exp(-length((p - nc) * vec2(0.9, 1.2)) * 4.0) * breathe;
  vec3 light = vec3(0.07, 0.065, 0.07)
             + lamp * (pool1 * (0.55 + 0.45 * KEY) + pool2 * 0.45) * 0.9
             + mix(neonA, neonB, 0.35) * nGlow * 0.30
             + lin(vec3(0.35, 0.50, 0.85)) * sstep(winX - 0.45, winX, p.x) * 0.12 * (0.5 + KEY);

  // ---- the brick wall
  vec2 b = p * vec2(8.5, 19.0);
  b.x += 0.5 * mod(floor(b.y), 2.0);
  vec2 bi = floor(b), bf = fract(b);
  float bh = hash12(bi);
  float mortar = max(fill(min(bf.y, 1.0 - bf.y) - 0.06, 0.03), fill(min(bf.x, 1.0 - bf.x) - 0.03, 0.02));
  vec3 brick = lin(mix(vec3(0.42, 0.20, 0.14), vec3(0.52, 0.30, 0.20), bh)) * (0.75 + 0.35 * noise(p * 55.0));
  vec3 alb = mix(brick, lin(vec3(0.42, 0.38, 0.34)), mortar);
  col = alb * light;

  // ---- the neon: a cup with three wisps of steam, on a cyan underline
  vec2 q = (p - nc) * 1.0;
  float cup = min(sdArc(q - vec2(0.0, 0.02), 0.06, -3.1416, 0.0), sdSeg(q, vec2(-0.06, 0.02), vec2(0.06, 0.02)));
  cup = min(cup, sdArc(q - vec2(0.072, -0.005), 0.022, -1.4, 1.4));
  float steamD = 1e3;
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    vec2 sq = q - vec2(-0.03 + fk * 0.03, 0.045);
    float wav = 0.008 * sin(sq.y * 70.0 - T * 1.2 + fk * 2.0);
    float d = max(abs(sq.x - wav) - 0.0, 0.0);
    d = length(vec2(d, max(max(-sq.y, sq.y - 0.07), 0.0)));
    steamD = min(steamD, d);
  }
  float line = sdSeg(q, vec2(-0.10, -0.07), vec2(0.10, -0.07));
  float dip = 1.0 - 0.12 * sstep(0.985, 1.0, sin(T * 0.21)) * step(0.5, fract(T * 3.0));
  vec3 nA = neonA * (fill(cup - 0.0035, 0.0015) * 1.6 + exp(-cup * 60.0) * 0.45 + exp(-cup * 16.0) * 0.12) * breathe;
  vec3 nB = neonB * (fill(min(steamD, line) - 0.003, 0.0015) * 1.5 + exp(-min(steamD, line) * 60.0) * 0.4) * breathe * dip;
  emit += nA + nB;

  // ---- fairy lights along the top, out of focus
  float catY = 0.44 - 0.035 * cos((p.x / HX) * 1.6);
  float bulbs = 0.0;
  float bx = p.x / 0.09;
  float bc = floor(bx) + 0.5;
  vec2 bp = vec2(bc * 0.09, 0.44 - 0.035 * cos((bc * 0.09 / HX) * 1.6) - 0.012);
  float tw = 0.75 + 0.25 * sin(T * 0.7 + hash11(bc) * 20.0);
  bulbs = fill(length(p - bp) - 0.014, 0.007) * tw;
  float wire = fill(abs(p.y - catY) - 0.0012, 0.0015);
  col = mix(col, lin(vec3(0.05)), wire * 0.7);
  emit += lin(vec3(1.0, 0.78, 0.45)) * (bulbs * 0.8 + exp(-length(p - bp) * 40.0) * 0.12 * tw);

  // ---- pendant lamps
  for (int k = 0; k < 2; k++) {
    vec2 lp = k == 0 ? l1 : l2;
    vec2 lq = p - lp;
    float cord = fill(abs(lq.x - (k == 0 ? sway1 : sway2) * (lq.y / 0.3)) - 0.0015, 0.001) * step(0.0, lq.y);
    float shade = fill(sdBox(lq - vec2(0.0, 0.015), vec2(0.018 + (0.03 - lq.y) * 0.9, 0.018)), 0.002);
    col = mix(col, lin(vec3(0.08)), cord);
    col = mix(col, lin(vec3(0.12, 0.10, 0.09)) + lamp * 0.05, shade);
    float bulb = fill(length((lq + vec2(0.0, 0.004)) * vec2(1.0, 2.0)) - 0.012, 0.004);
    emit += lamp * (bulb * 1.4 + exp(-length(lq) * 18.0) * 0.18) * (k == 0 ? 0.6 + 0.4 * KEY : 0.7);
  }

  // ---- the street window, on the light's side
  if (p.x > winX - 0.012) {
    vec2 wq = p - vec2(winX, -0.29);
    float frame = 1.0 - fill(sdBox(p - vec2(winX + 0.5, 0.08), vec2(0.5 - 0.012, 0.36)), 0.002);
    vec3 night = mix(lin(vec3(0.06, 0.08, 0.16)), lin(vec3(0.14, 0.12, 0.22)), sstep(0.4, -0.2, p.y));
    // City lights, far out of focus.
    vec3 bok = vec3(0.0);
    vec2 g = p * 13.0;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 c = floor(g) + vec2(float(i), float(j));
        vec2 h = hash22(c);
        if (h.x < 0.45) continue;
        vec2 o = c + 0.5 + (h - 0.5) * 0.6;
        float r = 0.25 + 0.2 * h.y;
        float d = length(g - o);
        vec3 bcol = h.y > 0.6 ? lin(vec3(1.0, 0.7, 0.35)) : lin(vec3(0.5, 0.75, 1.0));
        bok += bcol * sstep(r, r * 0.6, d) * (0.14 + 0.06 * sin(T * 0.3 + h.x * 30.0));
      }
    }
    // Rain on the glass: drops sliding down at their own pace, each with a
    // faint trail. Slow — this is a quiet evening, not a storm.
    vec2 rq = vec2(p.x * 28.0, p.y * 6.0);
    float colI = floor(rq.x);
    float rh = hash11(colI);
    float yy = fract(p.y * 1.3 + T * (0.03 + 0.04 * rh) + rh * 7.0);
    float drop = fill(length(vec2((fract(rq.x) - 0.5) * 0.035, (yy - 0.5) * 0.18)) - 0.006, 0.003) * step(0.35, rh);
    float trail = sstep(0.5, 0.95, yy) * fill(abs(fract(rq.x) - 0.5) - 0.06, 0.05) * step(0.35, rh) * 0.25;
    vec3 glassC = night + bok + lin(vec3(0.6, 0.7, 0.9)) * (drop * 0.18 + trail * 0.06);
    float inGlass = fill(sdBox(p - vec2(winX + 0.5, 0.08), vec2(0.5 - 0.012, 0.36)), 0.002);
    col = mix(col, lin(vec3(0.05, 0.05, 0.06)), frame * step(winX - 0.012, p.x) * step(p.y, 0.45) * step(-0.29, p.y));
    col = mix(col, vec3(0.0), inGlass);
    emit += glassC * inGlass;
    recv *= 1.0 - inGlass;
  }

  // ---- the counter, its screens, and a cup
  float top = -0.30;
  if (p.y < top) {
    vec3 wood = lin(vec3(0.30, 0.18, 0.11)) * (0.7 + 0.3 * noise(vec2(p.x * 6.0, p.y * 90.0)));
    col = wood * (light * 0.8 + 0.04);
    col += lin(vec3(0.85, 0.65, 0.40)) * fill(abs(p.y - top + 0.004) - 0.003, 0.002) * 0.25;
    recv = 0.4;
  }
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    vec2 sc = vec2(-HX * 0.88 + 0.085 + fk * 0.20, top + 0.085);
    // A narrow (upright) frame has room for fewer screens.
    if (sc.x + 0.085 > winX - 0.02) continue;
    vec2 sq = p - sc;
    float bez = fill(sdBox(sq, vec2(0.085, 0.058)), 0.002);
    float scr = fill(sdBox(sq, vec2(0.078, 0.051)), 0.002);
    float stand = fill(sdBox(sq + vec2(0.0, 0.07), vec2(0.006, 0.014)), 0.002);
    col = mix(col, lin(vec3(0.04)), max(bez, stand));
    // Code: rows of "words", scrolling up a line at a time.
    vec2 cq = (sq + vec2(0.078, 0.051)) * vec2(1.0, 1.0);
    float row = cq.y * 150.0 + T * (0.8 + 0.3 * fk);
    float ri = floor(row);
    float indent = floor(hash11(ri + fk * 31.0) * 4.0) * 0.008;
    float wlen = 0.03 + 0.09 * hash11(ri * 1.3 + fk);
    float x = cq.x - 0.006 - indent;
    float word = step(0.0, x) * step(x, wlen) * step(0.3, fract(x * 28.0 + hash11(ri)));
    float gl = word * sstep(0.15, 0.3, fract(row)) * sstep(0.85, 0.7, fract(row));
    vec3 tc = hash11(ri * 7.0 + fk) > 0.7 ? lin(vec3(1.0, 0.75, 0.35)) : lin(vec3(0.45, 0.95, 0.75));
    vec3 screen = lin(vec3(0.05, 0.09, 0.16)) + tc * gl * 0.55;
    col = mix(col, vec3(0.0), scr);
    emit += screen * scr;
    // Glow on the counter below.
    if (p.y < top) emit += lin(vec3(0.25, 0.45, 0.70)) * exp(-length((p - vec2(sc.x, top)) * vec2(1.0, 3.0)) * 12.0) * 0.06;
  }
  // A cup on the counter, and its steam — which bends when you move.
  vec2 cupP = vec2(winX - 0.05, top);
  vec2 cq2 = p - cupP;
  float mug = fill(sdBox(cq2 - vec2(0.0, 0.022), vec2(0.018, 0.022)), 0.002);
  float handle = fill(abs(length(cq2 - vec2(0.022, 0.024)) - 0.010) - 0.003, 0.002) * step(0.018, cq2.x);
  col = mix(col, lin(vec3(0.85, 0.82, 0.78)) * (light * 0.9 + 0.08), max(mug, handle));
  vec2 st = cq2 - vec2(0.0, 0.05) + stir(p, 0.03);
  float rise = st.y;
  float wisp = fbm3(vec2(st.x * 30.0 + sin(rise * 25.0 - T * 0.9) * 0.6, rise * 10.0 - T * 0.5));
  float steam = sstep(0.55, 0.85, wisp) * exp(-abs(st.x + 0.01 * sin(rise * 20.0 + T)) * 60.0) *
                sstep(0.0, 0.02, rise) * sstep(0.16, 0.04, rise);
  col += lin(vec3(0.75)) * steam * 0.18 * (0.3 + light.r);
  return vec4(col, recv);
}
`;

  // --- the mountain ---------------------------------------------------------
  //
  // A clear morning over a range: snow on the far peaks, each ridge hazier than
  // the one in front of it, faces lit from your light's side. Mist drifts along
  // the valleys, thin cirrus overhead, one bird circling far off, and a line of
  // pines close by. Nothing here is near enough to take your shadow.
  var MOUNTAIN = `
// A range: the highest of a few jittered tent-shaped peaks, which is what a
// skyline of real summits looks like from far off. xi/hi are the dominant
// peak's position and height, for the light and the snow.
float rangeY(float x, float seed, float spacing, float hs, out float xi, out float hi) {
  float c = floor(x / spacing);
  float best = -1e3;
  xi = 0.0; hi = 0.0;
  for (int i = -2; i <= 2; i++) {
    float ci = c + float(i);
    float h1 = hash11(ci * 1.37 + seed), h2 = hash11(ci * 2.71 + seed * 1.3), h3 = hash11(ci * 0.91 + seed * 2.1);
    float px = (ci + 0.5 + (h1 - 0.5) * 0.7) * spacing;
    float ph = hs * (0.45 + 0.55 * h2);
    float sl = x < px ? (0.7 + 0.5 * h3) : (0.85 + 0.5 * (1.0 - h3));
    float y = ph - abs(x - px) * sl;
    if (y > best) { best = y; xi = px; hi = ph; }
  }
  return best + hs * 0.10 * (ridged(vec2(x * 9.0 + seed, seed)) - 0.7);
}
// The light on a face: which side of its summit, and the gullies that run
// down from it — radial, as they do on a real peak.
float faceLight(vec2 p, float xi, float top, float seed, float k) {
  float right = sstep(-0.012, 0.012, p.x - xi);
  vec2 sp = p - vec2(xi, top);
  float ang = atan(sp.x, -sp.y);
  float r = length(sp);
  float g0 = ridged(vec2(ang * 10.0 + seed, r * 9.0));
  float g1 = ridged(vec2((ang + 0.02) * 10.0 + seed, r * 9.0));
  return mix(0.38, 1.0, right * (0.35 + 0.65 * KEY) + (1.0 - KEY) * 0.3) + (g1 - g0) * k;
}
// A conifer: a stack of drooping tiers, narrowing to a point.
float pine(vec2 q, float h) {
  if (q.y < 0.0 || q.y > h) return 0.0;
  float t = q.y / h;
  float tier = fract(t * 8.0 + 0.3);
  float w = h * 0.27 * (1.0 - t) * (0.62 + 0.38 * tier) * (0.9 + 0.1 * noise(q * 300.0));
  return fill(abs(q.x) - w, 0.0025);
}
vec4 scene(vec2 p, out vec3 emit) {
  emit = vec3(0.0);
  vec3 sunCol = lin(vec3(1.0, 0.94, 0.84));
  vec2 sunP = vec2(HX * 0.85, 0.56 + 0.12 * ELEV);
  // ---- sky
  float sy = clamp((p.y + 0.05) / 0.55, 0.0, 1.0);
  vec3 skyTop = mix(lin(vec3(0.30, 0.52, 0.80)), lin(vec3(0.22, 0.26, 0.48)), NIGHT * 0.7);
  vec3 skyLow = mix(lin(vec3(0.86, 0.91, 0.95)), lin(vec3(0.98, 0.72, 0.56)), NIGHT * 0.7);
  vec3 sky = mix(skyLow, skyTop, pow(sy, 0.8));
  float sd = length(p - sunP);
  sky += sunCol * (0.45 * exp(-sd * 3.5) + 0.12 * exp(-sd)) * (0.3 + 0.7 * KEY);
  float ci = fbm(vec2(p.x * 1.2 + T * 0.004, p.y * 9.0));
  sky = mix(sky, lin(vec3(0.98)), sstep(0.55, 0.8, ci) * sstep(0.15, 0.38, p.y) * 0.35);
  vec3 col = sky;
  vec3 haze = mix(skyLow, skyTop, 0.3);

  // ---- a bird, circling far off
  vec2 bq = p - vec2(-HX * 0.35 + 0.16 * cos(T * 0.06), 0.32 + 0.03 * sin(T * 0.12));
  bq *= rot(0.15 * sin(T * 0.06));
  float wing = abs(bq.y - 0.30 * abs(bq.x) + 6.0 * bq.x * bq.x) - 0.0011;
  float bird = fill(max(wing, abs(bq.x) - 0.011), 0.001);
  col = mix(col, lin(vec3(0.15, 0.15, 0.17)), bird * 0.7);

  // ---- the far range, snow-capped
  float xi, hi, xs, hs2;
  float y0 = rangeY(p.x, 3.0, 0.42, 0.30, xi, hi);
  float y0b = rangeY(p.x, 9.0, 0.23, 0.13, xs, hs2) - 0.02;
  // Lesser summits in the saddles; lit and snowed as part of the big one.
  y0 = max(y0, y0b);
  y0 += 0.03;
  if (p.y < y0 + 0.003) {
    float lit = faceLight(p, xi, 0.03 + hi, 3.0, 1.4);
    vec3 rock = lin(vec3(0.50, 0.55, 0.66)) * lit;
    float snowLine = 0.03 + hi - 0.10 - 0.06 * fbm3(vec2(p.x * 10.0, 2.0)) + 0.02 * sin((p.x - xi) * 40.0);
    float snow = sstep(snowLine - 0.008, snowLine + 0.01, p.y);
    vec3 sc = mix(lin(vec3(0.64, 0.72, 0.88)), lin(vec3(1.0, 0.98, 0.95)), clamp(lit, 0.0, 1.0));
    vec3 c = mix(rock, sc, snow);
    c = mix(c, haze, 0.36);
    col = mix(col, c, fill(p.y - y0, 0.002));
  }
  // ---- the middle range: lower, darker, forest climbing it
  float y1 = -0.07 + rangeY(p.x, 17.0, 0.30, 0.15, xi, hi);
  if (p.y < y1 + 0.003) {
    float lit = faceLight(p, xi, -0.07 + hi, 7.0, 1.2);
    vec3 rock = lin(vec3(0.36, 0.40, 0.44));
    float forest = sstep(y1 - 0.03, y1 - 0.08, p.y + 0.025 * noise(vec2(p.x * 24.0, 5.0)));
    vec3 trees = lin(vec3(0.14, 0.24, 0.17)) * (0.8 + 0.4 * noise(p * vec2(160.0, 90.0)));
    vec3 c = mix(rock, trees, forest) * lit;
    float snow = sstep(-0.07 + hi - 0.04, -0.07 + hi - 0.02, p.y) * step(0.10, hi);
    c = mix(c, lin(vec3(0.95, 0.96, 0.97)) * lit, snow * 0.8);
    c = mix(c, haze, 0.16);
    col = mix(col, c, fill(p.y - y1, 0.002));
  }
  // Mist lying in the valley, drifting.
  float m = fbm(vec2(p.x * 2.2 + T * 0.012, p.y * 9.0 + 3.0));
  float band = exp(-sq((p.y + 0.17) * 11.0));
  col = mix(col, mix(haze, lin(vec3(0.96, 0.97, 0.98)), 0.6), sstep(0.35, 0.75, m) * band * 0.6);

  // ---- forested foothills
  float y2 = -0.21 + 0.035 * sin(p.x * 3.1 + 0.7) + 0.02 * sin(p.x * 7.3 + 2.0) + 0.012 * fbm3(vec2(p.x * 12.0, 3.0));
  if (p.y < y2 + 0.003) {
    float crown = noise(vec2(p.x * 160.0, p.y * 90.0));
    float lit = 0.75 + 0.25 * KEY * (0.5 + 0.5 * sin(p.x * 3.1 + 0.7 + 1.57)) + 0.2 * (crown - 0.5);
    vec3 c = lin(vec3(0.15, 0.27, 0.16)) * lit;
    c = mix(c, haze, 0.10);
    float edge = y2 + 0.004 * step(0.5, noise(vec2(p.x * 220.0, 1.0)));
    col = mix(col, c, fill(p.y - edge, 0.0015));
  }
  // ---- the alpine meadow in front
  float y3 = -0.37 + 0.04 * sin(p.x * 1.4 - 0.4);
  if (p.y < y3 + 0.003) {
    float lit = 0.8 + 0.2 * KEY + 0.08 * (fbm3(p * vec2(20.0, 60.0)) - 0.5);
    vec3 c = mix(lin(vec3(0.42, 0.58, 0.26)), lin(vec3(0.30, 0.45, 0.18)), sstep(y3, -0.5, p.y)) * lit;
    col = mix(col, c, fill(p.y - y3, 0.002));
  }
  // ---- pines framing the view, on both edges, swaying a hair
  for (int k = 0; k < 6; k++) {
    float fk = float(k);
    float sideK = k < 3 ? -1.0 : 1.0;
    float j = mod(fk, 3.0);
    // Smaller in a narrow frame, or they would be all of it.
    float sc = clamp(HX / 0.889, 0.5, 1.0);
    float px = sideK * (HX - (0.03 + j * 0.075 + 0.03 * hash11(fk)) * sc);
    float h = (0.62 - j * 0.14 + 0.08 * hash11(fk * 3.0)) * sc;
    vec2 q = p - vec2(px, -0.52);
    q.x -= (0.004 * sin(T * 0.6 + fk) + 0.01 * MOTION * sin(T * 2.0 + fk)) * (q.y / h) * (q.y / h);
    float tr = pine(q, h);
    float tierT = fract(q.y / h * 8.0 + 0.3);
    vec3 pc = lin(vec3(0.08, 0.17, 0.10)) * (0.7 + 0.35 * KEY * step(0.0, q.x) + 0.25 * tierT + 0.1 * j);
    col = mix(col, pc, tr);
  }
  return vec4(col, 0.0);
}
`;

  // --- the countryside ------------------------------------------------------
  //
  // Rolling farmland under fair-weather cumulus: a patchwork of fields with
  // hedgerows between them, a farmhouse on the far slope, wind running across
  // the wheat in slow waves, and long grass and a few wild flowers close by,
  // stirring when you move.
  var COUNTRYSIDE = `
// Voronoi: distance to the nearest cell centre and to the border with the next.
vec3 voronoi(vec2 x) {
  vec2 n = floor(x), f = fract(x);
  float d1 = 8.0, d2 = 8.0;
  vec2 id = vec2(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash22(n + g) * 0.8 + 0.1;
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; id = n + g; }
      else if (d < d2) { d2 = d; }
    }
  }
  return vec3(sqrt(d2) - sqrt(d1), hash12(id), hash12(id + 7.7));
}
// One layer of grass blades: tapering strokes leaning on the wind.
float blades(vec2 p, float scale, float baseY, float hgt, float seed, out float tipT) {
  float x = p.x * scale;
  float ci = floor(x);
  float cover = 0.0;
  tipT = 0.0;
  for (int i = -1; i <= 1; i++) {
    float c = ci + float(i);
    float h = hash11(c * 1.31 + seed);
    float bh = hgt * (0.5 + 0.5 * hash11(c * 2.17 + seed));
    float t = (p.y - baseY) / bh;
    if (t < 0.0 || t > 1.0) continue;
    float bx = (c + 0.5 + (h - 0.5) * 0.9) / scale;
    float wind = (0.010 * sin(T * 0.9 + c * 0.37) + 0.008 * sin(T * 0.45 + p.x * 3.0)) * (1.0 + 2.5 * MOTION);
    float lean = ((hash11(c * 3.7 + seed) - 0.5) * 0.5 * bh + wind) * t * t;
    float w = 0.42 / scale * (1.0 - t * 0.92);
    float cv = fill(abs(p.x - bx - lean) - w, 0.18 / scale);
    if (cv > cover) { cover = cv; tipT = t; }
  }
  return cover;
}
vec4 scene(vec2 p, out vec3 emit) {
  emit = vec3(0.0);
  vec3 sunCol = lin(vec3(1.0, 0.95, 0.85));
  vec2 sunP = vec2(HX * 0.85, 0.62 + 0.1 * ELEV);
  // ---- sky and cumulus, lit from the sun's side
  float sy = clamp((p.y + 0.05) / 0.55, 0.0, 1.0);
  vec3 sky = mix(lin(vec3(0.85, 0.91, 0.96)), lin(vec3(0.38, 0.62, 0.88)), pow(sy, 0.75));
  float sd = length(p - sunP);
  sky += sunCol * (0.35 * exp(-sd * 3.5) + 0.12 * exp(-sd)) * (0.3 + 0.7 * KEY);
  vec2 cq = vec2(p.x * 1.8 + T * 0.007, p.y * 3.2);
  float hgt = sstep(0.04, 0.24, p.y);
  float dens = fbm(cq) * hgt - (1.0 - hgt) * 0.3;
  float dens2 = fbm(cq + normalize(sunP - p) * 0.12) * hgt - (1.0 - hgt) * 0.3;
  float cl = sstep(0.44, 0.62, dens);
  float shade = clamp(0.65 + (dens - dens2) * 3.5, 0.4, 1.0);
  sky = mix(sky, mix(lin(vec3(0.68, 0.73, 0.80)), lin(vec3(1.0, 0.99, 0.97)), shade), cl * 0.95);
  vec3 col = sky;
  vec3 haze = lin(vec3(0.76, 0.84, 0.88));

  // ---- the far hills
  float yf = 0.03 + 0.03 * sin(p.x * 2.3 + 1.0) + 0.018 * sin(p.x * 5.3 + 2.0) + 0.01 * fbm3(vec2(p.x * 6.0, 1.0));
  vec3 farC = mix(lin(vec3(0.36, 0.52, 0.30)), haze, 0.5) * (0.92 + 0.12 * fbm3(p * vec2(40.0, 80.0)));
  col = mix(col, farC, fill(p.y - yf, 0.002));

  // ---- the patchwork slope: fields, hedgerows, trees along them
  float ym = -0.06 + 0.05 * sin(p.x * 1.6 + 0.3) + 0.018 * sin(p.x * 4.1);
  if (p.y < ym + 0.004) {
    float gy = max(ym - p.y, 0.0);
    float persp = 1.0 + gy * 10.0;
    vec2 g = vec2(p.x * 11.0 / persp, gy * 38.0 / persp);
    g.x += 0.25 * sin(g.y * 1.7);
    vec3 v = voronoi(g);
    float h = v.y;
    vec3 fieldC = h < 0.30 ? lin(vec3(0.40, 0.62, 0.20)) :
                  h < 0.52 ? lin(vec3(0.58, 0.72, 0.26)) :
                  h < 0.72 ? lin(vec3(0.92, 0.80, 0.40)) :
                  h < 0.92 ? lin(vec3(0.32, 0.54, 0.18)) :
                             lin(vec3(0.74, 0.60, 0.36));
    float a = v.z * 3.1416;
    float rows = 0.9 + 0.1 * sin(dot(g, vec2(cos(a), sin(a))) * 60.0);
    // Wind running across the wheat in slow waves.
    float wheat = step(0.52, h) * step(h, 0.72);
    float gust = 0.12 * wheat * sin(p.x * 6.0 - T * 0.55 + gy * 20.0 + fbm3(p * 5.0) * 2.0);
    vec3 fc = fieldC * rows * (1.0 + gust);
    float hw = 0.03;
    float hedge = fill(v.x - hw, hw * 0.5);
    // Trees: clumps sitting on the hedgerows.
    float clump = sstep(0.62, 0.72, noise(g * 4.0 + 3.0)) * fill(v.x - hw * 3.0, hw);
    vec3 hc = lin(vec3(0.13, 0.25, 0.09)) * (0.8 + 0.3 * KEY * noise(g * 30.0));
    fc = mix(fc, hc, max(hedge, clump));
    fc *= 0.82 + 0.25 * KEY * (0.5 + 0.5 * cos(p.x * 1.6 + 0.3));
    fc = mix(fc, haze, (1.0 - sstep(0.0, 0.18, gy)) * 0.30);
    col = mix(col, fc, fill(p.y - ym, 0.0015));
  }
  // ---- the farmhouse on the slope
  float hx0 = -HX * 0.48;
  vec2 hp = p - vec2(hx0, -0.07 + 0.05 * sin(hx0 * 1.6 + 0.3) + 0.018 * sin(hx0 * 4.1));
  float walls = fill(sdBox(hp - vec2(0.0, 0.010), vec2(0.022, 0.010)), 0.0012);
  float roof = fill(max(hp.y - 0.034 + abs(hp.x) * 0.55, 0.019 - hp.y), 0.0012) * step(abs(hp.x), 0.028);
  col = mix(col, lin(vec3(0.94, 0.92, 0.86)) * (0.7 + 0.3 * KEY), walls);
  col = mix(col, lin(vec3(0.58, 0.26, 0.18)) * (0.8 + 0.2 * KEY), roof);

  // ---- the meadow in front: dense grass, three layers of blades, flowers
  float yg = -0.30 + 0.025 * sin(p.x * 2.0 + 0.5);
  if (p.y < yg + 0.16) {
    float ground = fill(p.y - yg, 0.004);
    vec3 gc = mix(lin(vec3(0.30, 0.46, 0.15)), lin(vec3(0.16, 0.30, 0.08)), sstep(yg, -0.5, p.y));
    gc *= 0.85 + 0.25 * fbm3(vec2(p.x * 160.0, p.y * 30.0));
    col = mix(col, gc * (0.8 + 0.25 * KEY), ground);
    float t1, t2, t3;
    float b1 = blades(p, 260.0, yg - 0.010, 0.050, 1.0, t1);
    vec3 c1 = mix(lin(vec3(0.30, 0.46, 0.16)), lin(vec3(0.62, 0.72, 0.32)), t1) * (0.8 + 0.25 * KEY);
    col = mix(col, c1, b1);
    // Flowers on the back layer, nodding in the same wind.
    float fx = p.x * 26.0;
    float fi = floor(fx);
    float fh = hash11(fi * 5.3);
    if (fh > 0.45) {
      vec2 fp = vec2((fi + 0.5 + (hash11(fi) - 0.5) * 0.6) / 26.0, yg + 0.035 + 0.035 * hash11(fi * 2.1));
      float nod = (0.006 * sin(T * 0.8 + fi) + 0.004 * sin(T * 0.45 + fp.x * 3.0)) * (1.0 + 2.5 * MOTION);
      float stem = fill(abs(p.x - fp.x - nod * (p.y - yg) / (fp.y - yg)) - 0.0012, 0.0008) * step(yg, p.y) * step(p.y, fp.y);
      fp.x += nod;
      float head = fill(length((p - fp) * vec2(1.0, 1.3)) - 0.0065, 0.0018);
      vec3 fcol = fh > 0.85 ? lin(vec3(0.97, 0.97, 0.94)) : fh > 0.68 ? lin(vec3(0.98, 0.80, 0.22)) : lin(vec3(0.66, 0.48, 0.88));
      col = mix(col, lin(vec3(0.30, 0.45, 0.16)), stem);
      col = mix(col, fcol * (0.75 + 0.3 * KEY), head);
    }
    float b2 = blades(p, 150.0, yg - 0.05, 0.090, 2.0, t2);
    vec3 c2 = mix(lin(vec3(0.20, 0.36, 0.10)), lin(vec3(0.55, 0.68, 0.28)), t2) * (0.75 + 0.3 * KEY);
    col = mix(col, c2, b2);
    float b3 = blades(p, 75.0, -0.56, 0.17, 3.0, t3);
    vec3 c3 = mix(lin(vec3(0.12, 0.24, 0.06)), lin(vec3(0.42, 0.58, 0.20)), t3) * (0.7 + 0.3 * KEY);
    col = mix(col, c3, b3);
  }
  // Pollen drifting in the light, swirling as you move.
  emit += sunCol * specks(p + stir(p, 0.05), 22.0, 0.07, 0.01) * sstep(-0.35, 0.0, p.y) * sstep(0.2, -0.05, p.y) * KEY * 0.05;
  return vec4(col, 0.0);
}
`;

  var SOURCES = {
    office: OFFICE, island: ISLAND, cybercafe: CAFE, mountain: MOUNTAIN, countryside: COUNTRYSIDE
  };

  // The common entry point. `scene()` is authored with the key light on the
  // right; this mirrors it for a light on the left, and while the light is
  // moving sides, draws both and crossfades — the room turns, it never jumps.
  var MAIN = `
vec4 shade(vec2 p, float m, out vec3 e) {
  SUBJ.x = (uSubject.x - 0.5) * 2.0 * HX * m;
  return scene(vec2(p.x * m, p.y), e);
}
void main() {
  vec2 uv = vUv;
  HX = 0.5 * uRes.x / uRes.y;
  PX = 1.0 / uRes.y;
  vec2 p = vec2((uv.x - 0.5) * 2.0 * HX, uv.y - 0.5);
  T = uTime;
  KEY = clamp(uLook.x, 0.0, 1.0);
  ELEV = clamp(uLook.y, -1.0, 1.0);
  MOTION = clamp(uLook.z, 0.0, 1.0);
  NIGHT = sstep(0.62, 0.28, uExposure);
  SUBJ = vec2(0.0, uSubject.y - 0.5);
  SUBJR = uSubject.zw * vec2(2.0 * HX, 1.0);
  vec3 e1, e2;
  vec4 c;
  if (uSideMix >= 0.999) c = shade(p, 1.0, e1);
  else if (uSideMix <= 0.001) c = shade(p, -1.0, e1);
  else {
    vec4 a = shade(p, 1.0, e1);
    vec4 b = shade(p, -1.0, e2);
    c = mix(b, a, uSideMix);
    e1 = mix(e2, e1, uSideMix);
  }
  // Lit surfaces take the room's exposure and colour; light sources (a lamp,
  // a screen, the sky through a window) are bright in a dark room as well.
  vec3 lit = c.rgb * uTint * uExposure + e1 * mix(1.0, uExposure, 0.35);
  outColor = vec4(sqrt(clamp(lit, 0.0, 1.0)), c.a);
}
`;

  function fragmentSource(id) {
    id = resolveId(id);
    return id ? HEADER + SOURCES[id] + MAIN : null;
  }

  // --- drawing --------------------------------------------------------------
  //
  // A tiny renderer that owns nothing: it is handed a GL context, a program and
  // a framebuffer, and sets the uniforms a scene reads. video-effects.js calls
  // it once per scene frame; the thumbnails call it once per chip.

  var VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }
`;

  // Compiling is split in two so it can happen off the page's thread. Start
  // it, then — once the driver says it is done — check it and look up the
  // uniforms. Checking a status right after linkProgram() is exactly what
  // forces the driver to finish synchronously, so the start does not.
  function startProgram(gl, id) {
    var src = fragmentSource(id);
    if (!src) throw new Error('unknown scene ' + id);
    function sh(type, text) {
      var o = gl.createShader(type);
      gl.shaderSource(o, text);
      gl.compileShader(o);
      return o;
    }
    var vs = sh(gl.VERTEX_SHADER, VERT), fs = sh(gl.FRAGMENT_SHADER, src);
    var p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    return { program: p, vs: vs, fs: fs, id: id };
  }

  function finishProgram(gl, job) {
    var p = job.program;
    var ok = gl.getProgramParameter(p, gl.LINK_STATUS);
    var log = ok ? '' : (gl.getShaderInfoLog(job.fs) || gl.getShaderInfoLog(job.vs) ||
                         gl.getProgramInfoLog(p) || 'link failed');
    gl.deleteShader(job.vs); gl.deleteShader(job.fs);
    if (!ok) {
      gl.deleteProgram(p);
      throw new Error('scene ' + job.id + ': ' + log);
    }
    var names = ['uRes', 'uTime', 'uSideMix', 'uLook', 'uTint', 'uExposure', 'uSubject'];
    var loc = {};
    names.forEach(function (n) { loc[n] = gl.getUniformLocation(p, n); });
    return { program: p, loc: loc, id: job.id };
  }

  // Synchronous: blocks until the driver has compiled. Throws on failure.
  function compileProgram(gl, id) {
    return finishProgram(gl, startProgram(gl, id));
  }

  // The same, without stalling the page. A scene's shader is a few hundred
  // lines with loops in it, and on some platforms (ANGLE over Direct3D, a
  // software GPU) compiling one takes long enough to freeze a call's video for
  // a visible moment. With KHR_parallel_shader_compile the driver compiles on
  // its own threads and we poll; without it, the compile still happens, just
  // in its own task.
  function compileProgramAsync(gl, id) {
    var ext = null;
    try { ext = gl.getExtension('KHR_parallel_shader_compile'); } catch (e) { ext = null; }
    var job;
    try { job = startProgram(gl, id); } catch (e) { return Promise.reject(e); }
    return new Promise(function (resolve, reject) {
      (function poll() {
        if (gl.isContextLost && gl.isContextLost()) { reject(new Error('context lost')); return; }
        if (ext && !gl.getProgramParameter(job.program, ext.COMPLETION_STATUS_KHR)) {
          setTimeout(poll, 16);
          return;
        }
        try { resolve(finishProgram(gl, job)); } catch (e) { reject(e); }
      })();
    });
  }

  // Set a scene's uniforms. The caller has bound the target framebuffer and
  // viewport, and draws the full-screen triangle afterwards.
  function setUniforms(gl, prog, w, h, time, look) {
    var L = prog.loc;
    gl.useProgram(prog.program);
    gl.uniform2f(L.uRes, w, h);
    gl.uniform1f(L.uTime, time);
    gl.uniform1f(L.uSideMix, look.sideMix);
    gl.uniform3f(L.uLook, Math.min(1, Math.abs(look.dirX)), look.dirY, look.motion);
    gl.uniform3f(L.uTint, look.tint[0], look.tint[1], look.tint[2]);
    gl.uniform1f(L.uExposure, look.exposure);
    // y up, like the scene.
    gl.uniform4f(L.uSubject, look.cx, 1 - look.cy, look.sx, look.sy);
  }

  // --- thumbnails -----------------------------------------------------------
  //
  // Rendered from the shaders themselves, so a chip shows exactly the room it
  // picks — in a neutral light, at a fixed moment. One small offscreen context,
  // used for all five and released as soon as they are done: a page may hold
  // only a handful of live WebGL contexts and the camera pipeline needs one.
  var THUMB_W = 160, THUMB_H = 90, THUMB_TIME = 37.0;
  var _thumbs = {};
  var _thumbPending = null;

  // An OffscreenCanvas where there is one: its convertToBlob() reads the
  // picture back without blocking the page, where toDataURL() waits on the
  // GPU — which on a software GPU means waiting for the shaders to be JIT-
  // compiled on the CPU first.
  function thumbCanvas() {
    if (typeof OffscreenCanvas === 'function') {
      try {
        var oc = new OffscreenCanvas(THUMB_W, THUMB_H);
        var g = oc.getContext('webgl2', { alpha: false, antialias: false });
        if (g) return { canvas: oc, gl: g };
      } catch (e) { /* fall through to a DOM canvas */ }
    }
    try {
      var c = document.createElement('canvas');
      c.width = THUMB_W; c.height = THUMB_H;
      var gl = c.getContext('webgl2', { alpha: false, preserveDrawingBuffer: true, antialias: false });
      if (gl) return { canvas: c, gl: gl };
    } catch (e) { /* no WebGL2 at all */ }
    return null;
  }

  function snapshot(canvas) {
    if (typeof canvas.convertToBlob === 'function') {
      return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
        .then(function (blob) { return URL.createObjectURL(blob); });
    }
    return Promise.resolve(canvas.toDataURL('image/jpeg', 0.85));
  }

  function thumbnails() {
    if (_thumbPending) return _thumbPending;
    _thumbPending = new Promise(function (resolve) {
      var t = thumbCanvas();
      if (!t) { resolve(_thumbs); return; }
      var gl = t.gl;
      var buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      var look = defaultLook();
      look.dirX = 0.6; look.cx = 0.5; look.cy = 0.7; look.sx = 0.25; look.sy = 0.35;
      // All five start compiling at once (in parallel, where the driver can);
      // they are drawn and read back one at a time, so no picture can be read
      // back over the next one's draw.
      var progs = SCENES.map(function (s) {
        return compileProgramAsync(gl, s.id).catch(function () { return null; });
      });
      var chain = Promise.resolve();
      SCENES.forEach(function (s, i) {
        chain = chain.then(function () { return progs[i]; }).then(function (prog) {
          if (!prog) return null;   // the swatch stays
          gl.viewport(0, 0, THUMB_W, THUMB_H);
          setUniforms(gl, prog, THUMB_W, THUMB_H, THUMB_TIME, look);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          gl.deleteProgram(prog.program);
          return snapshot(t.canvas).then(function (url) { _thumbs[s.id] = url; });
        }).catch(function () { /* the swatch stays */ });
      });
      chain.then(function () {
        try { gl.deleteBuffer(buf); } catch (e) { /* ignore */ }
        var lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
        resolve(_thumbs);
      });
    });
    return _thumbPending;
  }

  return {
    SCENES: SCENES,
    LEGACY: LEGACY,
    byId: byId,
    resolveId: resolveId,
    fragmentSource: fragmentSource,
    compileProgram: compileProgram,
    compileProgramAsync: compileProgramAsync,
    setUniforms: setUniforms,
    thumbnails: thumbnails,
    THUMB_TIME: THUMB_TIME,
    defaultLook: defaultLook,
    measureSubject: measureSubject,
    lookFromStats: lookFromStats,
    easeLook: easeLook,
    _lookConfig: {
      refLuma: LOOK_REF_LUMA, expMin: LOOK_EXP_MIN, expMax: LOOK_EXP_MAX,
      sideFlip: LOOK_SIDE_FLIP, tintMin: LOOK_TINT_MIN, tintMax: LOOK_TINT_MAX
    }
  };
})();
