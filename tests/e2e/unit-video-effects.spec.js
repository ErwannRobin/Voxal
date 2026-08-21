import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// Background blur and virtual backgrounds: the stored preference, the shared
// chip picker, and — the part that actually matters — exactly when the outgoing
// video track is swapped and when it is not.
//
// The whole point of routing the camera through a canvas is that the published
// track stops changing: once wrapped, switching blur → image → other image is a
// texture swap inside the shader, so peers see no renegotiation and no tile
// flicker. A regression there is invisible locally and obvious to everyone else
// in the call, which is why several tests below assert on replaceTrack counts.
//
// MediaPipe itself cannot run here — the ~12 MB runtime is staged by the build
// and headless GPU inference is not something to hang a deterministic suite on
// — so `window.__voxalSegStub` swaps inference for a fixed mask and leaves the
// GL passes, the captureStream and the teardown real. Same bargain
// unit-rnnoise-worklet.spec.js strikes for the audio worklet.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { window.__voxalSegStub = true; });
  await page.goto('/');
  await page.evaluate(() => {
    window.__mkVideoStream = function () {
      const c = document.createElement('canvas');
      c.width = 320; c.height = 240;
      const ctx = c.getContext('2d');
      let n = 0;
      const paint = () => {
        ctx.fillStyle = '#0a0';
        ctx.fillRect(0, 0, 320, 240);
        // A moving pixel: a canvas with no new drawing operations emits a
        // single frame and the capture stalls, which would stall the pipeline
        // under test rather than exercise it.
        ctx.fillStyle = '#0f0';
        ctx.fillRect((n++ * 7) % 320, 0, 2, 2);
      };
      paint();
      const stream = c.captureStream(15);
      const timer = setInterval(paint, 40);
      stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
      return stream;
    };
    window.__gumFail = null;
    navigator.mediaDevices.getUserMedia = function () {
      if (window.__gumFail) return Promise.reject(window.__gumFail);
      return Promise.resolve(window.__mkVideoStream());
    };
    navigator.mediaDevices.enumerateDevices = () => Promise.resolve([
      { kind: 'videoinput', deviceId: 'cam-1', label: 'Front' },
      { kind: 'videoinput', deviceId: 'cam-2', label: 'Back' },
    ]);
    localStorage.setItem('video-routing-mode', 'p2p-only');
    localStorage.removeItem('video-background');
  });
});

/**
 * A room with one peer whose video sender we can watch. `__swaps` records every
 * replaceTrack, which is how the "no renegotiation" claims below are checked.
 */
async function seedEffectsRoom(page) {
  await seedRoom(page, {
    selfId: 'host',
    isHost: true,
    connections: [{ id: 'p1', pseudo: 'Ada' }],
  });
  await page.evaluate(() => {
    window.__swaps = [];
    window.__calls = [];
    const sender = {
      track: { kind: 'video' },
      replaceTrack(t) { window.__swaps.push(t); this.track = t; return Promise.resolve(); },
    };
    window.__sender = sender;
    peer = {
      id: 'host',
      destroyed: false,
      call(peerId, stream, opts) {
        const handlers = {};
        const c = {
          peer: peerId,
          metadata: opts && opts.metadata,
          closed: false,
          peerConnection: {
            getSenders: () => [sender],
            getStats: () => Promise.resolve(new Map()),
          },
          close() { this.closed = true; },
          on(e, fn) { (handlers[e] = handlers[e] || []).push(fn); },
          emit(e, a) { (handlers[e] || []).forEach((fn) => fn(a)); },
        };
        window.__calls.push(c);
        return c;
      },
    };
    videoModeEnabled = true;
  });
}

test.describe('the background preference', () => {
  test('defaults to off and round-trips through localStorage', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const initial = VideoEffects.readMode();
      VideoEffects.writeMode('blur');
      const blur = [VideoEffects.readMode(), localStorage.getItem('video-background')];
      VideoEffects.writeMode('preset:aurora');
      const preset = VideoEffects.readMode();
      VideoEffects.writeMode('off');
      return { initial, blur, preset, cleared: localStorage.getItem('video-background') };
    });
    expect(seen.initial).toBe('off');
    expect(seen.blur).toEqual(['blur', 'blur']);
    expect(seen.preset).toBe('preset:aurora');
    // 'off' is the absence of a preference, not a stored value.
    expect(seen.cleared).toBe(null);
  });

  test('an unknown or stale mode falls back to off rather than a black frame', async ({ page }) => {
    const seen = await page.evaluate(() => [
      VideoEffects.normalizeMode('preset:no-such-image'),
      VideoEffects.normalizeMode('nonsense'),
      VideoEffects.normalizeMode(''),
      VideoEffects.normalizeMode('preset:aurora'),
    ]);
    expect(seen).toEqual(['off', 'off', 'off', 'preset:aurora']);
  });
});

