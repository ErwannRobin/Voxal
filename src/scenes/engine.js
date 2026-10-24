// engine.js — the animated backgrounds' renderer: Three.js, drawing on the
// camera pipeline's own WebGL2 context.
//
// An ES module, loaded with import() by video-scenes.js the first time a scene
// that has a module (`module: true` in its catalogue entry) is drawn; each
// scene is its own module next to this one (penthouse.js, office.js, ...),
// built from this file and kit.js. Nothing here is a global.
//
// What a scene module exports (default):
//
//   {
//     id: 'penthouse',
//     camera: { pos: [x, y, z], target: [x, y, z], fov: 50, near: 0.1, far: 2000 },
//     nearness: [1.0, 12.0],   // metres: full shadow weight up to the first,
//                              // none past the second (log curve)
//     build(k) -> state        // once per renderer: geometry, materials, lights
//     update(k, state, t, look) // every redraw, BEFORE the render: pure in (t, look)
//   }
//
// `k` (see SceneRenderer.kit()) carries THREE, the scene and camera, the
// shared uniforms (k.U), a seeded random generator, the quality settings and
// the material helpers below. `look` is the pipeline's look, already turned
// into the picture as authored (see draw()): exposure, tint, night (0 day ..
// 1 evening), key (0..1, how directional the subject's light is), elev,
// motion, and the subject (cx, cy, sx, sy; y down, x in the authored frame).
//
// What the pipeline gets back (see VideoScenes.createRenderer): draw() writes
// the scene into its framebuffer as the old ray-marched shaders did — rgb
// display-referred (exposure x tint, ACES, sRGB, a fixed dither), alpha the
// nearness the subject's shadow reads — and leaves the context as the
// Processor set it up (restoreState()).
//
// Three is told nothing about the Processor's own draws, so every draw()
// starts with renderer.resetState(), and ends by putting back the state the
// Processor assumes (restoreState()): Three leaves UNPACK_ALIGNMENT 4 (an
// odd-width mask upload fails), UNPACK_FLIP_Y on after an image texture (the
// camera arrives upside down), culling on (the full-screen triangle can be
// culled). Measured in the architecture spike: 2.5 us a draw.

import * as THREE from '../assets/three/three.min.js';

export { THREE };

// --- the pipeline's GL state ---------------------------------------------------

// The texture each unit had before Three drew, and which unit was active.
// The old scene shaders touched unit 8 only, and the Processor may lean on a
// binding persisting across frames on any other; Three binds its own on
// units 0..n. Units 0..15 cover everything the pipeline uses (0..9).
const UNITS = 16;
export function saveBindings(gl) {
  const active = gl.getParameter(gl.ACTIVE_TEXTURE);
  const tex = new Array(UNITS);
  for (let i = 0; i < UNITS; i++) {
    gl.activeTexture(gl.TEXTURE0 + i);
    tex[i] = gl.getParameter(gl.TEXTURE_BINDING_2D);
  }
  gl.activeTexture(active);
  return { active, tex };
}
export function restoreBindings(gl, b) {
  if (!b) return;
  for (let i = 0; i < UNITS; i++) {
    gl.activeTexture(gl.TEXTURE0 + i);
    gl.bindTexture(gl.TEXTURE_2D, b.tex[i]);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
  }
  gl.activeTexture(b.active);
}

export function restoreState(gl) {
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.SCISSOR_TEST);
  gl.disable(gl.STENCIL_TEST);
  gl.disable(gl.POLYGON_OFFSET_FILL);
  gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
  gl.frontFace(gl.CCW);
  gl.depthMask(true);
  gl.colorMask(true, true, true, true);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  gl.bindBuffer(gl.UNIFORM_BUFFER, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.useProgram(null);
  gl.activeTexture(gl.TEXTURE0);
}

// --- GLSL every engine material shares -------------------------------------------
//
// Declared once in a chunk the material patch and k.shader() both include, so
// a hand-written shader (sky, rain, glass) fogs, glows and filters exactly as
// a MeshStandardMaterial does.

export const ENGINE_UNIFORMS_GLSL = `
uniform float uTime;
uniform float uNight;
uniform vec3 uEmis;
uniform float uDetail;
uniform float uBufH;
uniform vec2 uRes;
uniform vec4 uSubject;
uniform float uMotion;
uniform float uKey;
uniform vec3 uFogColor;
uniform vec3 uFogSun;
uniform vec3 uSunDir;
uniform vec4 uFog;
`;

