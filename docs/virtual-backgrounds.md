# Virtual backgrounds: technical overview

Status: describes the shipped behavior. Implementation details live in
[`video-effects.md`](video-effects.md), [`scene-engine.md`](scene-engine.md) and
[`custom-scenes.md`](custom-scenes.md); this page is the map between them.
Measurements are from [`benchmarks.md`](benchmarks.md) and the docs above.

## 1. Summary

Voxal replaces the room behind a person with one of: nothing, a blur, a flat
picture, one of six animated 3D scenes, or a user-supplied 360° panorama or
`.glb` model. Everything is computed on the sender's device. No frame goes to a
server.

What sets it apart from a "cut-out over a picture" design:

| Property | Mechanism |
|---|---|
| A background is a **program**, not an image | Scenes are Three.js code drawn live on the GPU; the app ships 0 bytes of background artwork |
| The scene is relit | The pipeline measures the subject's light and sets the scene's exposure, tint and light direction |
| The scene reacts to the subject | The subject's soft shadow falls on near surfaces; scene light wraps onto the subject's edge |
| The scene moves with the device | On phones, `DeviceTilt` turns the scene with the camera |
| The scene can be drawn by the receiver | **Keyed sending**: the sender transmits the person over flat green; the receiver draws the scene itself |

## 2. Scope

| Mode | Stored as `video-background` | Drawn by | Sent to peers as |
|---|---|---|---|
| Off | absent | nothing (raw camera stream) | camera video |
| Blur | `blur` | sender | composite |
| Flat picture | `custom` | sender | composite |
| Built-in scene | `preset:<id>` | sender (or receiver, if keyed) | composite or keyed |
| Custom scene | `preset:u-<8 hex>` | sender | composite (never keyed) |

Built-in scene ids: `office`, `island`, `cybercafe`, `mountain`, `countryside`,
and the neon-rain penthouse. Legacy image ids still resolve to the nearest scene
(`VideoScenes.LEGACY`).

## 3. Sender pipeline

Code: `src/video-effects.js` (pipeline), `src/video-scenes.js` (catalogue),
`src/scenes/` (engine and scene modules).

```
camera
 └─ segmentation        MediaPipe (WASM), on a 256 px copy, ~10-15 Hz
     └─ mask cleanup    asymmetric temporal blend, dilate, feather
         └─ scene       Three.js draw, relit to the subject (WebGL2)
             └─ composite   subject over scene, shadow, light wrap
                 └─ canvas.captureStream()  → the published track
```

### 3.1 Segmentation

- MediaPipe runs in WebAssembly on a 256 px copy of the frame, 10–15 times per
  second, while the picture is composed at the camera's rate (24–30 fps).
  Segmentation is the one expensive step, so it runs on a fraction of frames.
- The runtime (`src/assets/seg/`, ~12 MB) is not committed. It is staged by
  `make seg-assets`, served same-origin on web and desktop, and fetched lazily
  from `web.voxal.app` on mobile.
- Rate is a user preference (`detection-quality`: battery, balanced, high).
- In a dim or backlit room the segmenter's own copy is brightened
  (`light-adapt`). The published picture is not.

### 3.2 Mask cleanup

Each new mask is blended with the previous one, fast when the subject moves and
slow when it settles. This hides skipped frames and stops the edge from
crawling. Dilate, feather and smoothstep window are driven together by one
preference (`edge-sharpness`, via `_edgeProfile()`).

### 3.3 Blur

Blur runs on a fixed 160 px buffer with three widening horizontal and vertical
Gaussian passes, then scales up. Cost does not depend on the camera's
resolution. Strength is a uniform (`blur-strength`), so changing it never swaps
a track.

### 3.4 Scene drawing

- Each scene is a module in `src/scenes/<id>.js`, loaded with `import()` the
  first time it is drawn. The engine (`engine.js`) runs Three.js r186
  (vendored) on the pipeline's own WebGL2 context and renders into a half-float
  target. A scene that fails to load falls back to its original fragment shader
  in `video-scenes.js`.
