import { test, expect } from './fixtures.js';

// A scene that turns with the phone (src/device-tilt.js, the scene shader's
// uView, and the tilt strip a keyed frame carries to a receiver that draws the
// scene itself).
//
// Four layers: the pure maths (the strip's codec, the view matrix and its
// inverse, the sensor's rotation algebra), the sensor fed synthetic
// `deviceorientation` events, the sender drawing the strip into the keyed
// frame, and a receiver reading it back off a hand-painted keyed source and
// turning its own scene by it.

const DEG = Math.PI / 180;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__voxalSegStub = true;
    window.__voxalKeyInWarmWaitMs = 45_000;
  });
  await page.goto('/');
  await page.evaluate(() => {
    window.__sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__waitFor = async (fn, ms) => {
      const end = Date.now() + ms;
      while (!fn() && Date.now() < end) await window.__sleep(40);
      return fn();
    };
    // One orientation event, then long enough for the sensor's ease (25 ms)
    // to have caught up.
    window.__orient = async (alpha, beta, gamma) => {
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha, beta, gamma }));
      await window.__sleep(250);
      return DeviceTilt.view();
    };
  });
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => {
    try { DeviceTilt.stop(); } catch (e) { /* not started */ }
    try { VideoEffects.setTilt(null); } catch (e) { /* ignore */ }
    try { window.__h && window.__h.destroy(); } catch (e) { /* ignore */ }
    try { window.__src && window.__src.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
    try { window.__raw && window.__raw.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
    try { VideoEffects.stop(); } catch (e) { /* ignore */ }
  });
});

test.describe('the strip codec', () => {
  test('round-trips an angle triple to within a quantum, and reads cell 0 white, cell 1 black', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const K = VideoEffects.KEY_TILT;
      const cases = [[0, 0, 0], [0.3, -0.1, 0.05], [-0.5, 0.2, -0.1], [0.01, 0.01, 0.01]];
      return {
        K,
        rows: cases.map(([yaw, pitch, roll]) => {
          const bits = VideoEffects.encodeTilt({ yaw, pitch, roll });
          const back = VideoEffects.decodeTilt(bits);
          return { yaw, pitch, roll, back, sync: bits & 3 };
        }),
      };
    });
    expect(seen.K.cells).toBe(32);
    for (const r of seen.rows) {
      expect(r.sync).toBe(1);
      // Half a quantum of each range, and no more.
      expect(Math.abs(r.back.yaw - r.yaw)).toBeLessThanOrEqual(seen.K.yaw / 511 + 1e-9);
      expect(Math.abs(r.back.pitch - r.pitch)).toBeLessThanOrEqual(seen.K.pitch / 511 + 1e-9);
      expect(Math.abs(r.back.roll - r.roll)).toBeLessThanOrEqual(seen.K.roll / 63 + 1e-9);
    }
  });

  test('clamps beyond its ranges and reads a non-number as zero', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const K = VideoEffects.KEY_TILT;
      const big = VideoEffects.decodeTilt(VideoEffects.encodeTilt({ yaw: 9, pitch: -9, roll: 9 }));
      const nan = VideoEffects.decodeTilt(VideoEffects.encodeTilt({ yaw: NaN, pitch: 'x' }));
      return { K, big, nan };
    });
    expect(seen.big.yaw).toBeCloseTo(seen.K.yaw, 6);
    expect(seen.big.pitch).toBeCloseTo(-seen.K.pitch, 6);
    expect(seen.big.roll).toBeCloseTo(seen.K.roll, 6);
    expect(Math.abs(seen.nan.yaw)).toBeLessThan(0.01);
    expect(Math.abs(seen.nan.pitch)).toBeLessThan(0.01);
  });

  test('rejects a frame whose sync cells or sum are wrong, and a flat key-green frame', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const good = VideoEffects.encodeTilt({ yaw: 0.2, pitch: 0.1, roll: 0.02 });
      const flip = (b) => (good ^ (1 << b)) >>> 0;
      return {
        good: VideoEffects.decodeTilt(good) !== null,
        syncWhite: VideoEffects.decodeTilt(flip(0)),
        syncBlack: VideoEffects.decodeTilt(flip(1)),
        // Any one data cell flipped breaks the sum.
        oneCell: [2, 7, 11, 18, 21, 25].map((b) => VideoEffects.decodeTilt(flip(b))),
        sumCell: VideoEffects.decodeTilt(flip(28)),
        allZero: VideoEffects.decodeTilt(0),
        allOne: VideoEffects.decodeTilt(0xffffffff),
      };
    });
    expect(seen.good).toBe(true);
    expect(seen.syncWhite).toBe(null);
    expect(seen.syncBlack).toBe(null);
    seen.oneCell.forEach((v) => expect(v).toBe(null));
    expect(seen.sumCell).toBe(null);
    expect(seen.allZero).toBe(null);
    expect(seen.allOne).toBe(null);
  });
});