// Usable in a vertex shader too (no derivatives).
export const ENGINE_NOISE_GLSL = `
float sq(float x) { return x * x; }
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
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm2(vec2 p, int oct) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    s += a * vnoise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p;
    a *= 0.5;
  }
  return s;
}
`;

// Fragment-only: footprints (fwidth), the subject mask, the fog.
export const ENGINE_FRAG_GLSL = `
// How much of the world one pixel of the PICTURE covers, for a pattern
// coordinate x: the resolve adds redraws up to the camera's size (uDetail
// rows), so a pattern may be as fine as that, not as this buffer.
float footprint(float x) { return max(fwidth(x) * uBufH / max(uDetail, 1.0), 1e-5); }
vec2 footprint2(vec2 x) { return max(fwidth(x) * uBufH / max(uDetail, 1.0), vec2(1e-5)); }
// A box-filtered square pulse: 1 inside [lo, hi] of each period-1 cell, the
// cell's average where a pixel spans several cells. Stable at any distance.
float pulseInt(float x, float lo, float hi) {
  return floor(x) * (hi - lo) + clamp(fract(x), lo, hi) - lo;
}
float pulse(float x, float lo, float hi, float w) {
  return (pulseInt(x + 0.5 * w, lo, hi) - pulseInt(x - 0.5 * w, lo, hi)) / w;
}
// The subject, in the authored picture's own UV (0..1, y up): 1 inside the
// head-and-shoulders ellipse, 0 well outside.
float subjectMask(vec2 uv) {
  vec2 d = (uv - uSubject.xy) / max(uSubject.zw * vec2(1.3, 1.15), vec2(1e-3));
  return 1.0 - smoothstep(0.7, 1.3, length(d));
}
// Exponential height fog, integrated along the ray (uFog: density at y=base,
// falloff per metre, base height, max opacity); in-scatter brighter toward
// the sun or the key light.
vec3 engFog(vec3 col, vec3 wp) {
  if (uFog.x <= 0.0) return col;
  vec3 d = wp - cameraPosition;
  float dist = length(d);
  float k = uFog.y;
  float rho0 = uFog.x * exp(-k * (cameraPosition.y - uFog.z));
  float kd = k * d.y;
  float t = abs(kd) > 1e-3 ? (1.0 - exp(-kd)) / kd : 1.0 - 0.5 * kd;
  float f = min(1.0 - exp(-rho0 * t * dist), uFog.w);
  vec3 fc = uFogColor + uFogSun * pow(max(dot(d / max(dist, 1e-4), uSunDir), 0.0), 6.0);
  return mix(col, fc, f);
}
`;

export const ENGINE_GLSL = ENGINE_NOISE_GLSL + ENGINE_FRAG_GLSL;

// --- the output pass -------------------------------------------------------------
//
// From the HDR picture as authored (key light on +x) to what the pipeline
// stores. The picture for a light on the left is the same picture mirrored,
// so a change of side is a crossfade between the picture and its mirror image
// — one render, where the ray-marched shaders drew the world twice.

const OUT_VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const OUT_FRAG = `#version 300 es
precision highp float;
out vec4 outColor;
uniform sampler2D uHdr;
uniform highp sampler2D uDepth;
uniform float uExposure;
uniform vec3 uTint;
uniform float uSideMix;
uniform vec2 uNearFar;
uniform vec2 uNearness;
uniform float uHdrScale;
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
vec3 srgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec4 tap(ivec2 q) {
  vec4 c = texelFetch(uHdr, q, 0);
  float d = texelFetch(uDepth, q, 0).r;
  float z = uNearFar.x * uNearFar.y / (uNearFar.y - d * (uNearFar.y - uNearFar.x));
  float near = clamp(1.0 - log2(max(z, 1e-3) / uNearness.x) / log2(uNearness.y / uNearness.x), 0.0, 1.0);
  return vec4(c.rgb * uHdrScale, d >= 0.999999 ? 0.0 : clamp(c.a, 0.0, 1.0) * near);
}
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  ivec2 m = ivec2(textureSize(uHdr, 0).x - 1 - q.x, q.y);
  vec4 c;
  if (uSideMix >= 0.999) c = tap(q);
  else if (uSideMix <= 0.001) c = tap(m);
  else c = mix(tap(m), tap(q), uSideMix);
  vec3 o = srgb(aces(max(c.rgb, vec3(0.0)) * uTint * uExposure * 0.55));
  o += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  outColor = vec4(o, c.a);
}
`;

