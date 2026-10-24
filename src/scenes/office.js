// office.js — "Office": an architect's home studio in a 1900s Copenhagen flat,
// 10:30 on an October morning.
//
// Warm-neutral and orthogonal: lime-washed walls, white-oak planks, built-in
// oak shelving full of books on the left, a cord lounge chair in front of it,
// a paper lantern hanging over the room, a low oak sideboard behind your
// shoulders, and on the right a tall steel window in the side wall with a
// fiddle-leaf fig in the corner. The low autumn sun comes in through that
// window from behind your right shoulder and lays a mullioned parallelogram on
// the lower back wall and the floor, dappled where a street linden stands in
// its way. Through the glass: the linden turning gold, an ochre brick facade
// with white sashes across the street, a strip of sky. In a dark room it is
// the blue hour: the window goes deep blue, a third of the windows across are
// lit, the brass lamp on the shelves and the lantern come on.
//
// Behind the head there is only the wall: lime-wash, a gradient of light from
// the window, the top of the sideboard below the shoulders. Interest is at
// the sides (shelves, window, fig) and in the upper corners (lantern, window
// head, fig crown).
//
// Authored with the key light on +x (the engine mirrors the picture for a
// light on the left). Metres; the floor is y = 0, the camera is 1.2 m up,
// looking down -z at the back wall 3.8 m away, turned 6 degrees toward the
// window and 2.5 degrees down.
//
// How it is lit (one material for the whole world, patched):
//   * the sun is a DirectionalLight; WHERE it gets in is analytic: a point is
//     sunlit if the ray toward the sun passes through the opening in the
//     wall's inner face, the opening in its outer face (the reveal cuts the
//     oblique beam) and between the steel bars of the glass plane, each a
//     box-filtered test whose width is the penumbra over the distance and two
//     of the buffer's pixels; the linden's dapple is a soft pattern where the
//     same ray crosses the tree. Nothing in it is per-redraw noise. (The light
//     casts a shadow map, empty, because that is where the test rides: on
//     Three's getShadow(), see WORLD_PATCH.)
//   * the window's daylight is the exact diffuse irradiance of a rectangle
//     (the opening as a polygon, Lambert's formula), so the room falls off
//     away from the window as a room does;
//   * the room's own bounce is an environment picture of this room, baked on
//     the CPU from the same two lights, with a soft corner occlusion;
//   * at night, the lantern (a point light) and the brass lamp, whose light
//     leaves its shelf only through the compartment's open front.
//
// What a still room costs every receiver (see the measurements in the
// comments): the room is drawn with 4-8x multisampling into its own target
// and copied into the engine's, and the subject's shadow weight (alpha) is a
// smooth function of position, never of material.
//
// Programs: sky, world, glass, glow (halos, motes), beam, the copy, and
// Three's shadow depth.

import { THREE } from './engine.js';
import * as K from './kit.js';

const SEED = 0x0ff1ce;
const D2R = Math.PI / 180;

// --- the room ---------------------------------------------------------------------------------
const XL = -3.0, XR = 2.0, ZB = -3.8, ZF = 1.6, CEIL = 2.95;
const EYE = 1.2, PITCH = 2.5 * D2R, YAW = 6 * D2R;
// The window in the right wall: its opening (z0..z1 along the wall, sill y0,
// head y1), the plane of the glass and its steel frame, the wall's outer face.
const WZ0 = -3.42, WZ1 = -1.84, WY0 = 0.62, WY1 = 2.70, WXG = 2.11, WXO = 2.38;
const COLS = 3, ROWS = 4, BAR = 0.022;
// Outside: the facade across the street, our floor 6.4 m above it, the linden
// whose crown dapples the sun (as a plane the sun's rays cross) and the one
// seen through the glass.
const FAC_X = 20.5, STREET = -6.4, TREE_X = 6.4, CROWN_Y = 5.35;
// The sun at 10:30 in October: 27 degrees up, from the window's side and from
// behind the camera, so its light runs away from you toward the back wall.
const SUN_E = 27 * D2R, SUN_A = 58 * D2R;
const SUN = new THREE.Vector3(Math.cos(SUN_E) * Math.cos(SUN_A), Math.sin(SUN_E), Math.cos(SUN_E) * Math.sin(SUN_A)).normalize();
// The shelving (built in, on the back wall, from the left corner), the sideboard, the fig.
const SH_X1 = -0.86, SH_D = 0.34, SH_H = 2.42;
const SB = { x0: -0.62, x1: 1.02, d: 0.44, h: 0.52 };
const FIG = { x: 1.47, z: -2.62 };
const LANTERN = new THREE.Vector3(-0.3, 2.44, -2.5);
const LAMP = new THREE.Vector3(-1.86, 0, -3.62);   // y set from the shelf

// --- colours ----------------------------------------------------------------------------------
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

// Albedos (linear).
const WALL = linA(0xe6ded2), OAK = linA(0xc8a27a), OAK_D = linA(0xb08a62), LINEN = linA(0xd8cdbb);
const SAGE = linA(0x8a9a7b), TERRA = linA(0xb5603a), STEEL = linA(0x4c4f52);
const BRASS = linA(0xc9a15a), PAPER = linA(0xf2ece2), WOOL = linA(0xd6cbb6);

// Material kinds (aMat.x), read by the world shader.
const K_PLAIN = 0, K_LIME = 1, K_FLOOR = 2, K_OAK = 3, K_BOOK = 4, K_RUG = 5, K_CORD = 6, K_LEAF = 7,
  K_FACADE = 8, K_TREE = 9, K_STEEL = 10, K_PAPER = 12, K_OPAL = 13, K_GLAZE = 11;

// --- geometry: one buffer for the whole world -----------------------------------------------------
//
// Per vertex: colour (linear albedo), aMat (kind, roughness, metalness,
// receiver = the subject's shadow weight) and aSway (pivot height, amplitude:
// > 0 radians for the fig's bend, < 0 metres for the linden's drift, phase,
// a parameter the kind reads).
class Buf {
  constructor() { this.parts = []; }
  add(g, rgb, mat, sway = [0, 0, 0, 0]) {
    const G = g.index ? g.toNonIndexed() : g;
    if (G !== g) g.dispose();
    for (const n of Object.keys(G.attributes)) if (n !== 'position' && n !== 'normal') G.deleteAttribute(n);
    if (!G.getAttribute('normal')) G.computeVertexNormals();
    const n = G.getAttribute('position').count;
    const C = new Float32Array(n * 3), M = new Float32Array(n * 4), S = new Float32Array(n * 4);
    const pos = G.getAttribute('position');
    for (let i = 0; i < n; i++) {
      const c = typeof rgb === 'function' ? rgb(pos.getX(i), pos.getY(i), pos.getZ(i)) : rgb;
      C[i * 3] = c[0]; C[i * 3 + 1] = c[1]; C[i * 3 + 2] = c[2];
      M.set(mat, i * 4); S.set(sway, i * 4);
    }
    G.setAttribute('color', new THREE.BufferAttribute(C, 3));
    G.setAttribute('aMat', new THREE.BufferAttribute(M, 4));
    G.setAttribute('aSway', new THREE.BufferAttribute(S, 4));
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
// A box by its min and max corners.
const boxMM = (x0, y0, z0, x1, y1, z1) => box(x1 - x0, y1 - y0, z1 - z0, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
const rbox = (w, h, d, x, y, z, r = 0.01, seg = 2) => {
  const g = new THREE.RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4));
  g.translate(x, y, z);
  return g;
};
// A smooth body of revolution from a profile [[r, y], ...], around the y axis at (x, y0, z).
const lathe = (prof, x, y0, z, seg = 28) => {
  const g = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), seg);
  g.translate(x, y0, z);
  return g;
};

// --- the world shader ----------------------------------------------------------------------------

const WORLD_VERT_HEAD = `
attribute vec4 aMat; attribute vec4 aSway;
varying vec4 vMat; varying float vPar;
`;
const WORLD_VERT = `
vMat = aMat; vPar = aSway.w;
if (aSway.y > 0.0) {
  // the fig: the whole plant bends from its pot, each leaf a little on its own
  float g = 0.72 * sin(6.2832 * uTime / 8.3) + 0.28 * sin(6.2832 * uTime / 13.1 + 1.3);
  float l = sin(6.2832 * uTime / 6.7 + aSway.z * 6.2832);
  float ang = aSway.y * (1.0 + 3.0 * uMotion) * (g + 0.12 * l);
  float h = max(transformed.y - aSway.x, 0.0);
  transformed.x += h * ang;
  transformed.z += h * ang * 0.45;
} else if (aSway.y < 0.0) {
  // the linden: a slow drift of a couple of centimetres
  float a = -aSway.y;
  transformed.x += a * sin(6.2832 * uTime / 6.7 + aSway.z);
  transformed.z += a * 0.7 * sin(6.2832 * uTime / 9.1 + 1.7 * aSway.z);
}
`;

