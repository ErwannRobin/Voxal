# Your background is a 3D world, and your friends' computers draw it

*Draft blog article. Facts about Voxal come from `docs/video-effects.md`, `docs/scene-engine.md`, `docs/custom-scenes.md` and `docs/benchmarks.md`. Competitor facts are sourced at the end and marked where unverified. See "Before publishing" at the bottom.*

---

## What it does (in 30 seconds)

In Voxal you can hide your room. Pick **None**, **Blur**, a picture of your own, or one of **six animated 3D scenes**: an office, an island lagoon, a cyber café, a mountain lake, the countryside, a rainy neon penthouse. You can also bring your own: a 360° photo or a 3D model (`.glb`).

Three things are different from the usual virtual background:

1. **The scenes are not videos or pictures. They are small 3D worlds drawn live on your device.** There is no artwork in the app at all.
2. **The world reacts to you.** It is lit like your room, it gets your shadow, and light wraps around your outline. On a phone, the scene turns when you turn the phone.
3. **Your friends' computers can draw your background for you.** Instead of sending a finished picture, Voxal can send just *you* over flat green. The other side redraws the scene behind you. A flat green field costs almost nothing to encode.

And it all stays on your device. No frame is sent to a server to compute a background.

---

## Why it is innovative

Most video tools treat a background as an image: cut out the person, paste them on a picture, send the result. This works, but it has limits. A picture cannot be relit. It does not move. It cannot be mirrored or turned. And once pasted, the picture is part of the video, so you pay to send it.

Voxal changes the idea: **a background is a program, not a picture.** A scene is generated from a few numbers (which scene, how bright, which side the light comes from). A program can be relit, animated, and moved. And a program does not need to travel over the network. Only its name does.

That one decision gives us:

| Because the scene is a program… | …we get |
|---|---|
| it is drawn from geometry and light | it can be **relit** to match your room, or a chosen time of day |
| it knows where you are | it can take **your shadow** and wrap its light on your edges |
| it has a camera | it can **turn with your phone**, or with your finger or mouse |
| it is only a name and a few numbers | the other side can **draw it themselves**, saving bandwidth |
| it is code, not artwork | **0 bytes** of background assets in the app |

---

## How it works

### 1. Everything happens on your device

```
camera
 └─ segmentation (finds you)       ← small ML model, WebAssembly
     └─ clean the edge (blend, soften)
         └─ scene drawn by the GPU (3D world, relit to your light)
             └─ composite: you over the scene, with your shadow
                 └─ the video that is sent
```

* **Finding you.** Voxal runs an ML segmentation model (MediaPipe, in WebAssembly). It runs on a *small copy* of the frame (256 pixels on the long side), about 10–15 times per second, while the picture is composed at 24–30 fps. Inference is the one expensive step, so it runs on a third to a half of the frames.
* **Smoothing.** Each new mask is blended with the previous one. Blending is asymmetric: it reacts fast when you move and settles slowly. That hides the skipped frames and stops the edge from crawling.
* **Blur.** It is done on a tiny fixed-size buffer (160 pixels), with a few widening Gaussian passes, then scaled up. This looks more like real lens blur than a full-size blur, and it costs the same on a 720p webcam and a 4K one.
* **The scene.** Each scene is a 3D world built with Three.js (vendored in the app, same WebGL context as the camera pipeline). The scene is drawn at a few frames per second and **several redraws are added together** (each with a tiny sub-pixel shift), so a still room becomes as sharp as the person in front of it.
* **Relight and shadow.** The pipeline measures how you are lit (four times per second) and sets the scene's exposure, tint and light direction to match. Your shadow falls on the scene's walls and floor. Scene light can also be set by hand: morning, midday, evening, night, local clock, or follow the screen's theme.

### 2. Cheap by design

* **Off costs nothing.** With no background, the camera is the raw stream. No canvas, no WebGL, no download, no processing.
* **Changing background does not touch the network.** Blur → image → scene is a change inside a shader. The outgoing video track stays the same, so nobody else in the call sees a reconnect or a flicker.
* **It protects itself.** If the device cannot keep up, Voxal steps down in order: first it helps other people's scenes less, then segmentation runs less often, then the scene redraws less often. Only as a last resort does it switch the effect off, and it tells you once.
* **Scenes are built to be quiet for the encoder.** Anything finer than a pixel is averaged out, because shimmer costs bits. A rule of the engine: mean change between frames one second apart must stay under 3/255.