function compileRaw(gl, vs, fs) {
  function sh(type, src) {
    const o = gl.createShader(type);
    gl.shaderSource(o, src);
    gl.compileShader(o);
    return o;
  }
  const v = sh(gl.VERTEX_SHADER, vs), f = sh(gl.FRAGMENT_SHADER, fs);
  const p = gl.createProgram();
  gl.attachShader(p, v); gl.attachShader(p, f);
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getShaderInfoLog(f) || gl.getShaderInfoLog(v) || gl.getProgramInfoLog(p);
    gl.deleteProgram(p); gl.deleteShader(v); gl.deleteShader(f);
    throw new Error('scene output pass: ' + log);
  }
  gl.deleteShader(v); gl.deleteShader(f);
  return p;
}

// --- one engine per GL context ---------------------------------------------------
//
// The Three renderer, the HDR target and the output pass belong to the
// context, not to a scene: a scene switch keeps Three's program cache, and
// re-picking a scene does not compile it again.

const ENGINES = new WeakMap();

class Engine {
  constructor(gl) {
    this.gl = gl;
    this.renderer = new THREE.WebGLRenderer({
      canvas: gl.canvas, context: gl, antialias: false, alpha: false,
      depth: false, stencil: false, precision: 'highp'
    });
    const r = this.renderer;
    r.autoClear = true;
    r.setClearColor(0x000000, 0);
    r.outputColorSpace = THREE.LinearSRGBColorSpace;
    r.toneMapping = THREE.NoToneMapping;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.shadowMap.autoUpdate = false;
    // Half-float wherever it can be rendered to; elsewhere 8 bits at a
    // quarter of the light, scaled back up in the output pass.
    this.float = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    this.hdrScale = this.float ? 1 : 4;
    this.rt = null;
    this.rts = [];
    this.out = null;
    this.dead = false;
    restoreState(gl);
  }

  // The HDR target for a w x h draw. Two sizes are kept: a context that draws
  // the same scene at two sizes (the settings preview and its cost probe, a
  // pipeline whose buffer the governor just stepped) would otherwise free and
  // reallocate a half-float target and its depth on every alternation.
  target(w, h) {
    let rt = null;
    for (let i = 0; i < this.rts.length; i++) {
      if (this.rts[i].width === w && this.rts[i].height === h) { rt = this.rts.splice(i, 1)[0]; break; }
    }
    if (!rt) {
      if (this.rts.length >= 2) { const old = this.rts.shift(); old.depthTexture.dispose(); old.dispose(); }
      rt = new THREE.WebGLRenderTarget(w, h, {
        type: this.float ? THREE.HalfFloatType : THREE.UnsignedByteType,
        format: THREE.RGBAFormat, depthBuffer: true,
        depthTexture: new THREE.DepthTexture(w, h),
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false
      });
    }
    this.rts.push(rt);
    this.rt = rt;
    return rt;
  }

