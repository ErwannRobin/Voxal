import { test, expect } from './fixtures.js';

// The keyed stream, sending half ("Let others draw my scene"): the second
// track a camera pipeline can publish — the person over a flat key colour with
// two marker zones, for peers that draw the scene themselves.
//
// What matters here is that the frame is EXACTLY what the receiver will take
// apart: the key outside, the camera inside, the composite's own alpha in
// between with its faint tail cut to pure key, the markers where the receiver
// looks — and that every guard which withholds keying (no scene, a green
// subject, a covered corner, a failed self-check) leaves the keyed canvas
// carrying the plain composite, with no markers, so a peer on that track just
// passes it through.
//
// The fake cameras here are deliberately NOT green: the effects spec's camera
// is #0a0 with a #0f0 dot along its top row, which is the key colour itself,
// in the marker zone. Inference is stubbed with the centred oval, as there.

const CAM = [200, 150, 120];   // #c89678

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { window.__voxalSegStub = true; });
  await page.goto('/');
  await page.evaluate(() => {
    window.__sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__waitFor = async (fn, ms) => {
      const end = Date.now() + ms;
      while (!fn() && Date.now() < end) await window.__sleep(40);
      return fn();
    };
    // A flat, non-green camera, repainted so the capture keeps producing
    // frames. The moving dot stays on the bottom rows, away from the zones
    // and from every point the tests read. `__camColor` can be changed live.
    window.__camColor = '#c89678';
    window.__mkCam = (w = 320, h = 240) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      let n = 0;
      const paint = () => {
        ctx.fillStyle = window.__camColor;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#334';
        ctx.fillRect(40 + (n++ * 3) % (w - 80), h - 3, 2, 2);
      };
      paint();
      const stream = c.captureStream(15);
      const timer = setInterval(paint, 40);
      stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
      return stream;
    };
    // Start a pipeline and hand back its processor as window.__p.
    window.__start = async (mode = 'preset:office', w = 320, h = 240) => {
      window.__raw = window.__mkCam(w, h);
      window.__stream = await VideoEffects.wrap(window.__raw, mode);
      window.__p = window.__stream._effectsProcessor;
      await window.__waitFor(() => window.__p.maskPrimed, 5000);
      return window.__p;
    };
    window.__kpx = (x, y) => Array.from(window.__p.keyed.ctx.getImageData(x, y, 1, 1).data).slice(0, 3);
    window.__gpx = (x, y) => {
      const src = window.__p.canvas;
      const probe = document.createElement('canvas');
      probe.width = src.width; probe.height = src.height;
      const ctx = probe.getContext('2d');
      ctx.drawImage(src, 0, 0);
      return Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3);
    };
    // Count every copy into the keyed canvas.
    window.__countCopies = () => {
      const k = window.__p.keyed;
      k.copies = 0;
      const orig = k.ctx.drawImage.bind(k.ctx);
      k.ctx.drawImage = (...a) => { k.copies++; return orig(...a); };
    };
  });
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => {
    try { VideoEffects.stop(); } catch (e) { /* none running */ }
    try { window.__raw && window.__raw.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
  });
});

