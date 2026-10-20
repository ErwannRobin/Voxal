// video-effects.js — background blur and virtual backgrounds for the camera.
//
// Loaded as a plain classic script by BOTH index.html and settings.html, the
// way net-usage.js is, so the two documents share one definition of the modes,
// the presets and the chip picker instead of hand-duplicating them. It must
// load *before* main.js, and *after* video-scenes.js — the presets are the
// animated scenes defined there.
//
// Everything lives inside one IIFE. In particular VIDEO_BACKGROUND_KEY is
// declared here and here only, and exposed as VideoEffects.STORAGE_KEY —
// classic scripts share one global lexical scope, so a second `const` of the
// same name in main.js would be a load-time SyntaxError.
//
// ---------------------------------------------------------------------------
// The pipeline, and why it is shaped this way
// ---------------------------------------------------------------------------
//
//   raw camera MediaStream
//     └─ <video> source (muted, playsinline, never in the DOM)
//          └─ requestVideoFrameCallback loop (rAF fallback)
//               ├─ [every Nth frame] ImageSegmenter.segmentForVideo()
//               │     → 256×144 confidence mask → uploaded as an R8 texture
//               └─ WebGL2 composite → canvas → captureStream() → the track we send
//
// Four things keep this cheap enough to run during a call:
//
//   * segmentation runs at 256×144 (the landscape selfie model's own input
//     size) and at 10–15 Hz, while compositing runs at the camera's frame rate.
//     Inference is the only expensive step and it runs a third of the time;
//   * the mask is smoothed temporally (mix with the previous mask), which both
//     kills edge flicker and is what makes the skipped frames invisible;
//   * the blur is a box downsample to a fixed 160-long buffer plus a few
//     widening H+V iterations of a separable 9-tap Gaussian — a handful of
//     draws on a tiny buffer, versus many times the work and a worse-looking
//     result at full resolution. It runs in linear light, which is what keeps
//     it from going grey. Its radius is one preference, `blur-strength`;
//   * the mask is feathered (blurred, then smoothstepped) before compositing.
//     Without this the segmentation's blockiness is plainly visible.
//
// The segmenter is given its OWN canvas, so MediaPipe's GL state changes can
// never disturb ours, and the mask crosses over as a Uint8Array. At 256×144
// that readback is 37 KB — far too small to matter, and far more robust across
// the five webviews Voxal ships on than sharing a context would be.

