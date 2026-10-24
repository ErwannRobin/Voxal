// countryside.js — "Countryside": Val d'Orcia, Tuscany, 18:00, mid-June.
//
// From a grassy knoll, the eye 1.5 m over the meadow and ~30 m over the valley:
// golden wheat on rolling clay hills under a low raking sun, ahead and to the
// key side, out of frame (rims on the wheat, long shadows). On the right a
// white gravel road zig-zags up a crest between cypresses to a stone casale
// with its dovecote tower, a barn and a haystack; below it a cut hay field
// with round bales. On the left an umbrella pine, its flat dark crown in the
// upper corner, and three olives on the knoll's flank. Behind the head the
// valley dips and three or four ridges recede, each lighter in the warm haze,
// with a hill town on each side and the faint dome of Monte Amiata. Poppies
// and long grass in the bottom corners. In a dark room it is 21:15: the sky
// orange over the key side and lavender above, the hills blue-violet, the
// casale's windows, the farms and the towns lit, fireflies in the grass.
//
// Authored with the key light on +x (the engine mirrors the picture for a light
// on the left). Metres; the valley floor is around y = 0, the camera looks down
// -z, pitched 1 degree down.
//
// Layers and what draws them (five programs: sky, world, cards, glow and the
// shadow map's depth):
//   * sky — kit.sky with this file's fragment: a warm gradient, fair-weather
//     cumulus heaped in the upper corners (analytic, lit from the key side),
//     and at dusk an orange band low over the key side;
//   * world — ONE k.std with vertex colours and a code per vertex (aMat):
//       - terrain: one polar grid round the camera (rings that grow with
//         distance, so the meadow at your feet and Amiata 20 km away are both
//         about a buffer pixel per vertex), shaped by hand (the knoll, the
//         casale's crest, the left hill, four ridges, Amiata). In the shader,
//         filtered by the pixel: the fields (a warped Voronoi of parcels, each
//         a crop: wheat with its tramlines, cut hay, green fallow, clay, woods
//         on the far hills, the vineyard; a few fields drawn on purpose), the
//         white road, the meadow and its poppies, the land's cavity shading,
//         cloud shadows drifting over the far fields, and the wheat's sheen,
//         its glow toward the sun and its wind waves;
//       - trees: cypresses as smooth lathed flames (no facets: their normals
//         come from the surface itself), the umbrella pine's crown and the
//         olives' as heaps of smooth clumps whose normals lean toward the
//         crown's, with tufts drawn in the shader and faded by footprint;
//       - the casale, barn, bales, far farms and hill towns;
//   * cards — the long grass, poppies and chamomile in the bottom corners,
//     stirring a centimetre or so (more when the subject moves). A blade
//     faces the camera and is never thinner than the redraw's pixel; one that
//     had to be widened shows its own colour only in proportion. Thin blades
//     were most of what a still room cost the encoder;
//   * glow — lit windows, farm and town lights, and fireflies at dusk.
// One cached shadow map (the sun does not move) gives the cypresses, the pine
// and the bales their long shadows; a shadow seen edge-on, thinner than the
// redraw's pixel, fades to the light it takes away.

import { THREE } from './engine.js';
import * as K from './kit.js';

const SEED = 0x7c0a1d;
const EYE = 1.5;
const PITCH = 0.0175;                 // 1 degree down
const TH = 1.12;                      // azimuths the terrain covers: -TH..TH
const D2R = Math.PI / 180;

// The sun at 18:00 in June: 22 degrees up, from the key side, its light coming
// 20 degrees toward the camera (the sun a little ahead of the key side, out
// of frame): raking light, rims on the wheat, long shadows reaching left and
// toward us.
const SUN = new THREE.Vector3(Math.cos(22 * D2R) * Math.cos(20 * D2R), Math.sin(22 * D2R), -Math.cos(22 * D2R) * Math.sin(20 * D2R)).normalize();

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
const mulA = (a, s) => [a[0] * s, a[1] * s, a[2] * s];

// --- where things are -------------------------------------------------------------------
const CAS = { x: 212, z: -452 };                                  // the casale, on its crest
const AMI = { x: 20000 * Math.sin(-0.36), z: -20000 * Math.cos(-0.36) };
const PINE = { x: -17, z: -33 };
// The road, from off the right edge up the crest's face to the casale's yard.
const ROAD = [[184, -158], [126, -230], [172, -290], [136, -344], [170, -396], [147, -436], [199, -444]];
// Fields that are drawn on purpose, not by the dice: centre xz, radii; crop.
const ZONES = [   // (the crops: 0 wheat, 1 cut hay, 2 green, 3 clay, 4 vines, 5 olive ground, 6 fallow)
  { c: [96, -136], r: [44, 30], crop: 1 },          // the cut hay field with its bales
  { c: [246, -352], r: [38, 52], crop: 4 },         // the vineyard under the casale
  { c: [CAS.x, CAS.z], r: [42, 36], crop: 2 }       // the casale's own grass
];
const RIDGES = [
  { R: 1350, wf: 330, wb: 650, h: 44, hv: 14, dip: 0.55, f: 2.6, o: 1.3 },
  { R: 2500, wf: 520, wb: 1000, h: 95, hv: 22, dip: 0.2, f: 2.1, o: 4.2 },
  { R: 4100, wf: 800, wb: 1500, h: 190, hv: 32, dip: 0.05, f: 1.7, o: 7.7 },
  { R: 6600, wf: 1200, wb: 2400, h: 380, hv: 55, dip: 0, f: 1.4, o: 2.2 }
];

// --- the land -------------------------------------------------------------------------------
function makeWorld() {
  const N = K.noise2(SEED), N2 = K.noise2(SEED + 31), N3 = K.noise2(SEED + 77);
  const smax = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.max(a, b) + h * h * k * 0.25; };
  const g2 = (x, z, cx, cz, rx, rz) => Math.exp(-(sq((x - cx) / rx) + sq((z - cz) / rz)));
  const centre = (th) => Math.exp(-sq(th / 0.34));
  const knoll = (x, z) => g2(x, z, -22, 12, 135, 112);
  function H(x, z) {
    const r = Math.hypot(x, z), th = Math.atan2(x, -z);
    let y = 2.5 + 6 * (N.fbm(x / 520 + 3.1, z / 520 + 1.7, 3) - 0.5);
    // the crete: low clay swells across the valley, quieter behind the head
    y += 15 * (N2.fbm(x / 190 + 7.3, z / 190 + 2.9, 3) - 0.42) * sstep(160, 420, r) * (1 - 0.8 * centre(th));
    y += 30 * knoll(x, z);
    y += 0.35 * (N3.fbm(x / 5 + 1.1, z / 5 + 4.4, 2) - 0.5) * (1 - sstep(25, 70, r));
    y += 50 * g2(x, z, CAS.x, CAS.z, 105, 150);
    y += 34 * g2(x, z, -290, -430, 170, 160);
    for (const R of RIDGES) {
      const Rc = R.R * (1 + 0.13 * (N3.fbm(th * R.f + R.o, R.o * 0.7, 3) - 0.5) * 2);
      const hc = (R.h + R.hv * (N2.fbm(th * R.f * 1.7 + R.o, 3.3 + R.o, 3) - 0.5) * 2) * (1 - R.dip * centre(th));
      const d = r - Rc;
      const p = d < 0 ? Math.exp(-sq(d / R.wf)) : Math.exp(-sq(d / R.wb));
      const v = hc * p * (1 + 0.14 * (N.fbm(x / 420 + R.o, z / 420, 3) - 0.5));
      y = smax(y, v, 5);
    }
    const ad = Math.hypot(x - AMI.x, z - AMI.z);
    if (ad < 7000) y = smax(y, 1650 * Math.pow(1 - sq(ad / 7000), 1.6) * (1 + 0.05 * (N.fbm(x / 1500, z / 1500, 3) - 0.5)), 40);
    return y;
  }
  return { H, N, N2, N3, knoll };
}
const W = makeWorld();
const GROUND0 = W.H(0, 0);
const CAM_Y = GROUND0 + EYE;

// The road's distance (metres), for placing things beside it.
function roadDist(x, z) {
  let d = 1e9;
  for (let i = 0; i + 1 < ROAD.length; i++) {
    const [ax, az] = ROAD[i], [bx, bz] = ROAD[i + 1];
    const px = x - ax, pz = z - az, ex = bx - ax, ez = bz - az;
    const h = Math.min(1, Math.max(0, (px * ex + pz * ez) / (ex * ex + ez * ez)));
    d = Math.min(d, Math.hypot(px - ex * h, pz - ez * h));
  }
  return d;
}
const inZone = (z, x, zz, m = 1) => Math.hypot((x - z.c[0]) / z.r[0], (zz - z.c[1]) / z.r[1]) < m;

// --- the terrain grid ------------------------------------------------------------------------
function ringRadii() {
  const out = [1.0];
  let r = 1.0;
  while (r < 24000) {
    const s = r < 25 ? 0.05 : r < 1800 ? 0.017 : r < 8000 ? 0.024 : 0.06;
    r = Math.min(24000, r * (1 + s));
    out.push(r);
  }
  return out;
}

