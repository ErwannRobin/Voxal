// cybercafe.js — "Cyber café": a late-90s internet café in a Lisbon side
// street, reborn as an espresso bar. 20:30 on a March evening; in a bright
// room, 17:30 the same day.
//
// A half-basement under a brick barrel vault, warm and dry. The back wall is
// lime-wash worn through to the brick at the sides, over a wainscot of blue
// and white azulejos; a brick arch rings it where the vault comes down, and in
// the top corners of the picture that arch is what frames you. On the left: a
// zinc bar with a chrome lever machine, a grinder and a cake under glass, the
// back-bar shelves of jars, tins and cups, a pink neon cup on the wall and a
// string of bulbs along the arch. On the right: an arched window onto the
// street, the street at its sill, and on a bench under it three beige CRT
// terminals still glowing green and amber, turned away so nothing on them can
// be read. Two enamel pendants hang to either side, never over the head; a
// walnut table runs across the bottom corners with a coffee steaming beside
// your shoulder.
//
// Through the window: the street climbing to the right on its rails, the far
// pavement, and a facade of green tiles with iron balconies, gold where the
// low sun still reaches it at 17:30, a few windows and a pastelaria lit at
// night under a wall lantern. A yellow tram comes up the hill every two
// minutes, waits at the stop in the window for forty seconds, and goes on: it
// is the only thing that moves much, and it moves briefly (the art direction
// had it cross in six seconds; a tram that stops is in the still frames too,
// and a still tram costs no bits).
//
// Behind the head there is only the wall: lime-wash, the light falling off
// from the pendants, the tiles below the shoulders.
//
// Authored with the key light on +x (the engine mirrors the picture for a
// light on the left). Metres; the floor is y = 0, the camera 1.2 m up, looking
// down -z at the back wall 3.4 m away, 2 degrees down.
//
// How it is lit (one material for the room and the street, patched):
//   * the window is an area light: the exact diffuse irradiance of its arched
//     opening as a polygon (Lambert's formula), so the bench and the floor fall
//     off away from it as they should;
//   * the street door behind the camera, at 17:30, a warm source far enough
//     away to be taken as a small one;
//   * the pendants are spot lights, pools on the counter and the bench that
//     graze the brick; the neon, the screens and the strip under the counter's
//     lip light what is near them, analytically;
//   * the room's bounce is an environment picture of this room, baked on the
//     CPU from the same lights, re-baked only when the evening moves a step;
//   * the street is lit on its own terms: sky, the sun above a line on the
//     facade, a lantern at night.
//
// What a still room costs every receiver: the room is drawn with up to 8x
// multisampling into its own target and copied into the engine's (office.js
// measured that halving the frozen cost), fine patterns are filtered by the
// buffer's pixel, and the subject's shadow weight (alpha) is a smooth function
// of position, never of material.
//
// Programs: world, glass, glow (halos, steam, the neon), the copy.

import { THREE } from './engine.js';
import * as K from './kit.js';

const SEED = 0xcafe28;
const D2R = Math.PI / 180;

// --- the room ----------------------------------------------------------------------------------
const XL = -2.8, XR = 2.8, ZB = -3.4, ZF = 2.2, WT = 0.5;
// The vault: a segment of a cylinder along z, radius VR about (0, VYC).
const VR = 4.46, VYC = -1.01;
const vaultY = (x) => VYC + Math.sqrt(VR * VR - x * x);
const SPRING = vaultY(XR);
// The brick arch round the back wall: its intrados RIB_R about the vault's axis, RIB_D deep.
const RIB_R = 4.2, RIB_D = 0.16;
const EYE = 1.2, PITCH = 2 * D2R;
// The window in the back wall: jambs, sill, springing; the glass; the wall's outer face.
const WX0 = 1.12, WX1 = 2.32, WY0 = 0.9, WYS = 1.95;
const WCX = (WX0 + WX1) / 2, WRAD = (WX1 - WX0) / 2;
const ZG = ZB - 0.3, ZO = ZB - WT;
const WAIN = 0.75;
// --- the street ---------------------------------------------------------------------------------
const ST0 = 0.55, GRADE = 0.08;
const streetY = (x) => ST0 + GRADE * (x - WCX);
const FAC_Z = ZO - 9.0, PAVE_W = 1.7, RAIL_Z = -8.3, TRAM_X = 3.8, FB0 = 3.0;
const LAMP = { x: 6.05, y: ST0 + GRADE * (6.05 - (1.12 + 2.32) / 2) + 4.25, z: FAC_Z + 0.42 };
const TRAM_G = Math.atan(GRADE);
// --- the bar ------------------------------------------------------------------------------------
const CF = -2.2, CB = -2.75, CX1 = -0.95, CH = 1.05;
const EM = { x: -1.62, z: -2.52 };
// --- the bench and the terminals ----------------------------------------------------------------
const BZ1 = ZB + 0.78, BX0 = 0.98, BH = 0.74;
const CRT_X = [1.32, 1.9, 2.48], CRT_Z = -3.1, CRT_A = 30 * D2R;
// --- lamps, the neon, the table at the front ----------------------------------------------------
const PEND = [new THREE.Vector3(-1.45, 2.05, -2.62), new THREE.Vector3(0.8, 2.05, -2.62)];
const NEON = { x: -2.02, y: 1.93, z: ZB + 0.03 };
const TAB = { x0: -2.6, x1: 2.6, z0: -1.16, z1: -0.42, y: 0.76 };
const CUP = new THREE.Vector3(0.54, TAB.y, -0.95);

// --- colours ------------------------------------------------------------------------------------
function srgbLin(v) { return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
function invAces(y) {
  y = Math.min(Math.max(y, 0), 0.985);
  const a = 2.43 * y - 2.51, b = 0.59 * y - 0.03, c = 0.14 * y;
  return (-b - Math.sqrt(Math.max(b * b - 4 * a * c, 0))) / (2 * a);
}
// The radiance that shows as `hex` at exposure E.
function shows(hex, E = 1, gain = 1) {
  const f = (v) => invAces(srgbLin(v / 255)) / (0.55 * E) * gain;
  return new THREE.Color().setRGB(f((hex >> 16) & 255), f((hex >> 8) & 255), f(hex & 255));
}
const lin = (hex, s = 1) => new THREE.Color(hex).multiplyScalar(s);
const linA = (hex, s = 1) => { const c = lin(hex, s); return [c.r, c.g, c.b]; };
const mixA = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mulA = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const g3 = (a) => `vec3(${a.map((v) => v.toFixed(4)).join(', ')})`;
const f1 = (v) => v.toFixed(4);

// Albedos (linear).
const LIME = linA(0xd9c8b4), BRICK = linA(0x9a4a34), MORTAR = linA(0xb9a58c);
const AZ_B = linA(0x2c4f9e), AZ_W = linA(0xede8dc), TERRA = linA(0x8e4c34);
const WALNUT = linA(0x4a2e1f), ZINC = linA(0xb8bcc0), CHROME = linA(0xdfe1e4);
const BEIGE = linA(0x9c9078), ENAMEL = linA(0x2f5a48), PORCELAIN = linA(0xf0ece4);
const GREEN_T = linA(0x3e7c6e), STONE = linA(0xd8d0c0), YELLOW = linA(0xf0b81c), CREAM = linA(0xeee4cc);

// Material kinds (aMat.x), read by the world shader.
const K_PLAIN = 0, K_LIME = 1, K_BRICK = 2, K_TILE = 3, K_FLOOR = 4, K_WOOD = 5, K_ZINC = 6, K_CHROME = 7,
  K_CRT = 8, K_GLOW = 9, K_FACADE = 10, K_STREET = 11, K_TRAM = 12, K_SKY = 13, K_CASE = 14, K_ENAMEL = 15;
// The glow colours (uGlowC), by index.
const G_BULB = 0, G_SHADE = 1, G_FEST = 2, G_LED = 3, G_LAMP = 4, G_HEAD = 5;

// --- geometry: one buffer for the whole world --------------------------------------------------------
//
// Per vertex: colour (linear albedo), aMat (kind, roughness, metalness, a
// parameter the kind reads) and aUV (surface coordinates in metres, for the
// patterns: brick, tiles, planks, the screens' rows, the tram's panels).
function planar(x, y, z, nx, ny, nz) {
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  if (az >= ax && az >= ay) return [x, y];
  if (ax >= ay) return [z, y];
  return [x, z];
}
class Buf {
  constructor() { this.parts = []; }
  // uv: null, 'planar', or (x, y, z, nx, ny, nz) -> [u, v], computed before xf (a Matrix4) moves it.
  add(g, rgb, mat, uv = null, xf = null) {
    const G = g.index ? g.toNonIndexed() : g;
    if (G !== g) g.dispose();
    for (const n of Object.keys(G.attributes)) if (n !== 'position' && n !== 'normal') G.deleteAttribute(n);
    if (!G.getAttribute('normal')) G.computeVertexNormals();
    const pos = G.getAttribute('position'), nor = G.getAttribute('normal');
    const n = pos.count;
    const C = new Float32Array(n * 3), M = new Float32Array(n * 4), UV = new Float32Array(n * 2);
    const fn = uv === 'planar' ? planar : uv;
    for (let i = 0; i < n; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const c = typeof rgb === 'function' ? rgb(x, y, z) : rgb;
      C[i * 3] = c[0]; C[i * 3 + 1] = c[1]; C[i * 3 + 2] = c[2];
      M.set(mat, i * 4);
      if (fn) { const q = fn(x, y, z, nor.getX(i), nor.getY(i), nor.getZ(i)); UV[i * 2] = q[0]; UV[i * 2 + 1] = q[1]; }
    }
    G.setAttribute('color', new THREE.BufferAttribute(C, 3));
    G.setAttribute('aMat', new THREE.BufferAttribute(M, 4));
    G.setAttribute('aUV', new THREE.BufferAttribute(UV, 2));
    if (xf) G.applyMatrix4(xf);
    this.parts.push(G);
    return G;
  }
  geometry() {
    const g = K.merge(this.parts);
    this.parts.forEach((p) => p.dispose());
    this.parts = [];
    g.computeBoundingSphere();
    return g;
  }
}
const box = (w, h, d, x, y, z) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return g; };
const boxMM = (x0, y0, z0, x1, y1, z1) => box(x1 - x0, y1 - y0, z1 - z0, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
const rbox = (w, h, d, x, y, z, r = 0.01, seg = 2) => {
  const g = new THREE.RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4));
  g.translate(x, y, z);
  return g;
};
const lathe = (prof, x, y0, z, seg = 28) => {
  const g = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), seg);
  g.translate(x, y0, z);
  return g;
};
const cyl = (r0, r1, h, x, y0, z, seg = 20) => {
  const g = new THREE.CylinderGeometry(r1, r0, h, seg);
  g.translate(x, y0 + h / 2, z);
  return g;
};
// Arc length round the vault's axis, and the distance from it: brick on the vault and the arch.
const arcUV = (x, y) => [Math.hypot(x, y - VYC), VR * Math.atan2(x, y - VYC)];

// --- the world shader --------------------------------------------------------------------------------

const WORLD_VERT_HEAD = `
attribute vec4 aMat; attribute vec2 aUV;
varying vec4 vMat; varying vec2 vUV;
uniform vec2 uTram;
`;
const WORLD_VERT = `
vMat = aMat; vUV = aUV;
// the tram runs along its rails, up the hill
if (abs(aMat.x - ${K_TRAM}.0) < 0.5) transformed.xy += uTram;
`;

