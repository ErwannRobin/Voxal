import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// Screen sharing in the iOS/Android apps.
//
// No mobile WebView implements getDisplayMedia, so on Capacitor the frames come
// from a native ScreenCapture plugin as H.264 access units, get decoded by
// WebCodecs and drawn to a canvas whose captureStream() is the MediaStream the
// rest of the app publishes. What is worth pinning here is precisely the seam:
// that the native path produces a stream the EXISTING screen pipeline accepts
// unchanged, and that every way a share can end converges on one teardown.
//
// IS_NATIVE_MOBILE is a `const` evaluated while main.js loads, so the platform
// and plugin stubs must be installed with addInitScript, before goto.

/**
 * Install a fake Capacitor + ScreenCapture plugin and a stub VideoDecoder.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{supported?: boolean, canCaptureThrows?: boolean, startRejects?: string, noRequestFrame?: boolean}} opts
 */
async function fakeNativeScreen(page, opts = {}) {
  await page.addInitScript((o) => {
    const listeners = {};
    window.__screenPlugin = {
      calls: [],
      started: null,
      stopped: 0,
      emit(event, payload) { (listeners[event] || []).forEach((fn) => fn(payload)); },
      listenerCount() { return Object.values(listeners).reduce((n, a) => n + a.length, 0); },
    };

    const plugin = {
      canCapture() {
        window.__screenPlugin.calls.push('canCapture');
        if (o.canCaptureThrows) return Promise.reject(new Error('not implemented'));
        return Promise.resolve({ supported: o.supported !== false });
      },
      start(args) {
        window.__screenPlugin.calls.push('start');
        if (o.startRejects) {
          const e = new Error(o.startRejects);
          e.code = o.startRejects;
          return Promise.reject(e);
        }
        window.__screenPlugin.started = args;
        if (o.emitOnStart) {
          // What Android really does: the service is running the moment consent
          // lands, so config and frames can precede start()'s own resolution.
          window.__screenPlugin.emit('screenCaptureConfig', { codec: 'avc1.42E01E', width: 720, height: 1280 });
          window.__screenPlugin.emit('screenCaptureChunk', { data: btoa('key'), key: true, timestamp: 0 });
        }
        return Promise.resolve();
      },
      stop() {
        window.__screenPlugin.calls.push('stop');
        window.__screenPlugin.stopped += 1;
        return Promise.resolve();
      },
      addListener(event, fn) {
        (listeners[event] = listeners[event] || []).push(fn);
        return {
          remove() {
            const a = listeners[event] || [];
            const i = a.indexOf(fn);
            if (i >= 0) a.splice(i, 1);
          },
        };
      },
    };

    window.Capacitor = { isNativePlatform: () => true, Plugins: { ScreenCapture: plugin } };

    // A VideoDecoder that records what it was handed and synthesises an output
    // frame per decode, so the canvas -> captureStream half runs for real.
    window.__decoders = [];
    window.VideoDecoder = class {
      constructor(init) {
        this.state = 'unconfigured';
        this.init = init;
        this.configs = [];
        this.chunks = [];
        window.__decoders.push(this);
      }
      configure(cfg) { this.configs.push(cfg); this.state = 'configured'; }
      decode(chunk) {
        this.chunks.push(chunk);
        // A stand-in for a real VideoFrame: drawImage accepts a canvas, and
        // close() is what the pipeline is obliged to call.
        const c = document.createElement('canvas');
        c.width = 16; c.height = 16;
        c.close = () => { c.__closed = true; };
        this.init.output(c);
      }
      close() { this.state = 'closed'; }
    };
    window.EncodedVideoChunk = class {
      constructor(o2) { Object.assign(this, o2); }
    };

    if (o.noRequestFrame) {
      // Simulate a browser without CanvasCaptureMediaStreamTrack.requestFrame.
      const orig = HTMLCanvasElement.prototype.captureStream;
      HTMLCanvasElement.prototype.captureStream = function (fps) {
        const s = orig.call(this, fps);
        s.getVideoTracks().forEach((t) => { t.requestFrame = undefined; });
        return s;
      };
    }
  }, opts);
}