test.describe('the setting', () => {
  test('is on by default, stores only "off", and fires its hook when set', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const fired = [];
      VideoEffects.onSubjectOnlyChange((on) => fired.push(on));
      const initial = [VideoEffects.readSubjectOnly(), localStorage.getItem(VideoEffects.SUBJECT_ONLY_KEY)];
      const wrote = VideoEffects.writeSubjectOnly(false);
      const stored = localStorage.getItem('send-subject-only');
      const firedAfterWrite = fired.length;    // writing alone is not a change main.js hears about
      VideoEffects.setSubjectOnly(true);
      const cleared = localStorage.getItem('send-subject-only');
      VideoEffects.setSubjectOnly(false);
      return { key: VideoEffects.SUBJECT_ONLY_KEY, initial, wrote, stored, firedAfterWrite,
        cleared, fired, now: VideoEffects.readSubjectOnly() };
    });
    expect(seen.key).toBe('send-subject-only');
    expect(seen.initial).toEqual([true, null]);
    expect(seen.wrote).toBe(false);
    expect(seen.stored).toBe('off');
    expect(seen.firedAfterWrite).toBe(0);
    // On is an absence, never a stored 'on'.
    expect(seen.cleared).toBe(null);
    expect(seen.fired).toEqual([true, false]);
    expect(seen.now).toBe(false);
  });

  test('only "off" reads as off ("on", from the opt-in build, still reads as on)', async ({ page }) => {
    const seen = await page.evaluate(() => ['off', 'on', 'true', ''].map((v) => {
      localStorage.setItem(VideoEffects.SUBJECT_ONLY_KEY, v);
      return VideoEffects.readSubjectOnly();
    }));
    expect(seen).toEqual([false, true, true, true]);
  });

  test('the toggle renders, stores and fires — or only reports, when given onChange', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const fired = [];
      VideoEffects.onSubjectOnlyChange((on) => fired.push(on));
      const el = document.createElement('div');
      document.body.appendChild(el);
      const t = VideoEffects.renderSubjectOnly(el, { id: 'btn-subject-only-test' });
      const before = [t.button.id, t.button.getAttribute('aria-checked'), t.button.getAttribute('aria-label')];
      t.button.click();
      const after = [t.button.getAttribute('aria-checked'), localStorage.getItem('send-subject-only')];
      localStorage.removeItem('send-subject-only');

      const reported = [];
      const el2 = document.createElement('div');
      const t2 = VideoEffects.renderSubjectOnly(el2, { onChange: (on) => reported.push(on) });
      t2.button.click();
      return { before, after, fired, reported, stillOn: localStorage.getItem('send-subject-only') };
    });
    expect(seen.before).toEqual(['btn-subject-only-test', 'true', 'Let others draw my scene']);
    expect(seen.after).toEqual(['false', 'off']);
    expect(seen.fired).toEqual([false]);
    // onChange replaces the store-and-fire, as for every other toggle.
    expect(seen.reported).toEqual([false]);
    expect(seen.stillOn).toBe(null);
  });

  test('the constants the two ends must agree on', async ({ page }) => {
    const seen = await page.evaluate(() => ({
      cap: VideoEffects.KEYED_CAP, color: VideoEffects.KEY_COLOR,
      marker: VideoEffects.KEY_MARKER, floor: VideoEffects.KEY_ALPHA_FLOOR,
    }));
    expect(seen).toEqual({ cap: 'keyed-video-1', color: [0, 255, 0],
      marker: { zone: 0.1, patch: 0.6 }, floor: 0.06 });
  });
});

