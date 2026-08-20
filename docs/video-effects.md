# Camera background effects (blur & virtual backgrounds)

Voxal can blur what is behind you, or replace it with an image. This document
covers how the pipeline is built, why it is built that way, where the assets
come from, and what happens on a device that cannot keep up.

The whole feature is `src/video-effects.js` plus a handful of integration points
in `src/main.js`. It applies to **your camera only** — never to screen-share,
and never to audio.

## Everything happens on your device

> **No frame is ever sent anywhere to compute a background.** Segmentation runs
> locally, in WebAssembly, on your own GPU. The only thing that leaves your
> machine is the finished video, exactly as it would without the effect.

This is worth stating plainly because it is the opposite of the trade-off
described in [video routing](video-routing.md): an SFU genuinely can see the
camera video it forwards. A background effect adds nothing to that exposure —
it changes the picture *before* the picture is encoded. If you route video
through the relay, the relay sees your blurred background; if you don't, nobody
does.

The 12 MB MediaPipe runtime is fetched from Voxal's own origin (see
[Where the assets come from](#where-the-assets-come-from)) the first time you
turn an effect on, and cached. That fetch is the only network traffic the
feature ever generates.

## Off costs nothing

With the background set to **None**, `localVideoStream` is the raw
`getUserMedia` stream, byte for byte what it was before this feature existed.
No canvas is created, no WebGL context is taken, no runtime is downloaded and
no frame is processed. Someone who never turns this on pays nothing for it.

That is why the preference is stored as an *absence*: `off` removes
`localStorage['video-background']` rather than writing a value to it.

## The pipeline

```
raw camera MediaStream  (getUserMedia)
  └─ <video> source — muted, playsinline, never in the DOM
       └─ requestVideoFrameCallback loop (rAF where that is missing)
            ├─ [every Nth frame] ImageSegmenter.segmentForVideo()
            │      → 256×144 confidence mask → R8 texture
            │      → temporal blend with the previous mask
            │      → separable blur (the feather)
            └─ WebGL2 composite → canvas → captureStream() → the published track
```

Four decisions carry almost all of the performance:

| Decision | Why |
|---|---|
| **Segment at 256×144** — the landscape selfie model's own input size | Inference costs ~3–6 ms instead of ~30 ms. Segmenting at capture resolution buys a mask nobody can tell apart. |
| **Segment at 10–15 Hz while compositing at 24–30 fps** | Inference is the only expensive step in the whole pipeline, and it runs on a third to a half of the frames. |
| **Temporally blend each new mask into the previous one** | Kills the edge crawl between frames, *and* is what makes the skipped frames invisible. Without it, dropping to 10 Hz reads as stutter. |
| **Blur by downsampling to a quarter and running two separable 9-tap passes** | Three draws on a sixteenth of the pixels. A full-resolution blur costs 16× more *and* looks worse — a quarter-res Gaussian upsamples into something closer to real bokeh. |

The mask is then feathered — blurred, then `smoothstep`ed in the composite —
because the raw model output has a visible 256×144 staircase along its edge.
That single pass is the difference between "a demo" and "shippable".

Per composited frame: one camera texture upload, plus about six small draw
calls. On any GPU from the last decade that is well under a millisecond.

### Why the mask crosses the CPU

MediaPipe can share a WebGL context, which would keep the mask on the GPU. It
also freely resets viewport, framebuffer and blend state, and Voxal ships on
five different webviews (Chromium, two WebKits, WebKitGTK, WebView2). Saving and
restoring GL state around every inference on all of them is a real maintenance
risk for a real but small win.

So the segmenter gets **its own canvas**, and the mask comes back as a
`Uint8Array`. At 256×144 that is 37 KB per readback — about 0.5 MB/s at 15 Hz,
and sub-millisecond. Sharing the context is a documented future optimisation,
not something this version needs.

## Switching backgrounds does not touch the wire

This is the property the design exists to protect.

Once the camera is wrapped, **the published track is the canvas**, and the
canvas does not change when the background does. Blur → image → another image is
a texture swap inside a fragment shader: no `replaceTrack`, no renegotiation, no
tile teardown on anyone else's screen. Only crossing the **off ↔ on** boundary
swaps a track, and even then it is a `replaceTrack` on the existing senders
(`localVideoSenders()` in `main.js`, which already covers both the mesh and the
SFU publish connection) rather than a republish.

The same property makes the front/back camera flip free: `flipCamera()` points
the effect at the new camera via `VideoEffects.setSource()` and the far side
never learns anything happened.

Nothing is announced on the wire for any of this. Changing your background is
not a start and not a stop; re-announcing would make every peer tear the tile
down and rebuild it. This is the same rule `flipCamera()` follows, for the same
reason.

`tests/e2e/unit-video-effects.spec.js` asserts the `replaceTrack` counts
directly, because a regression here is invisible locally and obvious to
everyone else in the call.

## Teardown, and the leak it prevents

A processed stream carries its source on itself:

```js
processed._effectsOriginal  = rawStream;   // the actual camera
processed._effectsProcessor = pipeline;
```

This is the same contract `applyRNNoise()` / `stopMicStreamFully()` use for the
microphone, and it exists for the same reason: **stopping the visible tracks is
not enough.** The tracks on a processed stream belong to a canvas. Stop only
those and the real camera keeps capturing, the indicator light stays on, and the
render loop keeps spinning.

`stopStreamTracks()` in `main.js` does the unwrap, so every teardown path gets
it for free. Suspending is the same story: `setLocalCameraSuspended()` disables
the raw track *and* pauses the render loop, not just the canvas track.

## When a device can't keep up

Segmentation on a phone is real work, and a call that degrades into a slideshow
is worse than no effect at all. The pipeline measures its achieved frame rate
over rolling five-second windows and, when it falls below 60% of the camera's
rate:

1. steps segmentation down — 15 → 10 → 6 Hz on desktop, 10 → 6 Hz on mobile —
   since that is where nearly all the cost is; then
2. having run out of things to trade, gives up: the raw camera goes back on the
   wire, the preference is set to `off`, and the user is told once.

Degradation happens quietly. Only giving up is announced, and it is announced
rather than left to look like a broken camera.

## Where the assets come from

| Asset | Size | Shipped how |
|---|---|---|
| `vision_bundle.mjs`, `vision_wasm_internal.{js,wasm}` | ~12 MB | **Not committed, not bundled.** Copied out of `node_modules` by `seg-assets.sh` — which both `make seg-assets` and the Vercel deploy (`vercel-build.sh`) call — served from Voxal's own origin, fetched lazily on first use. |
| `selfie_segmenter_landscape.tflite` | 250 KB | Committed to `src/assets/seg/`, bundled into the apps. |
| `assets/backgrounds/*.webp` | ~20 KB total | Committed. Generated by `resources/make-backgrounds.py`, so there is no third-party artwork and nothing to license. |

Twelve megabytes of WASM in every App Store and Play download, for a feature
most people never switch on, is not a trade worth making — so `make cap-sync`
deletes `assets/seg/vision_*` from the iOS and Android bundles after syncing.
The model and the artwork stay bundled: they are small, and keeping them local
saves a round-trip.

Resolution at runtime (`runtimeBase()` in `video-effects.js`):

- **Web** — same-origin `assets/seg/`. No CORS involved, and the existing
  `Cross-Origin-Embedder-Policy: require-corp` header is satisfied for free.
- **Tauri and Capacitor** — `https://voxal.app/assets/seg/`, or whatever
  `localStorage['service-url']` points at, so a self-hoster's deployment serves
  its own copy. These fetches are cross-origin from `tauri://localhost` and
  `capacitor://localhost`, which is why `vercel.json` sets
  `Access-Control-Allow-Origin: *` on `/assets/seg/(.*)`. That path is also
  served `immutable` with a one-year max-age, so the download happens once per
  device rather than once per launch; on native the binary is additionally kept
  in CacheStorage (`voxal-seg-v1`) and handed to MediaPipe as a blob URL.

Because the runtime is not committed, a fresh clone needs `npm install`
followed by `make seg-assets` (both `make install` and `make dev` do this for
you) before the effect will start locally.

## Custom backgrounds

A picked image is downscaled to at most 1280×720, re-encoded as JPEG and stored
as a **Blob in IndexedDB** (`voxal-bg` / `images` / `custom`). localStorage can
hold neither a Blob nor, comfortably, its base64. The downscale matters: a 12 MP
phone photo decodes to ~50 MB of RGBA, which is a real memory spike on the
device least able to absorb one, for something that ends up soft-focused behind
a person.

Images are drawn cover-fit — fill the frame, crop the overflow, never stretch.

## The UI

One button, **Background**, next to Camera in the room's control row. It appears
only while a camera is actually running, and only where the pipeline is
supported. It opens a popover holding a single row of chips:

```
None · Blur · Aurora · Dusk · Studio · Linen · +
```

The same row appears in Settings → Video, rendered by the same
`VideoEffects.renderPicker()` so there is one definition rather than three
drifting copies. In the desktop preferences window (`settings.html`) the picker
is write-only: that window has no module system and therefore no capture
pipeline, so it writes `localStorage['video-background']` and the main window's
`storage` listener does the work — the same bridge the noise-suppression and
microphone-device selectors use.

## Key files

| File | What it holds |
|---|---|
| `src/video-effects.js` | The whole pipeline, the shaders, the mode storage, the picker |
| `src/main.js` | `maybeApplyVideoEffects()`, `applyVideoBackground()`, `swapLocalVideoTrack()`, the unwrap in `stopStreamTracks()`, the effects branches in `flipCamera()` and `setLocalCameraSuspended()` |
| `resources/make-backgrounds.py` | Generates the four preset images |
| `tests/e2e/unit-video-effects.spec.js` | Coverage, with inference stubbed via `window.__voxalSegStub` |