  outputPass(fb, w, h, o) {
    const gl = this.gl;
    if (!this.out) {
      const p = compileRaw(gl, OUT_VERT, OUT_FRAG);
      const vao = gl.createVertexArray(), buf = gl.createBuffer();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      const loc = {};
      ['uHdr', 'uDepth', 'uExposure', 'uTint', 'uSideMix', 'uNearFar', 'uNearness', 'uHdrScale']
        .forEach((n) => { loc[n] = gl.getUniformLocation(p, n); });
      this.out = { p, vao, buf, loc };
    }
    const props = this.renderer.properties;
    const color = props.get(this.rt.texture).__webglTexture;
    const depth = props.get(this.rt.depthTexture).__webglTexture;
    const { p, vao, loc } = this.out;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb || null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, color);
    gl.uniform1i(loc.uHdr, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, depth);
    gl.uniform1i(loc.uDepth, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1f(loc.uExposure, o.exposure);
    gl.uniform3f(loc.uTint, o.tint[0], o.tint[1], o.tint[2]);
    gl.uniform1f(loc.uSideMix, o.sideMix);
    gl.uniform2f(loc.uNearFar, o.near, o.far);
    gl.uniform2f(loc.uNearness, o.nearness[0], o.nearness[1]);
    gl.uniform1f(loc.uHdrScale, this.hdrScale);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  dispose() {
    if (this.dead) return;
    this.dead = true;
    const gl = this.gl;
    try {
      this.renderer.setRenderTarget(null);
      this.rts.forEach((rt) => { rt.depthTexture.dispose(); rt.dispose(); });
      this.renderer.renderLists.dispose();
      this.renderer.dispose();
    } catch (e) { /* a lost context */ }
    if (this.out) {
      try { gl.deleteProgram(this.out.p); gl.deleteVertexArray(this.out.vao); gl.deleteBuffer(this.out.buf); } catch (e) { /* lost */ }
    }
    this.rt = this.out = null;
    this.rts = [];
    try { restoreState(gl); } catch (e) { /* lost */ }
  }
}

export function engineFor(gl) {
  let e = ENGINES.get(gl);
  if (!e || e.dead) { e = new Engine(gl); ENGINES.set(gl, e); }
  return e;
}

// Before a context is let go of (loseContext()): Three's renderer, its
// programs and our targets go with it.
export function releaseContext(gl) {
  const e = ENGINES.get(gl);
  if (e) { e.dispose(); ENGINES.delete(gl); }
}

// --- determinism -------------------------------------------------------------------
//
// Every scene is built from one seed, so a keyed receiver drawing your scene
// builds the very same city. Never Math.random().

export function rng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  const next = () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  next.range = (a, b) => a + (b - a) * next();
  next.int = (a, b) => Math.floor(a + (b - a + 1) * next());
  next.pick = (arr) => arr[Math.floor(next() * arr.length) % arr.length];
  next.sign = () => (next() < 0.5 ? -1 : 1);
  return next;
}

// --- the view ------------------------------------------------------------------------
//
// VideoScenes.viewMatrix(v) (Ry Rx Rz, row-major) as a quaternion, for a picture
// that will be shown mirrored when m = -1: S V S, the turn as the authored
// world sees it.
const _vm = new THREE.Matrix4();
export function viewQuat(v, m, out) {
  out = out || new THREE.Quaternion();
  if (!v) return out.identity();
  const y = (Number(v.yaw) || 0) * m, p = Number(v.pitch) || 0, r = (Number(v.roll) || 0) * m;
  const cy = Math.cos(y), sy = Math.sin(y), cp = Math.cos(p), sp = Math.sin(p), cr = Math.cos(r), sr = Math.sin(r);
  _vm.set(
    cy * cr + sy * sp * sr, -cy * sr + sy * sp * cr, sy * cp, 0,
    cp * sr, cp * cr, -sp, 0,
    -sy * cr + cy * sp * sr, sy * sr + cy * sp * cr, cy * cp, 0,
    0, 0, 0, 1);
  return out.setFromRotationMatrix(_vm);
}

// The vertical field of view for a buffer of aspect a: the scene's own for a
// landscape picture, wider for an upright one so a phone held upright still
// sees the room (the ray-marched scenes' FOCAL rule).
export function fovFor(fovDeg, aspect) {
  const hx = 0.5 * aspect;
  const k = Math.min(1, Math.max(0.66, hx / 0.70));
  const f = 0.5 / Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2);
  return THREE.MathUtils.radToDeg(2 * Math.atan(0.5 / (f * k)));
}