function terrainGeo() {
  const rings = ringRadii(), nth = 280, NJ = nth + 1, NI = rings.length;
  const n = NI * NJ;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3), mat = new Float32Array(n * 4);
  const C = {
    green: linA(0x86a04e, 0.55), dry: linA(0xc9b46c, 0.62), clay: linA(0xa88a6a, 0.55)
  };
  for (let i = 0; i < NI; i++) {
    const r = rings[i];
    const e = Math.max(0.04, r * 0.008);
    for (let j = 0; j < NJ; j++) {
      const th = -TH + 2 * TH * j / nth;
      const x = r * Math.sin(th), z = -r * Math.cos(th);
      const y = W.H(x, z);
      const o = i * NJ + j;
      pos[o * 3] = x; pos[o * 3 + 1] = y; pos[o * 3 + 2] = z;
      const hx = W.H(x + e, z) - W.H(x - e, z), hz = W.H(x, z + e) - W.H(x, z - e);
      const nv = new THREE.Vector3(-hx, 2 * e, -hz).normalize();
      nor[o * 3] = nv.x; nor[o * 3 + 1] = nv.y; nor[o * 3 + 2] = nv.z;
      // the knoll's meadow, and fields beyond it
      const kn = W.knoll(x, z);
      const meadow = sstep(0.42, 0.6, kn + 0.06 * (W.N.fbm(x / 25, z / 25, 2) - 0.5));
      const dryK = sstep(0.32, 0.72, W.N2.fbm(x / 9 + 2, z / 9 + 5, 3));
      const c = mulA(mixA(C.green, C.dry, 0.2 + 0.75 * dryK), 0.9 + 0.2 * W.N3.fbm(x / 3 + 7, z / 3 + 1, 2));
      col[o * 3] = c[0]; col[o * 3 + 1] = c[1]; col[o * 3 + 2] = c[2];
      // hollows a little darker, crests a little lighter: the land's own shading
      const ec = Math.max(1.5, r * 0.02);
      const cav = (W.H(x + ec, z) + W.H(x - ec, z) + W.H(x, z + ec) + W.H(x, z - ec) - 4 * y) / ec;
      const ao = (1 - 0.3 * sstep(0.01, 0.16, cav)) * (1 + 0.07 * sstep(0.01, 0.12, -cav));
      mat[o * 4] = 0; mat[o * 4 + 1] = 1 - meadow; mat[o * 4 + 2] = 1 - nv.y; mat[o * 4 + 3] = ao;
    }
  }
  // What the eye can never see (it only turns, never moves): a vertex under
  // the highest slope seen so far along its azimuth is behind a crest.
  const hidden = new Uint8Array(n);
  for (let j = 0; j < NJ; j++) {
    let top = -1e9;
    for (let i = 0; i < NI; i++) {
      const o = i * NJ + j, rr = rings[i];
      const tn = (pos[o * 3 + 1] - CAM_Y) / rr;
      if (tn < top - 0.003) hidden[o] = 1;
      top = Math.max(top, tn);
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
  g.setAttribute('aMat', new THREE.BufferAttribute(mat, 4));
  g.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

// --- small geometry helpers -------------------------------------------------------------------
// Flat vertex colour and a material code (aMat: kind, a, b, c) on a geometry.
function paint(g, rgb, m = [0, 0, 0, 0]) {
  g = g.index ? g.toNonIndexed() : g;
  if (g.getAttribute('uv')) g.deleteAttribute('uv');
  const n = g.getAttribute('position').count;
  const c = new Float32Array(n * 3), a = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { c.set(rgb, i * 3); a.set(m, i * 4); }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g.setAttribute('aMat', new THREE.BufferAttribute(a, 4));
  return g;
}
// The same with per-vertex functions of the (final) position and normal.
function paintFn(g, rgbFn, mFn) {
  g = g.index ? g.toNonIndexed() : g;
  if (g.getAttribute('uv')) g.deleteAttribute('uv');
  const p = g.getAttribute('position'), nr = g.getAttribute('normal');
  const n = p.count;
  const c = new Float32Array(n * 3), a = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const P = [p.getX(i), p.getY(i), p.getZ(i)], Nn = [nr.getX(i), nr.getY(i), nr.getZ(i)];
    c.set(rgbFn(P, Nn), i * 3);
    a.set(mFn(P, Nn), i * 4);
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g.setAttribute('aMat', new THREE.BufferAttribute(a, 4));
  return g;
}

// A surface p(u, v), u round (0..1, wrapping), v along (0..1), with normals
// taken from the surface itself — smooth everywhere, no facets, no seam.
function surface(fn, nu, nv, tipUp = true) {
  const NU = nu + 1, NV = nv + 1;
  const pos = new Float32Array(NU * NV * 3), nor = new Float32Array(NU * NV * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let j = 0; j < NV; j++) {
    for (let i = 0; i < NU; i++) {
      const u = i / nu, v = j / nv;
      const p = fn(u % 1, v);
      const o = (j * NU + i) * 3;
      pos[o] = p[0]; pos[o + 1] = p[1]; pos[o + 2] = p[2];
      const vv = Math.min(v, 0.985), e = 1e-3;
      const pu1 = fn((u + e) % 1, vv), pu0 = fn((u - e + 1) % 1, vv);
      const pv1 = fn(u % 1, Math.min(1, vv + e)), pv0 = fn(u % 1, Math.max(0, vv - e));
      a.set(pu1[0] - pu0[0], pu1[1] - pu0[1], pu1[2] - pu0[2]);
      b.set(pv1[0] - pv0[0], pv1[1] - pv0[1], pv1[2] - pv0[2]);
      c.crossVectors(b, a).normalize();
      if (v >= 0.999 && tipUp) c.set(0, 1, 0);
      nor[o] = c.x; nor[o + 1] = c.y; nor[o + 2] = c.z;
    }
  }
  const idx = [];
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const p0 = j * NU + i, p1 = p0 + 1, p2 = p0 + NU, p3 = p2 + 1;
    idx.push(p0, p2, p1, p1, p2, p3);
  }
  // wind every triangle outward (its normal with the vertices')
  const P = (k) => new THREE.Vector3(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]);
  for (let t = 0; t < idx.length; t += 3) {
    const A = P(idx[t]), B = P(idx[t + 1]), Cc = P(idx[t + 2]);
    const fnv = new THREE.Vector3().crossVectors(B.clone().sub(A), Cc.clone().sub(A));
    const vn = new THREE.Vector3(nor[idx[t] * 3] + nor[idx[t + 1] * 3] + nor[idx[t + 2] * 3],
      nor[idx[t] * 3 + 1] + nor[idx[t + 1] * 3 + 1] + nor[idx[t + 2] * 3 + 1],
      nor[idx[t] * 3 + 2] + nor[idx[t + 1] * 3 + 2] + nor[idx[t + 2] * 3 + 2]);
    if (fnv.dot(vn) < 0) { const s = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = s; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

// An Italian cypress, standing at the origin: a tall smooth flame, widest a
// quarter of the way up, its tip leaning a little, its flank faintly lumpy.
function cypressGeo(rng, h, R) {
  const N = K.noise2(Math.floor(rng() * 1e9));
  const lean = rng.range(-0.025, 0.025) * h, leanZ = rng.range(-0.02, 0.02) * h;
  const o = rng() * 50;
  return surface((u, v) => {
    const a = u * Math.PI * 2;
    let f = v < 0.24 ? Math.sqrt(Math.max(0, 1 - sq((0.24 - v) / 0.32))) : Math.pow(Math.max(0, 1 - (v - 0.24) / 0.76), 0.92);
    f *= 1 + 0.09 * (N.fbm(v * 7 + o, Math.cos(a) * 1.3 + Math.sin(a) * 0.7 + o, 2) - 0.5) * 2;
    const r = R * f;
    const bend = v * v * v;
    return [Math.cos(a) * r + lean * bend, v * h, Math.sin(a) * r + leanZ * bend];
  }, 14, 26);
}

// A heap of smooth clumps (a tree's crown): each an icosphere squashed and
// lumped, its normals leaning toward the whole crown's so the heap reads as
// one mass with soft lobes. `crownC` / `crownR`: the crown's centre and radii.
function clumpGeo(cx, cy, cz, rx, ry, rz, detail, Nn, seed, crownC, crownR, lean = 0.4, lump = 0) {
  let g = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal'); g.deleteAttribute('uv');
  g = THREE.mergeVertices(g);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const f = 1 + 0.22 * (Nn.fbm(x * 1.6 + seed, z * 1.6 + y * 0.9 + seed * 0.7, 3) - 0.5) +
      lump * (Nn.fbm(x * 5.5 + seed * 1.3, z * 5.5 + y * 4.1, 2) - 0.5);
    p.setXYZ(i, cx + x * rx * f, cy + y * ry * f, cz + z * rz * f);
  }
  g.computeVertexNormals();
  const nr = g.getAttribute('normal');
  const v = new THREE.Vector3(), w = new THREE.Vector3();
  for (let i = 0; i < nr.count; i++) {
    v.set(nr.getX(i), nr.getY(i), nr.getZ(i));
    w.set((p.getX(i) - crownC[0]) / sq(crownR[0]), (p.getY(i) - crownC[1]) / sq(crownR[1]), (p.getZ(i) - crownC[2]) / sq(crownR[2])).normalize();
    v.multiplyScalar(1 - lean).addScaledVector(w, lean).normalize();
    nr.setXYZ(i, v.x, v.y, v.z);
  }
  return g;
}

// A tapered, bent tube from a to b (limbs, trunks), smooth.
function limbGeo(a, b, r0, r1, bendV, segs = 8, rows = 6) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), bend = new THREE.Vector3(...(bendV || [0, 0, 0]));
  const dir = B.clone().sub(A);
  const L = dir.length(); dir.normalize();
  const side = Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const s1 = new THREE.Vector3().crossVectors(dir, side).normalize(), s2 = new THREE.Vector3().crossVectors(dir, s1).normalize();
  return surface((u, v) => {
    const ang = u * Math.PI * 2;
    const c = A.clone().addScaledVector(dir, v * L).addScaledVector(bend, Math.sin(v * Math.PI));
    const r = r0 + (r1 - r0) * v;
    c.addScaledVector(s1, Math.cos(ang) * r).addScaledVector(s2, -Math.sin(ang) * r);
    return [c.x, c.y, c.z];
  }, segs, rows, false);
}

