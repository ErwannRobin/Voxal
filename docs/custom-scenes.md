# Your own virtual backgrounds

Voxal's animated backgrounds are 3D scenes drawn on your device. Besides the
six built-in scenes, you can add your own in two ways, from **Settings →
Video → Background**, with the cube chip (⬡):

| You have | Voxal makes |
|---|---|
| a **360° photo** (a panorama twice as wide as it is tall) | a scene you stand inside: it turns with your phone, or when you drag the preview |
| a **3D model** as a glTF binary (`.glb`) | a 3D room or place, seen through the model's own camera, lit, shadowed, animated |

And, as before, the **+** chip uses a flat picture as a still background.

A scene you add:

* **stays on this device.** The file is kept in the browser's storage
  (IndexedDB), never uploaded. It is not synced to your other devices.
* **is sent as your picture.** People you call see you in front of it as
  video, like with blur or a flat picture. *Let others draw my scene* does not
  apply to it: nobody else has the file.
* **is never run, only read.** A picture is decoded by the browser; a model is
  parsed by Three.js's glTF loader. Nothing inside a file can execute code in
  Voxal.
* **can be removed** with the ✕ on its chip. If it was the background in use,
  the background falls back to blur.

You can keep up to 12 scenes of your own.

## A 360° photo

Any **equirectangular** panorama works: a picture whose width is twice its
height (1.8:1 to 2.2:1 is accepted), covering 360° around and 180° from top to
bottom. Most phones make one in their camera app's *Panorama* or *Photo Sphere*
mode, so do 360° cameras (Insta360, Ricoh Theta), and every 3D tool can render
one.

* **Size:** up to 8192 × 4096 is kept (bigger pictures are scaled down, and a
  phone whose GPU allows less scales it again). 4096 × 2048 is already sharp
  behind a person at 720p.
* **Format:** JPEG, PNG or WebP. It is stored as a JPEG.
* **What you see first** is the middle of the picture. To start somewhere
  else, turn the preview (drag it, or swipe sideways on a phone) and press
  **Keep this view**: that becomes the panorama's own starting direction. A
  turn is limited to about 28° each way at a time; keep a view, then turn
  again from there.
* **Light:** the picture is shown as it is in a well-lit room. In a dim room,
  or with *Scene light* set to an evening or the night, it darkens and warms or
  cools with it. A photograph has no evening of its own: it never lights its
  lamps the way the built-in scenes do.
* **Good panoramas** have the interesting part to the sides and something calm
  in the middle (you sit in front of it): a window or a view to one side, a
  plain wall or distant landscape straight ahead. Avoid text: it can't be
  mirrored, and Voxal never mirrors a panorama.

A picture that is not 2:1 is refused with a message; use **+** for a flat
picture instead.

## A 3D model (`.glb`)

Export your scene as **glTF 2.0 binary** (`.glb`). In **Blender**: *File →
Export → glTF 2.0*, format *glTF Binary (.glb)*, and tick:

* **Include → Cameras** and **Punctual Lights**;
* **Data → Mesh → Apply Modifiers**;
* **Animation** if you want things to move (see below);
* leave **Compression** (Draco) **off**: compressed geometry and textures
  (Draco, Meshopt, KTX2/Basis) cannot be read.

What Voxal does with the file:

* **The camera.** Voxal looks through the file's **first perspective camera**.
  Put it where your eye would be: about 1.2 m above the floor, looking at the
  wall behind you, with the interesting things to the sides and the space
  behind your head calm. Its vertical field of view is used (about 50° is a
  webcam's). An upright phone sees more above and below, and a turn of the
  phone (or a drag) looks around from there. Without a camera, the model is
  framed whole from the front, as a product shot, which suits an object more
  than a room.
* **Units:** metres, Y up (Blender's export converts its Z-up for you).
* **Lights.** The file's lights are used as they are (*Punctual Lights*: sun,
  point, spot). Suns and spots cast shadows. Without any, Voxal adds a sky
  (seen through any opening) and a sun from the upper right. Either way, the
  sky's light fills the shadows a little.
* **Materials:** glTF's PBR materials (base colour, metal/roughness, normal,
  emissive maps), and unlit ones. An **emissive** surface glows and keeps its
  glow in a dark room: that is how to make a lamp, a screen or a neon sign.
