# Scene engine v2 — project brief and progress log

Shared brief for every agent working on the virtual-background rebuild. Keep it
short; put detail in reports, not here.

## Goal

Rebuild every animated virtual background (`src/video-scenes.js`) as an
art-directed, stable, performant real-time 3D environment on a shared rendering
platform, without breaking the camera pipeline (`src/video-effects.js`).

- Branch `feat/scene-engine-v2`, cut from `feat/neon-rain-penthouse` @ `e668f70`
  (= `feat/mobile-bar-orbit-preview` + Neon Rain). Old renderer stays until the
  new one is validated. Do not merge, push or deploy.
- Working files that must not be committed go under `scene-previews/` (gitignored):
  `scene-previews/baseline/` (old-engine renders), `scene-previews/reports/` (agent
  reports), `scene-previews/spike/` (throwaway experiments).

## Scene catalogue (ids are public: stored in `video-background` = `preset:<id>`, sent in keyed offers)

| id | label | shadow | wrap | res | hz | bloom |
|---|---|---|---|---|---|---|
| office | Office | 0.55 | 0.22 | 0.85 | [12,6] | – |
| island | Island | 0.30 | 0.36 | 0.80 | [10,5] | – |
| cybercafe | Cyber café | 0.45 | 0.42 | 1.0 | [15,8] | – |
| mountain | Mountain | 0 | 0.28 | 0.70 | [10,5] | – |
| countryside | Countryside | 0 | 0.28 | 0.80 | [10,5] | – |
| penthouse | Neon rain | 0.40 | 0.40 | 1.0 | [12,6] | 0.45 |

`LEGACY` maps old image ids (aurora/dusk/studio/linen) to scenes — keep it.

## The contract between a scene and the pipeline (today)

`VideoScenes` (classic script, one global, loaded by `index.html` AND `settings.html`
before `video-effects.js`):

- `compileProgramAsync(gl, id)` → `{program, loc, id}`; `compileProgram` (sync).
- `setUniforms(gl, prog, w, h, time, look, frame, view)`; caller binds the target FBO
  (`fbScene`, RGBA8, `sceneW×sceneH` = `SCENE_LONG(512 desktop / 384 phone) × scale × res`)
  and draws a full-screen triangle (`Processor.drawQuad`).
- Inputs: `time` (s, starts at `THUMB_TIME`=37), `look` {sideMix 0..1 (1 = key light on
  +x/right), dirX, dirY, motion, tint[3], exposure, cx, cy, sx, sy (subject centre/size,
  y down)}, `frame` {jitter:[x,y] px, detail: output height px} or null, `view`
  {yaw,pitch,roll} rad (phone tilt / mouse orbit) or null.
- Output RGBA8: rgb = display-referred sRGB (scene does exposure × tint, ACES, sRGB,
  dither itself); **a = nearness / shadow-receiver weight** (walls ~0.95, sand ~0.55,
  sky/far 0) — the composite darkens `rgb * (1 - a*shade)` with the subject's soft shadow.
- After drawing, the pipeline `generateMipmap`s `texScene` (light wrap reads mip 3,
  bloom reads coarse mips), then `resolveScene()` accumulates the jittered redraw into a
  camera-size history (TAA-style, `RESOLVE_FRAG`, Halton 256) — static detail converges,
  motion falls back to the soft redraw.
- Mirroring: scenes are authored with the key light on +x; `shade(p, m)` draws
  `scene(vec2(p.x*m, p.y))` with the subject x mirrored too; during a side change both
  are drawn and crossfaded by `uSideMix`. View turns are applied in screen space and
  un-mirrored (`MIR`). Scenes carry no text/clock (they are mirrored).
- `NIGHT = sstep(0.62, 0.28, exposure)`: a dark room turns the scene to evening (lamps on,
  sun down, city lit).
- Same scene is drawn by **keyed receivers** (`KeyInProcessor`, own GL context) from
  `{scene id, look, view}` in the sender's offer → rendering must be deterministic from
  (id, time, look, view, size).
- Thumbnails: one OffscreenCanvas WebGL2 context, 160×90, `THUMB_TIME`, skipped on
  software GL (`isSoftwareGL`). `renderScenePreview()` in video-effects.js = standalone
  orbit preview in Settings.

## Hard constraints

- No bundler, no module system for app code: classic scripts sharing one global scope.
  Dynamic `import()` from a classic script works (MediaPipe already does it). Every
  third-party file is vendored under `src/assets/` (never a CDN). Licence must allow
  commercial use (MIT/BSD/Apache/CC0). Three.js 0.186.1 (MIT) is installable via npm.
- One WebGL2 context per Processor, created `{alpha:false, antialias:false, depth:false,
  stencil:false, preserveDrawingBuffer:false}`. The Processor sets state ONCE
  (`BLEND` off, `DEPTH_TEST` off, `UNPACK_ALIGNMENT 1`) and assumes it persists; it uses
  units 0–9 (noise table on unit 8). Anything else drawing in that context must restore
  state. Release contexts with `WEBGL_lose_context` (Chromium kills the oldest past 16).
- Motion is bitrate for every receiver: scene redraw 5–20 Hz, slow small motion; test
  pins mean change between frames 1 s apart < 3/255; sub-pixel patterns = churn (lit
  windows cost 1.7 Mb/s frozen until filtered to footprint). Measure with
  `node scripts/scene-preview.mjs --bits --still` / `--bits --person`.
- Night scenes must still be a picture: mean luma > 25, crushed < 25%.
- GLSL ES 3.00 lives in JS template literals: no backticks in shader comments; reserved
  words `patch cast half sample input output filter`; no `pow(neg,…)`; no `smoothstep`
  with edge0 ≥ edge1 (real drivers NaN).
- Tests run on SwiftShader (software GL): scene shader compile ~1.4–12 s per scene today
  and freezes the page; keep compile cost down.
- After any `src/` change: `make cap-sync` (outputs are untracked). ESLint globals list in
  `eslint.config.js` must name any new cross-file global.

## Tools

- `node scripts/scene-preview.mjs [ids] [--person] [--size WxH] [--look JSON] [--view JSON]
  [--time s] [--alpha] [--live] [--raw] [--bits [--still]] [--out dir]` → PNG per scene +
  sheet.png. Default Chromium = SwiftShader.
- **Real GPU is available**: Playwright Chromium with
  `args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']` (headless)
  reports `ANGLE Metal Renderer: Apple M5`. Default flags give SwiftShader.
- Tests: `npx playwright test --project=unit tests/e2e/unit-video-scenes.spec.js`
  (scene specs can time out under parallel workers; run with `--workers=1` when judging).
- Known pre-existing failures (from learning.md): `unit-video-keyed.spec.js` "a green
  subject withholds keying…" (slow-copy on this GPU); scenes spec afterEach timeouts
  under 3 workers.

## Baseline (old engine, SwiftShader, 960×540 preview, --person)

| scene | buffer | first redraw (≈compile) | timed redraw+resolve |
|---|---|---|---|
| office | 435×245 | 4.2 s | 78 ms |
| island | 410×230 | 6.1 s | 68 ms |
| cybercafe | 512×288 | 1.4 s | 36 ms |
| mountain | 358×202 | 12.5 s | 83 ms |
| countryside | 410×230 | 6.7 s | 76 ms |
| penthouse | 512×288 | 3.3 s | 65 ms |

Renders: `scene-previews/baseline/landscape/`.

## Progress log

- 2026-10-23 — branch created; baseline renders taken; agents A–E launched
  (A architecture spike, B techniques, C art direction, D perf/tests, E visual validation).
