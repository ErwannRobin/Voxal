// video-scenes.js — the animated virtual backgrounds: five small 3D worlds, a
// room and four places, that the camera pipeline in video-effects.js draws
// behind you.
//
// Loaded as a plain classic script by BOTH index.html and settings.html, BEFORE
// video-effects.js (which reads VideoScenes when it is built). It declares
// exactly one global, `VideoScenes`.
//
// ---------------------------------------------------------------------------
// What a scene is
// ---------------------------------------------------------------------------
//
// One fragment shader, and what it draws is a world rather than a picture of
// one: a pinhole camera looks into geometry — a ray-marched heightfield, signed-
// distance furniture, analytic planes and triangles — that is lit the way a
// camera would see it. A sun and a sky from a single-scattering atmosphere, a
// room's window as an area light, lamps with real fall-off; soft shadows,
// ambient occlusion, reflection and refraction in water and glass, light
// through leaves, ray-marched cumulus that shade their own undersides, haze
// that thickens with distance, and last a camera's own shoulder and tone curve.
//
// No image, no model, no font, nothing downloaded: every wall, cloud and leaf
// is computed from the pixel's position and the time. That is a requirement,
// not a stylistic choice — it costs nothing to ship, there is no artwork to
// license, and it is what lets the scene be relit to match YOU, which a
// photograph can never be. (The one table a scene reads, a lattice of random
// bytes, is generated here from a fixed seed — see noiseTexture().)
//
// Each scene is drawn the same way:
//
//   * in linear light, with its key light (window, sun, lamp) placed on the
//     side the camera says YOUR light is coming from. The world is authored
//     with the key light on +x and mirrored when it is on the left, so a window
//     never appears on the side your face is in shadow;
//   * scaled to your exposure and tinted by your room's white balance, so a
//     dim warm room gets a dim warm office rather than a sunlit one pasted
//     behind a face lit by a desk lamp. A dark enough room turns the scene to
//     evening — the sun goes down over the island, the lamp comes on in the
//     office, the city lights come on outside the café's window;
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
// sunbeam swirls, fronds and leaves stir, steam bends.
//
// Every texture a scene has is finer than the pixels it is drawn to, so each is
// faded out by how much of the world one pixel covers (a "footprint") instead
// of being sampled below its own wavelength: that is what turns water, grass
// and brick into a soft, stable picture rather than a shimmer.
//
// The scene is ray-marched into a small buffer (a fraction of 512 on its long
// side, per scene), because each of its pixels is a whole march; the
// ray-marched landscapes cost the most, so they are drawn smaller and less
// often (`res`, `hz` in the catalogue). It is not shown stretched: each redraw
// looks through a different point of its pixels, and the redraws are added up
// into a picture at the camera's own size (RESOLVE_FRAG), so a room that holds
// still is as sharp as the person in front of it.

var VideoScenes = (function () {
  'use strict';

  // --- the catalogue --------------------------------------------------------
  //
  // shadow: how dark your shadow gets on the scene's near surfaces (0 = the
  //         scene has none — everything in it is far away).
  // wrap:   how much of the scene's light spills onto your outline.
  // res:    the scene's buffer, as a fraction of the pipeline's (see
  //         SCENE_LONG in video-effects.js). The ray-marched landscapes are
  //         the dearest scenes to draw and the softest to look at.
  // hz:     how often it is redrawn, and what that falls to under load. Its
  //         motion is slow, so a dear scene is redrawn less often, not made
  //         to look less.
  // swatch: what the chip shows until its real thumbnail has been rendered,
  //         and where WebGL2 is not available to render one at all.
  var SCENES = [
    { id: 'office', label: 'Office', shadow: 0.55, wrap: 0.22, res: 0.85, hz: [12, 6],
      swatch: 'linear-gradient(120deg,#d9d0c3 0%,#e8e1d6 55%,#a9c3da 100%)' },
    { id: 'island', label: 'Island', shadow: 0.30, wrap: 0.36, res: 0.80, hz: [10, 5],
      swatch: 'linear-gradient(180deg,#7fb2df 0%,#cfe6ef 48%,#3fa3a6 52%,#e9dcbc 100%)' },
    { id: 'cybercafe', label: 'Cyber café', shadow: 0.45, wrap: 0.42, res: 1.0, hz: [15, 8],
      swatch: 'linear-gradient(120deg,#2a1714 0%,#5a2a3c 50%,#1d3550 100%)' },
    { id: 'mountain', label: 'Mountain', shadow: 0, wrap: 0.28, res: 0.70, hz: [10, 5],
      swatch: 'linear-gradient(180deg,#8fb4d9 0%,#e6eef5 45%,#5f7387 70%,#2f4a35 100%)' },
    { id: 'countryside', label: 'Countryside', shadow: 0, wrap: 0.28, res: 0.80, hz: [10, 5],
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
  //
  // The header is everything the scenes share: the camera, the noise, the
  // shapes, the sun and the atmosphere, the clouds. A scene then defines
  // scene(p, emit) — the colour and nearness of what the pixel at p sees, and
  // the light it gives off itself — and MAIN, at the end, does the rest.

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
uniform sampler2D uNoise; // 256 x 256 lattice, four corners to a texel (see noiseTexture)
uniform vec2  uJitter;    // where in its pixel this frame looks, px from the centre (see RESOLVE_FRAG)
uniform float uDetail;    // the height the frames are resolved to, px; 0 = uRes.y
uniform mat3  uView;      // the phone's turn since the room was set up (viewMatrix()); identity = a still camera

float T, KEY, ELEV, MOTION, NIGHT, PX, HX, FOCAL;
float MIR = 1.0;   // -1 while the room is drawn mirrored for a light on the left (shade())
vec2 SUBJ, SUBJR, SEED;

const float PI = 3.14159265359;

// --- colour -----------------------------------------------------------------
// Scenes are authored in sRGB-looking numbers and lit in linear light; the
// last step of main() tone-maps and encodes.
vec3 lin(vec3 c) { return c * (c * (c * 0.305306011 + 0.682171111) + 0.012522878); }
vec3 srgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
// Narkowicz's ACES fit: a soft shoulder, so a sun-lit wall and a cloud's edge
// roll off to white the way a camera's do instead of clipping flat.
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

// --- numbers ----------------------------------------------------------------
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
// Value noise from the lattice table: one fetch returns the cell's four
// corners, the rest is interpolation. Smoothstep-interpolated for the cheap
// one, quintic (with the slope) for terrain.
float noise(vec2 x) {
  vec2 p = floor(x), w = x - p;
  vec4 t = texelFetch(uNoise, ivec2(p) & 255, 0);
  vec2 u = w * w * (3.0 - 2.0 * w);
  return mix(mix(t.r, t.g, u.x), mix(t.b, t.a, u.x), u.y);
}
// A third axis from two layers of the table, each shifted so they are not the
// same field: cheap, and good enough for a cloud.
float noise3(vec3 x) {
  float z = floor(x.z), f = x.z - z;
  vec2 o = vec2(37.0, 17.0) * z;
  return mix(noise(x.xy + o), noise(x.xy + o + vec2(37.0, 17.0)), f * f * (3.0 - 2.0 * f));
}
// Value noise and its slope, quintic-smoothed: what lets a heightfield be
// eroded (damp each octave by the slope accumulated so far) and lit without
// a finite difference. x: value, yz: d/dx, d/dy.
vec3 noised(vec2 x) {
  vec2 p = floor(x), w = x - p;
  vec4 t = texelFetch(uNoise, ivec2(p) & 255, 0);
  vec2 u = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * w * w * (w * (w - 2.0) + 1.0);
  float k1 = t.g - t.r, k2 = t.b - t.r, k4 = t.r - t.g - t.b + t.a;
  return vec3(t.r + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du * (vec2(k1, k2) + k4 * u.yx));
}
float fbm3(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * noise(p); p = p * 2.07 + vec2(11.3, 5.7); a *= 0.5; }
  return s / 0.875;
}
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }

// --- shapes -----------------------------------------------------------------
float sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float sdBox3(vec3 p, vec3 b) { vec3 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, max(d.y, d.z)), 0.0); }
float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}
float sdEllipsoid(vec3 p, vec3 r) {
  float k0 = length(p / r), k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-4);
}
float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}
float sdCylY(vec3 p, float r, float hh) {
  vec2 d = vec2(length(p.xz) - r, abs(p.y) - hh);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}
// Coverage of a signed distance, with a soft edge s wide. Every edge in a
// scene is soft by at least a texel: this is a backdrop, focused past.
float fill(float d, float s) { return 1.0 - sstep(-s, s, d); }

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

// --- the camera -------------------------------------------------------------
// A pinhole, 50 degrees from top to bottom; a narrow (upright) frame widens it
// a little so a phone still sees a room and not a keyhole. World: y up, the
// camera looks down -z, +x is the key light's side (main() mirrors the rest).
//
// uView turns the camera the way the phone has turned, so the room stays where
// it was while the picture moves over it. It is a turn of the PICTURE, so it
// is applied in screen space: a mirrored room (MIR) un-mirrors, turns, mirrors.
vec3 viewFwd(vec3 d) { d.x *= MIR; d = uView * d; d.x *= MIR; return d; }
vec3 viewInv(vec3 d) { d.x *= MIR; d = d * uView; d.x *= MIR; return d; }
// Where the straight-ahead of a still camera lands in the turned picture: what
// a layer drawn in the picture's own plane has to follow.
vec2 viewShift() { vec3 s = viewInv(vec3(0.0, 0.0, -1.0)); return s.xy * FOCAL / max(-s.z, 0.2); }
vec3 camRay(vec2 p, float pitch) {
  vec3 d = normalize(viewFwd(vec3(p.x, p.y, -FOCAL)));
  float c = cos(pitch), s = sin(pitch);
  return vec3(d.x, d.y * c - d.z * s, d.y * s + d.z * c);
}

// --- the sun and the air ----------------------------------------------------
//
// Single scattering through a Rayleigh + Mie atmosphere, integrated per pixel
// (8 samples along the view ray, 3 toward the sun). It is what makes a low sun
// turn the horizon gold and a high one leave the zenith deep blue without
// anyone choosing those colours, and the same function gives the colour of the
// haze a far ridge fades into. Units are kilometres.
vec3 SUN;     // unit vector toward the sun
vec3 SUNC;    // sunlight reaching the ground, linear (a sunrise is already red)
vec3 AMB;     // sky light on an up-facing surface
const float R_EARTH = 6360.0;
const float R_ATM   = 6420.0;
const vec3  BETA_R  = vec3(2.6e-3, 9.5e-3, 33.1e-3);
const float BETA_M  = 5.0e-3;
const float SUN_I   = 18.0;

float atmExit(vec3 o, vec3 d) {
  float b = dot(o, d);
  float c = dot(o, o) - R_ATM * R_ATM;
  return -b + sqrt(max(b * b - c, 0.0));
}

vec3 atmosphere(vec3 rd, float camH) {
  vec3 o = vec3(0.0, R_EARTH + camH, 0.0);
  rd = normalize(vec3(rd.x, max(rd.y, 0.0), rd.z));
  float tEnd = atmExit(o, rd);
  float mu = dot(rd, SUN);
  float phR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  const float g = 0.76;
  float phM = 3.0 / (8.0 * PI) * ((1.0 - g * g) * (1.0 + mu * mu)) /
              ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
  float odR = 0.0, odM = 0.0;
  vec3 sR = vec3(0.0), sM = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float f = (float(i) + 0.5) / 8.0;
    float t = tEnd * f * f;                       // dense near the viewer
    float dt = tEnd * 2.0 * f / 8.0;
    vec3 p = o + rd * t;
    float h = length(p) - R_EARTH;
    float dR = exp(-h / 8.0) * dt, dM = exp(-h / 1.2) * dt;
    odR += dR; odM += dM;
    float tl = atmExit(p, SUN);
    float lR = 0.0, lM = 0.0;
    for (int j = 0; j < 3; j++) {
      float hq = length(p + SUN * (tl * (float(j) + 0.5) / 3.0)) - R_EARTH;
      lR += exp(-hq / 8.0); lM += exp(-hq / 1.2);
    }
    lR *= tl / 3.0; lM *= tl / 3.0;
    vec3 att = exp(-(BETA_R * (odR + lR) + BETA_M * 1.1 * (odM + lM)) * 0.62);
    sR += att * dR; sM += att * dM;
  }
  return SUN_I * (sR * BETA_R * phR + sM * BETA_M * phM);
}

// Put the sun at an elevation and an azimuth (from straight ahead toward +x)
// and work out the light it brings down: the sun's own colour after its path
// through the air, and the sky's glow on a surface that faces up.
void sunSetup(float elev, float azim) {
  float c = cos(elev);
  SUN = vec3(sin(azim) * c, sin(elev), -cos(azim) * c);
  float s = max(SUN.y, 0.02);
  float m = 1.0 / (s + 0.15 * pow(degrees(asin(s)) + 3.885, -1.253));   // air mass
  // A softly lit face (a light straight on, or all around) is a day with its sun
  // a little veiled; a hard side light is the sun at full strength.
  SUNC = 3.4 * (0.80 + 0.20 * clamp(KEY / 0.5, 0.0, 1.0)) * exp(-(BETA_R * 8.0 + BETA_M * 1.1 * 1.2) * m * 1.3);
  AMB = atmosphere(vec3(0.0, 1.0, 0.0), 0.0) * 0.85 + vec3(0.02);
}

// The sun's disc, and a tight halo: the part of the sun the scattering sum
// above is too coarse to show.
vec3 sunDisc(vec3 rd) {
  float d = dot(rd, SUN);
  float disc = sstep(0.99992, 0.99997, d);
  float halo = pow(max(d, 0.0), 1200.0);
  return SUNC * (disc * 60.0 + halo * 1.2) * sstep(-0.02, 0.05, rd.y);
}

// Distance haze: an exponential falloff with height (aerosols hug the ground),
// integrated along the ray exactly, fading what is far into the colour of the
// sky it is in front of.
vec3 aerial(vec3 col, vec3 ro, vec3 rd, float dist, float ext0, float camH) {
  const float H = 1.6;
  float k = rd.y / H;
  float od = abs(k) < 1e-3 ? dist : (1.0 - exp(-dist * k)) / k;
  od *= ext0 * exp(-max(ro.y, -0.5) / H);
  vec3 fogC = atmosphere(vec3(rd.x, max(rd.y, 0.0) + 0.04, rd.z), camH);
  vec3 tr = exp(-od * vec3(0.86, 1.0, 1.22));
  return col * tr + fogC * (1.0 - exp(-od)) * 0.95;
}

// --- clouds -----------------------------------------------------------------
//
// One slab of cumulus, ray-marched: a noise density shaped by a height profile
// (flat bottoms, billowing tops), lit by marching a few samples toward the sun
// — which is what puts a dark base under a bright, silver-edged crown — with
// the sky's glow filling the shade. The scene says where the slab is.
float CL_BASE = 1.6, CL_TOP = 3.2, CL_COVER = 0.5, CL_SCALE = 0.6;
vec2 CL_WIND = vec2(0.010, 0.004);

float cloudD(vec3 p, bool detail) {
  float h = (p.y - CL_BASE) / (CL_TOP - CL_BASE);
  float prof = sstep(0.0, 0.10, h) * sstep(1.0, 0.45, h);
  vec3 q = p * CL_SCALE + vec3(CL_WIND.x, 0.0, CL_WIND.y) * T;
  float n = 0.58 * noise3(q * 0.55) + 0.30 * noise3(q * 1.25) + 0.12 * noise3(q * 2.7);
  float d = n * prof - (0.74 - 0.55 * CL_COVER);
  if (detail) d -= 0.10 * noise3(q * 5.3 + vec3(0.0, T * 0.03, 0.0));
  return max(d, 0.0) * 3.0;
}