- Each scene is drawn into a small buffer at its own rate (`hz`). Several
  redraws, each with a different sub-pixel jitter, are added together by a
  resolve pass, so a still room is as sharp as the person.
- A scene can request bloom (the neon-rain penthouse does).
- Output contract: display-referred rgb, with alpha = receiver × nearness,
  where nearness comes from depth. Nearness decides how much of the subject's
  shadow a surface takes.

### 3.5 Relight, shadow, light wrap

The pipeline measures how the subject is lit about four times per second and
passes it to the scene as `look` (exposure, tint, light side). `scene-light`
can replace the measurement: morning, midday, afternoon, evening, night, the
local clock, or the app theme. The chosen light is part of what a keyed peer is
offered, so the receiver reproduces it without any new protocol field.

### 3.6 Switching and load handling

- **Off costs nothing.** No canvas, no WebGL, no download, no processing.
- **Switching modes on the wire.** Blur ↔ picture ↔ scene is a shader uniform
  change. The outgoing track is replaced only when crossing off ↔ on.
  `applyVideoBackground(mode)` owns this.
- **Step-down under load.** The effect reduces its own work in order (other
  peers' scenes, then segmentation rate, then scene redraw rate) and gives up
  only as a last resort.

## 4. Scene engine and authoring

A scene is one ES module:

```js
export default {
  id: 'example',
  camera: { pos: [0, 1.2, 0], target: [0, 1.15, -3], fov: 50 },
  nearness: [1.0, 12.0],
  build(k)  { /* meshes, materials, a sky */ },
  update(k, st, t, look) { /* everything that moves is a function of t */ }
};
```

Registration: add `{ id, label, name, blurb, kbps, shadow, wrap, hz, module: true,
swatch }` to `SCENES` in `src/video-scenes.js`. The shared kit (`kit.js`) provides
sky and image-based light, planar mirror, terrain, facade windows, rain, glass
and foliage.

Rules every scene follows (and why):

| Rule | Reason |
|---|---|
| Deterministic: seeded `k.rng`, motion is a function of `t` | A receiver rebuilds the exact same world from a scene id and look |
| Nothing finer than a pixel | Shimmer costs encoder bits; budget is mean change under 3/255 between frames one second apart |
| Calm behind the head, interest at the sides, works mirrored and cropped to 9:16 | The subject sits in front of it |
| Slow motion, readable at night, ≤ 8 distinct programs | Encoder cost and shader compile time |

Procedure, previews and measurement scripts are in `scene-engine.md`. A scene
may read only what a keyed receiver can also know: the scene id, the look, and
where the person is as measured from the keyed picture.

## 5. User-supplied scenes

Settings → Video → Background (cube chip). Details in `custom-scenes.md`.

| Input | Result |
|---|---|
| Equirectangular panorama (aspect 1.8:1 to 2.2:1; JPEG, PNG or WebP; stored as JPEG; up to 8192×4096) | The subject stands inside it; it turns with the phone or a drag |
| glTF 2.0 binary `.glb` (up to 64 MB; no Draco, Meshopt or KTX2) | Rendered through the file's first perspective camera, with its lights, materials and animations |

- Stored in IndexedDB (`voxal-bg` / `images`, key `scene:<id>`); the list is in
  `localStorage['custom-scenes']`; maximum 12.
- Never uploaded, never executed, only parsed (browser image decoder,
  Three.js glTF loader).
- A model is drawn once off screen before it is kept. That drawing is the
  thumbnail, and a file that cannot be drawn is refused.
- Custom scenes are sent as composite video, never keyed (`keyedReason()` =
  `custom`).

## 6. Keyed sending ("Let others draw my scene")

Preference `send-subject-only` (on by default). It acts only with an animated
scene and a capable, acknowledged mesh peer.

### 6.1 Flow

1. Receiver advertises capability `keyed-video-1` (and `keyed-tilt-1`).
2. Sender offers `keyedOffer` (scene id, look, tilt flag, epoch).
3. Receiver acks `video-keyed-ready` for this call's `connectionId`, the
   current epoch and the current scene, within 25 s.
4. Sender moves that peer's video sender to the keyed track with
   `replaceTrack`, through `queueVideoSenderMutation()`.
5. Receiver (`KeyInProcessor`, `keyIn()`) finds the two corner markers, cuts the
   person out of the key green and draws the same scene behind them.

Protocol: `PROTOCOL_VERSION` 4; messages `caps`, `keyedOffer`, `video-keyed`,
`video-keyed-ready`. On a phone, tilt rides in the keyed frame as a 32-cell
luma strip along the top edge.

### 6.2 Properties

- Every new call starts on the composite. Only the keyed reconcile
  (`scheduleKeyedReconcile()`) moves a call, and only after the ack.
- **Mesh only.** A camera routed through the SFU is always the composite.
- **Safe fallback.** The sender keeps the composite and withholds the keyed
  track when: the mode is not keyable, the scene is compiling, the subject is
  wearing green, a corner marker is covered, the receiver's copy is slow, or
  the self-check fails (reasons: mode, compiling, green, corner, slow-copy,
  self-check).
- **Receiver requirements.** WebGL2, a Chromium engine, a hardware GPU. A
  software GPU is excluded (see 8.2). The receiver draws up to 3 scenes on
  desktop and 1 on a phone.
- **Privacy.** Keyed video goes only over direct connections, never through a
  relay. Anything fainter than a thin soft edge is cut to pure green before it
  leaves the sender.
- Receiver state lives in `_keyedReceivers`. `conn.remoteVideoStream` stays the
  raw incoming stream; tiles read `displayVideoStreamFor(peerId, conn)`.

## 7. Extension points

| Goal | Where | Notes |
|---|---|---|
| New built-in scene | `src/scenes/<id>.js` + `SCENES` entry | Section 4. Then `tests/e2e/unit-video-scenes.spec.js`, `unit-scene-engine.spec.js` |
| New shared scene primitive | `src/scenes/kit.js` | Keep deterministic |
| New user-scene input type | `src/scenes/custom.js`, `VideoEffects.addCustomScene()` | Must keep "parse, never execute" |
| Key custom scenes | Needs a safe way to share the file | Not implemented. A keyed peer today has no copy of a user's file |
| New scene light | `VideoScenes.chosenLight()`, `scene-light` | Only exposure and tint are chosen, so no protocol change |
| New preference | `video-effects.js` only | Declare keys once there (shared classic-script scope); mirror in `settings.html` through the shared script |

Any change under `src/` needs `make cap-sync` for the mobile bundles.

## 8. Performance

### 8.1 Bandwidth

Offline test: VP9, fixed quantizer, 1280×720, 30 fps, a moving stand-in
subject.

| Stream | Bitrate |
|---|---|
| Composite over the six scenes | 130–287 kb/s |
| Person over key green | 96 kb/s |

Difference: **26–67 % fewer bits** at equal quantizer.

In a call the encoder spends the cap it is given, so the saving appears as a
lower cap: `keyedVideoBitrate()` is 3/4 of the camera cap. **The real-call
saving has not been measured.**

Per-scene kb/s values shown in Settings are in the right-hand column of the
table in `scene-engine.md`.

### 8.2 Compute

| Item | Value | Source |
|---|---|---|
| Segmentation | 256 px copy, 10–15 Hz | `video-effects.md` |
| Blur | fixed 160 px buffer, any camera | `video-effects.md` |
| Scene redraw, 1280×720, Apple M5 | 1.2–1.9 ms (no samples), 1.5–2.6 ms (4), 2.0–3.3 ms (8) | `scene-engine.md` |
| Scene redraw, 720p, software GPU (SwiftShader) | about 116–270 ms | `scene-engine.md` |
| Extra cost of keyed sending | on the receiver: one scene per keyed peer | section 6 |

All timings are from one machine class (Apple M5) plus a software renderer.
There is no data for low-end GPUs or phones yet.

The multi-peer benchmark runs every peer in one browser on one machine, so its
CPU figures are whole-room totals (and its blur room records the effect giving
up on that machine). They are **not** the cost of a background and must not be
quoted as such. See `benchmarking.md`.

## 9. Comparison with other tools

The segmentation step is not unique to Voxal: Google Meet runs MediaPipe
models in the browser with WebAssembly and WebGL. The difference is what
happens after the cut-out. "Not found" means the feature was not found in
public documentation reviewed in October 2026; it is not proof of absence.

| | Voxal | Google Meet | Zoom | Microsoft Teams |
|---|---|---|---|---|
| Segmentation on the device | Yes | Yes | Yes (CPU requirements published) | Yes (AVX2 CPU on Windows, per one guide) |
| Server needed to compute it | No | No | No | No |
| Blur | Yes, adjustable | Yes | Yes | Yes |
| Own still image | Yes | Yes | Yes | Yes (JPEG, PNG, BMP) |
| Animated 3D scene, relit, with subject's shadow | Yes (6 built in) | Not found | Not found | Not found |
| Own 360° photo or `.glb` | Yes | Not found | Not found | Not found |
| Background sent as an id and a few numbers | Yes (direct connections) | No | No | No |
| App bytes for background artwork | 0 | n/a | n/a | n/a |

**Bandwidth.** In the other tools the background is part of the video, so it
is not a separate cost. Zoom's published group-video guidance (Zoom Community
post, April 2023) is about 1.0 / 0.6 Mbps down/up for high quality, 2.6 / 1.8
for 720p and 3.8 / 3.0 for 1080p. No head-to-head measurement against Zoom,
Meet or Teams exists, so no percentage against them is claimed. The supported
claim is narrower: a flat key-green field costs an encoder very little, and
Voxal can send that instead of the finished scene.