test.describe('the keyed frame', () => {
  test('is the key outside, the camera inside, and the markers in the top corners', async ({ page }) => {
    test.setTimeout(60_000);
    const seen = await page.evaluate(async () => {
      const p = await window.__start('preset:office');
      const track = VideoEffects.keyedTrack(window.__stream);
      VideoEffects.setKeyedDemand(window.__stream, 1);
      await window.__sleep(500);
      const state = VideoEffects.keyedState(window.__stream);
      const W = p.canvas.width, H = p.canvas.height, Z = 0.1 * Math.min(W, H);
      return {
        isKeyed: VideoEffects.isKeyedTrack(track),
        compositeIsKeyed: VideoEffects.isKeyedTrack(window.__stream.getVideoTracks()[0]),
        sameAgain: VideoEffects.keyedTrack(window.__stream) === track,
        live: track.readyState,
        size: [W, H, p.keyed.canvas.width, p.keyed.canvas.height],
        state,
        outside: window.__kpx(4, H >> 1),
        inside: window.__kpx(W >> 1, Math.round(H * 0.6)),
        tl: [window.__kpx(1, 1), window.__kpx(Math.floor(Z / 2), Math.floor(Z / 2)), window.__kpx(Math.floor(Z) - 1, Math.floor(Z) - 1)],
        // The ring around the patch, and the patch itself.
        ring: [window.__kpx(W - Math.floor(Z), 1), window.__kpx(W - 1, 1), window.__kpx(W - 1, Math.floor(Z) - 1)],
        patch: [window.__kpx(Math.floor(W - Z / 2), Math.floor(Z / 2)), window.__kpx(Math.floor(W - Z / 2) - 6, Math.floor(Z / 2) + 6)],
        belowZones: [window.__kpx(2, Math.ceil(Z) + 1), window.__kpx(W - 3, Math.ceil(Z) + 1)],
        // And the composite on the GL canvas is still the composite.
        compositeOutside: window.__gpx(4, H >> 1),
        context: p.gl.getContextAttributes().desynchronized,
      };
    });
    expect(seen.isKeyed).toBe(true);
    expect(seen.compositeIsKeyed).toBe(false);
    expect(seen.sameAgain).toBe(true);
    expect(seen.live).toBe('live');
    expect(seen.size).toEqual([320, 240, 320, 240]);
    expect(seen.state.scene).toBe('office');
    expect(seen.state.reason).toBe(null);
    expect(seen.state.size).toEqual([320, 240]);
    expect(Object.keys(seen.state.look).sort()).toEqual(['dirX', 'dirY', 'exposure', 'hard', 'side', 'tint']);
    expect(seen.state.look.tint).toHaveLength(3);
    expect(seen.state.edgeE).toBeLessThanOrEqual(0);
    // Exactly the key: the faint tail of the room never leaves the device.
    expect(seen.outside).toEqual([0, 255, 0]);
    // The camera, untouched by the scene's light: no wrap at the receiver's
    // expense, and no scene behind it.
    seen.inside.forEach((v, i) => expect(Math.abs(v - [200, 150, 120][i])).toBeLessThanOrEqual(3));
    seen.tl.forEach((px) => expect(px).toEqual([0, 255, 0]));
    seen.ring.forEach((px) => expect(px).toEqual([0, 255, 0]));
    seen.patch.forEach((px) => expect(px).toEqual([0, 0, 0]));
    seen.belowZones.forEach((px) => expect(px).toEqual([0, 255, 0]));
    // The GL canvas keeps publishing the composite: a scene, not the key.
    expect(seen.compositeOutside).not.toEqual([0, 255, 0]);
    expect(seen.context).toBe(false);
  });

  test('in the edge band its alpha is the composite\'s own, sharpened and floored, with no wrap and no shadow', async ({ page }) => {
    test.setTimeout(60_000);
    // Island has both a light wrap and a shadow: if either leaked into the
    // keyed frame, the band would not be mix(K, camera, m).
    const seen = await page.evaluate(async () => {
      const p = await window.__start('preset:island');
      VideoEffects.keyedTrack(window.__stream);
      VideoEffects.setKeyedDemand(window.__stream, 1);
      await window.__sleep(500);
      const gl = p.gl, MW = p.segW, MH = p.segH;
      const buf = new Uint8Array(MW * MH * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, p.fbMaskA);
      gl.readPixels(0, 0, MW, MH, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      // The composite samples the mask bilinearly at `flip`; so does this.
      const texel = (i, j) => buf[(Math.min(MH - 1, Math.max(0, j)) * MW + Math.min(MW - 1, Math.max(0, i))) * 4] / 255;
      const mask = (u, v) => {
        const x = u * MW - 0.5, y = v * MH - 0.5, i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
        return (texel(i, j) * (1 - fx) + texel(i + 1, j) * fx) * (1 - fy) + (texel(i, j + 1) * (1 - fx) + texel(i + 1, j + 1) * fx) * fy;
      };
      const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
      const W = p.canvas.width, H = p.canvas.height, Z = 0.1 * Math.min(W, H);
      const C = window.__kpx(W >> 1, Math.round(H * 0.6));
      const d = p.keyed.ctx.getImageData(0, 0, W, H).data;
      let band = 0, worst = 0, floored = 0, floorMiss = 0, interior = 0;
      for (let y = Math.ceil(Z); y < H - 4; y++) {
        for (let x = 0; x < W; x++) {
          // The keyed frame narrows the user's edge once more (KEY_MATTE_EDGE).
          const m = ss(VideoEffects.KEY_MATTE_EDGE[0], VideoEffects.KEY_MATTE_EDGE[1],
            ss(p.edge.lo, p.edge.hi, mask((x + 0.5) / W, (y + 0.5) / H)));
          const o = (y * W + x) * 4;
          if (m < 0.055) {
            floored++;
            if (d[o] !== 0 || d[o + 1] !== 255 || d[o + 2] !== 0) floorMiss++;
          } else if (m > 0.065 && m < 0.995) {
            band++;
            const want = [C[0] * m, 255 * (1 - m) + C[1] * m, C[2] * m];
            for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(d[o + c] - want[c]));
          } else if (m >= 0.995) {
            interior++;
          }
        }
      }
      // Turning the scene's wrap and shadow off must not move a keyed pixel.
      const before = Array.from(d);
      p.scene = Object.assign({}, p.scene, { wrap: 0, shadow: 0 });
      await window.__sleep(300);
      const after = p.keyed.ctx.getImageData(0, 0, W, H).data;
      // The fake camera's dot runs along the bottom rows and may have moved
      // between the two reads (how far depends on the frame timing): leave
      // those rows out, as the band above does.
      let moved = 0;
      for (let i = 0; i < W * (H - 4) * 4; i++) moved = Math.max(moved, Math.abs(before[i] - after[i]));
      return { band, worst, floored, floorMiss, interior, moved };
    });
    expect(seen.band).toBeGreaterThan(100);
    expect(seen.interior).toBeGreaterThan(1000);
    expect(seen.floored).toBeGreaterThan(1000);
    expect(seen.floorMiss).toBe(0);
    expect(seen.worst).toBeLessThanOrEqual(3);
    // The dot on the bottom rows moves between the two reads; nothing else may.
    expect(seen.moved).toBeLessThanOrEqual(1);
  });

  test('a portrait frame sizes its zones from the short side', async ({ page }) => {
    test.setTimeout(60_000);
    const seen = await page.evaluate(async () => {
      const p = await window.__start('preset:office', 240, 320);
      VideoEffects.keyedTrack(window.__stream);
      VideoEffects.setKeyedDemand(window.__stream, 1);
      await window.__sleep(500);
      const W = p.canvas.width, H = p.canvas.height;
      // Z = 0.1 * 240 = 24, not 32: the zones end at row 23 and column 23.
      return { size: [W, H], inZone: window.__kpx(22, 22), pastZone: window.__kpx(25, 25),
        patch: window.__kpx(W - 12, 12), rightOfPatchRow: window.__kpx(W - 12, 26) };
    });
    expect(seen.size).toEqual([240, 320]);
    expect(seen.inZone).toEqual([0, 255, 0]);
    expect(seen.patch).toEqual([0, 0, 0]);
    // Below the zone the subject is far away: plain key, not the patch.
    expect(seen.rightOfPatchRow).toEqual([0, 255, 0]);
    expect(seen.pastZone).toEqual([0, 255, 0]);
  });
});