/** A native room where every peer can take a mesh MediaConnection. */
async function seedNativeRoom(page) {
  await seedRoom(page, {
    selfId: 'host',
    isHost: true,
    connections: [{ id: 'p1', pseudo: 'Ada' }, { id: 'p2', pseudo: 'Grace' }],
  });
  await page.evaluate(() => {
    window.__calls = [];
    peer = {
      id: 'host',
      destroyed: false,
      call(peerId, stream, opts) {
        const handlers = {};
        const c = {
          peer: peerId,
          metadata: opts && opts.metadata,
          closed: false,
          peerConnection: { getSenders: () => [], getStats: () => Promise.resolve(new Map()) },
          close() { this.closed = true; },
          on(e, fn) { (handlers[e] = handlers[e] || []).push(fn); },
          emit(e, a) { (handlers[e] || []).forEach((fn) => fn(a)); },
        };
        window.__calls.push(c);
        return c;
      },
    };
    videoModeEnabled = true;
    localStorage.setItem('video-routing-mode', 'p2p-only');
  });
}

test.describe('deciding whether the app can share a screen at all', () => {
  test('a binary that answers canCapture() offers the button', async ({ page }) => {
    await fakeNativeScreen(page);
    await page.goto('/');
    await expect.poll(() => page.evaluate(() => screenShareSupported())).toBe(true);
    expect(await page.evaluate(() => window.__screenPlugin.calls)).toContain('canCapture');
  });

  // The rule from KNOWLEDGE/learning.md: an OTA-updated JS bundle routinely runs
  // on an older native binary where the plugin object exists but the method does
  // not. Capability must come from CALLING it, never from its presence.
  test('an older native binary that throws is treated as unsupported', async ({ page }) => {
    await fakeNativeScreen(page, { canCaptureThrows: true });
    await page.goto('/');
    expect(await page.evaluate(() => probeNativeScreenCapture())).toBe(false);
    expect(await page.evaluate(() => screenShareSupported())).toBe(false);
  });

  test('a device that says no keeps the button hidden', async ({ page }) => {
    await fakeNativeScreen(page, { supported: false });
    await page.goto('/');
    expect(await page.evaluate(() => probeNativeScreenCapture())).toBe(false);
    await page.evaluate(() => { videoModeEnabled = true; updateVideoModeUI(); });
    await expect(page.locator('#btn-share-screen')).toHaveClass(/hidden/);
  });

  // WebCodecs is the other half of the requirement: iOS shipped VideoDecoder in
  // 16.4, and the app's deployment target is older than that.
  test('no WebCodecs means no screen share, whatever the plugin says', async ({ page }) => {
    await fakeNativeScreen(page);
    await page.addInitScript(() => { delete window.VideoDecoder; });
    await page.goto('/');
    expect(await page.evaluate(() => probeNativeScreenCapture())).toBe(false);
  });

  test('the button appears once the probe answers', async ({ page }) => {
    await fakeNativeScreen(page);
    await page.goto('/');
    await page.evaluate(() => { videoModeEnabled = true; });
    await expect.poll(async () => {
      await page.evaluate(() => updateVideoModeUI());
      return page.locator('#btn-share-screen').getAttribute('class');
    }).not.toMatch(/hidden/);
  });

  test('plain web still gates on getDisplayMedia, untouched', async ({ page }) => {
    await page.goto('/');
    expect(await page.evaluate(() => screenShareSupported())).toBe(
      await page.evaluate(() => !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)),
    );
    expect(await page.evaluate(() => probeNativeScreenCapture())).toBe(false);
  });
});

