# Scene engine (v2): Three.js worlds behind the camera

The animated backgrounds (`preset:<id>`) used to be one ray-marched fragment
shader each, in `src/video-scenes.js`. They are now 3D worlds built with
**Three.js r186** (vendored, MIT) on the camera pipeline's **own WebGL2
context**, one ES module per scene under `src/scenes/`. This page is the
architecture and the authoring guide. The pipeline around a scene (segmentation,
resolve, composite, keyed receivers) is unchanged and described in
`docs/video-effects.md`.

## Why Three.js, and why on the same context

Measured in the architecture spike (same night-city content, cold caches):

| | ray-marched penthouse | hand-written raster | Three.js |
|---|---|---|---|
| SwiftShader first frame | 2.7 s | 0.35 s | 1.06 s |
| SwiftShader redraw 512×288 / 720p | 44 / 270 ms | 30 / 116 ms | 36 / 151 ms |
| Apple M5 first frame | 0.78 s | 0.24 s | 0.55 s |
| Apple M5 redraw 512×288 / 720p | 1.0 / 3.6 ms | 0.4 / 0.6 ms | 0.5 / 0.7 ms |

Three costs 1.2× a hand-written rasteriser in steady state and is far cheaper
than ray marching; what it buys is a documented geometry, material, shadow, IBL
and instancing library that several people can build scenes with at once. A
separate canvas would need a copy every frame (WebGL contexts cannot share
textures), so Three draws on the Processor's context and gives the state back
(`restoreState()` in `engine.js`).

Ray marching survives where it wins: nothing in the catalogue needs it today;
skies, clouds, water ripples and facades are analytic shaders inside the Three
scene (see `kit.js`).

## The pieces

| file | what |
|---|---|
| `src/assets/three/three.min.js` | Three r186 + `mergeGeometries`, `mergeVertices`, `RoundedBoxGeometry`, one ES module (`make three-vendor`, entry `scripts/three-entry.mjs`) |
| `src/scenes/engine.js` | one Three renderer per GL context, the HDR target, the output pass, the material patch, `createRenderer()` |
| `src/scenes/kit.js` | shared generators: sky + IBL bake, planar mirror, water, heightfield terrain, facade windows, rain, glass, foliage, instancing |
| `src/scenes/<id>.js` | one scene each (`export default { id, camera, nearness, build, update }`) |
| `src/video-scenes.js` | the catalogue; `createRenderer(gl, id, opts)` loads a `module: true` scene with `import()` |

The pipeline holds a **renderer object** per scene, whatever draws it:
`draw(fb, w, h, time, look, frame, view)` and `dispose()`. A scene without
`module: true` is its old shader, wrapped in the same object, so scenes could
move one at a time.

## What `draw()` does

1. `renderer.resetState()` — Three knows nothing of the Processor's own draws.
2. Shared uniforms (`k.U`): time, `uNight` (= `sstep(0.62, 0.28, exposure)`),
   `uEmis` (emissive pre-scale), `uDetail` (picture height), `uRes`, `uSubject`.
3. `scene.update(k, state, t, look)`.
4. Camera: the scene's base orientation × the phone/mouse turn, jittered by the
   resolve's sub-pixel offset (`setViewOffset`), vertical FOV widened for an
   upright picture (`fovFor()`: the old FOCAL rule).
5. Render into a half-float target with a depth texture.
6. `restoreState()`, then the **output pass** (raw GL) into the pipeline's
   framebuffer: `rgb = srgb(aces(hdr × tint × exposure × 0.55)) + dither` —
   the old shaders' tone — and `alpha = receiver × nearness(depth)`.

### Mirroring is an image flip