test.describe('the picker', () => {
  test.beforeEach(async ({ page }) => {
    await page.click('#btn-open-settings');
    // At this width the modal is sidebar-driven: every card but the selected
    // one carries `hidden-by-sidebar`.
    await page.click('#modal-settings [data-target="settings-video"]');
  });

  test('offers none, blur, every preset and a custom slot', async ({ page }) => {
    const modes = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#settings-bg-picker .bg-chip'))
        .map((c) => c.dataset.mode));
    expect(modes).toEqual([
      'off', 'blur', 'preset:aurora', 'preset:dusk', 'preset:studio', 'preset:linen', 'custom',
    ]);
  });

  test('picking a chip stores the mode and marks it checked', async ({ page }) => {
    await page.click('#settings-bg-picker .bg-chip[data-mode="blur"]');
    await expect(page.locator('#settings-bg-picker .bg-chip[data-mode="blur"]'))
      .toHaveAttribute('aria-checked', 'true');
    expect(await page.evaluate(() => localStorage.getItem('video-background'))).toBe('blur');

    // Exactly one chip is ever checked — it is a radiogroup, not a set of toggles.
    await page.click('#settings-bg-picker .bg-chip[data-mode="preset:dusk"]');
    const checked = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#settings-bg-picker .bg-chip'))
        .filter((c) => c.getAttribute('aria-checked') === 'true')
        .map((c) => c.dataset.mode));
    expect(checked).toEqual(['preset:dusk']);
  });

  test('both pickers stay in step, since they share one source of truth', async ({ page }) => {
    await page.click('#settings-bg-picker .bg-chip[data-mode="blur"]');
    await expect(page.locator('#video-bg-picker .bg-chip[data-mode="blur"]'))
      .toHaveAttribute('aria-checked', 'true');
  });
});

test.describe('the room control', () => {
  test.beforeEach(async ({ page }) => {
    await page.evaluate(() => showScreen('room'));
  });

  // The control belongs to your camera, not to the room, so it rides on the
  // self-view tile beside the flip button rather than sitting in the bottom bar.
  test('rides on the self-view tile, and only once a camera is running', async ({ page }) => {
    await seedEffectsRoom(page);
    await page.evaluate(() => { updateVideoModeUI(); });
    expect(await page.locator('.video-tile-bg').count()).toBe(0);

    await page.evaluate(() => startVideoShare());
    const btn = page.locator('.video-tile-self.video-tile-camera .video-tile-bg');
    await expect(btn).toBeVisible();
    // Next to the flip control, on the tile — not in the room's control row.
    expect(await page.locator('.ctrl-row .video-tile-bg').count()).toBe(0);
    expect(await page.evaluate(() =>
      !!document.querySelector('.video-tile-self .video-tile-bg')
      && !!document.querySelector('.video-tile-self .video-tile-flip'))).toBe(true);

    await page.evaluate(() => stopVideoShare());
    await expect(page.locator('.video-tile-self.video-tile-camera .video-tile-bg')).toHaveCount(0);
  });

  test('is icon-only', async ({ page }) => {
    await seedEffectsRoom(page);
    await page.evaluate(() => startVideoShare());
    const btn = page.locator('.video-tile-self.video-tile-camera .video-tile-bg');
    // No label text — the affordance is the icon plus the tooltip.
    expect((await btn.innerText()).trim()).toBe('');
    await expect(btn).toHaveAttribute('aria-label', /background/i);
  });

  test('stays hidden where the pipeline cannot run', async ({ page }) => {
    await seedEffectsRoom(page);
    await page.evaluate(async () => {
      await startVideoShare();
      // Pretend this device has no WebGL2; the probe result is cached, so
      // override the accessor the way an unsupported webview would behave.
      VideoEffects.isSupported = () => false;
      updatePeerList();
    });
    await expect(page.locator('.video-tile-self.video-tile-camera .video-tile-bg')).toBeHidden();
  });

  test('opens a popover anchored to it, and closes on Escape', async ({ page }) => {
    await seedEffectsRoom(page);
    await page.evaluate(() => startVideoShare());
    await expect(page.locator('#video-bg-popover')).toBeHidden();

    await page.locator('.video-tile-self.video-tile-camera .video-tile-bg').click();
    await expect(page.locator('#video-bg-popover')).toBeVisible();

    // Anchored, not parked in a corner: the popover sits near its button and
    // inside the viewport.
    const fits = await page.evaluate(() => {
      const pop = document.getElementById('video-bg-popover').getBoundingClientRect();
      const btn = document.querySelector('.video-tile-self .video-tile-bg').getBoundingClientRect();
      return {
        inViewport: pop.left >= 0 && pop.top >= 0 &&
                    pop.right <= innerWidth + 1 && pop.bottom <= innerHeight + 1,
        near: Math.abs((pop.left + pop.width / 2) - (btn.left + btn.width / 2)) < pop.width,
      };
    });
    expect(fits).toEqual({ inViewport: true, near: true });

    await page.keyboard.press('Escape');
    await expect(page.locator('#video-bg-popover')).toBeHidden();
  });
});