const WORLD_FRAG_HEAD = `
varying vec4 vMat; varying vec2 vUV;
uniform vec3 uWc[7];        // the window's opening, a polygon on the wall's inner face
uniform vec3 uWinRad;       // its radiance
uniform vec4 uDoor;         // the street door behind the camera: centre, area
uniform vec3 uDoorRad;
uniform vec4 uNeonP[4];     // where the neon's light comes from
uniform vec3 uNeonL;
uniform vec4 uCrtP[3];      // the screens' centres; w: 0 green, 1 amber
uniform vec3 uCrtN;         // their normal
uniform vec3 uCrtG; uniform vec3 uCrtA;
uniform vec2 uCrt;          // the screens' brightness, the scroll's step
uniform vec4 uLed;          // the strip under the counter's lip: rgb, on
uniform vec3 uGlowC[8];
uniform vec4 uAoBox[6];     // contact shadows: centre x, z, half size x, z
uniform vec4 uAoBoxY[6];    // their top, strength
uniform vec4 uIbl;          // the environment's diffuse share, its specular share, corner occlusion
uniform vec4 uFestP[3];     // the string of bulbs, as three sources
uniform vec3 uFestL;
// outside
uniform vec3 uSunO; uniform vec3 uSunDirO;
uniform vec3 uSkyAmb; uniform vec3 uOutRefl;
uniform vec4 uLampO; uniform vec3 uLampC;
uniform vec3 uFacLit; uniform vec3 uTramLit;
uniform vec3 uSkyLo; uniform vec3 uSkyHi;
uniform vec2 uTram;

// Static patterns are filtered by the BUFFER's pixel: detail the jittered
// redraws disagree about is churn every receiver pays for.
vec2 bufPx2(vec2 x) { return max(fwidth(x) * 1.25, vec2(1e-5)); }
float bufPx(float x) { return max(fwidth(x) * 1.25, 1e-5); }
float boxF(float x, float lo, float hi, float w) {
  return clamp((min(x + 0.5 * w, hi) - max(x - 0.5 * w, lo)) / w, 0.0, 1.0);
}

// Running bond: bricks 24 x 7 cm (q.x along a brick), mortar a centimetre;
// each brick its own tone, the mean where they are finer than the buffer.
vec3 brickAt(vec2 q) {
  vec2 b = q / vec2(0.245, 0.072);
  b.x += 0.5 * mod(floor(b.y), 2.0);
  vec2 fw = bufPx2(b);
  float body = pulse(b.x, 0.045, 1.0, fw.x) * pulse(b.y, 0.15, 1.0, fw.y);
  float h = hash12(floor(b) + 7.3);
  float far = smoothstep(0.3, 0.8, max(fw.x, fw.y));
  float tone = mix(0.80 + 0.38 * h, 0.99, far);
  vec3 br = ${g3(BRICK)} * tone;
  br = mix(br, br * vec3(0.72, 0.74, 0.8), step(0.86, h) * (1.0 - far));
  br = mix(br, br * vec3(1.12, 1.0, 0.86), step(h, 0.1) * (1.0 - far));
  return mix(${g3(MORTAR)}, br, body);
}

// Azulejos: 14 cm tiles of a four-petalled rose in a diamond, quarter rings at
// the corners that close into circles across the joints; a frieze of waves
// along the top course. ink 0..1, the mean where finer than the buffer.
float azulejo(vec2 q, out float grout, out vec2 tid) {
  vec2 t = q / 0.14;
  vec2 fw = bufPx2(t);
  tid = floor(t);
  grout = 1.0 - pulse(t.x, 0.025, 0.975, fw.x) * pulse(t.y, 0.025, 0.975, fw.y);
  float far = smoothstep(0.2, 0.6, max(fw.x, fw.y));
  float ink;
  if (q.y > ${f1(WAIN - 0.14)}) {
    float v = (q.y - ${f1(WAIN - 0.14)}) / 0.14;
    float wave = 0.5 + 0.17 * sin(t.x * 3.14159);
    float px = max(fw.x, fw.y) * 1.5;
    ink = 1.0 - boxF(v, wave - 0.12, wave + 0.12, px);
    ink = mix(ink, 0.72, far);
  } else {
    vec2 f = fract(t) * 2.0 - 1.0;
    vec2 a = abs(f);
    float px = max(fw.x, fw.y) * 2.0;
    float dc = abs(length(a - 1.0) - 0.5) - 0.05;
    vec2 r = vec2(a.x + a.y, abs(a.x - a.y)) * 0.7071;
    float dp = (length((r - vec2(0.4, 0.0)) / vec2(0.26, 0.12)) - 1.0) * 0.1;
    float dd = length(f) - 0.11;
    float dm = abs(a.x + a.y - 0.98) - 0.025;
    float d = min(min(dc, dp), min(dd, dm));
    ink = 1.0 - smoothstep(-px, px, d);
    ink = mix(ink, 0.27, far);
  }
  return ink;
}

// Where the vault meets the walls, the floor, the corners; under furniture.
float roomAO(vec3 P) {
  float ao = 1.0;
  ao *= 1.0 - 0.30 * exp(-max(P.y, 0.0) / 0.2);
  ao *= 1.0 - 0.22 * exp(-max(P.z - ${f1(ZB)}, 0.0) / 0.25);
  ao *= 1.0 - 0.25 * exp(-max(${f1(XR)} - abs(P.x), 0.0) / 0.3);
  float vy = ${f1(VYC)} + sqrt(max(${f1(VR * VR)} - P.x * P.x, 0.0));
  ao *= 1.0 - 0.3 * exp(-max(vy - P.y, 0.0) / 0.4);
  for (int i = 0; i < 6; i++) {
    vec4 b = uAoBox[i];
    if (b.z <= 0.0) continue;
    vec2 q = abs(P.xz - b.xy) - b.zw;
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
    float above = abs(P.y - uAoBoxY[i].x);
    ao *= 1.0 - uAoBoxY[i].y * exp(-max(d, 0.0) / 0.08) * exp(-above / 0.1);
  }
  return ao;
}

vec3 eV(vec3 a, vec3 b) {
  vec3 c = cross(a, b);
  float l = length(c);
  return l > 1e-6 ? c / l * acos(clamp(dot(a, b), -0.9999, 0.9999)) : vec3(0.0);
}
// The irradiance a surface at P, facing N, gets from the window (per unit of
// its radiance): Lambert's formula for its polygon. In the reveal, half the sky.
float winLight(vec3 P, vec3 N) {
  if (P.z < ${f1(ZB - 0.01)}) {
    if (P.z < ${f1(ZG)}) return 0.0;
    return 0.42 * max(N.z * 0.5 + 0.5, 0.0);
  }
  // the wall the window is in sees none of it
  if (P.z < ${f1(ZB + 0.02)} && N.z > 0.9) return 0.0;
  vec3 s = vec3(0.0);
  vec3 a = normalize(uWc[6] - P);
  for (int i = 0; i < 7; i++) {
    vec3 b = normalize(uWc[i] - P);
    s += eV(a, b);
    a = b;
  }
  return max(dot(s, N), 0.0) * 0.5;
}

// The facade across the street: buildings 6.6 m wide stepping up the hill, a
// shop floor and floors of 3.3 m, three bays each; green tiles, ochre and rose
// plaster; lioz stone round the openings; iron balconies. u = x, v = y.
vec3 facadeAt(vec2 q, out float glass, out float lit, out float tile) {
  float bw = 6.6;
  float bi = floor((q.x - ${f1(FB0)}) / bw);
  float lx = q.x - ${f1(FB0)} - bi * bw;
  float base = ${f1(ST0)} + ${f1(GRADE)} * (${f1(FB0)} + (bi + 0.5) * bw - ${f1(WCX)}) + 0.14;
  float v = q.y - base;
  float style = mod(bi, 3.0);
  vec3 wall = style < 0.5 ? ${g3(GREEN_T)} : style < 1.5 ? vec3(0.62, 0.36, 0.14) : vec3(0.58, 0.30, 0.25);
  bool ground = v < 4.2;
  float fl = ground ? -1.0 : floor((v - 4.2) / 3.3);
  float fv = ground ? v : v - 4.2 - fl * 3.3;
  float bay = clamp(floor(lx / 2.2), 0.0, 2.0);
  float bu = lx - bay * 2.2 - 1.1;
  vec2 fw = bufPx2(q);
  // the glazed tiles of the green house, averaged when finer than the buffer
  vec2 tq = q / 0.14;
  vec2 tf = bufPx2(tq);
  float tg = 1.0 - pulse(tq.x, 0.06, 0.94, tf.x) * pulse(tq.y, 0.06, 0.94, tf.y);
  float tfar = smoothstep(0.3, 0.8, max(tf.x, tf.y));
  tile = style < 0.5 ? 1.0 : 0.0;
  wall *= mix(1.0, 1.0 + 0.14 * (hash12(floor(tq)) - 0.5), (1.0 - tfar) * tile);
  wall = mix(wall, vec3(0.5, 0.52, 0.48), tg * 0.3 * tile);
  float hw = ground ? (bay < 1.5 ? 0.86 : 0.55) : 0.5;
  float y0 = ground ? (bay < 1.5 ? 0.5 : 0.0) : 0.2;
  float y1 = ground ? 3.1 : 2.5;
  float open = boxF(bu, -hw, hw, fw.x) * boxF(fv, y0, y1, fw.y);
  float frame = boxF(bu, -hw - 0.13, hw + 0.13, fw.x) * boxF(fv, y0 - 0.12, y1 + 0.18, fw.y) - open;
  float course = ground ? boxF(fv, 3.75, 4.2, fw.y) : boxF(fv, -0.06, 0.12, fw.y);
  vec3 c = mix(wall, ${g3(STONE)}, clamp(frame + course, 0.0, 1.0));
  // the plinth of the shop floor
  c = mix(c, ${g3(STONE)} * 0.8, ground ? boxF(fv, -0.5, 0.45, fw.y) * (1.0 - open) : 0.0);
  glass = open;
  float hid = hash13(vec3(bi, fl, bay) + 0.37);
  float rel = clamp((fv - y0) / (y1 - y0), 0.0, 1.0), relx = (bu + hw) / (2.0 * hw);
  // glazing bars: three lights to a shop window, two to a door or a window
  float nb = ground && bay < 1.5 ? 3.0 : 2.0;
  float gbar = pulse(relx * nb + 0.03, 0.0, 0.06, fw.x * nb / (2.0 * hw) + 1e-4) * step(0.02, relx) * step(relx, 0.98);
  glass *= 1.0 - gbar * 0.85;
  if (ground) {
    // a pastelaria: lamps along its ceiling, a counter of cakes across the bottom
    lit = (bay < 1.5 ? 1.0 : 0.3) * (0.4 + 0.6 * sstep(0.35, 1.0, rel)) * (1.0 - 0.65 * boxF(rel, -0.1, 0.33, fw.y / (y1 - y0)));
  } else {
    float curtain = step(0.45, hash13(vec3(bi, fl, bay) + 2.1)) * (1.0 - boxF(relx, 0.28, 0.72, fw.x / (2.0 * hw)));
    lit = step(hid, 0.55) * (0.5 + 0.5 * sstep(0.0, 1.0, rel)) * (1.0 - 0.55 * curtain);
  }
  c = mix(c, vec3(0.03, 0.035, 0.04), open);
  if (!ground) {
    // a balcony's railing over the lower metre of each window
    float rail = boxF(fv, 0.0, 1.0, fw.y) * boxF(bu, -0.78, 0.78, fw.x);
    float bars = mix(pulse(bu / 0.12, 0.0, 0.22, fw.x / 0.12 + 1e-4), 0.22, smoothstep(0.3, 0.8, fw.x / 0.12));
    float top = boxF(fv, 0.92, 1.0, fw.y) + boxF(fv, 0.0, 0.06, fw.y);
    float iron = rail * clamp(bars * 0.9 + top, 0.0, 1.0);
    c = mix(c, vec3(0.025, 0.03, 0.03), iron);
    glass *= 1.0 - iron;
  }
  return c;
}
// Where the low sun still reaches the facade at 17:30: above a line that
// climbs with the street.
float facadeSun(vec3 P) {
  float line = ${f1(ST0)} + ${f1(GRADE)} * (P.x - ${f1(WCX)}) + 2.5;
  return sstep(line - 0.15, line + 0.25, P.y) * step(P.z, ${f1(FAC_Z + 0.9)});
}
`;