float hgPhase(float mu, float g) {
  return (1.0 - g * g) / (4.0 * PI * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
}

// rgb: light scattered toward the camera; a: what is left of the sky behind.
vec4 cloudMarch(vec3 ro, vec3 rd, float camH) {
  if (rd.y < 0.012) return vec4(0.0, 0.0, 0.0, 1.0);
  float t0 = (CL_BASE - ro.y) / rd.y;
  float t1 = min((CL_TOP - ro.y) / rd.y, t0 + 14.0);
  float dt = (t1 - t0) / 14.0;
  // Start each ray a fraction of a step in, differently per pixel, so the
  // slices are not visible as bands. The pattern changes only with the
  // redraw's JITTER point, so the redraws that are added up average it away.
  float t = t0 + dt * hash12(SEED);
  float trans = 1.0, tHit = 0.0;
  vec3 acc = vec3(0.0);
  float mu = dot(rd, SUN);
  float ph = mix(hgPhase(mu, 0.65), hgPhase(mu, -0.2), 0.45) * 4.0 * PI;
  for (int i = 0; i < 14; i++) {
    vec3 p = ro + rd * t;
    float d = cloudD(p, true);
    if (d > 0.002) {
      float ld = cloudD(p + SUN * 0.18, false) * 0.18 + cloudD(p + SUN * 0.45, false) * 0.27 +
                 cloudD(p + SUN * 1.0, false) * 0.55;
      float h = (p.y - CL_BASE) / (CL_TOP - CL_BASE);
      float beer = exp(-ld * 4.2);
      float powder = 1.0 - exp(-d * 5.0);
      vec3 L = SUNC * beer * (0.30 + 0.70 * powder) * ph * 0.62 +
               AMB * mix(0.45, 1.05, h) * vec3(0.92, 0.97, 1.0) * 0.95;
      float a = 1.0 - exp(-d * dt * 5.5);
      acc += trans * a * L;
      if (tHit == 0.0) tHit = t;
      trans *= 1.0 - a;
      if (trans < 0.03) break;
    }
    t += dt;
  }
  // Far clouds fade into the haze like everything else.
  float fade = exp(-max(tHit, 0.0) * 0.05);
  return vec4(acc * fade, 1.0 - (1.0 - trans) * fade);
}
`;

  // --- the office -----------------------------------------------------------
  //
  // A corner of a bright room, built rather than painted: five planes, and in
  // them a bookcase whose every book is its own box, a fiddle-leaf fig of thin
  // cupped leaves, a floor lamp, a framed picture, a windowsill. The window is
  // in the side wall, on the side your own light is on, and the sun comes
  // through it for real: a ray from every surface point toward the sun must
  // pass between the bars and between the leaves of the tree outside, so the
  // patch on the back wall has the window's shape, its dapple and the fig's
  // shadow, and a shaft of lit dust runs across the room to it. The skylight is
  // the window as an area light (a form factor, not a fudge), so the wall is
  // brightest where it faces the glass; the floor holds a blurred picture of
  // it. Leaves let the sun through. In a dim room it is evening: the sun is
  // gone, the town outside is lit, and the lamp is on.
  var OFFICE = `
// Metres. The camera is the origin, 1.25 m above the floor, looking down -z at
// the back wall of a room. The window is in the right-hand wall, so the sun
// (and your light) comes in from +x; main() mirrors the whole room when it is
// on the other side.
const float FLOOR_Y = -1.25, CEIL_Y = 1.20, BACK_Z = -3.0, RIGHT_X = 1.55, LEFT_X = -2.9;
const float WZ0 = -2.85, WZ1 = -1.95, WY0 = -0.55, WY1 = 0.95;     // the window in the right wall
const float TRANSOM_Y = 0.42;
const vec3  LAMPP = vec3(-0.92, 0.46, -2.62);                       // the floor lamp's shade
const vec3  SHELF_C = vec3(-1.90, -0.20, -2.80);                    // the bookcase's centre
const vec3  PLANT_B = vec3(1.08, FLOOR_Y, -2.62);                   // the fig's pot

float DAY, SUNK;
vec3 SKYW;       // light coming in through the glass
vec3 LAMPC;      // the lamp, when it is on
vec3 gCol;       // colour of whatever map() last found
float gCap = 1e3; // while marching, no step may be longer than the books are thin

// --- the window --------------------------------------------------------------
float winMask(vec2 zy, float soft) {
  vec2 c = vec2(0.5 * (WZ0 + WZ1), 0.5 * (WY0 + WY1));
  vec2 h = vec2(0.5 * (WZ1 - WZ0), 0.5 * (WY1 - WY0));
  return fill(sdBox(zy - c, h), soft);
}
float mullion(vec2 zy, float soft) {
  return max(fill(abs(zy.x - 0.5 * (WZ0 + WZ1)) - 0.016, soft), fill(abs(zy.y - TRANSOM_Y) - 0.016, soft));
}

// How much of the sun reaches x: a ray from x toward the sun must pass through
// the glass, between the bars, and between the leaves of the tree outside. The
// edge softens with the distance travelled, because the sun is a disc.
float sunVis(vec3 x) {
  if (SUN.x < 0.05) return 0.0;
  float s = (RIGHT_X - x.x) / SUN.x;
  if (s < 0.0) return 0.0;
  vec3 w = x + SUN * s;
  float pen = 0.006 + s * 0.011;
  float v = winMask(w.zy, pen) * (1.0 - mullion(w.zy, pen));
  // The tree outside, swaying: a dapple that sharpens as the patch comes
  // nearer the glass.
  vec2 lq = w.zy * 5.5 + vec2(0.20 * sin(T * 0.33), 0.12 * sin(T * 0.26 + 1.0));
  float leaves = sstep(0.34, 0.66, fbm3(lq + vec2(T * 0.012, 0.0)));
  v *= 1.0 - mix(0.30, 0.78, sstep(3.0, 0.8, s)) * leaves;
  return v * sstep(0.04, 0.2, SUN.y);
}

// Skylight through the window as an area light: the cosine-weighted share of
// the hemisphere at x (normal n) that the glass fills — what makes the wall
// brightest nearest the window and fall off smoothly across the room.
float windowFF(vec3 x, vec3 n) {
  vec3 a = normalize(vec3(RIGHT_X, WY0, WZ0) - x);
  vec3 b = normalize(vec3(RIGHT_X, WY0, WZ1) - x);
  vec3 c = normalize(vec3(RIGHT_X, WY1, WZ1) - x);
  vec3 d = normalize(vec3(RIGHT_X, WY1, WZ0) - x);
  float s = acos(clamp(dot(a, b), -1.0, 1.0)) * dot(normalize(cross(a, b)), n) +
            acos(clamp(dot(b, c), -1.0, 1.0)) * dot(normalize(cross(b, c)), n) +
            acos(clamp(dot(c, d), -1.0, 1.0)) * dot(normalize(cross(c, d)), n) +
            acos(clamp(dot(d, a), -1.0, 1.0)) * dot(normalize(cross(d, a)), n);
  return clamp(abs(s) / 6.2832, 0.0, 1.0);
}

// What is out there, in direction rd: sky, a hazy line of roofs, and a tree in
// leaf close to the glass, its canopy broken by gaps of light. Soft on purpose
// — it is behind glass, out of focus, and nobody counts leaves.
vec3 outside(vec3 rd) {
  float y = rd.y;
  vec3 sky = atmosphere(vec3(rd.x, max(y, 0.03), rd.z), 0.0) * 1.1;
  vec2 cq = vec2(rd.z, rd.x) / (y + 0.4) * 1.3;
  float cl = sstep(0.50, 0.72, fbm3(cq + vec2(T * 0.01, 0.0)));
  sky = mix(sky, lin(vec3(0.97, 0.97, 0.98)) * (SUNC * 0.22 + AMB * 1.1), cl * 0.6 * sstep(0.02, 0.2, y));
  // Roofs and a church tower, far off and blue with haze.
  float col = floor(rd.z * 20.0);
  float top = 0.012 + 0.06 * hash11(col * 3.7) + 0.04 * noise(vec2(rd.z * 8.0, 2.0));
  top += 0.10 * sstep(0.03, 0.0, abs(rd.z + 0.62)) * 0.0;
  float roofs = sstep(top + 0.005, top - 0.005, y);
  vec3 town = mix(lin(vec3(0.52, 0.56, 0.60)), lin(vec3(0.62, 0.52, 0.46)), noise(vec2(rd.z * 30.0, y * 14.0)));
  town = mix(town, sky, 0.25) * (SUNC * 0.12 + AMB * 0.8);
  vec3 c = mix(sky, town, roofs);
  // The tree: leaf masses, lit from above, with sky showing through. The glass
  // shows a slice of the world only a few degrees wide, so the leaves are small.
  vec2 lq = vec2(rd.z * 15.0 + 0.3 * sin(T * 0.27 + y * 9.0), y * 17.0);
  float mass = fbm3(lq) * 0.75 + 0.25 * noise(lq * 3.3);
  float hang = 0.62 - 1.6 * (y - 0.06);                      // thicker lower down
  float canopy = sstep(0.0, 0.12, mass - (1.0 - clamp(hang, 0.0, 1.0)) * 0.60 - 0.10);
  float lit = sstep(0.25, 0.75, noise(lq * 2.1 + 7.0));
  vec3 leaf = mix(lin(vec3(0.05, 0.14, 0.04)), lin(vec3(0.40, 0.55, 0.15)), lit) * (SUNC * 0.30 + AMB * 1.2);
  c = mix(c, leaf, canopy);
  // At dusk the town lights up in out-of-focus lamps.
  vec2 g = vec2(rd.z * 70.0, y * 70.0);
  vec2 cid = floor(g);
  vec2 h2 = hash22(cid);
  float lampD = length(fract(g) - 0.5 - (h2 - 0.5) * 0.4);
  float on = step(0.72, h2.x) * sstep(0.34, 0.14, lampD) * step(y, top + 0.01) * step(-0.08, y) * (1.0 - canopy);
  c += lin(vec3(1.0, 0.76, 0.44)) * on * NIGHT * 0.8 * (0.6 + 0.4 * sin(T * 0.4 + h2.y * 40.0));
  return c;
}

// --- the furniture ------------------------------------------------------------

// One book in cell cx of a tier, as a box: its own height, thickness and cover.
// Returns 1e3 for an empty cell. Written as a function so a point can ask the
// cell on either side as well — a lattice that only asks its own cell draws a
// jagged edge wherever a book is wider than the cell's half.
float bookBox(vec3 q, float cx, float tier, float cy, inout vec3 col) {
  float r1 = hash12(vec2(cx, tier + 3.0));
  // Gaps on two shelves, where a vase and a stack of books stand.
  if (r1 < 0.12 || cx < 0.0 || cx > 29.0) return 1e3;
  if ((tier == 2.0 && cx > 15.0 && cx < 24.0) || (tier == 3.0 && cx > 3.0 && cx < 12.0)) return 1e3;
  float r2 = hash12(vec2(cx + 9.0, tier));
  float bh = 0.19 + 0.17 * r2;
  float bw = 0.0105 + 0.0065 * hash12(vec2(cx, tier + 20.0));
  float bx = (cx + 0.5) * 0.036 - 0.53;
  float db = sdBox3(vec3(q.x - bx, cy - 0.025 - bh * 0.5, q.z + 0.045), vec3(bw, bh * 0.5, 0.118));
  float pick = hash12(vec2(cx * 1.7, tier * 5.0));
  vec3 c0 = pick < 0.14 ? vec3(0.62, 0.20, 0.17) : pick < 0.28 ? vec3(0.17, 0.30, 0.46) :
            pick < 0.42 ? vec3(0.83, 0.77, 0.62) : pick < 0.56 ? vec3(0.28, 0.42, 0.30) :
            pick < 0.70 ? vec3(0.78, 0.56, 0.20) : pick < 0.84 ? vec3(0.22, 0.20, 0.22) : vec3(0.58, 0.40, 0.52);
  col = lin(c0) * (0.7 + 0.5 * r2);
  return db;
}

// The bookcase: sides, back, boards, and a row of books on every shelf.
float shelfMap(vec3 p) {
  vec3 q = p - SHELF_C;
  float side = sdBox3(vec3(abs(q.x) - 0.555, q.y, q.z), vec3(0.012, 1.05, 0.18));
  float back = sdBox3(q - vec3(0.0, 0.0, -0.17), vec3(0.55, 1.05, 0.010));
  float yb = q.y + 1.05;
  float cy = mod(yb, 0.41);
  float tier = floor(yb / 0.41);
  float board = sdBox3(vec3(q.x, cy - 0.0125, q.z), vec3(0.55, 0.0125, 0.18));
  board = max(board, abs(q.y) - 1.05);
  float d = min(min(side, back), board);
  gCol = lin(vec3(0.66, 0.52, 0.38));
  if (tier < 5.0 && abs(q.x) < 0.55) {
    float fx = (q.x + 0.53) / 0.036;
    float cx = floor(fx);
    float cn = cx + (fract(fx) < 0.5 ? -1.0 : 1.0);
    vec3 c1, c2;
    float d1 = bookBox(q, cx, tier, cy, c1);
    float d2 = bookBox(q, cn, tier, cy, c2);
    float db = min(d1, d2);
    if (db < d) { d = db; gCol = d1 < d2 ? c1 : c2; }
    if (tier == 2.0) {
      // A vase with a few dry stems.
      vec3 v = q - vec3(0.30, -1.05 + 0.41 * 2.0 + 0.025 + 0.11, -0.04);
      float vb = sdEllipsoid(v, vec3(0.062, 0.115, 0.062));
      float neck = sdCylY(v - vec3(0.0, 0.12, 0.0), 0.026, 0.04);
      float dv = smin(vb, neck, 0.03);
      float stems = sdCapsule(v, vec3(0.0, 0.1, 0.0), vec3(0.05 * sin(T * 0.4), 0.42, 0.02), 0.004);
      if (dv < d) { d = dv; gCol = lin(vec3(0.20, 0.34, 0.45)); }
      if (stems < d) { d = stems; gCol = lin(vec3(0.46, 0.36, 0.22)); }
    }
    if (tier == 3.0) {
      // A leaning stack of three books.
      vec3 s = q - vec3(-0.26, -1.05 + 0.41 * 3.0 + 0.025, -0.04);
      float s1 = sdBox3(s - vec3(0.0, 0.02, 0.0), vec3(0.11, 0.02, 0.085));
      float s2 = sdBox3(s - vec3(0.01, 0.062, 0.0), vec3(0.095, 0.021, 0.08));
      float s3 = sdBox3(s - vec3(-0.01, 0.103, 0.0), vec3(0.085, 0.020, 0.075));
      float ds = min(s1, min(s2, s3));
      if (ds < d) { d = ds; gCol = lin(s1 < s2 && s1 < s3 ? vec3(0.50, 0.24, 0.20) : s2 < s3 ? vec3(0.25, 0.36, 0.40) : vec3(0.80, 0.72, 0.52)); }
    }
  }
  return d;
}

// The fig: a pot, a slim trunk, and fiddle-shaped leaves spiralling up it,
// each a thin ellipsoid cupped along its length. They sway, and sway more
// when you move.
float plantMap(vec3 p) {
  vec3 q = p - PLANT_B;
  float pot = max(sdCylY(q - vec3(0.0, 0.17, 0.0), 0.15 + 0.03 * q.y, 0.17), -(q.y - 0.32));
  vec3 gc = lin(vec3(0.72, 0.40, 0.27));
  float d = pot;
  float trunk = sdCapsule(q, vec3(0.0, 0.3, 0.0), vec3(0.03 * sin(T * 0.3), 1.62, 0.02), 0.016);
  if (trunk < d) { d = trunk; gc = lin(vec3(0.40, 0.31, 0.22)); }
  if (length(q - vec3(0.0, 1.0, 0.0)) < 0.95) {
    for (int i = 0; i < 12; i++) {
      float fi = float(i);
      float hy = 0.62 + fi * 0.085 + 0.02 * hash11(fi);
      float az = fi * 2.399 + 0.6;
      float sway = 0.05 * sin(T * 0.45 + fi * 1.3) + 0.12 * MOTION * sin(T * 1.9 + fi * 2.1);
      float pit = 0.45 + 0.30 * hash11(fi * 3.1) - fi * 0.012 + sway;
      vec3 u = vec3(cos(az) * cos(pit), sin(pit), sin(az) * cos(pit));
      vec3 sd = normalize(cross(vec3(0.0, 1.0, 0.0), u));
      vec3 nm = cross(u, sd);
      float len = 0.15 - fi * 0.004;
      vec3 c = vec3(0.0, hy, 0.0) + u * (0.05 + len);
      vec3 r = q - c;
      vec3 lp = vec3(dot(r, u), dot(r, sd), dot(r, nm));
      lp.z += 0.9 * lp.x * lp.x - 0.7 * lp.y * lp.y;       // cupped, and arched
      float leaf = sdEllipsoid(lp, vec3(len, 0.082 - fi * 0.002, 0.0075)) * 0.8;
      if (leaf < d) { d = leaf; gc = lin(vec3(0.12, 0.31, 0.09)) * (0.8 + 0.4 * hash11(fi * 5.0)); }
      float stem = sdCapsule(q, vec3(0.0, hy, 0.0), vec3(0.0, hy, 0.0) + u * 0.07, 0.005);
      if (stem < d) { d = stem; gc = lin(vec3(0.30, 0.38, 0.14)); }
    }
  }
  gCol = gc;
  return d;
}

float lampMap(vec3 p) {
  vec3 q = p - vec3(LAMPP.x, 0.0, LAMPP.z);
  float pole = sdCylY(q - vec3(0.0, (FLOOR_Y + LAMPP.y - 0.14) * 0.5, 0.0), 0.011, (LAMPP.y - 0.14 - FLOOR_Y) * 0.5);
  float base = sdCylY(q - vec3(0.0, FLOOR_Y + 0.012, 0.0), 0.14, 0.012);
  float ry = (q.y - (LAMPP.y - 0.14)) / 0.28;
  float shade = max(abs(q.y - LAMPP.y) - 0.14, length(q.xz) - (0.12 + 0.045 * ry)) ;
  if (shade < min(pole, base)) { gCol = lin(vec3(0.95, 0.90, 0.80)); return shade; }
  gCol = lin(vec3(0.62, 0.50, 0.28));
  return min(pole, base);
}

// Everything that stands in the room. Each piece is skipped, cheaply, while
// the point is far from its bounding box.
float map(vec3 p) {
  float d = 1e3;
  vec3 gs = vec3(0.0);
  float bs = sdBox3(p - SHELF_C, vec3(0.57, 1.07, 0.20));
  if (bs < 0.12) { d = min(shelfMap(p), gCap); gs = gCol; } else d = bs + 0.02;
  float bp = length(p - PLANT_B - vec3(0.0, 1.0, 0.0)) - 1.0;
  if (bp < 0.12) { float dp = plantMap(p); if (dp < d) { d = dp; gs = gCol; } } else if (bp < d) d = bp;
  float bl = sdBox3(p - vec3(LAMPP.x, 0.1, LAMPP.z), vec3(0.17, 0.78, 0.17));
  if (bl < 0.12) { float dl = lampMap(p); if (dl < d) { d = dl; gs = gCol; } } else if (bl < d) d = bl;
  // The windowsill.
  float sill = sdBox3(p - vec3(RIGHT_X - 0.06, WY0 - 0.012, 0.5 * (WZ0 + WZ1)), vec3(0.075, 0.014, 0.5 * (WZ1 - WZ0) + 0.05));
  if (sill < d) { d = sill; gs = lin(vec3(0.93, 0.92, 0.89)); }
  gCol = gs;
  return d;
}

float marchObjects(vec3 ro, vec3 rd, float tmax) {
  float t = 0.4;
  gCap = 0.022;
  for (int i = 0; i < 56; i++) {
    float h = map(ro + rd * t);
    if (h < 0.0015) { gCap = 1e3; return t; }
    t += h * 0.8;
    if (t > tmax) break;
  }
  gCap = 1e3;
  return -1.0;
}

vec3 mapNormal(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  const float e = 0.002;
  return normalize(k.xyy * map(p + k.xyy * e) + k.yyx * map(p + k.yyx * e) +
                   k.yxy * map(p + k.yxy * e) + k.xxx * map(p + k.xxx * e));
}

float objAO(vec3 p, vec3 n) {
  float occ = 0.0, sca = 1.0;
  for (int i = 0; i < 4; i++) {
    float h = 0.012 + 0.04 * float(i);
    occ += (h - map(p + n * h)) * sca;
    sca *= 0.8;
  }
  return clamp(1.0 - 1.8 * occ, 0.0, 1.0);
}

float objShadow(vec3 ro, vec3 rd) {
  float res = 1.0, t = 0.02;
  for (int i = 0; i < 18; i++) {
    float h = map(ro + rd * t);
    res = min(res, 9.0 * h / t);
    t += clamp(h, 0.02, 0.25);
    if (res < 0.02 || t > 2.5) break;
  }
  return clamp(res, 0.0, 1.0);
}

// --- surfaces ------------------------------------------------------------------
vec3 plaster(vec3 x) {
  float n = noise(x.xy * 30.0 + x.zz * 17.0) * 0.5 + noise(x.xy * 90.0) * 0.5;
  return lin(vec3(0.91, 0.88, 0.82)) * (0.965 + 0.07 * n);
}

vec3 floorAlb(vec3 x) {
  float pw = 0.16;
  float pi = floor(x.x / pw);
  float tone = hash11(pi * 3.7);
  float seam = floor(x.z / 1.4 + tone * 5.0);
  float tone2 = hash12(vec2(pi, seam));
  float grain = noise(vec2(x.x * 110.0, x.z * 5.0 + tone * 40.0));
  vec3 base = mix(lin(vec3(0.72, 0.50, 0.30)), lin(vec3(0.50, 0.33, 0.19)), tone * 0.6 + tone2 * 0.4);
  base *= 0.88 + 0.24 * grain;
  float gap = sstep(0.012, 0.0, abs(fract(x.x / pw) - 0.5) * pw - (pw * 0.5 - 0.0035));
  return base * (1.0 - 0.7 * gap);
}

// What a mirror-ish floor (or a glossy sill) sees: mostly the walls, and
// occasionally the window, which is by far the brightest thing in the room.
vec3 roomSeen(vec3 x, vec3 rd, float blur) {
  vec3 c = plaster(x) * (SKYW * 0.10 + vec3(0.07)) * 1.4;
  if (rd.x > 0.02) {
    float s = (RIGHT_X - x.x) / rd.x;
    vec3 w = x + rd * s;
    float m = winMask(w.zy, 0.02 + blur * s) * (1.0 - 0.8 * mullion(w.zy, 0.02 + blur * s));
    c = mix(c, outside(rd), m);
  }
  return c;
}

vec4 scene(vec2 p, out vec3 emit) {
  emit = vec3(0.0);
  DAY = 1.0 - NIGHT;
  float elev = mix(0.52 + 0.14 * ELEV, 0.12, NIGHT);
  sunSetup(elev, 1.15);
  // The sun comes in from the right and slightly from behind the camera, so
  // its light crosses the room toward the back wall.
  SUN = normalize(vec3(0.72, 0.46 + 0.25 * ELEV, 0.40));
  SUNK = (0.35 + 0.65 * KEY) * DAY;
  SKYW = (AMB * 6.0 + vec3(0.08)) * (0.30 + 0.70 * DAY);
  LAMPC = lin(vec3(1.0, 0.70, 0.42)) * 2.6 * NIGHT;

  vec3 ro = vec3(0.0);
  vec3 rd = camRay(p, -0.02);
  float tb = rd.z < -1e-4 ? BACK_Z / rd.z : 1e5;
  float tr = rd.x > 1e-4 ? RIGHT_X / rd.x : 1e5;
  float tl = rd.x < -1e-4 ? LEFT_X / rd.x : 1e5;
  float tf = rd.y < -1e-4 ? FLOOR_Y / rd.y : 1e5;
  float tc = rd.y > 1e-4 ? CEIL_Y / rd.y : 1e5;
  float tp = min(min(tb, tr), min(min(tl, tf), tc));

  float to = marchObjects(ro, rd, tp);
  float t = to > 0.0 ? to : tp;
  vec3 X = rd * t;
  vec3 n;
  vec3 alb;
  float glossy = 0.0, recv = 0.95;
  float trans = 0.0;
  float glass = 0.0;
  vec3 glassCol = vec3(0.0);

  if (to > 0.0) {
    n = mapNormal(X);
    map(X);
    alb = gCol;
    // Leaves and stems let light through.
    trans = step(PLANT_B.x - 0.9, X.x) * step(X.x, PLANT_B.x + 0.9) * step(PLANT_B.z - 0.9, X.z) * step(X.z, PLANT_B.z + 0.9) * step(0.0, X.y - FLOOR_Y - 0.5);
    glossy = 0.0;
  } else if (t == tb) {
    n = vec3(0.0, 0.0, 1.0);
    alb = plaster(X);
    float bb = sstep(FLOOR_Y + 0.14, FLOOR_Y + 0.10, X.y);               // baseboard
    alb = mix(alb, lin(vec3(0.95, 0.94, 0.91)), bb);
    // Crown moulding: a lighter band under the ceiling, and the shadow it throws.
    float crown = sstep(CEIL_Y - 0.115, CEIL_Y - 0.105, X.y);
    alb = mix(alb, lin(vec3(0.96, 0.95, 0.92)), crown);
    alb *= 1.0 - 0.18 * sstep(CEIL_Y - 0.115, CEIL_Y - 0.150, X.y) * (1.0 - crown);
    // The framed picture.
    vec2 pf = X.xy - vec2(-0.12, 0.43);
    float fr = fill(sdBox(pf, vec2(0.50, 0.37)), 0.004);
    float cv = fill(sdBox(pf, vec2(0.465, 0.335)), 0.003);
    vec2 uv = pf / vec2(0.465, 0.335);
    float hills = sstep(0.0, 0.03, 0.18 * sin(uv.x * 3.2 + 1.0) + 0.12 * sin(uv.x * 7.0) - uv.y - 0.1);
    vec3 art = mix(lin(vec3(0.96, 0.84, 0.62)), lin(vec3(0.62, 0.78, 0.88)), sstep(-0.3, 0.9, uv.y));
    art = mix(art, lin(vec3(0.30, 0.46, 0.42)), hills);
    art = mix(art, lin(vec3(0.98, 0.90, 0.62)), sstep(0.16, 0.12, length(uv - vec2(0.35, 0.3))));
    // Brush strokes and a canvas weave.
    float stroke = noise(vec2(uv.x * 24.0, uv.y * 6.0 + 3.0)) - 0.5;
    art *= 1.0 + 0.16 * stroke + 0.05 * (noise(pf * 500.0) - 0.5);
    vec3 wood = mix(lin(vec3(0.34, 0.22, 0.12)), lin(vec3(0.22, 0.14, 0.08)), noise(vec2(pf.x * 40.0, pf.y * 40.0)));
    alb = mix(alb, wood, fr);
    alb = mix(alb, art, cv);
  } else if (t == tr) {
    n = vec3(-1.0, 0.0, 0.0);
    alb = plaster(X);
    float bb = sstep(FLOOR_Y + 0.14, FLOOR_Y + 0.10, X.y);
    alb = mix(alb, lin(vec3(0.95, 0.94, 0.91)), bb);
    float wm = winMask(X.zy, 0.004);
    float frame = winMask(X.zy, 0.004);
    float outerFrame = fill(sdBox(X.zy - vec2(0.5 * (WZ0 + WZ1), 0.5 * (WY0 + WY1)), vec2(0.5 * (WZ1 - WZ0) + 0.05, 0.5 * (WY1 - WY0) + 0.05)), 0.004);
    alb = mix(alb, lin(vec3(0.94, 0.93, 0.90)), outerFrame);
    // The reveal: the frame is deeper than the wall, and the side of it nearest
    // the glass sits in its own shade.
    float dFrame = sdBox(X.zy - vec2(0.5 * (WZ0 + WZ1), 0.5 * (WY0 + WY1)), vec2(0.5 * (WZ1 - WZ0), 0.5 * (WY1 - WY0)));
    alb *= 1.0 - 0.28 * outerFrame * sstep(0.04, 0.0, dFrame);
    // The glass is far brighter than the wall round it, and a lens bleeds.
    float dWin = max(sdBox(X.zy - vec2(0.5 * (WZ0 + WZ1), 0.5 * (WY0 + WY1)), vec2(0.5 * (WZ1 - WZ0), 0.5 * (WY1 - WY0))), 0.0);
    emit += outside(normalize(vec3(1.0, 0.1, -1.3))) * exp(-dWin * 9.0) * 0.07 * (1.0 - wm);
    if (wm > 0.0) {
      float mul = mullion(X.zy, 0.004);
      vec3 view = outside(rd);
      // A sheer curtain drawn over half the window: folds, and light through it.
      float cEdge = WZ0 + 0.50 * (WZ1 - WZ0);
      float cur = sstep(cEdge + 0.03, cEdge - 0.03, X.z) * sstep(WY1 + 0.05, WY1 - 0.01, X.y);
      float fold = 0.5 + 0.5 * sin((X.z - WZ0) * 70.0 + 2.0 * noise(vec2(X.z * 6.0, X.y * 2.0)) + 0.3 * sin(T * 0.3 + X.y * 2.0));
      vec3 curtain = lin(vec3(0.97, 0.96, 0.93)) * (0.55 + 0.45 * fold);
      view = mix(view, curtain * (SKYW * 1.1 + SUNC * 0.2 * SUNK + vec3(0.1)) * 1.5, cur * (0.58 + 0.2 * fold));
      glassCol = view;
      glass = wm * (1.0 - mul);
      alb = mix(alb, lin(vec3(0.94, 0.93, 0.90)), wm * mul);
    }
    recv = 0.7 * (1.0 - glass);
  } else if (t == tl) {
    n = vec3(1.0, 0.0, 0.0);
    alb = plaster(X);
  } else if (t == tf) {
    n = vec3(0.0, 1.0, 0.0);
    alb = floorAlb(X);
    glossy = 0.9;
    recv = 0.5;
  } else {
    n = vec3(0.0, -1.0, 0.0);
    alb = plaster(X) * 0.95;
  }

  // ---- light ----
  float sv = SUNK > 0.001 ? sunVis(X) : 0.0;
  float objSh = 1.0;
  if (sv > 0.01 && (to > 0.0 || t == tf || t == tb)) objSh = objShadow(X + n * 0.01, SUN);
  vec3 L = vec3(0.0);
  L += SUNC * SUNK * 1.15 * sv * objSh * max(dot(n, SUN), 0.0);
  float ff = (t == tr && to < 0.0) ? 0.0 : windowFF(X, n);
  L += SKYW * ff * 1.45;
  // Light that has bounced around the room, strongest near the sunlit patch.
  vec3 floorPatch = vec3(0.35, FLOOR_Y, -2.35);
  vec3 toP = floorPatch - X;
  float bounce = max(dot(n, normalize(toP)), 0.0) / (1.0 + 1.8 * dot(toP, toP));
  L += lin(vec3(0.95, 0.80, 0.60)) * SUNC * SUNK * 1.4 * bounce;
  L += (vec3(0.40, 0.375, 0.345) * (0.35 + 0.65 * DAY)) * (0.65 + 0.35 * n.y);
  // The lamp: a pool of warm light on the wall, a glow on the shelf.
  vec3 lv = LAMPP - X;
  float ld = dot(lv, lv);
  L += LAMPC * max(dot(n, normalize(lv)), 0.0) / (0.35 + ld) * 0.55;
  // Occlusion: walls meeting, and anything standing near.
  float ao = 1.0;
  if (to < 0.0) {
    float dCorner = min(min(t == tb ? 9.0 : abs(X.z - BACK_Z), t == tr ? 9.0 : abs(X.x - RIGHT_X)),
                        min(t == tf ? 9.0 : abs(X.y - FLOOR_Y), t == tc ? 9.0 : abs(X.y - CEIL_Y)));
    ao *= 1.0 - 0.38 * exp(-dCorner * 6.5);
  }
  ao *= objAO(X + n * 0.004, n);
  vec3 col = alb * L * ao;
  // Leaves are translucent: the window shows through them.
  if (trans > 0.5) {
    vec3 tcol = alb * (SUNC * SUNK * sv * max(dot(-n, SUN), 0.0) * 0.9 + SKYW * windowFF(X, -n) * 1.2);
    col += tcol * 0.8;
  }
  // The floor and sill are glossy: they hold a blurred picture of the window.
  if (glossy > 0.0) {
    vec3 rr = reflect(rd, n);
    float fr = 0.04 + 0.96 * pow(1.0 - clamp(dot(-rd, n), 0.0, 1.0), 5.0);
    vec3 seen = roomSeen(X, rr, 0.10 + 0.04 * t);
    col += seen * fr * glossy * 0.9;
  }
  // The beam: dust in the sunlight crossing the room, glowing faintly where
  // the sun shines through the glass.
  if (SUNK > 0.01) {
    float acc = 0.0;
    float tEnd = min(t, 6.0);
    for (int i = 0; i < 12; i++) {
      float ti = (float(i) + 0.5 + 0.6 * hash12(SEED + float(i))) / 12.0 * tEnd;
      vec3 q = rd * ti;
      float sv2 = sunVis(q);
      float dust = 0.55 + 0.9 * noise(q.xz * 5.0 + q.yy * 3.0 + vec2(T * 0.03, 0.0));
      acc += sv2 * dust * (tEnd / 12.0);
    }
    float mu = dot(rd, SUN);
    col += SUNC * SUNK * acc * (0.018 + 0.05 * pow(max(mu, 0.0), 3.0));
  }
  // Dust motes, stirred by you.
  vec2 dp = p + stir(p, 0.04);
  emit += SUNC * SUNK * specks(dp, 24.0, 0.07, 0.01) * 0.020 * (0.2 + 0.8 * min(1.0, sv + 0.15));
  // The lamp's shade glows, and so does the glass.
  if (to > 0.0 && LAMPC.r > 0.0 && X.x < LAMPP.x + 0.2 && X.x > LAMPP.x - 0.2 && X.y > LAMPP.y - 0.16 && X.y < LAMPP.y + 0.16) {
    emit += LAMPC * 0.5 * alb;
  }
  emit += glassCol * glass * (1.0 - 0.15 * NIGHT);
  col *= 1.0 - glass;
  return vec4(col, recv);
}
`;

  // --- the island -----------------------------------------------------------
  //
  // A lagoon from the shade of a beach, at eye height. The sea is a surface of
  // swells with Fresnel reflection of the real sky (and its clouds), and under
  // it, in the shallows, the sand shows through, netted with caustics and
  // turned turquoise by the depth, until the reef where a line of surf breaks.
  // The sun glitters where a wavelet happens to face it, and the shore laps at
  // wet sand that is a mirror. A coconut palm leans in from the sun's side —
  // trunk and fronds, each leaflet cut out of a bent ribbon, lit from behind —
  // and throws its trunk's shadow on the sand; far off are an islet with its own
  // palms, a sail and a few gulls. In a dim room the sun sets.
  var ISLAND = `
// Metres. The camera stands on a beach 2.1 m above the sea, looking out over a
// lagoon: +x is toward the key light, -z is away from the shore, and the sand
// slopes down from the camera to the waterline 12 m ahead.
const vec3 CAMI = vec3(0.0, 2.1, 0.0);
const float BEACH_SLOPE = 0.04;
const float SHORE_Z = 12.5;

// How much water lies over the sand at (x, z): none on the beach, a shelf of
// turquoise shallows that deepens quickly enough to be coloured, a reef with a
// break of surf along it, then the open blue beyond.
float seaDepth(vec2 xz) {
  float z = -xz.y;
  float zs = SHORE_Z + 3.5 * (noise(vec2(xz.x * 0.05, 1.7)) - 0.5);
  float u = max(z - zs, 0.0);
  float d = 3.0 * (1.0 - exp(-u * 0.065 / 3.0));
  d += 0.8 * (noise(vec2(xz.x * 0.04, z * 0.07)) - 0.5) * sstep(10.0, 40.0, u);
  d -= 1.7 * exp(-sq((z - 170.0) / 16.0));
  d += 12.0 * sstep(185.0, 330.0, z);
  return max(d, 0.0);
}

// The sea's slope: a swell and three shorter chop, each faded out once it is
// finer than a pixel — a surface sampled below its own wavelength shimmers, and
// a shimmer costs every receiver bits. They run toward the shore, slowly: this
// is a lagoon, and the water is a backdrop.
vec2 seaSlope(vec2 w, float fp, float shoal) {
  vec2 g = vec2(0.0);
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float lam = 13.0 * pow(0.45, fi);
    float vis = sstep(lam * 1.3, lam * 0.4, fp);
    float a = 1.35 + fi * 0.62 + 0.3 * sin(fi * 7.0);
    vec2 dir = vec2(cos(a), sin(a));
    float c = 0.06 * sqrt(lam);
    float ph = (dot(w, dir) - c * T) * 6.2832 / lam + fi * 2.3;
    g += dir * cos(ph) * (0.040 * pow(0.66, fi)) * vis * (1.0 + 0.5 * shoal);
  }
  return g;
}

