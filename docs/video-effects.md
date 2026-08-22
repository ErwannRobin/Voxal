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
| **Blur in a fixed 160-long buffer, box-downsampled, three widening H+V iterations of a 9-tap Gaussian** | Seven draws on a tiny buffer. A full-resolution blur costs orders of magnitude more *and* looks worse — a downsampled Gaussian upsamples into something closer to real bokeh. |

Per composited frame: one camera texture upload, plus about a dozen small draw
calls on buffers of a few thousand pixels. On any GPU from the last decade that
is well under a millisecond.

### How strong the blur looks is one number, and it is a setting

The Gaussian's sigma **as a fraction of the frame's long side**. Everything else
is derived from it. Stating it as a fraction rather than in pixels or texels is
what makes it mean the same thing on every camera — a 4K webcam and a 720p one
land on the same percentage, verified across four capture sizes and the whole
slider range in the tests.

It lives in **Settings → Video → Blur strength**
(`localStorage['blur-strength']`), directly under the chip row it modifies —
because "blurred enough" turned out to vary far more between people than any
single constant could serve. Default `0.08` — sigma ≈ 100 px on a 1280-wide
frame — over a range of `0.02` to `0.20`.

The slider's travel is **geometric, not linear**: each step is a constant
*ratio*. Linear travel would spend most of the slider inside "already
unreadable", because 2% → 4% is a dramatic change while 18% → 20% is invisible.
The eye reads blur as a ratio, so the mapping does too.

Moving it is a **uniform change inside a pass that already runs** — no
`replaceTrack`, no renegotiation, nothing announced, exactly like switching
blur → image. That matters more here than for the mode: a dragged slider fires
an event per pixel of travel, and each one is a recomputed array of at most six
numbers. In the desktop preferences window it is write-only, like the picker
beside it, and the main window's `storage` listener applies it.

### The background blur is not a fraction of the frame

The blur buffer is a **fixed 160 px on its long side**, not `frame / 4`. Two
things follow. The blur is the same *visible* strength on a 720p camera and a
4K one, instead of getting relatively weaker as the capture resolution rises;
and it costs the same on both, instead of scaling with a number the user did
not choose. Below 160 the buffer just tracks the frame, because there is
nothing to gain by upscaling first.

The buffer is small on purpose. The strength is relative to the frame, so
shrinking the buffer *buys* radius rather than spending it, and the box
downsample that fills it low-passes the frame on the way in.

Getting into it is a **box downsample** — four bilinear taps at the quarters of
a destination texel, so each averages a 2×2 source neighbourhood and the four
cover the whole footprint. A single tap, which is what this replaces, reads 4
source texels out of the 16-plus a destination texel covers. That is a point
sample in all but name, and the texels it throws away come back as aliasing —
aliasing that moves with the frame, which is precisely the "boiling" look of a
cheap background blur.

### Each iteration strides twice the last, and there are as many as it takes

Successive Gaussians add **variances**, so N doubling iterations reach
`sqrt((4ᴺ − 1) / 3)` times the radius of the first — three of them are worth
4.6×, which is how a 9-tap kernel gets a wide-lens radius at all. `blurPlan()`
solves that for the first stride, and the rest follow.

The pass **count** is derived rather than fixed: take the fewest passes whose
first stride still lands under a texel. That is what lets one slider span a 10×
range without the blur changing character — a stronger setting buys itself
another pass (2 at the bottom of the range, 5 at the top) instead of quietly
degrading into the failure below.

Doubling rather than repeating one stride is the part that matters, and it is
the fix for a blur that reads as *weak*. **A stride wider than the detail it is
sampling skips over that detail instead of averaging it**, and what survives is
structured, moving aliasing — which the eye reads as "the blur isn't really
blurring", however large the sigma on paper. So the first iteration steps less
than a texel, and each later one may stride further precisely because the one
before it has already smoothed what it is about to sample.

The tests pin both halves: that the strides add up to the requested strength on
every capture size and at five points along the slider, and — by probing a
blurred black/white edge on the rendered canvas at two different strengths —
that the setting actually reaches the shader. The second catches what the first
cannot: a stride in the wrong units, a dropped iteration, or a preference that
is stored but never applied all leave the arithmetic correct and the picture
wrong.

### Colour is blurred in linear light; coverage is not