test.describe('turning the effect on and off mid-call', () => {
  test('turning it on swaps the sender to the composited track', async ({ page }) => {
    await seedEffectsRoom(page);
    const seen = await page.evaluate(async () => {
      await startVideoShare();
      const rawStream = localVideoStream;
      window.__swaps = [];
      await applyVideoBackground('blur');
      return {
        swaps: window.__swaps.length,
        wrapped: !!localVideoStream._effectsProcessor,
        // The raw camera is kept alive behind the canvas, not stopped.
        rawKept: localVideoStream._effectsOriginal === rawStream,
        rawLive: rawStream.getVideoTracks()[0].readyState === 'live',
        senderIsCanvas: window.__sender.track === localVideoStream.getVideoTracks()[0],
        stored: localStorage.getItem('video-background'),
      };
    });
    expect(seen.swaps).toBe(1);
    expect(seen.wrapped).toBe(true);
    expect(seen.rawKept).toBe(true);
    expect(seen.rawLive).toBe(true);
    expect(seen.senderIsCanvas).toBe(true);
    expect(seen.stored).toBe('blur');
  });

  // The reason this whole design routes through a canvas. If this ever starts
  // swapping tracks, every peer's tile blinks each time somebody browses the
  // background chips.
  test('changing between backgrounds swaps nothing on the wire', async ({ page }) => {
    await seedEffectsRoom(page);
    const seen = await page.evaluate(async () => {
      await startVideoShare();
      await applyVideoBackground('blur');
      const track = localVideoStream.getVideoTracks()[0];
      window.__swaps = [];
      await applyVideoBackground('preset:aurora');
      await applyVideoBackground('preset:studio');
      await applyVideoBackground('blur');
      return {
        swaps: window.__swaps.length,
        sameTrack: localVideoStream.getVideoTracks()[0] === track,
        mode: VideoEffects.active().mode,
      };
    });
    expect(seen.swaps).toBe(0);
    expect(seen.sameTrack).toBe(true);
    expect(seen.mode).toBe('blur');
  });

  test('turning it off puts the real camera back and tears the pipeline down', async ({ page }) => {
    await seedEffectsRoom(page);
    const seen = await page.evaluate(async () => {
      await startVideoShare();
      const rawStream = localVideoStream;
      await applyVideoBackground('blur');
      const canvasTrack = localVideoStream.getVideoTracks()[0];
      window.__swaps = [];
      await applyVideoBackground('off');
      return {
        swaps: window.__swaps.length,
        backToRaw: localVideoStream === rawStream,
        rawLive: rawStream.getVideoTracks()[0].readyState === 'live',
        canvasStopped: canvasTrack.readyState === 'ended',
        senderIsRaw: window.__sender.track === rawStream.getVideoTracks()[0],
        processorGone: VideoEffects.active() === null,
      };
    });
    expect(seen.swaps).toBe(1);
    expect(seen.backToRaw).toBe(true);
    expect(seen.rawLive).toBe(true);
    expect(seen.canvasStopped).toBe(true);
    expect(seen.senderIsRaw).toBe(true);
    expect(seen.processorGone).toBe(true);
  });

  test('a preference set before sharing is applied when the camera starts', async ({ page }) => {
    await seedEffectsRoom(page);
    const seen = await page.evaluate(async () => {
      VideoEffects.writeMode('preset:linen');
      await startVideoShare();
      return {
        wrapped: !!localVideoStream._effectsProcessor,
        mode: VideoEffects.active().mode,
        published: window.__calls.map((c) => c.metadata.type),
      };
    });
    expect(seen.wrapped).toBe(true);
    expect(seen.mode).toBe('preset:linen');
    expect(seen.published).toEqual(['video']);
  });

  test('a pipeline that will not start leaves the plain camera sharing', async ({ page }) => {
    await seedEffectsRoom(page);
    const seen = await page.evaluate(async () => {
      window.__voxalSegStub = { fail: true };
      await startVideoShare();
      return {
        active: localVideoActive,
        wrapped: !!localVideoStream._effectsProcessor,
        shared: !!localVideoStream,
      };
    });
    // A background effect is a nicety; it must never be why a camera fails.
    expect(seen).toEqual({ active: true, wrapped: false, shared: true });
  });
});