var VideoEffects = (function () {
  'use strict';

  // --- constants ------------------------------------------------------------

  var STORAGE_KEY = 'video-background';

  // Must equal the exact @mediapipe/tasks-vision version in package.json (a
  // test pins it). The loader .js and the .wasm are a matched pair, and the
  // filenames never change: without this in the URL and the cache name, a
  // browser that cached 1.1.0's binary pairs it with 1.1.1's loader and dies on
  // `wasmExports["eg"].value`.
  var SEG_RUNTIME_VERSION = '1.1.1';
  var CACHE_PREFIX = 'voxal-seg-';
  var CACHE_NAME  = CACHE_PREFIX + SEG_RUNTIME_VERSION;
  var MODEL_FILE  = 'selfie_segmenter_landscape.tflite';
  var WASM_LOADER = 'vision_wasm_internal.js';
  var WASM_BINARY = 'vision_wasm_internal.wasm';
  var BUNDLE_FILE = 'vision_bundle.mjs';
  var ASSET_DIR   = 'assets/seg/';

  // The mask's working resolution: the long side, with the short side derived
  // from the camera's actual aspect (see segSizeFor).
  //
  // This is not cosmetic. ImageSegmenter returns its mask at the dimensions of
  // the frame you hand it, NOT at the model's own input size — so feeding it
  // the raw video meant a 640x480 mask read back per inference (300 KB, not the
  // 37 KB a 256x144 mask would be) and then resampled into a hardcoded 16:9
  // buffer, crushing 480 rows into 144 and clipping the subject. Downscaling
  // the frame ourselves first fixes the readback cost and the geometry at once.
  var SEG_LONG = 256;

  // How far to expand the mask before feathering it, in mask pixels. The model
  // errs slightly inside the subject, the feather blur erodes a little more,
  // and a mask that lags the frame by a segmentation interval erodes it again
  // at exactly the moment you move. Three small erosions compound into a
  // visibly clipped face, so the pipeline deliberately errs outward instead.
  //
  // It also has to cover half of the composite's soft band, which now reaches
  // further inward than it used to — see MASK_EDGE_LO / MASK_EDGE_HI.
  var MASK_DILATE = 3;

  // Feather radius, in mask pixels, and the window the composite maps that
  // feather through.
  //
  // These two together are the whole "how hard is the cutout" control, and they
  // are easy to get wrong separately. The feather sets how wide the gradient
  // is; the smoothstep window decides how much of that gradient survives as a
  // visible transition. A narrow window on a wide gradient is still a hard
  // edge — it just throws the gradient away.
  //
  // The window is deliberately wide (it keeps ~70% of the ramp) and biased low,
  // so the soft band runs from about 3 mask pixels outside the dilated
  // silhouette to about 2 inside it. With MASK_DILATE in front of it, that band
  // sits wholly outside the real subject: a soft outline, not a bite out of an
  // ear.
  var MASK_FEATHER  = 1.4;
  var MASK_EDGE_LO  = 0.12;
  var MASK_EDGE_HI  = 0.78;

  // Those three are the MIDDLE of a slider, not a fixed truth.
  //
  // "How hard should the cutout be" is a matter of taste and of what is behind
  // you: a plain wall forgives a crisp edge, a cluttered room does not, and
  // curly hair against a bright window is a different problem again from a
  // shaved head against a door. So the tuned values above are what
  // `edge-sharpness` 0.5 produces, and the preference moves the whole profile
  // — feather, smoothstep window and dilate together, because moving one
  // without the others is exactly the mistake the MASK_FEATHER comment warns
  // about.
  //
  // Every one of the three is a shader uniform of a pass that already runs, so
  // this costs nothing to change mid-call and swaps no track.
  var SHARPNESS_KEY     = 'edge-sharpness';
  var SHARPNESS_DEFAULT = 0.5;

  // How far the ends reach, as a ratio against the midpoint. The feather moves
  // further than the window does: a wide window on a narrow feather is a hard
  // edge with a wasted uniform, so the window follows the gradient it is
  // mapping rather than leading it.
  var SHARP_FEATHER_RANGE = 2.0;
  var SHARP_WINDOW_RANGE  = 1.6;

  // The window keeps its centre and its low bias while it widens and narrows —
  // see the FRAG_COMPOSITE comment for why 0.45 rather than 0.5 — and the
  // dilate keeps the same relationship to the feather it has at the midpoint:
  // it must cover half the soft band plus the model's own inward bias.
  var MASK_EDGE_MID    = (MASK_EDGE_LO + MASK_EDGE_HI) / 2;
  var MASK_DILATE_BASE = MASK_DILATE - MASK_FEATHER;

  // HOW STRONG THE BLUR LOOKS IS ONE NUMBER: the Gaussian's sigma, as a
  // fraction of the frame's long side. Everything else is derived from it.
  //
  // Expressing it as a fraction of the frame rather than in pixels or in texels
  // is what makes it mean the same thing on every camera. At the 0.08 default a
  // 1280-wide frame gets sigma ~100 px — the room behind you is colour and
  // shape and nothing more.
  //
  // It is a preference (Settings → Advanced) rather than a constant because
  // "blurred enough" turned out to vary far more between people than any single
  // number could serve. The range is geometric, not linear: each step of the
  // slider is a constant *ratio*, which is how the eye reads blur.
  var STRENGTH_KEY      = 'blur-strength';
  var STRENGTH_DEFAULT  = 0.08;
  var STRENGTH_MIN      = 0.02;
  var STRENGTH_MAX      = 0.20;

  // The blur runs in a FIXED-size buffer rather than at a fraction of the
  // capture resolution, so a 1080p camera and a 720p one get the same-looking
  // blur and cost the same to blur. It is small on purpose: the strength is
  // relative to the frame, so shrinking this buys radius rather than spending
  // it, and the box downsample that fills it low-passes the frame first.
  var BLUR_LONG  = 160;
  var BLUR_SIGMA = 1.75;   // sigma of one 9-tap pass, in taps

  // Iterations of the separable pass, each with DOUBLE the previous stride.
  //
  // Successive Gaussians add variances, so N doubling iterations reach
  // sqrt((4^N - 1) / 3) times the radius of the first one — three of them are
  // worth 4.6x, which is how a 9-tap kernel gets a wide-lens radius at all.
  //
  // Doubling rather than repeating one stride is the part that matters. A
  // stride wider than the detail it is sampling skips over that detail instead
  // of averaging it, and what survives is structured, moving aliasing — you
  // read it as "the blur isn't really blurring". So the first iteration steps
  // less than a texel, and each later one may stride further precisely because
  // the one before it has already smoothed what it is about to sample.
  //
  // Which is why the pass COUNT is derived rather than fixed: the slider's top
  // end needs a sigma three times its bottom end's, and holding the pass count
  // still while the strength climbs is exactly how the first stride grows past
  // a texel and the blur starts skipping instead of blurring.
  var BLUR_PASSES_MAX = 6;

  // Temporal blend weights, per inference. Growing is nearly immediate so the
  // mask keeps up with a moving head; shrinking takes several inferences, which
  // is what stops the model's frame-to-frame noise turning into a boiling edge.
  var MASK_ALPHA_UP   = 0.85;
  var MASK_ALPHA_DOWN = 0.20;

  // Segmentation rates, in Hz, stepped down under load in the order listed.
  //
  // This ladder IS the accuracy knob, and it is the honest one. The mask's
  // working size is not: ImageSegmenter resizes whatever you hand it to the
  // model's own 256-wide input, so a bigger seg canvas buys a bigger readback
  // and not one extra pixel of detail. What re-detecting more often actually
  // buys is a mask that lags a moving head by less — the lag is one
  // segmentation interval, so 24 Hz sees ~40 ms of it where 10 Hz sees 100 —
  // and less of the temporal blend's smoothing, since the blend is per
  // inference.
  //
  // Each entry is a full ladder: the first rate is what the device starts at,
  // and measure() walks down the rest as it fails to keep up. The bottom rung
  // is 6 Hz in every mode, because below that the effect is worse than not
  // having it and giveUp() is the right answer instead.
  var QUALITY_KEY     = 'detection-quality';
  var QUALITY_DEFAULT = 'balanced';
  var SEG_HZ = {
    battery:  { desktop: [10, 6],         mobile: [6] },
    balanced: { desktop: [15, 10, 6],     mobile: [10, 6] },
    high:     { desktop: [24, 15, 10, 6], mobile: [15, 10, 6] }
  };
  var QUALITIES = [
    { id: 'battery',  label: 'Battery',  hint: 'Fewest inferences' },
    { id: 'balanced', label: 'Balanced', hint: 'The default' },
    { id: 'high',     label: 'High',     hint: 'Tracks fast movement' }
  ];

  // --- low light ------------------------------------------------------------
  //
  // The selfie model is trained on ordinary indoor light and degrades in the
  // dark exactly where it hurts: confidence collapses toward the middle of the
  // range, the mask's edge goes soft and noisy, and the temporal blend turns
  // that noise into a crawling outline. Brightening the frame first is worth
  // more than any amount of downstream filtering, because it hands the model
  // back the contrast it was trained on.
  //
  // Two things this deliberately does NOT do. It never touches the published
  // picture — only the copy the segmenter sees, which is already a private
  // 256-wide downscale — so nobody in the call sees you get brighter. And it
  // never darkens: a well-lit scene gets gain 1.0, which sets no filter at all
  // and therefore costs nothing.
  var LIGHT_ADAPT_KEY = 'light-adapt';
  // Phones only: turn an animated scene's camera with the phone. Absent is ON
  // (like light-adapt) — the effect is the point, and nothing about it leaves
  // the device unless the person also lets others draw their scene.
  var BACKGROUND_TILT_KEY = 'background-tilt';
  var LIGHT_TARGET    = 0.42;   // mean luma, 0-1, that the segmenter's input aims for
  var LIGHT_GAIN_MAX  = 2.6;
  var LIGHT_SAMPLE_MS = 400;    // how often the scene is measured
  var LIGHT_SMOOTH    = 0.25;   // EMA weight per sample — stops the gain pumping
  var LIGHT_GRID_W    = 12;     // the luma probe is 12x8 = 96 pixels
  var LIGHT_GRID_H    = 8;

  // --- a fixed camera: the empty-room reference -----------------------------
  //
  // On by default, but idle until the user captures the room from the
  // background menu (Settings → Video → Fixed camera switches it off). When
  // the camera does not move, a picture of the room without you in it says,
  // pixel by pixel and at far more than the model's 256-wide resolution, what
  // is NOT you: anything that still
  // looks like the empty room. That is a second opinion, and it is strongest
  // exactly where the model is weakest — the edge, the hair, the shoulder.
  //
  // It is never trusted on its own. The model still decides the two easy
  // regions: far from you (so a shadow or a moving curtain across the room is
  // never cut in), and deep inside you (so a white shirt in front of a white
  // wall is never cut out). The reference only decides the band in between,
  // which is where the model's staircase and the dilate's halo of sharp
  // background live. See FRAG_COMPOSITE.
  //
  // The picture is kept in memory and nowhere else — never stored, never sent
  // — and forgotten when the page goes away or the setting is switched off.
  var REFERENCE_KEY      = 'bg-reference';
  var REF_LONG           = 640;   // the comparison buffer's long side
  var REF_CAPTURE_FRAMES = 12;    // averaged into the reference, to beat sensor noise
  var REF_CAPTURE_MS     = 6000;  // give up on a capture that cannot finish
  var REF_PRESENT_MAX    = 0.02;  // share of the frame the model may call "person" during a capture
  var REF_STATS_LONG     = 64;    // the CPU probe that watches for a moved camera
  var REF_STATS_MS       = 500;
  var REF_STALE_BELOW    = 0.55;  // share of the visible room that must still match…
  var REF_FRESH_ABOVE    = 0.70;  // …and the higher bar to trust it again (hysteresis)
  var REF_MIN_ROOM       = 0.10;  // too little room visible to judge = keep the last verdict
  var REF_GAIN_MIN       = 0.5;   // exposure / white-balance drift the reference absorbs
  var REF_GAIN_MAX       = 2.0;
  var REF_GAIN_SMOOTH    = 0.3;
  // The difference score, 0 = identical to the room, mapped through
  // smoothstep(LO, HI) to "how much this is not the room". Reasoned, not
  // measured on a real room — see docs/video-effects.md.
  var REF_SCORE_LO       = 0.10;
  var REF_SCORE_HI       = 0.28;
  var REF_MATCH_MAX      = 0.15;  // the CPU probe's "still the same room" score
  // Where the model is sure enough that the reference is not asked: the
  // blended mask ERODED by REF_CORE_ERODE mask texels, through
  // smoothstep(CORE_LO, CORE_HI). Eroded rather than merely thresholded,
  // because the model is confidently wrong as often as it is unsure — a mask
  // of 1.0 right up to its staircase edge would leave the reference nothing
  // to decide. Four texels is ~20 px on a 1280-wide camera: the region where
  // hair and shoulders go wrong, and no deeper.
  var REF_CORE_ERODE     = 4;
  // Edge colour decontamination (FRAG_COMPOSITE): how far the person's colour
  // is pulled into the matte's band, 0-1, and how far apart, in matte texels,
  // the four taps either side of the band are.
  var DECON_STRENGTH     = 0.85;
  var DECON_STEP         = 2.0;
  var REF_CORE_LO        = 0.60;
  var REF_CORE_HI        = 0.95;
  // The band the reference may decide is widened by this much, in mask
  // texels, while it is in use — hair the model missed can only be given back
  // if it is inside the band.
  var REF_DILATE_EXTRA   = 2;
  var REF_TEMPORAL       = 0.6;   // per-frame blend of the difference, toward the new frame
  var REF_FADE           = 0.15;  // per-frame ease of the reference's weight in and out

  var IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');

  // The presets are the animated scenes in video-scenes.js: generated in a
  // shader, relit to match you, and drawn into a small buffer of their own.
  // See the "scenes" section of the processor below.
  var PRESETS = VideoScenes.SCENES;

  // The scene buffer's long side. Small on purpose: it is cheap, and a real
  // camera focused on a face shows the room behind it soft anyway. A scene may
  // ask for less (`res` in the catalogue, a fraction of this): the ray-marched
  // landscapes are the most expensive thing the page draws, and sixty per cent
  // of the pixels of a backdrop nobody is looking at closely is plenty.
  var SCENE_LONG = IS_MOBILE ? 384 : 512;
  // How often the scene itself is redrawn. Its motion is slow by design, and a
  // background that changes on every frame is one the encoder pays for on every
  // frame — so it runs well under the camera's rate, and halves under load
  // before anything else is given up. This is the default; a scene that costs
  // more to draw says so (`hz` in the catalogue) and is drawn less often.
  var SCENE_HZ = [20, 10];
  // How long the picker is on screen before its scene thumbnails start to render.
  var THUMB_DELAY_MS = 600;
  // The subject's light is re-measured this often (a 32-wide probe).
  var LOOK_SAMPLE_MS = 250;
  var LOOK_PROBE_W = 32;
  // The soft mask the shadow and the light wrap read: the finished mask,
  // brought down to this width and blurred wide.
  var SOFT_LONG = 64;
  // How far your shadow falls from you, as a fraction of the frame, at a light
  // fully to one side.
  var SHADOW_REACH = 0.075;
  // The faint darkening of a near surface right behind you, whatever the light:
  // the contact shadow that keeps a person from looking pasted on.
  var SHADOW_AO = 0.12;

  // --- the keyed stream: "let others draw my scene" -------------------------
  //
  // With an animated scene picked and the setting on, a peer that can draw the
  // scene itself is sent a picture of the person over a flat key colour
  // instead of the finished composite, and cuts the person out again at its
  // end. A flat field costs the encoder next to nothing, so the same quality
  // takes fewer bits; the scene is generated from a few numbers, so nothing of
  // it has to cross the network at all.
  //
  // On unless switched off — absent is ON, the polarity of light-adapt and
  // bg-reference ('on', written by the build that made this an opt-in, still
  // reads as on). It only does anything for a person who picked an animated
  // scene, and only with a mesh peer that advertised the capability and
  // acked, so on by default costs nobody who has not asked for a scene.
  var SUBJECT_ONLY_KEY = 'send-subject-only';
  // What a peer advertises when it can receive a keyed stream.
  var KEYED_CAP = 'keyed-video-1';

  // The frame format, which sender and receiver must agree on exactly.
  //
  // The key colour is pure green in ENCODED sRGB, the space the composite
  // already mixes in, so `mix(K, camera, m)` here and `c + (bg - K)(1 - a)` at
  // the receiver are the composite's own `mix(bg, camera, m)` taken apart and
  // put back together.
  var KEY_COLOR = [0, 255, 0];
  // Two square zones at the top corners of the picture say "this frame is
  // keyed": top-left all key, top-right a key ring around a BLACK patch. Black
  // rather than a grey because it is luma contrast, which 4:2:0 keeps at full
  // resolution and which survives a starved encoder long after a chroma
  // difference has been averaged away. The side is a fraction of the SHORT
  // side, so a portrait frame is not notched across a sixth of its width.
  var KEY_MARKER = { zone: 0.10, patch: 0.6 };
  // The faint tail of the matte. Below this the composite shows almost pure
  // background anyway, and a keyed frame that carried it would carry a faint
  // ghost of the real room — so it is cut to exact key instead, and the room
  // never leaves the device.
  var KEY_ALPHA_FLOOR = 0.06;
  // Where the detectors look inside a zone: pixel indices of a 20x20 grid laid
  // over it, so the GPU taps and the CPU probe read exactly the same places.
  // The ring taps sit in the middle of the ring (the patch spans 0.2-0.8 of
  // the zone), the patch taps around its centre.
  var KEY_TAP_GRID = 20;
  var KEY_TAPS = {
    tl: [[5, 5], [15, 5], [5, 15], [15, 15], [10, 10]],
    ring: [[2, 2], [17, 2], [2, 17], [17, 17]],
    patch: [[9, 9], [10, 9], [9, 10], [10, 10]]
  };

  // The tilt strip. A sender on a phone turns its scene's camera with the
  // phone (see setTilt()), and a receiver drawing that scene must turn the same
  // way on the same frame — a message could not promise that, and every one
  // between two non-hosts would ride the host. So the turn travels IN the
  // frame: a row of 32 black-or-white cells along the top edge, between the
  // two marker zones, half a zone tall. Luma only, for the reason the patch is
  // black: it survives 4:2:0 and a starved encoder. The strip is cut like a
  // zone (the subject is key there), and a receiver reserves it only when the
  // sender's offer says `tilt` — see KEYED_TILT_CAP in main.js.
  //
  // Cell 0 is white and cell 1 black (where the key colour would be neither);
  // then yaw 9 bits, pitch 9, roll 6 — each the angle's share of its range —
  // and a 6-bit check (see tiltSum()) that rejects a frame the codec mangled.
  var KEY_TILT = {
    cells: 32,
    rows: 0.5,                         // the strip's height, in zones
    yaw: 32 * Math.PI / 180,           // ±, radians
    pitch: 16 * Math.PI / 180,
    roll: 8 * Math.PI / 180,
    bits: [9, 9, 6]
  };

  function tiltQuant(v, range, bits) {
    var top = (1 << bits) - 1;
    var q = Math.round((Math.min(1, Math.max(-1, v / range)) * 0.5 + 0.5) * top);
    return isFinite(q) ? q : top >> 1;
  }
  function tiltUnquant(q, range, bits) {
    return ((q / ((1 << bits) - 1)) * 2 - 1) * range;
  }
  // The 24 data bits as four 6-bit groups, XORed (and offset, so an all-zero
  // payload is not its own sum): any single flipped cell changes it.
  function tiltSum(data) {
    return ((data & 63) ^ ((data >>> 6) & 63) ^ ((data >>> 12) & 63) ^ ((data >>> 18) & 63) ^ 21) & 63;
  }

  // { yaw, pitch, roll } in radians -> the strip's 32 cells as one uint32
  // (cell i is bit i). Angles beyond the ranges are clamped, non-numbers read
  // as zero.
  function encodeTilt(v) {
    var B = KEY_TILT.bits;
    var y = tiltQuant(Number(v && v.yaw) || 0, KEY_TILT.yaw, B[0]);
    var p = tiltQuant(Number(v && v.pitch) || 0, KEY_TILT.pitch, B[1]);
    var r = tiltQuant(Number(v && v.roll) || 0, KEY_TILT.roll, B[2]);
    var bits = 1;                          // cell 0 white, cell 1 black
    bits |= y << 2;
    bits |= p << (2 + B[0]);
    bits |= r << (2 + B[0] + B[1]);
    bits |= tiltSum((bits >>> 2) & 0xFFFFFF) << (2 + B[0] + B[1] + B[2]);
    return bits >>> 0;
  }

  // The 32 cells' bits -> { yaw, pitch, roll }, or null when the sync cells or
  // the sum disagree.
  function decodeTilt(bits) {
    var B = KEY_TILT.bits;
    bits = bits >>> 0;
    if ((bits & 3) !== 1) return null;
    var y = (bits >>> 2) & ((1 << B[0]) - 1);
    var p = (bits >>> (2 + B[0])) & ((1 << B[1]) - 1);
    var r = (bits >>> (2 + B[0] + B[1])) & ((1 << B[2]) - 1);
    var c = (bits >>> (2 + B[0] + B[1] + B[2])) & 63;
    if (c !== tiltSum((bits >>> 2) & 0xFFFFFF)) return null;
    return {
      yaw: tiltUnquant(y, KEY_TILT.yaw, B[0]),
      pitch: tiltUnquant(p, KEY_TILT.pitch, B[1]),
      roll: tiltUnquant(r, KEY_TILT.roll, B[2])
    };
  }

  // The phone's turn since the room was set up, from main.js's sensor: the
  // scene's camera of every LOCAL pipeline turns with it (a receiver's scene
  // turns by what the strip says instead). null = a still camera.
  var _tilt = null;
  function setTilt(v) {
    if (!v) { _tilt = null; return; }
    var y = Number(v.yaw), p = Number(v.pitch), r = Number(v.roll);
    _tilt = (isFinite(y) && isFinite(p) && isFinite(r)) ? { yaw: y, pitch: p, roll: r } : null;
  }
  function getTilt() { return _tilt; }

  // The sender's own guards. Each one withholds keying — the keyed canvas
  // then carries the plain composite with no markers, so a peer on the keyed
  // track simply passes it through and nobody needs a track swap.
  var KEY_COPY_SAMPLES = 30;   // copies timed before the copy is judged…
  var KEY_COPY_BUDGET_MS = 4;  // …and the median it may take
  var KEY_GREEN_E = 0.12;      // how much greener than red and blue counts as "green"…
  var KEY_GREEN_ON = 0.04;     // …the share of the subject that withholds keying…
  var KEY_GREEN_OFF = 0.02;    // …and the share it must stay under…
  var KEY_GREEN_HOLD_MS = 5000; // …for this long before keying resumes
  var KEY_CORNER_ON = 0.15;    // the share of a marker zone the subject may cover
  var KEY_CORNER_OFF = 0.05;
  var KEY_CORNER_HOLD_MS = 2000;
  var KEY_STATE_MS = 2000;     // the look is re-announced at most this often
  var KEY_EDGE_SMOOTH_S = 1.4; // edgeE is eased like the look (LOOK_SMOOTH_S)

  // The receiving end. See KeyInProcessor.
  var KEYIN_MAX_LONG = 1280;   // the output is never bigger than 1280x720…
  var KEYIN_MAX_SHORT = 720;
  var KEYIN_ASPECT_TOL = 0.02; // …and only resized for a new shape, never a new size
  var KEYIN_PROBE_MS = 250;    // the CPU marker probe's period
  var KEYIN_RECENT_MS = 500;   // how long a keyed frame keeps the relaxed detector on
  var KEYIN_FRAME_WAIT_MS = 10000;
  var KEYIN_WARM_FRAMES = 30;  // composited frames before the handle is handed out…
  var KEYIN_WARM_MS = 6;       // …and the median draw they must stay under
  var KEYIN_WARM_WAIT_MS = 15000;
  var KEYIN_BUDGET_MS = 8;     // the rolling median, once running…
  var KEYIN_BUDGET_WINDOW_MS = 5000; // …over this window
  // The edge band: a pixel within this reach (a fraction of the frame's width,
  // ~10 px at 1280, never under 3 px — the codec's 4:2:0 chroma alone smears
  // the edge by 2) of anything the key calls mostly background is an edge
  // pixel, and gets the edgeE correction; everything further in is the
  // person, at full opacity. Wider buys the band nothing and costs the
  // inside: at 15 px the band scored the same and the interior's p99 went
  // from 2.5 to 5.7 levels, the correction reaching pixels that needed none.
  var KEYIN_BAND_REACH = 0.008;
  var KEYIN_BAND_MIN_PX = 3;
  var KEYIN_BAND_A0 = 0.5;
  // Above this the alpha is 1. Below KEY_ALPHA_FLOOR it is 0, exactly as the
  // sender floored it; in between it is taken as it is. Measured on colour
  // against the sender's composite (unit-video-keyin.spec.js), this beat a
  // ramp re-stretched over 0.06-0.94: band p95 13 vs 17 levels with no codec,
  // 27 vs 30 through VP8 at 450 kb/s — the stretch is exact at no point of
  // the band, where the sender's floor is exact at all of them.
  var KEYIN_SATURATE = 0.97;
  // How hard the leftover key is taken out of a partly keyed pixel's colour.
  // In exact arithmetic there is none to take: the band's corrected alpha
  // leaves the subject estimate exactly as green as edgeE, which is <= 0. What
  // it catches is green the codec put there — 4:2:0 chroma bleeding the key a
  // pixel or two into the person. It only ever removes green ABOVE the larger
  // of red and blue, so it cannot grey a face; on the test's skin-and-shirt
  // edge 0, 4 and 8 scored the same.
  var KEYIN_DESPILL = 4.0;
  // What the background is while there is no scene to draw. Never the blur:
  // blurring a keyed frame would smear the key into green mush.
  var KEYIN_FLAT = [0.42, 0.42, 0.44];

  // --- mode: read, write, normalise ----------------------------------------

  function normalizeMode(mode) {
    if (!mode || mode === 'off') return 'off';
    if (mode === 'blur' || mode === 'custom') return mode;
    if (String(mode).indexOf('preset:') === 0) {
      // A scene id, or one of the image presets they replaced (mapped to the
      // nearest scene, so an upgrade never silently drops someone's choice).
      var id = VideoScenes.resolveId(String(mode).slice(7));
      if (id) return 'preset:' + id;
    }
    return 'off';
  }

  function readMode() {
    try { return normalizeMode(localStorage.getItem(STORAGE_KEY)); } catch (e) { return 'off'; }
  }

  function writeMode(mode) {
    mode = normalizeMode(mode);
    try {
      if (mode === 'off') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, mode);
    } catch (e) { /* private mode — the effect still works for this session */ }
    return mode;
  }

  // --- blur strength: read, write, and the slider's mapping ------------------

  function clampStrength(v) {
    v = Number(v);
    if (!isFinite(v)) return STRENGTH_DEFAULT;
    return Math.min(STRENGTH_MAX, Math.max(STRENGTH_MIN, v));
  }

  function readStrength() {
    try {
      var raw = localStorage.getItem(STRENGTH_KEY);
      if (raw === null || raw === '') return STRENGTH_DEFAULT;
      return clampStrength(raw);
    } catch (e) { return STRENGTH_DEFAULT; }
  }

  function writeStrength(v) {
    v = clampStrength(v);
    try {
      // The default is stored as an absence, the way `off` is for the mode —
      // so a later change of taste in the default reaches everyone who never
      // moved the slider.
      if (Math.abs(v - STRENGTH_DEFAULT) < 1e-9) localStorage.removeItem(STRENGTH_KEY);
      else localStorage.setItem(STRENGTH_KEY, String(v));
    } catch (e) { /* private mode — it still applies for this session */ }
    return v;
  }

  // Slider position (0-100) <-> strength, geometrically.
  //
  // Linear travel would spend most of the slider inside "already unreadable":
  // going from 2% to 4% is a dramatic change and from 18% to 20% is invisible,
  // because the eye reads blur as a ratio. A geometric map gives every part of
  // the travel the same perceived weight.
  function strengthFromSlider(pos) {
    var t = Math.min(100, Math.max(0, Number(pos) || 0)) / 100;
    return clampStrength(STRENGTH_MIN * Math.pow(STRENGTH_MAX / STRENGTH_MIN, t));
  }

  function sliderFromStrength(v) {
    v = clampStrength(v);
    return Math.round(100 * Math.log(v / STRENGTH_MIN) / Math.log(STRENGTH_MAX / STRENGTH_MIN));
  }

  function strengthLabel(v) {
    v = clampStrength(v);
    var word = v < 0.035 ? 'Subtle' : v < 0.065 ? 'Medium' : v < 0.12 ? 'Strong' : 'Maximum';
    return word + ' · ' + (v * 100).toFixed(1) + '%';
  }

  // --- edge sharpness: read, write, and the profile it derives --------------

  function clampSharpness(v) {
    v = Number(v);
    if (!isFinite(v)) return SHARPNESS_DEFAULT;
    return Math.min(1, Math.max(0, v));
  }

  function readSharpness() {
    try {
      var raw = localStorage.getItem(SHARPNESS_KEY);
      if (raw === null || raw === '') return SHARPNESS_DEFAULT;
      return clampSharpness(raw);
    } catch (e) { return SHARPNESS_DEFAULT; }
  }

  function writeSharpness(v) {
    v = clampSharpness(v);
    try {
      // Stored as an absence at the default, the way the mode and the strength
      // are — so a later retune of the midpoint reaches everyone who never
      // moved the slider.
      if (Math.abs(v - SHARPNESS_DEFAULT) < 1e-9) localStorage.removeItem(SHARPNESS_KEY);
      else localStorage.setItem(SHARPNESS_KEY, String(v));
    } catch (e) { /* private mode — it still applies for this session */ }
    return v;
  }

  // The one place the three edge numbers are derived, so they can never be
  // moved apart. Linear travel, unlike the blur's: this is not a radius the eye
  // reads as a ratio, it is a blend between two tunings.
  //
  // Exported as _edgeProfile and pinned by a test at s=0.5, because a profile
  // whose midpoint has drifted off the tuned constants is a change nobody
  // asked for applied to everybody who never opened the setting.
  function edgeProfile(s) {
    s = clampSharpness(s);
    var k = Math.pow(SHARP_FEATHER_RANGE, 1 - 2 * s);
    var feather = MASK_FEATHER * k;
    var width = (MASK_EDGE_HI - MASK_EDGE_LO) * Math.pow(SHARP_WINDOW_RANGE, 1 - 2 * s);
    return {
      feather: feather,
      // Softer means a wider soft band, and the band has to stay OUTSIDE the
      // subject — so a softer edge is dilated further, not less.
      dilate: MASK_DILATE_BASE + feather,
      lo: Math.max(0.05, MASK_EDGE_MID - width / 2),
      hi: Math.min(0.95, MASK_EDGE_MID + width / 2)
    };
  }

  function sharpnessFromSlider(pos) {
    return clampSharpness((Number(pos) || 0) / 100);
  }

  function sliderFromSharpness(v) {
    return Math.round(clampSharpness(v) * 100);
  }

  function sharpnessLabel(v) {
    v = clampSharpness(v);
    if (v < 0.2) return 'Very soft';
    if (v < 0.4) return 'Soft';
    if (v < 0.6) return 'Balanced';
    if (v < 0.8) return 'Crisp';
    return 'Sharp';
  }

  // --- detection accuracy: read, write, and the ladder it picks -------------

  function normalizeQuality(q) {
    q = String(q || '');
    return SEG_HZ[q] ? q : QUALITY_DEFAULT;
  }

  function readQuality() {
    try { return normalizeQuality(localStorage.getItem(QUALITY_KEY)); }
    catch (e) { return QUALITY_DEFAULT; }
  }

  function writeQuality(q) {
    q = normalizeQuality(q);
    try {
      if (q === QUALITY_DEFAULT) localStorage.removeItem(QUALITY_KEY);
      else localStorage.setItem(QUALITY_KEY, q);
    } catch (e) { /* private mode — it still applies for this session */ }
    return q;
  }

  // A copy, always: the returned array becomes a processor's mutable ladder
  // position, and handing out the shared constant would let one call's
  // step-down rewrite the table for every later one.
  function segHzFor(quality, mobile) {
    var row = SEG_HZ[normalizeQuality(quality)];
    return (mobile ? row.mobile : row.desktop).slice();
  }

  function qualityLabel(q) {
    q = normalizeQuality(q);
    for (var i = 0; i < QUALITIES.length; i++) if (QUALITIES[i].id === q) return QUALITIES[i].label;
    return q;
  }

  // --- low light: read, write, and the gain it asks for ---------------------

  function readLightAdapt() {
    // On unless switched off, so the people it helps most — the ones on a
    // laptop in a dim room, who are also least likely to go looking for a
    // setting — get it without asking.
    try { return localStorage.getItem(LIGHT_ADAPT_KEY) !== 'off'; }
    catch (e) { return true; }
  }

  function readBackgroundTilt() {
    try { return localStorage.getItem(BACKGROUND_TILT_KEY) !== 'off'; }
    catch (e) { return true; }
  }

  function writeBackgroundTilt(on) {
    on = !!on;
    try {
      if (on) localStorage.removeItem(BACKGROUND_TILT_KEY);
      else localStorage.setItem(BACKGROUND_TILT_KEY, 'off');
    } catch (e) { /* private mode — it still applies for this session */ }
    return on;
  }

  function writeLightAdapt(on) {
    on = !!on;
    try {
      if (on) localStorage.removeItem(LIGHT_ADAPT_KEY);
      else localStorage.setItem(LIGHT_ADAPT_KEY, 'off');
    } catch (e) { /* private mode — it still applies for this session */ }
    return on;
  }

  // Mean luma of the subject's part of the frame -> what to do about it.
  //
  // Measured over the CENTRE, not the whole frame, and that is the whole
  // difference between this helping and this hurting. The case that breaks
  // segmentation is backlight: a window behind you drags the frame's average
  // up while leaving your face the darkest thing in it, and a gain computed
  // from the full-frame average would then darken the one region the model
  // needs. The centre box is where a webcam's subject is, near enough.
  //
  // The contrast bump rides along with the gain rather than being its own
  // number: brightening a dark frame lifts its noise floor with everything
  // else, and a little contrast puts the edges back where the model can find
  // them. Both are 1.0 — i.e. no filter at all — in ordinary light.
  function lightPlan(meanLuma) {
    var mean = Number(meanLuma);
    if (!isFinite(mean) || mean <= 0) return { gain: 1, contrast: 1 };
    var gain = Math.min(LIGHT_GAIN_MAX, Math.max(1, LIGHT_TARGET / mean));
    return { gain: gain, contrast: 1 + 0.25 * (gain - 1) / (LIGHT_GAIN_MAX - 1) };
  }

  // --- the empty-room reference: the preference ----------------------------

  function readReference() {
    // On unless switched off. Being on costs nothing by itself: the pipeline
    // only changes once a picture has been captured, which the user asks for
    // from the background menu. So the switch is an opt-OUT — absent is on,
    // and only 'off' is stored. ('on', written by the build that made this an
    // opt-in, still reads as on.)
    try { return localStorage.getItem(REFERENCE_KEY) !== 'off'; }
    catch (e) { return true; }
  }

  function writeReference(on) {
    on = !!on;
    try {
      if (on) localStorage.removeItem(REFERENCE_KEY);
      else localStorage.setItem(REFERENCE_KEY, 'off');
    } catch (e) { /* private mode — it still applies for this session */ }
    return on;
  }

  // --- the keyed stream: the preference -------------------------------------

  function readSubjectOnly() {
    try { return localStorage.getItem(SUBJECT_ONLY_KEY) !== 'off'; }
    catch (e) { return true; }
  }

  function writeSubjectOnly(on) {
    on = !!on;
    try {
      if (on) localStorage.removeItem(SUBJECT_ONLY_KEY);
      else localStorage.setItem(SUBJECT_ONLY_KEY, 'off');
    } catch (e) { /* private mode — it still applies for this session */ }
    return on;
  }

  // Single slot, like onOverload: main.js is the one consumer, and what it
  // does with the change (offers, per-peer tracks) is entirely its business.
  var _onSubjectOnly = null;

  function onSubjectOnlyChange(fn) { _onSubjectOnly = fn; }

  function setSubjectOnly(on) {
    on = writeSubjectOnly(on);
    if (_onSubjectOnly) { try { _onSubjectOnly(on); } catch (e) { /* ignore */ } }
    return on;
  }

  // How different two colours are, for the reference: 0 is "the same room".
  //
  // Two parts, and the larger wins. Chromaticity (colour with the brightness
  // divided out) catches a person in front of a wall of another colour, and is
  // left alone by a shadow, which darkens without changing colour. It is
  // ignored in the dark, where it is mostly sensor noise. Relative luma catches
  // the rest — a grey jumper in front of a grey wall — weighted down so a soft
  // shadow alone does not cross the threshold.
  //
  // The GLSL in FRAG_REF_DIFF is this function, line for line; the CPU probe
  // uses this copy, so the two cannot disagree about what "the same" means.
  function refScore(cr, cg, cb, pr, pg, pb) {
    var yc = 0.2126 * cr + 0.7152 * cg + 0.0722 * cb;
    var yp = 0.2126 * pr + 0.7152 * pg + 0.0722 * pb;
    var lum = Math.abs(yc - yp) / Math.max(yc, yp, 0.08);
    var sc = Math.max(cr + cg + cb, 0.03), sp = Math.max(pr + pg + pb, 0.03);
    var dr = cr / sc - pr / sp, dg = cg / sc - pg / sp, db = cb / sc - pb / sp;
    var y = Math.max(yc, yp);
    var lit = y <= 0.04 ? 0 : y >= 0.15 ? 1 : (function (t) { return t * t * (3 - 2 * t); })((y - 0.04) / 0.11);
    var chroma = Math.sqrt(dr * dr + dg * dg + db * db) * 4 * lit;
    return Math.max(chroma, lum * 0.7);
  }

  // Long side SEG_LONG, short side to match the frame, both even. A 16:9 camera
  // gives 256x144; the 4:3 one on most laptops gives 256x192; a phone held
  // upright gives 144x256.
  function segSizeFor(w, h) {
    if (!w || !h) return { width: SEG_LONG, height: Math.round(SEG_LONG * 9 / 16) };
    var scale = SEG_LONG / Math.max(w, h);
    return {
      width:  Math.max(2, Math.round(w * scale / 2) * 2),
      height: Math.max(2, Math.round(h * scale / 2) * 2)
    };
  }

  // The reference's comparison buffer: long side REF_LONG, never larger than
  // the camera itself, short side to match.
  function refSizeFor(w, h) {
    var scale = Math.min(1, REF_LONG / Math.max(w || 1, h || 1));
    return {
      width:  Math.max(2, Math.round((w || REF_LONG) * scale)),
      height: Math.max(2, Math.round((h || Math.round(REF_LONG * 9 / 16)) * scale))
    };
  }

  // --- support probe --------------------------------------------------------

  var _supported = null;

  function isSupported() {
    if (_supported !== null) return _supported;
    _supported = false;
    try {
      if (typeof WebAssembly === 'undefined') return _supported;
      if (typeof document === 'undefined') return _supported;
      var c = document.createElement('canvas');
      if (typeof c.captureStream !== 'function') return _supported;
      var gl = c.getContext('webgl2', { failIfMajorPerformanceCaveat: false });
      if (!gl) return _supported;
      // Release the probe context immediately — a page is allowed only a
      // handful of live WebGL contexts and we want ours for the real pipeline.
      var lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      _supported = true;
    } catch (e) {
      _supported = false;
    }
    return _supported;
  }

  // Can this device draw other people's scenes for them? A separate probe from
  // isSupported(): receiving needs no WebAssembly (there is no segmentation at
  // this end), but it does need a real GPU, because every keyed peer is a
  // scene ray-marched on THIS device — on a software rasteriser that is
  // seconds of main-thread compile per peer and then a frame budget nobody
  // has. And for now it needs a Chromium engine: the receive path (an off-DOM
  // remote <video> driving requestVideoFrameCallback, a captured GL canvas)
  // is verified there and nowhere else yet.
  //
  // The facts are probed once; the two test overrides are read at every call,
  // so a test can set them after the page has loaded.
  var _keyInFacts = null;

  function chromiumEngine() {
    try {
      var uad = navigator.userAgentData;
      if (uad && uad.brands && uad.brands.some(function (b) { return /Chromium/i.test(b.brand); })) return true;
      var ua = navigator.userAgent || '';
      // Every browser on iOS is WebKit, whatever its name says.
      if (/CriOS|EdgiOS|FxiOS|OPiOS/.test(ua)) return false;
      return /Chrome\/|Chromium\//.test(ua) && !/Firefox\//.test(ua);
    } catch (e) { return false; }
  }

  function keyInFacts() {
    if (_keyInFacts) return _keyInFacts;
    var f = { gl2: false, capture: false, software: false, chromium: chromiumEngine() };
    try {
      var c = document.createElement('canvas');
      f.capture = typeof c.captureStream === 'function';
      var gl = c.getContext('webgl2', { failIfMajorPerformanceCaveat: false });
      if (gl) {
        f.gl2 = true;
        f.software = VideoScenes.isSoftwareGL(gl);
        var lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      }
    } catch (e) { /* no WebGL2 at all */ }
    _keyInFacts = f;
    return f;
  }

  function canKeyIn() {
    var f = keyInFacts();
    if (!f.gl2 || !f.capture) return false;
    if (!f.chromium && !(typeof window !== 'undefined' && window.__voxalKeyInAnyEngine)) return false;
    if (f.software && !(typeof window !== 'undefined' && window.__voxalKeyInOnSoftwareGL)) return false;
    return true;
  }

  // --- custom background storage (IndexedDB) --------------------------------
  //
  // A background image is a few hundred KB of binary; localStorage can hold
  // neither a Blob nor, comfortably, its base64. IndexedDB stores the Blob
  // directly and is available in every webview Voxal targets.

  var DB_NAME = 'voxal-bg', DB_STORE = 'images', DB_KEY = 'custom';

  function idb() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('no indexedDB')); return; }
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('indexedDB open failed')); };
    });
  }

  function idbOp(mode, fn) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, mode);
        var req = fn(tx.objectStore(DB_STORE));
        tx.oncomplete = function () { db.close(); resolve(req ? req.result : undefined); };
        tx.onerror = function () { db.close(); reject(tx.error); };
      });
    });
  }

  function getCustomImage() {
    return idbOp('readonly', function (store) { return store.get(DB_KEY); })
      .catch(function () { return null; });
  }

  function clearCustomImage() {
    return idbOp('readwrite', function (store) { return store.delete(DB_KEY); })
      .catch(function () { return null; });
  }

  // Store a picked file downscaled to at most 1280×720. A 12 MP phone photo is
  // ~4 MB of JPEG and decodes to ~50 MB of RGBA — pointless for something that
  // ends up behind a person at 720p, and a real memory spike on a phone.
  function setCustomImage(file) {
    return loadBitmap(file).then(function (bmp) {
      var scale = Math.min(1, 1280 / bmp.width, 720 / bmp.height);
      var w = Math.max(1, Math.round(bmp.width * scale));
      var h = Math.max(1, Math.round(bmp.height * scale));
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(bmp, 0, 0, w, h);
      if (bmp.close) try { bmp.close(); } catch (e) { /* ignore */ }
      return new Promise(function (resolve, reject) {
        c.toBlob(function (blob) {
          if (!blob) { reject(new Error('could not encode image')); return; }
          idbOp('readwrite', function (store) { return store.put(blob, DB_KEY); })
            .then(function () { resolve(blob); }, reject);
        }, 'image/jpeg', 0.86);
      });
    });
  }

  function loadBitmap(src) {
    if (window.createImageBitmap && (src instanceof Blob)) return createImageBitmap(src);
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('could not decode image')); };
      img.src = (src instanceof Blob) ? URL.createObjectURL(src) : src;
    });
  }

  // --- asset locations ------------------------------------------------------
  //
  // The model and the preset artwork are small and ship with the app, so they
  // are always same-origin. The ~12 MB MediaPipe runtime is NOT bundled, so it
  // has to be fetched — and the resolution follows exactly the rule
  // anonymousTurnUrl() and the SFU endpoints in main.js already use:
  //
  //   * an explicit override wins (self-hosters, tests);
  //   * on plain web over http(s), a SAME-ORIGIN path, so a self-hosted deploy
  //     serves its own copy (and the COEP require-corp header is satisfied for
  //     free);
  //   * native (Capacitor/Tauri) has no same-origin server — the page comes
  //     from capacitor:// or the Tauri asset protocol — so it needs the
  //     absolute URL of the static site.
  //
  // That last line is the one that matters: this must point at the host serving
  // src/, which is web.voxal.app. It is NOT presenceBase()/`service-url` —
  // that is the presence API, which defaults to a Supabase edge function and
  // has never served static assets. Getting this wrong is silent on the web and
  // breaks the whole feature on the desktop and mobile apps.
  //
  // It was `ptt.voxal.app` until that name lost its DNS record, which is
  // exactly the failure this comment warns about wearing a different hat: a
  // host that cannot be resolved is as useless as a host that serves the wrong
  // thing, and both are invisible from a browser tab.

  var DEFAULT_SEG_BASE = 'https://web.voxal.app/' + ASSET_DIR;
  var SEG_BASE_KEY = 'seg-assets-url';

  function isTauri() { return !!window.__TAURI__; }

  function isCapacitor() {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  }

  function runtimeBase() {
    var override;
    try { override = localStorage.getItem(SEG_BASE_KEY); } catch (e) { override = null; }
    if (override) return override.trim().replace(/\/*$/, '/');
    // Desktop ships the runtime inside the app: tauri.conf.json's frontendDist
    // is the whole of src/, and the build targets stage the runtime before
    // bundling. So there is nothing to download, nothing to go wrong offline,
    // and no dependency on the static host being reachable.
    if (isTauri()) return ASSET_DIR;
    // Capacitor is the opposite trade — cap-sync strips the runtime, because
    // 12 MB in every App Store and Play download is not worth it for a feature
    // most people never switch on — so it fetches, with a progress bar.
    if (isCapacitor()) return DEFAULT_SEG_BASE;
    if (/^https?:$/.test(location.protocol)) return ASSET_DIR;
    return DEFAULT_SEG_BASE;
  }

  // import() needs a real URL: 'assets/seg/x.mjs' is a *bare* specifier and
  // would throw, where './assets/seg/x.mjs' or an absolute URL resolves.
  function absolute(url) {
    try { return new URL(url, document.baseURI).href; } catch (e) { return url; }
  }

  // The runtime's URL carries its version so neither the HTTP cache (immutable
  // on /assets/seg/) nor CacheStorage can hand back a file of another version.
  function versioned(url) {
    return absolute(url) + '?v=' + SEG_RUNTIME_VERSION;
  }

  function modelUrl() { return ASSET_DIR + MODEL_FILE; }

  // --- MediaPipe loading, with progress and a way out -----------------------
  //
  // Twelve megabytes on a phone tether is not instant, and a picker that just
  // sits there looking broken is worse than a slow one. So the binary is
  // fetched by hand rather than left to MediaPipe's loader: a streamed read
  // gives us a byte count to report, and an AbortController gives the user a
  // way to change their mind.

  var _runtime = null;         // Promise<{ ImageSegmenter, fileset }>
  var _loadAbort = null;       // AbortController for the in-flight fetch
  var _onProgress = null;      // fn({ phase, loaded, total, ratio })

  // Rough, and deliberately so — it is a "this will take a moment" signal, not
  // an invoice. Read once at load time from the real Content-Length when the
  // server sends one.
  var APPROX_RUNTIME_BYTES = 12 * 1024 * 1024;

  // Single slot, not a list: main.js is the only consumer, and a second
  // registration displacing the first would silently stop the UI updating.
  function onLoadProgress(fn) { _onProgress = fn; }

  function report(phase, loaded, total) {
    if (!_onProgress) return;
    // Content-Length is the *compressed* size whenever the server encodes the
    // response, while the reader hands back decompressed bytes — so the header
    // is a hint, not a denominator to trust. Fall back to the approximate size,
    // and never show 100% before the runtime is actually ready.
    var denom = total || APPROX_RUNTIME_BYTES;
    var ratio = phase === 'ready' || phase === 'cache'
      ? 1
      : Math.min(0.99, (loaded || 0) / denom);
    try {
      _onProgress({
        phase: phase,
        loaded: loaded || 0,
        total: total || 0,
        ratio: ratio
      });
    } catch (e) { /* a broken progress UI must not break the load */ }
  }

  function isLoading() { return !!_loadAbort; }
  function isLoaded() { return !!_runtime && !_loadAbort; }

  // Cancel an in-flight first load. The fetch rejects with AbortError, which
  // wrap() turns into "leave the plain camera alone".
  function cancelLoad() {
    if (_loadAbort) { try { _loadAbort.abort(); } catch (e) { /* ignore */ } }
  }

  // Fetch with a byte counter. Without ReadableStream (or without a
  // Content-Length) it still works — you just get an indeterminate bar, which
  // is the honest thing to show when the size is genuinely unknown.
  function fetchBinary(url, signal) {
    return fetch(url, { signal: signal }).then(function (res) {
      if (!res.ok) throw new Error('runtime fetch failed: HTTP ' + res.status);
      var total = Number(res.headers.get('content-length')) || 0;
      if (!res.body || typeof res.body.getReader !== 'function') {
        report('download', 0, total);
        return res.blob();
      }
      var reader = res.body.getReader();
      var chunks = [], loaded = 0;
      report('download', 0, total);
      return (function pump() {
        return reader.read().then(function (r) {
          if (r.done) return new Blob(chunks, { type: 'application/wasm' });
          chunks.push(r.value);
          loaded += r.value.length;
          report('download', loaded, total);
          return pump();
        });
      })();
    });
  }

  // The binary is the only asset big enough to be worth caching by hand. There
  // is no service worker, so a CacheStorage entry only helps if we hand
  // MediaPipe a blob: URL made from it — but that is exactly what the progress
  // fetch produces anyway, so the two fall out together.
  function runtimeBinaryUrl(url, signal) {
    var open = window.caches ? caches.open(CACHE_NAME) : Promise.reject();
    // Drop the binaries of every other runtime version.
    if (window.caches) {
      caches.keys().then(function (keys) {
        keys.forEach(function (k) {
          if (k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE_NAME) caches.delete(k);
        });
      }).catch(function () { /* best effort */ });
    }
    return open.then(function (cache) {
      return cache.match(url).then(function (hit) {
        if (hit) { report('cache', 1, 1); return hit.blob(); }
        return fetchBinary(url, signal).then(function (blob) {
          // Best effort: a full quota must not fail the load.
          try { cache.put(url, new Response(blob)); } catch (e) { /* ignore */ }
          return blob;
        });
      });
    }, function () {
      return fetchBinary(url, signal);
    }).then(function (blob) { return URL.createObjectURL(blob); });
  }

  function loadRuntime() {
    if (_runtime) return _runtime;
    var base = runtimeBase();
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    _loadAbort = ctl;
    report('start', 0, APPROX_RUNTIME_BYTES);

    // Dynamic import is legal from a classic script and keeps the runtime off
    // the critical path — nothing is fetched until an effect is turned on.
    _runtime = Promise.all([
      import(versioned(base + BUNDLE_FILE)),
      runtimeBinaryUrl(versioned(base + WASM_BINARY), ctl && ctl.signal)
    ]).then(function (r) {
      _loadAbort = null;
      report('ready', 1, 1);
      return {
        ImageSegmenter: r[0].ImageSegmenter,
        fileset: { wasmLoaderPath: versioned(base + WASM_LOADER), wasmBinaryPath: r[1] }
      };
    }, function (err) {
      _loadAbort = null;
      _runtime = null;   // let a later attempt retry rather than latch a failure
      report(isAbort(err) ? 'cancelled' : 'failed', 0, 0);
      throw err;
    });
    return _runtime;
  }

  function isAbort(err) {
    return !!err && (err.name === 'AbortError' || /abort/i.test(err.message || ''));
  }

  // Tests drive the whole pipeline — the GL passes, the track swaps, the
  // teardown — but cannot run MediaPipe: the ~12 MB runtime is staged by the
  // build and headless GPU inference is not something to hang a deterministic
  // suite on. `window.__voxalSegStub` swaps inference for a fixed mask and
  // leaves everything else real, the same bargain unit-rnnoise-worklet.spec.js
  // strikes for the audio worklet.
  function stubSegmenter() {
    var stub = window.__voxalSegStub;
    if (stub && stub.fail) {
      var err = new Error(stub.abort ? 'The user aborted a request.' : 'stubbed segmenter failure');
      if (stub.abort) err.name = 'AbortError';
      return Promise.reject(err);
    }
    // Sized from the frame it is handed, exactly as the real segmenter is.
    var cache = {};
    function maskFor(w, h) {
      var key = w + 'x' + h;
      if (cache[key]) return cache[key];
      var data = new Uint8Array(w * h);
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          // A centred oval stands in for a person.
          var dx = (x - w / 2) / (w * 0.22);
          var dy = (y - h * 0.6) / (h * 0.45);
          data[y * w + x] = (dx * dx + dy * dy) < 1 ? 255 : 0;
        }
      }
      cache[key] = { width: w, height: h, getAsUint8Array: function () { return data; } };
      return cache[key];
    }
    return Promise.resolve({
      close: function () {},
      segmentForVideo: function (frame, ts, cb) {
        window.__voxalSegCalls = (window.__voxalSegCalls || 0) + 1;
        var w = frame.width || frame.videoWidth || SEG_LONG;
        var h = frame.height || frame.videoHeight || Math.round(SEG_LONG * 9 / 16);
        // `{ empty: true }` is an empty room: nobody in the picture, which is
        // what capturing the reference needs to see. Read per call, so a test
        // can step out of the frame and back in.
        var s = window.__voxalSegStub;
        if (s && s.empty) {
          cb({ confidenceMasks: [{ width: w, height: h,
            getAsUint8Array: function () { return new Uint8Array(w * h); } }] });
          return;
        }
        // `{ full: true }` is somebody filling the whole picture — into both
        // top corners, where the keyed stream's markers live.
        if (s && s.full) {
          cb({ confidenceMasks: [{ width: w, height: h,
            getAsUint8Array: function () { return new Uint8Array(w * h).fill(255); } }] });
          return;
        }
        cb({ confidenceMasks: [maskFor(w, h)] });
      }
    });
  }

  function createSegmenter() {
    if (window.__voxalSegStub) return stubSegmenter();
    return loadRuntime().then(function (rt) {
      // Its own canvas, deliberately: MediaPipe initialises a WebGL context on
      // whatever canvas it is handed and freely resets viewport, framebuffer
      // and blend state. Sharing ours would mean saving and restoring GL state
      // around every inference on five different webviews.
      var segCanvas = document.createElement('canvas');
      segCanvas.width = SEG_LONG; segCanvas.height = SEG_LONG;
      return rt.ImageSegmenter.createFromOptions(rt.fileset, {
        baseOptions: { modelAssetPath: modelUrl(), delegate: 'GPU' },
        canvas: segCanvas,
        runningMode: 'VIDEO',
        outputCategoryMask: false,
        outputConfidenceMasks: true
      });
    });
  }

  function warmup() {
    if (!isSupported()) return Promise.resolve(false);
    if (window.__voxalSegStub) return Promise.resolve(true);
    return loadRuntime().then(function () { return true; }, function () { return false; });
  }

  // --- WebGL plumbing -------------------------------------------------------

  var VERT = [
    '#version 300 es',
    'in vec2 aPos;',
    'out vec2 vUv;',
    'void main() {',
    '  vUv = aPos * 0.5 + 0.5;',
    '  gl_Position = vec4(aPos, 0.0, 1.0);',
    '}'
  ].join('\n');

  // A normalised half-Gaussian, computed rather than typed.
  //
  // The hand-written table this replaces summed to 0.838, not 1 — so every
  // separable pass quietly threw away 16% of what it was given. Two passes over
  // the background left it at 70% brightness (the washed-out grey everyone
  // noticed), and two more over the mask capped the feather at 0.7, which
  // shifted the composite's threshold inward and hardened the very edge the
  // feather exists to soften. Generating the weights makes that class of bug
  // unrepresentable, so `_gaussianHalfKernel` is exported and pinned by a test.
  function gaussianHalfKernel(sigma, taps) {
    var w = [], sum = 0, i;
    for (i = 0; i < taps; i++) {
      var v = Math.exp(-(i * i) / (2 * sigma * sigma));
      w.push(v);
      sum += (i === 0 ? v : 2 * v);
    }
    for (i = 0; i < taps; i++) w[i] /= sum;
    return w;
  }

  // Separable 9-tap Gaussian, emitted twice: once for colour and once for the
  // mask. uDir is the per-tap step in UV space, so one program serves both the
  // horizontal and the vertical pass.
  //
  // The colour build blurs in LINEAR light. This is the other half of the "too
  // grey" answer: averaging sRGB-encoded values is not averaging light, and it
  // pulls every mixture toward the middle — a bright window behind you goes
  // dull instead of blooming, and a colourful room turns to porridge. Each pass
  // linearises its taps, sums, and re-encodes, which keeps the intermediate
  // buffer sRGB-encoded (8 bits of linear light bands visibly in the darks).
  // Gamma 2.0 rather than 2.2: a multiply and a sqrt, exact at both ends, and
  // indistinguishable here from the real curve.
  function fragBlur(gamma) {
    var w = gaussianHalfKernel(BLUR_SIGMA, 5);
    var src = [
      '#version 300 es',
      'precision mediump float;',
      'in vec2 vUv;',
      'uniform sampler2D uTex;',
      'uniform vec2 uDir;',
      'out vec4 outColor;'
    ];
    for (var i = 0; i < w.length; i++) src.push('const float w' + i + ' = ' + w[i].toFixed(7) + ';');
    if (gamma) {
      src.push('vec3 lin(vec3 c) { return c * c; }');
      src.push('vec3 enc(vec3 c) { return sqrt(max(c, 0.0)); }');
      src.push('vec3 tap(vec2 uv) { return lin(texture(uTex, uv).rgb); }');
      src.push('void main() {');
      src.push('  vec3 sum = tap(vUv) * w0;');
      for (var j = 1; j < w.length; j++) {
        src.push('  sum += (tap(vUv + uDir * ' + j + '.0) + tap(vUv - uDir * ' + j + '.0)) * w' + j + ';');
      }
      src.push('  outColor = vec4(enc(sum), 1.0);');
      src.push('}');
    } else {
      src.push('void main() {');
      src.push('  float sum = texture(uTex, vUv).r * w0;');
      for (var k = 1; k < w.length; k++) {
        src.push('  sum += (texture(uTex, vUv + uDir * ' + k + '.0).r' +
                 ' + texture(uTex, vUv - uDir * ' + k + '.0).r) * w' + k + ';');
      }
      src.push('  outColor = vec4(sum, 0.0, 0.0, 1.0);');
      src.push('}');
    }
    return src.join('\n');
  }

  var FRAG_BLUR    = fragBlur(true);
  var FRAG_FEATHER = fragBlur(false);

  // The per-iteration strides that add up to a requested sigma.
  //
  // Each iteration strides twice the last, so their variances are in the ratio
  // 1 : 4 : 16 : … and the total is `first * sqrt((4^N - 1) / 3)` — solve that
  // for the first stride and the rest follow.
  //
  // The pass count is chosen, not passed in: take the fewest passes whose first
  // stride still lands under a texel, because a first stride wider than that is
  // the "skips detail instead of averaging it" failure. A stronger blur
  // therefore buys itself another pass rather than quietly degrading, which is
  // what lets one slider span a 10x range without changing character.
  //
  // Exported for the test that pins the arithmetic: an error here is a blur
  // that is silently the wrong size, and nothing else.
  function blurPlan(sigmaTexels) {
    var passes = 1;
    while (passes < BLUR_PASSES_MAX &&
           sigmaTexels / (BLUR_SIGMA * Math.sqrt((Math.pow(4, passes) - 1) / 3)) > 1) {
      passes++;
    }
    var first = sigmaTexels / (BLUR_SIGMA * Math.sqrt((Math.pow(4, passes) - 1) / 3));
    var steps = [];
    for (var i = 0; i < passes; i++) steps.push(first * Math.pow(2, i));
    return steps;
  }

  // Box downsample into the blur buffer: four bilinear taps at the quarters of
  // a destination texel, so each one averages a 2x2 source neighbourhood and
  // the four together cover the destination texel's whole footprint.
  //
  // The single tap this replaces read 4 source texels out of the 16 (or more)
  // that a destination texel covers, which is a point sample in all but name:
  // the discarded texels come back as aliasing, and aliasing that moves with
  // the frame is exactly the "boiling" you see in a cheap background blur.
  // Averaging in linear light, for the same reason the blur does.
  var FRAG_DOWNSAMPLE = [
    '#version 300 es',
    'precision mediump float;',
    'in vec2 vUv;',
    'uniform sampler2D uTex;',
    'uniform vec2 uOff;',
    'out vec4 outColor;',
    'vec3 lin(vec3 c) { return c * c; }',
    'void main() {',
    '  vec3 sum = lin(texture(uTex, vUv + vec2(-uOff.x, -uOff.y)).rgb);',
    '  sum += lin(texture(uTex, vUv + vec2( uOff.x, -uOff.y)).rgb);',
    '  sum += lin(texture(uTex, vUv + vec2(-uOff.x,  uOff.y)).rgb);',
    '  sum += lin(texture(uTex, vUv + vec2( uOff.x,  uOff.y)).rgb);',
    '  outColor = vec4(sqrt(max(sum * 0.25, 0.0)), 1.0);',
    '}'
  ].join('\n');

  // Separable max filter. Expands the subject by uDir per pass; the mask is a
  // single channel, so three taps is enough to matter and cheap enough to be
  // free at this size.
  //
  // The same filter with min() in place of max() erodes instead: that is the
  // reference's "core", where the model is trusted without asking.
  function fragMorph(op) {
    return [
      '#version 300 es',
      'precision mediump float;',
      'in vec2 vUv;',
      'uniform sampler2D uTex;',
      'uniform vec2 uDir;',
      'out vec4 outColor;',
      'void main() {',
      '  float m = texture(uTex, vUv).r;',
      '  m = ' + op + '(m, texture(uTex, vUv + uDir).r);',
      '  m = ' + op + '(m, texture(uTex, vUv - uDir).r);',
      '  outColor = vec4(m, 0.0, 0.0, 1.0);',
      '}'
    ].join('\n');
  }

  var FRAG_DILATE = fragMorph('max');
  var FRAG_ERODE  = fragMorph('min');

  // Temporal smoothing, and the reason it is asymmetric.
  //
  // A single blend factor forces a choice between two bad outcomes: blend
  // slowly and the mask lags a moving head, clipping it; blend quickly and the
  // model's frame-to-frame noise goes straight through, so the blur boils.
  //
  // So the mask grows quickly and shrinks slowly. A pixel the model has just
  // decided is part of you is trusted almost immediately; one it has just
  // dropped is given several inferences to prove it. Motion is tracked without
  // the flicker, because flicker is overwhelmingly pixels dropping out for a
  // frame and coming straight back.
  var FRAG_MASK_MIX = [
    '#version 300 es',
    'precision mediump float;',
    'in vec2 vUv;',
    'uniform sampler2D uPrev;',
    'uniform sampler2D uNext;',
    'uniform float uAlphaUp;',
    'uniform float uAlphaDown;',
    'out vec4 outColor;',
    'void main() {',
    '  float p = texture(uPrev, vUv).r;',
    '  float n = texture(uNext, vUv).r;',
    '  float a = (n > p) ? uAlphaUp : uAlphaDown;',
    '  outColor = vec4(mix(p, n, a), 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  // The empty-room reference: how much each pixel is NOT the room, per frame.
  //
  // refScore() in GLSL — same constants, same order — so the per-pixel answer
  // here and the CPU probe's "has the camera moved" answer cannot drift apart.
  // The camera is box-sampled (four bilinear taps, as FRAG_DOWNSAMPLE does)
  // into a buffer the reference's size, which averages away most of the sensor
  // noise that would otherwise make the edge shimmer — and the reference is
  // sampled through the same four taps, so both are equally soft. (It is also
  // already an average of REF_CAPTURE_FRAMES frames.)
  //
  // uGain is the exposure and white balance the camera has drifted by since the
  // capture, measured on the CPU over what the model calls room. The reference
  // is brought to the camera, not the other way round.
  //
  // Lightly blended with the previous frame's answer: a pixel-scale threshold
  // on a live camera flickers, and this costs one frame of lag at most.
  // Everything here stays in the mask's own convention (image rows top first,
  // sampled at vUv), so the composite samples it with `flip` like the mask.
  function fragRefDiff() {
    function f(v) { return v.toFixed(4); }
    return [
      '#version 300 es',
      'precision mediump float;',
      'in vec2 vUv;',
      'uniform sampler2D uCam;',
      'uniform sampler2D uPlate;',
      'uniform sampler2D uPrev;',
      'uniform vec3 uGain;',
      'uniform vec2 uOff;',
      'uniform float uAlpha;',
      'out vec4 outColor;',
      'void main() {',
      '  vec3 c = texture(uCam, vUv + vec2(-uOff.x, -uOff.y)).rgb;',
      '  c += texture(uCam, vUv + vec2( uOff.x, -uOff.y)).rgb;',
      '  c += texture(uCam, vUv + vec2(-uOff.x,  uOff.y)).rgb;',
      '  c += texture(uCam, vUv + vec2( uOff.x,  uOff.y)).rgb;',
      '  c *= 0.25;',
      // The reference through the SAME four taps. Sampled once, it is sharper
      // than the box-filtered camera, and every edge in the room — a door
      // frame, a shelf — would read as "different" along its length.
      '  vec3 p = texture(uPlate, vUv + vec2(-uOff.x, -uOff.y)).rgb;',
      '  p += texture(uPlate, vUv + vec2( uOff.x, -uOff.y)).rgb;',
      '  p += texture(uPlate, vUv + vec2(-uOff.x,  uOff.y)).rgb;',
      '  p += texture(uPlate, vUv + vec2( uOff.x,  uOff.y)).rgb;',
      '  p = clamp(p * 0.25 * uGain, 0.0, 1.0);',
      '  vec3 Y = vec3(0.2126, 0.7152, 0.0722);',
      '  float yc = dot(c, Y);',
      '  float yp = dot(p, Y);',
      '  float lum = abs(yc - yp) / max(max(yc, yp), 0.08);',
      '  vec3 cc = c / max(c.r + c.g + c.b, 0.03);',
      '  vec3 pc = p / max(p.r + p.g + p.b, 0.03);',
      '  float chroma = length(cc - pc) * 4.0 * smoothstep(0.04, 0.15, max(yc, yp));',
      '  float score = max(chroma, lum * 0.7);',
      '  float d = smoothstep(' + f(REF_SCORE_LO) + ', ' + f(REF_SCORE_HI) + ', score);',
      '  float prev = texture(uPrev, vUv).r;',
      '  outColor = vec4(mix(prev, d, uAlpha), 0.0, 0.0, 1.0);',
      '}'
    ].join('\n');
  }

  var FRAG_REF_DIFF = fragRefDiff();

  // uBgMode picks the background: 0 the blurred camera, 1 an image, 2 a scene.
  // uBgXform packs a cover-fit for the background image: xy scale, zw offset.
  // uEdge packs the smoothstep window the feathered mask is mapped through.
  //
  // A scene brings three more things, all read from uSoft — the finished mask,
  // shrunk to 64 wide and blurred wide (see buildSoft()):
  //   * your shadow: uSoft sampled toward the light (uShadowOff), darkening the
  //     scene by uShadow.x where the scene's alpha says the surface is near
  //     enough to take one — the wall behind you, never the distant hills;
  //   * a contact shadow (uShadow.y), uSoft sampled where you are: the faint
  //     darkening of a wall right behind a person, whatever the light;
  //   * the light wrap: the scene's light, from a coarse mip level of the
  //     small buffer it is drawn into (uSceneEnv), spilling onto the edge of
  //     your silhouette (uWrap). Screen-blended in linear light, so it only
  //     ever adds light — a neon sign tints your shoulder, a dark wall never
  //     dirties it.
  // uScene itself is the scene resolved at the camera's size (see
  // resolveScene()). Both are rendered in GL orientation, so they are sampled
  // at vUv, not at the flipped coordinate the camera needs.
  //
  // uKeyOut turns the same program into the keyed stream's frame (see
  // keyedTrack()): the person over the flat key colour, with the marker zones.
  // The same program on purpose — the keyed alpha must be EXACTLY the
  // composite's `m`, smoothstep and reference included, and a second program
  // computing it would drift from this one the first time either was tuned.
  // It takes the camera colour before the light wrap: the receiver wraps with
  // its own scene's light, and a frame wrapped here would be wrapped twice.
  // uZone is the marker zone's side in UV, (Z / width, Z / height).
  var FRAG_COMPOSITE = [
    '#version 300 es',
    'precision mediump float;',
    'in vec2 vUv;',
    'uniform sampler2D uSharp;',
    'uniform sampler2D uBlur;',
    'uniform sampler2D uImage;',
    'uniform sampler2D uMask;',
    'uniform float uBgMode;',
    'uniform vec4 uBgXform;',
    'uniform vec2 uEdge;',
    'uniform sampler2D uRef;',
    'uniform sampler2D uCore;',
    'uniform float uRefOn;',
    'uniform sampler2D uScene;',
    'uniform sampler2D uSceneEnv;',
    'uniform sampler2D uSoft;',
    'uniform vec2 uShadowOff;',
    'uniform vec2 uShadow;',
    'uniform float uWrap;',
    'uniform float uKeyOut;',
    'uniform vec2 uZone;',
    'uniform float uTiltOn;',
    'uniform highp uint uTiltBits;',
    'uniform float uDecon;',
    'out vec4 outColor;',
    'void main() {',
    '  vec2 flip = vec2(vUv.x, 1.0 - vUv.y);',
    '  vec3 sharp = texture(uSharp, flip).rgb;',
    // Wide, and biased low on purpose. Wide because a narrow window turns the
    // feather back into the hard cutout it was meant to soften — it maps almost
    // the whole gradient to 0 or 1 and keeps only a sliver as a transition.
    // Biased low because the confidence mask is not a clean 0/1 field: it falls
    // off gradually at the subject, and a window centred on 0.5 cuts inside the
    // face rather than outside it. Better to keep a sliver of background sharp
    // than to blur somebody's ear off. See MASK_EDGE_LO / MASK_EDGE_HI.
    '  float m = smoothstep(uEdge.x, uEdge.y, texture(uMask, flip).r);',
    // The empty-room reference, when there is one. `m` is the model's band —
    // dilated, so it reaches past you — and the reference only ever takes
    // away from it: outside the band it is never asked, so a shadow across
    // the room cannot be cut in. `core` is where the model is sure on its own
    // (the blended mask, eroded — see REF_CORE_ERODE), and there the reference
    // is not asked either, so a shirt the colour of the wall cannot be cut out.
    // uRefOn eases between the two answers, so a reference that goes stale
    // fades out rather than snapping.
    '  if (uRefOn > 0.001) {',
    '    float core = smoothstep(' + REF_CORE_LO.toFixed(4) + ', ' + REF_CORE_HI.toFixed(4) +
      ', texture(uCore, flip).r);',
    '    float d = texture(uRef, flip).r;',
    '    m = mix(m, m * max(d, core), uRefOn);',
    '  }',
    // The keyed frame. In flip space the top of the picture is y = 0, so the
    // zones are the two top corners there. Nothing of the scene, the shadow
    // or the wrap is drawn: the receiver draws all three itself.
    '  if (uKeyOut > 0.5) {',
    '    vec3 key = vec3(' + KEY_COLOR.map(function (c) { return (c / 255).toFixed(1); }).join(', ') + ');',
    '    if (m < ' + KEY_ALPHA_FLOOR.toFixed(4) + ') m = 0.0;',
    '    bool top = flip.y < uZone.y;',
    '    bool tl = top && flip.x < uZone.x;',
    '    bool tr = top && flip.x > 1.0 - uZone.x;',
    '    vec3 o = (tl || tr) ? key : mix(key, sharp, m);',
    // The tilt strip: 32 cells between the zones, bit i of uTiltBits, white
    // for 1. Drawn over the person — the receiver reserves it.
    '    if (uTiltOn > 0.5 && flip.y < uZone.y * ' + KEY_TILT.rows.toFixed(2) + ' && flip.x > uZone.x && flip.x < 1.0 - uZone.x) {',
    '      float cell = floor((flip.x - uZone.x) / (1.0 - 2.0 * uZone.x) * ' + KEY_TILT.cells.toFixed(1) + ');',
    '      cell = min(cell, ' + (KEY_TILT.cells - 1).toFixed(1) + ');',
    '      o = vec3(float((uTiltBits >> uint(cell)) & 1u));',
    '    }',
    '    if (tr) {',
    '      vec2 q = vec2(flip.x - (1.0 - uZone.x), flip.y) / uZone - 0.5;',
    '      if (max(abs(q.x), abs(q.y)) < ' + (KEY_MARKER.patch / 2).toFixed(4) + ') o = vec3(0.0);',
    '    }',
    '    outColor = vec4(o, 1.0);',
    '    return;',
    '  }',
    // Edge colour decontamination. A pixel in the matte's band is part person,
    // part the room behind them, and over a different background the room's
    // share shows as a halo. Where the band is, pull the pixel's colour toward
    // the person's own colour a little way inside (found along the matte's
    // gradient), by how much of the pixel is the old room: the colour it
    // would have had with no room behind it. Never run for the keyed frame
    // (returned above), and never for the blur, whose background IS the room.
    // Pure person pixels are not touched: their t below is 1.
    '  if (uDecon > 0.0 && uBgMode > 0.5 && m > 0.02 && m < 0.98) {',
    '    vec2 mt = 1.0 / vec2(textureSize(uMask, 0));',
    '    vec2 g = vec2(texture(uMask, flip + vec2(mt.x * 2.0, 0.0)).r - texture(uMask, flip - vec2(mt.x * 2.0, 0.0)).r,',
    '                  texture(uMask, flip + vec2(0.0, mt.y * 2.0)).r - texture(uMask, flip - vec2(0.0, mt.y * 2.0)).r);',
    '    float gl2 = length(g);',
    '    if (gl2 > 0.004) {',
    '      vec2 dir = g / gl2 * mt;',
    '      vec3 fg = vec3(0.0); float fw = 0.0;',
    '      vec3 bk = vec3(0.0); float bw = 0.0;',
    '      for (int i = 1; i <= 4; i++) {',
    '        float k = float(i) * ' + DECON_STEP.toFixed(1) + ';',
    '        vec2 pi = flip + dir * k;',
    '        vec2 po = flip - dir * k;',
    '        float mi = smoothstep(uEdge.x, uEdge.y, texture(uMask, pi).r);',
    '        float mo = smoothstep(uEdge.x, uEdge.y, texture(uMask, po).r);',
    '        float wi = smoothstep(0.9, 1.0, mi);',
    '        float wo = 1.0 - smoothstep(0.0, 0.1, mo);',
    '        fg += texture(uSharp, pi).rgb * wi; fw += wi;',
    '        bk += texture(uSharp, po).rgb * wo; bw += wo;',
    '      }',
    '      if (fw > 0.5 && bw > 0.5) {',
    '        fg /= fw; bk /= bw;',
    '        vec3 d = fg - bk;',
    '        float dd = dot(d, d);',
    '        if (dd > 0.004) {',
    '          float t = clamp(dot(sharp - bk, d) / dd, 0.0, 1.0);',
    '          float band = clamp(6.0 * m * (1.0 - m), 0.0, 1.0);',
    '          sharp = mix(sharp, fg, (1.0 - t) * band * uDecon);',
    '        }',
    '      }',
    '    }',
    '  }',
    '  vec3 bg;',
    '  float soft = 0.0;',
    '  if (uBgMode > 1.5) {',
    '    vec4 sc = texture(uScene, vUv);',
    '    soft = texture(uSoft, flip).r;',
    '    float thrown = texture(uSoft, flip + uShadowOff).r;',
    '    float shade = clamp(thrown * uShadow.x + soft * uShadow.y, 0.0, 0.85);',
    '    bg = sc.rgb * (1.0 - sc.a * shade);',
    '  } else if (uBgMode > 0.5) {',
    '    vec2 uv = clamp(flip * uBgXform.xy + uBgXform.zw, 0.0, 1.0);',
    '    bg = texture(uImage, uv).rgb;',
    '  } else {',
    '    bg = texture(uBlur, flip).rgb;',
    '  }',
    '  if (uBgMode > 1.5 && uWrap > 0.0) {',
    '    vec3 env = textureLod(uSceneEnv, vUv, 3.0).rgb;',
    '    float rim = uWrap * (1.0 - smoothstep(0.4, 0.95, soft));',
    '    vec3 s = sharp * sharp;',
    '    sharp = sqrt(s + env * env * rim * (1.0 - s));',
    '  }',
    '  outColor = vec4(mix(bg, sharp, m), 1.0);',
    '}'
  ].join('\n');

  // --- the receiving end's shaders --------------------------------------------
  //
  // Is this frame keyed? Asked of every frame, by the shader itself, from a
  // handful of taps in the two zones — so a peer that swaps back to the
  // composite (or never left it) is passed through untouched on the very frame
  // it arrives, and the tile's srcObject never has to change.
  //
  // Two strengths of the question. The STRICT one wants the whole pattern:
  // the top-left zone key-like, the top-right ring key-like and its patch
  // dark. That is what a receiver asks while it has no reason to expect keyed
  // frames, so an ordinary picture with a green top-left corner is never cut
  // up. The RELAXED one, asked while this receiver has acked keyed frames or
  // has just seen one, wants only the top-left zone key-like and the patch
  // not key-like: on a starved link the patch's chroma converges frames after
  // the flat green does, and the strict test would pass those frames through
  // — as a full-screen green flash.
  //
  // `kd` is the key colour as it decoded (limited-range YUV, a matrix mismatch
  // and 4:2:0 all move it off pure green), averaged over the top-left taps.
  // Everything is in image coordinates: x right, y DOWN, as the camera
  // texture's rows are stored.
  function keyDetectGlsl() {
    function tap(side, p) {
      var f = function (i) { return ((i + 0.5) / KEY_TAP_GRID).toFixed(4); };
      return 'zoneTap(' + side + ', vec2(' + f(p[0]) + ', ' + f(p[1]) + '))';
    }
    var src = [
      'uniform float uTiltStrip;',
      'float keyE(vec3 x) { return x.g - max(x.r, x.b); }',
      'bool keyLike(vec3 x) { return x.g > 0.75 && x.r < 0.25 && x.b < 0.25; }',
      'vec3 zoneTap(float side, vec2 f) {',
      '  vec2 o = vec2(side > 0.5 ? 1.0 - uZone.x : 0.0, 0.0);',
      '  return texture(uCam, o + f * uZone).rgb;',
      '}',
      'vec4 keyDetect() {',
      '  vec3 kd = vec3(0.0);',
      '  vec3 t;',
      '  bool tl = true;'
    ];
    KEY_TAPS.tl.forEach(function (p) {
      src.push('  t = ' + tap('0.0', p) + '; tl = tl && keyLike(t); kd += t;');
    });
    src.push('  kd /= ' + KEY_TAPS.tl.length.toFixed(1) + ';');
    src.push('  vec3 p = (' + KEY_TAPS.patch.map(function (p) { return tap('1.0', p); }).join(' + ') +
             ') / ' + KEY_TAPS.patch.length.toFixed(1) + ';');
    src.push('  bool keyed;');
    src.push('  if (uExpectKeyed > 0.5 || uKeyedRecently > 0.5) {');
    src.push('    keyed = tl && keyE(p) < 0.35;');
    src.push('  } else {');
    src.push('    bool ring = true;');
    KEY_TAPS.ring.forEach(function (p) {
      src.push('    ring = ring && keyLike(' + tap('1.0', p) + ');');
    });
    src.push('    keyed = tl && ring && max(p.r, max(p.g, p.b)) < 0.25;');
    src.push('  }');
    src.push('  return vec4(kd, keyed ? 1.0 : 0.0);');
    src.push('}');
    // The raw key alpha: how far a pixel is from the key, as a share of how
    // far the key is from grey. 1 - e(c)/e(K): the composite's own m times
    // (1 - e(camera)), which is why a reddish face reaches 1 early and a
    // greenish one never does.
    src.push('float keyA0(vec3 c, vec3 kd) { return 1.0 - keyE(c) / max(keyE(kd), 0.3); }');
    // The low end is the sender's own floor (and codec noise in the flat
    // field), the top end the saturation; between them the alpha is taken as
    // it is. See KEYIN_SATURATE.
    src.push('float keyRamp(float a) { return a < ' + KEY_ALPHA_FLOOR.toFixed(4) + ' ? 0.0 : (a > ' +
             KEYIN_SATURATE.toFixed(4) + ' ? 1.0 : a); }');
    // The two corner zones, and — when the sender's offer says it draws one —
    // the tilt strip between them.
    src.push('bool inZone(vec2 q) {');
    src.push('  if (q.y < uZone.y && (q.x < uZone.x || q.x > 1.0 - uZone.x)) return true;');
    src.push('  return uTiltStrip > 0.5 && q.y < uZone.y * ' + KEY_TILT.rows.toFixed(2) +
             ' && q.x > uZone.x && q.x < 1.0 - uZone.x;');
    src.push('}');
    return src;
  }

  // The key-in's own matte, at the mask's working size, every frame. Two
  // channels:
  //   r: the key alpha, box-averaged over the destination texel — what the
  //      soft mask (and so the shadow and the light wrap's rim) is built from,
  //      exactly as the sender builds its soft mask from its finished mask;
  //   g: the LOWEST raw alpha within KEYIN_BAND_REACH — "is there background
  //      near here". The composite uses it to tell the edge band, where the
  //      edgeE correction applies, from the inside of the person, where the
  //      alpha is simply 1.
  // Its rows stay in the camera's order (top first), so the composite samples
  // it at `flip` like the sender's mask.
  var FRAG_KEY_MASK = [
    '#version 300 es',
    'precision mediump float;',
    'in vec2 vUv;',
    'uniform sampler2D uCam;',
    'uniform vec2 uZone;',
    'uniform float uExpectKeyed;',
    'uniform float uKeyedRecently;',
    'uniform vec2 uOff;',
    'uniform vec2 uReach;',
    'out vec4 outColor;'
  ].concat(keyDetectGlsl(), [
    'void main() {',
    '  vec4 det = keyDetect();',
    '  if (det.a < 0.5) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }',
    '  vec2 q = vUv;',
    '  vec3 kd = det.rgb;',
    '  float a = keyRamp(clamp(keyA0(texture(uCam, q + vec2(-uOff.x, -uOff.y)).rgb, kd), 0.0, 1.0));',
    '  a += keyRamp(clamp(keyA0(texture(uCam, q + vec2( uOff.x, -uOff.y)).rgb, kd), 0.0, 1.0));',
    '  a += keyRamp(clamp(keyA0(texture(uCam, q + vec2(-uOff.x,  uOff.y)).rgb, kd), 0.0, 1.0));',
    '  a += keyRamp(clamp(keyA0(texture(uCam, q + vec2( uOff.x,  uOff.y)).rgb, kd), 0.0, 1.0));',
    '  a *= 0.25;',
    '  float near = keyA0(texture(uCam, q).rgb, kd);',
    '  for (int i = 0; i < 8; i++) {',
    '    float ang = float(i) * 0.7853982;',
    '    near = min(near, keyA0(texture(uCam, q + vec2(cos(ang), sin(ang)) * uReach).rgb, kd));',
    '  }',
    '  if (inZone(q)) { a = 0.0; near = 0.0; }',
    '  outColor = vec4(a, clamp(near, 0.0, 1.0), 0.0, 1.0);',
    '}'
  ]).join('\n');

  // The key-in composite: the incoming frame `c`, cut out and put over this
  // device's own render of the sender's scene.
  //
  // a0 is the raw key alpha. In the edge band it is divided by (1 - edgeE),
  // edgeE being the sender's own measure of how green its edge pixels are
  // (the median e(camera) over its band, <= 0): a face is redder than green,
  // so its a0 runs ahead of the true m by exactly that factor, and the
  // correction brings it back. Inside the person the alpha is 1 — the frame's
  // pixel, untouched.
  //
  // Then `c + (bg - kd)(1 - a)`, which is mix(bg, S, a) for the subject's own
  // colour S without ever computing S as a clamped number: a pixel that is
  // 70% person keeps the encoder's own rounding rather than having it
  // amplified by a division. S is only computed for the two things that need
  // it — taking the leftover key out of a partly keyed pixel (the despill,
  // only where a0 < 1) and the light wrap, the scene's light on your outline,
  // done as FRAG_COMPOSITE does it — and enters as a correction weighted by a.
  //
  // Passthrough, when the frame is not keyed, is the input unchanged. The
  // scene is still sampled (and drawn) in passthrough: its history stays warm
  // and what the receiver pays is what it will pay once keyed frames arrive.
  var FRAG_KEYIN = [
    '#version 300 es',
    'precision mediump float;',
    'in vec2 vUv;',
    'uniform sampler2D uCam;',
    'uniform sampler2D uMask;',
    'uniform sampler2D uScene;',
    'uniform sampler2D uSceneEnv;',
    'uniform sampler2D uSoft;',
    'uniform vec2 uZone;',
    'uniform float uExpectKeyed;',
    'uniform float uKeyedRecently;',
    'uniform float uEdgeE;',
    'uniform vec2 uShadowOff;',
    'uniform vec2 uShadow;',
    'uniform float uWrap;',
    'uniform float uHasScene;',
    'uniform vec3 uFlat;',
    'uniform vec2 uFit;',
    'out vec4 outColor;'
  ].concat(keyDetectGlsl(), [
    'void main() {',
    // The output may be bigger than the picture (see setStageAspect): the
    // picture sits whole in the middle and the scene fills what is left.
    '  vec2 pq = (vUv - 0.5) * uFit + 0.5;',
    '  bool outside = pq.x < 0.0 || pq.x > 1.0 || pq.y < 0.0 || pq.y > 1.0;',
    '  vec2 flip = vec2(clamp(pq.x, 0.0, 1.0), 1.0 - clamp(pq.y, 0.0, 1.0));',
    '  vec3 c = texture(uCam, flip).rgb;',
    '  vec3 bg = uFlat;',
    '  float soft = 0.0;',
    '  if (uHasScene > 0.5) {',
    '    vec4 sc = texture(uScene, vUv);',
    '    soft = texture(uSoft, flip).r;',
    '    float thrown = texture(uSoft, flip + uShadowOff).r;',
    '    float shade = clamp(thrown * uShadow.x + soft * uShadow.y, 0.0, 0.85);',
    '    bg = sc.rgb * (1.0 - sc.a * shade);',
    '  }',
    '  if (outside) { outColor = vec4(bg, 1.0); return; }',
    '  vec4 det = keyDetect();',
    '  if (det.a < 0.5) { outColor = vec4(c, 1.0); return; }',
    '  if (inZone(flip)) { outColor = vec4(bg, 1.0); return; }',
    '  vec3 kd = det.rgb;',
    '  float a0 = keyA0(c, kd);',
    '  float near = texture(uMask, flip).g;',
    '  float a = near < ' + KEYIN_BAND_A0.toFixed(4) + ' ? clamp(a0 / (1.0 - uEdgeE), 0.0, 1.0) : 1.0;',
    '  a = keyRamp(a);',
    '  vec3 S = (c - kd * (1.0 - a)) / max(a, 1.0 / 255.0);',
    '  float spill = max(0.0, S.g - max(S.r, S.b)) * clamp((1.0 - a0) * ' + KEYIN_DESPILL.toFixed(2) + ', 0.0, 1.0);',
    '  vec3 F = clamp(S - vec3(0.0, spill, 0.0), 0.0, 1.0);',
    '  vec3 lit = F;',
    '  if (uHasScene > 0.5 && uWrap > 0.0) {',
    '    vec3 env = textureLod(uSceneEnv, vUv, 3.0).rgb;',
    '    float rim = uWrap * (1.0 - smoothstep(0.4, 0.95, soft));',
    '    vec3 s = F * F;',
    '    lit = sqrt(s + env * env * rim * (1.0 - s));',
    '  }',
    '  vec3 o = c + (bg - kd) * (1.0 - a) + a * (lit - F - vec3(0.0, spill, 0.0));',
    '  outColor = vec4(clamp(o, 0.0, 1.0), 1.0);',
    '}'
  ]).join('\n');

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('shader compile failed: ' + log);
    }
    return sh;
  }

  function program(gl, fragSrc) {
    var p = gl.createProgram();
    var vs = compile(gl, gl.VERTEX_SHADER, VERT);
    var fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      var log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error('program link failed: ' + log);
    }
    return p;
  }

  var _uCache = new WeakMap();

  function uloc(gl, prog, name) {
    var m = _uCache.get(prog);
    if (!m) { m = {}; _uCache.set(prog, m); }
    if (!(name in m)) m[name] = gl.getUniformLocation(prog, name);
    return m[name];
  }

  function texture(gl, w, h, internal, format, type) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (w && h) gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    return t;
  }

  function framebuffer(gl, tex) {
    var fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return fb;
  }

  // One triangle that covers the viewport, which every pass draws. Stored as
  // `quad` and `vao` on whatever owns the context.
  function fullScreenTriangle(gl, owner) {
    owner.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, owner.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    owner.vao = gl.createVertexArray();
    gl.bindVertexArray(owner.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  // An off-DOM <video> playing a stream, for a pipeline to read frames from.
  function hiddenVideo(stream) {
    var v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.autoplay = true;
    v.setAttribute('playsinline', '');
    v.srcObject = stream;
    return v;
  }

  // Point such a <video> at another stream. Never a bare srcObject switch,
  // because of a Chromium crash (seen in 141): while a frame callback runs,
  // asking for the next one has Chromium look for that frame at the next
  // rendering step — and if the source was switched in the same task, it
  // looks at the NEW player. A player that has not shown its first frame has
  // none to describe; with a callback registered it dereferences null and the
  // whole tab dies. Whether that callback was asked for before the switch or
  // just after makes no difference, only that one is registered before the
  // new stream's first frame. Here one is registered nearly always
  // (onFrame() asks for the next one first), and that task is exactly where
  // main.js swaps a source: in the promise a frame callback has just
  // resolved, which is where a key-in handle is first given its stream.
  // So `cancel` takes the pending callback away before the switch and must
  // also hold the loop off — nothing may ask for a frame meanwhile, not even
  // the frame loop's own pump() — and `rearm` lets it go only once the new
  // stream has put up a picture: videoWidth is read from the player's current
  // frame, so a non-zero one means the frame the callback needs is there.
  // `current` lets a newer switch, or a teardown, call the wait off; it is a
  // poll, not a frame event, because asking for a frame event is the very
  // thing that crashes. Resolves with play(), as the bare switch did.
  function repointVideo(video, stream, cancel, rearm, current) {
    cancel();
    video.srcObject = stream;
    var played = video.play().catch(function () { /* muted autoplay */ });
    (function wait() {
      if (!current()) return;
      if (video.videoWidth && video.readyState >= 2) { rearm(); return; }
      setTimeout(wait, 40);
    })();
    return played;
  }

  function median(values) {
    if (!values.length) return 0;
    var s = values.slice().sort(function (a, b) { return a - b; });
    return s[s.length >> 1];
  }

  // --- the processor --------------------------------------------------------

  var _active = null;      // at most one camera pipeline at a time
  var _onOverload = null;  // set by main.js; called when we give up on a device

  // The empty-room reference, held at module level rather than on a processor
  // so turning the camera off and on again does not throw it away. In memory
  // only: { w, h, rgba, sw, sh, small, aspect, deviceId }. `rgba` is the
  // comparison buffer's size; `small` is the CPU probe's (0-1 floats, RGB).
  var _plate = null;
  var _onReference = null; // set by main.js; called with the new state

  // The keyed stream's hooks and bookkeeping. Every keyed track ever made is
  // remembered (weakly), so isKeyedTrack() still answers for a track whose
  // processor has gone — main.js asks exactly then, to move a sender off it.
  var _onKeyedState = null;   // fn(stream): a published stream's keyed state changed
  var _onPressure = null;     // fn() -> true when load was shed elsewhere
  var _keyedTracks = (typeof WeakSet === 'function') ? new WeakSet() : null;
  var _keyIns = [];           // live KeyInProcessors

  function Processor(rawStream, mode) {
    this.raw = rawStream;
    this.mode = normalizeMode(mode);
    this.paused = false;
    this.stopped = false;

    this.segmenter = null;
    this.segHzSteps = segHzFor(readQuality(), IS_MOBILE);
    this.segStep = 0;
    this.segInterval = 1000 / this.segHzSteps[0];
    this.lastSeg = 0;
    this.lastTs = -1;

    // The three edge numbers, derived together from one preference. Read once
    // here and refreshed by applyEdge(); the draw loop must not touch
    // localStorage.
    this.edge = edgeProfile(readSharpness());
    this.decon = DECON_STRENGTH;

    // Low-light state. gain 1 / contrast 1 means "set no canvas filter at
    // all", which is both the well-lit case and the unsupported one.
    this.lightAdapt = readLightAdapt();
    this.lightGain = 1;
    this.lightContrast = 1;
    this.lastLight = 0;

    // The empty-room reference. refWeight eases toward 1 while a reference is
    // loaded and still matches the room, toward 0 otherwise.
    this.refOn = readReference();
    this.refLoaded = false;
    this.refStale = false;
    this.refWeight = 0;
    this.refGain = [1, 1, 1];
    this.lastRefStats = 0;
    this.refCapture = null;
    this.refStateSent = null;

    this.frames = 0;
    this.windowStart = 0;
    this.slowWindows = 0;

    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
    this.video.setAttribute('playsinline', '');
    this.video.srcObject = rawStream;

    this.canvas = document.createElement('canvas');
    this.gl = null;
    this.stream = null;
    this.track = null;
    this.bgReady = false;
    this.bgAspect = 1;

    // The animated scene, when the mode is one. Its buffers are allocated the
    // first time a scene is chosen and never for blur or an image — the same
    // "you do not pay for what you did not pick" rule as off. See ensureScene().
    this.sceneId = null;
    this.scene = null;
    this.sceneProgs = {};
    this.pResolve = undefined; // compiled with the first scene, null if it failed (see resolveScene())
    this.texSceneOut = null;   // [2]: the scene at the camera's size, taking turns
    this.fbSceneOut = null;
    this.sceneOut = 0;         // which of the two holds the picture
    this.sceneAge = 0;         // redraws added into it since the scene was picked
    this.sceneLook = 0;        // which JITTER point the next redraw looks through
    this.sceneHzSteps = SCENE_HZ.slice();
    this.sceneStep = 0;
    this.lastScene = 0;
    this.lastDraw = 0;
    this.sceneStart = 0;
    // How the subject is lit, as measured (lookTarget) and as drawn (look,
    // eased toward the target every frame). Kept across scene changes: the
    // room you are in has not changed because the backdrop did.
    this.look = VideoScenes.defaultLook();
    this.lookTarget = VideoScenes.defaultLook();
    this.lastLook = 0;
    this.lookPrev = null;
    this.lookCtx = null;

    // The keyed output (see keyedTrack()). Nothing at all until main.js asks
    // for it, so a camera whose owner never turned the setting on draws,
    // copies and measures exactly what it did before the feature existed.
    this.keyed = null;
    this.sceneCompiling = false;
    this.rebuilding = false;
    this.keyGreen = false;
    this.keyGreenClear = 0;
    this.keyCorner = false;
    this.keyCornerClear = 0;
    this.edgeE = 0;
    this.edgeEMeasured = false;
    this.lastEdgeE = 0;

    // A context the browser takes away — the GPU process restarting, or the
    // page holding more contexts than it may — is a camera that would freeze
    // for every peer on a track that still says "live". Better to give up
    // out loud: main.js's overload handler turns the effect off and the peers
    // get the plain camera. destroy() loses the context on purpose, after
    // `stopped` is set, so that one never reaches giveUp().
    var self = this;
    this.canvas.addEventListener('webglcontextlost', function (ev) {
      ev.preventDefault();
      self.giveUp('context-lost');
    });
  }

  Processor.prototype.targetFps = function () {
    var t = this.raw && this.raw.getVideoTracks()[0];
    var s = t && t.getSettings ? t.getSettings() : null;
    return (s && s.frameRate) ? Math.round(s.frameRate) : (IS_MOBILE ? 24 : 30);
  };

  Processor.prototype.sizeFromTrack = function () {
    var t = this.raw && this.raw.getVideoTracks()[0];
    var s = t && t.getSettings ? t.getSettings() : null;
    var w = (s && s.width) || this.video.videoWidth || 1280;
    var h = (s && s.height) || this.video.videoHeight || 720;
    // Track settings can lag a rotation (or never change on some phones) while
    // the frames already arrive the other way up: the video's shape wins.
    var vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (vw && vh && (vw >= vh) !== (w >= h)) { var t0 = w; w = h; h = t0; }
    return { w: w, h: h };
  };

  Processor.prototype.start = function () {
    var self = this;
    return this.video.play().catch(function () { /* autoplay of a muted local stream */ })
      .then(function () { return self.waitForFrame(); })
      .then(function () { return createSegmenter(); })
      .then(function (seg) {
        if (self.stopped) { try { seg.close(); } catch (e) { /* ignore */ } return null; }
        self.segmenter = seg;
        self.initGL();
        return self.applyBackground(self.mode).then(function () {
          var fps = self.targetFps();
          var cs = self.canvas.captureStream(0);
          var track = cs.getVideoTracks()[0];
          if (!track || typeof track.requestFrame !== 'function') {
            // Safari has captureStream but not requestFrame; let the browser
            // pull frames on its own clock instead.
            try { cs.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
            cs = self.canvas.captureStream(fps);
            track = cs.getVideoTracks()[0];
            self.manualFrames = false;
          } else {
            self.manualFrames = true;
          }
          self.stream = cs;
          self.track = track;
          // Read back by stopStreamTracks(): the processed stream is a canvas
          // capture, so stopping its track leaves the real camera running.
          cs._effectsOriginal = self.raw;
          cs._effectsProcessor = self;
          self.pump();
          return cs;
        });
      });
  };

  Processor.prototype.waitForFrame = function () {
    var v = this.video;
    if (v.readyState >= 2 && v.videoWidth) return Promise.resolve();
    return new Promise(function (resolve) {
      var done = false;
      var finish = function () { if (!done) { done = true; resolve(); } };
      v.addEventListener('loadeddata', finish, { once: true });
      setTimeout(finish, 3000);   // never hang the camera button on a stalled decode
    });
  };

  Processor.prototype.initGL = function () {
    var size = this.sizeFromTrack();
    this.canvas.width = size.w;
    this.canvas.height = size.h;

    // Not desynchronized: the canvas is never in the DOM, so the low-latency
    // path has nothing to make faster, and the keyed copy (keyedTrack()) reads
    // the back buffer in the same task — a path the flag could only make
    // stranger on the platforms where it actually engages.
    var gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      desynchronized: false,
      preserveDrawingBuffer: false
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    fullScreenTriangle(gl, this);

    this.pDown = program(gl, FRAG_DOWNSAMPLE);
    this.pBlur = program(gl, FRAG_BLUR);
    this.pFeather = program(gl, FRAG_FEATHER);
    this.pMix  = program(gl, FRAG_MASK_MIX);
    this.pDilate = program(gl, FRAG_DILATE);
    this.pComp = program(gl, FRAG_COMPOSITE);
    this.pRef  = program(gl, FRAG_REF_DIFF);
    this.pErode = program(gl, FRAG_ERODE);

    this.texCam = texture(gl, 1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    this.texImg = texture(gl, 1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);

    // The background is blurred at a fixed size, not at a fixed fraction of the
    // frame, so the blur is the same *visible* strength on every camera and
    // costs the same on a 4K one as on a 720p one. A 9-tap pass down here is
    // worth a far wider one at full size, for a fraction of the fill rate — and
    // it looks better, because a downsampled Gaussian upsamples into something
    // closer to a real defocus than any single full-resolution pass.
    var bscale = Math.min(1, BLUR_LONG / Math.max(size.w, size.h));
    var bw = Math.max(1, Math.round(size.w * bscale));
    var bh = Math.max(1, Math.round(size.h * bscale));
    this.blurW = bw; this.blurH = bh;
    this.applyStrength();
    this.texBlurA = texture(gl, bw, bh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    this.texBlurB = texture(gl, bw, bh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    this.fbBlurA = framebuffer(gl, this.texBlurA);
    this.fbBlurB = framebuffer(gl, this.texBlurB);

    // Matched to the camera's aspect, not to a fixed 16:9 — see SEG_LONG.
    var seg = segSizeFor(size.w, size.h);
    this.segW = seg.width; this.segH = seg.height;
    // The frame is downscaled into this before inference, so the mask comes
    // back at segW x segH instead of at the capture resolution.
    this.segCanvas = document.createElement('canvas');
    this.segCanvas.width = this.segW; this.segCanvas.height = this.segH;
    this.segCtx = this.segCanvas.getContext('2d', { willReadFrequently: false });

    // The luma probe: 96 pixels, read back a couple of times a second. Small
    // enough that getImageData's synchronous readback is genuinely free, and
    // large enough to tell a dim room from a bright one and a lit face from a
    // backlit silhouette. Its own canvas, because the seg canvas is written by
    // a filtered draw and measuring the *result* of the gain would make the
    // adaptation a feedback loop.
    this.lumaCanvas = document.createElement('canvas');
    this.lumaCanvas.width = LIGHT_GRID_W; this.lumaCanvas.height = LIGHT_GRID_H;
    this.lumaCtx = this.lumaCanvas.getContext('2d', { willReadFrequently: true });
    // Canvas filters are what apply the gain. Older WebKit has no ctx.filter at
    // all, and there the honest answer is to leave the frame alone.
    this.lightFilterOk = (typeof this.segCtx.filter === 'string');

    this.texMaskRaw = texture(gl, this.segW, this.segH, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    // Two pairs, deliberately. S/SB is the temporal blend's own memory; A/B is
    // scratch for the dilate and the feather. Sharing one pair is what let the
    // filters compound into their own input — see uploadMask().
    this.texMaskS = texture(gl, this.segW, this.segH, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    this.texMaskSB = texture(gl, this.segW, this.segH, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    this.texMaskA = texture(gl, this.segW, this.segH, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    this.texMaskB = texture(gl, this.segW, this.segH, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    this.fbMaskS = framebuffer(gl, this.texMaskS);
    this.fbMaskSB = framebuffer(gl, this.texMaskSB);
    this.fbMaskA = framebuffer(gl, this.texMaskA);
    this.fbMaskB = framebuffer(gl, this.texMaskB);
    this.maskPrimed = false;

    // The empty-room reference: the picture itself, a ping-pong pair for the
    // per-frame difference (the pair is the temporal blend's memory), and a
    // 64-wide 2D canvas the CPU reads to notice a camera that has moved. All
    // of it is allocated whether or not the feature is on — a few hundred KB
    // of GPU memory — so switching it on mid-call never rebuilds anything.
    var ref = refSizeFor(size.w, size.h);
    this.refW = ref.width; this.refH = ref.height;
    this.texPlate = texture(gl, this.refW, this.refH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    this.texRefA = texture(gl, this.refW, this.refH, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    this.texRefB = texture(gl, this.refW, this.refH, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    this.fbRefA = framebuffer(gl, this.texRefA);
    this.fbRefB = framebuffer(gl, this.texRefB);
    // The core: the blended mask, eroded. Mask-sized, rebuilt per inference
    // while a reference is loaded.
    this.texCore = texture(gl, this.segW, this.segH, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    this.fbCore = framebuffer(gl, this.texCore);
    var sscale = REF_STATS_LONG / Math.max(this.refW, this.refH);
    this.refSW = Math.max(2, Math.round(this.refW * sscale));
    this.refSH = Math.max(2, Math.round(this.refH * sscale));
    this.refStatsCanvas = document.createElement('canvas');
    this.refStatsCanvas.width = this.refSW; this.refStatsCanvas.height = this.refSH;
    this.refStatsCtx = this.refStatsCanvas.getContext('2d', { willReadFrequently: true });
    this.refLoaded = false;
    this.syncReference();

    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  };

  Processor.prototype.drawQuad = function (fb, w, h) {
    var gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb || null);
    gl.viewport(0, 0, w, h);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  };

  Processor.prototype.bindTex = function (prog, name, unit, tex) {
    var gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(uloc(gl, prog, name), unit);
  };

  // Re-derive the strides for the current preference.
  //
  // Nothing is reallocated and nothing is renegotiated: the strength lives
  // entirely in the uniforms of a pass that already runs, so moving the slider
  // mid-call is the same kind of non-event as switching blur to an image. The
  // published track is still the canvas.
  Processor.prototype.applyStrength = function () {
    if (!this.blurW) return;
    // The strength is a fraction of the frame and the buffer's long side spans
    // exactly that, so the sigma in texels is the two multiplied.
    this.blurSteps = blurPlan(readStrength() * Math.max(this.blurW, this.blurH));
  };

  // Re-read the edge preference. Three uniforms of passes that already run, so
  // this is the same kind of non-event as moving the blur slider: no
  // reallocation, no track swap, nothing on the wire. The next inference
  // rebuilds the mask with the new profile, which at 10-24 Hz is immediate.
  Processor.prototype.applyEdge = function () {
    this.edge = edgeProfile(readSharpness());
  };

  // Re-read the accuracy preference and start again at the top of the new
  // ladder.
  //
  // Starting at the top rather than trying to hold the current rung is
  // deliberate: the rungs are not the same between ladders, and a device that
  // needed stepping down will be stepped down again within one measurement
  // window anyway. Resetting that window is part of it — carrying a window
  // that began under the old rate into a judgement about the new one is how
  // you get an instant, spurious step-down.
  Processor.prototype.applyQuality = function () {
    this.segHzSteps = segHzFor(readQuality(), IS_MOBILE);
    this.segStep = 0;
    this.segInterval = 1000 / this.segHzSteps[0];
    this.frames = 0;
    this.windowStart = 0;
    this.slowWindows = 0;
  };

  // Re-read the low-light preference. Switching it off drops the gain back to
  // 1 at the next inference, which clears the canvas filter entirely.
  Processor.prototype.applyLightAdapt = function () {
    this.lightAdapt = readLightAdapt();
    if (!this.lightAdapt) { this.lightGain = 1; this.lightContrast = 1; }
    this.lastLight = 0;
  };

  // --- the empty-room reference ---------------------------------------------

  // Re-read the preference. Switching it off drops the reference from this
  // processor; refreshReference() is what forgets the picture itself.
  Processor.prototype.applyReference = function () {
    this.refOn = readReference();
    if (!this.refOn && this.refCapture) this.finishCapture({ ok: false, reason: 'off' });
    this.syncReference();
  };

  // The camera this processor is reading, as far as the browser will say.
  Processor.prototype.deviceId = function () {
    var t = this.raw && this.raw.getVideoTracks()[0];
    var st = t && t.getSettings ? t.getSettings() : null;
    return (st && st.deviceId) || '';
  };

  // Load the module's reference into this processor's GL state if it belongs
  // to this camera — same device, same shape — and drop it otherwise. A
  // reference of another camera, or of the same one at another aspect, is not
  // "slightly off", it is a different room.
  Processor.prototype.syncReference = function () {
    var gl = this.gl;
    var p = _plate;
    var fits = !!(gl && this.refOn && p && p.w === this.refW && p.h === this.refH &&
                  (!p.deviceId || !this.deviceId() || p.deviceId === this.deviceId()));
    if (fits && !this.refLoaded) {
      gl.bindTexture(gl.TEXTURE_2D, this.texPlate);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, p.w, p.h, gl.RGBA, gl.UNSIGNED_BYTE, p.rgba);
      // The difference starts from "all room" and is pulled toward the truth
      // within a few frames; the weight eases in over the same span.
      [this.fbRefA, this.fbRefB].forEach(function (fb) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      });
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.refGain = [1, 1, 1];
      this.refStale = false;
      this.lastRefStats = 0;
    }
    this.refLoaded = fits;
    if (!fits) this.refStale = false;
    this.emitReference();
  };

  Processor.prototype.referenceState = function () {
    if (!this.refOn) return 'off';
    if (this.refCapture) return 'capturing';
    if (!this.refLoaded) return 'none';
    return this.refStale ? 'stale' : 'ready';
  };

  Processor.prototype.emitReference = function () {
    var st = this.referenceState();
    if (st === this.refStateSent) return;
    this.refStateSent = st;
    if (_onReference && _active === this) { try { _onReference(st); } catch (e) { /* ignore */ } }
  };

  // Photograph the empty room. Resolves { ok: true } or { ok: false, reason }
  // with reason 'present' (the model still sees somebody), 'off', 'timeout' or
  // 'unavailable'. Never rejects: a failed capture is something to tell the
  // user, not an error.
  //
  // REF_CAPTURE_FRAMES consecutive frames are averaged, which takes the sensor
  // noise down by ~3.5x — and the model is watched throughout, so a capture
  // with somebody still in it is refused rather than learnt. The countdown
  // that gives the user time to step out belongs to the caller.
  Processor.prototype.captureReference = function () {
    var self = this;
    if (!this.gl || this.stopped) return Promise.resolve({ ok: false, reason: 'unavailable' });
    if (!this.refOn) return Promise.resolve({ ok: false, reason: 'off' });
    if (this.refCapture) return this.refCapture.promise;
    var cap = {
      frames: 0,
      inferences: 0,
      present: 0,
      acc: new Float32Array(this.refW * this.refH * 3),
      canvas: document.createElement('canvas'),
      started: performance.now()
    };
    cap.canvas.width = this.refW; cap.canvas.height = this.refH;
    cap.ctx = cap.canvas.getContext('2d', { willReadFrequently: true });
    cap.promise = new Promise(function (resolve) { cap.resolve = resolve; });
    this.refCapture = cap;
    this.emitReference();
    // A deadline of its own: a paused or hidden pipeline delivers no frames,
    // and a capture must not hang the button.
    cap.timer = setTimeout(function () {
      if (self.refCapture === cap) self.finishCapture({ ok: false, reason: 'timeout' });
    }, REF_CAPTURE_MS);
    return cap.promise;
  };

  // One frame of the capture, from onFrame().
  Processor.prototype.captureStep = function () {
    var cap = this.refCapture;
    if (cap.frames < REF_CAPTURE_FRAMES) {
      var px;
      try {
        cap.ctx.drawImage(this.video, 0, 0, this.refW, this.refH);
        px = cap.ctx.getImageData(0, 0, this.refW, this.refH).data;
      } catch (e) {
        this.finishCapture({ ok: false, reason: 'unavailable' });
        return;
      }
      var acc = cap.acc;
      for (var i = 0, j = 0; j < acc.length; i += 4, j += 3) {
        acc[j] += px[i]; acc[j + 1] += px[i + 1]; acc[j + 2] += px[i + 2];
      }
      cap.frames++;
    }
    // Two inferences at least, so the "is anybody there" check has actually
    // looked at the room the frames were taken of.
    if (cap.frames >= REF_CAPTURE_FRAMES && cap.inferences >= 2) this.completeCapture();
  };

  // Called from the segmentation callback while a capture runs: the share of
  // the frame the model calls a person, worst case over the capture.
  Processor.prototype.captureSawMask = function (data) {
    var cap = this.refCapture;
    var n = 0;
    for (var i = 0; i < data.length; i++) if (data[i] >= 128) n++;
    cap.present = Math.max(cap.present, data.length ? n / data.length : 0);
    cap.inferences++;
  };

  Processor.prototype.completeCapture = function () {
    var cap = this.refCapture;
    if (cap.present > REF_PRESENT_MAX) {
      this.finishCapture({ ok: false, reason: 'present' });
      return;
    }
    var W = this.refW, H = this.refH, k = 1 / cap.frames;
    var rgba = new Uint8Array(W * H * 4);
    for (var i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      rgba[i]     = Math.round(cap.acc[j] * k);
      rgba[i + 1] = Math.round(cap.acc[j + 1] * k);
      rgba[i + 2] = Math.round(cap.acc[j + 2] * k);
      rgba[i + 3] = 255;
    }
    // The probe's copy, box-averaged down from the same average, so the CPU
    // check compares like with like.
    var SW = this.refSW, SH = this.refSH;
    var small = new Float32Array(SW * SH * 3);
    for (var sy = 0; sy < SH; sy++) {
      var y0 = Math.floor(sy * H / SH), y1 = Math.max(y0 + 1, Math.floor((sy + 1) * H / SH));
      for (var sx = 0; sx < SW; sx++) {
        var x0 = Math.floor(sx * W / SW), x1 = Math.max(x0 + 1, Math.floor((sx + 1) * W / SW));
        var r = 0, g = 0, b = 0, n = 0;
        for (var y = y0; y < y1; y++) {
          for (var x = x0; x < x1; x++) {
            var o = (y * W + x) * 4;
            r += rgba[o]; g += rgba[o + 1]; b += rgba[o + 2]; n++;
          }
        }
        var so = (sy * SW + sx) * 3;
        small[so] = r / n / 255; small[so + 1] = g / n / 255; small[so + 2] = b / n / 255;
      }
    }
    _plate = { w: W, h: H, rgba: rgba, sw: SW, sh: SH, small: small,
               aspect: W / H, deviceId: this.deviceId() };
    this.refLoaded = false;   // force the upload
    this.finishCapture({ ok: true });
  };

  Processor.prototype.finishCapture = function (result) {
    var cap = this.refCapture;
    if (!cap) return;
    clearTimeout(cap.timer);
    this.refCapture = null;
    cap.acc = null;
    if (result.ok) this.syncReference();
    else this.emitReference();
    cap.resolve(result);
  };

  // Every REF_STATS_MS, from the segmentation callback, which is the one place
  // a fresh model mask is in hand: compare a 64-wide copy of the camera to the
  // reference over the part of the frame the model calls room.
  //
  // Two answers come out. The per-channel gain is how far exposure and white
  // balance have drifted since the capture — webcams re-meter the moment you
  // walk back into the picture, and without this the whole room would read as
  // "different". And the share of that room that still matches says whether
  // the camera has moved or the lighting has changed: below REF_STALE_BELOW
  // the reference is set aside (eased out, not snapped), and it comes back
  // only above REF_FRESH_ABOVE, so a borderline room does not flicker between
  // the two.
  Processor.prototype.referenceStats = function (mask, mw, mh, now) {
    if (now - this.lastRefStats < REF_STATS_MS) return;
    this.lastRefStats = now;
    var p = _plate;
    if (!p || p.sw !== this.refSW || p.sh !== this.refSH) return;
    var SW = this.refSW, SH = this.refSH, px;
    try {
      this.refStatsCtx.drawImage(this.video, 0, 0, SW, SH);
      px = this.refStatsCtx.getImageData(0, 0, SW, SH).data;
    } catch (e) { return; }

    var room = [], cr = 0, cg = 0, cb = 0, pr = 0, pg = 0, pb = 0;
    for (var y = 0; y < SH; y++) {
      var my = Math.min(mh - 1, Math.floor((y + 0.5) * mh / SH));
      for (var x = 0; x < SW; x++) {
        var mx = Math.min(mw - 1, Math.floor((x + 0.5) * mw / SW));
        if (mask[my * mw + mx] >= 64) continue;   // the model sees you here
        var i = y * SW + x;
        room.push(i);
        cr += px[i * 4]; cg += px[i * 4 + 1]; cb += px[i * 4 + 2];
        pr += p.small[i * 3]; pg += p.small[i * 3 + 1]; pb += p.small[i * 3 + 2];
      }
    }
    // Too little of the room in view to judge — somebody leaning into the
    // camera. Keep the last verdict rather than guessing.
    if (room.length < REF_MIN_ROOM * SW * SH) return;

    var clampGain = function (c, q) {
      if (q < 1e-3) return 1;
      return Math.min(REF_GAIN_MAX, Math.max(REF_GAIN_MIN, (c / 255) / q));
    };
    var want = [clampGain(cr, pr), clampGain(cg, pg), clampGain(cb, pb)];
    for (var c = 0; c < 3; c++) this.refGain[c] += (want[c] - this.refGain[c]) * REF_GAIN_SMOOTH;

    var same = 0, g = this.refGain;
    for (var k = 0; k < room.length; k++) {
      var j = room[k];
      var score = refScore(px[j * 4] / 255, px[j * 4 + 1] / 255, px[j * 4 + 2] / 255,
                           Math.min(1, p.small[j * 3] * g[0]),
                           Math.min(1, p.small[j * 3 + 1] * g[1]),
                           Math.min(1, p.small[j * 3 + 2] * g[2]));
      if (score < REF_MATCH_MAX) same++;
    }
    this.refMatch = same / room.length;
    if (!this.refStale && this.refMatch < REF_STALE_BELOW) this.refStale = true;
    else if (this.refStale && this.refMatch > REF_FRESH_ABOVE) this.refStale = false;
    this.emitReference();
  };

  // --- background source ----------------------------------------------------

  Processor.prototype.applyBackground = function (mode) {
    var self = this;
    this.mode = normalizeMode(mode);
    if (this.mode.indexOf('preset:') === 0) {
      // A scene is a shader, not a download: switching to one is a compile
      // (once per scene per camera) and nothing else. The compile runs off the
      // page's thread where the driver allows it, and whatever was showing
      // keeps showing until it lands — a pick never freezes the call's video.
      // A scene that will not compile falls back to blur, as a missing image
      // does.
      var id = this.mode.slice(7);
      var want = this.mode;
      var gl = this.gl;
      this.bgReady = false;
      if (!gl) return Promise.resolve();
      // Read by keyedReason(): with nothing drawn yet, the keyed stream says
      // "compiling" rather than "not a scene".
      this.sceneCompiling = true;
      var ready = this.sceneProgs[id] ? Promise.resolve(this.sceneProgs[id])
                                      : VideoScenes.compileProgramAsync(gl, id);
      return ready.then(function (prog) {
        if (self.stopped || self.gl !== gl) return;
        self.sceneProgs[id] = prog;
        if (self.mode !== want) return;          // a later pick won
        self.ensureScene(id);
      }).catch(function (e) {
        if (self.mode === want) { self.sceneId = null; self.scene = null; }
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[VideoEffects] scene unavailable: ' + (e && e.message ? e.message : e));
        }
      }).then(function () {
        if (self.mode === want) self.sceneCompiling = false;
      });
    }
    this.sceneCompiling = false;
    this.sceneId = null;
    this.scene = null;
    if (this.mode === 'blur' || this.mode === 'off') {
      this.bgReady = false;
      return Promise.resolve();
    }
    var load = getCustomImage().then(function (blob) {
      if (!blob) throw new Error('no custom background stored');
      return loadBitmap(blob);
    });
    return load.then(function (bmp) {
      if (self.stopped || !self.gl) return;
      var gl = self.gl;
      gl.bindTexture(gl.TEXTURE_2D, self.texImg);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
      self.bgAspect = bmp.width / bmp.height;
      self.bgReady = true;
      if (bmp.close) try { bmp.close(); } catch (e) { /* ignore */ }
    }).catch(function () {
      // A missing or corrupt image falls back to blur rather than to a black
      // rectangle, which would look like the camera had failed.
      self.bgReady = false;
    });
  };

  // --- scenes ---------------------------------------------------------------
  //
  // Allocate the scene's buffers (once), compile its program (once per scene),
  // and draw its first frame now, so the composite never samples an empty or
  // mip-incomplete texture. Throws if the program does not compile.
  Processor.prototype.ensureScene = function (id) {
    var gl = this.gl;
    if (!gl) return;
    id = VideoScenes.resolveId(id);
    if (!id) throw new Error('unknown scene');
    var want = VideoScenes.byId(id);
    var cw = this.canvas.width, ch = this.canvas.height;
    var k = Math.min(1, SCENE_LONG * (want.res || 1) / Math.max(cw, ch));
    var nw = Math.max(2, Math.round(cw * k)), nh = Math.max(2, Math.round(ch * k));
    if (this.texScene && (nw !== this.sceneW || nh !== this.sceneH)) {
      // Another scene, another size: the buffers follow it.
      try { gl.deleteTexture(this.texScene); } catch (e) { /* ignore */ }
      try { gl.deleteFramebuffer(this.fbScene); } catch (e) { /* ignore */ }
      this.texScene = null;
      this.fbScene = null;
    }
    if (!this.texScene) {
      this.sceneW = nw;
      this.sceneH = nh;
      this.texScene = texture(gl, this.sceneW, this.sceneH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
      // Mipmapped: the light wrap reads a coarse level as "the light around
      // here", for the cost of one generateMipmap per scene frame. Generated
      // once now as well, so nothing ever samples it mip-incomplete (which
      // reads as black).
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
      this.fbScene = framebuffer(gl, this.texScene);
      if (!this.texSoftA) this.allocSoft(this.segW, this.segH);
      if (!this.sceneStart) this.sceneStart = performance.now();
    }
    // The resolve is one small program for every scene. Without it the scene
    // is still a scene, only softer (its small buffer, stretched), so a failure
    // here is not a reason to fall back to the blur.
    if (this.pResolve === undefined) {
      try { this.pResolve = program(gl, VideoScenes.RESOLVE_FRAG); } catch (e) {
        console.warn('[VideoEffects] scene resolve unavailable: ' + (e && e.message ? e.message : e));
        this.pResolve = null;
      }
    }
    // The picture the redraws add up to, at the camera's own size, which does
    // not change while this context lives (a new capture size rebuilds it).
    // Not mipmapped: it is read one texel to one pixel.
    if (this.pResolve && !this.texSceneOut) {
      this.texSceneOut = [0, 1].map(function () {
        return texture(gl, cw, ch, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
      });
      this.fbSceneOut = this.texSceneOut.map(function (t) { return framebuffer(gl, t); });
    }
    // Another scene (or the same one, picked again) starts its picture over.
    this.sceneAge = 0;
    if (!this.sceneProgs[id]) this.sceneProgs[id] = VideoScenes.compileProgram(gl, id);
    this.sceneId = id;
    this.scene = want;
    // Each scene brings its own redraw rate; a new one starts at the top of
    // its ladder, and the governor walks it down again if it has to.
    this.sceneHzSteps = (want.hz || SCENE_HZ).slice();
    this.sceneStep = 0;
    this.lastScene = 0;
    this.drawScene(performance.now());
    this.buildSoft();
  };

  // The soft mask: the finished mask, shrunk to SOFT_LONG and blurred wide.
  // What the shadow and the light wrap read — a person's shadow on a wall a
  // metre behind them is that soft, and a wrap must fade in from the edge.
  Processor.prototype.allocSoft = function (segW, segH) {
    var gl = this.gl;
    var k = SOFT_LONG / Math.max(segW, segH);
    this.softW = Math.max(2, Math.round(segW * k));
    this.softH = Math.max(2, Math.round(segH * k));
    if (!this.texSoftA) {
      this.texSoftA = texture(gl, this.softW, this.softH, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
      this.texSoftB = texture(gl, this.softW, this.softH, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
      this.fbSoftA = framebuffer(gl, this.texSoftA);
      this.fbSoftB = framebuffer(gl, this.texSoftB);
    } else {
      [this.texSoftA, this.texSoftB].forEach(function (t) {
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, this.softW, this.softH, 0, gl.RED, gl.UNSIGNED_BYTE, null);
      }, this);
    }
    // Nobody, until the first mask says otherwise.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbSoftA);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };

  // Rebuilt from the finished mask once per inference, by the feather program
  // (coverage, not light — no gamma). Four draws on a buffer of ~2,000 pixels.
  Processor.prototype.buildSoft = function () {
    var gl = this.gl;
    if (!gl || !this.texSoftA || !this.maskPrimed) return;
    gl.useProgram(this.pFeather);
    this.bindTex(this.pFeather, 'uTex', 0, this.texMaskA);
    gl.uniform2f(uloc(gl, this.pFeather, 'uDir'), 1.5 / this.segW, 0);
    this.drawQuad(this.fbSoftB, this.softW, this.softH);
    this.bindTex(this.pFeather, 'uTex', 0, this.texSoftB);
    gl.uniform2f(uloc(gl, this.pFeather, 'uDir'), 0, 1.5 / this.segH);
    this.drawQuad(this.fbSoftA, this.softW, this.softH);
    this.bindTex(this.pFeather, 'uTex', 0, this.texSoftA);
    gl.uniform2f(uloc(gl, this.pFeather, 'uDir'), 1.6 / this.softW, 0);
    this.drawQuad(this.fbSoftB, this.softW, this.softH);
    this.bindTex(this.pFeather, 'uTex', 0, this.texSoftB);
    gl.uniform2f(uloc(gl, this.pFeather, 'uDir'), 0, 1.6 / this.softH);
    this.drawQuad(this.fbSoftA, this.softW, this.softH);
  };

  // The turn of the scene's camera: the phone's own, for a pipeline that is
  // drawing the scene for this device's camera.
  Processor.prototype.sceneView = function () { return _tilt; };

  // Whether drawScene() will redraw on this frame (its own rate gate).
  Processor.prototype.sceneDue = function (now) {
    var hz = this.sceneHzSteps[this.sceneStep];
    return !this.lastScene || (now - this.lastScene) >= 1000 / hz;
  };

  // Ease the look every frame; redraw the scene at its own, lower rate.
  Processor.prototype.drawScene = function (now) {
    var gl = this.gl;
    var dt = this.lastDraw ? (now - this.lastDraw) / 1000 : 0;
    this.lastDraw = now;
    VideoScenes.easeLook(this.look, this.lookTarget, Math.min(dt, 0.5));
    var hz = this.sceneHzSteps[this.sceneStep];
    if (this.lastScene && (now - this.lastScene) < 1000 / hz) return;
    this.lastScene = now;
    var prog = this.sceneProgs[this.sceneId];
    if (!prog) return;
    // The clock starts where the chip's thumbnail was taken, so the first
    // frame is the picture that was picked.
    var t = VideoScenes.THUMB_TIME + (now - this.sceneStart) / 1000;
    var at = this.texSceneOut ? VideoScenes.JITTER[this.sceneLook++ % VideoScenes.JITTER.length] : null;
    VideoScenes.setUniforms(gl, prog, this.sceneW, this.sceneH, t, this.look,
                            at ? { jitter: at, detail: this.canvas.height } : null, this.sceneView());
    this.drawQuad(this.fbScene, this.sceneW, this.sceneH);
    gl.bindTexture(gl.TEXTURE_2D, this.texScene);
    gl.generateMipmap(gl.TEXTURE_2D);
    if (at) this.resolveScene(at);
  };

  // Add the redraw just made to the scene's picture at the camera's size: one
  // pass, from the picture so far into the other buffer, once per scene frame
  // — never per camera frame. See RESOLVE_FRAG in video-scenes.js.
  Processor.prototype.resolveScene = function (at) {
    var gl = this.gl, p = this.pResolve, from = this.sceneOut, to = 1 - from;
    gl.useProgram(p);
    this.bindTex(p, 'uCur', 0, this.texScene);
    this.bindTex(p, 'uHist', 1, this.texSceneOut[from]);
    gl.uniform2f(uloc(gl, p, 'uCurRes'), this.sceneW, this.sceneH);
    gl.uniform2f(uloc(gl, p, 'uOutRes'), this.canvas.width, this.canvas.height);
    gl.uniform2f(uloc(gl, p, 'uJitter'), at[0], at[1]);
    gl.uniform1f(uloc(gl, p, 'uAge'), Math.min(this.sceneAge, 255));
    this.drawQuad(this.fbSceneOut[to], this.canvas.width, this.canvas.height);
    this.sceneOut = to;
    this.sceneAge++;
  };

  // Measure how the subject is lit, from a 32-wide copy of the frame and the
  // mask that has just come back. A few times a second is plenty: light
  // changes when somebody turns a lamp on, not frame to frame. See
  // VideoScenes.measureSubject() for what is read and why.
  Processor.prototype.sampleLook = function (mask, mw, mh, now) {
    if (now - this.lastLook < LOOK_SAMPLE_MS) return;
    this.lastLook = now;
    var pw = LOOK_PROBE_W, ph = Math.max(2, Math.round(pw * mh / mw));
    if (!this.lookCtx || this.lookCanvas.height !== ph) {
      this.lookCanvas = document.createElement('canvas');
      this.lookCanvas.width = pw; this.lookCanvas.height = ph;
      this.lookCtx = this.lookCanvas.getContext('2d', { willReadFrequently: true });
      this.lookPrev = null;
    }
    try {
      this.lookCtx.drawImage(this.video, 0, 0, pw, ph);
      var rgba = this.lookCtx.getImageData(0, 0, pw, ph).data;
      var grid = new Uint8Array(pw * ph);
      for (var y = 0; y < ph; y++) {
        var my = Math.min(mh - 1, Math.floor((y + 0.5) * mh / ph));
        for (var x = 0; x < pw; x++) {
          grid[y * pw + x] = mask[my * mw + Math.min(mw - 1, Math.floor((x + 0.5) * mw / pw))];
        }
      }
      var stats = VideoScenes.measureSubject(rgba, pw, ph, grid, this.lookPrev);
      this.lookPrev = grid;
      this.lookTarget = VideoScenes.lookFromStats(stats, this.lookTarget);
      if (this.keyed) this.keyedLook(rgba, grid, pw * ph, now);
    } catch (e) { /* a frame that cannot be read leaves the last look standing */ }
  };

  // Two things only a keyed stream needs, from the same probe and mask grid.
  //
  // GREEN: a subject that is itself green cannot be keyed against green. A
  // green shirt never reaches full alpha at the receiver, so the receiver's
  // scene would show through it — while the sender's own self-view looks
  // perfect. So the share of the confident core that is clearly greener than
  // red and blue withholds keying, and a hysteresis (under half that share,
  // for five seconds) keeps a shirt at the threshold from flapping.
  //
  // edgeE: how green the subject's edge is, as the median e(camera) over the
  // pixels the model is unsure about (<= 0, since only a greener-than-grey
  // edge is ever a problem the other way). The receiver divides its raw alpha
  // by (1 - edgeE) in the band, which is what keeps a face's outline from
  // coming out lime. A slow number, eased like the look.
  Processor.prototype.keyedLook = function (rgba, grid, n, now) {
    var core = 0, green = 0, band = [];
    for (var i = 0; i < n; i++) {
      var r = rgba[i * 4] / 255, g = rgba[i * 4 + 1] / 255, b = rgba[i * 4 + 2] / 255;
      var e = g - Math.max(r, b), m = grid[i] / 255;
      if (m > 0.9) { core++; if (e > KEY_GREEN_E) green++; }
      if (m >= 0.3 && m <= 0.98) band.push(e);
    }
    var share = core ? green / core : 0;
    if (!this.keyGreen) {
      if (share > KEY_GREEN_ON) { this.keyGreen = true; this.keyGreenClear = 0; }
    } else if (share < KEY_GREEN_OFF) {
      if (!this.keyGreenClear) this.keyGreenClear = now;
      else if (now - this.keyGreenClear >= KEY_GREEN_HOLD_MS) { this.keyGreen = false; this.keyGreenClear = 0; }
    } else {
      this.keyGreenClear = 0;
    }
    if (band.length >= 3) {
      band.sort(function (x, y) { return x - y; });
      var target = Math.min(0, band[band.length >> 1]);
      if (!this.edgeEMeasured) {
        this.edgeE = target;
        this.edgeEMeasured = true;
      } else {
        var dt = Math.min(2, Math.max(0, (now - this.lastEdgeE) / 1000));
        this.edgeE += (target - this.edgeE) * (1 - Math.exp(-dt / KEY_EDGE_SMOOTH_S));
      }
      this.lastEdgeE = now;
    }
  };

  // CORNER: a subject reaching into a marker zone is cut there — the zones
  // are key whatever is in front of them — and the receiver would show a
  // square notch of scene where a head or a hand was. So keying is withheld
  // while the mask covers either zone, until it has stayed clear for a while.
  // From the segmentation callback, on the mask itself.
  Processor.prototype.keyedCorner = function (mask, mw, mh, now) {
    var W = this.canvas.width || mw, H = this.canvas.height || mh;
    var Z = KEY_MARKER.zone * Math.min(W, H);
    var zw = Math.max(1, Math.min(mw, Math.round(Z / W * mw)));
    var zh = Math.max(1, Math.min(mh, Math.round(Z / H * mh)));
    var tl = 0, tr = 0;
    for (var y = 0; y < zh; y++) {
      var row = y * mw;
      for (var x = 0; x < zw; x++) { tl += mask[row + x]; tr += mask[row + mw - 1 - x]; }
    }
    var cover = Math.max(tl, tr) / (255 * zw * zh);
    if (!this.keyCorner) {
      if (cover > KEY_CORNER_ON) { this.keyCorner = true; this.keyCornerClear = 0; }
    } else if (cover < KEY_CORNER_OFF) {
      if (!this.keyCornerClear) this.keyCornerClear = now;
      else if (now - this.keyCornerClear >= KEY_CORNER_HOLD_MS) { this.keyCorner = false; this.keyCornerClear = 0; }
    } else {
      this.keyCornerClear = 0;
    }
  };

  // Cover-fit: fill the frame, crop the overflow, never stretch.
  Processor.prototype.bgXform = function () {
    var frameAspect = this.canvas.width / this.canvas.height;
    var a = this.bgAspect || 1;
    if (a > frameAspect) {
      var sx = frameAspect / a;
      return [sx, 1, (1 - sx) / 2, 0];
    }
    var sy = a / frameAspect;
    return [1, sy, 0, (1 - sy) / 2];
  };

  // --- per-frame work -------------------------------------------------------

  // One frame callback in flight at a time: onFrame() asks for the next one
  // before anything else, and a re-arm after a new source (repoint()) must
  // never start a second loop beside it. None at all while `_held`: a new
  // source has no frame yet (see repointVideo()).
  Processor.prototype.pump = function () {
    if (this.stopped || this._held || this._rvfc || this._raf) return;
    var self = this;
    if (this.video.requestVideoFrameCallback) {
      this._rvfc = this.video.requestVideoFrameCallback(function () { self._rvfc = 0; self.onFrame(); });
    } else {
      this._raf = requestAnimationFrame(function () { self._raf = 0; self.onFrame(); });
    }
  };

  Processor.prototype.unpump = function () {
    if (this._rvfc && this.video.cancelVideoFrameCallback) {
      try { this.video.cancelVideoFrameCallback(this._rvfc); } catch (e) { /* ignore */ }
    }
    if (this._raf) cancelAnimationFrame(this._raf);
    this._rvfc = 0;
    this._raf = 0;
  };

  // A new stream behind the hidden <video>, with the frame loop held off
  // until it has a picture — see repointVideo() for the crash this avoids.
  Processor.prototype.repoint = function (stream) {
    var self = this, gen = this._srcGen = (this._srcGen || 0) + 1;
    return repointVideo(this.video, stream,
      function () { self._held = true; self.unpump(); },
      function () { self._held = false; self.pump(); },
      function () { return !self.stopped && self._srcGen === gen; });
  };

  Processor.prototype.onFrame = function () {
    if (this.stopped) return;
    this.pump();                                  // schedule the next one first
    if (this.keyed) this.checkKeyedState(performance.now());
    if (this.paused || document.hidden ||
        !this.gl || this.video.readyState < 2 || !this.video.videoWidth) {
      // Restart the measurement window. Carrying it across a pause would
      // measure a handful of frames over minutes of wall clock and step the
      // effect down — or off — for no reason at all.
      this.frames = 0;
      this.windowStart = 0;
      return;
    }

    // A phone turned: the camera now delivers the other way up, but the canvas
    // (and every buffer sized from it) still has the old shape, so the picture
    // is stretched into it. Rebuild for the new shape, as setSource() does.
    if (this.followCameraShape()) return;

    var now = performance.now();
    if (this.refCapture) this.captureStep();
    if (this.segmenter && (now - this.lastSeg) >= this.segInterval) {
      this.lastSeg = now;
      this.runSegment(now);
    }
    this.draw(now);
    if (this.manualFrames && this.track && this.track.requestFrame) {
      try { this.track.requestFrame(); } catch (e) { /* track ended */ }
    }
    this.requestKeyedFrame();
    this.measure(now);
  };

  Processor.prototype.followCameraShape = function () {
    if (this.rebuilding) return true;
    var vw = this.video.videoWidth, vh = this.video.videoHeight;
    var cw = this.canvas.width, ch = this.canvas.height;
    if (!vw || !vh || !cw || !ch) return false;
    // Orientation, not size: a few pixels either way is not a turned phone.
    if ((vw >= vh) === (cw >= ch)) return false;
    var self = this;
    this.rebuilding = true;
    this.refLoaded = false;
    this.releaseGL();
    this.initGL();
    this.applyBackground(this.mode).then(function () {
      self.rebuilding = false;
    }, function () {
      self.rebuilding = false;
    });
    return true;
  };

  Processor.prototype.runSegment = function (now) {
    var self = this;
    // segmentForVideo rejects a non-increasing timestamp outright.
    var ts = Math.max(Math.round(now), this.lastTs + 1);
    this.lastTs = ts;
    try {
      // Segment a downscaled copy, not the camera frame. ImageSegmenter returns
      // its mask at the size of whatever you hand it, so passing the raw video
      // means reading back a full-resolution mask every inference and then
      // resampling it — expensive, and lossy in the one direction that clips
      // the subject. The model resizes its input internally anyway, so nothing
      // is lost by doing the downscale ourselves.
      this.sampleLight(now);
      if (this.lightFilterOk) {
        this.segCtx.filter = this.lightGain > 1.01
          ? 'brightness(' + this.lightGain.toFixed(3) + ') contrast(' +
            this.lightContrast.toFixed(3) + ')'
          : 'none';
      }
      this.segCtx.drawImage(this.video, 0, 0, this.segW, this.segH);
      this.segmenter.segmentForVideo(this.segCanvas, ts, function (result) {
        var masks = result && result.confidenceMasks;
        // The selfie model publishes a single confidence mask ("selfie"); other
        // segmenters put the person at index 1 behind the background.
        var mask = masks && (masks.length > 1 ? masks[1] : masks[0]);
        if (!mask) return;
        try {
          var data = mask.getAsUint8Array();
          if (self.refCapture) self.captureSawMask(data);
          self.uploadMask(data, mask.width, mask.height);
          if (self.keyed) self.keyedCorner(data, mask.width, mask.height, now);
          // Read here and nowhere else: the mask's lifetime ends with this
          // callback.
          if (self.refLoaded) self.referenceStats(data, mask.width, mask.height, now);
          if (self.sceneId) {
            self.buildSoft();
            self.sampleLook(data, mask.width, mask.height, now);
          }
        } catch (e) { /* the mask's lifetime ends with this callback */ }
      });
    } catch (e) {
      // A single failed inference must not take the call's video with it.
      this.segFailures = (this.segFailures || 0) + 1;
      if (this.segFailures > 30) this.giveUp('segmentation kept failing');
    }
  };

  // Measure the scene and ease the gain toward what it asks for.
  //
  // On its own clock, not the segmenter's: the room's lighting changes on the
  // scale of somebody turning a lamp on, and re-measuring every inference
  // would be work spent to track nothing. Eased rather than applied outright,
  // because a gain that jumps when you lean forward makes the mask breathe —
  // and the mask is the only thing this gain is for.
  Processor.prototype.sampleLight = function (now) {
    if (!this.lightAdapt || !this.lightFilterOk || !this.lumaCtx) {
      this.lightGain = 1; this.lightContrast = 1;
      return;
    }
    if (now - this.lastLight < LIGHT_SAMPLE_MS) return;
    this.lastLight = now;

    var mean;
    try {
      this.lumaCtx.drawImage(this.video, 0, 0, LIGHT_GRID_W, LIGHT_GRID_H);
      var px = this.lumaCtx.getImageData(0, 0, LIGHT_GRID_W, LIGHT_GRID_H).data;
      // The centre half, in both axes — see lightPlan() for why not the whole
      // frame.
      var x0 = Math.floor(LIGHT_GRID_W * 0.25), x1 = Math.ceil(LIGHT_GRID_W * 0.75);
      var y0 = Math.floor(LIGHT_GRID_H * 0.25), y1 = Math.ceil(LIGHT_GRID_H * 0.75);
      var sum = 0, n = 0;
      for (var y = y0; y < y1; y++) {
        for (var x = x0; x < x1; x++) {
          var i = (y * LIGHT_GRID_W + x) * 4;
          // Rec. 709 luma on the encoded values, which is the space the gain
          // is applied in too.
          sum += (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
          n++;
        }
      }
      mean = n ? sum / n : 1;
    } catch (e) {
      // A tainted or not-yet-decodable frame is not a reason to leave a stale
      // gain applied.
      this.lightGain = 1; this.lightContrast = 1;
      return;
    }

    var want = lightPlan(mean);
    this.lightGain += (want.gain - this.lightGain) * LIGHT_SMOOTH;
    this.lightContrast += (want.contrast - this.lightContrast) * LIGHT_SMOOTH;
    this.lightMean = mean;
  };

  Processor.prototype.uploadMask = function (data, w, h) {
    var gl = this.gl;
    if (!gl) return;
    var W = this.segW, H = this.segH;

    gl.bindTexture(gl.TEXTURE_2D, this.texMaskRaw);
    if (w !== W || h !== H) {
      // Should not happen now that we control the input size, but a mask of an
      // unexpected shape is better re-allocated than silently misread.
      this.segW = W = w; this.segH = H = h;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data);
      this.resizeMaskBuffers(w, h);
      gl.bindTexture(gl.TEXTURE_2D, this.texMaskRaw);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RED, gl.UNSIGNED_BYTE, data);
    }

    // Temporal blend, into a state buffer of its OWN.
    //
    // This separation is the whole point, and collapsing it is a genuinely
    // nasty bug: feed the *finished* mask back in as `uPrev` and the dilate and
    // the feather are re-applied to their own output on every single inference.
    // They compound. Measured, at 15 Hz: the silhouette's 50% point crept 10.7
    // texels OUTSIDE the subject and the feather ramp reached ~4x its
    // configured width, so a wide halo around the person stayed sharp
    // permanently — which reads, from the outside, as "the blur isn't strong
    // enough", and no amount of blur radius can fix it because the blur is not
    // what is wrong.
    //
    // So `uPrev` must be the previous *blended* mask, never a processed one.
    // The very first mask is taken whole, otherwise the first second of video
    // fades in from an empty matte.
    gl.useProgram(this.pMix);
    this.bindTex(this.pMix, 'uPrev', 0, this.texMaskS);
    this.bindTex(this.pMix, 'uNext', 1, this.texMaskRaw);
    gl.uniform1f(uloc(gl, this.pMix, 'uAlphaUp'), this.maskPrimed ? MASK_ALPHA_UP : 1.0);
    gl.uniform1f(uloc(gl, this.pMix, 'uAlphaDown'), this.maskPrimed ? MASK_ALPHA_DOWN : 1.0);
    this.drawQuad(this.fbMaskSB, W, H);

    // Swap the state pair: texMaskS is the blend's memory, and nothing
    // downstream ever writes to it.
    var ts = this.texMaskS, fs = this.fbMaskS;
    this.texMaskS = this.texMaskSB; this.fbMaskS = this.fbMaskSB;
    this.texMaskSB = ts; this.fbMaskSB = fs;

    // Everything from here is a fresh derivation of that state into the work
    // pair, discarded and rebuilt next inference.
    //
    // Dilate before feathering. Everything downstream shrinks the subject a
    // little — the feather blur, the smoothstep, and the mask's own lag behind
    // a moving frame — so expand it first and let those take the slack back.
    // Separable, like the blur: two passes of a 3-tap max.
    //
    // First, while a reference is loaded, the core it is never asked about:
    // the blended mask eroded by REF_CORE_ERODE, as two 3-tap min passes per
    // axis at half that stride (taps at 0, ±s, ±2s — no gaps for a sliver to
    // slip through). The work pair is scratch, exactly as for the dilate.
    if (this.refLoaded) {
      var es = REF_CORE_ERODE / 2;
      gl.useProgram(this.pErode);
      this.bindTex(this.pErode, 'uTex', 0, this.texMaskS);
      gl.uniform2f(uloc(gl, this.pErode, 'uDir'), es / W, 0);
      this.drawQuad(this.fbMaskB, W, H);
      this.bindTex(this.pErode, 'uTex', 0, this.texMaskB);
      this.drawQuad(this.fbMaskA, W, H);
      this.bindTex(this.pErode, 'uTex', 0, this.texMaskA);
      gl.uniform2f(uloc(gl, this.pErode, 'uDir'), 0, es / H);
      this.drawQuad(this.fbMaskB, W, H);
      this.bindTex(this.pErode, 'uTex', 0, this.texMaskB);
      this.drawQuad(this.fbCore, W, H);
    }

    // With the empty-room reference in use the band reaches a little further:
    // the reference can only give back what is inside it.
    var dilate = this.edge.dilate + (this.refWeight > 0.5 ? REF_DILATE_EXTRA : 0);
    gl.useProgram(this.pDilate);
    this.bindTex(this.pDilate, 'uTex', 0, this.texMaskS);
    gl.uniform2f(uloc(gl, this.pDilate, 'uDir'), dilate / W, 0);
    this.drawQuad(this.fbMaskB, W, H);

    this.bindTex(this.pDilate, 'uTex', 0, this.texMaskB);
    gl.uniform2f(uloc(gl, this.pDilate, 'uDir'), 0, dilate / H);
    this.drawQuad(this.fbMaskA, W, H);

    // Feather: blur the dilated mask so the composite's smoothstep has a real
    // gradient to work with instead of the model's staircase. Its own program
    // rather than the background's — coverage is not light, so this one must
    // NOT be gamma-corrected, or the ramp would be bent and the edge would land
    // somewhere other than where MASK_DILATE put it.
    gl.useProgram(this.pFeather);
    this.bindTex(this.pFeather, 'uTex', 0, this.texMaskA);
    gl.uniform2f(uloc(gl, this.pFeather, 'uDir'), this.edge.feather / W, 0);
    this.drawQuad(this.fbMaskB, W, H);

    this.bindTex(this.pFeather, 'uTex', 0, this.texMaskB);
    gl.uniform2f(uloc(gl, this.pFeather, 'uDir'), 0, this.edge.feather / H);
    this.drawQuad(this.fbMaskA, W, H);

    // texMaskA is the finished mask, by construction rather than by a swap —
    // the work pair has a fixed direction now, so there is no way for the
    // feedback above to come back.
    this.maskPrimed = true;
  };

  // Re-allocate just the mask ping-pong for a new mask shape, leaving the
  // camera and blur buffers alone.
  Processor.prototype.resizeMaskBuffers = function (w, h) {
    var gl = this.gl;
    [this.texMaskS, this.texMaskSB, this.texMaskA, this.texMaskB, this.texCore].forEach(function (t) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    });
    this.maskPrimed = false;
    if (this.segCanvas) { this.segCanvas.width = w; this.segCanvas.height = h; }
    if (this.texSoftA) this.allocSoft(w, h);
  };

  Processor.prototype.draw = function (now) {
    var gl = this.gl;
    var w = this.canvas.width, h = this.canvas.height;
    if (now === undefined) now = performance.now();

    gl.bindTexture(gl.TEXTURE_2D, this.texCam);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
    } catch (e) {
      return;   // the source can vanish mid-teardown
    }

    // The empty-room reference: ease its weight toward whether it should be
    // used, and while it carries any weight, compare this frame to it.
    var refWant = (this.refLoaded && !this.refStale && !this.refCapture) ? 1 : 0;
    this.refWeight += (refWant - this.refWeight) * REF_FADE;
    if (refWant === 0 && this.refWeight < 0.001) this.refWeight = 0;
    if (this.refWeight > 0) {
      gl.useProgram(this.pRef);
      this.bindTex(this.pRef, 'uCam', 0, this.texCam);
      this.bindTex(this.pRef, 'uPlate', 1, this.texPlate);
      this.bindTex(this.pRef, 'uPrev', 2, this.texRefA);
      gl.uniform3f(uloc(gl, this.pRef, 'uGain'), this.refGain[0], this.refGain[1], this.refGain[2]);
      gl.uniform2f(uloc(gl, this.pRef, 'uOff'), 0.25 / this.refW, 0.25 / this.refH);
      gl.uniform1f(uloc(gl, this.pRef, 'uAlpha'), REF_TEMPORAL);
      this.drawQuad(this.fbRefB, this.refW, this.refH);
      // A is always the newest answer, and the next frame's memory.
      var rt = this.texRefA, rf = this.fbRefA;
      this.texRefA = this.texRefB; this.fbRefA = this.fbRefB;
      this.texRefB = rt; this.fbRefB = rf;
    }

    var useScene = !!this.sceneId;
    var useImage = !useScene && this.bgReady && this.mode !== 'blur';
    if (useScene) this.drawScene(now);
    if (!useImage && !useScene) {
      // Box downsample into the blur buffer, then one H+V pair per stride in
      // blurSteps — widening each time, so the whole chain reaches a wide-lens
      // radius while every individual pass is still sampling detail it can see.
      gl.useProgram(this.pDown);
      this.bindTex(this.pDown, 'uTex', 0, this.texCam);
      gl.uniform2f(uloc(gl, this.pDown, 'uOff'), 0.25 / this.blurW, 0.25 / this.blurH);
      this.drawQuad(this.fbBlurA, this.blurW, this.blurH);

      gl.useProgram(this.pBlur);
      for (var pass = 0; pass < this.blurSteps.length; pass++) {
        var step = this.blurSteps[pass];
        this.bindTex(this.pBlur, 'uTex', 0, this.texBlurA);
        gl.uniform2f(uloc(gl, this.pBlur, 'uDir'), step / this.blurW, 0);
        this.drawQuad(this.fbBlurB, this.blurW, this.blurH);

        this.bindTex(this.pBlur, 'uTex', 0, this.texBlurB);
        gl.uniform2f(uloc(gl, this.pBlur, 'uDir'), 0, step / this.blurH);
        this.drawQuad(this.fbBlurA, this.blurW, this.blurH);
      }
    }

    gl.useProgram(this.pComp);
    this.bindTex(this.pComp, 'uSharp', 0, this.texCam);
    this.bindTex(this.pComp, 'uBlur', 1, this.texBlurA);
    this.bindTex(this.pComp, 'uImage', 2, this.texImg);
    this.bindTex(this.pComp, 'uMask', 3, this.texMaskA);
    this.bindTex(this.pComp, 'uRef', 4, this.texRefA);
    this.bindTex(this.pComp, 'uCore', 5, this.texCore);
    // Bound in every mode — a sampler with nothing behind it is an error on
    // some drivers even in a branch that never reads it.
    this.bindTex(this.pComp, 'uScene', 6,
                 (this.texSceneOut && this.texSceneOut[this.sceneOut]) || this.texScene || this.texImg);
    this.bindTex(this.pComp, 'uSceneEnv', 9, this.texScene || this.texImg);
    this.bindTex(this.pComp, 'uSoft', 7, this.texSoftA || this.texMaskA);
    gl.uniform1f(uloc(gl, this.pComp, 'uRefOn'), this.refWeight);
    gl.uniform1f(uloc(gl, this.pComp, 'uBgMode'), useScene ? 2 : useImage ? 1 : 0);
    var sh = this.shadowPlan();
    gl.uniform2f(uloc(gl, this.pComp, 'uShadowOff'), sh.offX, sh.offY);
    gl.uniform2f(uloc(gl, this.pComp, 'uShadow'), sh.cast, sh.contact);
    gl.uniform1f(uloc(gl, this.pComp, 'uWrap'), useScene && this.scene ? this.scene.wrap : 0);
    gl.uniform2f(uloc(gl, this.pComp, 'uEdge'), this.edge.lo, this.edge.hi);
    gl.uniform1f(uloc(gl, this.pComp, 'uDecon'), this.decon);
    var x = this.bgXform();
    gl.uniform4f(uloc(gl, this.pComp, 'uBgXform'), x[0], x[1], x[2], x[3]);
    if (this.keyed && this.keyed.demand > 0) this.drawKeyed(w, h);
    else this.drawQuad(null, w, h);
  };

  // --- the keyed output -----------------------------------------------------
  //
  // A second track from the same pipeline: the person over the key colour,
  // for the peers who draw the scene themselves. It is a plain 2D canvas,
  // filled by copying the GL canvas between two draws of the composite
  // program in one task — keyed first, copied out, then the composite drawn
  // over it, so the GL canvas (and every peer on the composite track) ends
  // the frame exactly as it always did. With preserveDrawingBuffer off the
  // back buffer only holds the keyed frame until the task ends, which is why
  // the copy must happen right there.
  //
  // It lives as long as the processor and costs nothing until main.js says
  // how many senders are on it (setKeyedDemand): no keyed draw, no copy, no
  // capture while nobody is watching.
  Processor.prototype.keyedOutput = function () {
    if (this.keyed) return this.keyed.track;
    if (this.stopped || !this.stream) return null;
    var c = document.createElement('canvas');
    c.width = this.canvas.width || 2;
    c.height = this.canvas.height || 2;
    var ctx = c.getContext('2d', { alpha: false });
    if (!ctx || typeof c.captureStream !== 'function') return null;
    var cs = c.captureStream(0);
    var track = cs.getVideoTracks()[0];
    var manual = true;
    if (!track || typeof track.requestFrame !== 'function') {
      // Safari, as in start(): no requestFrame, so the browser pulls frames.
      try { cs.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
      cs = c.captureStream(this.targetFps());
      track = cs.getVideoTracks()[0];
      manual = false;
    }
    if (!track) return null;
    // A camera suspended in the background has its tracks disabled; one made
    // in the meantime must not be the exception.
    track.enabled = !this.paused;
    if (_keyedTracks) _keyedTracks.add(track);
    track._voxalKeyed = true;
    this.keyed = {
      canvas: c, ctx: ctx, capture: cs, track: track, manual: manual,
      demand: 0, pending: false, tilt: false,
      checked: false, failed: false,
      copyTimes: [], slow: false,
      sent: null, sentAt: 0
    };
    // What main.js is about to read anyway, so the first frame does not
    // announce it back.
    this.keyed.sent = this.keyedSnapshot();
    this.keyed.sentAt = performance.now();
    return track;
  };

  // Why keying is withheld right now, or null when it is not. The keyed canvas
  // still carries a frame while withheld — the composite, unmarked — so a
  // peer on the keyed track passes it through and needs no swap.
  Processor.prototype.keyedReason = function () {
    var k = this.keyed;
    if (k && k.failed) return 'self-check';
    if (k && k.slow) return 'slow-copy';
    if (this.mode.indexOf('preset:') !== 0) return 'mode';
    if (!this.sceneId) return this.sceneCompiling ? 'compiling' : 'mode';
    if (this.keyGreen) return 'green';
    if (this.keyCorner) return 'corner';
    return null;
  };

  function round3(v) { return Math.round(v * 1000) / 1000; }

  Processor.prototype.keyedSnapshot = function () {
    if (!this.keyed) return null;
    var reason = this.keyedReason();
    // The look as measured, not as eased: the receiver eases toward it on its
    // own clock, as this end does.
    var L = this.lookTarget;
    return {
      scene: reason ? null : this.sceneId,
      reason: reason,
      size: [this.canvas.width, this.canvas.height],
      look: {
        tint: L.tint.map(round3),
        exposure: round3(L.exposure),
        dirX: round3(L.dirX),
        dirY: round3(L.dirY),
        hard: round3(L.hard),
        side: L.side < 0 ? -1 : 1
      },
      edgeE: round3(this.edgeE),
      tilt: !!this.keyed.tilt
    };
  };

  // Tell main.js when what it would put in an offer has changed. A new scene,
  // a new reason, a new size or the light moving to the other side is news
  // at once; the look drifting a little is news at most every KEY_STATE_MS,
  // because every announcement is a message to every peer. Held back while
  // setSource() rebuilds the context: the scene goes away for the length of a
  // compile and comes back, and the peers need to hear about neither.
  Processor.prototype.checkKeyedState = function (now) {
    var k = this.keyed;
    if (!k || this.rebuilding || this.stopped) return;
    var s = this.keyedSnapshot(), last = k.sent;
    var urgent = !last || last.scene !== s.scene || last.reason !== s.reason ||
                 last.look.side !== s.look.side || last.tilt !== s.tilt ||
                 last.size[0] !== s.size[0] || last.size[1] !== s.size[1];
    if (!urgent) {
      if (now - k.sentAt < KEY_STATE_MS) return;
      var a = last.look, b = s.look;
      var moved = Math.abs(a.exposure - b.exposure) > 0.03 ||
                  Math.abs(a.dirX - b.dirX) > 0.08 || Math.abs(a.dirY - b.dirY) > 0.08 ||
                  Math.abs(a.hard - b.hard) > 0.08 || Math.abs(last.edgeE - s.edgeE) > 0.02 ||
                  a.tint.some(function (t, i) { return Math.abs(t - b.tint[i]) > 0.02; });
      if (!moved) return;
    }
    k.sent = s;
    k.sentAt = now;
    if (_onKeyedState && this.stream) {
      try { _onKeyedState(this.stream); } catch (e) { /* ignore */ }
    }
  };

  // The composite program's two passes, from draw(), with its uniforms set.
  Processor.prototype.drawKeyed = function (w, h) {
    var gl = this.gl, k = this.keyed;
    var reason = this.keyedReason();
    var Z = KEY_MARKER.zone * Math.min(w, h);
    gl.uniform2f(uloc(gl, this.pComp, 'uZone'), Z / w, Z / h);
    gl.uniform1f(uloc(gl, this.pComp, 'uKeyOut'), reason ? 0 : 1);
    gl.uniform1f(uloc(gl, this.pComp, 'uTiltOn'), (!reason && k.tilt) ? 1 : 0);
    if (!reason && k.tilt) gl.uniform1ui(uloc(gl, this.pComp, 'uTiltBits'), encodeTilt(_tilt));
    this.drawQuad(null, w, h);
    this.copyKeyed(w, h);
    if (!reason && !k.checked) {
      k.checked = true;
      if (!this.keyedSelfCheck(w, h)) k.failed = true;
    }
    if (!reason) {
      gl.uniform1f(uloc(gl, this.pComp, 'uKeyOut'), 0);
      gl.uniform1f(uloc(gl, this.pComp, 'uTiltOn'), 0);
      this.drawQuad(null, w, h);
      // A keyed frame that failed its own check never goes out: the keyed
      // canvas gets the composite instead, from now on.
      if (k.failed) this.copyKeyed(w, h);
    }
    k.pending = true;
  };

  // The copy's budget. A test may raise it with `window.__voxalKeyCopyBudgetMs`,
  // read at every call like the canKeyIn() overrides: the real-peer mesh test
  // renders in software, where this copy is a read-back queued behind every
  // other peer's scene in one shared GPU process, and would always be judged
  // too slow to key at all.
  function keyCopyBudget() {
    var o = (typeof window !== 'undefined') ? Number(window.__voxalKeyCopyBudgetMs) : NaN;
    return o > 0 ? o : KEY_COPY_BUDGET_MS;
  }

  Processor.prototype.copyKeyed = function (w, h) {
    var k = this.keyed;
    if (k.canvas.width !== w || k.canvas.height !== h) {
      k.canvas.width = w;
      k.canvas.height = h;
    }
    var t0 = performance.now();
    try { k.ctx.drawImage(this.canvas, 0, 0, w, h); } catch (e) { return; }
    // Where the 2D canvas is not GPU-backed, this copy is a synchronous
    // read-back of the whole frame, every frame — milliseconds that come
    // straight out of the pipeline's own budget, on a device that may already
    // be close to giving the effect up. If it is that dear, keying is not
    // worth it here.
    if (k.copyTimes) {
      k.copyTimes.push(performance.now() - t0);
      if (k.copyTimes.length >= KEY_COPY_SAMPLES) {
        var sorted = k.copyTimes.slice().sort(function (a, b) { return a - b; });
        if (sorted[sorted.length >> 1] > keyCopyBudget()) k.slow = true;
        k.copyTimes = null;
      }
    }
  };

  // Read back the first keyed frame at the two places a receiver looks first:
  // the top-left zone must be the key, the top-right patch black. A browser
  // whose canvas copy, colour management or capture path disagrees would send
  // frames no receiver can detect — passed through, which is to say green —
  // so keying is withheld for good rather than trusted.
  Processor.prototype.keyedSelfCheck = function (w, h) {
    var k = this.keyed;
    var Z = KEY_MARKER.zone * Math.min(w, h);
    var cy = Math.floor(Z / 2);
    try {
      var tl = k.ctx.getImageData(Math.floor(Z / 2), cy, 1, 1).data;
      var tr = k.ctx.getImageData(Math.min(w - 1, Math.floor(w - Z / 2)), cy, 1, 1).data;
      var near = function (px, want) {
        return Math.abs(px[0] - want[0]) <= 8 && Math.abs(px[1] - want[1]) <= 8 && Math.abs(px[2] - want[2]) <= 8;
      };
      return near(tl, KEY_COLOR) && near(tr, [0, 0, 0]);
    } catch (e) {
      return false;
    }
  };

  Processor.prototype.requestKeyedFrame = function () {
    var k = this.keyed;
    if (!k || !k.pending) return;
    k.pending = false;
    if (k.manual && k.track.requestFrame) {
      try { k.track.requestFrame(); } catch (e) { /* track ended */ }
    }
  };

  // Rising demand draws a keyed frame at once, so a sender switched onto the
  // keyed track never starts on a canvas that has not been drawn.
  Processor.prototype.setKeyedDemand = function (n) {
    var k = this.keyed;
    if (!k) return;
    n = Math.max(0, Math.floor(Number(n) || 0));
    var was = k.demand;
    k.demand = n;
    if (was || !n || this.stopped || !this.gl) return;
    if (this.video.readyState < 2 || !this.video.videoWidth) return;
    try { this.draw(performance.now()); } catch (e) { return; }
    this.requestKeyedFrame();
  };

  // Where your shadow falls and how dark it is, from the measured light.
  //
  // The soft mask is sampled TOWARD the light: a shadow falls away from its
  // light, so the point it darkens is lit by way of you. A light from your
  // right throws your shadow to the left; a light from above drops it a little.
  // A light that is strongly to one side is a hard light (the window, the
  // sun) and gets the darker shadow; a frontal, diffuse one barely casts any.
  // In flip space, so +y is down the picture.
  Processor.prototype.shadowPlan = function () {
    var sc = this.scene, L = this.look;
    if (!sc || !sc.shadow) return { offX: 0, offY: 0, cast: 0, contact: 0 };
    return {
      offX: L.dirX * SHADOW_REACH,
      offY: -(0.015 + 0.035 * Math.max(0, Math.min(1, L.dirY))),
      cast: sc.shadow * (0.35 + 0.65 * L.hard),
      contact: SHADOW_AO
    };
  };

  // --- staying within budget ------------------------------------------------
  //
  // A phone that cannot keep up must degrade visibly-but-gracefully rather than
  // ship a 6 fps call. Step the segmentation rate down first, since that is
  // where nearly all the cost is; only give up once there is nothing left to
  // trade.

  Processor.prototype.measure = function (now) {
    this.frames++;
    if (!this.windowStart) { this.windowStart = now; return; }
    var elapsed = now - this.windowStart;
    if (elapsed < 5000) return;

    var achieved = this.frames * 1000 / elapsed;
    this.frames = 0;
    this.windowStart = now;

    if (achieved >= this.targetFps() * 0.6) { this.slowWindows = 0; return; }
    this.slowWindows++;

    // Before giving up anything of its own, ask whether the load can come off
    // somewhere else. Drawing other people's scenes (key-in) shares this GPU
    // and this main thread, and it is the user's OWN background that would be
    // stepped down, and finally switched off, to pay for it. If main.js shed
    // something, this window is not held against the pipeline.
    if (_onPressure) {
      var shed;
      try { shed = !!_onPressure(); } catch (e) { shed = false; }
      if (shed) return;
    }

    if (this.segStep < this.segHzSteps.length - 1) {
      this.segStep++;
      this.segInterval = 1000 / this.segHzSteps[this.segStep];
      this.slowWindows = 0;
      if (typeof console !== 'undefined' && console.info) {
        console.info('[VideoEffects] ' + Math.round(achieved) + ' fps — segmentation stepped to ' +
                     this.segHzSteps[this.segStep] + ' Hz');
      }
      return;
    }
    // Then the scene: half the redraws, the same picture moving less smoothly.
    if (this.sceneId && this.sceneStep < this.sceneHzSteps.length - 1) {
      this.sceneStep++;
      this.slowWindows = 0;
      if (typeof console !== 'undefined' && console.info) {
        console.info('[VideoEffects] ' + Math.round(achieved) + ' fps — scene stepped to ' +
                     this.sceneHzSteps[this.sceneStep] + ' Hz');
      }
      return;
    }
    this.giveUp('device cannot sustain the effect (' + Math.round(achieved) + ' fps)');
  };

  Processor.prototype.giveUp = function (why) {
    if (this.stopped || this.gaveUp) return;
    this.gaveUp = true;
    if (_onOverload) { try { _onOverload(why); } catch (e) { /* ignore */ } }
  };

  // --- lifecycle ------------------------------------------------------------

  // Swap the camera behind a running pipeline — used by flipCamera(). The
  // canvas track is unchanged, so there is nothing to replaceTrack and nothing
  // to renegotiate: the far side never sees the swap at all.
  Processor.prototype.setSource = function (rawStream) {
    this.raw = rawStream;
    if (this.stream) this.stream._effectsOriginal = rawStream;
    var self = this;
    return this.repoint(rawStream).then(function () {
      var size = self.sizeFromTrack();
      // Another camera is another room: a reference taken by the front camera
      // must not be compared with the back one. initGL() re-checks on its own.
      self.refLoaded = false;
      if (!self.gl || (size.w === self.canvas.width && size.h === self.canvas.height)) {
        self.syncReference();
        return;
      }
      // A different capture size needs new buffers; rebuilding the whole GL
      // state is simpler and rarer than resizing every attachment in place.
      // The keyed state is held back meanwhile (checkKeyedState()), and the
      // keyed canvas follows the new size on its next copy.
      self.rebuilding = true;
      self.releaseGL();
      self.initGL();
      self.applyBackground(self.mode).then(function () {
        self.rebuilding = false;
      }, function () {
        self.rebuilding = false;
      });
    });
  };

  Processor.prototype.setPaused = function (paused) {
    this.paused = !!paused;
    if (this.keyed) {
      try { this.keyed.track.enabled = !this.paused; } catch (e) { /* track ended */ }
    }
  };

  Processor.prototype.releaseGL = function () {
    var gl = this.gl;
    if (!gl) return;
    [this.texCam, this.texImg, this.texBlurA, this.texBlurB, this.texMaskRaw,
     this.texMaskS, this.texMaskSB, this.texMaskA, this.texMaskB,
     this.texPlate, this.texRefA, this.texRefB, this.texCore].forEach(function (t) {
      if (t) try { gl.deleteTexture(t); } catch (e) { /* ignore */ }
    });
    [this.fbBlurA, this.fbBlurB, this.fbMaskS, this.fbMaskSB,
     this.fbMaskA, this.fbMaskB, this.fbRefA, this.fbRefB, this.fbCore].forEach(function (f) {
      if (f) try { gl.deleteFramebuffer(f); } catch (e) { /* ignore */ }
    });
    [this.pDown, this.pBlur, this.pFeather, this.pMix, this.pDilate, this.pComp,
     this.pRef, this.pErode].forEach(function (p) {
      if (p) try { gl.deleteProgram(p); } catch (e) { /* ignore */ }
    });
    [this.texScene, this.texSoftA, this.texSoftB].concat(this.texSceneOut || []).forEach(function (t) {
      if (t) try { gl.deleteTexture(t); } catch (e) { /* ignore */ }
    });
    [this.fbScene, this.fbSoftA, this.fbSoftB].concat(this.fbSceneOut || []).forEach(function (f) {
      if (f) try { gl.deleteFramebuffer(f); } catch (e) { /* ignore */ }
    });
    if (this.pResolve) try { gl.deleteProgram(this.pResolve); } catch (e) { /* ignore */ }
    this.pResolve = undefined;
    var progs = this.sceneProgs;
    Object.keys(progs).forEach(function (k) {
      try { gl.deleteProgram(progs[k].program); } catch (e) { /* ignore */ }
    });
    this.sceneProgs = {};
    // A rebuilt context compiles its scene again (applyBackground); until it
    // lands, the blur shows rather than a scene with no program behind it.
    this.sceneId = null;
    this.scene = null;
    this.texScene = this.texSoftA = this.texSoftB = null;
    this.fbScene = this.fbSoftA = this.fbSoftB = null;
    this.texSceneOut = this.fbSceneOut = null;
    if (this.quad) try { gl.deleteBuffer(this.quad); } catch (e) { /* ignore */ }
    if (this.vao) try { gl.deleteVertexArray(this.vao); } catch (e) { /* ignore */ }
    this.gl = null;
    this.refLoaded = false;
  };

  Processor.prototype.destroy = function () {
    if (this.stopped) return;
    this.stopped = true;
    if (this.refCapture) this.finishCapture({ ok: false, reason: 'unavailable' });
    this.unpump();
    if (this.segmenter) { try { this.segmenter.close(); } catch (e) { /* ignore */ } this.segmenter = null; }
    if (this.keyed) {
      try { this.keyed.capture.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
      this.keyed.canvas.width = 0;
      this.keyed.canvas.height = 0;
      this.keyed = null;
    }
    // Lose the context outright rather than leave it for the garbage
    // collector. A page may hold only so many live WebGL contexts (16 in
    // Chromium, fewer in WebKit) and the browser frees room by killing the
    // OLDEST — which, after a few camera restarts or key-in receivers come
    // and gone, is the camera pipeline that is running now.
    var lose;
    try { lose = this.gl && this.gl.getExtension('WEBGL_lose_context'); } catch (e) { lose = null; }
    this.releaseGL();
    if (lose) { try { lose.loseContext(); } catch (e) { /* ignore */ } }
    this.canvas.width = 0;
    this.canvas.height = 0;
    try { this.video.pause(); } catch (e) { /* ignore */ }
    this.video.srcObject = null;
    if (this.stream) {
      this.stream._effectsOriginal = null;
      this.stream._effectsProcessor = null;
    }
    if (_active === this) {
      _active = null;
      if (_onReference) { try { _onReference(referenceState()); } catch (e) { /* ignore */ } }
    }
  };

  // --- the receiving end: key-in -------------------------------------------
  //
  // A peer that sends a keyed stream sends the person over the key colour and
  // an offer: which scene, how it is lit, how green its edge is, how big its
  // picture. Each such peer gets a KeyInProcessor here, which cuts the person
  // out of every incoming frame and puts them over THIS device's render of
  // the same scene, into a canvas whose capture is what the peer's tile shows.
  //
  // It is not a Processor, and must never be mistaken for one: it is never
  // `_active` (wrap() would destroy the user's own camera pipeline), never
  // reports through `_onOverload` (that switches the user's OWN background
  // off) or `_onProgress` (the picker's download bar), never loads the
  // segmentation runtime, and never sees `_plate` — the empty-room picture is
  // of the user's room, and a remote track's empty deviceId would otherwise
  // match it. It borrows the scene half of Processor (ensureScene, drawScene,
  // resolveScene, buildSoft, the shadow) and nothing else.

  // The CPU half of detection, a few times a second: the two zones of the
  // newest frame drawn into a 40x20 canvas and read at exactly the taps the
  // shader uses. It is what tells main.js, without a GPU read-back, when a
  // peer's frames are keyed and when they stopped being — lastKeyed and
  // lastUnkeyed are the performance.now() of the last frame seen each way.
  function MarkerProbe(video) {
    this.video = video;
    this.canvas = document.createElement('canvas');
    this.canvas.width = KEY_TAP_GRID * 2;
    this.canvas.height = KEY_TAP_GRID;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.expect = false;
    this.lastKeyed = 0;
    this.lastUnkeyed = 0;
    this.lastStrict = 0;
    this.lastProbe = 0;
  }

  // "A keyed frame was seen lately" — what lets the relaxed detector stand in
  // for a receiver that is not expecting keyed frames (it has withdrawn, and
  // they are still arriving). Only a frame that passed the STRICT test counts:
  // a relaxed pass renewing the very window that allows it would latch for as
  // long as somebody's ordinary picture happened to have a green top-left
  // corner.
  MarkerProbe.prototype.recent = function (now) {
    return !!this.lastStrict && now - this.lastStrict <= KEYIN_RECENT_MS;
  };

  function keyLikeRgb(c) { return c[1] > 0.75 && c[0] < 0.25 && c[2] < 0.25; }
  function keyERgb(c) { return c[1] - Math.max(c[0], c[2]); }

  // -> null when it is not time yet (or there is nothing to read), else
  // { keyed, kd } with kd the decoded key colour, 0-1.
  MarkerProbe.prototype.tick = function (now) {
    if (now - this.lastProbe < KEYIN_PROBE_MS) return null;
    var v = this.video, vw = v.videoWidth, vh = v.videoHeight;
    if (!this.ctx || !vw || !vh || v.readyState < 2) return null;
    this.lastProbe = now;
    var G = KEY_TAP_GRID, Z = KEY_MARKER.zone * Math.min(vw, vh), d;
    try {
      this.ctx.drawImage(v, 0, 0, Z, Z, 0, 0, G, G);
      this.ctx.drawImage(v, vw - Z, 0, Z, Z, G, 0, G, G);
      d = this.ctx.getImageData(0, 0, 2 * G, G).data;
    } catch (e) { return null; }
    var px = function (side, p) {
      var o = (p[1] * 2 * G + side * G + p[0]) * 4;
      return [d[o] / 255, d[o + 1] / 255, d[o + 2] / 255];
    };
    var avg = function (side, taps) {
      var s = [0, 0, 0];
      taps.forEach(function (p) { var c = px(side, p); s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; });
      return s.map(function (x) { return x / taps.length; });
    };
    var tl = KEY_TAPS.tl.every(function (p) { return keyLikeRgb(px(0, p)); });
    var kd = avg(0, KEY_TAPS.tl), patch = avg(1, KEY_TAPS.patch);
    var strict = tl && KEY_TAPS.ring.every(function (p) { return keyLikeRgb(px(1, p)); }) &&
                 Math.max(patch[0], patch[1], patch[2]) < 0.25;
    var keyed = (this.expect || this.recent(now)) ? (tl && keyERgb(patch) < 0.35) : strict;
    if (strict) this.lastStrict = now;
    if (keyed) this.lastKeyed = now; else this.lastUnkeyed = now;
    return { keyed: keyed, kd: kd };
  };

  function capKeyInSize(w, h) {
    var wide = w >= h;
    var maxW = wide ? KEYIN_MAX_LONG : KEYIN_MAX_SHORT, maxH = wide ? KEYIN_MAX_SHORT : KEYIN_MAX_LONG;
    var s = Math.min(1, maxW / w, maxH / h);
    return { w: Math.max(2, Math.round(w * s / 2) * 2), h: Math.max(2, Math.round(h * s / 2) * 2) };
  }

  function finiteIn(v, lo, hi, dflt) {
    v = Number(v);
    if (!isFinite(v)) return dflt;
    return Math.min(hi, Math.max(lo, v));
  }

  function KeyInProcessor(remote, offer, onGiveUp) {
    this.raw = remote;
    this.onGiveUp = typeof onGiveUp === 'function' ? onGiveUp : null;
    this.stopped = false;
    this.dead = false;        // gave up: the probe keeps running, the GL does not
    this.resolved = false;
    this.paused = false;
    this.expectKeyed = false;
    this.tiltStrip = false;   // the offer says the frames carry a tilt strip
    this.view = null;         // the sender's turn, as last read off it: { yaw, pitch, roll }
    this.viewAt = 0;
    this.tiltCanvas = null;
    this.tiltCtx = null;
    this.video = hiddenVideo(remote);
    this.canvas = document.createElement('canvas');
    this.gl = null;
    this.capture = null;
    this.track = null;
    this.manualFrames = false;
    this.zone = [KEY_MARKER.zone, KEY_MARKER.zone];   // the marker zone in UV, (Z / width, Z / height)
    this.srcW = 1280;                                   // the incoming frame's width
    this.segW = 0;
    this.segH = 0;
    this.picW = 0;            // the incoming picture's shape; the canvas may be wider or taller
    this.picH = 0;
    this.stageAspect = 0;     // the tile's width / height, or 0 for "the picture's own"
    this.maskPrimed = false;
    this.drawTimes = [];
    this.lastBudget = 0;
    this.warm = null;

    // The scene, kept exactly as Processor keeps it: its methods are borrowed.
    this.sceneId = null;
    this.scene = null;
    this.sceneProgs = {};
    this.pResolve = undefined;
    this.texSceneOut = null;
    this.fbSceneOut = null;
    this.sceneOut = 0;
    this.sceneAge = 0;
    this.sceneLook = 0;
    this.sceneHzSteps = SCENE_HZ.slice();
    this.sceneStep = 0;
    this.lastScene = 0;
    this.lastDraw = 0;
    this.sceneStart = 0;
    this.wantScene = null;
    this.look = VideoScenes.defaultLook();
    this.lookTarget = VideoScenes.defaultLook();
    this.lookPrev = null;
    this.lookCanvas = null;
    this.lookCtx = null;

    this.offer = { scene: null, edgeE: 0, size: null };
    this.edgeE = 0;
    this.applyOffer(offer);
    this.probe = new MarkerProbe(this.video);

    var self = this;
    this.canvas.addEventListener('webglcontextlost', function (ev) {
      ev.preventDefault();
      self.giveUp('context-lost');
    });
    this.handle = {
      stream: null,
      processor: this,
      setSource: function (s) { self.setSource(s); },
      setOffer: function (o) { return self.setOffer(o); },
      scene: function () { return self.sceneId; },
      setExpectKeyed: function (on) { self.expectKeyed = !!on; },
      setStageAspect: function (a) { self.setStageAspect(a); },
      pictureAspect: function () { return self.pictureAspect(); },
      setPaused: function (on) { self.paused = !!on; },
      lastKeyedAt: function () { return self.probe.lastKeyed; },
      lastUnkeyedAt: function () { return self.probe.lastUnkeyed; },
      alive: function () { return !self.stopped && !self.dead; },
      destroy: function () { self.destroy(); }
    };
  }

  ['drawQuad', 'bindTex', 'ensureScene', 'allocSoft', 'buildSoft', 'drawScene',
   'resolveScene', 'shadowPlan', 'pump', 'unpump', 'repoint', 'sceneDue'].forEach(function (name) {
    KeyInProcessor.prototype[name] = Processor.prototype[name];
  });

  // The offer's numbers, taken defensively even though main.js has already
  // sanitised them: a NaN in a uniform is a black tile.
  KeyInProcessor.prototype.applyOffer = function (offer) {
    offer = offer || {};
    var o = this.offer;
    o.scene = VideoScenes.resolveId(offer.scene) || null;
    var sz = offer.size;
    if (sz && sz.length === 2 && isFinite(sz[0]) && isFinite(sz[1]) && sz[0] > 0 && sz[1] > 0) {
      o.size = [Math.round(finiteIn(sz[0], 16, 4096, 640)), Math.round(finiteIn(sz[1], 16, 4096, 360))];
    }
    if (offer.edgeE !== undefined && offer.edgeE !== null) o.edgeE = finiteIn(offer.edgeE, -1, 0, o.edgeE);
    this.edgeE = o.edgeE;
    this.tiltStrip = offer.tilt === true;
    if (!this.tiltStrip) this.view = null;
    if (offer.look) this.applyLook(offer.look);
  };

  // The scene turns the way the sender's phone has, as the strip on the
  // frame says; none when it does not carry one.
  KeyInProcessor.prototype.sceneView = function () { return this.view; };

  // Read the strip off the newest frame: 32 cells along the top edge, sampled
  // at their centres into a 32x1 canvas. Called only when the scene is about
  // to be redrawn, so it is at most as often as that (20 a second) and never
  // for a frame the scene would not use. A frame that does not decode (a
  // composite passing through, a mangled one) keeps the last turn for half a
  // second and then eases back to a still camera.
  KeyInProcessor.prototype.readTilt = function (now) {
    var v = this.video, vw = v.videoWidth, vh = v.videoHeight, n = KEY_TILT.cells, got;
    if (!vw || !vh || v.readyState < 2) return;
    try {
      if (!this.tiltCtx) {
        this.tiltCanvas = document.createElement('canvas');
        this.tiltCanvas.width = n; this.tiltCanvas.height = 1;
        this.tiltCtx = this.tiltCanvas.getContext('2d', { willReadFrequently: true });
      }
      var Z = KEY_MARKER.zone * Math.min(vw, vh), sh = Math.max(2, Z * KEY_TILT.rows);
      // The middle half of the strip's height: its edges bleed into the
      // picture below and the top row.
      this.tiltCtx.drawImage(v, Z, sh * 0.25, Math.max(n, vw - 2 * Z), sh * 0.5, 0, 0, n, 1);
      var d = this.tiltCtx.getImageData(0, 0, n, 1).data, bits = 0;
      for (var i = 0; i < n; i++) {
        var lum = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
        if (lum > 0.5) bits |= (1 << i);
      }
      got = decodeTilt(bits >>> 0);
    } catch (e) { got = null; }
    if (got) {
      this.view = got;
      this.viewAt = now;
    } else if (this.view && now - this.viewAt > 500) {
      var k = 0.85;
      this.view = { yaw: this.view.yaw * k, pitch: this.view.pitch * k, roll: this.view.roll * k };
      if (Math.abs(this.view.yaw) + Math.abs(this.view.pitch) + Math.abs(this.view.roll) < 1e-4) this.view = null;
    }
  };

  // The look is the SENDER's: exposure, white balance and the light's
  // direction can only be measured where the room still is, and a keyed
  // frame has no room left in it. So they are taken whole from the offer
  // (the first one is applied at once — easeLook takes a first measurement
  // whole — and later ones are eased into), and only where the person is
  // in the picture is measured here (sampleGeometry()).
  KeyInProcessor.prototype.applyLook = function (look) {
    var t = this.lookTarget, cfg = VideoScenes._lookConfig;
    if (look.tint && look.tint.length === 3) {
      t.tint = [0, 1, 2].map(function (i) { return finiteIn(look.tint[i], 0.5, 2, 1); });
    }
    t.exposure = finiteIn(look.exposure, cfg.expMin, cfg.expMax, t.exposure);
    t.dirX = finiteIn(look.dirX, -1, 1, t.dirX);
    t.dirY = finiteIn(look.dirY, -1, 1, t.dirY);
    t.hard = finiteIn(look.hard, 0, 1, t.hard);
    if (look.side === 1 || look.side === -1) t.side = look.side;
    t.measured = true;
  };

  // The canvas: the sender's own size, capped at 1280x720 — not the size the
  // frames happen to arrive at, which climbs through two or three steps in a
  // call's first twenty seconds as the encoder finds its bitrate. The camera
  // texture is sampled by UV, so it may be any size at all; only a new SHAPE
  // (a phone turned) is worth a resize.
  KeyInProcessor.prototype.sizeFor = function (vw, vh) {
    var sz = this.offer.size;
    var base = capKeyInSize(sz ? sz[0] : vw, sz ? sz[1] : vh);
    var aspect = vw / vh;
    if (Math.abs(aspect / (base.w / base.h) - 1) <= KEYIN_ASPECT_TOL) return base;
    var long = Math.max(base.w, base.h);
    return aspect >= 1 ? capKeyInSize(long, long / aspect) : capKeyInSize(long * aspect, long);
  };

  // The canvas for a picture of this size. Normally the picture's own shape.
  // When the tile showing it is a different shape (setStageAspect), the canvas
  // takes the TILE's: the picture stays whole and the scene — drawn here, so it
  // has no edge — continues past it, where the tile would otherwise show bars.
  KeyInProcessor.prototype.outputSize = function (pw, ph) {
    var A = this.resolved ? this.stageAspect : 0, pa = pw / ph;
    if (!(A > 0) || Math.abs(A / pa - 1) <= KEYIN_ASPECT_TOL) return { w: pw, h: ph };
    return A > pa ? capKeyInSize(ph * A, ph) : capKeyInSize(pw, pw / A);
  };

  KeyInProcessor.prototype.initGL = function (w, h) {
    this.picW = w;
    this.picH = h;
    var out = this.outputSize(w, h);
    this.canvas.width = out.w;
    this.canvas.height = out.h;
    var gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      desynchronized: false,
      preserveDrawingBuffer: false
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    fullScreenTriangle(gl, this);
    this.pKeyMask = program(gl, FRAG_KEY_MASK);
    this.pKeyComp = program(gl, FRAG_KEYIN);
    this.pFeather = program(gl, FRAG_FEATHER);
    this.texCam = texture(gl, 1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    var seg = segSizeFor(w, h);
    this.segW = seg.width;
    this.segH = seg.height;
    this.texMaskA = texture(gl, this.segW, this.segH, gl.RG8, gl.RG, gl.UNSIGNED_BYTE);
    this.fbMaskA = framebuffer(gl, this.texMaskA);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  };

  // The light resize: the canvas, the matte (if its shape changed) and the
  // scene's buffers. The programs stay — a recompile is seconds of somebody's
  // tile showing nothing — and so does the context.
  KeyInProcessor.prototype.resize = function (w, h) {
    var gl = this.gl;
    this.picW = w;
    this.picH = h;
    var out = this.outputSize(w, h);
    this.canvas.width = out.w;
    this.canvas.height = out.h;
    var seg = segSizeFor(w, h);
    if (seg.width !== this.segW || seg.height !== this.segH) {
      this.segW = seg.width;
      this.segH = seg.height;
      gl.bindTexture(gl.TEXTURE_2D, this.texMaskA);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, this.segW, this.segH, 0, gl.RG, gl.UNSIGNED_BYTE, null);
      this.maskPrimed = false;
      if (this.texSoftA) this.allocSoft(this.segW, this.segH);
    }
    if (this.texSceneOut) {
      this.texSceneOut.forEach(function (t) { gl.deleteTexture(t); });
      this.fbSceneOut.forEach(function (f) { gl.deleteFramebuffer(f); });
      this.texSceneOut = this.fbSceneOut = null;
    }
    if (this.sceneId) {
      try { this.ensureScene(this.sceneId); } catch (e) { this.giveUp('scene'); }
    }
  };

  KeyInProcessor.prototype.openOutput = function () {
    var cs = this.canvas.captureStream(0);
    var track = cs.getVideoTracks()[0];
    if (!track || typeof track.requestFrame !== 'function') {
      try { cs.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
      cs = this.canvas.captureStream(30);
      track = cs.getVideoTracks()[0];
      this.manualFrames = false;
    } else {
      this.manualFrames = true;
    }
    this.capture = cs;
    this.track = track;
    this.handle.stream = cs;
  };

  KeyInProcessor.prototype.check = function () {
    if (this.stopped) throw new Error('key-in was destroyed');
    if (this.dead) throw new Error('key-in gave up');
  };

  // Frames flowing means a real picture size. Unlike the camera's own
  // waitForFrame(), no timeout is taken as "good enough": a stalled remote
  // stream is a reason not to key, not a 1280x720 guess.
  KeyInProcessor.prototype.waitForFrames = function () {
    var self = this, v = this.video, t0 = performance.now();
    return new Promise(function (resolve, reject) {
      (function poll() {
        if (self.stopped) { reject(new Error('key-in was destroyed')); return; }
        if (v.readyState >= 2 && v.videoWidth && v.videoHeight) { resolve(); return; }
        if (performance.now() - t0 > KEYIN_FRAME_WAIT_MS) { reject(new Error('no frames from the remote stream')); return; }
        setTimeout(poll, 50);
      })();
    });
  };

  // Frames flow → the scene compiles → the self-test → the warm-up. Only
  // then is the handle given out, and only then does main.js tell the
  // sender it is ready: a receiver that cannot do the job says so by never
  // saying yes, which leaves the peer on the composite.
  KeyInProcessor.prototype.start = function () {
    var self = this, id = this.offer.scene;
    if (!id) return Promise.reject(new Error('key-in needs a scene'));
    return this.video.play().catch(function () { /* muted autoplay */ })
      .then(function () { return self.waitForFrames(); })
      .then(function () {
        self.check();
        var s = self.sizeFor(self.video.videoWidth, self.video.videoHeight);
        self.initGL(s.w, s.h);
        return VideoScenes.compileProgramAsync(self.gl, id);
      })
      .then(function (prog) {
        self.check();
        self.sceneProgs[id] = prog;
        self.wantScene = id;
        self.ensureScene(id);
        self.openOutput();
        var why = self.selfTest();
        if (why) throw new Error('key-in self-test failed: ' + why);
        return self.warmUp();
      })
      .then(function () {
        self.check();
        self.resolved = true;
        // A tile shape told to us while starting is applied now.
        if (self.stageAspect) self.resize(self.picW, self.picH);
        return self.handle;
      });
  };

  // How long the warm-up may wait for its frames. A test may lengthen it with
  // `window.__voxalKeyInWarmWaitMs`, read at every start like the canKeyIn()
  // overrides: the unit suite runs receivers on a software GPU that canKeyIn()
  // refuses, several browsers to a machine, where frames arrive at a rate no
  // receiver this wait is meant for would ever see — a wait that measured
  // the machine and not the code under test.
  function keyInWarmWait() {
    var o = (typeof window !== 'undefined') ? Number(window.__voxalKeyInWarmWaitMs) : NaN;
    return o > 0 ? o : KEYIN_WARM_WAIT_MS;
  }

  KeyInProcessor.prototype.warmUp = function () {
    var self = this;
    return new Promise(function (resolve, reject) {
      self.warm = {
        times: [], resolve: resolve, reject: reject,
        timer: setTimeout(function () {
          var w = self.warm;
          if (!w) return;
          self.warm = null;
          reject(new Error('key-in warm-up timed out (' + w.times.length + ' frames)'));
        }, keyInWarmWait())
      };
      self.pump();
    });
  };

  // Check the whole path on this engine before anybody relies on it.
  //
  // First, that the GPU sees the incoming frame the way a 2D canvas does — a
  // webview that uploads remote video flipped, black or not at all would key
  // nonsense. Then two synthetic frames through the real passes: a keyed one,
  // whose subject must come out as itself and whose background and zones must
  // come out as anything but the key; and an unmarked one with a green
  // top-left corner, which must come out untouched. Returns null when all is
  // well, or what failed.
  KeyInProcessor.prototype.selfTest = function () {
    var gl = this.gl, v = this.video, vw = v.videoWidth, vh = v.videoHeight;
    gl.bindTexture(gl.TEXTURE_2D, this.texCam);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v); } catch (e) { return 'upload'; }
    var pts = [[0.1, 0.1], [0.9, 0.1], [0.5, 0.5], [0.1, 0.9], [0.9, 0.9]].map(function (f) {
      return [Math.min(vw - 1, Math.floor(f[0] * vw)), Math.min(vh - 1, Math.floor(f[1] * vh))];
    });
    var gpu = [], texel = new Uint8Array(4);
    var fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texCam, 0);
    // Rows as stored: the camera texture keeps the picture's top row first,
    // and so does a framebuffer's row 0.
    pts.forEach(function (p) {
      gl.readPixels(p[0], p[1], 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, texel);
      gpu.push([texel[0], texel[1], texel[2]]);
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    var probe = document.createElement('canvas');
    probe.width = pts.length; probe.height = 1;
    var pc = probe.getContext('2d', { willReadFrequently: true });
    var cpu;
    try {
      pts.forEach(function (p, i) { pc.drawImage(v, p[0], p[1], 1, 1, i, 0, 1, 1); });
      cpu = pc.getImageData(0, 0, pts.length, 1).data;
    } catch (e) { return 'probe'; }
    // Generous: the two paths may convert YUV a little differently, and a
    // moving picture may even have moved on by a frame. What this is for is a
    // flipped, black or garbage upload, which misses by far more.
    var agree = 0;
    gpu.forEach(function (g, i) {
      var d = Math.max(Math.abs(g[0] - cpu[i * 4]), Math.abs(g[1] - cpu[i * 4 + 1]), Math.abs(g[2] - cpu[i * 4 + 2]));
      if (d <= 48) agree++;
    });
    if (agree < pts.length - 1) return 'texture';

    var W = 160, H = 90, Z = KEY_MARKER.zone * Math.min(W, H), P = KEY_MARKER.patch * Z;
    var syn = document.createElement('canvas');
    syn.width = W; syn.height = H;
    var sx = syn.getContext('2d', { alpha: false });
    var C = [200, 120, 90];
    var zoneUv = [Z / 2 / W, Z / 2 / H];
    sx.fillStyle = 'rgb(0,255,0)';
    sx.fillRect(0, 0, W, H);
    sx.fillStyle = 'rgb(' + C.join(',') + ')';
    sx.fillRect(W * 0.3, H * 0.3, W * 0.4, H * 0.7);
    sx.fillStyle = '#000';
    sx.fillRect(W - Z + (Z - P) / 2, (Z - P) / 2, P, P);
    var keyed = this.synthPass(syn, [[0.5, 0.75], [0.12, 0.6], zoneUv]);
    sx.fillStyle = 'rgb(128,128,128)';
    sx.fillRect(0, 0, W, H);
    sx.fillStyle = 'rgb(0,255,0)';
    sx.fillRect(0, 0, Z, Z);
    var plain = this.synthPass(syn, [[0.5, 0.75], zoneUv]);
    if (!keyed || !plain) return 'synthetic';
    var near = function (px, want, tol) {
      return Math.abs(px[0] - want[0]) <= tol && Math.abs(px[1] - want[1]) <= tol && Math.abs(px[2] - want[2]) <= tol;
    };
    var notKey = function (px) { return !near(px, KEY_COLOR, 60); };
    if (!near(keyed[0], C, 12)) return 'subject';
    if (!notKey(keyed[1]) || !notKey(keyed[2])) return 'background';
    if (!near(plain[0], [128, 128, 128], 8) || !near(plain[1], KEY_COLOR, 8)) return 'passthrough';
    return null;
  };

  // One synthetic frame through the matte, the soft mask and the composite,
  // read back at UV points (image coordinates) from the canvas in the same
  // task — or, with no points, the whole canvas as RGBA bytes, top row first.
  // Strict detection unless `expect` (the self-test never expects; the codec
  // tests use both).
  KeyInProcessor.prototype.synthPass = function (src, points, expect) {
    var gl = this.gl;
    if (!this.texSynth) this.texSynth = texture(gl, 1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    gl.bindTexture(gl.TEXTURE_2D, this.texSynth);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    var Z = KEY_MARKER.zone * Math.min(src.width, src.height);
    this.zone = [Z / src.width, Z / src.height];
    this.srcW = src.width;
    this.keyMask(this.texSynth, !!expect, false);
    this.buildSoft();
    this.composite(this.texSynth, !!expect, false);
    var cw = this.canvas.width, ch = this.canvas.height;
    var probe = document.createElement('canvas');
    if (!points) {
      probe.width = cw; probe.height = ch;
      var fc = probe.getContext('2d', { willReadFrequently: true });
      try {
        fc.drawImage(this.canvas, 0, 0);
        return fc.getImageData(0, 0, cw, ch).data;
      } catch (e) { return null; }
    }
    probe.width = points.length; probe.height = 1;
    var pc = probe.getContext('2d', { willReadFrequently: true });
    try {
      var self = this;
      points.forEach(function (p, i) {
        var x = Math.min(cw - 1, Math.floor(p[0] * cw)), y = Math.min(ch - 1, Math.floor(p[1] * ch));
        pc.drawImage(self.canvas, x, y, 1, 1, i, 0, 1, 1);
      });
      var d = pc.getImageData(0, 0, points.length, 1).data;
      return points.map(function (p, i) { return [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]]; });
    } catch (e) {
      return null;
    }
  };

  KeyInProcessor.prototype.keyMask = function (tex, expect, recent) {
    var gl = this.gl, p = this.pKeyMask;
    gl.useProgram(p);
    this.bindTex(p, 'uCam', 0, tex);
    gl.uniform2f(uloc(gl, p, 'uZone'), this.zone[0], this.zone[1]);
    gl.uniform1f(uloc(gl, p, 'uExpectKeyed'), expect ? 1 : 0);
    gl.uniform1f(uloc(gl, p, 'uKeyedRecently'), recent ? 1 : 0);
    gl.uniform1f(uloc(gl, p, 'uTiltStrip'), this.tiltStrip ? 1 : 0);
    gl.uniform2f(uloc(gl, p, 'uOff'), 0.25 / this.segW, 0.25 / this.segH);
    // The same distance in pixels down the picture as across it: the zone is
    // square in pixels, so zone.y / zone.x is the frame's width over height.
    var aspect = this.zone[1] / this.zone[0];
    var reach = Math.max(KEYIN_BAND_REACH, KEYIN_BAND_MIN_PX / this.srcW);
    gl.uniform2f(uloc(gl, p, 'uReach'), reach, reach * aspect);
    this.drawQuad(this.fbMaskA, this.segW, this.segH);
    this.maskPrimed = true;
  };

  KeyInProcessor.prototype.composite = function (tex, expect, recent) {
    var gl = this.gl, p = this.pKeyComp;
    var hasScene = !!(this.sceneId && this.scene);
    gl.useProgram(p);
    this.bindTex(p, 'uCam', 0, tex);
    this.bindTex(p, 'uMask', 3, this.texMaskA);
    // Bound whether or not there is a scene: a sampler with nothing behind it
    // is an error on some drivers even in a branch that never reads it.
    this.bindTex(p, 'uScene', 6, (this.texSceneOut && this.texSceneOut[this.sceneOut]) || this.texScene || this.texCam);
    this.bindTex(p, 'uSceneEnv', 9, this.texScene || this.texCam);
    this.bindTex(p, 'uSoft', 7, this.texSoftA || this.texMaskA);
    gl.uniform2f(uloc(gl, p, 'uZone'), this.zone[0], this.zone[1]);
    gl.uniform1f(uloc(gl, p, 'uExpectKeyed'), expect ? 1 : 0);
    gl.uniform1f(uloc(gl, p, 'uKeyedRecently'), recent ? 1 : 0);
    gl.uniform1f(uloc(gl, p, 'uTiltStrip'), this.tiltStrip ? 1 : 0);
    gl.uniform1f(uloc(gl, p, 'uEdgeE'), this.edgeE);
    var sh = this.shadowPlan();
    gl.uniform2f(uloc(gl, p, 'uShadowOff'), sh.offX, sh.offY);
    gl.uniform2f(uloc(gl, p, 'uShadow'), sh.cast, sh.contact);
    gl.uniform1f(uloc(gl, p, 'uWrap'), hasScene ? this.scene.wrap : 0);
    gl.uniform1f(uloc(gl, p, 'uHasScene'), hasScene ? 1 : 0);
    gl.uniform3f(uloc(gl, p, 'uFlat'), KEYIN_FLAT[0], KEYIN_FLAT[1], KEYIN_FLAT[2]);
    var f = this.fit();
    gl.uniform2f(uloc(gl, p, 'uFit'), f[0], f[1]);
    this.drawQuad(null, this.canvas.width, this.canvas.height);
  };

  // How much bigger than the picture the output is, per axis (>= 1): the
  // factor that maps an output coordinate onto the picture's.
  KeyInProcessor.prototype.fit = function () {
    var oa = this.canvas.width / this.canvas.height, pa = this.picW && this.picH ? this.picW / this.picH : oa;
    return [Math.max(1, oa / pa), Math.max(1, pa / oa)];
  };

  // Tell the receiver what shape its tile is. 0 (or anything unusable) means
  // the picture's own shape. Cheap to repeat; a real change re-sizes the canvas
  // and so is the caller's to debounce. Held until the handle is out, so the
  // self-test's synthetic frames are read off a canvas of the picture's shape.
  KeyInProcessor.prototype.setStageAspect = function (a) {
    a = Number(a);
    a = (isFinite(a) && a > 0) ? Math.min(4, Math.max(0.25, a)) : 0;
    var was = this.stageAspect;
    if (was === a || (was && a && Math.abs(a / was - 1) < 0.03)) return;
    this.stageAspect = a;
    if (!this.resolved || this.stopped || this.dead || !this.gl || !this.picW) return;
    this.resize(this.picW, this.picH);
  };

  KeyInProcessor.prototype.pictureAspect = function () {
    return this.picW && this.picH ? this.picW / this.picH : 0;
  };

  KeyInProcessor.prototype.draw = function (now) {
    var gl = this.gl, v = this.video;
    var vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return false;
    if (Math.abs((vw / vh) / (this.picW / this.picH) - 1) > KEYIN_ASPECT_TOL) {
      var s = this.sizeFor(vw, vh);
      this.resize(s.w, s.h);
      if (this.dead) return false;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.texCam);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
    } catch (e) {
      return false;   // the source can vanish mid-teardown
    }
    var Z = KEY_MARKER.zone * Math.min(vw, vh);
    this.zone = [Z / vw, Z / vh];
    this.srcW = vw;
    var recent = this.probe.recent(now);
    this.keyMask(this.texCam, this.expectKeyed, recent);
    // Drawn in passthrough too: its history stays warm, and what the
    // receiver pays now is what it will pay once keyed frames arrive.
    if (this.sceneId) {
      if (this.tiltStrip && this.sceneDue(now)) this.readTilt(now);
      this.drawScene(now);
    }
    this.buildSoft();
    this.composite(this.texCam, this.expectKeyed, recent);
    return true;
  };

  KeyInProcessor.prototype.onFrame = function () {
    if (this.stopped) return;
    this.pump();
    var now = performance.now();
    // The probe runs paused and even after a give-up: main.js still needs to
    // know when this peer's frames stop being keyed.
    this.probe.expect = this.expectKeyed;
    var seen = this.probe.tick(now);
    if (seen && seen.keyed && !this.dead) this.sampleGeometry(seen.kd);
    if (this.dead || this.paused || !this.gl || this.video.readyState < 2 || !this.video.videoWidth) return;
    var t0 = performance.now(), drew;
    try { drew = this.draw(now); } catch (e) { drew = false; }
    if (!drew) return;
    var ms = performance.now() - t0;
    if (this.manualFrames && this.track && this.track.requestFrame) {
      try { this.track.requestFrame(); } catch (e) { /* track ended */ }
    }
    this.noteDraw(now, ms);
  };

  // The frame budget, warm-up and running alike. A test may raise it with
  // `window.__voxalKeyInFrameBudgetMs`, read at every call like the canKeyIn()
  // overrides: the real-peer mesh test renders in software, where one scene
  // redraw is tens of milliseconds and every peer shares one GPU process, so
  // no receiver there could ever pass the budget a real GPU is held to.
  function keyInFrameBudget(ms) {
    var o = (typeof window !== 'undefined') ? Number(window.__voxalKeyInFrameBudgetMs) : NaN;
    return o > 0 ? o : ms;
  }

  // The warm-up's 30 frames, then the running budget: a rolling median over
  // five seconds. Over budget is a give-up ('budget'), which main.js answers
  // by putting the peer back on the composite — never by touching the user's
  // own camera pipeline.
  KeyInProcessor.prototype.noteDraw = function (now, ms) {
    var w = this.warm;
    if (w) {
      w.times.push(ms);
      if (w.times.length < KEYIN_WARM_FRAMES) return;
      this.warm = null;
      clearTimeout(w.timer);
      var m = median(w.times);
      if (m < keyInFrameBudget(KEYIN_WARM_MS)) w.resolve();
      else w.reject(new Error('key-in over budget (' + m.toFixed(1) + ' ms a frame)'));
      return;
    }
    var t = this.drawTimes;
    t.push([now, ms]);
    while (t.length && now - t[0][0] > KEYIN_BUDGET_WINDOW_MS) t.shift();
    if (now - this.lastBudget < 1000) return;
    this.lastBudget = now;
    if (t.length < 10 || now - t[0][0] < KEYIN_BUDGET_WINDOW_MS * 0.9) return;
    if (median(t.map(function (x) { return x[1]; })) > keyInFrameBudget(KEYIN_BUDGET_MS)) this.giveUp('budget');
  };

  // Where the person is in the picture, from the key itself: the geometry
  // the scene reacts to (the light's falloff around you, the dust you stir)
  // and nothing else — see applyLook() for the rest.
  KeyInProcessor.prototype.sampleGeometry = function (kd) {
    var v = this.video, vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return;
    var pw = LOOK_PROBE_W, ph = Math.max(2, Math.round(pw * vh / vw));
    if (!this.lookCtx || this.lookCanvas.height !== ph) {
      this.lookCanvas = document.createElement('canvas');
      this.lookCanvas.width = pw; this.lookCanvas.height = ph;
      this.lookCtx = this.lookCanvas.getContext('2d', { willReadFrequently: true });
      this.lookPrev = null;
    }
    try {
      this.lookCtx.drawImage(v, 0, 0, pw, ph);
      var rgba = this.lookCtx.getImageData(0, 0, pw, ph).data;
      var eK = Math.max(keyERgb(kd), 0.3);
      var Z = KEY_MARKER.zone * Math.min(vw, vh), zx = Z / vw * pw, zy = Z / vh * ph;
      var grid = new Uint8Array(pw * ph);
      for (var y = 0; y < ph; y++) {
        for (var x = 0; x < pw; x++) {
          var i = y * pw + x;
          if (y + 0.5 < zy && (x + 0.5 < zx || x + 0.5 > pw - zx)) continue;
          if (this.tiltStrip && y + 0.5 < zy * KEY_TILT.rows) continue;
          var e = rgba[i * 4 + 1] / 255 - Math.max(rgba[i * 4] / 255, rgba[i * 4 + 2] / 255);
          var a0 = Math.min(1, Math.max(0, 1 - e / eK));
          grid[i] = a0 < KEY_ALPHA_FLOOR ? 0 : a0 > KEYIN_SATURATE ? 255 : Math.round(a0 * 255);
        }
      }
      var stats = VideoScenes.measureSubject(rgba, pw, ph, grid, this.lookPrev);
      this.lookPrev = grid;
      var t = this.lookTarget;
      if (stats) {
        // Measured in the picture; the scene is drawn in the (maybe larger) output.
        var f = this.fit();
        t.cx = (stats.cx - 0.5) / f[0] + 0.5; t.cy = (stats.cy - 0.5) / f[1] + 0.5;
        t.sx = stats.sx / f[0]; t.sy = stats.sy / f[1];
        t.motion = Math.min(1, Math.max(0, (stats.motion - 0.03) * 4));
      } else {
        t.motion = 0;
      }
    } catch (e) { /* a frame that cannot be read leaves the last geometry standing */ }
  };

  // A new offer: the look and the edge at once, the scene once it compiles.
  // The scene being drawn keeps drawing until then, and a compile that fails
  // leaves it drawing and rejects — main.js decides what a scene this device
  // cannot draw means for the peer.
  KeyInProcessor.prototype.setOffer = function (offer) {
    var self = this;
    this.applyOffer(offer);
    var id = this.offer.scene;
    if (!id || id === this.sceneId) {
      this.wantScene = this.sceneId;
      return Promise.resolve(this.sceneId);
    }
    if (this.stopped || this.dead || !this.gl) return Promise.reject(new Error('key-in is not running'));
    this.wantScene = id;
    var gl = this.gl;
    var ready = this.sceneProgs[id] ? Promise.resolve(this.sceneProgs[id]) : VideoScenes.compileProgramAsync(gl, id);
    return ready.then(function (prog) {
      if (self.stopped || self.gl !== gl) throw new Error('key-in went away');
      self.sceneProgs[id] = prog;
      if (self.wantScene !== id) return self.sceneId;   // a later offer won
      self.ensureScene(id);
      return self.sceneId;
    });
  };

  // The peer's stream object changed (a re-call). The canvas, and so the
  // track the tile shows, stays: no flash.
  KeyInProcessor.prototype.setSource = function (remote) {
    if (this.stopped || !remote) return;
    this.raw = remote;
    this.repoint(remote);
  };

  KeyInProcessor.prototype.giveUp = function (why) {
    if (this.stopped || this.dead) return;
    this.dead = true;
    if (this.warm) {
      var w = this.warm;
      this.warm = null;
      clearTimeout(w.timer);
      w.reject(new Error('key-in gave up: ' + why));
    }
    if (this.resolved && this.onGiveUp) {
      try { this.onGiveUp(why); } catch (e) { /* ignore */ }
    }
  };

  KeyInProcessor.prototype.releaseGL = function () {
    var gl = this.gl;
    if (!gl) return;
    [this.texCam, this.texMaskA, this.texSynth, this.texScene, this.texSoftA, this.texSoftB]
      .concat(this.texSceneOut || []).forEach(function (t) {
        if (t) try { gl.deleteTexture(t); } catch (e) { /* ignore */ }
      });
    [this.fbMaskA, this.fbScene, this.fbSoftA, this.fbSoftB].concat(this.fbSceneOut || []).forEach(function (f) {
      if (f) try { gl.deleteFramebuffer(f); } catch (e) { /* ignore */ }
    });
    [this.pKeyMask, this.pKeyComp, this.pFeather, this.pResolve].forEach(function (p) {
      if (p) try { gl.deleteProgram(p); } catch (e) { /* ignore */ }
    });
    var progs = this.sceneProgs;
    Object.keys(progs).forEach(function (k) {
      try { gl.deleteProgram(progs[k].program); } catch (e) { /* ignore */ }
    });
    if (this.quad) try { gl.deleteBuffer(this.quad); } catch (e) { /* ignore */ }
    if (this.vao) try { gl.deleteVertexArray(this.vao); } catch (e) { /* ignore */ }
    this.sceneProgs = {};
    this.pResolve = undefined;
    this.sceneId = null;
    this.scene = null;
    this.texCam = this.texMaskA = this.texSynth = this.texScene = this.texSoftA = this.texSoftB = null;
    this.fbMaskA = this.fbScene = this.fbSoftA = this.fbSoftB = null;
    this.texSceneOut = this.fbSceneOut = null;
    this.gl = null;
  };

  // Stops ITS OWN canvas tracks and nothing else: the remote tracks belong to
  // the call. Loses the context at once — see Processor.destroy() for why a
  // context left to the garbage collector is a threat to the user's camera.
  KeyInProcessor.prototype.destroy = function () {
    if (this.stopped) return;
    this.stopped = true;
    this.unpump();
    if (this.warm) {
      var w = this.warm;
      this.warm = null;
      clearTimeout(w.timer);
      w.reject(new Error('key-in was destroyed'));
    }
    if (this.capture) {
      try { this.capture.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
    }
    var lose;
    try { lose = this.gl && this.gl.getExtension('WEBGL_lose_context'); } catch (e) { lose = null; }
    this.releaseGL();
    if (lose) { try { lose.loseContext(); } catch (e) { /* ignore */ } }
    this.canvas.width = 0;
    this.canvas.height = 0;
    try { this.video.pause(); } catch (e) { /* ignore */ }
    this.video.srcObject = null;
    var i = _keyIns.indexOf(this);
    if (i >= 0) _keyIns.splice(i, 1);
  };

  // --- public surface -------------------------------------------------------

  // Wrap a raw camera stream. Resolves with the processed stream, which carries
  // `_effectsOriginal` so teardown can find the real camera behind it — exactly
  // the contract applyRNNoise()/stopMicStreamFully() use for the microphone.
  function wrap(rawStream, mode) {
    mode = normalizeMode(mode || readMode());
    if (mode === 'off') return Promise.resolve(rawStream);
    if (!isSupported()) return Promise.reject(new Error('video effects unsupported here'));
    if (_active) { _active.destroy(); _active = null; }

    var p = new Processor(rawStream, mode);
    _active = p;
    return p.start().then(function (stream) {
      if (!stream) throw new Error('video effects were torn down while starting');
      return stream;
    }, function (err) {
      p.destroy();
      throw err;
    });
  }

  function setMode(mode) {
    mode = normalizeMode(mode);
    if (!_active) return Promise.resolve(mode);
    return _active.applyBackground(mode).then(function () { return mode; });
  }

  function setSource(rawStream) {
    return _active ? _active.setSource(rawStream) : Promise.resolve();
  }

  function setPaused(paused) {
    if (_active) _active.setPaused(paused);
  }

  // stop(stream) tears down the pipeline behind a processed stream;
  // stop() with no argument tears down whatever is running.
  function stop(stream) {
    var p = stream ? stream._effectsProcessor : _active;
    if (p) p.destroy();
  }

  // Store a new blur strength and push it at whatever is running. Safe to call
  // on every `input` event of a dragged slider: it writes one small string and
  // rebuilds an array of at most six numbers.
  function setStrength(v) {
    v = writeStrength(v);
    if (_active) { try { _active.applyStrength(); } catch (e) { /* ignore */ } }
    return v;
  }

  // The other three preferences, stored and pushed at whatever is running.
  // Each one is uniforms or a timer — never a reallocation and never a track
  // swap — so all three are safe to call on every event of a dragged slider or
  // a hammered toggle, mid-call included.
  function setSharpness(v) {
    v = writeSharpness(v);
    if (_active) { try { _active.applyEdge(); } catch (e) { /* ignore */ } }
    return v;
  }

  function setQuality(q) {
    q = writeQuality(q);
    if (_active) { try { _active.applyQuality(); } catch (e) { /* ignore */ } }
    return q;
  }

  function setLightAdapt(on) {
    on = writeLightAdapt(on);
    if (_active) { try { _active.applyLightAdapt(); } catch (e) { /* ignore */ } }
    return on;
  }

  // --- the empty-room reference: the public half ----------------------------

  // 'off' (the setting is off), 'inactive' (on, but no camera effect is
  // running), or the running processor's 'none' / 'capturing' / 'ready' /
  // 'stale'.
  function referenceState() {
    if (!readReference()) return 'off';
    if (!_active) return 'inactive';
    return _active.referenceState();
  }

  // Re-read the preference and push it at whatever is running. Switching it
  // off FORGETS the picture, not just stops using it: an opt-in that keeps a
  // photo of your room after you opted out is not an opt-out. Called by the
  // main window's `storage` listener when the preferences window flips it.
  function refreshReference() {
    if (!readReference()) _plate = null;
    if (_active) { try { _active.applyReference(); } catch (e) { /* ignore */ } }
    else if (_onReference) { try { _onReference(referenceState()); } catch (e) { /* ignore */ } }
  }

  function setReference(on) {
    on = writeReference(on);
    refreshReference();
    return on;
  }

  function captureReference() {
    if (!_active) return Promise.resolve({ ok: false, reason: 'unavailable' });
    return _active.captureReference();
  }

  // Forget the picture, keeping the setting on.
  function clearReference() {
    _plate = null;
    if (_active) { _active.refLoaded = false; _active.syncReference(); }
    else if (_onReference) { try { _onReference(referenceState()); } catch (e) { /* ignore */ } }
  }

  function hasReference() { return !!_plate; }

  function onReferenceState(fn) { _onReference = fn; }

  function active() { return _active; }

  function onOverload(fn) { _onOverload = fn; }

  // --- the keyed stream: the public half ------------------------------------
  //
  // Sending. Every call names the stream: the published, processed stream
  // (main.js's localVideoStream), never an implicit `_active` — so the
  // settings preview, which also runs a Processor, can never grow a keyed
  // output by accident.

  function processorOf(stream) {
    var p = stream && stream._effectsProcessor;
    return (p && p instanceof Processor && !p.stopped) ? p : null;
  }

  // The keyed track, created on first ask, alive as long as the processor.
  function keyedTrack(stream) {
    var p = processorOf(stream);
    return p ? p.keyedOutput() : null;
  }

  function isKeyedTrack(track) {
    if (!track) return false;
    return _keyedTracks ? _keyedTracks.has(track) : track._voxalKeyed === true;
  }

  // How many senders are on the keyed track right now. 0 stops the keyed
  // pass and the copy entirely.
  function setKeyedDemand(stream, n) {
    var p = processorOf(stream);
    if (p) p.setKeyedDemand(n);
  }

  // null while there is no keyed output; else { scene, reason, size, look,
  // edgeE }. `scene` is non-null only while marked keyed frames are being
  // produced, and `reason` says why not otherwise.
  function keyedState(stream) {
    var p = processorOf(stream);
    return p ? p.keyedSnapshot() : null;
  }

  // Whether the keyed frames carry the tilt strip. main.js turns it on only
  // when its offer will say so and every peer that can be keyed reads it (and
  // the epoch changes with it, so nobody is on the keyed track meanwhile).
  function setKeyedTilt(stream, on) {
    var p = processorOf(stream);
    if (p && p.keyed) p.keyed.tilt = !!on;
  }

  function onKeyedState(fn) { _onKeyedState = fn; }

  function onPressure(fn) { _onPressure = fn; }

  // Receiving. Resolves with a handle once the scene is compiled and the
  // path has proved itself (see KeyInProcessor.start()); rejects otherwise,
  // with the context already released.
  function keyIn(remoteStream, offer, opts) {
    opts = opts || {};
    if (!remoteStream || typeof remoteStream.getVideoTracks !== 'function') {
      return Promise.reject(new Error('key-in needs a stream'));
    }
    var p;
    try { p = new KeyInProcessor(remoteStream, offer, opts.onGiveUp); } catch (e) { return Promise.reject(e); }
    _keyIns.push(p);
    return p.start().catch(function (err) {
      p.destroy();
      throw err;
    });
  }

  function keyInCount() { return _keyIns.length; }

  // Just the CPU half: is this peer's stream carrying keyed frames? For a
  // peer with no live key-in handle, so main.js can show a placeholder rather
  // than a green screen while keyed frames are still arriving. No GL at all.
  function keyProbe(remoteStream) {
    var video = hiddenVideo(remoteStream);
    var probe = new MarkerProbe(video);
    var stopped = false, held = false, rvfc = 0, timer = 0, gen = 0;
    // One callback in flight, and none while held, as Processor.pump() keeps it.
    function schedule() {
      if (stopped || held || rvfc || timer) return;
      if (video.requestVideoFrameCallback) rvfc = video.requestVideoFrameCallback(onFrame);
      else timer = setTimeout(onFrame, KEYIN_PROBE_MS);
    }
    function hold() {
      held = true;
      cancel();
    }
    function rearm() {
      held = false;
      schedule();
    }
    function cancel() {
      if (rvfc && video.cancelVideoFrameCallback) {
        try { video.cancelVideoFrameCallback(rvfc); } catch (e) { /* ignore */ }
      }
      if (timer) clearTimeout(timer);
      rvfc = timer = 0;
    }
    function onFrame() {
      rvfc = timer = 0;
      if (stopped) return;
      schedule();
      probe.tick(performance.now());
    }
    video.play().catch(function () { /* muted autoplay */ });
    schedule();
    return {
      lastKeyedAt: function () { return probe.lastKeyed; },
      lastUnkeyedAt: function () { return probe.lastUnkeyed; },
      setSource: function (remote) {
        if (stopped || !remote) return;
        var mine = ++gen;
        repointVideo(video, remote, hold, rearm, function () { return !stopped && gen === mine; });
      },
      destroy: function () {
        if (stopped) return;
        stopped = true;
        cancel();
        try { video.pause(); } catch (e) { /* ignore */ }
        video.srcObject = null;
      }
    };
  }

  // --- the picker -----------------------------------------------------------
  //
  // One definition of the chip row, rendered into the room's popover, the
  // in-page settings modal and the desktop preferences window alike. Anything
  // else means three copies drifting apart.

  function chip(cls, label, mode) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'bg-chip ' + cls;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', 'false');
    b.setAttribute('aria-label', label);
    b.title = label;
    b.dataset.mode = mode;
    return b;
  }

  // opts: { onPick(mode), allowCustom (default true) }
  function renderPicker(el, opts) {
    if (!el) return null;
    opts = opts || {};
    el.innerHTML = '';
    el.classList.add('bg-picker');
    el.setAttribute('role', 'radiogroup');
    el.setAttribute('aria-label', 'Background');

    var chips = [];

    var none = chip('bg-chip-none', 'No background effect', 'off');
    none.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/>' +
      '<line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/></svg>';
    chips.push(none);

    var blur = chip('bg-chip-blur', 'Blur my background', 'blur');
    blur.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 8h16"/><path d="M4 12h16"/>' +
      '<path d="M4 16h16"/></svg>';
    chips.push(blur);

    // The scenes. Each chip shows a gradient swatch at once and its real
    // thumbnail — rendered from the scene's own shader — once that is ready.
    var sceneChips = PRESETS.map(function (p) {
      var c = chip('bg-chip-image bg-chip-scene', p.label, 'preset:' + p.id);
      c.dataset.scene = p.id;
      c.style.backgroundImage = p.swatch;
      chips.push(c);
      return c;
    });
    // The thumbnails are rendered only once the row is actually on screen:
    // every page renders its pickers at load, inside a closed popover or a
    // settings card nobody has opened, and five shader compiles are not worth
    // paying for a picker that may never be seen.
    //
    // And not the instant the row appears either: the person who opened it is
    // reaching for a chip, and whatever the page does in the first moments is
    // work they will feel (a compile can take seconds where the GPU is soft).
    // The swatches are already there; the pictures replace them a beat later.
    var thumbsAsked = false;
    function paintThumbs() {
      if (thumbsAsked) return;
      thumbsAsked = true;
      setTimeout(function () {
        VideoScenes.thumbnails().then(function (thumbs) {
          sceneChips.forEach(function (c) {
            var url = thumbs[c.dataset.scene];
            if (url) c.style.backgroundImage = 'url("' + url + '")';
          });
        });
      }, THUMB_DELAY_MS);
    }
    if (typeof IntersectionObserver === 'function') {
      var io = new IntersectionObserver(function (entries) {
        if (entries.some(function (e) { return e.isIntersecting; })) {
          io.disconnect();
          paintThumbs();
        }
      });
      io.observe(el);
    } else {
      paintThumbs();
    }

    var custom = null, clearBtn = null, fileInput = null;
    if (opts.allowCustom !== false) {
      custom = chip('bg-chip-custom', 'Use my own image', 'custom');
      custom.innerHTML = '<span class="bg-chip-plus" aria-hidden="true">+</span>';
      chips.push(custom);

      clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'bg-chip-clear hidden';
      clearBtn.title = 'Remove my image';
      clearBtn.setAttribute('aria-label', 'Remove my image');
      clearBtn.textContent = '✕';

      fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*';
      // Visually hidden rather than display:none — WKWebView will not open a
      // picker for an input that is not rendered.
      fileInput.className = 'bg-file-input';
    }

    chips.forEach(function (c) {
      if (c !== custom) { el.appendChild(c); return; }
      // The clear badge is positioned against this wrapper, not the picker: in
      // the settings card the row is much wider than its chips, and anchoring
      // to the row would strand the ✕ at the far right.
      var wrap = document.createElement('span');
      wrap.className = 'bg-chip-wrap';
      wrap.appendChild(c);
      if (clearBtn) wrap.appendChild(clearBtn);
      el.appendChild(wrap);
    });
    if (fileInput) el.appendChild(fileInput);

    // Whether a custom image is stored, kept as a plain flag rather than read
    // from IndexedDB at click time. See the click handler: the read is async,
    // and an async hop before input.click() loses the user activation, which is
    // why the "+" chip silently did nothing on iOS and Android.
    var hasCustom = false;

    function paintCustom() {
      if (!custom) return Promise.resolve();
      return getCustomImage().then(function (blob) {
        hasCustom = !!blob;
        if (blob) {
          if (custom._url) URL.revokeObjectURL(custom._url);
          custom._url = URL.createObjectURL(blob);
          custom.style.backgroundImage = 'url("' + custom._url + '")';
          custom.classList.add('bg-chip-image');
          custom.innerHTML = '';
          if (clearBtn) clearBtn.classList.remove('hidden');
        } else {
          if (custom._url) { URL.revokeObjectURL(custom._url); custom._url = null; }
          custom.style.backgroundImage = '';
          custom.classList.remove('bg-chip-image');
          custom.innerHTML = '<span class="bg-chip-plus" aria-hidden="true">+</span>';
          if (clearBtn) clearBtn.classList.add('hidden');
        }
        return !!blob;
      });
    }

    function sync(mode) {
      mode = normalizeMode(mode === undefined ? readMode() : mode);
      chips.forEach(function (c) {
        var on = c.dataset.mode === mode;
        c.setAttribute('aria-checked', on ? 'true' : 'false');
        c.classList.toggle('is-active', on);
        c.tabIndex = on ? 0 : -1;
      });
      if (!chips.some(function (c) { return c.dataset.mode === mode; })) none.tabIndex = 0;
    }

    function pick(mode) {
      sync(mode);
      if (opts.onPick) opts.onPick(mode);
    }

    chips.forEach(function (c) {
      c.addEventListener('click', function () {
        var mode = c.dataset.mode;
        if (mode === 'custom' && !hasCustom) {
          // Synchronous, deliberately: a file picker only opens while the
          // browser still considers itself inside a user gesture, and even one
          // resolved promise in between is enough to lose that on WebKit.
          fileInput.click();
          return;
        }
        pick(mode);
      });
    });

    if (fileInput) {
      fileInput.addEventListener('change', function () {
        var file = fileInput.files && fileInput.files[0];
        fileInput.value = '';
        if (!file) return;
        custom.classList.add('is-busy');
        setCustomImage(file).then(function () {
          custom.classList.remove('is-busy');
          return paintCustom();
        }).then(function () {
          pick('custom');
        }).catch(function () {
          custom.classList.remove('is-busy');
          if (opts.onError) opts.onError('Could not use that image');
        });
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        hasCustom = false;
        clearCustomImage().then(paintCustom).then(function () {
          if (readMode() === 'custom') pick('blur');
        });
      });
    }

    paintCustom().then(function () { sync(); });

    return { sync: sync, refreshCustom: paintCustom, element: el };
  }

  // --- the sliders ----------------------------------------------------------
  //
  // One definition, rendered into the in-page settings modal and the desktop
  // preferences window alike — the same bargain renderPicker() strikes, for the
  // same reason. settings.html has no capture pipeline, so there they are
  // write-only: they store the value and the main window's `storage` listener
  // applies it.
  //
  // Blur strength and edge sharpness are the same control with different
  // arithmetic behind it, so they are built by the same function and styled by
  // the same rules. The class prefix differs so the two can be told apart in
  // CSS and in a test.
  function renderSlider(el, cfg) {
    if (!el) return null;
    el.innerHTML = '';
    el.classList.add(cfg.cls);

    var slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '1';
    slider.className = cfg.cls + '-slider';
    slider.setAttribute('aria-label', cfg.ariaLabel);

    var out = document.createElement('output');
    out.className = cfg.cls + '-value';

    var row = document.createElement('div');
    row.className = cfg.cls + '-row';
    row.appendChild(slider);
    row.appendChild(out);
    el.appendChild(row);

    function paint(v) {
      out.textContent = cfg.label(v);
      slider.setAttribute('aria-valuetext', cfg.label(v));
    }

    function sync(v) {
      v = (v === undefined || v === null) ? cfg.read() : cfg.clamp(v);
      slider.value = String(cfg.toSlider(v));
      paint(v);
    }

    slider.addEventListener('input', function () {
      var v = cfg.fromSlider(slider.value);
      paint(v);
      if (cfg.onChange) cfg.onChange(v);
      else cfg.apply(v);
    });

    sync();
    return { sync: sync, element: el, slider: slider };
  }

  function renderStrength(el, opts) {
    opts = opts || {};
    return renderSlider(el, {
      cls: 'blur-strength',
      ariaLabel: 'Background blur strength',
      read: readStrength,
      clamp: clampStrength,
      toSlider: sliderFromStrength,
      fromSlider: strengthFromSlider,
      label: strengthLabel,
      onChange: opts.onChange,
      apply: setStrength
    });
  }

  function renderSharpness(el, opts) {
    opts = opts || {};
    return renderSlider(el, {
      cls: 'edge-sharpness',
      ariaLabel: 'Cut-out edge sharpness',
      read: readSharpness,
      clamp: clampSharpness,
      toSlider: sliderFromSharpness,
      fromSlider: sharpnessFromSlider,
      label: sharpnessLabel,
      onChange: opts.onChange,
      apply: setSharpness
    });
  }

  // --- the accuracy picker --------------------------------------------------
  //
  // A segmented control rather than a slider: there are three rungs, they are
  // not a continuum, and each one is a different bargain between how well the
  // cut-out tracks a moving head and how much of the device it costs.
  function renderQuality(el, opts) {
    if (!el) return null;
    opts = opts || {};
    el.innerHTML = '';
    el.classList.add('fx-seg');
    el.setAttribute('role', 'radiogroup');
    el.setAttribute('aria-label', 'Detection accuracy');

    var buttons = QUALITIES.map(function (q) {
      var b = document.createElement('button');
      b.type = 'button';
      b.dataset.quality = q.id;
      b.textContent = q.label;
      b.title = q.hint;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      el.appendChild(b);
      return b;
    });

    function sync(q) {
      q = normalizeQuality(q === undefined ? readQuality() : q);
      buttons.forEach(function (b) {
        var on = b.dataset.quality === q;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      });
    }

    buttons.forEach(function (b) {
      b.addEventListener('click', function () {
        var q = b.dataset.quality;
        sync(q);
        if (opts.onChange) opts.onChange(q);
        else setQuality(q);
      });
    });

    sync();
    return { sync: sync, element: el, buttons: buttons };
  }

  // --- the low-light toggle -------------------------------------------------

  var _onBackgroundTilt = null;
  function onBackgroundTiltChange(fn) { _onBackgroundTilt = fn; }
  function setBackgroundTilt(on) {
    on = writeBackgroundTilt(on);
    if (_onBackgroundTilt) { try { _onBackgroundTilt(on); } catch (e) { /* ignore */ } }
    return on;
  }
  function renderBackgroundTilt(el, opts) {
    opts = opts || {};
    return renderToggle(el, {
      id: opts.id,
      label: opts.label || 'Move the background with my phone',
      title: opts.title,
      read: readBackgroundTilt,
      onChange: opts.onChange,
      apply: setBackgroundTilt
    });
  }

  function renderLightAdapt(el, opts) {
    opts = opts || {};
    return renderToggle(el, {
      id: opts.id,
      label: opts.label || 'Adapt the detector to low light',
      title: opts.title,
      read: readLightAdapt,
      onChange: opts.onChange,
      apply: setLightAdapt
    });
  }

  // --- the fixed-camera toggle ----------------------------------------------

  function renderReference(el, opts) {
    opts = opts || {};
    return renderToggle(el, {
      id: opts.id,
      label: opts.label || 'Fixed camera: compare with the empty room',
      title: opts.title,
      read: readReference,
      onChange: opts.onChange,
      apply: setReference
    });
  }

  // --- the keyed-stream toggle ----------------------------------------------

  function renderSubjectOnly(el, opts) {
    opts = opts || {};
    return renderToggle(el, {
      id: opts.id,
      label: opts.label || 'Let others draw my scene',
      title: opts.title,
      read: readSubjectOnly,
      onChange: opts.onChange,
      apply: setSubjectOnly
    });
  }

  // An ON/OFF switch over one boolean preference. cfg: { id, label, title,
  // read(), apply(on), onChange(on) } — onChange, when given, replaces apply
  // (settings.html stores and lets the main window apply).
  function renderToggle(el, opts) {
    if (!el) return null;
    el.innerHTML = '';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toggle-btn';
    btn.setAttribute('role', 'switch');
    // The id is what the row's <label for=...> points at, and the aria-label is
    // the fallback for a caller that renders no label of its own.
    if (opts.id) btn.id = opts.id;
    btn.setAttribute('aria-label', opts.label);
    if (opts.title) btn.title = opts.title;

    function sync(on) {
      on = (on === undefined) ? opts.read() : !!on;
      btn.textContent = on ? 'ON' : 'OFF';
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
      return on;
    }

    btn.addEventListener('click', function () {
      var on = !(btn.getAttribute('aria-checked') === 'true');
      sync(on);
      if (opts.onChange) opts.onChange(on);
      else opts.apply(on);
    });

    el.appendChild(btn);
    sync();
    return { sync: sync, element: el, button: btn };
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    STRENGTH_KEY: STRENGTH_KEY,
    STRENGTH_DEFAULT: STRENGTH_DEFAULT,
    SHARPNESS_KEY: SHARPNESS_KEY,
    SHARPNESS_DEFAULT: SHARPNESS_DEFAULT,
    QUALITY_KEY: QUALITY_KEY,
    QUALITY_DEFAULT: QUALITY_DEFAULT,
    QUALITIES: QUALITIES,
    LIGHT_ADAPT_KEY: LIGHT_ADAPT_KEY,
    REFERENCE_KEY: REFERENCE_KEY,
    PRESETS: PRESETS,
    SEG_LONG: SEG_LONG,
    segSizeFor: segSizeFor,
    isSupported: isSupported,
    normalizeMode: normalizeMode,
    readMode: readMode,
    writeMode: writeMode,
    warmup: warmup,
    onLoadProgress: onLoadProgress,
    // Test hook: drives the progress reporter without a 12 MB fetch.
    _reportForTest: report,
    // Test hook: the blur/feather kernel. A pass that does not sum to 1 dims
    // whatever it touches — that was the original "why is the blur grey".
    _gaussianHalfKernel: gaussianHalfKernel,
    // Test hook: the per-iteration strides, and the geometry they come from.
    _blurPlan: blurPlan,
    // Test hooks: the edge profile (pinned at its midpoint against the tuned
    // constants), the segmentation ladders, and the low-light response curve.
    _edgeProfile: edgeProfile,
    _segHzFor: segHzFor,
    _lightPlan: lightPlan,
    _lightConfig: {
      target: LIGHT_TARGET, maxGain: LIGHT_GAIN_MAX,
      sampleMs: LIGHT_SAMPLE_MS, smooth: LIGHT_SMOOTH
    },
    _edgeConfig: {
      dilate: MASK_DILATE, feather: MASK_FEATHER,
      lo: MASK_EDGE_LO, hi: MASK_EDGE_HI, def: SHARPNESS_DEFAULT
    },
    _blurConfig: {
      long: BLUR_LONG, sigma: BLUR_SIGMA, maxPasses: BLUR_PASSES_MAX,
      min: STRENGTH_MIN, max: STRENGTH_MAX, def: STRENGTH_DEFAULT
    },
    _runtimeBaseForTest: runtimeBase,
    // Test hook: the numbers the scenes' shadow and pacing are built from.
    _sceneConfig: {
      long: SCENE_LONG, hz: SCENE_HZ, softLong: SOFT_LONG,
      shadowReach: SHADOW_REACH, shadowAo: SHADOW_AO, lookSampleMs: LOOK_SAMPLE_MS
    },
    readStrength: readStrength,
    writeStrength: writeStrength,
    setStrength: setStrength,
    strengthFromSlider: strengthFromSlider,
    sliderFromStrength: sliderFromStrength,
    strengthLabel: strengthLabel,
    renderStrength: renderStrength,
    readSharpness: readSharpness,
    writeSharpness: writeSharpness,
    setSharpness: setSharpness,
    sharpnessFromSlider: sharpnessFromSlider,
    sliderFromSharpness: sliderFromSharpness,
    sharpnessLabel: sharpnessLabel,
    renderSharpness: renderSharpness,
    readQuality: readQuality,
    writeQuality: writeQuality,
    setQuality: setQuality,
    normalizeQuality: normalizeQuality,
    qualityLabel: qualityLabel,
    renderQuality: renderQuality,
    BACKGROUND_TILT_KEY: BACKGROUND_TILT_KEY,
    readBackgroundTilt: readBackgroundTilt,
    writeBackgroundTilt: writeBackgroundTilt,
    setBackgroundTilt: setBackgroundTilt,
    onBackgroundTiltChange: onBackgroundTiltChange,
    renderBackgroundTilt: renderBackgroundTilt,
    readLightAdapt: readLightAdapt,
    writeLightAdapt: writeLightAdapt,
    setLightAdapt: setLightAdapt,
    renderLightAdapt: renderLightAdapt,
    readReference: readReference,
    writeReference: writeReference,
    setReference: setReference,
    refreshReference: refreshReference,
    referenceState: referenceState,
    captureReference: captureReference,
    clearReference: clearReference,
    hasReference: hasReference,
    onReferenceState: onReferenceState,
    renderReference: renderReference,
    // Test hooks: the difference score both the shader and the probe use, and
    // the numbers the reference is judged by.
    _refScore: refScore,
    _refConfig: {
      long: REF_LONG, frames: REF_CAPTURE_FRAMES, presentMax: REF_PRESENT_MAX,
      staleBelow: REF_STALE_BELOW, freshAbove: REF_FRESH_ABOVE,
      matchMax: REF_MATCH_MAX, scoreLo: REF_SCORE_LO, scoreHi: REF_SCORE_HI
    },
    // The keyed stream ("let others draw my scene"): the setting, the
    // capability, the sending half and the receiving half.
    SUBJECT_ONLY_KEY: SUBJECT_ONLY_KEY,
    readSubjectOnly: readSubjectOnly,
    writeSubjectOnly: writeSubjectOnly,
    onSubjectOnlyChange: onSubjectOnlyChange,
    setSubjectOnly: setSubjectOnly,
    renderSubjectOnly: renderSubjectOnly,
    KEYED_CAP: KEYED_CAP,
    canKeyIn: canKeyIn,
    keyedTrack: keyedTrack,
    setKeyedTilt: setKeyedTilt,
    setTilt: setTilt,
    getTilt: getTilt,
    encodeTilt: encodeTilt,
    decodeTilt: decodeTilt,
    KEY_TILT: KEY_TILT,
    isKeyedTrack: isKeyedTrack,
    setKeyedDemand: setKeyedDemand,
    keyedState: keyedState,
    onKeyedState: onKeyedState,
    onPressure: onPressure,
    keyIn: keyIn,
    keyProbe: keyProbe,
    keyInCount: keyInCount,
    KEY_COLOR: KEY_COLOR,
    KEY_MARKER: KEY_MARKER,
    KEY_ALPHA_FLOOR: KEY_ALPHA_FLOOR,
    cancelLoad: cancelLoad,
    isLoading: isLoading,
    isLoaded: isLoaded,
    isAbort: isAbort,
    wrap: wrap,
    setMode: setMode,
    setSource: setSource,
    setPaused: setPaused,
    stop: stop,
    active: active,
    onOverload: onOverload,
    renderPicker: renderPicker,
    getCustomImage: getCustomImage,
    setCustomImage: setCustomImage,
    clearCustomImage: clearCustomImage
  };
})();