test.describe('sharing a phone screen into the room', () => {
  test('publishes to every peer exactly as the desktop path does', async ({ page }) => {
    await fakeNativeScreen(page);
    await page.goto('/');
    await seedNativeRoom(page);
    const seen = await page.evaluate(async () => {
      const sent = [];
      connections.forEach((c) => { c.data.send = (m) => sent.push(m); });
      await startScreenShare();
      return {
        active: localScreenActive,
        tracks: localScreenStream ? localScreenStream.getVideoTracks().length : 0,
        calls: window.__calls.map((c) => c.metadata && c.metadata.type),
        offers: sent.filter((m) => m.type === 'screen-offer').length,
        started: window.__screenPlugin.started,
      };
    });
    expect(seen.active).toBe(true);
    expect(seen.tracks).toBe(1);
    expect(seen.calls).toEqual(['screen', 'screen']);
    expect(seen.offers).toBe(2);
    // The native side is told the caps the JS side would otherwise have to
    // re-derive: long edge, frame rate, and the mobile screen bitrate.
    expect(seen.started.maxEdge).toBe(1280);
    expect(seen.started.fps).toBe(24);
    expect(seen.started.bitrate).toBe(800000);
  });

  // The native side starts emitting as soon as the user consents, which can be
  // before start() resolves — and since config is only re-sent when the
  // geometry changes, a config lost to a late listener is a share that never
  // decodes anything.
  test('catches a config that arrives before start() resolves', async ({ page }) => {
    await fakeNativeScreen(page, { emitOnStart: true });
    await page.goto('/');
    await seedNativeRoom(page);
    const seen = await page.evaluate(async () => {
      await startScreenShare();
      const d = window.__decoders[window.__decoders.length - 1];
      return { decoders: window.__decoders.length, chunks: d ? d.chunks.length : 0 };
    });
    expect(seen).toEqual({ decoders: 1, chunks: 1 });
  });

  test('cancelling the system prompt leaves the room untouched', async ({ page }) => {
    await fakeNativeScreen(page, { startRejects: 'cancelled' });
    await page.goto('/');
    await seedNativeRoom(page);
    const seen = await page.evaluate(async () => {
      await startScreenShare();
      return { active: localScreenActive, stream: localScreenStream, calls: window.__calls.length };
    });
    expect(seen).toEqual({ active: false, stream: null, calls: 0 });
    await expect(page.locator('#copy-toast')).toHaveText('Screen share cancelled');
    // Nothing downstream ever took the stream, so the cancel path owns releasing
    // it — otherwise the canvas capture spins on for the rest of the session.
    expect(await page.evaluate(() => _nativeScreenSession)).toBeNull();
  });

  test('a native failure that is not a cancel says unsupported', async ({ page }) => {
    await fakeNativeScreen(page, { startRejects: 'projection denied' });
    await page.goto('/');
    await seedNativeRoom(page);
    await page.evaluate(() => startScreenShare());
    await expect(page.locator('#copy-toast')).toHaveText('Screen sharing not supported');
  });
});