test.describe('the effect and the rest of the camera lifecycle', () => {
  test('stopping the share releases the camera behind the canvas', async ({ page }) => {
    await seedEffectsRoom(page);
    const seen = await page.evaluate(async () => {
      VideoEffects.writeMode('blur');
      await startVideoShare();
      const rawTrack = localVideoStream._effectsOriginal.getVideoTracks()[0];
      const canvasTrack = localVideoStream.getVideoTracks()[0];
      stopVideoShare();
      return {
        raw: rawTrack.readyState,
        canvas: canvasTrack.readyState,
        processorGone: VideoEffects.active() === null,
        stream: localVideoStream,
      };
    });
    // The failure this guards against is the video twin of the RNNoise one:
    // stopping the canvas track alone leaves the camera light on.
    expect(seen.raw).toBe('ended');
    expect(seen.canvas).toBe('ended');
    expect(seen.processorGone).toBe(true);
    expect(seen.stream).toBe(null);
  });

  test('suspending gates the real camera, not just the canvas', async ({ page }) => {
    await seedEffectsRoom(page);
    const seen = await page.evaluate(async () => {
      VideoEffects.writeMode('blur');
      await startVideoShare();
      const raw = localVideoStream._effectsOriginal.getVideoTracks()[0];
      const canvas = localVideoStream.getVideoTracks()[0];
      setLocalCameraSuspended(true);
      const suspended = { raw: raw.enabled, canvas: canvas.enabled, paused: VideoEffects.active().paused };
      setLocalCameraSuspended(false);
      return { suspended, resumed: { raw: raw.enabled, paused: VideoEffects.active().paused } };
    });
    expect(seen.suspended).toEqual({ raw: false, canvas: false, paused: true });
    expect(seen.resumed).toEqual({ raw: true, paused: false });
  });

  test('flipping the camera behind an effect changes nothing on the wire', async ({ page }) => {
    await seedEffectsRoom(page);
    const seen = await page.evaluate(async () => {
      VideoEffects.writeMode('blur');
      await startVideoShare();
      const canvasTrack = localVideoStream.getVideoTracks()[0];
      const firstRaw = localVideoStream._effectsOriginal;
      window.__swaps = [];
      await flipCamera();
      return {
        swaps: window.__swaps.length,
        sameTrack: localVideoStream.getVideoTracks()[0] === canvasTrack,
        newRaw: localVideoStream._effectsOriginal !== firstRaw,
        oldRawStopped: firstRaw.getVideoTracks()[0].readyState === 'ended',
        facing: _cameraFacing,
      };
    });
    // The published track is the canvas, so repointing it at the other camera
    // needs no replaceTrack and no re-tune at all.
    expect(seen.swaps).toBe(0);
    expect(seen.sameTrack).toBe(true);
    expect(seen.newRaw).toBe(true);
    expect(seen.oldRawStopped).toBe(true);
    expect(seen.facing).toBe('environment');
  });

  test('with no effect the camera is the published stream, untouched', async ({ page }) => {
    await seedEffectsRoom(page);
    const seen = await page.evaluate(async () => {
      await startVideoShare();
      return {
        wrapped: !!localVideoStream._effectsProcessor,
        processor: VideoEffects.active(),
        original: localVideoStream._effectsOriginal,
      };
    });
    // Off means off: no canvas, no pipeline, nothing constructed.
    expect(seen.wrapped).toBe(false);
    expect(seen.processor).toBe(null);
    expect(seen.original).toBe(undefined);
  });
});

test.describe('choosing a background', () => {
  test.beforeEach(async ({ page }) => {
    await page.evaluate(() => showScreen('room'));
    await seedEffectsRoom(page);
    await page.evaluate(() => startVideoShare());
    await page.click('.video-tile-self.video-tile-camera .video-tile-bg');
    await expect(page.locator('#video-bg-popover')).toBeVisible();
  });

  test('closes the popover, since the choice is about the picture behind it', async ({ page }) => {
    await page.click('#video-bg-popover .bg-chip[data-mode="preset:studio"]');
    await expect(page.locator('#video-bg-popover')).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('video-background')))
      .toBe('preset:studio');
  });

  // The selected chip's ring is a box-shadow drawn outside its box, and on a
  // narrow screen the strip is a scroll container — which clips both axes.
  test('the selected chip\'s ring is not clipped by the scrolling strip', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await page.click('#video-bg-popover .bg-chip[data-mode="preset:dusk"]');
    await page.click('.video-tile-self.video-tile-camera .video-tile-bg');
    const clearance = await page.evaluate(() => {
      const strip = document.querySelector('#video-bg-popover .bg-picker');
      const chip = strip.querySelector('.bg-chip.is-active');
      const s = strip.getBoundingClientRect(), c = chip.getBoundingClientRect();
      const RING = 4;   // the box-shadow's spread beyond the chip
      return {
        scrolls: getComputedStyle(strip).overflowX,
        top: Math.round((c.top - RING) - s.top),
        bottom: Math.round(s.bottom - (c.bottom + RING)),
      };
    });
    expect(clearance.scrolls).toBe('auto');
    expect(clearance.top).toBeGreaterThanOrEqual(0);
    expect(clearance.bottom).toBeGreaterThanOrEqual(0);
  });
});

