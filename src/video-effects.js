// video-effects.js — background blur and virtual backgrounds for the camera.
//
// Loaded as a plain classic script by BOTH index.html and settings.html, the
// way net-usage.js is, so the two documents share one definition of the modes,
// the presets and the chip picker instead of hand-duplicating them. It must
// load *before* main.js.
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
//   * the blur is a box downsample to a fixed 240-long buffer plus two H+V
//     iterations of a separable 9-tap Gaussian — 5 draws on a small buffer,
//     versus many times the work and a worse-looking result at full
//     resolution. It runs in linear light, which is what keeps it from going
//     grey;
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
  var SERVICE_URL_KEY = 'service-url';       // same key presenceBase() reads
  var DEFAULT_SERVICE_URL = 'https://voxal.app';

  var CACHE_NAME  = 'voxal-seg-v1';
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

  // The background blur runs at a FIXED size rather than at a fraction of the
  // capture resolution, so a 1080p camera and a 720p one get the same-looking
  // blur (and cost the same to blur). BLUR_STEP is the per-tap stride in that
  // buffer; two H+V iterations of the 9-tap kernel below give an effective
  // sigma of about 6 texels — roughly 2.5% of the frame width, which is the
  // range a real lens would defocus a room behind someone at.
  var BLUR_LONG  = 240;
  var BLUR_STEP  = 2.5;
  var BLUR_SIGMA = 1.75;   // sigma of one 9-tap pass, in taps

  // Temporal blend weights, per inference. Growing is nearly immediate so the
  // mask keeps up with a moving head; shrinking takes several inferences, which
  // is what stops the model's frame-to-frame noise turning into a boiling edge.
  var MASK_ALPHA_UP   = 0.85;
  var MASK_ALPHA_DOWN = 0.20;

  // Segmentation rates, in Hz, stepped down under load in this order.
  var SEG_HZ_DESKTOP = [15, 10, 6];
  var SEG_HZ_MOBILE  = [10, 6];

  var PRESETS = [
    { id: 'aurora', label: 'Aurora', src: 'assets/backgrounds/aurora.webp' },
    { id: 'dusk',   label: 'Dusk',   src: 'assets/backgrounds/dusk.webp' },
    { id: 'studio', label: 'Studio', src: 'assets/backgrounds/studio.webp' },
    { id: 'linen',  label: 'Linen',  src: 'assets/backgrounds/linen.webp' }
  ];

  var IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');

  // --- mode: read, write, normalise ----------------------------------------

  function normalizeMode(mode) {
    if (!mode || mode === 'off') return 'off';
    if (mode === 'blur' || mode === 'custom') return mode;
    if (String(mode).indexOf('preset:') === 0) {
      var id = String(mode).slice(7);
      for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return mode;
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

  function presetById(id) {
    for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i];
    return null;
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
  // src/, which is ptt.voxal.app. It is NOT presenceBase()/`service-url` —
  // that is the presence API, which defaults to a Supabase edge function and
  // has never served static assets. Getting this wrong is silent on the web and
  // breaks the whole feature on the desktop and mobile apps.

  var DEFAULT_SEG_BASE = 'https://ptt.voxal.app/' + ASSET_DIR;
  var SEG_BASE_KEY = 'seg-assets-url';

  function isTauri() { return !!window.__TAURI__; }

  function isCapacitor() {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  }

  function isNative() { return isTauri() || isCapacitor(); }

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
      import(absolute(base + BUNDLE_FILE)),
      runtimeBinaryUrl(absolute(base + WASM_BINARY), ctl && ctl.signal)
    ]).then(function (r) {
      _loadAbort = null;
      report('ready', 1, 1);
      return {
        ImageSegmenter: r[0].ImageSegmenter,
        fileset: { wasmLoaderPath: absolute(base + WASM_LOADER), wasmBinaryPath: r[1] }
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
  var FRAG_DILATE = [
    '#version 300 es',
    'precision mediump float;',
    'in vec2 vUv;',
    'uniform sampler2D uTex;',
    'uniform vec2 uDir;',
    'out vec4 outColor;',
    'void main() {',
    '  float m = texture(uTex, vUv).r;',
    '  m = max(m, texture(uTex, vUv + uDir).r);',
    '  m = max(m, texture(uTex, vUv - uDir).r);',
    '  outColor = vec4(m, 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

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

  // uBgXform packs a cover-fit for the background image: xy scale, zw offset.
  // uEdge packs the smoothstep window the feathered mask is mapped through.
  var FRAG_COMPOSITE = [
    '#version 300 es',
    'precision mediump float;',
    'in vec2 vUv;',
    'uniform sampler2D uSharp;',
    'uniform sampler2D uBlur;',
    'uniform sampler2D uImage;',
    'uniform sampler2D uMask;',
    'uniform float uUseImage;',
    'uniform vec4 uBgXform;',
    'uniform vec2 uEdge;',
    'out vec4 outColor;',
    'void main() {',
    '  vec2 flip = vec2(vUv.x, 1.0 - vUv.y);',
    '  vec3 sharp = texture(uSharp, flip).rgb;',
    '  vec3 bg;',
    '  if (uUseImage > 0.5) {',
    '    vec2 uv = clamp(flip * uBgXform.xy + uBgXform.zw, 0.0, 1.0);',
    '    bg = texture(uImage, uv).rgb;',
    '  } else {',
    '    bg = texture(uBlur, flip).rgb;',
    '  }',
    // Wide, and biased low on purpose. Wide because a narrow window turns the
    // feather back into the hard cutout it was meant to soften — it maps almost
    // the whole gradient to 0 or 1 and keeps only a sliver as a transition.
    // Biased low because the confidence mask is not a clean 0/1 field: it falls
    // off gradually at the subject, and a window centred on 0.5 cuts inside the
    // face rather than outside it. Better to keep a sliver of background sharp
    // than to blur somebody's ear off. See MASK_EDGE_LO / MASK_EDGE_HI.
    '  float m = smoothstep(uEdge.x, uEdge.y, texture(uMask, flip).r);',
    '  outColor = vec4(mix(bg, sharp, m), 1.0);',
    '}'
  ].join('\n');

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

  // --- the processor --------------------------------------------------------

  var _active = null;      // at most one camera pipeline at a time
  var _onOverload = null;  // set by main.js; called when we give up on a device

  function Processor(rawStream, mode) {
    this.raw = rawStream;
    this.mode = normalizeMode(mode);
    this.paused = false;
    this.stopped = false;

    this.segmenter = null;
    this.segHzSteps = IS_MOBILE ? SEG_HZ_MOBILE : SEG_HZ_DESKTOP;
    this.segStep = 0;
    this.segInterval = 1000 / this.segHzSteps[0];
    this.lastSeg = 0;
    this.lastTs = -1;

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

    var gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      desynchronized: true,
      preserveDrawingBuffer: false
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;

    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.pDown = program(gl, FRAG_DOWNSAMPLE);
    this.pBlur = program(gl, FRAG_BLUR);
    this.pFeather = program(gl, FRAG_FEATHER);
    this.pMix  = program(gl, FRAG_MASK_MIX);
    this.pDilate = program(gl, FRAG_DILATE);
    this.pComp = program(gl, FRAG_COMPOSITE);

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

    this.texMaskRaw = texture(gl, this.segW, this.segH, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    this.texMaskA = texture(gl, this.segW, this.segH, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    this.texMaskB = texture(gl, this.segW, this.segH, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    this.fbMaskA = framebuffer(gl, this.texMaskA);
    this.fbMaskB = framebuffer(gl, this.texMaskB);
    this.maskPrimed = false;

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

  // --- background source ----------------------------------------------------

  Processor.prototype.applyBackground = function (mode) {
    var self = this;
    this.mode = normalizeMode(mode);
    if (this.mode === 'blur' || this.mode === 'off') {
      this.bgReady = false;
      return Promise.resolve();
    }
    var load;
    if (this.mode === 'custom') {
      load = getCustomImage().then(function (blob) {
        if (!blob) throw new Error('no custom background stored');
        return loadBitmap(blob);
      });
    } else {
      var preset = presetById(this.mode.slice(7));
      if (!preset) { this.bgReady = false; return Promise.resolve(); }
      load = loadBitmap(preset.src);
    }
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

  Processor.prototype.pump = function () {
    if (this.stopped) return;
    var self = this;
    if (this.video.requestVideoFrameCallback) {
      this._rvfc = this.video.requestVideoFrameCallback(function () { self.onFrame(); });
    } else {
      this._raf = requestAnimationFrame(function () { self.onFrame(); });
    }
  };

  Processor.prototype.onFrame = function () {
    if (this.stopped) return;
    this.pump();                                  // schedule the next one first
    if (this.paused || document.hidden ||
        !this.gl || this.video.readyState < 2 || !this.video.videoWidth) {
      // Restart the measurement window. Carrying it across a pause would
      // measure a handful of frames over minutes of wall clock and step the
      // effect down — or off — for no reason at all.
      this.frames = 0;
      this.windowStart = 0;
      return;
    }

    var now = performance.now();
    if (this.segmenter && (now - this.lastSeg) >= this.segInterval) {
      this.lastSeg = now;
      this.runSegment(now);
    }
    this.draw();
    if (this.manualFrames && this.track && this.track.requestFrame) {
      try { this.track.requestFrame(); } catch (e) { /* track ended */ }
    }
    this.measure(now);
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
      this.segCtx.drawImage(this.video, 0, 0, this.segW, this.segH);
      this.segmenter.segmentForVideo(this.segCanvas, ts, function (result) {
        var masks = result && result.confidenceMasks;
        // The selfie model publishes a single confidence mask ("selfie"); other
        // segmenters put the person at index 1 behind the background.
        var mask = masks && (masks.length > 1 ? masks[1] : masks[0]);
        if (!mask) return;
        try { self.uploadMask(mask.getAsUint8Array(), mask.width, mask.height); }
        catch (e) { /* the mask's lifetime ends with this callback */ }
      });
    } catch (e) {
      // A single failed inference must not take the call's video with it.
      this.segFailures = (this.segFailures || 0) + 1;
      if (this.segFailures > 30) this.giveUp('segmentation kept failing');
    }
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

    // texMaskA holds the smoothed mask. The very first mask is taken whole,
    // otherwise the first second of video fades in from an empty matte.
    gl.useProgram(this.pMix);
    this.bindTex(this.pMix, 'uPrev', 0, this.texMaskA);
    this.bindTex(this.pMix, 'uNext', 1, this.texMaskRaw);
    gl.uniform1f(uloc(gl, this.pMix, 'uAlphaUp'), this.maskPrimed ? MASK_ALPHA_UP : 1.0);
    gl.uniform1f(uloc(gl, this.pMix, 'uAlphaDown'), this.maskPrimed ? MASK_ALPHA_DOWN : 1.0);
    this.drawQuad(this.fbMaskB, W, H);

    // Dilate before feathering. Everything downstream shrinks the subject a
    // little — the feather blur, the smoothstep, and the mask's own lag behind
    // a moving frame — so expand it first and let those take the slack back.
    // Separable, like the blur: two passes of a 3-tap max.
    gl.useProgram(this.pDilate);
    this.bindTex(this.pDilate, 'uTex', 0, this.texMaskB);
    gl.uniform2f(uloc(gl, this.pDilate, 'uDir'), MASK_DILATE / W, 0);
    this.drawQuad(this.fbMaskA, W, H);

    this.bindTex(this.pDilate, 'uTex', 0, this.texMaskA);
    gl.uniform2f(uloc(gl, this.pDilate, 'uDir'), 0, MASK_DILATE / H);
    this.drawQuad(this.fbMaskB, W, H);

    // Feather: blur the dilated mask so the composite's smoothstep has a real
    // gradient to work with instead of the model's staircase. Its own program
    // rather than the background's — coverage is not light, so this one must
    // NOT be gamma-corrected, or the ramp would be bent and the edge would land
    // somewhere other than where MASK_DILATE put it.
    gl.useProgram(this.pFeather);
    this.bindTex(this.pFeather, 'uTex', 0, this.texMaskB);
    gl.uniform2f(uloc(gl, this.pFeather, 'uDir'), MASK_FEATHER / W, 0);
    this.drawQuad(this.fbMaskA, W, H);

    this.bindTex(this.pFeather, 'uTex', 0, this.texMaskA);
    gl.uniform2f(uloc(gl, this.pFeather, 'uDir'), 0, MASK_FEATHER / H);
    this.drawQuad(this.fbMaskB, W, H);

    // Swap so texMaskA is always the current, feathered mask.
    var t = this.texMaskA, f = this.fbMaskA;
    this.texMaskA = this.texMaskB; this.fbMaskA = this.fbMaskB;
    this.texMaskB = t; this.fbMaskB = f;
    this.maskPrimed = true;
  };

  // Re-allocate just the mask ping-pong for a new mask shape, leaving the
  // camera and blur buffers alone.
  Processor.prototype.resizeMaskBuffers = function (w, h) {
    var gl = this.gl;
    [this.texMaskA, this.texMaskB].forEach(function (t) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    });
    this.maskPrimed = false;
    if (this.segCanvas) { this.segCanvas.width = w; this.segCanvas.height = h; }
  };

  Processor.prototype.draw = function () {
    var gl = this.gl;
    var w = this.canvas.width, h = this.canvas.height;

    gl.bindTexture(gl.TEXTURE_2D, this.texCam);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
    } catch (e) {
      return;   // the source can vanish mid-teardown
    }

    var useImage = this.bgReady && this.mode !== 'blur';
    if (!useImage) {
      // Box downsample into the blur buffer, then two H+V iterations at that
      // size. Two iterations rather than one: successive Gaussians add
      // variances, so this reaches sigma ~6 texels without stretching a 9-tap
      // kernel far enough apart to show its individual taps as ghosts.
      gl.useProgram(this.pDown);
      this.bindTex(this.pDown, 'uTex', 0, this.texCam);
      gl.uniform2f(uloc(gl, this.pDown, 'uOff'), 0.25 / this.blurW, 0.25 / this.blurH);
      this.drawQuad(this.fbBlurA, this.blurW, this.blurH);

      gl.useProgram(this.pBlur);
      for (var pass = 0; pass < 2; pass++) {
        this.bindTex(this.pBlur, 'uTex', 0, this.texBlurA);
        gl.uniform2f(uloc(gl, this.pBlur, 'uDir'), BLUR_STEP / this.blurW, 0);
        this.drawQuad(this.fbBlurB, this.blurW, this.blurH);

        this.bindTex(this.pBlur, 'uTex', 0, this.texBlurB);
        gl.uniform2f(uloc(gl, this.pBlur, 'uDir'), 0, BLUR_STEP / this.blurH);
        this.drawQuad(this.fbBlurA, this.blurW, this.blurH);
      }
    }

    gl.useProgram(this.pComp);
    this.bindTex(this.pComp, 'uSharp', 0, this.texCam);
    this.bindTex(this.pComp, 'uBlur', 1, this.texBlurA);
    this.bindTex(this.pComp, 'uImage', 2, this.texImg);
    this.bindTex(this.pComp, 'uMask', 3, this.texMaskA);
    gl.uniform1f(uloc(gl, this.pComp, 'uUseImage'), useImage ? 1 : 0);
    gl.uniform2f(uloc(gl, this.pComp, 'uEdge'), MASK_EDGE_LO, MASK_EDGE_HI);
    var x = this.bgXform();
    gl.uniform4f(uloc(gl, this.pComp, 'uBgXform'), x[0], x[1], x[2], x[3]);
    this.drawQuad(null, w, h);
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
    this.video.srcObject = rawStream;
    if (this.stream) this.stream._effectsOriginal = rawStream;
    var self = this;
    return this.video.play().catch(function () { /* ignore */ }).then(function () {
      var size = self.sizeFromTrack();
      if (!self.gl || (size.w === self.canvas.width && size.h === self.canvas.height)) return;
      // A different capture size needs new buffers; rebuilding the whole GL
      // state is simpler and rarer than resizing every attachment in place.
      self.releaseGL();
      self.initGL();
      self.applyBackground(self.mode);
    });
  };

  Processor.prototype.setPaused = function (paused) {
    this.paused = !!paused;
  };

  Processor.prototype.releaseGL = function () {
    var gl = this.gl;
    if (!gl) return;
    [this.texCam, this.texImg, this.texBlurA, this.texBlurB,
     this.texMaskRaw, this.texMaskA, this.texMaskB].forEach(function (t) {
      if (t) try { gl.deleteTexture(t); } catch (e) { /* ignore */ }
    });
    [this.fbBlurA, this.fbBlurB, this.fbMaskA, this.fbMaskB].forEach(function (f) {
      if (f) try { gl.deleteFramebuffer(f); } catch (e) { /* ignore */ }
    });
    [this.pDown, this.pBlur, this.pFeather, this.pMix, this.pDilate, this.pComp].forEach(function (p) {
      if (p) try { gl.deleteProgram(p); } catch (e) { /* ignore */ }
    });
    if (this.quad) try { gl.deleteBuffer(this.quad); } catch (e) { /* ignore */ }
    if (this.vao) try { gl.deleteVertexArray(this.vao); } catch (e) { /* ignore */ }
    this.gl = null;
  };

  Processor.prototype.destroy = function () {
    if (this.stopped) return;
    this.stopped = true;
    if (this._rvfc && this.video.cancelVideoFrameCallback) {
      try { this.video.cancelVideoFrameCallback(this._rvfc); } catch (e) { /* ignore */ }
    }
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this.segmenter) { try { this.segmenter.close(); } catch (e) { /* ignore */ } this.segmenter = null; }
    this.releaseGL();
    try { this.video.pause(); } catch (e) { /* ignore */ }
    this.video.srcObject = null;
    if (this.stream) {
      this.stream._effectsOriginal = null;
      this.stream._effectsProcessor = null;
    }
    if (_active === this) _active = null;
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

  function active() { return _active; }

  function onOverload(fn) { _onOverload = fn; }

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

    PRESETS.forEach(function (p) {
      var c = chip('bg-chip-image', p.label, 'preset:' + p.id);
      c.style.backgroundImage = 'url("' + p.src + '")';
      chips.push(c);
    });

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

  return {
    STORAGE_KEY: STORAGE_KEY,
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
    _runtimeBaseForTest: runtimeBase,
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
