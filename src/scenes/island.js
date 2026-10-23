// island.js — "Overwater deck, Polynesian lagoon, 10:00, July".
//
// The shaded teak deck of an overwater bungalow, looking out over a lagoon:
// turquoise shallows that deepen to navy past a reef where a line of surf
// breaks, a volcanic peak to the left in the haze, the neighbour's bungalow on
// its stilts, and to the right a coconut palm leaning out from a sand spit, its
// crown in the upper corner, the sun coming through its fronds. Our own thatch
// eave fringes the upper left. In a dark room the sun has set: the sky goes
// orange at the sea, rose above it, indigo overhead, the lagoon mirrors it, and
// the lanterns and the neighbour's windows come on.
//
// Authored with the key light on +x (the engine mirrors the picture for a light
// on the left). Metres; the camera's eye is 2.35 m above the water, on the
// deck (1.15 m), looking -z with the sea's horizon at the middle of the picture.
//
// Layers and what draws them (five programs: sky, water, objects, cards, and
// Three's shadow depth):
//   * sky — kit.sky with this file's own fragment: a three-stop sunset, a sheet
//     of fair-weather cloud kept to the upper corners, and trade cumulus at the
//     sides, analytic (no geometry), drifting a few pixels back and forth;
//   * water — kit.mirrorMaterial with a custom blend (`reflect`): depth-tinted
//     body colour (sand spit, lagoon, coral heads, the drop-off past the reef),
//     a slow swell and footprint-faded ripples (calmed behind the face), the
//     reef's surf filtered to the pixel, and sparse sun glitter on the key side;
//   * objects — one k.std with vertex colours and a per-vertex pattern code
//     (aPat): deck planks, trunk rings, thatch rows, lamps that light at night;
//   * cards — one alpha-tested, double-sided k.std (aCard): the eave's thatch
//     fringe and the palm's fronds, whose leaflets are a comb cut by footprint
//     and which sway about the crown (more when the subject moves).

import { THREE } from './engine.js';
import * as K from './kit.js';

const SEED = 0x15a7d;

// --- colours by what they show as ------------------------------------------------
//
// The output pass shows radiance r as srgb(aces(r x exposure x 0.55)). The sky
// and the cloud colours are authored as the colour they should SHOW at a given
// exposure (the night set at 0.25, where a dark room puts it): shows() inverts
// the curve.
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
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// --- where things are ----------------------------------------------------------------
const DECK_Y = 1.15;
const SUN_DAY = new THREE.Vector3(0.56, 0.80, 0.21).normalize();        // 53 deg, from +x, a little behind us
const SUN_SET = new THREE.Vector3(0.597, -0.035, -0.801).normalize();   // 2 deg under the sea, front right
const LIGHT_SET = new THREE.Vector3(0.62, 0.07, -0.78).normalize();     // what still lights the palm at sunset
const GLINT_DAY = new THREE.Vector3(0.52, 0.16, -0.84).normalize();     // where the day's glitter is seen from
const REEF_Z = 140;
const NB = { x: -24.5, z: -34 };                 // the neighbour's bungalow
const VOLC = { x: -4300, z: -9600 };

// --- GLSL ------------------------------------------------------------------------------

// The sky: day gradient, a designed sunset, the cloud sheet in the upper
// corners, and trade cumulus at the sides. Directions only (no gl_FragCoord):
// the same code draws the reflection in the lagoon.
const CUMN = 7;
const SKY_HEAD = `
uniform vec3 uMidN;
uniform vec4 uCumA[${CUMN}];
uniform vec4 uCumB[${CUMN}];
uniform vec3 uCumLit; uniform vec3 uCumShade; uniform vec3 uCumLitN; uniform vec3 uCumShadeN;
vec3 islandGrad(vec3 dir) {
  float e = dir.y;
  float ee = max(e, 0.0);
  vec3 day = mix(uHorizon, uZenith, pow(ee, uSkyHaze));
  // the evening: orange at the sea, rose a few degrees up, indigo overhead
  vec3 eve = mix(uHorizonN, uMidN, sstep(0.0, 0.14, ee));
  eve = mix(eve, uZenithN, sstep(0.08, 0.5, ee));
  vec3 c = mix(day, eve, uNight);
  if (e < 0.0) c = mix(c, mix(uGround, uGroundN, uNight), sstep(0.0, 0.25, -e));
  float s = max(dot(dir, uSkySun.xyz), 0.0);
  c += uSkySunCol * (pow(s, 6.0) * 0.30 + pow(s, 60.0) * 0.9);
  return c;
}
vec3 horizonCol() { return mix(uHorizon, uHorizonN, uNight); }
// One cumulus: a heap of rounded turrets on a flat base, in its own frame
// (x across in half-widths, y up in heights).
vec4 cumulus(vec2 l, vec4 A, vec4 B) {
  vec2 q = vec2(l.x * A.z / A.w, l.y);
  float fq = footprint(q.x * 3.0) + footprint(q.y * 3.0);
  int oct = fq > 0.5 ? 2 : fq > 0.15 ? 3 : 4;
  float n = fbm2(q * 4.0 + B.x, oct);
  float top = pow(max(1.0 - l.x * l.x, 0.0), 0.6) * (0.8 + 0.2 * cos(l.x * 6.0 + B.x * 3.0));
  float f = top - l.y + 0.55 * (n - 0.5) + B.y * l.x * 0.15;
  float den = smoothstep(-0.06, 0.3 + fq * 0.5, f) * smoothstep(-0.04, 0.2, l.y) * 0.95;
  float n2 = fbm2(q * 4.0 + B.x + vec2(0.07, 0.05), oct);
  float lit = clamp(0.15 + 0.6 * sqrt(max(l.y, 0.0)) + 0.18 * l.x + (n - n2) * 3.0 + 0.25 * f, 0.0, 1.0);
  return vec4(mix(mix(uCumShade, uCumShadeN, uNight), mix(uCumLit, uCumLitN, uNight), lit) * B.w, den);
}
`;
const SKY_FRAG = `
  vec3 dir = normalize(vWorld - cameraPosition);
  vec3 c = islandGrad(dir);
  float az = atan(dir.x, -dir.z);
  float el = asin(clamp(dir.y, -1.0, 1.0));
  float side = abs(dir.x) / max(abs(dir.z), 0.05);
  // fair-weather cloud, only toward the upper corners
  if (uCloud.x > 0.0 && dir.y > 0.05) {
    vec2 p = dir.xz / dir.y * uCloud.z;
    p.x += uTime * uCloud.w;
    vec2 q = p * uCloud.y;
    float fw = footprint(q.x) + footprint(q.y);
    int oct = fw > 0.5 ? 2 : fw > 0.12 ? 3 : fw > 0.04 ? 4 : 5;
    float d = fbm2(q, oct);
    float cov = uCloud.x * sstep(0.30, 0.75, side) * sstep(0.12, 0.30, dir.y);
    float m = smoothstep(1.0 - cov, 1.0 - cov + 0.25, d);
    float d2 = fbm2(q + vec2(0.3, 0.1), oct);
    float lit = clamp(0.62 + (d - d2) * 2.0, 0.0, 1.0);
    vec3 cl = mix(mix(uCloudShade, uCloudShadeN, uNight), mix(uCloudLit, uCloudLitN, uNight), lit);
    c = mix(c, cl, m * sstep(0.05, 0.2, dir.y));
  }
  // trade cumulus, drifting a little back and forth
  for (int i = 0; i < ${CUMN}; i++) {
    vec4 A = uCumA[i];
    float a0 = A.x + 0.012 * sin(uTime * 0.04 + float(i) * 1.9);
    vec2 l = vec2((az - a0) / A.z, (el - A.y) / A.w);
    if (l.y < -0.05 || l.y > 1.2 || abs(l.x) > 1.05) continue;
    vec4 cu = cumulus(l, A, uCumB[i]);
    vec3 cc = mix(cu.rgb, horizonCol(), 0.35 * (1.0 - sstep(0.0, 0.12, el)));
    c = mix(c, cc, cu.a);
  }
  gl_FragColor = vec4(c, 0.0);
`;