test.describe('a custom image', () => {
  // The "+" chip used to read IndexedDB before opening the dialog. That await
  // spends the user activation, and WebKit will not open a file picker without
  // one — so on iOS and Android the chip silently did nothing.
  test('opens the file dialog straight from the tap', async ({ page }) => {
    await page.evaluate(() => showScreen('room'));
    await seedEffectsRoom(page);
    await page.evaluate(() => startVideoShare());
    await page.click('.video-tile-self.video-tile-camera .video-tile-bg');

    const chooser = page.waitForEvent('filechooser', { timeout: 5000 });
    await page.click('#video-bg-popover .bg-chip[data-mode="custom"]');
    expect(await chooser).toBeTruthy();
  });

  test('the input is rendered, not display:none', async ({ page }) => {
    // WKWebView refuses to open a picker for an input it is not rendering.
    const display = await page.evaluate(() =>
      getComputedStyle(document.querySelector('#video-bg-picker input[type=file]')).display);
    expect(display).not.toBe('none');
  });

  test('a stored image is selected rather than re-prompted for', async ({ page }) => {
    await page.evaluate(() => showScreen('room'));
    await seedEffectsRoom(page);
    await page.evaluate(() => startVideoShare());
    await page.click('.video-tile-self.video-tile-camera .video-tile-bg');

    const chooser = page.waitForEvent('filechooser');
    await page.click('#video-bg-popover .bg-chip[data-mode="custom"]');
    await (await chooser).setFiles('src/assets/backgrounds/aurora.webp');
    await expect(page.locator('#video-bg-popover')).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('video-background'))).toBe('custom');

    // Second time round the chip holds the image, so it must select it rather
    // than ask again.
    await page.evaluate(() => VideoEffects.writeMode('blur'));
    await page.click('.video-tile-self.video-tile-camera .video-tile-bg');
    let reprompted = false;
    page.on('filechooser', () => { reprompted = true; });
    await page.click('#video-bg-popover .bg-chip[data-mode="custom"]');
    await page.waitForTimeout(300);
    expect(reprompted).toBe(false);
    expect(await page.evaluate(() => localStorage.getItem('video-background'))).toBe('custom');
  });
});

test.describe('the first-run download', () => {
  // The runtime is not bundled, so the first effect anybody turns on pays for a
  // ~12 MB fetch. Silence there reads as a broken feature.
  test('reports progress and names the size', async ({ page }) => {
    await page.evaluate(() => showScreen('room'));
    await seedEffectsRoom(page);
    const seen = await page.evaluate(async () => {
      // Drive the reporter directly: the stub never touches the network, and a
      // real 12 MB fetch is not something to put in this suite. Note we do NOT
      // register a listener of our own — onLoadProgress has a single slot, so
      // that would displace the one main.js installed and there would be
      // nothing left to render the row.
      VideoEffects._reportForTest('download', 3 * 1024 * 1024, 12 * 1024 * 1024);
      const row = document.getElementById('video-bg-progress');
      return {
        visible: !row.classList.contains('hidden'),
        text: row.querySelector('.video-bg-progress-text').textContent,
        fill: row.querySelector('.video-bg-progress-fill').style.width,
      };
    });
    expect(seen.visible).toBe(true);
    expect(seen.text).toMatch(/12 MB/);
    expect(seen.text).toMatch(/25%/);
    expect(seen.fill).toBe('25%');
  });

  test('the row goes away once the runtime is ready', async ({ page }) => {
    const hidden = await page.evaluate(() => {
      VideoEffects._reportForTest('download', 1, 2);
      VideoEffects._reportForTest('ready', 1, 1);
      return document.getElementById('video-bg-progress').classList.contains('hidden');
    });
    expect(hidden).toBe(true);
  });

  test('cancelling leaves the plain camera sharing and the effect off', async ({ page }) => {
    await page.evaluate(() => showScreen('room'));
    await seedEffectsRoom(page);
    const seen = await page.evaluate(async () => {
      await startVideoShare();
      const rawStream = localVideoStream;
      // A load that never resolves until it is aborted — what a slow 12 MB
      // fetch looks like from the picker's point of view.
      window.__voxalSegStub = { fail: true, abort: true };
      window.__swaps = [];
      await applyVideoBackground('blur');
      return {
        stillRaw: localVideoStream === rawStream,
        wrapped: !!localVideoStream._effectsProcessor,
        swaps: window.__swaps.length,
        stored: localStorage.getItem('video-background'),
        sharing: localVideoActive,
      };
    });
    // Cancelling is an answer, not a failure: nothing on the wire changes.
    expect(seen.stillRaw).toBe(true);
    expect(seen.wrapped).toBe(false);
    expect(seen.swaps).toBe(0);
    expect(seen.stored).toBe(null);
    expect(seen.sharing).toBe(true);
  });
});