// A hipped roof over a w x d rectangle at height y0, rising h (flat faces).
function hipRoof(w, d, y0, h, ox = 0, oz = 0) {
  const hw = w / 2, hd = d / 2, rr = Math.max(0, (w - d) / 2);
  const A = [ox - hw, y0, oz - hd], B = [ox + hw, y0, oz - hd], Cc = [ox + hw, y0, oz + hd], D = [ox - hw, y0, oz + hd];
  const R1 = [ox - rr, y0 + h, oz], R2 = [ox + rr, y0 + h, oz];
  const tri = (p, q, r) => [...p, ...q, ...r];
  const P = [].concat(tri(D, Cc, R2), tri(D, R2, R1), tri(B, A, R1), tri(B, R1, R2), tri(A, D, R1), tri(Cc, B, R2));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.computeVertexNormals();
  return g;
}

// A box wall that knows its facade coordinates (aMat.zw: along, up), for the
// windows the shader draws on it. Built at the origin, then transformed.
function wallBox(w, h, d, x, y, z, rgb, windows) {
  const g = K.boxAt(w, h, d, x, y, z).toNonIndexed();
  g.deleteAttribute('uv');
  return paintFn(g, () => rgb, (P, Nn) => [windows ? 4 : 5, 0, Math.abs(Nn[0]) > 0.5 ? P[2] - z + d / 2 : P[0] - x + w / 2, P[1]]);
}

// --- GLSL ----------------------------------------------------------------------------------

const WORLD_HEAD = `
varying vec4 vMat;
varying vec3 vNrmW;
uniform vec3 uCropW; uniform vec3 uCropH; uniform vec3 uCropG; uniform vec3 uCropC;
uniform vec3 uCropV; uniform vec3 uCropO; uniform vec3 uCropF; uniform vec3 uSoil; uniform vec3 uCropY;
uniform vec3 uMargin; uniform vec3 uGravel; uniform vec3 uVerge; uniform vec3 uPoppy;
uniform vec4 uRoad[${ROAD.length - 1}];
uniform vec4 uRoadBox;
uniform vec4 uZone[${ZONES.length}];
uniform vec4 uWind;       // direction xz, speed (m/s), luma amplitude
uniform vec4 uCloudSh;    // scale (1/m), speed (m/s), strength, coverage threshold
uniform vec3 uSunCol;     // the sun's radiance, for the terms Three does not draw
uniform float uSheen;
// Patterns here are filtered by the redraw's OWN pixel: anything finer is
// sampled differently by each jittered redraw, and a still picture would keep
// costing bits. The derivatives are taken once, up front, where every pixel
// of a quad still runs the same code (gDX..: d(world)/dx, d(world)/dy).
vec3 gDX; vec3 gDY;
// The pixel's footprint along a horizontal direction, in units of s metres.
float fwDir(vec2 dir, float s) { return max((abs(dot(gDX.xz, dir)) + abs(dot(gDY.xz, dir))) / s, 1e-5); }
// ... and its size on the ground (metres), for distances.
float fwLen() { return max(max(abs(gDX.x) + abs(gDY.x), abs(gDX.z) + abs(gDY.z)), 1e-4); }
// ... and in 3D, in units of s metres (foliage, bark).
float fw3(float s) { vec3 f = abs(gDX) + abs(gDY); return max((f.x + f.y + f.z) / s, 1e-5); }
// How much this pixel is behind the head: the subject, and the middle of the
// picture below its top sixth.
float calmK() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float mid = (1.0 - sstep(0.17, 0.25, abs(uv.x - 0.5))) * sstep(0.88, 0.8, uv.y);
  return max(subjectMask(uv), mid);
}
// --- the fields: a warped Voronoi of parcels -------------------------------------------
const float CELL = 230.0;
vec2 fieldQ(vec2 p) {
  return p / CELL + 0.3 * vec2(vnoise(p / 560.0 + 3.1), vnoise(p / 560.0 + 9.7)) - 0.15;
}
// x: distance to the parcel's border (cells), y: its hash, zw: its centre
// (cells); bn: the border's normal
vec4 parcel(vec2 q, out vec2 bn) {
  vec2 n = floor(q), f = fract(q);
  vec2 mg = vec2(0.0), mr = vec2(0.0);
  float md = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 r = g + 0.12 + 0.76 * hash22(n + g) - f;
    float d = dot(r, r);
    if (d < md) { md = d; mr = r; mg = g; }
  }
  md = 8.0;
  bn = vec2(1.0, 0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = mg + vec2(float(i), float(j));
    vec2 r = g + 0.12 + 0.76 * hash22(n + g) - f;
    vec2 dd = r - mr;
    if (dot(dd, dd) > 1e-6) {
      float e = dot(0.5 * (mr + r), normalize(dd));
      if (e < md) { md = e; bn = normalize(dd); }
    }
  }
  vec2 id = n + mg;
  return vec4(md, hash12(id * 1.31 + 7.7), id + 0.12 + 0.76 * hash22(id));
}
// The distance to the road (m) and the direction it is measured in.
vec3 roadDist(vec2 p) {
  vec3 best = vec3(1e9, 1.0, 0.0);
  for (int i = 0; i < ${ROAD.length - 1}; i++) {
    vec4 s = uRoad[i];
    vec2 pa = p - s.xy, ba = s.zw - s.xy;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    vec2 v = pa - ba * h;
    float d = length(v);
    if (d < best.x) best = vec3(d, v / max(d, 1e-4));
  }
  return best;
}
// A coverage of [0, w] by a pixel whose footprint along x is fx, faded out
// where the band is far thinner than the pixel.
float band(float x, float w, float fx) {
  return (1.0 - smoothstep(w - 0.5 * fx, w + 0.5 * fx, x)) * min(1.0, 2.0 * w / max(fx, 1e-4));
}
// The fields' albedo at p; wheat: how much of it is standing wheat.
vec3 fields(vec2 p, float slope, float calm, out float wheat) {
  wheat = 0.0;
  vec2 q = fieldQ(p);
  vec2 bn;
  vec4 P = parcel(q, bn);
  vec2 cw = P.zw * CELL;
  float rc = length(cw), thc = atan(cw.x, -cw.y);
  float h = P.y;
  int crop = h < 0.4 ? 0 : h < 0.54 ? 1 : h < 0.78 ? 2 : h < 0.85 ? 3 : 6;
  if (abs(thc) < 0.3 && rc < 3200.0) crop = 0;
  float tone = fract(h * 7.31);
  float ed = P.x * CELL;
  for (int i = 0; i < ${ZONES.length}; i++) {
    vec4 z = uZone[i];
    vec2 d = (p - z.xy) / z.zw;
    float e = length(d) + 0.1 * (vnoise(p / 22.0 + float(i) * 7.0) - 0.5);
    if (e < 1.0) {
      crop = ${ZONES.map((z, i) => i < ZONES.length - 1 ? `i == ${i} ? ${z.crop} : ` : `${z.crop}`).join('')};
      ed = (1.0 - e) * min(z.z, z.w);
      tone = 0.5;
    }
  }
  vec3 c;
  if (crop == 0) {
    c = uCropW * (0.93 + 0.14 * tone);
    // ripening: a little greener in the hollows of the field
    float rip = vnoise(p / 70.0 + tone * 30.0);
    c *= 0.88 + 0.24 * rip;
    c = mix(c, c * vec3(0.86, 1.02, 0.8), 0.5 * (1.0 - rip));
    // the tractor's tramlines, along the field
    float ang = tone * 6.2832;
    float u = dot(p, vec2(cos(ang), sin(ang))) / 21.0;
    float tram = pulse(u, 0.0, 0.07, fwDir(vec2(cos(ang), sin(ang)), 21.0));
    c *= 1.0 - 0.16 * tram * (1.0 - 0.7 * calm);
    wheat = 1.0;
  } else if (crop == 1) {
    c = uCropH * (0.95 + 0.1 * tone);
    float ang = tone * 6.2832 + 0.7;
    float u = dot(p, vec2(cos(ang), sin(ang))) / 6.5;
    c *= 0.95 + 0.1 * pulse(u, 0.0, 0.5, fwDir(vec2(cos(ang), sin(ang)), 6.5));
  } else if (crop == 2) {
    c = uCropG * (0.85 + 0.3 * vnoise(p / 35.0 + 3.0)) * (0.92 + 0.16 * tone);
  } else if (crop == 3) {
    c = uCropC * (0.88 + 0.24 * vnoise(p / 55.0 + 9.0));
  } else if (crop == 6) {
    c = uCropY * (0.9 + 0.2 * vnoise(p / 45.0 + 5.0)) * (0.92 + 0.16 * tone);
  } else if (crop == 4) {
    float u = dot(p, vec2(0.86, 0.5)) / 2.6;
    c = mix(uSoil, uCropV, pulse(u, 0.0, 0.42, fwDir(vec2(0.86, 0.5), 2.6)));
  } else {
    c = uCropO * (0.9 + 0.2 * vnoise(p / 12.0));
  }
  // woods on the steep slopes of the far hills
  float wd = max(sstep(0.15, 0.2, slope + 0.08 * (vnoise(p / 90.0) - 0.5)) * step(0.35, fract(h * 3.7)), step(0.72, fract(h * 5.3)) * sstep(0.35, 0.6, vnoise(p / 160.0 + 2.0)));
  wd *= sstep(800.0, 1300.0, length(p)) * (1.0 - 0.8 * calm);
  if (wd > 0.0) {
    float fwd = fwLen() / 14.0;
    float crowns = mix(vnoise(p / 14.0), 0.5, sstep(0.3, 0.9, fwd));
    c = mix(c, uCropF * (0.75 + 0.5 * crowns), wd);
    wheat *= 1.0 - wd;
  }
  // a grassy margin along each field's edge
  c = mix(c, uMargin, band(ed, 1.6, fwDir(bn, 1.0)) * 0.75);
  return c;
}
vec3 meadow(vec2 p, vec3 base) {
  float fl = fwLen();
  float f1 = 2.0 * fl / 0.45;
  float n1 = mix(vnoise(p / 0.45), 0.5, sstep(0.3, 0.9, f1));
  float f2 = 2.0 * fl / 1.7;
  float n2 = mix(vnoise(p / 1.7 + 5.0), 0.5, sstep(0.3, 0.9, f2));
  float n3 = vnoise(p / 7.0 + 11.0);
  vec3 c = base * (0.8 + 0.4 * n1) * (0.9 + 0.2 * n2);
  // poppies, in drifts: a red fleck per cell where the drift is
  vec2 g = p / 0.34;
  vec2 gi = floor(g), gf = fract(g) - 0.5;
  vec2 hh = hash22(gi + 17.0);
  float drift = sstep(0.52, 0.78, n3);
  float on = step(1.0 - 0.25 * drift, hh.x);
  float fg = 2.0 * fl / 0.34;
  float rad = 0.12;
  float fleck = 1.0 - smoothstep(rad - 0.5 * fg, rad + 0.5 * fg, length(gf - (hh - 0.5) * 0.5));
  float cover = mix(fleck * on, 0.4 * drift * 0.09, sstep(0.25, 0.9, fg));
  return mix(c, uPoppy, cover);
}
// Cloud shadows drifting over the far fields, never over the knoll or behind the head.
float cloudShadow(vec3 wp, float calm) {
  if (uCloudSh.z <= 0.0) return 1.0;
  vec2 q = (wp.xz + vec2(uTime * uCloudSh.y, uTime * uCloudSh.y * 0.35)) * uCloudSh.x;
  float d = fbm2(q, 3);
  float s = smoothstep(uCloudSh.w, uCloudSh.w + 0.14, d);
  float far = sstep(320.0, 700.0, length(wp.xz));
  return 1.0 - uCloudSh.z * s * far * (1.0 - 0.85 * calm);
}
// Wind waves running across the wheat: 0..1.
float windWave(vec2 p) {
  float u = (dot(p, uWind.xy) - uTime * uWind.z) / 26.0;
  float v = dot(p, vec2(-uWind.y, uWind.x)) / 60.0;
  float fu = fwDir(uWind.xy, 26.0);
  return mix(vnoise(vec2(u, v)), 0.5, sstep(0.25, 0.7, fu));
}
`;