// The water: what is under it, the swell, the reef's surf, the glitter.
const WATER_HEAD = `
// Patterns here are filtered by the redraw's OWN pixel (fwidth), not the
// picture's: anything finer than the buffer's pixel is sampled differently by
// each jittered redraw, and a frozen lagoon would still cost bits.
float bfw(float x) { return max(fwidth(x), 1e-5); }
vec2 bfw2(vec2 x) { return max(fwidth(x), vec2(1e-5)); }
// The kit's two drifting octaves, faded by the buffer's pixel.
vec2 islRipple(vec2 x) {
  float s = uRipple.y;
  vec2 a = x * s + vec2(uTime * uRipple.z, uTime * uRipple.z * 0.7);
  vec2 b = x * s * 2.3 - vec2(uTime * uRipple.z * 0.6, -uTime * uRipple.z * 0.9);
  float fa = 1.0 - smoothstep(0.1, 0.4, bfw(a.x) + bfw(a.y));
  float fb = 1.0 - smoothstep(0.1, 0.4, bfw(b.x) + bfw(b.y));
  vec2 e = vec2(0.07, 0.0);
  vec2 g = vec2(vnoise(a + e.xy) - vnoise(a - e.xy), vnoise(a + e.yx) - vnoise(a - e.yx)) * fa;
  g += 0.5 * vec2(vnoise(b + e.xy) - vnoise(b - e.xy), vnoise(b + e.yx) - vnoise(b - e.yx)) * fb;
  return g;
}
uniform vec3 uWShallow; uniform vec3 uWLagoon; uniform vec3 uWDeep; uniform vec3 uWCoral;
uniform vec4 uSpit; uniform vec3 uFoamLit; uniform vec3 uGlint; uniform vec3 uGlintDir;
float reefZ(float x) { return ${REEF_Z.toFixed(1)} + 16.0 * (vnoise(vec2(x * 0.006, 3.1)) - 0.5) - 0.0006 * x * x; }
// metres of water over the bottom
float seaDepth(vec2 xz) {
  float z = -xz.y;
  float d = 2.6 + 1.4 * sstep(25.0, 90.0, z) + 0.8 * (vnoise(xz * 0.03) - 0.5);
  vec2 s = (xz - uSpit.xy) / uSpit.zw;
  d -= 3.2 * exp(-dot(s, s) * 0.9);
  float rz = reefZ(xz.x);
  d = mix(d, 0.5, exp(-sq((z - rz) / 16.0)));
  d += 40.0 * sstep(rz + 6.0, rz + 45.0, z);
  return max(d, 0.0);
}
float coralHeads(vec2 xz) {
  vec2 q = xz / 24.0;
  vec2 fw = bfw2(q);
  vec2 id = floor(q);
  vec2 h = hash22(id + 3.0);
  float on = step(0.6, hash12(id + 11.0));
  vec2 c = id + 0.25 + 0.5 * h;
  float rad = 0.05 + 0.06 * hash12(id + 5.0);
  float blob = 1.0 - smoothstep(rad * 0.3, rad + max(fw.x, fw.y), length(q - c));
  float zf = sstep(12.0, 22.0, -xz.y) * (1.0 - sstep(110.0, 150.0, -xz.y));
  return on * blob * zf * (1.0 - sstep(0.4, 1.0, max(fw.x, fw.y)));
}
// Two long swells: only their slope shows, slowly, and only where they are
// coarser than the picture's pixel.
vec2 swellGrad(vec2 xz) {
  vec2 d1 = normalize(vec2(0.25, 1.0)), d2 = normalize(vec2(-0.45, 1.0));
  float p1 = dot(xz, d1) / 13.0, p2 = dot(xz, d2) / 8.5;
  float v1 = 1.0 - sstep(0.10, 0.40, bfw(p1));
  float v2 = 1.0 - sstep(0.10, 0.40, bfw(p2));
  vec2 g = d1 * cos(6.2832 * (p1 - uTime / 7.0)) * 0.016 * v1;
  g += d2 * cos(6.2832 * (p2 - uTime / 5.8) + 1.7) * 0.010 * v2;
  return g;
}
float waterCalm() { return 1.0 - 0.7 * subjectMask(gl_FragCoord.xy / uRes); }
// The surf on the reef: a band filtered to the pixel's footprint (so a line
// that is thinner than a pixel stays one, at the same brightness), building
// and falling back in 40 m stretches every ten seconds or so.
float reefFoam(vec2 xz, vec2 uv) {
  float z = -xz.y;
  float rz = reefZ(xz.x) + 4.0;
  float sig = 14.0;
  float fz = bfw(z);
  float s2 = sig * sig + fz * fz;
  float band = sig / sqrt(s2) * exp(-sq(z - rz) / (2.0 * s2));
  float sx = xz.x / 40.0;
  float i0 = floor(sx), fx = fract(sx);
  float w0 = sin(uTime * 0.55 + hash11(i0 + 0.5) * 6.283), w1 = sin(uTime * 0.55 + hash11(i0 + 1.5) * 6.283);
  float surf = 0.6 + 0.4 * mix(w0, w1, smoothstep(0.0, 1.0, fx));
  float broken = sstep(0.05, 0.55, vnoise(vec2(xz.x * 0.025, 7.0)));
  float calm = mix(0.3, 1.0, sstep(0.12, 0.3, abs(uv.x - 0.5)));
  return band * surf * broken * calm * 1.6;
}
// Sparks of sun on the facets of the ripples: one possible spark per 0.7 m
// cell, present where the slope it needs is a likely one, each twinkling on
// its own slow clock; drawn at least a pixel wide with its light conserved, and
// as their mean where the cells are finer than the picture.
vec3 glitter(vec2 xz, vec3 V, vec2 uv) {
  vec3 H = normalize(uGlintDir + V);
  float s2 = dot(H.xz, H.xz) / max(H.y * H.y, 1e-4);
  float dens = exp(-s2 / 0.02);
  float zone = sstep(0.58, 0.72, uv.x) * (1.0 - subjectMask(uv));
  dens *= zone;
  if (dens < 0.003) return vec3(0.0);
  vec2 q = xz / 0.7;
  vec2 fw = max(fwidth(q), vec2(1e-5));
  float foot = max(fw.x, fw.y);
  vec2 id = floor(q);
  vec2 h = hash22(id);
  float present = step(hash12(id + 17.0), dens * 0.5);
  vec2 c = id + 0.2 + 0.6 * h;
  vec2 r = max(vec2(0.035), fw * 0.7);
  vec2 dd = (q - c) / r;
  float spot = exp(-dot(dd, dd) * 2.0) * (0.035 * 0.035) / (r.x * r.y);
  float tw = sstep(0.6, 1.0, sin(uTime * (0.9 + 0.8 * h.x) + h.y * 40.0));
  float near = present * spot * tw;
  float mean = dens * 0.5 * 0.0019 * 0.2;
  return uGlint * mix(near, mean, sstep(0.35, 0.9, foot));
}
`;