test.describe('the view matrix', () => {
  test('is the identity for no turn, and decompose() is its inverse', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const id = Array.from(VideoScenes.viewMatrix(null));
      const rows = [[0.3, -0.1, 0.05], [-0.4, 0.2, -0.1], [0, 0.25, 0], [0.5, 0, 0.1]].map(([yaw, pitch, roll]) => {
        const c = VideoScenes.viewMatrix({ yaw, pitch, roll });
        // Column-major in, row-major out.
        const m = [c[0], c[3], c[6], c[1], c[4], c[7], c[2], c[5], c[8]];
        return { want: [yaw, pitch, roll], got: VideoScenes.decomposeView(m) };
      });
      return { id, rows, nan: Array.from(VideoScenes.viewMatrix({ yaw: NaN, pitch: 0, roll: 0 })) };
    });
    expect(seen.id).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(seen.nan).toEqual(seen.id);
    for (const r of seen.rows) {
      expect(r.got.yaw).toBeCloseTo(r.want[0], 5);
      expect(r.got.pitch).toBeCloseTo(r.want[1], 5);
      expect(r.got.roll).toBeCloseTo(r.want[2], 5);
    }
  });
});

test.describe('the sensor', () => {
  test('publishes nothing until an event arrives, and is ready only then', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      const published = [];
      DeviceTilt.start({ onChange: (v) => published.push(v) });
      const before = { ready: DeviceTilt.ready(), n: published.length };
      await window.__orient(0, 90, 0);
      const after = { ready: DeviceTilt.ready(), view: DeviceTilt.view() };
      DeviceTilt.stop();
      return { before, after, last: published[published.length - 1], ready: DeviceTilt.ready() };
    });
    expect(seen.before).toEqual({ ready: false, n: 0 });
    expect(seen.after.ready).toBe(true);
    // The first pose is the baseline: straight ahead.
    expect(Math.abs(seen.after.view.yaw)).toBeLessThan(1e-6);
    expect(Math.abs(seen.after.view.pitch)).toBeLessThan(1e-6);
    expect(Math.abs(seen.after.view.roll)).toBeLessThan(1e-6);
    // Stopping says "none" and is no longer ready.
    expect(seen.last).toBe(null);
    expect(seen.ready).toBe(false);
  });

  test('a turn about the vertical is a yaw of the same size, whichever camera, whichever way up', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      const out = {};
      for (const facing of ['user', 'environment']) {
        DeviceTilt.stop();
        DeviceTilt.setFacing(facing);
        DeviceTilt.start({});
        await window.__orient(0, 90, 0);
        out[facing] = await window.__orient(5, 90, 0);
      }
      return out;
    });
    for (const f of ['user', 'environment']) {
      // Five degrees, to within the baseline's slow drift and the sensor's ease.
      expect(seen[f].yaw).toBeGreaterThan(4.3 * DEG);
      expect(seen[f].yaw).toBeLessThan(5.1 * DEG);
      expect(Math.abs(seen[f].pitch)).toBeLessThan(0.3 * DEG);
      expect(Math.abs(seen[f].roll)).toBeLessThan(0.3 * DEG);
    }
  });

  test('tilting the phone forward and back pitches the two cameras opposite ways', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      const out = {};
      for (const facing of ['user', 'environment']) {
        DeviceTilt.stop();
        DeviceTilt.setFacing(facing);
        DeviceTilt.start({});
        await window.__orient(0, 90, 0);
        out[facing] = await window.__orient(0, 95, 0);
      }
      return out;
    });
    expect(Math.abs(seen.user.pitch)).toBeGreaterThan(4.3 * DEG);
    expect(Math.abs(seen.environment.pitch)).toBeGreaterThan(4.3 * DEG);
    expect(Math.sign(seen.user.pitch)).toBe(-Math.sign(seen.environment.pitch));
    expect(Math.abs(seen.user.yaw)).toBeLessThan(0.3 * DEG);
    expect(Math.abs(seen.environment.roll)).toBeLessThan(0.3 * DEG);
  });

  test('turning about the lens is a roll', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      DeviceTilt.setFacing('environment');
      DeviceTilt.start({});
      await window.__orient(0, 0, 0);          // lying flat: the rear lens looks down
      return window.__orient(4, 0, 0);          // turned about the vertical = about the lens
    });
    expect(Math.abs(seen.roll)).toBeGreaterThan(3.4 * DEG);
    expect(Math.abs(seen.yaw)).toBeLessThan(0.3 * DEG);
    expect(Math.abs(seen.pitch)).toBeLessThan(0.3 * DEG);
  });

  test('a big turn rolls off inside the limit the strip can carry', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      DeviceTilt.start({});
      await window.__orient(0, 90, 0);
      const v = await window.__orient(170, 90, 0);
      return { v, limit: DeviceTilt.LIMIT, range: VideoEffects.KEY_TILT, soft: [DeviceTilt._soften(0.1 * 0.28, 0.28), DeviceTilt._soften(-5, 0.28)] };
    });
    expect(Math.abs(seen.v.yaw)).toBeLessThanOrEqual(seen.limit.yaw + 1e-9);
    expect(seen.limit.yaw).toBeLessThan(seen.range.yaw);
    expect(seen.limit.pitch).toBeLessThan(seen.range.pitch);
    expect(seen.limit.roll).toBeLessThan(seen.range.roll);
    // Linear below the knee, saturating above it.
    expect(seen.soft[0]).toBeCloseTo(0.028, 9);
    expect(seen.soft[1]).toBeCloseTo(-0.28, 3);
  });

  test('ignores events without angles (a desktop fires one with nulls)', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      DeviceTilt.start({});
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: null, beta: null, gamma: null }));
      await window.__sleep(50);
      return DeviceTilt.ready();
    });
    expect(seen).toBe(false);
  });

  test('changing camera starts from a new baseline', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      DeviceTilt.start({});
      await window.__orient(0, 90, 0);
      await window.__orient(10, 90, 0);
      DeviceTilt.setFacing('environment');
      return window.__orient(10, 90, 0);
    });
    expect(Math.abs(seen.yaw)).toBeLessThan(0.1 * DEG);
  });
});

