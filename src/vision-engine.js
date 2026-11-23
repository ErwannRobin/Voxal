// Apple Vision as a segmentation engine — the DEFAULT in the macOS desktop app
// and in the iOS app (docs/apple-vision-evaluation.md).
//
// In the Tauri app on a Mac, and in the Capacitor app on iOS, it is the engine
// unless another one was chosen (localStorage['segmentation-engine'] absent or
// 'vision'; ?segengine=vision for a visit). There, an explicit Longpipe choice
// is stored as 'longpipe', because an absent key now means Vision. It is never
// offered anywhere else: the model is the system's own
// (VNGenerateForegroundInstanceMaskRequest, macOS 14+ / iOS 17+), so there is
// nothing to download and nothing to bundle, and elsewhere selected() is false
// and nothing here runs.
//
// The camera pipeline lives in the webview, so Vision cannot see its frames.
// Each inference draws a downscaled copy of the current frame (long side
// `vision-size`, default 512 — as good as full size on the matting bench) and
// sends it to native code; the mask comes back at the same size.
//   - Mac: the raw RGBA over Tauri IPC (`vision_foreground_mask`,
//     src-tauri/src/vision.rs), mask back as raw bytes.
//   - iOS: the Capacitor bridge is JSON, so the frame goes as a base64 JPEG
//     (the canvas's own encoder; ~25 KB against 590 KB of RGBA) to the app's
//     `VisionMask` plugin (ios/App/App/VisionMaskPlugin.swift), mask back as
//     base64. An OTA bundle on a binary without the plugin is simply not
//     `available()`.
// A call that errors (macOS 13, iOS 16, a Vision failure) rejects create() and
// video-effects.js falls back to Longpipe (and MediaPipe if Longpipe cannot
// start).
//
// The adapter is shaped like MediaPipe's ImageSegmenter (segmentForVideo /
// close / getLabels), like p3m-engine.js, so the Processor treats it like the
// others. Inference is asynchronous: segmentForVideo() starts one on the
// current frame when none is running and hands back the newest finished mask,
// so the mask trails the picture by about one round trip (~30 ms measured).
var VisionEngine = (function () {
  'use strict';

  var ENGINE_KEY = 'segmentation-engine';  // shared with the other engines: 'vision' selects this one
  var SIZE_KEY = 'vision-size';            // long side of the frame sent to Vision, px (default DEFAULT_SIZE)
  var COMMAND = 'vision_foreground_mask';
  var DEFAULT_SIZE = 512;
  var SIZES = [256, 384, 512, 640];
  var HEADER = 12;                         // u16 mw, u16 mh, u32 vision_us, u32 total_us
  var SAMPLES = 120;
  var JPEG_QUALITY = 0.9;                  // iOS transport: invisible to the mask at 512 px

  function store(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  // The IPC call: the real Tauri bridge, or a test's stand-in with the same
  // signature (invoke(cmd, body, { headers }) -> Promise<ArrayBuffer>).
  function invoker() {
    if (typeof window === 'undefined') return null;
    if (typeof window.__voxalVisionStub === 'function') return window.__voxalVisionStub;
    var core = window.__TAURI__ && window.__TAURI__.core;
    return core && typeof core.invoke === 'function' ? core.invoke : null;
  }

  // The iOS app's plugin, read at call time (never at load: an OTA bundle can
  // run on a binary that predates it, and then there is none).
  function nativePlugin() {
    if (typeof window === 'undefined') return null;
    var C = window.Capacitor;
    if (!C || typeof C.isNativePlatform !== 'function' || !C.isNativePlatform()) return null;
    if (typeof C.getPlatform === 'function' && C.getPlatform() !== 'ios') return null;
    var p = C.Plugins && C.Plugins.VisionMask;
    return p && typeof p.foregroundMask === 'function' ? p : null;
  }

  // Which native side answers: 'tauri' (the Mac app, or a test's stand-in for
  // its command), 'ios', or null.
  function platform() {
    if (typeof window === 'undefined') return null;
    if (typeof window.__voxalVisionStub === 'function') return 'tauri';
    if (invoker()) {
      var p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '';
      return /mac/i.test(p) ? 'tauri' : null;
    }
    return nativePlugin() ? 'ios' : null;
  }

  // Whether this build can offer it at all: the desktop app on a Mac, or the
  // iOS app. The OS version is the native side's to judge (it answers an
  // error before macOS 14 / iOS 17).
  function available() { return platform() !== null; }

  // Where the default applies, for labels: 'this Mac' / 'this iPhone'.
  function deviceName() {
    if (platform() !== 'ios') return 'this Mac';
    var ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    return /iPad/.test(ua) ? 'this iPad' : 'this iPhone';
  }

  // The default where it is available: absent (never chosen) selects it.
  function selected() {
    if (!available()) return false;
    try {
      var q = /[?&]segengine=([a-z0-9]+)/.exec(location.search);
      if (q) return q[1] === 'vision';
    } catch (e) { /* no location */ }
    var v = store(ENGINE_KEY);
    return v === null || v === 'vision';
  }

  // Called last by VideoEffects.setEngine(), after the other engines have
  // written their choice. Longpipe stores itself as an ABSENT key, which on
  // the Mac now reads as Vision: there, write it out as 'longpipe' (which
  // LongpipeEngine.selected() reads as itself, like any non-'mediapipe' value).
  function setSelected(on) {
    try {
      if (on) { localStorage.setItem(ENGINE_KEY, 'vision'); return; }
      if (localStorage.getItem(ENGINE_KEY) === 'vision') localStorage.removeItem(ENGINE_KEY);
      if (available() && localStorage.getItem(ENGINE_KEY) === null) localStorage.setItem(ENGINE_KEY, 'longpipe');
    } catch (e) { /* storage blocked */ }
  }

  function config() {
    var size = parseInt(store(SIZE_KEY), 10);
    if (!(size >= 64 && size <= 1280)) size = DEFAULT_SIZE;
    return { size: size };
  }

  // The frame sent for one of w x h at `long` px on the long side: the aspect
  // kept, even sides, never larger than the frame itself.
  function inputSize(w, h, long) {
    var s = Math.min(1, long / Math.max(w, h));
    function snap(v) { return Math.max(16, Math.round(v * s / 2) * 2); }
    return { width: snap(w), height: snap(h) };
  }

  // base64 -> bytes (the iOS plugin's mask).
  function fromBase64(b64) {
    var bin = atob(b64), n = bin.length, out = new Uint8Array(n);
    for (var i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // The iOS plugin's answer, in parseMask()'s shape (rustMs = native's total).
  function parseNative(r) {
    if (!r || typeof r.mask !== 'string') throw new Error('Vision answered no mask');
    var w = r.width | 0, h = r.height | 0;
    var data = fromBase64(r.mask);
    if (!(w > 0 && h > 0) || data.length !== w * h) throw new Error('Vision mask ' + w + 'x' + h + ' in ' + data.length + ' bytes');
    return { width: w, height: h, data: data, visionMs: (+r.visionUs || 0) / 1000, rustMs: (+r.totalUs || 0) / 1000 };
  }

  // The command's answer: { width, height, data, visionMs, rustMs }.
  function parseMask(buf) {
    if (!(buf instanceof ArrayBuffer)) {
      if (buf && buf.buffer instanceof ArrayBuffer) buf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      else if (Array.isArray(buf)) buf = new Uint8Array(buf).buffer;
      else throw new Error('Vision answered no bytes');
    }
    if (buf.byteLength < HEADER) throw new Error('Vision answered ' + buf.byteLength + ' bytes');
    var dv = new DataView(buf);
    var w = dv.getUint16(0, true), h = dv.getUint16(2, true);
    if (buf.byteLength !== HEADER + w * h) throw new Error('Vision mask ' + w + 'x' + h + ' in ' + buf.byteLength + ' bytes');
    return {
      width: w, height: h, data: new Uint8Array(buf, HEADER),
      visionMs: dv.getUint32(4, true) / 1000, rustMs: dv.getUint32(8, true) / 1000
    };
  }

  function percentile(arr, p) {
    if (!arr.length) return null;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  }

  function VisionSegmenter(raw, camVideo) {
    this.engine = 'vision';
    this.cfg = config();
    this.camVideo = camVideo || null;
    this.platform = platform();
    this.invoke = this.platform === 'tauri' ? invoker() : null;
    this.plugin = this.platform === 'ios' ? nativePlugin() : null;
    this.closed = false;
    this.failed = null;
    this.onFail = null;
    this.busy = false;
    this.latest = null;            // { data, width, height, at, ms }
    this.delivered = null;
    this.cvs = document.createElement('canvas');
    this.ctx = this.cvs.getContext('2d', { willReadFrequently: true });
    this.input = null;             // 'WxH' last sent
    this.initMs = null;            // create() to ready (the probe frame, Vision's model load included)
    this.times = [];               // whole round trip: draw + read + IPC + Vision + mask back
    this.visionTimes = [];         // the Vision call alone
    this.ipcTimes = [];            // round trip minus what Rust spent
    this.stamps = [];
    this.errors = [];
    this.failStreak = 0;           // inferences failed in a row
    this.frames = 0;
    this.openedAt = performance.now();
    this.openPromise = this.open();
  }

  // One tiny frame through the whole path before the engine is handed over:
  // it proves the command exists and this macOS has the request, and it loads
  // Vision's model, so the first real frame is not the slow one.
  VisionSegmenter.prototype.open = function () {
    var self = this;
    if (!this.invoke && !this.plugin) {
      var e0 = new Error('Apple Vision needs the Voxal desktop app on macOS, or the iOS app');
      this.fail(e0);
      return Promise.reject(e0);
    }
    var probe = document.createElement('canvas');
    probe.width = 64; probe.height = 36;
    return this.send(probe, 64, 36).then(function () {
      if (self.closed) return;
      self.initMs = Math.round(performance.now() - self.openedAt);
    }).catch(function (e) {
      self.fail(e);
      throw e;
    });
  };

  VisionSegmenter.prototype.fail = function (e) {
    if (this.closed || this.failed) return;
    this.failed = e;
    this.errors.push(String(e && e.message || e));
    if (this.onFail) { try { this.onFail(e); } catch (x) { /* ignore */ } }
  };

  VisionSegmenter.prototype.getLabels = function () { return ['selfie']; };

  // No state between frames: a new source needs nothing.
  VisionSegmenter.prototype.setSource = function () {};

  // Draw `source` at w x h, send its pixels, parse the answer.
  VisionSegmenter.prototype.send = function (source, w, h) {
    if (this.cvs.width !== w || this.cvs.height !== h) { this.cvs.width = w; this.cvs.height = h; }
    this.ctx.drawImage(source, 0, 0, w, h);
    if (this.plugin) {
      var url = this.cvs.toDataURL('image/jpeg', JPEG_QUALITY);
      return Promise.resolve(this.plugin.foregroundMask({ image: url.slice(url.indexOf(',') + 1), width: w, height: h }))
        .then(parseNative);
    }
    var px = this.ctx.getImageData(0, 0, w, h).data;
    return Promise.resolve(this.invoke(COMMAND, new Uint8Array(px.buffer, px.byteOffset, px.byteLength),
      { headers: { 'x-width': String(w), 'x-height': String(h) } })).then(parseMask);
  };

  // One inference on `source` (a canvas, video or image). Resolves with the
  // mask as 0-255 at the size sent. Never runs two at once.
  VisionSegmenter.prototype.inferFrame = function (source) {
    var self = this;
    if (this.closed) return Promise.reject(new Error('closed'));
    var sw = source.videoWidth || source.width, sh = source.videoHeight || source.height;
    if (!sw || !sh) return Promise.reject(new Error('no frame'));
    var sz = inputSize(sw, sh, this.cfg.size);
    this.input = sz.width + 'x' + sz.height;
    var t0 = performance.now();
    this.busy = true;
    return this.send(source, sz.width, sz.height).then(function (m) {
      self.busy = false;
      self.failStreak = 0;
      if (self.closed) return null;
      var ms = performance.now() - t0;
      self.frames++;
      self.times.push(ms); if (self.times.length > SAMPLES) self.times.shift();
      self.visionTimes.push(m.visionMs); if (self.visionTimes.length > SAMPLES) self.visionTimes.shift();
      self.ipcTimes.push(Math.max(0, ms - m.rustMs)); if (self.ipcTimes.length > SAMPLES) self.ipcTimes.shift();
      self.stamps.push(t0); if (self.stamps.length > SAMPLES) self.stamps.shift();
      return { data: m.data, width: m.width, height: m.height, at: t0, ms: ms };
    }, function (e) {
      self.busy = false;
      self.failStreak++;
      self.errors.push(String(e && e.message || e));
      if (self.errors.length > 10) self.errors.shift();
      throw e;
    });
  };

  // The Processor's call. Synchronous like MediaPipe's callback form: it starts
  // an inference on this frame when none is running, and calls back only with a
  // mask it has not handed over yet (otherwise the Processor keeps the last).
  VisionSegmenter.prototype.segmentForVideo = function (frame, ts, cb) {
    if (this.closed || this.failed) return;
    var self = this;
    if (!this.busy) {
      var src = (this.camVideo && this.camVideo.readyState >= 2 && this.camVideo.videoWidth) ? this.camVideo : frame;
      this.inferFrame(src).then(function (r) { if (r) self.latest = r; }, function (e) {
        // Five failures in a row: the engine is gone, and the Processor goes
        // back to MediaPipe rather than freeze on the last mask.
        if (self.failStreak >= 5) self.fail(e);
      });
    }
    var m = this.latest;
    if (!m || m === this.delivered) return;
    this.delivered = m;
    cb({ confidenceMasks: [{ width: m.width, height: m.height, getAsUint8Array: function () { return m.data; } }],
         vision: m });
  };

  VisionSegmenter.prototype.close = function () {
    if (this.closed) return;
    this.closed = true;
    this.latest = this.delivered = null;
    this.cvs.width = this.cvs.height = 0;
  };

  VisionSegmenter.prototype.stats = function () {
    var span = this.stamps.length > 1 ? (this.stamps[this.stamps.length - 1] - this.stamps[0]) / 1000 : 0;
    return Promise.resolve({
      engine: 'vision',
      input: this.input,
      initMs: this.initMs,
      frames: this.frames,
      inferMsP50: percentile(this.times, 0.5),
      inferMsP95: percentile(this.times, 0.95),
      visionMsP50: percentile(this.visionTimes, 0.5),
      ipcMsP50: percentile(this.ipcTimes, 0.5),
      maskHz: span > 0 ? Math.round((this.stamps.length - 1) / span * 10) / 10 : null,
      errors: this.errors.slice()
    });
  };

  function create(raw, camVideo) {
    var seg = new VisionSegmenter(raw, camVideo);
    return seg.openPromise.then(function () { return seg; });
  }

  return {
    ENGINE_KEY: ENGINE_KEY,
    SIZE_KEY: SIZE_KEY,
    SIZES: SIZES,
    DEFAULT_SIZE: DEFAULT_SIZE,
    available: available,
    platform: platform,
    deviceName: deviceName,
    selected: selected,
    setSelected: setSelected,
    config: config,
    create: create,
    // exposed for tests
    _inputSize: inputSize,
    _parseMask: parseMask,
    _parseNative: parseNative,
    _Segmenter: VisionSegmenter
  };
})();