const WATER_COLOR = `
float WD = seaDepth(vWorld.xz);
float WREEF = sstep(4.0, 25.0, WD);
{
  vec3 wc = mix(uWShallow, uWLagoon, 1.0 - exp(-WD * 0.55));
  wc = mix(wc, uWDeep, WREEF);
  wc = mix(wc, uWCoral, coralHeads(vWorld.xz) * 0.6);
  diffuseColor.rgb = wc;
}
`;
const WATER_NORMAL = `
{
  vec2 g = swellGrad(vWorld.xz) * waterCalm();
  normal = normalize((viewMatrix * vec4(-g.x, 1.0, -g.y, 0.0)).xyz);
}
`;
const WATER_REFLECT = `
  vec2 rg = (islRipple(vWorld.xz) * uRipple.x + swellGrad(vWorld.xz) * 1.2) * waterCalm();
  vec4 mr = mirrorSample(vWorld, rg * uRipple.w * 10.0, uMirBlur + roughnessFactor * 5.0);
  vec3 Vv = normalize(vViewPosition);
  float NdV = clamp(dot(normalize(normal), Vv), 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
  // a lagoon is never a perfect mirror: its ripples show the bottom through
  // the reflection, so the turquoise carries out to the reef; past the reef
  // the ocean's own slopes show more of the sky overhead (deeper blue); far
  // out it is all reflection, into the haze.
  float wdist = length(vWorld - cameraPosition);
  F *= mix(mix(0.45, 0.75, WREEF), 1.0, sstep(1500.0, 7000.0, wdist));
  F *= uMirStrength * mr.a;
  float sideK = mix(0.45, 1.0, sstep(0.08, 0.3, abs(gl_FragCoord.x / uRes.x - 0.5)));
  vec3 refl = mr.rgb * mix(vec3(1.0), vec3(0.5, 0.66, 0.92), WREEF * sideK);
  outgoingLight = mix(outgoingLight, refl, clamp(F, 0.0, 1.0));
`;
const WATER_AFTER = `
{
  vec2 uvp = gl_FragCoord.xy / uRes;
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uFoamLit, clamp(reefFoam(vWorld.xz, uvp), 0.0, 1.0));
  gl_FragColor.rgb += glitter(vWorld.xz, normalize(cameraPosition - vWorld), uvp) * uEmis;
}
`;

// Objects: a pattern per vertex (aPat.x: 0 plain, 1 deck planks, 2 trunk
// rings, 3 thatch, 4 a lamp or a window that lights at night).
const OBJ_PATCH = {
  key: 'islObj',
  vertexHead: 'attribute vec4 aPat;\nvarying vec4 vPat;\n',
  vertex: { begin_vertex: 'vPat = aPat;' },
  fragmentHead: `
varying vec4 vPat;
uniform float uLampOn; uniform vec3 uLampCol;
float bfw(float x) { return max(fwidth(x), 1e-5); }
// Teak planks 0.145 m wide along x, 2.9 m long with staggered butt joints.
float deckTone(vec2 xz) {
  float row = xz.y / 0.145;
  float fr = max(fwidth(row), 1e-5);
  float seam = pulse(row, 0.0, 0.05, max(fr, 1e-4));
  float rid = floor(row);
  float jx = (xz.x + hash11(rid * 1.37) * 2.9) / 2.9;
  float fj = max(fwidth(jx), 1e-5);
  float joint = pulse(jx, 0.0, 0.004, max(fj, 1e-4));
  float tone = 0.86 + 0.26 * hash12(vec2(rid, floor(jx)));
  float grain = 0.94 + 0.12 * vnoise(vec2(xz.x * 1.3, row * 3.0 + 0.5));
  float far = sstep(0.3, 1.0, fr);
  tone = mix(tone * grain, 1.0, far);
  return tone * (1.0 - 0.7 * max(seam, joint));
}
float trunkTone(vec2 p) {
  float q = p.x / 0.085;
  float fq = bfw(q);
  float ring = pulse(q, 0.0, 0.22, max(fq, 1e-4));
  float crack = vnoise(vec2(p.y * 24.0, p.x * 1.5));
  return (0.85 + 0.3 * crack * (1.0 - sstep(0.3, 1.0, fq))) * (1.0 - 0.5 * ring);
}
float thatchTone(vec2 p) {
  float q = p.y / 0.11;
  float fq = bfw(q);
  float rows = pulse(q, 0.0, 0.3, max(fq, 1e-4));
  float fx = bfw(p.x * 30.0);
  float streak = vnoise(vec2(p.x * 30.0, q * 0.7)) * (1.0 - sstep(0.3, 1.0, fx));
  return (0.88 + 0.24 * streak) * (1.0 - 0.3 * rows);
}
`,
  fragment: {
    color_fragment: `
float PK = vPat.x;
if (PK > 0.5 && PK < 1.5) diffuseColor.rgb *= deckTone(vWorld.xz);
else if (PK > 1.5 && PK < 2.5) diffuseColor.rgb *= trunkTone(vPat.yz);
else if (PK > 2.5 && PK < 3.5) diffuseColor.rgb *= thatchTone(vPat.yz);
`,
    roughnessmap_fragment: 'if (PK > 3.5) roughnessFactor = 0.35; else if (PK > 0.5 && PK < 1.5) roughnessFactor = 0.72;',
    emissivemap_fragment: `
if (PK > 3.5) {
  float fl = 1.0 + 0.025 * sin(uTime * 1.3 + vPat.z * 6.0) + 0.015 * sin(uTime * 2.3 + vPat.z * 3.0);
  totalEmissiveRadiance += uLampCol * vPat.y * uLampOn * fl;
}`
  }
};