test.describe('the setting', () => {
  test('is on by default, stores only "off", and fires its hook when set', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const fired = [];
      VideoEffects.onBackgroundTiltChange((on) => fired.push(on));
      const initial = [VideoEffects.readBackgroundTilt(), localStorage.getItem(VideoEffects.BACKGROUND_TILT_KEY)];
      VideoEffects.setBackgroundTilt(false);
      const stored = localStorage.getItem('background-tilt');
      VideoEffects.setBackgroundTilt(true);
      return { initial, stored, cleared: localStorage.getItem('background-tilt'), fired };
    });
    expect(seen.initial).toEqual([true, null]);
    expect(seen.stored).toBe('off');
    expect(seen.cleared).toBe(null);
    expect(seen.fired).toEqual([false, true]);
  });
});

test.describe('the sender', () => {
  async function start(page) {
    await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 320; c.height = 240;
      const ctx = c.getContext('2d');
      let n = 0;
      const paint = () => {
        ctx.fillStyle = '#c89678';
        ctx.fillRect(0, 0, 320, 240);
        ctx.fillStyle = '#334';
        ctx.fillRect(40 + (n++ * 3) % 240, 237, 2, 2);
      };
      paint();
      window.__raw = c.captureStream(15);
      const timer = setInterval(paint, 40);
      window.__raw.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
      window.__stream = await VideoEffects.wrap(window.__raw, 'preset:office');
      window.__p = window.__stream._effectsProcessor;
      await window.__waitFor(() => window.__p.maskPrimed, 5000);
      window.__cells = () => {
        const W = window.__p.canvas.width, H = window.__p.canvas.height;
        const Z = 0.1 * Math.min(W, H), sh = Z * VideoEffects.KEY_TILT.rows;
        const y = Math.floor(sh / 2), n = VideoEffects.KEY_TILT.cells;
        const span = W - 2 * Z;
        let bits = 0;
        const px = [];
        for (let i = 0; i < n; i++) {
          const x = Math.floor(Z + (i + 0.5) * span / n);
          const d = window.__p.keyed.ctx.getImageData(x, y, 1, 1).data;
          px.push([d[0], d[1], d[2]]);
          if (d[0] > 128) bits |= (1 << i);
        }
        return { bits: bits >>> 0, px };
      };
    });
  }

  test('draws the 32 cells between the zones, and only when asked', async ({ page }) => {
    test.setTimeout(60_000);
    await start(page);
    const seen = await page.evaluate(async () => {
      VideoEffects.keyedTrack(window.__stream);
      VideoEffects.setKeyedDemand(window.__stream, 1);
      await window.__sleep(400);
      const off = window.__cells();
      const stateOff = VideoEffects.keyedState(window.__stream).tilt;
      VideoEffects.setTilt({ yaw: 0.25, pitch: -0.1, roll: 0.05 });
      VideoEffects.setKeyedTilt(window.__stream, true);
      await window.__sleep(500);
      const on = window.__cells();
      const stateOn = VideoEffects.keyedState(window.__stream).tilt;
      const decoded = VideoEffects.decodeTilt(on.bits);
      return { off, on, stateOff, stateOn, decoded };
    });
    expect(seen.stateOff).toBe(false);
    expect(seen.stateOn).toBe(true);
    // Off: the strip is just key green.
    seen.off.px.forEach((p) => expect(p).toEqual([0, 255, 0]));
    // On: pure black or white, the turn read back off the pixels.
    seen.on.px.forEach((p) => {
      const white = p[0] > 128;
      expect(p).toEqual(white ? [255, 255, 255] : [0, 0, 0]);
    });
    expect(seen.decoded).not.toBe(null);
    expect(seen.decoded.yaw).toBeCloseTo(0.25, 1);
    expect(seen.decoded.pitch).toBeCloseTo(-0.1, 1);
    expect(seen.decoded.roll).toBeCloseTo(0.05, 1);
  });

  test('the state hook hears the strip switch on and off', async ({ page }) => {
    test.setTimeout(60_000);
    await start(page);
    const seen = await page.evaluate(async () => {
      VideoEffects.keyedTrack(window.__stream);
      VideoEffects.setKeyedDemand(window.__stream, 1);
      await window.__sleep(300);
      let heard = 0;
      VideoEffects.onKeyedState(() => { heard++; });
      VideoEffects.setKeyedTilt(window.__stream, true);
      await window.__sleep(600);
      const afterOn = heard;
      VideoEffects.setKeyedTilt(window.__stream, false);
      await window.__sleep(600);
      return { afterOn, afterOff: heard };
    });
    expect(seen.afterOn).toBeGreaterThanOrEqual(1);
    expect(seen.afterOff).toBeGreaterThan(seen.afterOn);
  });

  test('the strip is cut out of the subject, like a zone, and leaves the frame alone below it', async ({ page }) => {
    test.setTimeout(60_000);
    await start(page);
    const seen = await page.evaluate(async () => {
      VideoEffects.keyedTrack(window.__stream);
      VideoEffects.setKeyedDemand(window.__stream, 1);
      VideoEffects.setKeyedTilt(window.__stream, true);
      VideoEffects.setTilt({ yaw: 0, pitch: 0, roll: 0 });
      await window.__sleep(500);
      const W = window.__p.canvas.width, Z = 0.1 * Math.min(W, window.__p.canvas.height);
      const below = Math.ceil(Z * VideoEffects.KEY_TILT.rows) + 2;
      const px = (x, y) => Array.from(window.__p.keyed.ctx.getImageData(x, y, 1, 1).data).slice(0, 3);
      // Below the strip, at the top of the frame, nothing changed: outside the
      // oval it is the key.
      return { below: px(W >> 1, below), corner: px(2, 2), patch: px(Math.floor(W - Z / 2), Math.floor(Z / 2)) };
    });
    expect(seen.below).toEqual([0, 255, 0]);
    expect(seen.corner).toEqual([0, 255, 0]);
    expect(seen.patch).toEqual([0, 0, 0]);
  });

  test('the scene of the local composite turns with the phone', async ({ page }) => {
    test.setTimeout(60_000);
    await start(page);
    const seen = await page.evaluate(async () => {
      const px = (x, y) => {
        const src = window.__p.canvas, probe = document.createElement('canvas');
        probe.width = src.width; probe.height = src.height;
        const ctx = probe.getContext('2d');
        ctx.drawImage(src, 0, 0);
        const out = [];
        for (let i = 0; i < 8; i++) out.push(Array.from(ctx.getImageData(10 + i * 5, y, 1, 1).data).slice(0, 3));
        return out;
      };
      await window.__sleep(1500);
      const still = px(0, 120);
      VideoEffects.setTilt({ yaw: -0.3, pitch: 0, roll: 0 });
      await window.__sleep(2500);
      const turned = px(0, 120);
      return { still, turned };
    });
    // The picture is not the same picture: the room moved under the camera.
    const diff = seen.still.reduce((s, p, i) => s + Math.abs(p[0] - seen.turned[i][0]) + Math.abs(p[1] - seen.turned[i][1]) + Math.abs(p[2] - seen.turned[i][2]), 0);
    expect(diff).toBeGreaterThan(30);
  });
});

