// penthouse.js — "Neon rain", the flagship: a penthouse 230 m up over a
// Pacific-rim harbour city at 01:00, under a typhoon's storm deck.
//
// Quiet inside, alive outside. Behind you: a dark room of plaster, concrete
// coffers and a terrazzo floor polished to a mirror, an aubergine velvet sofa
// on a floating plinth with its own underglow, a smoked-glass table, a brass
// arc lamp with an opal globe on the key-light side, a cyan strip in the wall
// opposite and a magenta one on the key side, both held in the floor. Then a
// wall of wet glass, with bronze posts at the sides and none behind the head.
//
// Outside is geometry, not a picture: a city of eight tower archetypes in
// four depth bands, merged into one draw, with windows that hold still by
// construction (a hash decides which are lit, one window per tower changes
// every minute and a half, and a pixel that spans several windows shows how
// many are lit in their mean colour). Down the middle runs the harbour, misty
// and calm, to a far shore and a ridge lost in the cloud: that corridor is
// where a head goes. The storm deck is low and lit from below by the city;
// the towers' crowns pierce it; once in a while a flash lights it from inside.
// Rain falls in two depths outside, beads and runnels sit on the glass, and
// both are held back in front of the face.
//
// Authored with the key light on +x (the image is mirrored for a light on the
// left: nothing here is handed). Units: metres; the camera is the origin,
// 1.25 m above the floor, looking down -z at the glass 4.8 m away; sea level
// is 231 m below the camera, the cloud base 118 m above it.
//
// Programs: sky, city (towers, ground, water, ridge), emissive (strips,
// crowns' lights, halos, ghosts in the glass), drops on the glass, rain, and
// three of Three's standard ones (the room, the mirror floor, the glass).

import { THREE } from './engine.js';
import * as K from './kit.js';

// --- the room -----------------------------------------------------------------------
const FLOOR = -1.25, CEIL = 2.30, GZ = -4.8, SIDE = 3.1, BACKZ = 1.0;
const POST_X = 1.85, SILL = -1.07;
// --- the city ---------------------------------------------------------------------------
const STREET = -225, SEA = -231, DECK = 118;

const D2R = Math.PI / 180;

// --- art direction in display colours ---------------------------------------------------
//
// A colour given as what the camera should SHOW (sRGB) is turned into the
// radiance that shows it: the output pass is srgb(aces(hdr x exposure x 0.55)).
// k = 0.55 at exposure 1 (the blue hour); in a dark room everything here is
// compensated (see update()) so k = 0.40 is what the night colours are shown at.
function acesJ(x) { return Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14))); }
function invAces(y) {
  let lo = 0, hi = 64;
  for (let i = 0; i < 48; i++) { const m = 0.5 * (lo + hi); if (acesJ(m) < y) lo = m; else hi = m; }
  return 0.5 * (lo + hi);
}
function shown(hex, k = 0.55) {
  const c = new THREE.Color(hex);
  return new THREE.Color(invAces(c.r) / k, invAces(c.g) / k, invAces(c.b) / k);
}
const NK = 0.40;
const lin = (hex, s = 1) => new THREE.Color(hex).multiplyScalar(s);