// Cards: the eave's fringe (aCard.x 1) and the fronds (2). aCard.yz: along,
// across (0..1); aCard.w: the frond's phase.
const CARD_PATCH = {
  key: 'islCard',
  vertexHead: 'attribute vec4 aCard;\nvarying vec4 vCard;\nuniform vec3 uCrown;\nuniform vec2 uSway;\n',
  vertex: {
    begin_vertex: `
vCard = aCard;
if (aCard.x > 1.5) {
  vec3 rel = transformed - uCrown;
  float ph = aCard.w;
  // each frond bobs about the crown, the tip most; the crown leans as one
  float a = uSway.x * (0.62 * sin(uTime * 0.94 + ph) + 0.38 * sin(uTime * 1.73 + ph * 2.7)) * (0.3 + 0.7 * aCard.y);
  vec2 rh = normalize(rel.xz + vec2(1e-4, 0.0));
  transformed += a * cross(vec3(-rh.y, 0.0, rh.x), rel);
  transformed += uSway.x * 0.45 * sin(uTime * 0.57 + 1.3) * cross(vec3(0.0, 0.0, 1.0), rel);
  // and the leaflets flutter when the subject moves
  transformed.y += uSway.y * aCard.z * aCard.y * sin(uTime * 2.6 + ph * 5.0 + aCard.y * 9.0) * 0.12;
}`
  },
  fragmentHead: `
varying vec4 vCard;
uniform vec3 uTransCol;
// Alpha-tested combs are filtered by the redraw's OWN pixel, not the
// picture's: a strand thinner than the buffer's pixel is hit by one jitter
// point and missed by the next, and the resolve never settles.
float bfoot(float x) { return max(fwidth(x), 1e-5); }
float fringeA(vec2 uv) {
  float q = uv.x / 0.024;
  float fq = bfoot(q);
  float h = hash12(vec2(floor(q), 7.0));
  float len = 0.5 + 0.3 * vnoise(vec2(uv.x * 5.0, 1.7)) + 0.2 * vnoise(vec2(uv.x * 23.0, 4.1)) + 0.15 * (h - 0.5);
  float comb = pulse(q, 0.2, 0.8, max(fq, 1e-4));
  float a = mix(1.0, comb, sstep(0.25, 0.6, uv.y / len));
  a = mix(a, 1.0, sstep(0.45, 0.9, fq));
  return a * (1.0 - sstep(len - 0.05, len, uv.y));
}
float frondA(vec2 uv) {
  float q = uv.x * 24.0 - uv.y * 1.8;
  // the leaflets bend a little in groups, each its own width, a few torn out
  q += 0.7 * (vnoise(vec2(q * 0.45, uv.y * 2.2 + vCard.w)) - 0.5) * uv.y;
  float fq = bfoot(q);
  float h = hash12(vec2(floor(q), vCard.w * 7.13));
  float w = mix(0.55, 0.2, uv.y) * (0.7 + 0.6 * hash12(vec2(floor(q), 3.3 + vCard.w))) * step(h, 0.94);
  float comb = pulse(q, 0.5 - 0.5 * w, 0.5 + 0.5 * w, max(fq, 1e-4));
  comb = mix(comb, 1.0, 1.0 - sstep(0.02, 0.08, uv.y));
  // leaflets closer than ~4 of the redraw's pixels churn between jitters (the
  // frozen picture's dearest part): there the wing is shown whole, its edge even
  float fine = sstep(0.4, 0.65, fq);
  comb = mix(comb, 0.8, fine);
  float len = mix(0.7 + 0.3 * h, 0.86, fine);
  return comb * (1.0 - sstep(len - 0.08, len, uv.y));
}
`,
  fragment: {
    color_fragment: `
float CA = vCard.x < 1.5 ? fringeA(vCard.yz) : frondA(vCard.yz);
diffuseColor.a = CA;
if (vCard.x > 1.5) diffuseColor.rgb *= 0.78 + 0.4 * hash12(vec2(floor(vCard.y * 24.0 - vCard.z * 1.8), vCard.w));
else diffuseColor.rgb *= 0.55 + 0.35 * hash12(vec2(floor(vCard.y / 0.012), 2.0));
`
  },
  fragmentBefore: {
    opaque_fragment: `
{
  // sunlight through the leaf, seen from its shaded side
  vec3 Lv = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
  float tr = max(dot(-normal, Lv), 0.0);
  outgoingLight += diffuseColor.rgb * uTransCol * tr;
}`
  }
};

// --- geometry helpers --------------------------------------------------------------------