test.describe('the composited output', () => {
  test('draws the background outside the person and the camera inside it', async ({ page }) => {
    await seedEffectsRoom(page);
    const seen = await page.evaluate(async () => {
      VideoEffects.writeMode('preset:aurora');
      await startVideoShare();
      await new Promise((r) => setTimeout(r, 600));
      const src = VideoEffects.active().canvas;
      const probe = document.createElement('canvas');
      probe.width = src.width; probe.height = src.height;
      const ctx = probe.getContext('2d');
      ctx.drawImage(src, 0, 0);
      const at = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3);
      return {
        size: [src.width, src.height],
        corner: at(4, 4),
        centre: at(Math.floor(src.width / 2), Math.floor(src.height * 0.6)),
        segmented: (window.__voxalSegCalls || 0) > 0,
      };
    });
    expect(seen.size).toEqual([320, 240]);
    expect(seen.segmented).toBe(true);
    // The stub's mask is a centred oval: outside it we should see the aurora
    // artwork (blue-dominant), inside it the fake camera's green fill.
    expect(seen.corner[2]).toBeGreaterThan(seen.corner[0]);
    expect(seen.centre[1]).toBeGreaterThan(seen.centre[0] + 40);
    expect(seen.centre[1]).toBeGreaterThan(seen.centre[2] + 40);
  });

  // The "why is the blur grey" regression, pinned end to end.
  //
  // Blurring a flat colour must give that colour back. It did not: the
  // hand-written Gaussian table summed to 0.838 rather than 1, so each
  // separable pass dimmed what it touched and the two together left the
  // background at 70% brightness — rgb(0,170,0) came out near rgb(0,119,0).
  // The fake camera paints a flat #0a0, so any drift here is the pipeline's,
  // not the picture's.
  test('blurring a flat background preserves its brightness', async ({ page }) => {
    await seedEffectsRoom(page);
    const seen = await page.evaluate(async () => {
      VideoEffects.writeMode('blur');
      await startVideoShare();
      await new Promise((r) => setTimeout(r, 600));
      const src = VideoEffects.active().canvas;
      const probe = document.createElement('canvas');
      probe.width = src.width; probe.height = src.height;
      const ctx = probe.getContext('2d');
      ctx.drawImage(src, 0, 0);
      // Left edge, mid-height: outside the stub's centred oval, and far from
      // the moving marker pixel the fake camera draws along one edge.
      return Array.from(ctx.getImageData(4, Math.floor(src.height / 2), 1, 1).data).slice(0, 3);
    });
    expect(seen[1]).toBeGreaterThan(158);
    expect(seen[0]).toBeLessThan(12);
    expect(seen[2]).toBeLessThan(12);
  });

  // How wide the blur actually is, measured off the rendered canvas rather than
  // trusted from the constants — and that the strength preference is what sets
  // it. The camera paints a hard black/white edge across a column that is
  // background at every height; a Gaussian of sigma s turns that step into a
  // ramp, so the value a fixed distance into the dark side is a direct read of
  // s. Raise the strength and that point must come up.
  //
  // The arithmetic test below pins the strides. This pins the picture — a
  // stride that never reaches the shader, a uniform in the wrong units, a
  // dropped iteration or a preference that is stored but never applied all
  // leave the arithmetic correct and the blur wrong.
  test('the strength preference sets the rendered blur radius', async ({ page }) => {
    await seedEffectsRoom(page);
    const seen = await page.evaluate(async () => {
      const W = 1280, H = 720, SPLIT = H / 2;
      // A horizontal edge, sampled down a column the stub's oval never reaches
      // (it spans x from 0.28W to 0.72W at its widest, so 0.1W is clear at
      // every height). Canvas y matches camera y: the composite's `1.0 - vUv.y`
      // cancels GL's bottom-up framebuffer convention rather than adding a flip
      // of its own, so the dark half stays the top half.
      window.__mkVideoStream = function () {
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        const ctx = c.getContext('2d');
        let n = 0;
        const paint = () => {
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, W, SPLIT);
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, SPLIT, W, H - SPLIT);
          // Keep the capture from stalling on an unchanging canvas, in the far
          // corner where it cannot reach the probes.
          ctx.fillStyle = n++ % 2 ? '#fff' : '#eee';
          ctx.fillRect(W - 6, SPLIT + 4, 4, 4);
        };
        paint();
        const stream = c.captureStream(15);
        const timer = setInterval(paint, 40);
        stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
        return stream;
      };
      VideoEffects.writeMode('blur');
      await startVideoShare();

      const src = VideoEffects.active().canvas;
      const probe = document.createElement('canvas');
      probe.width = src.width; probe.height = src.height;
      const ctx = probe.getContext('2d');
      const col = Math.round(src.width * 0.1);
      const edge = Math.round(src.height / 2);

      async function sample(strength) {
        VideoEffects.setStrength(strength);
        await new Promise((r) => setTimeout(r, 500));
        ctx.drawImage(src, 0, 0);
        const at = (y) => ctx.getImageData(col, y, 1, 1).data[1];
        const sigma = strength * src.width;
        return {
          // 60 px into the dark half — near the ramp for a weak blur, well
          // inside it for a strong one.
          nearEdge: at(edge - 60),
          // Three sigma out on either side is past the ramp in both directions.
          deepDark: at(Math.max(0, Math.round(edge - 3 * sigma))),
          deepLight: at(Math.min(src.height - 1, Math.round(edge + 3 * sigma))),
        };
      }
      return { size: [src.width, src.height], weak: await sample(0.03), strong: await sample(0.09) };
    });
    expect(seen.size).toEqual([1280, 720]);
    // Past the ramp it is still black on one side and white on the other, at
    // both strengths — a blur, not an overall fog.
    [seen.weak, seen.strong].forEach((s) => {
      expect(s.deepDark).toBeLessThan(40);
      expect(s.deepLight).toBeGreaterThan(215);
    });
    // The preference is what moves the ramp. At 60 px in, a sigma-38 blur has
    // barely reached and a sigma-115 one is halfway to the far side.
    expect(seen.weak.nearEdge).toBeLessThan(90);
    expect(seen.strong.nearEdge).toBeGreaterThan(120);
  });
});