// The storm: a far flash every so often — the old shader's stormFlash(), kept
// exactly (21 s windows, a hash decides which have a stroke and when; the
// first is due 35.46 s in): a stroke and a weaker one 0.2 s behind it.
function fract(x) { return x - Math.floor(x); }
function hash11(p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
function sstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
function stormFlash(T) {
  let f = 0;
  for (let i = 0; i < 2; i++) {
    const k = Math.floor(T / 21) - i;
    const on = hash11(k * 5.17 + 2.3) >= 0.38 ? 1 : 0;
    const dt = T - (k + 0.1 + 0.7 * hash11(k * 3.31 + 7.0)) * 21;
    const a = sstep(0, 0.025, dt) * Math.exp(-Math.max(dt, 0) * 7);
    const b = sstep(0.20, 0.23, dt) * Math.exp(-Math.max(dt - 0.20, 0) * 4.5) * 0.65;
    f += on * (a + b) * (dt <= 3 ? 1 : 0);
  }
  return Math.min(f, 1);
}
// Where in the deck a window's stroke lights it: always off to a side.
function flashDir(T, out) {
  const k = Math.floor(T / 21);
  const side = hash11(k * 9.13 + 1.7) < 0.5 ? -1 : 1;
  const az = side * (24 + 16 * hash11(k * 2.71 + 4.4)) * D2R;
  const el = (7 + 8 * hash11(k * 6.07 + 0.3)) * D2R;
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

// --- the air: shared by the sky, the city and the drops on the glass ----------------------

const ATMOS = `
uniform vec3 uDeckTop; uniform vec3 uDeckLow; uniform vec3 uDeckHor;
uniform vec3 uHazeL; uniform vec3 uHazeR; uniform vec3 uHazeC; uniform vec3 uHazeLow;
uniform vec3 uFlashCol; uniform float uFlash; uniform vec3 uFlashDir;
uniform vec3 uLit;
const float STREET_Y = ${STREET.toFixed(1)};
const float SEA_Y = ${SEA.toFixed(1)};
const float DECK_Y = ${DECK.toFixed(1)};
float band(float x, float lo, float hi, float w) {
  return (clamp(x + 0.5 * w, lo, hi) - clamp(x - 0.5 * w, lo, hi)) / max(w, 1e-5);
}
// The glow of the city under the deck along a direction: violet to the left,
// magenta over the signage on the right, teal mist down the harbour.
vec3 horTint(vec3 d) {
  float az = d.x / max(-d.z, 0.25);
  vec3 side = mix(uHazeL, uHazeR, sstep(-0.55, 0.55, az));
  return mix(side, uHazeC, exp(-sq(az / 0.24)));
}
// The storm deck's underside (and the air under it, for a ray just above the horizon).
vec3 deckCol(vec3 d) {
  float e = max(d.y, 0.0);
  vec3 c = mix(uDeckHor, uDeckLow, sstep(0.0, 0.14, e));
  c = mix(c, uDeckTop, sstep(0.10, 0.55, e));
  c += horTint(d) * exp(-e * 11.0);
  float cell = pow(max(dot(d, uFlashDir), 0.0), 5.0);
  c += uFlashCol * uFlash * (0.55 + 2.4 * cell) * sstep(-0.05, 0.08, d.y);
  return c;
}
// The air looking along d: what fog fades a far thing into. Continuous with
// deckCol() at the horizon; lower rays see the canyons' sodium.
vec3 hazeAt(vec3 d) {
  vec3 c = uDeckHor + horTint(d);
  c += uHazeLow * sstep(-0.01, -0.16, d.y);
  c += uFlashCol * uFlash * 0.35;
  return c;
}
// Height fog from the street up (denser low): how much of the way to wp is air.
float airAmt(vec3 wp) {
  vec3 dv = wp - cameraPosition;
  float dist = length(dv);
  float k = 1.0 / 120.0;
  float a = 0.0009 * exp(-(cameraPosition.y - STREET_Y) * k) + 0.00012;
  float kd = k * dv.y;
  float tt = abs(kd) > 1e-3 ? (1.0 - exp(-kd)) / kd : 1.0 - 0.5 * kd;
  return min(1.0 - exp(-a * tt * dist), 0.975);
}
// ... and the cloud deck swallowing whatever climbs into it.
float cloudAmt(vec3 wp) { return sstep(DECK_Y - 70.0, DECK_Y + 50.0, wp.y); }
vec3 airFog(vec3 col, vec3 wp) {
  vec3 rd = normalize(wp - cameraPosition);
  col = mix(col, hazeAt(rd), airAmt(wp));
  return mix(col, deckCol(rd), cloudAmt(wp));
}
// What reaches the camera of a light at wp (an additive glow adds no air of its own).
float airTrans(vec3 wp) { return (1.0 - airAmt(wp)) * (1.0 - cloudAmt(wp)); }
`;

// --- the sky: the storm deck ---------------------------------------------------------------
const SKY_FRAG = `
  vec3 d = normalize(vWorld - cameraPosition);
  vec3 c = deckCol(d);
  float e = max(d.y, 0.0);
  float az = d.x / max(-d.z, 0.25);
  // Billows on the deck's underside, only in the upper corners: the middle
  // of the sky behind a head stays an even glow.
  float corner = mix(0.35, 1.0, sstep(0.10, 0.40, abs(az))) * sstep(0.04, 0.20, e);
  if (corner > 0.0) {
    vec2 p = d.xz * (DECK_Y / max(d.y, 0.03));
    vec2 q = p * 0.006 + vec2(uTime * 0.0035, uTime * 0.0012);
    float fw = footprint(q.x) + footprint(q.y);
    int oct = fw > 0.5 ? 1 : fw > 0.15 ? 2 : fw > 0.05 ? 3 : 4;
    float n = fbm2(q, oct);
    float n2 = fbm2(q + vec2(0.0, 0.35), oct);
    // lit from below: the lower side of a billow is the bright one
    float lump = clamp(0.55 + (n - 0.5) * 1.9 + (n - n2) * 1.6, 0.18, 1.7);
    c *= mix(1.0, lump, corner);
  }
  // Rain shafts over the far shore: soft vertical veils near the horizon, at the sides.
  float veil = vnoise(vec2(atan(d.x, -d.z) * 34.0 + uTime * 0.004, 0.5));
  c *= 1.0 - 0.10 * veil * exp(-e * 22.0) * sstep(0.10, 0.30, abs(az));
  // The spire's beacon, glowing through the cloud base.
  vec3 bd = normalize(uBeacon.xyz);
  float bb = max(dot(d, bd), 0.0);
  c += uBeaconCol * uEmis * (pow(bb, 9000.0) * 1.0 + pow(bb, 1400.0) * 0.12);
  gl_FragColor = vec4(c, 0.0);
`;

// --- the city ---------------------------------------------------------------------------------
//
// One merged geometry, one program: walls with windows, roofs, the streets,
// the harbour water and the ridge. Per vertex:
//   aFac (across the wall m, up from the street m, this section's top m, building x 8 + face)
//   aWin (bay m, floor m, kind, lit-share bias)  kind: 0 blank 1 office 2 residential
//        3 hotel 4 finned office 6 street 7 water 8 ridge
//   aCol (albedo rgb linear, gloss)
//   aGlw (light radiance rgb, kind x 1000 + width m)  kind: 1 flood from below
//        2 LED edge 3 ribbons 4 rings every 8 floors 5 lattice crown
const CITY_DECL = `
varying vec4 vFac; varying vec4 vWin; varying vec4 vCol; varying vec4 vGlw;
varying vec3 vN; varying vec3 vWorld;
`;
const CITY_VERT = `
attribute vec4 aFac; attribute vec4 aWin; attribute vec4 aCol; attribute vec4 aGlw;
void main() {
  vFac = aFac; vWin = aWin; vCol = aCol; vGlw = aGlw;
  vN = normal;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const CITY_FRAG = `
uniform vec4 uWinK;      // x lit share scale, y window radiance, z detail kept in the subject (0..1)
uniform vec3 uWarm; uniform vec3 uNeutral; uniform vec3 uCool; uniform vec3 uAccA; uniform vec3 uAccB;
uniform vec3 uSodium; uniform vec3 uLed;
uniform vec3 uAmbUp; uniform vec3 uAmbLow;
// The head itself, tighter than subjectMask() (which takes in the shoulders).
float subjectCore(vec2 uv) {
  vec2 d = (uv - uSubject.xy) / max(uSubject.zw * vec2(0.85, 0.95), vec2(1e-3));
  return 1.0 - smoothstep(0.55, 1.15, length(d));
}

// The windows of a wall: rgb emitted, a glass coverage. Stable by construction.
vec4 windows(float kind, vec2 uv, float topV, float bias, vec2 cell, float seedF, float calm) {
  vec2 g = uv / cell;
  // Filtered against the BUFFER's pixel, not the resolved picture's: a lit
  // window the jitter can move across a pixel edge is churn every redraw
  // pays for, and the frozen room's cost is mostly that.
  vec2 fw = max(fwidth(g) * 1.2, vec2(1e-4));
  float foot = max(fw.x, fw.y);
  vec2 gs = kind > 3.5 ? vec2(0.80, 0.68) : kind > 1.5 ? vec2(0.56, 0.58) : vec2(0.70, 0.62);
  vec2 lo = 0.5 - 0.5 * gs, hi = 0.5 + 0.5 * gs;
  float gx = pulse(g.x, lo.x, hi.x, fw.x);
  float gyL = pulse(g.y, lo.y, 0.5, fw.y);
  float gyH = pulse(g.y, 0.5, hi.y, fw.y);
  vec2 id = floor(g);
  float bld = floor(seedF / 8.0), face = seedF - bld * 8.0;
  float nFl = floor(topV / cell.y);
  float office = (kind < 1.5 || kind > 3.5) ? 1.0 : 0.0;
  float frac = kind < 1.5 ? 0.33 : kind < 2.5 ? 0.56 : kind < 3.5 ? 0.60 : 0.30;
  frac = clamp((frac + bias) * uWinK.x, 0.02, 0.9);
  float topB = step(nFl - 3.0, id.y) * 0.15;
  float on;
  if (office > 0.5) {
    float fl = step(hash12(vec2(bld * 1.73 + face * 0.0, id.y + 0.5)), (frac + topB) * 1.08);
    on = fl * step(hash13(vec3(id, seedF)), 0.88) + (1.0 - fl) * step(hash13(vec3(id, seedF + 7.0)), 0.05);
  } else {
    on = step(hash13(vec3(id, seedF)), frac + topB);
  }
  // One window at a time: two slots per tower, each holding one window in
  // the other state for 90 s, fading over 1.5 s.
  for (int j = 0; j < 2; j++) {
    float ep = uTime / 90.0 + float(j) * 0.5 + hash11(bld * 3.7 + 0.2);
    float kk = floor(ep), inE = fract(ep) * 90.0;
    float pf = floor(hash12(vec2(bld + 0.5, kk * 1.3 + float(j))) * 4.0);
    float px = floor(hash12(vec2(kk + 0.5, bld * 0.7 + 5.0)) * 16.0);
    float py = floor(hash12(vec2(bld + 2.5, kk + 0.25)) * max(nFl, 1.0));
    float hit = step(abs(face - pf), 0.5) * step(abs(id.x - px), 0.5) * step(abs(id.y - py), 0.5);
    float fade = sstep(0.0, 1.5, inE) * sstep(90.0, 88.5, inE);
    on = mix(on, 1.0 - on, hit * fade);
  }
  float hc = hash13(vec3(id.yx, seedF + 1.3));
  float w = office > 0.5 ? 0.38 : 0.56;
  vec3 c = hc < w ? uWarm : hc < w + 0.2 ? uNeutral : hc < 0.95 ? uCool
         : (hash13(vec3(id, seedF + 4.0)) < 0.5 ? uAccA : uAccB);
  c *= 0.85 + 0.30 * hash13(vec3(id, seedF + 5.5));
  float blind = step(hash13(vec3(id, seedF + 9.0)), 0.30);
  float lit = gx * (gyL + gyH * mix(1.0, 0.30, blind));
  vec3 meanC = office > 0.5 ? uWarm * 0.38 + uNeutral * 0.2 + uCool * 0.37 + (uAccA + uAccB) * 0.025
                            : uWarm * 0.56 + uNeutral * 0.2 + uCool * 0.19 + (uAccA + uAccB) * 0.025;
  float far = max(smoothstep(0.42, 0.9, foot), calm);
  vec3 em = mix(c * on * lit, meanC * (frac + topB * 0.2) * gx * (gyL + gyH * 0.79), far);
  return vec4(em * uWinK.y, gx * (gyL + gyH));
}

void main() {
  vec3 dv = vWorld - cameraPosition;
  float dist = length(dv);
  vec3 rd = dv / dist;
  vec3 N = normalize(vN);
  float kind = vWin.z;
  vec3 alb = vCol.rgb;
  float hgt = vWorld.y - STREET_Y;
  vec2 sp = gl_FragCoord.xy / uRes;
  float core = subjectCore(sp);
  float calm = uWinK.z * core;
  // Light on a surface: the deck above, the city's glow from below (strong in
  // the canyons, fading with height), and the flash.
  vec3 amb = mix(uAmbLow * (0.30 + 0.70 * exp(-hgt / 85.0)), uAmbUp, 0.5 + 0.5 * N.y);
  amb += uFlashCol * uFlash * (0.15 + 0.6 * max(N.y, 0.0)) * 0.6;
  vec3 col;
  if (kind > 6.5 && kind < 7.5) {
    // The harbour: a soft mirror of the deck, a long glow under the far shore,
    // no sparkle. Ripples are far finer than a pixel here, so they are their average.
    vec3 r = reflect(rd, vec3(0.0, 1.0, 0.0));
    r.y = max(r.y, 0.004);
    float fres = 0.02 + 0.98 * pow(1.0 - max(-rd.y, 0.0), 5.0);
    col = deckCol(normalize(r + vec3(0.0, 0.03, 0.0))) * (0.12 + 0.5 * fres);
    float az = rd.x / max(-rd.z, 0.25);
    // the far shore's lights, smeared down the water (blurred, steady)
    float below = -rd.y - 0.056;
    float streak = exp(-max(below, 0.0) / 0.03) * sstep(-0.004, 0.004, below);
    float cols = 0.55 + 0.9 * vnoise(vec2(az * 38.0, 7.0)) * vnoise(vec2(az * 11.0, 2.0));
    col += (uHazeLow * 0.7 + uWarm * uEmis * 0.05) * streak * cols;
    // and the banks' towers at the corridor's edges
    float edge = sstep(0.11, 0.2, abs(az));
    col += mix(uHazeL, uHazeR, step(0.0, az)) * edge * 0.6 * (0.6 + 0.8 * vnoise(vec2(az * 24.0, 1.0)));
    col += alb * amb * 0.3;
  } else if (kind > 5.5 && kind < 6.5) {
    // Streets: wet asphalt, sodium and LED lines on a grid of blocks.
    vec2 q = vWorld.xz / vec2(92.0, 118.0);
    vec2 fw = max(footprint2(q), vec2(1e-4));
    float rx = pulse(q.x, 0.0, 0.16, fw.x), rz = pulse(q.y, 0.0, 0.13, fw.y);
    float road = max(rx, rz);
    float cl = max(pulse(q.x, 0.075, 0.085, fw.x), pulse(q.y, 0.06, 0.07, fw.y));
    float district = 0.55 + 0.9 * vnoise(vWorld.xz * 0.0021);
    col = alb * amb + (uSodium * road + uLed * cl * 0.6) * district * uEmis;
    col += deckCol(reflect(rd, vec3(0.0, 1.0, 0.0))) * 0.12;
  } else if (kind > 7.5) {
    // The ridge across the bay: dark rock, a fringe of lights at its foot.
    col = alb * amb;
    float foot = exp(-max(vWorld.y - SEA_Y, 0.0) / 45.0);
    col += uHazeLow * foot * 0.6 * (0.6 + 0.8 * vnoise(vWorld.xz * 0.01)) * uEmis;
  } else if (N.y > 0.6) {
    // Roofs, seen from above: plant boxes on a 7 m grid, wet.
    vec2 q = vWorld.xz / 7.0;
    vec2 fw = max(footprint2(q), vec2(1e-4));
    vec2 id = floor(q);
    float box = pulse(q.x, 0.2, 0.75, fw.x) * pulse(q.y, 0.25, 0.8, fw.y);
    float has = mix(step(hash12(id + vFac.w), 0.35), 0.35, smoothstep(0.35, 1.0, max(fw.x, fw.y)));
    col = alb * amb * (1.0 + 0.6 * box * has);
    float fres = 0.04 + 0.96 * pow(1.0 - max(-rd.y, 0.0), 5.0);
    col += deckCol(reflect(rd, N)) * fres * 0.5 * vCol.w;
  } else {
    // Walls: the facade, its windows, the glass reflecting the deck.
    vec2 uv = vFac.xy;
    if (kind > 3.5) {
      // fins every 1.5 m, catching the light from below
      float fwf = max(footprint(uv.x / 1.5), 1e-4);
      float fin = pulse(uv.x / 1.5, 0.0, 0.16, fwf);
      alb = mix(alb, alb * 1.6 + 0.006, fin);
    }
    col = alb * amb;
    if (kind > 0.5) {
      vec4 W = windows(kind, uv, vFac.z, vWin.w, vWin.xy, vFac.w, calm);
      float fres = 0.05 + 0.95 * pow(1.0 - abs(dot(rd, N)), 5.0);
      vec3 glassC = deckCol(reflect(rd, N)) * (0.18 + 0.8 * fres) * vCol.w + vec3(0.002, 0.003, 0.006);
      col = mix(col, glassC, W.a * 0.92) + W.rgb * uEmis;
    }
  }
  // Lights on the buildings: crowns, outlines, ribbons, rings.
  float gk = floor(vGlw.w / 1000.0 + 0.001);
  if (gk > 0.5 && abs(N.y) < 0.6) {
    float wid = vGlw.w - gk * 1000.0;
    float dTop = vFac.z - vFac.y;
    float fwT = max(footprint(dTop), 1e-3);
    vec3 L = vec3(0.0);
    if (gk < 1.5) {
      // flood from below over the crown: brightest at its foot
      float inC = band(dTop, 0.0, wid, fwT);
      L = vGlw.rgb * inC * (0.25 + 0.75 * exp(-max(wid - dTop, 0.0) / (0.3 * wid)));
    } else if (gk < 2.5) {
      L = vGlw.rgb * band(dTop, 0.0, wid, fwT);
    } else if (gk < 3.5) {
      float per = wid / 3.0;
      float x = vFac.x / per;
      float rb = pulse(x, 0.0, 0.07, max(footprint(x), 1e-4));
      float hf = clamp(vFac.y / max(vFac.z, 1.0), 0.0, 1.0);
      L = mix(vGlw.rgb, vec3(vGlw.b * 0.55, vGlw.g * 0.6, vGlw.r * 0.9), hf) * rb;
    } else if (gk < 4.5) {
      float x = vFac.y / (8.0 * vWin.y);
      L = vGlw.rgb * pulse(x, 0.0, 1.4 / (8.0 * vWin.y), max(footprint(x), 1e-4)) * step(kind, 6.0);
    } else {
      float x = vFac.x / 4.5, y = vFac.y / 4.5;
      float lat = max(pulse(x, 0.0, 0.12, max(footprint(x), 1e-4)), pulse(y, 0.0, 0.12, max(footprint(y), 1e-4)));
      L = vGlw.rgb * lat * band(dTop, 0.0, wid, fwT);
    }
    col += L * uEmis * (1.0 - 0.5 * calm);
  }
  col = airFog(col, vWorld);
  // Behind the head, the city recedes into the mist: half the detail.
  col = mix(col, hazeAt(rd) * 0.7, core * uWinK.w);
  gl_FragColor = vec4(col, 0.0);
}
`;

// --- emissive: strips, crowns' lamps, halos, ghosts, washes --------------------------------
//
// One program for every light-emitting thing, drawn by two materials (opaque
// and additive). Per vertex:
//   aEm (radiance rgb, animation: 0 steady 1 aviation 2.5 s fade 2 signage
//        gradient 3 mover 4 a slow breath)
//   aA  (halo radius m | cycle s, speed m/s, phase, mode: 0 surface 1 halo
//        2 ghost in the glass 3 linear wash 4 radial wash 5 opal sphere)
//   aB  (second colour | direction of travel, path length)
const EM_DECL = `
varying vec4 vEm; varying vec4 vA; varying vec4 vB; varying vec2 vQ; varying vec3 vN; varying float vScale;
varying vec3 vWorld;
uniform float uAdd; uniform float uGhostZ; uniform vec4 uGhostBox; uniform float uFloorY;
`;
const EM_VERT = `
attribute vec4 aEm; attribute vec4 aA; attribute vec4 aB;
void main() {
  vEm = aEm; vA = aA; vB = aB; vQ = uv; vScale = 1.0;
  vec3 p = position;
  float mode = aA.w;
  if (aEm.w > 2.5 && aEm.w < 3.5) {
    float s = mod(uTime * aA.y + aA.z, aB.w) - 0.5 * aB.w;
    p += aB.xyz * s;
  }
  vec4 wp = modelMatrix * vec4(p, 1.0);
  if (mode > 0.5 && mode < 1.5) {
    vec3 toC = cameraPosition - wp.xyz;
    float dist = length(toC);
    toC /= dist;
    vec3 rt = normalize(cross(vec3(0.0, 1.0, 0.0), toC));
    vec3 up = cross(toC, rt);
    float px = dist * 2.0 / (projectionMatrix[1][1] * uBufH);
    float r = max(aA.x, px * 1.6);
    vScale = sq(aA.x / r);
    wp.xyz += (rt * (uv.x * 2.0 - 1.0) + up * (uv.y * 2.0 - 1.0)) * r;
  }
  if (mode > 1.5 && mode < 2.5) wp.xyz *= uGhostZ / wp.z;
  if (mode > 5.5) wp.xyz *= uFloorY / wp.y;   // a reflection in the floor, drawn on the floor
  vWorld = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const EM_FRAG = `
void main() {
  float mode = vA.w;
  vec3 c = vEm.rgb;
  float an = vEm.w;
  if (an > 0.5 && an < 1.5) c *= 0.12 + 0.88 * sq(0.5 + 0.5 * sin(6.2832 * (uTime / 2.5 + vA.z)));
  else if (an > 1.5 && an < 2.5) {
    float g = 0.5 + 0.5 * sin(6.2832 * (vQ.x * 0.55 + vQ.y * 0.3 + uTime / vA.x + vA.z));
    c = mix(vEm.rgb, vB.rgb, g);
  } else if (an > 3.5) c *= 1.0 + 0.05 * sin(6.2832 * (uTime / 7.0 + vA.z));
  float a = 1.0;
  if (mode > 0.5 && mode < 1.5) {
    vec2 q = vQ * 2.0 - 1.0;
    float d2 = dot(q, q);
    a = sq(max(1.0 - d2, 0.0)) / (1.0 + d2 / 0.02);
    c *= vScale;
  } else if (mode > 1.5 && mode < 2.5) {
    a = sq(sin(3.14159 * clamp(vQ.x, 0.0, 1.0))) * step(uGhostBox.x, vWorld.x) * step(vWorld.x, uGhostBox.y) * step(uGhostBox.z, vWorld.y) * step(vWorld.y, uGhostBox.w);
  } else if (mode > 2.5 && mode < 3.5) {
    a = sq(1.0 - clamp(vQ.y, 0.0, 1.0)) * sstep(0.0, 0.15, vQ.x) * sstep(1.0, 0.85, vQ.x);
  } else if (mode > 3.5 && mode < 4.5) {
    vec2 q = vQ * 2.0 - 1.0;
    a = sq(max(1.0 - dot(q, q), 0.0));
  } else if (mode > 5.5) {
    // soft across, fading away from where the light meets the floor
    float across = vQ.x * 2.0 - 1.0;
    a = sq(max(1.0 - across * across, 0.0)) * pow(1.0 - clamp(vQ.y, 0.0, 1.0), 1.6);
    if (mode > 6.5) { vec2 q = vQ * 2.0 - 1.0; a = sq(max(1.0 - dot(q, q), 0.0)); }
  } else if (mode > 4.5) {
    vec3 V = normalize(cameraPosition - vWorld);
    float ndv = max(dot(normalize(vN), V), 0.0);
    c *= 0.72 + 0.28 * ndv;
  }
  c *= uEmis;
  if (uAdd > 0.5) gl_FragColor = vec4(c * airTrans(vWorld), a);
  else gl_FragColor = vec4(c, 0.0);
}
`;

// --- drops on the glass --------------------------------------------------------------------
//
// Beads that stay, a few drops that slide in fits and starts and leave a
// trail, runnels only toward the sides. Each drop is a lens: it shows the
// world behind it upside down (the city's glow in its top, the deck in its
// bottom), with a dark rim and a pin of the room's light. Held back in front
// of the face; a bead smaller than the picture's pixel is its average.
const DROP_FRAG = `
uniform vec4 uDrops;     // x amount, y calm, z lamp highlight, w
uniform vec3 uRoomL; uniform vec3 uRoomR; uniform vec3 uLampC;
vec4 lens(vec2 dv, float r, float mpp, float side) {
  float d = length(dv);
  float aa = max(mpp / r, 0.02);
  float cov = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, d);
  if (cov <= 0.0) return vec4(0.0);
  // the world behind, upside down and squeezed into the drop
  vec3 look = normalize(vec3(dv.x * 0.25, -dv.y * 0.22 - 0.035, -1.0));
  vec3 c = hazeAt(look) * 0.55;
  c += (uHazeLow * 0.6 + uHazeR * 0.3) * sstep(0.0, 0.8, dv.y);
  // a soft edge, and the room's light caught on the upper side
  c *= 1.0 - 0.35 * smoothstep(0.6, 1.0, d);
  vec3 room = mix(uRoomL, uRoomR, side) * uEmis;
  c += room * smoothstep(0.65, 0.95, d) * sstep(0.2, 0.9, dv.y) * 0.35;
  c += uLampC * uEmis * exp(-dot(dv - vec2(0.32, 0.42), dv - vec2(0.32, 0.42)) / 0.025) * uDrops.z * sstep(0.3, 1.0, side);
  // too small to see: its average, faint
  float vis = sstep(0.5, 1.6, r / mpp);
  return vec4(c, cov * mix(0.15, 0.7, vis));
}
void main() {
  vec2 p = vWorld.xy;
  vec2 sp = gl_FragCoord.xy / uRes;
  float calm = 1.0 - uDrops.y * subjectMask(sp);
  float side = sstep(-2.2, 2.2, p.x);
  float outer = sstep(0.75, 1.9, abs(p.x));
  float mpp = max(footprint(p.x), 1e-5);
  vec4 acc = vec4(0.0);
  // beads that stay: two grids
  for (int L = 0; L < 2; L++) {
    float cs = L == 0 ? 0.11 : 0.07;
    vec2 g = p / cs + float(L) * 17.31;
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    vec2 h = hash22(id);
    float keep = mix(0.06, 0.42, outer) * (L == 0 ? 1.0 : 0.5);
    if (hash12(id + 3.1) > keep) continue;
    float r = cs * (0.10 + 0.12 * h.y);
    vec2 dv = (f - (h - 0.5) * 0.5) * cs / r;
    dv.y *= 1.08;
    vec4 l = lens(dv, r, mpp, side);
    acc += vec4(l.rgb * l.a, l.a) * (1.0 - acc.a);
  }
  // drops that slide, in fits and starts, and their trails: toward the sides only
  {
    float cw = 0.31;
    float cx = floor(p.x / cw);
    float hx = hash11(cx * 7.13 + 0.7);
    float ok = step(1.05, abs((cx + 0.5) * cw)) * step(hx, 0.75);
    if (ok > 0.5) {
      float x0 = (cx + 0.2 + 0.6 * hash11(cx * 3.1 + 2.0)) * cw;
      float period = 3.5 + 3.0 * hash11(cx * 1.7);
      float tau = uTime / period + hash11(cx * 5.3);
      float prog = floor(tau) + smoothstep(0.62, 1.0, fract(tau));
      float H = ${(CEIL - SILL).toFixed(2)};
      float travel = prog * (0.05 + 0.05 * hash11(cx * 2.9));
      float y = ${CEIL.toFixed(2)} - mod(travel + hash11(cx * 9.1) * H, H);
      float fadeE = sstep(${CEIL.toFixed(2)}, ${(CEIL - 0.25).toFixed(2)}, y) * sstep(${SILL.toFixed(2)}, ${(SILL + 0.3).toFixed(2)}, y);
      float xw = x0 + 0.012 * sin(p.y * 7.0 + cx);
      float r = 0.016;
      vec2 dv = vec2((p.x - xw) / r, (p.y - y) / (r * 1.25));
      vec4 l = lens(dv, r, mpp, side);
      l.a *= fadeE;
      acc += vec4(l.rgb * l.a, l.a) * (1.0 - acc.a);
      // the trail above it: a thin wet line, beading, fading with height
      float above = p.y - y;
      if (above > 0.0 && above < 0.45) {
        float tw = 0.0035;
        float lw = max(tw, mpp * 0.8);
        float line = (tw / lw) * (1.0 - smoothstep(0.5 * lw, 0.5 * lw + mpp, abs(p.x - xw)));
        float beads = 0.55 + 0.45 * pulse(p.y / 0.03, 0.0, 0.5, max(footprint(p.y / 0.03), 1e-3));
        float tr = line * beads * (1.0 - above / 0.45) * 0.55 * fadeE;
        vec3 tc = hazeAt(normalize(vec3(0.0, -0.06, -1.0))) * 0.9 + mix(uRoomL, uRoomR, side) * uEmis * 0.2;
        acc += vec4(tc * tr, tr) * (1.0 - acc.a);
      }
    }
  }
  float a = acc.a * uDrops.x * calm;
  gl_FragColor = vec4(acc.rgb / max(acc.a, 1e-4), clamp(a, 0.0, 1.0));
}
`;

// --- building the city ----------------------------------------------------------------------

class CityBuf {
  constructor() { this.P = []; this.N = []; this.F = []; this.W = []; this.C = []; this.G = []; }
  vert(p, n, f, face) {
    this.P.push(p[0], p[1], p[2]); this.N.push(n[0], n[1], n[2]);
    this.F.push(f[0], f[1], f[2], f[3]);
    this.W.push(...face.win); this.C.push(...face.col); this.G.push(...face.glw);
  }
  // A triangle; its winding is fixed against the normal it should face.
  tri(a, b, c, na, nb, nc, fa, fb, fc, face, want) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * want[0] + cy * want[1] + cz * want[2] < 0) {
      this.vert(a, na, fa, face); this.vert(c, nc, fc, face); this.vert(b, nb, fb, face);
    } else {
      this.vert(a, na, fa, face); this.vert(b, nb, fb, face); this.vert(c, nc, fc, face);
    }
  }
  // A wall from a to b (xz), y0..y1, facing n; u runs from a.
  wall(a, b, y0, y1, n, face, u0 = 0, fid = 0) {
    const right = [n[2], -n[0]];
    if ((b[0] - a[0]) * right[0] + (b[1] - a[1]) * right[1] < 0) { const t = a; a = b; b = t; }
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const N3 = [n[0], 0, n[2]];
    const top = y1 - STREET;
    const s = face.seed * 8 + fid;
    const p00 = [a[0], y0, a[1]], p10 = [b[0], y0, b[1]], p11 = [b[0], y1, b[1]], p01 = [a[0], y1, a[1]];
    const f00 = [u0, y0 - STREET, top, s], f10 = [u0 + L, y0 - STREET, top, s];
    const f11 = [u0 + L, y1 - STREET, top, s], f01 = [u0, y1 - STREET, top, s];
    this.tri(p00, p10, p11, N3, N3, N3, f00, f10, f11, face, N3);
    this.tri(p00, p11, p01, N3, N3, N3, f00, f11, f01, face, N3);
    return L;
  }
  // A convex footprint (xz points, any order around), y0..y1, walls and a roof.
  prismFlat(pts, y0, y1, face, roof = true) {
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    let u = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      let nx = b[1] - a[1], nz = -(b[0] - a[0]);
      const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l;
      const mx = (a[0] + b[0]) / 2 - cx, mz = (a[1] + b[1]) / 2 - cz;
      if (nx * mx + nz * mz < 0) { nx = -nx; nz = -nz; }
      u += this.wall(a, b, y0, y1, [nx, 0, nz], face, pts.length > 4 ? u : 0, i % 4);
    }
    if (roof) this.cap(pts, y1, face);
  }
  cap(pts, y, face) {
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const up = [0, 1, 0], f = [0, y - STREET, y - STREET, face.seed * 8];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      this.tri([cx, y, cz], [a[0], y, a[1]], [b[0], y, b[1]], up, up, up, f, f, f, face, up);
    }
  }
  // A smooth, possibly twisting prism: ring(levelFraction) gives the outline.
  prismSmooth(ring, levels, y0, y1, face, roof = true) {
    const rings = [];
    for (let j = 0; j <= levels; j++) rings.push(ring(j / levels));
    const n = rings[0].length;
    const norm = (R, i) => {
      const a = R[(i - 1 + n) % n], b = R[(i + 1) % n];
      let nx = b[1] - a[1], nz = -(b[0] - a[0]);
      const cx = R.reduce((s, p) => s + p[0], 0) / n, cz = R.reduce((s, p) => s + p[1], 0) / n;
      if (nx * (R[i][0] - cx) + nz * (R[i][1] - cz) < 0) { nx = -nx; nz = -nz; }
      const l = Math.hypot(nx, nz) || 1;
      return [nx / l, 0, nz / l];
    };
    const top = y1 - STREET;
    for (let j = 0; j < levels; j++) {
      const A = rings[j], B = rings[j + 1];
      const ya = y0 + (y1 - y0) * j / levels, yb = y0 + (y1 - y0) * (j + 1) / levels;
      let u = 0;
      for (let i = 0; i < n; i++) {
        const i2 = (i + 1) % n;
        const L = Math.hypot(A[i2][0] - A[i][0], A[i2][1] - A[i][1]);
        const fid = Math.floor(i * 4 / n);
        const s = face.seed * 8 + fid;
        const na = norm(A, i), nb = norm(A, i2), nc = norm(B, i2), nd = norm(B, i);
        const p00 = [A[i][0], ya, A[i][1]], p10 = [A[i2][0], ya, A[i2][1]], p11 = [B[i2][0], yb, B[i2][1]], p01 = [B[i][0], yb, B[i][1]];
        const f00 = [u, ya - STREET, top, s], f10 = [u + L, ya - STREET, top, s], f11 = [u + L, yb - STREET, top, s], f01 = [u, yb - STREET, top, s];
        const want = [(na[0] + nb[0]) / 2, 0, (na[2] + nb[2]) / 2];
        this.tri(p00, p10, p11, na, nb, nc, f00, f10, f11, face, want);
        this.tri(p00, p11, p01, na, nc, nd, f00, f11, f01, face, want);
        u += L;
      }
    }
    if (roof) this.cap(rings[levels], y1, face);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('aFac', new THREE.Float32BufferAttribute(this.F, 4));
    g.setAttribute('aWin', new THREE.Float32BufferAttribute(this.W, 4));
    g.setAttribute('aCol', new THREE.Float32BufferAttribute(this.C, 4));
    g.setAttribute('aGlw', new THREE.Float32BufferAttribute(this.G, 4));
    g.computeBoundingSphere();
    return g;
  }
}