// Every objects geometry carries position, normal, uv, color, aPat (so they merge).
function tag(g, hex, pat = [0, 0, 0, 0], colFn = null) {
  if (!g.index) g = THREE.mergeVertices(g);
  const n = g.attributes.position.count;
  const c = new THREE.Color(hex);
  const col = new Float32Array(n * 3), pa = new Float32Array(n * 4);
  const P = g.attributes.position;
  for (let i = 0; i < n; i++) {
    const cc = colFn ? colFn(P.getX(i), P.getY(i), P.getZ(i), i) : c;
    col[i * 3] = cc.r; col[i * 3 + 1] = cc.g; col[i * 3 + 2] = cc.b;
    const p = typeof pat === 'function' ? pat(P.getX(i), P.getY(i), P.getZ(i), i) : pat;
    pa[i * 4] = p[0]; pa[i * 4 + 1] = p[1]; pa[i * 4 + 2] = p[2]; pa[i * 4 + 3] = p[3];
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aPat', new THREE.BufferAttribute(pa, 4));
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color', 'aPat'].includes(k)) g.deleteAttribute(k);
  return g;
}
const box = (w, h, d, x, y, z, hex, pat) => tag(K.boxAt(w, h, d, x, y, z), hex, pat);
function cyl(r0, r1, x, y0, y1, z, hex, seg = 8, pat) {
  const g = new THREE.CylinderGeometry(r1, r0, y1 - y0, seg, 1);
  g.translate(x, (y0 + y1) / 2, z);
  return tag(g, hex, pat);
}
// A rod between two points.
function rod(a, b, r, hex, seg = 6) {
  const d = new THREE.Vector3().subVectors(b, a);
  const g = new THREE.CylinderGeometry(r, r, d.length(), seg, 1);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return tag(g, hex);
}
// A quad from four corners (a b c d counter-clockwise seen from the front).
function quad(a, b, c, d, hex, pat) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([...a.toArray(), ...b.toArray(), ...c.toArray(), ...d.toArray()], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return tag(g, hex, pat);
}

// A tube along a curve whose radius follows rad(s); aPat = (2, metres along, angle, 0).
function trunkGeo(curve, n, radial, rad, hex) {
  const frames = curve.computeFrenetFrames(n, false);
  const len = curve.getLength();
  const pos = [], nor = [], uv = [], idx = [];
  const P = new THREE.Vector3(), N = new THREE.Vector3();
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    curve.getPointAt(s, P);
    const r = rad(s);
    for (let j = 0; j <= radial; j++) {
      const a = j / radial * Math.PI * 2;
      N.copy(frames.normals[i]).multiplyScalar(Math.cos(a)).addScaledVector(frames.binormals[i], Math.sin(a)).normalize();
      pos.push(P.x + N.x * r, P.y + N.y * r, P.z + N.z * r);
      nor.push(N.x, N.y, N.z);
      uv.push(s * len, j / radial);
    }
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < radial; j++) {
    const a = i * (radial + 1) + j, b = a + radial + 1;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  const U = g.attributes.uv;
  return tag(g, hex, (x, y, z, i) => [2, U.getX(i), U.getY(i) * 2.0, 0]);
}

// The fronds: each a rachis arching out of the crown and falling, with a wing
// of leaflets either side opening downward in a V. aCard = (2, along, across,
// phase); vertex colour = the frond's green (older, lower fronds yellower).
function frondsGeo(r, crown) {
  const pos = [], nor = [], col = [], card = [], idx = [];
  const UP = new THREE.Vector3(0, 1, 0);
  const COUNT = 15, SEG = 18;
  const green = new THREE.Color(0x2f5c22), old = new THREE.Color(0x7a6a2e), young = new THREE.Color(0x4f7a28);
  for (let f = 0; f < COUNT; f++) {
    const az = f * 2.39996 + r.range(-0.2, 0.2);
    const dx = Math.cos(az), dz = Math.sin(az);
    // fronds toward the lagoon (-x, into the open sky) stay higher
    const tier = f / (COUNT - 1);
    let el = THREE.MathUtils.degToRad(48 - 95 * tier + r.range(-6, 6));
    if (dx < -0.2) el = Math.max(el, THREE.MathUtils.degToRad(4 + 10 * -dx));
    const L = 3.7 + 0.9 * r() - (tier < 0.2 ? 0.8 : 0);
    const droop = (0.08 + 0.12 * r() + 0.10 * tier) * (dx < -0.2 ? 0.55 : 1);
    const dir = new THREE.Vector3(Math.cos(el) * dx, Math.sin(el), Math.cos(el) * dz);
    const c = green.clone().lerp(old, Math.max(0, tier - 0.55) * 1.2 * r.range(0.6, 1)).lerp(young, tier < 0.25 ? 0.5 : 0)
      .multiplyScalar(r.range(0.85, 1.1));
    const ph = r() * 6.283;
    const lmax = 0.95 + 0.25 * r();
    for (const sg of [-1, 1]) {
      const base = pos.length / 3;
      for (let j = 0; j <= SEG; j++) {
        const s = j / SEG * L, u = j / SEG;
        const p = new THREE.Vector3().copy(crown).addScaledVector(dir, s);
        p.y -= droop * s * s;
        const T = dir.clone().add(new THREE.Vector3(0, -2 * droop * s, 0)).normalize();
        const S = new THREE.Vector3().crossVectors(T, UP).normalize();
        const Nf = new THREE.Vector3().crossVectors(S, T).normalize();
        const phi = THREE.MathUtils.degToRad(42 + 18 * u);
        const W = S.clone().multiplyScalar(sg * Math.cos(phi)).addScaledVector(Nf, -Math.sin(phi)).addScaledVector(T, 0.42).normalize();
        const ll = lmax * Math.pow(Math.sin(Math.PI * Math.min(1, 0.04 + 0.96 * u)), 0.6) * (1 - 0.25 * u);
        const pts = [
          p,
          p.clone().addScaledVector(W, ll * 0.5).addScaledVector(Nf, -ll * 0.08),
          p.clone().addScaledVector(W, ll * 0.92).addScaledVector(Nf, -ll * 0.38)
        ];
        const nw = new THREE.Vector3().crossVectors(T, W).normalize();
        if (nw.dot(Nf) < 0) nw.negate();
        pts.forEach((q, k) => {
          pos.push(q.x, q.y, q.z);
          nor.push(nw.x, nw.y, nw.z);
          col.push(c.r, c.g, c.b);
          card.push(2, u, k / 2, ph);
        });
      }
      for (let j = 0; j < SEG; j++) for (let k = 0; k < 2; k++) {
        const a = base + j * 3 + k, b = a + 3;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aCard', new THREE.Float32BufferAttribute(card, 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// The eave's fringe: a strip hanging from the edge a..b, h deep, leaning out by `out`.
function fringeGeo(a, b, h, out, segs) {
  const pos = [], nor = [], col = [], card = [], idx = [];
  const len = a.distanceTo(b);
  const straw = new THREE.Color(0xb08a57);
  const n = new THREE.Vector3().crossVectors(new THREE.Vector3().subVectors(b, a), new THREE.Vector3(0, -1, 0)).normalize();
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const p = a.clone().lerp(b, t);
    for (let k = 0; k <= 1; k++) {
      const q = p.clone().add(new THREE.Vector3(0, -h * k, 0)).addScaledVector(out, k);
      pos.push(q.x, q.y, q.z);
      nor.push(n.x, n.y, n.z);
      col.push(straw.r, straw.g, straw.b);
      card.push(1, t * len, k, 0);
    }
  }
  for (let i = 0; i < segs; i++) { const a0 = i * 2; idx.push(a0, a0 + 2, a0 + 1, a0 + 1, a0 + 2, a0 + 3); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aCard', new THREE.Float32BufferAttribute(card, 4));
  g.setIndex(idx);
  return g;
}

// The lagoon's surface: a grid whose cells grow geometrically away from the
// camera, out to 18 km. One huge quad clipped by the near plane loses its
// depth and position interpolation on a software rasteriser (SwiftShader drew
// the sea in front of the deck), and a fine grid near us costs nothing.
function seaGeo() {
  const ax = [0];
  for (let v = 0, st = 1.5; v < 18000;) { v += st; ax.push(Math.min(v, 18000)); st *= 1.32; }
  const xs = ax.slice(1).reverse().map((a) => -a).concat(ax);
  const n = xs.length;
  const pos = new Float32Array(n * n * 3), nor = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const o = j * n + i;
    pos[o * 3] = xs[i]; pos[o * 3 + 2] = xs[j];
    nor[o * 3 + 1] = 1;
    uv[o * 2] = i / (n - 1); uv[o * 2 + 1] = j / (n - 1);
  }
  const idx = [];
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// --- the scene -------------------------------------------------------------------------------

export default {
  id: 'island',
  camera: { pos: [0, 2.35, 0], target: [0, 2.35 + Math.tan(THREE.MathUtils.degToRad(1)) * 100, -100], fov: 50, near: 0.3, far: 25000 },
  nearness: [1.5, 30],

  build(k) {
    const r = k.rng(SEED);
    const st = {};
    // Placing things where the 16:9 picture wants them (u right, v down).
    const cam = k.camera;
    cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    const ray = (u, v) => new THREE.Vector3(2 * u - 1, 1 - 2 * v, 0.5).unproject(cam).sub(cam.position).normalize();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const onLevel = (u, v, y) => { const d = ray(u, v); return cam.position.clone().addScaledVector(d, (y - cam.position.y) / d.y); };
    const at = (u, v, depth) => { const d = ray(u, v); return cam.position.clone().addScaledVector(d, depth / d.dot(fwd)); };
    const PALM_BASE = onLevel(0.975, 0.665, 0.3);
    const CROWN = at(0.865, 0.085, 14.5);
    const SPIT = [PALM_BASE.x + 1.2, PALM_BASE.z - 1.0, 7.5, 3.0];   // sand spit: centre x, z, radii

    // --- sky and light ------------------------------------------------------------------------
    const skyO = {
      zenith: shows(0x3479cc), horizon: shows(0xbfdff0), ground: lin(0x94c2b4, 0.95),
      zenithNight: shows(0x262a5c, 0.25), horizonNight: shows(0xd27c66, 0.25), groundNight: lin(0x3a3858, 0.7),
      sunDir: SUN_DAY.toArray(), sunColor: 0xfff0d8, sunIntensity: 0.5, disc: 0, haze: 0.34,
      cloud: { coverage: 0.42, scale: 0.0016, height: 1600, wind: 1.5,
        lit: shows(0xfbfcff), shade: shows(0xb4c4d8), litNight: shows(0xf2b296, 0.25), shadeNight: shows(0x6a5274, 0.25) },
      fragmentHead: SKY_HEAD, fragment: SKY_FRAG
    };
    const sky = K.sky(k, skyO);
    const D = THREE.MathUtils.degToRad;
    // trade cumulus: azimuth, base elevation, half-width, height (radians); seed, lean, -, brightness
    const cum = [
      [-27, 0.35, 6.5, 4.2, 0.95], [-36.5, 0.25, 3.5, 2.6, 0.9], [-19.5, 17.5, 4, 4.5, 0.92],
      [26.5, 0.3, 4.8, 3.0, 0.9], [36, 0.2, 4.2, 2.2, 0.88], [19.5, 20, 4.2, 5, 0.95], [33, 21, 5, 4.5, 0.9]
    ];
    Object.assign(sky.mesh.material.uniforms, {
      uMidN: { value: shows(0x9a4c74, 0.25) },
      uCumA: { value: cum.map((c) => new THREE.Vector4(D(c[0]), D(c[1]), D(c[2]), D(c[3]))) },
      uCumB: { value: cum.map((c, i) => new THREE.Vector4(i * 3.7 + 0.5, r.range(-1, 1), 0, c[4])) },
      uCumLit: { value: shows(0xf6f7f6) }, uCumShade: { value: shows(0x97a6bb) },
      uCumLitN: { value: shows(0xf0aa88, 0.25) }, uCumShadeN: { value: shows(0x6e5280, 0.25) }
    });
    st.sky = sky;
    st.env = K.envFollower(k, skyO, 0.25, 1);
    st.env(0);

    const sun = new THREE.DirectionalLight(0xffffff, 5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(k.quality.shadow, k.quality.shadow);
    const sc = sun.shadow.camera;
    sc.left = -34; sc.right = 34; sc.top = 34; sc.bottom = -34; sc.near = 1; sc.far = 180;
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
    sun.target.position.set(-7, 0, -17);
    k.scene.add(sun, sun.target);
    st.sun = sun;
    const lampL = new THREE.PointLight(0xffb36b, 0, 7, 2), lampR = new THREE.PointLight(0xffb36b, 0, 7, 2);
    lampL.position.set(-2.6, DECK_Y + 0.45, -3.55); lampR.position.set(2.6, DECK_Y + 0.45, -3.55);
    k.scene.add(lampL, lampR);
    st.lamps = [lampL, lampR];

    const objU = { uLampOn: { value: 0 }, uLampCol: { value: lin(0xffa95c, 0.55) } };
    const objMat = (recv) => k.std({ vertexColors: true, roughness: 0.85, metalness: 0, receiver: recv,
      patch: Object.assign({ uniforms: objU }, OBJ_PATCH) });
    const near = objMat(0.85), mid = objMat(0.45), far = objMat(0.0);
    const addMesh = (geoms, mat, cast, recv = true) => {
      const m = new THREE.Mesh(K.merge(geoms), mat);
      m.castShadow = cast; m.receiveShadow = recv;
      k.scene.add(m);
      return m;
    };

    // --- our deck -----------------------------------------------------------------------------
    const teak = 0x74533a;
    const deck = [box(7.2, 0.26, 5.6, 0, DECK_Y - 0.26, -1.0, teak, [1, 0, 0, 0])];
    // rope posts at the front corners, a lantern beside each, one more to the right
    const posts = [], lanterns = [];
    for (const sx of [-1, 1]) {
      posts.push(cyl(0.07, 0.065, sx * 2.82, DECK_Y, DECK_Y + 0.85, -3.72, 0x6e4a30, 10));
      posts.push(tag(new THREE.SphereGeometry(0.075, 10, 6).translate(sx * 2.82, DECK_Y + 0.86, -3.72), 0x6e4a30));
    }
    const lantern = (x, z, list) => {
      list.push(box(0.17, 0.03, 0.17, x, DECK_Y, z, 0x3a2a1e));
      list.push(box(0.13, 0.22, 0.13, x, DECK_Y + 0.03, z, 0x8a7a5a, [4, 1.0, x * 3.1 + z, 0]));
      list.push(tag(new THREE.ConeGeometry(0.13, 0.1, 4).rotateY(Math.PI / 4).translate(x, DECK_Y + 0.3, z), 0x3a2a1e));
    };
    lantern(-2.55, -3.6, lanterns); lantern(2.55, -3.6, lanterns); lantern(2.25, -2.75, lanterns);
    // the lounger, bottom left: a teak frame, a cream cushion, a teal towel
    const lounger = [
      box(0.72, 0.1, 2.0, -2.05, DECK_Y + 0.22, -2.55, teak),
      box(0.06, 0.24, 0.06, -2.37, DECK_Y, -3.5, 0x6e4a30), box(0.06, 0.24, 0.06, -1.73, DECK_Y, -3.5, 0x6e4a30),
      box(0.66, 0.09, 1.6, -2.05, DECK_Y + 0.32, -2.75, 0xd6ccb8),
      box(0.6, 0.03, 0.45, -2.05, DECK_Y + 0.41, -3.2, 0x3a7378)
    ];
    const back = new THREE.BoxGeometry(0.66, 0.09, 0.75);
    back.rotateX(-0.75); back.translate(-2.05, DECK_Y + 0.62, -1.75);
    lounger.push(tag(back, 0xd6ccb8));
    addMesh(deck, near, false);
    addMesh([...posts, ...lanterns, ...lounger], near, true);

    // --- our roof: its front-left corner, a thatch slab on bamboo rafters ---------------------
    const E1 = onLevel(0.0, 0.165, 3.95), E2 = onLevel(0.335, 0.0, 3.95);
    const edge = new THREE.Vector3().subVectors(E2, E1).normalize();
    const inward = new THREE.Vector3(-edge.z, 0, edge.x);          // toward the camera side
    if (inward.dot(new THREE.Vector3(0, 0, 0).sub(E1)) < 0) inward.negate();
    const rise = new THREE.Vector3().copy(inward).multiplyScalar(Math.cos(0.42)).add(new THREE.Vector3(0, Math.sin(0.42), 0));
    const ea = E1.clone().addScaledVector(edge, -3), eb = E2.clone().addScaledVector(edge, 2.2);
    const roof = [];
    // underside (seen from below), the front face of the thick edge, and the top
    roof.push(quad(ea, eb, eb.clone().addScaledVector(rise, 7), ea.clone().addScaledVector(rise, 7), 0xb27a4a,
      (x, y, z) => { const p = new THREE.Vector3(x, y, z).sub(E1); return [3, p.dot(edge), p.dot(rise), 0]; }));
    for (let i = 0; i < 5; i++) {
      const a = E1.clone().addScaledVector(edge, -1.2 + i * 0.95).addScaledVector(rise, -0.12).add(new THREE.Vector3(0, -0.05, 0)).addScaledVector(inward, -0.12);
      roof.push(rod(a, a.clone().addScaledVector(rise, 5.5), 0.045, 0x8f7a52));
    }
    roof.push(rod(E1.clone().addScaledVector(edge, -2).add(new THREE.Vector3(0, -0.12, 0)).addScaledVector(inward, 0.15),
      E2.clone().addScaledVector(edge, 3).add(new THREE.Vector3(0, -0.12, 0)).addScaledVector(inward, 0.15), 0.06, 0x7a6040));
    addMesh(roof, near, true);

    // --- the neighbour's bungalow, its stilts and boardwalk --------------------------------------
    const nb = [], nbx = NB.x, nbz = NB.z;
    const pale = 0xa88760, wood = 0x6a4a30, glassC = 0x1c1e20;
    nb.push(box(7.6, 0.25, 7.6, nbx, 1.35, nbz, 0x8a6442, [1, 0, 0, 0]));
    for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
      nb.push(cyl(0.13, 0.13, nbx - 3.5 + i * 7 / 3, -1.2, 1.4, nbz - 3.4 + j * 3.4, wood, 7));
    }
    nb.push(box(6, 2.5, 6, nbx, 1.6, nbz, pale));
    // windows and the door, facing us and the sun: dark by day, lit at night
    nb.push(box(1.2, 1.1, 0.06, nbx - 1.5, 2.5, nbz + 3.0, glassC, [4, 0.9, 1.0, 0]));
    nb.push(box(1.0, 2.0, 0.06, nbx + 1.4, 1.6, nbz + 3.0, glassC, [4, 0.6, 2.0, 0]));
    nb.push(box(0.06, 1.1, 1.6, nbx + 3.0, 2.5, nbz, glassC, [4, 0.8, 3.0, 0]));
    // the deck rail
    for (let i = 0; i <= 6; i++) nb.push(box(0.08, 0.9, 0.08, nbx - 3.7 + i * 7.4 / 6, 1.6, nbz + 3.75, wood));
    nb.push(box(7.5, 0.06, 0.08, nbx, 2.45, nbz + 3.75, wood));
    // hip roof
    const hip = new THREE.ConeGeometry(6.2, 3.3, 4, 1, false);
    hip.rotateY(Math.PI / 4); hip.translate(nbx, 4.1 + 1.65, nbz);
    nb.push(tag(hip, 0x9a7448, (x, y, z) => [3, Math.atan2(z - nbz, x - nbx) * 6.0, (5.75 - y) * 1.2, 0]));
    // lanterns on its deck
    lantern(nbx + 3.4, nbz + 3.3, nb); lantern(nbx - 3.0, nbz + 3.3, nb);
    // the boardwalk, going off to the left
    const bw0 = new THREE.Vector3(nbx + 3.0, 1.48, nbz + 3.8), bw1 = new THREE.Vector3(nbx + 13, 1.48, nbz + 28);
    const bwd = new THREE.Vector3().subVectors(bw1, bw0);
    const bw = new THREE.BoxGeometry(bwd.length(), 0.14, 1.6);
    bw.rotateY(-Math.atan2(bwd.z, bwd.x)); bw.translate((bw0.x + bw1.x) / 2, 1.41, (bw0.z + bw1.z) / 2);
    nb.push(tag(bw, 0x8a6442));
    for (let i = 0; i <= 20; i++) {
      const p = bw0.clone().lerp(bw1, i / 20);
      nb.push(cyl(0.1, 0.1, p.x, -1.2, 1.4, p.z - 0.7, wood, 6), cyl(0.1, 0.1, p.x, -1.2, 1.4, p.z + 0.7, wood, 6));
      nb.push(box(0.07, 0.85, 0.07, p.x, 1.48, p.z + 0.75, wood));
    }
    nb.push(rod(bw0.clone().add(new THREE.Vector3(0, 0.82, 0.75)), bw1.clone().add(new THREE.Vector3(0, 0.82, 0.75)), 0.03, wood, 4));
    addMesh(nb, mid, true);

    // --- the sand spit and the palm -----------------------------------------------------------------
    const spitH = (x, z) => {
      const sx = (x - SPIT[0]) / SPIT[2], sz = (z - SPIT[1]) / SPIT[3];
      return -2.6 + 3.2 * Math.exp(-(sx * sx + sz * sz) * 0.9);
    };
    const sandDry = new THREE.Color(0xebddbf), sandWet = new THREE.Color(0xb8a27c);
    const spit = K.heightfield({ x0: SPIT[0] - 9, x1: SPIT[0] + 12, z0: SPIT[1] - 6, z1: SPIT[1] + 6, nx: 56, nz: 32, height: spitH,
      color: (x, z, y) => { const c = sandWet.clone().lerp(sandDry, sstep(0.05, 0.3, y)); return [c.r, c.g, c.b]; } });
    const spitG = tag(spit, 0xffffff, [0, 0, 0, 0], (x, y, z, i) => new THREE.Color().fromBufferAttribute(spit.attributes.color, i));
    addMesh([spitG], mid, false);
    const palm = [];
    // leaning out over the lagoon, bowed: steeper at the foot, bending over at the top
    const tp = [];
    for (let i = 0; i <= 6; i++) {
      const s = i / 6;
      tp.push(PALM_BASE.clone().lerp(CROWN, s).add(new THREE.Vector3(0.75, -0.35, 0.1).multiplyScalar(Math.sin(Math.PI * s))));
    }
    tp.unshift(PALM_BASE.clone().add(new THREE.Vector3(0.1, -0.5, 0)));
    const curve = new THREE.CatmullRomCurve3(tp);
    palm.push(trunkGeo(curve, 90, 10, (s) => 0.15 + 0.05 * (1 - s) + 0.12 * Math.exp(-s * 30), 0x584c3e));
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * Math.PI * 2 + 0.4;
      palm.push(tag(new THREE.SphereGeometry(0.13, 8, 6).translate(CROWN.x + Math.cos(a) * 0.22, CROWN.y - 0.32 - 0.08 * (i % 2), CROWN.z + Math.sin(a) * 0.22), i % 3 ? 0x6a5a2a : 0x7c6a2e));
    }
    palm.push(tag(new THREE.SphereGeometry(0.3, 10, 8).scale(1, 0.8, 1).translate(CROWN.x, CROWN.y - 0.05, CROWN.z), 0x5a4a30));
    addMesh(palm, mid, false);

    // --- far: the volcano and the motu --------------------------------------------------------------
    const nz = K.noise2(SEED + 3);
    const volcH = (x, z) => {
      const r0 = Math.hypot(x - VOLC.x, (z - VOLC.z) * 1.2);
      let h = 900 * Math.exp(-Math.pow(r0 / 650, 1.5)) + 470 * Math.exp(-Math.pow(r0 / 2300, 2));
      const r2 = Math.hypot(x - (VOLC.x - 1700), z - (VOLC.z - 500));
      h += 380 * Math.exp(-Math.pow(r2 / 700, 1.6));
      h += 260 * (nz.ridged(x / 700, z / 700, 6) - 0.45) * Math.min(1, h / 250);
      return h - 30;
    };
    const jungle = new THREE.Color(0x2f5a2e), jungle2 = new THREE.Color(0x3f6a34), basalt = new THREE.Color(0x5b5a55);
    const volc = K.heightfield({ x0: VOLC.x - 5200, x1: VOLC.x + 4200, z0: VOLC.z - 3500, z1: VOLC.z + 3200, nx: 120, nz: 80, height: volcH,
      color: (x, z, y, n) => {
        const c = jungle.clone().lerp(jungle2, nz(x / 300, z / 300)).lerp(basalt, sstep(0.72, 0.5, n.y) * 0.9 + sstep(900, 1150, y) * 0.3);
        if (y < 6) c.lerp(new THREE.Color(0xd8cfb4), 0.5);
        return [c.r, c.g, c.b];
      } });
    const motuH = (x, z) => {
      const u = (x - 1000) / 1900, v = (z + 2600) / 170;
      const m = sstep(0, 0.08, u) * sstep(1, 0.9, u) * Math.exp(-v * v * 2.5);
      return -3 + m * (6 + 22 * (0.55 + 0.45 * nz.fbm(x / 45, z / 45, 3)));
    };
    const motu = K.heightfield({ x0: 900, x1: 3000, z0: -2900, z1: -2300, nx: 110, nz: 14, height: motuH,
      color: (x, z, y) => { const c = y < 4 ? new THREE.Color(0xd8cdb0) : new THREE.Color(0x2c5428); return [c.r, c.g, c.b]; } });
    const farG = [volc, motu].map((g) => tag(g, 0xffffff, [0, 0, 0, 0], (x, y, z, i) => new THREE.Color().fromBufferAttribute(g.attributes.color, i)));
    const farM = addMesh(farG, far, false, false);
    farM.frustumCulled = false;

    // --- cards: the fringe and the fronds -----------------------------------------------------------
    const cardU = { uCrown: { value: CROWN.clone() }, uSway: { value: new THREE.Vector2(0.03, 0) }, uTransCol: { value: new THREE.Color(0, 0, 0) } };
    // Lambert: a leaf's sheen of the sky turned whole fronds grey at grazing angles
    const cardMat = (recv) => k.lambert({ vertexColors: true, side: THREE.DoubleSide, alphaTest: 0.5,
      receiver: recv, patch: Object.assign({ uniforms: cardU }, CARD_PATCH) });
    const fr = new THREE.Mesh(fringeGeo(ea.clone().addScaledVector(edge, 1.5), eb,
      0.24, inward.clone().multiplyScalar(-0.05), 140), cardMat(0.5));
    fr.receiveShadow = true;
    k.scene.add(fr);
    const fronds = new THREE.Mesh(frondsGeo(r, CROWN), cardMat(0.1));
    fronds.receiveShadow = true;
    k.scene.add(fronds);
    st.cardU = cardU;

    // --- the lagoon ------------------------------------------------------------------------------------
    const water = new THREE.Mesh(seaGeo(), null);
    water.receiveShadow = true;
    const waterU = {
      uWShallow: { value: lin(0x9ee6cf, 0.55) }, uWLagoon: { value: lin(0x10b4a0, 0.5) }, uWDeep: { value: lin(0x1d5f8c, 0.3) },
      uWCoral: { value: lin(0x4a5a3a, 0.2) },
      uSpit: { value: new THREE.Vector4(...SPIT) },
      uFoamLit: { value: new THREE.Color(1, 1, 1) }, uGlint: { value: new THREE.Color(0, 0, 0) }, uGlintDir: { value: GLINT_DAY.clone() }
    };
    const wm = K.mirrorMaterial(k, water, {
      key: 'isl', normal: new THREE.Vector3(0, 1, 0), ripple: 1, rippleScale: 0.35, rippleSpeed: 0.07, rippleDistort: 0.0035, blur: 1.2, strength: 1,
      material: { color: 0xffffff, roughness: 0.05, metalness: 0, receiver: 0.12 },
      uniforms: waterU, fragmentHead: WATER_HEAD, reflect: WATER_REFLECT,
      fragment: { color_fragment: WATER_COLOR, normal_fragment_maps: WATER_NORMAL, opaque_fragment: WATER_AFTER }
    });
    k.scene.add(water);
    st.waterU = waterU;
    st.wm = wm;
    st.objU = objU;
    st.nq = -1;
    return st;
  },

  update(k, st, t, look) {
    const n = look.night, key = look.key, E = look.exposure;
    // The night is a designed sunset, not the day dimmed: what lights it is
    // compensated for the exposure.
    const comp = (0.65 + 0.35 * E) / E;
    const lift = 1 + (comp - 1) * n;
    // the sun goes down on the key side
    const nq = Math.round(n * 16) / 16;
    if (nq !== st.nq) {
      st.nq = nq;
      const L = SUN_DAY.clone().lerp(LIGHT_SET, nq).normalize();
      st.sun.position.copy(st.sun.target.position).addScaledVector(L, 80);
      st.sun.updateMatrixWorld();
      st.sun.target.updateMatrixWorld();
      k.shadowsChanged();
      st.skyDir = SUN_DAY.clone().lerp(SUN_SET, nq).normalize();
      st.sky.uniforms.uSkySun.value.set(st.skyDir.x, st.skyDir.y, st.skyDir.z, 0.02);
      st.waterU.uGlintDir.value.copy(GLINT_DAY).lerp(new THREE.Vector3(SUN_SET.x, 0.035, SUN_SET.z).normalize(), nq).normalize();
    }
    const day = new THREE.Color(1.0, 0.95, 0.86), eve = new THREE.Color(1.0, 0.72, 0.48);
    const sunI = (8.5 * (0.4 + 0.6 * key)) * (1 - n) + 0.55 * n;
    st.sun.color.copy(day).lerp(eve, n);
    st.sun.intensity = sunI * lift;
    st.sky.uniforms.uSkySunCol.value.copy(new THREE.Color(1.0, 0.94, 0.82).multiplyScalar(0.35))
      .lerp(new THREE.Color(1.0, 0.62, 0.28).multiplyScalar(3.4), n);
    if (st.env(n)) k.renderer.resetState();
    k.scene.environmentIntensity = (0.34 + 0.45 * (1 - key)) * (1 - n) + 0.2 * n;
    // fog = the horizon, so the sea meets the sky without a line
    const hz = new THREE.Color().copy(st.sky.uniforms.uHorizon.value).lerp(st.sky.uniforms.uHorizonN.value, n);
    k.fog({ density: 7.5e-5, falloff: 1 / 1100, base: 0, max: 1, color: hz,
      sun: st.sky.uniforms.uSkySunCol.value.clone().multiplyScalar(0.3), sunDir: st.skyDir });
    // lamps
    const on = sstep(0.35, 0.9, n);
    st.objU.uLampOn.value = on;
    st.lamps.forEach((l) => { l.intensity = 0.9 * on * lift; });
    // the palm: a slow sway, more (and a flutter) when the subject moves
    st.cardU.uSway.value.set(0.026 + 0.05 * look.motion, look.motion);
    st.cardU.uTransCol.value.copy(st.sun.color).multiplyScalar(st.sun.intensity * 0.14 * (1 - 0.6 * n));
    // the water's lit foam and glitter
    const irr = st.sun.intensity * Math.max(0.15, st.sun.position.clone().sub(st.sun.target.position).normalize().y) / Math.PI;
    st.waterU.uFoamLit.value.copy(st.sun.color).multiplyScalar(irr * 1.6).add(hz.clone().multiplyScalar(0.25));
    st.waterU.uGlint.value.copy(new THREE.Color(1.0, 0.97, 0.9)).lerp(new THREE.Color(1.0, 0.62, 0.3), n)
      .multiplyScalar((60 * key) * (1 - n) + 40 * n);
  }
};
