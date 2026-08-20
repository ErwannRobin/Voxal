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
//   * the blur is a downsample to a quarter resolution plus two separable
//     9-tap passes — about 3 draws on a small buffer, versus 16× the work and a
//     worse-looking result at full resolution;
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

  // The landscape selfie model's input. Segmenting at the capture resolution
  // would cost an order of magnitude more for a mask nobody can tell apart.
  var SEG_W = 256, SEG_H = 144;

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
  // are always same-origin. The ~12 MB MediaPipe runtime is NOT bundled: on the
  // web it is served from our own origin (which the COEP require-corp header
  // already covers); on Tauri and Capacitor it is fetched from voxal.app, or
  // from whatever a self-hoster set as `service-url`.

  function isNative() {
    if (window.__TAURI__) return true;
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  }

  function runtimeBase() {
    if (!isNative()) return ASSET_DIR;
    var base;
    try { base = localStorage.getItem(SERVICE_URL_KEY) || DEFAULT_SERVICE_URL; }
    catch (e) { base = DEFAULT_SERVICE_URL; }
    return String(base).replace(/\/+$/, '') + '/' + ASSET_DIR;
  }

  // import() needs a real URL: 'assets/seg/x.mjs' is a *bare* specifier and
  // would throw, where './assets/seg/x.mjs' or an absolute URL resolves.
  function absolute(url) {
    try { return new URL(url, document.baseURI).href; } catch (e) { return url; }
  }

  function modelUrl() { return ASSET_DIR + MODEL_FILE; }

  // Best-effort offline cache for the one asset big enough to be worth it.
  // There is no service worker, so a CacheStorage entry only helps if we hand
  // MediaPipe a blob: URL made from it. Any failure falls back to the plain URL
  // and the HTTP cache, which the immutable Cache-Control header already makes
  // effective for repeat launches.
  function cachedBinaryUrl(url) {
    // Same-origin web is already served with an immutable Cache-Control, so the
    // HTTP cache does this job without holding a 12 MB blob in memory.
    if (!isNative() || !window.caches) return Promise.resolve(url);
    return caches.open(CACHE_NAME).then(function (cache) {
      return cache.match(url).then(function (hit) {
        if (hit) return hit;
        return cache.add(url).then(function () { return cache.match(url); });
      }).then(function (res) {
        if (!res) return url;
        return res.blob().then(function (blob) { return URL.createObjectURL(blob); });
      });
    }).catch(function () { return url; });
  }

  // --- MediaPipe loading ----------------------------------------------------

  var _runtime = null;   // Promise<{ ImageSegmenter, fileset }>

  function loadRuntime() {
    if (_runtime) return _runtime;
    var base = runtimeBase();
    // Dynamic import is legal from a classic script and keeps the ~12 MB
    // runtime off the critical path — nothing is fetched until the user
    // actually turns an effect on.
    _runtime = Promise.all([
      import(absolute(base + BUNDLE_FILE)),
      cachedBinaryUrl(absolute(base + WASM_BINARY))
    ]).then(function (r) {
      return {
        ImageSegmenter: r[0].ImageSegmenter,
        fileset: { wasmLoaderPath: absolute(base + WASM_LOADER), wasmBinaryPath: r[1] }
      };
    }).catch(function (err) {
      _runtime = null;   // let a later attempt retry rather than latch a failure
      throw err;
    });
    return _runtime;
  }

  // Tests drive the whole pipeline — the GL passes, the track swaps, the
  // teardown — but cannot run MediaPipe: the ~12 MB runtime is staged by the
  // build and headless GPU inference is not something to hang a deterministic
  // suite on. `window.__voxalSegStub` swaps inference for a fixed mask and
  // leaves everything else real, the same bargain unit-rnnoise-worklet.spec.js
  // strikes for the audio worklet.
  function stubSegmenter() {
    var stub = window.__voxalSegStub;
    if (stub && stub.fail) return Promise.reject(new Error('stubbed segmenter failure'));
    var data = new Uint8Array(SEG_W * SEG_H);
    for (var y = 0; y < SEG_H; y++) {
      for (var x = 0; x < SEG_W; x++) {
        // A centred oval stands in for a person.
        var dx = (x - SEG_W / 2) / (SEG_W * 0.22);
        var dy = (y - SEG_H * 0.6) / (SEG_H * 0.45);
        data[y * SEG_W + x] = (dx * dx + dy * dy) < 1 ? 255 : 0;
      }
    }
    var mask = {
      width: SEG_W, height: SEG_H,
      getAsUint8Array: function () { return data; }
    };
    return Promise.resolve({
      close: function () {},
      segmentForVideo: function (frame, ts, cb) {
        window.__voxalSegCalls = (window.__voxalSegCalls || 0) + 1;
        cb({ confidenceMasks: [mask, mask] });
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
      segCanvas.width = SEG_W; segCanvas.height = SEG_H;
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

  var FRAG_COPY = [
    '#version 300 es',
    'precision mediump float;',
    'in vec2 vUv;',
    'uniform sampler2D uTex;',
    'out vec4 outColor;',
    'void main() { outColor = texture(uTex, vUv); }'
  ].join('\n');

  // Separable 9-tap Gaussian. uDir is the per-tap step in UV space, so the same
  // program serves the horizontal pass, the vertical pass, the quarter-res
  // background blur and the mask feather.
  var FRAG_BLUR = [
    '#version 300 es',
    'precision mediump float;',
    'in vec2 vUv;',
    'uniform sampler2D uTex;',
    'uniform vec2 uDir;',
    'out vec4 outColor;',
    'const float w0 = 0.1621622;',
    'const float w1 = 0.1459459;',
    'const float w2 = 0.1216216;',
    'const float w3 = 0.0540541;',
    'const float w4 = 0.0162162;',
    'void main() {',
    '  vec4 sum = texture(uTex, vUv) * w0;',
    '  sum += (texture(uTex, vUv + uDir * 1.0) + texture(uTex, vUv - uDir * 1.0)) * w1;',
    '  sum += (texture(uTex, vUv + uDir * 2.0) + texture(uTex, vUv - uDir * 2.0)) * w2;',
    '  sum += (texture(uTex, vUv + uDir * 3.0) + texture(uTex, vUv - uDir * 3.0)) * w3;',
    '  sum += (texture(uTex, vUv + uDir * 4.0) + texture(uTex, vUv - uDir * 4.0)) * w4;',
    '  outColor = sum;',
    '}'
  ].join('\n');

  // Temporal smoothing. Blending each new mask into the previous one is what
  // stops the edge crawling between frames, and is also why dropping to 10 Hz
  // segmentation does not read as stutter.
  var FRAG_MASK_MIX = [
    '#version 300 es',
    'precision mediump float;',
    'in vec2 vUv;',
    'uniform sampler2D uPrev;',
    'uniform sampler2D uNext;',
    'uniform float uAlpha;',
    'out vec4 outColor;',
    'void main() {',
    '  float p = texture(uPrev, vUv).r;',
    '  float n = texture(uNext, vUv).r;',
    '  outColor = vec4(mix(p, n, uAlpha), 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  // uBgXform packs a cover-fit for the background image: xy scale, zw offset.
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
    '  float m = smoothstep(0.35, 0.65, texture(uMask, flip).r);',
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

    this.pCopy = program(gl, FRAG_COPY);
    this.pBlur = program(gl, FRAG_BLUR);
    this.pMix  = program(gl, FRAG_MASK_MIX);
    this.pComp = program(gl, FRAG_COMPOSITE);

    this.texCam = texture(gl, 1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    this.texImg = texture(gl, 1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);

    // Quarter resolution for the background blur: a 9-tap pass here is worth
    // roughly a 36-tap pass at full size, for a sixteenth of the fill rate.
    var bw = Math.max(1, Math.floor(size.w / 4));
    var bh = Math.max(1, Math.floor(size.h / 4));
    this.blurW = bw; this.blurH = bh;
    this.texBlurA = texture(gl, bw, bh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    this.texBlurB = texture(gl, bw, bh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    this.fbBlurA = framebuffer(gl, this.texBlurA);
    this.fbBlurB = framebuffer(gl, this.texBlurB);

    this.texMaskRaw = texture(gl, SEG_W, SEG_H, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    this.texMaskA = texture(gl, SEG_W, SEG_H, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    this.texMaskB = texture(gl, SEG_W, SEG_H, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
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
      this.segmenter.segmentForVideo(this.video, ts, function (result) {
        var masks = result && result.confidenceMasks;
        // Category 1 is the person; 0 is the background.
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
    gl.bindTexture(gl.TEXTURE_2D, this.texMaskRaw);
    if (w !== SEG_W || h !== SEG_H) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SEG_W, SEG_H, gl.RED, gl.UNSIGNED_BYTE, data);
    }

    // texMaskA holds the smoothed mask. The very first mask is taken whole,
    // otherwise the first second of video fades in from an empty matte.
    var alpha = this.maskPrimed ? 0.5 : 1.0;
    gl.useProgram(this.pMix);
    this.bindTex(this.pMix, 'uPrev', 0, this.texMaskA);
    this.bindTex(this.pMix, 'uNext', 1, this.texMaskRaw);
    gl.uniform1f(uloc(gl, this.pMix, 'uAlpha'), alpha);
    this.drawQuad(this.fbMaskB, SEG_W, SEG_H);

    // Feather: blur the smoothed mask so the composite's smoothstep has a real
    // gradient to work with instead of the model's hard 256×144 staircase.
    gl.useProgram(this.pBlur);
    this.bindTex(this.pBlur, 'uTex', 0, this.texMaskB);
    gl.uniform2f(uloc(gl, this.pBlur, 'uDir'), 1 / SEG_W, 0);
    this.drawQuad(this.fbMaskA, SEG_W, SEG_H);

    this.bindTex(this.pBlur, 'uTex', 0, this.texMaskA);
    gl.uniform2f(uloc(gl, this.pBlur, 'uDir'), 0, 1 / SEG_H);
    this.drawQuad(this.fbMaskB, SEG_W, SEG_H);

    // Swap so texMaskA is always the current, feathered mask.
    var t = this.texMaskA, f = this.fbMaskA;
    this.texMaskA = this.texMaskB; this.fbMaskA = this.fbMaskB;
    this.texMaskB = t; this.fbMaskB = f;
    this.maskPrimed = true;
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
      // Downsample to a quarter, then two separable passes at that size.
      gl.useProgram(this.pCopy);
      this.bindTex(this.pCopy, 'uTex', 0, this.texCam);
      this.drawQuad(this.fbBlurA, this.blurW, this.blurH);

      gl.useProgram(this.pBlur);
      this.bindTex(this.pBlur, 'uTex', 0, this.texBlurA);
      gl.uniform2f(uloc(gl, this.pBlur, 'uDir'), 1.5 / this.blurW, 0);
      this.drawQuad(this.fbBlurB, this.blurW, this.blurH);

      this.bindTex(this.pBlur, 'uTex', 0, this.texBlurB);
      gl.uniform2f(uloc(gl, this.pBlur, 'uDir'), 0, 1.5 / this.blurH);
      this.drawQuad(this.fbBlurA, this.blurW, this.blurH);
    }

    gl.useProgram(this.pComp);
    this.bindTex(this.pComp, 'uSharp', 0, this.texCam);
    this.bindTex(this.pComp, 'uBlur', 1, this.texBlurA);
    this.bindTex(this.pComp, 'uImage', 2, this.texImg);
    this.bindTex(this.pComp, 'uMask', 3, this.texMaskA);
    gl.uniform1f(uloc(gl, this.pComp, 'uUseImage'), useImage ? 1 : 0);
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
    [this.pCopy, this.pBlur, this.pMix, this.pComp].forEach(function (p) {
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
      fileInput.className = 'hidden';
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

    function paintCustom() {
      if (!custom) return Promise.resolve();
      return getCustomImage().then(function (blob) {
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
        if (mode === 'custom') {
          getCustomImage().then(function (blob) {
            if (blob) pick('custom');
            else fileInput.click();
          });
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
    SEG_SIZE: { width: SEG_W, height: SEG_H },
    isSupported: isSupported,
    normalizeMode: normalizeMode,
    readMode: readMode,
    writeMode: writeMode,
    warmup: warmup,
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