// Caustics: the web of light a wavy surface focuses onto what is under it.
float caustic(vec2 p, float t) {
  vec2 i = p;
  float c = 1.0;
  const float inten = 0.0075;
  for (int n = 0; n < 4; n++) {
    float tt = t * (1.0 - 3.5 / float(n + 1));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
  }
  c /= 4.0;
  c = 1.17 - pow(c, 1.4);
  return pow(abs(c), 8.0);
}

vec3 sandAt(vec2 xz, float fp, float wet) {
  float f = sstep(0.4, 0.06, fp);
  float rip = noise(vec2(xz.x * 3.4, xz.y * 1.1)) * 0.6 + noise(xz * 11.0) * 0.4 * f;
  vec3 dry = mix(lin(vec3(0.93, 0.84, 0.66)), lin(vec3(0.84, 0.73, 0.54)), rip);
  float speck = step(0.93, hash12(floor(xz * 38.0))) * f;       // shell grit
  dry = mix(dry, lin(vec3(0.98, 0.95, 0.90)), speck * 0.5);
  vec3 damp = lin(vec3(0.60, 0.50, 0.37));
  return mix(dry, damp, wet);
}

// --- the palm ---------------------------------------------------------------------
//
// A curved trunk of six capsules and a crown of fronds. A frond is a spine that
// arches and falls, with a leaflet wing either side, each wing four planar
// quads; the leaflets are a comb cut out of those quads (an alpha test in the
// frond's own coordinates), so what you see through is the sky, and what you see
// is lit from behind — sun through leaf. All of it is analytic ray-against-
// triangle, and all of it is skipped for rays that miss the crown's bounding
// sphere.
const vec3 PT0 = vec3(4.4, 0.28, -4.4);
const vec3 PT1 = vec3(4.2, 1.7, -4.7);
const vec3 PT2 = vec3(3.3, 3.0, -5.0);
const vec3 PT3 = vec3(2.4, 4.1, -5.3);

vec3 trunkAt(float t) {
  float u = 1.0 - t;
  return u * u * u * PT0 + 3.0 * u * u * t * PT1 + 3.0 * u * t * t * PT2 + t * t * t * PT3;
}

float capHit(vec3 ro, vec3 rd, vec3 pa, vec3 pb, float r) {
  vec3 ba = pb - pa, oa = ro - pa;
  float baba = dot(ba, ba), bard = dot(ba, rd), baoa = dot(ba, oa);
  float rdoa = dot(rd, oa), oaoa = dot(oa, oa);
  float a = baba - bard * bard;
  float b = baba * rdoa - baoa * bard;
  float c = baba * oaoa - baoa * baoa - r * r * baba;
  float h = b * b - a * c;
  if (h < 0.0) return -1.0;
  float t = (-b - sqrt(h)) / a;
  float y = baoa + t * bard;
  if (y > 0.0 && y < baba) return t;
  vec3 oc = y <= 0.0 ? oa : ro - pb;
  b = dot(rd, oc); c = dot(oc, oc) - r * r;
  h = b * b - c;
  return h > 0.0 ? -b - sqrt(h) : -1.0;
}

float triHit(vec3 ro, vec3 rd, vec3 a, vec3 b, vec3 c, out vec2 uv) {
  vec3 e1 = b - a, e2 = c - a;
  vec3 p = cross(rd, e2);
  float det = dot(e1, p);
  uv = vec2(0.0);
  if (abs(det) < 1e-7) return -1.0;
  float inv = 1.0 / det;
  vec3 s = ro - a;
  float u = dot(s, p) * inv;
  if (u < 0.0 || u > 1.0) return -1.0;
  vec3 q = cross(s, e1);
  float v = dot(rd, q) * inv;
  if (v < 0.0 || u + v > 1.0) return -1.0;
  uv = vec2(u, v);
  return dot(e2, q) * inv;
}

// Does a ray come near the palm at all? Everything below is skipped if not.
bool nearPalm(vec3 ro, vec3 rd) {
  vec3 oc = ro - vec3(3.3, 2.7, -5.2);
  float b = dot(oc, rd);
  return b * b - (dot(oc, oc) - 4.6 * 4.6) > 0.0 && (b < 0.0 || dot(oc, oc) < 4.6 * 4.6);
}

// The palm along a ray. Returns t (or -1) and the colour of what it hit.
float palmHit(vec3 ro, vec3 rd, float tmax, out vec3 col) {
  col = vec3(0.0);
  float best = tmax;
  bool hit = false;
  if (!nearPalm(ro, rd)) return -1.0;
  // ---- trunk
  vec3 pa = trunkAt(0.0);
  for (int k = 0; k < 6; k++) {
    vec3 pb = trunkAt(float(k + 1) / 6.0);
    float rad = mix(0.21, 0.13, (float(k) + 0.5) / 6.0);
    float t = capHit(ro, rd, pa, pb, rad);
    if (t > 0.0 && t < best) {
      best = t; hit = true;
      vec3 X = ro + rd * t;
      vec3 axis = normalize(pb - pa);
      vec3 nrm = normalize(X - (pa + axis * dot(X - pa, axis)));
      float along = (float(k) + clamp(dot(X - pa, pb - pa) / dot(pb - pa, pb - pa), 0.0, 1.0)) / 6.0;
      float ang = atan(nrm.z, nrm.x);
      float ring = sstep(0.35, 0.65, fract(along * 46.0 + 0.3 * noise(vec2(ang * 3.0, along * 20.0))));
      vec3 bark = mix(lin(vec3(0.46, 0.38, 0.28)), lin(vec3(0.30, 0.24, 0.18)), ring) * (0.85 + 0.3 * noise(vec2(ang * 9.0, along * 120.0)));
      // The shaded side is lit by the sky and, below all, by the sunlit sand.
      vec3 bounce = lin(vec3(0.92, 0.82, 0.62)) * SUNC * max(SUN.y, 0.2) * 0.30 * (0.5 - 0.5 * nrm.y);
      col = bark * (SUNC * max(dot(nrm, SUN), 0.0) + AMB * (0.9 + 0.5 * nrm.y) + bounce);
    }
    pa = pb;
  }
  // ---- crown
  vec3 C = PT3 + vec3(0.0, 0.1, 0.0);
  vec3 oc = ro - (C + vec3(0.0, -0.7, 0.0));
  float bb = dot(oc, rd), cc = dot(oc, oc) - 3.4 * 3.4;
  if ((bb * bb - cc > 0.0 && bb < 0.0) || cc < 0.0) {
    // The coconuts, tucked under the leaves.
    for (int k = 0; k < 3; k++) {
      vec3 cp = C + vec3(-0.12 + 0.12 * float(k), -0.30 - 0.06 * float(k == 1), 0.10 - 0.1 * float(k));
      vec3 o2 = ro - cp;
      float b2 = dot(o2, rd), c2 = dot(o2, o2) - 0.15 * 0.15, h2 = b2 * b2 - c2;
      if (h2 > 0.0) {
        float t = -b2 - sqrt(h2);
        if (t > 0.0 && t < best) {
          best = t; hit = true;
          vec3 nrm = normalize(ro + rd * t - cp);
          col = lin(vec3(0.40, 0.31, 0.15)) * (SUNC * max(dot(nrm, SUN), 0.0) * 0.8 + AMB * 0.6);
        }
      }
    }
    for (int i = 0; i < 11; i++) {
      float fi = float(i);
      float h1 = hash11(fi * 3.7 + 1.0), h2 = hash11(fi * 5.3 + 2.0);
      float phi = fi * 0.571 + 0.4 * h1 + 0.07 * sin(T * 0.18 + fi);
      float sway = 0.03 * sin(T * 0.35 + fi * 1.7) + 0.10 * MOTION * sin(T * 1.9 + fi * 2.3);
      float th = 0.22 + 0.62 * h2 + sway;
      float L = 2.6 + 0.8 * h1;
      vec3 d0 = vec3(cos(phi) * cos(th), sin(th), sin(phi) * cos(th));
      // A frond is only worth its sixteen triangles if the ray comes near it.
      vec3 fc = C + d0 * (L * 0.5) - vec3(0.0, 0.35, 0.0);
      vec3 fo = ro - fc;
      float fb = dot(fo, rd);
      if (fb * fb - (dot(fo, fo) - sq(L * 0.62 + 0.4)) < 0.0) continue;
      // Spine points, the leaflet wings' hinge, and how wide each is.
      vec3 S[5];
      vec3 W[5];
      float Ww[5];
      for (int k = 0; k < 5; k++) {
        float s = L * float(k) / 4.0;
        S[k] = C + d0 * s + vec3(0.0, -0.95 * s * s * (0.45 + 0.55 * h2) / L, 0.0);
        float u = float(k) / 4.0;
        Ww[k] = 0.62 * sin(3.1416 * pow(clamp(u, 0.02, 1.0), 0.65)) * (1.0 - 0.25 * u);
      }
      for (int k = 0; k < 5; k++) {
        vec3 tg = normalize(S[min(k + 1, 4)] - S[max(k - 1, 0)]);
        W[k] = normalize(cross(tg, vec3(0.0, 1.0, 0.0)) + vec3(1e-4));
      }
      for (int wing = 0; wing < 2; wing++) {
        float sg = wing == 0 ? 1.0 : -1.0;
        for (int k = 0; k < 4; k++) {
          vec3 a0 = S[k], a1 = S[k + 1];
          vec3 dir0 = normalize(W[k] * sg * 0.84 + vec3(0.0, -0.54, 0.0));
          vec3 dir1 = normalize(W[k + 1] * sg * 0.84 + vec3(0.0, -0.54, 0.0));
          vec3 b0 = a0 + dir0 * Ww[k], b1 = a1 + dir1 * Ww[k + 1];
          vec2 uv;
          float t = triHit(ro, rd, a0, a1, b1, uv);
          float f = uv.x + uv.y, w = uv.y;
          if (t < 0.0) { t = triHit(ro, rd, a0, b1, b0, uv); f = uv.x; w = uv.x + uv.y; }
          if (t > 0.0 && t < best) {
            float s = (float(k) + f) / 4.0;
            // The comb: leaflets raked toward the tip, a rachis down the middle.
            float lf = fract(s * L * 7.5 - w * 1.1 + h1 * 7.0);
            float leaflet = sstep(0.08, 0.22, lf) * sstep(0.97, 0.78, lf) * sstep(1.0, 0.82, w);
            float rachis = sstep(0.035, 0.015, w);
            if (leaflet + rachis > 0.5) {
              best = t; hit = true;
              vec3 nrm = normalize(cross(b1 - a0, a1 - a0));
              if (dot(nrm, rd) > 0.0) nrm = -nrm;
              vec3 up = nrm.y >= 0.0 ? nrm : -nrm;
              vec3 base = mix(lin(vec3(0.06, 0.20, 0.05)), lin(vec3(0.26, 0.40, 0.09)), clamp(s * 0.9 + 0.2 * h2, 0.0, 1.0));
              base = mix(base, lin(vec3(0.35, 0.45, 0.20)), rachis);
              // The sun shines through: the leaf we see is lit from the other side.
              float lightUp = max(dot(up, SUN), 0.0);
              vec3 through = lin(vec3(0.38, 0.58, 0.14)) * SUNC * lightUp * 0.50;
              vec3 front = base * (SUNC * max(dot(nrm, SUN), 0.0) * 0.7 + AMB * (0.55 + 0.45 * nrm.y));
              vec3 hv = normalize(SUN - rd);
              float gloss = pow(max(dot(nrm, hv), 0.0), 40.0) * 0.30;
              col = front + through + SUNC * gloss;
            }
          }
        }
      }
    }
  }
  return hit ? best : -1.0;
}

// A shadow from the trunk onto the sand: three rays across the sun's disc.
float trunkShadow(vec3 x) {
  if (!nearPalm(x, SUN)) return 1.0;
  float lit = 0.0;
  vec3 side = normalize(cross(SUN, vec3(0.0, 1.0, 0.0)));
  for (int j = 0; j < 3; j++) {
    vec3 d = normalize(SUN + (float(j) - 1.0) * 0.012 * side);
    float s = 0.0;
    vec3 pa = trunkAt(0.0);
    for (int k = 0; k < 6; k++) {
      vec3 pb = trunkAt(float(k + 1) / 6.0);
      if (capHit(x, d, pa, pb, mix(0.21, 0.13, (float(k) + 0.5) / 6.0)) > 0.0) s = 1.0;
      pa = pb;
    }
    lit += 1.0 - s;
  }
  return lit / 3.0;
}

// --- the beach hut ----------------------------------------------------------------
// Four posts, a raised deck and a hipped roof of thatch, a signed distance
// marched inside its bounding sphere: a roof you could shelter under, on the
// far side of the picture from the palm.
const vec3 HUT = vec3(-6.4, 0.07, -10.8);         // the middle of its floor, on the sand
const float HUT_S = 0.75;                         // and how big, against the drawing below

float hutSD0(vec3 q) {
  float deck = sdBox3(q - vec3(0.0, 0.34, 0.0), vec3(2.1, 0.06, 1.8));
  vec3 pq = vec3(abs(q.x) - 1.9, q.y - 1.30, abs(q.z) - 1.6);
  float posts = sdBox3(pq, vec3(0.09, 1.25, 0.09));
  float ry = q.y - 2.45;
  float roof = max(max(abs(q.x), abs(q.z) * 1.15) - 3.0 * (1.0 - ry / 1.7), max(-ry, ry - 1.7)) * 0.7;
  roof += 0.07 * (noise(vec2(atan(q.z, q.x) * 16.0, q.y * 7.0)) - 0.5);      // strands of thatch
  return min(min(deck, posts), roof);
}

float hutSD(vec3 q) { return hutSD0(q / HUT_S) * HUT_S; }

float hutHit(vec3 ro, vec3 rd, float tmax) {
  vec3 oc = ro - (HUT + vec3(0.0, 1.9 * HUT_S, 0.0));
  float bb = dot(oc, rd), cc = dot(oc, oc) - sq(4.3 * HUT_S);
  float disc = bb * bb - cc;
  if (disc < 0.0 || (bb > 0.0 && cc > 0.0)) return -1.0;
  float t = max(-bb - sqrt(disc), 0.0);
  for (int i = 0; i < 40; i++) {
    float d = hutSD(ro + rd * t - HUT);
    if (d < 0.003 + 0.0004 * t) return t;
    t += d * 0.85;
    if (t > tmax) break;
  }
  return -1.0;
}

