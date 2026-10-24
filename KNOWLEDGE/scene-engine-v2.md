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

## Decision (2026-10-23)

**Three.js r186, on the Processor's own context, hybrid** (agent A spike, measured):
Three draws geometry/PBR/shadows/IBL/instancing into a half-float target; our GLSL stays
for sky, clouds, water, facades, rain (as Three materials); our raw-GL output pass does
exposure/tint/ACES/sRGB/dither, alpha = receiver × nearness(depth), and mirroring as an
image flip (one render per redraw). See `docs/scene-engine.md`.

Work happens in worktree `../voxal-engine-wt`, branch `feat/scene-engine-v2-int`
(Playwright there: `--config=.pw-wt.config.js`, port 8091).

## Progress log

- 2026-10-23 — branch created; baseline renders taken; agents A–E launched
  (A architecture spike, B techniques, C art direction, D perf/tests, E visual validation).
- Reports in `scene-previews/reports/` (main checkout, gitignored). Baseline matrix:
  `scene-previews/baseline/matrix/`; baseline bench: `D-scene-bench-baseline-{gpu,swiftshader}.md`;
  legacy library copy: `scene-previews/baseline/video-scenes.legacy.js`.
- Renderer interface (`createRenderer`/`draw`/`dispose`) in the pipeline (`06f2b11`).
- Engine (`src/scenes/engine.js`), kit (`src/scenes/kit.js`), vendored Three
  (`src/assets/three/three.min.js`, `make three-vendor`), preview/bench/compare tooling,
  test harness `__renderScene` async. Smoke tests pass on Metal and SwiftShader.
- Flagship agent building `src/scenes/penthouse.js`.
- Draft PR #210 (`feat/scene-engine-v2` on origin = local `feat/scene-engine-v2-int`).
- Flagship penthouse (`7a7102d`), island (`81cf717`), mountain (`1e6f931`) on the engine;
  kit fixes from the flagship (`ebfcec8`). Scene agents hit the plan's quota twice:
  run them one at a time and resume with SendMessage, never restart.
- Countryside on the engine (fresh agent; the paused one could not be resumed after the
  quota stop). Val d'Orcia knoll at 18:00: 343/292 kb/s vs 381/330, GPU 1.3 ms,
  SwiftShader first frame 1.0-1.3 s (old 5.8 s), 5 programs, 229k tris. Weak: backlit
  casale/cypresses dark, pine crown low in portrait, distant wheat flat.
  Kit requests: shadow fade by footprint; `vertexHead` on `k.shader`.
- Office on the engine: Copenhagen studio at 10:30, per-pixel sun through the window,
  rectangle window light, baked room bounce. 248/216 kb/s vs 299/159 (frozen 1.36x old,
  accepted for the detail), GPU ~2 ms, SwiftShader first 1.5 s, 6 programs, 41k tris.
  Local 4-8x MSAA target (frozen 435 -> 216 kb/s): candidate for the engine. Smooth alpha
  by position (617 -> 515 kb/s): try on penthouse. Test fix: the camera-size resolve test
  compiles the module before `ensureScene()` and reads age/look before awaiting the ref.
- Cyber café on the engine: Lisbon half-basement under a brick vault, zinc bar, neon cup,
  arched window onto a climbing street, beige CRTs turned away, tram every 120 s.
  268/246 kb/s vs 696/569, M5 1.0 ms, SwiftShader first 1.0-1.1 s, 4 programs, 36k tris.
  MSAA off on software GPUs (sniffs the renderer: wants `k.quality.software`).
  All six scenes now on the engine. Video/scene specs: 582 passed, 2 failed (the two
  pre-existing keyed "slow-copy" tests).
- Bench old vs new (M5 + SwiftShader, warm and cold) in `docs/scene-engine.md`.
  Full unit suite: 1925 passed, 1 failed (keyed "slow-copy", fails the same on `7152b33`).
- Next: visual refinement of the weak points (see PR), real devices, mesh suite.
