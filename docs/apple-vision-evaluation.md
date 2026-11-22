# Apple Vision for the cut-out: measured

Question: on the Mac app, could Apple's Vision framework cut the person out
better than the engines Voxal uses today (Longpipe by default, MediaPipe as the
fallback)? It had never been measured.

**Short answer.** One Vision request is worth taking further:
**`VNGenerateForegroundInstanceMaskRequest`** (macOS 14+). On the matting bench
it has the lowest composite error of every engine measured that runs without
the empty-room picture, at 12 ms per frame on a 512 px input. The three
`VNGeneratePersonSegmentationRequest` quality levels are **not** worth it: they
are no better than Longpipe and drop whole regions of the person in two of the
three rooms.

Nothing is wired into the app. This is the offline measurement that decides
whether the IPC bridge (below) is worth building.

## Method

Same bench as `docs/matting-evaluation.md` and `docs/matting-candidates.md`:
300 frames per room with a known alpha, three rooms, 1280x720, through the real
Processor into the same background with the same settings, on this Mac with
Chromium on the real GPU.

Vision cannot run inside the browser, so it goes through the bench's offline
path (`pre:<name>`, like BiRefNet): `scripts/apple-vision-offline.swift` runs
every frame and writes the alpha to `footage/pre/<name>/<room>/NNNN.png`.

```sh
swiftc -O scripts/apple-vision-offline.swift -o bench-results/apple-vision-offline
bench-results/apple-vision-offline foreground            # full 1280x720 input
bench-results/apple-vision-offline foreground --width 512 # what the app would send over IPC
node scripts/matting-bench.mjs --engines pre:apple-foreground,pre:apple-foreground-512 --res 1280x720
```

Variants: `person-accurate` / `person-balanced` / `person-fast`
(`VNGeneratePersonSegmentationRequest`, one `VNSequenceRequestHandler` per room
so Vision sees video) and `foreground`
(`VNGenerateForegroundInstanceMaskRequest`, one image handler per frame, every
instance merged). `--width 512` downscales the input first. A `-512` suffix
names those runs. Full-frame input flatters Vision, since the app would send a
downscaled copy.

## Results

Means over the three rooms (wall, living, kitchen). Lower is better in every
column. "Cost" is the model call alone (Vision: the CLI's own timer; MODNet: its
WebGPU time from `docs/matting-candidates.md`), without decode or IPC.

