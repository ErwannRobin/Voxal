// P3M-Net as a segmentation engine — EXPERIMENTAL, for the P3M-Net evaluation
// (docs/p3m-evaluation.md).
//
// Off unless localStorage['segmentation-engine'] is 'p3m' (or ?segengine=p3m).
// Nothing here loads, runs or downloads otherwise. The model is not in the
// repository: `make p3m-assets` converts the official checkpoint to ONNX and
// stages it, with the ONNX Runtime Web build that runs it, into the gitignored
// src/assets/p3m/. P3M-Net is MIT (code and weights) — it is kept out of the
// repository and the builds for its size (78 MB at the smallest), not its
// licence. Without the files create() rejects and video-effects.js falls back
// to MediaPipe, exactly as for an RVM or a Longpipe that cannot start.
//
// P3M-Net (https://github.com/JizhiziLi/P3M, ACM MM 2021) is an IMAGE matting
// network — no recurrent state, each frame on its own: a ResNet-34 encoder, a
// global decoder for a background / transition / foreground trimap and a local
// decoder for the alpha in the transition band, fused into one alpha matte.
// scripts/p3m-export.py folds the fusion and the ImageNet normalisation into
// the graph, so the model takes RGB 0-1 (NCHW, sides multiples of 32) and
// returns `pha`, the alpha, at the same size.
//
// The adapter is shaped like MediaPipe's ImageSegmenter (segmentForVideo /
// close / getLabels), like rvm-engine.js, so the Processor treats it like the
// others. Inference is asynchronous: segmentForVideo() starts one on the
// current frame when none is running and hands back the newest finished matte,
// so the matte trails the picture by about one inference.
var P3mEngine = (function () {
  'use strict';

  var ENGINE_KEY = 'segmentation-engine';  // shared with Longpipe / RVM: 'p3m' selects this one
  var BASE_KEY = 'p3m-assets-url';         // where ort.*.mjs and the .onnx files are (default ./assets/p3m/)
  var MODEL_KEY = 'p3m-model';             // w16 (default) | fp32 | fp16
  var EP_KEY = 'p3m-ep';                   // webgpu (default) | wasm (only when asked for: see open())
  var SIZE_KEY = 'p3m-size';               // long side of the network's input, px (default DEFAULT_SIZE)
  var ORT_FILE = 'ort.all.min.mjs';
  var CACHE_NAME = 'voxal-p3m-v1';         // Cache Storage: 78-156 MB is not left to the HTTP cache's mercy
  // w16: weights stored as half floats, computed in float32 (78 MB, the fp32
  // graph's alpha to ~1e-5). fp32: 156 MB. fp16: half-float compute, only
  // with `make p3m-assets ARGS=--fp16` — its alpha drifts by 1-2.6% on average.
  var MODELS = ['w16', 'fp32', 'fp16'];
  // The official test runs the network at half the photo's size (its RESIZE
  // strategy) with a 32-px grid. 384 on the long side is 384x224 for a 16:9
  // camera: chosen from the measurements in docs/p3m-evaluation.md.
  var DEFAULT_SIZE = 384;
  var SAMPLES = 120;

  function store(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  function selected() {
    try {
      var q = /[?&]segengine=([a-z0-9]+)/.exec(location.search);
      if (q) return q[1] === 'p3m';
    } catch (e) { /* no location */ }
    return store(ENGINE_KEY) === 'p3m';
  }

  function setSelected(on) {
    try {
      if (on) localStorage.setItem(ENGINE_KEY, 'p3m');
      else if (localStorage.getItem(ENGINE_KEY) === 'p3m') localStorage.removeItem(ENGINE_KEY);
    } catch (e) { /* storage blocked */ }
  }

  function config() {
    var model = store(MODEL_KEY);
    if (MODELS.indexOf(model) < 0) model = MODELS[0];
    var ep = store(EP_KEY) === 'wasm' ? 'wasm' : 'webgpu';
    var size = parseInt(store(SIZE_KEY), 10);
    if (!(size >= 128 && size <= 1280)) size = DEFAULT_SIZE;
    var base = store(BASE_KEY) || './assets/p3m/';
    if (base.charAt(base.length - 1) !== '/') base += '/';
    return { model: model, ep: ep, size: size, base: base };
  }

  // Input size for a frame of w x h at `long` px on the long side: both sides
  // multiples of 32 (the encoder pools five times), at least 64.
  function inputSize(w, h, long) {
    var s = long / Math.max(w, h);
    function snap(v) { return Math.max(64, Math.round(v * s / 32) * 32); }
    return { width: snap(w), height: snap(h) };
  }

  // --- runtime ---------------------------------------------------------------

  var _ort = {};
  function loadOrt(base) {
    if (window.__voxalP3mStub) return Promise.resolve(window.__voxalP3mStub);
    if (!_ort[base]) {
      _ort[base] = import(new URL(base + ORT_FILE, document.baseURI).href).then(function (m) {
        var ort = m.default && m.default.InferenceSession ? m.default : m;
        ort.env.wasm.wasmPaths = new URL(base, document.baseURI).href;
        // Threads need cross-origin isolation (the deployed app has it).
        ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
        return ort;
      }).catch(function (e) { delete _ort[base]; throw e; });
    }
    return _ort[base];
  }

  // The model's bytes, from Cache Storage when it has them. Resolves with
  // { bytes, cached }. Cache Storage needs a secure context; without it (or
  // when it refuses 78 MB) this is a plain fetch.
  function fetchModel(url) {
    function net() {
      return fetch(url).then(function (r) {
        if (!r.ok) throw new Error('P3M-Net model: HTTP ' + r.status + ' (run make p3m-assets)');
        return r;
      });
    }
    if (typeof caches === 'undefined' || window.__voxalP3mNoCache) {
      return net().then(function (r) { return r.arrayBuffer(); }).then(function (b) { return { bytes: b, cached: false }; });
    }
    return caches.open(CACHE_NAME).then(function (c) {
      return c.match(url).then(function (hit) {
        if (hit) return hit.arrayBuffer().then(function (b) { return { bytes: b, cached: true }; });
        return net().then(function (r) {
          var keep = r.clone();
          return r.arrayBuffer().then(function (b) {
            c.put(url, keep).catch(function () { /* quota: next start downloads again */ });
            return { bytes: b, cached: false };
          });
        });
      });
    }, function () {
      return net().then(function (r) { return r.arrayBuffer(); }).then(function (b) { return { bytes: b, cached: false }; });
    });
  }

  function percentile(arr, p) {
    if (!arr.length) return null;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  }

  function P3mSegmenter(raw, camVideo) {
    this.engine = 'p3m';
    this.cfg = config();
    this.camVideo = camVideo || null;
    this.closed = false;
    this.failed = null;
    this.onFail = null;
    this.ort = null;
    this.session = null;
    this.epUsed = null;
    this.modelBytes = null;        // kept until the first run proves the EP, then dropped
    this.modelMB = null;
    this.cached = null;
    this.busy = false;
    this.latest = null;            // { data, width, height, at, ms }
    this.delivered = null;
    this.cvs = document.createElement('canvas');
    this.ctx = this.cvs.getContext('2d', { willReadFrequently: true });
    this.loadMs = null;            // download (or cache read) of the model
    this.sessionMs = null;         // session creation (graph optimisation, weight upload)
    this.firstRunMs = null;        // the first inference (WebGPU compiles its shaders here)
    this.initMs = null;            // create() to ready, everything
    this.times = [];
    this.stamps = [];
    this.errors = [];
    this.failStreak = 0;           // inferences failed in a row
    this.frames = 0;
    this.openedAt = performance.now();
    this.openPromise = this.open();
  }

  P3mSegmenter.prototype.open = function () {
    var self = this, cfg = this.cfg;
    var url = new URL(cfg.base + 'p3m_r34_' + cfg.model + '.onnx', document.baseURI).href;
    var t0;
    return loadOrt(cfg.base).then(function (ort) {
      self.ort = ort;
      t0 = performance.now();
      // Tests hand the model's bytes in with the runtime stub.
      if (ort.modelBytes) return { bytes: ort.modelBytes, cached: false };
      return fetchModel(url);
    }).then(function (got) {
      if (self.closed) return null;
      self.loadMs = Math.round(performance.now() - t0);
      self.cached = got.cached;
      self.modelBytes = new Uint8Array(got.bytes);
      self.modelMB = Math.round(self.modelBytes.length / 1e5) / 10;
      // WebGPU or nothing, unless WASM is asked for by name: ORT's WASM
      // backend runs on the main thread, and the camera dropped to 3.7 fps
      // with it on an M5 (docs/p3m-evaluation.md). Without WebGPU, create()
      // rejects and the camera stays on MediaPipe.
      if (cfg.ep === 'webgpu' && !navigator.gpu) {
        throw new Error('P3M-Net needs WebGPU, which this browser does not offer (p3m-ep=wasm forces the CPU)');
      }
      var t1 = performance.now();
      return self.createSession(cfg.ep).then(function () { self.sessionMs = Math.round(performance.now() - t1); });
    }).then(function () {
      if (self.closed) return;
      self.initMs = Math.round(performance.now() - self.openedAt);
    }).catch(function (e) {
      self.fail(e);
      throw e;
    });
  };

  P3mSegmenter.prototype.createSession = function (ep) {
    var self = this;
    if (this.session && this.session.release) { try { this.session.release(); } catch (e) { /* ignore */ } }
    this.session = null;
    return this.ort.InferenceSession.create(this.modelBytes, {
      executionProviders: [ep],
      graphOptimizationLevel: 'all'
    }).then(function (s) {
      self.session = s;
      self.epUsed = ep;
      return s;
    });
  };

  P3mSegmenter.prototype.fail = function (e) {
    if (this.closed || this.failed) return;
    this.failed = e;
    this.errors.push(String(e && e.message || e));
    if (this.onFail) { try { this.onFail(e); } catch (x) { /* ignore */ } }
  };

  P3mSegmenter.prototype.getLabels = function () { return ['selfie']; };

  // No recurrent state: a new source needs nothing.
  P3mSegmenter.prototype.setSource = function () {};

  // One inference on `source` (a canvas, video or image). Resolves with the
  // matte as 0-255 at the network's input size. Never runs two at once.
  P3mSegmenter.prototype.inferFrame = function (source) {
    var self = this;
    if (this.closed) return Promise.reject(new Error('closed'));
    if (!this.session) return this.openPromise.then(function () { return self.inferFrame(source); });
    var sw = source.videoWidth || source.width, sh = source.videoHeight || source.height;
    if (!sw || !sh) return Promise.reject(new Error('no frame'));
    var sz = inputSize(sw, sh, this.cfg.size);
    var w = sz.width, h = sz.height, n = w * h;
    if (this.cvs.width !== w || this.cvs.height !== h) { this.cvs.width = w; this.cvs.height = h; }
    this.ctx.drawImage(source, 0, 0, w, h);
    var px = this.ctx.getImageData(0, 0, w, h).data;
    var src = new Float32Array(3 * n);
    for (var i = 0; i < n; i++) {
      src[i] = px[i * 4] / 255;
      src[n + i] = px[i * 4 + 1] / 255;
      src[2 * n + i] = px[i * 4 + 2] / 255;
    }
    var t0 = performance.now();
    this.busy = true;
    return this.session.run({ src: new this.ort.Tensor('float32', src, [1, 3, h, w]) }).then(function (out) {
      self.busy = false;
      self.failStreak = 0;
      var ms = performance.now() - t0;
      if (self.closed) return null;
      if (!self.frames) { self.firstRunMs = Math.round(ms); self.modelBytes = null; }
      var pha = out.pha.data;
      var mask = new Uint8Array(n);
      for (var i = 0; i < n; i++) {
        var a = pha[i];
        mask[i] = a <= 0 ? 0 : (a >= 1 ? 255 : (a * 255 + 0.5) | 0);
      }
      if (out.pha.dispose) try { out.pha.dispose(); } catch (e) { /* ignore */ }
      self.frames++;
      // The first run compiles shaders: not an inference time.
      if (self.frames > 1) { self.times.push(ms); if (self.times.length > SAMPLES) self.times.shift(); }
      self.stamps.push(t0); if (self.stamps.length > SAMPLES) self.stamps.shift();
      return { data: mask, width: w, height: h, at: t0, ms: ms };
    }, function (e) {
      self.busy = false;
      self.failStreak++;
      self.errors.push(String(e && e.message || e));
      if (self.errors.length > 10) self.errors.shift();
      // A kernel WebGPU cannot run shows up at the first run, not at session
      // creation. No move to WASM (see open()): give up at once, and the
      // Processor goes back to MediaPipe.
      if (self.epUsed === 'webgpu' && !self.frames && !self.closed) self.fail(e);
      throw e;
    });
  };

  // The Processor's call. Synchronous like MediaPipe's callback form: it starts
  // an inference on this frame when none is running, and calls back only with a
  // matte it has not handed over yet (otherwise the Processor keeps the last).
  P3mSegmenter.prototype.segmentForVideo = function (frame, ts, cb) {
    if (this.closed || this.failed || !this.session) return;
    var self = this;
    if (!this.busy) {
      var src = (this.camVideo && this.camVideo.readyState >= 2 && this.camVideo.videoWidth) ? this.camVideo : frame;
      this.inferFrame(src).then(function (r) { if (r) self.latest = r; }, function (e) {
        // Ten failures before the first matte, or five in a row after it (a
        // lost GPU device): the engine is gone, and the Processor goes back
        // to MediaPipe rather than freeze on the last matte.
        if ((self.errors.length >= 10 && !self.frames) || self.failStreak >= 5) self.fail(e);
      });
    }
    var m = this.latest;
    if (!m || m === this.delivered) return;
    this.delivered = m;
    cb({ confidenceMasks: [{ width: m.width, height: m.height, getAsUint8Array: function () { return m.data; } }],
         p3m: m });
  };

  P3mSegmenter.prototype.close = function () {
    if (this.closed) return;
    this.closed = true;
    if (this.session && this.session.release) { try { this.session.release(); } catch (e) { /* ignore */ } }
    this.session = null;
    this.modelBytes = null;
    this.latest = this.delivered = null;
    this.cvs.width = this.cvs.height = 0;
  };

  P3mSegmenter.prototype.stats = function () {
    var span = this.stamps.length > 1 ? (this.stamps[this.stamps.length - 1] - this.stamps[0]) / 1000 : 0;
    return Promise.resolve({
      engine: 'p3m',
      model: this.cfg.model,
      modelMB: this.modelMB,
      cached: this.cached,
      ep: this.epUsed,
      input: this.cvs.width + 'x' + this.cvs.height,
      initMs: this.initMs,
      loadMs: this.loadMs,
      sessionMs: this.sessionMs,
      firstRunMs: this.firstRunMs,
      frames: this.frames,
      inferMsP50: percentile(this.times, 0.5),
      inferMsP95: percentile(this.times, 0.95),
      maskHz: span > 0 ? Math.round((this.stamps.length - 1) / span * 10) / 10 : null,
      threads: this.ort ? this.ort.env.wasm.numThreads : null,
      errors: this.errors.slice()
    });
  };

  function create(raw, camVideo) {
    var seg = new P3mSegmenter(raw, camVideo);
    return seg.openPromise.then(function () { return seg; });
  }

  // Forget the cached model (Settings → Advanced, or the console).
  function clearCache() {
    if (typeof caches === 'undefined') return Promise.resolve(false);
    return caches.delete(CACHE_NAME);
  }

  return {
    ENGINE_KEY: ENGINE_KEY,
    BASE_KEY: BASE_KEY,
    MODEL_KEY: MODEL_KEY,
    EP_KEY: EP_KEY,
    SIZE_KEY: SIZE_KEY,
    MODELS: MODELS,
    DEFAULT_SIZE: DEFAULT_SIZE,
    selected: selected,
    setSelected: setSelected,
    config: config,
    create: create,
    clearCache: clearCache,
    // exposed for tests
    _inputSize: inputSize,
    _Segmenter: P3mSegmenter
  };
})();