Averaging sRGB-encoded values is not averaging light. It pulls every mixture
toward the middle, so a bright window behind you goes dull instead of blooming
and a colourful room turns to porridge — the flat, grey blur that this pipeline
used to produce. Each colour pass therefore linearises its taps, sums, and
re-encodes on the way out. Gamma 2.0 rather than 2.2: a multiply and a `sqrt`,
exact at both ends, mediump-safe, and indistinguishable from the real curve at
this scale. Keeping the intermediate buffer sRGB-*encoded* matters too — eight
bits of linear light bands visibly in the darks.

The mask feather runs the **same kernel through a second program with the gamma
step compiled out**, because a coverage value is not light. Bending that ramp
would move the edge somewhere other than where `MASK_DILATE` put it.

### The kernel is generated, not typed

`gaussianHalfKernel(sigma, taps)` computes normalised weights at load time and
the shader sources are built from them. This is a direct response to a real
bug: the hand-written table it replaces summed to **0.838**, not 1.

A pass that does not sum to 1 is a brightness multiplier wearing a blur's
clothes, and it is invisible in isolation. Two passes over the background left
it at 70% brightness — a flat `rgb(0,170,0)` came out as `rgb(0,120,0)` — which
is most of the answer to "why is the blur grey". Two more passes over the mask
capped the feather at 0.7, which quietly shifted the composite's threshold
inward and *hardened* the very edge the feather exists to soften.

`tests/e2e/unit-video-effects.spec.js` pins both ends: the generator's
normalisation, and — through the real GL pipeline — that blurring a flat colour
gives that colour back.

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
deliberately biased low — `smoothstep(0.12, 0.78)` rather than a symmetric
window around 0.5. Keeping a sliver of background sharp is a much smaller sin
than blurring somebody's ear off.

### How hard the cutout looks is two numbers, not one

The feather radius (`MASK_FEATHER`) sets how wide the gradient is. The
composite's window (`MASK_EDGE_LO` / `MASK_EDGE_HI`) decides how much of that
gradient survives as a visible transition. They are easy to tune separately and
wrong to think about separately: **a narrow window on a wide gradient is still
a hard edge** — it maps almost the whole ramp to 0 or 1 and keeps a sliver as
the transition. That is how the effect ended up looking like a paper cutout
even with a feather in front of it.

The window is wide on purpose — it keeps roughly 70% of the ramp — and biased
low, so the soft band runs from about 3 mask pixels outside the dilated
silhouette to about 2 inside it. With `MASK_DILATE = 3` in front, that band
sits wholly outside the real subject: a soft outline, never a bite out of an
ear. At 720p the band works out around 20 px.

### …and both of them are the middle of a slider

Those numbers are tuned, not universal. A plain wall forgives a crisp edge; hair,
glasses and a cluttered bookshelf do not, and people disagree about which
failure they would rather look at. So `MASK_FEATHER`, the composite's window and
`MASK_DILATE` are what **`edge-sharpness` 0.5** produces, and the preference
moves all three together through `edgeProfile()` — which exists precisely
because moving one without the others is the mistake the section above is about.

Sharper narrows the gradient and the window that maps it. Softer widens both —
*and dilates further*, because a wider soft band still has to sit outside the
real subject.

All three are uniforms of passes that already run, so dragging the slider
mid-call re-cuts the mask on the next inference and swaps no track. A test reads
the ramp back off the GPU at both ends of the travel; another pins the midpoint
against the constants above, so a retune cannot silently reach everyone who
never opened the setting.

### Accuracy is the inference *rate*, not the mask's size

The tempting knob — make the seg canvas bigger — buys nothing. `ImageSegmenter`
resizes whatever you hand it to the model's own 256-wide input, so a larger
canvas returns a larger readback of the same information (see the section
above). What actually improves the cut-out is running it **more often**: the
mask lags the frame by one segmentation interval, so 24 Hz sees ~40 ms of lag
where 10 Hz sees 100, and the temporal blend — which is per inference — smooths
over less.

So **`detection-quality`** picks a rate ladder rather than a resolution:

| | desktop | mobile |
|---|---|---|
| `battery` | 10 → 6 Hz | 6 Hz |
| `balanced` (default) | 15 → 10 → 6 Hz | 10 → 6 Hz |
| `high` | 24 → 15 → 10 → 6 Hz | 15 → 10 → 6 Hz |

Each row is a full ladder: the first rate is where the device starts, and the
load measurement below walks down the rest. Every ladder ends at 6 Hz, because
below that the effect is worse than not having it and giving up is the right
answer instead. Changing the setting restarts at the top of the new ladder —
the rungs differ between ladders, and a device that needs stepping down will be
stepped down again within one measurement window anyway.

