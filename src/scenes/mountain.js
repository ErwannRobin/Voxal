// mountain.js — "Mountain": a Dolomites lake at 07:30, late September.
//
// From a shingle shore, the eye 1.6 m above a glassy emerald lake: pale
// limestone spires in a V — a low hazy col behind the head, the big summits at
// the sides and in the upper corners — golden larches among dark spruce, a
// weathered boathouse on stilts with its jetty and two rowboats, pale boulders
// in the clear shallows, and a band of mist lying on the far water. In a dark
// room it is the blue hour: the alpenglow fading off the summits, a warm band
// low over the key side, two windows in the boathouse and one hut high on the
// right, all of it mirrored in the lake.
//
// Authored with the key light on +x (the engine mirrors the picture for a light
// on the left). Metres, the lake's surface is y = 0, the camera looks down -z
// with its pitch at 0.03 rad (the mirror test reads the horizon there).
//
// Layers and what draws them (five programs: sky, world, world instanced,
// water, glow; no shadow map — everything here is far, its light is baked):
//   * sky — kit.sky with this file's fragment: the morning gradient, a warm
//     band over the key side at dusk, altocumulus kept to the upper corners,
//     and the mist band's own share of the low sky;
//   * terrain — ONE polar grid round the camera (azimuth -1.05..1.05 rad, rings
//     that grow with distance: a few cm at the shore, ~35 m on the summits), so
//     the near shingle, the shore, the far forest and the spires 3 km away are
//     all about one buffer pixel per vertex and the silhouettes read. The
//     height is shaped by hand: shore distances per azimuth (promontory left,
//     the boathouse bank right), a back ridge whose crest makes the col, and
//     towers on scree pedestals for the summits, their walls cut into
//     buttresses and gullies; vertex colours carry forest, scree, limestone,
//     snow in a few couloirs and the hollows' shade. In the shader (footprint-
//     filtered): strata, black water streaks, shingle, planks, underwater tint,
//     alpenglow, mist. Boulders, the drift log and the boathouse share it;
//   * trees — stacked-cone spruces and larches (instanced), the far forest as
//     camera-facing three-tier impostors, all one material;
//   * water — a transparent mirror over the real lake bed: planar reflection,
//     depth-tinted emerald body, cat's-paws only in the side thirds;
//   * glow — the boathouse windows and the hut's light at night.

import { THREE } from './engine.js';
import * as K from './kit.js';

const SEED = 0x30b7a1;
const EYE = 1.6;
const PITCH = 0.03;
const TH = 1.05;                         // azimuths the terrain covers: -TH..TH

// The sun at 07:30: 18 degrees up, 120 degrees round from the view toward the
// key side — behind the right shoulder: summits front-lit, no disc in view.
const SUN = new THREE.Vector3(Math.sin(2.094) * Math.cos(0.314), Math.sin(0.314), -Math.cos(2.094) * Math.cos(0.314));
// The alpenglow at dusk comes from the same side, the sun just under the horizon.
const GLOW_DIR = new THREE.Vector3(SUN.x, 0.05, SUN.z).normalize();