// After color_fragment: albedo, roughness and metalness by kind; the glows.
const WORLD_COLOR = `
float KIND = vMat.x;
float ROUGH = vMat.y, METAL = vMat.z, PAR = vMat.w;
vec3 EMIT = vec3(0.0);
vec3 NPERT = vec3(0.0);
vec3 P = vWorld;
vec2 Q = vUV;
bool OUT = KIND > 9.5 && KIND < 13.5;
vec3 nW0 = inverseTransformDirection(normalize(vNormal), viewMatrix);
if (KIND > 0.5 && KIND < 1.5) {
  // lime-wash, worn through to the brick: a little everywhere, more at the
  // sides, low down and under the arch, least of all behind the head
  float n = fbm2(Q * 1.2 + vec2(3.1, 7.7), 4);
  float m = fbm2(Q * 2.3 + 11.0, 2) - 0.5;
  // the brick under the wash: its courses and joints, faint
  vec2 bq = Q / vec2(0.245, 0.072);
  bq.x += 0.5 * mod(floor(bq.y), 2.0);
  vec2 bfw = bufPx2(bq);
  float joint = 1.0 - pulse(bq.x, 0.045, 1.0, bfw.x) * pulse(bq.y, 0.15, 1.0, bfw.y);
  float bfar = smoothstep(0.3, 0.8, max(bfw.x, bfw.y));
  float btone = (hash12(floor(bq) + 7.3) - 0.5) * (1.0 - bfar);
  float ax = abs(P.x);
  float bias = 0.15 * sstep(1.2, 2.6, ax) + 0.12 * (1.0 - sstep(${f1(WAIN)}, ${f1(WAIN + 0.35)}, P.y)) * sstep(0.9, 1.6, ax)
             + 0.10 * sstep(${f1(SPRING - 0.4)}, ${f1(SPRING + 0.4)}, P.y) + 0.12 * PAR
             - 0.26 * (1.0 - sstep(0.8, 1.6, ax)) * (1.0 - PAR);
  float w = n + bias;
  float fw = fwidth(w) * 1.2 + 0.002;
  float bare = smoothstep(0.68 - fw, 0.68 + fw, w);
  float edge = clamp(smoothstep(0.645 - fw, 0.675, w) - bare, 0.0, 1.0);
  vec3 lime = ${g3(LIME)} * (1.0 + 0.07 * m) * (1.0 - 0.07 * joint + 0.035 * btone);
  vec3 dusty = mix(brickAt(Q), ${g3(LIME)}, 0.22);
  diffuseColor.rgb = mix(lime, dusty, bare) * (1.0 - 0.14 * edge);
  ROUGH = mix(0.93, 0.86, bare);
} else if (KIND > 1.5 && KIND < 2.5) {
  // bare brick: the vault (courses along it), the arch (voussoirs); sooty toward the crown
  diffuseColor.rgb = brickAt(Q) * (1.0 - 0.22 * sstep(2.7, 3.45, P.y)) * (1.0 + 0.06 * (fbm2(Q * 1.7, 2) - 0.5));
} else if (KIND > 2.5 && KIND < 3.5) {
  float grout; vec2 tid;
  float ink = azulejo(Q, grout, tid);
  float th = hash12(tid + 3.1);
  vec3 white = ${g3(AZ_W)} * (0.94 + 0.08 * th);
  vec3 blue = ${g3(AZ_B)} * (0.85 + 0.3 * hash12(tid + 9.7));
  diffuseColor.rgb = mix(mix(white, blue, ink * 0.78), vec3(0.6, 0.58, 0.54), grout * 0.8);
  ROUGH = mix(0.16, 0.6, grout);
  // hand-made: each tile a little out of plane
  vec2 tilt = (vec2(hash12(tid + 1.7), hash12(tid + 4.2)) - 0.5) * 0.06 * (1.0 - grout);
  NPERT = abs(nW0.z) > 0.5 ? vec3(tilt, 0.0) : vec3(0.0, tilt.y, tilt.x);
} else if (KIND > 3.5 && KIND < 4.5) {
  // waxed terracotta, 30 cm squares, each fired a little differently
  vec2 t = Q / 0.3;
  vec2 fw = bufPx2(t);
  float joint = 1.0 - pulse(t.x, 0.02, 0.98, fw.x) * pulse(t.y, 0.02, 0.98, fw.y);
  float far = smoothstep(0.25, 0.7, max(fw.x, fw.y));
  float h = hash12(floor(t) + 0.5);
  vec3 c = diffuseColor.rgb * mix(0.82 + 0.3 * h, 0.97, far) * (1.0 + 0.08 * (fbm2(Q * 4.0, 2) - 0.5));
  diffuseColor.rgb = mix(c, vec3(0.30, 0.26, 0.22), joint * 0.8);
  ROUGH = mix(0.42 + 0.2 * h, 0.8, joint);
} else if (KIND > 4.5 && KIND < 5.5) {
  // walnut: grain along the piece (PAR: 0 along x, 1 along y, 2 along z)
  vec3 a = PAR < 0.5 ? P.yzx : PAR < 1.5 ? P.xzy : P.xyz;
  vec2 gq = vec2((a.x + a.y) * 34.0, a.z * 2.2);
  vec2 gf = bufPx2(gq);
  float grain = (vnoise(gq) - 0.5) * (1.0 - smoothstep(0.3, 0.9, gf.x));
  float fig = fbm2(vec2((a.x + a.y) * 6.0, a.z * 0.9), 2) - 0.5;
  diffuseColor.rgb *= 1.0 + 0.22 * grain + 0.18 * fig;
} else if (KIND > 5.5 && KIND < 6.5) {
  // zinc: a soft patina
  diffuseColor.rgb *= 0.9 + 0.16 * fbm2(P.xz * 3.0 + 2.0, 3);
  ROUGH += 0.12 * (fbm2(P.xz * 5.0, 2) - 0.5);
} else if (KIND > 7.5 && KIND < 8.5) {
  // a terminal's screen: rows of characters nobody can read, scrolling up a
  // row every two seconds (each screen on its own beat); the glass curves away
  vec2 c = Q * 2.0 - 1.0;
  float vig = clamp(1.0 - 0.5 * dot(c * c, vec2(0.7, 0.9)), 0.0, 1.0);
  float rows = 11.0, cols = 26.0;
  vec2 g = vec2(Q.x * cols, (1.0 - Q.y) * rows);
  vec2 fw = bufPx2(g);
  float stp = floor(uCrt.y * 0.5 + PAR * 0.37);
  float row = floor(g.y) + stp;
  float ind = floor(hash12(vec2(row, PAR) + 0.3) * 4.0) * step(0.6, hash12(vec2(row, PAR) + 5.1));
  float len = ind + floor(hash12(vec2(row, PAR) + 2.7) * (cols - 4.0 - ind)) * step(0.15, hash12(vec2(row, PAR) + 8.9));
  float ch = floor(g.x);
  float word = step(0.16, hash12(vec2(ch, row) + PAR * 13.0));
  float on = step(ind, ch) * step(ch, len) * word;
  float cell = pulse(g.x, 0.12, 0.88, fw.x) * pulse(g.y, 0.18, 0.78, fw.y);
  float rowCov = clamp((len - ind) / cols, 0.0, 1.0) * 0.84 * 0.76;
  float inRow = pulse(g.y, 0.18, 0.78, fw.y);
  float ink = mix(on * cell, rowCov * inRow, smoothstep(0.4, 0.9, fw.x));
  ink = mix(ink, 0.17, smoothstep(0.4, 0.9, fw.y));
  float inScreen = boxF(Q.x, 0.04, 0.96, bufPx(Q.x)) * boxF(Q.y, 0.05, 0.95, bufPx(Q.y));
  vec3 ph = PAR > 0.5 && PAR < 1.5 ? vec3(1.0, 0.56, 0.12) : vec3(0.36, 1.0, 0.55);
  EMIT = ph * uCrt.x * vig * (0.07 + ink * inScreen);
  diffuseColor.rgb = vec3(0.02, 0.025, 0.022);
} else if (KIND > 8.5 && KIND < 9.5) {
  float ndv = clamp(dot(normalize(vNormal), normalize(vViewPosition)), 0.0, 1.0);
  EMIT = uGlowC[int(PAR + 0.5)] * (0.55 + 0.45 * ndv);
  diffuseColor.rgb *= 0.3;
} else if (KIND > 9.5 && KIND < 10.5) {
  float gl, lit, tile;
  diffuseColor.rgb = facadeAt(vec2(P.x, P.y), gl, lit, tile);
  ROUGH = mix(mix(0.85, 0.3, tile), 0.08, gl);
  vec3 warm = mix(vec3(1.0, 0.5, 0.22), vec3(1.0, 0.66, 0.36), hash12(floor(P.xy / vec2(2.2, 3.3)) + 3.0));
  EMIT = warm * lit * gl * uFacLit;
} else if (KIND > 10.5 && KIND < 11.5) {
  // the street: setts, the tram's rails; the far pavement (PAR 1): calçada
  if (PAR > 0.5) {
    diffuseColor.rgb = vec3(0.62, 0.6, 0.55) * (0.92 + 0.12 * fbm2(P.xz * 2.0, 2));
    ROUGH = 0.8;
  } else {
    float fz = bufPx(P.z);
    float rail = boxF(P.z, ${f1(RAIL_Z - 0.49)}, ${f1(RAIL_Z - 0.43)}, fz) + boxF(P.z, ${f1(RAIL_Z + 0.43)}, ${f1(RAIL_Z + 0.49)}, fz);
    vec2 sq = P.xz / 0.12;
    vec2 sf = bufPx2(sq);
    float far = smoothstep(0.3, 0.8, max(sf.x, sf.y));
    float sett = mix(0.8 + 0.4 * hash12(floor(sq)), 1.0, far);
    diffuseColor.rgb = mix(vec3(0.28, 0.27, 0.25) * sett, vec3(0.55, 0.56, 0.58), rail);
    ROUGH = mix(0.75, 0.22, rail);
    METAL = rail;
  }
} else if (KIND > 11.5 && KIND < 12.5) {
  // the tram (in its own frame: u along, v up from the rail; the ends and the roof by their normal)
  float u = Q.x, v = Q.y;
  float fv = bufPx(v);
  vec3 c = ${g3(YELLOW)};
  float win = 0.0;
  if (nW0.y > 0.6) c = vec3(0.42, 0.42, 0.4);
  else {
    float side = step(0.6, abs(nW0.z));
    float wx = side > 0.5 ? pulse(u / 0.96 + 0.5, 0.1, 0.9, bufPx(u / 0.96)) * boxF(abs(u), 0.0, 3.0, bufPx(u))
                          : boxF(abs(u + 0.0), 0.0, 0.0, 1.0) + boxF(abs(Q.x), 0.0, 0.0, 1.0);
    float wy = boxF(v, 1.42, 2.36, fv);
    win = side > 0.5 ? wx * wy : 0.0;
    c = mix(c, ${g3(CREAM)}, boxF(v, 2.36, 2.86, fv));
    c = mix(c, vec3(0.03), boxF(v, 0.98, 1.04, fv));
    c = mix(c, vec3(0.04, 0.035, 0.03), boxF(v, -1.0, 0.44, fv));
    c = mix(c, vec3(0.03, 0.035, 0.04), win);
  }
  diffuseColor.rgb = c;
  ROUGH = mix(0.32, 0.08, win);
  float iv = (v - 1.42) / 0.94;
  float seat = boxF(iv, 0.0, 0.32, fv / 0.94) * (0.55 + 0.45 * hash11(floor(u / 0.96 + 0.5) + 5.0));
  EMIT = uTramLit * win * (0.3 + 0.7 * sstep(0.1, 0.95, iv)) * (1.0 - 0.75 * seat) * (0.8 + 0.4 * hash11(floor(u / 0.96 + 0.5) + 2.0));
} else if (KIND > 12.5 && KIND < 13.5) {
  vec3 d = normalize(P - cameraPosition);
  EMIT = mix(uSkyLo, uSkyHi, sstep(0.05, 0.6, d.y));
  diffuseColor.rgb = vec3(0.0);
} else if (KIND > 13.5 && KIND < 14.5) {
  // old beige plastic, yellowed unevenly
  diffuseColor.rgb *= 0.95 + 0.08 * fbm2(P.xy * 6.0 + P.z * 3.0, 2);
} else if (KIND > 14.5 && KIND < 15.5) {
  // enamel; inside a shade (PAR 1), lit by its bulb
  if (PAR > 0.5) {
    EMIT = uGlowC[${G_SHADE}];
    diffuseColor.rgb = vec3(0.9, 0.88, 0.84);
  }
}
`;

const WORLD_PATCH = (uniforms) => ({
  key: 'cafe-world',
  uniforms,
  vertexHead: WORLD_VERT_HEAD,
  vertex: { begin_vertex: WORLD_VERT },
  fragmentHead: WORLD_FRAG_HEAD,
  fragment: {
    color_fragment: WORLD_COLOR,
    normal_fragment_maps: 'normal = normalize(normal + (viewMatrix * vec4(NPERT, 0.0)).xyz);',
    roughnessmap_fragment: 'roughnessFactor = clamp(ROUGH, 0.04, 1.0);',
    metalnessmap_fragment: 'metalnessFactor = METAL;',
    emissivemap_fragment: 'totalEmissiveRadiance += EMIT;',
    // The environment is this room: the street takes its own sky instead.
    lights_fragment_maps: `
#if defined( RE_IndirectDiffuse )
iblIrradiance *= OUT ? 0.0 : uIbl.x;
#endif
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
radiance = OUT ? uOutRefl : radiance * uIbl.y;
#endif
`,
    lights_fragment_end: `{
  vec3 nW = inverseTransformDirection(normal, viewMatrix);
  vec3 alb = material.diffuseContribution * RECIPROCAL_PI;
  if (OUT) {
    // the street: sky, the sun above its line on the facade, the lantern at night
    reflectedLight.directDiffuse = vec3(0.0);
    reflectedLight.directSpecular = vec3(0.0);
    float sunV = KIND < 10.5 ? facadeSun(vWorld) : 0.0;
    vec3 E = uSunO * max(dot(nW, uSunDirO), 0.0) * sunV + uSkyAmb * (0.62 + 0.38 * nW.y);
    vec3 dl = uLampO.xyz - vWorld;
    float d2 = dot(dl, dl);
    E += uLampC * max(dot(nW, dl * inversesqrt(d2)), 0.0) / max(d2, 0.4);
    reflectedLight.indirectDiffuse = alb * E;
  } else {
    float ao = mix(1.0, roomAO(vWorld), uIbl.z);
    reflectedLight.indirectDiffuse *= ao;
    reflectedLight.indirectSpecular *= mix(1.0, ao, 0.6);
    vec3 E = uWinRad * winLight(vWorld, nW);
    // the door behind the camera
    vec3 dd = uDoor.xyz - vWorld;
    float q = dot(dd, dd);
    vec3 dn = dd * inversesqrt(q);
    E += uDoorRad * uDoor.w * max(dot(nW, dn), 0.0) * max(dn.z, 0.0) / max(q, 1.5);
    // the neon's pink on what is near it
    for (int i = 0; i < 4; i++) {
      vec3 l = uNeonP[i].xyz - vWorld;
      float lq = dot(l, l);
      E += uNeonL * max(dot(nW, l * inversesqrt(lq)), 0.0) / max(lq, 0.03);
    }
    for (int i = 0; i < 3; i++) {
      vec3 l = uFestP[i].xyz - vWorld;
      float lq = dot(l, l);
      E += uFestL * (0.35 + 0.65 * max(dot(nW, l * inversesqrt(lq)), 0.0)) / max(lq, 0.08);
    }
    // the screens' phosphor, in front of them
    for (int i = 0; i < 3; i++) {
      vec3 l = uCrtP[i].xyz - vWorld;
      float lq = dot(l, l);
      vec3 ln = l * inversesqrt(lq);
      E += mix(uCrtG, uCrtA, uCrtP[i].w) * max(dot(nW, ln), 0.0) * max(-dot(ln, uCrtN), 0.0) / max(lq, 0.02);
    }
    // the strip under the counter's lip: a line of light along its front edge
    if (uLed.w > 0.0 && vWorld.x < ${f1(CX1 + 0.1)} && vWorld.y < ${f1(CH)}) {
      vec2 l = vec2(${f1(CH - 0.05)} - vWorld.y, ${f1(CF + 0.035)} - vWorld.z);
      float ll = max(length(l), 0.015);
      float along = sstep(${f1(CX1 + 0.08)}, ${f1(CX1 - 0.05)}, vWorld.x);
      E += uLed.rgb * max(dot(nW, vec3(0.0, l) / ll), 0.0) / ll * along * 0.06;
    }
    reflectedLight.indirectDiffuse += material.diffuseContribution * RECIPROCAL_PI * E * mix(1.0, ao, 0.5);
  }
}`
  },
  // The subject's shadow weight: a smooth function of WHERE, never of which
  // material (see office.js: a weight that jumps at every edge is read as
  // movement along each of them by the resolve). Nothing past the window.
  fragmentBefore: {
    premultiplied_alpha_fragment: `gl_FragColor.a = vWorld.z < ${f1(ZB - 0.25)} ? 0.0 : mix(0.72, 0.93, sstep(0.02, 0.5, vWorld.y));`
  }
});