test.describe('when keying is withheld', () => {
  test('blur sends the plain composite on the keyed track, with no markers', async ({ page }) => {
    test.setTimeout(60_000);
    const seen = await page.evaluate(async () => {
      const p = await window.__start('blur');
      VideoEffects.keyedTrack(window.__stream);
      VideoEffects.setKeyedDemand(window.__stream, 1);
      await window.__sleep(400);
      const W = p.canvas.width, H = p.canvas.height;
      return { state: VideoEffects.keyedState(window.__stream),
        tl: window.__kpx(5, 5), patch: window.__kpx(W - 12, 12), outside: window.__kpx(4, H >> 1),
        composite: window.__gpx(4, H >> 1) };
    });
    expect(seen.state.scene).toBe(null);
    expect(seen.state.reason).toBe('mode');
    // The blurred room, as the composite shows it: a flat camera blurs to itself.
    for (const px of [seen.tl, seen.patch, seen.outside]) {
      px.forEach((v, i) => expect(Math.abs(v - CAM[i])).toBeLessThanOrEqual(4));
    }
    seen.outside.forEach((v, i) => expect(Math.abs(v - seen.composite[i])).toBeLessThanOrEqual(2));
  });

  test('no demand, no keyed pass: nothing is drawn or copied until a sender is on it', async ({ page }) => {
    test.setTimeout(60_000);
    const seen = await page.evaluate(async () => {
      const p = await window.__start('preset:office');
      VideoEffects.keyedTrack(window.__stream);
      window.__countCopies();
      await window.__sleep(500);
      const idle = p.keyed.copies;
      VideoEffects.setKeyedDemand(window.__stream, 2);
      // Rising demand draws one keyed frame at once, before any frame callback.
      const atOnce = p.keyed.copies;
      const tlAtOnce = window.__kpx(5, 5);
      // Then one per frame (a software GPU draws a scene at a few a second).
      await window.__waitFor(() => p.keyed.copies >= 3, 5000);
      const running = p.keyed.copies;
      VideoEffects.setKeyedDemand(window.__stream, 0);
      const stopAt = p.keyed.copies;
      await window.__sleep(400);
      return { idle, atOnce, tlAtOnce, running, stopped: p.keyed.copies - stopAt };
    });
    expect(seen.idle).toBe(0);
    expect(seen.atOnce).toBe(1);
    expect(seen.tlAtOnce).toEqual([0, 255, 0]);
    expect(seen.running).toBeGreaterThanOrEqual(3);
    expect(seen.stopped).toBe(0);
  });

  test('a keyed frame that fails its own read-back check is never sent, and keying stays off', async ({ page }) => {
    test.setTimeout(60_000);
    const seen = await page.evaluate(async () => {
      const p = await window.__start('preset:office');
      VideoEffects.keyedTrack(window.__stream);
      // The copy "works" but reads back as something else: a browser whose
      // canvas path mangles the key.
      const ctx = p.keyed.ctx;
      const real = ctx.getImageData.bind(ctx);
      ctx.getImageData = (x, y, w, h) => (w === 1 && h === 1)
        ? { data: new Uint8ClampedArray([12, 200, 30, 255]) } : real(x, y, w, h);
      VideoEffects.setKeyedDemand(window.__stream, 1);
      const state = VideoEffects.keyedState(window.__stream);
      ctx.getImageData = real;
      const tlNow = window.__kpx(5, 5);
      await window.__sleep(400);
      return { state, tlNow, tlLater: window.__kpx(5, 5), checked: p.keyed.checked, failed: p.keyed.failed };
    });
    expect(seen.checked).toBe(true);
    expect(seen.failed).toBe(true);
    expect(seen.state.scene).toBe(null);
    expect(seen.state.reason).toBe('self-check');
    // Not even the frame that failed went out: the canvas was re-copied from
    // the composite.
    expect(seen.tlNow).not.toEqual([0, 255, 0]);
    expect(seen.tlLater).not.toEqual([0, 255, 0]);
  });

  test('a real browser passes its own self-check', async ({ page }) => {
    test.setTimeout(60_000);
    const seen = await page.evaluate(async () => {
      const p = await window.__start('preset:office');
      VideoEffects.keyedTrack(window.__stream);
      VideoEffects.setKeyedDemand(window.__stream, 1);
      await window.__sleep(200);
      return { checked: p.keyed.checked, failed: p.keyed.failed, reason: VideoEffects.keyedState(window.__stream).reason };
    });
    expect(seen).toEqual({ checked: true, failed: false, reason: null });
  });

  test('a green subject withholds keying, and only a while after it is gone does keying resume', async ({ page }) => {
    test.setTimeout(60_000);
    const seen = await page.evaluate(async () => {
      await window.__start('preset:office');
      VideoEffects.keyedTrack(window.__stream);
      VideoEffects.setKeyedDemand(window.__stream, 1);
      await window.__sleep(400);
      const before = VideoEffects.keyedState(window.__stream).reason;
      window.__camColor = '#2a8c3a';            // a green shirt filling the frame
      const went = await window.__waitFor(() => VideoEffects.keyedState(window.__stream).reason === 'green', 3000);
      const keyedTl = window.__kpx(5, 5);
      window.__camColor = '#c89678';
      const back = performance.now();
      await window.__sleep(2500);
      const stillHeld = VideoEffects.keyedState(window.__stream).reason;
      await window.__waitFor(() => VideoEffects.keyedState(window.__stream).reason === null, 6000);
      return { before, went, keyedTl, stillHeld, resumedAfter: performance.now() - back,
        state: VideoEffects.keyedState(window.__stream) };
    });
    expect(seen.before).toBe(null);
    expect(seen.went).toBe(true);
    // Withheld means the composite, unmarked: no key in the corner.
    expect(seen.keyedTl).not.toEqual([0, 255, 0]);
    expect(seen.stillHeld).toBe('green');
    expect(seen.resumedAfter).toBeGreaterThanOrEqual(4800);
    expect(seen.state.reason).toBe(null);
    expect(seen.state.scene).toBe('office');
  });

  test('a subject covering a marker corner withholds keying, with its own hysteresis', async ({ page }) => {
    test.setTimeout(60_000);
    const seen = await page.evaluate(async () => {
      await window.__start('preset:office');
      VideoEffects.keyedTrack(window.__stream);
      VideoEffects.setKeyedDemand(window.__stream, 1);
      await window.__sleep(300);
      const before = VideoEffects.keyedState(window.__stream).reason;
      window.__voxalSegStub = { full: true };
      const went = await window.__waitFor(() => VideoEffects.keyedState(window.__stream).reason === 'corner', 3000);
      const tl = window.__kpx(5, 5);
      window.__voxalSegStub = true;
      const back = performance.now();
      await window.__sleep(1000);
      const stillHeld = VideoEffects.keyedState(window.__stream).reason;
      await window.__waitFor(() => VideoEffects.keyedState(window.__stream).reason === null, 4000);
      return { before, went, tl, stillHeld, resumedAfter: performance.now() - back,
        reason: VideoEffects.keyedState(window.__stream).reason };
    });
    expect(seen.before).toBe(null);
    expect(seen.went).toBe(true);
    // The composite: the person, not a square of key over their head.
    expect(seen.tl).not.toEqual([0, 255, 0]);
    expect(seen.stillHeld).toBe('corner');
    expect(seen.resumedAfter).toBeGreaterThanOrEqual(1800);
    expect(seen.reason).toBe(null);
  });

  test('a scene still compiling says so, and the composite goes out meanwhile', async ({ page }) => {
    test.setTimeout(60_000);
    const seen = await page.evaluate(async () => {
      const p = await window.__start('blur');
      VideoEffects.keyedTrack(window.__stream);
      VideoEffects.setKeyedDemand(window.__stream, 1);
      const picked = VideoEffects.setMode('preset:mountain');
      const during = VideoEffects.keyedState(window.__stream);
      await picked;
      await window.__sleep(200);
      return { during, after: VideoEffects.keyedState(window.__stream), scene: p.sceneId };
    });
    expect(seen.during.reason).toBe('compiling');
    expect(seen.during.scene).toBe(null);
    expect(seen.after.reason).toBe(null);
    expect(seen.after.scene).toBe('mountain');
  });
});