const WORLD_FRAG_HEAD = `
varying vec4 vMat; varying float vPar;
uniform vec3 uSunL;        // toward the sun (world)
uniform vec4 uWinZY;       // the opening: z0, z1, y0, y1
uniform vec4 uWinX;        // inner face, glass, outer face, the dappling crown's plane
uniform vec4 uBars;        // columns, rows, bar width (m), the glass's transmission
uniform vec4 uDapple;      // strength, the crown's lower edge (m), drift x, drift y
uniform vec3 uWc0; uniform vec3 uWc1; uniform vec3 uWc2; uniform vec3 uWc3;   // the glass, as a polygon
uniform vec3 uWinRad;      // the window's mean radiance (daylight in, blue hour)
uniform vec4 uIbl;         // diffuse share of the environment, specular share, corner occlusion, sky on the facade
uniform vec3 uLantern;     // the paper's glow at night
uniform vec3 uOpal;        // the brass lamp's opal globe
uniform vec3 uFacLit;      // the windows across the street at night
uniform vec4 uRug;         // x0, z0, x1, z1
uniform vec4 uFacSun;      // the facade's sun (rgb) on its upper floors, w: unused
uniform vec4 uAoBox[6];    // contact shadows: centre x, z, half size x, z (on the floor and the wall behind)
uniform vec4 uAoBoxY[6];   // their height (top), strength
uniform vec3 uOutAmb;      // outside: the sky's irradiance on a wall
uniform vec3 uOutRefl;     // outside: what glass and slate reflect
uniform vec3 uTreeTrans;   // the linden, lit through from behind

// Static patterns are filtered by the BUFFER's pixel: detail the jittered
// redraws disagree about is churn every receiver pays for (see facadePatch()).
vec2 bufPx2(vec2 x) { return max(fwidth(x) * 1.25, vec2(1e-5)); }
float bufPx(float x) { return max(fwidth(x) * 1.25, 1e-5); }
float boxF(float x, float lo, float hi, float w) {
  return clamp((min(x + 0.5 * w, hi) - max(x - 0.5 * w, lo)) / w, 0.0, 1.0);
}
// Where the ray from P toward the sun crosses the plane x = X: (z, y, distance along x).
vec3 sunAt(vec3 P, float X) {
  float s = (X - P.x) / uSunL.x;
  return vec3(P.z + s * uSunL.z, P.y + s * uSunL.y, s);
}
// Steel bars: the share of [u - w/2, u + w/2] that is NOT behind a bar at
// lo + k (hi - lo) / n, k = 0..n, each bw wide.
float bars(float u, float lo, float hi, float n, float bw, float w) {
  float per = (hi - lo) / n;
  float h = 0.5 * bw / per;
  return 1.0 - pulse((u - lo) / per + h, 0.0, 2.0 * h, max(w / per, 1e-4));
}
// How much of the sun reaches P: through both faces of the opening, between
// the bars, through the glass and the linden. Box-filtered by the penumbra
// (the sun is half a degree wide) and the picture's pixel. 1 outside.
float sunGate(vec3 P) {
  if (P.x > uWinX.z - 0.005) return 1.0;
  vec3 qo = sunAt(P, uWinX.z);
  // at least two of the buffer's pixels: an edge narrower than that is seen
  // differently by every jittered redraw, and the encoder pays for it
  vec2 fo = bufPx2(qo.xy) * 2.0;
  // the sun's disc seen across the distance travelled; the plane is oblique to the ray in z
  float pen = qo.z * 0.03 + 0.01;
  vec2 wo = sqrt(fo * fo + vec2(pen / max(uSunL.x, 0.2), pen) * vec2(pen / max(uSunL.x, 0.2), pen)) + 1e-4;
  float open = boxF(qo.x, uWinZY.x, uWinZY.y, wo.x) * boxF(qo.y, uWinZY.z, uWinZY.w, wo.y);
  if (open <= 0.0) return 0.0;
  if (P.x < uWinX.x) {
    vec3 qi = sunAt(P, uWinX.x);
    open *= boxF(qi.x, uWinZY.x, uWinZY.y, wo.x) * boxF(qi.y, uWinZY.z, uWinZY.w, wo.y);
  }
  if (P.x < uWinX.y) {
    vec3 qg = sunAt(P, uWinX.y);
    open *= bars(qg.x, uWinZY.x, uWinZY.y, uBars.x, uBars.z, wo.x) * bars(qg.y, uWinZY.z, uWinZY.w, uBars.y, uBars.z, wo.y) * uBars.w;
  }
  if (open <= 0.0 || uDapple.x <= 0.0) return open;
  // the linden: under its crown the sun is clear; in it, flecks between the leaves
  vec3 qt = sunAt(P, uWinX.w);
  float crown = sstep(uDapple.y - 0.4, uDapple.y + 0.6, qt.y);
  if (crown <= 0.0) return open;
  // flecks: the sun's images through gaps between the leaves, ~10 cm, sparse
  vec2 dq = (qt.xy + uDapple.zw) * vec2(6.0, 7.0);
  vec2 fd = bufPx2(dq);
  float fade = 1.0 - smoothstep(0.3, 0.9, fd.x + fd.y);
  float n = vnoise(dq) * 0.65 + vnoise(dq * 2.3 + 5.1) * 0.35;
  float fleck = mix(0.12, smoothstep(0.57, 0.75, n), fade);
  float tr = mix(1.0, mix(0.03, 0.8, fleck), crown);
  return open * mix(1.0, tr, uDapple.x);
}

vec3 eV(vec3 a, vec3 b) {
  vec3 c = cross(a, b);
  float l = length(c);
  return l > 1e-6 ? c / l * acos(clamp(dot(a, b), -0.9999, 0.9999)) : vec3(0.0);
}
// The irradiance a surface at P, facing N, gets from the window (per unit of
// the window's radiance): Lambert's formula for a polygon.
float winLight(vec3 P, vec3 N) {
  if (P.x > uWinX.y - 0.004) return 0.0;
  vec3 a = normalize(uWc0 - P), b = normalize(uWc1 - P), c = normalize(uWc2 - P), d = normalize(uWc3 - P);
  vec3 s = eV(a, b) + eV(b, c) + eV(c, d) + eV(d, a);
  return max(dot(s, N), 0.0) * 0.5;
}
// Soft occlusion where planes meet (the room's corners), and under furniture.
float roomAO(vec3 P) {
  float ao = 1.0;
  ao *= 1.0 - 0.32 * exp(-max(P.y, 0.0) / 0.22);
  ao *= 1.0 - 0.26 * exp(-max(P.z - ${ZB.toFixed(2)}, 0.0) / 0.3);
  ao *= 1.0 - 0.26 * exp(-max(${XR.toFixed(2)} - P.x, 0.0) / 0.3);
  ao *= 1.0 - 0.20 * exp(-max(${CEIL.toFixed(2)} - P.y, 0.0) / 0.3);
  for (int i = 0; i < 6; i++) {
    vec4 b = uAoBox[i];
    if (b.z <= 0.0) continue;
    vec2 q = abs(P.xz - b.xy) - b.zw;
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
    float above = max(P.y - uAoBoxY[i].x, 0.0);
    ao *= 1.0 - uAoBoxY[i].y * exp(-max(d, 0.0) / 0.09) * exp(-above / 0.12);
  }
  return ao;
}

// Inside the built-in shelving: darker toward the back and under each board.
float shelfAO(vec3 P) {
  float zf = ${(ZB + SH_D).toFixed(3)};
  if (P.x > ${SH_X1.toFixed(3)} || P.z > zf || P.y > ${SH_H.toFixed(3)}) return 1.0;
  float dz = zf - P.z;
  float top = 0.1 + 0.37 * ceil((P.y - 0.1) / 0.37 + 1e-3);
  float a = 1.0 - 0.45 * sstep(0.0, 0.3, dz);
  a *= 1.0 - 0.3 * exp(-max(top - P.y, 0.0) / 0.09) * sstep(0.0, 0.12, dz);
  return a;
}
// The brass lamp lights its own compartment, and the room only through the
// compartment's open front.
uniform vec3 uLampP; uniform vec4 uLampBox; uniform vec3 uLampI;
float lampVis(vec3 P) {
  float zf = ${(ZB + SH_D).toFixed(3)};
  bool inside = P.x < ${SH_X1.toFixed(3)} + 0.003 && P.z < zf + 0.003 && P.y < ${SH_H.toFixed(3)} + 0.01;
  if (inside) return (P.x > uLampBox.x - 0.02 && P.x < uLampBox.y + 0.02 && P.y > uLampBox.z - 0.02 && P.y < uLampBox.w + 0.02) ? 1.0 : 0.0;
  vec3 d = uLampP - P;
  if (abs(d.z) < 1e-4) return 0.0;
  float s = (zf - P.z) / d.z;
  if (s < 0.0 || s > 1.0) return 0.0;
  vec2 q = P.xy + s * d.xy;
  float w = 0.03 + 0.02 * (1.0 - s);
  return boxF(q.x, uLampBox.x, uLampBox.y, w) * boxF(q.y, uLampBox.z, uLampBox.w, w);
}

// The facade across the street: ochre brick, white sashes, a cornice; a
// third of its windows lit at night (fixed). u across (m), v up from the street.
vec4 facadeAt(vec2 uv, out float glass) {
  vec2 cell = vec2(3.1, 3.3);
  float gf = 4.3;                       // the ground floor's height
  float v = uv.y - gf;
  vec2 g = vec2(uv.x / cell.x, v / cell.y);
  vec2 fw = bufPx2(g) + 1e-4;
  // the window opening and its white frame
  float wx = pulse(g.x, 0.32, 0.68, fw.x), wy = pulse(g.y, 0.22, 0.80, fw.y) * step(0.0, v) * step(v, 4.0 * cell.y);
  float win = wx * wy;
  float gx = pulse(g.x, 0.335, 0.665, fw.x), gy = pulse(g.y, 0.235, 0.785, fw.y);
  float glassA = gx * gy * wy;
  // sash bars: one upright, one rail, filtered
  float bar = max(pulse(g.x, 0.493, 0.507, fw.x), pulse(g.y, 0.56, 0.575, fw.y));
  glass = glassA * (1.0 - bar);
  // the brick, its courses averaged away when they are finer than the picture
  vec2 br = uv / vec2(0.24, 0.075);
  vec2 fb = bufPx2(br) + 1e-4;
  float mortar = 1.0 - pulse(br.y, 0.12, 1.0, fb.y) * pulse(br.x + 0.5 * floor(br.y), 0.05, 1.0, fb.x);
  vec3 brick = vec3(0.60, 0.40, 0.16) * (0.93 + 0.12 * vnoise(floor(br) * 0.73));
  brick = mix(brick, vec3(0.62, 0.55, 0.42), mortar * 0.6);
  vec3 c = brick;
  // the plastered ground floor, string courses, the cornice
  c = mix(c, vec3(0.58, 0.52, 0.42), step(uv.y, gf));
  float sc = boxF(v, -0.12, 0.10, fw.y * cell.y);
  float cor = boxF(uv.y, gf + 4.0 * cell.y + 0.25, gf + 4.0 * cell.y + 0.95, fw.y * cell.y);
  c = mix(c, vec3(0.78, 0.74, 0.66), max(sc, cor));
  c = mix(c, vec3(0.80, 0.80, 0.78), win * (1.0 - glassA) + glassA * bar);
  // the reveal's shade under each lintel, a curtain in some windows
  vec2 id0 = floor(g);
  float curtain = step(hash12(id0 + 41.0), 0.4) * pulse(g.x, 0.335, 0.42, fw.x);
  vec3 gc = mix(vec3(0.16, 0.17, 0.19), vec3(0.34, 0.32, 0.29), curtain);
  gc *= 1.0 - 0.5 * pulse(g.y, 0.66, 0.785, fw.y);
  c = mix(c, gc, glass);
  c *= 1.0 - 0.25 * wx * pulse(g.y, 0.80, 0.84, fw.y);
  return vec4(c, 1.0);
}
`;