vec3 hutColor(vec3 P, vec3 rd) {
  vec3 q = P - HUT;
  const float e = 0.015;
  vec3 n = normalize(vec3(hutSD(q + vec3(e, 0.0, 0.0)) - hutSD(q - vec3(e, 0.0, 0.0)),
                          hutSD(q + vec3(0.0, e, 0.0)) - hutSD(q - vec3(0.0, e, 0.0)),
                          hutSD(q + vec3(0.0, 0.0, e)) - hutSD(q - vec3(0.0, 0.0, e))));
  bool roof = q.y > 2.3 * HUT_S;
  float strand = noise(vec2(atan(q.z, q.x) * 40.0, q.y * 14.0 / HUT_S));
  vec3 thatch = mix(lin(vec3(0.50, 0.38, 0.20)), lin(vec3(0.74, 0.60, 0.34)), strand) * (0.6 + 0.4 * sstep(2.3, 4.0, q.y / HUT_S));
  vec3 bamboo = mix(lin(vec3(0.50, 0.38, 0.22)), lin(vec3(0.64, 0.52, 0.32)), noise(vec2(q.y * 18.0 / HUT_S, q.x * 3.0)));
  vec3 alb = roof ? thatch : bamboo;
  float ndl = max(dot(n, SUN), 0.0);
  // Under the roof it is dim: the thatch is a lid on the posts and the deck.
  float under = roof ? 1.0 : 0.38;
  return alb * (SUNC * ndl * under + AMB * (0.55 + 0.45 * n.y) * (roof ? 1.0 : 0.6));
}

// --- far off -----------------------------------------------------------------------
// An islet on the horizon, with its palms, and a sail: drawn in the angles they
// subtend, since at this distance there is no parallax to be had.
vec4 horizonThings(vec3 rd, vec3 haze) {
  float az = atan(rd.x, -rd.z);
  float el = rd.y;
  vec4 r = vec4(0.0);
  // The islet: a low dome, sand at its feet, palms along its back.
  float ix = (az + 0.20) / 0.17;
  float dome = 0.021 * exp(-ix * ix) + 0.0006 * noise(vec2(az * 60.0, 3.0));
  float palms = 0.0;
  for (int k = 0; k < 5; k++) {
    float fk = float(k);
    float pa = -0.20 + (fk - 2.0) * 0.045 + 0.012 * hash11(fk * 3.0);
    float pd = az - pa;
    float pix = (pa + 0.20) / 0.17;
    float base = 0.021 * exp(-pix * pix);
    float h = 0.016 + 0.007 * hash11(fk + 5.0);
    float lean = 0.0035 * (hash11(fk + 9.0) - 0.5) * 2.0;
    float trunk = fill(abs(pd - lean * (el - base) / h) - 0.0009, 0.0004) * step(base, el) * step(el, base + h);
    vec2 cq = vec2(pd - lean, el - (base + h));
    // A crown: a flat tuft with three fronds drooping from it.
    float crown = fill(length(cq * vec2(1.0, 2.8)) - 0.0100, 0.0005);
    float fr = min(sdSeg(cq, vec2(0.0, 0.0), vec2(-0.0125, -0.0060)),
                   min(sdSeg(cq, vec2(0.0, 0.0), vec2(0.0125, -0.0065)), sdSeg(cq, vec2(0.0, 0.0), vec2(0.0, -0.0085))));
    palms = max(palms, max(trunk, max(crown, fill(fr - 0.0007, 0.0004))));
  }
  float islet = max(fill(el - dome, 0.0003), palms) * step(-0.002, el);
  r.a = islet;
  r.rgb = mix(lin(vec3(0.10, 0.24, 0.12)), haze, 0.55);
  // A sail, crossing slowly.
  float bx = -0.9 + mod(T * 0.0012 + 0.55, 2.0);
  float sx = az - bx;
  float sail = fill(max(max(-el + 0.0003, el - 0.0095), abs(sx + (el - 0.0003) * 0.4) - (0.0095 - el) * 0.28 + 0.0004), 0.0003);
  float hull = fill(sdBox(vec2(sx, el - 0.0004), vec2(0.0042, 0.0005)), 0.0002);
  r.rgb = mix(r.rgb, lin(vec3(0.97, 0.97, 0.95)), sail * 0.9 * step(0.0, el));
  r.rgb = mix(r.rgb, lin(vec3(0.30, 0.34, 0.40)), hull);
  r.a = max(r.a, max(sail * 0.85, hull) * step(-0.0006, el));
  return r;
}

// Gulls, gliding: a bent line with a slow roll, far enough that they are marks.
float gulls(vec3 rd) {
  float az = atan(rd.x, -rd.z);
  float acc = 0.0;
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    vec2 c = vec2(-0.45 + 0.55 * fk + 0.06 * sin(T * 0.05 + fk * 2.0), 0.20 + 0.05 * sin(T * 0.07 + fk * 3.0) + 0.04 * fk);
    vec2 q = vec2(az, rd.y) - c;
    float flex = 0.006 * sin(T * 0.6 + fk * 1.7);
    float wing = abs(q.y + 0.35 * abs(q.x) - 0.0012 * 0.0 - flex * abs(q.x) * 20.0) - 0.0011;
    acc = max(acc, fill(max(wing, abs(q.x) - 0.012), 0.0006));
  }
  return acc;
}

vec3 skyAtI(vec3 rd, float sunK) {
  vec3 sky = atmosphere(rd, 0.0) + sunDisc(rd) * sunK;
  vec4 cl = cloudMarch(CAMI * 0.001, rd, 0.0);
  return sky * cl.a + cl.rgb;
}

vec4 scene(vec2 p, out vec3 emit) {
  emit = vec3(0.0);
  float elev = mix(0.40 + 0.08 * ELEV, 0.05, NIGHT);
  sunSetup(elev, 0.55);
  CL_BASE = 1.3; CL_TOP = 2.5; CL_COVER = 0.36; CL_SCALE = 0.95;
  vec3 ro = CAMI;
  vec3 rd = camRay(p, 0.05);
  vec3 col;
  float recv = 0.0;

  // The sand: a plane through the waterline, sloping at BEACH_SLOPE.
  vec3 pn = normalize(vec3(0.0, 1.0, -BEACH_SLOPE));
  float ts = (0.0 - dot(ro, pn) + dot(vec3(0.0, 0.0, -SHORE_Z), pn)) / dot(rd, pn);
  vec3 Ps = ro + rd * ts;
  bool onSand = ts > 0.0 && Ps.y > 0.0;
  float tw = rd.y < -1e-5 ? -ro.y / rd.y : 1e6;

  if (onSand) {
    float fp = ts * PX / FOCAL;
    float lap = 0.9 * sin(T * 0.45 + Ps.x * 0.12) + 0.35 * sin(T * 0.9 + Ps.x * 0.31);
    float wet = sstep(-3.2, -0.3, (-Ps.z - SHORE_Z) + 0.8 * lap);
    vec3 alb = sandAt(Ps.xz, fp, wet);
    vec3 n = normalize(pn + vec3(noise(Ps.xz * 7.0) - 0.5, 0.0, noise(Ps.xz * 7.0 + 9.0) - 0.5) * 0.10 * sstep(0.5, 0.05, fp));
    float ndl = max(dot(n, SUN), 0.0);
    float sh = trunkShadow(Ps);
    col = alb * (SUNC * ndl * sh + AMB * 0.9);
    // Wet sand is a mirror: a thin film of water giving back the sky.
    vec3 rr = reflect(rd, n);
    float fr = (0.02 + 0.98 * pow(1.0 - clamp(dot(-rd, n), 0.0, 1.0), 5.0)) * wet;
    col = mix(col, skyAtI(vec3(rr.x, abs(rr.y), rr.z), 0.1), fr * 0.8);
    recv = 0.55;
  } else if (tw < 1e5) {
    // ---- the sea
    vec3 P = ro + rd * tw;
    float fp = tw * PX / FOCAL;
    float depth = seaDepth(P.xz);
    float shoal = sstep(2.0, 0.0, depth);
    vec2 g = seaSlope(P.xz, fp, shoal);
    vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
    vec3 rr = reflect(rd, n);
    rr.y = abs(rr.y);
    float fres = 0.02 + 0.98 * pow(1.0 - clamp(dot(-rd, n), 0.0, 1.0), 5.0);
    vec3 refl = skyAtI(rr, 1.0);
    // Under the surface: the bottom, lit by the sun through the water and
    // netted with caustics, then dimmed and turned blue-green by the depth.
    vec3 rf = refract(rd, n, 0.75);
    float path = depth / max(-rf.y, 0.15);
    vec2 bx = P.xz + rf.xz / max(-rf.y, 0.15) * depth;
    float cf = sstep(0.8, 0.12, fp);
    float caus = mix(0.5, clamp(caustic(mod(bx * 2.4, 6.2832) - 250.0, T * 0.30), 0.0, 3.0) * 1.2 + 0.4, cf);
    vec3 bed = sandAt(bx, fp, 1.0);
    vec3 sunDown = SUNC * exp(-depth * vec3(0.28, 0.08, 0.05) / max(SUN.y, 0.2));
    vec3 bottom = bed * (sunDown * caus * max(SUN.y, 0.2) + AMB * 0.7);
    vec3 absorb = exp(-path * vec3(0.30, 0.060, 0.038));
    vec3 scatter = lin(vec3(0.03, 0.55, 0.58)) * (AMB * 1.1 + SUNC * 0.14);
    vec3 deepC = lin(vec3(0.015, 0.20, 0.38)) * (AMB * 0.9 + SUNC * 0.05);
    vec3 body = bottom * absorb + mix(scatter, deepC, sstep(1.8, 9.0, depth)) * (1.0 - absorb);
    col = mix(body, refl, fres * 0.92);
    // The sun's glitter: where a facet happens to face it.
    vec3 h = normalize(SUN - rd);
    float nh = max(dot(n, h), 0.0);
    float rough = 0.014 + fp * 0.02;
    col += SUNC * pow(nh, 1.0 / (rough * rough * 2.0 + 1e-4)) * 0.3 * rough;
    // Foam: the break on the reef, and the shore lapping.
    float zf = -P.z;
    float breakN = noise(vec2(P.x * 0.3 + T * 0.04, zf * 0.7 - T * 0.18));
    float reef = exp(-sq((zf - 167.0) / 5.0)) * sstep(0.45, 0.8, breakN);
    float shore = sstep(0.30, 0.0, depth + 0.12 * sin(T * 0.4 + P.x * 0.2)) *
                  (0.55 + 0.45 * noise(P.xz * 1.5 + vec2(0.0, T * 0.12)));
    col = mix(col, lin(vec3(0.96, 0.98, 0.98)) * (SUNC * 0.5 + AMB), clamp(reef + shore, 0.0, 1.0) * 0.85);
    col = aerial(col, ro * 0.001, rd, tw * 0.001, 0.035, 0.0);
    recv = 0.25 * sstep(40.0, 8.0, tw);
  } else {
    col = skyAtI(rd, 1.0);
    col = mix(col, lin(vec3(0.97, 0.97, 0.96)) * (SUNC * 0.2 + AMB * 1.3), gulls(rd) * 0.9);
  }
  // Far off: the islet and the sail, in front of the sky.
  if (!onSand && rd.y > -0.0006 && rd.y < 0.045) {
    vec4 ht = horizonThings(rd, atmosphere(vec3(rd.x, 0.05, rd.z), 0.0));
    col = mix(col, ht.rgb, ht.a);
  }
  // The hut, on the sand, in front of whatever is behind it.
  float tSurf = onSand ? ts : (tw < 1e5 ? tw : 1e5);
  float th = hutHit(ro, rd, min(tSurf, 60.0));
  if (th > 0.0) { col = aerial(hutColor(ro + rd * th, rd), ro * 0.001, rd, th * 0.001, 0.035, 0.0); recv = 0.4; }
  // The palm in front of everything it covers.
  vec3 pc;
  float tp = palmHit(ro, rd, onSand ? ts : 1e5, pc);
  if (tp > 0.0) { col = pc; recv = 0.2; }
  return vec4(col, recv);
}
`;

  // --- the cyber café -------------------------------------------------------
  //
  // Evening in a brick-walled café. The brick is a height field, so a lamp or a
  // neon tube skimming the wall picks out every course and mortar line, and the
  // wall is lit by pools — two pendant lamps with dome shades, the pink and cyan
  // neon cup, a string of bulbs, the cool street through the glass. Over a
  // counter, a row of laptops (real boxes, their screens scrolling code), a mug
  // with steam that bends when you move, a shelf of jars. The street window is
  // wet: drops slide down it, each a lens that shows the night upside down, over
  // a city of lit windows and out-of-focus lights. The neon breathes; it never
  // flashes.
  var CAFE = `
// Metres. The camera is the origin, 1.25 m above the floor, looking down -z at
// the back wall of a brick café, over a counter. The street window is in the
// back wall on the key-light side (+x); main() mirrors the room otherwise.
const float FLOOR_Y = -1.25, CEIL_Y = 1.25, WALL_Z = -3.2;
const float CT = -0.42, CZ0 = -2.55, CZ1 = -1.75;                    // the counter's top and its edges
const float WX0 = 0.62, WX1 = 2.7, WY0 = -0.12, WY1 = 1.08;          // the street window
const vec3  PEND1 = vec3(0.30, 0.70, -2.15);
const vec3  PEND2 = vec3(-1.60, 0.78, -2.35);
const vec3  NEON_C = vec3(-1.25, 0.46, WALL_Z + 0.03);

vec3 gCol;
float gEmit;
vec3 lampA, lampB, neonA, neonB;     // the colours of the room's lights

// --- the brick ---------------------------------------------------------------
// Height of a running-bond wall, in 0..1: mortar low, brick faces high, the
// edges rounded. uv in metres.
float brickH(vec2 uv, out vec2 cell) {
  vec2 b = uv / vec2(0.225, 0.075);
  float row = floor(b.y);
  b.x += 0.5 * mod(row, 2.0);
  cell = vec2(floor(b.x), row);
  vec2 f = fract(b);
  float ex = min(f.x, 1.0 - f.x) * 0.225, ey = min(f.y, 1.0 - f.y) * 0.075;
  float e = min(ex, ey);
  return sstep(0.0, 0.0085, e);
}

// --- the street, out of focus -----------------------------------------------------
// Night in a city seen through wet glass: a violet sky, blocks of buildings
// with a few lit windows, and on the road below, the long reflections of
// whatever is lit — all of it a long way out of focus.
vec3 street(vec2 uv) {
  vec3 c = mix(lin(vec3(0.05, 0.06, 0.13)), lin(vec3(0.20, 0.13, 0.26)), sstep(0.7, -0.2, uv.y));
  // Blocks: columns of different heights, three ranks back.
  for (int r = 0; r < 3; r++) {
    float fr = float(r);
    float sc = 2.6 + fr * 1.7;
    float col = floor(uv.x * sc + fr * 7.3);
    float h = -0.05 + 0.34 * hash11(col * 3.1 + fr * 11.0) - 0.10 * fr;
    float body = sstep(h + 0.012, h - 0.012, uv.y) * sstep(-0.62, -0.5, uv.y);
    vec3 bc = mix(lin(vec3(0.07, 0.07, 0.12)), lin(vec3(0.11, 0.09, 0.15)), fr * 0.4);
    c = mix(c, bc, body);
    // A few lit windows in each block.
    vec2 wg = vec2(uv.x * sc * 7.0 + fr * 5.0, uv.y * 9.0);
    vec2 wid = floor(wg);
    float lit = step(0.80, hash12(wid + col * 13.0 + fr * 3.0)) * sstep(0.42, 0.30, abs(fract(wg.x) - 0.5)) *
                sstep(0.40, 0.26, abs(fract(wg.y) - 0.5)) * body;
    c += lin(vec3(1.0, 0.74, 0.44)) * lit * 0.26 * (hash12(wid) > 0.5 ? 1.0 : 0.6);
  }
  // Passers-by under umbrellas, crossing the pavement a long way off: shadows,
  // soft with distance and wet glass, picked out by the shop lights behind them.
  for (int k = 0; k < 2; k++) {
    float fk = float(k);
    float x0 = mod(T * (0.045 + 0.012 * fk) + 1.35 * fk, 3.2) - 1.55;
    vec2 q = uv - vec2(x0, -0.34 + 0.02 * fk);
    float sc = 1.0 + 0.25 * fk;
    q /= sc;
    float body = fill(length(q * vec2(1.0, 0.36) - vec2(0.0, -0.07)) - 0.050, 0.040);
    float head = fill(length(q - vec2(0.0, 0.052)) - 0.030, 0.025);
    float dome = fill(max(length(q * vec2(0.62, 1.0) - vec2(0.0, 0.058)) - 0.095, -(q.y - 0.050)), 0.025);
    float figure = max(max(body, head), dome);
    vec3 sil = lin(vec3(0.015, 0.016, 0.03)) + lin(vec3(1.0, 0.65, 0.35)) * 0.06 * sstep(-0.05, 0.10, q.y);
    c = mix(c, sil, figure * 0.92 * sstep(-0.62, -0.45, uv.y));
  }
  // Out-of-focus lights: lamp posts, signs, the tail-lights of cars.
  for (int L = 0; L < 2; L++) {
    float fl = float(L);
    float sc = 4.2 + fl * 3.2;
    vec2 g = uv * sc + vec2(fl * 13.1, fl * 7.7);
    vec2 cid = floor(g);
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 cc = cid + vec2(float(i), float(j));
        vec2 h = hash22(cc + fl * 31.0);
        if (h.x < 0.66) continue;
        vec2 o = cc + 0.5 + (h - 0.5) * 0.7;
        float r = 0.26 + 0.16 * hash12(cc + 9.0);
        float d = length(g - o);
        float h2 = hash12(cc + 17.0);
        vec3 bc = h2 > 0.78 ? lin(vec3(1.0, 0.22, 0.18)) : h2 > 0.50 ? lin(vec3(1.0, 0.70, 0.36)) :
                  h2 > 0.28 ? lin(vec3(0.50, 0.76, 1.0)) : lin(vec3(1.0, 0.95, 0.85));
        c += bc * (sstep(r, r * 0.74, d) * 0.55 + exp(-d * d / (r * r) * 2.0) * 0.16) *
             (0.34 + 0.08 * sin(T * 0.3 + h.y * 30.0)) * sstep(-0.55, -0.1, uv.y);
      }
    }
  }
  // The wet road, a streak of colour under each light.
  float road = sstep(-0.45, -0.58, uv.y);
  float streak = noise(vec2(uv.x * 9.0, 3.0)) * noise(vec2(uv.x * 23.0 + 5.0, 1.0));
  vec3 rc = mix(lin(vec3(1.0, 0.30, 0.22)), lin(vec3(1.0, 0.72, 0.38)), noise(vec2(uv.x * 5.0, 9.0)));
  c += rc * road * streak * 0.9 * sstep(-0.95, -0.5, uv.y);
  return c;
}

// Rain on the glass: drops that slide a little way, trailing a thin line, and a
// scatter of beads that stay. xy is where the drop bends the view (a drop is a
// lens, and shows the street upside down), z how much of the glass is wet.
vec3 rain(vec2 uv) {
  vec3 acc = vec3(0.0);
  for (int L = 0; L < 2; L++) {
    float s = L == 0 ? 1.0 : 1.9;
    vec2 q = uv * vec2(6.5, 2.4) * s + vec2(float(L) * 5.3, 0.0);
    float col = floor(q.x);
    float hc = hash11(col * 7.31 + float(L) * 31.7);
    float speed = 0.012 + 0.020 * hc;
    q.y += T * speed + hc * 19.0;
    vec2 id = vec2(col, floor(q.y));
    vec2 f = vec2(fract(q.x), fract(q.y));
    vec3 h3 = vec3(hash12(id), hash12(id + 2.1), hash12(id + 5.7));
    if (h3.x < 0.55) {
      float cx = 0.5 + (h3.y - 0.5) * 0.45 + 0.05 * sin(f.y * 18.0 + h3.z * 6.0);
      float cy = 0.28 + 0.5 * h3.z;
      vec2 d = (f - vec2(cx, cy)) * vec2(1.0, 0.38) * vec2(1.0, 1.0);
      float r = length(d * vec2(1.0, 2.2));
      float drop = sstep(0.17, 0.06, r);
      // The trail runs up from the drop (it has been sliding down).
      float up = f.y - cy;
      float trail = step(0.0, up) * sstep(0.020 + 0.02 * (1.0 - up), 0.0, abs(f.x - cx - 0.04 * sin(up * 14.0))) * sstep(0.85, 0.0, up) * 0.35;
      vec2 off = -(f - vec2(cx, cy)) * vec2(1.0, 0.45) * drop * 0.9;
      acc.xy += off;
      acc.z = max(acc.z, max(drop, trail));
    }
  }
  // Beads: a fixed scatter of tiny drops.
  vec2 g = uv * 34.0;
  vec2 gi = floor(g);
  vec2 hb = hash22(gi);
  float bead = step(0.86, hb.x) * sstep(0.22 + 0.10 * hb.y, 0.04, length(fract(g) - 0.5 - (hb - 0.5) * 0.4));
  acc.xy += -(fract(g) - 0.5) * bead * 0.5;
  acc.z = max(acc.z, bead * 0.8);
  return acc;
}


// --- the things on the counter, and over it ------------------------------------------
// A laptop: a base and a lid open toward you. gCol / gEmit say what it is.
float laptop(vec3 p, float lid) {
  float base = sdBox3(p - vec3(0.0, 0.010, 0.0), vec3(0.17, 0.010, 0.115));
  vec3 q = p - vec3(0.0, 0.021, -0.11);
  float ca = cos(lid), sa = sin(lid);
  q = vec3(q.x, q.y * ca - q.z * sa, q.y * sa + q.z * ca);
  float panel = sdBox3(q - vec3(0.0, 0.105, 0.0), vec3(0.17, 0.105, 0.006));
  return min(base, panel);
}