// A pass that does not sum to 1 is a brightness multiplier wearing a blur's
// clothes, and it is invisible in isolation — you only see it two passes later
// as a washed-out background, or as a feathered mask that never reaches 1 and
// so drags the composite's threshold inward. The weights are generated for
// exactly this reason; this is the guard on the generator.
test.describe('the blur kernel', () => {
  test('is normalised at every size the pipeline asks for', async ({ page }) => {
    const sums = await page.evaluate(() => {
      const out = {};
      [[1.75, 5], [1.0, 3], [3.0, 8]].forEach(([sigma, taps]) => {
        const w = VideoEffects._gaussianHalfKernel(sigma, taps);
        let s = w[0];
        for (let i = 1; i < w.length; i++) s += 2 * w[i];
        out[sigma + '/' + taps] = { sum: s, monotonic: w.every((v, i) => i === 0 || v < w[i - 1]) };
      });
      return out;
    });
    Object.keys(sums).forEach((k) => {
      expect(sums[k].sum).toBeCloseTo(1, 6);
      expect(sums[k].monotonic).toBe(true);
    });
  });

  // The strength is stated as a fraction of the frame so that it means the same
  // thing on every camera. That only holds if the strides derived from it
  // actually add up to it — successive Gaussians add *variances*, not radii,
  // and summing them the obvious (wrong) way silently under-blurs.
  test('the strides add up to the strength that was asked for', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const cfg = VideoEffects._blurConfig;
      const sizes = [[1280, 720], [640, 480], [1920, 1080], [320, 240]];
      const out = [];
      // Across the whole slider, not just the default: the top end asks for a
      // sigma 10x the bottom end's, and that is exactly where a fixed pass
      // count would start skipping detail instead of blurring it.
      [0, 25, 50, 75, 100].forEach((pos) => {
        const strength = VideoEffects.strengthFromSlider(pos);
        sizes.forEach(([w, h]) => {
          const scale = Math.min(1, cfg.long / Math.max(w, h));
          const bw = Math.round(w * scale), bh = Math.round(h * scale);
          const steps = VideoEffects._blurPlan(strength * Math.max(bw, bh));
          let variance = 0;
          steps.forEach((s) => { variance += Math.pow(cfg.sigma * s, 2); });
          out.push({
            pos,
            strength,
            fraction: Math.sqrt(variance) / Math.max(bw, bh),
            // Each stride doubles, and the first stays under a texel so no pass
            // ever strides past detail it is meant to be averaging.
            doubling: steps.every((s, i) => i === 0 || Math.abs(s / steps[i - 1] - 2) < 1e-9),
            firstStride: steps[0],
            passes: steps.length,
          });
        });
      });
      return { out, max: cfg.maxPasses };
    });
    seen.out.forEach((f) => {
      expect(f.fraction).toBeCloseTo(f.strength, 6);
      expect(f.doubling).toBe(true);
      expect(f.firstStride).toBeLessThanOrEqual(1);
      expect(f.passes).toBeLessThanOrEqual(seen.max);
    });
    // A stronger blur buys itself more passes rather than degrading.
    const weakest = seen.out.find((f) => f.pos === 0).passes;
    const strongest = seen.out.find((f) => f.pos === 100).passes;
    expect(strongest).toBeGreaterThan(weakest);
  });
});