test.describe('the receiver', () => {
  // A keyed source painted by hand, with the tilt strip a sender would draw.
  async function startReceiver(page, { tilt, view }) {
    await page.evaluate(async ({ tilt, view }) => {
      const W = 320, H = 240;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d', { alpha: false });
      const Z = 0.1 * Math.min(W, H), P = 0.6 * Z, n = VideoEffects.KEY_TILT.cells;
      let k = 0;
      window.__strip = view;                   // what the strip says, changeable live
      const paint = () => {
        ctx.fillStyle = 'rgb(0,255,0)';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = 'rgb(200,150,120)';
        ctx.beginPath();
        ctx.ellipse(W / 2, H * 0.65, W * 0.2, H * 0.3, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#000';
        ctx.fillRect(W - Z + (Z - P) / 2, (Z - P) / 2, P, P);
        if (window.__strip) {
          const bits = VideoEffects.encodeTilt(window.__strip);
          const cw = (W - 2 * Z) / n, sh = Z * VideoEffects.KEY_TILT.rows;
          for (let i = 0; i < n; i++) {
            ctx.fillStyle = (bits >>> i) & 1 ? '#fff' : '#000';
            ctx.fillRect(Z + i * cw, 0, Math.ceil(cw), sh);
          }
        }
        ctx.fillStyle = 'rgb(0,250,0)';
        ctx.fillRect((k++ * 3) % W, H - 1, 1, 1);
      };
      paint();
      window.__src = c.captureStream(15);
      const timer = setInterval(paint, 40);
      window.__src.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
      window.__h = await VideoEffects.keyIn(window.__src, {
        scene: 'office', size: [W, H], edgeE: 0, tilt,
        look: { tint: [1, 1, 1], exposure: 1, dirX: 0.35, dirY: 0.5, hard: 0.45, side: 1 },
      }, {});
      window.__p = window.__h.processor;
      window.__out = (x, y) => {
        const src = window.__p.canvas, probe = document.createElement('canvas');
        probe.width = src.width; probe.height = src.height;
        const cx = probe.getContext('2d');
        cx.drawImage(src, 0, 0);
        return Array.from(cx.getImageData(x, y, 1, 1).data).slice(0, 3);
      };
    }, { tilt, view });
  }

  test('reads the turn off the strip and turns its own scene by it', async ({ page }) => {
    test.setTimeout(120_000);
    await startReceiver(page, { tilt: true, view: { yaw: 0.2, pitch: -0.08, roll: 0.03 } });
    const seen = await page.evaluate(async () => {
      await window.__waitFor(() => window.__p.view, 8000);
      const first = window.__p.view;
      window.__strip = { yaw: -0.15, pitch: 0.05, roll: 0 };
      await window.__waitFor(() => window.__p.view && Math.abs(window.__p.view.yaw + 0.15) < 0.01, 8000);
      return { first, second: window.__p.view, sceneView: window.__p.sceneView() };
    });
    expect(seen.first).not.toBe(null);
    expect(seen.first.yaw).toBeCloseTo(0.2, 1);
    expect(seen.first.pitch).toBeCloseTo(-0.08, 1);
    expect(seen.first.roll).toBeCloseTo(0.03, 1);
    expect(seen.second.yaw).toBeCloseTo(-0.15, 1);
    expect(seen.second.pitch).toBeCloseTo(0.05, 1);
    expect(seen.sceneView).toEqual(seen.second);
  });

  test('treats the strip as a zone: the receiver\'s scene is drawn there, not the cells', async ({ page }) => {
    test.setTimeout(120_000);
    await startReceiver(page, { tilt: true, view: { yaw: 0.2, pitch: 0, roll: 0 } });
    const seen = await page.evaluate(async () => {
      await window.__waitFor(() => window.__p.view, 8000);
      await window.__sleep(1500);
      const W = window.__p.canvas.width, Z = 0.1 * Math.min(W, window.__p.canvas.height);
      const y = Math.floor(Z * VideoEffects.KEY_TILT.rows / 2);
      const row = [];
      for (let i = 0; i < 32; i++) row.push(window.__out(Math.floor(Z + (i + 0.5) * (W - 2 * Z) / 32), y));
      return row;
    });
    // Black or white cells would show as pure 0 or 255 in all three channels;
    // a scene never does that across the whole row.
    const cellLike = seen.filter((p) => p.every((v) => v <= 3) || p.every((v) => v >= 252)).length;
    expect(cellLike).toBeLessThan(8);
  });

  test('without tilt in the offer it reads nothing and the scene stays still', async ({ page }) => {
    test.setTimeout(120_000);
    await startReceiver(page, { tilt: false, view: { yaw: 0.2, pitch: 0, roll: 0 } });
    const seen = await page.evaluate(async () => {
      await window.__sleep(2500);
      return { view: window.__p.view, scene: window.__p.sceneView(), strip: window.__p.tiltStrip };
    });
    expect(seen).toEqual({ view: null, scene: null, strip: false });
  });

  test('a strip that stops decoding eases the scene back to a still camera', async ({ page }) => {
    test.setTimeout(150_000);
    await startReceiver(page, { tilt: true, view: { yaw: 0.2, pitch: 0, roll: 0 } });
    const seen = await page.evaluate(async () => {
      await window.__waitFor(() => window.__p.view, 8000);
      window.__strip = null;                  // no cells at all: key green where they were
      // The ease is per redraw (x0.85, ~47 of them), and software GL redraws a
      // scene a couple of times a second, so it takes ~24 s here and more on CI.
      const gone = await window.__waitFor(() => window.__p.view === null, 80_000);
      return { gone };
    });
    expect(seen.gone).toBe(true);
  });

  test('an offer that turns the strip off lets go of the turn', async ({ page }) => {
    test.setTimeout(120_000);
    await startReceiver(page, { tilt: true, view: { yaw: 0.2, pitch: 0, roll: 0 } });
    const seen = await page.evaluate(async () => {
      await window.__waitFor(() => window.__p.view, 8000);
      await window.__h.setOffer({
        scene: 'office', size: [320, 240], edgeE: 0, tilt: false,
        look: { tint: [1, 1, 1], exposure: 1, dirX: 0.35, dirY: 0.5, hard: 0.45, side: 1 },
      });
      return { view: window.__p.view, strip: window.__p.tiltStrip };
    });
    expect(seen).toEqual({ view: null, strip: false });
  });
});