test.describe('who gets a keyed output, and for how long', () => {
  test('only a stream that asks for one: the preview and the raw camera never do', async ({ page }) => {
    test.setTimeout(60_000);
    const seen = await page.evaluate(async () => {
      const p = await window.__start('preset:office');
      // Demand without a track asked for is nothing at all.
      VideoEffects.setKeyedDemand(window.__stream, 3);
      await window.__sleep(300);
      return {
        keyed: p.keyed,
        state: VideoEffects.keyedState(window.__stream),
        rawTrack: VideoEffects.keyedTrack(window.__raw),
        rawState: VideoEffects.keyedState(window.__raw),
        none: VideoEffects.keyedTrack(null),
        // Never the running pipeline by default, the way setPaused() and
        // setSource() reach it: that is how a settings preview would get one.
        implicit: [VideoEffects.keyedTrack(), VideoEffects.keyedState(), p.keyed],
        notKeyed: VideoEffects.isKeyedTrack(window.__raw.getVideoTracks()[0]),
      };
    });
    expect(seen.keyed).toBe(null);
    expect(seen.state).toBe(null);
    expect(seen.rawTrack).toBe(null);
    expect(seen.rawState).toBe(null);
    expect(seen.none).toBe(null);
    expect(seen.implicit).toEqual([null, null, null]);
    expect(seen.notKeyed).toBe(false);
  });

  test('the keyed track follows the pause, and dies with the pipeline', async ({ page }) => {
    test.setTimeout(60_000);
    const seen = await page.evaluate(async () => {
      await window.__start('preset:office');
      VideoEffects.setPaused(true);
      const track = VideoEffects.keyedTrack(window.__stream);
      const createdPaused = track.enabled;
      VideoEffects.setPaused(false);
      const resumed = track.enabled;
      VideoEffects.stop(window.__stream);
      return { createdPaused, resumed, after: track.readyState, stillKnown: VideoEffects.isKeyedTrack(track),
        state: VideoEffects.keyedState(window.__stream), again: VideoEffects.keyedTrack(window.__stream) };
    });
    expect(seen.createdPaused).toBe(false);
    expect(seen.resumed).toBe(true);
    expect(seen.after).toBe('ended');
    // Still recognisable after the pipeline is gone: that is exactly when
    // main.js needs to find the senders that were on it.
    expect(seen.stillKnown).toBe(true);
    expect(seen.state).toBe(null);
    expect(seen.again).toBe(null);
  });

  test('the state hook fires on a scene change, and not for a rebuild in between', async ({ page }) => {
    test.setTimeout(90_000);
    const seen = await page.evaluate(async () => {
      const p = await window.__start('preset:office');
      VideoEffects.keyedTrack(window.__stream);
      VideoEffects.setKeyedDemand(window.__stream, 1);
      const log = [];
      VideoEffects.onKeyedState((s) => {
        const st = VideoEffects.keyedState(s);
        log.push({ same: s === window.__stream, scene: st.scene, reason: st.reason, size: st.size });
      });
      await window.__sleep(400);
      const quiet = log.length;
      await VideoEffects.setMode('preset:island');
      await window.__waitFor(() => log.length > quiet, 2000);
      const afterPick = log.slice();
      // A camera with another capture size: releaseGL + initGL + a recompile,
      // during which the scene is briefly gone. Nobody hears about that.
      const other = window.__mkCam(480, 360);
      await VideoEffects.setSource(other);
      await window.__waitFor(() => log.length > afterPick.length && p.sceneId === 'island' && !p.rebuilding, 20000);
      await window.__sleep(300);
      other.getTracks().forEach((t) => t.stop());
      return { quiet, afterPick, all: log, keyedSize: [p.keyed.canvas.width, p.keyed.canvas.height] };
    });
    // Nothing to say while nothing changed (the creation itself is not news:
    // main.js has just read the state).
    expect(seen.quiet).toBe(0);
    expect(seen.afterPick).toEqual([{ same: true, scene: 'island', reason: null, size: [320, 240] }]);
    const rebuild = seen.all.slice(seen.afterPick.length);
    expect(rebuild.every((e) => e.scene === 'island' && e.reason === null)).toBe(true);
    expect(rebuild[rebuild.length - 1].size).toEqual([480, 360]);
    expect(seen.keyedSize).toEqual([480, 360]);
  });
});

