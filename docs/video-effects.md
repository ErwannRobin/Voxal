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
            ├─ [every Nth frame] downscale to the mask size (256 long side)
            │      → ImageSegmenter.segmentForVideo()
            │      → confidence mask → R8 texture
            │      → temporal blend with the previous mask
            │      → dilate, then separable blur (the feather)
            └─ WebGL2 composite → canvas → captureStream() → the published track
```

Four decisions carry almost all of the performance:

| Decision | Why |
|---|---|
| **Segment a downscaled copy**, long side 256, short side matching the camera | Inference costs ~3–6 ms instead of ~30 ms — and see the warning below, because this one is not optional. |
| **Segment at 10–15 Hz while compositing at 24–30 fps** | Inference is the only expensive step in the whole pipeline, and it runs on a third to a half of the frames. |
| **Blend each new mask into the previous one, asymmetrically** | Kills the edge crawl between frames, *and* is what makes the skipped frames invisible. See below — the asymmetry is the whole trick. |
| **Blur by downsampling to a quarter and running two separable 9-tap passes** | Three draws on a sixteenth of the pixels. A full-resolution blur costs 16× more *and* looks worse — a quarter-res Gaussian upsamples into something closer to real bokeh. |

Per composited frame: one camera texture upload, plus about six small draw
calls. On any GPU from the last decade that is well under a millisecond.

### `ImageSegmenter` returns the mask at *your* frame's size

Not at the model's input size. Hand it a 640×480 video and you get a 640×480
mask back — 300 KB read across per inference rather than 37 KB, and the model's
own resolution is long gone by then anyway.

Worse, the mask then has to be resampled into whatever buffer you allocated. The
first version of this pipeline hardcoded 256×144, so on the 4:3 camera in most
laptops every mask was crushed from 480 rows into 144 before use. That, plus
three compounding erosions — the feather blur, the composite's `smoothstep`, and
the mask's own lag behind a moving frame — clipped people's faces.

So the pipeline downscales the frame **itself** before inference, to a size that
keeps the camera's aspect (`segSizeFor()`: 16:9 → 256×144, 4:3 → 256×192, a
phone held upright → 144×256). That fixes the readback cost and the geometry
together.

The erosions are answered directly too: the mask is **dilated** by a separable
3-tap max filter before it is feathered, and the composite's threshold is
deliberately biased low — `smoothstep(0.10, 0.42)` rather than a symmetric
window around 0.5. Keeping a sliver of background sharp is a much smaller sin
than blurring somebody's ear off.

### The temporal blend is asymmetric, and that is the point

A single blend factor forces a choice between two bad outcomes. Blend slowly and
the mask lags a moving head, clipping it. Blend quickly and the model's
frame-to-frame noise goes straight through, so the blur boils.

So the mask **grows fast and shrinks slowly** — 0.85 up, 0.20 down, per
inference. A pixel the model has just decided belongs to you is trusted almost
immediately; one it has just dropped is given several inferences to prove it.
That tracks motion without the flicker, because flicker is overwhelmingly pixels
dropping out for a single inference and coming straight back.

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
| `vision_bundle.mjs`, `vision_wasm_internal.{js,wasm}` | ~12 MB | **Not committed.** Staged out of `node_modules` by `seg-assets.sh`, which `make seg-assets`, the desktop build targets and the Vercel deploy (`vercel-build.sh`) all call. Bundled into the desktop app; fetched lazily on mobile. |
| `selfie_segmenter_landscape.tflite` | 250 KB | Committed to `src/assets/seg/`, bundled into the apps. |
| `assets/backgrounds/*.webp` | ~20 KB total | Committed. Generated by `resources/make-backgrounds.py`, so there is no third-party artwork and nothing to license. |

Twelve megabytes of WASM in every App Store and Play download, for a feature
most people never switch on, is not a trade worth making — so `make cap-sync`
deletes `assets/seg/vision_*` from the iOS and Android bundles after syncing.
The model and the artwork stay bundled: they are small, and keeping them local
saves a round-trip.

**Desktop makes the opposite trade.** `tauri.conf.json` bundles the whole of
`src/`, and the build targets stage the runtime first, so the Tauri app ships
with it: no download, no first-run wait, and the effect works with no network at
all. A desktop app is not metered by an app store review the way a mobile one
is, and 12 MB against a Tauri bundle is noise.

Resolution at runtime (`runtimeBase()` in `video-effects.js`), which follows
exactly the rule `anonymousTurnUrl()` and the SFU endpoints in `main.js` already
use — an override wins, then same-origin where there is one, then the absolute
URL of the static site:

- **Web** — same-origin `assets/seg/`. No CORS involved, and the existing
  `Cross-Origin-Embedder-Policy: require-corp` header is satisfied for free.
- **Tauri** — same-origin too, because the runtime is inside the app bundle.
- **Capacitor** — `https://ptt.voxal.app/assets/seg/`, overridable with
  `localStorage['seg-assets-url']` for self-hosters and tests. This fetch is
  cross-origin from `capacitor://localhost`, which is why `vercel.json` sets
  `Access-Control-Allow-Origin: *` on `/assets/seg/(.*)`. That path is also
  served `immutable` with a one-year max-age, and the binary is additionally
  kept in CacheStorage (`voxal-seg-v1`) and handed to MediaPipe as a blob URL,
  so it is downloaded once per device rather than once per launch.

> **`ptt.voxal.app`, not `voxal.app`.** The static site is served from
> `ptt.voxal.app` — the same host `DEFAULT_ANON_TURN_URL` and the SFU endpoints
> point at. `presenceBase()` / `localStorage['service-url']` is the *presence
> API*, which defaults to a Supabase edge function and has never served static
> assets. Pointing the runtime at it is invisible on the web (same-origin wins
> there) and breaks the feature outright on the apps.

Because the runtime is not committed, a fresh clone needs `npm install`
followed by `make seg-assets` (both `make install` and `make dev` do this for
you) before the effect will start locally.

## The first run, and getting out of it

On mobile, the first effect anybody turns on has to pull ~12 MB down. A picker
that just sits there looks broken, so the popover says what is happening, how
far along it is, and offers to stop:

```
Downloading background effects (about 12 MB) — 42%
[============                    ]
[ Cancel ]
```

The binary is fetched by hand rather than left to MediaPipe's loader, precisely
so there is a byte count to report and an `AbortController` to hang Cancel off.
Cancelling is treated as an answer, not an error: the preference goes back to
`off`, the plain camera keeps sharing, and nothing is said on the wire or in a
toast.

Two details worth keeping in mind if you touch this. `Content-Length` is the
*compressed* size whenever the response is encoded, while the reader hands back
decompressed bytes — so it is a hint, not a denominator, and the reporter falls
back to an approximate size and never shows 100% before the runtime is ready.
And `onLoadProgress` is a single slot rather than a listener list: `main.js` is
the only consumer, and a second registration would silently displace it.

## Custom backgrounds

A picked image is downscaled to at most 1280×720, re-encoded as JPEG and stored
as a **Blob in IndexedDB** (`voxal-bg` / `images` / `custom`). localStorage can
hold neither a Blob nor, comfortably, its base64. The downscale matters: a 12 MP
phone photo decodes to ~50 MB of RGBA, which is a real memory spike on the
device least able to absorb one, for something that ends up soft-focused behind
a person.

Images are drawn cover-fit — fill the frame, crop the overflow, never stretch.

The **"+" chip opens the file dialog synchronously**, from inside the click
handler, and reads whether an image is already stored from a flag rather than
from IndexedDB. This is not a micro-optimisation: a browser only opens a file
picker while it still considers itself inside a user gesture, and a single
awaited promise is enough to spend that activation. The first version read the
store first, and the chip silently did nothing on iOS and Android. For the same
reason the input is visually hidden rather than `display: none` — WKWebView will
not open a picker for an input it is not rendering.

## The UI

One icon-only button, on **your own camera tile**, beside the front/back flip —
your background belongs to your picture, not to the room, and putting it there
keeps the bottom control row from growing a fifth item. It rides along when
`renderVideoStage()` moves the tile into the minimized self-view badge.

Because that tile moves, the popover cannot live inside it: it is a child of
`#screen-room`, positioned against whichever button opened it by
`positionVideoBackgroundPopover()` and clamped into the viewport. It holds a
single row of chips:

```
None · Blur · Aurora · Dusk · Studio · Linen · +
```

The button appears only while a camera is actually running, and only where the
pipeline is supported. Picking a background closes the popover — the choice is
about the picture the popover is sitting on top of.

On a narrow screen the chip strip scrolls sideways rather than wrapping into a
block that would cover the preview. It carries vertical padding for a reason
that is easy to delete by accident: `overflow-x` clips on *both* axes, and the
selected chip's ring is a `box-shadow` drawn outside its box, so without the
padding the ring is sliced off along the top and bottom.

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
| `src/main.js` | `maybeApplyVideoEffects()`, `applyVideoBackground()`, `swapLocalVideoTrack()`, the unwrap in `stopStreamTracks()`, the effects branches in `flipCamera()` and `setLocalCameraSuspended()`, the tile button in `_buildVideoTile()`, and `positionVideoBackgroundPopover()` / `renderVideoBackgroundProgress()` |
| `resources/make-backgrounds.py` | Generates the four preset images |
| `tests/e2e/unit-video-effects.spec.js` | Coverage, with inference stubbed via `window.__voxalSegStub` |