// The emissive geometry: quads, halos, strips, spheres.
class EmBuf {
  constructor() { this.P = []; this.N = []; this.U = []; this.E = []; this.A = []; this.B = []; }
  v(p, n, uv, e, a, b) {
    this.P.push(p[0], p[1], p[2]); this.N.push(n[0], n[1], n[2]); this.U.push(uv[0], uv[1]);
    this.E.push(...e); this.A.push(...a); this.B.push(...b);
  }
  // A flat quad from corner o along edges ex, ey (its face is ex x ey).
  quad(o, ex, ey, e, a, b = [0, 0, 0, 1]) {
    const n = new THREE.Vector3(...ex).cross(new THREE.Vector3(...ey)).normalize().toArray();
    const P = (s, t) => [o[0] + ex[0] * s + ey[0] * t, o[1] + ex[1] * s + ey[1] * t, o[2] + ex[2] * s + ey[2] * t];
    const c = [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]];
    for (const [s, t] of c) this.v(P(s, t), n, [s, t], e, a, b);
  }
  // A halo: four corners at one centre, opened in the vertex shader.
  halo(p, radius, e, anim = 0, phase = 0, b = [0, 0, 0, 1], speed = 0) {
    const c = [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]];
    for (const uv of c) this.v(p, [0, 0, 1], uv, [e[0], e[1], e[2], anim], [radius, speed, phase, 1], b);
  }
  // Any Three geometry, as an emitter.
  geom(g, e, a, b = [0, 0, 0, 1]) {
    const G = g.index ? g.toNonIndexed() : g;
    const p = G.getAttribute('position'), n = G.getAttribute('normal'), uv = G.getAttribute('uv');
    for (let i = 0; i < p.count; i++) {
      this.v([p.getX(i), p.getY(i), p.getZ(i)], n ? [n.getX(i), n.getY(i), n.getZ(i)] : [0, 0, 1], uv ? [uv.getX(i), uv.getY(i)] : [0, 0], e, a, b);
    }
    if (G !== g) G.dispose();
    g.dispose();
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.U, 2));
    g.setAttribute('aEm', new THREE.Float32BufferAttribute(this.E, 4));
    g.setAttribute('aA', new THREE.Float32BufferAttribute(this.A, 4));
    g.setAttribute('aB', new THREE.Float32BufferAttribute(this.B, 4));
    g.computeBoundingSphere();
    return g;
  }
}