const WORLD_PATCH = {
  key: 'ctrWorld',
  vertexHead: 'attribute vec4 aMat;\nvarying vec4 vMat;\nvarying vec3 vNrmW;\n',
  vertex: { begin_vertex: 'vMat = aMat;\nvNrmW = normalize(mat3(modelMatrix) * objectNormal);' },
  fragmentHead: WORLD_HEAD,
  fragment: {
    color_fragment: `
gDX = dFdx(vWorld); gDY = dFdy(vWorld);
vec2 gWin = fwidth(vMat.zw);
float CALM = calmK();
float WHEAT = 0.0;
float FOL = 0.5;
float KIND = vMat.x;
if (KIND < 0.5) {
  vec3 base = diffuseColor.rgb;
  if (vMat.y < 0.999) base = meadow(vWorld.xz, base);
  if (vMat.y > 0.0) {
    float wh;
    vec3 fc = fields(vWorld.xz, vMat.z, CALM, wh);
    base = mix(base, fc, vMat.y);
    WHEAT = wh * vMat.y;
  }
  vec2 p = vWorld.xz;
  if (p.x > uRoadBox.x && p.x < uRoadBox.z && p.y > uRoadBox.y && p.y < uRoadBox.w) {
    vec3 rd = roadDist(p);
    float d = rd.x;
    float fd = fwDir(rd.yz, 1.0);
    float road = band(d, 2.1, fd);
    float verge = band(d, 3.8, fd);
    base = mix(base, uVerge, max(verge - road, 0.0) * 0.6);
    base = mix(base, uGravel, road);
    WHEAT *= 1.0 - verge;
  }
  diffuseColor.rgb = base * vMat.w;
} else if (KIND < 2.5) {
  // foliage: tufts of needles or leaves, darker in the gaps between them
  float s = vMat.z;
  vec3 an = abs(normalize(vNrmW));
  vec3 w = an / (an.x + an.y + an.z);
  vec3 P = vWorld / s;
  float t1 = vnoise(P.zy) * w.x + vnoise(P.xz + 3.1) * w.y + vnoise(P.xy + 7.7) * w.z;
  vec3 P2 = P * 2.6;
  float t2 = vnoise(P2.zy + 1.3) * w.x + vnoise(P2.xz + 5.1) * w.y + vnoise(P2.xy + 2.7) * w.z;
  float fw1 = fw3(s);
  float k1 = 1.0 - sstep(0.3, 0.9, fw1), k2 = 1.0 - sstep(0.3, 0.9, fw1 * 2.6);
  FOL = 0.5 + (t1 - 0.5) * k1 * 0.9 + (t2 - 0.5) * k2 * 0.5;
  diffuseColor.rgb *= 0.5 + FOL;
  // deeper in the crown, darker (aMat.w: 0 inside .. 1 outer shell)
  diffuseColor.rgb *= 0.45 + 0.55 * vMat.w;
} else if (KIND < 3.5) {
  // bark: furrows up the trunk
  float u = (vWorld.x * 0.7 + vWorld.z * 0.7) / 0.09;
  float fu = fw3(0.09);
  float fur = mix(vnoise(vec2(u, vWorld.y * 1.3)), 0.5, sstep(0.3, 0.9, fu));
  diffuseColor.rgb *= 0.75 + 0.5 * fur;
} else if (KIND < 4.5) {
  // a stone wall with windows (aMat.zw: metres along, up)
  vec2 g = vec2(vMat.z / 3.4, vMat.w / 3.3);
  vec2 fw = max(gWin / vec2(3.4, 3.3), vec2(1e-4));
  float win = pulse(g.x, 0.38, 0.62, fw.x) * pulse(g.y - 0.12, 0.3, 0.72, fw.y) * step(0.5, vMat.w) * step(vMat.w, 6.9);
  diffuseColor.rgb *= 0.92 + 0.16 * vnoise(vWorld.xy * 0.7 + vWorld.zy * 0.5);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.025, 0.022, 0.02), win * 0.85);
} else {
  diffuseColor.rgb *= 0.92 + 0.16 * vnoise(vWorld.xz * 0.5 + vWorld.y * 0.3);
}
`,
    roughnessmap_fragment: 'if (KIND > 5.5 && KIND < 6.5) roughnessFactor = 0.7;',
    lights_fragment_end: `
float CS = cloudShadow(vWorld, CALM);
#if NUM_DIR_LIGHTS > 0
{
  // A cast shadow seen edge-on (a cypress's, far off, at a grazing angle) is
  // thinner than the redraw's pixel: each jittered redraw would hit or miss
  // it. Where the pixel's footprint across the shadows outgrows a cypress's
  // shadow, fade the shadow toward the light it takes away.
  float thin = sstep(0.45, 1.3, fwDir(normalize(vec2(-uSunDir.z, uSunDir.x)), 2.4));
  if (thin > 0.0) {
    float nl = max(dot(normal, directionalLights[0].direction), 0.0);
    vec3 un = nl * directionalLights[0].color * BRDF_Lambert(material.diffuseColor);
    reflectedLight.directDiffuse = mix(reflectedLight.directDiffuse, max(un, reflectedLight.directDiffuse), thin * 0.85);
  }
}
#endif
reflectedLight.directDiffuse *= CS;
reflectedLight.directSpecular *= CS;
`
  },
  fragmentBefore: {
    opaque_fragment: `{
  vec3 N = normalize(vNrmW);
  float NdL = dot(N, uSunDir);
  float shadowK = 1.0;
  if (WHEAT > 0.0) {
    // the low sun along the stalks: brighter where the field is seen edge-on,
    // and in bands where the wind bends them
    vec3 V = normalize(cameraPosition - vWorld);
    float g = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
    float wave = windWave(vWorld.xz);
    float side = 1.0 - 0.7 * CALM;
    outgoingLight += diffuseColor.rgb * uSunCol * uSheen * g * max(NdL, 0.0) * CS * WHEAT;
    // and looking toward the sun, the light through the ears: a warm glow
    float fwd = pow(max(dot(-V, uSunDir), 0.0), 5.0);
    outgoingLight += diffuseColor.rgb * uSunCol * fwd * 0.9 * CS * WHEAT * sstep(-0.1, 0.3, NdL);
    outgoingLight *= 1.0 + uWind.w * (wave - 0.5) * 2.0 * WHEAT * side;
  }
  if (KIND > 1.5 && KIND < 2.5) {
    // foliage: light wraps past the terminator, a little more on the tufts
    float wrap = max((NdL + 0.5) / 1.5, 0.0) - max(NdL, 0.0);
    outgoingLight += diffuseColor.rgb * uSunCol * wrap * (0.12 + 0.2 * FOL) * CS * vMat.w;
  }
}`
  }
};

const CARD_PATCH = {
  key: 'ctrCards',
  vertexHead: 'attribute vec4 aCard;\nvarying vec4 vCard;\nvarying float vThin;\nuniform vec3 uSway;\n',
  vertex: {
    begin_vertex: `
vCard = aCard;
vThin = 1.0;
{
  // aCard: kind, height over the tuft's base (m), phase, signed half-width (m)
  float hk = aCard.y / 0.5;
  float a = uSway.x * (0.7 * sin(uTime * 0.85 + aCard.z) + 0.3 * sin(uTime * 0.31 + aCard.z * 1.7));
  a += uSway.y * 0.5 * sin(uTime * 2.1 + aCard.z * 3.1);
  transformed.xz += vec2(-0.94, -0.34) * a * hk * hk;
  float hw = abs(aCard.w);
  if (hw > 0.0) {
    // a blade faces the camera and is never thinner than the redraw's pixel
    // (what a pixel spans at this distance: from the projection itself)
    vec3 toCam = cameraPosition - transformed;
    float px = length(toCam) * 2.0 / (projectionMatrix[1][1] * uBufH);
    float w = max(hw, px * 0.8);
    transformed += normalize(cross(vec3(0.0, 1.0, 0.0), toCam)) * sign(aCard.w) * w;
    // and fades into the meadow toward its tip, so it tapers in colour
    // where it cannot in width
    vThin = hw / w * (1.0 - 0.55 * sstep(0.45, 1.0, aCard.y / max(uSway.z, 1e-3)));
  }
}`
  },
  fragmentHead: `
varying vec4 vCard;
varying float vThin;
uniform vec3 uTransCol;
uniform vec3 uGroundCol;
`,
  fragment: {
    // a blade that had to be widened shows its own colour only in proportion
    color_fragment: 'diffuseColor.rgb = mix(uGroundCol, diffuseColor.rgb, vThin);'
  },
  fragmentBefore: {
    opaque_fragment: `{
  // sunlight through a blade or a petal, strongest looking toward the sun
  vec3 Vd = normalize(vWorld - cameraPosition);
  float tr = 0.2 + 0.8 * sstep(-0.1, 0.8, dot(Vd, uSunDir));
  outgoingLight += diffuseColor.rgb * uTransCol * tr * (vCard.x < 0.5 ? 0.8 : 1.0);
}`
  }
};