// --- colours by what they show as (see island.js) ------------------------------------
function srgbLin(v) { return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
function invAces(y) {
  y = Math.min(Math.max(y, 0), 0.985);
  const a = 2.43 * y - 2.51, b = 0.59 * y - 0.03, c = 0.14 * y;
  return (-b - Math.sqrt(Math.max(b * b - 4 * a * c, 0))) / (2 * a);
}
function shows(hex, E = 1, gain = 1) {
  const f = (v) => invAces(srgbLin(v / 255)) / (0.55 * E) * gain;
  return new THREE.Color().setRGB(f((hex >> 16) & 255), f((hex >> 8) & 255), f(hex & 255));
}
const lin = (hex, s = 1) => new THREE.Color(hex).multiplyScalar(s);
const linA = (hex, s = 1) => { const c = lin(hex, s); return [c.r, c.g, c.b]; };
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const sq = (x) => x * x;
const mixA = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// --- the land ------------------------------------------------------------------------------
//
// Where the shore is, per azimuth (0 = straight ahead, + = key side): the
// distance to the first land beyond the lake. Left, a wooded promontory from
// the frame's edge out to its tip at x 29 %; ahead the far shore 1.5-1.7 km
// out; right, the bank the larches stand on, receding past the boathouse.
const SHORE = [
  [-1.25, 13], [-1.0, 15], [-0.85, 19], [-0.69, 25], [-0.6, 29], [-0.5, 35], [-0.42, 44], [-0.36, 58], [-0.32, 76],
  [-0.295, 160], [-0.27, 600], [-0.22, 1350], [-0.1, 1600], [0.05, 1700], [0.18, 1450], [0.24, 900], [0.29, 420],
  [0.34, 230], [0.39, 150], [0.44, 100], [0.48, 80], [0.52, 52], [0.56, 33], [0.6, 24], [0.68, 19], [0.85, 15], [1.25, 12]
];

// The summits: azimuth, distance, height above the lake, wall radius, pedestal
// height, wall exponent (lower = squarer tower), elongation, its direction,
// whether its gullies hold snow. Left: the big summit at x ~19 % and its
// shoulders; the portrait anchors either side of the col; right: the spire
// group at x 70-90 %.
const PEAKS = [
  { th: -0.86, D: 2300, H: 880, R: 520, Hp: 320, w: 0.55, ax: 1.5, rot: 0.6 },
  { th: -0.64, D: 2650, H: 860, R: 420, Hp: 320, w: 0.6, ax: 1.4, rot: -0.3 },
  { th: -0.47, D: 3300, H: 1320, R: 560, Hp: 430, w: 0.62, ax: 1.35, rot: 0.25, snow: true },
  { th: -0.37, D: 3500, H: 1150, R: 300, Hp: 420, w: 0.75, ax: 1.0, rot: 0 },
  { th: -0.29, D: 3800, H: 1420, R: 380, Hp: 460, w: 0.7, ax: 1.1, rot: 0.5 },
  { th: 0.30, D: 3700, H: 1400, R: 360, Hp: 460, w: 0.7, ax: 1.1, rot: -0.4 },
  { th: 0.36, D: 3150, H: 1180, R: 200, Hp: 420, w: 0.85, ax: 1.0, rot: 0 },
  { th: 0.405, D: 2950, H: 1330, R: 240, Hp: 430, w: 0.8, ax: 1.0, rot: 0, snow: true },
  { th: 0.455, D: 3050, H: 1240, R: 220, Hp: 430, w: 0.85, ax: 1.0, rot: 0 },
  { th: 0.51, D: 2850, H: 1120, R: 250, Hp: 400, w: 0.8, ax: 1.1, rot: 0.3 },
  { th: 0.58, D: 2700, H: 960, R: 330, Hp: 360, w: 0.65, ax: 1.3, rot: 0.4 },
  { th: 0.77, D: 2400, H: 880, R: 520, Hp: 320, w: 0.55, ax: 1.5, rot: -0.5 }
];

function makeWorld() {
  const N = K.noise2(SEED), N2 = K.noise2(SEED + 101), N3 = K.noise2(SEED + 202);
  const tab = (T, th) => {
    if (th <= T[0][0]) return T[0][1];
    for (let i = 1; i < T.length; i++) {
      if (th <= T[i][0]) {
        const u = (th - T[i - 1][0]) / (T[i][0] - T[i - 1][0]);
        return Math.exp(Math.log(T[i - 1][1]) * (1 - u) + Math.log(T[i][1]) * u);
      }
    }
    return T[T.length - 1][1];
  };
  const shoreR = (th) => tab(SHORE, th) * (1 + 0.1 * (N.fbm(th * 11 + 3.3, 1.7, 3) - 0.5));
  const beachR = (th) => 5.4 - 2.2 * th * th + 0.7 * (N.fbm(th * 16 + 9.1, 7.1, 2) - 0.5);
  const peaks = PEAKS.map((p, i) => {
    const x = p.D * Math.sin(p.th), z = -p.D * Math.cos(p.th);
    const reach = p.R * 1.18 * 5 * Math.max(1, p.ax);
    return Object.assign({}, p, { x, z, c: Math.cos(p.rot), s: Math.sin(p.rot), reach2: reach * reach,
      ox: 3.7 * i + 1.3, oy: 5.1 * i + 2.9, gk: 3.4 });
  });
  // What H() found last (for the colours): zone (0 the camera's shingle, 1
  // the lake bed, 2 land), distance from the shore, the land and the range's
  // own heights, and the summit it is on with how deep in a gully it is.
  const info = { zone: 0, s: 0, hl: 0, hm: 0, peak: -1, g: 1, t: 9 };

  function backRidge(x, z, r, th) {
    const a = Math.abs(th);
    const D = 5300 - 500 * sstep(0.05, 0.5, a) + 300 * (N.fbm(th * 6 + 11, 2.2, 3) - 0.5);
    const C = (1235 + 1400 * Math.min(th * th, 0.1)) * (0.9 + 0.2 * N2.ridged(x / 600 + 7, z / 600 + 3, 4));
    const sd = r - D;
    return C * (sd < 0 ? Math.exp(-sq(sd / 1500)) : Math.exp(-sq(sd / 3000)));
  }

  function range(x, z, r, th) {
    let h = backRidge(x, z, r, th);
    info.peak = -1; info.g = 1; info.t = 9;
    for (let i = 0; i < peaks.length; i++) {
      const p = peaks[i];
      const dx = x - p.x, dz = z - p.z;
      if (dx * dx + dz * dz > p.reach2) continue;
      const u = (dx * p.c - dz * p.s) / p.ax, v = dx * p.s + dz * p.c;
      const d = Math.sqrt(u * u + v * v) + 1e-6;
      // buttresses (1) and gullies (0) round the tower
      const g = N3.ridged(u / d * p.gk + p.ox, v / d * p.gk + p.oy, 3);
      const rw = p.R * (0.68 + 0.5 * g);
      const t = d / rw;
      const ph = t < 1 ? p.Hp + (p.H - p.Hp) * Math.pow(1 - t, p.w) : p.Hp * sq(Math.max(0, 1 - (t - 1) / 4));
      if (ph > h) { h = ph; info.peak = i; info.g = g; info.t = t; }
    }
    // ledges: the walls stepped into bands, as limestone beds weather
    const P = 105, f = h / P, fl = Math.floor(f);
    h += (P * (fl + sstep(0.2, 0.8, f - fl)) - h) * 0.5 * sstep(380, 620, h);
    // the crests' teeth
    h += sstep(300, 1100, h) * 85 * (N2.ridged(x / 160 + 5, z / 160 + 9, 4) - 0.45);
    return h;
  }

  // A shore that runs away from the camera is reached sideways, not along the
  // ray: how far, at this radius, to the nearest azimuth where the lake (or
  // the land) is. Searched up to ~60 m each way.
  const isLake = (r, th) => r > beachR(th) && r < shoreR(th);
  function lateral(r, th, lake) {
    const step = Math.min(0.1, 7.5 / r);
    for (let j = 1; j <= 8; j++) {
      const d = j * step;
      const m = isLake(r, th - d) === lake ? -1 : isLake(r, th + d) === lake ? 1 : 0;
      if (m) {
        // refined, so the distance (and the bank on it) is continuous
        let lo = d - step, hi = d;
        for (let q = 0; q < 5; q++) { const mid = 0.5 * (lo + hi); if (isLake(r, th + m * mid) === lake) hi = mid; else lo = mid; }
        return r * 0.5 * (lo + hi);
      }
    }
    return 1e9;
  }

  function H(x, z) {
    const r = Math.hypot(x, z), th = Math.atan2(x, -z);
    const rb = beachR(th), rs = shoreR(th);
    info.hm = 0; info.peak = -1;
    if (r <= rb) {
      const s = rb - r;
      info.zone = 0; info.s = s; info.hl = 0;
      return 0.07 * s + 0.12 * (1 - Math.exp(-s / 0.6)) + 0.05 * (N3.fbm(x * 0.9, z * 0.9, 2) - 0.5) * sstep(0, 1.5, s);
    }
    if (r < rs) {
      const u = Math.min(r - rb, rs - r, lateral(r, th, false));
      info.zone = 1; info.s = u; info.hl = 0;
      const shelf = 0.085 * u + 0.12 * (1 - Math.exp(-u / 0.6));
      const drop = Math.min(26, Math.max(0, u - 7) * 0.65);
      return -(shelf + drop) + 0.08 * (N3.fbm(x * 0.4, z * 0.4, 2) - 0.5) * sstep(0, 2, u);
    }
    const s = Math.min(r - rs, lateral(r, th, true));
    info.zone = 2; info.s = s;
    const bank = 1.6 * (1 - Math.exp(-s / 7)) + 0.1 * (1 - Math.exp(-s / 0.8)) + 0.045 * s;
    const roll = (N.fbm(x / 260, z / 260, 3) - 0.45) * 22 * sstep(10, 150, s) +
                 (N2.fbm(x / 900, z / 900, 3) - 0.4) * 110 * sstep(300, 1500, s);
    const hl = bank + roll;
    const mt = range(x, z, r, th) * sstep(rs + 120, rs + 650, r);
    info.hl = hl; info.hm = mt;
    if (mt <= hl) info.peak = -1;
    return Math.max(hl, mt);
  }

  // Forest where it grows: below the tree line, not on walls, with clearings.
  const treeLine = (x, z) => 320 + 160 * (N.fbm(x / 500 + 2, z / 500 + 8, 2) - 0.5);
  const forestMask = (x, z) => N2.fbm(x / 140 + 3.1, z / 140 + 1.7, 3);
  const larchMask = (x, z) => N3.fbm(x / 90 + 11, z / 90 + 4, 2);
  return { H, info, shoreR, beachR, peaks, N, N2, N3, treeLine, forestMask, larchMask };
}

// --- the terrain grid ------------------------------------------------------------------------
function ringRadii() {
  const step = (r) => r < 30 ? 0.05
    : r < 1000 ? 0.05 - 0.025 * Math.log(r / 30) / Math.log(1000 / 30)
      : r < 2200 ? 0.025 - 0.014 * Math.log(r / 1000) / Math.log(2.2)
        : r < 4300 ? 0.011 : 0.011 + 0.009 * Math.min(1, Math.log(r / 4300) / Math.log(8000 / 4300));
  const out = [1.2];
  let r = 1.2;
  while (r < 8000) { r = Math.min(8000, r * (1 + step(r))); out.push(r); }
  return out;
}

function terrainGeo(W) {
  const rings = ringRadii(), nth = 330, NJ = nth + 1, NI = rings.length;
  const n = NI * NJ;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3), mat = new Float32Array(n * 3);
  const zone = new Uint8Array(n), sArr = new Float32Array(n), hm = new Float32Array(n), hl = new Float32Array(n);
  const pk = new Int8Array(n), gA = new Float32Array(n), tA = new Float32Array(n);
  for (let i = 0; i < NI; i++) {
    const r = rings[i];
    for (let j = 0; j < NJ; j++) {
      const th = -TH + 2 * TH * j / nth;
      const x = r * Math.sin(th), z = -r * Math.cos(th);
      const y = W.H(x, z);
      const o = i * NJ + j;
      pos[o * 3] = x; pos[o * 3 + 1] = y; pos[o * 3 + 2] = z;
      const f = W.info;
      zone[o] = f.zone; sArr[o] = f.s; hm[o] = f.hm; hl[o] = f.hl; pk[o] = f.peak; gA[o] = f.g; tA[o] = f.t;
    }
  }
  const P = (i, j) => (Math.min(NI - 1, Math.max(0, i)) * NJ + Math.min(NJ - 1, Math.max(0, j))) * 3;
  const nv = new THREE.Vector3(), ta = new THREE.Vector3(), tb = new THREE.Vector3();
  const C = {
    shingle: linA(0x9d978c, 0.75), bed: linA(0x8f8b7c, 0.7), silt: linA(0x4f584c, 0.6),
    lime: linA(0xdccbb0, 0.44), limeWarm: linA(0xe8c48e, 0.44), limeGrey: linA(0x9c9e9c, 0.32),
    scree: linA(0xa8a399, 0.4), snow: linA(0xf2f4f6, 0.8),
    forest: linA(0x23402f, 0.5), larch: linA(0xb98a34, 0.45), meadow: linA(0x3e4a2a, 0.36), bank: linA(0x5e5a4e, 0.38)
  };
  for (let i = 0; i < NI; i++) {
    for (let j = 0; j < NJ; j++) {
      const o = i * NJ + j, o3 = o * 3;
      const a = P(i, j + 1), b = P(i, j - 1), c = P(i + 1, j), d = P(i - 1, j);
      ta.set(pos[a] - pos[b], pos[a + 1] - pos[b + 1], pos[a + 2] - pos[b + 2]);
      tb.set(pos[c] - pos[d], pos[c + 1] - pos[d + 1], pos[c + 2] - pos[d + 2]);
      nv.crossVectors(ta, tb).normalize();
      nor[o3] = nv.x; nor[o3 + 1] = nv.y; nor[o3 + 2] = nv.z;
      // hollows in shade, crests a little lighter: the change of slope across a cell
      const y = pos[o3 + 1];
      const da = ta.length() * 0.5, db = tb.length() * 0.5;
      const lap = (pos[a + 1] + pos[b + 1] - 2 * y) / Math.max(da, 1e-3) + (pos[c + 1] + pos[d + 1] - 2 * y) / Math.max(db, 1e-3);
      const ao = (1 - 0.62 * sstep(0.02, 0.5, lap)) * (1 + 0.12 * sstep(0.05, 0.6, -lap));
      const x = pos[o3], z = pos[o3 + 2], r = Math.hypot(x, z);
      const slope = 1 - nv.y;
      const nz = W.N.fbm(x / 37 + 4, z / 37 + 1, 2);
      let cc, rock = 0, shingle;
      if (zone[o] === 0) {
        cc = C.shingle; shingle = 1;
      } else if (zone[o] === 1) {
        cc = mixA(C.bed, C.silt, sstep(2, 10, sArr[o]));
        shingle = sstep(9, 3, sArr[o]) * sstep(40, 15, r);
      } else {
        const s = sArr[o], tl = W.treeLine(x, z);
        // the range's rock only above the forested foothills
        const onRange = (pk[o] >= 0 || hm[o] > hl[o]) && y > 170 + 120 * nz;
        const wall = sstep(0.38, 0.62, slope);
        const fm = W.forestMask(x, z);
        const forest = sstep(tl + 10, tl - 40, y) * sstep(0.5, 0.32, slope) * sstep(2.5, 8, s) * sstep(0.28, 0.42, fm);
        const lk = sstep(0.55, 0.7, W.larchMask(x, z));
        const lime = mixA(mixA(C.lime, C.limeWarm, sstep(0.45, 0.7, nz)), C.limeGrey, sstep(0.55, 0.3, nz) * 0.6);
        let ground = mixA(C.meadow, C.bank, sstep(2.5, 0.8, s));
        // gullies grey and darker, buttresses warm
        const gully = pk[o] >= 0 ? sstep(0.35, 0.08, gA[o]) * sstep(1.05, 0.9, tA[o]) : 0;
        if (onRange) ground = mixA(mixA(C.scree, lime, wall), C.limeGrey, gully * 0.7);
        else ground = mixA(ground, mixA(C.forest, C.bank, 0.4), sstep(0.3, 0.55, slope));
        cc = mixA(ground, mixA(C.forest, C.larch, lk * 0.55), forest);
        rock = onRange ? 0.35 + 0.65 * wall : 0.4 * wall;
        shingle = sstep(3, 0.5, s) * sstep(80, 25, r);
        // snow only in a few couloirs: the deepest gullies of two summits, on the wall
        if (pk[o] >= 0 && W.peaks[pk[o]].snow && gA[o] < 0.12 && tA[o] > 0.25 && tA[o] < 0.9 && y > 600) {
          const k2 = sstep(0.12, 0.05, gA[o]) * sstep(600, 700, y);
          cc = mixA(cc, C.snow, k2); rock *= 1 - k2;
        }
      }
      const v = (0.9 + 0.2 * nz) * (zone[o] === 2 && pk[o] >= 0 ? 1 - 0.3 * sstep(0.3, 0.05, gA[o]) : 1);
      col[o3] = cc[0] * ao * v; col[o3 + 1] = cc[1] * ao * v; col[o3 + 2] = cc[2] * ao * v;
      mat[o3] = rock; mat[o3 + 1] = 0; mat[o3 + 2] = shingle;
    }
  }
  // What the eye can never see: walking out along each azimuth, a vertex
  // under the highest slope seen so far (with a pixel's margin) is behind a
  // ridge. The camera only turns, never moves, and the mirror's eye is lower
  // still, so it sees less. The deep lake bed stays: a ray into the shelf can
  // run on under the water to it, and a hole there would show the sky.
  const hidden = new Uint8Array(n);
  for (let j = 0; j < NJ; j++) {
    let top = -1e9;
    for (let i = 0; i < NI; i++) {
      const o = i * NJ + j, rr = rings[i];
      const tn = (pos[o * 3 + 1] - EYE) / rr;
      if (tn < top - 0.004) hidden[o] = 1;
      if (pos[o * 3 + 1] > 0) top = Math.max(top, tn);
    }
  }
  const idx = [];
  for (let i = 0; i < NI - 1; i++) {
    for (let j = 0; j < nth; j++) {
      const a = i * NJ + j, b = a + 1, c = a + NJ, d = c + 1;
      if (hidden[a] && hidden[b] && hidden[c] && hidden[d]) continue;
      idx.push(a, b, d, a, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aMat', new THREE.BufferAttribute(mat, 3));
  g.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

// The lake's surface: a flat polar grid (coarser than the land) carrying the
// water's depth under each vertex in uv.x.
function waterGeo(W) {
  const rings = [];
  for (let r = 1.2; r < 7000; r *= 1.055) rings.push(r);
  rings.push(7000);
  const nth = 120, NJ = nth + 1, NI = rings.length;
  const pos = new Float32Array(NI * NJ * 3), uv = new Float32Array(NI * NJ * 2), nor = new Float32Array(NI * NJ * 3);
  const land = new Uint8Array(NI * NJ);
  for (let i = 0; i < NI; i++) {
    for (let j = 0; j < NJ; j++) {
      const th = -TH + 2 * TH * j / nth, r = rings[i];
      const x = r * Math.sin(th), z = -r * Math.cos(th), o = i * NJ + j;
      const h = W.H(x, z);
      pos[o * 3] = x; pos[o * 3 + 1] = 0; pos[o * 3 + 2] = z;
      nor[o * 3 + 1] = 1;
      uv[o * 2] = Math.max(0, -h); uv[o * 2 + 1] = 0;
      land[o] = h > 0.6 ? 1 : 0;
    }
  }
  const idx = [];
  for (let i = 0; i < NI - 1; i++) {
    for (let j = 0; j < nth; j++) {
      const a = i * NJ + j, b = a + 1, c = a + NJ, d = c + 1;
      if (land[a] && land[b] && land[c] && land[d]) continue;
      idx.push(a, b, d, a, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

// --- small geometry helpers -------------------------------------------------------------------
// Give a geometry flat vertex colour and a material code (aMat: rock, wood, shingle).
function paint(g, rgb, m = [0, 0, 0]) {
  g = g.index ? g.toNonIndexed() : g;
  g.deleteAttribute('uv');
  const n = g.getAttribute('position').count;
  const c = new Float32Array(n * 3), a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c.set(rgb, i * 3); a.set(m, i * 3); }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g.setAttribute('aMat', new THREE.BufferAttribute(a, 3));
  return g;
}
const boxG = (w, h, d, x, y, z, rgb, m) => paint(K.boxAt(w, h, d, x, y, z), rgb, m);

// A conifer of stacked cone tiers, height 1 (instanced, scaled): each tier's
// rim jagged and drooping, dark inside, lit at its tips.
function coneTree(rng, o) {
  const P = [], Nn = [], Cc = [];
  const push = (p, n, c) => { P.push(p[0], p[1], p[2]); Nn.push(n[0], n[1], n[2]); Cc.push(c, c, c); };
  const vary = () => 0.7 + 0.6 * rng();
  // trunk
  const tr = o.trunk, ts = 5;
  for (let s = 0; s < ts; s++) {
    const a0 = s / ts * 6.2832, a1 = (s + 1) / ts * 6.2832;
    const p0 = [Math.cos(a0) * tr, 0, Math.sin(a0) * tr], p1 = [Math.cos(a1) * tr, 0, Math.sin(a1) * tr];
    const q0 = [p0[0] * 0.4, 0.9, p0[2] * 0.4], q1 = [p1[0] * 0.4, 0.9, p1[2] * 0.4];
    const n0 = [Math.cos(a0), 0, Math.sin(a0)], n1 = [Math.cos(a1), 0, Math.sin(a1)];
    push(p0, n0, 0.18); push(q1, n1, 0.18); push(p1, n1, 0.18);
    push(p0, n0, 0.18); push(q0, n0, 0.18); push(q1, n1, 0.18);
  }
  for (let t = 0; t < o.tiers; t++) {
    const f = t / (o.tiers - 1);
    const yb = o.base + (0.9 - o.base) * Math.pow(f, 0.92);
    const ht = (o.tierH - 0.08 * f) ;
    const yt = Math.min(1.0, yb + ht);
    const R = (o.width * (1 - 0.9 * f) + 0.025) * (1 + (o.irreg || 0) * (rng() - 0.5));
    const off = rng() * 6.2832, segs = o.segs;
    const rim = [];
    for (let s = 0; s < segs; s++) {
      const a = off + s / segs * 6.2832;
      const rr = R * (1 + o.jag * ((s & 1) ? -0.5 : 0.5) * (0.5 + rng()));
      rim.push([Math.cos(a) * rr, yb - o.droop * R * (0.6 + 0.8 * rng()), Math.sin(a) * rr, a]);
    }
    const shade = 0.62 + 0.38 * f;
    for (let s = 0; s < segs; s++) {
      const A = rim[s], B = rim[(s + 1) % segs];
      const am = (A[3] + (s === segs - 1 ? B[3] + 6.2832 : B[3])) * 0.5;
      const cn = (a) => { const v = new THREE.Vector3(Math.cos(a) * ht, R, Math.sin(a) * ht).normalize(); return [v.x, v.y, v.z]; };
      push([0, yt, 0], cn(am), 0.3 * shade);
      push([B[0], B[1], B[2]], cn(B[3]), shade * vary());
      push([A[0], A[1], A[2]], cn(A[3]), shade * vary());
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(Nn, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(Cc, 3));
  g.setAttribute('aMat', new THREE.Float32BufferAttribute(new Float32Array(P.length), 3));
  g.computeBoundingSphere();
  return g;
}

// A far tree: three stacked triangles facing +z (turned to the camera per
// instance), normals bent outward so it is lit like a cone.
function impostorGeo() {
  const P = [], Nn = [], Cc = [];
  const tiers = [[0.0, 0.5, 0.36], [0.28, 0.75, 0.27], [0.55, 1.0, 0.17]];
  for (const [yb, yt, w] of tiers) {
    P.push(-w, yb, 0, w, yb, 0, 0, yt, 0);
    Nn.push(-0.62, 0.3, 0.72, 0.62, 0.3, 0.72, 0, 0.5, 0.87);
    Cc.push(0.55, 0.55, 0.55, 0.55, 0.55, 0.55, 1, 1, 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(Nn, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(Cc, 3));
  g.setAttribute('aMat', new THREE.Float32BufferAttribute(new Float32Array(P.length), 3));
  return g;
}

// --- GLSL ------------------------------------------------------------------------------------------

// The mist lying on the far water: a thin exponential layer (density at the
// water, falloff per metre), counted only beyond `start` metres, breathing
// slowly at the sides and never behind the head.
const MIST_GLSL = `
uniform vec4 uMist;      // density at the water (1/m), falloff (1/m), start (m), max opacity
uniform vec3 uMistCol;
float mistDepth(vec3 ro, vec3 rd, float dist) {
  float kd = uMist.y * rd.y * dist;
  float t = abs(kd) > 1e-3 ? (1.0 - exp(-kd)) / kd : 1.0 - 0.5 * kd;
  return uMist.x * exp(-uMist.y * max(ro.y, 0.0)) * t * dist;
}
float mistBreath(vec3 rd) {
  float th = atan(rd.x, -rd.z);
  float n = vnoise(vec2(th * 5.0 + uTime * 0.01, uTime * 0.009 + 4.0));
  // thickest over the far water behind the head, thin along the side shores
  return (1.0 + 0.5 * (n - 0.5) * sstep(0.12, 0.4, abs(th))) * mix(0.3, 1.0, sstep(0.36, 0.16, abs(th)));
}
vec3 applyMist(vec3 col, vec3 wp) {
  vec3 d = wp - cameraPosition;
  float dist = length(d);
  vec3 rd = d / max(dist, 1e-4);
  // the mist lies on the water, not under it: a ray into the lake stops at its surface
  if (wp.y < 0.0 && cameraPosition.y > 0.0) dist *= cameraPosition.y / max(cameraPosition.y - wp.y, 1e-3);
  float od = mistDepth(cameraPosition, rd, dist) - mistDepth(cameraPosition, rd, min(dist, uMist.z));
  float f = min(1.0 - exp(-max(od, 0.0) * mistBreath(rd)), uMist.w);
  return mix(col, uMistCol, f);
}
`;

const WORLD_PATCH = {
  key: 'mtnWorld',
  vertexHead: 'attribute vec3 aMat;\nvarying vec3 vMat;\nvarying vec3 vNrmW;\n',
  vertex: { begin_vertex: 'vMat = aMat;\nvNrmW = normalize(mat3(modelMatrix) * objectNormal);' },
  fragmentHead: MIST_GLSL + `
varying vec3 vMat;
varying vec3 vNrmW;
uniform vec3 uAlpen;     // alpenglow on the summits at dusk
uniform vec3 uGlowDir;
uniform vec3 uAbsorb;    // what a metre of lake water takes from each channel
// A shingle of rounded stones: (distance to the gap, the stone's tone).
vec2 pebbles(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0; vec2 id = vec2(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y));
    vec2 c = o + 0.15 + 0.7 * hash22(i + o) - f;
    float d = dot(c, c);
    if (d < d1) { d2 = d1; d1 = d; id = i + o; } else if (d < d2) { d2 = d; }
  }
  return vec2(sqrt(d2) - sqrt(d1), hash12(id * 1.37 + 0.5));
}
`,
  fragment: {
    color_fragment: `{
  float calmK = 1.0 - 0.5 * subjectMask(gl_FragCoord.xy / uRes);
  if (vMat.x > 0.0) {
    // limestone: thin seams and broader beds that follow the height
    float sy = vWorld.y / 27.0 + 1.1 * vnoise(vWorld.xz * 0.0035);
    float seam = pulse(sy, 0.0, 0.16, max(footprint(sy), 1e-3));
    float wallK = sstep(0.25, 0.65, 1.0 - abs(vNrmW.y));
    float bed = mix(vnoise(vec2(sy * 0.27, 1.7)), 0.5, sstep(0.25, 0.9, footprint(sy * 0.27)));
    // black water streaks down the walls
    float ax = atan(vWorld.x, -vWorld.z) * length(vWorld.xz) / 9.0;
    float st = mix(sstep(0.6, 0.85, vnoise(vec2(ax, vWorld.y / 170.0))), 0.1, sstep(0.25, 0.9, footprint(ax)));
    float patchy = sstep(0.35, 0.7, vnoise(vWorld.xz * 0.006 + 3.0));
    float sh = (1.0 - 0.3 * seam * wallK * patchy) * (0.8 + 0.4 * bed) * (1.0 - 0.38 * st * wallK);
    diffuseColor.rgb *= mix(1.0, sh, vMat.x * calmK);
  }
  if (vMat.y > 0.0) {
    // weathered boards: vertical on walls, along x on decks
    float u = abs(vNrmW.y) > 0.7 ? vWorld.x : (abs(vNrmW.x) > abs(vNrmW.z) ? vWorld.z : vWorld.x);
    float b = u / 0.19;
    float fb = footprint(b);
    float seam = pulse(b, 0.0, 0.1, max(fb, 1e-3));
    float tone = mix(hash12(vec2(floor(b), 3.1)), 0.5, sstep(0.3, 0.9, fb));
    diffuseColor.rgb *= mix(1.0, (1.0 - 0.45 * seam) * (0.82 + 0.36 * tone), vMat.y);
  }
  if (vMat.z > 0.0) {
    vec2 pp = vWorld.xz / 0.075;
    float pf = footprint(pp.x) + footprint(pp.y);
    float k = sstep(0.9, 0.35, pf) * vMat.z * calmK;
    if (k > 0.0) {
      vec2 pb = pebbles(pp);
      float gap = 1.0 - sstep(0.02, 0.14 + pf * 0.2, pb.x);
      float sh = (0.7 + 0.6 * pb.y) * (1.0 - 0.55 * gap);
      diffuseColor.rgb *= mix(1.0, sh / 0.93, k);
    }
  }
  // under the lake the water takes the red first (down and back up)
  float uw = max(-vWorld.y, 0.0);
  diffuseColor.rgb *= exp(-uAbsorb * uw * 2.2) * (1.0 - 0.35 * sstep(0.0, 0.05, uw));
}`,
    premultiplied_alpha_fragment: 'gl_FragColor.rgb = applyMist(gl_FragColor.rgb, vWorld);'
  },
  fragmentBefore: {
    opaque_fragment: `{
  float hiK = sstep(380.0, 1150.0, vWorld.y) * vMat.x;
  float face = max(dot(normalize(vNrmW), uGlowDir), 0.0);
  outgoingLight += diffuseColor.rgb * uAlpen * hiK * (0.2 + 0.8 * face);
}`
  }
};

const SKY_HEAD = MIST_GLSL + `
uniform vec3 uDusk;        // the warm band low over the key side at dusk
uniform vec4 uAlto;        // altocumulus: coverage, scale (1/m), height (m), wind (m/s)
uniform vec3 uAltoLit; uniform vec3 uAltoShade;
`;
const SKY_FRAG = `
  vec3 dir = normalize(vWorld - cameraPosition);
  vec3 c = skyBase(dir);
  float hz = exp(-max(dir.y, 0.0) * 6.0);
  float keyS = sstep(-0.35, 0.8, dir.x / max(length(dir.xz), 1e-3));
  c += uDusk * hz * keyS;
  // altocumulus: patches of small cells, high, kept to the upper corners
  if (dir.y > 0.04) {
    vec2 p = dir.xz / dir.y * uAlto.z + vec2(uTime * uAlto.w, uTime * uAlto.w * 0.35);
    vec2 q = p * uAlto.y;
    float fw = footprint(q.x) + footprint(q.y);
    int oct = fw > 0.5 ? 2 : fw > 0.15 ? 3 : 4;
    float d = fbm2(q, oct);
    float cellF = sstep(0.2, 0.8, footprint(q.x * 3.0) + footprint(q.y * 3.0));
    float cells = mix(vnoise(q * 3.0 + 7.0), 0.5, cellF);
    float where = sstep(0.1, 0.42, dir.y) * (0.3 + 0.7 * sstep(0.12, 0.5, abs(dir.x) / max(length(dir.xz), 1e-3)));
    float cov = smoothstep(1.0 - uAlto.x, 1.0 - uAlto.x + 0.2, d) * (0.55 + 0.9 * cells) * where;
    float d2 = fbm2(q + normalize(uSkySun.xz + 1e-4) * 0.25, oct);
    float lit = clamp(0.6 + (d - d2) * 2.5, 0.0, 1.0);
    vec3 cl = mix(uAltoShade, uAltoLit, lit);
    c = mix(c, cl, clamp(cov, 0.0, 0.85));
  }
  // the mist's share of the low sky: the whole ray through the layer
  {
    float dy = max(dir.y, 1e-4);
    float od = uMist.x * exp(-uMist.y * cameraPosition.y) / (uMist.y * dy) - mistDepth(cameraPosition, dir, uMist.z);
    c = mix(c, uMistCol, min(1.0 - exp(-max(od, 0.0) * mistBreath(dir)), uMist.w));
  }
  gl_FragColor = vec4(c, 0.0);
`;

const WATER_HEAD = MIST_GLSL + `
uniform vec3 uShallow; uniform vec3 uDeep; uniform vec3 uSkyRefl;
uniform vec4 uWave;     // wavelet scale (1/m), drift (m/s), base mirror lod, distortion
uniform vec4 uPaw;      // cat's-paw scale (1/m), drift, strength, turbidity (1/m)
// The reflection, clamped at the texture's border rather than faded to a
// fallback colour (a faded border reads as a pale band down each side).
vec3 mirrorAt(vec3 wp, vec2 off, float lod) {
  vec4 c = uMirrorMatrix * vec4(wp, 1.0);
  return textureLod(uMirror, clamp(c.xy / c.w + off, 0.002, 0.998), lod).rgb;
}
vec2 wave(vec2 x) {
  vec2 a = x * uWave.x + vec2(uTime * uWave.y, uTime * uWave.y * 0.6);
  vec2 b = x * uWave.x * 2.3 - vec2(uTime * uWave.y * 0.5, -uTime * uWave.y * 0.8);
  float fa = 1.0 - sstep(0.15, 0.6, footprint(a.x) + footprint(a.y));
  float fb = 1.0 - sstep(0.15, 0.6, footprint(b.x) + footprint(b.y));
  vec2 e = vec2(0.08, 0.0);
  vec2 g = vec2(vnoise(a + e.xy) - vnoise(a - e.xy), vnoise(a + e.yx) - vnoise(a - e.yx)) * fa;
  g += 0.5 * vec2(vnoise(b + e.xy) - vnoise(b - e.xy), vnoise(b + e.yx) - vnoise(b - e.yx)) * fb;
  return g;
}
`;
const WATER_FRAG = `
  vec3 Vd = cameraPosition - vWorld;
  float dist = length(Vd);
  vec3 V = Vd / max(dist, 1e-4);
  float NdV = clamp(abs(V.y), 1e-3, 1.0);
  float calm = 1.0 - subjectMask(gl_FragCoord.xy / uRes);
  float th = atan(vWorld.x, -vWorld.z);
  float side = sstep(0.22, 0.45, abs(th)) * calm;
  // cat's-paws: two still patterns of wind patches, each fading in and out over 30 s
  float pawK = side * uPaw.z * sstep(30.0, 70.0, dist) * sstep(700.0, 300.0, dist);
  float paw = 0.0;
  if (pawK > 0.0) {
    vec2 q = vWorld.xz * uPaw.x;
    float pf = footprint(q.x) + footprint(q.y);
    float wa = sq(sin(uTime * 0.05236));
    float na = fbm2(q + vec2(uTime * uPaw.y, 0.0), 3);
    float nb = fbm2(q * 1.3 + vec2(17.3, 5.1) + vec2(0.0, uTime * uPaw.y), 3);
    paw = wa * sstep(0.6, 0.72, na) + (1.0 - wa) * sstep(0.6, 0.72, nb);
    paw = mix(paw, 0.1, sstep(0.5, 1.5, pf)) * pawK;
  }
  // wavelets: in the paws, and lapping near the shore at the bottom corners
  float wk = paw + 0.45 * side * sstep(14.0, 5.0, dist);
  vec2 g = wk > 0.0 ? wave(vWorld.xz) * wk : vec2(0.0);
  float F = 0.04 + 0.96 * pow(1.0 - NdV, 4.0);
  vec3 refl = uMirrorOn > 0.5 ? mirrorAt(vWorld, g * uWave.w, uWave.z + paw * 1.3) : uSkyRefl;
  refl = mix(refl, uSkyRefl, paw * 0.18);
  // under the surface: the bed shows through the shallows
  float depth = max(vUv.x, 0.0);
  float ct = sqrt(max(1.0 - (1.0 - NdV * NdV) / 1.77, 0.05));
  float T = exp(-uPaw.w * depth / ct) * sstep(16.0, 10.0, depth);
  vec3 body = mix(uShallow, uDeep, sstep(0.6, 5.0, depth));
  body = applyMist(engFog(body, vWorld), vWorld);
  float a = clamp(1.0 - (1.0 - F) * T, 0.0, 1.0);
  gl_FragColor = vec4((F * refl + (1.0 - F) * (1.0 - T) * body) / max(a, 1e-3), a);
`;

const GLOW_FRAG = `
  vec2 c = vUv * 2.0 - 1.0;
  float r2 = dot(c, c);
  float m = uRound > 0.5 ? (exp(-r2 * 5.0) * 0.35 + exp(-r2 * 70.0)) * step(r2, 1.0) : 1.0;
  gl_FragColor = vec4(engFog(uGlow * uEmis * m, vWorld), uRound > 0.5 ? 1.0 : 0.0);
`;

// --- the scene ---------------------------------------------------------------------------------------

export default {
  id: 'mountain',
  camera: { pos: [0, EYE, 0], target: [0, EYE + Math.tan(PITCH) * 1000, -1000], fov: 50, near: 0.8, far: 14000 },
  nearness: [3, 25],

  build(k) {
    const st = {};
    const W = makeWorld();
    const rng = k.rng(SEED);
    st.W = W;

    // --- sky and light ------------------------------------------------------------------------
    const mistU = { uMist: { value: new THREE.Vector4(0.0009, 1 / 16, 650, 0.75) }, uMistCol: { value: shows(0xccd7e0) } };
    const skyO = {
      zenith: shows(0x3e6fa8), horizon: shows(0xb2cde4), ground: lin(0x55645a, 0.6),
      zenithNight: shows(0x24375e, 0.25), horizonNight: shows(0x56658a, 0.25), groundNight: lin(0x262c3c, 0.5),
      sunDir: SUN.toArray(), sunColor: 0xfff0d8, sunIntensity: 0.3, disc: 0, haze: 0.42,
      cloud: { coverage: 0.3, lit: shows(0xf4f2ee), shade: shows(0xb7c0cc), litNight: shows(0xc89a9a, 0.25), shadeNight: shows(0x4a4e6a, 0.25) },
      fragmentHead: SKY_HEAD, fragment: SKY_FRAG
    };
    const sky = K.sky(k, skyO);
    Object.assign(sky.mesh.material.uniforms, mistU, {
      uDusk: { value: new THREE.Color(0, 0, 0) },
      uAlto: { value: new THREE.Vector4(0.3, 0.00055, 4200, 2.5) },
      uAltoLit: { value: shows(0xf6f3ee) }, uAltoShade: { value: shows(0xb9c3d0) }
    });
    st.sky = sky;
    st.env = K.envFollower(k, skyO, 0.25, 1);
    st.env(0);
    const sun = new THREE.DirectionalLight(0xffffff, 8);
    sun.position.copy(SUN).multiplyScalar(1000);
    k.scene.add(sun);
    st.sun = sun;

    // --- the land --------------------------------------------------------------------------------
    const worldU = Object.assign({}, mistU, {
      uAlpen: { value: new THREE.Color(0, 0, 0) }, uGlowDir: { value: GLOW_DIR.clone() },
      uAbsorb: { value: new THREE.Vector3(0.6, 0.12, 0.16) }
    });
    st.worldU = worldU;
    const patch = Object.assign({}, WORLD_PATCH, { uniforms: worldU });
    const worldMat = (recv) => k.std({ vertexColors: true, roughness: 0.92, metalness: 0, receiver: recv, patch });
    const terrain = new THREE.Mesh(terrainGeo(W), worldMat(0.3));
    terrain.frustumCulled = false;
    k.scene.add(terrain);

    // --- boulders in the shallows, the drift log ---------------------------------------------------
    const rocks = [];
    const ico = THREE.mergeVertices(new THREE.IcosahedronGeometry(1, 1).deleteAttribute('normal').deleteAttribute('uv'));
    for (let n = 0, tries = 0; n < 36 && tries < 400; tries++) {
      const side = rng() < 0.5 ? -1 : 1;
      const th = side * rng.range(0.3, 1.0), r = rng.range(3.4, 12);
      const x = r * Math.sin(th), z = -r * Math.cos(th);
      const y0 = W.H(x, z);
      if (y0 < -0.9 || W.info.zone === 2) continue;
      const s = rng.range(0.12, 0.45) * (r < 6 ? 0.6 : 1.0);
      const g = ico.clone();
      const p = g.getAttribute('position'), o = rng() * 100;
      for (let i = 0; i < p.count; i++) {
        const vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
        const f = 1 + 0.28 * (W.N3.fbm(vx * 1.3 + o, vz * 1.3 + vy * 0.7, 3) - 0.5);
        p.setXYZ(i, vx * f * s * 1.2, vy * f * s * 0.55, vz * f * s);
      }
      g.rotateY(rng() * 6.28);
      g.translate(x, y0 + s * 0.05, z);
      const gf = g.toNonIndexed();
      gf.computeVertexNormals();
      const tone = rng.range(0.85, 1.1);
      const pg = paint(gf, linA(0xb8b0a2, 0.42 * tone), [0.15, 0, 0]);
      const pc = pg.getAttribute('color'), pp = pg.getAttribute('position');
      for (let i = 0; i < pc.count; i++) {
        const v = 0.75 + 0.5 * W.N2.fbm(pp.getX(i) * 9 + o, pp.getZ(i) * 9 + pp.getY(i) * 5, 2);
        pc.setXYZ(i, pc.getX(i) * v, pc.getY(i) * v, pc.getZ(i) * v);
      }
      rocks.push(pg);
      n++;
    }
    {
      const th = -0.62, r = 6.4;
      const x = r * Math.sin(th), z = -r * Math.cos(th);
      const log = new THREE.CylinderGeometry(0.1, 0.13, 2.8, 9).rotateZ(Math.PI / 2).rotateY(0.5);
      log.deleteAttribute('uv');
      log.translate(x, W.H(x, z) + 0.1, z);
      rocks.push(paint(log, linA(0x9a9184, 0.42), [0, 0, 0]));
    }
    k.scene.add(new THREE.Mesh(K.merge(rocks.map((g) => g.index ? g.toNonIndexed() : g)), worldMat(0.5)));

    // --- the boathouse, its jetty, two rowboats ----------------------------------------------------
    const bh = boathouse(W, k, worldMat(0.1), rng);
    st.windows = bh.windows;

    // --- trees ---------------------------------------------------------------------------------------
    const treeMat = k.std({ vertexColors: true, roughness: 0.95, metalness: 0, side: THREE.DoubleSide, receiver: 0.2, patch });
    const spruceG = coneTree(rng, { tiers: 12, segs: 11, width: 0.24, tierH: 0.24, base: 0.06, jag: 0.8, droop: 0.35, trunk: 0.02, irreg: 0.25 });
    const larchG = coneTree(rng, { tiers: 16, segs: 7, width: 0.2, tierH: 0.19, base: 0.14, jag: 1.4, droop: 0.1, trunk: 0.018, irreg: 0.7 });
    const SPR = linA(0x2a4634, 0.8), LAR = linA(0xd9a441, 0.38);
    const spruces = [], larches = [];
    const tint = (base, v) => new THREE.Color(base[0] * v, base[1] * v * rng.range(0.92, 1.08), base[2] * v);
    const plant = (list, th, r, h, base, wscale = 1) => {
      const x = r * Math.sin(th), z = -r * Math.cos(th);
      const y = W.H(x, z);
      if (W.info.zone !== 2 || y < 0.4) return false;
      if (Math.hypot(x - bh.cx, z - bh.cz) < 9) return false;
      list.push({ p: [x, y - 0.3, z], r: [0, rng() * 6.28, 0], s: [h * wscale * rng.range(0.85, 1.15), h, h * wscale * rng.range(0.85, 1.15)], c: tint(base, rng.range(0.8, 1.15)) });
      return true;
    };
    // the promontory: tall spruces framing the left edge, smaller toward its tip
    for (let n = 0, i = 0; n < 9 && i < 200; i++) if (plant(spruces, rng.range(-1.0, -0.58), rng.range(34, 70), rng.range(12, 20), SPR)) n++;
    for (let n = 0, i = 0; n < 22 && i < 300; i++) {
      const lk = rng() < 0.25;
      if (plant(lk ? larches : spruces, rng.range(-0.58, -0.31), rng.range(50, 160), rng.range(6, 11), lk ? LAR : SPR)) n++;
    }
    // right: three larches on the near bank, more along it, spruces behind the boathouse
    for (let n = 0, i = 0; n < 3 && i < 200; i++) if (plant(larches, rng.range(0.6, 0.82), rng.range(22, 34), rng.range(6, 8.5), LAR)) n++;
    for (let n = 0, i = 0; n < 5 && i < 200; i++) if (plant(larches, rng.range(0.5, 0.64), rng.range(40, 95), rng.range(7, 10), LAR)) n++;
    for (let n = 0, i = 0; n < 10 && i < 300; i++) if (plant(spruces, rng.range(0.36, 0.58), rng.range(105, 230), rng.range(13, 22), SPR)) n++;
    // the mid-distance woods along both shores
    for (let n = 0, i = 0; n < 320 && i < 6000; i++) {
      const th = rng.range(-1.0, 1.0), r = Math.exp(rng.range(Math.log(140), Math.log(650)));
      const x = r * Math.sin(th), z = -r * Math.cos(th);
      if (W.forestMask(x, z) < 0.36) continue;
      const lk = W.larchMask(x, z) > 0.58 && rng() < 0.6;
      if (plant(lk ? larches : spruces, th, r, rng.range(14, 26), lk ? LAR : SPR)) n++;
    }
    const addInst = (geo, list) => {
      if (!list.length) return;
      const m = K.instances(k, geo, treeMat, list, { receiveShadow: false });
      k.scene.add(m);
    };
    addInst(spruceG, spruces);
    addInst(larchG, larches);
    // the far forest: impostors turned to the camera
    const far = [];
    const nFar = Math.round(4200 * Math.max(0.5, k.quality.particles));
    for (let n = 0, i = 0; n < nFar && i < 60000; i++) {
      const th = rng.range(-1.02, 1.02), r = Math.exp(rng.range(Math.log(600), Math.log(4800)));
      const x = r * Math.sin(th), z = -r * Math.cos(th);
      const y = W.H(x, z);
      if (W.info.zone !== 2 || W.info.s < 6 || y > W.treeLine(x, z) || W.forestMask(x, z) < 0.38) continue;
      const e = 4;
      const sl = Math.hypot(W.H(x + e, z) - W.H(x - e, z), W.H(x, z + e) - W.H(x, z - e)) / (2 * e);
      if (sl > 0.75) continue;
      const lk = W.larchMask(x, z) > 0.6 && rng() < 0.7;
      const h = rng.range(18, 30);
      far.push({ p: [x, y - 1, z], r: [0, Math.atan2(-x, -z), 0], s: [h * rng.range(0.85, 1.2), h, h], c: tint(lk ? LAR : SPR, rng.range(0.75, 1.15)) });
      n++;
    }
    addInst(impostorGeo(), far);

    // --- the lights of the blue hour -------------------------------------------------------------------
    const glowMat = (round) => k.shader({
      uniforms: { uGlow: { value: new THREE.Color(0, 0, 0) }, uRound: { value: round ? 1 : 0 } },
      head: 'uniform vec3 uGlow;\nuniform float uRound;\n', fragment: GLOW_FRAG,
      transparent: round, additive: round, side: THREE.DoubleSide
    });
    st.glows = [];
    for (const wdw of bh.windows) {
      const m = new THREE.Mesh(wdw, glowMat(false));
      k.scene.add(m);
      st.glows.push({ m, col: lin(0xffb070), base: 2.2, day: lin(0x2a3138, 0.35) });
    }
    {
      // the hut high on the right: on a ledge of the spire group's pedestal
      const th = 0.535, r = 2350;
      const x = r * Math.sin(th), z = -r * Math.cos(th);
      const y = W.H(x, z) + 12;
      const disc = new THREE.Mesh(new THREE.PlaneGeometry(56, 56), glowMat(true));
      disc.position.set(x, y, z);
      disc.lookAt(0, EYE, 0);
      disc.renderOrder = 20;
      k.scene.add(disc);
      st.glows.push({ m: disc, col: lin(0xffa860), base: 5.0, day: new THREE.Color(0, 0, 0) });
    }

    // --- the lake ---------------------------------------------------------------------------------------
    const water = new THREE.Mesh(waterGeo(W), null);
    water.frustumCulled = false;
    water.renderOrder = 5;
    const scale = k.quality.mirror ? Math.min(1, k.quality.mirror * 1.6) : 0.5;
    const pm = K.planarMirror(k, water, { normal: new THREE.Vector3(0, 1, 0), scale, every: 2 });
    const waterU = Object.assign({}, pm.uniforms, mistU, {
      uShallow: { value: shows(0x2f7f78) }, uDeep: { value: shows(0x15394a) }, uSkyRefl: { value: shows(0x9cb8d0) },
      uWave: { value: new THREE.Vector4(1.1, 0.07, 0.35, 0.035) },
      uPaw: { value: new THREE.Vector4(0.018, 0.12, 1.0, 0.22) }
    });
    water.material = k.shader({ uniforms: waterU, fragmentHead: pm.glsl + WATER_HEAD, fragment: WATER_FRAG, transparent: true, depthWrite: false });
    k.scene.add(water);
    st.waterU = waterU;
    st.mistU = mistU;
    st.day = {
      shallow: shows(0x2f7f78), deep: shows(0x15394a), skyRefl: shows(0x9cb8d0), mist: shows(0xccd7e0),
      shallowN: shows(0x1d4a52, 0.25), deepN: shows(0x13253a, 0.25), skyReflN: shows(0x3a4a6c, 0.25), mistN: shows(0x6a7590, 0.25),
      dusk: shows(0xc89078, 0.25), alpen: lin(0xf2a38a), altoLit: shows(0xf6f3ee), altoShade: shows(0xb9c3d0),
      altoLitN: shows(0xc49aa0, 0.25), altoShadeN: shows(0x404866, 0.25)
    };
    return st;
  },

  update(k, st, t, look) {
    const n = look.night, key = look.key, E = look.exposure;
    const comp = (0.65 + 0.35 * E) / E;
    const lift = 1 + (comp - 1) * n;
    const D = st.day;
    // the sun is down at the blue hour; what is left is the sky
    st.sun.color.setRGB(1.0, 0.86, 0.7);
    st.sun.intensity = 7.5 * (0.72 + 0.28 * key) * (1 - n);
    if (st.env(n)) k.renderer.resetState();
    k.scene.environmentIntensity = (0.45 + 0.2 * (1 - key)) * (1 - n) + 1.0 * n;
    const U = st.sky.mesh.material.uniforms;
    U.uSkySunCol.value.setRGB(1.0, 0.94, 0.82).multiplyScalar(0.3 * (1 - n));
    U.uDusk.value.copy(D.dusk).sub(U.uHorizonN.value).multiplyScalar(n);
    U.uAltoLit.value.copy(D.altoLit).lerp(D.altoLitN, n);
    U.uAltoShade.value.copy(D.altoShade).lerp(D.altoShadeN, n);
    // aerial perspective toward the horizon's colour
    const hz = new THREE.Color().copy(U.uHorizon.value).lerp(U.uHorizonN.value, n);
    k.fog({ density: 6e-5, falloff: 1 / 1800, base: 0, max: 0.85, color: hz, sun: new THREE.Color(0, 0, 0), sunDir: SUN });
    st.mistU.uMistCol.value.copy(D.mist).lerp(D.mistN, n);
    // the alpenglow: summits catching the last light, fading with the hour
    st.worldU.uAlpen.value.copy(D.alpen).multiplyScalar(0.55 * n * (1.2 - 0.5 * n) * lift);
    st.waterU.uShallow.value.copy(D.shallow).lerp(D.shallowN, n);
    st.waterU.uDeep.value.copy(D.deep).lerp(D.deepN, n);
    st.waterU.uSkyRefl.value.copy(D.skyRefl).lerp(D.skyReflN, n);
    const on = sstep(0.3, 0.85, n);
    for (const g of st.glows) {
      g.m.material.uniforms.uGlow.value.copy(g.day).multiplyScalar(1 - on).add(g.col.clone().multiplyScalar(g.base * on));
    }
  }
};

// The boathouse on stilts at the water's edge, its long side to the camera,
// the boat door at the lake end; a jetty along its front and two rowboats.
function boathouse(W, k, mat, rng) {
  const th = 0.462, r0 = W.shoreR(th);
  const cx = r0 * Math.sin(th), cz = -r0 * Math.cos(th);
  const toCam = new THREE.Vector2(-cx, -cz).normalize();
  const rot = Math.atan2(toCam.x, toCam.y);
  const WOOD = linA(0x8d877c, 0.5), DARK = linA(0x3a342e, 0.4), ROOF = linA(0x4a4038, 0.32), DOOR = linA(0x15130f, 0.3);
  const WD = [0, 1, 0];
  const parts = [];
  for (const px of [-3.8, -1.3, 1.3, 3.8]) for (const pz of [-2.3, 2.3]) parts.push(boxG(0.24, 3.0, 0.24, px, -2.0, pz, DARK, WD));
  parts.push(boxG(8.6, 0.22, 5.3, 0, 0.95, 0, DARK, WD));
  parts.push(boxG(8.0, 2.7, 4.8, 0, 1.17, 0, WOOD, WD));
  parts.push(boxG(0.08, 2.1, 3.0, -4.02, 1.17, 0, DOOR));
  // gable ends and the roof
  const gable = (x) => {
    const g = new THREE.BufferGeometry();
    const P = [x, 3.87, -2.4, x, 3.87, 2.4, x, 5.55, 0];
    if (x > 0) P.splice(0, 6, x, 3.87, 2.4, x, 3.87, -2.4);
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.computeVertexNormals();
    return paint(g, WOOD, WD);
  };
  parts.push(gable(-4.0), gable(4.0));
  const pitch = Math.atan2(1.75, 2.45);
  for (const s of [-1, 1]) {
    const slab = new THREE.BoxGeometry(8.9, 0.14, 3.25);
    slab.rotateX(s * pitch);
    slab.translate(0, 4.72, s * 1.32);
    parts.push(paint(slab, ROOF));
  }
  // a veranda along the front with its rail, the jetty beyond it
  parts.push(boxG(6.0, 0.14, 1.1, 0.6, 1.0, 2.95, WOOD, WD));
  parts.push(boxG(6.0, 0.08, 0.08, 0.6, 2.0, 3.45, WOOD));
  for (const px of [-2.3, 0.6, 3.5]) parts.push(boxG(0.08, 1.0, 0.08, px, 1.0, 3.45, WOOD));
  parts.push(boxG(13.0, 0.12, 1.3, -7.0, 0.55, 4.5, WOOD, WD));
  for (let px = -13; px <= -1; px += 2.4) for (const pz of [3.95, 5.05]) parts.push(boxG(0.16, 2.2, 0.16, px, -1.6, pz, DARK));
  // rowboats: half shells with a dark floor
  const boat = (x, z, a, rgb) => {
    const hull = new THREE.SphereGeometry(1, 14, 5, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
    hull.scale(2.0, 0.42, 0.62).rotateY(a).translate(x, 0.28, z);
    const floor = new THREE.CircleGeometry(1, 14).rotateX(-Math.PI / 2).scale(1.9, 1, 0.56).rotateY(a).translate(x, 0.22, z);
    return [paint(hull, rgb), paint(floor, linA(0x2a241e, 0.4), WD)];
  };
  parts.push(...boat(-12.2, 6.3, 0.15, linA(0x7a3a2a, 0.5)), ...boat(-6.0, 1.0, -0.1, linA(0x4a6a78, 0.5)));
  const g = K.merge(parts.map((p) => p.index ? p.toNonIndexed() : p));
  g.rotateY(rot);
  g.translate(cx, 0, cz);
  k.scene.add(new THREE.Mesh(g, mat));
  // the two windows on the long side (lit at dusk)
  const windows = [-1.4, 1.7].map((wx) => {
    const q = new THREE.PlaneGeometry(0.75, 0.85);
    q.translate(wx, 2.45, 2.43);
    q.rotateY(rot);
    q.translate(cx, 0, cz);
    return q;
  });
  return { cx, cz, windows };
}
