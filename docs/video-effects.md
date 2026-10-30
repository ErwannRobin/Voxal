# Camera background effects (blur & virtual backgrounds)

Voxal can blur what is behind you, or replace it with one of six animated
scenes or an image of your own. This document covers how the pipeline is built,
why it is built that way, where the assets come from, and what happens on a
device that cannot keep up. The scenes have [their own section](#animated-scenes).

The whole feature is `src/video-effects.js` plus a handful of integration points
in `src/main.js`. It applies to **your camera only** — never to screen-share,
and never to audio. With a scene picked, a setting that is on by default lets the people you
call draw it themselves, from a picture of just you
([Keyed sending and receiving](#keyed-sending-and-receiving)).

## Everything happens on your device

> **No frame is ever sent anywhere to compute a background.** Segmentation runs
> locally, in WebAssembly, on your own GPU. What leaves your machine is the
> finished video, exactly as it would without the effect — or, with **Let
> others draw my scene** on, a picture of you cut out on your own device, for
> the people who draw the scene behind you on theirs.

This is worth stating plainly because it is the opposite of the trade-off
described in [video routing](video-routing.md): an SFU genuinely can see the
camera video it forwards. A background effect adds nothing to that exposure —
it changes the picture *before* the picture is encoded. If you route video
through the relay, the relay sees your blurred background; if you don't, nobody
does.

The keyed picture does not change that. It goes only to a peer on a direct
connection, never through the relay (the relay is always sent the finished
picture), and it carries you over flat green plus the thin edge of your room
that the cut-out's soft outline lets through; anything fainter than that is cut
to pure green before it leaves (`KEY_ALPHA_FLOOR`). What it adds on the wire is
the scene's name and a few numbers about your light, so the far end can draw
the same scene.

The 12 MB MediaPipe runtime is fetched from Voxal's own origin (see
[Where the assets come from](#where-the-assets-come-from)) the first time you
turn an effect on, and cached. That fetch is the only network traffic the
effect itself generates; keying adds a few small messages over the room's own
signalling.

## Off costs nothing

With the background set to **None**, `localVideoStream` is the raw
`getUserMedia` stream, byte for byte what it was before this feature existed.
No canvas is created, no WebGL context is taken, no runtime is downloaded and
no frame is processed. Someone who never turns this on pays nothing for it.

That is why the preference is stored as an *absence*: `off` removes
`localStorage['video-background']` rather than writing a value to it.

There is one exception, and it is on the receiving side. A device that can draw
scenes says so to the room whatever its own background, and when somebody in
the call offers it a keyed picture, it draws that person's scene: a WebGL
context and a full scene render per keyed peer, capped at three on a desktop
and one on a phone (none on a phone drawing its own scene or set to save
battery). It pays that only while such an offer stands, and gives it up first
when its own camera needs the room
([Keyed sending and receiving](#keyed-sending-and-receiving)). Sending is free
until the setting is on, and even then the keyed pass is drawn only while some
peer is actually being sent it.

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
            │      → [a scene] shrink to 64 wide and blur wide (the soft mask)
            │      → [a scene, 4×/s] measure how you are lit
            ├─ [a scene, 20 Hz] draw the scene into a 512-long buffer, mipmap it
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

### Edge colour is the person's, not the room's

The band is where a pixel is part person and part the room behind them. Over
the old room that is invisible; over a scene or an image it is a halo of the
old wall around the head and shoulders, which no amount of mask tuning removes,
because the colour itself is wrong. The composite therefore decontaminates the
band (`uDecon`, `DECON_STRENGTH`, in `FRAG_COMPOSITE`): it reads the matte's
gradient, takes the camera's colour a few matte texels inside (`fg`) and
outside (`bk`) the band, and pulls the pixel toward `fg` by how much of it is
`bk` (`t`, the pixel's position on the `bk` to `fg` line). A pure person pixel
has `t` of 1 and is untouched; so is a flat room, where `fg` and `bk` agree.
Weighted by how deep in the band the pixel is, so the two ends of the ramp
are not moved. It runs for an image or a scene and never for blur (whose
background IS the room) or the keyed frame (the receiver composites that one,
and a second pass here would be done twice). Eight extra reads, only in the
band. `Processor.decon` is the knob; `unit-video-effects.spec.js` ("edge
decontamination") pins both halves: a flat room is unchanged, and a blurred
person edge on a red wall carries less red with it on.

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

### A fixed camera: the empty-room reference

On unless Settings → Video → **Fixed camera** is switched off (`bg-reference`;
absent means on, only `off` is stored). Being on costs nothing by itself — the
pipeline changes only once a picture exists. The background popover on your own
tile offers **Capture empty room**, which opens a full-window guide
(`#video-ref-guide`, `startVideoReferenceCapture()` in `main.js`) written for
somebody who is walking away from the screen:

1. **Leave** — "Step out of the picture", the live self-view, and a big
   `VIDEO_REF_COUNTDOWN_S` (5) countdown over it. The last three seconds beep
   (`playCountdownBeep()`), the "1" a fifth higher.
2. **Capturing** — `REF_CAPTURE_FRAMES` (12) frames averaged into a picture of
   the room without you (well under a second).
3. **Done** — a white flash over the window and a synthesised shutter click
   (`playShutterClick()`), then "you can come back — don't move the camera or
   the computer". The flash comes **after** the capture on purpose: the screen
   lights the room, and a white frame during it would be learnt as the room's
   colour. The dark scrim is the same from the countdown to the end of the
   capture for the same reason.
4. **Failed** — "you were still in the picture" (or no frames at all), with
   *Try again*.

Escape or *Cancel* leaves at any point but the capture itself. From then on every
frame is compared with that picture at `REF_LONG` (640) wide — two and a half
times the model's resolution — and the comparison is allowed to correct the
cut-out's edge.

**It is a second opinion, never the only one.** The composite keeps the model
in charge of the two regions it gets right, and hands the reference only the
band between them:

```
m     = smoothstep(edge, feathered dilated mask)   // the model, as before
core  = smoothstep(0.60, 0.95, eroded blended mask) // where the model is sure
m'    = m * max(diff, core)                          // the reference can only take away
```

- Outside the model's (dilated) band the reference is never asked, so a shadow
  or a moving curtain across the room is never cut *in*.
- Inside `core` — the blended mask eroded by `REF_CORE_ERODE` (4) mask texels,
  ~20 px on a 1280-wide camera — it is not asked either, so a shirt the colour
  of the wall is never cut *out*. Eroded, not merely thresholded: the model is
  confidently wrong as often as it is unsure, and a mask that is 1.0 right up to
  its staircase edge would leave the reference nothing to decide.
- In between, which is where the model's staircase and the dilate's halo of
  sharp room live, the per-pixel difference decides. While the reference is in
  use the band is dilated `REF_DILATE_EXTRA` (2) texels further, since the
  reference can only give back hair that is inside it.

The difference (`refScore()` in JS, the same arithmetic in `FRAG_REF_DIFF`) is
the larger of a chromaticity distance — colour with brightness divided out,
which a shadow leaves alone, and which is ignored in the dark where it is noise
— and a relative luma distance weighted down so a soft shadow alone does not
cross the threshold. Camera and reference are both box-sampled through the same
four taps: sampling the reference once made it sharper than the camera, and
every edge in the room read as "different" along its length.

**Webcams re-meter the moment you walk back in.** Every `REF_STATS_MS` (500 ms),
in the segmentation callback where a fresh mask is in hand, a 64-wide copy of
the frame is compared with the reference over the part the model calls room.
That gives a per-channel gain (exposure and white balance since the capture,
clamped to 0.5–2×) that is applied to the reference before the comparison, and
the share of the room that still matches. Below `REF_STALE_BELOW` (55%) the
reference is set aside — the camera moved, or the light changed — and eased out
over a few frames rather than snapped; it is trusted again only above
`REF_FRESH_ABOVE` (70%). The popover then says so, and a toast says it once.

A capture is refused (`reason: 'present'`) if the model calls more than
`REF_PRESENT_MAX` (2%) of any frame during it a person: a reference with you in
it would teach the pipeline that you are the room.

**Privacy.** The picture lives in a module-level variable, in memory only — it
survives turning the camera off and on, and nothing else. It is never written
to storage and never sent. Switching the setting off **forgets** it, not just
stops using it (`refreshReference()`, which the main window's `storage`
listener also calls when the desktop preferences window flips the switch). A
reference belongs to one camera at one shape: flipping to another camera, or a
different aspect, simply does not load it.

**Costs nothing when off, and little when on**: one 640-wide pass per frame, a
four-pass erosion of the 256-wide mask per inference, and a 64×36 readback
twice a second. Nothing about it swaps a track.

**Not measured on a real room.** Every threshold above (`REF_SCORE_LO/HI`,
`REF_MATCH_MAX`, the core window, the erosion) is reasoned from how webcams and
the model behave, and checked only against a synthetic striped room in
`unit-video-effects.spec.js`. Expect them to need tuning against a real webcam;
the reference sets itself aside when the room stops matching, so a bad tune
costs a sharper halo, not a broken picture.

## Animated scenes

> **Scene engine v2.** The scenes are moving from one ray-marched shader each
> (described below) to Three.js worlds in `src/scenes/` — see
> [`scene-engine.md`](scene-engine.md). Everything this section says about the
> resolve, the look, the shadow, the light wrap, bloom and keyed receivers
> holds for both; what it says about how a scene is drawn holds for the
> scenes still on their shader.

The presets are not pictures, and they are not layered drawings either. **Office**,
**Island**, **Cyber café**, **Mountain**, **Countryside** and **Neon rain** are each one fragment
shader in `src/video-scenes.js` that renders a small **3D world** from a pinhole
camera, lit the way a camera would see it: a sun and a sky from a single-
scattering atmosphere, ray-marched cumulus, haze that thickens with distance,
soft shadows, ambient occlusion, reflection and refraction in water and glass,
light through leaves, and a camera's own filmic shoulder and sRGB curve at the
end. Nothing is downloaded, nothing is licensed, and nothing is stored: there is
no artwork anywhere in the repository. That is a requirement rather than a style,
because it is what lets the scene be **relit to match you**, which a photograph
never can be.

| Scene | What it is | What moves | Takes your shadow |
|---|---|---|---|
| Office | A room: five planes, a bookcase of individual books, a fiddle-leaf fig, a lamp, a picture, a windowsill. The window is an **area light** and the sun passes through it for real | the dapple of the tree outside on the sunlit patch, the fig and its shadow, dust in the shaft | yes — the wall behind you |
| Island | A lagoon at eye height: Fresnel sea, turquoise shallows with **caustics**, a reef with surf, glitter, wet sand that mirrors the sky, a 3D **coconut palm** lit through its leaves, an islet, a sail, gulls | cumulus, the swell, the shore lapping, the palm | lightly — the sand |
| Cyber café | A brick wall that is a *height field* (so a lamp or neon skimming it picks out every course), pendant lamps, neon, laptops, a mug with steam, jars on a shelf, and a **wet street window** where each drop is a lens | the neon breathing, code scrolling, drops sliding, steam | yes — the brick wall |
| Mountain | An alpine lake: a **ray-marched range** (snow, strata, forest, haze), a **mirror lake** that reflects it all, mist, pines you could walk around | cirrus and the shade of clouds on the slopes, mist, ripples | no — everything is far away |
| Neon rain | A double-height penthouse over a **stormy night city seen from above**: a glass wall with slim posts, a low sofa with underglow, a smoked-glass table, an arc lamp, **polished floor that mirrors the strips and the city**, cyan cove and magenta side strips. The city is **geometry** (a grid of blocks walked by each ray), the glass is wet (lens drops, runnels), rain falls in three depths and a far flash lights the clouds | rain and drops, the odd window changing, traffic on the streets and in the air, mist banks, beacons, the strips breathing, a flash every so often | yes — the room |
| Countryside | Rolling farmland: a Voronoi **patchwork of fields**, hedgerows, a lane to a farm, an oak (a signed-distance tree, lit through its leaves), sheep, long grass and flowers | wind over the wheat, **cloud shadows** crossing the hills, the grass | no |

### Neon rain

Why it is the way it is, so the next scene does not have to rediscover it.

**The city is a grid, not a picture.** Each ray walks the cells of a 46 m grid
(DDA, at most 56 cells, 30 for a reflection) and meets a box per cell (a smaller
one on top of the tall ones), with a height from a hash and a cluster noise. That
gives roofs seen from above, towers that rise past the horizon, and parallax when
the camera turns (the phone's tilt, the mouse orbit, a keyed receiver's strip all
work without the scene knowing). Windows, banners, screens, roof lines and
beacons are a function of the hit point; streets are a function of the ground
point. A *2.5D stack of cards* was rejected: no roofs, no parallax, a repeat the
eye finds in a second.

**Composition is for a person in front of it.** Straight ahead is a *corridor* of
low blocks and mist (`corridor` in `building()`), the towers are on the sides, the
glass posts stand at ±1.85 m (never behind a head), no runnel runs down the middle,
and on top of that the city thins into mist around the subject (`calm`, from
`uSubject`, which a keyed receiver also has). The test pins the three of them.

**Windows must stop being windows before they alias.** A window the size of a
pixel is a different value in every redraw, and the resolve (see *Sharp at the
size it is shown*) reads that as movement: a frozen room cost 1,716 kb/s at a
fixed quantizer, against 676 for the café. The fix is the footprint: a window's
edge is as soft as a pixel is big (`ew`), and past ~2 pixels per window it becomes
*how many are lit, in their average colour* (`fade`, `plA`) — never "this cell's
own lit-or-not", which paints blocks the size of a window. Frozen cost came to
831 kb/s, with the near towers as sharp as before.

**Bloom, as a catalogue property.** There was no bloom. A separate pass would have
meant another full-size buffer per redraw and its own history; instead the
resolve reads the *coarse mip levels the pipeline already builds for the light
wrap* (`textureLod` 2, 3.2 and 4.4 of the redraw), adds them in light with a small
energy trade (`1 − 0.4·k`), and adds the result to every look *before* the looks
are compared, so a halo that holds still is as still as the picture. It is one
uniform (`uBloom`, from `bloom` in the catalogue; 0 means the shader is exactly
what it was). Cost: three more texture reads per output pixel, and about 3 ms on
the software GL of this machine (74 → 77 ms a redraw). Not a threshold bloom: with
no threshold a lamp in a dark room gets a halo and a lit wall only a little
brighter, which is what this scene wants and what a night scene always wants.

**Hybrid, as it is.** Near geometry (sofa, table, lamp: signed-distance fields
inside bounding boxes, so the march costs nothing where they are not), the city
(DDA over boxes), the sky (a cheap domain-warped cloud sheet), the glass (a few
procedural lens layers) and the floor (an analytic mirror of the strips, a march
for the objects, and *one* look at the city for either the glass or the floor's
reflection, so the DDA is in the shader once). Three.js was weighed and not
taken: a second GL context (the browser kills the oldest past 16), no relight by
the subject, no keyed receiver, a dependency, and nothing it does here that the
resolve does not.

**Rain is a bit rate.** Streaks are sparse and as long as a redraw's fall, the
sliding drops move in bursts a few pixels a second, and the beads hold still;
without rain the scene costs ~40% less to encode, which is the order of what
rain is worth.

### How a scene is built

Every scene is a pinhole camera (50° top to bottom, widened a little in an upright
frame) looking into a world that is lit, not coloured in. The shared header of
`video-scenes.js` is what the scenes have in common:

* **The sun and the air.** `atmosphere()` integrates single scattering through a
  Rayleigh + Mie atmosphere per pixel (8 samples along the view ray, 3 toward the
  sun), so a low sun turns the horizon gold and a high one leaves the zenith deep
  blue without anyone choosing those colours. `sunSetup()` puts the sun at an
  elevation and azimuth and works out the colour of its light after its path
  through the air (a sunset is already red). `aerial()` fades what is far into the
  sky it is in front of, with a haze that thins with height.
* **Clouds.** `cloudMarch()` ray-marches one slab of cumulus: a noise density under
  a height profile (flat bottoms, billowing tops), lit by marching three samples
  toward the sun (a dark base under a bright, silver-edged crown) with the sky's
  glow filling the shade. The same density, looked at from the ground up the
  sun's ray, is the **shade the clouds throw** on the mountain slopes and the
  fields.
* **Terrain.** The mountain and the countryside are height fields ray-marched with
  steps that grow with distance, a bisection to settle on the surface, a normal
  from forward differences, and a soft shadow march toward the sun. The
  mountain's march is in two stages — the lake's banks (a few cheap exponentials)
  and, from a kilometre out, the range — so rays that meet the lake never pay for
  the mountains.
* **Interiors and objects.** The office and the café are analytic planes plus a
  signed-distance `map()` of the furniture, each piece skipped, cheaply, while the
  ray is far from its bounding box. The island's palm is analytic too: capsules
  for the trunk, and each frond a spine with a wing of planar quads either side,
  the leaflets a comb cut out of them by an alpha test.
* **The tone curve.** Scenes are lit in physical-looking units (a sunlit wall is
  several times a mid-grey), so `main()` brings the camera's exposure down, rolls
  highlights off with an ACES-fit shoulder, encodes sRGB, and adds half a level of
  *fixed* dither so a smooth sky does not band.
* **The noise table.** Every scene is built from noise. Hashing four lattice
  corners per octave was most of what a 3D scene cost, so the corners are
  generated once, in JS, from a fixed seed (`noiseTexture()`, 256 x 256 bytes,
  four to a texel) and a scene reads a cell with one `texelFetch`. Nothing is
  fetched and no picture is sampled — it is a table of random numbers.

Two disciplines run through all of it. **Footprint:** every texture is finer than
the pixel it is drawn to somewhere, so each is faded out by how much of the world
one pixel covers (water ripples, brick relief, grass, rows in a field) rather than
sampled below its own wavelength; that is what keeps water from shimmering, and a
shimmer costs the encoder bits. **Silhouettes:** a ray-marched skyline is a
staircase unless the rays that *nearly* touched it are counted — the march keeps
the closest approach, a few golden-section steps refine it, and the pixel is the
land by that fraction.

### Looking at them

A shader that draws a world can pass every test and still be ugly, so there is a
way to look: `make scene-preview` loads `video-scenes.js` into a blank page,
draws each scene with the real shader (software GL is fine) and writes a PNG per
scene and a contact sheet to `scene-previews/` (gitignored), with the draw time.
Each picture is made the way a call makes it: the scene drawn into its small
buffer, redrawn `--frames` (24) times at one moment and resolved at the camera's
size (see *Sharp at the size it is shown*). Options go through `ARGS`: the
camera's size (`--size 1280x720`, the default; `--size 640x360 --long 384` for a
phone, `360x640` upright), a moment (`--time 80`), a look
(`--look '{"exposure":0.25}'` for the evening, `'{"dirX":-0.8,"sideMix":0}'` for
the mirror) and `--person`, which draws a stand-in head and shoulders over the
middle of the frame — where a composition is actually judged. `--raw` shows one
redraw stretched instead (what shows if the resolve cannot compile),
`--resolve '{...}'` tries other resolve settings, and `--alpha` shows the
nearness channel instead of the colour. `--nobloom` shows a scene without its
bloom, `--scenes copy.js` draws from a copy of `video-scenes.js` (to try a
change, or to switch one layer off and see what it costs), and every picture
prints its mean luma, the share of crushed and clipped pixels, a 6 × 3 grid of
means and how much detail it holds, so a change that made it dark is a number as
well as a picture. `--view` takes any of `yaw`, `pitch`, `roll` (the others are 0). `--bits` also says what each scene costs
a video encoder, and `--still` holds the clock while it does, so what is left is
what the redraws themselves change. See the header of `scripts/scene-preview.mjs`.

### The light is yours

A few times a second (`LOOK_SAMPLE_MS`, 250 ms), in the segmentation callback
where a fresh mask is in hand, a 32-wide copy of the frame is read alongside the
mask and three things are measured (`VideoScenes.measureSubject()`):

* **Exposure** — your own brightness, on the confident core of the mask only.
  The scene is scaled to it in linear light, so a dim room gets a dim scene.
  Measured on you rather than the frame, because the frame's average is mostly
  the room the scene is about to replace. As your face drops below about three
  quarters of a well-lit one (exposure 0.62, fully at 0.28) the scene turns to
  **evening**: the sun sets over the island, the lamp comes on in the office and
  the town outside its window lights up, the mountain goes to the blue hour, the
  countryside to dusk. Light sources (a lamp, a screen, the sky through a window)
  are dimmed less than lit surfaces, as they are in a real dark room.
* **Direction** — the right half of your silhouette against the left. The side
  of your face that is brighter is the side your light is on, and the scene puts
  its window, its sun or its brightest lamp there. Each scene is authored with
  its light on the right and **mirrored** for a light on the left; when the side
  changes, both are drawn and crossfaded over about a second, so the room turns
  rather than jumps. The side only changes past `LOOK_SIDE_FLIP` (0.35) — a head
  turned toward a second screen must not walk the window across the room.
* **Tint** — gray-world over the whole frame. The webcam has already
  white-balanced, so what is left is the cast it could not remove (a warm lamp at
  night, blue screen glow). Only half of it is followed, each channel is clamped
  to 0.84–1.18, and it is renormalised to luminance 1 so it is a colour, never a
  brightness. Measuring the subject instead would have been wrong: skin is not
  grey, and the "illuminant" read off a face is mostly the face.

What is measured is a *target*; what is drawn eases toward it with a 1.4 s time
constant (`easeLook()`), so leaning toward the screen never makes the room
flicker. The first measurement is taken whole, or every call would open with the
room relighting itself.

### Your shadow, and the scene's light on you

The scene's **alpha channel** says how near each surface is — 1 for the wall a
metre behind you, 0 for the sky and the distant hills — and the composite reads
one more buffer, the **soft mask**: the finished mask shrunk to 64 wide and
blurred wide, rebuilt per inference in four draws on ~2,000 pixels.

* **Cast shadow** — the soft mask sampled *toward* the light (`shadowPlan()`):
  a shadow falls away from its light, so the point it darkens is lit by way of
  you. A light from your right throws your shadow left, onto the wall; from
  above, a little down. A strongly one-sided light is a hard light and gets the
  darker shadow; a frontal one barely casts any. Multiplied by the alpha, so the
  mountains never take one.
* **Contact shadow** — the soft mask where you are, very faint
  (`SHADOW_AO`, 12%): the darkening of a wall right behind a person that keeps
  them from looking pasted on, whatever the light.
* **Light wrap** — the scene's light, from a coarse mip level of the scene
  buffer, spilling onto the edge of your silhouette. Screen-blended in linear
  light, so it only ever *adds* light: the café's neon tints your shoulder, a
  bright sky rims your hair, a dark wall never dirties you. Fades in from the
  edge over the soft mask's width; the middle of you is untouched.
* **Harmonisation and a lit side** — beyond the rim: the scene's colour is let into
  your mid-tones, your blacks are lifted towards the scene's own black level, and
  across the body the side towards the scene's key light is a little brighter and
  takes its colour while the far side falls to ambient (none of it for a frontal
  light). The scene's grain follows the camera too: more of it, with colour noise,
  as the measured exposure drops. Everything scales with the scene's `wrap`.

### Interactions

How much the mask moved between two samples is the scene's **motion** input. It
rises at once and settles over a couple of seconds, like air. The things near
you answer it: dust in the office's sunbeam is pushed away from you and swirls,
the fig's leaves stir, steam over the café cup bends, the palm's fronds and the
countryside's grass and flowers move more. All of it is a few millimetres of
screen — an acknowledgement, not an animation.

### Quiet on purpose

Every scene is a backdrop to a working call. Its motion is slow and small, and
there is a second reason for that beyond taste: **every pixel that changes is a
pixel the video encoder spends bits on**, for everyone receiving you. So:

* the scene is redrawn at 20 Hz or less (`SCENE_HZ`, and the scene's own `hz`),
  not at the camera's rate;
* nothing flashes — the neon breathes ±7%, the sea's swell is slow and its
  glitter sparse, the rain is a few drops sliding down, the palm sways a hair;
* `unit-video-scenes.spec.js` pins it: between two frames a second apart, the
  mean change is under 3 levels of 255 and under 5% of pixels change by more
  than 12. That is the scene's own motion; what the resolve adds to it, below,
  is pinned apart (a settled room changes by about a level per redraw).

### Sharp at the size it is shown

A scene is ray-marched into a small buffer (below), because each of its pixels
is a whole march, and a call shows it two to four times bigger than that.
Stretched, it was a soft room behind a sharp person, which is the first thing
that gives a virtual background away. (An earlier version blurred it further
on purpose, by distance, to save bits. It looked worse, and it is gone.)

So the buffer is never shown stretched. Each redraw looks through a slightly
different point of every one of its pixels (`JITTER`, 256 points of a Halton
sequence), and `resolveScene()` in `video-effects.js` adds what it saw to a
picture kept at the camera's own size (`RESOLVE_FRAG` in `video-scenes.js`).
Wherever the room holds still, which is nearly all of it nearly all the time,
a pixel of that picture is soon made of many looks at many points inside it,
and it holds detail the buffer never had: the marching cost of the small
buffer, the detail of one the camera's size. The scene is told that size
(`uDetail`), so the detail it draws is the picture's, not the buffer's.

* **How much a look counts** depends on how near it fell to the pixel's centre
  (`RESOLVE.sigma`, 0.6 of the picture's own pixels) and on how settled the
  picture is: the first looks count for a lot, so a new pick starts as the
  redraw itself (soft, never black) and sharpens within a second or two; later
  ones count for a small steady share (`RESOLVE.gain`, a tenth), so a settled
  picture changes by about a level with each redraw. At a quarter, a room frozen
  in time cost up to three quarters as much as a moving one (below), and
  `unit-video-scenes.spec.js` now holds a settled room to that level. 256
  points rather than 16: with few, a pixel is always looked at from the same
  side and an edge comes out dotted.
* **What moves is not added up.** The redraw and the picture so far are
  compared through the same small blur, at the very points the redraw looked
  at, so the detail only the picture has is not taken for movement. Where they
  differ by more than the local contrast explains, the redraw wins, and that
  part shows as the soft frame it is — the way a camera smears what moves.
  Brightness, colour and nearness are judged apart: nearness jumps at every edge
  that is not a colour edge, and a relight can warm the room without making it
  brighter (`uTint` is luminance 1). Colour gets a wider tolerance
  (`RESOLVE.tolColour`) than brightness, because a march's grain can sit in one
  channel: judged channel by channel, a frozen room churned half as much again.
  `unit-video-scenes.spec.js` moves a bar and checks that three redraws later
  nothing is left where it was, and warms a wall and checks the picture follows
  within two, each with a control that lags when its test is switched off.
* **Once per redraw, never per camera frame**: one pass at the camera's size,
  nine texel reads and ten filtered reads a pixel, ten to fifteen times a
  second, into one of two buffers that take turns (`texSceneOut`). They are
  allocated with the scene's, never for blur or an image. The light wrap still
  reads a coarse mip of the small buffer (`uSceneEnv`), which is what it wants.
  A resolve that will not compile leaves the scene stretched rather than
  falling back to the blur.

Detail costs the encoder something, and it is worth knowing what. `make
scene-preview ARGS='--bits --person'` encodes four seconds of each scene, as a
1280 x 720 camera shows it, at its own redraw rate through VP9 at a fixed
quantizer (32), so the bytes are the picture's difficulty and nothing else.
Before is the stretched buffer through the old distance blur; after is the
resolve. The last column holds the clock (`--still`): a room frozen in time,
where all that is left to pay for is what the redraws themselves change:

| Scene | Keyframe, before → after | Motion, before → after | Frozen in time |
|---|---|---|---|
| Office | 14.9 → 17.8 KB | 33 → 39 kb/s | 14 kb/s |
| Island | 18.6 → 29.5 KB | 97 → 167 kb/s | 72 kb/s |
| Cyber café | 18.6 → 28.2 KB | 40 → 85 kb/s | 52 kb/s |
| Mountain | 14.0 → 20.2 KB | 76 → 90 kb/s | 55 kb/s |
| Countryside | 15.5 → 22.9 KB | 28 → 34 kb/s | 22 kb/s |

The first version of the resolve, with a steady share of a quarter and
brightness alone judged, cost 47 / 237 / 143 / 117 / 46 kb/s moving and
20 / 148 / 109 / 79 / 31 frozen.

Measured on a software GPU with the stand-in subject (the encoder does not care
which GPU drew the picture). Compare rows with each other, never with a call's
bandwidth: a call's encoder works to `CAMERA_MAX_BITRATE`, so there the cost is
bits the encoder cannot spend on the person — which no call has measured yet.
Detail that holds still is paid for once, in a keyframe; what moves is paid for
in every frame. So is what the redraws still change in a frozen room, which is
a third to two thirds of each bill. That is probably the jitter's last trace on
detail finer than the small buffer (one redraw catches a thin line, the next
misses it, and the movement test takes that for movement) and the clouds' grain
averaging out; the two have not been measured apart. If that ever shows on the
person, calm what moves, or hold the scene still, before blurring anything: the
blur bought the bits back with the whole picture.

The per-pixel offsets that break up a march's slices (the clouds, the office's
sunbeam) change with each `JITTER` point too (`SEED`), so the added-up frames
average them away. Fixed, as they are for a single frame, they came out as grain
in the clouds once nothing blurred them.

### What moves is as sharp as one redraw

The resolve adds redraws up only where nothing changed. A palm in the breeze,
the water's edge, a cloud's rim: those pixels fall back to the single redraw
(`moved` above), so they are exactly as sharp as the small buffer is. That is
the "standard definition" look in a call, and `make scene-preview ARGS='island
--live'` shows it (the clock runs between redraws, as in a call; without
`--live` the picture is a frozen moment, which is the best case and hides it).
So on a GPU the buffer **starts at the picture's own size**, phone or computer
(`sceneScaleLadder()`): the engine's scenes are multisampled (8 samples on a
computer, 4 on a phone, `quality.samples` in `src/scenes/engine.js`) and cost
1.2–3.3 ms a redraw at 1280x720 on an Apple M5, so nothing is gained by drawing
them smaller where the device can afford it. The rungs below are `SCENE_SCALE`
(`[2.25, 1.5, 1]` x `SCENE_LONG` on a computer, `[2, 1.25, 1]` on a phone), so
a 720p picture's ladder is `[2.5, 2.25, 1.5, 1]`. The governor walks it down in
its own step: segmentation first, then the buffer one rung at a time
(reallocated; the picture starts over), then the scene's redraw rate, then it
gives up. The ladder belongs to the processor, so picking another scene does
not undo a step that the device has already shown it needs.

A **software rasteriser** (SwiftShader in a VM or a blocklisted driver, and the
tests) draws on the CPU the call also needs: there the scene starts where it
always did, at `SCENE_SCALE_SOFT` (`[1.5, 1]`, `[1.25, 1]` on a phone) and the
catalogue's `res`, without multisampling. `window.__voxalSceneHardware` lets a
test take the GPU path anyway.

**Full HD** (Settings → Video → *Full HD video*, desktop only, off by default,
`video-resolution` = `fhd`). The effect canvas is the camera's size, so a Full
HD picture starts with the capture: `cameraCaptureCap()` asks for 1920x1080 and
`cameraMaxBitrate()` lifts the per-listener cap to 2.5 Mbps (the room-size
`scaleResolutionDownBy` still applies on top). The scene ladder follows the
picture (`sceneScaleLadder()`): its own size at the top, so `[3.75, 2.25, 1.5,
1]` for 1920 (on a software rasteriser, about 0.6 of its long side: `[2.25,
1.5, 1]`), stepped down by the same governor. Switching it restarts a running
camera: the canvas is sized once from the capture (`initGL()`), so there is no
live swap. It is the dearest setting on the page: segmentation, the scene and
the encoder all work on 2.25x the pixels.

### Scene light

By default a scene is lit to match you: exposure from your brightness, tint from
the room's cast, and a dim enough room turns it to evening (above). Settings →
Video → **Scene light** (`scene-light`, `VideoEffects.SCENE_LIGHT_KEY`) can
choose instead: a fixed time of day (`morning`, `midday`, `afternoon`,
`evening`, `night`: `VideoScenes.LIGHTS`), `clock` (the local hour, blended
between those lights by `lightAtHour()`: night until 05:30, morning 07:30–10:00,
mid-day 12:30–14:30, afternoon 17:00, evening 19:30, night from 21:30), or
`screen` (the page in light mode is the middle of the day, in dark mode the
evening — `data-theme`, or the system's when it follows it). A web page cannot
read the screen's brightness itself; that would take native code per platform.

Only the look's **exposure and tint** are chosen; the light's side and hardness,
and where you are, still come from the camera. `Processor.fixLight()` writes them
into `lookTarget` after every measurement and before every redraw, so the look a
keyed peer is offered is the chosen one and the protocol needs nothing new. The
first time, before the camera has measured anything, the look is taken whole
(a pick never fades in from the default day); a change mid-call eases in like
any change of light. A keyed receiver has no `fixLight()`: it draws the sender's
light. The preview draws the chosen light too (a neutral day for *match my
room*), and its full window has a copy of the select.

### Cost, and the step-down

The scene is drawn into its buffer (the picture's own size on a GPU, see above;
`SCENE_LONG` x a rung on a software rasteriser) and resolved up to the camera's
size (above). Each scene says how often it should be redrawn (`hz`, with the
rate it falls to under load) and how much of the buffer its ray-marched
fallback needs (`res`; an engine scene ignores it on a GPU):

| Scene | `res` | `hz` | Why |
|---|---|---|---|
| Office | 0.85 | 12 → 6 | objects marched inside bounding boxes; little moves |
| Island | 0.80 | 10 → 5 | sea, caustics, clouds, the palm's triangles |
| Cyber café | 1.00 | 15 → 8 | cheap: planes, a few objects, 2D drops |
| Mountain | 0.70 | 10 → 5 | two terrain marches (the view and the lake's mirror) |
| Countryside | 0.80 | 10 → 5 | a terrain march, a tree, a farm, fields |

The ray-marched scenes are the most expensive thing the page draws; the resolve
is what lets their buffers stay this small. The buffer is reallocated when a pick
changes the size, and a new scene starts at the top of its own ladder and its
picture starts over. Its buffers — the scene, its mips, the two pictures at the
camera's size (about 7 MB at 1280 x 720, 2 MB at a phone's 640 x 360), the soft
mask — are allocated the first time a scene is picked and never for blur or an
image, the same rule that makes **off** free. Under load the scene is redrawn
less often, and a still room takes that much longer to sharpen.

Under load, the existing ladder runs first (segmentation steps down), then the
scene's buffer steps down its rungs to `SCENE_LONG`, then the scene drops to
the lower rate of its own ladder, and only then does the effect give up.

Picking a scene compiles its shader, once per scene per camera. The compile goes
through `KHR_parallel_shader_compile` where the driver has it, and whatever was
showing keeps showing until the new program is ready — a shader with loops can
take a visible moment to compile on ANGLE over Direct3D, and a pick must never
freeze the call's video.

### The chips

Each chip shows a gradient swatch (`swatch` in the catalogue) at once, then a
**thumbnail rendered from the scene's own shader** at the moment the live scene
starts from (`THUMB_TIME`), so the chip is the picture you get. All six render
in one small offscreen WebGL2 context that is released as soon as they are done,
and only once the chip row is actually on screen (an `IntersectionObserver`):
every page renders its pickers at load, inside a popover or a settings card that
may never be opened. Even then they wait a beat (`THUMB_DELAY_MS`) — the person
who opened the row is reaching for a chip — and where the driver cannot compile
off the page's thread (no `KHR_parallel_shader_compile`: a software GPU) each
shader is compiled in a task of its own, so five compiles never freeze the page
together. A *software* GPU (SwiftShader, llvmpipe — `VideoScenes.isSoftwareGL()`
reads the renderer string) skips the thumbnails altogether and keeps the
swatches: five ray-marched compiles would cost it seconds of a frozen page for a
chip nobody was waiting on. A test that wants the thumbnails anyway sets
`window.__voxalThumbsOnSoftwareGL`.

### From the image presets

The four bundled images (Aurora, Dusk, Studio, Linen) are gone. A stored
`preset:aurora` / `dusk` / `studio` / `linen` reads as the nearest scene —
mountain, island, office, countryside — rather than silently turning the effect
off (`VideoScenes.LEGACY`).

### Not measured on a real room

Like the fixed-camera reference, the lighting thresholds (`LOOK_DIR_GAIN`,
`LOOK_SIDE_FLIP`, the exposure curve, the tint clamp) and the shadow's reach and
strength are reasoned from how webcams light a face, and checked against
synthetic subjects in `unit-video-scenes.spec.js`. Expect them to want tuning
against a real webcam in a real room.

## Keyed sending and receiving

**Let others draw my scene** (`send-subject-only`, on unless switched off). A scene is
generated from a handful of numbers, so it does not have to cross the network at
all. With a scene picked and this setting on, a peer whose device can draw the
scene is sent a picture of you over flat key green instead of the finished
composite, cuts you out again, and puts you over its own render of the same
scene. A flat field costs an encoder next to nothing.

### What it saves, and what it does not

Offline, through VP9 at a fixed quantizer at 1280 x 720, with a moving stand-in
subject at 30 fps (so the bytes are the picture's difficulty and nothing else),
the composite over the scenes cost 130–287 kb/s and the person over green
96 kb/s: 26–67% fewer bits for the same quality.

A call does not run at a fixed quantizer. Its encoder spends whatever cap it is
given, so what a call actually saves is the **lower cap a keyed sender gets**
(`keyedVideoBitrate()` in `main.js`): three quarters of the camera cap on the
desktop and plain mobile tiers, set near libwebrtc's resolution steps so it
buys bits rather than a smaller picture, and nothing taken from the frugal tier,
which is already as low as a face survives. The flat field is what lets the
person keep their quality under it. Neither half has been measured on a real
call. And it is mesh-only, so on the default routing it applies in two-person
rooms (see [video routing](video-routing.md#keyed-camera-is-mesh-only)).

### The keyed frame

The same composite program draws it, behind `uKeyOut`, because the keyed alpha
must be **exactly** the composite's `m`, smoothstep and fixed-camera reference
included; a second program would drift from the first the first time either was
tuned.

* **Key** — pure green, `(0, 255, 0)`, in encoded sRGB, the space the composite
  already mixes in. `mix(K, camera, m)` here and `c + (bg − K)(1 − a)` at the far
  end are the composite's own `mix(bg, camera, m)` taken apart and put back.
* **Floor** — below `KEY_ALPHA_FLOOR` (0.06) the alpha is cut to pure key, so the
  faint tail of the room never leaves the device.
* **No wrap, no shadow, no scene** — the camera colour is taken before the light
  wrap: the receiver wraps with its own scene's light, and a frame wrapped here
  would be wrapped twice.
* **Markers** — two squares at the top corners, a tenth of the *short* side
  (`KEY_MARKER`, so a portrait frame is not notched across a sixth of its width).
  Top-left all key; top-right a key ring around a **black** patch. Black because
  luma contrast is what 4:2:0 keeps at full resolution, and what a starved
  encoder keeps longest. The subject is cut in both.
* **No alpha channel.** A band of the mask packed into the frame cost about
  60 kb/s, so the receiver derives the alpha from the colour instead.

### When the sender holds back

The keyed output belongs to the published pipeline only: every call in the
public API names the stream (`localVideoStream`), so the settings preview never
grows one. It is a 2D canvas filled by copying the GL canvas **between two draws
in the same task** — keyed first, copied out, then the composite drawn over it —
so the GL canvas, and every peer on the composite, ends the frame exactly as it
always did. With `preserveDrawingBuffer` off the back buffer only holds the
keyed frame until the task ends, which is why the copy is right there. It is
drawn only while `main.js` says some sender reads it (`setKeyedDemand()`), and
rising demand draws one at once, so a sender switched onto it never meets an
idle canvas.

When keying is **withheld**, the keyed canvas carries the plain composite with
no markers; every receiver passes that through, so nobody needs a track swap:

| Reason | While |
|---|---|
| `mode`, `compiling` | no scene is drawn: blur, an image, or the scene still compiling |
| `green` | more than 4% of your confident core is green, until under 2% for 5 s — green clothing would be cut through |
| `corner` | you cover more than 15% of a marker zone, until under 5% for 2 s — a head there would come out with a square notch of scene in it |
| `slow-copy` | the median of the first 30 copies is over 4 ms — where the 2D canvas is not GPU-backed the copy is a synchronous read-back, paid out of the pipeline's own budget |
| `self-check` | the first keyed frame, read back, is not key at the top-left and black at the top-right — for the pipeline's life |

`keyedState()` is what an offer is made of: the scene (null while withheld),
the reason, the size, the look and `edgeE` (below). A new scene, reason, size
or light side is news at once; the look drifting, at most every 2 s, since each
announcement is a message to every peer; nothing while a camera flip rebuilds
the context.

### The receiving end

A device advertises `keyed-video-1` when `canKeyIn()`: WebGL2, a capturable
canvas, a Chromium engine (the receive path — an off-DOM remote `<video>`
driving `requestVideoFrameCallback`, a captured GL canvas — is verified there
and nowhere else yet), and a **hardware** GPU, since every keyed peer is a scene
ray-marched on this device (`VideoScenes.isSoftwareGL()`, which also knows
Windows' own rasteriser). Never in a tiny embed. It is a capability, not a
preference: receiving costs nothing until somebody offers a keyed picture, so
it does not wait on a setting the native apps do not even show.

`keyIn()` gives each keyed sender a `KeyInProcessor`, handed out only once it
has proved itself: frames flowing, the scene compiled, a self-test (the GPU's
upload of a frame against a 2D probe of the same frame, then a keyed and an
unmarked synthetic frame through the real passes) and 30 warm-up frames with a
median draw under 6 ms. Running, a rolling median over 8 ms for five seconds is
a give-up. The scene is drawn in high definition — its buffer at the top of the
ladder (the canvas's own size on a GPU, phone or not; `SCENE_SCALE_MAX`, ~1152
long, on a software rasteriser) — and over either budget it first steps down
(`KEYIN_SCENE_SCALE`: 2.25x, then 1.5x — 1.25x on a phone — then `SCENE_LONG`),
the warm-up restarting
its count each time; only at the bottom does a miss give up. Every frame:

* **Is it keyed?** The shader asks, from a few taps in each zone, so an unkeyed
  frame is passed through untouched on the very frame it arrives and the tile
  never changes source. **Strict** (top-left key, top-right ring key, patch
  dark) while this receiver has no reason to expect keyed frames, so an
  ordinary picture with a green corner is never cut up; **relaxed** (top-left
  key, patch not key) while it has acked the current offer, or saw a strict
  frame in the last 500 ms. On a starved link the patch's chroma settles frames
  after the flat green does, and the strict test alone passed those frames
  through as a full-screen green flash.
* **The key as it decoded.** Limited-range YUV, a matrix mismatch and 4:2:0 move
  green off `(0, 255, 0)`, so the key `kd` is read from the top-left taps and
  the alpha is how far a pixel is from it: `a0 = 1 − e(c) / e(kd)`, with
  `e(x) = g − max(r, b)`.
* **The edge.** A face is redder than green, so `a0 = m · (1 − e(camera))` runs
  ahead of the true `m` at your outline. The sender measures how green its own
  edge is (`edgeE`, the median `e(camera)` over its band, never above 0) and the
  receiver divides it back out, but only within about 10 px of background
  (`KEYIN_BAND_REACH`); further in, the alpha is 1 and the pixel is the frame's
  own. Then `c + (bg − kd)(1 − a)`, with leftover green taken out of partly
  keyed pixels and the scene's light wrapped onto the outline as the composite
  does it.
* **The scene and its light come from the offer**: the scene id, and the look
  whole — exposure, white balance and the light's side can only be measured
  where the room still is. Only where you are in the picture is measured here,
  from the key. The scene is drawn in passthrough too, so its picture stays
  settled and what the receiver pays then is what it pays keyed. A new scene
  compiles while the old one keeps drawing; one that will not compile keeps the
  old and stands down.
* **The canvas is the sender's size** (from the offer, capped at 1280 x 720),
  not the arriving frames', which climb through two or three sizes in a call's
  first twenty seconds. Only a new shape resizes it, and never its context.

Measured on a synthetic person (`unit-video-keyin.spec.js`), as colour error in
the edge band against the sender's own composite: a mean of 6.9 levels and a
p95 of 13.0 with no codec, 12.5 and 27.2 through VP8 at 450 kb/s and
640 x 360 (Chromium 141; Chromium 156's encoder gave a p95 of 32 on the same
code, so only the no-codec number pins the formula). The first formula tried
scored a p95 of 36 and 42 — and looked fine when only its alpha was scored,
which is why the test scores colour. The markers
were found in 50 of 50 frames through VP8 at 320 x 180 and 96 kb/s, and at
160 x 90 and 38 kb/s; a switch from the composite to keyed at 60–112 kb/s
showed no key-coloured frame.

A `KeyInProcessor` is never mistaken for the user's own pipeline. It is never
`_active`, never reports through the overload hook (that turns the user's OWN
background off), never loads the segmentation runtime, and never sees the
empty-room picture.

### The handshake

Who is sent what is `main.js`'s; the messages are in the table at the top of it
(`PROTOCOL_VERSION` 4) and in [architecture](architecture.md#data-protocol-summary).

1. Every peer says what it can do: `caps` in `hello`, relayed in `peer-list`.
2. A sender whose offer is live — the setting on, the camera shared through a
   running pipeline, over the mesh, and somebody here capable — broadcasts it:
   `video-keyed { offer: { epoch, scene, look, edgeE, size } }`. It is computed
   from live state every time, never cached.
3. A receiver with a free slot starts a cut-out and, once it runs, answers
   `video-keyed-ready { ok: true, call, epoch, scene }`, naming the mesh call
   (its `connectionId`, which PeerJS gives both ends), the offer's epoch and the
   scene it has compiled.
4. The sender moves that one call onto the keyed track with `replaceTrack` (no
   renegotiation), and keeps it there only while the ack names the call, epoch
   and scene it has now.

The rules that keep a green frame off everybody's screen, each pinned by
`unit-video-keyed-wiring.spec.js`:

* **Every new call starts on the composite**, and an ack names its call and
  epoch, so nothing acked before a camera restart, a re-call or a migration can
  key what comes after.
* **Level-triggered.** Acks are repeated every 10 s and forgotten after 25 s,
  `hello` carries the offer to every new host, and the offer is recomputed on
  every roster tick, so a message lost in a migration heals instead of sticking.
* **Back first, then say so.** A peer's sender goes back to the composite before
  the offer it was keyed for changes or goes. A receiver that said `ok: false`
  lets go of its cut-out only once it sees an unkeyed frame, never on a timeout;
  keyed frames with no cut-out to take them show a placeholder
  (`displayVideoStreamFor()`), never the raw picture.
* **Scene → blur → scene costs nothing.** The offer's scene goes null, the keyed
  track carries the plain composite, and the cut-out passes it through with its
  scene still compiled: no `replaceTrack`, no tile flash, no recompile.
* **One queue.** Every `replaceTrack` on a video sender (background swaps, a
  flip, the keyed reconcile) runs through `queueVideoSenderMutation()`, and a
  sender that cannot be moved off the keyed track is closed and called again on
  the composite rather than left on a track about to end.

Receiving is bounded. Slots are capped and sticky — three on a desktop, one on a
phone, none on a phone drawing its own scene or set to save battery — and go to
the focused tile, then the grid, then the ribbon. A hidden tile keeps its slot
and stops drawing. A cut-out that gives up is never revived; the same scene on
the same stream is tried again after 30 s, then 2 min, then not this session.
And when the user's own pipeline falls behind, it asks first (`onPressure`):
the newest cut-out gives way before its own detection rate steps down.

**Every WebGL context is released** with `WEBGL_lose_context` when it is done
with. Chromium force-loses the oldest context once a page holds more than 16,
and after a few cut-outs have come and gone the oldest is the user's own camera
pipeline: its captured track stays live and the picture freezes for every peer.
The pipeline also listens for `webglcontextlost` and gives up out loud — the
background goes off and the peers get the plain camera — rather than freeze.

The switch alone says nothing about whether it is doing anything, and in a
default room of three, or with blur picked, it is not. `keyedStatus()` decides,
and two lines say it. Under the switch in Settings, every state ("In use for 1
of 2 people", "Not in use: video goes through the relay in this room"). In the
background popover of a call, only while it is in use, in words that say what
it means ("2 of 3 people draw this scene on their own device; the others see
your usual picture.", `keyedPopoverText()`), with an (i) whose tooltip says the
rest: a call is not told about a feature that is doing nothing.

**Not verified**: receiving on WebKit (Safari, every iOS browser, the iOS app —
`canKeyIn()` says no there), a sender encoding H.264 (Playwright's Chromium
cannot), the bitrate share and the receiver's cost on a real call. See
`KNOWLEDGE/todos.md`.

### Filling the tile

A keyed picture is drawn on the receiver, so it has no edge of its own. When the
tile showing it is a different shape from the picture (a landscape tile for a
portrait phone, say), `main.js` tells the receiver the tile's shape
(`syncKeyedStageShape()` → `handle.setStageAspect()`, debounced) and the output
canvas takes that shape: the person stays whole in the middle
(`KeyInProcessor.fit()` / `uFit` in `FRAG_KEYIN`) and the scene continues past
the picture where the tile would otherwise show black bars. The matte, soft mask
and subject geometry stay in the picture's own shape; only the scene and the
output are the tile's. It is applied only once the handle is out, so the
self-test reads a canvas of the picture's shape.

## The room turns with the phone

On a phone, an animated scene is a room that stays where it was while the
picture moves over it. `src/device-tilt.js` reads `deviceorientation`, takes
the camera's rotation since a baseline pose, and hands it to the scene shader as
`uView` (`VideoScenes.viewMatrix()`): the scene's rays are turned by it
**before** each scene's own fixed pitch (`camRay()`). A pure rotation moves every
depth by the same amount, so the real person in the frame and the scene slide
together with no parallax to fake. Translation (walking, leaning) is not
measured: double-integrating an accelerometer drifts inside a second.

* **Mobile only** (`IS_MOBILE_DEVICE`), on by default, switched off in Settings →
  Video → *Move the background with my phone* (`background-tilt`, `'off'` stored,
  absence = on). The card is hidden everywhere else. Only `index.html` has it —
  `settings.html` is the desktop window.
* **The rotation is built, not the angles used.** The three Euler angles are
  turned into a matrix first: an upright phone, which is how a selfie is held,
  sits next to the angles' singularity, where alpha and gamma swing while the
  rotation barely moves. The result is decomposed as `Ry(yaw) Rx(pitch) Rz(roll)`
  (`VideoScenes.decomposeView()`), small angles only.
* **Camera and screen.** The front camera looks the other way and its frame is
  not mirrored (only the self-view is), so its image-right is the screen's left;
  the screen's own rotation (`screen.orientation.angle`) is folded in; a flip
  starts from a new baseline (`DeviceTilt.setFacing()`).
* **A baseline that follows you.** It eases toward the phone with a 7 s time
  constant, so a posture you settle into becomes straight ahead again and the
  room never drifts into the far corner of its own walls; a quick turn is
  followed in full. The angles go through a soft limit (28° yaw, 14° pitch, 7°
  roll — linear to 60 %, then rolled off) that stays inside what the keyed
  frame can carry.
* **A mirrored room** (the light is on the left) is drawn by un-mirroring the
  screen ray, turning it and mirroring it again (`viewFwd()` / `viewInv()` in the
  header, `MIR` set by `shade()`), so a turn to the right moves the room left
  whichever side the sun is on. Things drawn in the picture's plane rather than
  the world (the countryside's foreground grass, the chimney's smoke via
  `toScreen()`) follow it through `viewShift()` / `viewInv()`.
* **iOS asks.** `DeviceOrientationEvent.requestPermission()` only from a user
  gesture, and the one that picked the scene is long gone by the time the camera
  is up — so `armTiltGesture()` asks on the first tap while the sensor is wanted
  but silent. `NSMotionUsageDescription` is in `Info.plist` (a native-shell
  change: it ships with a store build, the rest is OTA). Where no event ever
  arrives `DeviceTilt.ready()` stays false and nothing changes.
* **Moving costs.** While the phone moves, the resolve pass's own motion test
  fires (the redraw and the history differ) and the picture is the soft redraw
  for those frames, sharp again when the phone is still; the encoder pays for
  the motion, as it does for any. Not done: re-projecting the history by the
  rotation, which would keep it sharp throughout.

### Carried to the people who draw your scene

With *Let others draw my scene* a receiver draws the room itself, from an offer
sent at most once a second — no way to say "the phone is turning" at 20 Hz, and
every message between two non-hosts rides the host. So the turn travels **in the
frame**, which also makes it exactly synchronous with the person it belongs to.

* **The strip.** 32 black-or-white cells along the top edge between the two
  marker zones, half a zone tall (`KEY_TILT`). Luma only, for the patch's reason.
  Cell 0 white and cell 1 black (the key green is neither); then yaw 9 bits,
  pitch 9, roll 6 — each the angle's share of its range (±32°, ±16°, ±8°) — and a
  6-bit XOR of the data's four 6-bit groups (`tiltSum()`), which catches any one
  flipped cell. Quantum: 0.125° yaw, 0.06° pitch, 0.25° roll.
* **Only when everybody can read it.** The sender draws the strip only while
  the sensor is flowing **and** every peer that could be keyed advertises
  `keyed-tilt-1` (`keyedTiltOk()`); the keyed track is one picture for all of
  them, and a receiver without it would show the cells across the top. An
  older keyable peer takes the strip away from everyone.
* **The offer says so.** `keyedOffer.tilt`, and a change of it is a **new epoch**
  — acks name their epoch, so nobody is on the keyed track for a frame format they
  have not applied. The receiver reserves the strip (it is a zone: cut and drawn
  as scene) only when its offer says `tilt`; `inZone()` reads `uTiltStrip`.
* **Reading it.** The receiver samples the strip into a 32x1 canvas at the
  cells' centres (`readTilt()`), only when the scene is about to be redrawn
  (`sceneDue()`, at most 20 a second — never for a frame the scene would not
  use). A frame that does not decode keeps the last turn for half a second, then
  eases back to a still camera, so a composite passing through (keying held
  back) never leaves a room frozen at an angle.
* **Not measured:** the strip through a real encoder at starved bitrates. Cells
  are 4–5 px wide on the smallest portrait frame; if a real call shows misreads,
  the check rejects them (the room holds its last turn) and the fix is fewer,
  wider cells.

## The room turns with the hand, and can be looked at alone

A computer has no motion sensor, so the same turn comes from the hand; a phone
has both.
`VideoEffects.attachOrbit(el, opts)` is the one implementation, used twice.

* **On your own picture, in a call** (`wireBackgroundOrbit()` in `main.js`, from
  `_buildVideoTile()`): drag the self-view and the room follows the hand,
  double-click to recentre. It publishes the same `{ yaw, pitch, roll }` as the
  sensor, through the same `setTilt()`, so every local pipeline and the keyed
  frame's tilt strip take it unchanged. Not the minimised self-view badge (its drag
  moves the badge), and only with an animated scene on. On a phone a finger
  does it too (`touch: IS_MOBILE_DEVICE`; the tile takes `.orbit-touch`,
  `touch-action: none`, only while a scene runs) and the drag is **added** to
  the sensor's turn (`applyBackgroundTurn()`, clamped to `DeviceTilt.LIMIT`):
  the hand moves the room from wherever the phone has it. A tap still toggles
  the room's chrome, since a drag's click is swallowed.
* **The sign is the room following the hand.** Positive yaw is the camera turned
  right (the room slides left, as when a phone is turned that way), so pulling the
  picture right is a *smaller* yaw; pulling down is a larger pitch. The self-view is
  shown mirrored and the published frame is not, so a mirrored tile reverses yaw
  (`opts.mirrored`). The first version had the sign backwards — judge a change here
  with a picture (`renderScenePreview` and the arrow keys make that cheap), not by
  reading the matrix.
* **The range is the phone's** (`ORBIT_LIMIT`, 28° / 14°, inside `KEY_TILT`): a
  turn beyond what the strip carries would be drawn here and clipped for everyone
  who draws the scene themselves, and what you set must be what they see. Past
  60% of the limit it rolls off (`tanh`) rather than stopping.
* **The strip follows whether a turn has *ever* been made, not whether the picture
  is turned now** (`_backgroundOrbitEngaged`, read by `backgroundTiltFlowing()` next
  to `DeviceTilt.ready()`). `keyedOffer.tilt` flipping is a new epoch for every
  receiver, so a recentre must not flip it. It is dropped when the scene or camera
  goes (`syncBackgroundOrbit()`, run from `syncBackgroundTilt()`).
* **A drag is not a click.** Capture starts only after `ORBIT_SLOP` (4 px), and the
  click that ends a drag is swallowed (capture phase, expires on its own), so it
  never pins the tile.

**The scene on its own** (Settings → Video → *Preview*,
`VideoEffects.renderScenePreview()`, in both `settings.html` and the in-page
modal): the chosen scene drawn alone, no camera, no person, no segmentation, at
~20 fps with the same drag, arrow keys (Home recentres) and double-click (two taps
on a phone) to recentre. Its full-window button (an icon) puts it over the whole
window at the window's shape, with an icon to close it at the top left and, at
the top right, the scenes alone (`renderPicker({ scenesOnly: true })`, one click
each, applied through the caller's `onPick`) and the scene light under them. It
is a single-sample draw (no jitter accumulation: it is for judging a room and
trying the look-around, not for measuring sharpness) with a neutral light and the
subject box put below the picture so there is no shadow to explain.

* It runs **only while on screen** (`IntersectionObserver` + `visibilitychange`),
  and its WebGL context is released the moment it stops: Settings is also open
  over a running call, and a page holds only a handful of contexts.
* It follows the mode written **in its own window** through
  `VideoEffects.onModeWritten()` (a `storage` event never fires in the writer) and
  in the other window through `storage`.
* Software GL (`VideoScenes.isSoftwareGL()`) is refused with a sentence, like the
  thumbnails: compiling a scene there freezes the page for seconds. Tests lift it
  with `window.__voxalThumbsOnSoftwareGL`.
* `webglcontextlost` from its *own* `release()` arrives after a newer canvas may
  stand in its place; the handler checks it is still the current one.

## Switching backgrounds does not touch the wire

This is the property the design exists to protect.

Once the camera is wrapped, **the published track is the canvas**, and the
canvas does not change when the background does. Blur → image → another image is
a texture swap inside a fragment shader: no `replaceTrack`, no renegotiation, no
tile teardown on anyone else's screen. Only crossing the **off ↔ on** boundary
swaps a track, and even then it is a `replaceTrack` on the existing senders
(`localVideoSenders()` in `main.js`, which already covers both the mesh and the
SFU publish connection) rather than a republish.

Switching between scenes is the same non-event: a compile the first time, a
different program after that, and the same canvas track throughout.

Peers on the keyed track keep it too. A scene change is a new offer, which the
far end compiles while it keeps drawing the old scene; blur or an image puts
the plain composite on the keyed canvas, which the far end passes through. Only
the off ↔ on crossing moves a keyed sender, and `swapLocalVideoTrack()` gives
each sender its own track: the keyed one to a peer that still qualifies, the new
picture to everyone else.

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

The keyed track ends with its pipeline. A sender still on it when the pipeline
stops would freeze on a track that says "ended", so `stopStreamTracks()` closes
any such call first, and turning the effect off moves keyed senders to the raw
camera before it stops anything. A receiver's cut-out stops only its own canvas
tracks, never the remote ones, which belong to the call.

## When a device can't keep up

Segmentation on a phone is real work, and a call that degrades into a slideshow
is worse than no effect at all. The pipeline measures its achieved frame rate
over rolling five-second windows and, when it falls below 60% of the camera's
rate:

1. if this device is drawing other people's scenes for them, asks `main.js` to
   stop the newest of those first (`onPressure`) and holds that window against
   nothing of its own — the user's own background is the last thing to pay for
   somebody else's; then
2. steps segmentation down the ladder the `detection-quality` preference chose
   (by default 15 → 10 → 6 Hz on desktop, 10 → 6 Hz on mobile), since that is
   where nearly all the cost is; then
3. with an animated scene, redraws the scene at 10 Hz instead of 20; then
4. having run out of things to trade, gives up: the raw camera goes back on the
   wire, the preference is set to `off`, and the user is told once.

Degradation happens quietly. Only giving up is announced, and it is announced
rather than left to look like a broken camera.

## Where the assets come from

| Asset | Size | Shipped how |
|---|---|---|
| `vision_bundle.mjs`, `vision_wasm_internal.{js,wasm}` | ~12 MB | **Not committed.** Staged out of `node_modules` by `seg-assets.sh`, which `make seg-assets`, the desktop build targets and the Vercel deploy (`vercel-build.sh`) all call. Bundled into the desktop app; fetched lazily on mobile. |
| `selfie_segmenter_landscape.tflite` | 250 KB | Committed to `src/assets/seg/`, bundled into the apps. |
| The scenes | 0 bytes of assets | Shaders in `src/video-scenes.js`. There is no background artwork at all. |

Twelve megabytes of WASM in every App Store and Play download, for a feature
most people never switch on, is not a trade worth making — so `make cap-sync`
deletes `assets/seg/vision_*` from the iOS and Android bundles after syncing.
The model stays bundled: it is small, and keeping it local saves a round-trip.

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
- **Capacitor** — `https://web.voxal.app/assets/seg/`, overridable with
  `localStorage['seg-assets-url']` for self-hosters and tests. This fetch is
  cross-origin from `capacitor://localhost`, which is why `vercel.json` sets
  `Access-Control-Allow-Origin: *` on `/assets/seg/(.*)`. That path is also
  served `immutable` with a one-year max-age, and the binary is additionally
  kept in CacheStorage (`voxal-seg-v1`) and handed to MediaPipe as a blob URL,
  so it is downloaded once per device rather than once per launch.

> **`web.voxal.app`, not `voxal.app`.** The static site is served from
> `web.voxal.app` — the same host `DEFAULT_ANON_TURN_URL` and the SFU endpoints
> point at. (It was `ptt.voxal.app` until that name lost its DNS record; a host
> that does not resolve fails exactly as loudly as the wrong host does, which is
> to say not at all.)
> `presenceBase()` / `localStorage['service-url']` is the *presence
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
None · Blur · Office · Island · Cyber café · Mountain · Countryside · +
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
drifting copies. Six controls sit beneath it in the same card and follow the
same rule — `renderSubjectOnly()` (**Let others draw my scene**, right under the
picker's hint), `renderStrength()` and `renderSharpness()` (one slider builder,
two sets of arithmetic), `renderQuality()`, `renderLightAdapt()` and
`renderReference()` (the three switches are one builder, `renderToggle()`). In
the desktop preferences window (`settings.html`) all seven are write-only: that
window has no module system and therefore no capture pipeline, so it writes the
preference and the main window's `storage` listener applies it to the running
processor — the same bridge the noise-suppression and microphone-device
selectors use. The keyed switch is the one exception to "applies it to the
processor": what it changes is which track each peer is sent, so the main
window answers it with `refreshKeyedSend()`, never `applyVideoBackground()`.
Its live status line (`#settings-subject-only-status`, from `keyedStatus()`) is
in the main window's settings only, with a matching line in the background
popover (`#video-bg-subject-only`); the preferences window holds no call to
report on. The Video card, this switch with it, is hidden in the native phone
apps.

## Looking at the cutout: the segmentation diagnostic

*"A piece of the room stays sharp around me, even when I sit still."* Between the
model and the screen there are five places that could be responsible: the model's
own mask, the resize/reading of it, the temporal blend, the dilate / feather /
smoothstep, and the composite. Tuning any of them before knowing which one is
guesswork — every stage erodes or grows the subject, so a change in the wrong
one just moves the problem. The diagnostic shows each stage's output for the
**same inference**, side by side.

**Open it** (it is off, and costs one boolean test per frame, until you do):

- `?segdiag=1` on the page's URL (web / PWA — the way to do it on an iPhone), or
- `localStorage['seg-diagnostic'] = '1'` then reload (Tauri, Capacitor), or
- `VideoEffects.openDiagnostic('stages')` in the console.

It opens a panel with a mode selector, *Freeze* (hold the last inference so you
can study it or take a screenshot), *Save PNG*, *Hide* (shrinks it to a small
"Seg" chip — on a phone the panel is otherwise over the room's own mic and camera
buttons — and it takes no pictures while hidden) and ✕ (closes it and frees what
it made). `VideoEffects.closeDiagnostic()` does the same. The panel is opaque,
sized to the *visible* screen (`dvh`, safe areas) and keeps its control bar
sticky at the top, so the buttons stay reachable on a phone.

| View | What it is |
|---|---|
| **A** original | The camera frame, untouched |
| **A′** model input | What the segmenter was actually handed: the 256-wide downscale, brightened in a dim room (`light-adapt`) |
| **B** raw mask | `confidenceMasks[0].getAsUint8Array()` before anything touched it. Grey scale: white = person, black = background, greys = the model's uncertainty. Each model texel is a visible square (no interpolation) |
| **C1** blended | After the temporal blend (grows 0.85 / shrinks 0.20 per inference) |
| **C2** dilated | After the 3-texel max filter |
| **C3** feathered | After the feather blur — what the composite is given |
| **C4** matte used | The composite shader's own `m`: smoothstep window + empty-room reference + hair refinement, i.e. the alpha it actually mixes with |
| **D** final | The composite |
| stability map | Where the raw mask kept changing between successive inferences (bright = changing) |
| *grid* / *stages* | A B C3 D in 2x2, or B C1 C2 C3 C4 D in 3x2, of one inference |

"Tint the visible band red" paints, on the mask views, the values the composite
lets through as a *partial* picture (the smoothstep window, 12–78% by default).
That is the quickest way to see which grey texels in B are the ones that show up
as background fragments in D.

### The confidence cut

The first real capture (a phone selfie) put the fragments in **B**: a lamp above
the head at a median 48% confidence and a shoulder rim at 62%, both inside the
composite's 12–78% window, which therefore showed them at roughly half strength
or more. Neither a threshold nor the edge slider could have fixed that without
also cutting hair (the hair edge read a median 41%, the same as the lamp): the
model cannot tell them apart.

So the raw mask is now cut before anything else touches it (`MASK_CUT`, in
`FRAG_MASK_MIX`): a value **at or below 78% is background**, outright; above
78% it ramps to fully person over the next 6%. 78% is the top of the old window,
i.e. exactly the band the diagnostic paints red on the raw mask — *everything in
red is masked*. The blend, dilate, feather and window then work on that cleaner
mask, so C1–C4 show the cut and **B stays the model's own, uncut mask** (that is
what keeps the diagnostic honest).

The price: genuinely uncertain edges — fine hair, a blurred hand — are 40–70%
and go with the rest. A clean 0/255 mask is unchanged (pinned byte for byte).
To compare on a device without a console: `?maskcut=0` turns the cut off and
`?maskcut=0.6` moves it (also `window.__voxalMaskCut`); the panel prints the
value in use. Verified only on synthetic masks and one synthetic figure through
the real model; the effect on a real face is for your eyes.

### Why the comparison can be trusted

- **No extra inference.** It reads the mask the one existing `segmentForVideo()`
  call already returned. MediaPipe's callback form returns synchronously
  (documented in `vision.d.ts`: *"The method returns synchronously once the
  callback returns"*), so the camera frame `draw()` uploads right after is the
  frame that inference saw. That is checked, not assumed: the panel prints the
  video clock's skew between the two reads (it was 0.0 ms on the real model).
- **Same inference everywhere.** Panes are drawn only on the frame that follows
  an inference, from that inference's textures. C2 is copied out of the work
  texture before the feather overwrites it. C4 is the composite shader printing
  its own `m` (`uDbg`) — there is no second copy of the maths to drift.
- **The published frame does not change.** The panes are drawn into the
  processor's canvas, copied to the panel's 2D canvas in the same task (the keyed
  frame's trick), and then the real composite is drawn over the whole canvas.
  `unit-seg-diagnostic.spec.js` pins this byte for byte, with a baseline taken
  *before* the panel is opened (`uDbg` lives in the program, so a baseline taken
  after closing would hide a leak).
- **No console spam.** One line per opening (mask shape, label list, input size).
- **GL objects** (one program, three mask-sized textures) are created on first
  use and deleted on close, on a context rebuild (a turned phone) and with the
  processor.

### The numbers

Under the picture, per inference (moving average over ~5): the inference rate,
the mask shape and count, the label list (`["selfie"]` for the model we ship), the
share of pixels that are *person* (>= 50%) and *mid-confidence* (inside the
smoothstep window), and, against the previous inference, the **mean |delta|**,
the share of pixels that changed by more than 10%, and the share that **crossed
50%**. Sitting still, that last one should be close to 0.

### Reading it: which stage first shows the fragment

Freeze on an inference where the fragment is visible, open *stages*, and find the
**first** pane that has it. Every claim below is a hypothesis to confirm with
the pane named, not a finding — none has been verified against a real person
on a real camera (see the end of this section).

1. **Already in B (raw mask).** The model. Look at A′ first: is the downscale
   aliased or dark, is the subject/background contrast low, is it the same
   fragment frame after frame (stability map dark there = the model is *consistently*
   wrong, a limit of a 256x144 input and of this model) or does it come and go
   (the next case)? Levers that are not the model: the quality of the
   downscale (`segCtx.drawImage()` leaves `imageSmoothingQuality` at its default,
   `low`; I expect that to alias on a 5x reduction but have not measured it —
   A′ shows what it produces), light, and the empty-room reference for a fixed
   camera. Changing the model is a separate decision.
2. **B clean, a fragment appears in a later pane.** The stage that introduces it
   is the culprit:
   - *C1*: the **temporal blend**. It grows 0.85 and shrinks 0.20, so a texel
     the model fires on for a single inference is held up for several afterwards
     (a ratchet toward "person" on noisy input, by construction). If
     B flickers there (stability map bright, "crossing 50%" > 0) this is the
     mechanism, and sitting still does not help because the noise is in the
     input (sensor, auto-exposure, compression), not in your movement.
   - *C2*: the **dilate** grows any isolated texel by 3 texels (about 15 px of a
     1280-wide picture), speckle included.
   - *C3*: the **feather** spreads a small blob into a soft one.
   - *C4*: the **smoothstep window** (`lo` 0.12) keeps a visible share of any
     value above 12%, and the **hair refinement** pulls in neighbours whose
     colour matches. To test the second cheaply: `window.__voxalNoHairRefine = true`.
3. **C4 clean, D not.** The composite: orientation, the decontamination, the
   mix. Also check that the "fragment" is not simply the *blurred* room: in blur
   mode the room behind you is meant to be visible, soft.
4. **B changes while you sit still.** Read the stability numbers. On a still
   synthetic image through the real model the deltas were exactly 0, so a still
   *person* that flickers points at the camera input (noise, exposure,
   compression) rather than the model's determinism — a prediction to check with
   the numbers on your camera, not a result.
5. **Several are possible** (a weak value in B, then grown by C2 and kept by C4):
   the stage that shows it *first* is necessary but may not be sufficient. To
   separate them, change one thing at a time **after** isolating (`edge-sharpness`
   moves feather, window and dilate together; the temporal weights and the
   window are constants) and watch the same pane.

If the screenshots were taken of the *remote* tile, rather than the sender's own
panel, video compression can add block artifacts of its own; compare with the
sender's D pane.

### What is, and is not, tested

Automated (`tests/e2e/unit-seg-diagnostic.spec.js`, MediaPipe stubbed with a
hard-edged oval, GL passes real): panel off by default; `?segdiag=1`; one ingest
per inference; each pane reads the right texture and is upright; the dilated pane
really is pre-feather; the published frame is byte-identical (four views); the
stability arithmetic; close frees every texture and the program, repeatedly; no
per-frame logging. Run once by hand against the **real** model on a synthetic
head-and-shoulders scene: it returns one mask, label `selfie`, 256x144, and the
panes line up.

**Not** tested, and needing your eyes in a real browser on a real camera: how the
real model's confidences look on you, which stage first shows *your* fragments,
and iPhone behaviour (the panel is plain DOM and WebGL2 ops already used by the
pipeline; it has not been run on a device).

## Key files

| File | What it holds |
|---|---|
| `src/video-effects.js` | The whole pipeline, the shaders (generated from `gaussianHalfKernel`), the mode/strength/sharpness/accuracy/low-light/keyed storage, the picker and the controls under it; the keyed output (`keyedTrack()`, `setKeyedDemand()`, `keyedState()`) and the receiving end (`canKeyIn()`, `KeyInProcessor` behind `keyIn()`, the CPU-only `keyProbe()`) |
| `src/device-tilt.js` | The phone's turn for the scene's camera: `deviceorientation` -> a rotation since a slowly following baseline -> yaw/pitch/roll, per camera and screen rotation |
| `src/video-scenes.js` | The six animated scenes (one shader each), measuring how you are lit (`measureSubject()` / `lookFromStats()` / `easeLook()`), the async compile and the chip thumbnails |
| `src/main.js` | `maybeApplyVideoEffects()`, `applyVideoBackground()`, `swapLocalVideoTrack()`, the unwrap in `stopStreamTracks()`, the effects branches in `flipCamera()` and `setLocalCameraSuspended()`, the tile button in `_buildVideoTile()`, and `positionVideoBackgroundPopover()` / `renderVideoBackgroundProgress()`. The keyed camera: `localCaps()`, `currentOffer()`, `keyedFor()`, `refreshKeyedSend()` and the reconcile behind `queueVideoSenderMutation()`, the receivers (`reconcileKeyedReceivers()`, `displayVideoStreamFor()`), `keyedStatus()`, and `keyedVideoBitrate()` |
| `tests/e2e/unit-video-effects.spec.js` | Coverage, with inference stubbed via `window.__voxalSegStub` |
| `tests/e2e/unit-seg-diagnostic.spec.js` | The segmentation diagnostic: panes, orientation, byte-identical published frame, stability numbers, GL cleanup |
| `tests/e2e/unit-video-scenes.spec.js` | The scenes: every one renders, moves only a little, mirrors to the light; the measurement; shadow, light wrap and motion through the real pipeline |
| `tests/e2e/unit-video-keyed.spec.js` | The keyed frame, pixel for pixel, and every guard that withholds it |
| `tests/e2e/unit-video-keyin.spec.js` | The receiving end: the round trip, detection, staying out of the user's own pipeline, and the codec round trips through VP8 (band colour error, starved markers, the switch) |
| `tests/e2e/unit-background-tilt.spec.js` | The room turning with the phone: the strip codec, the view matrix, the sensor's algebra on synthetic events, the sender drawing the strip, a receiver reading it |
| `tests/e2e/unit-video-keyed-wiring.spec.js` | `main.js`: the protocol, which peer gets which track, the receiver's lifecycle, `keyedStatus()` |
| `tests/e2e/mesh-keyed.spec.js` | `@mesh`: four real peers, a green watchdog on every receiver through keying on, scene changes, blur, the setting, the camera and the host leaving |