test.describe('the pipeline\'s own hygiene', () => {
  test('destroy loses the WebGL context instead of leaving it to the collector', async ({ page }) => {
    test.setTimeout(60_000);
    const seen = await page.evaluate(async () => {
      const p = await window.__start('preset:office');
      const gl = p.gl, canvas = p.canvas;
      VideoEffects.stop(window.__stream);
      return { lost: gl.isContextLost(), size: [canvas.width, canvas.height], gl: p.gl };
    });
    expect(seen.lost).toBe(true);
    expect(seen.size).toEqual([0, 0]);
    expect(seen.gl).toBe(null);
  });

  test('a context the browser takes away gives up out loud, as an overload', async ({ page }) => {
    test.setTimeout(60_000);
    const seen = await page.evaluate(async () => {
      const why = [];
      VideoEffects.onOverload((w) => why.push(w));
      const p = await window.__start('preset:office');
      p.gl.getExtension('WEBGL_lose_context').loseContext();
      await window.__waitFor(() => why.length > 0, 2000);
      return { why, gaveUp: p.gaveUp };
    });
    expect(seen.why).toEqual(['context-lost']);
    expect(seen.gaveUp).toBe(true);
  });

  test('a slow window asks the pressure hook before stepping its own ladder', async ({ page }) => {
    test.setTimeout(60_000);
    const seen = await page.evaluate(async () => {
      const p = await window.__start('preset:office');
      VideoEffects.setPaused(true);      // keep the real loop from measuring meanwhile
      const asked = [];
      let answer = true;
      VideoEffects.onPressure(() => { asked.push(p.segStep); return answer; });
      const slowWindow = () => {
        const now = performance.now();
        p.windowStart = now - 5100;
        p.frames = 3;                     // far under 60% of the target rate
        p.measure(now);
      };
      const step0 = p.segStep;
      slowWindow();
      const afterShed = p.segStep;
      answer = false;
      slowWindow();
      const afterNoShed = p.segStep;
      VideoEffects.onPressure(null);
      return { asked, step0, afterShed, afterNoShed };
    });
    expect(seen.asked).toEqual([0, 0]);
    // Load shed elsewhere: this window is not held against the pipeline.
    expect(seen.afterShed).toBe(seen.step0);
    expect(seen.afterNoShed).toBe(seen.step0 + 1);
  });

  // Chromium (141) takes the whole tab down when a <video> is pointed at a
  // stream with no frame yet in the same task as one of its frame callbacks,
  // while a callback is registered — and it makes no difference whether that
  // callback was asked for before the switch or after it. So the switch lands
  // at the start of a frame callback here, and the pipeline's own onFrame()
  // then asks for its next frame: the loop must be held, not merely cancelled.
  test('a camera swapped inside a frame callback, before it has a frame, crashes nothing and is drawn once it has one', async ({ page }) => {
    test.setTimeout(60_000);
    const seen = await page.evaluate(async () => {
      const p = await window.__start('preset:office');
      // A camera still opening: nothing painted before the capture is taken,
      // or the canvas hands over its picture at once.
      const c = document.createElement('canvas');
      c.width = 320; c.height = 240;
      const ctx = c.getContext('2d');
      const quiet = c.captureStream(0);
      let flipped = null;
      await new Promise((resolve) => {
        const proto = HTMLVideoElement.prototype, real = proto.requestVideoFrameCallback;
        proto.requestVideoFrameCallback = function (cb) {
          proto.requestVideoFrameCallback = real;
          return real.call(this, (now, meta) => {
            flipped = VideoEffects.setSource(quiet);
            cb(now, meta);
            resolve();
          });
        };
      });
      await window.__sleep(600);
      const waiting = { held: p._held, rvfc: p._rvfc, raf: p._raf };
      const t = p.lastDraw;
      let n = 0;
      const timer = setInterval(() => {
        ctx.fillStyle = window.__camColor;
        ctx.fillRect(0, 0, 320, 240);
        ctx.fillStyle = '#334';
        ctx.fillRect(40 + (n++ * 3) % 240, 237, 2, 2);
        quiet.getVideoTracks()[0].requestFrame();
      }, 40);
      await flipped;
      const drew = await window.__waitFor(() => p.lastDraw > t, 5000);
      const out = { waiting, drew, held: p._held, original: window.__stream._effectsOriginal === quiet };
      clearInterval(timer);
      quiet.getTracks().forEach((tr) => tr.stop());
      return out;
    });
    expect(seen.waiting).toEqual({ held: true, rvfc: 0, raf: 0 });
    expect(seen.drew).toBe(true);
    expect(seen.held).toBe(false);
    expect(seen.original).toBe(true);
  });
});