const rad = (c, s) => { const x = lin(c, s); return [x.r, x.g, x.b]; };
const rect = (cx, cz, w, d, ry = 0) => {
  const c = Math.cos(ry), s = Math.sin(ry);
  return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([x, z]) => [cx + x * c - z * s, cz + x * s + z * c]);
};
const polar = (azDeg, d) => [d * Math.sin(azDeg * D2R), -d * Math.cos(azDeg * D2R)];

// Wall albedos (linear) by material.
const STONE = [0.075, 0.062, 0.050], GLASSY = [0.030, 0.040, 0.055], CONC = [0.050, 0.050, 0.055];
const PALE = [0.10, 0.10, 0.11], DARK = [0.022, 0.022, 0.028];

// A face description.
function face(seed, o) {
  return {
    seed,
    win: [o.bay || 2.0, o.floor || 3.6, o.kind == null ? 1 : o.kind, o.bias || 0],
    col: [...(o.col || CONC), o.gloss == null ? 1 : o.gloss],
    glw: o.glow ? [o.glow[0], o.glow[1], o.glow[2], o.gk * 1000 + o.gw] : [0, 0, 0, 0]
  };
}

// The water's edge: the channel's half-width at depth z (negative), with a
// slow wobble so the quays are not ruled lines.
const N2 = K.noise2(0x5ea);
function channelW(z) {
  const d = -z;
  if (d < 850) return 0;
  return 150 + 0.17 * (d - 850) + 40 * (N2(d * 0.004, 1.5) - 0.5);
}
function onWater(x, z, margin = 0) { return -z > 850 - margin && -z < 4000 + margin && Math.abs(x) < channelW(z) + margin; }

// --- the archetypes ---------------------------------------------------------------------------

const GOLD = 0xffc27a, CYAN = 0x3fe0ff, MAGENTA = 0xff3fa4, VIOLET = 0x9b5cff, WHITE = 0xeaf2ff, TEAL = 0x3fffc0, RED = 0xff2a1a;

function decoSetback(cb, eb, id, x, z, h, w, r, crownCol, bay = 1.9) {
  const tiers = r() < 0.5 ? [0.56, 0.76, 0.9, 1.0] : [0.62, 0.84, 1.0];
  let ww = w, y = STREET;
  const ry = r.range(-0.2, 0.2);
  tiers.forEach((tf, i) => {
    const y1 = STREET + h * tf;
    const last = i === tiers.length - 1;
    const f = face(id, { kind: 1, bay, floor: 3.6, col: STONE, gloss: 0.7, bias: r.range(-0.05, 0.08),
      glow: last ? rad(crownCol, 3.5) : rad(GOLD, 1.3), gk: last ? 1 : 2, gw: last ? Math.min(36, (y1 - y) * 0.6) : 1.2 });
    cb.prismFlat(rect(x, z, ww, ww * 0.85, ry), y, y1, f);
    y = y1; ww *= 0.78;
  });
  // the chevron crown: a narrow lantern and a mast
  const f = face(id, { kind: 0, col: STONE, glow: rad(crownCol, 4.5), gk: 1, gw: 14 });
  cb.prismFlat(rect(x, z, ww * 0.7, ww * 0.6, ry + Math.PI / 4), y, y + 14, f);
  cb.prismFlat(rect(x, z, 1.4, 1.4, ry), y + 14, y + 38, face(id, { kind: 0, col: PALE }));
  eb.halo([x, y + 38.5, z], 0.9, rad(RED, 9), 1, r());
  return y + 38;
}

function finSlab(cb, eb, id, x, z, h, r, ry, bay = 1.5) {
  const f = face(id, { kind: 4, bay, floor: 3.8, col: GLASSY, gloss: 1.2, bias: r.range(-0.06, 0.06),
    glow: rad(r() < 0.5 ? WHITE : TEAL, 2.6), gk: 2, gw: 1.6 });
  cb.prismFlat(rect(x, z, 50, 25, ry), STREET, STREET + h, f);
  // a plant floor on top, dark, with its own edge light
  cb.prismFlat(rect(x, z, 42, 19, ry), STREET + h, STREET + h + 9, face(id, { kind: 0, col: DARK, glow: rad(WHITE, 1.6), gk: 2, gw: 0.8 }));
  return STREET + h + 9;
}

function steppedPyramid(cb, eb, id, x, z, h, r) {
  let s = r.range(52, 62), y = STREET;
  const ry = r.range(0, Math.PI / 2);
  const steps = [0.55, 0.72, 0.86, 1.0];
  steps.forEach((tf) => {
    const y1 = STREET + h * tf;
    cb.prismFlat(rect(x, z, s, s, ry), y, y1, face(id, { kind: 3, bay: 2.2, floor: 3.4, col: PALE, gloss: 0.8,
      glow: rad(CYAN, 4.0), gk: 2, gw: 1.4 }));
    y = y1; s *= 0.74;
  });
  eb.halo([x, y + 3, z], 0.8, rad(RED, 8), 1, r());
  return y;
}

function twistTower(cb, eb, id, x, z, h, r) {
  const R = 30, levels = 40;
  const tw = 100 * D2R, rot0 = r() * Math.PI;
  const ring = (t) => {
    const out = [];
    const a0 = rot0 + tw * t, rr = R * (1 - 0.18 * t);
    for (let i = 0; i < 18; i++) {
      // a rounded triangle: radius swells at the corners
      const a = a0 + i / 18 * Math.PI * 2;
      const k = 1 + 0.16 * Math.cos(3 * (a - a0));
      out.push([x + Math.cos(a) * rr * k, z + Math.sin(a) * rr * k]);
    }
    return out;
  };
  const perim = 2 * Math.PI * R * 1.02;
  cb.prismSmooth(ring, levels, STREET, STREET + h, face(id, { kind: 1, bay: 2.0, floor: 4.0, col: GLASSY, gloss: 1.3, bias: -0.05,
    glow: rad(MAGENTA, 4.2), gk: 3, gw: perim }), false);
  // the lattice crown
  const top = (t) => ring(1).map(([px, pz]) => [x + (px - x) * (1 - 0.35 * t), z + (pz - z) * (1 - 0.35 * t)]);
  cb.prismSmooth(top, 2, STREET + h, STREET + h + 40, face(id, { kind: 0, col: DARK, glow: rad(VIOLET, 5), gk: 5, gw: 40 }));
  return STREET + h + 40;
}

