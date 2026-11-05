// BackgroundMattingV2 as a segmentation engine — EXPERIMENTAL, for the
// BackgroundMattingV2 evaluation (docs/bgm-evaluation.md).
//
// Off unless localStorage['segmentation-engine'] is 'bgm' (or ?segengine=bgm).
// Nothing here loads, runs or downloads otherwise. The model is not in the
// repository: `make bgm-assets` converts the official checkpoint into the
// gitignored src/assets/bgm/ with the ONNX Runtime Web build that runs it.
// BackgroundMattingV2 is MIT (code and weights); it is kept out of the builds
// until the evaluation says it is worth a download, not for its licence.
// Without the files create() rejects and video-effects.js falls back to
// MediaPipe, exactly as for a P3M-Net or an RVM that cannot start.
//
// BackgroundMattingV2 (https://github.com/PeterL1n/BackgroundMattingV2, CVPR
// 2021) is handed TWO pictures: the camera frame and a photograph of the same
// room with nobody in it — the "plate", which Voxal already takes for its
// fixed-camera reference (Settings → Video, the room's background popover).
// A MobileNetV2 base runs on both at a quarter (or half) of the input's size;
// a refiner brings the alpha and the person's own colour back to the full
// input size. scripts/bgm-export.py exports the refiner's "full" mode (plain
// convolutions everywhere), because the shipped "sampling" mode is made of
// ops ONNX Runtime Web's WebGPU backend does not run.
//
// So this engine can only run with a plate. video-effects.js decides when
// (Processor.syncBgm()): MediaPipe until the empty room is photographed, this
// engine while that picture is loaded and still matches the room, MediaPipe
// again when it goes stale (the camera moved, the light changed). The plate is
// handed in with setPlate(), with the per-channel gain the Processor measures
// as the webcam re-meters, so the model compares like with like.
//
// The adapter is shaped like MediaPipe's ImageSegmenter (segmentForVideo /
// close / getLabels), like p3m-engine.js. Inference is asynchronous:
// segmentForVideo() starts one on the current frame when none is running and
// hands back the newest finished matte, so the matte trails the picture by
// about one inference. It also hands back the model's foreground colour (`fg`,
// as RVM does), which the composite uses where the matte is partial.
var BgmEngine = (function () {
  'use strict';

  var ENGINE_KEY = 'segmentation-engine';  // shared with the other engines: 'bgm' selects this one
  var BASE_KEY = 'bgm-assets-url';         // where ort.*.mjs and the .onnx files are (default ./assets/bgm/)
  var MODEL_KEY = 'bgm-model';             // w16 (default) | fp32
  var SCALE_KEY = 'bgm-scale';             // the base's scale x 100: 25 (default) | 50
  var EP_KEY = 'bgm-ep';                   // webgpu (default) | wasm (only when asked for: see open())
  var SIZE_KEY = 'bgm-size';               // long side of the network's input, px (default DEFAULT_SIZE)
  var ORT_FILE = 'ort.all.min.mjs';
  var CACHE_NAME = 'voxal-bgm-v1';
  // w16: weights stored as half floats, computed in float32 (10 MB; the fp32
  // graph's alpha to ~3e-5 on average). fp32: 20 MB.
  var MODELS = ['w16', 'fp32'];
  var SCALES = ['25', '50'];
  // 640 on the long side is the plate's own size (the reference is kept at
  // 640 wide, REF_LONG in video-effects.js) and ~34 ms per inference on an
  // M-series GPU; 1280 is ~76 ms (docs/bgm-evaluation.md).
  var DEFAULT_SIZE = 640;
  var SAMPLES = 120;

  function store(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  function selected() {
    try {
      var q = /[?&]segengine=([a-z0-9]+)/.exec(location.search);
      if (q) return q[1] === 'bgm';
    } catch (e) { /* no location */ }
    return store(ENGINE_KEY) === 'bgm';
  }

  function setSelected(on) {
    try {
      if (on) localStorage.setItem(ENGINE_KEY, 'bgm');
      else if (localStorage.getItem(ENGINE_KEY) === 'bgm') localStorage.removeItem(ENGINE_KEY);
    } catch (e) { /* storage blocked */ }
  }

  function config() {
    var model = store(MODEL_KEY);
    if (MODELS.indexOf(model) < 0) model = MODELS[0];
    var scale = store(SCALE_KEY);
    if (SCALES.indexOf(scale) < 0) scale = SCALES[0];
    var ep = store(EP_KEY) === 'wasm' ? 'wasm' : 'webgpu';
    var size = parseInt(store(SIZE_KEY), 10);
    if (!(size >= 128 && size <= 1920)) size = DEFAULT_SIZE;
    var base = store(BASE_KEY) || './assets/bgm/';
    if (base.charAt(base.length - 1) !== '/') base += '/';
    return { model: model, scale: scale, ep: ep, size: size, base: base };
  }

  // Input size for a frame of w x h at `long` px on the long side: both sides
  // multiples of 8 (the refiner works at 1/2 and 1/4 of the input, and the
  // base at 1/4 of that is still a whole number of pixels), at least 64.
  function inputSize(w, h, long) {
    var s = Math.min(long, Math.max(w, h)) / Math.max(w, h);
    function snap(v) { return Math.max(64, Math.round(v * s / 8) * 8); }
    return { width: snap(w), height: snap(h) };
  }

  // --- runtime ---------------------------------------------------------------

  var _ort = {};
  function loadOrt(base) {
    if (window.__voxalBgmStub) return Promise.resolve(window.__voxalBgmStub);
    if (!_ort[base]) {
      _ort[base] = import(new URL(base + ORT_FILE, document.baseURI).href).then(function (m) {
        var ort = m.default && m.default.InferenceSession ? m.default : m;
        ort.env.wasm.wasmPaths = new URL(base, document.baseURI).href;
        ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
        return ort;
      }).catch(function (e) { delete _ort[base]; throw e; });
    }
    return _ort[base];
  }

  // The model's bytes, from Cache Storage when it has them (see p3m-engine.js).
  function fetchModel(url) {
    function net() {
      return fetch(url).then(function (r) {
        if (!r.ok) throw new Error('BackgroundMattingV2 model: HTTP ' + r.status + ' (run make bgm-assets)');
        return r;
      });
    }
    if (typeof caches === 'undefined' || window.__voxalBgmNoCache) {
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

  // BackgroundMattingV2's one failure on the matting bench: now and then it
  // calls a patch of plain room "person", far from anybody, though frame and
  // plate are identical there (docs/bgm-evaluation.md). Such a patch is a
  // separate island, small next to the person, and does not touch the edge
  // of the picture. So: label the matte's islands (4-connected, alpha >=
  // BLOB_LEVEL so an island owns its soft rim), and clear every island under
  // BLOB_KEEP of the largest that touches no border. A hand coming in from the
  // bottom of the picture touches it and is kept; a second person is large
  // and is kept. `window.__voxalBgmBlobs = false` switches it off (the bench's
  // A/B). Returns how many pixels were cleared.
  var BLOB_LEVEL = 32;
  var BLOB_KEEP = 0.15;
  function dropStrayIslands(mask, w, h) {
    var n = w * h, label = new Int32Array(n), stack = new Int32Array(n);
    var sizes = [0], border = [false], next = 1, i;
    for (i = 0; i < n; i++) {
      if (label[i] || mask[i] < BLOB_LEVEL) continue;
      var id = next++, size = 0, edge = false, sp = 0;
      label[i] = id; stack[sp++] = i;
      while (sp) {
        var q = stack[--sp], x = q % w, y = (q - x) / w;
        size++;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
        if (x > 0 && !label[q - 1] && mask[q - 1] >= BLOB_LEVEL) { label[q - 1] = id; stack[sp++] = q - 1; }
        if (x < w - 1 && !label[q + 1] && mask[q + 1] >= BLOB_LEVEL) { label[q + 1] = id; stack[sp++] = q + 1; }
        if (y > 0 && !label[q - w] && mask[q - w] >= BLOB_LEVEL) { label[q - w] = id; stack[sp++] = q - w; }
        if (y < h - 1 && !label[q + w] && mask[q + w] >= BLOB_LEVEL) { label[q + w] = id; stack[sp++] = q + w; }
      }
      sizes.push(size); border.push(edge);
    }
    if (next <= 2) return 0;
    var big = 0;
    for (i = 1; i < next; i++) if (sizes[i] > big) big = sizes[i];
    var drop = new Uint8Array(next), any = false;
    for (i = 1; i < next; i++) if (!border[i] && sizes[i] < BLOB_KEEP * big) { drop[i] = 1; any = true; }
    if (!any) return 0;
    var cleared = 0;
    for (i = 0; i < n; i++) if (drop[label[i]]) { mask[i] = 0; cleared++; }
    return cleared;
  }

  function percentile(arr, p) {
    if (!arr.length) return null;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  }

  // Two gains the same to within half a percent are the same plate: the
  // Processor eases its gain every REF_STATS_MS, and rebuilding the input
  // tensor for a change nobody can see would be work for nothing.
  function sameGain(a, b) {
    if (!a || !b) return false;
    for (var c = 0; c < 3; c++) if (Math.abs(a[c] - b[c]) > 0.005) return false;
    return true;
  }

  function BgmSegmenter(raw, camVideo) {
    this.engine = 'bgm';
    this.cfg = config();
    this.camVideo = camVideo || null;
    this.closed = false;
    this.failed = null;
    this.onFail = null;
    this.ort = null;
    this.session = null;
    this.epUsed = null;
    this.modelBytes = null;
    this.modelMB = null;
    this.cached = null;
    this.busy = false;
    this.latest = null;            // { data, fg, width, height, at, ms }
    this.delivered = null;
    this.plate = null;             // { w, h, rgba, gain }, from setPlate()
    this.plateCvs = null;          // the plate at its own size (putImageData)
    this.bgr = null;               // the plate as the network's input: Float32 NCHW, gain applied
    this.bgrFor = null;            // { width, height, gain, plate } the tensor was built for
    this.plateSets = 0;
    this.cvs = document.createElement('canvas');
    this.ctx = this.cvs.getContext('2d', { willReadFrequently: true });
    this.loadMs = null;
    this.sessionMs = null;
    this.firstRunMs = null;
    this.initMs = null;
    this.times = [];
    this.stamps = [];
    this.errors = [];
    this.failStreak = 0;
    this.frames = 0;
    this.blobMs = [];              // dropStrayIslands()' main-thread time
    this.lastCleared = 0;
    this.strayFrames = 0;          // mattes it cleared a stray island from
    this.openedAt = performance.now();
    this.openPromise = this.open();
  }

  BgmSegmenter.prototype.open = function () {
    var self = this, cfg = this.cfg;
    var url = new URL(cfg.base + 'bgm_mnv2_s' + cfg.scale + '_' + cfg.model + '.onnx', document.baseURI).href;
    var t0;
    return loadOrt(cfg.base).then(function (ort) {
      self.ort = ort;
      t0 = performance.now();
      if (ort.modelBytes) return { bytes: ort.modelBytes, cached: false };
      return fetchModel(url);
    }).then(function (got) {
      if (self.closed) return null;
      self.loadMs = Math.round(performance.now() - t0);
      self.cached = got.cached;
      self.modelBytes = new Uint8Array(got.bytes);
      self.modelMB = Math.round(self.modelBytes.length / 1e5) / 10;
      // WebGPU or nothing, unless WASM is asked for by name: ORT's WASM
      // backend runs on the main thread (docs/p3m-evaluation.md).
      if (cfg.ep === 'webgpu' && !navigator.gpu) {
        throw new Error('BackgroundMattingV2 needs WebGPU, which this browser does not offer (bgm-ep=wasm forces the CPU)');
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

  BgmSegmenter.prototype.createSession = function (ep) {
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

  BgmSegmenter.prototype.fail = function (e) {
    if (this.closed || this.failed) return;
    this.failed = e;
    this.errors.push(String(e && e.message || e));
    if (this.onFail) { try { this.onFail(e); } catch (x) { /* ignore */ } }
  };

  BgmSegmenter.prototype.getLabels = function () { return ['selfie']; };

  // No recurrent state: a new source needs nothing.
  BgmSegmenter.prototype.setSource = function () {};

  // The empty room: { w, h, rgba (Uint8 RGBA, w*h*4), gain: [r, g, b] }, the
  // gain being what the camera's exposure and white balance have moved by
  // since the picture was taken (plate x gain ~ the room now). null forgets
  // it, and the engine stops producing mattes until it gets another.
  BgmSegmenter.prototype.setPlate = function (plate) {
    if (!plate) { this.plate = null; this.bgr = null; this.bgrFor = null; return; }
    var gain = plate.gain ? plate.gain.slice(0, 3) : [1, 1, 1];
    if (this.plate && this.plate.rgba === plate.rgba && sameGain(this.plate.gain, gain)) return;
    var fresh = !this.plate || this.plate.rgba !== plate.rgba;
    this.plate = { w: plate.w, h: plate.h, rgba: plate.rgba, gain: gain };
    if (fresh) {
      if (!this.plateCvs) this.plateCvs = document.createElement('canvas');
      this.plateCvs.width = plate.w; this.plateCvs.height = plate.h;
      var pc = this.plateCvs.getContext('2d');
      var id = pc.createImageData(plate.w, plate.h);
      id.data.set(plate.rgba);
      pc.putImageData(id, 0, 0);
    }
    this.plateSets++;
  };

  BgmSegmenter.prototype.hasPlate = function () { return !!this.plate; };

  // The plate as the network's input at w x h, gain applied, rebuilt only
  // when the size, the picture or the gain changed.
  BgmSegmenter.prototype.plateTensor = function (w, h) {
    var p = this.plate, f = this.bgrFor;
    if (this.bgr && f && f.width === w && f.height === h && f.plate === p.rgba && sameGain(f.gain, p.gain)) return this.bgr;
    var n = w * h;
    this.ctx.drawImage(this.plateCvs, 0, 0, w, h);
    var px = this.ctx.getImageData(0, 0, w, h).data;
    var g = p.gain, out = (this.bgr && this.bgr.length === 3 * n) ? this.bgr : new Float32Array(3 * n);
    for (var i = 0; i < n; i++) {
      out[i] = Math.min(1, px[i * 4] / 255 * g[0]);
      out[n + i] = Math.min(1, px[i * 4 + 1] / 255 * g[1]);
      out[2 * n + i] = Math.min(1, px[i * 4 + 2] / 255 * g[2]);
    }
    this.bgr = out;
    this.bgrFor = { width: w, height: h, gain: g.slice(), plate: p.rgba };
    return out;
  };

  // One inference on `source` (a canvas, video or image) against the plate.
  // Resolves with the matte (0-255) and the person's colour (RGBA) at the
  // network's input size. Never runs two at once.
  BgmSegmenter.prototype.inferFrame = function (source) {
    var self = this;
    if (this.closed) return Promise.reject(new Error('closed'));
    if (!this.session) return this.openPromise.then(function () { return self.inferFrame(source); });
    if (!this.plate) return Promise.reject(new Error('no plate'));
    var sw = source.videoWidth || source.width, sh = source.videoHeight || source.height;
    if (!sw || !sh) return Promise.reject(new Error('no frame'));
    var sz = inputSize(sw, sh, this.cfg.size);
    var w = sz.width, h = sz.height, n = w * h;
    // Sized first: plateTensor() draws the plate through this same canvas,
    // and a canvas still at its default 300x150 would clip it (the rest of the
    // plate reads back as black, which the model then calls "person").
    if (this.cvs.width !== w || this.cvs.height !== h) { this.cvs.width = w; this.cvs.height = h; }
    var bgr = this.plateTensor(w, h);
    this.ctx.drawImage(source, 0, 0, w, h);
    var px = this.ctx.getImageData(0, 0, w, h).data;
    var src = new Float32Array(3 * n);
    for (var i = 0; i < n; i++) {
      src[i] = px[i * 4] / 255;
      src[n + i] = px[i * 4 + 1] / 255;
      src[2 * n + i] = px[i * 4 + 2] / 255;
    }
    var T = this.ort.Tensor;
    var t0 = performance.now();
    this.busy = true;
    return this.session.run({
      src: new T('float32', src, [1, 3, h, w]),
      bgr: new T('float32', bgr, [1, 3, h, w])
    }).then(function (out) {
      self.busy = false;
      self.failStreak = 0;
      var ms = performance.now() - t0;
      if (self.closed) return null;
      if (!self.frames) { self.firstRunMs = Math.round(ms); self.modelBytes = null; }
      var pha = out.pha.data, fgr = out.fgr.data;
      var mask = new Uint8Array(n), fg = new Uint8ClampedArray(n * 4);
      for (var i = 0; i < n; i++) {
        var a = pha[i];
        mask[i] = a <= 0 ? 0 : (a >= 1 ? 255 : (a * 255 + 0.5) | 0);
        fg[i * 4] = fgr[i] * 255;
        fg[i * 4 + 1] = fgr[n + i] * 255;
        fg[i * 4 + 2] = fgr[2 * n + i] * 255;
        fg[i * 4 + 3] = 255;
      }
      [out.pha, out.fgr].forEach(function (t) { if (t && t.dispose) try { t.dispose(); } catch (e) { /* ignore */ } });
      if (window.__voxalBgmBlobs !== false) {
        var tb = performance.now();
        self.lastCleared = dropStrayIslands(mask, w, h);
        self.blobMs.push(performance.now() - tb); if (self.blobMs.length > SAMPLES) self.blobMs.shift();
        if (self.lastCleared) self.strayFrames++;
      }
      self.frames++;
      if (self.frames > 1) { self.times.push(ms); if (self.times.length > SAMPLES) self.times.shift(); }
      self.stamps.push(t0); if (self.stamps.length > SAMPLES) self.stamps.shift();
      return { data: mask, fg: fg, width: w, height: h, at: t0, ms: ms };
    }, function (e) {
      self.busy = false;
      self.failStreak++;
      self.errors.push(String(e && e.message || e));
      if (self.errors.length > 10) self.errors.shift();
      if (self.epUsed === 'webgpu' && !self.frames && !self.closed) self.fail(e);
      throw e;
    });
  };

  // The Processor's call: see p3m-engine.js. Without a plate it does nothing
  // (the Processor keeps its last mask, and swaps back to MediaPipe when the
  // plate goes away: Processor.syncBgm()).
  BgmSegmenter.prototype.segmentForVideo = function (frame, ts, cb) {
    if (this.closed || this.failed || !this.session || !this.plate) return;
    var self = this;
    if (!this.busy) {
      var src = (this.camVideo && this.camVideo.readyState >= 2 && this.camVideo.videoWidth) ? this.camVideo : frame;
      this.inferFrame(src).then(function (r) { if (r) self.latest = r; }, function (e) {
        if ((self.errors.length >= 10 && !self.frames) || self.failStreak >= 5) self.fail(e);
      });
    }
    var m = this.latest;
    if (!m || m === this.delivered) return;
    this.delivered = m;
    cb({ confidenceMasks: [{ width: m.width, height: m.height, getAsUint8Array: function () { return m.data; } }],
         bgm: m });
  };

  BgmSegmenter.prototype.close = function () {
    if (this.closed) return;
    this.closed = true;
    if (this.session && this.session.release) { try { this.session.release(); } catch (e) { /* ignore */ } }
    this.session = null;
    this.modelBytes = null;
    this.latest = this.delivered = null;
    this.plate = this.bgr = this.bgrFor = null;
    this.cvs.width = this.cvs.height = 0;
    if (this.plateCvs) this.plateCvs.width = this.plateCvs.height = 0;
  };

  BgmSegmenter.prototype.stats = function () {
    var span = this.stamps.length > 1 ? (this.stamps[this.stamps.length - 1] - this.stamps[0]) / 1000 : 0;
    return Promise.resolve({
      engine: 'bgm',
      model: this.cfg.model,
      scale: this.cfg.scale,
      modelMB: this.modelMB,
      cached: this.cached,
      ep: this.epUsed,
      input: this.cvs.width + 'x' + this.cvs.height,
      plate: this.plate ? this.plate.w + 'x' + this.plate.h : null,
      plateGain: this.plate ? this.plate.gain.map(function (g) { return Math.round(g * 1000) / 1000; }) : null,
      plateSets: this.plateSets,
      initMs: this.initMs,
      loadMs: this.loadMs,
      sessionMs: this.sessionMs,
      firstRunMs: this.firstRunMs,
      frames: this.frames,
      inferMsP50: percentile(this.times, 0.5),
      inferMsP95: percentile(this.times, 0.95),
      maskHz: span > 0 ? Math.round((this.stamps.length - 1) / span * 10) / 10 : null,
      islandMsP50: percentile(this.blobMs, 0.5),
      strayFrames: this.strayFrames,
      threads: this.ort ? this.ort.env.wasm.numThreads : null,
      errors: this.errors.slice()
    });
  };

  function create(raw, camVideo) {
    var seg = new BgmSegmenter(raw, camVideo);
    return seg.openPromise.then(function () { return seg; });
  }

  function clearCache() {
    if (typeof caches === 'undefined') return Promise.resolve(false);
    return caches.delete(CACHE_NAME);
  }

  return {
    ENGINE_KEY: ENGINE_KEY,
    BASE_KEY: BASE_KEY,
    MODEL_KEY: MODEL_KEY,
    SCALE_KEY: SCALE_KEY,
    EP_KEY: EP_KEY,
    SIZE_KEY: SIZE_KEY,
    MODELS: MODELS,
    SCALES: SCALES,
    DEFAULT_SIZE: DEFAULT_SIZE,
    selected: selected,
    setSelected: setSelected,
    config: config,
    create: create,
    clearCache: clearCache,
    // exposed for tests
    _inputSize: inputSize,
    _dropStrayIslands: dropStrayIslands,
    _Segmenter: BgmSegmenter
  };
})();