Scenes are authored with the key light on **+x**. A light on the left is the
same picture mirrored, so the output pass reads `x` or `W−1−x`, and a change of
side crossfades the picture with its mirror image: **one render**, where the old
shaders drew the world twice. Everything subject-related (the subject's
position, the view turn, the jitter's x) is given to the scene in the
*authored* frame. Consequence: nothing in a scene may be handed (text, clocks,
logos) — already the rule.

### Exposure, tint and emissives

The output pass multiplies everything by `tint × exposure`. Emissive light
(lamps, windows, neon) should be dimmed less than lit surfaces in a dark room
(`e × mix(1, E, 0.35)`, as before), so every engine material multiplies its
emissive radiance by `uEmis = mix(1,E,0.35)/(E·tint)` — exact, no second
target.

### Alpha: the subject's shadow

`alpha = receiver × nearness`. `nearness` comes from depth (`nearness: [d0, d1]`
in metres: 1 up to `d0`, 0 past `d1`, log in between). `receiver` is per
material (`k.std({ receiver: 0.6 })`, default 0.95); the sky writes 0;
transparent layers (rain, glass, glows) keep the alpha below them.

## Writing a scene

```js
// src/scenes/example.js
import { THREE } from './engine.js';
import * as K from './kit.js';

export default {
  id: 'example',
  camera: { pos: [0, 1.2, 0], target: [0, 1.15, -3], fov: 50, near: 0.05, far: 2000 },
  nearness: [1.0, 12.0],
  build(k) {
    const s = K.sky(k, { sunDir: [0.6, 0.3, -0.7], cloud: { coverage: 0.4 } });
    K.skyEnvironment(k, s, 0);
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(6, 3), k.std({ color: 0xe6ded2, roughness: 0.9 }));
    k.scene.add(wall);
    return { s };
  },
  update(k, st, t, look) { /* pure in (t, look): look.night, look.key, look.motion, look.cx... */ }
};
```

Then set `module: true` on its catalogue entry in `src/video-scenes.js`.

### The kit object `k`

- `k.THREE`, `k.scene`, `k.camera`, `k.U` (shared uniforms), `k.rng(seed)`,
  `k.quality` (`shadow` map size, `mirror` scale, `particles` share).
- `k.std(p)`, `k.phys(p)`, `k.lambert(p)`, `k.basic(p)`: Three materials with the
  engine patch. Extra keys: `receiver`, `additive`, `defines`, and `patch`
  (`{ key, uniforms, vertexHead, fragmentHead, vertex: {chunk: code},
  fragment: {chunk: code}, fragmentBefore: {chunk: code} }` — code inserted after
  / before `#include <chunk>`; `key` names the code: Three shares one program
  between materials with the same key).
- `k.shader(p)`: a hand-written material; `p.fragment` / `p.vertex` are the body
  of `main()` with `vWorld`, `vUv`, `vNormalW`, the engine uniforms and helpers
  (`footprint()`, `pulse()`, `vnoise()`, `fbm2()`, `subjectMask()`, `engFog()`),
  or whole `vertexShader`/`fragmentShader` prefixed with `k.GLSL_VERTEX` /
  `k.GLSL_FRAGMENT`. Writes `gl_FragColor` (rgb radiance; alpha = receiver when
  opaque).
- `k.glow(color, intensity)`: an emitting surface that lights nothing (neon,
  LED strip, a lamp's shade).
- `k.fog({ density, falloff, base, max, color, sun, sunDir })`: exponential
  height fog on every engine material.
- `k.environment(equirectTexture, intensity)`: image-based light (PMREM).
- `k.shadowsChanged()`: the shadow map is drawn once and only again after this.
- `k.track(obj)`: free it on dispose.

### Rules (they are what the tests and the encoder check)

- **Deterministic.** `k.rng(seed)` only; everything that moves is a function of
  `t`. A keyed receiver rebuilds your scene from its id and must get the same
  world.
- **Nothing finer than the picture's pixel.** Patterns go through `footprint()`
  / `pulse()`; a repeat finer than ~2 output pixels becomes its average
  (windows, bricks, ripples, rows). The resolve adds up jittered redraws, so
  static detail sharpens; anything that differs between redraws reads as
  motion and costs every receiver bandwidth.
- **Calm behind the head.** Middle ~40% of the width, from 15% of the height
  down: low contrast, no vertical edges, no motion, no bright sources;
  `subjectMask()` follows the actual subject. Interest goes to the sides and the
  upper corners. Must also work cropped to 9:16 (centre) and mirrored.
- **Slow motion.** Mean change between frames 1 s apart < 3/255 (pinned);
  target ≤ 2% of pixels visibly changing per second.
- **Night is a picture**: mean luma > 25, < 25% crushed, at exposure 0.25.
- **Cheap to compile**: few distinct programs (≤ 8); share materials; one shadow
  map, cached (`k.shadowsChanged()` only when a light really moves).

### Traps found building the first scenes

- `material.envMapIntensity` is ignored once `scene.environment` is set: scale
  `scene.environmentIntensity` instead.
- One huge ground or sea quad misdraws on SwiftShader: use a grid whose cells
  grow with distance.
- Thin bright lines alias through a half-size mirror: draw their reflections
  as geometry.
- Facade windows filter by the buffer's pixel (`facadePatch()` default), which
  the encoder pays far less for than the picture's.

## Status

| scene | engine | vs old (VP9, moving / frozen) |
|---|---|---|
| penthouse (Neon rain) | Three.js | 721 / 556 kb/s vs 1156 / 690 |
| island | Three.js | 509 / 382 vs 1171 / 751 |
| mountain | Three.js | 167 / 217 vs 706 / 593 |
| countryside | Three.js | 343 / 292 vs 381 / 330 |
| office | Three.js | 248 / 216 vs 299 / 159 (frozen above old: detail, by choice) |
| cybercafe | old shader (behind the same interface) | — |

## Looking at a scene

```sh
node scripts/scene-preview.mjs penthouse --gpu --person          # 1280x720 + stand-in subject
node scripts/scene-preview.mjs penthouse --gpu --matrix --out scene-previews/new/matrix
node scripts/scene-compare.mjs scene-previews/baseline/matrix scene-previews/new/matrix
node scripts/scene-preview.mjs penthouse --gpu --bits --person   # encoder cost (VP9, fixed q)
node scripts/scene-preview.mjs penthouse --gpu --bits --still    # what a frozen room still costs
node scripts/scene-bench.mjs --gpu --label new-gpu               # init/redraw/leak numbers
```

`--gpu` uses the real GPU (`--use-angle=metal --enable-gpu`); without it the
browser is SwiftShader, which is what the tests run on.