float map(vec3 p) {
  float d = 1e3;
  gEmit = 0.0;
  gCol = vec3(0.1);
  // Laptops, left, centre and right, each turned a little.
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec3 c = vec3(-1.55 + fi * 1.7, CT, -2.2 - 0.04 * fi);
    vec3 q = p - c;
    float ya = 0.25 - fi * 0.22;
    q.xz = rot(ya) * q.xz;
    if (length(q.xz) < 0.4 && q.y < 0.4) {
      float dl = laptop(q, 0.28 + 0.04 * fi);
      if (dl < d) { d = dl; gCol = lin(vec3(0.62, 0.63, 0.66)); gEmit = 0.0; if (q.y > 0.03 && q.z < -0.08) { gEmit = 1.0 + fi; } }
    }
  }
  // A wall shelf on the left, with jars of beans and a trailing plant.
  vec3 sq = p - vec3(-1.98, 0.22, WALL_Z + 0.14);
  if (length(sq.xz) < 0.9 && abs(sq.y) < 0.5) {
    float board = sdBox3(sq, vec3(0.42, 0.012, 0.13));
    if (board < d) { d = board; gCol = lin(vec3(0.34, 0.22, 0.13)); gEmit = 0.0; }
    for (int j = 0; j < 4; j++) {
      float fj = float(j);
      vec3 jq = sq - vec3(-0.30 + fj * 0.15, 0.012 + 0.07 + 0.02 * hash11(fj), 0.0);
      float jar = sdCylY(jq, 0.052, 0.07 + 0.02 * hash11(fj));
      if (jar < d) {
        d = jar;
        gCol = j == 0 ? lin(vec3(0.46, 0.30, 0.14)) : j == 1 ? lin(vec3(0.30, 0.20, 0.10)) :
               j == 2 ? lin(vec3(0.80, 0.72, 0.52)) : lin(vec3(0.20, 0.28, 0.18));
        gEmit = 0.0;
      }
    }
    // The plant: a pot and four leaves arching over the shelf's edge.
    vec3 pq = sq - vec3(0.34, 0.012 + 0.05, 0.0);
    float pot = sdCylY(pq, 0.045, 0.05);
    if (pot < d) { d = pot; gCol = lin(vec3(0.74, 0.74, 0.70)); gEmit = 0.0; }
    for (int k = 0; k < 5; k++) {
      float fk = float(k);
      vec3 lq = pq - vec3(0.0, 0.07, 0.0);
      float a = fk * 1.26 + 0.4;
      vec3 dir = vec3(cos(a) * 0.9, 0.0, sin(a) * 0.4);
      vec3 lc = dir * 0.10 + vec3(0.0, 0.03 - 0.07 * fk * 0.3, 0.0);
      vec3 r = lq - lc;
      float lf = sdEllipsoid(vec3(dot(r, normalize(dir + vec3(0.0, 0.3, 0.0))), r.y * 3.0, dot(r, vec3(-dir.z, 0.0, dir.x))), vec3(0.085, 0.012, 0.035));
      if (lf < d) { d = lf; gCol = lin(vec3(0.14, 0.34, 0.12)); gEmit = 0.0; }
    }
  }
  // A mug.
  vec3 mq = p - vec3(0.42, CT + 0.045, -2.12);
  float mug = max(sdCylY(mq, 0.043, 0.045), -(mq.y - 0.04) + 0.0 - 0.0) ;
  float mugIn = sdCylY(mq - vec3(0.0, 0.012, 0.0), 0.037, 0.04);
  mug = max(mug, -mugIn);
  float handle = max(abs(length(mq.xy - vec2(0.05, 0.0)) - 0.024) - 0.005, abs(mq.z) - 0.005);
  mug = min(mug, handle);
  if (mug < d) { d = mug; gCol = lin(vec3(0.90, 0.88, 0.84)); gEmit = 0.0; }
  // Pendant lamps: a cord, a dome shade, and a bulb that is the light.
  for (int k = 0; k < 2; k++) {
    vec3 lp = k == 0 ? PEND1 : PEND2;
    lp.x += (k == 0 ? 0.006 : 0.005) * sin(T * 0.5 + float(k));
    vec3 q = p - lp;
    float cord = sdCapsule(q, vec3(0.0, 0.05, 0.0), vec3(0.0, CEIL_Y - lp.y, 0.0), 0.003);
    float shade = max(sdEllipsoid(q - vec3(0.0, 0.02, 0.0), vec3(0.15, 0.115, 0.15)), -(q.y + 0.045));
    float bulb = length(q - vec3(0.0, -0.025, 0.0)) - 0.032;
    if (cord < d) { d = cord; gCol = lin(vec3(0.05)); gEmit = 0.0; }
    if (shade < d) { d = shade; gCol = lin(vec3(0.10, 0.11, 0.10)); gEmit = 0.0; }
    if (bulb < d) { d = bulb; gCol = lin(vec3(1.0, 0.82, 0.55)); gEmit = 9.0; }
  }
  return d;
}

float marchObjects(vec3 ro, vec3 rd, float tmax) {
  float t = 0.4;
  for (int i = 0; i < 44; i++) {
    vec3 p = ro + rd * t;
    float h = map(p);
    if (h < 0.0015) return t;
    t += h * 0.9;
    if (t > tmax) break;
  }
  return -1.0;
}

vec3 mapNormal(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  const float e = 0.0015;
  return normalize(k.xyy * map(p + k.xyy * e) + k.yyx * map(p + k.yyx * e) +
                   k.yxy * map(p + k.yxy * e) + k.xxx * map(p + k.xxx * e));
}

// A point light's contribution at x: soft falloff, and a floor under the
// distance so a lamp near the wall cannot blow it out.
vec3 pointLight(vec3 x, vec3 n, vec3 lp, vec3 lc, float k) {
  vec3 lv = lp - x;
  float d2 = dot(lv, lv);
  return lc * max(dot(n, lv * inversesqrt(d2)), 0.0) * k / (0.10 + d2 * d2 * 0.18 + d2 * 0.55);
}

// A pendant with a dome shade: the light goes mostly downward, so the wall is
// washed below the lamp and the ceiling above it is left in the dark.
vec3 pendantLight(vec3 x, vec3 n, vec3 lp, vec3 lc, float k) {
  vec3 lv = lp - x;
  float d2 = dot(lv, lv);
  vec3 l = lv * inversesqrt(d2);
  float cone = pow(max(-l.y, 0.0), 1.6) * 0.92 + 0.08;
  return lc * max(dot(n, l), 0.0) * cone * k / (0.10 + d2 * 0.55 + d2 * d2 * 0.12);
}

vec4 scene(vec2 p, out vec3 emit) {
  emit = vec3(0.0);
  lampA = lin(vec3(1.0, 0.68, 0.36));
  lampB = lin(vec3(1.0, 0.62, 0.30));
  neonA = lin(vec3(1.0, 0.28, 0.58));
  neonB = lin(vec3(0.28, 0.86, 1.0));
  float glowK = 0.93 + 0.07 * sin(T * 0.9);            // the neon breathes, it never flashes
  float rec = 0.85;

  vec3 ro = vec3(0.0);
  vec3 rd = camRay(p, 0.0);
  // The wall, the ceiling, and the counter (its top and its face).
  float tw = rd.z < -1e-4 ? WALL_Z / rd.z : 1e5;
  float tc = rd.y > 1e-4 ? CEIL_Y / rd.y : 1e5;
  float tt = 1e5, tfc = 1e5;
  if (rd.y < -1e-4) {
    float t1 = CT / rd.y;
    float z1 = rd.z * t1;
    if (z1 < CZ1 && z1 > CZ0) tt = t1;
  }
  if (rd.z < -1e-4) {
    float t2 = CZ1 / rd.z;
    float y2 = rd.y * t2;
    if (y2 < CT && y2 > FLOOR_Y) tfc = t2;
  }
  float tp = min(min(tw, tc), min(tt, tfc));
  float to = marchObjects(ro, rd, tp);
  float t = to > 0.0 ? to : tp;
  vec3 X = rd * t;
  vec3 n;
  vec3 alb;
  vec3 col = vec3(0.0);
  float rough = 0.9, spec = 0.0;
  float glass = 0.0;
  vec3 glassCol = vec3(0.0);
  bool isWall = false;

  if (to > 0.0) {
    n = mapNormal(X);
    map(X);
    alb = gCol;
    if (gEmit > 0.5 && gEmit < 4.0) {
      // A screen: a dark ground and rows of code, scrolling up a line at a time.
      vec2 su = vec2(X.x * 3.0 + gEmit * 7.0, X.y * 22.0 - T * 0.35 * (0.8 + 0.2 * gEmit));
      float row = floor(su.y);
      float ind = floor(hash11(row + gEmit * 31.0) * 4.0) * 0.5;
      float wl = 0.8 + 3.0 * hash11(row * 1.3 + gEmit);
      float xx = su.x - ind;
      float word = step(0.0, fract(xx * 0.5 - 0.1)) * step(fract(xx * 0.5), wl * 0.3) * step(0.25, fract(xx * 3.0 + hash11(row)));
      float gl = word * sstep(0.2, 0.35, fract(su.y)) * sstep(0.8, 0.65, fract(su.y));
      vec3 tc2 = hash11(row * 7.0 + gEmit) > 0.7 ? lin(vec3(1.0, 0.75, 0.35)) : lin(vec3(0.45, 0.95, 0.75));
      emit += (lin(vec3(0.05, 0.09, 0.16)) + tc2 * gl * 0.9) * 0.9;
      alb = vec3(0.02);
    }
    if (gEmit > 8.0) { emit += alb * 4.0; alb = vec3(0.0); }
    rough = 0.4; spec = 0.25;
  } else if (t == tt) {
    n = vec3(0.0, 1.0, 0.0);
    alb = mix(lin(vec3(0.32, 0.19, 0.11)), lin(vec3(0.44, 0.27, 0.15)), noise(vec2(X.x * 5.0, X.z * 80.0)));
    spec = 0.9; rough = 0.25;
    rec = 0.4;
  } else if (t == tfc) {
    n = vec3(0.0, 0.0, 1.0);
    float slat = sstep(0.0, 0.006, 0.040 - abs(fract(X.x / 0.09) - 0.5) * 0.09);
    alb = lin(vec3(0.42, 0.24, 0.14)) * (0.50 + 0.50 * slat) * (0.8 + 0.2 * noise(vec2(X.x * 30.0, X.y * 3.0)));
    float rail = sstep(0.018, 0.006, abs(X.y + 1.05));
    alb = mix(alb, lin(vec3(0.72, 0.55, 0.28)), rail);
    spec = 0.0;
    spec = 0.3; rough = 0.5;
    rec = 0.4;
  } else if (t == tc) {
    n = vec3(0.0, -1.0, 0.0);
    alb = lin(vec3(0.12, 0.105, 0.10));
  } else {
    n = vec3(0.0, 0.0, 1.0);
    isWall = true;
    // Brick, with its relief taken from the height: the normal tilts toward the
    // lower mortar at every edge, which is what a light skimming the wall picks out.
    vec2 cell, c2;
    float h0 = brickH(X.xy, cell);
    float hx = brickH(X.xy + vec2(0.004, 0.0), c2);
    float hy = brickH(X.xy + vec2(0.0, 0.004), c2);
    vec3 bn = normalize(vec3(-(hx - h0) * 7.0, -(hy - h0) * 7.0, 1.0));
    float bh = hash12(cell);
    vec3 brick = lin(mix(vec3(0.40, 0.18, 0.12), vec3(0.58, 0.32, 0.21), bh)) * (0.72 + 0.4 * noise(X.xy * 50.0));
    brick *= 0.85 + 0.3 * noise(X.xy * 7.0);
    alb = mix(lin(vec3(0.36, 0.33, 0.30)), brick, h0);
    n = bn;
    rec = 0.9;
    // The street window.
    float inWin = fill(sdBox(X.xy - vec2(0.5 * (WX0 + WX1), 0.5 * (WY0 + WY1)), vec2(0.5 * (WX1 - WX0), 0.5 * (WY1 - WY0))), 0.003);
    if (inWin > 0.0) {
      vec2 gu = (X.xy - vec2(0.5 * (WX0 + WX1), 0.5 * (WY0 + WY1))) / 1.0;
      vec3 rn = rain(gu);
      vec2 look = gu + rn.xy * 0.16;
      vec3 view = street(look);
      float bar = max(fill(abs(X.x - 0.5 * (WX0 + WX1)) - 0.020, 0.004), fill(abs(X.y - 0.46) - 0.020, 0.004));
      // The room in the glass: a faint reflection of the lamps.
      vec3 refl = lampA * (exp(-length(X.xy - PEND1.xy * vec2(1.0, 1.0) * vec2(-0.8, 0.9)) * 3.0)) * 0.10;
      view = view + refl * 0.5 + lin(vec3(0.85, 0.92, 1.0)) * pow(rn.z, 1.6) * 0.10;
      view *= 1.0 - 0.18 * rn.z;
      glassCol = view;
      glass = inWin * (1.0 - bar);
      alb = mix(alb, lin(vec3(0.045, 0.045, 0.05)), inWin * bar);
      rec = 0.0;
    }
  }

  // ---- light ----
  vec3 L = vec3(0.085, 0.066, 0.064) + lin(vec3(0.9, 0.55, 0.30)) * 0.160 * (0.5 + 0.5 * n.z);
  // The rest of the café, behind the camera, lights whatever faces it.
  L += lin(vec3(1.0, 0.62, 0.34)) * (isWall ? 0.12 : (t == tfc ? 0.85 : 0.6)) * max(n.z, 0.0) * (0.6 + 0.4 * sstep(-1.25, 0.6, X.y));
  L += pendantLight(X, n, PEND1 + vec3(0.0, -0.03, 0.0), lampA * 7.5, 1.0);
  L += pendantLight(X, n, PEND2 + vec3(0.0, -0.03, 0.0), lampB * 6.0, 1.0);
  L += pointLight(X, n, vec3(NEON_C.x + 0.02, NEON_C.y, NEON_C.z + 0.35), neonA, 0.30 * glowK);
  L += pointLight(X, n, vec3(NEON_C.x + 0.22, NEON_C.y - 0.12, NEON_C.z + 0.40), neonB, 0.18 * glowK);
  // Cool light from the street, through the glass.
  L += pointLight(X, n, vec3(1.7, 0.4, WALL_Z + 0.6), lin(vec3(0.38, 0.55, 0.95)), 0.30);
  // Strings of bulbs along the top of the wall.
  L += pointLight(X, n, vec3(-0.4, 1.0, WALL_Z + 0.2), lin(vec3(1.0, 0.78, 0.48)), 0.35);
  col = alb * L;
  // Glossy surfaces (the counter, the mug) catch the lamps as highlights.
  if (spec > 0.0) {
    vec3 v = -rd;
    for (int k = 0; k < 2; k++) {
      vec3 lp = k == 0 ? PEND1 : PEND2;
      vec3 h = normalize(normalize(lp - X) + v);
      float nh = max(dot(n, h), 0.0);
      float sp = pow(nh, 1.0 / (rough * rough * 0.5 + 0.004));
      col += (k == 0 ? lampA : lampB) * sp * spec * 0.5 * (1.0 / (0.6 + dot(lp - X, lp - X) * 0.2));
    }
    // The counter also holds a smeared picture of the screens and the neon.
    if (t == tt) {
      col += neonA * exp(-sq((X.x - NEON_C.x) / 0.5)) * 0.10 * glowK + neonB * exp(-sq((X.x - NEON_C.x - 0.3) / 0.5)) * 0.05;
      col += lin(vec3(0.3, 0.55, 0.8)) * 0.05 * exp(-sq((X.x + 1.4) / 0.9)) + lin(vec3(0.3, 0.55, 0.8)) * 0.05 * exp(-sq((X.x - 1.0) / 0.9));
    }
  }

  // ---- the neon: a cup with three wisps of steam over a cyan underline ----
  if (isWall && glass < 0.5) {
    vec2 q = X.xy - NEON_C.xy;
    float cup = min(length(vec2(q.x, min(q.y - 0.01, 0.0))) - 0.07, 1e3);
    // Cup: a half-ring under a rim, a handle, wisps, an underline.
    float bowl = abs(length(q - vec2(0.0, 0.03)) - 0.075);
    bowl = q.y > 0.03 ? 1e3 : bowl;
    float rim = sdSeg(q, vec2(-0.075, 0.03), vec2(0.075, 0.03));
    float handle = abs(length(q - vec2(0.093, 0.0)) - 0.027); handle = q.x < 0.07 ? 1e3 : handle;
    float cupD = min(min(bowl, rim), handle);
    float wisp = 1e3;
    for (int k = 0; k < 3; k++) {
      vec2 sq2 = q - vec2(-0.035 + float(k) * 0.035, 0.065);
      float wav = 0.009 * sin(sq2.y * 60.0 - T * 1.1 + float(k) * 2.0);
      float dd = abs(sq2.x - wav);
      wisp = min(wisp, length(vec2(dd, max(max(-sq2.y, sq2.y - 0.08), 0.0))));
    }
    float underline = sdSeg(q, vec2(-0.12, -0.085), vec2(0.12, -0.085));
    float dA = cupD, dB = min(wisp, underline);
    col += neonA * (fill(dA - 0.0035, 0.0015) * 1.8 + exp(-dA * 55.0) * 0.55 + exp(-dA * 14.0) * 0.12) * glowK;
    col += neonB * (fill(dB - 0.0032, 0.0015) * 1.6 + exp(-dB * 55.0) * 0.5 + exp(-dB * 14.0) * 0.10) * glowK;
  }

  // ---- glow around the bulbs ----
  for (int k = 0; k < 2; k++) {
    vec3 lp = k == 0 ? PEND1 : PEND2;
    lp.y -= 0.025;
    float tl = dot(lp, rd);
    if (tl > 0.0 && tl < t) {
      float dd = length(cross(lp, rd));
      emit += (k == 0 ? lampA : lampB) * (exp(-dd * 22.0) * 0.30 + exp(-dd * 6.0) * 0.05);
    }
  }
  // A string of fairy lights, out of focus, along the top of the wall.
  {
    float bx = X.x / 0.34;
    float bc = floor(bx) + 0.5;
    vec3 bp = vec3(bc * 0.34, 1.05 - 0.10 * cos(bc * 0.34 * 0.9) , WALL_Z + 0.05);
    float tl = dot(bp, rd);
    float dd = length(cross(bp, rd));
    float tw2 = 0.75 + 0.25 * sin(T * 0.7 + hash11(bc) * 20.0);
    if (isWall && glass < 0.5 && tl > 0.0) {
      emit += lin(vec3(1.0, 0.78, 0.48)) * (sstep(0.030, 0.012, dd) * 0.9 + exp(-dd * 30.0) * 0.12) * tw2;
    }
  }
  // Steam over the mug: it bends when you move.
  {
    vec2 sp = p + stir(p, 0.015);
    // Project the mug's top onto the screen.
    vec3 top = vec3(0.42, CT + 0.10, -2.12);
    vec2 tp2 = vec2(top.x, top.y) / (-top.z) * FOCAL;
    vec2 st = sp - tp2;
    float rise = st.y;
    float wisp2 = fbm3(vec2(st.x * 90.0 + sin(rise * 60.0 - T * 0.9) * 0.6, rise * 28.0 - T * 0.5));
    float steam = sstep(0.52, 0.85, wisp2) * exp(-abs(st.x + 0.004 * sin(rise * 40.0 + T)) * 140.0) * sstep(0.0, 0.01, rise) * sstep(0.12, 0.02, rise);
    col += lin(vec3(0.8, 0.75, 0.7)) * steam * 0.20 * (0.4 + L.r * 0.5);
  }

  emit += glassCol * glass * 0.9;
  col *= 1.0 - glass;
  return vec4(col, rec);
}
`;

  // --- the mountain ---------------------------------------------------------
  //
  // An alpine lake at morning. The range is a ray-marched height field — summits
  // placed by hand, ridged noise eroded down their faces — with snow where snow
  // can lie, rock in strata, forest to the tree line, each ridge hazier than the
  // one in front; the skyline is anti-aliased from how near each ray came to it.
  // The lake mirrors all of it (the reflection is marched too) through ripples
  // that fade out by distance; a mist lies on it; the clouds throw their shade on
  // the slopes. Nearby, pines on the banks are real objects with a lit side and a
  // shaded one. Nothing here is near enough to take your shadow. In a dim room it
  // is the blue hour.
  var MOUNTAIN = `
// Units are kilometres, +x toward the key light, the camera looks down -z from
// a bank a few metres above a lake whose surface is y = 0.
const mat2 M2 = mat2(0.8, -0.6, 0.6, 0.8);
const float HMAX = 4.6;
const vec3 CAM = vec3(0.0, 0.0165, 0.0);

// The bank the camera stands on, with a promontory either side of it where
// the nearest pines grow.
float bankH(vec2 p) {
  vec2 a = p - vec2(-0.062, -0.075), b = p - vec2(0.070, -0.095);
  return 0.05 * exp(-dot(p, p) / sq(0.05)) + 0.046 * exp(-dot(a, a) / sq(0.034)) + 0.052 * exp(-dot(b, b) / sq(0.040));
}

// One summit: a steep cone, sharper than a gaussian, so each is a peak with
// its own shoulders and not a bump.
float summit(vec2 p, vec2 c, float R, float H) {
  float r = length(p - c) / R;
  return H * pow(max(1.0 - r, 0.0), 1.35);
}

// The land. Four summits placed by hand, so the picture has a composition —
// two big ones either side of a col the light comes through — and a fractal
// laid over everything: ridged octaves (the arêtes of a real range) damped by
// the slope accumulated so far, which cuts gullies down the faces instead of
// bumping them. Near the lake the same field is smoothed into foothills.
float terrainH(vec2 p, int oct) {
  float d = -p.y;
  // The bank the camera stands on; a forested headland on the light's side
  // and an islet on the other, so the lake has near, middle and far.
  vec2 q1 = p - vec2(1.7, -2.3), q2 = p - vec2(-1.2, -1.4);
  float land = bankH(p) +
               0.26 * exp(-dot(q1, q1) / sq(0.8)) * (0.6 + 0.8 * noise(p * 2.7)) +
               0.07 * exp(-dot(q2, q2) / sq(0.22)) * (0.6 + 0.8 * noise(p * 5.1 + 3.0));
  // Nothing but the lake and its banks within a kilometre of the camera.
  if (d < 1.0) return land - 0.035;
  vec2 x = p * 0.34 + vec2(3.1, 7.7);
  float a = 0.0, b = 1.0;
  vec2 dd = vec2(0.0);
  float rg = mix(0.2, 0.75, sstep(4.0, 9.0, d));
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    vec3 n = noised(x);
    float ridge = 1.0 - abs(2.0 * n.x - 1.0);
    float v = i == 0 ? n.x : mix(n.x, ridge, rg);
    dd += i == 0 ? n.yz : n.yz * 1.6;
    a += b * v / (1.0 + 0.8 * dd.x * dd.x + 0.8 * dd.y * dd.y);
    b *= 0.5;
    x = M2 * x * 2.02;
  }
  float big = summit(p, vec2(-2.8, -8.4), 4.8, 3.1) + summit(p, vec2(4.3, -10.2), 5.4, 3.5) +
              summit(p, vec2(-8.2, -9.4), 4.6, 2.7) + summit(p, vec2(9.8, -12.0), 5.2, 2.6) +
              summit(p, vec2(0.6, -15.0), 7.0, 2.8);
  float foot = 0.30 * sstep(2.2, 6.5, d);
  return a * foot + big * clamp(0.42 + 1.1 * a, 0.3, 1.3) - 0.035 + land;
}