test.describe('the decode pipeline', () => {
  async function share(page) {
    await seedNativeRoom(page);
    await page.evaluate(() => startScreenShare());
  }

  test('configures a decoder from the native config event', async ({ page }) => {
    await fakeNativeScreen(page);
    await page.goto('/');
    await share(page);
    const seen = await page.evaluate(() => {
      window.__screenPlugin.emit('screenCaptureConfig', { codec: 'avc1.4D401F', width: 720, height: 1280 });
      const d = window.__decoders[window.__decoders.length - 1];
      return { codec: d.configs[0].codec, latency: d.configs[0].optimizeForLatency, state: d.state };
    });
    expect(seen).toEqual({ codec: 'avc1.4D401F', latency: true, state: 'configured' });
  });

  // Annex-B carries SPS/PPS inline ahead of each IDR, so there is no
  // `description` to pass — but a delta frame arriving before the first
  // keyframe still has nothing to decode against.
  test('waits for a keyframe before decoding anything', async ({ page }) => {
    await fakeNativeScreen(page);
    await page.goto('/');
    await share(page);
    const seen = await page.evaluate(() => {
      window.__screenPlugin.emit('screenCaptureConfig', { codec: 'avc1.42E01E', width: 640, height: 360 });
      const d = window.__decoders[window.__decoders.length - 1];
      window.__screenPlugin.emit('screenCaptureChunk', { data: btoa('delta'), key: false, timestamp: 0 });
      const afterDelta = d.chunks.length;
      window.__screenPlugin.emit('screenCaptureChunk', { data: btoa('key'), key: true, timestamp: 1000 });
      window.__screenPlugin.emit('screenCaptureChunk', { data: btoa('delta'), key: false, timestamp: 2000 });
      return { afterDelta, total: d.chunks.length, types: d.chunks.map((c) => c.type) };
    });
    expect(seen).toEqual({ afterDelta: 0, total: 2, types: ['key', 'delta'] });
  });

  // Microsecond timestamps pass 2^31 about 36 minutes into a share, so the
  // obvious `| 0` coercion would send the decoder's presentation times negative
  // exactly once the call has been going a while.
  test('carries a microsecond timestamp past the 32-bit ceiling intact', async ({ page }) => {
    await fakeNativeScreen(page);
    await page.goto('/');
    await share(page);
    const stamps = await page.evaluate(() => {
      window.__screenPlugin.emit('screenCaptureConfig', { codec: 'avc1.42E01E', width: 64, height: 64 });
      const d = window.__decoders[window.__decoders.length - 1];
      window.__screenPlugin.emit('screenCaptureChunk', { data: btoa('k'), key: true, timestamp: 4000000000 });
      window.__screenPlugin.emit('screenCaptureChunk', { data: btoa('d'), key: false, timestamp: 9007199254 });
      return d.chunks.map((c) => c.timestamp);
    });
    expect(stamps).toEqual([4000000000, 9007199254]);
  });

  test('a chunk arriving before any config is ignored, not thrown', async ({ page }) => {
    await fakeNativeScreen(page);
    await page.goto('/');
    await share(page);
    const ok = await page.evaluate(() => {
      window.__screenPlugin.emit('screenCaptureChunk', { data: btoa('key'), key: true, timestamp: 0 });
      return localScreenActive;
    });
    expect(ok).toBe(true);
  });

  // A VideoFrame holds a GPU buffer; a handful of un-closed ones stalls the
  // decoder within a second or two. This is the single easiest thing to
  // regress in this file.
  test('closes every decoded frame', async ({ page }) => {
    await fakeNativeScreen(page);
    await page.goto('/');
    await share(page);
    const closed = await page.evaluate(() => {
      window.__screenPlugin.emit('screenCaptureConfig', { codec: 'avc1.42E01E', width: 64, height: 64 });
      const d = window.__decoders[window.__decoders.length - 1];
      const seenFrames = [];
      const origOutput = d.init.output;
      d.init.output = (f) => { seenFrames.push(f); origOutput(f); };
      window.__screenPlugin.emit('screenCaptureChunk', { data: btoa('key'), key: true, timestamp: 0 });
      window.__screenPlugin.emit('screenCaptureChunk', { data: btoa('d1'), key: false, timestamp: 1 });
      return seenFrames.length > 0 && seenFrames.every((f) => f.__closed === true);
    });
    expect(closed).toBe(true);
  });

  test('a rotation reconfigures the decoder and resizes the canvas', async ({ page }) => {
    await fakeNativeScreen(page);
    await page.goto('/');
    await share(page);
    const seen = await page.evaluate(() => {
      window.__screenPlugin.emit('screenCaptureConfig', { codec: 'avc1.42E01E', width: 720, height: 1280 });
      const first = window.__decoders[window.__decoders.length - 1];
      window.__screenPlugin.emit('screenCaptureChunk', { data: btoa('key'), key: true, timestamp: 0 });
      window.__screenPlugin.emit('screenCaptureConfig', { codec: 'avc1.42E01E', width: 1280, height: 720 });
      const second = window.__decoders[window.__decoders.length - 1];
      // A delta straight after the reconfigure has nothing to decode against.
      window.__screenPlugin.emit('screenCaptureChunk', { data: btoa('d'), key: false, timestamp: 1 });
      return { firstClosed: first.state, replaced: first !== second, afterRotate: second.chunks.length };
    });
    expect(seen).toEqual({ firstClosed: 'closed', replaced: true, afterRotate: 0 });
  });

  test('falls back to a timed capture where requestFrame is missing', async ({ page }) => {
    await fakeNativeScreen(page, { noRequestFrame: true });
    await page.goto('/');
    await share(page);
    const seen = await page.evaluate(() => ({
      active: localScreenActive,
      tracks: localScreenStream.getVideoTracks().length,
      live: localScreenStream.getVideoTracks()[0].readyState,
    }));
    expect(seen).toEqual({ active: true, tracks: 1, live: 'live' });
  });
});