function ringCylinder(cb, eb, id, x, z, h, r) {
  const R = 20;
  const ring = () => { const o = []; for (let i = 0; i < 24; i++) { const a = i / 24 * Math.PI * 2; o.push([x + Math.cos(a) * R, z + Math.sin(a) * R]); } return o; };
  cb.prismSmooth(ring, 1, STREET, STREET + h, face(id, { kind: 3, bay: 2.1, floor: 3.4, col: PALE, gloss: 0.9,
    glow: rad(WHITE, 3.2), gk: 4, gw: 1 }));
  // the helipad: a ring of lights, and beacons at the rim
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * Math.PI * 2;
    eb.halo([x + Math.cos(a) * 14, STREET + h + 0.6, z + Math.sin(a) * 14], 0.35, rad(i % 3 ? TEAL : WHITE, 6));
  }
  eb.halo([x + R, STREET + h + 2, z], 0.8, rad(RED, 8), 1, r());
  eb.halo([x - R, STREET + h + 2, z], 0.8, rad(RED, 8), 1, r());
  return STREET + h;
}

function landmarkSpire(cb, eb, id, x, z, h) {
  const sec = [[0.0, 0.42, 34], [0.42, 0.64, 28], [0.64, 0.80, 22], [0.80, 0.90, 15], [0.90, 1.0, 9]];
  sec.forEach(([a, b, s], i) => {
    const oct = [];
    for (let k = 0; k < 8; k++) { const ang = (k + 0.5) / 8 * Math.PI * 2; oct.push([x + Math.cos(ang) * s, z + Math.sin(ang) * s]); }
    cb.prismFlat(oct, STREET + h * a, STREET + h * b, face(id, { kind: i < 4 ? 1 : 0, bay: 2.0, floor: 4.2, col: [0.06, 0.065, 0.08], gloss: 1.2,
      bias: 0.05, glow: rad(i === 2 ? GOLD : WHITE, i === 2 ? 3.5 : 2.2), gk: i === 2 ? 1 : 2, gw: i === 2 ? 30 : 1.5 }));
  });
  return STREET + h;
}

function cruciform(cb, id, x, z, h, r) {
  const ry = r.range(0, Math.PI / 2), a = r.range(30, 38), b = r.range(13, 16);
  const f = face(id, { kind: 2, bay: 1.6, floor: 3.0, col: [0.085, 0.08, 0.075], gloss: 0.5, bias: r.range(-0.04, 0.08) });
  cb.prismFlat(rect(x, z, a, b, ry), STREET, STREET + h, f);
  cb.prismFlat(rect(x, z, b, a, ry), STREET, STREET + h - 0.5, f);
  // a rooftop water tank
  cb.prismFlat(rect(x, z, 6, 6, ry), STREET + h, STREET + h + 5, face(id, { kind: 0, col: DARK }));
}

function signagePodium(cb, eb, id, x, z, h, r, ry) {
  const w = r.range(55, 75), d = r.range(40, 55);
  cb.prismFlat(rect(x, z, w, d, ry), STREET, STREET + h, face(id, { kind: 3, bay: 2.4, floor: 4.5, col: DARK, gloss: 0.6, bias: -0.15 }));
  // LED panels on the faces that look at the room, gradients on a slow cycle;
  // blade signs as colour bars.
  const c = Math.cos(ry), s = Math.sin(ry);
  const pairs = [[MAGENTA, VIOLET], [CYAN, 0x3a6bff], [0xff7a3a, MAGENTA], [TEAL, CYAN]];
  const nrm = [[0, 1], [1, 0], [-1, 0]];
  nrm.forEach(([nx0, nz0], j) => {
    const nx = nx0 * c - nz0 * s, nz = nx0 * s + nz0 * c;
    const half = (nx0 !== 0 ? w : d) / 2;
    const px = x + nx * (nx0 !== 0 ? w / 2 : d / 2) * 1.0 + nx * 0.6, pz = z + nz * (nx0 !== 0 ? w / 2 : d / 2) + nz * 0.6;
    const tx = -nz, tz = nx;
    const pw = Math.min(half * 1.4, 40), ph = r.range(16, 26), y0 = STREET + h - ph - r.range(4, 14);
    const [c1, c2] = pairs[(id + j) % pairs.length];
    eb.quad([px + tx * pw / 2, y0, pz + tz * pw / 2], [-tx * pw, 0, -tz * pw], [0, ph, 0],
      [...rad(c1, 2.2), 2], [r.range(30, 40), 0, r(), 0], [...rad(c2, 2.2), 1]);
    // a blade: a narrow vertical bar standing off the corner
    if (j === 0) {
      const bx = px + tx * (pw / 2 + 4), bz = pz + tz * (pw / 2 + 4);
      eb.quad([bx, STREET + h * 0.25, bz], [nx * 3, 0, nz * 3], [0, h * 0.6, 0], [...rad(r() < 0.5 ? 0xff5f3a : CYAN, 3.0), 0], [0, 0, 0, 0]);
      eb.quad([bx, STREET + h * 0.25, bz], [-nx * 3, 0, -nz * 3], [0, h * 0.6, 0], [...rad(r() < 0.5 ? 0xff5f3a : CYAN, 3.0), 0], [0, 0, 0, 0]);
    }
  });
}

function plainBlock(cb, id, x, z, h, w, d, ry, kind, r, lift = 0) {
  cb.prismFlat(rect(x, z, w, d, ry), STREET, STREET + h, face(id, {
    kind, bay: kind === 2 ? 1.7 : 2.2, floor: kind === 2 ? 3.0 : 3.6,
    col: kind === 2 ? [0.08, 0.075, 0.07] : r() < 0.5 ? GLASSY : CONC, gloss: kind === 2 ? 0.5 : 1.0, bias: r.range(-0.08, 0.08) + lift
  }));
}

function buildCity(k, cb, eb) {
  const r = k.rng(0x2041e);
  let id = 1;
  const used = [];
  const free = (x, z, rr) => used.every(([ux, uz, ur]) => Math.hypot(ux - x, uz - z) > ur + rr);
  const take = (x, z, rr) => used.push([x, z, rr]);
  // B0, placed by hand by azimuth (deg, + = key side) and distance.
  {
    // right: a dense residential slab filling the glass by the right wall
    let [x, z] = polar(34, 235);
    plainBlock(cb, id, x, z, 330, 62, 30, 20 * D2R, 2, r);
    cb.prismFlat(rect(x, z, 56, 26, 20 * D2R), STREET + 330, STREET + 342, face(id++, { kind: 0, col: DARK, glow: rad(MAGENTA, 4), gk: 2, gw: 1.2 }));
    eb.halo([x + 25, STREET + 343, z], 0.8, rad(RED, 9), 1, 0.3);
    take(x, z, 50);
    // right, by the corridor: a tall deco tower whose flooded crown climbs into the cloud
    [x, z] = polar(17.5, 330);
    decoSetback(cb, eb, id++, x, z, 372, 46, r, GOLD, 2.6);
    take(x, z, 40);
    // further right, mostly behind the wall
    [x, z] = polar(43, 190);
    plainBlock(cb, id++, x, z, 300, 40, 40, 0.3, 1, r);
    take(x, z, 35);
    // left, by the corridor: a finned office slab rising out of the frame
    [x, z] = polar(-18.5, 300);
    finSlab(cb, eb, id++, x, z, 395, r, 0.25, 3.0);
    take(x, z, 40);
    // the far left edge: a dark deco tower, partly behind the wall
    [x, z] = polar(-35, 205);
    decoSetback(cb, eb, id++, x, z, 290, 40, r, GOLD, 2.4);
    take(x, z, 35);
    [x, z] = polar(-47, 175);
    plainBlock(cb, id++, x, z, 260, 36, 36, 0.6, 1, r);
    take(x, z, 30);
    // and the camera's own neighbours, below the sill
    take(0, -60, 120);
  }
  // Landmarks in B1.
  {
    let [x, z] = polar(-26.5, 1150);
    landmarkSpire(cb, eb, id++, x, z, 520);
    take(x, z, 45);
    [x, z] = polar(-22.0, 780);
    steppedPyramid(cb, eb, id++, x, z, 250, r);
    take(x, z, 45);
    [x, z] = polar(23.2, 1450);
    twistTower(cb, eb, id++, x, z, 430, r);
    take(x, z, 45);
    [x, z] = polar(21.0, 640);
    ringCylinder(cb, eb, id++, x, z, 205, r);
    take(x, z, 30);
    [x, z] = polar(14.8, 820);
    signagePodium(cb, eb, id++, x, z, 95, r, -14.8 * D2R);
    take(x, z, 45);
    [x, z] = polar(27.5, 560);
    signagePodium(cb, eb, id++, x, z, 80, r, -27 * D2R);
    take(x, z, 45);
    [x, z] = polar(-31, 640);
    decoSetback(cb, eb, id++, x, z, 240, 38, r, GOLD);
    take(x, z, 35);
  }
  // B1: 0.4-1.3 km, both banks. Left is the business district (taller,
  // offices, slabs), right is residential (clusters, signage, hotels).
  for (let n = 0, tries = 0; n < 80 && tries < 4000; tries++) {
    const left = r() < 0.5;
    const az = (left ? -1 : 1) * (11.5 + Math.pow(r(), 1.4) * 36);
    const d = r.range(420, 1300);
    const [x, z] = polar(az, d);
    if (onWater(x, z, 45)) continue;
    const near = Math.abs(az) < 16 ? 0.55 : 1;   // lower by the water: the corridor stays open
    if (left) {
      const pick = r();
      if (pick < 0.25 && free(x, z, 32)) { finSlab(cb, eb, id++, x, z, near * r.range(150, 260), r, r.range(-0.4, 0.4)); take(x, z, 32); n++; }
      else if (pick < 0.40 && free(x, z, 36)) { decoSetback(cb, eb, id++, x, z, near * r.range(170, 290), r.range(32, 42), r, r() < 0.7 ? GOLD : TEAL); take(x, z, 34); n++; }
      else if (pick < 0.48 && free(x, z, 40)) { steppedPyramid(cb, eb, id++, x, z, near * r.range(200, 270), r); take(x, z, 40); n++; }
      else if (free(x, z, 26)) { plainBlock(cb, id++, x, z, near * r.range(90, 230), r.range(30, 48), r.range(26, 40), r.range(-0.5, 0.5), r() < 0.7 ? 1 : 3, r); take(x, z, 26); n++; }
    } else {
      const pick = r();
      if (pick < 0.38 && free(x, z, 48)) {
        const m = r.int(4, 7);
        for (let i = 0; i < m; i++) {
          const ox = x + r.range(-38, 38), oz = z + r.range(-38, 38);
          if (onWater(ox, oz, 30)) continue;
          cruciform(cb, id++, ox, oz, near * r.range(90, 135), r);
        }
        take(x, z, 50); n++;
      } else if (pick < 0.50 && free(x, z, 40)) { signagePodium(cb, eb, id++, x, z, r.range(60, 120), r, -az * D2R); take(x, z, 40); n++; }
      else if (pick < 0.58 && free(x, z, 24)) { ringCylinder(cb, eb, id++, x, z, near * r.range(160, 240), r); take(x, z, 24); n++; }
      else if (pick < 0.68 && free(x, z, 34)) { decoSetback(cb, eb, id++, x, z, near * r.range(170, 270), r.range(30, 40), r, r() < 0.5 ? MAGENTA : GOLD); take(x, z, 32); n++; }
      else if (free(x, z, 26)) { plainBlock(cb, id++, x, z, near * r.range(80, 200), r.range(26, 44), r.range(20, 34), r.range(-0.5, 0.5), r() < 0.6 ? 2 : 3, r); take(x, z, 26); n++; }
    }
  }
  // B2: 1.3-4.2 km, impostors across the water, the far shore low and dense.
  for (let n = 0, tries = 0; n < 260 && tries < 5000; tries++) {
    const az = (r() < 0.5 ? -1 : 1) * Math.pow(r(), 1.6) * 60;
    const d = r.range(1300, 4300);
    const [x, z] = polar(az, d);
    if (onWater(x, z, 30)) continue;
    const farShore = -z > 3900;
    const h = farShore ? r.range(22, 90) : r.range(60, 240) * (Math.abs(az) < 14 ? 0.6 : 1);
    const w = r.range(30, 70);
    if (!free(x, z, w * 0.5)) continue;
    plainBlock(cb, id++, x, z, h, w, r.range(25, 60), r.range(-0.5, 0.5), r() < 0.55 ? 2 : 1, r, farShore ? 0.25 : 0);
    take(x, z, w * 0.5); n++;
  }
  return id;
}