vec3 terrainNormal(vec3 P, float t, int oct) {
  float e = max(0.0006, 0.0011 * t);
  float h0 = terrainH(P.xz, oct);
  float hx = terrainH(P.xz + vec2(e, 0.0), oct) - h0;
  float hz = terrainH(P.xz + vec2(0.0, e), oct) - h0;
  return normalize(vec3(-hx, e, -hz));
}

// How near the last march came to the land without touching it, as a fraction
// of a pixel, and where: a ray that grazes a ridge is partly that ridge, and
// painting it so is what keeps the skyline from being a staircase.
float gMiss, gTMiss, gTA, gTB;

float marchTerrain(vec3 ro, vec3 rd, float t0, float tmax, int steps, int oct, float grow) {
  float t = t0, tp = t0;
  for (int i = 0; i < 110; i++) {
    if (i >= steps) break;
    vec3 p = ro + rd * t;
    float H = terrainH(p.xz, t < 2.5 ? oct : oct - 1);
    float h = p.y - max(H, 0.0);
    float rm = h / (t * 0.0032 + 0.0002);
    bool nearest = false;
    if (rm < gMiss && H > 0.0) { gMiss = rm; gTMiss = t; gTA = tp; nearest = true; }
    if (h < 0.0003 * (1.0 + t * 0.7)) {
      if (H <= 0.0) return -1.0;
      // Settle between the last step and this one, so a face is a surface and
      // not a staircase of the step sizes.
      float a = tp, b = t;
      for (int k = 0; k < 6; k++) {
        float m = 0.5 * (a + b);
        vec3 q = ro + rd * m;
        if (q.y - terrainH(q.xz, oct) > 0.0) a = m; else b = m;
      }
      return 0.5 * (a + b);
    }
    if (p.y > HMAX && rd.y > 0.0) return -1.0;
    tp = t;
    t += max(0.5 * h, grow * t + 0.0004);
    if (nearest) gTB = t;
    if (t > tmax) return -1.0;
  }
  return rd.y > -0.0005 ? t : -1.0;
}

float terrainShadow(vec3 ro, vec3 rd) {
  float res = 1.0, t = 0.03;
  for (int i = 0; i < 14; i++) {
    vec3 p = ro + rd * t;
    float h = p.y - terrainH(p.xz, 3);
    res = min(res, 9.0 * h / t);
    t += clamp(h, 0.05, 0.9);
    if (res < 0.01 || p.y > HMAX) break;
  }
  return sstep(0.0, 1.0, clamp(res, 0.0, 1.0));
}

// What the land is made of: bare rock in strata, snow where it can lie, pine
// forest below the tree line, meadow and shingle at the water.
vec3 terrainColor(vec3 P, vec3 n, float t, bool full) {
  float h = P.y;
  float slope = n.y;
  float fp = t * PX / FOCAL;                       // km under one pixel here
  float fine = sstep(0.05, 0.004, fp);             // detail finer than that is noise
  float n1 = noise(P.xz * 16.0);
  float n2 = noise(P.xz * 60.0 + 7.0);
  float n3 = mix(0.5, noise(P.xz * 240.0), fine);
  float strata = noise(vec2(h * 50.0 + n1 * 2.5, dot(P.xz, vec2(0.8, 0.6)) * 1.5));
  vec3 rock = mix(lin(vec3(0.46, 0.43, 0.41)), lin(vec3(0.27, 0.25, 0.25)), sstep(0.3, 0.7, strata));
  rock = mix(rock, lin(vec3(0.55, 0.45, 0.36)), 0.25 * sstep(0.6, 0.9, n1));
  float treeLine = 1.45 + 0.18 * (n1 - 0.5);
  float forest = sstep(treeLine, treeLine - 0.3, h) * sstep(0.55, 0.78, slope + 0.1 * (n2 - 0.5));
  float tree = mix(n2, n3, 0.5);
  vec3 pines = mix(lin(vec3(0.045, 0.09, 0.05)), lin(vec3(0.15, 0.22, 0.08)), sstep(0.25, 0.8, tree));
  float tuft = noise(P.xz * 1500.0) * 0.55 + noise(P.xz * 380.0) * 0.45;
  vec3 meadow = mix(lin(vec3(0.20, 0.30, 0.09)), lin(vec3(0.42, 0.45, 0.17)), mix(n1, tuft, sstep(0.02, 0.003, fp)));
  float low = sstep(0.12, 0.02, h);
  vec3 alb = mix(rock, pines, forest);
  alb = mix(alb, meadow, low * sstep(0.7, 0.9, slope) * (1.0 - forest * 0.7));
  float shore = sstep(0.004, 0.0, h);
  alb = mix(alb, mix(lin(vec3(0.44, 0.41, 0.36)), lin(vec3(0.26, 0.24, 0.22)), n3), shore);
  float snowLine = 1.7 + 0.3 * (n1 - 0.5);
  float snow = sstep(snowLine, snowLine + 0.35, h + 0.45 * (slope - 0.55)) *
               sstep(0.38, 0.62, slope + 0.35 * (n2 - 0.5));
  alb = mix(alb, lin(vec3(0.92, 0.94, 0.97)), snow);

  float sh = 1.0;
  if (full) {
    sh = terrainShadow(P + n * 0.002, SUN);
    // And the shade of the clouds, drifting over the slopes: the slab looked
    // at from the ground up along the sun.
    float ts = max((CL_BASE + 0.4 * (CL_TOP - CL_BASE) - P.y) / max(SUN.y, 0.15), 0.0);
    sh *= mix(1.0, 0.45, 1.0 - exp(-cloudD(P + SUN * ts, false) * 1.8));
  }
  float ndl = max(dot(n, SUN), 0.0);
  // Forest canopy is rough: it takes light a little round the corner.
  ndl = mix(ndl, max(dot(n, SUN) * 0.5 + 0.5, 0.0), forest * 0.35);
  float ao = 0.55 + 0.45 * sstep(0.0, 1.0, slope);
  vec3 col = alb * (SUNC * ndl * sh + AMB * (0.55 + 0.45 * n.y) * ao);
  // Light coming back off the snow and the lake into the shade.
  col += alb * lin(vec3(0.55, 0.62, 0.7)) * 0.10 * (1.0 - n.y) * AMB;
  return col;
}

// A low mist lying on the lake, thicker in places and drifting.
vec3 lakeMist(vec3 col, vec3 ro, vec3 rd, float t) {
  const float H = 0.05;
  float k = rd.y / H;
  float od = (abs(k) < 1e-3 ? t : (1.0 - exp(-t * k)) / k) * exp(-max(ro.y, 0.0) / H);
  vec3 q = ro + rd * min(t, 5.0);
  float m = 0.3 + 1.3 * fbm3(q.xz * 1.1 + vec2(T * 0.010, T * 0.004));
  od *= 0.30 * m;
  vec3 fogC = lin(vec3(0.86, 0.90, 0.95)) * (AMB * 0.9 + SUNC * 0.16);
  return mix(col, fogC, 1.0 - exp(-od));
}


// --- the pier ---------------------------------------------------------------------
// A wooden jetty running out from the left bank: a deck of planks on posts a
// couple of metres apart, as a signed distance marched inside its own bounding
// sphere. It is what puts a human scale in the picture, and a line for the eye
// to follow out over the water.
const vec2 PIER_A = vec2(-0.054, -0.091);
const vec2 PIER_B = vec2(-0.037, -0.119);

float pierSD(vec3 p) {
  vec2 d = normalize(PIER_B - PIER_A);
  vec2 q = p.xz - PIER_A;
  float u = dot(q, d), v = dot(q, vec2(-d.y, d.x));
  float len = length(PIER_B - PIER_A);
  float deck = sdBox3(vec3(u - len * 0.5, p.y - 0.00130, v), vec3(len * 0.5, 0.00018, 0.00095));
  float uu = mod(u + 0.00175, 0.0035) - 0.00175;
  float post = max(sdCylY(vec3(uu, p.y + 0.0006, abs(v) - 0.0008), 0.00016, 0.0019), abs(u - len * 0.5) - len * 0.5);
  return min(deck, post);
}

float pierHit(vec3 ro, vec3 rd, float tmax) {
  vec3 c = vec3(0.5 * (PIER_A.x + PIER_B.x), 0.001, 0.5 * (PIER_A.y + PIER_B.y));
  float rb = 0.5 * length(PIER_B - PIER_A) + 0.004;
  vec3 oc = ro - c;
  float bb = dot(oc, rd), cc = dot(oc, oc) - rb * rb;
  float disc = bb * bb - cc;
  if (disc < 0.0 || (bb > 0.0 && cc > 0.0)) return -1.0;
  float t = max(-bb - sqrt(disc), 0.0);
  for (int i = 0; i < 44; i++) {
    float d = pierSD(ro + rd * t);
    if (d < 0.00006 + 0.0006 * t) return t;
    t += d * 0.8;
    if (t > tmax) break;
  }
  return -1.0;
}

vec3 pierColor(vec3 P) {
  const float e = 0.00012;
  vec3 n = normalize(vec3(pierSD(P + vec3(e, 0.0, 0.0)) - pierSD(P - vec3(e, 0.0, 0.0)),
                          pierSD(P + vec3(0.0, e, 0.0)) - pierSD(P - vec3(0.0, e, 0.0)),
                          pierSD(P + vec3(0.0, 0.0, e)) - pierSD(P - vec3(0.0, 0.0, e))));
  vec2 d = normalize(PIER_B - PIER_A);
  float u = dot(P.xz - PIER_A, d);
  float plank = sstep(0.0, 0.00006, abs(fract(u / 0.00032) - 0.5) - 0.02);
  vec3 wood = mix(lin(vec3(0.30, 0.25, 0.20)), lin(vec3(0.46, 0.38, 0.29)), noise(vec2(u * 3000.0, dot(P.xz, vec2(-d.y, d.x)) * 9000.0)));
  wood *= 0.55 + 0.45 * plank;
  // Wet and dark near the water.
  wood *= mix(0.45, 1.0, sstep(0.0, 0.0012, P.y));
  return wood * (SUNC * max(dot(n, SUN), 0.0) + AMB * (0.55 + 0.45 * n.y));
}

// --- the pines on the near bank ---------------------------------------------------
// Five conifers, each a stack of drooping tiers round a trunk, marched as a
// signed distance inside its own bounding cylinder — close enough to be real
// objects, with a sun-lit side and a shaded one, instead of a texture.
const int NPINE = 5;
vec4 pineAt(int i) {   // x, z, height, radius — kilometres
  if (i == 0) return vec4(-0.058, -0.070, 0.030, 0.0072);
  if (i == 1) return vec4(-0.076, -0.050, 0.023, 0.0056);
  if (i == 2) return vec4(-0.049, -0.083, 0.018, 0.0048);
  if (i == 3) return vec4(0.071, -0.092, 0.033, 0.0078);
  return vec4(0.055, -0.074, 0.021, 0.0054);
}

float pineSD(vec3 q, float H, float R, float seed) {
  float r = length(q.xz);
  float y = clamp(q.y / H, 0.0, 1.0);
  float ty = y * 13.0 + 0.35 + 0.25 * noise(vec2(seed, y * 3.0));
  float saw = fract(ty);
  float tier = floor(ty);
  // Boughs reach out and droop: wide at the bottom of a tier, drawn in at the top.
  float prof = (1.0 - y) * (0.55 + 0.45 * saw * saw * (3.0 - 2.0 * saw));
  float ang = atan(q.z, q.x);
  float jag = 0.78 + 0.44 * noise(vec2(ang * 3.4 + seed + tier * 1.7, y * 23.0));
  float rad = R * prof * jag * sstep(0.10, 0.24, y);        // the lowest boughs draw in to the trunk
  float canopy = max(max(r - rad, q.y - H), 0.12 * H - q.y);
  float trunk = max(max(r - 0.0005, q.y - 0.9 * H), -q.y);
  return min(canopy, trunk) * 0.7;
}

// The nearest pine along a ray: its t, or -1, with the point in the tree's own
// frame, its seed and its description.
float pineHit(vec3 ro, vec3 rd, float tmax, out vec3 P, out float seed, out vec4 info) {
  float best = -1.0;
  P = vec3(0.0); seed = 0.0; info = vec4(0.0);
  for (int i = 0; i < NPINE; i++) {
    vec4 pn = pineAt(i);
    float by = bankH(pn.xy) - 0.035 - 0.0005;
    vec3 oc = ro - vec3(pn.x, by, pn.y);
    float rb = pn.w * 1.15;
    // Ray against the vertical bounding cylinder.
    float a = dot(rd.xz, rd.xz), b = dot(oc.xz, rd.xz), c = dot(oc.xz, oc.xz) - rb * rb;
    float disc = b * b - a * c;
    if (disc < 0.0 || a < 1e-9) continue;
    float sq = sqrt(disc);
    float t0 = max((-b - sq) / a, 0.0), t1 = (-b + sq) / a;
    if (t1 < 0.0 || t0 > tmax) continue;
    float t = t0;
    for (int k = 0; k < 26; k++) {
      vec3 q = oc + rd * t;
      if (q.y > pn.z * 1.02 && rd.y > 0.0) break;
      float d = pineSD(q, pn.z, pn.w, float(i) * 7.3);
      if (d < 0.00035) {
        if (best < 0.0 || t < best) { best = t; P = q; seed = float(i); info = pn; }
        break;
      }
      t += d;
      if (t > t1 || t > tmax) break;
    }
  }
  return best;
}

vec3 pineColor(vec3 q, vec4 info, float seed, vec3 rd) {
  float H = info.z, R = info.w;
  float eps = 0.0004;
  vec3 n = normalize(vec3(
    pineSD(q + vec3(eps, 0.0, 0.0), H, R, seed * 7.3) - pineSD(q - vec3(eps, 0.0, 0.0), H, R, seed * 7.3),
    pineSD(q + vec3(0.0, eps, 0.0), H, R, seed * 7.3) - pineSD(q - vec3(0.0, eps, 0.0), H, R, seed * 7.3),
    pineSD(q + vec3(0.0, 0.0, eps), H, R, seed * 7.3) - pineSD(q - vec3(0.0, 0.0, eps), H, R, seed * 7.3)));
  float y = q.y / H;
  float tex = noise(vec2(atan(q.z, q.x) * 14.0 + seed, q.y * 700.0));
  vec3 alb = mix(lin(vec3(0.035, 0.085, 0.045)), lin(vec3(0.13, 0.22, 0.08)), tex * (0.4 + 0.6 * y));
  // Bark below the first branches.
  alb = mix(lin(vec3(0.20, 0.13, 0.09)), alb, sstep(0.10, 0.16, y));
  float ndl = max(dot(n, SUN), 0.0);
  // A tier shades the one under it; needles pass light through at their edges.
  float shade = 0.35 + 0.65 * sstep(0.0, 0.5, fract(y * 13.0 + 0.35) + 0.2 * ndl);
  float trans = pow(max(dot(-n, SUN), 0.0), 1.2) * 0.35;
  return alb * (SUNC * (ndl * shade + trans) + AMB * (0.45 + 0.35 * n.y) * (0.4 + 0.6 * y));
}

vec3 skyAt(vec3 rd, float sunK) {
  vec3 sky = atmosphere(rd, 0.0) + sunDisc(rd) * sunK;
  vec4 cl = cloudMarch(CAM, rd, 0.0);
  return sky * cl.a + cl.rgb;
}

// The lake's surface slope: three swells, each faded out once it is finer
// than a pixel — a surface sampled below its own wavelength shimmers, which
// reads as noise and costs the encoder bits.
vec2 lakeSlope(vec2 w, float fp) {
  vec2 g = vec2(0.0);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float lam = 22.0 / (1.0 + fi * 1.9);
    float vis = sstep(lam * 1.3, lam * 0.4, fp);
    float a = 0.7 + fi * 2.1;
    vec2 dir = vec2(cos(a), sin(a));
    float ph = dot(w, dir) * 6.2832 / lam + T * (0.16 + 0.10 * fi) + fi * 2.7;
    g += dir * cos(ph) * 0.012 * vis;
  }
  return g;
}

// A ray that missed the land but came close: find its closest approach properly
// (the march only looked every few hundred metres) by narrowing the bracket
// around the nearest sample. Returns the miss in pixels; gTMiss is moved to it.
float refineMiss(vec3 ro, vec3 rd, int oct) {
  float a = gTA, b = gTB;
  float best = gMiss;
  for (int i = 0; i < 6; i++) {
    float m1 = mix(a, b, 0.382), m2 = mix(a, b, 0.618);
    vec3 p1 = ro + rd * m1, p2 = ro + rd * m2;
    float r1 = (p1.y - max(terrainH(p1.xz, oct), 0.0)) / (m1 * 0.0032 + 0.0002);
    float r2 = (p2.y - max(terrainH(p2.xz, oct), 0.0)) / (m2 * 0.0032 + 0.0002);
    if (r1 < r2) { b = m2; if (r1 < best) { best = r1; gTMiss = m1; } }
    else { a = m1; if (r2 < best) { best = r2; gTMiss = m2; } }
  }
  return best;
}

vec4 scene(vec2 p, out vec3 emit) {
  emit = vec3(0.0);
  float elev = mix(0.32 + 0.07 * ELEV, 0.06, NIGHT);
  sunSetup(elev, 0.95);
  CL_BASE = 3.2; CL_TOP = 4.8; CL_COVER = 0.34; CL_SCALE = 0.45;
  vec3 ro = CAM;
  vec3 rd = camRay(p, 0.03);
  vec3 col;
  float tw = rd.y < -1e-4 ? -ro.y / rd.y : 1e5;
  // The land in two stages: the bank and promontories under the camera, which
  // cost almost nothing to evaluate, and then, from a kilometre out, the
  // foothills and the range. Rays that meet the lake first never reach the
  // second.
  gMiss = 1e3; gTMiss = 0.0; gTA = 0.0; gTB = 0.0;
  float tmaxm = min(tw, 45.0);
  float tm = -1.0;
  if (rd.y < 0.0) tm = marchTerrain(ro, rd, 0.002, min(tw, 0.32), 44, 5, 0.09);
  float tfar = 1.0 / max(-rd.z, 0.02);
  if (tm < 0.0 && tfar < tmaxm) tm = marchTerrain(ro, rd, tfar, tmaxm, 72, 5, 0.03);
  float miss = 1e3;
  if (!(tm > 0.0 && tm < tw) && tw > 1e4 && gMiss < 3.0) miss = refineMiss(ro, rd, 5);
  float cover = tm > 0.0 && tm < tw ? 1.0 : (tw < 1e4 ? 0.0 : clamp(1.0 - miss, 0.0, 1.0));
  float tt = (tm > 0.0 && tm < tw) ? tm : gTMiss;
  if (cover > 0.0) {
    // ---- the land (or, at a skyline, the part of a pixel that is land)
    vec3 P = ro + rd * tt;
    int oct = int(clamp(log2(450.0 / tt) + 0.5, 4.0, 8.0));
    if (cover < 1.0) P.y = terrainH(P.xz, oct);          // the ridge itself, not the air over it
    vec3 n = terrainNormal(P, tt, oct);
    col = terrainColor(P, n, tt, true);
    col = aerial(col, ro, rd, tt, 0.065, 0.0);
    col = lakeMist(col, ro, rd, tt);
    if (cover < 1.0) col = mix(skyAt(rd, 1.0), col, cover);
  } else if (tw < 1e4) {
    // ---- the lake
    vec3 P = ro + rd * tw;
    float fp = tw * 1000.0 * PX / FOCAL;                  // metres per pixel here
    vec2 g = lakeSlope(P.xz * 1000.0, fp);
    vec3 n = normalize(vec3(g.x, 1.0, g.y));
    vec3 rr = reflect(rd, n);
    rr.y = abs(rr.y);
    float fres = 0.03 + 0.97 * pow(1.0 - clamp(dot(-rd, n), 0.0, 1.0), 5.0);
    // What the surface mirrors: the far shore and peaks, or the sky.
    vec3 refl;
    float tr = -1.0;
    float trf = max((1.0 - (-P.z)) / max(-rr.z, 0.02), 0.0);
    gMiss = 1e3;
    if (trf < 40.0) tr = marchTerrain(P + vec3(0.0, 0.0004, 0.0), rr, trf, 40.0, 30, 3, 0.07);
    if (tr > 0.0) {
      vec3 Q = P + rr * tr;
      vec3 qn = terrainNormal(Q, tr, 3);
      refl = terrainColor(Q, qn, tr, false);
      refl = aerial(refl, P, rr, tr, 0.065, 0.0);
    } else {
      refl = skyAt(rr, 0.08);
    }
    // What is under it: shingle in the shallows, then deep green-black water.
    float depth = max(0.0 - terrainH(P.xz, 4), 0.0);
    vec3 deep = lin(vec3(0.04, 0.12, 0.15)) * (0.5 + 0.8 * AMB.b * 0.5);
    vec3 bed = lin(vec3(0.34, 0.32, 0.26)) * (AMB * 0.7 + SUNC * 0.25);
    vec3 body = mix(deep, bed * vec3(0.55, 0.85, 0.8), exp(-depth * 90.0));
    col = mix(body, refl, fres);
    col = aerial(col, ro, rd, tw, 0.065, 0.0);
    col = lakeMist(col, ro, rd, tw);
  } else {
    col = skyAt(rd, 1.0);
  }
  // The pier, over the water and the shore it starts from.
  float tPrim = (tm > 0.0 && tm < tw) ? tm : (tw < 1e4 ? tw : 1e5);
  float tpr = pierHit(ro, rd, min(tPrim, 0.2));
  if (tpr > 0.0) col = aerial(pierColor(ro + rd * tpr), ro, rd, tpr, 0.065, 0.0);
  // The nearest pines stand in front of whatever is behind them.
  vec3 Pq; float sd; vec4 inf;
  float tp = pineHit(ro, rd, 0.2, Pq, sd, inf);
  if (tp > 0.0) col = pineColor(Pq, inf, sd, rd);
  return vec4(col, 0.0);
}
`;

  // --- the countryside ------------------------------------------------------
  //
  // Rolling farmland from a knoll: a ray-marched height field with a patchwork
  // of fields (a Voronoi of crops, hedgerows and woods) laid over it, wind
  // running across the wheat in slow waves, and the shade of fair-weather
  // cumulus drifting over the hills — the same clouds, looked at from the ground
  // up the sun's ray. An oak close by (a signed-distance tree, lit through its
  // leaves) throws its shadow on the grass; a farmhouse and barn stand up the
  // slope at the end of a lane; sheep graze; and in front of it all, long grass
  // and wildflowers, drawn in layers and stirring when you move. In a dim room it
  // is dusk.
  var COUNTRYSIDE = `
