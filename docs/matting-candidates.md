# Matting candidates: every other small model, measured

Question: apart from the engines already evaluated (MediaPipe, Longpipe,
RVM, P3M-Net, and BackgroundMattingV2 in PR #262), is there a specialised
person-segmentation or portrait-matting model that would cut the person out
better in Voxal's real pipeline? Licences were **not** a filter: a model with
a real gain is measured even if Voxal could not ship it as is.

**Short answer.** One candidate is worth taking further: **MODNet with its
webcam checkpoint** (Apache-2.0, 26 MB, 13 MB as fp16). It is the best engine
measured that needs no picture of the empty room:

* Mask error: 5.2, against RVM's 6.5 and Longpipe's 16.2.
* Edge band: 104, the cleanest of any live engine.
* Composite error: 0.70, about 10% better than Longpipe's 0.78.
* Cost: 32 ms on WebGPU, the same as RVM's.

It still trails RVM, which cannot ship (GPL-3.0), in two places: it leaves
more of the old room at the edge (4.8% against 0.9%) and it is less steady from
frame to frame. Nothing else tested beats it:

* PP-MattingV2 and SGHM are close behind.
* PP-HumanSeg and MediaPipe's multiclass model are no better than today's
  segmenters.
* RMBG-1.4 is unstable on video.
* BiRefNet is the best still-image matte measured, but at about 6 s a frame
  on the CPU it is not real time.
* MatAnyone2 is the steadiest from frame to frame, but its matte is no better
  than RVM's.

Everything is on the same bench as `docs/matting-evaluation.md`: 300 frames
with a known alpha, three rooms, 1280x720, through the real Processor, on an
Apple M5 with Chromium on WebGPU.

## What was tested

| Model | Kind | Licence | Size | Input | How it runs here |
|---|---|---|---|---|---|
| **MODNet**, photographic checkpoint ([ZHKKKe/MODNet](https://github.com/ZHKKKe/MODNet)) | trimap-free portrait matting | Apache-2.0 (code, models) | 26 MB (13 MB fp16) | 512 long side, /32 | `Xenova/modnet` ONNX, as published |
| **MODNet, webcam checkpoint** | the same network, trained for webcams | Apache-2.0 | 26 MB | 512 long side, /32 | exported from the official `.ckpt` (`scripts/lab-export-torch.py`) |
| **PP-HumanSegV2-Lite** ([PaddleSeg](https://github.com/PaddlePaddle/PaddleSeg)) | portrait segmentation | Apache-2.0 | 3.8 MB | 256x144 | converted with paddle2onnx (`scripts/lab-export-paddle.py`) |
| **PP-HumanSegV2-Mobile** | general human segmentation | Apache-2.0 | 30 MB | 192x192 | the same |
| **PP-MattingV2** (STDC1) | real-time human matting | Apache-2.0 | 36 MB | 512x512 | the same |
| **SGHM** ([cxgincsu/SemanticGuidedHumanMatting](https://github.com/cxgincsu/SemanticGuidedHumanMatting)) | segmentation + matting, ResNet-50 | MIT | 190 MB | 768 long side, /64 | exported with its 3-scale alpha fusion folded in |
| **MediaPipe selfie multiclass** | 6-class selfie segmentation (hair, skin, clothes) | Apache-2.0 | 16 MB | 256x256 | MediaPipe's own runtime; person = 1 − background |
| **RMBG-1.4** ([briaai](https://huggingface.co/briaai/RMBG-1.4)) | salient-object background removal | **BRIA, non-commercial** | 88 MB fp16 | 1024x1024 | briaai's ONNX |
| **BiRefNet lite** ([ZhengPeng7/BiRefNet](https://github.com/ZhengPeng7/BiRefNet)) | high-resolution dichotomous segmentation | MIT | 115 MB fp16 | 1024x1024 | **offline** (PyTorch, MPS): ONNX Runtime Web runs out of WASM memory on its 16k-node graph |
| **MatAnyone2** ([pq-yang/MatAnyone2](https://github.com/pq-yang/MatAnyone2)) | memory-based video matting | **NTU S-Lab, non-commercial** | 141 MB | footage size | **offline** (PyTorch, MPS), first-frame mask from MODNet |

Not tested:

* **Mirage** (Cactus): a multi-task scene model with coarse instance masks, not
  a matting model. See the earlier answer.
* **ViTMatte**: needs a trimap. It could only refine another engine's mask.
* **RMBG-2.0**: BiRefNet's network with non-commercial weights. BiRefNet lite
  stands in for it.
* **MediaPipe HairSegmenter**: hair only. The multiclass model already has a
  hair class, and it did not help.

## Results

Quality: lower is better. The three rooms are wall / living / kitchen.

* **mask**: |matte − truth| ×1000.
* **comp**: |composite − true composite| on 0–255.
* **edge band**: the mask error in an 8 px band round the silhouette.
* **dtSSD**: frame-to-frame error, which counts flicker and lag.
* **leak**: % of the old room left in the composite's edge band.

| Engine | Licence | mask | avg | comp | avg | edge band | dtSSD | leak % |
|---|---|---|---|---|---|---|---|---|
| MediaPipe (fallback) | Apache-2.0 | 8.5 / 14.1 / 18.2 | 13.6 | 1.16 / 1.47 / 1.51 | 1.38 | 211 | 2.38 | 12.1 |
| Longpipe (default) | MIT | 14.7 / 17.2 / 16.7 | 16.2 | 0.62 / 0.89 / 0.83 | 0.78 | 188 | 1.97 | 5.3 |
| RVM | **GPL-3.0** | 5.7 / 6.9 / 6.9 | 6.5 | 0.51 / 0.68 / 0.60 | **0.60** | 135 | **1.46** | **0.9** |
| P3M-Net | MIT | 4.7 / 8.6 / 16.9 | 10.1 | 0.63 / 0.91 / 1.42 | 0.99 | 150 | 3.23 | 4.4 |
| BackgroundMattingV2 (PR #262, needs the empty-room picture) | MIT | 5.0 / 5.3 / 4.7 | 5.0 | 0.59 / 0.66 / 0.59 | 0.61 | 91–115 | – | – |
| **MODNet webcam** | Apache-2.0 | 3.6 / 5.0 / 6.9 | **5.2** | 0.53 / 0.68 / 0.89 | 0.70 | **104** | 1.92 | 4.8 |
| MODNet photographic | Apache-2.0 | 3.7 / 6.0 / 7.8 | 5.8 | 0.53 / 0.75 / 0.94 | 0.74 | 110 | 2.16 | 4.7 |
| MODNet photographic fp16 (13 MB) | Apache-2.0 | 3.7 / 6.0 / 7.8 | 5.8 | 0.53 / 0.75 / 0.94 | 0.74 | 110 | 2.17 | 4.7 |
| MODNet webcam at 384 px | Apache-2.0 | 3.4 / 5.6 / 12.8 | 7.3 | 0.56 / 0.75 / 1.52 | 0.95 | 116 | 2.17 | 6.3 |
| MODNet webcam, dilate 1 | Apache-2.0 | 3.6 / 5.0 / 6.9 | 5.2 | 0.68 / 0.89 / 1.06 | 0.88 | 104 | 1.92 | 13.8 |
| PP-MattingV2 | Apache-2.0 | 4.0 / 7.2 / 7.9 | 6.4 | 0.53 / 0.79 / 0.97 | 0.76 | 109 | 2.48 | 4.3 |
| SGHM (768) | MIT | 4.9 / 7.5 / 9.9 | 7.4 | 0.53 / 0.79 / 0.93 | 0.75 | 127 | 2.19 | 4.4 |
| SGHM (1024) | MIT | 4.5 / 7.3 / 8.0 | 6.6 | 0.51 / 0.76 / 0.87 | 0.71 | 120 | 1.97 | 3.0 |
| PP-HumanSegV2-Lite | Apache-2.0 | 11.2 / 16.1 / 16.7 | 14.7 | 0.95 / 1.33 / 1.29 | 1.19 | 248 | 2.33 | 9.5 |
| PP-HumanSegV2-Mobile | Apache-2.0 | 10.4 / 16.4 / 19.6 | 15.5 | 1.12 / 1.43 / 1.32 | 1.29 | 235 | 2.33 | 12.6 |
| MediaPipe multiclass | Apache-2.0 | 185 / 99 / 79 | 121 | 5.09 / 2.66 / 1.08 | 2.95 | 183 | 2.97 | −3.7 |
| RMBG-1.4 | non-commercial | 4.4 / 63.4 / 15.8 | 27.9 | 0.53 / 5.80 / 1.36 | 2.57 | 168 | 4.51 | 4.1 |
| BiRefNet lite (offline, 1024²) | MIT | 3.1 / 4.6 / 4.1 | **3.9** | 0.50 / 0.71 / 0.58 | **0.60** | **95** | 2.08 | 6.5 |
| MatAnyone2 (offline) | non-commercial | 3.3 / 6.4 / 9.4 | 6.4 | 0.51 / 0.75 / 0.98 | 0.75 | 117 | 1.65 | 5.6 |

The table rests on four measurements of the Processor's own loop, with the
camera fed at 30 fps, at 1280x720:

| Engine | out fps | matte Hz | inference ms p50 / p95 | main-thread `runSegment` ms p50 | matte age ms p50 / p95 |
|---|---|---|---|---|---|
| MediaPipe | 29.7 | 24 | – | 10.5 | 9 / 33 |
| Longpipe | 29.8 | 15 | 6.9 (its model) | 8.2 | 1 / 27 |
| RVM | 29.8 | 15 | 32.3 / 35.1 | 3.4 | 80 / 103 |
| P3M-Net | 30.0 | 14 | 48.2 / 53.4 | 3.1 | 93 / 152 |
| **MODNet webcam** | 29.9 | 15 | 31.6 / 33.9 | 7.2 | 78 / 100 |
| MODNet fp16 | 29.7 | 15 | 28.7 / 31.4 | 7.0 | 80 / 98 |
| MODNet webcam at 384 | 29.9 | 15 | 22.4 / 25.2 | 7.1 | 79 / 98 |
| PP-MattingV2 | 30.0 | 16 | 35.5 / 38.4 | 5.5 | 73 / 103 |
| SGHM (768) | 29.8 | **5** | 164.9 / 179.7 | 0.4 | 264 / 367 |
| PP-HumanSegV2-Lite | 30.1 | 15 | 11.6 / 15.4 | 3.5 | 81 / 100 |
| MediaPipe multiclass | **26.5** | 15 | 33.0 / 46.2 | **33.3** | 100 / 135 |

## Reading it

* **MODNet webcam** is the one shippable gain:
  * Its mask is as good as BackgroundMattingV2's, without a picture of the
    empty room.
  * Its edge band is the cleanest of any live engine.
  * It costs what RVM costs, and its 26 MB stores as 13 MB in half floats.
    The photographic fp16 export gave identical scores.
  * What it lacks against RVM is RVM's recurrence. It flickers more (dtSSD
    1.92 against 1.46), though less than Longpipe. Its soft edge carries
    more of the old room (leak 4.8% against 0.9%), and that is why its
    composite error (0.70) trails RVM's (0.60) despite a better mask.
  * Both gaps are pipeline-shaped, not model-shaped:
    * Foreground-colour estimation in the edge band, which
      BackgroundMattingV2 gets from its own output, attacks the leak.
    * MODNet's own one-frame-delay trick, or a temporal blend tuned for it,
      attacks the flicker.
  * Keep its edge undilated: dilate 1 raised the leak from 4.8% to 13.8%.
  * Keep 512 px: 384 px saves 9 ms but almost doubles the kitchen's error.
* **PP-MattingV2 and SGHM** land just behind MODNet on every metric:
  * PP-MattingV2 converts exactly only at 512x512, because of its adaptive
    pools.
  * SGHM is 190 MB and runs at 5 Hz.
  * Neither adds anything MODNet does not.
* **PP-HumanSegV2** (Lite and Mobile) are segmenters in MediaPipe's class.
  They beat MediaPipe slightly and lose to Longpipe clearly, so they offer no
  path to an upgrade.
* **MediaPipe multiclass** is a regression:
  * Its "background" confidence is never near 1, so 1 − background leaves an
    ~8–18% veil over the whole room.
  * MediaPipe's cut then punches holes in the person.
  * It costs 33 ms of main thread, so the camera drops to 26.5 fps.
* **RMBG-1.4** is a salient-object model. On some frames it picks the sofa
  or the lamp, not the person (living-room mask error 63), so it is
  unusable for video whatever its licence.
* **BiRefNet lite** is the best single-frame matte measured:
  * Mask error 3.9 and composite error 0.60, the same as RVM.
  * At 1024x1024 it is about 6 s a frame on the CPU and runs out of memory
    in ONNX Runtime Web. Its deformable convolutions do not re-export at a
    smaller size on current PyTorch.
  * It marks the ceiling for a still-image model, not a candidate. It also
    leaks more (12% in the living room).
* **MatAnyone2** is the steadiest (dtSSD 1.65), as a memory-based video
  model should be, but:
  * Its matte is no better than RVM's, and is worse in the kitchen.
  * It is non-commercial.
  * It runs at about 4 frames a second at 720p in PyTorch on the M5's GPU,
    with no browser runtime.
  * Not worth porting.

## How to reproduce

```sh
make lab-assets                                   # download + convert every candidate into src/assets/lab (uv needed)
make matting-bench ARGS="--engines lab:modnet-webcam,lab:ppmatting-v2 --rooms wall,living,kitchen --res 1280x720"
make matting-bench ARGS="--realtime --engines lab:modnet-webcam --res 1280x720"
# offline models: precompute the mattes, then score them through the pipeline
.cache/lab/torch/bin/python scripts/matting-offline.py birefnet-lite   # needs transformers, timm, kornia, einops in that venv
make matting-bench ARGS="--engines pre:birefnet-lite --rooms wall,living,kitchen --res 1280x720"
```

* The bench's engine names:
  * `lab:<model>[@<long side>][~<dilate>][!wasm]` runs a candidate live, for
    example `lab:sghm@1024`.
  * `pre:<name>` scores precomputed mattes from `footage/pre/<name>/`.
* In the app: Settings → Advanced → Segmentation debug → *Engine: matting
  lab*. Pick the model under *Matting lab model*, or open the app with
  `?segengine=lab&labmodel=modnet-webcam`. It needs `make lab-assets`.
  Nothing in `src/assets/lab` is ever deployed or bundled.

## What was built

* **`src/lab-engine.js`**: one generic engine for every candidate. A
  registry entry describes a model:
  * the input size rule: the frame's aspect on a grid, or a fixed size;
  * the normalisation;
  * the output: an alpha, a logit, a softmax channel or a min–max map;
  * whether it is a matte (no cut, no dilate, like P3M-Net) or a
    segmentation (MediaPipe's cut and edge).

  It feeds half floats to a float16 graph. A MediaPipe `.tflite` runs through
  MediaPipe's own runtime. It has the same adapter shape as `p3m-engine.js`,
  so the Processor, the fallback to MediaPipe and the debug panel treat it
  like the others. It is kept out of the *Compare engines* view: one engine
  standing for many models would make that view's labels meaningless.
* **`scripts/lab-assets.sh`** (`make lab-assets`) downloads or converts every
  candidate:
  * `scripts/lab-export-torch.py` handles MODNet webcam and SGHM, each
    checked against its PyTorch module (max |Δ| 1e-5 and 1e-7).
  * `scripts/lab-export-paddle.py` handles PaddleSeg. It pins the input,
    infers shapes and converts, then checks the result against Paddle's own
    predictor.
* **`scripts/matting-offline.py`** + the bench's `pre:` engine score a model
  that cannot run in a browser through the same pipeline, so a quality
  ceiling is measured on the same terms.
* **`tests/e2e/unit-lab-engine.spec.js`**: sizing, normalisation, half
  floats, the four output decodings, engine choice and fallback, matte versus
  segmentation in the real Processor, a model swap under a running camera.

## Next, if MODNet is pursued

1. **Real webcams**: glasses, dark hair against a dark room, hands over the
   face, backlight. None of these are in the footage. Compare it against
   Longpipe live by switching engines.
2. **Publish an fp16 webcam export** (13 MB) as a prerelease asset, as for
   P3M-Net, so previews can carry it. Apache-2.0 allows shipping it.
3. **Move pre- and post-processing to the GPU**: it is 7 ms of main thread
   now, against RVM's 3.4.
4. **Foreground colour in the edge band**, for the leak.
5. **Temporal smoothing tuned for an image model**, for the flicker.
6. **Phones**: nothing here was measured off an M5.