* **Your shadow.** Surfaces nearer than 3 m take your soft shadow, as in the
  built-in rooms; farther ones fade from 3 m to 30 m.
* **Animation.** Every animation in the file plays, looped, from the scene's
  own clock. Keep motion slow and small, and away from the middle: everything
  that moves is something the video encoder pays for, every second of your
  call.
* **Size:** up to 64 MB. Lighter is better: a phone has to build it, and a
  model is drawn several times a second. A room of a few hundred thousand
  triangles and 2K textures is plenty.
* **Never mirrored.** The built-in scenes put their window on the side your
  light comes from by mirroring the picture. A model, like a photo, may have
  lettering, so it is always shown as authored.

A file that cannot be read or drawn is refused with a message: Voxal draws a
new scene once, off screen, before keeping it. That drawing is its thumbnail.

To try the feature without a model of your own:

```sh
node scripts/custom-scene-sample.mjs scene-previews/sample-room.glb
```

writes a small room (walls, a cabinet, a lamp, a plant, a turning cube, a
camera and two lights) as a `.glb` built by hand. It is also a compact
example of everything above.

## What it costs

Under the preview, Settings shows what the chosen scene costs. For a scene of
your own, the upload is *not measured*: it depends on the file. The cost on
your device is measured the same way as for the built-in scenes: one redraw
at a 720p call's size, timed. A still panorama costs very little to send. A
model with fine detail or moving parts costs more, like the built-in island's
water. In a call, *In your call now* shows what your camera is actually
sending.

## For developers: a scene in the catalogue

A scene everyone gets, and that keyed peers can draw themselves, is code, not a
file. It is an ES module in `src/scenes/<id>.js` built with the scene engine's
kit, plus an entry in the catalogue in `src/video-scenes.js`. The engine, the
kit and the rules a scene must follow (deterministic, nothing finer than a
pixel, calm behind the head, slow motion, a night that is still a picture) are
in [`docs/scene-engine.md`](scene-engine.md). In short:

1. Write `src/scenes/<id>.js`: `export default { id, camera, nearness,
   build(k), update(k, state, t, look) }`.
2. Add `{ id, label, name, blurb, kbps, shadow, wrap, hz, module: true,
   swatch }` to `SCENES` in `src/video-scenes.js`. Measure `kbps` with
   `node scripts/scene-preview.mjs <id> --gpu --long 1280 --bits --person` and
   `--still`.
3. Look at it: `node scripts/scene-preview.mjs <id> --gpu --matrix`.
4. Run `tests/e2e/unit-video-scenes.spec.js` and `unit-scene-engine.spec.js`.

### How a custom scene is stored and drawn

| Piece | Where |
|---|---|
| The list (id `u-` + 8 hex digits, kind, name, size, thumbnail, options such as a panorama's `yaw` and `pitch`) | `localStorage['custom-scenes']`, read by `VideoScenes.customScenes()` in every window |
| The file | IndexedDB `voxal-bg` / `images`, key `scene:<id>` (next to the flat custom picture's `custom`) |
| Adding, removing, changing options | `VideoEffects.addCustomScene(file)`, `removeCustomScene(id)`, `updateCustomScene(id, changes)` |
| Parsing and the scene definition | `src/scenes/custom.js` (`load(meta)` → `{ id, camera, nearness, mirror: false, build, update }`) |
| The glTF loader | `src/assets/three/gltf-loader.min.js` (`make three-vendor`), imported only by `custom.js` |
| The mode | `video-background` = `preset:<id>`, like a built-in scene; `VideoScenes.byId()` answers with a catalogue entry marked `custom` |

A custom scene's catalogue entry has `custom: true`. The camera pipeline gives
it the keyed-stream reason `custom` (`keyedReason()`), so a keyed offer carries
no scene and the peer gets the composite. `main.js`'s *Let others draw my
scene* status says so ("a scene you added is sent as your picture").