// Kilometres, +x toward the key light, looking down -z from a knoll over a
// valley of fields: an oak close by, a farmhouse and barn up the slope, a lane
// winding to them, long grass at the camera's feet.
const mat2 M2 = mat2(0.8, -0.6, 0.6, 0.8);
const float HMAX = 1.2;
const vec2  OAK_XZ  = vec2(-0.056, -0.098);
const vec2  FARM_XZ = vec2(0.215, -0.500);

// Rolling land: a few octaves of damped value noise, the camera's own knoll,
// and a faint range of high ground far beyond the last ridge.
float landH(vec2 p, int oct) {
  float d = -p.y;
  vec2 x = p * 0.55 + vec2(11.3, 4.7);
  float a = 0.0, b = 0.5;
  vec2 dd = vec2(0.0);
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    vec3 n = noised(x);
    dd += n.yz;
    a += b * n.x / (1.0 + 0.35 * dot(dd, dd));
    b *= 0.5;
    x = M2 * x * 2.03;
  }
  float knoll = 0.05 * exp(-dot(p, p) / sq(0.28));
  float far = 0.55 * sstep(14.0, 32.0, d);
  return 0.01 + a * 0.62 + knoll + far * (0.4 + a);
}

vec3 landNormal(vec3 P, float t, int oct) {
  float e = max(0.0005, 0.0012 * t);
  float h0 = landH(P.xz, oct);
  float hx = landH(P.xz + vec2(e, 0.0), oct) - h0;
  float hz = landH(P.xz + vec2(0.0, e), oct) - h0;
  return normalize(vec3(-hx, e, -hz));
}

float marchLand(vec3 ro, vec3 rd, float tmax) {
  float t = 0.002, tp = 0.0;
  for (int i = 0; i < 80; i++) {
    vec3 p = ro + rd * t;
    float h = p.y - landH(p.xz, 4);
    if (h < 0.0004 * (1.0 + t)) {
      float a = tp, b = t;
      for (int k = 0; k < 5; k++) {
        float m = 0.5 * (a + b);
        vec3 q = ro + rd * m;
        if (q.y - landH(q.xz, 4) > 0.0) a = m; else b = m;
      }
      return 0.5 * (a + b);
    }
    if (p.y > HMAX && rd.y > 0.0) return -1.0;
    tp = t;
    t += max(0.55 * h, 0.035 * t + 0.0005);
    if (t > tmax) return -1.0;
  }
  return t;
}

float landShadow(vec3 ro, vec3 rd) {
  float res = 1.0, t = 0.02;
  for (int i = 0; i < 10; i++) {
    vec3 p = ro + rd * t;
    float h = p.y - landH(p.xz, 3);
    res = min(res, 10.0 * h / t);
    t += clamp(h, 0.04, 0.5);
    if (res < 0.01 || p.y > HMAX) break;
  }
  return sstep(0.0, 1.0, clamp(res, 0.0, 1.0));
}

// Voronoi: the cell's border distance and three random numbers for the cell.
vec4 cells(vec2 x) {
  vec2 n = floor(x), f = x - n;
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
  return vec4(sqrt(d2) - sqrt(d1), hash12(id), hash12(id + 7.7), hash12(id + 3.3));
}

// The lane: a dirt track from the camera's feet up to the farm, wheel ruts and
// a strip of grass down its middle.
float laneX(float z) { return 0.03 + 0.37 * (-z) + 0.040 * sin(-z * 13.0); }
float laneAt(vec2 xz) {
  float w = 0.0024 + 0.0045 * sstep(0.4, 0.0, -xz.y);
  return sstep(w, w * 0.45, abs(xz.x - laneX(xz.y))) * step(xz.y, 0.0) * step(-0.55, xz.y);
}

// --- the oak -----------------------------------------------------------------------
// A trunk, three limbs, and a crown of overlapping lumps whose surface is noise:
// a signed distance, marched only inside its bounding sphere.
float oakSD(vec3 q) {
  float trunk = sdCapsule(q, vec3(0.0), vec3(0.0010, 0.0095, 0.0), 0.0015 - 0.0004 * clamp(q.y / 0.01, 0.0, 1.0));
  float l1 = sdCapsule(q, vec3(0.0010, 0.0075, 0.0), vec3(-0.0080, 0.0138, 0.0020), 0.0008);
  float l2 = sdCapsule(q, vec3(0.0010, 0.0080, 0.0), vec3(0.0095, 0.0130, -0.0020), 0.0008);
  float l3 = sdCapsule(q, vec3(0.0012, 0.0090, 0.0), vec3(0.0010, 0.0160, 0.0080), 0.0007);
  float l4 = sdCapsule(q, vec3(0.0010, 0.0085, 0.0), vec3(-0.0020, 0.0150, -0.0085), 0.0007);
  float wood = smin(smin(trunk, l1, 0.002), smin(smin(l2, l3, 0.002), l4, 0.002), 0.002);
  // The crown is many clumps, not one: each round, none quite alike.
  float c = length(q - vec3(-0.0085, 0.0160, 0.0020)) - 0.0050;
  c = min(c, length(q - vec3(-0.0035, 0.0190, 0.0050)) - 0.0050);
  c = min(c, length(q - vec3(0.0095, 0.0150, -0.0020)) - 0.0050);
  c = min(c, length(q - vec3(0.0050, 0.0185, 0.0010)) - 0.0058);
  c = min(c, length(q - vec3(0.0005, 0.0215, 0.0000)) - 0.0058);
  c = min(c, length(q - vec3(-0.0030, 0.0205, -0.0050)) - 0.0050);
  c = min(c, length(q - vec3(0.0010, 0.0170, 0.0092)) - 0.0045);
  c = min(c, length(q - vec3(-0.0010, 0.0160, -0.0095)) - 0.0040);
  c = min(c, length(q - vec3(0.0070, 0.0160, 0.0070)) - 0.0040);
  c = min(c, length(q - vec3(-0.0080, 0.0140, -0.0040)) - 0.0040);
  c += 0.0034 * (0.5 - noise3(q * 560.0)) + 0.0014 * (0.5 - noise3(q * 1500.0));
  return min(wood, c * 0.8);
}

float oakHit(vec3 ro, vec3 rd, vec3 base, float tmax) {
  vec3 oc = ro - base - vec3(0.0, 0.0165, 0.0);
  float bb = dot(oc, rd), cc = dot(oc, oc) - 0.0155 * 0.0155;
  float disc = bb * bb - cc;
  if (disc < 0.0 || (bb > 0.0 && cc > 0.0)) return -1.0;
  float t = max(-bb - sqrt(disc), 0.0);
  for (int i = 0; i < 32; i++) {
    float d = oakSD(ro + rd * t - base);
    if (d < 0.00028) return t;
    t += d * 0.8;
    if (t > tmax) break;
  }
  return -1.0;
}

vec3 oakColor(vec3 base, vec3 P, vec3 rd) {
  vec3 q = P - base;
  const float e = 0.0004;
  vec3 n = normalize(vec3(oakSD(q + vec3(e, 0.0, 0.0)) - oakSD(q - vec3(e, 0.0, 0.0)),
                          oakSD(q + vec3(0.0, e, 0.0)) - oakSD(q - vec3(0.0, e, 0.0)),
                          oakSD(q + vec3(0.0, 0.0, e)) - oakSD(q - vec3(0.0, 0.0, e))));
  float wood = step(q.y, 0.0120 + 0.002 * n.y) * step(length(q.xz), 0.0040) * step(oakSD(q), 0.0009);
  float lump = noise3(q * 1100.0);
  float lit = noise3(q * 700.0 + 3.0);
  vec3 leaf = mix(lin(vec3(0.07, 0.15, 0.05)), lin(vec3(0.40, 0.52, 0.12)), lit * 0.7 + 0.3 * lump);
  vec3 bark = mix(lin(vec3(0.20, 0.15, 0.11)), lin(vec3(0.10, 0.08, 0.06)), noise(vec2(atan(q.z, q.x) * 6.0, q.y * 900.0)));
  vec3 alb = mix(leaf, bark, wood);
  float ndl = max(dot(n, SUN), 0.0);
  float depth = clamp((q.y - 0.011) / 0.016, 0.0, 1.0);
  float occ = mix(mix(0.30, 1.0, depth) * (0.70 + 0.30 * lump), 0.9, wood);
  float trans = pow(max(dot(-n, SUN), 0.0), 1.5) * 0.30 * (1.0 - wood);
  return alb * (SUNC * (ndl + trans * lin(vec3(0.7, 0.9, 0.3)).g) * occ + AMB * (0.5 + 0.5 * n.y) * occ);
}

// The oak's shadow on the ground (and on the lane): a ray toward the sun, tested
// against its bounding sphere first, then marched.
float oakShadow(vec3 P, vec3 base) {
  vec3 oc = P - base - vec3(0.0, 0.0165, 0.0);
  float bb = dot(oc, SUN), cc = dot(oc, oc) - 0.0155 * 0.0155;
  if (bb > 0.0 || bb * bb - cc < 0.0) return 1.0;
  float res = 1.0, t = 0.001;
  for (int i = 0; i < 16; i++) {
    float d = oakSD(P + SUN * t - base);
    res = min(res, 8.0 * d / t);
    t += clamp(d, 0.0015, 0.01);
    if (res < 0.02 || t > 0.05) break;
  }
  return clamp(res, 0.0, 1.0);
}

// --- the farm ----------------------------------------------------------------------
float gableSD(vec3 q, vec3 hs, float roofH) {
  float body = sdBox3(q - vec3(0.0, hs.y, 0.0), hs);
  float ry = q.y - 2.0 * hs.y;
  float tri = (abs(q.z) - hs.z * 1.12 * (1.0 - ry / roofH)) * 0.7;
  float roof = max(max(tri, abs(q.x) - hs.x * 1.06), max(ry - roofH, -ry));
  return min(body, roof);
}
float farmSD0(vec3 q) {
  float house = gableSD(q - vec3(-0.0120, 0.0, 0.0), vec3(0.0105, 0.0042, 0.0062), 0.0050);
  float barn = gableSD((q - vec3(0.0130, 0.0, -0.0040)).zyx * vec3(1.0, 1.0, 1.0), vec3(0.0085, 0.0058, 0.0105), 0.0060);
  float chim = sdBox3(q - vec3(-0.0190, 0.0120, 0.0010), vec3(0.0009, 0.0030, 0.0009));
  return min(min(house, barn), chim);
}
float farmSD(vec3 q) { return farmSD0(q / 1.45) * 1.45; }
float farmHit(vec3 ro, vec3 rd, vec3 base, float tmax) {
  vec3 oc = ro - base - vec3(0.0, 0.006, 0.0);
  float bb = dot(oc, rd), cc = dot(oc, oc) - 0.042 * 0.042;
  float disc = bb * bb - cc;
  if (disc < 0.0 || (bb > 0.0 && cc > 0.0)) return -1.0;
  float t = max(-bb - sqrt(disc), 0.0);
  for (int i = 0; i < 40; i++) {
    float d = farmSD(ro + rd * t - base);
    if (d < 0.00035) return t;
    t += d * 0.9;
    if (t > tmax) break;
  }
  return -1.0;
}
vec3 farmColor(vec3 base, vec3 P) {
  vec3 q = P - base;
  const float e = 0.0004;
  vec3 n = normalize(vec3(farmSD(q + vec3(e, 0.0, 0.0)) - farmSD(q - vec3(e, 0.0, 0.0)),
                          farmSD(q + vec3(0.0, e, 0.0)) - farmSD(q - vec3(0.0, e, 0.0)),
                          farmSD(q + vec3(0.0, 0.0, e)) - farmSD(q - vec3(0.0, 0.0, e))));
  bool isBarn = q.x > 0.0035 * 1.45;
  bool roof = q.y > (isBarn ? 0.0125 : 0.0088) * 1.45 && abs(n.y) > 0.25;
  vec3 wall = isBarn ? lin(vec3(0.50, 0.30, 0.22)) : lin(vec3(0.95, 0.92, 0.85));
  vec3 tile = isBarn ? lin(vec3(0.34, 0.36, 0.40)) : lin(vec3(0.58, 0.24, 0.16));
  vec3 alb = roof ? tile * (0.85 + 0.3 * noise(vec2(q.x * 3000.0, q.z * 3000.0))) : wall;
  float ndl = max(dot(n, SUN), 0.0);
  return alb * (SUNC * ndl + AMB * (0.55 + 0.45 * n.y) * (0.6 + 0.4 * clamp(q.y / 0.015, 0.0, 1.0)));
}

// --- the smoke -----------------------------------------------------------------------
// The farm's chimney, projected to the screen, and a thin plume rising from it
// and leaning with the wind: a soft noise column, drawn in the picture's plane.
vec2 toScreen(vec3 world, vec3 ro, float pitch) {
  vec3 d = world - ro;
  float c = cos(pitch), s = sin(pitch);
  vec3 cam = vec3(d.x, d.y * c + d.z * s, -d.y * s + d.z * c);
  cam = viewInv(cam);
  return cam.xy * FOCAL / max(-cam.z, 1e-4);
}
float chimneySmoke(vec2 p, vec3 ro, vec3 farmBase) {
  vec3 top = farmBase + vec3(-0.0276, 0.0222, 0.0015);
  vec2 c = toScreen(top, ro, -0.02);
  vec2 st = p - c;
  float rise = st.y;
  if (rise < 0.0 || rise > 0.075) return 0.0;
  float u = rise / 0.075;
  float lean = 0.02 * u * u + 0.006 * sin(u * 9.0 - T * 0.35);
  float width = 0.0016 + 0.010 * u;
  float puff = fbm3(vec2(st.x * 220.0 + u * 5.0, rise * 120.0 - T * 0.5));
  float d = abs(st.x - lean);
  return sstep(width, 0.0, d) * sstep(0.30, 0.75, puff) * sstep(0.0, 0.08, u) * (1.0 - u) * 0.55;
}

// --- the ground ---------------------------------------------------------------------
vec3 landColor(vec3 P, vec3 n, float t, bool full, vec3 oakBase) {
  float fp = t * PX / FOCAL;                         // km under one pixel
  float fine = sstep(0.0035, 0.0007, fp);            // ~4 m detail resolved
  float near = sstep(0.30, 0.10, t);                 // the meadow under the camera
  vec4 c = cells(P.xz * 3.1);                        // ~320 m fields
  float h = c.y;
  vec3 crop = h < 0.22 ? lin(vec3(0.27, 0.40, 0.15)) :
              h < 0.42 ? lin(vec3(0.37, 0.48, 0.19)) :
              h < 0.60 ? lin(vec3(0.66, 0.56, 0.30)) :
              h < 0.70 ? lin(vec3(0.78, 0.66, 0.22)) :
              h < 0.84 ? lin(vec3(0.34, 0.27, 0.20)) :
                         lin(vec3(0.22, 0.33, 0.13));
  crop *= 0.82 + 0.36 * noise(P.xz * 2.3);                 // moisture and soil, a kilometre wide
  float wood = step(0.92, c.w);
  float ang = c.z * 3.1416;
  float rows = 0.5 + 0.5 * sin(dot(P.xz, vec2(cos(ang), sin(ang))) * 1900.0);
  float rowsLod = sstep(0.0012, 0.0002, fp);
  crop *= 1.0 - 0.10 * rows * rowsLod * step(0.55, h);
  // Wind running across the crops in slow waves.
  float gust = noise(vec2(P.x * 3.0 - T * 0.12, P.z * 1.6 + T * 0.05)) - 0.5;
  float sway = noise(P.xz * 8.0 + vec2(T * 0.08, 0.0)) - 0.5;
  float grain = noise(P.xz * 220.0);
  float crops = step(h, 0.70) * (1.0 - wood);
  crop *= 1.0 + (0.30 * gust + 0.10 * sway) * crops;
  crop *= 0.88 + 0.24 * mix(0.5, grain, fine);
  // Hedgerows on the field borders, with trees along them.
  float hw = max(0.005, fp * 0.7);
  float hedge = sstep(hw, hw * 0.35, c.x);
  float clump = sstep(0.52, 0.76, noise(P.xz * 30.0 + 5.0));
  float tree = clamp(hedge * (0.5 + 0.5 * clump) + wood * 0.95, 0.0, 1.0);
  vec3 leaf = mix(lin(vec3(0.07, 0.15, 0.06)), lin(vec3(0.20, 0.31, 0.10)), noise(P.xz * 110.0) * fine + 0.3);
  vec3 alb = mix(crop, leaf, tree);
  // Sheep in the pasture: pale blobs, one to a few cells, grazing in clusters.
  vec2 sg = P.xz * 210.0;
  vec2 sid = floor(sg);
  vec2 sh2 = hash22(sid);
  float flock = sstep(0.55, 0.75, noise(P.xz * 9.0 + 1.0));
  float sheep = step(0.80, sh2.x) * flock * step(h, 0.22) * (1.0 - tree) *
                sstep(0.34, 0.16, length((fract(sg) - 0.5) * vec2(1.0, 1.6) - (sh2 - 0.5) * 0.3)) * sstep(0.006, 0.0012, fp);
  alb = mix(alb, lin(vec3(0.88, 0.86, 0.82)), sheep * 0.9);
  // The meadow itself: long grass in two greens (the blades and flowers in
  // front of it are drawn over the top by foreground()).
  float gr = noise(P.xz * 160.0) * 0.5 + noise(P.xz * 40.0) * 0.5;
  vec3 meadow = mix(lin(vec3(0.16, 0.30, 0.08)), lin(vec3(0.40, 0.52, 0.17)), gr);
  alb = mix(alb, meadow, near);
  // The lane, over all of it: pale dirt, two ruts, grass between.
  float ln = laneAt(P.xz);
  float rut = sstep(0.0008, 0.0, abs(abs(P.x - laneX(P.z)) - 0.0011)) * sstep(0.0015, 0.0004, fp) * 0.35;
  vec3 dirt = mix(lin(vec3(0.62, 0.55, 0.43)), lin(vec3(0.40, 0.34, 0.26)), rut + 0.25 * noise(P.xz * 500.0));
  float mid = sstep(0.0006, 0.0, abs(P.x - laneX(P.z))) * sstep(0.0, 0.0012, fp);
  dirt = mix(dirt, meadow, 0.0);
  alb = mix(alb, dirt, ln * (1.0 - tree * 0.5));
  // Trees are lumpy: a bump on the normal so each catches the light itself.
  vec2 gn = noised(P.xz * 46.0).yz;
  vec3 nn = normalize(n + vec3(gn.x, 0.0, gn.y) * 0.11 * tree * (0.3 + 0.7 * fine));
  float sh = 1.0;
  if (full) {
    sh = landShadow(P + n * 0.0015, SUN);
    sh *= oakShadow(P, oakBase);
  }
  // Shade cast by clouds: the same slab, looked at from the ground up along
  // the sun, so it drifts with them.
  float ts = max((CL_BASE + 0.35 * (CL_TOP - CL_BASE) - P.y) / SUN.y, 0.0);
  float cd = cloudD(P + SUN * ts, false) + 0.6 * cloudD(P + SUN * (ts * 1.3), false);
  sh *= mix(1.0, 0.32, 1.0 - exp(-cd * 1.7));
  float ndl = max(dot(nn, SUN), 0.0);
  float ao = 0.62 + 0.38 * clamp(nn.y, 0.0, 1.0) - 0.15 * tree * (1.0 - clump);
  return alb * (SUNC * ndl * sh + AMB * (0.55 + 0.45 * nn.y) * ao);
}

