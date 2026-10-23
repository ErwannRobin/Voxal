// kit.js — what several scenes are built from: the sky and its image-based
// light, planar reflections, water, terrain, lit facades, rain, foliage,
// glass, instancing. Everything takes the scene's kit `k` (engine.js) and is
// deterministic: same arguments, same world, so a keyed receiver draws the
// same scene as the sender.
//
// Style rules every piece follows (see docs/video-effects.md, Scene engine):
//   * no pattern finer than the PICTURE's pixel: patterns are box-filtered by
//     footprint() (engine GLSL), which knows the resolved size (uDetail);
//   * nothing changes between redraws except as a function of uTime: no
//     per-frame noise, no random();
//   * motion is slow and sparse — every changing pixel costs every receiver
//     bandwidth;
//   * a light-emitting thing is radiance scaled by uEmis, so a dark room
//     dims surfaces more than lamps.

import { THREE, rng } from './engine.js';

// --- small helpers -------------------------------------------------------------

export const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
export const col = (c) => new THREE.Color(c);

// A seeded 2D value-noise fbm on the CPU, for terrain, scattering and layout.
export function noise2(seed) {
  const r = rng(seed);
  const N = 256, perm = new Uint16Array(N * 2), val = new Float32Array(N);
  for (let i = 0; i < N; i++) { perm[i] = i; val[i] = r(); }
  for (let i = N - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
  for (let i = 0; i < N; i++) perm[N + i] = perm[i];
  const lat = (x, y) => val[perm[(perm[x & 255] + y) & 511] & 255];
  const smooth = (t) => t * t * (3 - 2 * t);
  const n = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = smooth(xf), v = smooth(yf);
    const a = lat(xi, yi), b = lat(xi + 1, yi), c = lat(xi, yi + 1), d = lat(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  n.fbm = (x, y, oct = 5, lac = 2.0, gain = 0.5) => {
    let s = 0, a = 0.5, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) { s += a * n(x * f, y * f); norm += a; f *= lac; a *= gain; }
    return s / norm;
  };
  // Ridged: sharp crests, for mountains.
  n.ridged = (x, y, oct = 5) => {
    let s = 0, a = 0.5, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) { const v = 1 - Math.abs(n(x * f, y * f) * 2 - 1); s += a * v * v; norm += a; f *= 2.03; a *= 0.5; }
    return s / norm;
  };
  return n;
}

// An InstancedMesh from a list of placements: { p: [x,y,z], r: [rx,ry,rz]
// (radians, XYZ) | q: Quaternion, s: number | [sx,sy,sz], c: colour }.
export function instances(k, geometry, material, list, opts = {}) {
  const m = new THREE.InstancedMesh(geometry, material, Math.max(1, list.length));
  const M = new THREE.Matrix4(), P = new THREE.Vector3(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), E = new THREE.Euler();
  let colours = false;
  list.forEach((it, i) => {
    P.fromArray(it.p || [0, 0, 0]);
    if (it.q) Q.copy(it.q); else Q.setFromEuler(E.set(...(it.r || [0, 0, 0])));
    if (Array.isArray(it.s)) S.fromArray(it.s); else S.setScalar(it.s == null ? 1 : it.s);
    m.setMatrixAt(i, M.compose(P, Q, S));
    if (it.c != null) { m.setColorAt(i, new THREE.Color(it.c)); colours = true; }
  });
  m.count = list.length;
  m.instanceMatrix.needsUpdate = true;
  if (colours && m.instanceColor) m.instanceColor.needsUpdate = true;
  m.castShadow = !!opts.castShadow;
  m.receiveShadow = opts.receiveShadow !== false;
  m.computeBoundingSphere();
  if (opts.noCull) m.frustumCulled = false;
  return m;
}

export const merge = (geoms, groups = false) => THREE.mergeGeometries(geoms, groups);

// A box whose geometry sits on y = 0 (a building, a plinth), translated.
export function boxAt(w, h, d, x = 0, y = 0, z = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y + h / 2, z);
  return g;
}

// --- sky ---------------------------------------------------------------------------
//
// A dome drawn LAST among opaque things, where nothing nearer was drawn (its
// depth sits just inside the far plane and it writes none), so an interior
// pays for it only through its windows. A day and an evening set of colours,
// mixed by uNight; a sun (or moon) with its glow; one layer of clouds on a
// plane above the camera, filtered to the pixel's footprint. Alpha 0: the sky
// takes no shadow. skyEnvironment() bakes the same sky into the scene's
// image-based light, so what the sky says and what lights the room agree.