test.describe('the blur strength preference', () => {
  test('defaults to the built-in, round-trips, and clamps to the slider range', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const cfg = VideoEffects._blurConfig;
      const initial = VideoEffects.readStrength();
      VideoEffects.writeStrength(0.12);
      const set = [VideoEffects.readStrength(), localStorage.getItem(VideoEffects.STRENGTH_KEY)];
      // Out of range in both directions, and outright junk.
      VideoEffects.writeStrength(9);
      const high = VideoEffects.readStrength();
      VideoEffects.writeStrength(0);
      const low = VideoEffects.readStrength();
      localStorage.setItem(VideoEffects.STRENGTH_KEY, 'not-a-number');
      const junk = VideoEffects.readStrength();
      // Back to the default: stored as an absence, the way `off` is for mode.
      VideoEffects.writeStrength(cfg.def);
      return {
        initial, set, high, low, junk, cfg,
        cleared: localStorage.getItem(VideoEffects.STRENGTH_KEY),
      };
    });
    expect(seen.initial).toBe(seen.cfg.def);
    expect(seen.set).toEqual([0.12, '0.12']);
    expect(seen.high).toBe(seen.cfg.max);
    expect(seen.low).toBe(seen.cfg.min);
    expect(seen.junk).toBe(seen.cfg.def);
    expect(seen.cleared).toBe(null);
  });

  // Linear travel would spend most of the slider inside "already unreadable":
  // 2%→4% is a dramatic change and 18%→20% is invisible, because the eye reads
  // blur as a ratio.
  test('the slider is geometric, so every part of its travel is worth the same', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const cfg = VideoEffects._blurConfig;
      const at = (p) => VideoEffects.strengthFromSlider(p);
      return {
        ends: [at(0), at(100)],
        // Equal travel, equal ratio — that is what geometric means.
        ratios: [at(25) / at(0), at(50) / at(25), at(75) / at(50), at(100) / at(75)],
        roundTrip: [0, 17, 50, 83, 100].map((p) => VideoEffects.sliderFromStrength(at(p))),
        defaultPos: VideoEffects.sliderFromStrength(cfg.def),
        labels: [at(0), cfg.def, at(100)].map((v) => VideoEffects.strengthLabel(v)),
        cfg,
      };
    });
    expect(seen.ends).toEqual([seen.cfg.min, seen.cfg.max]);
    seen.ratios.forEach((r) => expect(r).toBeCloseTo(seen.ratios[0], 6));
    expect(seen.roundTrip).toEqual([0, 17, 50, 83, 100]);
    // The default sits mid-travel, so there is real room in both directions.
    expect(seen.defaultPos).toBeGreaterThan(35);
    expect(seen.defaultPos).toBeLessThan(85);
    expect(seen.labels[0]).toMatch(/Subtle/);
    expect(seen.labels[2]).toMatch(/Maximum/);
  });

  // It belongs beside the picker it modifies, not off in Advanced.
  test('the slider is in Video, under the picker, and moving it stores the value', async ({ page }) => {
    await page.click('#btn-open-settings');
    await page.click('#modal-settings [data-target="settings-video"]');
    // Same card, and after the chip row rather than before it.
    const order = await page.evaluate(() => {
      const card = document.getElementById('settings-video');
      const picker = document.getElementById('settings-bg-picker');
      const strength = document.getElementById('settings-blur-strength');
      return {
        inVideoCard: !!card && card.contains(picker) && card.contains(strength),
        afterPicker: !!(picker.compareDocumentPosition(strength) &
                        Node.DOCUMENT_POSITION_FOLLOWING),
      };
    });
    expect(order).toEqual({ inVideoCard: true, afterPicker: true });
    const slider = page.locator('#settings-blur-strength input[type="range"]');
    await expect(slider).toBeVisible();

    // Start from a known position, then drag to the far end.
    await slider.fill('100');
    await slider.dispatchEvent('input');
    const strong = await page.evaluate(() => VideoEffects.readStrength());
    expect(strong).toBe((await page.evaluate(() => VideoEffects._blurConfig)).max);
    await expect(page.locator('#settings-blur-strength .blur-strength-value'))
      .toHaveText(/Maximum/);

    await slider.fill('0');
    await slider.dispatchEvent('input');
    expect(await page.evaluate(() => VideoEffects.readStrength()))
      .toBe((await page.evaluate(() => VideoEffects._blurConfig)).min);
  });

  // The whole reason the strength is a uniform and not a capture setting. If
  // this ever starts swapping tracks, every peer's tile blinks each time
  // somebody drags the slider — and a slider fires an event per pixel.
  test('dragging it mid-call swaps nothing on the wire', async ({ page }) => {
    await seedEffectsRoom(page);
    const seen = await page.evaluate(async () => {
      await startVideoShare();
      await applyVideoBackground('blur');
      const track = localVideoStream.getVideoTracks()[0];
      const before = VideoEffects.active().blurSteps.slice();
      window.__swaps = [];
      // Sweep it the way a drag would.
      for (let p = 0; p <= 100; p += 5) VideoEffects.setStrength(VideoEffects.strengthFromSlider(p));
      const after = VideoEffects.active().blurSteps.slice();
      return {
        swaps: window.__swaps.length,
        sameTrack: localVideoStream.getVideoTracks()[0] === track,
        // It did actually take effect, rather than being a silent no-op.
        widened: after[after.length - 1] > before[before.length - 1],
        stored: VideoEffects.readStrength(),
      };
    });
    expect(seen.swaps).toBe(0);
    expect(seen.sameTrack).toBe(true);
    expect(seen.widened).toBe(true);
    expect(seen.stored).toBe(0.2);
  });
});