// After color_fragment: albedo, roughness and metalness by kind; the glows.
const WORLD_COLOR = `
float KIND = vMat.x;
float ROUGH = vMat.y, METAL = vMat.z;
float SUNOK = (vMat.x > 9.5 && vMat.x < 10.5) ? 0.0 : 1.0;
vec3 EMIT = vec3(0.0);
vec3 P = vWorld;
if (KIND > 0.5 && KIND < 1.5) {
  // lime-wash: a slow mottle of a few percent, and the trowel's broad strokes
  vec3 nw0 = inverseTransformDirection(normalize(vNormal), viewMatrix);
  vec2 q = abs(nw0.z) > 0.5 ? P.xy : abs(nw0.x) > 0.5 ? P.zy : P.xz;
  vec2 f = footprint2(q * 3.0);
  float m = fbm2(q * 1.3 + 7.0, 3) - 0.5;
  float s = (vnoise(q * vec2(3.0, 6.5) + 3.1) - 0.5) * (1.0 - smoothstep(0.2, 0.7, f.x + f.y));
  diffuseColor.rgb *= 1.0 + 0.07 * m + 0.03 * s;
} else if (KIND > 1.5 && KIND < 2.5) {
  // white-oak planks, 0.20 x 2.4 m, running toward the back wall
  vec2 q = vec2(P.x / 0.20, 0.0);
  float bx = floor(q.x);
  float off = hash11(bx * 1.37 + 0.2) * 2.4;
  float zz = (P.z + off) / 2.4;
  float bz = floor(zz);
  vec2 f = footprint2(vec2(q.x, zz));
  float seam = (1.0 - pulse(q.x, 0.012, 0.988, f.x + 1e-4)) + (1.0 - pulse(zz, 0.002, 0.998, f.y + 1e-4));
  float tone = hash12(vec2(bx, bz) + 0.5);
  vec2 gq = vec2(P.x * 26.0, P.z * 1.6) + vec2(tone * 9.0, 0.0);
  vec2 gf = footprint2(gq);
  float grain = (vnoise(gq) - 0.5) * (1.0 - smoothstep(0.3, 0.9, gf.x));
  diffuseColor.rgb *= (0.92 + 0.14 * tone + 0.08 * grain) * (1.0 - 0.28 * clamp(seam, 0.0, 1.0));
  ROUGH = 0.42 + 0.10 * tone;
} else if (KIND > 2.5 && KIND < 3.5) {
  // oak: grain along the piece (vPar: 0 along x, 1 along y, 2 along z)
  vec3 a = vPar < 0.5 ? P.yzx : vPar < 1.5 ? P.xzy : P.xyz;
  vec2 gq = vec2((a.x + a.y) * 30.0, a.z * 1.8);
  vec2 gf = footprint2(gq);
  float grain = (vnoise(gq) - 0.5) * (1.0 - smoothstep(0.3, 0.9, gf.x));
  diffuseColor.rgb *= 1.0 + 0.14 * grain;
} else if (KIND > 3.5 && KIND < 4.5) {
  // a book: cloth or paper, a little lighter at the spine's edges
  diffuseColor.rgb *= 0.94 + 0.12 * vnoise(P.xy * vec2(9.0, 3.0) + vPar);
} else if (KIND > 4.5 && KIND < 5.5) {
  // the wool rug: oatmeal, a charcoal border, a weave that averages out
  vec2 r0 = P.xz - uRug.xy, r1 = uRug.zw - P.xz;
  float e = min(min(r0.x, r1.x), min(r0.y, r1.y));
  vec2 f = footprint2(P.xz);
  float fwb = max(f.x, f.y) + 1e-4;
  float border = boxF(e, 0.06, 0.16, fwb);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.045, 0.043, 0.042), border);
  vec2 wq = P.xz * 70.0;
  vec2 wf = footprint2(wq);
  float weave = (vnoise(wq) - 0.5) * (1.0 - smoothstep(0.3, 0.9, wf.x + wf.y));
  diffuseColor.rgb *= 1.0 + 0.10 * weave + 0.05 * (fbm2(P.xz * 3.0, 2) - 0.5);
} else if (KIND > 5.5 && KIND < 6.5) {
  // paper cord, woven over the seat and back: an average where it is too fine
  vec3 nw1 = inverseTransformDirection(normalize(vNormal), viewMatrix);
  vec2 q = (abs(nw1.y) > 0.6 ? P.xz : P.xy) * 55.0;
  vec2 f = footprint2(q);
  float w = (pulse(q.x, 0.1, 0.9, f.x + 1e-4) + pulse(q.y, 0.1, 0.9, f.y + 1e-4)) * 0.5;
  diffuseColor.rgb *= mix(0.8, 1.0, w);
} else if (KIND > 6.5 && KIND < 7.5) {
  // a fig leaf: darker toward the edge, a pale midrib (vPar: 0 midrib .. 1 edge),
  // and the window's light through it where it hangs in front of the glass
  diffuseColor.rgb *= mix(1.12, 0.86, smoothstep(0.0, 1.0, vPar)) * (1.0 + 0.5 * (1.0 - smoothstep(0.0, 0.08, vPar)));
  vec3 nwl = inverseTransformDirection(normalize(vNormal), viewMatrix);
  vec3 toWin = normalize(vec3(${WXG.toFixed(2)}, 1.6, ${((WZ0 + WZ1) / 2).toFixed(2)}) - P);
  float back = max(dot(-nwl * sign(dot(nwl, normalize(cameraPosition - P))), toWin), 0.0);
  EMIT = diffuseColor.rgb * vec3(0.9, 1.0, 0.55) * uWinRad * 0.11 * (0.35 + back);
} else if (KIND > 7.5 && KIND < 8.5) {
  float gl;
  vec4 F = facadeAt(vec2(-P.z, P.y - ${STREET.toFixed(2)}), gl);
  diffuseColor.rgb = F.rgb;
  ROUGH = mix(0.85, 0.08, gl);
  // the windows' light, computed again for the glow (cheap)
  vec2 cell = vec2(3.1, 3.3);
  vec2 g = vec2(-P.z / cell.x, (P.y - ${STREET.toFixed(2)} - 4.3) / cell.y);
  vec2 id = floor(g);
  float lit = step(hash12(id + 17.0), 0.35) * step(0.0, g.y);
  vec2 fw = bufPx2(g);
  float far = smoothstep(0.35, 0.9, max(fw.x, fw.y));
  vec3 warm = mix(vec3(1.0, 0.58, 0.26), vec3(1.0, 0.74, 0.46), hash12(id + 3.0));
  EMIT = mix(warm * lit, vec3(1.0, 0.66, 0.36) * 0.35, far) * gl * uFacLit;
  // its upper floors catch a little sun over our roof
  EMIT += diffuseColor.rgb * uFacSun.rgb * sstep(9.0, 14.0, P.y - ${STREET.toFixed(2)}) * (1.0 - gl);
} else if (KIND > 8.5 && KIND < 9.5) {
  // the linden's leaves, gold turning: clusters lit through from behind,
  // dark gaps between them; their average where they are finer than the buffer
  vec2 q = vec2(P.z + 0.4 * P.x, P.y) * 5.5;
  vec2 f = bufPx2(q);
  float n = vnoise(q) * 0.6 + vnoise(q * 2.1 + 4.0) * 0.4;
  float k = 1.0 - smoothstep(0.35, 1.0, f.x + f.y);
  float leaf = mix(0.5, smoothstep(0.35, 0.65, n), k);
  diffuseColor.rgb *= 0.45 + 0.85 * leaf;
  vec3 nwt = inverseTransformDirection(normalize(vNormal), viewMatrix);
  float rim = 1.0 - abs(dot(nwt, normalize(cameraPosition - P)));
  EMIT = diffuseColor.rgb * uTreeTrans * leaf * (0.35 + 0.9 * rim * rim);
} else if (KIND > 11.5 && KIND < 12.5) {
  // the paper lantern: pleats, and its glow at night (thinner paper glows more)
  float rib = pulse((P.y - ${LANTERN.y.toFixed(2)}) / 0.028, 0.0, 0.25, footprint((P.y - ${LANTERN.y.toFixed(2)}) / 0.028) + 1e-4);
  vec3 V = normalize(cameraPosition - P);
  float ndv = clamp(dot(normalize(vNormal), normalize(vViewPosition)), 0.0, 1.0);
  diffuseColor.rgb *= 1.0 - 0.10 * rib;
  EMIT = uLantern * (0.55 + 0.45 * ndv) * (1.0 - 0.35 * rib);
} else if (KIND > 12.5 && KIND < 13.5) {
  float ndv = clamp(dot(normalize(vNormal), normalize(vViewPosition)), 0.0, 1.0);
  EMIT = uOpal * (0.6 + 0.4 * ndv);
}
`;

const WORLD_PATCH = (uniforms) => ({
  key: 'office-world',
  uniforms,
  vertexHead: WORLD_VERT_HEAD,
  vertex: { begin_vertex: WORLD_VERT },
  fragmentHead: WORLD_FRAG_HEAD,
  fragment: {
    color_fragment: WORLD_COLOR,
    roughnessmap_fragment: 'roughnessFactor = ROUGH;',
    metalnessmap_fragment: 'metalnessFactor = METAL;',
    emissivemap_fragment: 'totalEmissiveRadiance += EMIT;',
    // The sun's shadow from the map, times where the sun gets in at all (it is
    // the one light with a shadow). The macro is defined after Three's
    // getShadow(), and a macro's own name is not expanded inside it.
    shadowmap_pars_fragment: `
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
#define getShadow(a, b, c, d, e, f) (getShadow(a, b, c, d, e, f) * sunGate(vWorld) * SUNOK)
#endif
`,
    // The environment is this room: the outside takes the sky instead.
    lights_fragment_maps: `
#if defined( RE_IndirectDiffuse )
iblIrradiance *= vWorld.x > uWinX.z ? 0.0 : uIbl.x;
#endif
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
radiance = vWorld.x > uWinX.z ? uOutRefl : radiance * uIbl.y;
#endif
`,
    lights_fragment_end: `{
  vec3 nW = inverseTransformDirection(normal, viewMatrix);
  if (vWorld.x > uWinX.z) {
    // at the blue hour the outside loses its colour to the sky's
    vec3 alb = mix(material.diffuseContribution, vec3(dot(material.diffuseContribution, vec3(0.3, 0.59, 0.11))), 0.7 * uNight);
    reflectedLight.indirectDiffuse += alb * RECIPROCAL_PI * uOutAmb * (0.75 + 0.25 * nW.y);
  }
  float ao = mix(1.0, roomAO(vWorld) * shelfAO(vWorld), uIbl.z);
  if (uLampI.r > 0.0) {
    vec3 dl = uLampP - vWorld;
    float d2 = dot(dl, dl);
    float lv = lampVis(vWorld) * max(dot(nW, dl * inversesqrt(d2)), 0.0) / max(d2, 0.02);
    reflectedLight.directDiffuse += material.diffuseContribution * RECIPROCAL_PI * uLampI * lv;
  }
  reflectedLight.indirectDiffuse *= ao;
  float E = winLight(vWorld, nW);
  reflectedLight.indirectDiffuse += material.diffuseContribution * RECIPROCAL_PI * uWinRad * E * mix(1.0, ao, 0.6);
}`
  },
  // The subject's shadow weight: a smooth function of WHERE, never of which
  // material. The resolve compares it between redraws as it does the colour,
  // and a weight that jumps at every book and chair rail is read as movement
  // along each of those edges: per-material weights cost this room 600 kb/s
  // frozen, a smooth one 25. Lower toward the floor; nothing past the glass.
  fragmentBefore: {
    premultiplied_alpha_fragment: `gl_FragColor.a = vWorld.x > ${(XR - 0.05).toFixed(2)} ? 0.0 : mix(0.74, 0.92, sstep(0.02, 0.45, vWorld.y));`
  }
});