// The streets and the water, as strips down the channel's edges.
function buildGround(cb) {
  const fStreet = face(0, { kind: 6, col: [0.02, 0.02, 0.024], gloss: 0.6 });
  const fWater = face(0, { kind: 7, col: [0.010, 0.022, 0.030], gloss: 1 });
  const X = 9000;
  const up = [0, 1, 0];
  const f0 = [0, 0, 0, 0];
  const quad = (x0, z0, x1, z1, x2, z2, x3, z3, y, f) => {
    cb.tri([x0, y, z0], [x1, y, z1], [x2, y, z2], up, up, up, f0, f0, f0, f, up);
    cb.tri([x0, y, z0], [x2, y, z2], [x3, y, z3], up, up, up, f0, f0, f0, f, up);
  };
  // land in front of the water and behind it
  quad(-X, 0, X, 0, X, -850, -X, -850, STREET, fStreet);
  quad(-X, -4000, X, -4000, X, -9000, -X, -9000, STREET, fStreet);
  for (let z = -850; z > -4000; z -= 50) {
    const z2 = Math.max(z - 50, -4000);
    const w1 = channelW(z), w2 = channelW(z2);
    quad(-X, z, -w1, z, -w2, z2, -X, z2, STREET, fStreet);
    quad(w1, z, X, z, X, z2, w2, z2, STREET, fStreet);
    quad(-w1, z, w1, z, w2, z2, -w2, z2, SEA, fWater);
    // the quay walls
    const fq = face(0, { kind: 0, col: [0.04, 0.04, 0.045] });
    cb.wall([-w1, z], [-w2, z2], SEA, STREET, normal2(-w1, z, -w2, z2, 1), fq);
    cb.wall([w1, z], [w2, z2], SEA, STREET, normal2(w1, z, w2, z2, -1), fq);
  }
  const wf = channelW(-4000);
  cb.wall([-wf, -4000], [wf, -4000], SEA, STREET, [0, 0, 1], face(0, { kind: 0, col: [0.04, 0.04, 0.045] }));
}
function normal2(ax, az, bx, bz, sgn) {
  let nx = bz - az, nz = -(bx - ax);
  const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l;
  if (nx * sgn < 0) { nx = -nx; nz = -nz; }
  return [nx, 0, nz];
}

// Piers and moored ferries in the harbour, lit steadily.
function buildHarbour(k, cb, eb) {
  const r = k.rng(0xfe44);
  [[-1, 1350], [1, 1650], [-1, 2300], [1, 2900]].forEach(([s, d], i) => {
    const z = -d, w = channelW(z);
    const x0 = s * w, len = r.range(110, 170);
    const x1 = x0 - s * len;
    cb.prismFlat(rect((x0 + x1) / 2, z, len, 14, 0), SEA, SEA + 4, face(500 + i, { kind: 0, col: [0.05, 0.05, 0.055] }));
    for (let j = 0; j < 6; j++) eb.halo([x0 + (x1 - x0) * (j + 0.5) / 6, SEA + 6, z], 0.6, rad(0xffb070, 5));
    // a ferry alongside, its cabin a band of light
    const fx = x0 + (x1 - x0) * 0.6, fz = z - 16;
    cb.prismFlat(rect(fx, fz, 62, 12, 0), SEA, SEA + 5, face(510 + i, { kind: 0, col: [0.09, 0.09, 0.1], glow: rad(0xffe0b0, 2.5), gk: 2, gw: 1.2 }));
    cb.prismFlat(rect(fx, fz, 40, 9, 0), SEA + 5, SEA + 9, face(520 + i, { kind: 3, bay: 2.0, floor: 4.0, col: [0.1, 0.1, 0.11], bias: 0.3 }));
    eb.halo([fx + 25, SEA + 12, fz], 0.5, rad(0x3fff7a, 5));
    eb.halo([fx - 25, SEA + 12, fz], 0.5, rad(RED, 5));
  });
}

// The ridge across the bay, into the cloud.
function buildRidge(k) {
  const n = K.noise2(0x11d6e);
  const g = K.heightfield({
    x0: -9000, x1: 9000, z0: -8200, z1: -5200, nx: 140, nz: 16,
    height: (x, z) => {
      const t = (z + 8200) / 3000;           // 0 back .. 1 front
      const ridge = n.ridged(x * 0.00035, 0.5, 4);
      const peak = Math.exp(-Math.pow((x + 1400) / 1900, 2)) * 0.6;   // a Lion Rock shoulder off to the left
      const hgt = (180 + 330 * ridge + 380 * peak) * Math.sin(Math.PI * Math.min(1, t * 1.3));
      return SEA + Math.max(0, hgt) - 8;
    }
  }).toNonIndexed();
  const cnt = g.getAttribute('position').count;
  const fill = (v) => { const a = new Float32Array(cnt * 4); for (let i = 0; i < cnt; i++) a.set(v, i * 4); return a; };
  g.setAttribute('aFac', new THREE.BufferAttribute(fill([0, 0, 0, 0]), 4));
  g.setAttribute('aWin', new THREE.BufferAttribute(fill([1, 1, 8, 0]), 4));
  g.setAttribute('aCol', new THREE.BufferAttribute(fill([0.03, 0.028, 0.035, 0]), 4));
  g.setAttribute('aGlw', new THREE.BufferAttribute(fill([0, 0, 0, 0]), 4));
  g.deleteAttribute('uv');
  return g;
}

// Air-cars: a few slow lights crossing the upper sides.
function buildMovers(eb) {
  const cars = [
    { p: polar(-30, 520), y: 95, dir: [0.92, 0.0, 0.39], len: 900, v: 9, c: 0xffe6c0, ph: 120 },
    { p: polar(33, 600), y: 120, dir: [-0.85, 0.05, 0.52], len: 1100, v: 7, c: 0x9fd8ff, ph: 420 },
    { p: polar(-38, 760), y: 140, dir: [0.6, 0.0, -0.8], len: 1300, v: 11, c: 0xff8a9a, ph: 800 }
  ];
  cars.forEach((c) => {
    const p = [c.p[0], c.y, c.p[1]];
    eb.halo(p, 0.9, rad(c.c, 6), 3, c.ph, [...c.dir, c.len], c.v);
    eb.halo([p[0] - c.dir[0] * 6, p[1] - 0.8, p[2] - c.dir[2] * 6], 0.6, rad(RED, 3), 3, c.ph, [...c.dir, c.len], c.v);
  });
}

// --- the room ----------------------------------------------------------------------------------

function roomPatch(sheen) {
  return {
    key: 'room',
    uniforms: { uSheen: { value: new THREE.Vector4(...sheen) } },
    fragmentHead: 'uniform vec4 uSheen;\n',
    fragmentBefore: {
      opaque_fragment: `{
  float ndvS = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
  outgoingLight += uSheen.rgb * pow(1.0 - ndvS, 3.0) * uSheen.a;
}`
    }
  };
}

