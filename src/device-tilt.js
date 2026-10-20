// DeviceTilt — how far the phone has turned, for the camera backgrounds.
//
// A scene is a room seen through a camera. When the phone turns, the real world
// (and the person in front of it) slides across the picture, so a background
// that stays put looks pasted on. This turns the scene's camera by the same
// amount: pure rotation shifts every depth equally, so no parallax is needed.
//
// What it publishes is the rotation of the CAMERA since a baseline pose, as the
// three small angles the scene shader takes (yaw, pitch, roll — see
// VideoScenes.viewMatrix). The baseline follows the phone slowly (BASE_TAU_S),
// so a posture you settle into becomes "straight ahead" again and the room
// never drifts off into the far corner of its walls; a quick turn is followed
// in full. The angles are eased through a soft limit that stays inside what
// the keyed frame's tilt strip can carry (VideoEffects.KEY_TILT).
//
// It reads `deviceorientation` (the browsers fuse gyro and accelerometer for
// it) and builds a rotation matrix from the three Euler angles rather than
// using them directly: a phone held upright, which is how a selfie is held, sits
// next to the angles' singularity, where alpha and gamma swing wildly while the
// rotation they describe barely moves.
//
// iOS asks permission, and only from a user gesture: requestPermission().
// Where no events ever arrive (a desktop, a denied prompt, a WebView without
// the sensor) ready() stays false and nothing is published.
//
// A classic script with one global, loaded before main.js.
var DeviceTilt = (function () {
  'use strict';

  var DEG = Math.PI / 180;
  // What the scene may turn by: linear to KNEE of the limit, then rolled off
  // toward it. Inside VideoEffects.KEY_TILT's ranges (32°, 16°, 8°).
  var LIMIT = { yaw: 28 * DEG, pitch: 14 * DEG, roll: 7 * DEG };
  var KNEE = 0.6;
  var BASE_TAU_S = 7;        // the baseline follows the phone with this time constant
  var SMOOTH_TAU_S = 0.025;  // sensor noise, well under a frame
  var QUIET_MS = 1500;       // no event for this long: not flowing

  var started = false;
  var facing = 'user';
  var onChange = null;
  var onState = null;
  var gotEvents = false;     // an event with real angles has arrived since start()
  var lastEventAt = 0;
  var lastT = 0;
  var base = null;           // { r, u, f }: the baseline camera axes, earth frame
  var smooth = null;         // { yaw, pitch, roll }
  var current = null;        // what was last published
  var watchdog = null;
  var denied = false;

  // --- vectors and matrices (row-major 3x3 as nine numbers) ---------------------
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function norm(a) {
    var l = Math.sqrt(dot(a, a)) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  }
  function mulMV(m, v) {
    return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
            m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
            m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
  }
  function mulMM(a, b) {
    var o = new Array(9);
    for (var i = 0; i < 3; i++) {
      for (var j = 0; j < 3; j++) {
        o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
      }
    }
    return o;
  }
  function rotZ(a) { var c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0, 0, 0, 1]; }
  function rotX(a) { var c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, -s, 0, s, c]; }
  function rotY(a) { var c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c]; }

  // The W3C's device-to-earth rotation, Z-X'-Y'': Rz(alpha) Rx(beta) Ry(gamma).
  function deviceMatrix(alpha, beta, gamma) {
    return mulMM(mulMM(rotZ(alpha * DEG), rotX(beta * DEG)), rotY(gamma * DEG));
  }

  function screenAngle() {
    var a = 0;
    try {
      if (window.screen && screen.orientation && typeof screen.orientation.angle === 'number') a = screen.orientation.angle;
      else if (typeof window.orientation === 'number') a = window.orientation;
    } catch (e) { a = 0; }
    return a * DEG;
  }

  // The camera's three axes in the earth frame, for a device pose and the way
  // the screen is turned. The picture is always upright to the screen, so its
  // right and up are the screen's. A rear camera looks out of the back of the
  // device; a front one looks at the user, and its frame is not mirrored (only
  // the self-view is), so its image-right is the screen's LEFT.
  function cameraAxes(R, a, front) {
    var rightD = [Math.cos(a), -Math.sin(a), 0];
    var upD = [Math.sin(a), Math.cos(a), 0];
    var r = mulMV(R, rightD), u = mulMV(R, upD), back = mulMV(R, [0, 0, 1]);
    if (front) return { r: [-r[0], -r[1], -r[2]], u: u, f: back };
    return { r: r, u: u, f: [-back[0], -back[1], -back[2]] };
  }

  // The turn from the baseline camera to this one, as the row-major matrix the
  // scene shader multiplies a view ray by (VideoScenes.viewMatrix's):
  // columns are this camera's right, up and back, written in the baseline's.
  function relativeTurn(b, c) {
    return [
      dot(c.r, b.r), dot(c.u, b.r), -dot(c.f, b.r),
      dot(c.r, b.u), dot(c.u, b.u), -dot(c.f, b.u),
      -dot(c.r, b.f), -dot(c.u, b.f), dot(c.f, b.f)
    ];
  }

  function decompose(m) {
    var s = -m[5];
    return {
      yaw: Math.atan2(m[2], m[8]),
      pitch: Math.asin(s < -1 ? -1 : s > 1 ? 1 : s),
      roll: Math.atan2(m[3], m[4])
    };
  }

  // Linear up to KNEE of the limit, then rolled off to it.
  function soften(a, max) {
    var k = KNEE * max, m = Math.abs(a);
    if (m <= k) return a;
    var over = (m - k) / (max - k);
    return (a < 0 ? -1 : 1) * (k + (max - k) * Math.tanh(over));
  }

  // Let the baseline follow the phone, then make its axes a right-handed frame
  // again (the blend of two of them is not unit length, nor square).
  function followBase(c, dt) {
    var k = 1 - Math.exp(-dt / BASE_TAU_S);
    var mix = function (a, b) { return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]; };
    var f = norm(mix(base.f, c.f));
    var r = mix(base.r, c.r);
    var d = dot(r, f);
    r = norm([r[0] - f[0] * d, r[1] - f[1] * d, r[2] - f[2] * d]);
    // r x u = back = -f, so u = back x r.
    var u = cross([-f[0], -f[1], -f[2]], r);
    base = { r: r, u: u, f: f };
  }

  function publish(v) {
    current = v;
    if (onChange) { try { onChange(v); } catch (e) { /* a listener must not stop the sensor */ } }
  }

  function setActiveState() {
    if (onState) { try { onState(ready()); } catch (e) { /* ignore */ } }
  }

  function onOrientation(ev) {
    if (!started || !ev || typeof ev.alpha !== 'number' || typeof ev.beta !== 'number' || typeof ev.gamma !== 'number') return;
    if (!isFinite(ev.alpha) || !isFinite(ev.beta) || !isFinite(ev.gamma)) return;
    var now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    var dt = lastT ? Math.min(0.5, Math.max(0, (now - lastT) / 1000)) : 0;
    lastT = now;
    lastEventAt = now;
    var c = cameraAxes(deviceMatrix(ev.alpha, ev.beta, ev.gamma), screenAngle(), facing === 'user');
    if (!base) base = c;
    else if (dt > 0) followBase(c, dt);
    var raw = decompose(relativeTurn(base, c));
    var e = {
      yaw: soften(raw.yaw, LIMIT.yaw), pitch: soften(raw.pitch, LIMIT.pitch), roll: soften(raw.roll, LIMIT.roll)
    };
    if (!smooth || dt === 0) smooth = e;
    else {
      var k = 1 - Math.exp(-dt / SMOOTH_TAU_S);
      smooth = {
        yaw: smooth.yaw + (e.yaw - smooth.yaw) * k,
        pitch: smooth.pitch + (e.pitch - smooth.pitch) * k,
        roll: smooth.roll + (e.roll - smooth.roll) * k
      };
    }
    var first = !gotEvents;
    gotEvents = true;
    publish({ yaw: smooth.yaw, pitch: smooth.pitch, roll: smooth.roll });
    if (first) setActiveState();
  }

  function supported() {
    return typeof window !== 'undefined' && typeof window.DeviceOrientationEvent !== 'undefined';
  }

  function needsPermission() {
    return supported() && typeof window.DeviceOrientationEvent.requestPermission === 'function';
  }

  // iOS only, and only from a user gesture. Resolves 'granted', 'denied' or
  // 'unsupported'; where no prompt exists it is 'granted' (the events will
  // tell, or not).
  function requestPermission() {
    if (!supported()) return Promise.resolve('unsupported');
    if (!needsPermission()) return Promise.resolve('granted');
    var asked;
    try { asked = window.DeviceOrientationEvent.requestPermission(); }
    catch (e) { return Promise.resolve('denied'); }
    return Promise.resolve(asked).then(function (r) {
      denied = r !== 'granted';
      if (denied) { gotEvents = false; setActiveState(); }
      return denied ? 'denied' : 'granted';
    }, function () {
      denied = true;
      return 'denied';
    });
  }

  function start(opts) {
    opts = opts || {};
    if (opts.onChange) onChange = opts.onChange;
    if (opts.onState) onState = opts.onState;
    if (started || !supported()) return started;
    started = true;
    base = null; smooth = null; lastT = 0;
    window.addEventListener('deviceorientation', onOrientation, true);
    // A phone that never sends anything is not "ready": events stop arriving
    // for QUIET_MS (backgrounded, the sensor taken away) and the next one
    // starts from a fresh baseline instead of a stale one.
    watchdog = setInterval(function () {
      var now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
      if (gotEvents && lastEventAt && now - lastEventAt > QUIET_MS) { base = null; smooth = null; lastT = 0; }
    }, 1000);
    return true;
  }

  function stop() {
    if (!started) return;
    started = false;
    try { window.removeEventListener('deviceorientation', onOrientation, true); } catch (e) { /* ignore */ }
    if (watchdog) { clearInterval(watchdog); watchdog = null; }
    var was = gotEvents;
    gotEvents = false; base = null; smooth = null; lastT = 0;
    if (was) { publish(null); setActiveState(); }
  }

  // Events have arrived since start(): the phone has a sensor and may use it.
  function ready() { return started && gotEvents && !denied; }

  // Which camera is in use. The two look opposite ways, so a change starts
  // from a new baseline.
  function setFacing(f) {
    f = f === 'environment' ? 'environment' : 'user';
    if (f === facing) return;
    facing = f;
    base = null; smooth = null; lastT = 0;
  }

  // Take the phone's present pose as straight ahead.
  function recenter() { base = null; }

  return {
    supported: supported,
    needsPermission: needsPermission,
    requestPermission: requestPermission,
    start: start,
    stop: stop,
    ready: ready,
    setFacing: setFacing,
    recenter: recenter,
    view: function () { return current; },
    // Exposed for the tests: the pure maths, and an event path that needs no
    // sensor.
    _onOrientation: onOrientation,
    _deviceMatrix: deviceMatrix,
    _cameraAxes: cameraAxes,
    _relativeTurn: relativeTurn,
    _decompose: decompose,
    _soften: soften,
    LIMIT: LIMIT
  };
})();