const SKY_UNIFORMS = `
uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uGround;
uniform vec3 uZenithN; uniform vec3 uHorizonN; uniform vec3 uGroundN;
uniform vec4 uSkySun;      // xyz direction (normalised), w angular radius (rad)
uniform vec3 uSkySunCol;   // radiance of the disc's glow (the disc is x 30)
uniform vec4 uCloud;       // coverage 0..1, scale (1/m), height (m), wind (m/s)
uniform vec3 uCloudLit; uniform vec3 uCloudShade;
uniform vec3 uCloudLitN; uniform vec3 uCloudShadeN;
uniform float uSkyHaze;    // horizon band: higher = thinner
uniform float uSkyDisc;    // 0 = glow only (a sun behind the camera, a moon in cloud)
`;
const SKY_FUNCS = `
vec3 skyBase(vec3 dir) {
  float e = dir.y;
  vec3 z = mix(uZenith, uZenithN, uNight), h = mix(uHorizon, uHorizonN, uNight), g = mix(uGround, uGroundN, uNight);
  vec3 c = e >= 0.0 ? mix(h, z, pow(clamp(e, 0.0, 1.0), uSkyHaze)) : mix(h, g, sstep(0.0, 0.25, -e));
  float s = dot(dir, uSkySun.xyz);
  c += uSkySunCol * (pow(max(s, 0.0), 8.0) * 0.25 + pow(max(s, 0.0), 120.0) * 1.5);
  return c;
}
`;

const SKY_FRAG = `
  vec3 dir = normalize(vWorld - cameraPosition);
  vec3 c = skyBase(dir);
  // The disc, antialiased by the pixel's angular size.
  float s = dot(dir, uSkySun.xyz);
  float px = max(fwidth(s), 1e-5);
  c += uSkySunCol * 30.0 * uSkyDisc * smoothstep(cos(uSkySun.w) - px, cos(uSkySun.w) + px, s);
  // Clouds: a sheet at uCloud.z metres, drifting with the wind.
  if (uCloud.x > 0.0 && dir.y > 0.01) {
    vec2 p = dir.xz / dir.y * uCloud.z;
    p.x += uTime * uCloud.w;
    vec2 q = p * uCloud.y;
    float fw = footprint(q.x) + footprint(q.y);
    int oct = fw > 0.5 ? 2 : fw > 0.12 ? 3 : fw > 0.04 ? 4 : 5;
    float d = fbm2(q, oct);
    float cov = smoothstep(1.0 - uCloud.x, 1.0 - uCloud.x + 0.28, d);
    // Lit from the sun's side: denser toward it means darker.
    float d2 = fbm2(q + normalize(uSkySun.xz + 1e-4) * 0.35, oct);
    float lit = clamp(0.55 + (d - d2) * 2.2 + 0.25 * max(s, 0.0), 0.0, 1.0);
    vec3 cl = mix(mix(uCloudShade, uCloudShadeN, uNight), mix(uCloudLit, uCloudLitN, uNight), lit);
    float fade = sstep(0.01, 0.18, dir.y);
    c = mix(c, cl, cov * fade);
  }
  gl_FragColor = vec4(c, 0.0);
`;

function skyColourArgs(o) {
  const C = (x, d) => new THREE.Color(x == null ? d : x);
  return {
    uZenith: { value: C(o.zenith, 0x3a6fb8) }, uHorizon: { value: C(o.horizon, 0xcfe0ef) }, uGround: { value: C(o.ground, 0x4a4a48) },
    uZenithN: { value: C(o.zenithNight, o.zenith == null ? 0x0b1020 : o.zenith) },
    uHorizonN: { value: C(o.horizonNight, o.horizon == null ? 0x25203a : o.horizon) },
    uGroundN: { value: C(o.groundNight, o.ground == null ? 0x0c0c10 : o.ground) },
    uSkySun: { value: new THREE.Vector4(...(o.sunDir || [0.5, 0.4, -0.7]), o.sunSize || 0.02) },
    uSkySunCol: { value: C(o.sunColor, 0xffe2b0).multiplyScalar(o.sunIntensity == null ? 1 : o.sunIntensity) },
    uCloud: { value: new THREE.Vector4(o.cloud ? o.cloud.coverage : 0, o.cloud ? o.cloud.scale || 0.0012 : 0.001, o.cloud ? o.cloud.height || 1500 : 1500, o.cloud ? o.cloud.wind || 2 : 0) },
    uCloudLit: { value: C(o.cloud && o.cloud.lit, 0xffffff) }, uCloudShade: { value: C(o.cloud && o.cloud.shade, 0x9aa6b8) },
    uCloudLitN: { value: C(o.cloud && o.cloud.litNight, o.cloud && o.cloud.lit != null ? o.cloud.lit : 0x7a6a80) },
    uCloudShadeN: { value: C(o.cloud && o.cloud.shadeNight, 0x2a2638) },
    uSkyHaze: { value: o.haze == null ? 0.45 : o.haze },
    uSkyDisc: { value: o.disc == null ? 1 : o.disc }
  };
}