function buildRoom(k, st) {
  const S = k.scene;
  const sheen0 = [0, 0, 0, 0];
  const mk = (o, sheen = sheen0) => k.std(Object.assign({ patch: roomPatch(sheen) }, o));
  const plaster = mk({ color: 0x1a1a22, roughness: 0.92, metalness: 0 });
  const concrete = mk({ color: 0x2a2a30, roughness: 0.85, metalness: 0 });
  const dark = mk({ color: 0x0c0c10, roughness: 0.7, metalness: 0 });
  const velvet = mk({ color: 0x2e1430, roughness: 0.9, metalness: 0, receiver: 0.6 }, [0.16, 0.07, 0.18, 1]);
  const brass = mk({ color: 0xb0884e, roughness: 0.35, metalness: 1, receiver: 0.6 });
  const bronze = mk({ color: 0x4a3a2a, roughness: 0.42, metalness: 1 });
  const blackMetal = mk({ color: 0x111114, roughness: 0.45, metalness: 1, receiver: 0.6 });
  st.velvet = velvet;
  const add = (g, m) => { const o = new THREE.Mesh(g, m); S.add(o); return o; };
  const box = (w, h, d, x, y, z) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return g; };
  const H = CEIL - FLOOR;
  // walls and ceiling: left, right, back
  add(K.merge([
    box(0.2, H, BACKZ - GZ + 0.4, -SIDE - 0.1, FLOOR + H / 2, (BACKZ + GZ) / 2),
    box(0.2, H, BACKZ - GZ + 0.4, SIDE + 0.1, FLOOR + H / 2, (BACKZ + GZ) / 2),
    box(2 * SIDE + 0.4, H, 0.2, 0, FLOOR + H / 2, BACKZ + 0.1)
  ]), plaster);
  // the coffered ceiling: a slab and a grid of deep beams
  const cof = [box(2 * SIDE, 0.2, BACKZ - GZ, 0, CEIL + 0.1, (BACKZ + GZ) / 2)];
  for (let x = -SIDE + 1.2; x < SIDE - 0.2; x += 1.24) cof.push(box(0.14, 0.26, BACKZ - GZ, x, CEIL - 0.13, (BACKZ + GZ) / 2));
  for (let z = GZ + 1.0; z < BACKZ; z += 1.24) cof.push(box(2 * SIDE, 0.26, 0.14, 0, CEIL - 0.13, z));
  add(K.merge(cof), concrete);
  // the sill upstand under the glass, and the glass's bronze frame and posts
  add(box(2 * SIDE, SILL - FLOOR, 0.28, 0, (SILL + FLOOR) / 2, GZ + 0.14), concrete);
  add(K.merge([
    box(0.08, CEIL - SILL, 0.12, -POST_X, (CEIL + SILL) / 2, GZ + 0.04),
    box(0.08, CEIL - SILL, 0.12, POST_X, (CEIL + SILL) / 2, GZ + 0.04),
    box(0.06, CEIL - SILL, 0.10, -SIDE + 0.03, (CEIL + SILL) / 2, GZ + 0.04),
    box(0.06, CEIL - SILL, 0.10, SIDE - 0.03, (CEIL + SILL) / 2, GZ + 0.04),
    box(2 * SIDE, 0.05, 0.10, 0, SILL + 0.025, GZ + 0.04),
    box(2 * SIDE, 0.07, 0.10, 0, CEIL - 0.035, GZ + 0.04)
  ]), bronze);
  // the strips' channels in the side walls
  add(K.merge([
    box(0.025, H, 0.10, -SIDE + 0.0125, FLOOR + H / 2, -4.2),
    box(0.025, H, 0.10, SIDE - 0.0125, FLOOR + H / 2, -4.2)
  ]), dark);

  // the sofa: aubergine velvet, back to the glass, on a floating plinth
  const SX = -1.72, SZ = -3.92, PL = 0.13;
  const RB = THREE.RoundedBoxGeometry;
  const rb = (w, h, d, x, y, z, r = 0.05) => { const g = new RB(w, h, d, 3, r); g.translate(x, y, z); return g.toNonIndexed(); };
  const sy = FLOOR + PL + 0.02;
  add(K.merge([
    rb(2.4, 0.22, 0.92, SX, sy + 0.11, SZ, 0.06),
    rb(2.24, 0.36, 0.22, SX, sy + 0.22 + 0.16, SZ - 0.35, 0.08),
    rb(0.2, 0.28, 0.92, SX - 1.1, sy + 0.22 + 0.06, SZ, 0.07),
    rb(0.2, 0.28, 0.92, SX + 1.1, sy + 0.22 + 0.06, SZ, 0.07),
    rb(0.66, 0.12, 0.66, SX - 0.68, sy + 0.28, SZ + 0.08, 0.05),
    rb(0.66, 0.12, 0.66, SX, sy + 0.28, SZ + 0.08, 0.05),
    rb(0.66, 0.12, 0.66, SX + 0.68, sy + 0.28, SZ + 0.08, 0.05)
  ]), velvet);
  add(box(2.7, 0.11, 1.2, SX, FLOOR + 0.045 + 0.055, SZ), concrete);
  add(box(2.4, 0.05, 0.95, SX, FLOOR + 0.025, SZ), dark);
  // the table: smoked glass on a black frame
  const TX = -1.18, TZ = -2.82, TY = FLOOR + 0.40;
  add(K.merge([
    box(0.02, 0.38, 0.02, TX - 0.56, FLOOR + 0.19, TZ - 0.28), box(0.02, 0.38, 0.02, TX + 0.56, FLOOR + 0.19, TZ - 0.28),
    box(0.02, 0.38, 0.02, TX - 0.56, FLOOR + 0.19, TZ + 0.28), box(0.02, 0.38, 0.02, TX + 0.56, FLOOR + 0.19, TZ + 0.28),
    box(1.14, 0.02, 0.02, TX, FLOOR + 0.04, TZ - 0.28), box(1.14, 0.02, 0.02, TX, FLOOR + 0.04, TZ + 0.28)
  ]), blackMetal);
  const smoked = k.std({ color: 0x0b0a0e, roughness: 0.06, metalness: 0.2, transparent: true, opacity: 0.72, depthWrite: false });
  const top = add(box(1.2, 0.018, 0.62, TX, TY, TZ), smoked);
  top.renderOrder = 5;
  // the arc lamp: a brass stem rising, an arc, the opal globe hanging
  const LX = 2.52, LZ = -3.58;
  const GLOBE = new THREE.Vector3(1.90, 0.40, LZ);
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(LX, FLOOR + 0.04, LZ), new THREE.Vector3(LX, 0.2, LZ), new THREE.Vector3(LX - 0.04, 0.78, LZ),
    new THREE.Vector3(LX - 0.22, 1.02, LZ), new THREE.Vector3(GLOBE.x + 0.12, 0.95, LZ), new THREE.Vector3(GLOBE.x, GLOBE.y + 0.32, LZ)
  ]);
  add(K.merge([
    new THREE.TubeGeometry(curve, 48, 0.011, 6, false).toNonIndexed(),
    (() => { const g = new THREE.CylinderGeometry(0.19, 0.2, 0.035, 32); g.translate(LX, FLOOR + 0.0175, LZ); return g.toNonIndexed(); })(),
    (() => { const g = new THREE.CylinderGeometry(0.02, 0.02, 0.2, 8); g.translate(GLOBE.x, GLOBE.y + 0.21, LZ); return g.toNonIndexed(); })()
  ].map((g) => { g.deleteAttribute('uv'); return g; })), brass);
  st.globe = GLOBE;
  return { plaster, concrete, bronze, brass, velvet };
}

// --- the scene ---------------------------------------------------------------------------------

