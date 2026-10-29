// Longpipe as a segmentation engine for the camera background effect.
//
// EXPERIMENTAL and off by default: MediaPipe stays the engine unless
// localStorage['segmentation-engine'] is 'longpipe' (or VideoEffects.setEngine
// was called). Nothing here runs, loads or downloads otherwise.
//
// Longpipe (https://github.com/sb2702/longpipe, MIT code and MIT weights) has no
// "give me the mask" API: it takes a MediaStream and returns a MediaStream with
// the background already replaced. So the mask is recovered from its output.
// The pipeline is asked for a flat key colour behind the person, and a pixel
//
//     c = a * F + (1 - a) * K          (F the person, K the key)
//
// gives back `a` through the key's chroma, e(c): for green, g - max(r, b).
// That is the same measure the keyed camera uses ("Let others draw my scene"),
// minus the codec, so the colour comes back exact. Everything downstream of
// the mask (feather, dilate, temporal blend, hair refinement, scenes, light)
// is Voxal's own and sees an ordinary 0-255 mask.
//
// The key colour is chosen from the four that are far from skin (green, blue,
// magenta, cyan): the one the person's own pixels agree with least. A key that
// matches a shirt reads that shirt as background, so the key moves.
//
// The adapter is shaped like MediaPipe's ImageSegmenter (segmentForVideo /
// close / getLabels) so the Processor treats both alike.
var LongpipeEngine = (function () {
  'use strict';

  var ENGINE_KEY = 'segmentation-engine';    // 'longpipe' | absent / anything else = MediaPipe
  var WEIGHTS_KEY = 'longpipe-weights-url';  // self-host override, same meaning as weightsBaseUrl
  var PRESET_KEY = 'longpipe-preset';        // auto (default) | fast | balanced | quality
  var MODULE_URL = './assets/longpipe/index.js';

  var KEY_E = 0.12;            // chroma above this on a person pixel = "the key colour is on you"
  var KEY_ON = 0.04;           // share of the central frame that triggers a change…
  var KEY_OFF = 0.015;         // …when another key is under this…
  var KEY_HOLD_MS = 3000;      // …for this long
  var KEY_EVAL_MS = 1000;
  var KEY_SETTLE_TOL = 0.28;   // per-channel distance at which the corners count as "this key"
  var KEY_SETTLE_MAX_MS = 1500;// fail open: a person filling the corners must not freeze the mask
  var READY_TIMEOUT_MS = 20000;
  var CORE = 0.9;              // mask value that counts as the subject's inside
  var SAMPLES = 120;           // timing window

  // Tests shorten the key timers; read at call time so setting them after load works.
  function tune(name, dflt) {
    var v = window['__voxalLongpipe' + name];
    return typeof v === 'number' ? v : dflt;
  }

  var KEYS = [
    { name: 'green',   rgb: [0, 1, 0] },
    { name: 'blue',    rgb: [0, 0, 1] },
    { name: 'magenta', rgb: [1, 0, 1] },
    { name: 'cyan',    rgb: [0, 1, 1] }
  ];

  function selected() {
    try {
      var q = /[?&]segengine=([a-z]+)/.exec(location.search);
      if (q) return q[1] === 'longpipe' ? 'longpipe' : 'mediapipe';
      return localStorage.getItem(ENGINE_KEY) === 'longpipe' ? 'longpipe' : 'mediapipe';
    } catch (e) { return 'mediapipe'; }
  }

  function setSelected(name) {
    try {
      if (name === 'longpipe') localStorage.setItem(ENGINE_KEY, 'longpipe');
      else localStorage.removeItem(ENGINE_KEY);
    } catch (e) { /* storage unavailable: the choice lasts until reload at best */ }
  }

  // --- pure maths (unit-tested) --------------------------------------------

  // How much of the key colour K a pixel carries, 0..1 for the pure key and
  // <= 0 for anything that is not on K's side. K is a corner of the RGB cube
  // with one or two channels at 1: the weakest channel that should be high,
  // minus the strongest that should be low.
  function chroma(r, g, b, K) {
    var lo = 2, hi = -2, v;
    for (var i = 0; i < 3; i++) {
      v = i === 0 ? r : (i === 1 ? g : b);
      if (K[i] > 0) { if (v < lo) lo = v; } else if (v > hi) hi = v;
    }
    return lo - hi;
  }

  // The key colour's chroma over the person's own pixels, as a median. This is
  // what pushes a skin tone's raw key-alpha above its real value, so the mask
  // is divided by (1 - it). Negative or zero in practice.
  function medianChroma(cam, mask, n, K) {
    var vals = [];
    for (var i = 0; i < n; i++) {
      if (mask[i] / 255 < CORE) continue;
      vals.push(chroma(cam[i * 4] / 255, cam[i * 4 + 1] / 255, cam[i * 4 + 2] / 255, K));
    }
    if (!vals.length) return 0;
    vals.sort(function (a, b) { return a - b; });
    return Math.min(0, Math.max(-1, vals[vals.length >> 1]));
  }

  // lp: RGBA of Longpipe's output on key K. out: Uint8 mask, same size.
  function deriveMask(lp, n, K, edgeE, out) {
    var div = 1 / Math.max(0.2, 1 - edgeE);
    for (var i = 0; i < n; i++) {
      var e = chroma(lp[i * 4] / 255, lp[i * 4 + 1] / 255, lp[i * 4 + 2] / 255, K);
      var a = (1 - e) * div;
      out[i] = a <= 0 ? 0 : (a >= 1 ? 255 : (a * 255 + 0.5) | 0);
    }
    return out;
  }

  // Share of the CENTRAL part of the camera frame that looks like each
  // candidate key. Not "of the person": a shirt the same colour as the key is
  // painted out of the mask, so measuring the mask's own subject can never see
  // it (the chicken and the egg). The middle 60% of the width is where a person
  // sits; a coloured wall in it also moves the key, which costs nothing.
  function keyConflicts(cam, w, h) {
    var x0 = Math.floor(w * 0.2), x1 = Math.ceil(w * 0.8);
    var shares = KEYS.map(function () { return 0; }), n = 0;
    for (var y = 0; y < h; y++) {
      for (var x = x0; x < x1; x++) {
        var i = (y * w + x) * 4;
        var r = cam[i] / 255, g = cam[i + 1] / 255, b = cam[i + 2] / 255;
        n++;
        for (var k = 0; k < KEYS.length; k++) {
          if (chroma(r, g, b, KEYS[k].rgb) > KEY_E) shares[k]++;
        }
      }
    }
    return { n: n, shares: shares.map(function (s) { return n ? s / n : 0; }) };
  }

  // Mean colour of the four 4x4 corner patches, as the Longpipe frame shows it.
  function cornersMatch(lp, w, h, K) {
    var p = 4, ok = 0;
    [[0, 0], [w - p, 0], [0, h - p], [w - p, h - p]].forEach(function (c) {
      var r = 0, g = 0, b = 0, m = 0;
      for (var y = c[1]; y < c[1] + p; y++) for (var x = c[0]; x < c[0] + p; x++) {
        var i = (y * w + x) * 4; r += lp[i]; g += lp[i + 1]; b += lp[i + 2]; m++;
      }
      r /= 255 * m; g /= 255 * m; b /= 255 * m;
      if (Math.abs(r - K[0]) < KEY_SETTLE_TOL && Math.abs(g - K[1]) < KEY_SETTLE_TOL &&
          Math.abs(b - K[2]) < KEY_SETTLE_TOL) ok++;
    });
    return ok >= 3;
  }

  function percentile(arr, p) {
    if (!arr.length) return null;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  }

  // --- runtime --------------------------------------------------------------

  var _mod = null;
  function loadModule() {
    if (window.__voxalLongpipeStub) return Promise.resolve(window.__voxalLongpipeStub);
    if (!_mod) {
      _mod = import(new URL(MODULE_URL, document.baseURI).href).catch(function (e) {
        _mod = null;   // a later try may succeed (offline then online)
        throw e;
      });
    }
    return _mod;
  }

  function weightsUrl() {
    try { return localStorage.getItem(WEIGHTS_KEY) || null; } catch (e) { return null; }
  }
  function presetChoice() {
    try {
      var v = localStorage.getItem(PRESET_KEY);
      return v === 'fast' || v === 'balanced' || v === 'quality' ? v : 'auto';
    } catch (e) { return 'auto'; }
  }

  function LongpipeSegmenter(raw) {
    this.engine = 'longpipe';
    this.onFail = null;
    this.closed = false;
    this.pipeline = null;
    this.input = null;
    this.video = null;
    this.keyIndex = 0;
    this.keySince = 0;      // when setBackground(key) was last asked for
    this.settled = false;
    this.pipeReady = false;
    this.openedAt = 0;
    this.initMs = null;
    this.lastEval = 0;
    this.betterSince = 0;
    this.edgeE = 0;
    this.prevMask = null;
    this.switches = 0;
    this.heldFrames = 0;
    this.frames = 0;
    this.errors = [];
    this.times = [];
    this.stamps = [];
    this.cvs = document.createElement('canvas');
    this.ctx = this.cvs.getContext('2d', { willReadFrequently: true });
    this.cam = document.createElement('canvas');
    this.camCtx = this.cam.getContext('2d', { willReadFrequently: true });
    this.openPromise = this.open(raw);
  }

  LongpipeSegmenter.prototype.open = function (raw) {
    var self = this;
    this.pipeReady = false;
    this.settled = false;
    this.openedAt = performance.now();
    this.fresh = true;     // model still loading: no fail-open until READY_TIMEOUT_MS
    return loadModule().then(function (mod) {
      if (self.closed) return;
      var track = raw && raw.getVideoTracks()[0];
      if (!track) throw new Error('no camera track');
      // A clone, so that stopping Longpipe's input can never stop the camera the
      // rest of the app is using.
      self.input = new MediaStream([track.clone()]);
      var opts = {
        background: { color: KEYS[self.keyIndex].rgb },
        audio: 'drop',
        preset: presetChoice(),
        onError: function (err) { self.noteError(err); }
      };
      var base = weightsUrl();
      if (base) opts.weightsBaseUrl = base;
      self.pipeline = new mod.EffectsPipeline(self.input, opts);
      self.keySince = performance.now();
      self.video = document.createElement('video');
      self.video.muted = true;
      self.video.playsInline = true;
      self.video.setAttribute('playsinline', '');
      self.video.srcObject = self.pipeline.stream;
      var play = self.video.play();
      if (play && play.catch) play.catch(function () { /* autoplay of a muted local stream */ });
      var ready = Promise.resolve(self.pipeline.ready);
      return Promise.race([
        ready,
        new Promise(function (_, rej) { setTimeout(function () { rej(new Error('Longpipe not ready after ' + READY_TIMEOUT_MS / 1000 + ' s')); }, READY_TIMEOUT_MS); })
      ]).then(function () {
        if (self.closed) return;
        self.pipeReady = true;
        self.initMs = Math.round(performance.now() - self.openedAt);
      });
    }).catch(function (e) {
      self.fail(e);
      throw e;
    });
  };

  LongpipeSegmenter.prototype.noteError = function (err) {
    this.errors.push((err && err.message) || String(err));
    if (this.errors.length > 10) this.errors.shift();
    if (err && err.recoverable === false) this.fail(new Error(err.message || 'Longpipe failed'));
  };

  LongpipeSegmenter.prototype.fail = function (e) {
    if (this.closed || this.failed) return;
    this.failed = e;
    this.errors.push(String(e && e.message || e));
    if (this.onFail) { try { this.onFail(e); } catch (x) { /* ignore */ } }
  };

  LongpipeSegmenter.prototype.getLabels = function () { return ['selfie']; };

  // Camera flipped: the pipeline's input is fixed, so a new one is opened. The
  // Processor keeps drawing with the last mask meanwhile.
  LongpipeSegmenter.prototype.setSource = function (raw) {
    if (this.closed) return;
    this.teardownPipeline();
    this.prevMask = null;
    this.openPromise = this.open(raw).catch(function () { /* fail() already told the owner */ });
  };

  LongpipeSegmenter.prototype.teardownPipeline = function () {
    if (this.pipeline) { try { this.pipeline.destroy(); } catch (e) { /* ignore */ } this.pipeline = null; }
    if (this.input) { try { this.input.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ } this.input = null; }
    if (this.video) { try { this.video.srcObject = null; } catch (e) { /* ignore */ } this.video = null; }
    this.pipeReady = false;
  };

  LongpipeSegmenter.prototype.close = function () {
    if (this.closed) return;
    this.closed = true;
    this.teardownPipeline();
    this.cvs.width = this.cvs.height = this.cam.width = this.cam.height = 0;
  };

  LongpipeSegmenter.prototype.switchKey = function (index, now) {
    var self = this, p = this.pipeline;
    if (!p) return;
    var prev = this.keyIndex;
    this.keyIndex = index;
    this.settled = false;
    this.fresh = false;
    this.keySince = now;
    this.switches++;
    this.betterSince = 0;
    var done = p.setBackground({ color: KEYS[index].rgb });
    if (done && done.catch) done.catch(function (e) {
      self.keyIndex = prev;      // the old key is still what is on screen
      self.noteError({ message: 'setBackground: ' + (e && e.message || e), recoverable: true });
    });
  };

  // One "inference": read Longpipe's latest frame and turn it into a mask.
  // Synchronous, like MediaPipe's callback form, and it calls back only when it
  // has a trustworthy mask — otherwise the Processor keeps the last one.
  LongpipeSegmenter.prototype.segmentForVideo = function (frame, ts, cb) {
    if (this.closed || this.failed || !this.pipeReady || !this.video) return;
    var v = this.video;
    if (v.readyState < 2 || !v.videoWidth) return;
    var t0 = performance.now();
    var w = frame.width, h = frame.height, n = w * h;
    if (this.cvs.width !== w || this.cvs.height !== h) {
      this.cvs.width = this.cam.width = w;
      this.cvs.height = this.cam.height = h;
      this.prevMask = null;
    }
    var lp, cam;
    try {
      this.ctx.drawImage(v, 0, 0, w, h);
      lp = this.ctx.getImageData(0, 0, w, h).data;
      this.camCtx.drawImage(frame, 0, 0, w, h);
      cam = this.camCtx.getImageData(0, 0, w, h).data;
    } catch (e) { return; }

    var K = KEYS[this.keyIndex].rgb;

    // Until the pipeline shows the key, its frames are the unprocessed camera
    // (it passes the input through while the model loads, and for a few frames
    // after a key change). Reading those as a mask would call the room "person".
    if (!this.settled) {
      if (cornersMatch(lp, w, h, K) || t0 - this.keySince > KEY_SETTLE_MAX_MS + (this.fresh ? READY_TIMEOUT_MS : 0)) {
        this.settled = true;
        this.fresh = false;
      } else { this.heldFrames++; return; }
    }

    if (this.prevMask && this.prevMask.length === n) {
      this.edgeE += (medianChroma(cam, this.prevMask, n, K) - this.edgeE) * 0.3;
    }
    if (t0 - this.lastEval >= tune('KeyEvalMs', KEY_EVAL_MS)) {
      this.lastEval = t0;
      this.evaluateKey(cam, w, h, t0);
    }

    var mask = new Uint8Array(n);
    deriveMask(lp, n, K, this.edgeE, mask);
    this.prevMask = mask;

    var dt = performance.now() - t0;
    this.frames++;
    this.times.push(dt); if (this.times.length > SAMPLES) this.times.shift();
    this.stamps.push(t0); if (this.stamps.length > SAMPLES) this.stamps.shift();

    cb({ confidenceMasks: [{ width: w, height: h, getAsUint8Array: function () { return mask; } }] });
  };

  LongpipeSegmenter.prototype.evaluateKey = function (cam, w, h, now) {
    var c = keyConflicts(cam, w, h);
    var cur = c.shares[this.keyIndex], best = this.keyIndex;
    for (var k = 0; k < c.shares.length; k++) if (c.shares[k] < c.shares[best]) best = k;
    this.conflict = cur;
    if (cur > KEY_ON && best !== this.keyIndex && c.shares[best] < KEY_OFF) {
      if (!this.betterSince) this.betterSince = now;
      else if (now - this.betterSince >= tune('KeyHoldMs', KEY_HOLD_MS)) this.switchKey(best, now);
    } else {
      this.betterSince = 0;
    }
  };

  LongpipeSegmenter.prototype.stats = function () {
    var span = this.stamps.length > 1 ? (this.stamps[this.stamps.length - 1] - this.stamps[0]) / 1000 : 0;
    var out = {
      engine: 'longpipe',
      key: KEYS[this.keyIndex].name,
      keySwitches: this.switches,
      keyConflict: this.conflict === undefined ? null : Math.round(this.conflict * 1000) / 1000,
      initMs: this.initMs,
      maskFrames: this.frames,
      heldFrames: this.heldFrames,
      ourMsP50: percentile(this.times, 0.5),
      ourMsP95: percentile(this.times, 0.95),
      maskHz: span > 0 ? Math.round((this.stamps.length - 1) / span * 10) / 10 : null,
      edgeE: Math.round(this.edgeE * 1000) / 1000,
      errors: this.errors.slice()
    };
    if (!this.pipeline || !this.pipeline.getStats) return Promise.resolve(out);
    return Promise.resolve(this.pipeline.getStats()).then(function (s) {
      out.pipeline = s;
      return out;
    }, function () { return out; });
  };

  function create(raw) {
    var seg = new LongpipeSegmenter(raw);
    return seg.openPromise.then(function () { return seg; });
  }

  return {
    ENGINE_KEY: ENGINE_KEY,
    WEIGHTS_KEY: WEIGHTS_KEY,
    PRESET_KEY: PRESET_KEY,
    KEYS: KEYS,
    selected: selected,
    setSelected: setSelected,
    create: create,
    // exposed for tests
    _chroma: chroma,
    _deriveMask: deriveMask,
    _medianChroma: medianChroma,
    _keyConflicts: keyConflicts,
    _cornersMatch: cornersMatch,
    _percentile: percentile,
    _Segmenter: LongpipeSegmenter
  };
})();