export function sky(k, o = {}) {
  const uniforms = skyColourArgs(o);
  const dir = new THREE.Vector3(uniforms.uSkySun.value.x, uniforms.uSkySun.value.y, uniforms.uSkySun.value.z).normalize();
  uniforms.uSkySun.value.set(dir.x, dir.y, dir.z, uniforms.uSkySun.value.w);
  const mat = k.shader({ uniforms, head: SKY_UNIFORMS, fragmentHead: SKY_FUNCS + (o.fragmentHead || ''), fragment: o.fragment || SKY_FRAG, side: THREE.BackSide, depthWrite: false });
  const r = (k.camera.far || 2000) * 0.9;
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 48, 24), mat);
  mesh.renderOrder = 1000;
  mesh.frustumCulled = false;
  mesh.onBeforeRender = (renderer, scene, camera) => {
    mesh.position.copy(camera.position);
    mesh.updateMatrixWorld();
  };
  k.scene.add(mesh);
  return { mesh, uniforms, opts: o };
}

// The sky as an equirectangular picture (linear radiance) for k.environment():
// the same gradient and sun glow, the clouds as their average. `night` picks
// how far into the evening set (0..1).
export function skyPicture(skyOrOpts, night = 0, w = 128, h = 64) {
  const u = skyOrOpts.uniforms || skyColourArgs(skyOrOpts);
  const lerp = (a, b, t) => a + (b - a) * t;
  const mixc = (a, b, t) => [lerp(a.r, b.r, t), lerp(a.g, b.g, t), lerp(a.b, b.b, t)];
  const Z = mixc(u.uZenith.value, u.uZenithN.value, night), H = mixc(u.uHorizon.value, u.uHorizonN.value, night), G = mixc(u.uGround.value, u.uGroundN.value, night);
  const CL = mixc(u.uCloudLit.value, u.uCloudLitN.value, night), CS = mixc(u.uCloudShade.value, u.uCloudShadeN.value, night);
  const sun = u.uSkySun.value, sc = u.uSkySunCol.value, haze = u.uSkyHaze.value, cov = u.uCloud.value.x;
  const data = new Float32Array(w * h * 4);
  for (let j = 0; j < h; j++) {
    const th = ((j + 0.5) / h - 0.5) * Math.PI, ey = Math.sin(th), ce = Math.cos(th);
    for (let i = 0; i < w; i++) {
      const ph = ((i + 0.5) / w - 0.5) * 2 * Math.PI;
      const dx = Math.cos(ph) * ce, dz = Math.sin(ph) * ce;
      let c;
      if (ey >= 0) { const t = Math.pow(ey, haze); c = [lerp(H[0], Z[0], t), lerp(H[1], Z[1], t), lerp(H[2], Z[2], t)]; }
      else { const t = Math.min(1, -ey / 0.25); const s = t * t * (3 - 2 * t); c = [lerp(H[0], G[0], s), lerp(H[1], G[1], s), lerp(H[2], G[2], s)]; }
      const s = Math.max(0, dx * sun.x + ey * sun.y + dz * sun.z);
      const gl = Math.pow(s, 8) * 0.25 + Math.pow(s, 120) * 1.5 + Math.pow(s, 2000) * 30 * u.uSkyDisc.value;
      c = [c[0] + sc.r * gl, c[1] + sc.g * gl, c[2] + sc.b * gl];
      if (cov > 0 && ey > 0.01) {
        const f = Math.min(1, ey / 0.18) * cov * 0.8;
        const cl = mixc({ r: CS[0], g: CS[1], b: CS[2] }, { r: CL[0], g: CL[1], b: CL[2] }, 0.55 + 0.3 * s);
        c = [lerp(c[0], cl[0], f), lerp(c[1], cl[1], f), lerp(c[2], cl[2], f)];
      }
      const o = (j * w + i) * 4;
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 1;
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

// Bake skyPicture() into the scene's image-based light. Call again (it is
// cheap) when the evening has moved on by a step: see envFollower().
export function skyEnvironment(k, skyOrOpts, night = 0, intensity = 1) {
  const tex = skyPicture(skyOrOpts, night);
  const env = k.environment(tex, intensity);
  tex.dispose();
  return env;
}

// Re-bakes the environment only when the evening has moved by `step`, never
// per redraw.
export function envFollower(k, skyOrOpts, step = 0.25, intensity = 1) {
  let last = -1;
  return (night) => {
    const q = Math.round(night / step) * step;
    if (q === last) return false;
    last = q;
    const prev = k.scene.environment;
    skyEnvironment(k, skyOrOpts, q, intensity);
    if (prev && prev !== k.scene.environment) prev.dispose();
    return true;
  };
}

// --- planar reflection -------------------------------------------------------------
//
// A mirror camera renders the scene above the plane into a half-size target
// with mips (roughness reads a coarser level), clipped at the plane (oblique
// near plane, after Three's Reflector — MIT), WITHOUT the main camera's
// jitter, so what it shows holds still between redraws. It is re-rendered
// every `every` redraws, not each one: what it reflects moves slowly.
//
// Returns { uniforms, glsl } for a material patch: add the uniforms, put
// `glsl` in fragmentHead, and call mirrorSample(vWorld, offset, lod) in the
// fragment to read it (rgb, a = 1 where valid).

export function planarMirror(k, mesh, opts = {}) {
  const scale = opts.scale == null ? k.quality.mirror : opts.scale;
  const uniforms = {
    uMirror: { value: null },
    uMirrorMatrix: { value: new THREE.Matrix4() },
    uMirrorOn: { value: 0 }
  };
  const glsl = `
uniform sampler2D uMirror; uniform mat4 uMirrorMatrix; uniform float uMirrorOn;
vec4 mirrorSample(vec3 wp, vec2 off, float lod) {
  if (uMirrorOn < 0.5) return vec4(0.0);
  vec4 c = uMirrorMatrix * vec4(wp, 1.0);
  vec2 uv = c.xy / c.w + off;
  float edge = smoothstep(0.0, 0.03, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
  return vec4(textureLod(uMirror, clamp(uv, 0.001, 0.999), lod).rgb, edge);
}
`;
  if (!scale) return { uniforms, glsl, mirror: null };
  const float = !!(k.renderer.extensions.has('EXT_color_buffer_float') || k.renderer.extensions.has('EXT_color_buffer_half_float'));
  const rt = k.track(new THREE.WebGLRenderTarget(2, 2, {
    type: float ? THREE.HalfFloatType : THREE.UnsignedByteType,
    generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true
  }));
  uniforms.uMirror.value = rt.texture;
  const cam = new THREE.PerspectiveCamera();
  const every = opts.every || 2;
  const normal = new THREE.Vector3(), planeP = new THREE.Vector3(), camP = new THREE.Vector3();
  const view = new THREE.Vector3(), target = new THREE.Vector3(), lookAt = new THREE.Vector3(), rot = new THREE.Matrix4();
  const plane = new THREE.Plane(), clip = new THREE.Vector4(), q = new THREE.Vector4();
  const localNormal = opts.normal || new THREE.Vector3(0, 0, 1);
  let n = 0, busy = false;
  mesh.onBeforeRender = (renderer, scene, camera) => {
    if (busy || camera === cam) return;
    if ((n++ % every) !== 0 && uniforms.uMirrorOn.value) return;
    const cur = renderer.getRenderTarget();
    const w = Math.max(2, Math.round((cur ? cur.width : 512) * scale)), h = Math.max(2, Math.round((cur ? cur.height : 288) * scale));
    if (rt.width !== w || rt.height !== h) rt.setSize(w, h);
    planeP.setFromMatrixPosition(mesh.matrixWorld);
    camP.setFromMatrixPosition(camera.matrixWorld);
    rot.extractRotation(mesh.matrixWorld);
    normal.copy(localNormal).applyMatrix4(rot).normalize();
    view.subVectors(planeP, camP);
    if (view.dot(normal) > 0) return;
    view.reflect(normal).negate().add(planeP);
    rot.extractRotation(camera.matrixWorld);
    lookAt.set(0, 0, -1).applyMatrix4(rot).add(camP);
    target.subVectors(planeP, lookAt).reflect(normal).negate().add(planeP);
    cam.position.copy(view);
    cam.up.set(0, 1, 0).applyMatrix4(rot).reflect(normal);
    cam.lookAt(target);
    cam.near = camera.near; cam.far = camera.far;
    cam.fov = camera.fov; cam.aspect = camera.aspect;
    cam.updateProjectionMatrix();       // no view offset: the reflection holds still
    cam.updateMatrixWorld();
    const tm = uniforms.uMirrorMatrix.value;
    tm.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    tm.multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
    plane.setFromNormalAndCoplanarPoint(normal, planeP).applyMatrix4(cam.matrixWorldInverse);
    clip.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const pm = cam.projectionMatrix, e = pm.elements;
    q.x = (Math.sign(clip.x) + e[8]) / e[0];
    q.y = (Math.sign(clip.y) + e[9]) / e[5];
    q.z = -1.0;
    q.w = (1.0 + e[10]) / e[14];
    clip.multiplyScalar(2.0 / clip.dot(q));
    e[2] = clip.x; e[6] = clip.y; e[10] = clip.z + 1.0 - (opts.clipBias || 0.003); e[14] = clip.w;
    busy = true;
    const vis = mesh.visible;
    mesh.visible = false;
    const hide = opts.hide || [];
    const was = hide.map((o) => o.visible);
    hide.forEach((o) => { o.visible = false; });
    const shadowNeeds = renderer.shadowMap.needsUpdate;
    renderer.shadowMap.needsUpdate = false;
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.setRenderTarget(cur);
    renderer.shadowMap.needsUpdate = shadowNeeds;
    hide.forEach((o, i) => { o.visible = was[i]; });
    mesh.visible = vis;
    busy = false;
    uniforms.uMirrorOn.value = 1;
  };
  return { uniforms, glsl, mirror: cam, target: rt };
}

// A reflective floor or lake surface: k.std() with a planar mirror. `rough`
// blurs the reflection (mip level), `strength` scales it, `ripple` (0..1)
// adds a slowly moving distortion (water), filtered by distance.
export function mirrorMaterial(k, mesh, p = {}) {
  const pm = planarMirror(k, mesh, p);
  const strength = p.strength == null ? 1 : p.strength;
  const params = Object.assign({ color: 0x202020, roughness: 0.2, metalness: 0 }, p.material || {});
  const uStrength = { value: strength };
  const uRipple = { value: new THREE.Vector4(p.ripple || 0, p.rippleScale || 0.6, p.rippleSpeed || 0.25, p.rippleDistort || 0.02) };
  const uRough = { value: p.blur == null ? 1.5 : p.blur };
  params.patch = {
    key: 'mirror' + (p.key || ''),
    uniforms: Object.assign({}, pm.uniforms, { uMirStrength: uStrength, uRipple, uMirBlur: uRough }, p.uniforms || {}),
    fragmentHead: pm.glsl + `
uniform float uMirStrength; uniform vec4 uRipple; uniform float uMirBlur;
vec2 rippleGrad(vec2 x) {
  // Two drifting octaves of value noise, differenced; faded by footprint.
  float s = uRipple.y;
  vec2 a = x * s + vec2(uTime * uRipple.z, uTime * uRipple.z * 0.7);
  vec2 b = x * s * 2.3 - vec2(uTime * uRipple.z * 0.6, -uTime * uRipple.z * 0.9);
  float fa = 1.0 - smoothstep(0.15, 0.6, footprint(a.x) + footprint(a.y));
  float fb = 1.0 - smoothstep(0.15, 0.6, footprint(b.x) + footprint(b.y));
  vec2 e = vec2(0.07, 0.0);
  vec2 g = vec2(vnoise(a + e.xy) - vnoise(a - e.xy), vnoise(a + e.yx) - vnoise(a - e.yx)) * fa;
  g += 0.5 * vec2(vnoise(b + e.xy) - vnoise(b - e.xy), vnoise(b + e.yx) - vnoise(b - e.yx)) * fb;
  return g;
}
` + (p.fragmentHead || ''),
    fragment: p.fragment || {},
    fragmentBefore: {
      opaque_fragment: `{
  vec2 rg = uRipple.x > 0.0 ? rippleGrad(vWorld.xz) * uRipple.x : vec2(0.0);
  vec4 mr = mirrorSample(vWorld, rg * uRipple.w * 10.0, uMirBlur + roughnessFactor * 5.0);
  vec3 Vv = normalize(vViewPosition);
  float NdV = clamp(dot(normalize(normal), Vv), 0.0, 1.0);
  float F = 0.04 + 0.96 * pow(1.0 - NdV, 5.0);
  F = mix(F, 1.0, metalnessFactor) * uMirStrength * mr.a;
  outgoingLight = mix(outgoingLight, mr.rgb, clamp(F, 0.0, 1.0));
}`
    }
  };
  const mat = k.std(params);
  mesh.material = mat;
  return { material: mat, mirror: pm, uniforms: { strength: uStrength, ripple: uRipple, blur: uRough } };
}

// --- terrain -------------------------------------------------------------------------
//
// A heightfield: a grid over [x0,x1] x [z0,z1] lifted by height(x, z), with
// normals from the function itself (central differences), so a coarse grid
// still shades smoothly. `color(x, z, y, n)` may return [r,g,b] per vertex
// (linear), read as vertexColors.
export function heightfield({ x0, x1, z0, z1, nx = 128, nz = 128, height, color = null, skirt = 0 }) {
  const W = nx + 1, H = nz + 1;
  const pos = new Float32Array(W * H * 3), nor = new Float32Array(W * H * 3), uv = new Float32Array(W * H * 2);
  const cols = color ? new Float32Array(W * H * 3) : null;
  const dx = (x1 - x0) / nx, dz = (z1 - z0) / nz;
  const e = Math.min(dx, dz) * 0.5;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const x = x0 + i * dx, z = z0 + j * dz;
      const y = height(x, z);
      const o = (j * W + i) * 3;
      pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
      const hx = height(x + e, z) - height(x - e, z), hz = height(x, z + e) - height(x, z - e);
      const n = new THREE.Vector3(-hx, 2 * e, -hz).normalize();
      nor[o] = n.x; nor[o + 1] = n.y; nor[o + 2] = n.z;
      uv[(j * W + i) * 2] = i / nx; uv[(j * W + i) * 2 + 1] = j / nz;
      if (cols) { const c = color(x, z, y, n); cols[o] = c[0]; cols[o + 1] = c[1]; cols[o + 2] = c[2]; }
    }
  }
  const idx = [];
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (cols) g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  g.setIndex(W * H > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  if (skirt) { /* edges are hidden by the scenes' own framing */ }
  return g;
}

// --- facades: lit windows that hold still ----------------------------------------------
//
// A patch for k.std() that draws a grid of windows on a building's walls:
// glass dark and glossy by day, lit at night in a few warm and cool colours.
// Stable by construction: whether a window is lit is a hash of (building,
// floor, bay) and of a slow clock (each window changes on average every
// `period` seconds, fading over 1.5 s), and where a pixel of the picture
// covers several windows it shows their AVERAGE (lit share x mean colour),
// never one window's own lit-or-not — the windows were the costliest churn in
// the old penthouse (1.7 Mb/s frozen) until they were drawn this way.
//
// Geometry supplies the facade coordinates: either an attribute `facade`
// (vec4: across-the-wall metres, up-the-wall metres, wall id, building seed),
// or, for an InstancedMesh of unit boxes, nothing — they are derived from the
// instance's scale and gl_InstanceID (`instancedBoxes: true`).
//
// o: { bay: 2.0, floor: 3.4, glass: [0.70, 0.62] (fraction of a cell), lit:
//      0.4, litNight: 0.6, warm, cool, accent, strength: 4, period: 4000,
//      frame: colour of the mullions/spandrels (darker than the wall) }
export function facadePatch(o = {}) {
  const uniforms = {
    uWinCell: { value: new THREE.Vector4(o.bay || 2.0, o.floor || 3.4, (o.glass || [0.7, 0.62])[0], (o.glass || [0.7, 0.62])[1]) },
    uWinLit: { value: new THREE.Vector4(o.lit == null ? 0.25 : o.lit, o.litNight == null ? 0.55 : o.litNight, o.strength == null ? 4 : o.strength, o.period || 4000) },
    uWinWarm: { value: new THREE.Color(o.warm == null ? 0xffc48a : o.warm) },
    uWinCool: { value: new THREE.Color(o.cool == null ? 0xcfe3ff : o.cool) },
    uWinAccent: { value: new THREE.Color(o.accent == null ? 0xff5fd2 : o.accent) },
    uWinGlass: { value: new THREE.Color(o.glassColor == null ? 0x0d1218 : o.glassColor) },
    uWinDay: { value: o.dayLit == null ? 0.0 : o.dayLit }
  };
  const box = !!o.instancedBoxes;
  const vertexHead = box ? 'varying vec4 vFacade;\n' : 'attribute vec4 facade;\nvarying vec4 vFacade;\n';
  const vertex = box ? {
    begin_vertex: `
#ifdef USE_INSTANCING
  vec3 isc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  float iseed = float(gl_InstanceID);
#else
  vec3 isc = vec3(1.0); float iseed = 0.0;
#endif
  vec3 fp = position * isc;
  float wallId = abs(normal.x) > 0.5 ? (normal.x > 0.0 ? 1.0 : 3.0) : (abs(normal.z) > 0.5 ? (normal.z > 0.0 ? 0.0 : 2.0) : -1.0);
  vFacade = vec4(abs(normal.x) > 0.5 ? fp.z * sign(normal.x) : fp.x * sign(normal.z + 1e-4), fp.y + 0.5 * isc.y, wallId, iseed);
` } : { begin_vertex: 'vFacade = facade;' };
  const fragmentHead = `
varying vec4 vFacade;
uniform vec4 uWinCell; uniform vec4 uWinLit;
uniform vec3 uWinWarm; uniform vec3 uWinCool; uniform vec3 uWinAccent; uniform vec3 uWinGlass; uniform float uWinDay;
// rgb: emitted light, a: how much of the pixel is glass.
vec4 facadeWindows() {
  if (vFacade.z < 0.0) return vec4(0.0);
  vec2 g = vFacade.xy / uWinCell.xy;
  vec2 fw = footprint2(g);
  float foot = max(fw.x, fw.y);
  vec2 lo = 0.5 - 0.5 * uWinCell.zw, hi = 0.5 + 0.5 * uWinCell.zw;
  float glass = pulse(g.x, lo.x, hi.x, max(fw.x, 1e-4)) * pulse(g.y, lo.y, hi.y, max(fw.y, 1e-4));
  vec2 id = floor(g);
  float seed = vFacade.w * 7.31 + vFacade.z * 131.0;
  float frac = mix(uWinLit.x, uWinLit.y, uNight);
  // This cell, on a clock that ticks for it every uWinLit.w seconds on
  // average (each cell its own phase), fading over 1.5 s.
  float ph = hash13(vec3(id, seed + 3.7));
  float tt = uTime / uWinLit.w + ph;
  float k0 = floor(tt), fr = fract(tt) * uWinLit.w;
  float a0 = step(hash13(vec3(id + k0 * 17.0, seed)), frac);
  float a1 = step(hash13(vec3(id + (k0 - 1.0) * 17.0, seed)), frac);
  float on = mix(a1, a0, smoothstep(0.0, 1.5, fr));
  // Whole floors of offices go dark together: a per-floor bias.
  on *= step(0.12, hash13(vec3(0.0, id.y, seed + 9.1)));
  float hc = hash13(vec3(id.yx, seed + 1.3));
  vec3 c = hc < 0.55 ? uWinWarm : hc < 0.75 ? mix(uWinWarm, vec3(1.0, 0.9, 0.78), 0.7) : hc < 0.95 ? uWinCool : uWinAccent;
  c *= 0.85 + 0.3 * hash13(vec3(id, seed + 5.5));
  // A pixel that spans several windows shows their average.
  vec3 meanC = uWinWarm * 0.62 + uWinCool * 0.25 + uWinAccent * 0.05 + vec3(1.0, 0.9, 0.78) * 0.08;
  float far = smoothstep(0.35, 1.0, foot);
  vec3 em = mix(c * on, meanC * frac * 0.92, far);
  em *= glass * uWinLit.z * mix(uWinDay, 1.0, uNight);
  return vec4(em, glass);
}
`;
  return {
    key: 'facade' + (box ? 'B' : 'A'),
    uniforms,
    vertexHead,
    vertex,
    fragmentHead,
    fragment: {
      color_fragment: 'vec4 WIN = facadeWindows();\ndiffuseColor.rgb = mix(diffuseColor.rgb, uWinGlass, WIN.a);',
      roughnessmap_fragment: 'roughnessFactor = mix(roughnessFactor, 0.08, WIN.a);',
      emissivemap_fragment: 'totalEmissiveRadiance += WIN.rgb;'
    }
  };
}

// --- rain ---------------------------------------------------------------------------------
//
// Streaks falling through a box, as one instanced draw: each a thin quad
// stretched along its velocity by how far a drop falls in one redraw (a
// shutter's length, so it never strobes), lit by `color`, faded by distance,
// and held back in front of the subject's face. Additive over the scene; the
// alpha the surfaces wrote is kept.
//
// o: { count, box: [x0, x1, y0, y1, z0, z1], speed (m/s), slant (rad), width (m),
//      length (s of fall drawn), color, opacity, seed, calm (0..1) }
export function rain(k, o = {}) {
  const count = Math.max(1, Math.round((o.count || 600) * k.quality.particles));
  const b = o.box || [-10, 10, -2, 12, -30, -4];
  const r = rng(o.seed || 7);
  const data = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    data[i * 4] = b[0] + (b[1] - b[0]) * r();
    data[i * 4 + 1] = b[4] + (b[5] - b[4]) * r();
    data[i * 4 + 2] = r();
    data[i * 4 + 3] = 0.8 + 0.4 * r();
  }
  const geo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(1, 1);
  geo.index = quad.index;
  geo.setAttribute('position', quad.getAttribute('position'));
  geo.setAttribute('uv', quad.getAttribute('uv'));
  geo.setAttribute('normal', quad.getAttribute('normal'));
  geo.setAttribute('aDrop', new THREE.InstancedBufferAttribute(data, 4));
  geo.instanceCount = count;
  const uniforms = {
    uRainBox: { value: new THREE.Vector4(b[2], b[3], o.speed || 9, o.slant || 0.25) },
    uRainLook: { value: new THREE.Vector4(o.width || 0.012, o.length || 0.06, o.opacity == null ? 0.18 : o.opacity, o.calm == null ? 0.75 : o.calm) },
    uRainColor: { value: new THREE.Color(o.color == null ? 0x9fb4d0 : o.color) },
    uRainFade: { value: new THREE.Vector2(o.near || 1.0, o.far || 60.0) }
  };
  const decl = `
uniform vec4 uRainBox; uniform vec4 uRainLook; uniform vec3 uRainColor; uniform vec2 uRainFade;
varying vec2 vUv; varying float vRainA; varying vec3 vWorld;
`;
  // Written whole: positions come from the clock, not from the mesh.
  const mat = k.shader({
    uniforms, transparent: true, additive: true, depthWrite: false,
    vertexShader: k.GLSL_VERTEX + decl + `
attribute vec4 aDrop;
void main() {
  float H = uRainBox.y - uRainBox.x;
  float sp = uRainBox.z * aDrop.w;
  float y = uRainBox.y - mod(aDrop.z * H + uTime * sp, H);
  vec3 vel = normalize(vec3(sin(uRainBox.w), -1.0, 0.0));
  vec3 c = vec3(aDrop.x, y, aDrop.y);
  float len = sp * uRainLook.y;
  vec3 toCam = normalize(cameraPosition - c);
  vec3 side = normalize(cross(vel, toCam));
  float dist = length(cameraPosition - c);
  // Never thinner than about a pixel: a hair-thin streak flickers.
  float w = max(uRainLook.x, dist * 1.2 / max(uBufH, 1.0));
  vec3 wp = c + side * position.x * w + vel * position.y * len;
  vUv = uv; vWorld = wp;
  vRainA = uRainLook.z * (uRainLook.x / w) * (1.0 - smoothstep(uRainFade.y * 0.6, uRainFade.y, dist)) * smoothstep(uRainFade.x * 0.5, uRainFade.x, dist);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`,
    fragmentShader: k.GLSL_FRAGMENT + decl + `
void main() {
  float across = 1.0 - abs(vUv.x * 2.0 - 1.0);
  float along = smoothstep(0.0, 0.3, vUv.y) * smoothstep(1.0, 0.6, vUv.y);
  float calm = 1.0 - uRainLook.w * subjectMask(gl_FragCoord.xy / uRes);
  float a = vRainA * across * along * calm;
  gl_FragColor = vec4(uRainColor * uEmis * mix(1.0, 0.6, uNight), a);
}`
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  k.scene.add(mesh);
  quad.dispose();
  return { mesh, uniforms };
}

// --- glass, foliage -------------------------------------------------------------------------

// Window glass: a faint tint that reflects the room's light (the environment
// and the specular highlight), not a transmission pass.
export function glass(k, p = {}) {
  return k.std(Object.assign({
    color: p.tint == null ? 0x9fb0b8 : p.tint, roughness: p.roughness == null ? 0.05 : p.roughness, metalness: 0,
    transparent: true, opacity: p.opacity == null ? 0.12 : p.opacity, depthWrite: false,
    envMapIntensity: p.env == null ? 1.0 : p.env
  }, p.material || {}));
}

// Leaves as alpha-tested cards: a cluster of leaf shapes drawn in the card's
// UV (no texture), translucent toward the light.
// p: { color, color2, translucency, density (0..1), leafScale, key }
export function foliage(k, p = {}) {
  const uniforms = {
    uLeafA: { value: new THREE.Color(p.color == null ? 0x4e7f32 : p.color) },
    uLeafB: { value: new THREE.Color(p.color2 == null ? 0x2f5a20 : p.color2) },
    uLeaf: { value: new THREE.Vector4(p.density == null ? 0.55 : p.density, p.leafScale || 5.0, p.translucency == null ? 0.35 : p.translucency, 0) }
  };
  return k.std({
    color: 0xffffff, roughness: p.roughness == null ? 0.65 : p.roughness, metalness: 0,
    side: THREE.DoubleSide, alphaTest: 0.5, receiver: p.receiver == null ? 0.6 : p.receiver,
    patch: {
      key: 'leaf' + (p.key || ''),
      uniforms,
      fragmentHead: `
uniform vec3 uLeafA; uniform vec3 uLeafB; uniform vec4 uLeaf;
float leafField(vec2 uv) {
  vec2 q = uv * uLeaf.y;
  vec2 id = floor(q), f = fract(q) - 0.5;
  float best = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 o = vec2(float(i), float(j));
    vec2 h = hash22(id + o);
    vec2 d = f - o - (h - 0.5) * 0.6;
    float ang = h.x * 6.2831;
    vec2 r = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * d;
    float leaf = 1.0 - length(r / vec2(0.22, 0.42));
    best = max(best, leaf + (h.y - 0.5) * 0.2);
  }
  // Thin toward the card's edge, so a card reads as a crown, not a square.
  vec2 e = abs(uv - 0.5) * 2.0;
  return best - smoothstep(0.55, 1.0, max(e.x, e.y)) * 0.6 + (uLeaf.x - 0.5);
}
`,
      fragment: {
        color_fragment: `
float LF = leafField(vUv);
diffuseColor.a = smoothstep(-0.02, 0.02, LF);
diffuseColor.rgb *= mix(uLeafB, uLeafA, clamp(LF * 2.0 + hash12(floor(vUv * uLeaf.y)) * 0.4, 0.0, 1.0));`
      },
    },
    defines: { USE_UV: '' }
  });
}