export default {
  id: 'penthouse',
  camera: { pos: [0, 0, 0], target: [0, -Math.tan(0.09) * 10, -10], fov: 50, near: 0.25, far: 9000 },
  nearness: [1.2, 11.0],

  build(k) {
    const st = {};
    const S = k.scene;
    // Uniforms every world shader shares (one object each: an update reaches all).
    const A = {
      uDeckTop: { value: new THREE.Color() }, uDeckLow: { value: new THREE.Color() }, uDeckHor: { value: new THREE.Color() },
      uHazeL: { value: new THREE.Color() }, uHazeR: { value: new THREE.Color() }, uHazeC: { value: new THREE.Color() },
      uHazeLow: { value: new THREE.Color() },
      uFlashCol: { value: new THREE.Color() }, uFlash: { value: 0 }, uFlashDir: { value: new THREE.Vector3(0.5, 0.2, -0.8).normalize() },
      uLit: { value: new THREE.Vector3(1, 1, 1) }
    };
    st.A = A;
    // The art direction: the blue hour (bright room) and 01:00 (dark room),
    // as display colours of the deck and the air.
    st.pal = {
      deckTop: [shown(0x24264a), shown(0x120e1e, NK)],
      deckLow: [shown(0x2c2f5c), shown(0x3a2440, NK)],
      deckHor: [shown(0x3a3462), shown(0x4a2a4a, NK)],
      hazeL: [shown(0x2a1f48).multiplyScalar(0.55), shown(0x2c1840, NK).multiplyScalar(0.55)],
      hazeR: [shown(0x4a2050).multiplyScalar(0.6), shown(0x4a1840, NK).multiplyScalar(0.65)],
      hazeC: [shown(0x24506a).multiplyScalar(0.7), shown(0x1a4258, NK).multiplyScalar(0.75)],
      hazeLow: [shown(0x5a3420).multiplyScalar(0.8), shown(0x6a3418, NK).multiplyScalar(0.9)],
      ambUp: [shown(0x2a2c4a).multiplyScalar(0.9), shown(0x1a1426, NK).multiplyScalar(0.9)],
      ambLow: [shown(0x6a4a3a), shown(0x6a3a30, NK)]
    };

    // --- sky: the storm deck
    const skyO = {
      zenith: 0x2a2f5a, horizon: 0x5a4470, ground: 0x3a2a30,
      zenithNight: 0x120e1e, horizonNight: 0x4a2a4a, groundNight: 0x2a1a22,
      sunDir: [0.0, 0.2, -1.0], sunIntensity: 0, disc: 0, haze: 0.6,
      fragmentHead: ATMOS + 'uniform vec3 uBeacon; uniform vec3 uBeaconCol;\n', fragment: SKY_FRAG
    };
    const sky = K.sky(k, skyO);
    const spire = polar(-26.5, 1150);
    Object.assign(sky.mesh.material.uniforms, A, {
      uBeacon: { value: new THREE.Vector3(spire[0], DECK + 20, spire[1]).normalize() },
      uBeaconCol: { value: lin(0xffb090, 0.8) }
    });
    st.sky = sky;
    st.env = K.envFollower(k, skyO, 0.25, 1);
    st.env(0);   // before compile(): the room's programs are built with their environment

    // --- the city, the ground, the harbour, the ridge: one draw
    const cb = new CityBuf(), eb = new EmBuf();
    buildCity(k, cb, eb);
    buildGround(cb);
    buildHarbour(k, cb, eb);
    buildMovers(eb);
    const cityG = K.merge([cb.geometry(), buildRidge(k)]);
    const cityU = Object.assign({}, A, {
      uWinK: { value: new THREE.Vector4(1, 1.6, 0.55, 0.45) },
      uWarm: { value: lin(0xffc48a) }, uNeutral: { value: lin(0xffe6c8) }, uCool: { value: lin(0xa9c8ff) },
      uAccA: { value: lin(0x7fa8ff) }, uAccB: { value: lin(0xff5fd2) },
      uSodium: { value: lin(0xff9a3c, 0.55) }, uLed: { value: lin(0xe8f0ff, 0.6) },
      uAmbUp: { value: new THREE.Color() }, uAmbLow: { value: new THREE.Color() }
    });
    st.cityU = cityU;
    const cityM = k.shader({
      uniforms: cityU,
      vertexShader: k.GLSL_VERTEX + CITY_DECL + CITY_VERT,
      fragmentShader: k.GLSL_FRAGMENT + CITY_DECL + ATMOS + CITY_FRAG
    });
    const city = new THREE.Mesh(cityG, cityM);
    city.frustumCulled = false;
    S.add(city);

    // --- emissive things: one program, two materials
    const emU = (add) => Object.assign({}, A, { uAdd: { value: add ? 1 : 0 }, uGhostZ: { value: GZ + 0.03 }, uFloorY: { value: FLOOR + 0.002 }, uGhostBox: { value: new THREE.Vector4(-SIDE + 0.06, SIDE - 0.06, SILL + 0.03, CEIL - 0.07) } });
    const emOpaque = k.shader({ uniforms: emU(false), vertexShader: k.GLSL_VERTEX + EM_DECL + EM_VERT, fragmentShader: k.GLSL_FRAGMENT + EM_DECL + ATMOS + EM_FRAG });
    const emAdd = k.shader({ uniforms: emU(true), transparent: true, additive: true, depthWrite: false,
      vertexShader: k.GLSL_VERTEX + EM_DECL + EM_VERT, fragmentShader: k.GLSL_FRAGMENT + EM_DECL + ATMOS + EM_FRAG });
    st.emAdd = emAdd;

    // The room's lights: the strips, the cove, the sill, the plinth's underglow, the globe.
    buildRoom(k, st);
    const emRoom = new EmBuf();
    const CYANS = lin(0x3fe0ff, 14), MAGS = lin(0xff3fa4, 14);
    const H = CEIL - FLOOR;
    // the wall strips: a 3 cm LED in each channel
    const strip = (x, c) => {
      const g = new THREE.BoxGeometry(0.02, H - 0.02, 0.035); g.translate(x + Math.sign(x) * -0.025, FLOOR + H / 2, -4.2);
      emRoom.geom(g, [c.r, c.g, c.b, 0], [0, 0, 0, 0]);
    };
    strip(-SIDE + 0.02, CYANS); strip(SIDE - 0.02, MAGS);
    // the cove at the glass head
    { const g = new THREE.BoxGeometry(2 * SIDE - 0.1, 0.02, 0.03); g.translate(0, CEIL - 0.09, GZ + 0.2); const c = lin(0x3fe0ff, 6); emRoom.geom(g, [c.r, c.g, c.b, 0], [0, 0, 0, 0]); }
    // the sill strip, in segments dimmed toward the middle (it runs under a chin)
    for (let i = 0; i < 24; i++) {
      const x0 = -SIDE + 0.08 + i * (2 * SIDE - 0.16) / 24, w = (2 * SIDE - 0.16) / 24;
      const xm = x0 + w / 2;
      const k0 = 0.12 + 0.88 * sstep(0.5, 2.3, Math.abs(xm));
      const g = new THREE.BoxGeometry(w, 0.012, 0.012); g.translate(xm, SILL + 0.07, GZ + 0.27);
      const c = lin(0x3fe0ff, 5 * k0);
      emRoom.geom(g, [c.r, c.g, c.b, 0], [0, 0, 0, 0]);
    }
    // the plinth's underglow
    {
      const c = lin(0x9b5cff, 0.7);
      const g1 = new THREE.BoxGeometry(2.5, 0.012, 0.012); g1.translate(-1.72, FLOOR + 0.04, -3.92 + 0.48);
      emRoom.geom(g1, [c.r, c.g, c.b, 0], [0, 0, 0, 0]);
    }
    // the opal globe
    {
      const g = new THREE.SphereGeometry(0.095, 32, 16); g.translate(st.globe.x, st.globe.y, st.globe.z);
      const c = lin(0xffdcb4, 2.3);
      emRoom.geom(g, [c.r, c.g, c.b, 0], [0, 0, 0, 5]);
    }
    const roomGlow = new THREE.Mesh(emRoom.geometry(), emOpaque);
    S.add(roomGlow);
    st.roomGlowGeo = roomGlow.geometry;

    // Washes and halos in the room, additive: light on the walls by the
    // strips, the cove on the ceiling, the underglow's pool, the globe's halo.
    {
      const W = new EmBuf();
      const cw = lin(0x3fe0ff, 0.12), mw = lin(0xff3fa4, 0.12);
      W.quad([-SIDE + 0.004, FLOOR, -4.2 + 0.7], [0, 0, -1.2], [0, H, 0], [cw.r, cw.g, cw.b, 0], [0, 0, 0, 4]);
      W.quad([SIDE - 0.004, FLOOR, -4.2 - 0.7], [0, 0, 1.2], [0, H, 0], [mw.r, mw.g, mw.b, 0], [0, 0, 0, 4]);
      const cc = lin(0x3fe0ff, 0.25);
      W.quad([-SIDE, CEIL - 0.004, GZ + 0.25], [2 * SIDE, 0, 0], [0, 0, 1.6], [cc.r, cc.g, cc.b, 0], [0, 0, 0, 3]);
      const pc = lin(0x9b5cff, 0.16);
      W.quad([-1.72 - 1.9, FLOOR + 0.003, -3.92 + 1.15], [3.8, 0, 0], [0, 0, -1.9], [pc.r, pc.g, pc.b, 0], [0, 0, 0, 4]);
      // the strips and the globe in the polished floor: mirrored, drawn on it
      const fr = (x, c) => {
        const y0 = FLOOR, y1 = FLOOR - H, w0 = 0.05, w1 = 0.5;
        // a trapezoid, narrow where the strip meets the floor, wider and fainter away from it
        const q = [[x - w0 / 2, y0], [x + w0 / 2, y0], [x + w1 / 2, y1], [x - w1 / 2, y1]];
        const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
        const e = [c.r, c.g, c.b, 0], a = [0, 0, 0, 6], b = [0, 0, 0, 1];
        for (const i of [0, 2, 1, 0, 3, 2]) W.v([q[i][0], q[i][1], -4.2], [0, 0, 1], uvs[i], e, a, b);
      };
      fr(-SIDE + 0.06, lin(0x3fe0ff, 2.6));
      fr(SIDE - 0.06, lin(0xff3fa4, 2.6));
      {
        const gy = 2 * FLOOR - st.globe.y, c = lin(0xffd2a0, 0.7);
        W.quad([st.globe.x - 0.22, gy - 0.9, st.globe.z], [0.44, 0, 0], [0, 1.4, 0], [c.r, c.g, c.b, 0], [0, 0, 0, 7]);
      }
      const gc = lin(0xffd9a8, 0.35);
      W.halo([st.globe.x, st.globe.y, st.globe.z], 0.45, [gc.r, gc.g, gc.b], 4, 0.1);
      const m = new THREE.Mesh(W.geometry(), emAdd);
      m.renderOrder = 30;
      m.frustumCulled = false;
      S.add(m);
      st.washes = m;
    }
    // Ghosts in the glass: the strips and the globe, mirrored in the pane
    // (placed where the mirror image is, drawn on the glass), faint and soft.
    {
      const G = new EmBuf();
      const gz = 2 * GZ + 4.2;
      const cs = lin(0x3fe0ff, 0.16), ms = lin(0xff3fa4, 0.16);
      G.quad([-SIDE + 0.07, SILL, gz], [0.06, 0, 0], [0, CEIL - SILL, 0], [cs.r, cs.g, cs.b, 0], [0, 0, 0, 2]);
      G.quad([SIDE - 0.13, SILL, gz], [0.06, 0, 0], [0, CEIL - SILL, 0], [ms.r, ms.g, ms.b, 0], [0, 0, 0, 2]);
      const gc = lin(0xffd9a8, 0.10);
      const gp = [st.globe.x, st.globe.y, 2 * GZ - st.globe.z];
      G.halo(gp, 0.16, [gc.r, gc.g, gc.b], 0, 0);
      const m = new THREE.Mesh(G.geometry(), emAdd);
      m.renderOrder = 22;
      m.frustumCulled = false;
      S.add(m);
    }
    // The city's own lights (signage, beacons, piers, air-cars).
    const cityLights = new THREE.Mesh(eb.geometry(), emAdd);
    cityLights.renderOrder = 8;
    cityLights.frustumCulled = false;
    S.add(cityLights);

    // --- the floor: terrazzo polished to a mirror
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(2 * SIDE, BACKZ - GZ));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, FLOOR, (BACKZ + GZ) / 2);
    S.add(floor);

    // --- rain, outside: near (3-15 m) and mid (15-60 m)
    const rainNear = K.rain(k, { count: 800, box: [-18, 18, -7, 12, -20, -7.6], speed: 9, slant: 0.42, width: 0.022, length: 0.045,
      color: 0xc0cce6, opacity: 1.0, seed: 11, calm: 0.7, near: 2.5, far: 24 });
    const rainMid = K.rain(k, { count: 1000, box: [-55, 55, -22, 30, -62, -20], speed: 10, slant: 0.42, width: 0.06, length: 0.04,
      color: 0xb0bce0, opacity: 0.4, seed: 23, calm: 0.7, near: 10, far: 70 });
    st.rain = [rainNear, rainMid];

    // --- the glass, and the water on it
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(2 * SIDE, CEIL - SILL), K.glass(k, { tint: 0x8a96a8, opacity: 0.05, env: 0.6 }));
    pane.position.set(0, (CEIL + SILL) / 2, GZ);
    pane.renderOrder = 20;
    S.add(pane);
    const dropU = Object.assign({}, A, {
      uDrops: { value: new THREE.Vector4(1, 0.7, 0.6, 0) },
      uRoomL: { value: lin(0x3fe0ff, 0.6) }, uRoomR: { value: lin(0xff3fa4, 0.6) }, uLampC: { value: lin(0xfff0dc, 2.2) }
    });
    st.dropU = dropU;
    const drops = new THREE.Mesh(new THREE.PlaneGeometry(2 * SIDE - 0.1, CEIL - SILL - 0.06), k.shader({
      uniforms: dropU, transparent: true, depthWrite: false,
      head: '', fragmentHead: ATMOS + DROP_FRAG.replace(/void main\(\)[\s\S]*$/, ''),
      fragment: DROP_FRAG.replace(/^[\s\S]*void main\(\) \{/, '').replace(/\}\s*$/, '')
    }));
    drops.position.set(0, (CEIL + SILL) / 2, GZ - 0.004);
    drops.renderOrder = 21;
    S.add(drops);

    // The mirror: the floor reflects the room and the city; the rain, the
    // water on the glass and the moving lights are left out (it is redrawn
    // every other redraw, and what moves would step).
    st.mirror = K.mirrorMaterial(k, floor, {
      material: { color: 0x15141a, roughness: 0.1, metalness: 0 },
      blur: 1.2, strength: 2.4, every: 2, hide: [rainNear.mesh, rainMid.mesh, drops, cityLights, st.washes],
      fragmentHead: `
float tzChip(vec2 p, float fw) {
  vec2 g = p / 0.028;
  vec2 id = floor(g), f = fract(g) - 0.5;
  vec2 h = hash22(id);
  float r = 0.18 + 0.22 * h.x;
  float d = length(f - (h - 0.5) * 0.4);
  float aa = fw / 0.028 + 0.02;
  float chip = 1.0 - smoothstep(r - aa, r + aa, d);
  float keep = step(0.45, h.y);
  float far = smoothstep(0.2, 0.8, fw / 0.028);
  return mix(chip * keep * (0.5 + h.y), 0.11, far);
}
`,
      fragment: {
        color_fragment: `{
  float fwc = max(fwidth(vWorld.x), fwidth(vWorld.z)) * uBufH / max(uDetail, 1.0);
  float ch = tzChip(vWorld.xz, fwc);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.20, 0.19, 0.19), ch * 0.6);
}`,
        roughnessmap_fragment: 'roughnessFactor = 0.05 + 0.08 * vnoise(vWorld.xz * 1.4);'
      }
    });
    st.floor = floor;

    // --- the room's lights (scaled per redraw: see update())
    const lamp = new THREE.PointLight(0xffd2a0, 1, 9, 2);
    lamp.position.copy(st.globe);
    S.add(lamp);
    const cyanL = new THREE.PointLight(0x3fe0ff, 1, 7, 2); cyanL.position.set(-SIDE + 0.25, 0.3, -4.2); S.add(cyanL);
    const magL = new THREE.PointLight(0xff3fa4, 1, 7, 2); magL.position.set(SIDE - 0.25, 0.3, -4.2); S.add(magL);
    const under = new THREE.PointLight(0x9b5cff, 1, 2.6, 2); under.position.set(-1.72, FLOOR + 0.05, -3.3); S.add(under);
    const flashL = new THREE.DirectionalLight(0xc8d8ff, 0); flashL.position.set(0.3, 1.0, -1.2); S.add(flashL);
    st.lights = { lamp, cyanL, magL, under, flashL };
    st.flashDir = new THREE.Vector3();
    st.litC = new THREE.Color();
    st.cityLights = cityLights;
    return st;
  },

  update(k, st, t, look) {
    const night = look.night;
    const E = look.exposure;
    const em = 0.65 + 0.35 * E, comp = em / E;
    const tint = look.tint || [1, 1, 1];
    const A = st.A;
    // The world's light, compensated for the exposure (the night is designed,
    // not dimmed) and half for the room's cast (a warm room still warms it).
    A.uLit.value.set(comp / Math.sqrt(tint[0]), comp / Math.sqrt(tint[1]), comp / Math.sqrt(tint[2]));
    const P = st.pal;
    const lit = st.litC.setRGB(A.uLit.value.x, A.uLit.value.y, A.uLit.value.z);
    const mixc = (dst, pair) => dst.copy(pair[0]).lerp(pair[1], night).multiply(lit);
    mixc(A.uDeckTop.value, P.deckTop); mixc(A.uDeckLow.value, P.deckLow); mixc(A.uDeckHor.value, P.deckHor);
    mixc(A.uHazeL.value, P.hazeL); mixc(A.uHazeR.value, P.hazeR); mixc(A.uHazeC.value, P.hazeC); mixc(A.uHazeLow.value, P.hazeLow);
    mixc(st.cityU.uAmbUp.value, P.ambUp); mixc(st.cityU.uAmbLow.value, P.ambLow);
    // the flash
    const f = stormFlash(t);
    A.uFlash.value = f;
    A.uFlashCol.value.setRGB(0.55, 0.65, 1.0).multiplyScalar(0.9).multiply(lit);
    flashDir(t, st.flashDir);
    A.uFlashDir.value.copy(st.flashDir);
    // more windows lit at 01:00 than at the blue hour
    st.cityU.uWinK.value.x = 0.78 + 0.22 * night;
    // the room
    const L = st.lights;
    const lampOn = 0.62 + 0.38 * night;
    L.lamp.intensity = 2.6 * lampOn * comp;
    L.cyanL.intensity = 0.35 * (1 + 0.2 * night) * comp;
    L.magL.intensity = 0.35 * (1 + 0.2 * night) * comp;
    L.under.intensity = 0.25 * comp;
    L.flashL.intensity = 0.35 * f * comp;
    if (st.env(night)) k.renderer.resetState();
    k.scene.environmentIntensity = 0.55 * comp;
    // the rain is lighter at the blue hour
    const ra = 0.75 + 0.25 * night;
    st.rain[0].uniforms.uRainLook.value.z = 1.0 * ra;
    st.rain[1].uniforms.uRainLook.value.z = 0.4 * ra;
    st.dropU.uDrops.value.z = 0.4 + 0.4 * lampOn;
  }
};
