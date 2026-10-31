// Robust Video Matting (RVM) as a segmentation engine — EXPERIMENTAL, for the
// matting evaluation only (docs/matting-evaluation.md).
//
// Off unless localStorage['segmentation-engine'] is 'rvm' (or ?segengine=rvm).
// Nothing here loads, runs or downloads otherwise, and in a normal checkout or
// deployment there is nothing for it to load: RVM's weights are GPL-3.0, so
// they are never committed or shipped. `make rvm-assets` stages them, with the
// ONNX Runtime Web build that runs them, into the gitignored src/assets/rvm/.
// Without them create() rejects and video-effects.js falls back to MediaPipe,
// exactly as it does for a Longpipe that cannot start.
//
// RVM (https://github.com/PeterL1n/RobustVideoMatting) is a recurrent matting
// network: it is handed consecutive frames and its four recurrent states, and
// returns an alpha matte (pha) and the person's own colour (fgr) at the input's
// size. The adapter is shaped like MediaPipe's ImageSegmenter (segmentForVideo
// / close / getLabels) so the Processor treats it like the others; pha is the
// mask. Inference is asynchronous: segmentForVideo() starts one on the current
// frame when none is running and hands back the newest finished matte, so in a
// call the matte trails the picture by about one inference.
var RvmEngine = (function () {
  'use strict';

  var ENGINE_KEY = 'segmentation-engine';  // shared with LongpipeEngine: 'rvm' selects this one
  var BASE_KEY = 'rvm-assets-url';         // where ort.*.mjs and the .onnx files are (default ./assets/rvm/)
  var MODEL_KEY = 'rvm-model';             // mobilenetv3_fp32 (default) | mobilenetv3_fp16 | resnet50_fp32 | resnet50_fp16
  var EP_KEY = 'rvm-ep';                   // webgpu (default, wasm when unavailable) | wasm
  var SIZE_KEY = 'rvm-size';               // long side of the network's input, px (default 512)
  var RATIO_KEY = 'rvm-ratio';             // downsample_ratio (default: auto from the size)
  var ORT_FILE = 'ort.all.min.mjs';
  var MODELS = ['mobilenetv3_fp32', 'mobilenetv3_fp16', 'resnet50_fp32', 'resnet50_fp16'];
  var SAMPLES = 120;

  function store(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  function selected() {
    try {
      var q = /[?&]segengine=([a-z]+)/.exec(location.search);
      if (q) return q[1] === 'rvm';
    } catch (e) { /* no location */ }
    return store(ENGINE_KEY) === 'rvm';
  }

  function setSelected(on) {
    try {
      if (on) localStorage.setItem(ENGINE_KEY, 'rvm');
      else if (localStorage.getItem(ENGINE_KEY) === 'rvm') localStorage.removeItem(ENGINE_KEY);
    } catch (e) { /* storage blocked */ }
  }

  function config() {
    var model = store(MODEL_KEY);
    if (MODELS.indexOf(model) < 0) model = MODELS[0];
    var ep = store(EP_KEY) === 'wasm' ? 'wasm' : 'webgpu';
    var size = parseInt(store(SIZE_KEY), 10);
    if (!(size >= 128 && size <= 1920)) size = 512;
    var ratio = parseFloat(store(RATIO_KEY));
    if (!(ratio > 0 && ratio <= 1)) ratio = autoRatio(size);
    var base = store(BASE_KEY) || './assets/rvm/';
    if (base.charAt(base.length - 1) !== '/') base += '/';
    return { model: model, ep: ep, size: size, ratio: ratio, base: base };
  }

  // RVM's own guidance (documentation/inference.md): the network's internal
  // resolution should stay around 256-512 px for a portrait. 512 and below run
  // at full size; above, downsample so the inside stays near 512.
  function autoRatio(longSide) { return Math.min(1, 512 / longSide); }

  // Input size for a frame of w x h at `long` px on the long side. Even, and a
  // multiple of 16 after the downsample, which the encoder's strides want.
  function inputSize(w, h, long, ratio) {
    var s = long / Math.max(w, h);
    var q = Math.max(2, Math.round(16 / ratio));
    function snap(v) { return Math.max(q, Math.round(v * s / q) * q); }
    return { width: snap(w), height: snap(h) };
  }

  // --- float16 (the fp16 models take and return half floats) --------------

  var _f32 = new Float32Array(1), _u32 = new Uint32Array(_f32.buffer);
  function toHalf(v) {
    _f32[0] = v;
    var x = _u32[0];
    var sign = (x >>> 16) & 0x8000, e = ((x >>> 23) & 0xff) - 112, m = x & 0x7fffff;
    if (e <= 0) return sign;                   // flush the tiny to zero: inputs are 0-1
    if (e >= 31) return sign | 0x7c00;
    return sign | (e << 10) | (m >>> 13);
  }
  function fromHalf(h) {
    var e = (h >>> 10) & 0x1f, m = h & 0x3ff;
    var v = e === 0 ? m * 5.960464477539063e-8 : (e === 31 ? Infinity : Math.pow(2, e - 15) * (1 + m / 1024));
    return (h & 0x8000) ? -v : v;
  }

  // --- runtime ---------------------------------------------------------------

  var _ort = {};
  function loadOrt(base) {
    if (window.__voxalRvmStub) return Promise.resolve(window.__voxalRvmStub);
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

  function percentile(arr, p) {
    if (!arr.length) return null;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  }

  function RvmSegmenter(raw, camVideo) {
    this.engine = 'rvm';
    this.cfg = config();
    this.camVideo = camVideo || null;
    this.closed = false;
    this.failed = null;
    this.onFail = null;
    this.ort = null;
    this.session = null;
    this.epUsed = null;
    this.half = /fp16$/.test(this.cfg.model);
    this.rec = null;               // [r1, r2, r3, r4] tensors from the last run
    this.busy = false;
    this.latest = null;            // { data, fg, width, height, at }
    this.delivered = null;
    this.cvs = document.createElement('canvas');
    this.ctx = this.cvs.getContext('2d', { willReadFrequently: true });
    this.initMs = null;
    this.times = [];
    this.stamps = [];
    this.errors = [];
    this.frames = 0;
    this.openedAt = performance.now();
    this.openPromise = this.open();
  }

  // ONNX Runtime Web's WebGPU AveragePool does not implement ceil_mode
  // ("ceil_mode kernel execution ... is not yet implemented", ORT 1.30), and
  // RVM's three source-pyramid poolings (AvgPool2d(2, 2, ceil_mode=True)) use
  // it. On an input whose downsampled size is a multiple of 8 — inputSize()
  // makes it a multiple of 16 — ceil and floor give the same shape and the same
  // values, so the flag is switched off in the bytes (an AttributeProto
  // `name: "ceil_mode", i: 1` becomes `i: 0`, same length). Returns the count.
  var CEIL = [0x0a, 0x09, 0x63, 0x65, 0x69, 0x6c, 0x5f, 0x6d, 0x6f, 0x64, 0x65, 0x18, 0x01];
  function patchCeilMode(bytes) {
    var n = 0;
    outer: for (var i = 0; i + CEIL.length <= bytes.length; i++) {
      for (var k = 0; k < CEIL.length; k++) if (bytes[i + k] !== CEIL[k]) continue outer;
      bytes[i + CEIL.length - 1] = 0x00;
      n++;
    }
    return n;
  }

  RvmSegmenter.prototype.open = function () {
    var self = this, cfg = this.cfg;
    var url = new URL(cfg.base + 'rvm_' + cfg.model + '.onnx', document.baseURI).href;
    return loadOrt(cfg.base).then(function (ort) {
      self.ort = ort;
      return fetch(url).then(function (r) {
        if (!r.ok) throw new Error('RVM model: HTTP ' + r.status + ' (run make rvm-assets)');
        return r.arrayBuffer();
      });
    }).then(function (buf) {
      if (self.closed) return null;
      self.modelBytes = new Uint8Array(buf);
      var gpu = cfg.ep === 'webgpu' && !!navigator.gpu;
      return self.createSession(gpu ? 'webgpu' : 'wasm').catch(function (e) {
        if (!gpu) throw e;
        self.errors.push('webgpu session failed, wasm: ' + (e && e.message || e));
        return self.createSession('wasm');
      });
    }).then(function () {
      if (self.closed) return;
      self.initMs = Math.round(performance.now() - self.openedAt);
    }).catch(function (e) {
      self.fail(e);
      throw e;
    });
  };

  RvmSegmenter.prototype.createSession = function (ep) {
    var self = this, bytes = this.modelBytes.slice();
    this.ceilPatched = ep === 'webgpu' ? patchCeilMode(bytes) : 0;
    if (this.session && this.session.release) { try { this.session.release(); } catch (e) { /* ignore */ } }
    this.session = null;
    this.resetState();
    return this.ort.InferenceSession.create(bytes, {
      executionProviders: [ep],
      graphOptimizationLevel: 'all'
    }).then(function (s) {
      self.session = s;
      self.epUsed = ep;
      return s;
    });
  };

  RvmSegmenter.prototype.fail = function (e) {
    if (this.closed || this.failed) return;
    this.failed = e;
    this.errors.push(String(e && e.message || e));
    if (this.onFail) { try { this.onFail(e); } catch (x) { /* ignore */ } }
  };

  RvmSegmenter.prototype.getLabels = function () { return ['selfie']; };

  // A new picture source (camera flipped, phone turned): the recurrent state
  // describes the old one and would smear it into the new.
  RvmSegmenter.prototype.setSource = function () { this.resetState(); };

  RvmSegmenter.prototype.resetState = function () {
    if (this.rec) this.rec.forEach(function (t) { if (t && t.dispose) try { t.dispose(); } catch (e) { /* ignore */ } });
    this.rec = null;
  };

  RvmSegmenter.prototype.tensor = function (data, dims) {
    var ort = this.ort;
    if (!this.half) return new ort.Tensor('float32', data, dims);
    var h = new Uint16Array(data.length);
    for (var i = 0; i < data.length; i++) h[i] = toHalf(data[i]);
    return new ort.Tensor('float16', h, dims);
  };

  function readFloat(t, i) {
    var d = t.data;
    return d instanceof Uint16Array ? fromHalf(d[i]) : d[i];
  }

  // One inference on `source` (a canvas, video or image). Resolves with the
  // matte as 0-255 at the network's input size, and the foreground colour as
  // RGBA (alpha 255) at the same size. Never runs two at once.
  RvmSegmenter.prototype.inferFrame = function (source) {
    var self = this;
    if (this.closed) return Promise.reject(new Error('closed'));
    if (!this.session) return this.openPromise.then(function () { return self.inferFrame(source); });
    var sw = source.videoWidth || source.width, sh = source.videoHeight || source.height;
    if (!sw || !sh) return Promise.reject(new Error('no frame'));
    var sz = inputSize(sw, sh, this.cfg.size, this.cfg.ratio);
    var w = sz.width, h = sz.height, n = w * h;
    if (this.cvs.width !== w || this.cvs.height !== h) {
      this.cvs.width = w; this.cvs.height = h;
      this.resetState();            // a new shape is a new stream for the recurrent state
    }
    var px;
    this.ctx.drawImage(source, 0, 0, w, h);
    px = this.ctx.getImageData(0, 0, w, h).data;
    var src = new Float32Array(3 * n);
    for (var i = 0; i < n; i++) {
      src[i] = px[i * 4] / 255;
      src[n + i] = px[i * 4 + 1] / 255;
      src[2 * n + i] = px[i * 4 + 2] / 255;
    }
    var ort = this.ort;
    var feeds = { src: this.tensor(src, [1, 3, h, w]) };
    var zero = this.half ? new ort.Tensor('float16', new Uint16Array(1), [1, 1, 1, 1])
                         : new ort.Tensor('float32', new Float32Array(1), [1, 1, 1, 1]);
    for (var r = 0; r < 4; r++) feeds['r' + (r + 1) + 'i'] = this.rec ? this.rec[r] : zero;
    feeds.downsample_ratio = new ort.Tensor('float32', new Float32Array([this.cfg.ratio]), [1]);
    var t0 = performance.now();
    this.busy = true;
    return this.session.run(feeds).then(function (out) {
      self.busy = false;
      var ms = performance.now() - t0;
      if (self.closed) return null;
      var old = self.rec;
      self.rec = [out.r1o, out.r2o, out.r3o, out.r4o];
      if (old) old.forEach(function (t) { if (t && t.dispose) try { t.dispose(); } catch (e) { /* ignore */ } });
      var pha = out.pha, fgr = out.fgr;
      var mask = new Uint8Array(n), fg = new Uint8ClampedArray(n * 4);
      for (var i = 0; i < n; i++) {
        var a = readFloat(pha, i);
        mask[i] = a <= 0 ? 0 : (a >= 1 ? 255 : (a * 255 + 0.5) | 0);
        fg[i * 4] = readFloat(fgr, i) * 255;
        fg[i * 4 + 1] = readFloat(fgr, n + i) * 255;
        fg[i * 4 + 2] = readFloat(fgr, 2 * n + i) * 255;
        fg[i * 4 + 3] = 255;
      }
      self.frames++;
      self.times.push(ms); if (self.times.length > SAMPLES) self.times.shift();
      self.stamps.push(t0); if (self.stamps.length > SAMPLES) self.stamps.shift();
      return { data: mask, fg: fg, width: w, height: h, at: t0, ms: ms };
    }, function (e) {
      self.busy = false;
      self.errors.push(String(e && e.message || e));
      if (self.errors.length > 10) self.errors.shift();
      // A kernel WebGPU cannot run shows up at the first run, not at session
      // creation: move to WASM once and try this frame again.
      if (self.epUsed === 'webgpu' && !self.frames && !self.closed) {
        return self.createSession('wasm').then(function () { return self.inferFrame(source); });
      }
      throw e;
    });
  };

  // The Processor's call. Synchronous like MediaPipe's callback form: it starts
  // an inference on this frame when none is running, and calls back only with a
  // matte it has not handed over yet (otherwise the Processor keeps the last).
  RvmSegmenter.prototype.segmentForVideo = function (frame, ts, cb) {
    if (this.closed || this.failed || !this.session) return;
    var self = this;
    if (!this.busy) {
      var src = (this.camVideo && this.camVideo.readyState >= 2 && this.camVideo.videoWidth) ? this.camVideo : frame;
      this.inferFrame(src).then(function (r) { if (r) self.latest = r; }, function (e) {
        if (self.errors.length >= 10 && !self.frames) self.fail(e);
      });
    }
    var m = this.latest;
    if (!m || m === this.delivered) return;
    this.delivered = m;
    cb({ confidenceMasks: [{ width: m.width, height: m.height, getAsUint8Array: function () { return m.data; } }],
         rvm: m });
  };

  RvmSegmenter.prototype.close = function () {
    if (this.closed) return;
    this.closed = true;
    this.resetState();
    if (this.session && this.session.release) { try { this.session.release(); } catch (e) { /* ignore */ } }
    this.session = null;
    this.cvs.width = this.cvs.height = 0;
  };

  RvmSegmenter.prototype.stats = function () {
    var span = this.stamps.length > 1 ? (this.stamps[this.stamps.length - 1] - this.stamps[0]) / 1000 : 0;
    return Promise.resolve({
      engine: 'rvm',
      model: this.cfg.model,
      ep: this.epUsed,
      ceilPatched: this.ceilPatched,
      input: this.cvs.width + 'x' + this.cvs.height,
      ratio: this.cfg.ratio,
      initMs: this.initMs,
      frames: this.frames,
      inferMsP50: percentile(this.times, 0.5),
      inferMsP95: percentile(this.times, 0.95),
      maskHz: span > 0 ? Math.round((this.stamps.length - 1) / span * 10) / 10 : null,
      threads: this.ort ? this.ort.env.wasm.numThreads : null,
      errors: this.errors.slice()
    });
  };

  function create(raw, camVideo) {
    var seg = new RvmSegmenter(raw, camVideo);
    return seg.openPromise.then(function () { return seg; });
  }

  return {
    ENGINE_KEY: ENGINE_KEY,
    BASE_KEY: BASE_KEY,
    MODEL_KEY: MODEL_KEY,
    EP_KEY: EP_KEY,
    SIZE_KEY: SIZE_KEY,
    RATIO_KEY: RATIO_KEY,
    MODELS: MODELS,
    selected: selected,
    setSelected: setSelected,
    config: config,
    create: create,
    // exposed for tests
    _inputSize: inputSize,
    _autoRatio: autoRatio,
    _toHalf: toHalf,
    _fromHalf: fromHalf,
    _patchCeilMode: patchCeilMode,
    _Segmenter: RvmSegmenter
  };
})();