### Low light is fixed before inference, not after

The selfie model is trained on ordinary indoor light and fails in the dark in
the way that hurts most: confidence collapses toward the middle of its range,
the edge goes soft and noisy, and the temporal blend turns that noise into a
crawling outline. No downstream filter recovers what the model never saw.

So with **`light-adapt`** on (the default), the pipeline measures the frame a
couple of times a second, and when it is dim it brightens *the segmenter's own
downscaled copy* through a canvas `filter` — `brightness()` plus a small
`contrast()` that rides along with it, since brightening lifts the noise floor
too. The gain is eased in at 25% per sample, because a gain that jumps when you
lean forward makes the mask breathe.

Three things it deliberately does not do:

* **It never touches the published picture.** Only the private 256-wide copy is
  brightened. A dark room stays dark on the wire — pinned by a test that reads
  the composited canvas while the gain is at full stretch.
* **It never darkens.** Gain is clamped to `[1, 2.6]`, and gain 1 sets no
  filter at all, so a well-lit scene costs exactly nothing.
* **It measures the centre, not the frame.** That difference is the whole of
  whether this helps or hurts in the classic failure case: a window behind you
  drags the frame's average up while leaving your face the darkest thing in it,
  and a full-frame average would then darken the one region the model needs.

Where `ctx.filter` does not exist (older WebKit), the frame is left alone.

### The blend's memory is its own buffer, and that is not optional

Three things run over the mask on every inference, in order: the temporal
blend, the dilate, the feather. The blend's `uPrev` must be **the previous
blended mask** — a buffer nothing downstream writes to.

It was not. `uPrev` was the *finished* mask, so the dilate and the feather were
re-applied to their own output ~15 times a second and compounded. Read off the
GPU, on a silhouette edge at texel 71.7 of a 256-wide mask:

| | 50% point | soft band |
|---|---|---|
| Compounding | texel 61 — **10.7 texels outside** the subject | texels 34–68 |
| Correct | texel 69 — one dilate outside | texels 63–71 |

From the outside that does not look like a mask bug. It looks like **the
background blur is weak**: a wide halo around the person stays sharp, and
turning the blur radius up cannot fix it, because the blur is not what is
wrong. It was reported three times as "not blurred enough" before anyone
looked at the mask.

So there are two ping-pong pairs, not one. `texMaskS`/`texMaskSB` is the
blend's memory; `texMaskA`/`texMaskB` is scratch for the dilate and the
feather, rebuilt from the state every inference and never fed back. The work
pair also has a fixed direction now — `texMaskA` is the finished mask by
construction rather than by a swap — so there is no arrangement of the swaps
that can reintroduce the loop.

`tests/e2e/unit-video-effects.spec.js` reads the mask back off the GPU and
asserts the edge does not move between an early and a late sample. That is the
assertion that fails on the old code; the geometry assertions alone would not
have caught it early, when the drift is still small.

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

1. steps segmentation down the ladder the `detection-quality` preference chose
   (by default 15 → 10 → 6 Hz on desktop, 10 → 6 Hz on mobile), since that is
   where nearly all the cost is; then
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
drifting copies. Four controls sit beneath it in the same card and follow the
same rule — `renderStrength()` and `renderSharpness()` (one slider builder,
two sets of arithmetic), `renderQuality()` and `renderLightAdapt()`. In the
desktop preferences window (`settings.html`) all five are write-only: that
window has no module system and therefore no capture pipeline, so it writes the
preference and the main window's `storage` listener applies it to the running
processor — the same bridge the noise-suppression and microphone-device
selectors use.

## Key files

| File | What it holds |
|---|---|
| `src/video-effects.js` | The whole pipeline, the shaders (generated from `gaussianHalfKernel`), the mode/strength/sharpness/accuracy/low-light storage, the picker and the four controls under it |
| `src/main.js` | `maybeApplyVideoEffects()`, `applyVideoBackground()`, `swapLocalVideoTrack()`, the unwrap in `stopStreamTracks()`, the effects branches in `flipCamera()` and `setLocalCameraSuspended()`, the tile button in `_buildVideoTile()`, and `positionVideoBackgroundPopover()` / `renderVideoBackgroundProgress()` |
| `resources/make-backgrounds.py` | Generates the four preset images |
| `tests/e2e/unit-video-effects.spec.js` | Coverage, with inference stubbed via `window.__voxalSegStub` |