// --- the grass at the camera's feet --------------------------------------------------
// Three layers of blades and a scatter of flowers, drawn over everything in the
// screen's lowest part: near, so they are large, soft, and lit from behind.
// Returns colour in rgb and coverage in a.
float blades(vec2 p, float scale, float baseY, float hgt, float seed, float soft, out float tipT) {
  float x = p.x * scale;
  float ci = floor(x);
  float cover = 0.0;
  tipT = 0.0;
  // The ground line wanders: the layers are never ruled across the picture.
  baseY += 0.030 * (noise(vec2(p.x * 2.1 + seed * 4.0, seed)) - 0.5) + 0.012 * sin(p.x * 11.0 + seed * 3.0);
  for (int i = -1; i <= 1; i++) {
    float c = ci + float(i);
    float h = hash11(c * 1.31 + seed);
    float r2 = hash11(c * 2.17 + seed);
    if (r2 < 0.18) continue;                                   // a bare patch
    float bh = hgt * (0.30 + 0.85 * r2 * r2);
    float t = (p.y - baseY) / bh;
    if (t < 0.0 || t > 1.0) continue;
    float bx = (c + 0.5 + (h - 0.5) * 0.9) / scale;
    float wind = (0.010 * sin(T * 0.8 + c * 0.37) + 0.008 * sin(T * 0.4 + p.x * 3.0)) * (1.0 + 2.2 * MOTION);
    float lean = ((hash11(c * 3.7 + seed) - 0.5) * 0.9 * bh + wind) * t * t;
    float w = (0.28 + 0.34 * hash11(c * 5.1 + seed)) / scale * (1.0 - t * 0.94);
    float cv = fill(abs(p.x - bx - lean) - w, soft / scale);
    if (cv > cover) { cover = cv; tipT = t; }
  }
  return cover;
}
vec4 foreground(vec2 p) {
  vec3 col = vec3(0.0);
  float a = 0.0;
  float t1, t2, t3;
  // Far layer first, the near layer over it.
  float b1 = blades(p, 190.0, -0.395, 0.085, 1.0, 0.16, t1);
  vec3 c1 = mix(lin(vec3(0.20, 0.32, 0.10)), lin(vec3(0.60, 0.68, 0.28)), t1) * (SUNC * 0.18 + AMB * 0.9);
  c1 += lin(vec3(0.55, 0.70, 0.18)) * SUNC * 0.16 * t1;          // sun through the tips
  col = mix(col, c1, b1); a = max(a, b1);
  // Flowers on stems, nodding in the wind: sparser and less even than a row.
  float fx = p.x * 17.0;
  float fi = floor(fx);
  float fh = hash11(fi * 5.3);
  if (fh > 0.58) {
    vec2 fp = vec2((fi + 0.5 + (hash11(fi) - 0.5) * 0.7) / 17.0, -0.395 + 0.040 + 0.085 * hash11(fi * 2.1));
    float nod = (0.006 * sin(T * 0.7 + fi) + 0.004 * sin(T * 0.4 + fp.x * 3.0)) * (1.0 + 2.2 * MOTION);
    float stem = fill(abs(p.x - fp.x - nod * (p.y + 0.395) / max(fp.y + 0.395, 0.01)) - 0.0013, 0.0008) * step(-0.395, p.y) * step(p.y, fp.y);
    fp.x += nod;
    vec2 d = p - fp;
    float ang = atan(d.y, d.x);
    float petals = 0.0070 + 0.0024 * cos(ang * 5.0 + fi);
    float head = fill(length(d) - petals, 0.0015);
    float eye = fill(length(d) - 0.0028, 0.001);
    vec3 pc = fh > 0.88 ? lin(vec3(0.98, 0.97, 0.94)) : fh > 0.75 ? lin(vec3(0.99, 0.80, 0.18)) : lin(vec3(0.70, 0.48, 0.90));
    vec3 fcol = mix(pc, lin(vec3(0.98, 0.78, 0.15)), eye * (fh > 0.88 ? 1.0 : 0.0)) * (SUNC * 0.45 + AMB * 1.0);
    col = mix(col, lin(vec3(0.20, 0.34, 0.10)) * (SUNC * 0.2 + AMB), stem); a = max(a, stem);
    col = mix(col, fcol, head); a = max(a, head);
  }
  float b2 = blades(p, 110.0, -0.440, 0.140, 2.0, 0.28, t2);
  vec3 c2 = mix(lin(vec3(0.12, 0.24, 0.06)), lin(vec3(0.52, 0.64, 0.22)), t2) * (SUNC * 0.16 + AMB * 0.85);
  c2 += lin(vec3(0.55, 0.70, 0.18)) * SUNC * 0.20 * t2;
  col = mix(col, c2, b2); a = max(a, b2);
  float b3 = blades(p, 46.0, -0.57, 0.30, 3.0, 0.5, t3);
  vec3 c3 = mix(lin(vec3(0.07, 0.16, 0.04)), lin(vec3(0.42, 0.58, 0.18)), t3) * (SUNC * 0.14 + AMB * 0.75);
  c3 += lin(vec3(0.55, 0.70, 0.18)) * SUNC * 0.22 * t3;
  col = mix(col, c3, b3); a = max(a, b3);
  return vec4(col, a);
}

vec4 scene(vec2 p, out vec3 emit) {
  emit = vec3(0.0);
  float elev = mix(0.50 + 0.08 * ELEV, 0.07, NIGHT);
  sunSetup(elev, 0.85);
  CL_BASE = 1.4; CL_TOP = 2.7; CL_COVER = 0.40; CL_SCALE = 0.85;
  float h0 = landH(vec2(0.0), 5);
  vec3 ro = vec3(0.0, h0 + 0.0018, 0.0);
  vec3 rd = camRay(p, -0.02);
  vec3 oakBase = vec3(OAK_XZ.x, landH(OAK_XZ, 5) - 0.0003, OAK_XZ.y);
  vec3 farmBase = vec3(FARM_XZ.x, landH(FARM_XZ, 4) - 0.0006, FARM_XZ.y);
  vec3 col;
  float tm = marchLand(ro, rd, 40.0);
  float tHit = 1e5;
  if (tm > 0.0) {
    vec3 P = ro + rd * tm;
    int oct = int(clamp(log2(90.0 / tm) + 1.5, 3.0, 6.0));
    vec3 n = landNormal(P, tm, oct);
    col = landColor(P, n, tm, true, oakBase);
    col = aerial(col, ro, rd, tm, 0.085, 0.0);
    tHit = tm;
  } else {
    vec3 sky = atmosphere(rd, 0.0) + sunDisc(rd);
    vec4 cl = cloudMarch(ro, rd, 0.0);
    col = sky * cl.a + cl.rgb;
  }
  // The farm, in front of the slope it stands on.
  float tf = farmHit(ro, rd, farmBase, min(tHit, 5.0));
  if (tf > 0.0) {
    col = aerial(farmColor(farmBase, ro + rd * tf), ro, rd, tf, 0.085, 0.0);
    tHit = tf;
  }
  // A wisp from the chimney, over the slope behind it.
  col = mix(col, lin(vec3(0.86, 0.85, 0.83)) * (SUNC * 0.25 + AMB * 1.1), chimneySmoke(p, ro, farmBase));
  // The oak, closer than anything else in the picture.
  float to = oakHit(ro, rd, oakBase, min(tHit, 0.5));
  float recv = 0.0;
  if (to > 0.0) { col = oakColor(oakBase, ro + rd * to, rd); recv = 0.15; }
  // And the grass over the lot.
  vec4 fg = foreground(p - viewShift());
  col = mix(col, fg.rgb, fg.a);
  return vec4(col, recv * (1.0 - fg.a) + 0.45 * fg.a);
}
`;

  var SOURCES = {
    office: OFFICE, island: ISLAND, cybercafe: CAFE, mountain: MOUNTAIN, countryside: COUNTRYSIDE
  };

  // The common entry point. scene() is authored with the key light on the
  // right; this mirrors it for a light on the left, and while the light is
  // moving sides, draws both and crossfades — the room turns, it never jumps.
  var MAIN = `
vec4 shade(vec2 p, float m, out vec3 e) {
  SUBJ.x = (uSubject.x - 0.5) * 2.0 * HX * m;
  MIR = m;
  return scene(vec2(p.x * m, p.y), e);
}
void main() {
  vec2 uv = vUv + uJitter / uRes;
  // The per-pixel offsets that break up a march's slices: fixed for a frame
  // shown on its own, new with each JITTER point when frames are added up.
  SEED = gl_FragCoord.xy + uJitter * 97.0;
  HX = 0.5 * uRes.x / uRes.y;
  // The detail a pixel may carry is the resolved picture's, not this buffer's:
  // the jittered frames add up to it (see RESOLVE_FRAG).
  PX = 1.0 / (uDetail > 0.0 ? uDetail : uRes.y);
  FOCAL = 1.072 * clamp(HX / 0.70, 0.66, 1.0);
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
  // The scenes are lit in physical-looking units (a sunlit wall is several
  // times brighter than a mid-grey), so the camera's own exposure comes down
  // first; then its filmic shoulder, the sRGB curve, and a half-level of fixed
  // dither so a smooth sky does not band.
  vec3 lit = (c.rgb * uTint * uExposure + e1 * mix(1.0, uExposure, 0.35)) * 0.55;
  vec3 o = srgb(aces(lit));
  o += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  outColor = vec4(o, c.a);
}
`;

  function fragmentSource(id) {
    id = resolveId(id);
    return id ? HEADER + SOURCES[id] + MAIN : null;
  }

  // --- resolve --------------------------------------------------------------
  //
  // Sharp at the size it is shown. A scene is ray-marched into a small buffer
  // (SCENE_LONG in video-effects.js, a few hundred pixels wide), because each
  // of its pixels costs a whole march, and a call shows it two to four times
  // bigger than that. Stretched, it is a soft room behind a sharp person, which
  // reads as a fake at once.
  //
  // So each redraw looks through a slightly different point of every pixel (a
  // Halton sequence, JITTER) and adds what it saw to a picture kept at the
  // camera's own size. Wherever the room holds still, which is nearly all of
  // it nearly all the time, a pixel of the picture is soon made of many looks
  // at many points inside it, and it holds detail the buffer never had: the
  // marching cost of the small buffer, the detail of one the camera's size.
  // The scene is told that size (uDetail), so what it draws is detailed for it.
  //
  // How much a look counts for a pixel depends on how near it fell to the
  // pixel's centre (RESOLVE.sigma, in the picture's own pixels) and on how
  // settled the picture already is: the first looks count for a lot, so a new
  // scene sharpens within a second or two, and later ones for a small steady
  // share (RESOLVE.gain), so a settled picture changes by a level or so with
  // each redraw, not more: the encoder pays for every pixel that changes, in
  // every frame, and with a share of a quarter a room frozen in time cost up
  // to three quarters as much as a moving one. A long sequence (256 points,
  // not 16): with few points, the same pixel is always looked at from the same
  // side, and an edge comes out dotted.
  //
  // What moves cannot be added up: the sea, a frond, a cloud's edge, a scene
  // relit. To find it, the redraw and the picture so far are compared through
  // the same small blur at the very points the redraw looked at, so the detail
  // that only the picture has is not mistaken for movement. Where they differ
  // by more than the local contrast explains (RESOLVE.tol, .tolColour,
  // .tolRange), the redraw wins, and that part shows as the soft frame it is,
  // the way a camera smears what moves. Brightness, colour and nearness are
  // judged apart: nearness changes abruptly at every edge that is not a colour
  // edge, and a relight can change the colour without the brightness.
  //
  // Once per redraw, at the scene's own rate, never per camera frame: one
  // pass at the camera's size, of nine texel reads and ten filtered reads a
  // pixel, into one of two buffers that take turns.
  //
  //   uCur    the redraw, uCurRes px, looked at uJitter px off each pixel's centre
  //   uHist   the picture so far, uOutRes px
  //   uAge    redraws added up so far: 0 = there is no picture yet
  var RESOLVE = { gain: 0.1, sigma: 0.6, tol: 0.015, tolColour: 0.03, tolRange: 0.25, moved: 0.6 };
  var JITTER = (function () {
    function halton(i, b) {
      var f = 1, r = 0;
      while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); }
      return r;
    }
    var out = [];
    for (var i = 1; i <= 256; i++) out.push([halton(i, 2) - 0.5, halton(i, 3) - 0.5]);
    return out;
  })();

  function glf(v) { return (v === Math.round(v) ? v.toFixed(1) : String(v)); }

  // The source is generated, so the preview script can try other settings
  // (`--resolve '{"gain":0.4}'`) without editing this file.
  function resolveSource(o) {
    o = Object.assign({}, RESOLVE, o || {});
    return `#version 300 es
precision highp float;
out vec4 outColor;
uniform sampler2D uCur;
uniform sampler2D uHist;
uniform vec2 uCurRes;
uniform vec2 uOutRes;
uniform vec2 uJitter;
uniform float uAge;
void main() {
  vec2 uv = gl_FragCoord.xy / uOutRes;
  // This pixel's centre among the redraw's looks: look q fell at q + 0.5 + uJitter.
  vec2 p = uv * uCurRes - 0.5 - uJitter;
  ivec2 n = ivec2(floor(p + 0.5));
  ivec2 lim = ivec2(uCurRes) - 1;
  vec4 cur = vec4(0.0), seen = vec4(0.0), lo = vec4(1e3), hi = vec4(-1e3), near = vec4(0.0);
  float wsum = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    ivec2 q = n + ivec2(i, j);
    vec4 c = texelFetch(uCur, clamp(q, ivec2(0), lim), 0);
    vec2 d = vec2(q) - p;
    float w = exp(-1.4 * dot(d, d));
    cur += c * w;
    seen += texture(uHist, (vec2(q) + 0.5 + uJitter) / uCurRes) * w;
    wsum += w;
    lo = min(lo, c); hi = max(hi, c);
    if (i == 0 && j == 0) near = c;
  }
  cur /= wsum; seen /= wsum;
  if (uAge < 0.5) { outColor = cur; return; }
  // The nearest look, measured in the picture's own pixels.
  float s = uOutRes.y / uCurRes.y;
  vec2 dn = (vec2(n) - p) * s;
  float sure = exp(-dot(dn, dn) / ${glf(2 * o.sigma * o.sigma)});
  float each = min(1.0, ${glf(6.2832 * o.sigma * o.sigma)} / (s * s));
  float gain = max(${glf(o.gain)}, 1.0 / (1.0 + uAge * each));
  vec4 hist = texture(uHist, uv);
  // Brightness, colour and nearness, each against its own local contrast.
  // Colour has a test of its own because a relight can change it and not the
  // brightness (uTint is luminance 1), and a wider tolerance than brightness:
  // a march's grain can sit in one channel, and judged channel by channel it
  // made a frozen room churn half as much again.
  vec3 d = cur.rgb - seen.rgb, r = hi.rgb - lo.rgb;
  float dy = abs(dot(d, vec3(0.25, 0.5, 0.25)));
  float dc = max(abs(0.5 * (d.r - d.b)), abs(dot(d, vec3(-0.25, 0.5, -0.25))));
  float err = max(max(
    dy / (${glf(o.tol)} + ${glf(o.tolRange)} * dot(r, vec3(0.25, 0.5, 0.25))),
    dc / (${glf(o.tolColour)} + ${glf(o.tolRange)} * max(r.r, max(r.g, r.b)))),
    abs(cur.a - seen.a) / (${glf(o.tol)} + ${glf(o.tolRange)} * (hi.a - lo.a)));
  float moving = smoothstep(1.0, 2.0, err);
  vec4 still = mix(hist, near, sure * gain);
  vec4 moved = mix(clamp(hist, lo, hi), cur, ${glf(o.moved)});
  outColor = mix(still, moved, moving);
}`;
  }
  var RESOLVE_FRAG = resolveSource();

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
    var names = ['uRes', 'uTime', 'uSideMix', 'uLook', 'uTint', 'uExposure', 'uSubject', 'uNoise', 'uJitter', 'uDetail', 'uView'];
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

  // --- the noise table --------------------------------------------------------
  //
  // Every scene is built from noise, and hashing four lattice corners per
  // octave is most of what a 3D scene costs. So the corners are generated once
  // — 256 x 256 random bytes from a fixed seed, in code, never fetched — and
  // packed four to a texel: (i,j), (i+1,j), (i,j+1) and (i+1,j+1), so one
  // texelFetch returns the whole cell and the scene only interpolates. Wrapping
  // is done by the shader (& 255), which is why the texture needs no sampler
  // state, and why the lattice repeats every 256 cells, far beyond any octave
  // the scenes read it at.
  var NOISE_N = 256;
  var NOISE_UNIT = 8;
  var _noiseTex = typeof WeakMap === 'function' ? new WeakMap() : null;

  function noiseTexture(gl) {
    var tex = _noiseTex && _noiseTex.get(gl);
    // A context that was lost and restored is the same object with none of its
    // textures: isTexture() is how that shows.
    if (tex && gl.isTexture(tex)) return tex;
    var n = NOISE_N, v = new Uint8Array(n * n), s = 0x9e3779b9;
    for (var i = 0; i < v.length; i++) {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;   // xorshift32
      v[i] = (s >>> 11) & 255;
    }
    var px = new Uint8Array(n * n * 4);
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        var o = (y * n + x) * 4, x1 = (x + 1) % n, y1 = (y + 1) % n;
        px[o] = v[y * n + x]; px[o + 1] = v[y * n + x1];
        px[o + 2] = v[y1 * n + x]; px[o + 3] = v[y1 * n + x1];
      }
    }
    tex = gl.createTexture();
    var prev = gl.getParameter(gl.ACTIVE_TEXTURE);
    gl.activeTexture(gl.TEXTURE0 + NOISE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.activeTexture(prev);
    if (_noiseTex) _noiseTex.set(gl, tex);
    return tex;
  }

  // The turn of the picture as a mat3 for the shader (column-major):
  // Ry(yaw) Rx(pitch) Rz(roll), the angles the sender measures from its phone
  // (see decomposeView()) and ships to a receiver drawing its scene. Absent or
  // non-finite angles are a still camera.
  var VIEW_IDENTITY = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  function viewMatrix(v) {
    if (!v) return VIEW_IDENTITY;
    var y = Number(v.yaw), p = Number(v.pitch), r = Number(v.roll);
    if (!isFinite(y) || !isFinite(p) || !isFinite(r)) return VIEW_IDENTITY;
    if (!y && !p && !r) return VIEW_IDENTITY;
    var cy = Math.cos(y), sy = Math.sin(y), cp = Math.cos(p), sp = Math.sin(p), cr = Math.cos(r), sr = Math.sin(r);
    // Row-major R = Ry Rx Rz, written out.
    var m00 = cy * cr + sy * sp * sr, m01 = -cy * sr + sy * sp * cr, m02 = sy * cp;
    var m10 = cp * sr,                m11 = cp * cr,                 m12 = -sp;
    var m20 = -sy * cr + cy * sp * sr, m21 = sy * sr + cy * sp * cr, m22 = cy * cp;
    return new Float32Array([m00, m10, m20, m01, m11, m21, m02, m12, m22]);
  }

  // The inverse of viewMatrix(): the angles of a row-major rotation matrix
  // (nine numbers) that was built as Ry Rx Rz.
  function decomposeView(m) {
    var s = -m[5];
    return {
      yaw: Math.atan2(m[2], m[8]),
      pitch: Math.asin(s < -1 ? -1 : s > 1 ? 1 : s),
      roll: Math.atan2(m[3], m[4])
    };
  }

  // Set a scene's uniforms. The caller has bound the target framebuffer and
  // viewport, and draws the full-screen triangle afterwards. `frame`, when the
  // frames are resolved into a bigger picture (RESOLVE_FRAG), says where in its
  // pixel this one looks ({ jitter: [x, y] }, px from the centre) and how tall
  // that picture is ({ detail }, px); without it a frame is a plain picture.
  //
  // `view`, when the phone has turned ({ yaw, pitch, roll }, radians), turns
  // the scene's camera by the same: see viewMatrix().
  function setUniforms(gl, prog, w, h, time, look, frame, view) {
    var L = prog.loc;
    gl.useProgram(prog.program);
    // The noise table lives on its own unit, so nothing the camera pipeline
    // has bound on the first few is disturbed; the active unit is put back.
    var prevUnit = gl.getParameter(gl.ACTIVE_TEXTURE);
    gl.activeTexture(gl.TEXTURE0 + NOISE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, noiseTexture(gl));
    gl.activeTexture(prevUnit);
    gl.uniform1i(L.uNoise, NOISE_UNIT);
    gl.uniform2f(L.uRes, w, h);
    gl.uniform1f(L.uTime, time);
    gl.uniform1f(L.uSideMix, look.sideMix);
    gl.uniform3f(L.uLook, Math.min(1, Math.abs(look.dirX)), look.dirY, look.motion);
    gl.uniform3f(L.uTint, look.tint[0], look.tint[1], look.tint[2]);
    gl.uniform1f(L.uExposure, look.exposure);
    // y up, like the scene.
    gl.uniform4f(L.uSubject, look.cx, 1 - look.cy, look.sx, look.sy);
    var j = frame && frame.jitter;
    gl.uniform2f(L.uJitter, j ? j[0] : 0, j ? j[1] : 0);
    gl.uniform1f(L.uDetail, (frame && frame.detail) || 0);
    gl.uniformMatrix3fv(L.uView, false, viewMatrix(view));
  }

  // --- thumbnails -----------------------------------------------------------
  //
  // Rendered from the shaders themselves, so a chip shows exactly the room it
  // picks — in a neutral light, at a fixed moment. One small offscreen context,
  // used for all five and released as soon as they are done: a page may hold
  // only a handful of live WebGL contexts and the camera pipeline needs one.
  var THUMB_W = 160, THUMB_H = 90, THUMB_TIME = 37.0;

  // Is this context drawn by the CPU (SwiftShader, llvmpipe...)? Compiling five
  // ray-marched shaders there costs the page a quarter of a minute, for the sake
  // of five chips that already show a gradient swatch — so the thumbnails are
  // skipped on such a machine, and the scenes themselves still work (the
  // pipeline's own governor decides whether the effect is affordable).
  // VideoEffects.canKeyIn() asks too: drawing other people's scenes on such a
  // machine is not offered at all. Windows' own rasteriser (WARP, the
  // "Microsoft Basic Render Driver" of a VM or a remote desktop) is one too.
  function isSoftwareGL(gl) {
    try {
      var info = gl.getExtension('WEBGL_debug_renderer_info');
      var name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
      return /swiftshader|llvmpipe|softpipe|software|basic render|warp/i.test(name);
    } catch (e) { return false; }
  }
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
      if (!(typeof window !== 'undefined' && window.__voxalThumbsOnSoftwareGL) && isSoftwareGL(gl)) {
        var drop = gl.getExtension('WEBGL_lose_context');
        if (drop) drop.loseContext();
        resolve(_thumbs);
        return;
      }
      var buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      var look = defaultLook();
      look.dirX = 0.6; look.cx = 0.5; look.cy = 0.7; look.sx = 0.25; look.sy = 0.35;
      // Where the driver compiles on its own threads, all five start at once;
      // where it does not (a software GPU, an older browser) a compile is the
      // page's own work, and five of them in one task would freeze it for as
      // long as they take — so each is started only when its turn comes, after
      // the page has had a moment to answer whatever was waiting. They are
      // drawn and read back one at a time either way, so no picture can be read
      // back over the next one's draw.
      var parallel = false;
      try { parallel = !!gl.getExtension('KHR_parallel_shader_compile'); } catch (e) { parallel = false; }
      var progs = SCENES.map(function (s) {
        return parallel ? compileProgramAsync(gl, s.id).catch(function () { return null; }) : null;
      });
      function turn(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
      var chain = Promise.resolve();
      SCENES.forEach(function (s, i) {
        chain = chain.then(function () {
          if (progs[i]) return progs[i];
          return turn(30).then(function () {
            return compileProgramAsync(gl, s.id).catch(function () { return null; });
          });
        }).then(function (prog) {
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
    RESOLVE_FRAG: RESOLVE_FRAG,
    resolveSource: resolveSource,
    JITTER: JITTER,
    _resolveConfig: RESOLVE,
    compileProgram: compileProgram,
    compileProgramAsync: compileProgramAsync,
    setUniforms: setUniforms,
    viewMatrix: viewMatrix,
    decomposeView: decomposeView,
    thumbnails: thumbnails,
    isSoftwareGL: isSoftwareGL,
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