function sstepJs(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// --- a scene, ready to draw ---------------------------------------------------------

class SceneRenderer {
  constructor(eng, def, opts) {
    this.eng = eng;
    this.def = def;
    this.id = def.id;
    this.opts = opts || {};
    this.disposables = [];
    const cam = def.camera || {};
    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = true;
    this.camera = new THREE.PerspectiveCamera(cam.fov || 50, 16 / 9, cam.near || 0.05, cam.far || 2000);
    this.camera.position.fromArray(cam.pos || [0, 0, 0]);
    this.camera.lookAt(new THREE.Vector3().fromArray(cam.target || [0, 0, -1]));
    this.baseQuat = this.camera.quaternion.clone();
    this.fov = cam.fov || 50;
    this.nearness = def.nearness || [1, 12];
    this._q = new THREE.Quaternion();
    this.shadowDirty = true;
    this.U = {
      uTime: { value: 0 },
      uNight: { value: 0 },
      uEmis: { value: new THREE.Vector3(1, 1, 1) },
      uDetail: { value: 720 },
      uBufH: { value: 288 },
      uRes: { value: new THREE.Vector2(512, 288) },
      uSubject: { value: new THREE.Vector4(0.5, 0.45, 0.2, 0.3) },
      uMotion: { value: 0 },
      uKey: { value: 1 },
      uFogColor: { value: new THREE.Color(0, 0, 0) },
      uFogSun: { value: new THREE.Color(0, 0, 0) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uFog: { value: new THREE.Vector4(0, 0, 0, 1) }
    };
    const q = this.opts.quality || 'full';
    this.quality = {
      name: q,
      // The shadow map's side, and whether planar reflections and the costlier
      // layers are drawn at all: a thumbnail is 160 px wide.
      shadow: q === 'thumb' ? 512 : q === 'receiver' || this.opts.mobile ? 1024 : 2048,
      mirror: q === 'thumb' ? 0 : q === 'receiver' || this.opts.mobile ? 0.35 : 0.5,
      particles: q === 'thumb' ? 0.4 : this.opts.mobile ? 0.6 : 1
    };
    this.k = this.kit();
    this.state = def.build(this.k) || {};
    restoreState(eng.gl);
  }

  // What a scene module builds and updates with.
  kit() {
    const self = this;
    const U = this.U;
    const k = {
      THREE,
      scene: this.scene,
      camera: this.camera,
      U,
      quality: this.quality,
      renderer: this.eng.renderer,
      rng,
      // Hand Three objects to the renderer to free on dispose().
      track(o) { self.disposables.push(o); return o; },
      // The shadow map is drawn once and again only when this is called (a
      // light moved, a caster moved): the camera never moves the world.
      shadowsChanged() { self.shadowDirty = true; },
      // Fog for every engine material: density per metre at height `base`,
      // `falloff` per metre of height (0 = uniform), `max` opacity.
      fog(o) {
        U.uFog.value.set(o.density || 0, o.falloff || 0, o.base || 0, o.max == null ? 1 : o.max);
        if (o.color) U.uFogColor.value.set(o.color);
        if (o.sun) U.uFogSun.value.set(o.sun);
        if (o.sunDir) U.uSunDir.value.copy(o.sunDir).normalize();
      },
      // An equirectangular picture (Texture) as the scene's image-based light;
      // returns the prefiltered texture.
      environment(tex, intensity) {
        const pm = new THREE.PMREMGenerator(self.eng.renderer);
        const rt = pm.fromEquirectangular(tex);
        pm.dispose();
        // Inside draw() (an update() re-baking for the evening), Three is
        // about to render: its state cache must match the GL state, which
        // PMREM changed. Outside, the pipeline's state is what must hold.
        if (self.drawing) self.eng.renderer.resetState();
        else restoreState(self.eng.gl);
        self.disposables.push(rt);
        self.scene.environment = rt.texture;
        if (intensity != null) self.scene.environmentIntensity = intensity;
        return rt.texture;
      },
      std: (p) => self.material(THREE.MeshStandardMaterial, p),
      phys: (p) => self.material(THREE.MeshPhysicalMaterial, p),
      lambert: (p) => self.material(THREE.MeshLambertMaterial, p),
      basic: (p) => self.material(THREE.MeshBasicMaterial, p),
      shader: (p) => self.shaderMaterial(p),
      // A light-emitting surface that lights nothing: the colour is radiance
      // (linear, can exceed 1), scaled like every emissive (uEmis).
      glow(color, intensity, extra) {
        return self.shaderMaterial(Object.assign({
          uniforms: { uGlow: { value: new THREE.Color(color).multiplyScalar(intensity == null ? 1 : intensity) } },
          head: 'uniform vec3 uGlow;\n' + (extra && extra.head || ''),
          fragment: 'gl_FragColor = vec4(engFog(uGlow * uEmis, vWorld), 0.0);',
          receiver: 0
        }, extra || {}, { head: 'uniform vec3 uGlow;\n' + (extra && extra.head || '') }));
      },
      // Prefixes for a shader written whole (k.shader({ vertexShader, fragmentShader })).
      GLSL_VERTEX: ENGINE_UNIFORMS_GLSL + ENGINE_NOISE_GLSL,
      GLSL_FRAGMENT: ENGINE_UNIFORMS_GLSL + ENGINE_GLSL
    };
    return k;
  }

  // A Three material with the engine's patch: emissive radiance scaled like
  // the old shaders' (uEmis), the surface's shadow weight in alpha
  // (`receiver`, 0..1, default 0.95; transparent materials leave alpha alone),
  // the engine's height fog instead of Three's, and the shared uniforms. A
  // scene adds its own code with `patch`:
  //
  //   patch: { key: 'facade', uniforms: {...}, vertexHead, fragmentHead,
  //            vertex: { begin_vertex: 'code after that chunk' },
  //            fragment: { color_fragment: '...', emissivemap_fragment: '...' },
  //            fragmentBefore: { opaque_fragment: 'outgoingLight += ...;' } }
  //
  // `key` must name the code (Three shares one program between materials
  // whose patches have the same key).
  material(Ctor, params) {
    const p = Object.assign({}, params);
    const patch = p.patch || null; delete p.patch;
    const receiver = p.receiver == null ? 0.95 : p.receiver; delete p.receiver;
    const additive = !!p.additive; delete p.additive;
    const defines = p.defines || null; delete p.defines;
    const m = new Ctor(p);
    if (defines) m.defines = Object.assign({}, m.defines || {}, defines);
    if (m.transparent) blendKeepingAlpha(m, additive);
    const U = this.U;
    const uRecv = { value: receiver };
    const opaque = !m.transparent;
    m.onBeforeCompile = (s) => {
      Object.assign(s.uniforms, U, { uReceiver: uRecv }, patch && patch.uniforms || {});
      let vs = s.vertexShader, fs = s.fragmentShader;
      vs = vs.replace('#include <common>', '#include <common>\n' + ENGINE_UNIFORMS_GLSL + ENGINE_NOISE_GLSL + 'varying vec3 vWorld;\n' + (patch && patch.vertexHead || ''));
      vs = vs.replace('#include <project_vertex>', '#include <project_vertex>\n{ vec4 ew = vec4(transformed, 1.0);\n#ifdef USE_INSTANCING\n ew = instanceMatrix * ew;\n#endif\n vWorld = (modelMatrix * ew).xyz; }');
      fs = fs.replace('#include <common>', '#include <common>\n' + ENGINE_UNIFORMS_GLSL + 'uniform float uReceiver;\nvarying vec3 vWorld;\n' + ENGINE_GLSL + (patch && patch.fragmentHead || ''));
      fs = fs.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= uEmis;');
      if (opaque) fs = fs.replace('#include <opaque_fragment>', '#include <opaque_fragment>\ngl_FragColor.a = uReceiver;');
      fs = fs.replace('#include <fog_fragment>', 'gl_FragColor.rgb = engFog(gl_FragColor.rgb, vWorld);');
      if (patch) {
        for (const [chunk, code] of Object.entries(patch.vertex || {})) vs = vs.replace('#include <' + chunk + '>', '#include <' + chunk + '>\n' + code);
        for (const [chunk, code] of Object.entries(patch.fragment || {})) fs = fs.replace('#include <' + chunk + '>', '#include <' + chunk + '>\n' + code);
        for (const [chunk, code] of Object.entries(patch.fragmentBefore || {})) fs = fs.replace('#include <' + chunk + '>', code + '\n#include <' + chunk + '>');
        for (const [chunk, code] of Object.entries(patch.vertexBefore || {})) vs = vs.replace('#include <' + chunk + '>', code + '\n#include <' + chunk + '>');
      }
      s.vertexShader = vs;
      s.fragmentShader = fs;
    };
    const key = 'eng2|' + (opaque ? 'o' : 't') + '|' + (patch ? patch.key || JSON.stringify(Object.keys(patch)) : '');
    m.customProgramCacheKey = () => key;
    m.userData.receiver = uRecv;
    return m;
  }

  // A hand-written material. `vertex` / `fragment` are the BODY of main()
  // (or pass full `vertexShader` / `fragmentShader`); both get the engine's
  // uniforms and helpers, `vWorld` (world position), `vUv`, `vNormalW`.
  // The fragment writes gl_FragColor: rgb linear radiance (call engFog()
  // yourself), alpha the receiver weight when opaque.
  shaderMaterial(p) {
    const U = this.U;
    const head = ENGINE_UNIFORMS_GLSL + (p.head || '');
    const vs = p.vertexShader || (head + ENGINE_NOISE_GLSL + `
varying vec3 vWorld;
varying vec2 vUv;
varying vec3 vNormalW;
void main() {
  vUv = uv;
  vec4 wp = vec4(position, 1.0);
#ifdef USE_INSTANCING
  wp = instanceMatrix * wp;
  vNormalW = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
#else
  vNormalW = normalize(mat3(modelMatrix) * normal);
#endif
  wp = modelMatrix * wp;
  vWorld = wp.xyz;
  ${p.vertex || ''}
  gl_Position = projectionMatrix * viewMatrix * wp;
}`);
    const fs = p.fragmentShader || (head + `
varying vec3 vWorld;
varying vec2 vUv;
varying vec3 vNormalW;
` + ENGINE_GLSL + (p.fragmentHead || '') + `
void main() {
  ${p.fragment || 'gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0);'}
}`);
    const m = new THREE.ShaderMaterial({
      uniforms: Object.assign({}, U, p.uniforms || {}),
      vertexShader: vs,
      fragmentShader: fs,
      transparent: !!p.transparent,
      depthWrite: p.depthWrite == null ? !p.transparent : p.depthWrite,
      depthTest: p.depthTest == null ? true : p.depthTest,
      side: p.side == null ? THREE.FrontSide : p.side
    });
    if (p.transparent) blendKeepingAlpha(m, !!p.additive);
    if (p.defines) m.defines = Object.assign({}, p.defines);
    return m;
  }

  // Per-redraw uniforms and the authored look.
  prepare(w, h, time, look, frame) {
    const U = this.U;
    const E = Math.max(0.05, look.exposure);
    const tint = look.tint || [1, 1, 1];
    const night = sstepJs(0.62, 0.28, E);
    const em = 0.65 + 0.35 * E;   // mix(1, E, 0.35)
    U.uTime.value = time;
    U.uNight.value = night;
    U.uEmis.value.set(em / (E * tint[0]), em / (E * tint[1]), em / (E * tint[2]));
    U.uDetail.value = (frame && frame.detail) || h;
    U.uBufH.value = h;
    U.uRes.value.set(w, h);
    U.uMotion.value = Math.min(1, Math.max(0, look.motion || 0));
    U.uKey.value = Math.min(1, Math.abs(look.dirX || 0));
    const m = look.sideMix >= 0.5 ? 1 : -1;
    // The subject in the authored picture: mirrored with it when the picture
    // will be shown the other way round. y up, like gl_FragCoord.
    const cx = m > 0 ? look.cx : 1 - look.cx;
    U.uSubject.value.set(cx, 1 - look.cy, look.sx, look.sy);
    return {
      m,
      exposure: E, tint, night,
      key: U.uKey.value, elev: look.dirY || 0, motion: U.uMotion.value,
      cx, cy: look.cy, sx: look.sx, sy: look.sy,
      sideMix: look.sideMix
    };
  }

  // Draw into framebuffer fb (null = the canvas), w x h. See the header.
  draw(fb, w, h, time, look, frame, view) {
    const eng = this.eng, gl = eng.gl, r = eng.renderer;
    if (eng.dead || (gl.isContextLost && gl.isContextLost())) return;
    const saved = saveBindings(gl);
    r.resetState();
    this.drawing = true;
    const L = this.prepare(w, h, time, look, frame);
    try {
      if (this.def.update) this.def.update(this.k, this.state, time, L);
    } finally { this.drawing = false; }
    const cam = this.camera;
    cam.aspect = w / h;
    cam.fov = fovFor(this.fov, w / h);
    const j = frame && frame.jitter;
    // The resolve looks at each pixel jitter px off its centre (x right, y
    // up); Three's view offset is in pixels, y down. Mirrored for a picture
    // that will be flipped.
    if (j) cam.setViewOffset(w, h, j[0] * L.m, -j[1], w, h);
    else cam.clearViewOffset();
    cam.updateProjectionMatrix();
    cam.quaternion.copy(this.baseQuat).multiply(viewQuat(view, L.m, this._q));
    cam.updateMatrixWorld();
    if (this.shadowDirty) { r.shadowMap.needsUpdate = true; this.shadowDirty = false; }
    const rt = eng.target(w, h);
    r.setRenderTarget(rt);
    r.render(this.scene, cam);
    r.setRenderTarget(null);
    restoreState(gl);
    eng.outputPass(fb, w, h, {
      exposure: L.exposure, tint: L.tint, sideMix: look.sideMix,
      near: cam.near, far: cam.far, nearness: this.nearness
    });
    restoreBindings(gl, saved);
  }

  // Compile every program the scene needs without stalling the page where
  // the driver can compile on its own threads. Must see the same target as
  // draw() (output colour space is part of Three's program key).
  compile(w, h) {
    const eng = this.eng, r = eng.renderer;
    const saved = saveBindings(eng.gl);
    r.resetState();
    this.prepare(w || 512, h || 288, 37, defaultLook(), null);
    r.setRenderTarget(eng.target(w || 512, h || 288));
    let done;
    try { done = r.compileAsync(this.scene, this.camera, this.scene); } catch (e) { done = Promise.reject(e); }
    // Synchronous work (and Three's bindings) happened above: hand the
    // units back now, and again when the driver is done.
    r.setRenderTarget(null);
    restoreState(eng.gl);
    restoreBindings(eng.gl, saved);
    return Promise.resolve(done).then(() => {
      restoreState(eng.gl);
    }, (e) => {
      try { restoreState(eng.gl); } catch (e2) { /* lost */ }
      throw e;
    });
  }

  info() {
    const i = this.eng.renderer.info;
    return { calls: i.render.calls, triangles: i.render.triangles, programs: (i.programs || []).length,
      geometries: i.memory.geometries, textures: i.memory.textures };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const eng = this.eng;
    const saved = eng.dead ? null : saveBindings(eng.gl);
    try { this.disposeInner(eng); } finally { if (saved) restoreBindings(eng.gl, saved); }
  }

  disposeInner(eng) {
    if (this.def.dispose) { try { this.def.dispose(this.k, this.state); } catch (e) { /* ignore */ } }
    if (eng.dead) return;
    try {
      eng.renderer.setRenderTarget(null);
      this.scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((mm) => {
          for (const v of Object.values(mm)) if (v && v.isTexture) v.dispose();
          mm.dispose();
        });
        if (o.isInstancedMesh) o.dispose();
        if (o.isLight && o.dispose) o.dispose();
      });
      this.disposables.forEach((d) => { try { d.dispose(); } catch (e) { /* ignore */ } });
      eng.renderer.renderLists.dispose();
      restoreState(eng.gl);
    } catch (e) { /* a lost context */ }
    this.disposables = [];
  }
}