### 3. Let others draw my scene (the bandwidth trick)

With an animated scene and a capable peer on a direct connection, Voxal sends that peer **you over flat green** (with two small corner markers) instead of the finished composite. The other side finds the markers, cuts you out, and draws *the same scene* from its name and a few numbers about your light. It also draws the scene's light onto your outline.

Measured offline (VP9, fixed quality, 1280×720, a moving stand-in subject, 30 fps): the composite over the scenes cost **130–287 kb/s**, the person over green **96 kb/s**. That is **26–67 % fewer bits** for the same quality.

Honest limits:

* In a real call the encoder spends whatever cap it is given, so the real saving is a **lower bitrate cap** for keyed senders (three quarters of the normal camera cap on desktop). **This has not been measured on a real call yet.**
* It only works for **direct (mesh) connections**, so with the default routing it applies in small rooms (two people). The relay always gets the finished picture.
* The receiver needs WebGL2, a Chromium engine and a real (hardware) GPU. Otherwise the sender simply keeps sending the finished picture.
* It is a safe fallback: if the sender is wearing green, or a head covers a marker, or anything looks wrong, Voxal sends the normal picture and nobody sees a glitch.

### 4. Privacy

The keyed picture goes only to peers on a direct connection, never through a relay. Anything fainter than a thin soft edge is cut to pure green before it leaves your machine. Your own scene files (panorama, `.glb`) never leave your device: nobody else has them, so a custom scene is sent as normal video.

---

## How it can be extended

### Add a scene (developers)

A scene is one small ES module in `src/scenes/`:

```js
export default {
  id: 'example',
  camera: { pos: [0, 1.2, 0], target: [0, 1.15, -3], fov: 50 },
  nearness: [1.0, 12.0],
  build(k)  { /* meshes, materials, a sky */ },
  update(k, st, t, look) { /* everything that moves is a function of t */ }
};
```

Then add it to the catalogue with `module: true`. A shared kit gives you sky and image-based light, water, terrain, windows, rain, glass, foliage and mirrors. The rules keep scenes friendly to people and encoders:

* **Deterministic.** Only a seeded random function; everything that moves depends on time. This is what lets a *remote* device rebuild the exact same world.
* **Nothing finer than a pixel.** Fine patterns fade into their average.
* **Calm behind the head.** Interest goes to the sides and corners. It must also work mirrored and cropped to 9:16.
* **Slow motion, readable at night, cheap to compile.**

### Bring your own (users)

From Settings → Video → Background:

* a **360° panorama** (any equirectangular photo, from a phone's Photo Sphere mode or a 360° camera). You stand inside it, and it turns with your phone or your finger.
* a **3D model** (`.glb` glTF binary, e.g. from Blender). Voxal uses the model's own camera, lights and animations.

Files stay on your device (IndexedDB), up to 12 scenes, never uploaded and never executed, only parsed.

### Natural next steps (ideas, not promises)

* Let custom scenes be keyed too (needs a way to share the file safely).
* Scenes made by the community, shared as `.glb` files.
* More lighting inputs: for example reading the real time of day or weather.
* Real-room tuning: the lighting thresholds and shadow strength are reasoned and tested on synthetic subjects. They are marked in the docs as needing tuning against real webcams.

---

## How it compares

The honest summary: **the "find the person" part is not unique to us.** Google Meet also runs MediaPipe models in the browser (WebAssembly + WebGL) and adapts to the device. The difference is what happens *after* the cut-out.

| | Voxal | Google Meet | Zoom | Microsoft Teams |
|---|---|---|---|---|
| Segmentation runs on your device | Yes | Yes (per Google's 2020 post) | Yes, and Zoom lists CPU requirements for it | Yes; Windows guides mention an AVX2 CPU |
| Needs a server to compute it | No | No | No | No |
| Blur | Yes, adjustable strength | Yes | Yes | Yes |
| Your own still image | Yes | Yes | Yes | Yes (JPEG/PNG/BMP, 360–2048 px per one guide) |
| Animated **3D** scenes relit to your room, with your shadow | **Yes (6 built in)** | Not found | Not found | Not found |
| Your own 360° photo or 3D model | **Yes** | Not found | Not found | Not found |
| Background sent as a few numbers instead of pixels | **Yes (direct connections, opt-out)** | No | No | No |
| App bytes for background artwork | **0** | n/a | n/a | n/a |
| Cost when disabled | Zero (raw camera) | n/a | n/a | n/a |

"Not found" means I did not find it in my searches, not that it is proven absent. Several of these products ship video backgrounds, and I could not verify the details. See the next section.

### Bandwidth

* **Competitors:** the background is part of the video. Zoom's published group-video guidance is roughly 1.0 / 0.6 Mbps (down/up) for "high quality", 2.6 / 1.8 for 720p and 3.8 / 3.0 for 1080p (Zoom Community post, April 2023). The background does not change these numbers: they are for video in general.
* **Voxal:** the same, **except** keyed senders, which may send **26–67 % fewer bits** in controlled tests, and a lower cap in real calls. Real-call savings: *not measured yet*.
* The comparison to quote is therefore *"a flat field costs an encoder almost nothing"*, not *"we use X % less bandwidth than Zoom"*. We have no head-to-head measurement against Zoom, Meet or Teams.

### Compute

* **Competitors:** all segment on the device. Zoom's virtual background without a green screen has a published CPU list (sources vary: for example 4+ cores on recent Intel, more on others). Meet adapts to the device. Teams needs AVX2 on Windows.
* **Voxal:** segmentation on a 256-pixel copy at 10–15 Hz, GPU compositing, scenes drawn on the GPU. Measured redraw of a scene at 1280×720: about **1.5–3 ms** on an Apple M5 (up to 8× multisampling). A software GPU is the slow case, so Voxal skips thumbnails and keyed drawing there.
* **Be careful with our own benchmark.** The multi-peer benchmark runs every peer in one browser on one machine, so the CPU number for a blur room (160 %) is a whole-room total, and it also records that the effect gave up on that machine. **Do not quote it as the cost of a background.** There is no clean per-user CPU figure yet.
* The extra cost of "Let others draw my scene" lands on the **receiver** (one scene drawn per keyed peer: up to 3 on desktop, 1 on a phone). Voxal gives that up first when the receiver's own camera needs the room.

---

## Before publishing (things I could not verify, sir)

1. **No head-to-head measurement** against Zoom, Meet or Teams. All competitor items come from web searches (sources below) and some pages were old or from universities. Check Zoom, Meet, Teams current docs, especially for video and animated backgrounds, before saying "they do not have it".
2. **Keyed saving in a real call is unmeasured.** Only the offline 26–67 % figure exists.
3. **Lighting and shadow tuning** were never tested on a real webcam in a real room (the docs say so).
4. **Cheap-GPU / phone numbers** are missing. All speed figures are from one Apple M5.
5. The six scenes: older text in `video-effects.md` says "five". Newer text says six. I used six.
6. Add screenshots or a short clip: office, island and neon rain would show the idea best.

## Sources

* Voxal docs: `docs/video-effects.md`, `docs/scene-engine.md`, `docs/custom-scenes.md`, `docs/benchmarks.md`
* [Background Features in Google Meet, Powered by Web ML (Google Research, 2020)](https://research.google/blog/background-features-in-google-meet-powered-by-web-ml/)
* [Zoom Community: virtual background](https://community.zoom.com/meetings-2/virtual-background-11682)
* [Zoom macOS virtual background minimum requirements (dev forum)](https://devforum.zoom.us/t/macos-virtual-background-minimum-requirements/15904.md)
* [Bandwidth requirements for Zoom (university IT page)](https://colum.teamdynamix.com/TDClient/2029/Portal/KB/Article/102394/Bandwidth-requirements-for-Zoom)
* [Teams custom backgrounds, Inception](https://www.inception.co.uk/knowledge-hub/how-to-add-a-custom-teams-background/)
* [Change Backgrounds in Teams (Adam the Automator)](https://adamtheautomator.com/change-background-teams)
