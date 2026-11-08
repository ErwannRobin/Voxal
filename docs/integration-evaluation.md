# Integration bench: real footage, judged blind

Question: when a change touches how the person sits in an animated scene
(the light on you, your shadow, grain, edge colour, the measured light), does
it look **better** to a person, on **real** footage?

Before this bench, nothing could say. The matting bench
(`docs/matting-evaluation.md`) scores the edge against a known alpha, but
everything after the edge (`sceneLight()`, the cast and contact shadows, the
scene's grain, the look measurement) was tuned on synthetic subjects
(`unit-video-scenes.spec.js`) and marked "untuned" throughout
`docs/video-effects.md`. This bench closes that gap in two halves:

1. **A blind paired comparison.** Same clip, same scene, two variants side by
   side, sides randomised, names hidden. A judge picks the one where the
   person looks more *there*. Several judges' exports are tallied with a
   confidence interval.
2. **Measurements without ground truth.** What can be measured on a real
   clip without knowing the right answer: how far the scene's look is from the
   look of the room this camera filmed, edge flicker, and what the pipeline
   measured about the light.

## Running it

```sh
make integration-footage                    # fetch the clips (once; ~1 min, ~250 MB of JPEG frames)
make integration-bench                      # every clip, office + cybercafe, shipped vs plain
make integration-bench ARGS='--clips glasses,"low light" --scenes office,island --variants shipped,no-shadow'
make integration-bench ARGS='--engine mediapipe --frames 60 --label quick'
node scripts/integration-bench.mjs --tally judgements-run-alice.json
```

Each run writes `bench-results/integration/<label>-<date>/` (gitignored):

| File | What |
|---|---|
| `judge.html` | The blind A/B page. Open it from disk. Keys `1`/`←` left, `2`/`→` right, `0`/`↓` no difference, space pauses, backspace undoes. Judgements are kept in the browser (`localStorage`) and exported as JSON |
| `videos/<clip>__<scene>__<variant>.mp4` | Each composite, H.264, at the clip's frame rate |
| `stills/…jpg` | Camera \| composite, the middle frame |
| `report.md`, `results.json` | The measurements below, per run and per variant |

Judge with at least two people. Only trust a win rate whose 95% interval
excludes 50%. The page and `--tally` print the interval.

## The clips

`tests/bench/integration/clips.csv` is the list. Columns `id`, `use`, `start`,
`seconds`, `note` are the bench's; `situation`, `description`, `interest`,
`link` are the original reference list. 21 Pexels clips (Pexels License: free
to use and modify; the files are fetched, never committed). One Pond5 clip is
listed with `use = no`: its public file is a watermarked preview of paid stock.

`--clips` takes ids or words from the situation column (`glasses`, `low light`,
`waving`, `headset`, …). To add a clip, add a row. `start` / `seconds` pick the
stretch. A landscape source becomes 1280x720 (a desktop camera), an upright one
720x1280 (a phone held upright), scaled to cover and centre-cropped.

**This is stock footage, not webcam footage.** It is graded, sharper and far
less noisy than a laptop camera, and in places shot handheld. The judgement
half does not care. The camera-look half does: `noise ×` against these clips
is not what it would be against a webcam. Add your own webcam recordings as
rows (any URL ffmpeg can read, or replace `download` for a local file) before
tuning grain on them.

## How it runs

`scripts/integration-bench.mjs` serves `src/` with the app's isolation headers
and drives `tests/bench/integration/harness.html`, which loads the app's own
scripts in `index.html`'s order and calls `VideoEffects.wrap(stream,
'preset:<scene>')`. Everything after that is the shipped Processor:
- the engine (Longpipe by default, `--engine mediapipe|rvm|p3m`)
- the mask blend
- the soft mask
- the look
- the scene's jittered redraws
- the composite

The harness only replaces the camera with a canvas it paints each clip frame
on, and steps the Processor itself.

**The clock is virtual.** Each step is one camera frame of pipeline time at the
clip's own rate. So the scene's animation, the look's 1.4 s easing and the
segmentation cadence (`--cadence app`, the app's own `segInterval`; `every`
segments every frame) behave as in a call, however long a step takes. Not
reproduced:
- **inference latency:** the mask belongs to the frame it was computed on, or to the last one segmented.
- **the load governor:** nothing steps down.

`--warm` (30) frames on the first frame let the look, the scene's history and
the mask blend settle before recording.

## Variants

Window flags the composite reads (`video-effects.js`) or preferences:

| Variant | What changes |
|---|---|
| `shipped` | Nothing |
| `plain` | No light on you, no shadow, no grain: a cut-out over the scene. The sanity baseline: if judges do not prefer `shipped`, the integration terms are not earning their place |
| `no-wrap` / `wrap-x2` | `__voxalWrapScale` 0 / 2: everything `sceneLight()` adds (rim, harmonisation, lit side, bloom) |
| `no-shadow` / `shadow-x2` | `__voxalShadowScale` 0 / 2: cast and contact shadow |
| `no-film` | `__voxalSceneFilmOff`: the scene's grain and vignette |
| `no-decon` | `__voxalDecon` 0: edge-colour decontamination |
| `no-edge-motion` | `__voxalNoEdgeMotion`: the softer edge while you move |
| `no-hair` | `__voxalNoHairRefine` |
| `light-midday` / `light-evening` | `scene-light` fixed instead of matched to your room |

`__voxalWrapScale` and `__voxalShadowScale` exist for this bench and multiply
`uWrap` and `uShadow` in the sender's composite only. To try a new term, add a
flag the composite reads and a row in `VARIANTS`.

## Measurements (no ground truth)

All of them are measured on the **background region**: cells of 8x8 px at
least 3 cells from any pixel the mask calls person. The composite's
background (the scene, as sent) is compared with the same region of the
camera frame (the room this camera filmed).

| Column | Meaning | Content-independent? |
|---|---|---|
| `Δ black`, `Δ white` | 2nd / 98th percentile of luma, scene − room, 8-bit levels | Mostly: a camera's black level and highlight roll-off are its own |
| `Δ mid` | Median luma, scene − room | No: a dark scene is not wrong |
| `sat ×` | Mean chroma, scene ÷ room | Partly |
| `noise ×` | Mean \|Laplacian\| in the flattest 20% of 8x8 blocks, scene ÷ room | Mostly (but see *stock footage* above) |
| `sharp ×` | 90th percentile gradient, scene ÷ room | Partly |
| `Δ bg vs you` | (scene − you) − (room − you), median luma: whether the scene is brighter or darker against you than your room was | Partly |
| `edge flicker` | Mean \|Δ composite\| at your edge where the camera held still, minus `scene churn` (the same away from you: grain, animation) | Yes |

Also, per clip, the look the pipeline measured (`exposure`, `side`, `dirX`,
`hard`, `motion`, `tint`). It is the input every integration term is driven
by, so a wrong one here explains a wrong picture.

**None of these says a picture is right.** They are the quantities item 2
of the integration plan (*match the camera, not only the light*) would act on,
and a way to see that a change moved what it meant to move.

## First observations (2026-11-08, Apple M5, Longpipe and MediaPipe)

- In `shipped`, the cast and contact shadows read as a **grey cloud over dark
  hair** on a bright wall: the shadow darkens the scene behind the head, and
  the soft edge lets that darkened band through as a smudge around the hair
  (pexels-8135465, office). `plain` shows the old room's light halo there
  instead. `no-shadow` vs `shipped` is the first comparison to judge.
- The stock clips' flat areas are 4–20x quieter than the scene's grain
  (`noise ×`), consistent with graded, denoised footage. This is not a webcam
  measurement.
- Seated subjects lose the desk in front of them (pexels-8136211): the
  foreground the person rests on is cut away with the room. A scene foreground
  layer (item 3 of the plan) is what would give them something to sit at.

## Key files

| File | Role |
|---|---|
| `tests/bench/integration/clips.csv` | The clip list |
| `scripts/integration-footage.mjs` | Fetches and cuts the clips into frames |
| `scripts/integration-bench.mjs` | Runner, variants, report, judging page, `--tally` |
| `scripts/integration-lib.mjs` | CSV, clip selection, Wilson interval, seeded schedule |
| `tests/bench/integration/harness.html` | The page: steps the Processor, measures |
| `tests/bench/integration/judge.html` | Template of the judging page |