**Compute.** All four segment on the device. Zoom and Teams publish CPU
requirements; Meet adapts to the device. Voxal's GPU compositing and scene
cost are in section 8.2.

## 10. Known limits and open items

1. Keyed bandwidth saving is measured offline only (section 8.1).
2. Lighting, shadow and light-wrap thresholds are tuned on synthetic subjects;
   real-webcam tuning is outstanding.
3. Timings come from an Apple M5 and a software renderer. Low-end GPUs and
   phones are not covered.
4. Keyed sending is mesh-only, needs a hardware-GPU Chromium receiver, and does
   not apply to custom scenes.
5. No head-to-head benchmark against Zoom, Meet or Teams. Competitor entries
   come from public pages and may be out of date.
6. Screenshots of the office, island and neon-rain scenes are not yet included.

## 11. References

- Voxal: `video-effects.md`, `scene-engine.md`, `custom-scenes.md`,
  `benchmarks.md`, `benchmarking.md`, `video-routing.md`
- [Background Features in Google Meet, Powered by Web ML (Google Research, 2020)](https://research.google/blog/background-features-in-google-meet-powered-by-web-ml/)
- [Zoom Community: virtual background](https://community.zoom.com/meetings-2/virtual-background-11682)
- [Zoom macOS virtual background minimum requirements (Zoom dev forum)](https://devforum.zoom.us/t/macos-virtual-background-minimum-requirements/15904.md)
- [Bandwidth requirements for Zoom (university IT page)](https://colum.teamdynamix.com/TDClient/2029/Portal/KB/Article/102394/Bandwidth-requirements-for-Zoom)
- [Teams custom backgrounds (Inception)](https://www.inception.co.uk/knowledge-hub/how-to-add-a-custom-teams-background/)
- [Change Backgrounds in Teams (Adam the Automator)](https://adamtheautomator.com/change-background-teams)