test.describe('ending a share', () => {
  test('the system Stop button ends it through the same path as the web picker', async ({ page }) => {
    await fakeNativeScreen(page);
    await page.goto('/');
    await seedNativeRoom(page);
    const seen = await page.evaluate(async () => {
      await startScreenShare();
      const sent = [];
      connections.forEach((c) => { c.data.send = (m) => sent.push(m); });
      // Stopping the native capture ends the canvas track, which fires the
      // 'ended' listener startScreenShare() already registered.
      window.__screenPlugin.emit('screenCaptureStopped', { reason: 'user' });
      return {
        active: localScreenActive,
        stream: localScreenStream,
        stops: sent.filter((m) => m.type === 'screen-stop').length,
      };
    });
    expect(seen).toEqual({ active: false, stream: null, stops: 2 });
  });

  test('stopping tells the native side and closes the decoder', async ({ page }) => {
    await fakeNativeScreen(page);
    await page.goto('/');
    await seedNativeRoom(page);
    const seen = await page.evaluate(async () => {
      await startScreenShare();
      window.__screenPlugin.emit('screenCaptureConfig', { codec: 'avc1.42E01E', width: 64, height: 64 });
      const d = window.__decoders[window.__decoders.length - 1];
      stopScreenShare();
      return {
        active: localScreenActive,
        stopped: window.__screenPlugin.stopped,
        decoder: d.state,
        listeners: window.__screenPlugin.listenerCount(),
        session: _nativeScreenSession,
      };
    });
    expect(seen).toEqual({ active: false, stopped: 1, decoder: 'closed', listeners: 0, session: null });
  });

  test('leaving the room stops the native capture too', async ({ page }) => {
    await fakeNativeScreen(page);
    await page.goto('/');
    await seedNativeRoom(page);
    const stopped = await page.evaluate(async () => {
      await startScreenShare();
      resetVideoState();
      return { stopped: window.__screenPlugin.stopped, active: localScreenActive };
    });
    expect(stopped).toEqual({ stopped: 1, active: false });
  });

  test('turning video mode off stops it as well', async ({ page }) => {
    await fakeNativeScreen(page);
    await page.goto('/');
    await seedNativeRoom(page);
    const seen = await page.evaluate(async () => {
      await startScreenShare();
      toggleVideoMode();
      return { screen: localScreenActive, stopped: window.__screenPlugin.stopped };
    });
    expect(seen).toEqual({ screen: false, stopped: 1 });
  });

  test('stopping twice is harmless', async ({ page }) => {
    await fakeNativeScreen(page);
    await page.goto('/');
    await seedNativeRoom(page);
    const stops = await page.evaluate(async () => {
      await startScreenShare();
      stopScreenShare();
      stopScreenShare();
      return window.__screenPlugin.stopped;
    });
    expect(stops).toBe(1);
  });
});

test.describe('a phone-sized share on the wire', () => {
  test('screen senders get the mobile ceiling, and full resolution', async ({ page }) => {
    await fakeNativeScreen(page);
    await page.goto('/');
    const seen = await page.evaluate(() => {
      const params = { encodings: [{}] };
      const sender = {
        track: { kind: 'video' },
        getParameters: () => params,
        setParameters: (p) => { Object.assign(params, p); return Promise.resolve(); },
      };
      tuneVideoSenders({ getSenders: () => [sender] }, 'screen');
      return {
        bitrate: params.encodings[0].maxBitrate,
        scaled: params.encodings[0].scaleResolutionDownBy,
        degradation: params.degradationPreference,
        hint: sender.track.contentHint,
        helper: screenMaxBitrate(),
      };
    });
    // Never scaled down: a screen that stays sharp at fewer frames is readable,
    // a smaller one is not.
    expect(seen).toEqual({
      bitrate: 800000,
      scaled: undefined,
      degradation: 'maintain-resolution',
      hint: 'detail',
      helper: 800000,
    });
  });

  test('a desktop keeps the full screen ceiling', async ({ page }) => {
    await page.goto('/');
    expect(await page.evaluate(() => screenMaxBitrate())).toBe(1500000);
  });

  // Backgrounding the app is exactly when a screen share must keep running —
  // unlike the camera, which is suspended to save battery.
  test('backgrounding suspends the camera but never the screen', async ({ page }) => {
    await fakeNativeScreen(page);
    await page.goto('/');
    await seedNativeRoom(page);
    const seen = await page.evaluate(async () => {
      await startScreenShare();
      setLocalCameraSuspended(true);
      return {
        enabled: localScreenStream.getVideoTracks()[0].enabled,
        active: localScreenActive,
      };
    });
    expect(seen).toEqual({ enabled: true, active: true });
  });
});