const GLOW_DECL = `
uniform vec3 uWarm; uniform vec3 uTown; uniform vec3 uFire;
uniform vec2 uOn;          // lights, fireflies
varying vec2 vUv; varying vec4 vGlow; varying vec3 vWorld;
`;
const GLOW_VERT = `
attribute vec4 aGlow;
void main() {
  vUv = uv; vGlow = aGlow;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const GLOW_FRAG = `
void main() {
  vec2 c = vUv * 2.0 - 1.0;
  float r2 = dot(c, c);
  float m = (exp(-r2 * 5.0) * 0.35 + exp(-r2 * 38.0)) * step(r2, 1.0);
  float k = vGlow.x;
  vec3 col = k < 1.5 ? uWarm : k < 2.5 ? uTown : uFire;
  float b = vGlow.z * uOn.x;
  if (k > 2.5) {
    // a firefly: about two seconds to light, a moment lit, two to fade, then dark
    float cyc = fract(uTime / vGlow.w + vGlow.y);
    b = vGlow.z * uOn.y * sstep(0.0, 0.25, cyc) * sstep(0.55, 0.32, cyc);
  }
  // additive (alpha is the blend's source factor; the target's alpha is kept)
  vec3 e = col * uEmis * b * m;
  gl_FragColor = vec4(engFog(e, vWorld) - engFog(vec3(0.0), vWorld), 1.0);
}`;

const CUMN = 8;
const SKY_HEAD = `
uniform vec3 uDusk;        // the orange band low over the key side at dusk
uniform vec3 uMidN;        // the evening's middle sky
uniform vec3 uMid;         // the day's: pale blue a few degrees up
uniform vec4 uCuA[${CUMN}]; // azimuth, base elevation, half-width, height (rad)
uniform vec4 uCuB[${CUMN}]; // seed, skew, brightness, 0
uniform vec3 uCuLit; uniform vec3 uCuShade; uniform vec3 uCuLitN; uniform vec3 uCuShadeN;
vec3 ctrGrad(vec3 dir) {
  float e = dir.y;
  float ee = max(e, 0.0);
  vec3 day = mix(uHorizon, uMid, sstep(0.0, 0.2, ee));
  day = mix(day, uZenith, sstep(0.08, 0.75, ee));
  vec3 eve = mix(uHorizonN, uMidN, sstep(0.0, 0.16, ee));
  eve = mix(eve, uZenithN, sstep(0.1, 0.55, ee));
  vec3 c = mix(day, eve, uNight);
  if (e < 0.0) c = mix(c, mix(uGround, uGroundN, uNight), sstep(0.0, 0.25, -e));
  float s = max(dot(dir, uSkySun.xyz), 0.0);
  c += uSkySunCol * (pow(s, 6.0) * 0.3 + pow(s, 60.0) * 0.8);
  return c;
}
// One cumulus in its own frame (x across in half-widths, y up in heights):
// a heap of turrets on a flat base (their tops joined smoothly), lit from the
// key side: brighter where the cloud thins toward the light.
float smaxf(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return max(a, b) + h * h * k * 0.25; }
float cuTop(float x, vec4 B) {
  float top = 0.0;
  for (int j = 0; j < 5; j++) {
    float fj = float(j);
    float cx = -0.8 + 0.4 * fj + 0.16 * (hash11(B.x * 3.1 + fj) - 0.5);
    float w = 0.3 + 0.16 * hash11(B.x * 1.7 + fj * 2.3);
    float hh = (0.45 + 0.55 * hash11(B.x * 2.3 + fj * 5.1)) * (1.0 - 0.6 * abs(cx)) * (1.0 + B.y * cx * 0.4);
    float u = (x - cx) / w;
    top = smaxf(top, hh * sqrt(max(1.0 - u * u, 0.0)), 0.14);
  }
  return top * sstep(1.32, 1.02, abs(x));
}
vec4 cumulus(vec2 l, vec4 A, vec4 B, float pxA) {
  float fq = pxA * 5.0 / A.z + pxA * 5.0 / A.w;
  int oct = fq > 0.5 ? 2 : fq > 0.15 ? 3 : 4;
  vec2 o = vec2(0.07, 0.055);
  float n = fbm2(l * vec2(5.0, 6.0) + B.x * 7.0, oct);
  float n2 = fbm2((l + o) * vec2(5.0, 6.0) + B.x * 7.0, oct);
  float f = cuTop(l.x, B) - l.y + 0.3 * (n - 0.5);
  float f2 = cuTop(l.x + o.x, B) - (l.y + o.y) + 0.3 * (n2 - 0.5);
  float base = smoothstep(-0.02, 0.06, l.y + 0.06 * (n - 0.5));
  float den = smoothstep(-0.03, 0.06 + fq * 0.5, f) * base;
  float lit = clamp(0.4 + 3.2 * (f - f2), 0.0, 1.0);
  lit *= 0.55 + 0.45 * sstep(0.0, 0.3, l.y);
  float rim = (1.0 - smoothstep(0.0, 0.1, f)) * B.w;
  vec3 lc = mix(uCuLit, uCuLitN, uNight), sc = mix(uCuShade, uCuShadeN, uNight);
  return vec4((mix(sc, lc, lit) + lc * rim * 0.5) * B.z, den);
}
`;
const SKY_FRAG = `
  vec3 dir = normalize(vWorld - cameraPosition);
  vec3 c = ctrGrad(dir);
  float az = atan(dir.x, -dir.z);
  float el = asin(clamp(dir.y, -1.0, 1.0));
  // a pixel's angular size, in the picture (not the redraw)
  float pxA = length(fwidth(dir)) * uBufH / max(uDetail, 1.0);
  // the evening's glow, low over the key side
  float hz = exp(-max(dir.y, 0.0) * 7.0);
  float keyS = sstep(-0.4, 0.9, dir.x / max(length(dir.xz), 1e-3));
  c += uDusk * hz * keyS;
  for (int i = 0; i < ${CUMN}; i++) {
    vec4 A = uCuA[i];
    float a0 = A.x + 0.006 * sin(uTime * 0.03 + float(i) * 1.9);
    vec2 l = vec2((az - a0) / A.z, (el - A.y) / A.w);
    if (l.y < -0.08 || l.y > 1.3 || abs(l.x) > 1.45) continue;
    vec4 cu = cumulus(l, A, uCuB[i], pxA);
    // low clouds are seen through the haze
    vec3 cc = mix(cu.rgb, mix(uHorizon, uHorizonN, uNight), 0.5 * (1.0 - sstep(0.0, 0.14, el)));
    c = mix(c, cc, cu.a);
  }
  gl_FragColor = vec4(c, 0.0);