// --- the glows: halos (the lantern and the lamp at night), the sunbeam's motes ---------------
const GLOW_DECL = `
varying vec2 vQ; varying vec4 vG; varying float vScale; varying vec3 vWorld;
uniform vec3 uHaloL; uniform vec3 uHaloO; uniform vec4 uMote;
uniform vec3 uSunL; uniform vec4 uWinZY; uniform vec4 uWinX; uniform vec3 uSunC;
`;
const GLOW_VERT = `
attribute vec4 aG;     // kind (0 lantern halo, 1 lamp halo, 2 mote), radius m, phase, speed
void main() {
  vQ = uv; vG = aG; vScale = 1.0;
  vec3 p = position;
  if (aG.x > 1.5) {
    // a mote: drifts on a slow loop, pushed by the subject's movement
    float t = uTime * aG.w + aG.z * 40.0;
    p += vec3(sin(t * 0.31 + aG.z * 6.0) * 0.12, sin(t * 0.23 + aG.z * 3.0) * 0.10 - 0.04 * sin(t * 0.07), cos(t * 0.27 + aG.z * 5.0) * 0.12);
    p.x -= uMote.y * 0.06 * sin(uTime * 0.9 + aG.z * 9.0);
  }
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vec3 toC = cameraPosition - wp.xyz;
  float dist = length(toC);
  toC /= dist;
  vec3 rt = normalize(cross(vec3(0.0, 1.0, 0.0), toC));
  vec3 up = cross(toC, rt);
  float px = dist * 2.0 / (projectionMatrix[1][1] * uBufH);
  float r = max(aG.y, px * 1.4);
  vScale = sq(aG.y / r);
  wp.xyz += (rt * (uv.x * 2.0 - 1.0) + up * (uv.y * 2.0 - 1.0)) * r;
  vWorld = wp.xyz;
  if (aG.x > 1.5) {
    // only where the sun is: the mote's own centre through the opening
    vec3 c = (modelMatrix * vec4(p, 1.0)).xyz;
    float s = (uWinX.z - c.x) / uSunL.x;
    vec2 q = vec2(c.z + s * uSunL.z, c.y + s * uSunL.y);
    float si = (uWinX.x - c.x) / uSunL.x;
    vec2 qi = vec2(c.z + si * uSunL.z, c.y + si * uSunL.y);
    float inside = sstep(uWinZY.x, uWinZY.x + 0.08, q.x) * sstep(uWinZY.y, uWinZY.y - 0.08, q.x)
                 * sstep(uWinZY.z, uWinZY.z + 0.08, q.y) * sstep(uWinZY.w - 1.1, uWinZY.w - 1.4, q.y)
                 * sstep(uWinZY.x, uWinZY.x + 0.08, qi.x) * sstep(uWinZY.y, uWinZY.y - 0.08, qi.x) * step(c.x, uWinX.x);
    vScale *= inside;
  }
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const GLOW_FRAG = `
void main() {
  vec2 q = vQ * 2.0 - 1.0;
  float d2 = dot(q, q);
  float a;
  vec3 c;
  if (vG.x < 0.5) { a = sq(max(1.0 - d2, 0.0)) / (1.0 + d2 / 0.05); c = uHaloL; }
  else if (vG.x < 1.5) { a = sq(max(1.0 - d2, 0.0)) / (1.0 + d2 / 0.03); c = uHaloO; }
  else { a = sq(max(1.0 - d2, 0.0)); c = uSunC * uMote.x; }
  c *= vScale * uEmis;
  gl_FragColor = vec4(c, a);
}
`;

// --- the sunbeam in the air ------------------------------------------------------------------------
//
// Dust in the beam, drawn on the front faces of a box around it: along the
// view ray, the stretch inside the beam is where the ray's projection toward
// the sun falls in both faces of the opening (each a linear test in t), ended
// by the floor and the back wall. Static, so it costs no bits once drawn.
const BEAM_HEAD = `
uniform vec3 uSunL; uniform vec4 uWinZY; uniform vec4 uWinX; uniform vec3 uBeam; uniform vec4 uDapple;
// the interval of t where lo <= a + b t <= hi
vec2 slab(float a, float b, float lo, float hi, vec2 iv) {
  if (abs(b) < 1e-6) return (a >= lo && a <= hi) ? iv : vec2(1.0, 0.0);
  float t0 = (lo - a) / b, t1 = (hi - a) / b;
  return vec2(max(iv.x, min(t0, t1)), min(iv.y, max(t0, t1)));
}
`;
const BEAM_BODY = `
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorld - ro);
  float t0 = length(vWorld - ro);
  // the ray's end: the floor or the back wall, whichever comes first
  float tf = rd.y < -1e-4 ? -ro.y / rd.y : 1e4;
  float tb = rd.z < -1e-4 ? (${ZB.toFixed(2)} - ro.z) / rd.z : 1e4;
  vec2 iv = vec2(t0, min(min(tf, tb), t0 + 8.0));
  // projections toward the sun onto the outer and the inner face, linear in t
  for (int k = 0; k < 2; k++) {
    float X = k == 0 ? uWinX.z : uWinX.x;
    float sa = (X - ro.x) / uSunL.x, sb = -rd.x / uSunL.x;
    iv = slab(ro.z + sa * uSunL.z, rd.z + sb * uSunL.z, uWinZY.x, uWinZY.y, iv);
    iv = slab(ro.y + sa * uSunL.y, rd.y + sb * uSunL.y, uWinZY.z, uWinZY.w, iv);
  }
  iv = slab(ro.x, rd.x, -10.0, uWinX.x, iv);
  float len = max(iv.y - iv.x, 0.0);
  // the crown takes most of the upper beam: under it, clear
  float X = uWinX.w;
  float sa = (X - ro.x) / uSunL.x, sb = -rd.x / uSunL.x;
  vec2 clear = slab(ro.y + sa * uSunL.y, rd.y + sb * uSunL.y, -100.0, uDapple.y, iv);
  float lc = max(clear.y - clear.x, 0.0);
  float l = lc + (len - lc) * 0.2;
  gl_FragColor = vec4(uBeam * uEmis * (1.0 - exp(-l * 0.9)), 1.0);
