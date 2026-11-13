// The matting "lab": one engine that runs any candidate model from a registry —
// EXPERIMENTAL, for the candidate evaluation (docs/matting-candidates.md).
//
// Off unless localStorage['segmentation-engine'] is 'lab' (or ?segengine=lab).
// Nothing here loads, runs or downloads otherwise. Which model runs is
// localStorage['lab-model'] (a key of MODELS below; ?labmodel=<id> in the URL
// wins). No model file is in the repository: `make lab-assets` downloads and
// converts every candidate into the gitignored src/assets/lab/
// (scripts/lab-assets.sh). Some candidates carry licences Voxal could not ship
// (RMBG-1.4: BRIA non-commercial) — they are measured, never shipped: every
// build and production deploy strips src/assets/lab; only a PREVIEW_ENGINES=1
// preview fetches it (scripts/matting-models-fetch.sh), exactly as for RVM.
//
// The point of one generic engine is that a new candidate costs one registry
// entry, not a 400-line adapter: an ONNX model is described by its input
// (size rule, normalisation, element type) and its output (an alpha, a logit
// to squash, a softmax's foreground channel, a min-max normalised map); a
// MediaPipe .tflite segmenter by the classes that are "not the person".
//
// The adapter is shaped like p3m-engine.js (segmentForVideo / inferFrame /
// close / stats), so the Processor, the matting bench and the compare view
// treat it like the others. Inference is asynchronous: segmentForVideo()
// starts one on the current frame when none is running and hands back the
// newest finished matte, so the matte trails the picture by one inference.
var LabEngine = (function () {
  'use strict';

  var ENGINE_KEY = 'segmentation-engine';  // shared: 'lab' selects this one
  var MODEL_KEY = 'lab-model';             // a key of MODELS
  var SIZE_KEY = 'lab-size';               // long side override, px (dynamic-size models only)
  var EP_KEY = 'lab-ep';                   // webgpu (default) | wasm
  var BASE_KEY = 'lab-assets-url';         // default ./assets/lab/
  var ORT_FILE = 'ort.all.min.mjs';
  var SAMPLES = 120;

  var IMAGENET = { mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] };
  var HALF = { mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5] };
  var UNIT = { mean: [0, 0, 0], std: [1, 1, 1] };

  // size: { long, mult } = the frame's aspect at `long` px on its long side,
  // both sides multiples of `mult`; { fixed: [w, h] } = stretched to that.
  // out: 'alpha' (0-1) | 'sigmoid' (a logit) | 'softmax1' (channel 1 of a
  // two-class softmax) | 'minmax' (RMBG: rescaled to its own min..max).
  var MODELS = {
    // MODNet (ZHKKKe, Apache-2.0), photographic portrait checkpoint, the
    // transformers.js export (Xenova/modnet). Trimap-free, one frame at a time.
    'modnet': { file: 'modnet_fp32.onnx', size: { long: 512, mult: 32 }, norm: HALF, out: 'alpha',
      licence: 'Apache-2.0', label: 'MODNet (photographic)' },
    'modnet-fp16': { file: 'modnet_fp16.onnx', size: { long: 512, mult: 32 }, norm: HALF, out: 'alpha',
      licence: 'Apache-2.0', label: 'MODNet fp16' },
    // MODNet's webcam checkpoint (trained for exactly this), exported by
    // scripts/lab-export-torch.py from the official .ckpt.
    'modnet-webcam': { file: 'modnet_webcam_fp32.onnx', size: { long: 512, mult: 32 }, norm: HALF, out: 'alpha',
      licence: 'Apache-2.0', label: 'MODNet (webcam)' },
    // PaddleSeg (Apache-2.0), converted by paddle2onnx. Fixed input sizes,
    // softmax heads: channel 1 is the person.
    // Segmenters, not mattes: `matte: false` gives them MediaPipe's cut and
    // edge, as the confidence they are.
    'pphs-v2-lite': { file: 'pphs_v2_lite_256x144.onnx', size: { fixed: [256, 144] }, norm: HALF, out: 'softmax1',
      matte: false, licence: 'Apache-2.0', label: 'PP-HumanSegV2-Lite (portrait 256x144)' },
    'pphs-v2-mobile': { file: 'pphs_v2_mobile_192.onnx', size: { fixed: [192, 192] }, norm: HALF, out: 'softmax1',
      matte: false, licence: 'Apache-2.0', label: 'PP-HumanSegV2-Mobile (192x192)' },
    // Square on purpose: its adaptive pools only convert exactly where the
    // feature map divides into their bins (scripts/lab-export-paddle.py).
    'ppmatting-v2': { file: 'ppmattingv2_512x512.onnx', size: { fixed: [512, 512] }, norm: UNIT, out: 'alpha',
      licence: 'Apache-2.0', label: 'PP-MattingV2 (STDC1, 512x512)' },
    // Semantic Guided Human Matting (MIT), ResNet-50, exported by
    // scripts/lab-export-torch.py: segmentation + matting in one graph.
    'sghm': { file: 'sghm_r50_fp32.onnx', size: { long: 768, mult: 64 }, norm: UNIT, out: 'alpha',
      licence: 'MIT', label: 'SGHM (ResNet-50)' },
    // BiRefNet lite (MIT), Swin-T, onnx-community's export: fixed at the
    // 1024x1024 it was built for. A ceiling on quality, not a real-time model.
    'birefnet-lite': { file: 'birefnet_lite_fp16.onnx', size: { fixed: [1024, 1024] }, norm: IMAGENET, out: 'sigmoid',
      licence: 'MIT', label: 'BiRefNet lite (1024x1024)' },
    // BRIA RMBG-1.4 (IS-Net; BRIA non-commercial: measured, never shipped),
    // briaai's export, fixed at 1024x1024.
    'rmbg-1.4': { file: 'rmbg14_fp16.onnx', size: { fixed: [1024, 1024] }, norm: { mean: [0.5, 0.5, 0.5], std: [1, 1, 1] },
      out: 'minmax', licence: 'BRIA non-commercial', label: 'RMBG-1.4 (1024x1024)' },
    // MediaPipe's multiclass selfie model (Apache-2.0): background / hair /
    // body skin / face skin / clothes / others. The person is 1 - background,
    // so hair is part of it by construction.
    'mp-multiclass': { kind: 'mediapipe', file: 'selfie_multiclass_256x256.tflite', background: [0], matte: false,
      licence: 'Apache-2.0', label: 'MediaPipe selfie multiclass (256x256)' }
  };
  var DEFAULT_MODEL = 'modnet';

  function store(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  function selected() {
    try {
      var q = /[?&]segengine=([a-z0-9]+)/.exec(location.search);
      if (q) return q[1] === 'lab';
    } catch (e) { /* no location */ }
    return store(ENGINE_KEY) === 'lab';
  }

  function setSelected(on) {
    try {
      if (on) localStorage.setItem(ENGINE_KEY, 'lab');
      else if (localStorage.getItem(ENGINE_KEY) === 'lab') localStorage.removeItem(ENGINE_KEY);
    } catch (e) { /* storage blocked */ }
  }

  // `override`: a model id that wins over the URL and the stored choice (the
  // diagnostic's Engines tab runs several candidates side by side).
  function config(override) {
    var model = MODELS[override] ? override : null;
    if (!model) try { var q = /[?&]labmodel=([a-z0-9.-]+)/.exec(location.search); if (q) model = q[1]; } catch (e) { /* none */ }
    if (!MODELS[model]) model = store(MODEL_KEY);
    if (!MODELS[model]) model = DEFAULT_MODEL;
    var size = parseInt(store(SIZE_KEY), 10);
    if (!(size >= 64 && size <= 2048)) size = null;
    var base = store(BASE_KEY) || './assets/lab/';
    if (base.charAt(base.length - 1) !== '/') base += '/';
    return { model: model, spec: MODELS[model], ep: store(EP_KEY) === 'wasm' ? 'wasm' : 'webgpu', size: size, base: base };
  }

  function inputSize(spec, w, h, sizeOverride) {
    var sz = spec.size || {};
    if (sz.fixed) return { width: sz.fixed[0], height: sz.fixed[1] };
    var long = sizeOverride || sz.long || 512, m = sz.mult || 32;
    var s = long / Math.max(w, h);
    function snap(v) { return Math.max(m * 2, Math.round(v * s / m) * m); }
    return { width: snap(w), height: snap(h) };
  }

  // --- half floats (models whose graph takes or returns float16) --------------

  var _f32 = new Float32Array(1), _u32 = new Uint32Array(_f32.buffer);
  function toHalf(v) {
    _f32[0] = v;
    var x = _u32[0], sign = (x >>> 16) & 0x8000, e = ((x >>> 23) & 0xff) - 112, m = x & 0x7fffff;
    if (e <= 0) return sign;                       // flush tiny values (inputs are 0-ish or normal)
    if (e >= 31) return sign | 0x7c00;
    return sign | (e << 10) | ((m + 0x1000) >>> 13);
  }
  function fromHalf(h) {
    var s = h & 0x8000 ? -1 : 1, e = (h >>> 10) & 0x1f, m = h & 0x3ff;
    if (e === 0) return s * m * 5.960464477539063e-8;
    if (e === 31) return m ? NaN : s * Infinity;
    return s * (1 + m / 1024) * Math.pow(2, e - 15);
  }

  // --- runtime ---------------------------------------------------------------

  var _ort = {};
  function loadOrt(base) {
    if (window.__voxalLabStub) return Promise.resolve(window.__voxalLabStub);
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

  var _mp = null;
  function loadMediaPipe() {
    if (!_mp) {
      var seg = './assets/seg/';
      _mp = import(new URL(seg + 'vision_bundle.mjs', document.baseURI).href).then(function (m) {
        return { ImageSegmenter: m.ImageSegmenter,
                 fileset: { wasmLoaderPath: new URL(seg + 'vision_wasm_internal.js', document.baseURI).href,
                            wasmBinaryPath: new URL(seg + 'vision_wasm_internal.wasm', document.baseURI).href } };
      }).catch(function (e) { _mp = null; throw e; });
    }
    return _mp;
  }

  function percentile(arr, p) {
    if (!arr.length) return null;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  }

  function LabSegmenter(raw, camVideo, model) {
    this.engine = 'lab';
    this.cfg = config(model);
    this.spec = this.cfg.spec;
    this.camVideo = camVideo || null;
    this.closed = false;
    this.failed = null;
    this.onFail = null;
    this.ort = null;
    this.session = null;
    this.mp = null;
    this.inName = null;
    this.outName = null;
    this.in16 = false;
    this.epUsed = null;
    this.modelMB = null;
    this.busy = false;
    this.latest = null;
    this.delivered = null;
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
    this.openedAt = performance.now();
    this.openPromise = this.open();
  }

  LabSegmenter.prototype.open = function () {
    var self = this, cfg = this.cfg, spec = this.spec;
    var url = new URL(cfg.base + spec.file, document.baseURI).href;
    var t0 = performance.now();
    if (spec.kind === 'mediapipe') {
      return loadMediaPipe().then(function (rt) {
        var cvs = document.createElement('canvas');
        return rt.ImageSegmenter.createFromOptions(rt.fileset, {
          baseOptions: { modelAssetPath: url, delegate: 'GPU' },
          canvas: cvs, runningMode: 'IMAGE', outputCategoryMask: false, outputConfidenceMasks: true
        });
      }).then(function (s) {
        self.mp = s;
        self.epUsed = 'mediapipe-gpu';
        self.loadMs = self.sessionMs = Math.round(performance.now() - t0);
        self.initMs = Math.round(performance.now() - self.openedAt);
      }).catch(function (e) { self.fail(e); throw e; });
    }
    return loadOrt(cfg.base).then(function (ort) {
      self.ort = ort;
      if (ort.modelBytes) return ort.modelBytes;
      return fetch(url).then(function (r) {
        if (!r.ok) throw new Error('lab model ' + spec.file + ': HTTP ' + r.status + ' (run make lab-assets)');
        return r.arrayBuffer();
      });
    }).then(function (bytes) {
      if (self.closed) return null;
      self.loadMs = Math.round(performance.now() - t0);
      self.modelMB = Math.round(bytes.byteLength / 1e5) / 10;
      if (cfg.ep === 'webgpu' && !navigator.gpu) throw new Error('the lab engine needs WebGPU (lab-ep=wasm forces the CPU)');
      var t1 = performance.now();
      return self.ort.InferenceSession.create(new Uint8Array(bytes), {
        executionProviders: [cfg.ep], graphOptimizationLevel: 'all'
      }).then(function (s) {
        self.session = s;
        self.epUsed = cfg.ep;
        self.inName = s.inputNames[0];
        self.outName = spec.output || s.outputNames[0];
        var meta = s.inputMetadata && s.inputMetadata[0];
        self.in16 = !!(meta && meta.type === 'float16') || !!spec.in16;
        self.sessionMs = Math.round(performance.now() - t1);
      });
    }).then(function () {
      if (!self.closed) self.initMs = Math.round(performance.now() - self.openedAt);
    }).catch(function (e) { self.fail(e); throw e; });
  };

  LabSegmenter.prototype.fail = function (e) {
    if (this.closed || this.failed) return;
    this.failed = e;
    this.errors.push(String(e && e.message || e));
    if (this.onFail) { try { this.onFail(e); } catch (x) { /* ignore */ } }
  };

  LabSegmenter.prototype.getLabels = function () { return ['selfie']; };
  LabSegmenter.prototype.setSource = function () {};

  // The output tensor as a 0-255 matte of n pixels.
  LabSegmenter.prototype.decode = function (t, n) {
    var d = t.data, out = this.spec.out, mask = new Uint8Array(n), off = 0, i, v;
    var is16 = t.type === 'float16' && !(d instanceof Float32Array) && typeof Float16Array === 'undefined';
    function at(k) { return is16 ? fromHalf(d[k]) : d[k]; }
    if (out === 'softmax1') off = d.length >= 2 * n ? n : 0;
    var lo = 0, hi = 1;
    if (out === 'minmax') {
      lo = Infinity; hi = -Infinity;
      for (i = 0; i < n; i++) { v = at(i); if (v < lo) lo = v; if (v > hi) hi = v; }
      if (!(hi > lo)) hi = lo + 1;
    }
    for (i = 0; i < n; i++) {
      v = at(off + i);
      if (out === 'sigmoid') v = 1 / (1 + Math.exp(-v));
      else if (out === 'minmax') v = (v - lo) / (hi - lo);
      mask[i] = v <= 0 ? 0 : (v >= 1 ? 255 : (v * 255 + 0.5) | 0);
    }
    return mask;
  };

  // One inference on `source`. Resolves with the matte as 0-255 at the
  // network's output size. Never runs two at once.
  LabSegmenter.prototype.inferFrame = function (source) {
    var self = this, spec = this.spec;
    if (this.closed) return Promise.reject(new Error('closed'));
    if (!this.session && !this.mp) return this.openPromise.then(function () { return self.inferFrame(source); });
    var sw = source.videoWidth || source.width, sh = source.videoHeight || source.height;
    if (!sw || !sh) return Promise.reject(new Error('no frame'));
    var t0 = performance.now();
    this.busy = true;
    var run;
    if (this.mp) {
      run = new Promise(function (resolve, reject) {
        try {
          self.mp.segment(source, function (res) {
            var masks = res.confidenceMasks, m0 = masks[0], w = m0.width, h = m0.height, n = w * h;
            var person = new Float32Array(n);
            for (var i = 0; i < n; i++) person[i] = 1;
            spec.background.forEach(function (c) {
              var a = masks[c].getAsFloat32Array();
              for (var j = 0; j < n; j++) person[j] -= a[j];
            });
            var mask = new Uint8Array(n);
            for (var k = 0; k < n; k++) { var v = person[k]; mask[k] = v <= 0 ? 0 : (v >= 1 ? 255 : (v * 255 + 0.5) | 0); }
            resolve({ data: mask, width: w, height: h });
          });
        } catch (e) { reject(e); }
      });
    } else {
      var sz = inputSize(spec, sw, sh, this.cfg.size);
      var w = sz.width, h = sz.height, n = w * h;
      if (this.cvs.width !== w || this.cvs.height !== h) { this.cvs.width = w; this.cvs.height = h; }
      this.ctx.drawImage(source, 0, 0, w, h);
      var px = this.ctx.getImageData(0, 0, w, h).data;
      var mean = spec.norm.mean, std = spec.norm.std, i, c;
      var src = this.in16 ? new Uint16Array(3 * n) : new Float32Array(3 * n);
      for (c = 0; c < 3; c++) {
        var mc = mean[c], sc = 1 / std[c], o = c * n;
        for (i = 0; i < n; i++) {
          var v = (px[i * 4 + c] / 255 - mc) * sc;
          src[o + i] = this.in16 ? toHalf(v) : v;
        }
      }
      var feeds = {};
      feeds[this.inName] = new this.ort.Tensor(this.in16 ? 'float16' : 'float32', src, [1, 3, h, w]);
      run = this.session.run(feeds).then(function (out) {
        var t = out[self.outName];
        var dims = t.dims, oh = dims[dims.length - 2], ow = dims[dims.length - 1];
        var mask = self.decode(t, ow * oh);
        Object.keys(out).forEach(function (k) { if (out[k].dispose) try { out[k].dispose(); } catch (e) { /* ignore */ } });
        return { data: mask, width: ow, height: oh };
      });
    }
    return run.then(function (r) {
      self.busy = false;
      self.failStreak = 0;
      var ms = performance.now() - t0;
      if (self.closed) return null;
      if (!self.frames) self.firstRunMs = Math.round(ms);
      self.frames++;
      if (self.frames > 1) { self.times.push(ms); if (self.times.length > SAMPLES) self.times.shift(); }
      self.stamps.push(t0); if (self.stamps.length > SAMPLES) self.stamps.shift();
      r.at = t0; r.ms = ms;
      return r;
    }, function (e) {
      self.busy = false;
      self.failStreak++;
      self.errors.push(String(e && e.message || e));
      if (self.errors.length > 10) self.errors.shift();
      if (!self.frames && !self.closed) self.fail(e);
      throw e;
    });
  };

  LabSegmenter.prototype.segmentForVideo = function (frame, ts, cb) {
    if (this.closed || this.failed || (!this.session && !this.mp)) return;
    var self = this;
    if (!this.busy) {
      var src = (this.camVideo && this.camVideo.readyState >= 2 && this.camVideo.videoWidth) ? this.camVideo : frame;
      this.inferFrame(src).then(function (r) { if (r) self.latest = r; }, function (e) {
        if (self.failStreak >= 5) self.fail(e);
      });
    }
    var m = this.latest;
    if (!m || m === this.delivered) return;
    this.delivered = m;
    cb({ confidenceMasks: [{ width: m.width, height: m.height, getAsUint8Array: function () { return m.data; } }],
         lab: m });
  };

  LabSegmenter.prototype.close = function () {
    if (this.closed) return;
    this.closed = true;
    if (this.session && this.session.release) { try { this.session.release(); } catch (e) { /* ignore */ } }
    if (this.mp && this.mp.close) { try { this.mp.close(); } catch (e) { /* ignore */ } }
    this.session = this.mp = null;
    this.latest = this.delivered = null;
    this.cvs.width = this.cvs.height = 0;
  };

  LabSegmenter.prototype.stats = function () {
    var span = this.stamps.length > 1 ? (this.stamps[this.stamps.length - 1] - this.stamps[0]) / 1000 : 0;
    return Promise.resolve({
      engine: 'lab',
      model: this.cfg.model,
      label: this.spec.label,
      licence: this.spec.licence,
      modelMB: this.modelMB,
      ep: this.epUsed,
      input: this.mp ? 'mediapipe' : this.cvs.width + 'x' + this.cvs.height,
      half: this.in16,
      initMs: this.initMs,
      loadMs: this.loadMs,
      sessionMs: this.sessionMs,
      firstRunMs: this.firstRunMs,
      frames: this.frames,
      inferMsP50: percentile(this.times, 0.5),
      inferMsP95: percentile(this.times, 0.95),
      maskHz: span > 0 ? Math.round((this.stamps.length - 1) / span * 10) / 10 : null,
      errors: this.errors.slice()
    });
  };

  function create(raw, camVideo, model) {
    var seg = new LabSegmenter(raw, camVideo, model);
    return seg.openPromise.then(function () { return seg; });
  }

  return {
    ENGINE_KEY: ENGINE_KEY,
    MODEL_KEY: MODEL_KEY,
    SIZE_KEY: SIZE_KEY,
    EP_KEY: EP_KEY,
    BASE_KEY: BASE_KEY,
    MODELS: MODELS,
    DEFAULT_MODEL: DEFAULT_MODEL,
    selected: selected,
    setSelected: setSelected,
    config: config,
    create: create,
    // exposed for tests
    _inputSize: inputSize,
    _toHalf: toHalf,
    _fromHalf: fromHalf,
    _Segmenter: LabSegmenter
  };
})();