`;

// --- the scene --------------------------------------------------------------------------------

export default {
  id: 'countryside',
  camera: { pos: [0, CAM_Y, 0], target: [0, CAM_Y - Math.tan(PITCH) * 1000, -1000], fov: 50, near: 0.8, far: 30000 },
  nearness: [3, 30],

  build(k) {
    const st = {};
    // one random stream per element, so tuning one never reshuffles another
    let rng = k.rng(SEED);

    // --- sky and light ------------------------------------------------------------------------
    const skyO = {
      zenith: shows(0x6f9fd6), horizon: shows(0xebdcc3), ground: lin(0x8a7a52, 0.5),
      zenithNight: shows(0x6a6aa8, 0.25), horizonNight: shows(0xe8a25c, 0.25), groundNight: lin(0x3a3048, 0.6),
      sunDir: SUN.toArray(), sunColor: 0xffd9a0, sunIntensity: 0.5, disc: 0, haze: 0.5,
      fragmentHead: SKY_HEAD, fragment: SKY_FRAG
    };
    const sky = K.sky(k, skyO);
    const D = (deg) => deg * D2R;
    // azimuth, base elevation, half-width, height (degrees); brightness
    const cum = [
      [-25, 17.5, 8.5, 6.5, 0.97], [-35, 23.5, 5.5, 4.0, 0.95], [27, 13.0, 10.5, 9.5, 1.0],
      [37, 22.5, 6.5, 5.5, 0.96], [-36, 2.6, 6.0, 2.6, 0.92], [33, 2.8, 7.0, 3.0, 0.92], [16, 30, 6, 5, 0.97], [-19, 36, 7, 5.5, 0.97]
    ];
    Object.assign(sky.mesh.material.uniforms, {
      uDusk: { value: new THREE.Color(0, 0, 0) },
      uMidN: { value: shows(0xc48a8a, 0.25) },
      uMid: { value: shows(0xb9d0e6) },
      uCuA: { value: cum.map((c) => new THREE.Vector4(D(c[0]), D(c[1]), D(c[2]), D(c[3]))) },
      uCuB: { value: cum.map((c, i) => new THREE.Vector4(i * 3.7 + 0.5, rng.range(-1, 1), c[4], sstep(-20, 40, c[0]) * 0.8)) },
      uCuLit: { value: shows(0xf5e9d6) }, uCuShade: { value: shows(0x98a2b8) },
      uCuLitN: { value: shows(0xeaa688, 0.25) }, uCuShadeN: { value: shows(0x7c6a92, 0.25) }
    });
    st.sky = sky;
    // The light the land takes from the sky: at dusk mostly the lavender
    // overhead, not the orange band low in the west, so the hills go blue-violet.
    const envO = Object.assign({}, skyO, { horizonNight: shows(0xa894b8, 0.25), groundNight: lin(0x2e2c40, 0.6) });
    st.env = K.envFollower(k, envO, 0.25, 1);
    st.env(0);

    const sun = new THREE.DirectionalLight(0xffffff, 10);
    const centre = new THREE.Vector3(115, 30, -245);
    sun.position.copy(centre).addScaledVector(SUN, 900);
    sun.target.position.copy(centre);
    k.scene.add(sun, sun.target);
    sun.castShadow = true;
    sun.shadow.mapSize.set(k.quality.shadow, k.quality.shadow);
    sun.shadow.bias = -0.0015;
    sun.shadow.normalBias = 0.6;
    {
      // fit the shadow camera to the box the casters and their shadows are in
      sun.updateMatrixWorld(); sun.target.updateMatrixWorld();
      const cam = sun.shadow.camera;
      cam.position.copy(sun.position); cam.lookAt(centre); cam.updateMatrixWorld();
      const inv = cam.matrixWorldInverse;
      const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
      for (const x of [-60, 290]) for (const y of [-5, 80]) for (const z of [-500, 0]) {
        const v = new THREE.Vector3(x, y, z).applyMatrix4(inv);
        lo.min(v); hi.max(v);
      }
      cam.left = lo.x; cam.right = hi.x; cam.bottom = lo.y; cam.top = hi.y;
      cam.near = Math.max(1, -hi.z - 20); cam.far = -lo.z + 20;
      cam.updateProjectionMatrix();
    }
    st.sun = sun;

    // --- the world material ------------------------------------------------------------------
    const roadSeg = [];
    for (let i = 0; i + 1 < ROAD.length; i++) roadSeg.push(new THREE.Vector4(ROAD[i][0], ROAD[i][1], ROAD[i + 1][0], ROAD[i + 1][1]));
    const rx = ROAD.map((p) => p[0]), rz = ROAD.map((p) => p[1]);
    const worldU = {
      uCropW: { value: lin(0xd8b865, 0.62) }, uCropH: { value: lin(0xe0c27c, 0.6) }, uCropG: { value: lin(0x8fa458, 0.46) },
      uCropC: { value: lin(0xb09478, 0.5) }, uCropV: { value: lin(0x5e7a3a, 0.55) }, uCropO: { value: lin(0xb5a779, 0.55) },
      uCropF: { value: lin(0x3e4a2c, 0.6) }, uSoil: { value: lin(0xb39c7c, 0.55) }, uCropY: { value: lin(0xb4b064, 0.55) },
      uMargin: { value: lin(0x7e9248, 0.5) }, uGravel: { value: lin(0xe3dccb, 0.7) }, uVerge: { value: lin(0x9aa65a, 0.5) },
      uPoppy: { value: lin(0xd2332a, 0.7) },
      uRoad: { value: roadSeg },
      uRoadBox: { value: new THREE.Vector4(Math.min(...rx) - 8, Math.min(...rz) - 8, Math.max(...rx) + 8, Math.max(...rz) + 8) },
      uZone: { value: ZONES.map((z) => new THREE.Vector4(z.c[0], z.c[1], z.r[0], z.r[1])) },
      uWind: { value: new THREE.Vector4(-0.94, -0.34, 2.0, 0.04) },
      uCloudSh: { value: new THREE.Vector4(1 / 650, 6.0, 0.45, 0.56) },
      uSunCol: { value: new THREE.Color(1, 1, 1) },
      uSheen: { value: 0.5 }
    };
    st.worldU = worldU;
    const patch = Object.assign({}, WORLD_PATCH, { uniforms: worldU });
    const worldMat = k.std({ vertexColors: true, roughness: 0.9, metalness: 0, receiver: 0.4, patch });
    const terrain = new THREE.Mesh(terrainGeo(), worldMat);
    terrain.frustumCulled = false;
    terrain.receiveShadow = true;
    k.scene.add(terrain);

    // --- trees, buildings, bales -------------------------------------------------------------
    const near = [], far = [];
    const CYP = linA(0x34482a, 1.0), PINEC = linA(0x405634, 1.0), OLV = linA(0x8f977c, 0.72);
    const BARK = linA(0x6b5a4c, 0.55), OBARK = linA(0x6e665a, 0.6);
    const foliage = (g, rgb, tuft, shellFn, jit = 0.12) => paintFn(g,
      (P) => mulA(rgb, 1 + jit * (W.N3.fbm(P[0] * 0.35 + 3, P[2] * 0.35 + P[1] * 0.2, 2) - 0.5) * 2),
      (P, Nn) => [2, 0, tuft, shellFn(P, Nn)]);

    // cypresses along the road, alternate sides; two by the casale; then the far ones
    rng = k.rng(SEED + 2);
    const cyps = [];
    {
      let side = 1, acc = 9;
      for (let i = 0; i + 1 < ROAD.length; i++) {
        const [ax, az] = ROAD[i], [bx, bz] = ROAD[i + 1];
        const L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L;
        const avenue = i === ROAD.length - 2;
        for (; acc < L; acc += avenue ? 11 : rng.range(19, 26)) {
          const sides = avenue ? [-1, 1] : [side];
          for (const s of sides) {
            const off = 4.6 + rng.range(-0.4, 0.6);
            cyps.push([ax + ux * acc - uz * off * s, az + uz * acc + ux * off * s, rng.range(13.5, 17.5)]);
          }
          side = -side;
        }
        acc -= L;
      }
      cyps.push([CAS.x + 22, CAS.z + 4, 16.5], [CAS.x - 16, CAS.z - 14, 15]);
    }
    const cypressAt = (list, x, z, h, w = 0.085) => {
      const g = cypressGeo(rng, h, h * w * rng.range(0.9, 1.1));
      g.translate(x, W.H(x, z) - 0.4, z);
      list.push(foliage(g, CYP, 0.5, (P) => 0.7 + 0.3 * sstep(0, 3, P[1] - W.H(x, z)), 0.08));
    };
    for (const [x, z, h] of cyps) cypressAt(near, x, z, h);
    st.cypresses = cyps.length;
    // the cypress ring on its knoll, far left; pairs on the far hills
    for (let i = 0; i < 9; i++) {
      const a = i / 9 * Math.PI * 2;
      cypressAt(far, -430 + Math.cos(a) * 9, -880 + Math.sin(a) * 9, rng.range(14, 18));
    }
    for (const [x, z] of [[520, -1300], [-900, -1700], [760, -2100], [-1300, -2600], [1100, -1500], [-640, -1450]]) {
      cypressAt(far, x, z, rng.range(14, 18), 0.1);
      cypressAt(far, x + rng.range(5, 9), z + rng.range(-4, 4), rng.range(12, 17), 0.1);
    }

    // the umbrella pine: a leaning trunk forking under a broad flat crown
    rng = k.rng(SEED + 3);
    {
      const gx = PINE.x, gz = PINE.z, gy = W.H(gx, gz);
      const top = [gx + 0.9, gy + 11.5, gz - 0.4];
      near.push(paint(limbGeo([gx, gy - 0.5, gz], top, 0.36, 0.24, [0.5, 0, 0.2], 10, 10), BARK, [3, 0, 0, 0]));
      const limbs = [[-4.2, 13.6, 1.2], [3.6, 14.0, -1.5], [0.6, 14.4, 3.4], [-1.2, 13.8, -3.6], [4.4, 13.2, 2.4]];
      for (const [lx, ly, lz] of limbs) {
        near.push(paint(limbGeo(top, [gx + lx, gy + ly, gz + lz], 0.2, 0.08, [0, 0.6, 0], 7, 5), BARK, [3, 0, 0, 0]));
      }
      const cc = [gx + 0.4, gy + 15.4, gz - 0.2], cr = [8.4, 2.4, 7.4];
      // the canopy: rings of overlapping flat clumps over the whole disc, so
      // it reads as one umbrella; the rim smaller and drooping, a few gaps in it
      const clumps = [];
      for (const [rr, n, sz] of [[0, 1, 2.5], [0.34, 7, 2.15], [0.6, 12, 1.95], [0.84, 19, 1.65]]) {
        const a0 = rng() * Math.PI * 2;
        for (let i = 0; i < n; i++) {
          if (rr > 0.8 && rng() < 0.12) continue;
          const a = a0 + (i + rng.range(-0.3, 0.3)) / n * Math.PI * 2, q = rr + rng.range(-0.05, 0.05);
          const x = cc[0] + Math.cos(a) * q * cr[0], z = cc[2] + Math.sin(a) * q * cr[2];
          const y = cc[1] + 0.85 * (1 - q * q) * cr[1] - 0.6 - 0.5 * sstep(0.7, 0.95, q) + rng.range(-0.3, 0.3);
          const s2 = sz * rng.range(0.88, 1.12);
          clumps.push(clumpGeo(x, y, z, s2, s2 * rng.range(0.42, 0.52), s2 * rng.range(0.9, 1.1), 5, W.N2, rng() * 40, cc, cr, 0.42, 0.34));
        }
      }
      for (const g of clumps) {
        near.push(foliage(g, PINEC, 0.42, (P) => sstep(-1.8, 1.0, P[1] - cc[1]) * 0.8 + 0.2 * sstep(0.4, 0.95, Math.hypot((P[0] - cc[0]) / cr[0], (P[2] - cc[2]) / cr[2]))));
      }
    }
    // three olives on the knoll's flank: a short twisted trunk, three or four
    // limbs, each holding its own mass of silver-green tufts with sky between
    rng = k.rng(SEED + 4);
    for (const [ox, oz, sc] of [[-12.5, -21.5, 1.0], [-21, -26, 1.1], [-14.5, -31, 0.85]]) {
      const gy = W.H(ox, oz);
      const t0 = [ox, gy - 0.3, oz], t1 = [ox + 0.25 * sc, gy + 1.1 * sc, oz - 0.15];
      near.push(paint(limbGeo(t0, t1, 0.26 * sc, 0.19 * sc, [0.18, 0, 0.1], 9, 6), OBARK, [3, 0, 0, 0]));
      const nm = 3 + (rng() < 0.5 ? 1 : 0);
      const a0 = rng() * Math.PI * 2;
      for (let m = 0; m < nm; m++) {
        const a = a0 + m / nm * Math.PI * 2 + rng.range(-0.4, 0.4), rr = rng.range(0.9, 1.5) * sc;
        const mc = [ox + Math.cos(a) * rr, gy + rng.range(2.3, 3.1) * sc, oz + Math.sin(a) * rr * 0.9];
        near.push(paint(limbGeo(t1, [mc[0], mc[1] - 0.5 * sc, mc[2]], 0.13 * sc, 0.05 * sc, [0, 0.25, 0], 7, 4), OBARK, [3, 0, 0, 0]));
        const mr = rng.range(0.9, 1.25) * sc;
        for (let i = 0; i < 9; i++) {
          const b = rng() * Math.PI * 2, q = Math.sqrt(rng()) * 0.8;
          const x = mc[0] + Math.cos(b) * q * mr, z = mc[2] + Math.sin(b) * q * mr;
          const y = mc[1] + rng.range(-0.35, 0.45) * mr * (1 - 0.5 * q);
          const s2 = rng.range(0.38, 0.6) * sc;
          const g = clumpGeo(x, y, z, s2, s2 * 0.72, s2, 3, W.N3, rng() * 40, mc, [mr, mr * 0.7, mr], 0.5, 0.45);
          near.push(foliage(g, OLV, 0.16, (P) => 0.35 + 0.65 * sstep(0.2, 0.95, Math.hypot((P[0] - mc[0]) / mr, (P[1] - mc[1]) / (mr * 0.7), (P[2] - mc[2]) / mr)), 0.25));
        }
      }
    }
    // lone oaks out in the fields
    rng = k.rng(SEED + 5);
    for (const [x, z, s] of [[-330, -700, 6.5], [380, -820, 7], [-620, -1100, 7.5], [470, -560, 5.5]]) {
      const gy = W.H(x, z);
      far.push(paint(limbGeo([x, gy - 0.5, z], [x, gy + s * 0.8, z], 0.5, 0.35, null, 6, 2), BARK, [3, 0, 0, 0]));
      const g = clumpGeo(x, gy + s * 1.35, z, s, s * 0.72, s, 2, W.N, rng() * 40, [x, gy + s * 1.3, z], [s, s * 0.7, s], 0.3);
      far.push(foliage(g, linA(0x40552c, 0.85), 1.2, () => 0.85, 0.12));
    }

    // the casale: stone, a low hipped roof, its dovecote tower; a wing, the
    // barn and a haystack along the crest
    const STONE = linA(0xc9a57a, 0.68), STONE2 = linA(0xbf9a72, 0.62), ROOF = linA(0xb5683f, 0.62);
    const casale = [];
    {
      const parts = [];
      const base = -2.5;
      parts.push(wallBox(22, 9.2 - base, 11, 0, base, 0, STONE, true));
      parts.push(paint(hipRoof(23.2, 12.2, 9.2, 2.6), ROOF, [6, 0, 0, 0]));
      parts.push(wallBox(5.4, 15 - base, 5.4, -8.0, base, 1.4, STONE, true));
      parts.push(paint(hipRoof(6.3, 6.3, 15, 1.7, -8.0, 1.4), ROOF, [6, 0, 0, 0]));
      parts.push(wallBox(10, 6 - base, 8, 16, base, -1.2, STONE2, false));
      parts.push(paint(hipRoof(10.8, 8.8, 6, 1.7, 16, -1.2), ROOF, [6, 0, 0, 0]));
      // the barn, a little down the crest, and its haystack
      parts.push(wallBox(15, 6.8 - base, 9, 35, base - 1.5, 10, STONE2, false));
      parts.push(paint(hipRoof(15.8, 9.8, 6.8 - 1.5, 2.2, 35, 10), ROOF, [6, 0, 0, 0]));
      const stack = new THREE.ConeGeometry(3.0, 5.0, 12, 1);
      stack.translate(46, 2.5 - 2.0, 17);
      parts.push(paint(stack, linA(0xc7a865, 0.6), [7, 0, 0, 0]));
      const g = K.merge(parts);
      const rot = Math.atan2(-CAS.x, -CAS.z) - 0.35 + Math.PI;
      g.rotateY(rot);
      g.translate(CAS.x, W.H(CAS.x, CAS.z), CAS.z);
      casale.push(g);
      st.casaleRot = rot;
    }
    near.push(...casale);
    // round bales on the cut field, each throwing its long shadow
    rng = k.rng(SEED + 6);
    {
      const z = ZONES[0];
      const bale = (x, zz, a) => {
        const g = new THREE.CylinderGeometry(0.75, 0.75, 1.25, 14, 1);
        g.rotateZ(Math.PI / 2); g.rotateY(a);
        g.translate(x, W.H(x, zz) + 0.68, zz);
        return paint(g, linA(0xd6c28a, 0.62), [7, 0, 0, 0]);
      };
      for (let i = 0, n = 0; n < 13 && i < 200; i++) {
        const x = z.c[0] + rng.range(-1, 1) * z.r[0] * 0.85, zz = z.c[1] + rng.range(-1, 1) * z.r[1] * 0.85;
        if (!inZone(z, x, zz, 0.82) || roadDist(x, zz) < 8) continue;
        near.push(bale(x, zz, rng() * Math.PI));
        n++;
      }
    }
    // far farmhouses (each with a light at dusk) and the two hill towns
    rng = k.rng(SEED + 7);
    const glows = [];
    const farms = [[-560, -1250], [640, -1500], [-1100, -2300], [1250, -2600], [-1700, -3300], [1900, -3600], [-2600, -5200], [2500, -4800], [-820, -1080], [1500, -2050]];
    for (const [x, z] of farms) {
      const y = W.H(x, z);
      const a = rng() * Math.PI;
      const g = K.merge([wallBox(12, 7, 7, 0, -3, 0, STONE, false), paint(hipRoof(12.8, 7.8, 4, 1.8), ROOF, [6, 0, 0, 0])]);
      g.rotateY(a); g.translate(x, y, z);
      far.push(g);
      const d = Math.hypot(x, z);
      // in front of the house, toward the camera
      glows.push({ p: [x - x / d * 9, y + 3, z - z / d * 9], size: Math.max(7, d * 0.011), kind: 1, gain: 6.0, phase: 0, period: 1 });
    }
    const town = (th, R, n, seed) => {
      const r2 = k.rng(seed);
      const cx = R * Math.sin(th), cz = -R * Math.cos(th);
      const gy = W.H(cx, cz);
      const parts = [];
      for (let i = 0; i < n; i++) {
        const a = r2() * Math.PI * 2, d = Math.sqrt(r2()) * 110;
        const x = Math.cos(a) * d, z = Math.sin(a) * d;
        const y = W.H(cx + x, cz + z) - gy;
        const w = r2.range(18, 40), h = r2.range(10, 20) * (1 - 0.4 * d / 110), dd = r2.range(14, 30);
        parts.push(wallBox(w, h + 8, dd, x, y - 8, z, STONE, false));
        parts.push(paint(hipRoof(w + 1, dd + 1, y + h, 3), ROOF, [6, 0, 0, 0]).translate(x, 0, z));
        if (i % 3 === 0) {
          const wx = cx + x, wz = cz + z, d = Math.hypot(wx, wz);
          glows.push({ p: [wx - wx / d * 30, gy + y + h * 0.5, wz - wz / d * 30], size: Math.max(12, R * 0.009), kind: 2, gain: 4.5, phase: 0, period: 1 });
        }
      }
      parts.push(wallBox(9, 46, 9, 12, -8, -6, STONE, false));
      parts.push(paint(hipRoof(10, 10, 38, 5, 12, -6), ROOF, [6, 0, 0, 0]));
      const g = K.merge(parts);
      g.translate(cx, gy, cz);
      far.push(g);
    };
    town(-0.6, 4150, 16, SEED + 5);
    town(0.62, 6500, 14, SEED + 9);

    const nearMesh = new THREE.Mesh(K.merge(near), worldMat);
    nearMesh.castShadow = true; nearMesh.receiveShadow = true;
    k.scene.add(nearMesh);
    const farMesh = new THREE.Mesh(K.merge(far), worldMat);
    farMesh.receiveShadow = true;
    k.scene.add(farMesh);

    // --- the casale's windows at dusk ----------------------------------------------------------
    {
      const rot = st.casaleRot;
      const c = Math.cos(rot), s = Math.sin(rot);
      const gy = W.H(CAS.x, CAS.z);
      const at = (lx, ly, lz) => [CAS.x + lx * c + lz * s, gy + ly, CAS.z - lx * s + lz * c];
      // on the long wall that faces the camera (local +z or -z, whichever does)
      const face = Math.cos(rot) * (-CAS.z) + Math.sin(rot) * (-CAS.x) > 0 ? 1 : -1;
      for (const [u, v] of [[-3.4, 1.6], [3.4, 1.6], [0.0, 5.0], [6.8, 5.0]]) {
        glows.push({ p: at(u, v + 0.3, face * 5.8), size: 3.4, kind: 0, gain: 5.0, phase: 0, period: 1 });
      }
    }
    // fireflies over the grass in the bottom corners
    rng = k.rng(SEED + 8);
    for (let i = 0; i < 20; i++) {
      const side = i % 2 ? 1 : -1;
      const th = side * rng.range(0.42, 0.72), r = rng.range(3.2, 9);
      const x = r * Math.sin(th), z = -r * Math.cos(th);
      glows.push({ p: [x, W.H(x, z) + rng.range(0.35, 1.0), z], size: 0.16, kind: 3, gain: 3.5, phase: rng(), period: rng.range(6, 11) });
    }
    {
      const quads = glows.map((gl) => {
        const q = new THREE.PlaneGeometry(gl.size, gl.size);
        q.lookAt(new THREE.Vector3(-gl.p[0], CAM_Y - gl.p[1], -gl.p[2]));
        q.translate(...gl.p);
        q.deleteAttribute('normal');
        const n = q.getAttribute('position').count;
        const a = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) a.set([gl.kind, gl.phase, gl.gain, gl.period], i * 4);
        q.setAttribute('aGlow', new THREE.BufferAttribute(a, 4));
        return q.index ? q.toNonIndexed() : q;
      });
      const glowU = {
        uWarm: { value: lin(0xffb066) }, uTown: { value: lin(0xffc98a) }, uFire: { value: lin(0xd8f070) },
        uOn: { value: new THREE.Vector2(0, 0) }
      };
      const glowMat = k.shader({
        uniforms: glowU, transparent: true, additive: true, depthWrite: false, side: THREE.DoubleSide,
        vertexShader: k.GLSL_VERTEX + GLOW_DECL + GLOW_VERT,
        fragmentShader: k.GLSL_FRAGMENT + GLOW_DECL + GLOW_FRAG
      });
      const gm = new THREE.Mesh(K.merge(quads), glowMat);
      gm.frustumCulled = false;
      gm.renderOrder = 20;
      k.scene.add(gm);
      st.glowU = glowU;
    }

    // --- long grass, poppies and chamomile in the bottom corners ------------------------------------
    rng = k.rng(SEED + 9);
    {
      const P = [], Nn = [], Cc = [], A = [];
      const push = (p, n, c, a) => { P.push(...p); Nn.push(...n); Cc.push(...c); A.push(...a); };
      const GR = linA(0x6c9a3a, 0.55), GD = linA(0xc6ad5c, 0.6), GT = linA(0xe2d6a0, 0.7);
      // A blade is its centre line (position) and a half-width per vertex
      // (aCard.w, signed by side): the vertex shader turns it to face the
      // camera and never lets it be thinner than the redraw's pixel.
      const blade = (bx, by, bz, h, w, lean, dirA, ph, col) => {
        const dx = Math.cos(dirA), dz = Math.sin(dirA);
        const pts = [];
        const segs = 3;
        for (let s = 0; s <= segs; s++) {
          const t = s / segs;
          const off = lean * t * t * h;
          const ww = w * (1 - 0.72 * Math.pow(t, 1.3)) * 0.5;
          pts.push([[bx + dx * off, by + h * t * (1 - 0.18 * lean * t), bz + dz * off], ww, t, h * t]);
        }
        const nrm = [dx * 0.3, 0.85, dz * 0.3];
        for (let s = 0; s < segs; s++) {
          const [a, wa, t0, h0] = pts[s], [b, wb, t1, h1] = pts[s + 1];
          const c0 = mixA(col, GT, t0 * 0.55), c1 = mixA(col, GT, t1 * 0.55);
          push(a, nrm, c0, [0, h0, ph, -wa]); push(a, nrm, c0, [0, h0, ph, wa]); push(b, nrm, c1, [0, h1, ph, wb]);
          push(a, nrm, c0, [0, h0, ph, -wa]); push(b, nrm, c1, [0, h1, ph, wb]); push(b, nrm, c1, [0, h1, ph, -wb]);
        }
      };
      const nT = Math.round(190 * Math.max(0.6, k.quality.particles));
      for (let i = 0; i < nT; i++) {
        const side = i % 2 ? 1 : -1;
        const th = side * rng.range(0.36, 0.8), r = 2.0 + 5.0 * Math.pow(rng(), 1.5);
        const x = r * Math.sin(th), z = -r * Math.cos(th), y = W.H(x, z) - 0.03;
        const nb = rng.int(5, 9), hT = rng.range(0.3, 0.66) * (r < 3.5 ? 0.85 : 1);
        const ph = rng() * 6.28;
        const col = mixA(GR, GD, sstep(0.25, 0.85, rng()));
        for (let b = 0; b < nb; b++) {
          blade(x + rng.range(-0.13, 0.13), y, z + rng.range(-0.13, 0.13), hT * rng.range(0.55, 1.15), rng.range(0.012, 0.022),
            rng.range(0.25, 0.85), rng() * Math.PI * 2, ph + rng.range(-0.4, 0.4), mixA(col, GD, rng() * 0.3));
        }
      }
      // poppy heads: shallow red cups; chamomile: white discs with a yellow eye
      const cup = (x, y, z, rad, col, ph) => {
        const g = new THREE.CylinderGeometry(rad, rad * 0.5, rad * 0.85, 10, 1, true);
        g.translate(x, y, z);
        const p = g.toNonIndexed();
        const pp = p.getAttribute('position');
        for (let i = 0; i < pp.count; i++) {
          const ox = pp.getX(i) - x, oz = pp.getZ(i) - z, l = Math.hypot(ox, oz) || 1;
          push([pp.getX(i), pp.getY(i), pp.getZ(i)], [ox / l * 0.55, 0.75, oz / l * 0.55], col, [1, y - W.H(x, z), ph, 0]);
        }
      };
      const disc = (x, y, z, rad, col, eye, ph) => {
        for (let s = 0; s < 6; s++) {
          const a0 = s / 6 * Math.PI * 2, a1 = (s + 1) / 6 * Math.PI * 2;
          const hh = y - W.H(x, z);
          push([x, y + 0.002, z], [0, 1, 0], eye, [2, hh, ph, 0]);
          push([x + Math.cos(a1) * rad, y, z + Math.sin(a1) * rad * 0.8], [0, 1, 0], col, [2, hh, ph, 0]);
          push([x + Math.cos(a0) * rad, y, z + Math.sin(a0) * rad * 0.8], [0, 1, 0], col, [2, hh, ph, 0]);
        }
      };
      const POP = linA(0xd2332a, 0.75), CHA = linA(0xf2efe2, 0.8), EYEC = linA(0xe8c23a, 0.7);
      for (let i = 0; i < 46; i++) {
        const side = i % 2 ? 1 : -1;
        const th = side * rng.range(0.38, 0.8), r = 2.6 + 7 * Math.pow(rng(), 1.4);
        const x = r * Math.sin(th), z = -r * Math.cos(th);
        cup(x, W.H(x, z) + rng.range(0.3, 0.58), z, rng.range(0.032, 0.045), mulA(POP, rng.range(0.85, 1.1)), rng() * 6.28);
      }
      for (let i = 0; i < 34; i++) {
        const side = i % 2 ? 1 : -1;
        const th = side * rng.range(0.4, 0.8), r = 2.2 + 3.5 * rng();
        const x = r * Math.sin(th), z = -r * Math.cos(th);
        disc(x, W.H(x, z) + rng.range(0.18, 0.4), z, rng.range(0.016, 0.022), CHA, EYEC, rng() * 6.28);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(Nn, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(Cc, 3));
      g.setAttribute('aCard', new THREE.Float32BufferAttribute(A, 4));
      g.computeBoundingSphere();
      const cardU = { uSway: { value: new THREE.Vector3(0.015, 0, 0.5) }, uTransCol: { value: new THREE.Color(0, 0, 0) },
        uGroundCol: { value: new THREE.Color().setRGB(...mixA(GR, GD, 0.6)) } };
      const cardMat = k.std({ vertexColors: true, roughness: 0.8, metalness: 0, side: THREE.DoubleSide, receiver: 0.5,
        patch: Object.assign({}, CARD_PATCH, { uniforms: cardU }) });
      const cards = new THREE.Mesh(g, cardMat);
      cards.frustumCulled = false;
      cards.receiveShadow = true;
      k.scene.add(cards);
      st.cardU = cardU;
    }

    st.day = {
      sun: new THREE.Color(1.0, 0.74, 0.47), dusk: shows(0xf0904a, 0.25),
      fog: shows(0xd9cdb6), fogN: shows(0x9a88b0, 0.25)
    };
    k.shadowsChanged();
    return st;
  },

  update(k, st, t, look) {
    const n = look.night, key = look.key, D = st.day;
    // the sun goes down; what is left at 21:15 is the sky
    // after sunset only a faint afterglow from the west is left on the slopes
    const si = 12.5 * (0.7 + 0.3 * key) * (1 - n) + 0.9 * n;
    st.sun.color.copy(D.sun).lerp(new THREE.Color(1.0, 0.5, 0.42), n);
    st.sun.intensity = si;
    st.worldU.uSunCol.value.copy(st.sun.color).multiplyScalar(si / Math.PI);
    st.cardU.uTransCol.value.copy(st.sun.color).multiplyScalar(si / Math.PI * 0.35);
    if (st.env(n)) k.renderer.resetState();
    k.scene.environmentIntensity = (0.24 + 0.16 * (1 - key)) * (1 - n) + 0.95 * n;
    const U = st.sky.mesh.material.uniforms;
    U.uSkySunCol.value.setRGB(1.0, 0.8, 0.52).multiplyScalar(1.1 * (1 - n));
    U.uDusk.value.copy(D.dusk).sub(U.uHorizonN.value).multiplyScalar(n * 0.6);
    // aerial perspective: the warm haze, lavender at dusk
    const fc = D.fog.clone().lerp(D.fogN, n);
    k.fog({ density: 1.35e-4, falloff: 1 / 900, base: 0, max: 0.88, color: fc, sun: new THREE.Color(0.55, 0.36, 0.14).multiplyScalar(1 - n), sunDir: SUN });
    st.worldU.uCloudSh.value.z = 0.45 * (1 - n);
    st.cardU.uSway.value.set(0.008 + 0.03 * look.motion, look.motion * 0.02, 0.5);
    st.glowU.uOn.value.set(sstep(0.3, 0.85, n), sstep(0.6, 0.95, n));
  }
};