`;

// --- the room's light, for the environment ----------------------------------------------------------
//
// A picture of this room seen from its middle, lit by the same window and sun
// as the shader (CPU copies of winLight() and of the sun's way in), plus the
// lamps at night: what the glossy things reflect and what fills the shadows.
function eVjs(a, b) {
  const c = a.clone().cross(b), l = c.length();
  return l > 1e-6 ? c.multiplyScalar(Math.acos(Math.min(0.9999, Math.max(-0.9999, a.dot(b)))) / l) : new THREE.Vector3();
}
const WC = [[WXG, WY0, WZ0], [WXG, WY1, WZ0], [WXG, WY1, WZ1], [WXG, WY0, WZ1]].map((p) => new THREE.Vector3(...p));
function winLightJs(P, N) {
  if (P.x > WXG - 0.004) return 0;
  const v = WC.map((c) => c.clone().sub(P).normalize());
  const s = eVjs(v[0], v[1]).add(eVjs(v[1], v[2])).add(eVjs(v[2], v[3])).add(eVjs(v[3], v[0]));
  return Math.max(s.dot(N), 0) * 0.5;
}
function sunInJs(P) {
  const at = (X) => { const s = (X - P.x) / SUN.x; return [P.z + s * SUN.z, P.y + s * SUN.y]; };
  const inside = (q, top) => q[0] > WZ0 && q[0] < WZ1 && q[1] > WY0 && q[1] < top;
  const o = at(WXO), i = at(XR), t = at(TREE_X);
  if (!inside(o, WY1) || !inside(i, WY1)) return 0;
  return 0.62 * (t[1] < CROWN_Y ? 1 : 0.2);
}

function roomEnvPicture(o) {
  const w = 64, h = 32;
  const data = new Float32Array(w * h * 4);
  const C = new THREE.Vector3(-0.2, 1.35, -2.2);
  const d = new THREE.Vector3(), P = new THREE.Vector3(), N = new THREE.Vector3();
  const lamps = o.lamps || [];
  for (let j = 0; j < h; j++) {
    const th = ((j + 0.5) / h - 0.5) * Math.PI, ey = Math.sin(th), ce = Math.cos(th);
    for (let i = 0; i < w; i++) {
      const ph = ((i + 0.5) / w - 0.5) * 2 * Math.PI;
      d.set(Math.cos(ph) * ce, ey, Math.sin(ph) * ce);
      // the nearest of the room's six planes
      let t = Infinity, face = -1;
      const tryP = (tt, f) => { if (tt > 1e-4 && tt < t) { t = tt; face = f; } };
      if (d.x > 0) tryP((XR - C.x) / d.x, 0); else if (d.x < 0) tryP((XL - C.x) / d.x, 1);
      if (d.y > 0) tryP((CEIL - C.y) / d.y, 2); else if (d.y < 0) tryP((0 - C.y) / d.y, 3);
      if (d.z > 0) tryP((ZF - C.z) / d.z, 4); else if (d.z < 0) tryP((ZB - C.z) / d.z, 5);
      P.copy(C).addScaledVector(d, t);
      let c;
      if (face === 0 && P.z > WZ0 && P.z < WZ1 && P.y > WY0 && P.y < WY1) {
        // the window: sky over the facade and the linden
        const up = sstep(1.6, 2.6, P.y);
        c = mixA(o.outside, o.sky, up);
      } else {
        N.set(face === 0 ? -1 : face === 1 ? 1 : 0, face === 2 ? -1 : face === 3 ? 1 : 0, face === 4 ? -1 : face === 5 ? 1 : 0);
        let alb = WALL;
        if (face === 3) alb = mulA(OAK, 0.8);
        else if (face === 2) alb = mulA(WALL, 1.05);
        else if (face === 5 && P.x < SH_X1) alb = [0.16, 0.11, 0.08];
        else if (face === 5 && P.y < SB.h && P.x > SB.x0 && P.x < SB.x1) alb = mulA(OAK, 0.7);
        const E = winLightJs(P, N);
        const sunCos = Math.max(0, N.dot(SUN));
        const s = sunInJs(P) * sunCos;
        let r = alb.map((a, k) => a / Math.PI * (o.win[k] * E + o.sun[k] * s + o.bounce[k]));
        for (const L of lamps) {
          const dl = L.p.clone().sub(P), dd = dl.length();
          const cos = Math.max(0, N.dot(dl.divideScalar(dd)));
          r = r.map((v, k) => v + alb[k] / Math.PI * L.c[k] * cos / Math.max(dd * dd, 0.3));
        }
        c = r;
      }
      // the lantern itself, seen from the middle of the room
      if (o.lantern) {
        const to = LANTERN.clone().sub(C), dist = to.length();
        const cosA = to.normalize().dot(d);
        if (cosA > Math.cos(Math.atan(0.24 / dist))) c = mixA(c, o.lantern, 1);
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

// --- building the room -----------------------------------------------------------------------------

function buildShell(B) {
  const T = 0.2;   // walls are boxes, so nothing leaks at a corner
  const wall = [K_LIME, 0.92, 0, 0.95];
  // back wall, left wall, the wall behind the camera
  B.add(boxMM(XL - T, -0.1, ZB - T, XR + T, CEIL + 0.1, ZB), WALL, wall);
  B.add(boxMM(XL - T, -0.1, ZB - T, XL, CEIL + 0.1, ZF + T), WALL, wall);
  B.add(boxMM(XL - T, -0.1, ZF, XR + T, CEIL + 0.1, ZF + T), WALL, wall);
  // the right wall, around the window's opening (out to the wall's outer face)
  const xo = WXO;
  B.add(boxMM(XR, -0.1, ZB - T, xo, CEIL + 0.1, WZ0), WALL, wall);
  B.add(boxMM(XR, -0.1, WZ1, xo, CEIL + 0.1, ZF + T), WALL, wall);
  B.add(boxMM(XR, -0.1, WZ0, xo, WY0, WZ1), WALL, wall);
  B.add(boxMM(XR, WY1, WZ0, xo, CEIL + 0.1, WZ1), WALL, wall);
  // ceiling
  B.add(boxMM(XL - T, CEIL, ZB - T, XR + T, CEIL + T, ZF + T), mulA(WALL, 1.06), [K_PLAIN, 0.95, 0, 0.9]);
  // floor
  B.add(boxMM(XL, -0.1, ZB, XR, 0, ZF), OAK, [K_FLOOR, 0.45, 0, 0.62]);
  // skirting: painted, satin
  const sk = [K_PLAIN, 0.6, 0, 0.9], skC = mulA(WALL, 1.02);
  const skd = 0.011;
  B.add(boxMM(XL, 0, ZB, XR, 0.13, ZB + skd), skC, sk);
  B.add(boxMM(XL, 0, ZB, XL + skd, 0.13, ZF), skC, sk);
  B.add(boxMM(XR - skd, 0, ZB, XR, 0.13, ZF), skC, sk);
  // the cornice: a stepped cove round the ceiling
  const cor = [K_PLAIN, 0.9, 0, 0.9], corC = mulA(WALL, 1.08);
  const steps = [[0.05, 0.02], [0.09, 0.045], [0.12, 0.10], [0.15, 0.14]];
  for (const [o, hh] of steps) {
    B.add(boxMM(XL, CEIL - hh, ZB, XR, CEIL, ZB + o), corC, cor);
    B.add(boxMM(XL, CEIL - hh, ZB, XL + o, CEIL, ZF), corC, cor);
    B.add(boxMM(XR - o, CEIL - hh, ZB, XR, CEIL, ZF), corC, cor);
  }
  // a ceiling rose for the lantern
  B.add(lathe([[0.0, 0.0], [0.11, 0.0], [0.1, -0.012], [0.07, -0.025], [0.0, -0.028]], LANTERN.x, CEIL, LANTERN.z, 32), corC, cor);
}

// The window: the reveal (lime-wash inside the glass, brick outside it), a deep
// oak sill, the steel frame and its bars, a radiator under it.
function buildWindow(B) {
  const steel = [K_STEEL, 0.38, 0.3, 0.6];
  const xg = WXG;
  // the frame round the opening and the bars between the lights
  const parts = [];
  const fd = 0.012, bd = 0.01, FR = 0.03;
  parts.push(boxMM(xg - fd, WY0, WZ0, xg + fd, WY0 + FR, WZ1));
  parts.push(boxMM(xg - fd, WY1 - FR, WZ0, xg + fd, WY1, WZ1));
  parts.push(boxMM(xg - fd, WY0, WZ0, xg + fd, WY1, WZ0 + FR));
  parts.push(boxMM(xg - fd, WY0, WZ1 - FR, xg + fd, WY1, WZ1));
  for (let i = 1; i < COLS; i++) {
    const z = WZ0 + (WZ1 - WZ0) * i / COLS;
    parts.push(boxMM(xg - bd, WY0, z - BAR / 2, xg + bd, WY1, z + BAR / 2));
  }
  for (let i = 1; i < ROWS; i++) {
    const y = WY0 + (WY1 - WY0) * i / ROWS;
    parts.push(boxMM(xg - bd, y - BAR / 2, WZ0, xg + bd, y + BAR / 2, WZ1));
  }
  for (const g of parts) B.add(g, STEEL, steel);
  // the sill: oak, proud of the wall
  B.add(rbox(0.16, 0.035, WZ1 - WZ0 + 0.08, XR + 0.03, WY0 - 0.0175, (WZ0 + WZ1) / 2, 0.006), mulA(OAK, 1.05), [K_OAK, 0.5, 0, 0.6, ], [0, 0, 0, 2]);
}

// Books: runs of a colour family, some leaning, a few lying in stacks.
const FAMILIES = [
  [0xb5603a, 0xc4823f, 0x9a4a2e, 0xd19a52, 0x8c5a3a],   // rust, ochre
  [0x8a9a7b, 0x6e7d58, 0x9aa07a, 0x5e6a4a, 0xa8ac88],   // sage, olive
  [0x34425c, 0x4a5a70, 0x3a4658, 0x5d6b7c, 0x2c3850],   // navy, slate
  [0xe6dece, 0xd6cbb2, 0xece5d4, 0xc9bd9e, 0xddd1b8]    // cream
];
// An architect's shelf: each compartment's run is one colour family, its
// tones stepping gently from one book to the next (neighbouring spines that
// differ wildly are edges the jittered redraws keep disagreeing about).
let FAM_I = 0;
function fillBooks(B, r, x0, x1, y0, hMax, zBack, opts = {}) {
  let x = x0 + 0.01;
  const end = x1 - (opts.gap || 0.01);
  const fam = FAMILIES[(FAM_I++ * 3 + 1) % 4];
  const tones = fam.map((h) => linA(h)).sort((p, q) => (p[0] + p[1] + p[2]) - (q[0] + q[1] + q[2]));
  let k = r() * tones.length, dir = r() < 0.5 ? 1 : -1;
  let leaned = false;
  while (x < end - 0.02) {
    const t = r.range(0.018, 0.045), h = Math.min(hMax - 0.02, r.range(0.19, 0.31)), d = r.range(0.15, 0.23);
    if (x + t > end) break;
    k += dir * r.range(0.2, 0.7);
    if (k < 0 || k > tones.length - 1) { dir = -dir; k = Math.max(0, Math.min(tones.length - 1, k)); }
    const i0 = Math.floor(k), i1 = Math.min(tones.length - 1, i0 + 1);
    const c = mulA(mixA(tones[i0], tones[i1], k - i0), r.range(0.95, 1.04));
    const g = box(t, h, d, 0, h / 2, 0);
    let lean = 0;
    // now and then the last book of a group leans on its neighbour
    if (!leaned && x > x0 + 0.25 && r() < 0.08 && x + t + 0.08 < end) { lean = r.range(0.12, 0.24); leaned = true; }
    if (lean) {
      g.translate(t / 2, 0, 0); g.rotateZ(-lean); g.translate(-t / 2, 0, 0);
    }
    g.translate(x + t / 2, y0, zBack + d / 2 + 0.01 + r.range(0, 0.015));
    B.add(g, c, [K_BOOK, r.range(0.6, 0.85), 0, 0.85], [0, 0, 0, r() * 10]);
    x += t + (lean ? Math.sin(lean) * h + 0.004 : 0.0);
  }
}
function stackBooks(B, r, x, y0, zBack, n) {
  let y = y0;
  for (let i = 0; i < n; i++) {
    const t = r.range(0.022, 0.04), w = r.range(0.2, 0.28), d = r.range(0.15, 0.21);
    const c = mulA(linA(r.pick(r.pick(FAMILIES))), r.range(0.85, 1.05));
    const g = box(w, t, d, x + r.range(-0.01, 0.01), y + t / 2, zBack + d / 2 + 0.02);
    g.rotateY(0);
    B.add(g, c, [K_BOOK, 0.7, 0, 0.85], [0, 0, 0, r() * 10]);
    y += t;
  }
  return y;
}
// A ceramic: a smooth lathe, glazed.
function ceramic(B, r, x, y0, z, kind) {
  const prof = kind === 0
    ? [[0, 0], [0.045, 0], [0.06, 0.03], [0.065, 0.1], [0.045, 0.17], [0.03, 0.2], [0.034, 0.215], [0.0, 0.215]]
    : kind === 1
      ? [[0, 0], [0.04, 0], [0.085, 0.025], [0.1, 0.06], [0.095, 0.065], [0.0, 0.065]]
      : [[0, 0], [0.05, 0], [0.052, 0.14], [0.048, 0.145], [0, 0.145]];
  const col = r.pick([linA(0xd8d0c0), SAGE, linA(0x5d6b72), mulA(TERRA, 0.9), linA(0xe9e4da)]);
  B.add(lathe(prof, x, y0, z, 32), col, [K_GLAZE, 0.22, 0, 0.7]);
}

function buildShelving(B, r) {
  FAM_I = 0;   // every build the same shelf (a keyed receiver builds its own)
  const oak = [K_OAK, 0.55, 0, 0.8];
  const x0 = XL, x1 = SH_X1, zb = ZB, zf = ZB + SH_D;
  const t = 0.025;
  // the carcass: plinth, top, the end panel, two uprights, seven boards
  B.add(boxMM(x0, 0, zb, x1, 0.1, zf - 0.02), mulA(OAK_D, 0.9), oak, [0, 0, 0, 0]);
  B.add(boxMM(x1 - t, 0, zb, x1, SH_H, zf), OAK, oak, [0, 0, 0, 1]);
  B.add(boxMM(x0, SH_H - t, zb, x1, SH_H, zf), OAK, oak, [0, 0, 0, 0]);
  const bays = [x0, x0 + (x1 - x0) * 0.34, x0 + (x1 - x0) * 0.67, x1 - t];
  for (let i = 1; i < 3; i++) B.add(boxMM(bays[i] - t / 2, 0.1, zb, bays[i] + t / 2, SH_H - t, zf), OAK, oak, [0, 0, 0, 1]);
  const levels = [0.1, 0.47, 0.84, 1.21, 1.58, 1.95, SH_H - t];
  for (let i = 0; i < levels.length - 1; i++) B.add(boxMM(x0, levels[i] - (i ? t / 2 : 0), zb, x1 - t, levels[i] + (i ? t / 2 : t), zf), OAK, oak, [0, 0, 0, 0]);
  // what each compartment holds (row 0 is the bottom; bay 0 the left)
  // 'b' books, 's' a stack and books, 'c' a ceramic and books, 'L' the lamp
  const plan = [
    ['b', 'b', 'b'],
    ['b', 's', 'b'],
    ['c', 'b', 'b'],
    ['b', 'b', 'c'],
    ['b', 'L', 's'],
    ['s', 'c', 'b']
  ];
  const lampY = levels[4] + t / 2;
  for (let row = 0; row < 6; row++) {
    const y0 = levels[row] + (row ? t / 2 : t), hMax = levels[row + 1] - t / 2 - y0;
    for (let bay = 0; bay < 3; bay++) {
      const a = bays[bay] + (bay ? t / 2 : 0), b = bays[bay + 1] - t / 2;
      const what = plan[row][bay];
      if (what === 'b') fillBooks(B, r, a, b - r.range(0.0, 0.12), y0, hMax, zb);
      else if (what === 's') {
        stackBooks(B, r, a + 0.15, y0, zb, r.int(3, 6));
        fillBooks(B, r, a + 0.3, b - 0.02, y0, hMax, zb);
      } else if (what === 'c') {
        fillBooks(B, r, a, a + (b - a) * 0.55, y0, hMax, zb);
        ceramic(B, r, a + (b - a) * 0.78, y0, zb + 0.16, r.int(0, 2));
      } else if (what === 'L') {
        fillBooks(B, r, b - 0.24, b - 0.01, y0, hMax, zb);
        LAMP.y = lampY;
      }
    }
  }
  // the lamp: a brass foot and stem, an opal globe
  const L = LAMP;
  B.add(lathe([[0, 0], [0.06, 0], [0.062, 0.008], [0.05, 0.016], [0.012, 0.02], [0.011, 0.2], [0.02, 0.21], [0.02, 0.225], [0, 0.225]], L.x, L.y, L.z, 32),
    BRASS, [K_PLAIN, 0.3, 1, 0.7]);
  const globe = new THREE.SphereGeometry(0.068, 32, 20);
  globe.translate(L.x, L.y + 0.28, L.z);
  B.add(globe, linA(0xf4efe6), [K_OPAL, 0.3, 0, 0.7]);
  // the lamp's compartment: its open front, for its light
  const lb = new THREE.Vector4(bays[1] + t / 2, bays[2] - t / 2, levels[4] + t / 2, levels[5] - t / 2);
  return { lamp: new THREE.Vector3(L.x, L.y + 0.28, L.z), lampY, box: lb };
}

// The lounge chair: an oak frame round a paper-cord seat and back, low and reclined.
function buildChair(B) {
  const cx = -1.04, cz = -2.8, rot = 0.42;
  const oak = [K_OAK, 0.5, 0, 0.6], cord = [K_CORD, 0.9, 0, 0.6];
  const CORD = mixA(LINEN, linA(0xc2ab7e), 0.55);
  const put = (g, c, m, tilt = null) => {
    if (tilt) { g.translate(0, -tilt.y, -tilt.z); g.rotateX(tilt.a); g.translate(0, tilt.y, tilt.z); }
    g.rotateY(rot); g.translate(cx, 0, cz);
    B.add(g, c, m, [0, 0, 0, 1]);
  };
  const W = 0.64, D = 0.72;
  for (const sx of [-1, 1]) {
    const x = sx * (W / 2 - 0.022);
    put(rbox(0.04, 0.4, 0.04, x, 0.2, D / 2 - 0.06, 0.014, 3), OAK, oak);       // front leg
    put(rbox(0.04, 0.34, 0.04, x, 0.17, -D / 2 + 0.08, 0.014, 3), OAK, oak);    // back leg
    put(rbox(0.05, 0.03, D - 0.02, x, 0.53, 0.02, 0.012, 3), OAK, oak);         // arm
    put(rbox(0.026, 0.13, 0.026, x, 0.465, D / 2 - 0.06, 0.01, 3), OAK, oak);  // arm post
    put(rbox(0.03, 0.03, D - 0.12, x, 0.3, 0.0, 0.01, 3), OAK, oak);           // seat rail
  }
  // the seat: a woven panel in a frame, sloping back
  const seatTilt = { a: 0.08, y: 0.32, z: 0.0 };
  put(rbox(W - 0.08, 0.025, D - 0.16, 0, 0.32, 0.02, 0.01, 2), CORD, cord, seatTilt);
  put(rbox(W - 0.04, 0.035, 0.035, 0, 0.32, D / 2 - 0.07, 0.01, 3), OAK, oak, seatTilt);
  // the back: two stiles, a top rail, a woven panel, reclined
  const backTilt = { a: -0.36, y: 0.3, z: -D / 2 + 0.08 };
  put(rbox(W - 0.1, 0.5, 0.022, 0, 0.6, -D / 2 + 0.08, 0.01, 2), CORD, cord, backTilt);
  for (const sx of [-1, 1]) put(rbox(0.035, 0.62, 0.035, sx * (W / 2 - 0.05), 0.6, -D / 2 + 0.08, 0.012, 3), OAK, oak, backTilt);
  put(rbox(W - 0.06, 0.04, 0.035, 0, 0.9, -D / 2 + 0.08, 0.012, 3), OAK, oak, backTilt);
  return { x: cx, z: cz, hx: 0.36, hz: 0.4 };
}

// The sideboard: a long low oak case on slim legs; a vase and books at its left end.
function buildSideboard(B, r) {
  const oak = [K_OAK, 0.42, 0, 0.8];
  const z1 = ZB + SB.d, zc = ZB + SB.d / 2 + 0.01;
  const legH = 0.16;
  B.add(rbox(SB.x1 - SB.x0, SB.h - legH, SB.d, (SB.x0 + SB.x1) / 2, legH + (SB.h - legH) / 2, zc, 0.012, 2), OAK, oak, [0, 0, 0, 0]);
  // (no drawer reveals: a line thinner than the buffer's pixel flickers
  // from one jittered redraw to the next, and every receiver pays for it)
  for (const x of [SB.x0 + 0.08, SB.x1 - 0.08]) {
    for (const z of [ZB + 0.09, z1 - 0.06]) {
      B.add(lathe([[0, 0], [0.012, 0], [0.018, legH], [0, legH]], x, 0, z, 16), OAK_D, oak, [0, 0, 0, 1]);
    }
  }
  // at the left end: two art books and a tall sage vase
  stackBooks(B, r, SB.x0 + 0.22, SB.h, ZB + 0.04, 2);
  B.add(lathe([[0, 0], [0.05, 0], [0.072, 0.07], [0.07, 0.18], [0.04, 0.27], [0.032, 0.32], [0.036, 0.335], [0, 0.335]], SB.x0 + 0.08, SB.h, ZB + 0.24, 36),
    SAGE, [K_GLAZE, 0.25, 0, 0.75]);
  // and a low bowl at the right end
  B.add(lathe([[0, 0], [0.05, 0], [0.11, 0.035], [0.13, 0.07], [0.125, 0.075], [0, 0.075]], SB.x1 - 0.2, SB.h, ZB + 0.24, 36),
    linA(0xe6dfd2), [K_GLAZE, 0.3, 0, 0.75]);
}

// The rug: oatmeal wool, charcoal border (drawn by the shader from uRug).
function buildRug(B) {
  const R = [-1.62, -3.3, 0.78, -1.6];
  B.add(rbox(R[2] - R[0], 0.012, R[3] - R[1], (R[0] + R[2]) / 2, 0.006, (R[1] + R[3]) / 2, 0.005, 1), WOOL, [K_RUG, 0.95, 0, 0.6]);
  return R;
}

// The paper lantern on its cord.
function buildLantern(B) {
  const g = new THREE.SphereGeometry(0.225, 40, 28);
  g.scale(1, 0.9, 1);
  g.translate(LANTERN.x, LANTERN.y, LANTERN.z);
  B.add(g, PAPER, [K_PAPER, 0.9, 0, 0.5]);
  const top = LANTERN.y + 0.2;
  B.add(box(0.006, CEIL - top, 0.006, LANTERN.x, (CEIL + top) / 2, LANTERN.z), linA(0x2a2826), [K_PLAIN, 0.6, 0, 0.5]);
  B.add(lathe([[0, 0], [0.03, 0], [0.03, 0.025], [0, 0.03]], LANTERN.x, top - 0.01, LANTERN.z, 20), linA(0xe8e2d8), [K_PLAIN, 0.5, 0, 0.5]);
}

// The fiddle-leaf fig: a terracotta pot, a slender trunk, forty leaves.
function leafGeo(len, wid, cup, droop) {
  const nu = 12, nv = 8;
  const P = [], I = [], par = [];
  for (let i = 0; i <= nu; i++) {
    const s = i / nu;
    // fiddle-shaped: narrow at the stalk, widest two thirds up, a blunt tip,
    // a slight waist below the middle
    const m = 0.66;
    const e = s < m ? Math.sqrt(Math.max(0, 1 - Math.pow((s - m) / m, 2))) : Math.sqrt(Math.max(0, 1 - Math.pow((s - m) / (1 - m + 0.02), 2)));
    const w = wid * Math.pow(e, 0.85) * (1 - 0.14 * Math.exp(-Math.pow((s - 0.4) / 0.1, 2)));
    for (let j = 0; j <= nv; j++) {
      const v = j / nv * 2 - 1;
      const x = v * w * 0.5;
      // the midrib bends down toward the tip
      const y = s * len * (1 - 0.18 * droop * s * s);
      const z = cup * (v * v) * w * 0.5 - droop * 0.35 * len * s * s + 0.012 * Math.sin(v * 7 + s * 9) * s;
      P.push(x, y, z);
      par.push(Math.abs(v));
    }
  }
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const a = i * (nv + 1) + j, b = a + 1, c = a + nv + 1, d = c + 1;
    I.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setIndex(I);
  g.computeVertexNormals();
  return { g, par };
}
function buildFig(B, r) {
  const fx = FIG.x, fz = FIG.z;
  // the pot
  B.add(lathe([[0, 0.0], [0.15, 0.0], [0.17, 0.02], [0.19, 0.33], [0.205, 0.34], [0.205, 0.37], [0.185, 0.37], [0.18, 0.34], [0, 0.34]], fx, 0, fz, 40),
    TERRA, [K_PLAIN, 0.85, 0, 0.6]);
  const sway = (ph) => [0.36, 0.006, ph, 0];
  // the trunk: a slight S, then three branches
  const pts = [[0, 0.3, 0], [0.02, 0.7, -0.01], [-0.02, 1.05, 0.02], [0.03, 1.38, 0.0], [0.0, 1.62, -0.02]].map(([x, y, z]) => new THREE.Vector3(fx + x, y, fz + z));
  const trunk = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.018, 8, false);
  B.add(trunk, linA(0x6f6252), [K_PLAIN, 0.8, 0, 0.6], sway(0));
  const BR = [];
  for (const [y, a, l] of [[0.95, 0.4, 0.32], [1.15, 2.6, 0.3], [1.3, 4.6, 0.26]]) {
    const o = new THREE.Vector3(fx, y, fz);
    const e = o.clone().add(new THREE.Vector3(Math.cos(a) * l, l * 0.7, Math.sin(a) * l));
    const mid = o.clone().lerp(e, 0.5).add(new THREE.Vector3(0, -0.03, 0));
    B.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([o, mid, e]), 10, 0.011, 6, false), linA(0x6f6252), [K_PLAIN, 0.8, 0, 0.6], sway(0));
    BR.push([o, e]);
  }
  // forty leaves, spiralling up the trunk and the branches, larger low down
  const LEAF_A = linA(0x34502a), LEAF_B = linA(0x4a6a34);
  let n = 0;
  const leafAt = (base, dirA, tilt, len) => {
    const { g, par } = leafGeo(len, len * r.range(0.66, 0.78), r.range(0.15, 0.32), r.range(0.4, 1.0));
    g.rotateX(-tilt);
    g.rotateY(dirA);
    g.translate(base.x, base.y, base.z);
    const G = g.toNonIndexed();
    // the midrib-to-edge parameter, per vertex of the non-indexed copy
    const idx = g.index.array;
    const pv = new Float32Array(idx.length);
    for (let i = 0; i < idx.length; i++) pv[i] = par[idx[i]];
    g.dispose();
    const c = mixA(LEAF_A, LEAF_B, r());
    const P = B.add(G, c, [K_LEAF, 0.55, 0, 0.6], [0.36, 0.006, r(), 0]);
    const S = P.getAttribute('aSway');
    for (let i = 0; i < pv.length; i++) S.setW(i, pv[i]);
    n++;
  };
  // up the trunk, alternate, broad leaves held out and a little down at the tip
  for (let i = 0; i < 24; i++) {
    const t = i / 23;
    const y = 0.78 + t * 0.92 + r.range(-0.03, 0.03);
    const a = i * 2.4 + r.range(-0.3, 0.3);
    const base = new THREE.Vector3(fx + Math.cos(a) * 0.02, y, fz + Math.sin(a) * 0.02);
    // mostly toward or away from the room, so few are seen edge-on
    const face = Math.atan2(-FIG.x, -FIG.z) + (i % 2 ? Math.PI : 0) + r.range(-0.75, 0.75);
    leafAt(base, face + Math.PI, r.range(0.75, 1.15) - 0.3 * t, r.range(0.27, 0.36) * (1.05 - 0.2 * t));
  }
  // and along the three branches
  for (let i = 0; i < 16; i++) {
    const [o, e] = BR[i % 3];
    const t = 0.3 + 0.7 * r();
    const base = o.clone().lerp(e, t);
    const out = Math.atan2(e.x - o.x, e.z - o.z);
    leafAt(base, out + r.range(-0.6, 0.6), r.range(0.6, 1.1), r.range(0.24, 0.32));
  }
  return n;
}

// Outside: the street, the facade across it with a roof, the linden in front.
function buildOutside(B, r) {
  // the facade: a grid of cells that grow with distance (SwiftShader and huge quads)
  const fac = new THREE.PlaneGeometry(110, 20.5, 22, 5);
  fac.rotateY(-Math.PI / 2);
  fac.translate(FAC_X, STREET + 10.25, -35);
  B.add(fac, [0.5, 0.4, 0.2], [K_FACADE, 0.85, 0, 0]);
  // the roof: slate, a few chimneys and dormers
  const roofY = STREET + 20.5;
  const roof = new THREE.PlaneGeometry(7, 110, 2, 22);
  roof.rotateX(-Math.PI / 2);
  roof.rotateZ(0.75);
  roof.translate(FAC_X + 3.5 * Math.cos(0.75), roofY + 3.5 * Math.sin(0.75), -35);
  B.add(roof, linA(0x4a4e52, 0.8), [K_PLAIN, 0.6, 0, 0]);
  for (let i = 0; i < 6; i++) {
    const z = -70 + i * 13 + r.range(-3, 3);
    B.add(box(0.9, 2.2, 1.4, FAC_X + 3.0, roofY + 3.2, z), linA(0x9a5a3a, 0.8), [K_PLAIN, 0.9, 0, 0]);
  }
  // the street and the pavement below
  const st = new THREE.PlaneGeometry(40, 120, 8, 24);
  st.rotateX(-Math.PI / 2);
  st.translate(10, STREET, -40);
  B.add(st, linA(0x3a3a3c, 0.8), [K_PLAIN, 0.9, 0, 0]);
  // our own outer wall, beyond the reveal (seen at the window's edges when the view turns)
  B.add(boxMM(WXO, STREET, ZB - 3, WXO + 0.02, CEIL + 3.5, WZ0), linA(0xb9a383, 0.8), [K_PLAIN, 0.9, 0, 0]);
  B.add(boxMM(WXO, STREET, WZ1, WXO + 0.02, CEIL + 3.5, ZF + 3), linA(0xb9a383, 0.8), [K_PLAIN, 0.9, 0, 0]);
  // the linden across the window: its crown fills the top of the view, the
  // trunk stands off to the right where the window's edge hides it
  const tx = 7.6, tz = -5.2;
  B.add(new THREE.CylinderGeometry(0.11, 0.17, 10.0, 10), linA(0x3e3832), [K_PLAIN, 0.9, 0, 0]).translate(tx, STREET + 5.0, tz);
  const GOLD = linA(0xb8a24a), LIME = linA(0x8e9a48), AMBER = linA(0xc79a42), DEEP = linA(0x55602e);
  const cc = new THREE.Vector3(8.6, 6.6, -9.0);
  for (let i = 0; i < 46; i++) {
    const a = r() * Math.PI * 2, q = Math.sqrt(r());
    const x = cc.x + Math.cos(a) * q * 2.4, z = cc.z + Math.sin(a) * q * 4.2;
    const y = cc.y + r.range(-1.9, 2.4) * (1 - 0.35 * q);
    const sz = r.range(0.4, 0.8);
    const g = new THREE.IcosahedronGeometry(sz, 2);
    g.scale(1, 0.75, 1);
    // normals leaning out from the crown's middle, so the clumps read as one crown
    const p = g.getAttribute('position'), nn = g.getAttribute('normal');
    for (let k = 0; k < p.count; k++) {
      const v = new THREE.Vector3(p.getX(k) + x - cc.x, (p.getY(k) + y - cc.y) * 1.3, p.getZ(k) + z - cc.z).normalize();
      const m = new THREE.Vector3(nn.getX(k), nn.getY(k), nn.getZ(k)).lerp(v, 0.55).normalize();
      nn.setXYZ(k, m.x, m.y, m.z);
    }
    g.translate(x, y, z);
    // darker inside the crown and underneath
    const depth = sstep(0.2, 1.0, q) * 0.5 + sstep(cc.y - 2, cc.y + 2, y) * 0.5;
    const c = mulA(mixA(mixA(GOLD, LIME, r()), AMBER, r() * 0.45), 0.55 + 0.5 * depth);
    B.add(g, mixA(c, DEEP, (1 - depth) * 0.35), [K_TREE, 0.8, 0, 0], [0, -0.008, r() * 6.28, 0]);
  }
}

// How many samples the room's target can have: up to 8 (measured: 4 cost a
// still room 239 kb/s, 8 cost 216), as many as the colour format allows here.
function msaaSamples(k, float) {
  const gl = k.renderer.getContext();
  try {
    const fmt = float ? gl.RGBA16F : gl.RGBA8;
    const list = gl.getInternalformatParameter(gl.RENDERBUFFER, fmt, gl.SAMPLES);
    const max = list && list.length ? Math.max(...list) : 0;
    return Math.min(8, max, k.renderer.capabilities.maxSamples || 0);
  } catch (e) { return 0; }
}

// --- the scene -----------------------------------------------------------------------------------------

export default {
  id: 'office',
  camera: {
    pos: [0, EYE, 0],
    target: [Math.sin(YAW) * Math.cos(PITCH) * 10, EYE - Math.sin(PITCH) * 10, -Math.cos(YAW) * Math.cos(PITCH) * 10],
    fov: 50, near: 0.1, far: 400
  },
  nearness: [4.6, 24],

  build(k) {
    const st = {};
    const S = k.scene;
    let r;

    // --- the sky through the window: an October morning, the blue hour at night
    const skyO = {
      zenith: shows(0x5f8fcf), horizon: shows(0xd9e5ef), ground: lin(0x5a5550, 0.4),
      zenithNight: shows(0x1b2440, 0.25), horizonNight: shows(0x2b3a55, 0.25), groundNight: lin(0x10131a, 0.4),
      sunDir: SUN.toArray(), sunColor: 0xfff0d8, sunIntensity: 0.6, disc: 0, haze: 0.5,
      cloud: { coverage: 0.32, scale: 0.0016, height: 1400, wind: 3, lit: 0xffffff, shade: 0xb4bfcc, litNight: 0x3a4466, shadeNight: 0x222a40 }
    };
    // the clouds' colours are radiance too
    const sky = K.sky(k, skyO);
    const U0 = sky.mesh.material.uniforms;
    U0.uCloudLit.value.copy(shows(0xf4f2ee)); U0.uCloudShade.value.copy(shows(0xb9c3cf));
    U0.uCloudLitN.value.copy(shows(0x46506e, 0.25)); U0.uCloudShadeN.value.copy(shows(0x2a3350, 0.25));
    st.sky = sky;

    // --- the world
    const B = new Buf();
    buildShell(B);
    buildWindow(B);
    r = k.rng(SEED + 1);
    const shelf = buildShelving(B, r);
    const chair = buildChair(B);
    r = k.rng(SEED + 2);
    buildSideboard(B, r);
    const rug = buildRug(B);
    buildLantern(B);
    r = k.rng(SEED + 3);
    st.leaves = buildFig(B, r);
    r = k.rng(SEED + 4);
    buildOutside(B, r);

    const aoBox = [
      new THREE.Vector4((SB.x0 + SB.x1) / 2, ZB + SB.d / 2, (SB.x1 - SB.x0) / 2, SB.d / 2),
      new THREE.Vector4(chair.x, chair.z, 0.3, 0.32),
      new THREE.Vector4(FIG.x, FIG.z, 0.17, 0.17),
      new THREE.Vector4((XL + SH_X1) / 2, ZB + SH_D / 2, (SH_X1 - XL) / 2, SH_D / 2),
      new THREE.Vector4(0, 0, 0, 0),
      new THREE.Vector4(0, 0, 0, 0)
    ];
    const aoBoxY = [
      new THREE.Vector4(0.0, 0.55), new THREE.Vector4(0.0, 0.45), new THREE.Vector4(0.0, 0.5),
      new THREE.Vector4(0.0, 0.3), new THREE.Vector4(0.0, 0.35), new THREE.Vector4(0, 0)
    ];
    const worldU = {
      uSunL: { value: SUN.clone() },
      uWinZY: { value: new THREE.Vector4(WZ0, WZ1, WY0, WY1) },
      uWinX: { value: new THREE.Vector4(XR, WXG, WXO, TREE_X) },
      uBars: { value: new THREE.Vector4(COLS, ROWS, BAR, 0.86) },
      uDapple: { value: new THREE.Vector4(1, CROWN_Y, 0, 0) },
      uWc0: { value: WC[0] }, uWc1: { value: WC[1] }, uWc2: { value: WC[2] }, uWc3: { value: WC[3] },
      uWinRad: { value: new THREE.Color() },
      uIbl: { value: new THREE.Vector4(0.6, 1.0, 1.0, 0) },
      uLantern: { value: new THREE.Color() },
      uOpal: { value: new THREE.Color() },
      uFacLit: { value: new THREE.Color() },
      uRug: { value: new THREE.Vector4(rug[0], rug[1], rug[2], rug[3]) },
      uFacSun: { value: new THREE.Vector4(0, 0, 0, 0) },
      uAoBox: { value: aoBox },
      uAoBoxY: { value: aoBoxY },
      uOutAmb: { value: new THREE.Color() },
      uOutRefl: { value: new THREE.Color() },
      uTreeTrans: { value: new THREE.Color() },
      uLampP: { value: shelf.lamp.clone() },
      uLampBox: { value: shelf.box.clone() },
      uLampI: { value: new THREE.Color() }
    };
    st.worldU = worldU;
    const worldM = k.std({ vertexColors: true, roughness: 1, metalness: 0, side: THREE.DoubleSide, shadowSide: THREE.DoubleSide, patch: WORLD_PATCH(worldU) });
    const world = new THREE.Mesh(B.geometry(), worldM);
    world.receiveShadow = true;
    world.castShadow = false;
    world.frustumCulled = false;
    S.add(world);

    // Nothing inside the room stands in the beam, so nothing casts into the
    // shadow map; the light keeps castShadow because the sun's way in (the
    // window, the bars, the linden: sunGate()) rides on Three's getShadow().

    // --- glass
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(WZ1 - WZ0, WY1 - WY0), K.glass(k, { tint: 0xa8b4bc, opacity: 0.06, env: 1 }));
    glass.rotation.y = -Math.PI / 2;
    glass.position.set(WXG + 0.005, (WY0 + WY1) / 2, (WZ0 + WZ1) / 2);
    glass.renderOrder = 20;
    S.add(glass);

    // --- the sun: a directional light whose shadow map holds the room's things
    const sun = new THREE.DirectionalLight(0xffffff, 1);
    const centre = new THREE.Vector3(1.3, 1.0, -3.0);
    sun.position.copy(centre).addScaledVector(SUN, 8);
    sun.target.position.copy(centre);
    S.add(sun, sun.target);
    sun.castShadow = true;
    sun.shadow.mapSize.set(k.quality.shadow, k.quality.shadow);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.012;
    sun.shadow.radius = 0;
    {
      sun.updateMatrixWorld(); sun.target.updateMatrixWorld();
      const cam = sun.shadow.camera;
      cam.position.copy(sun.position); cam.lookAt(centre); cam.updateMatrixWorld();
      const inv = cam.matrixWorldInverse;
      const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
      for (const x of [0.2, XR + 0.4]) for (const y of [0, WY1 + 0.1]) for (const z of [ZB, WZ1 + 0.3]) {
        const v = new THREE.Vector3(x, y, z).applyMatrix4(inv);
        lo.min(v); hi.max(v);
      }
      cam.left = lo.x; cam.right = hi.x; cam.bottom = lo.y; cam.top = hi.y;
      cam.near = Math.max(0.1, -hi.z - 1); cam.far = -lo.z + 1;
      cam.updateProjectionMatrix();
    }
    st.sun = sun;

    // --- lamps at night
    const lanternL = new THREE.PointLight(0xffb871, 0, 9, 2);
    lanternL.position.copy(LANTERN).add(new THREE.Vector3(0, -0.02, 0));
    S.add(lanternL);
    st.lanternL = lanternL;

    // --- glows: the halos at night, the motes in the beam
    {
      const P = [], UV = [], G = [];
      const quad = (p, kind, rad, ph, sp) => {
        for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]]) { P.push(p.x, p.y, p.z); UV.push(u, v); G.push(kind, rad, ph, sp); }
      };
      quad(LANTERN, 0, 0.7, 0, 0);
      quad(shelf.lamp, 1, 0.28, 0, 0);
      const rm = k.rng(SEED + 7);
      const nM = Math.round(150 * k.quality.particles);
      for (let i = 0; i < nM; i++) {
        // in the beam's volume: between the window and the back wall
        const z = rm.range(ZB + 0.15, WZ1 - 0.2), x = rm.range(0.8, XR - 0.1), y = rm.range(0.2, 2.2);
        quad(new THREE.Vector3(x, y, z), 2, rm.range(0.0018, 0.0035), rm(), rm.range(0.08, 0.16));
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
      g.setAttribute('aG', new THREE.Float32BufferAttribute(G, 4));
      const glowU = {
        uHaloL: { value: new THREE.Color() }, uHaloO: { value: new THREE.Color() },
        uMote: { value: new THREE.Vector4(0, 0, 0, 0) },
        uSunL: worldU.uSunL, uWinZY: worldU.uWinZY, uWinX: worldU.uWinX,
        uSunC: { value: new THREE.Color() }
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

    // --- the sunbeam in the air
    {
      const bx = boxMM(0.15, 0.0, ZB, XR - 0.002, WY1, WZ1);
      const beamU = { uSunL: worldU.uSunL, uWinZY: worldU.uWinZY, uWinX: worldU.uWinX, uDapple: worldU.uDapple, uBeam: { value: new THREE.Color() } };
      const beamM = k.shader({ uniforms: beamU, transparent: true, additive: true, depthWrite: false, fragmentHead: BEAM_HEAD, fragment: BEAM_BODY });
      const m = new THREE.Mesh(bx, beamM);
      m.frustumCulled = false;
      m.renderOrder = 25;
      S.add(m);
      st.beamU = beamU;
    }

    // --- the room's environment, baked for the morning and the evening
    st.envPal = {
      win: [lin(0xf2f4f8, 1), lin(0x2b3a55, 0.12)],
      sky: [shows(0xe8eef4), shows(0x2b3a55, 0.25)],
      outside: [shows(0xc8b089), shows(0x1e2638, 0.25)]
    };
    st.envAt = -1;
    st.bakeEnv = (night) => {
      const q = Math.round(night * 4) / 4;
      if (q === st.envAt) return false;
      st.envAt = q;
      const P = st.envPal;
      const m = (pair) => { const c = pair[0].clone().lerp(pair[1], q); return [c.r, c.g, c.b]; };
      const winR = mulA(m(P.win), 6.0 * (1 - q) + 6.0 * q);
      const lampC = mulA(linA(0xffb36b), 2.2 * q), lanC = mulA(linA(0xffb871), 4.0 * q);
      const tex = roomEnvPicture({
        win: winR, sun: mulA([1.0, 0.86, 0.66], 16 * (1 - q)), bounce: mulA([1.0, 0.88, 0.72], 1.5 * (1 - q) + 0.25 * q),
        sky: m(P.sky), outside: m(P.outside),
        lamps: q > 0 ? [{ p: shelf.lamp, c: lampC }, { p: LANTERN, c: lanC }] : [],
        lantern: q > 0 ? mulA(linA(0xffd2a0), 3.0 * q) : null
      });
      const prev = S.environment;
      k.environment(tex, 1);
      tex.dispose();
      if (prev && prev !== S.environment) prev.dispose();
      return true;
    };
    st.bakeEnv(0);

    // --- the room, drawn with 4x multisampling into its own target, then
    // copied as it is into the engine's. Every edge a redraw draws is then an
    // average of four looks across its pixel, not one, so the jittered redraws
    // disagree far less about it, and that disagreement is what a room that
    // holds still costs the encoder (each redraw's change is added to the
    // picture): measured, 435 -> 240 kb/s frozen. The room lives on layer 1,
    // which the engine's camera does not see (it sees the copy, layer 0); the
    // lights are on every layer, so the engine's compile() builds the room's
    // programs with the right lights, off the frame's path. The copy sits 1 m
    // away, inside the nearness range, so the subject's shadow weight is the
    // room's own alpha.
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
      k.scene.add(copy);
      st.rt = rt;
    }

    k.shadowsChanged();
    st.tmp = new THREE.Color();
    return st;
  },

  update(k, st, t, look) {
    const n = look.night, key = look.key;
    const E = look.exposure;
    // emissives are dimmed less than surfaces; the evening's lights are
    // designed at a dark room's exposure, so they are compensated for it
    const comp = (0.65 + 0.35 * E) / E;
    const U = st.worldU;
    // the sun: as directional as the subject's light; gone at the blue hour
    const hard = sstep(0.06, 0.5, key);
    const sunAmt = (0.06 + 0.94 * hard) * (1 - n);
    st.sun.color.setRGB(1.0, 0.86, 0.66);
    st.sun.intensity = 17 * sunAmt;
    // the window: brighter when the sky is overcast, deep blue at night
    const over = 1 - hard;
    // an overcast sky is no brighter than a clear one: what goes is the sun,
    // and the warm bounce of its patch on the floor
    const day = new THREE.Color(1.0, 0.95, 0.87).multiplyScalar(7.2).lerp(st.tmp.setRGB(0.95, 0.96, 1.0).multiplyScalar(6.9), over);
    const eve = new THREE.Color(0.30, 0.40, 0.66).multiplyScalar(0.55 * comp);
    U.uWinRad.value.copy(day).lerp(eve, n);
    // the linden moves in the air: its flecks drift a centimetre or so
    U.uDapple.value.set(1, CROWN_Y, 0.012 * Math.sin(t * 0.7) + 0.005 * Math.sin(t * 1.6 + 1.0), 0.008 * Math.sin(t * 0.53 + 2.0));
    // the environment: bounce and reflections
    if (st.bakeEnv(n)) k.renderer.resetState();
    k.scene.environmentIntensity = (0.62 + 0.28 * hard) * (1 - n) + 0.9 * comp * n;
    U.uIbl.value.set(0.55, 1.0, 1.0, 0);
    // the lamps
    const on = sstep(0.15, 0.7, n);
    U.uLampI.value.setRGB(1.0, 0.70, 0.42).multiplyScalar(1.6 * on * comp);
    st.lanternL.intensity = 2.6 * on * comp;
    U.uLantern.value.setRGB(1.0, 0.62, 0.32).multiplyScalar(1.1 * on);
    U.uOpal.value.setRGB(1.0, 0.78, 0.52).multiplyScalar(3.5 * on + 0.0);
    U.uFacLit.value.setRGB(1, 1, 1).multiplyScalar(0.55 * sstep(0.3, 0.8, n));
    U.uFacSun.value.set(0.10 * sunAmt, 0.08 * sunAmt, 0.05 * sunAmt, 0);
    U.uOutAmb.value.setRGB(3.0, 3.25, 3.75).multiplyScalar(1 - n).add(st.tmp.setRGB(0.5, 0.85, 2.1).multiplyScalar(comp * n));
    U.uOutRefl.value.setRGB(0.42, 0.50, 0.62).multiplyScalar(1 - n).add(st.tmp.setRGB(0.10, 0.14, 0.26).multiplyScalar(comp * n));
    U.uTreeTrans.value.setRGB(1.0, 0.82, 0.45).multiplyScalar(0.15 + 0.8 * sunAmt);
    st.glowU.uHaloL.value.setRGB(1.0, 0.7, 0.42).multiplyScalar(0.35 * on);
    st.glowU.uHaloO.value.setRGB(1.0, 0.75, 0.5).multiplyScalar(0.6 * on);
    st.glowU.uSunC.value.setRGB(1.0, 0.9, 0.75);
    st.glowU.uMote.value.set(0.9 * sunAmt, look.motion, 0, 0);
    st.beamU.uBeam.value.setRGB(1.0, 0.88, 0.7).multiplyScalar(0.22 * sunAmt);
  }
};
