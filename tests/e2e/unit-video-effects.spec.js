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

  test('stays hidden until a camera is actually running', async ({ page }) => {
    await seedEffectsRoom(page);
    await page.evaluate(() => { updateVideoModeUI(); });
    await expect(page.locator('#btn-video-bg')).toBeHidden();

    await page.evaluate(() => startVideoShare());
    await expect(page.locator('#btn-video-bg')).toBeVisible();

    await page.evaluate(() => stopVideoShare());
    await expect(page.locator('#btn-video-bg')).toBeHidden();
  });

  test('stays hidden where the pipeline cannot run', async ({ page }) => {
    await seedEffectsRoom(page);
    await page.evaluate(async () => {
      await startVideoShare();
      // Pretend this device has no WebGL2; the probe result is cached, so
      // override the accessor the way an unsupported webview would behave.
      VideoEffects.isSupported = () => false;
      updateVideoModeUI();
    });
    await expect(page.locator('#btn-video-bg')).toBeHidden();
  });

  test('opens and closes its popover', async ({ page }) => {
    await seedEffectsRoom(page);
    await page.evaluate(() => startVideoShare());
    await expect(page.locator('#video-bg-popover')).toBeHidden();
    await page.click('#btn-video-bg');
    await expect(page.locator('#video-bg-popover')).toBeVisible();
    await expect(page.locator('#btn-video-bg')).toHaveAttribute('aria-expanded', 'true');
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
});