// Transparent layers over the scene (rain, glass, glows) must not change the
// alpha the opaque surfaces wrote: that is the subject's shadow weight.
function blendKeepingAlpha(m, additive) {
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.SrcAlphaFactor;
  m.blendDst = additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor;
  m.blendEquationAlpha = THREE.AddEquation;
  m.blendSrcAlpha = THREE.ZeroFactor;
  m.blendDstAlpha = THREE.OneFactor;
  m.premultipliedAlpha = false;
}

function defaultLook() {
  return { sideMix: 1, dirX: 0.6, dirY: 0, motion: 0, tint: [1, 1, 1], exposure: 1, cx: 0.5, cy: 0.62, sx: 0.22, sy: 0.32 };
}

// The one entry point video-scenes.js uses. Synchronous: geometry is built
// and programs are compiled the first time it draws, unless compile() is
// awaited first (createRenderer does).
export function createRenderer(gl, def, opts) {
  // Building (Three's constructor, PMREM, geometry uploads) binds textures
  // on the pipeline's units: hand them back.
  const saved = saveBindings(gl);
  let eng, sr;
  try {
    eng = engineFor(gl);
    sr = new SceneRenderer(eng, def, opts);
  } finally {
    restoreBindings(gl, saved);
  }
  return {
    id: def.id,
    engine: 'three',
    draw: (fb, w, h, time, look, frame, view) => sr.draw(fb, w, h, time, look, frame, view),
    compile: (w, h) => sr.compile(w, h),
    info: () => sr.info(),
    dispose: () => sr.dispose(),
    _scene: sr
  };
}