// --- the glows: halos, the steam, the espresso machine's puff, the neon --------------------------------
const NEON_SEGS = (() => {
  const s = [];
  const pl = (pts) => { for (let i = 0; i + 1 < pts.length; i++) s.push([pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]]); };
  // the cup's bowl, a half ellipse, and its rim
  const bowl = [];
  for (let i = 0; i <= 8; i++) { const a = Math.PI + Math.PI * i / 8; bowl.push([0.16 * Math.cos(a), 0.1 + 0.19 * Math.sin(a)]); }
  pl(bowl);
  pl([[-0.175, 0.1], [0.175, 0.1]]);
  // the handle
  pl([[0.15, 0.055], [0.215, 0.05], [0.235, 0.005], [0.205, -0.04], [0.115, -0.045]]);
  // the saucer
  pl([[-0.25, -0.115], [-0.13, -0.14], [0.13, -0.14], [0.25, -0.115]]);
  // two wisps of steam
  pl([[-0.05, 0.145], [-0.085, 0.19], [-0.045, 0.24], [-0.08, 0.29]]);
  pl([[0.05, 0.145], [0.015, 0.19], [0.055, 0.24], [0.02, 0.29]]);
  return s;
})();

const GLOW_DECL = `
varying vec2 vQ; varying vec4 vG; varying float vScale; varying vec3 vWorld; varying vec2 vL;
uniform vec3 uGC[8];
uniform vec2 uTram;
uniform vec4 uSeg[${NEON_SEGS.length}];
uniform vec4 uNeon;        // rgb, strength
uniform vec3 uSteamC;
`;
const GLOW_VERT = `
attribute vec4 aG;     // kind (0 halo, 1 steam, 2 puff, 3 neon, 4 the tram's lamps), radius, phase, colour
attribute vec2 aL;     // the neon: this corner in the sign's own metres
void main() {
  vQ = uv; vG = aG; vScale = 1.0; vL = aL;
  vec3 p = position;
  if (aG.x > 3.5) p.xy += uTram;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  if (aG.x < 2.5 || aG.x > 3.5) {
    vec3 toC = cameraPosition - wp.xyz;
    float dist = length(toC);
    toC /= dist;
    if (aG.x > 0.5 && aG.x < 2.5) {
      // steam stands upright, turned to face you
      vec3 rt = normalize(vec3(toC.z, 0.0, -toC.x));
      if (aG.x < 1.5) wp.xyz += rt * (uv.x * 2.0 - 1.0) * aG.y + vec3(0.0, uv.y * 0.34, 0.0);
      else wp.xyz += (rt * (uv.x * 2.0 - 1.0) + vec3(0.0, uv.y * 2.0 - 0.6, 0.0)) * aG.y;
    } else {
      vec3 rt = normalize(cross(vec3(0.0, 1.0, 0.0), toC));
      vec3 up = cross(toC, rt);
      float px = dist * 2.0 / (projectionMatrix[1][1] * uBufH);
      float r = max(aG.y, px * 1.5);
      vScale = sq(aG.y / r);
      wp.xyz += (rt * (uv.x * 2.0 - 1.0) + up * (uv.y * 2.0 - 1.0)) * r;
    }
  }
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const GLOW_FRAG = `
float boxF(float x, float lo, float hi, float w) {
  return clamp((min(x + 0.5 * w, hi) - max(x - 0.5 * w, lo)) / w, 0.0, 1.0);
}
void main() {
  vec2 q = vQ * 2.0 - 1.0;
  float d2 = dot(q, q);
  vec3 c;
  float a = 1.0;
  if (vG.x < 0.5 || vG.x > 3.5) {
    a = sq(max(1.0 - d2, 0.0)) / (1.0 + d2 / 0.035);
    c = uGC[int(vG.w + 0.5)] * vScale * uEmis;
  } else if (vG.x < 1.5) {
    // the cup's steam: two or three wisps rising 3 cm a second, leaning when you move
    float h = vQ.y * 0.34;
    float x = (vQ.x * 2.0 - 1.0) * vG.y;
    float lean = (0.012 + 0.06 * uMotion) * sq(h / 0.34) * sin(uTime * 0.35 + vG.z);
    x -= lean + 0.01 * sin(h * 18.0 - uTime * 0.9 + vG.z);
    float rise = uTime * 0.03;
    float n = vnoise(vec2(x * 45.0 + vG.z, (h - rise) * 11.0)) * 0.65 + vnoise(vec2(x * 90.0 + 3.0, (h - rise * 1.3) * 23.0)) * 0.35;
    float wisp = smoothstep(0.42, 0.8, n);
    float env = exp(-sq(x / (0.009 + 0.07 * h))) * smoothstep(0.0, 0.03, h) * (1.0 - smoothstep(0.1, 0.32, h));
    a = wisp * env * 0.2;
    c = uSteamC;
  } else if (vG.x < 2.5) {
    // the machine lets off steam now and then: a puff that swells and fades
    float life = mod(uTime + vG.z, 40.0);
    float k = life < 3.5 ? life / 3.5 : 1.0;
    vec2 p = vec2(q.x, vQ.y * 2.0 - 0.6);
    float r = mix(0.25, 1.0, sqrt(k));
    float n = vnoise(p * 3.5 + vec2(vG.z, -uTime * 0.25)) * 0.6 + vnoise(p * 7.0 - uTime * 0.2) * 0.4;
    float body = smoothstep(r, r * 0.3, length(p - vec2(0.0, k * 0.5))) * smoothstep(0.3, 0.7, n);
    a = body * 0.22 * (1.0 - k) * step(life, 3.5);
    c = uSteamC;
  } else {
    // the neon cup: the distance to its tubes, a white-hot core and a pink glow
    float d = 1e3;
    for (int i = 0; i < ${NEON_SEGS.length}; i++) {
      vec4 s = uSeg[i];
      vec2 ab = s.zw - s.xy, ap = vL - s.xy;
      float t = clamp(dot(ap, ab) / dot(ab, ab), 0.0, 1.0);
      d = min(d, length(ap - ab * t));
    }
    float px = max(max(fwidth(vL.x), fwidth(vL.y)) * 1.25, 1e-4);
    float core = boxF(d, -0.0065, 0.0065, px);
    float halo = 0.5 * exp(-d / 0.014) + 0.16 * exp(-d / 0.06);
    c = (uNeon.rgb * (core * 2.2 + halo) + vec3(1.0, 0.86, 0.94) * core * 1.2) * uNeon.w * uEmis;
  }
  gl_FragColor = vec4(c, a);
}
`;

// --- the room's light, for the environment ----------------------------------------------------------------
//
// A picture of this room seen from its middle, lit by the same window, door and
// lamps as the shader: what the zinc, the chrome and the tiles reflect, and
// what fills the shadows.
function envPicture(o) {
  const w = 64, h = 32;
  const data = new Float32Array(w * h * 4);
  const C = new THREE.Vector3(0, 1.5, -1.6);
  const d = new THREE.Vector3(), P = new THREE.Vector3(), N = new THREE.Vector3(), L = new THREE.Vector3();
  const win = new THREE.Vector3(WCX, 1.6, ZB), door = new THREE.Vector3(2.5, 1.3, ZF);
  for (let j = 0; j < h; j++) {
    const th = ((j + 0.5) / h - 0.5) * Math.PI, ey = Math.sin(th), ce = Math.cos(th);
    for (let i = 0; i < w; i++) {
      const ph = ((i + 0.5) / w - 0.5) * 2 * Math.PI;
      d.set(Math.cos(ph) * ce, ey, Math.sin(ph) * ce);
      let t = Infinity, face = '';
      const hit = (tt, f) => { if (tt > 1e-4 && tt < t) { t = tt; face = f; } };
      if (d.y < 0) hit(-C.y / d.y, 'floor');
      if (d.x > 0) hit((XR - C.x) / d.x, 'wall'); else if (d.x < 0) hit((XL - C.x) / d.x, 'wall');
      if (d.z < 0) hit((ZB - C.z) / d.z, 'back'); else if (d.z > 0) hit((ZF - C.z) / d.z, 'front');
      {
        const ox = C.x, oy = C.y - VYC, a = d.x * d.x + d.y * d.y, b = 2 * (ox * d.x + oy * d.y), c = ox * ox + oy * oy - VR * VR;
        const disc = b * b - 4 * a * c;
        if (a > 1e-6 && disc > 0) {
          const tt = (-b + Math.sqrt(disc)) / (2 * a);
          if (C.y + tt * d.y > SPRING - 0.01) hit(tt, 'vault');
        }
      }
      P.copy(C).addScaledVector(d, t);
      let c;
      if (face === 'back' && P.x > WX0 && P.x < WX1 && P.y > WY0 && (P.y < WYS || Math.hypot(P.x - WCX, P.y - WYS) < WRAD)) {
        c = o.outside;
      } else if (face === 'front' && P.x > 0.4 && P.x < 2.4 && P.y < 2.6) {
        c = o.door;
      } else {
        let alb = LIME;
        if (face === 'floor') { alb = mulA(TERRA, 0.9); N.set(0, 1, 0); }
        else if (face === 'vault') { alb = mulA(BRICK, 0.95); N.set(-P.x, VYC - P.y, 0).normalize(); }
        else if (face === 'wall') { alb = mixA(LIME, BRICK, 0.35); N.set(-Math.sign(P.x), 0, 0); }
        else if (face === 'back') {
          alb = P.y < WAIN ? mixA(AZ_W, AZ_B, 0.35) : P.x < -1.0 && P.y < 2.3 ? mulA(WALNUT, 1.4) : LIME;
          N.set(0, 0, 1);
        } else { N.set(0, 0, -1); }
        // the window and the door as small sources, the lamps, a constant bounce
        let E = [o.bounce[0], o.bounce[1], o.bounce[2]];
        L.copy(win).sub(P); let q = L.lengthSq(); L.normalize();
        let k = Math.max(0, N.dot(L)) * Math.max(0, L.z < 0 ? -L.z : 0) * 1.75 / Math.max(q, 0.5);
        E = E.map((v, m) => v + o.win[m] * k);
        L.copy(door).sub(P); q = L.lengthSq(); L.normalize();
        k = Math.max(0, N.dot(L)) * Math.max(0, L.z) * 5.2 / Math.max(q, 1.5);
        E = E.map((v, m) => v + o.door[m] * k);
        for (const lp of o.lamps) {
          L.copy(lp.p).sub(P); q = L.lengthSq(); L.normalize();
          const cone = sstep(-0.35, 0.6, -L.y);
          k = Math.max(0, N.dot(L)) * cone / Math.max(q, 0.3);
          E = E.map((v, m) => v + lp.c[m] * k);
        }
        c = alb.map((a, m) => a / Math.PI * E[m]);
      }
      // the bright things, as seen from the middle of the room
      for (const s of o.spots) {
        const to = s.p.clone().sub(C), dist = to.length();
        if (to.normalize().dot(d) > Math.cos(Math.atan(s.r / dist))) c = s.c;
      }
      const k = (j * w + i) * 4;
      data[k] = c[0]; data[k + 1] = c[1]; data[k + 2] = c[2]; data[k + 3] = 1;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// --- building the room -------------------------------------------------------------------------------------

// The lunette under the vault as a shape in the wall's plane (x, y), optionally with the window cut in it.
function lunette(withWindow) {
  const s = new THREE.Shape();
  const a0 = Math.atan2(SPRING - 0.02 - VYC, XR + 0.3);
  s.moveTo(XL - 0.3, -0.1);
  s.lineTo(XR + 0.3, -0.1);
  s.lineTo(XR + 0.3, SPRING - 0.02);
  s.absarc(0, VYC, Math.hypot(XR + 0.3, SPRING - 0.02 - VYC) + 0.04, a0, Math.PI - a0, false);
  s.lineTo(XL - 0.3, -0.1);
  if (withWindow) {
    const hpath = new THREE.Path();
    hpath.moveTo(WX0, WY0);
    hpath.lineTo(WX0, WYS);
    hpath.absarc(WCX, WYS, WRAD, Math.PI, 0, true);
    hpath.lineTo(WX1, WY0);
    hpath.lineTo(WX0, WY0);
    s.holes.push(hpath);
  }
  return s;
}

function buildShell(B) {
  // the azulejo wainscot and its cap, across the back wall (first: what is in front is drawn first, so the
  // walls behind it are not shaded for nothing)
  const tile = [K_TILE, 0.16, 0, 0];
  B.add(boxMM(XL, 0.0, ZB, XR, WAIN, ZB + 0.012), AZ_W, tile, 'planar');
  B.add(rbox(XR - XL, 0.028, 0.03, 0, WAIN + 0.01, ZB + 0.012, 0.012, 3), mulA(AZ_B, 0.8), [K_PLAIN, 0.15, 0, 0]);
  // and on the side walls (seen only when the view turns)
  B.add(boxMM(XL, 0, ZB, XL + 0.012, WAIN, ZF), AZ_W, tile, 'planar');
  B.add(boxMM(XR - 0.012, 0, ZB, XR, WAIN, ZF), AZ_W, tile, 'planar');
  const lime = [K_LIME, 0.92, 0, 0], limeS = [K_LIME, 0.92, 0, 1];
  // the back wall, the window cut through it (its reveal is the extrusion's side)
  const back = new THREE.ExtrudeGeometry(lunette(true), { depth: WT, bevelEnabled: false, curveSegments: 36 });
  back.translate(0, 0, ZO);
  B.add(back, LIME, lime, 'planar');
  // the front wall, behind the camera
  const front = new THREE.ExtrudeGeometry(lunette(false), { depth: 0.3, bevelEnabled: false, curveSegments: 36 });
  front.translate(0, 0, ZF);
  B.add(front, LIME, limeS, 'planar');
  // the side walls, up to the springing
  B.add(boxMM(XL - 0.3, -0.1, ZB - 0.1, XL, SPRING + 0.02, ZF + 0.1), LIME, limeS, 'planar');
  B.add(boxMM(XR, -0.1, ZB - 0.1, XR + 0.3, SPRING + 0.02, ZF + 0.1), LIME, limeS, 'planar');
  // the floor
  B.add(boxMM(XL, -0.1, ZB, XR, 0, ZF), TERRA, [K_FLOOR, 0.5, 0, 0], 'planar');
  // the vault: brick in courses along it
  {
    const a0 = Math.asin(XR / VR), nu = 72, nz = 6;
    const P = [], I = [];
    for (let j = 0; j <= nz; j++) {
      const z = ZB - 0.05 + (ZF + 0.1 - ZB) * j / nz;
      for (let i = 0; i <= nu; i++) {
        const th = -a0 + 2 * a0 * i / nu;
        P.push(VR * Math.sin(th), VYC + VR * Math.cos(th), z);
      }
    }
    for (let j = 0; j < nz; j++) for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
      I.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setIndex(I);
    g.computeVertexNormals();
    B.add(g, BRICK, [K_BRICK, 0.88, 0, 0], (x, y, z) => [z, arcUV(x, y)[1]]);
  }
  // the brick arch round the back wall, and another over the room
  const ring = (z0, depth) => {
    const s = new THREE.Shape();
    const ao = Math.asin((XR + 0.25) / (VR + 0.3)), ai = Math.asin(Math.min(1, (XR + 0.25) / RIB_R));
    s.absarc(0, VYC, VR + 0.3, Math.PI / 2 - ao, Math.PI / 2 + ao, false);
    s.absarc(0, VYC, RIB_R, Math.PI / 2 + ai, Math.PI / 2 - ai, true);
    const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 64 });
    g.translate(0, 0, z0);
    B.add(g, BRICK, [K_BRICK, 0.9, 0, 1], (x, y, z, nx, ny, nz) => {
      const [r, a] = arcUV(x, y);
      return Math.abs(nz) > 0.5 ? [r, a] : [z * 1.0, a];
    });
  };
  ring(ZB - 0.02, RIB_D + 0.02);
  ring(-1.35, 0.3);
}

// The window: a sash of painted wood (frame, a mullion, two transoms, a fanlight
// of radial bars), a stone sill inside.
function buildWindow(B) {
  const paint = [K_PLAIN, 0.45, 0, 0], PAINT = linA(0x2c3b33);
  const fz = ZG, fd = 0.05, FR = 0.045, BAR = 0.024;
  const parts = [];
  parts.push(boxMM(WX0, WY0, fz - fd, WX1, WY0 + FR, fz + fd));
  parts.push(boxMM(WX0, WY0, fz - fd, WX0 + FR, WYS, fz + fd));
  parts.push(boxMM(WX1 - FR, WY0, fz - fd, WX1, WYS, fz + fd));
  parts.push(boxMM(WX0, WYS - BAR / 2, fz - fd, WX1, WYS + BAR / 2, fz + fd));
  parts.push(boxMM(WCX - BAR / 2, WY0, fz - fd * 0.8, WCX + BAR / 2, WYS, fz + fd * 0.8));
  // the fanlight: the arched frame and three radial bars
  {
    const s = new THREE.Shape();
    s.absarc(WCX, WYS, WRAD, 0, Math.PI, false);
    s.absarc(WCX, WYS, WRAD - FR, Math.PI, 0, true);
    const g = new THREE.ExtrudeGeometry(s, { depth: fd * 2, bevelEnabled: false, curveSegments: 24 });
    g.translate(0, 0, fz - fd);
    parts.push(g);
    for (const a of [Math.PI / 4, Math.PI / 2, 3 * Math.PI / 4]) {
      const g2 = box(BAR, WRAD - FR, fd * 1.4, 0, (WRAD - FR) / 2, 0);
      g2.rotateZ(a - Math.PI / 2);
      g2.translate(WCX, WYS, fz);
      parts.push(g2);
    }
  }
  for (const g of parts) B.add(g, PAINT, paint);
  // the sill inside: a slab of pale stone, proud of the wall
  B.add(rbox(WX1 - WX0 + 0.14, 0.04, WT - 0.28 + 0.06, WCX, WY0 - 0.02, ZB - (WT - 0.28) / 2 + 0.03, 0.01), STONE, [K_PLAIN, 0.4, 0, 0]);
}

// The bar: walnut, panelled, a zinc top with a rolled edge; the back-bar shelves.
function buildBar(B, r) {
  const wood = (axis) => [K_WOOD, 0.5, 0, axis];
  const TEAK = linA(0x7a5236);
  B.add(boxMM(XL, 0, CB, CX1, CH - 0.04, CF), mulA(TEAK, 0.9), wood(1));
  // the front's panels: stiles and rails proud of it
  for (let x = XL + 0.05; x < CX1; x += 0.62) B.add(boxMM(x, 0.08, CF, Math.min(x + 0.06, CX1), CH - 0.06, CF + 0.018), TEAK, wood(1));
  B.add(boxMM(XL, 0.08, CF, CX1, 0.14, CF + 0.018), TEAK, wood(0));
  B.add(boxMM(XL, CH - 0.12, CF, CX1, CH - 0.06, CF + 0.018), TEAK, wood(0));
  B.add(boxMM(CX1, 0.08, CB, CX1 + 0.018, CH - 0.06, CF), TEAK, wood(2));
  // a brass foot rail on its brackets
  const rail = new THREE.CylinderGeometry(0.022, 0.022, CX1 - XL, 16);
  rail.rotateZ(Math.PI / 2);
  rail.translate((XL + CX1) / 2, 0.2, CF + 0.16);
  B.add(rail, linA(0xc8a050), [K_PLAIN, 0.22, 1, 0]);
  for (let x = XL + 0.4; x < CX1; x += 0.9) B.add(boxMM(x - 0.012, 0.19, CF, x + 0.012, 0.21, CF + 0.16), linA(0xc8a050), [K_PLAIN, 0.3, 1, 0]);
  // a kick plate in shadow
  B.add(boxMM(XL, 0, CF - 0.02, CX1, 0.08, CF + 0.005), linA(0x1a1410), [K_PLAIN, 0.6, 0, 0]);
  // the zinc top
  B.add(rbox(CX1 - XL + 0.32, 0.045, CF - CB + 0.08, (XL + CX1) / 2, CH - 0.022, (CF + CB) / 2 + 0.02, 0.02, 3), ZINC, [K_ZINC, 0.34, 1, 0]);
  // the strip under the lip
  B.add(boxMM(XL, CH - 0.06, CF + 0.02, CX1 - 0.02, CH - 0.045, CF + 0.045), [1, 1, 1], [K_GLOW, 0, 0, G_LED]);
  // the back-bar: a cabinet, and shelves on the wall
  B.add(boxMM(XL, 0, ZB, -1.1, 0.95, ZB + 0.42), mulA(WALNUT, 0.85), wood(0));
  const shelf = (x0, x1, y) => B.add(boxMM(x0, y - 0.03, ZB, x1, y, ZB + 0.24), WALNUT, wood(0));
  const boards = [[XL, -1.12, 1.3], [XL, -1.12, 1.57], [XL, -2.42, 1.9], [XL, -2.42, 2.2]];
  for (const [x0, x1, y] of boards) shelf(x0, x1, y);
  // what is on them: jars of beans and sugar and biscuits, tins, cups, a few bottles
  const TINS = [0xb8322a, 0x2f6a4a, 0xd8a83a, 0x2a4a7a, 0xe6dcc8, 0x8a2a3a];
  let n = 0;
  for (const [x0, x1, y] of boards) {
    let x = x0 + 0.06;
    while (x < x1 - 0.08) {
      const pick = r();
      const z = ZB + 0.11 + r.range(-0.02, 0.03);
      if (pick < 0.32) {
        // a glass jar and what is in it
        const rr = r.range(0.045, 0.06), hh = r.range(0.14, 0.2);
        const fill = r.pick([linA(0x3a2216), linA(0xe8e0d0), linA(0xb07a40), linA(0x6a3a20)]);
        B.add(cyl(rr, rr, hh * 0.8, x + rr, y, z, 18), fill, [K_PLAIN, 0.6, 0, 0]);
        B.add(cyl(rr + 0.004, rr + 0.004, hh * 0.18, x + rr, y + hh * 0.8, z, 18), mixA(fill, [0.6, 0.62, 0.6], 0.7), [K_PLAIN, 0.08, 0, 0]);
        B.add(cyl(rr * 0.9, rr * 0.9, 0.03, x + rr, y + hh * 0.98, z, 18), linA(0x8a8a86), [K_CHROME, 0.3, 1, 0]);
        x += rr * 2 + r.range(0.015, 0.04);
      } else if (pick < 0.6) {
        const rr = r.range(0.04, 0.055), hh = r.range(0.1, 0.17);
        B.add(cyl(rr, rr, hh, x + rr, y, z, 18), linA(r.pick(TINS)), [K_PLAIN, 0.35, 0.5, 0]);
        x += rr * 2 + r.range(0.01, 0.03);
      } else if (pick < 0.85) {
        // a stack of cups
        const k = r.int(2, 4);
        for (let i = 0; i < k; i++) B.add(lathe([[0, 0], [0.028, 0], [0.04, 0.05], [0.042, 0.055], [0, 0.055]], x + 0.045, y + i * 0.045, z, 18), PORCELAIN, [K_PLAIN, 0.2, 0, 0]);
        x += 0.1;
      } else {
        const col = r.pick([linA(0x3a1a10), linA(0x2a3a1a), linA(0x6a3a10)]);
        B.add(lathe([[0, 0], [0.035, 0], [0.036, 0.17], [0.014, 0.22], [0.012, 0.27], [0, 0.27]], x + 0.04, y, z, 16), col, [K_PLAIN, 0.1, 0, 0]);
        x += 0.09;
      }
      n++;
    }
  }
  return n;
}

// The lever machine on the counter, the grinder, the cake under its dome.
function buildMachine(B) {
  const chrome = [K_CHROME, 0.12, 1, 0], y0 = CH;
  const cx = EM.x, cz = EM.z;
  // body, a cream enamel panel on its front, the cup warmer on top
  B.add(rbox(0.66, 0.36, 0.44, cx, y0 + 0.2, cz, 0.04, 3), CHROME, chrome);
  B.add(rbox(0.5, 0.2, 0.01, cx, y0 + 0.24, cz + 0.222, 0.01, 2), linA(0x8a1e22), [K_PLAIN, 0.25, 0, 0]);
  B.add(rbox(0.6, 0.03, 0.4, cx, y0 + 0.395, cz, 0.012, 2), CHROME, chrome);
  // the boiler's dome and its finial
  B.add(lathe([[0.2, 0], [0.2, 0.02], [0.18, 0.08], [0.12, 0.15], [0.05, 0.19], [0.03, 0.2], [0.035, 0.235], [0.0, 0.25]], cx, y0 + 0.41, cz, 36), CHROME, chrome);
  // two groups and their portafilters, the levers raised
  for (const gx of [cx - 0.17, cx + 0.17]) {
    B.add(cyl(0.045, 0.04, 0.09, gx, y0 + 0.11, cz + 0.25, 20), CHROME, chrome);
    const pf = box(0.03, 0.025, 0.17, gx, y0 + 0.1, cz + 0.36);
    B.add(pf, linA(0x151210), [K_PLAIN, 0.5, 0, 0]);
    const lv = box(0.022, 0.32, 0.022, 0, 0.16, 0);
    lv.rotateX(-0.35);
    lv.translate(gx, y0 + 0.24, cz + 0.27);
    B.add(lv, CHROME, chrome);
    B.add(new THREE.SphereGeometry(0.03, 14, 10).translate(gx, y0 + 0.24 + 0.3 * Math.cos(0.35), cz + 0.27 + 0.3 * Math.sin(0.35)), linA(0x151210), [K_PLAIN, 0.3, 0, 0]);
    // a cup under each
    B.add(lathe([[0, 0], [0.024, 0], [0.034, 0.045], [0.036, 0.05], [0, 0.05]], gx, y0 + 0.012, cz + 0.29, 18), PORCELAIN, [K_PLAIN, 0.2, 0, 0]);
  }
  // the drip tray, the steam wand
  B.add(rbox(0.6, 0.02, 0.14, cx, y0 + 0.01, cz + 0.28, 0.006, 2), CHROME, chrome);
  const wand = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
    new THREE.Vector3(cx + 0.31, y0 + 0.3, cz + 0.15), new THREE.Vector3(cx + 0.36, y0 + 0.28, cz + 0.2), new THREE.Vector3(cx + 0.37, y0 + 0.12, cz + 0.24)]), 10, 0.008, 6);
  B.add(wand, CHROME, chrome);
  // cups warming on top
  for (let i = 0; i < 5; i++) B.add(lathe([[0, 0], [0.022, 0], [0.032, 0.042], [0.034, 0.046], [0, 0.046]], cx - 0.2 + i * 0.1, y0 + 0.41, cz - 0.1 + (i % 2) * 0.05, 16), PORCELAIN, [K_PLAIN, 0.2, 0, 0]);
  // the grinder: a red base, a chrome body, a hopper of beans
  const gx = -2.16, gz = -2.6;
  B.add(rbox(0.16, 0.2, 0.2, gx, y0 + 0.1, gz, 0.02, 2), linA(0x8a1e22), [K_PLAIN, 0.25, 0, 0]);
  B.add(cyl(0.07, 0.06, 0.16, gx, y0 + 0.2, gz, 20), CHROME, chrome);
  B.add(lathe([[0.03, 0], [0.1, 0.16], [0.104, 0.17], [0, 0.17]], gx, y0 + 0.36, gz, 24), linA(0x3a2014), [K_PLAIN, 0.15, 0, 0]);
  // the cake stand and the cake (the dome is glass, drawn apart)
  const kx = -1.03, kz = -2.36;
  B.add(lathe([[0, 0], [0.06, 0], [0.03, 0.02], [0.02, 0.09], [0.14, 0.1], [0.14, 0.11], [0, 0.11]], kx, y0, kz, 32), PORCELAIN, [K_PLAIN, 0.2, 0, 0]);
  B.add(cyl(0.1, 0.1, 0.08, kx, y0 + 0.11, kz, 28), linA(0x8a5a30), [K_PLAIN, 0.7, 0, 0]);
  B.add(cyl(0.1, 0.1, 0.012, kx, y0 + 0.19, kz, 28), linA(0xf0e6d0), [K_PLAIN, 0.6, 0, 0]);
  return { kx, kz };
}

// Bar stools: a walnut seat on a black steel stem and ring.
function buildStools(B) {
  const steel = [K_PLAIN, 0.35, 0.8, 0], STEEL = linA(0x1c1c1e);
  for (const sx of [-2.05, -1.55, -1.05]) {
    const sz = -1.86;
    B.add(cyl(0.17, 0.17, 0.05, sx, 0.72, sz, 28), linA(0x6a4630), [K_WOOD, 0.4, 0, 0]);
    B.add(cyl(0.025, 0.025, 0.7, sx, 0.02, sz, 12), STEEL, steel);
    B.add(cyl(0.2, 0.22, 0.03, sx, 0, sz, 24), STEEL, steel);
    const ring = new THREE.TorusGeometry(0.15, 0.01, 6, 24);
    ring.rotateX(Math.PI / 2);
    ring.translate(sx, 0.3, sz);
    B.add(ring, STEEL, steel);
  }
}

// The terminals: a bench under the window, three beige CRTs turned away, their keyboards.
function buildTerminals(B) {
  const wood = [K_WOOD, 0.5, 0, 0];
  B.add(boxMM(BX0, BH - 0.04, ZB, XR, BH, BZ1), WALNUT, wood);
  B.add(boxMM(BX0, BH - 0.14, BZ1 - 0.04, XR, BH - 0.04, BZ1), mulA(WALNUT, 0.85), wood);
  for (const x of [BX0 + 0.04, XR - 0.06]) B.add(boxMM(x, 0, BZ1 - 0.08, x + 0.04, BH - 0.04, BZ1 - 0.04), mulA(WALNUT, 0.85), [K_WOOD, 0.5, 0, 1]);
  const screens = [];
  const caseM = [K_CASE, 0.55, 0, 0];
  CRT_X.forEach((cx, i) => {
    const xf = new THREE.Matrix4().makeRotationY(CRT_A).setPosition(cx, BH, CRT_Z);
    // the case: a deep box with a tapering back, a bezel round the screen
    B.add(rbox(0.4, 0.36, 0.26, 0, 0.24, 0.06, 0.02, 2), BEIGE, caseM, null, xf);
    B.add(rbox(0.32, 0.28, 0.2, 0, 0.22, -0.16, 0.03, 2), mulA(BEIGE, 0.92), caseM, null, xf);
    B.add(rbox(0.22, 0.05, 0.22, 0, 0.025, 0.0, 0.01, 2), mulA(BEIGE, 0.9), caseM, null, xf);
    // the screen: glass bulging a little out of its bezel
    const sg = new THREE.PlaneGeometry(0.31, 0.24, 6, 6);
    const p = sg.getAttribute('position');
    for (let k = 0; k < p.count; k++) {
      const u = p.getX(k) / 0.155, v = p.getY(k) / 0.12;
      p.setZ(k, 0.012 * (1 - 0.5 * u * u - 0.5 * v * v));
    }
    sg.computeVertexNormals();
    sg.translate(0, 0.25, 0.188);
    B.add(sg, [0.02, 0.02, 0.02], [K_CRT, 0.06, 0, i === 1 ? 1 : (i === 2 ? 2 : 0)], (x, y) => [(x + 0.155) / 0.31, (y - 0.13) / 0.24], xf);
    // the keyboard in front of it
    const kb = rbox(0.44, 0.03, 0.16, 0, 0.015, 0.36, 0.008, 2);
    kb.rotateX(-0.06);
    B.add(kb, mulA(BEIGE, 0.95), caseM, null, xf);
    screens.push(new THREE.Vector3(0, 0.25, 0.2).applyMatrix4(xf));
  });
  return screens;
}

// The pendants: a bottle-green enamel shade, white inside, a brass cap, a cord to the vault.
function buildPendant(B, p) {
  const shade = [[0.03, 0.2], [0.05, 0.18], [0.1, 0.12], [0.15, 0.05], [0.175, 0.0]];
  B.add(lathe(shade.map(([rr, y]) => [rr + 0.003, y]).reverse(), p.x, p.y, p.z, 40), ENAMEL, [K_ENAMEL, 0.28, 0, 0]);
  B.add(lathe(shade, p.x, p.y + 0.003, p.z, 40), [0.9, 0.88, 0.84], [K_ENAMEL, 0.4, 0, 1]);
  B.add(cyl(0.035, 0.03, 0.06, p.x, p.y + 0.19, p.z, 16), linA(0xb08a40), [K_PLAIN, 0.3, 1, 0]);
  B.add(new THREE.SphereGeometry(0.045, 16, 12).translate(p.x, p.y + 0.07, p.z), [1, 1, 1], [K_GLOW, 0, 0, G_BULB]);
  const top = vaultY(p.x);
  B.add(box(0.008, top - p.y - 0.24, 0.008, p.x, (top + p.y + 0.24) / 2, p.z), linA(0x1a1a1a), [K_PLAIN, 0.6, 0, 0]);
}

// A string of twelve bulbs along the back arch, in six swags from hooks in its
// face: in a wide picture only its ends show, in the top corners; upright, it
// rings the arch over the head.
function buildFestoon(B) {
  const pts = [], wire = [];
  const z = ZB + RIB_D + 0.03, rr = RIB_R - 0.04;
  const a0 = Math.asin(2.62 / rr), N = 6;
  const hook = (i) => { const a = -a0 + 2 * a0 * i / N; return new THREE.Vector3(rr * Math.sin(a), VYC + rr * Math.cos(a), z); };
  for (let k = 0; k < N; k++) {
    const a = hook(k), b = hook(k + 1);
    const sag = 0.16;
    for (let i = 0; i <= 12; i++) { const t = i / 12; const p = a.clone().lerp(b, t); p.y -= sag * 4 * t * (1 - t); wire.push(p); }
    for (const t of [1 / 3, 2 / 3]) { const p = a.clone().lerp(b, t); p.y -= sag * 4 * t * (1 - t); pts.push(p); }
  }
  B.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(wire), 120, 0.004, 4), linA(0x161616), [K_PLAIN, 0.6, 0, 0]);
  for (const p of pts) {
    B.add(box(0.006, 0.05, 0.006, p.x, p.y - 0.02, p.z), linA(0x161616), [K_PLAIN, 0.6, 0, 0]);
    B.add(new THREE.SphereGeometry(0.024, 10, 8).translate(p.x, p.y - 0.06, p.z), [1, 1, 1], [K_GLOW, 0, 0, G_FEST]);
  }
  pts.forEach((p) => { p.y -= 0.06; });
  // as three sources for the light they throw: the arch's feet and its crown
  const mid = [new THREE.Vector3(-2.15, 2.25, z + 0.3), new THREE.Vector3(0, 3.0, z + 0.3), new THREE.Vector3(2.15, 2.25, z + 0.3)];
  return { pts, mid };
}

// The walnut table across the front, a cup of coffee on its saucer.
function buildTable(B) {
  B.add(rbox(TAB.x1 - TAB.x0, 0.045, TAB.z1 - TAB.z0, (TAB.x0 + TAB.x1) / 2, TAB.y - 0.022, (TAB.z0 + TAB.z1) / 2, 0.015, 3), mulA(WALNUT, 1.1), [K_WOOD, 0.72, 0, 0]);
  B.add(lathe([[0, 0], [0.05, 0], [0.075, 0.006], [0.078, 0.012], [0, 0.012]], CUP.x, CUP.y, CUP.z, 32), PORCELAIN, [K_PLAIN, 0.18, 0, 0]);
  B.add(lathe([[0, 0], [0.026, 0], [0.04, 0.02], [0.043, 0.06], [0.04, 0.062], [0.036, 0.06], [0, 0.055]], CUP.x, CUP.y + 0.012, CUP.z, 32), PORCELAIN, [K_PLAIN, 0.18, 0, 0]);
  const handle = new THREE.TorusGeometry(0.016, 0.004, 6, 12, Math.PI);
  handle.rotateZ(-Math.PI / 2);
  handle.translate(CUP.x + 0.042, CUP.y + 0.045, CUP.z);
  B.add(handle, PORCELAIN, [K_PLAIN, 0.18, 0, 0]);
  B.add(cyl(0.037, 0.037, 0.004, CUP.x, CUP.y + 0.05, CUP.z, 24), linA(0x2a160c), [K_PLAIN, 0.15, 0, 0]);
}

// Outside: the street up the hill, the far pavement, the facades, balconies,
// a wall lantern, a scooter; the sky over the roofs; the tram (its own kind).
function buildOutside(B, r) {
  const st = new THREE.PlaneGeometry(40, FAC_Z + PAVE_W - ZO + 0.4, 20, 8);
  st.rotateX(-Math.PI / 2);
  st.translate(4, 0, (FAC_Z + PAVE_W + ZO) / 2);
  const sp = st.getAttribute('position');
  for (let i = 0; i < sp.count; i++) sp.setY(i, streetY(sp.getX(i)));
  st.computeVertexNormals();
  B.add(st, [0.3, 0.3, 0.3], [K_STREET, 0.8, 0, 0]);
  // the far pavement, raised behind its kerb
  const pv = new THREE.BoxGeometry(40, 0.3, PAVE_W, 20, 1, 1);
  pv.translate(4, -0.01, FAC_Z + PAVE_W / 2);
  const pp = pv.getAttribute('position');
  for (let i = 0; i < pp.count; i++) pp.setY(i, pp.getY(i) + streetY(pp.getX(i)));
  B.add(pv, [0.6, 0.58, 0.54], [K_STREET, 0.8, 0, 1]);
  // the facades: one plane, cells that grow with distance
  const fac = new THREE.PlaneGeometry(40, 22, 20, 8);
  fac.translate(4, 10.5, FAC_Z);
  B.add(fac, [0.5, 0.5, 0.5], [K_FACADE, 0.8, 0, 0]);
  // balconies on the upper floors
  for (let bi = -2; bi <= 3; bi++) {
    const base = ST0 + GRADE * (FB0 + (bi + 0.5) * 6.6 - WCX) + 0.14;
    for (let fl = 0; fl < 4; fl++) for (let bay = 0; bay < 3; bay++) {
      const x = FB0 + bi * 6.6 + bay * 2.2 + 1.1, y = base + 4.2 + fl * 3.3;
      B.add(boxMM(x - 0.82, y - 0.08, FAC_Z, x + 0.82, y, FAC_Z + 0.55), linA(0xc8c0b0), [K_PLAIN, 0.8, 0, 0]);
    }
  }
  // the wall lantern on its bracket
  const lx = LAMP.x, ly = LAMP.y;
  B.add(boxMM(lx - 0.02, ly + 0.25, FAC_Z, lx + 0.02, ly + 0.29, LAMP.z), linA(0x101010), [K_PLAIN, 0.5, 0.6, 0]);
  B.add(lathe([[0.0, 0], [0.09, 0.02], [0.12, 0.22], [0.15, 0.24], [0.0, 0.3]], lx, ly - 0.05, LAMP.z, 6), linA(0x101010), [K_PLAIN, 0.5, 0.6, 0]);
  B.add(lathe([[0.0, 0], [0.085, 0.03], [0.11, 0.21], [0.0, 0.21]], lx, ly - 0.03, LAMP.z, 6), [1, 1, 1], [K_GLOW, 0, 0, G_LAMP]);
  // a scooter on the pavement, cream and red
  const sx = 6.7, sz = FAC_Z + 0.75, sy = streetY(sx) + 0.14;
  const xf = new THREE.Matrix4().makeRotationZ(TRAM_G).setPosition(sx, sy, sz);
  B.add(rbox(0.9, 0.42, 0.34, 0.1, 0.42, 0, 0.12, 3), linA(0xe8dcc0), [K_PLAIN, 0.3, 0, 0], null, xf);
  B.add(rbox(0.5, 0.1, 0.26, 0.15, 0.68, 0, 0.04, 2), linA(0x3a1a14), [K_PLAIN, 0.6, 0, 0], null, xf);
  B.add(rbox(0.12, 0.62, 0.3, -0.42, 0.5, 0, 0.05, 2), linA(0xa82a24), [K_PLAIN, 0.3, 0, 0], null, xf);
  for (const wx of [-0.48, 0.5]) {
    const w = new THREE.CylinderGeometry(0.2, 0.2, 0.1, 18);
    w.rotateX(Math.PI / 2);
    B.add(w, linA(0x141414), [K_PLAIN, 0.8, 0, 0], null, new THREE.Matrix4().makeRotationZ(TRAM_G).setPosition(sx + wx, sy + 0.2 + wx * GRADE, sz));
  }
  // the sky beyond the roofs
  const sky = new THREE.PlaneGeometry(240, 120, 6, 3);
  sky.translate(0, 40, -90);
  B.add(sky, [0, 0, 0], [K_SKY, 1, 0, 0]);
  r();
}

// The tram, at its stop (the shader moves it along the street): a yellow body,
// a cream band over the windows, a grey roof, its trolley pole raised.
function buildTram(B) {
  const xf = new THREE.Matrix4().makeRotationZ(TRAM_G).setPosition(TRAM_X, streetY(TRAM_X) + 0.03, RAIL_Z);
  const uvT = (x, y) => [x, y];
  B.add(rbox(8.0, 2.5, 2.3, 0, 0.42 + 1.25, 0, 0.22, 3), YELLOW, [K_TRAM, 0.35, 0, 0], uvT, xf);
  B.add(rbox(7.5, 0.24, 2.0, 0, 2.95, 0, 0.1, 2), [0.4, 0.4, 0.38], [K_TRAM, 0.5, 0, 1], uvT, xf);
  B.add(boxMM(-2.8, 0.05, -0.9, 2.8, 0.46, 0.9), [0.05, 0.05, 0.05], [K_TRAM, 0.7, 0, 2], uvT, xf);
  const pole = box(0.05, 3.2, 0.05, 0, 1.6, 0);
  pole.rotateZ(-1.1);
  pole.translate(-1.5, 3.05, 0);
  B.add(pole, [0.06, 0.06, 0.06], [K_TRAM, 0.5, 0.5, 3], uvT, xf);
  // where its headlamps are (for the glows), in the street's frame
  return [new THREE.Vector3(4.02, 1.25, 0.6), new THREE.Vector3(4.02, 1.25, -0.6)].map((v) => v.applyMatrix4(xf));
}

// The tram's offset along the street at time t: it comes up the hill every two
// minutes, waits forty seconds in the window, and goes on.
function tramAt(t) {
  const P = 120, tt = ((t % P) + P) % P;
  const A0 = 18, A1 = 25, D0 = 65, D1 = 72, L = 26;
  let s;
  if (tt < A0) s = -200;
  else if (tt < A1) { const u = (A1 - tt) / (A1 - A0); s = -L * u * u; }
  else if (tt < D0) s = 0;
  else if (tt < D1) { const u = (tt - D0) / (D1 - D0); s = L * u * u; }
  else s = 200;
  return s;
}

// How many samples the room's target can have: up to 8, as many as the colour
// format allows here. None on a software GPU: there the samples cost the CPU
// 40 % of a redraw (SwiftShader, 512x288: 104 -> 64 ms), time the pipeline
// needs to keep the effect running at all.
function msaaSamples(k, float) {
  const gl = k.renderer.getContext();
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    if (/swiftshader|llvmpipe|softpipe|software|basic render|warp/i.test(name)) return 0;
    const fmt = float ? gl.RGBA16F : gl.RGBA8;
    const list = gl.getInternalformatParameter(gl.RENDERBUFFER, fmt, gl.SAMPLES);
    const max = list && list.length ? Math.max(...list) : 0;
    return Math.min(8, max, k.renderer.capabilities.maxSamples || 0);
  } catch (e) { return 0; }
}

// --- the scene -----------------------------------------------------------------------------------------------

export default {
  id: 'cybercafe',
  camera: {
    pos: [0, EYE, 0],
    target: [0, EYE - Math.sin(PITCH) * 10, -Math.cos(PITCH) * 10],
    fov: 50, near: 0.08, far: 300
  },
  nearness: [4.2, 20],

  build(k) {
    const st = {};
    const S = k.scene;

    const B = new Buf();
    // nearest first: one draw, so its order is the only early depth test there is
    buildTable(B);
    buildStools(B);
    const cake = buildMachine(B);
    st.items = buildBar(B, k.rng(SEED + 1));
    const screens = buildTerminals(B);
    PEND.forEach((p) => buildPendant(B, p));
    const fest = buildFestoon(B), bulbs = fest.pts;
    buildWindow(B);
    buildShell(B);
    buildOutside(B, k.rng(SEED + 2));
    const heads = buildTram(B);

    const aoBox = [
      new THREE.Vector4((XL + CX1) / 2, (CF + CB) / 2, (CX1 - XL) / 2, (CF - CB) / 2),
      new THREE.Vector4(EM.x, EM.z, 0.33, 0.22),
      new THREE.Vector4((BX0 + XR) / 2, (ZB + BZ1) / 2, (XR - BX0) / 2, (BZ1 - ZB) / 2),
      new THREE.Vector4(CRT_X[1], CRT_Z, 0.9, 0.2),
      new THREE.Vector4(CUP.x, CUP.z, 0.06, 0.06),
      new THREE.Vector4(cake.kx, cake.kz, 0.08, 0.08)
    ];
    const aoBoxY = [
      new THREE.Vector4(0.0, 0.45), new THREE.Vector4(CH, 0.45), new THREE.Vector4(0.0, 0.4),
      new THREE.Vector4(BH, 0.45), new THREE.Vector4(TAB.y, 0.5), new THREE.Vector4(CH, 0.4)
    ];
    const wc = [[WX0, WY0], [WX1, WY0], [WX1, WYS]];
    for (const a of [Math.PI / 4, Math.PI / 2, 3 * Math.PI / 4]) wc.push([WCX + WRAD * Math.cos(a), WYS + WRAD * Math.sin(a)]);
    wc.push([WX0, WYS]);
    const neonP = [[0, 0.0], [-0.12, 0.1], [0.12, 0.1], [0, 0.22]].map(([x, y]) => new THREE.Vector4(NEON.x + x, NEON.y + y, NEON.z + 0.04, 0));
    const U = {
      uWc: { value: wc.map(([x, y]) => new THREE.Vector3(x, y, ZB)) },
      uWinRad: { value: new THREE.Color() },
      uDoor: { value: new THREE.Vector4(2.5, 1.3, ZF, 5.2) },
      uDoorRad: { value: new THREE.Color() },
      uNeonP: { value: neonP },
      uNeonL: { value: new THREE.Color() },
      uCrtP: { value: screens.map((p, i) => new THREE.Vector4(p.x, p.y, p.z, i === 1 ? 1 : 0)) },
      uCrtN: { value: new THREE.Vector3(Math.sin(CRT_A), 0, Math.cos(CRT_A)) },
      uCrtG: { value: new THREE.Color() }, uCrtA: { value: new THREE.Color() },
      uCrt: { value: new THREE.Vector2(1, 0) },
      uLed: { value: new THREE.Vector4(0, 0, 0, 0) },
      uGlowC: { value: Array.from({ length: 8 }, () => new THREE.Color()) },
      uAoBox: { value: aoBox }, uAoBoxY: { value: aoBoxY },
      uIbl: { value: new THREE.Vector4(1, 1, 1, 0) },
      uFestP: { value: fest.mid.map((p) => new THREE.Vector4(p.x, p.y, p.z, 0)) }, uFestL: { value: new THREE.Color() },
      uSunO: { value: new THREE.Color() }, uSunDirO: { value: new THREE.Vector3(0.55, 0.32, 0.77).normalize() },
      uSkyAmb: { value: new THREE.Color() }, uOutRefl: { value: new THREE.Color() },
      uLampO: { value: new THREE.Vector4(LAMP.x, LAMP.y + 0.08, LAMP.z, 0) }, uLampC: { value: new THREE.Color() },
      uFacLit: { value: new THREE.Color() }, uTramLit: { value: new THREE.Color() },
      uSkyLo: { value: new THREE.Color() }, uSkyHi: { value: new THREE.Color() },
      uTram: { value: new THREE.Vector2(0, 0) }
    };
    st.U = U;
    const worldM = k.std({ vertexColors: true, roughness: 1, metalness: 0, side: THREE.DoubleSide, patch: WORLD_PATCH(U) });
    const world = new THREE.Mesh(B.geometry(), worldM);
    world.frustumCulled = false;
    S.add(world);

    // --- glass: the window's panes, the cake's dome
    {
      const s = new THREE.Shape();
      s.moveTo(WX0, WY0); s.lineTo(WX1, WY0); s.lineTo(WX1, WYS);
      s.absarc(WCX, WYS, WRAD, 0, Math.PI, false);
      s.lineTo(WX0, WY0);
      const pane = new THREE.Mesh(new THREE.ShapeGeometry(s, 24), K.glass(k, { tint: 0xa8b0b0, opacity: 0.07, env: 1 }));
      pane.position.z = ZG + 0.002;
      pane.renderOrder = 20;
      S.add(pane);
      const dome = new THREE.Mesh(lathe([[0.13, 0], [0.13, 0.12], [0.11, 0.2], [0.06, 0.25], [0.02, 0.26], [0.02, 0.29], [0, 0.3]], cake.kx, CH + 0.11, cake.kz, 32),
        K.glass(k, { tint: 0xd8dcd8, opacity: 0.1, env: 1 }));
      dome.renderOrder = 21;
      S.add(dome);
    }

    // --- the pendants: spot lights straight down
    st.spots = PEND.map((p) => {
      const s = new THREE.SpotLight(0xffb36b, 0, 9, 56 * D2R, 0.6, 2);
      s.position.set(p.x, p.y + 0.05, p.z);
      // each aimed a little outward, so its pool falls on the bar or the bench, not behind you
      s.target.position.set(p.x + Math.sign(p.x) * 0.45, 0, p.z + 0.1);
      S.add(s, s.target);
      return s;
    });

    // --- the glows: halos, steam, the puff, the neon, the tram's lamps
    {
      const P = [], UV = [], G = [], L = [];
      const quad = (p, kind, rad, ph, ci) => {
        for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]]) { P.push(p.x, p.y, p.z); UV.push(u, v); G.push(kind, rad, ph, ci); L.push(0, 0); }
      };
      PEND.forEach((p) => quad(new THREE.Vector3(p.x, p.y + 0.02, p.z), 0, 0.3, 0, G_BULB));
      bulbs.forEach((p) => quad(new THREE.Vector3(p.x, p.y - 0.02, p.z + 0.03), 0, 0.075, 0, G_FEST));
      quad(new THREE.Vector3(LAMP.x, LAMP.y + 0.08, LAMP.z + 0.05), 0, 0.5, 0, G_LAMP);
      screens.forEach((p, i) => quad(p.clone().add(new THREE.Vector3(0.03, 0, 0.05)), 0, 0.26, 0, i === 1 ? 7 : 6));
      heads.forEach((p) => quad(p, 4, 0.22, 0, G_HEAD));
      // the steam over the cup, the machine's puff by its wand
      quad(new THREE.Vector3(CUP.x, CUP.y + 0.07, CUP.z), 1, 0.07, 1.3, 0);
      quad(new THREE.Vector3(EM.x + 0.37, CH + 0.1, EM.z + 0.26), 2, 0.2, 17.0, 0);
      // the neon: one quad on the wall, the tubes drawn by distance
      const nw = 0.66, nh = 0.6;
      for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]]) {
        const lx = (u - 0.5) * nw, ly = (v - 0.4) * nh;
        P.push(NEON.x + lx, NEON.y + ly, NEON.z); UV.push(u, v); G.push(3, 0, 0, 0); L.push(lx, ly);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
      g.setAttribute('aG', new THREE.Float32BufferAttribute(G, 4));
      g.setAttribute('aL', new THREE.Float32BufferAttribute(L, 2));
      const glowU = {
        uGC: { value: Array.from({ length: 8 }, () => new THREE.Color()) },
        uTram: U.uTram,
        uSeg: { value: NEON_SEGS.map((s) => new THREE.Vector4(...s)) },
        uNeon: { value: new THREE.Vector4(1, 0.3, 0.62, 1) },
        uSteamC: { value: new THREE.Color() }
      };
      const glowM = k.shader({
        uniforms: glowU, transparent: true, additive: true, depthWrite: false,
        vertexShader: k.GLSL_VERTEX + GLOW_DECL + GLOW_VERT,
        fragmentShader: k.GLSL_FRAGMENT + GLOW_DECL + GLOW_FRAG
      });
      const m = new THREE.Mesh(g, glowM);
      m.frustumCulled = false;
      m.renderOrder = 30;
      S.add(m);
      st.glowU = glowU;
    }

    // --- the room's environment, baked for the afternoon and the evening
    st.envAt = -1;
    st.bakeEnv = (night) => {
      const q = Math.round(night * 4) / 4;
      if (q === st.envAt) return false;
      st.envAt = q;
      const day = 1 - q;
      const comp = 2.6 * q + (1 - q);
      const pend = mulA(linA(0xffb36b), 3.2 * (0.2 * day + comp * q));
      const tex = envPicture({
        outside: mixA(mulA(shows(0xb8a888).toArray(), 1), mulA(shows(0x1c2436, 0.25).toArray(), 1), q),
        door: mixA(shows(0xf4f0e8, 1, 1.3).toArray(), shows(0x101622, 0.25).toArray(), q),
        win: mulA([0.86, 0.92, 1.0], 5.0 * day + 0.3 * q),
        bounce: mixA([0.78, 0.76, 0.72], [0.55, 0.4, 0.26], q),
        lamps: PEND.map((p) => ({ p, c: pend })),
        spots: [
          ...PEND.map((p) => ({ p, r: 0.14, c: mulA(linA(0xfff0d8), 4 + 30 * q) })),
          { p: new THREE.Vector3(NEON.x, NEON.y, ZB), r: 0.22, c: mulA([1.0, 0.3, 0.62], 1.2 + 2.0 * q) },
          ...screens.map((p, i) => ({ p, r: 0.13, c: i === 1 ? mulA([1.0, 0.56, 0.12], 0.8 + 1.2 * q) : mulA([0.36, 1.0, 0.55], 0.8 + 1.2 * q) }))
        ]
      });
      const prev = S.environment;
      k.environment(tex, 1);
      tex.dispose();
      if (prev && prev !== S.environment) prev.dispose();
      return true;
    };
    st.bakeEnv(0);

    // --- the room, drawn with multisampling into its own target, then copied
    // into the engine's (see office.js: the jittered redraws then disagree far
    // less about every edge, which is what a still room costs the encoder).
    // The room lives on layer 1; the lights are on every layer.
    S.traverse((o) => { if (o.isLight) o.layers.enableAll(); else o.layers.set(1); });
    {
      const float = !!(k.renderer.extensions.has('EXT_color_buffer_float') || k.renderer.extensions.has('EXT_color_buffer_half_float'));
      const rt = k.track(new THREE.WebGLRenderTarget(2, 2, {
        type: float ? THREE.HalfFloatType : THREE.UnsignedByteType, depthBuffer: true,
        samples: k.quality.name === 'thumb' ? 0 : msaaSamples(k, float), minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false
      }));
      const tri = new THREE.BufferGeometry();
      tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
      const copyM = k.shader({
        uniforms: { uRoom: { value: rt.texture } },
        vertexShader: k.GLSL_VERTEX + 'void main() { gl_Position = vec4(position.xy, 0.8, 1.0); }',
        fragmentShader: k.GLSL_FRAGMENT + 'uniform sampler2D uRoom;\nvoid main() { gl_FragColor = texelFetch(uRoom, ivec2(gl_FragCoord.xy), 0); }'
      });
      const copy = new THREE.Mesh(tri, copyM);
      copy.frustumCulled = false;
      const cam = new THREE.PerspectiveCamera();
      let busy = false;
      copy.onBeforeRender = (renderer, scene, camera) => {
        if (busy) return;
        const cur = renderer.getRenderTarget();
        const w = cur ? cur.width : 512, h = cur ? cur.height : 288;
        if (rt.width !== w || rt.height !== h) rt.setSize(w, h);
        cam.copy(camera);
        cam.projectionMatrix.copy(camera.projectionMatrix);
        cam.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
        cam.layers.set(1);
        busy = true;
        renderer.setRenderTarget(rt);
        renderer.clear();
        renderer.render(S, cam);
        renderer.setRenderTarget(cur);
        busy = false;
      };
      S.add(copy);
    }

    st.tmp = new THREE.Color();
    return st;
  },

  update(k, st, t, look) {
    const n = look.night, E = look.exposure;
    const day = 1 - n;
    const hard = sstep(0.06, 0.5, look.key);
    // emissives are dimmed less than surfaces; the evening's lights are
    // designed at a dark room's exposure, so they are compensated for it
    const comp = (0.65 + 0.35 * E) / E;
    const U = st.U, G = st.glowU, tmp = st.tmp;
    const on = sstep(0.1, 0.75, n);
    // the window: the street in shade by day, deep blue at night
    U.uWinRad.value.setRGB(0.86, 0.92, 1.0).multiplyScalar(3.0 * day).add(tmp.setRGB(0.22, 0.26, 0.42).multiplyScalar(0.5 * comp * n));
    // the door behind you: the low sun on the square, as directional as your light
    U.uDoorRad.value.setRGB(1.0, 0.94, 0.86).multiplyScalar((4.4 + 3.6 * hard) * day);
    // the pendants: a fifth by day, full at night
    const pend = 0.2 * day + comp * n;
    st.spots.forEach((s) => { s.intensity = 7.0 * pend; });
    U.uGlowC.value[G_BULB].setRGB(1.0, 0.82, 0.58).multiplyScalar(6.0 * (0.25 + 0.75 * on));
    U.uGlowC.value[G_SHADE].setRGB(1.0, 0.78, 0.5).multiplyScalar(1.4 * (0.25 + 0.75 * on));
    U.uGlowC.value[G_FEST].setRGB(1.0, 0.7, 0.4).multiplyScalar(3.0 * (0.35 + 0.65 * on));
    U.uGlowC.value[G_LED].setRGB(1.0, 0.72, 0.42).multiplyScalar(2.0 * on);
    U.uGlowC.value[G_LAMP].setRGB(1.0, 0.76, 0.46).multiplyScalar(0.3 + 4.0 * on);
    U.uGlowC.value[G_HEAD].setRGB(1.0, 0.92, 0.75).multiplyScalar(2.0 + 2.0 * on);
    U.uFestL.value.setRGB(1.0, 0.68, 0.38).multiplyScalar(0.12 * (0.3 * day + comp * n));
    U.uLed.value.set(1.0 * comp * on, 0.7 * comp * on, 0.4 * comp * on, on);
    // the neon: 60% by day, full at night, breathing a little
    const neon = (0.6 + 0.4 * on) * (1 + 0.05 * Math.sin(t * Math.PI / 2));
    G.uNeon.value.w = neon;
    U.uNeonL.value.setRGB(1.0, 0.3, 0.6).multiplyScalar(0.1 * (0.5 * day + comp * n));
    // the screens
    U.uCrt.value.set(1.6 * (0.7 + 0.3 * on), t);
    U.uCrtG.value.setRGB(0.36, 1.0, 0.55).multiplyScalar(0.05 * (0.4 * day + comp * n));
    U.uCrtA.value.setRGB(1.0, 0.56, 0.12).multiplyScalar(0.05 * (0.4 * day + comp * n));
    // the bounce
    if (st.bakeEnv(n)) k.renderer.resetState();
    k.scene.environmentIntensity = (0.68 - 0.22 * hard) * day + 1.0 * comp * n;
    U.uIbl.value.set(1.0, 1.0, 1.0, 0);
    // the street
    U.uSunO.value.setRGB(1.0, 0.72, 0.42).multiplyScalar(9.0 * day);
    U.uSkyAmb.value.setRGB(1.5, 1.7, 2.1).multiplyScalar(day).add(tmp.setRGB(0.36, 0.28, 0.24).multiplyScalar(comp * n));
    U.uOutRefl.value.setRGB(0.5, 0.56, 0.66).multiplyScalar(day).add(tmp.setRGB(0.05, 0.07, 0.12).multiplyScalar(comp * n));
    U.uLampC.value.setRGB(1.0, 0.72, 0.4).multiplyScalar(6.0 * comp * on);
    U.uFacLit.value.setRGB(1, 1, 1).multiplyScalar(0.75 * sstep(0.25, 0.8, n) + 0.05);
    U.uTramLit.value.setRGB(1.0, 0.7, 0.4).multiplyScalar(0.12 + 0.75 * on);
    U.uSkyLo.value.copy(shows(0xd8c8b0)).multiplyScalar(day).add(tmp.copy(shows(0x1c2638, 0.25)).multiplyScalar(n));
    U.uSkyHi.value.copy(shows(0x9ab4cc)).multiplyScalar(day).add(tmp.copy(shows(0x0e1420, 0.25)).multiplyScalar(n));
    // the tram
    const s = tramAt(t);
    U.uTram.value.set(s * Math.cos(TRAM_G), s * Math.sin(TRAM_G));
    // the steam is lit by the room
    G.uSteamC.value.setRGB(1.0, 0.9, 0.78).multiplyScalar(0.9 * day + 0.5 * comp * n);
    for (let i = 0; i < 8; i++) G.uGC.value[i].copy(U.uGlowC.value[i]);
    G.uGC.value[6].setRGB(0.36, 1.0, 0.55).multiplyScalar(0.12 * (0.6 + 0.4 * on));
    G.uGC.value[7].setRGB(1.0, 0.56, 0.12).multiplyScalar(0.12 * (0.6 + 0.4 * on));
    G.uGC.value[G_BULB].multiplyScalar(0.08);
    G.uGC.value[G_FEST].multiplyScalar(0.12);
    G.uGC.value[G_LAMP].multiplyScalar(0.1);
    G.uGC.value[G_HEAD].multiplyScalar(0.2);
  }
};