| Engine | Composite error | Mask error | Old room left at the edge | Frame-to-frame (`dtSSD`) | Cost |
|---|---|---|---|---|---|
| **Vision foreground, full frame** | **0.63** | **4.2** | 7.4% | 2.08 | 18 ms |
| **Vision foreground, 512 px input** | 0.66 | 4.4 | 5.9% | 2.11 | **12 ms** |
| MODNet (webcam) | 0.74 | 5.8 | 4.7% | 2.16 | 32 ms |
| Longpipe (today's default) | 0.80 | 16.4 | 5.5% | 2.02 | not measured |
| Vision person, accurate, 512 px | 0.89 | 11.7 | 8.6% | 4.02 | 34 ms |
| Vision person, balanced, 512 px | 0.93 | 13.7 | 7.4% | 3.52 | 8 ms |
| Vision person, fast | 0.94 | 8.8 | 5.2% | 4.70 | 7 ms |
| Vision person, accurate, full frame | 0.98 | 12.6 | 9.3% | 3.87 | 39 ms |
| Vision person, balanced, full frame | 1.02 | 14.5 | 7.8% | 3.29 | 13 ms |
| MediaPipe | 1.38 | 13.6 | 12.2% | 2.38 | not measured |

(MODNet here is 0.74; `docs/matting-candidates.md` has 0.70 from another run of
the same bench. Compare within this table.)

What the table says:

* **Foreground-instance mask: ~15% better composite error than MODNet and ~20%
  better than Longpipe**, with the steadiest matte of the contenders bar
  Longpipe. Its mask error (4.2) is the best of any engine here that can run live, and it is as good at a 512 px input as at full
  size, which is what the app would send.
* **The person-segmentation request is the wrong one.** Its `living` and
  `kitchen` rooms show `hole` 7-11 and `drop` 3-4, against the foreground mask's
  0.1-0.9 and 0.03-0.3: it loses regions of the person for stretches, and it
  flickers twice as much (`dtSSD` 3.3-4.7 against ~2.1). `accurate` buys little
  over `balanced` for four times the cost.
* **The one weak spot is `living`'s edge:** 12.2% of the old room left at the
  edge at full-frame input (9.2% at 512 px), the worst of the foreground runs
  and worse than MODNet's 5.3% in that room. It is the same fault MODNet shows
  against RVM, not new.

## What it would take

* The camera pipeline lives in the webview (`getUserMedia` into WebGL), so
  Vision cannot see the frames. The workable bridge: the webview sends a
  downscaled frame (~512x288) to Rust over Tauri IPC with raw bytes, a
  macOS-only Swift (or `objc2-vision`) call runs the request, and the mask
  comes back as bytes into the existing downstream stages (feather, dilate,
  blend, scenes, light). The pipeline already tolerates a mask that lags by one
  inference interval.
* Guard it with `window.__TAURI__` and macOS 14+, with Longpipe as the
  automatic fallback. The app has one Rust command today; this adds a second
  and a capability.
* A native `AVCaptureSession` beside the webview's is not an option: a second
  camera client, frame sync, and the wrong device when the user picked another.
* It must be set up like a matte engine (`maskCut: 0`, no dilate, half the
  feather), exactly as the `pre:` engines are in the bench.

## In the app (experimental)

The `vision` segmentation engine (`src/vision-engine.js`) runs this live in the
Mac app. It is opt-in, like P3M-Net: Settings → Advanced → *Segmentation
engine* → *Apple Vision*, or `localStorage['segmentation-engine'] = 'vision'`,
or `?segengine=vision`. It is offered only in the Tauri app on a Mac
(`VisionEngine.available()`), and never on the web or on mobile.

* Each inference draws the current frame at `vision-size` on the long side
  (default 512, the size that scored 0.66 above; 256 / 384 / 640 in the same
  settings card), sends the raw RGBA to `vision_foreground_mask`, and hands
  the returned mask to the Processor. It runs at the pipeline's usual inference
  rate (`detection-quality`) with one request in flight, so the mask trails the
  picture by one round trip, as P3M-Net's does.
* The mask is set up as the bench ran it (`maskCut: 0`, no dilate, half the
  feather, the usual 0.6 blend). `vision-dilate` (Advanced) overrides the
  dilate.
* `create()` sends a 64x36 probe frame first. That proves the command exists
  and that this macOS has the request, and it absorbs Vision's ~1.7 s model
  load. Any error there (not a Mac, macOS 13), or five failed frames in a row
  later, puts the camera back on MediaPipe, and the diagnostic shows why.
* The Rust side answers the **scaled** mask
  (`generateScaledMaskForImageForInstances`) at the input's own size, not the
  prototype's analysis mask. That one is a fixed 512x512 square whatever the
  frame's shape, and it is not what the bench measured. At 512x288 the scaled
  mask is also the smaller answer (147 KB against 262 KB). Each frame runs in
  its own autorelease pool, because a Tokio blocking thread has none and every
  request autoreleases its results.
* The segmentation diagnostic reports the round trip, the Vision call alone,
  the IPC share and the mask rate. The *Engines* tab (`?segdiag=compare`) puts
  Vision beside the others on the same camera.

Not yet measured: the live round trip at 512x288 with the window in front, the
CPU cost of a whole call, and how the mask behaves on a live camera (see below).

## IPC prototype (partial)

`src-tauri/src/vision.rs` + the `vision_foreground_mask` command, and a probe
(`src/vision-bench.js`, inert unless the app starts with
`VOXAL_VISION_BENCH=<path to a JPEG frame>`), measure the real round trip in
`make dev`: webview frame (`drawImage` + `getImageData`) -> raw bytes over Tauri
IPC -> Vision (`objc2-vision`) -> raw mask bytes -> webview. These numbers were
taken with the analysis mask, before the engine switched to the scaled one.

Back to back, 256x144 RGBA input (147 KB), ms, over 150 frames, three runs:

| | mean |
|---|---|
| Capture (`drawImage` + `getImageData`) | 1.1-1.3 |
| Vision (`performRequests` + mask) | 16.4-17.6 |
| IPC both ways + copies | 5-10 (p95 5 in one run, 58-104 in the others) |
| **Total** | **27-30** |

* **Vision's analysis mask is always 512x512 (262 KB)**, whatever the input:
  its analysis resolution is fixed, so a smaller input only shrinks the IPC
  upload, not the model work. (The engine now asks for the scaled mask at the
  input's size instead; see *In the app*.) The request needs a CVPixelBuffer, and macOS
  refuses `32RGBA` (`CVPixelBufferCreate` -6680), so the Rust side swaps R/B
  into BGRA while copying.
* The IPC itself is cheap (a few ms for ~150 KB up and 262 KB down). The long
  tail (p95 58-117 ms in three of four runs) was measured with the window
  hidden, where WebKit throttles the page; it is not a number to quote.
* ~28 ms per frame fits one mask per frame at 30 fps with no overlap only
  barely, so the pipeline would run it at its usual inference rate (10-15 Hz,
  `detection-quality`), off the main thread, with the one-interval mask lag it
  already has.

**Not measured:** 512x288 and 640x360 input, and the paced 30 Hz run with main-thread stall
monitoring. Both need the window on screen: the screen was locked partway through,
the page was suspended, and the probe never got past its first size. Re-run on an
unlocked Mac with the Voxal window in front.

## What this does not tell us

* **The IPC round trip is only partly measured** (see the prototype above:
  256x144 input only, window hidden).
* **Real-time Vision on a live stream.** The foreground request is documented
  for stills. Run per frame here (no temporal state), it was steady (`dtSSD`
  2.1), but it has not been run on a live camera, with auto-exposure and a
  moving subject.
* **"Instance" means any salient foreground object**, not just a person. On
  this footage the only foreground is the person; a person holding or standing
  beside an object may get that too. The bench cannot show it.
* **One clip, three rooms, one Mac (Apple Silicon).** Intel Macs and macOS 14
  versus 15/26 are unmeasured; Vision's models change with the OS.
* **Mobile is out of scope**: iOS has the same framework, but Capacitor has no
  such bridge.
