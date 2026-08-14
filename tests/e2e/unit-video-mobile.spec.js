import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// The video stage on a phone: the same tiles, but filling the screen with the
// voice UI overlaid, on mobile web AND in the Capacitor apps. Plus the things a
// phone needs that a laptop does not — a camera flip, tighter capture and
// bitrate caps, a wake lock, and capture that stops when the app backgrounds.
//
// The invariant carried over from unit-video-stage.spec.js and re-asserted here
// at phone size: an audio-only room gets NEITHER body class, so it renders
// exactly as it did before any of this existed.

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

async function enterRoom(page, cfg = {}) {
  await seedRoom(page, { selfId: 'self', isHost: true, roomCode: 'room1', ...cfg });
  await page.evaluate(() => {
    showScreen('room');
    updatePeerList();
  });
}

// IS_NATIVE_MOBILE / IS_MOBILE_DEVICE are `const`s evaluated while main.js
// loads, so every platform stub must be installed with addInitScript, before
// goto — setting them afterwards is far too late.
async function fakeNative(page) {
  await page.addInitScript(() => {
    window.Capacitor = { isNativePlatform: () => true, Plugins: {} };
  });
}

async function fakeMobileUA(page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', {
      get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
      configurable: true,
    });
  });
}

test.describe('videoStageMode — which shape of stage applies where', () => {
  test('a wide web viewport gets the desktop grid', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/');
    expect(await page.evaluate(() => videoStageMode())).toBe('desktop');
  });

  test('a phone-width web viewport gets the immersive stage', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/');
    expect(await page.evaluate(() => videoStageMode())).toBe('immersive');
    expect(await page.evaluate(() => videoStageAvailable())).toBe(true);
  });

  // A native tablet in portrait is wider than the desktop breakpoint, but the
  // desktop grid is `html.is-web`-qualified and can never apply there — so
  // native must resolve to immersive at ANY width, not by measuring.
  test('native is immersive even at desktop width', async ({ page }) => {
    await fakeNative(page);
    await page.setViewportSize(DESKTOP);
    await page.goto('/');
    expect(await page.evaluate(() => document.documentElement.classList.contains('is-native'))).toBe(true);
    expect(await page.evaluate(() => videoStageMode())).toBe('immersive');
  });

  // Tauri gets neither class and keeps its own pop-out WebviewWindow.
  test('a surface that is neither web nor native has no stage', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/');
    await page.evaluate(() => document.documentElement.classList.remove('is-web'));
    expect(await page.evaluate(() => videoStageMode())).toBe('none');
    expect(await page.evaluate(() => videoStageAvailable())).toBe(false);
  });

  test('a tiny embed has no stage, at any width', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/?embed=tiny');
    expect(await page.evaluate(() => videoStageMode())).toBe('none');
  });

  test('crossing the breakpoint switches mode without a reload', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/');
    expect(await page.evaluate(() => videoStageMode())).toBe('desktop');
    await page.setViewportSize(PHONE);
    expect(await page.evaluate(() => videoStageMode())).toBe('immersive');
  });
});

test.describe('body.video-stage-immersive', () => {
  test.use({ viewport: PHONE });

  test.beforeEach(async ({ page }) => { await page.goto('/'); });

  // The assertion that matters most: the feature is strictly additive.
  test('an audio-only room gets neither class', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true }],
    });
    expect(await page.evaluate(() => document.body.classList.contains('video-stage'))).toBe(false);
    expect(await page.evaluate(() => document.body.classList.contains('video-stage-immersive'))).toBe(false);
  });

  test('appears with the first camera and goes away with the last', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    expect(await page.evaluate(() => document.body.classList.contains('video-stage-immersive'))).toBe(true);

    await page.evaluate(() => {
      connections.get('p1').videoActive = false;
      updatePeerList();
    });
    expect(await page.evaluate(() => document.body.classList.contains('video-stage-immersive'))).toBe(false);
  });

  test('the desktop grid never claims a phone', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    const display = await page.evaluate(() =>
      getComputedStyle(document.getElementById('screen-room')).display);
    expect(display).not.toBe('grid');
  });

  // The stage cancels the room's safe-area padding exactly, so video reaches
  // the physical edges instead of sitting in an inset box.
  test('the stage fills the room edge to edge', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    const { stage, room } = await page.evaluate(() => ({
      stage: document.getElementById('video-stage').getBoundingClientRect().toJSON(),
      room: document.getElementById('screen-room').getBoundingClientRect().toJSON(),
    }));
    expect(Math.round(stage.width)).toBe(Math.round(room.width));
    expect(Math.round(stage.height)).toBe(Math.round(room.height));
  });

  // The stage runs under the chrome, so without measured insets the top tile
  // hides behind the roster strip and the bottom tile's name bar behind the
  // controls. The insets come off the grid's CONTENT box, which is also why the
  // column count has to be computed from the content box, not the border box.
  test('tiles sit between the chrome, not underneath it', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1', 'p2'],
      connections: [
        { id: 'p1', pseudo: 'Alice', open: true, videoActive: true },
        { id: 'p2', pseudo: 'Bob', open: true, videoActive: true },
      ],
    });
    const boxes = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect().toJSON();
      return {
        roster: r('.room-peers-panel'),
        bar: r('.room-bottom-bar'),
        tiles: [...document.querySelectorAll('#video-stage-grid .video-tile')]
          .map((e) => e.getBoundingClientRect().toJSON()),
      };
    });
    expect(boxes.tiles.length).toBe(2);
    for (const t of boxes.tiles) {
      expect(t.top).toBeGreaterThanOrEqual(Math.floor(boxes.roster.bottom));
      expect(t.bottom).toBeLessThanOrEqual(Math.ceil(boxes.bar.top));
      expect(t.height).toBeGreaterThan(0);
    }
  });

  test('hiding the chrome gives the space back to the tiles', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    const topPad = () => page.evaluate(() =>
      parseFloat(getComputedStyle(document.getElementById('video-stage-grid')).paddingTop));
    const before = await topPad();
    expect(before).toBeGreaterThan(0);

    await page.evaluate(() => {
      document.body.classList.add('stage-chrome-hidden');
      relayoutVideoStage();
    });
    expect(await topPad()).toBe(0);

    await page.evaluate(() => showStageChrome(true));
    expect(await topPad()).toBe(before);
  });

  // The talk button is the one control people reach for without looking, so it
  // is exempt from the auto-hide that takes the header and roster.
  test('the PTT button is never hidden with the chrome', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    await page.evaluate(() => document.body.classList.add('stage-chrome-hidden'));
    const opacity = (sel) => page.evaluate(
      (s) => getComputedStyle(document.querySelector(s)).opacity, sel);
    // The fade is a transition, so the header reaches 0 a beat after the class
    // lands — reading it synchronously catches it mid-animation at 1.
    await expect.poll(() => opacity('.room-header')).toBe('0');
    expect(await opacity('#ptt-btn')).toBe('1');
    expect(await opacity('.room-controls')).toBe('1');
  });

  test('a tap on the room reveals the chrome again', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    await page.evaluate(() => document.body.classList.add('stage-chrome-hidden'));
    await page.evaluate(() => {
      document.getElementById('video-stage').dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(await page.evaluate(() => document.body.classList.contains('stage-chrome-hidden'))).toBe(false);
  });
});

test.describe('capture and bitrate caps are mobile-aware', () => {
  test('a desktop keeps 720p30 and the full bitrate', async ({ page }) => {
    await page.goto('/');
    const cap = await page.evaluate(() => cameraCaptureCap());
    expect(cap.height.max).toBe(720);
    expect(await page.evaluate(() => cameraMaxBitrate())).toBe(600000);
  });

  test('a phone captures smaller and uploads less', async ({ page }) => {
    await fakeMobileUA(page);
    await page.goto('/');
    expect(await page.evaluate(() => IS_MOBILE_DEVICE)).toBe(true);
    const cap = await page.evaluate(() => cameraCaptureCap());
    expect(cap.height.max).toBe(360);
    expect(cap.frameRate.max).toBe(24);
    expect(await page.evaluate(() => cameraMaxBitrate())).toBe(300000);
  });

  // Never `exact` — forcing fixed dimensions renders a split frame on Desk View
  // and virtual cameras (KNOWLEDGE/learning.md).
  test('mobile capture constraints are still ideal/max, never exact', async ({ page }) => {
    await fakeMobileUA(page);
    await page.goto('/');
    const c = await page.evaluate(() => selectedCameraConstraints());
    expect(c.width.exact).toBeUndefined();
    expect(c.height.exact).toBeUndefined();
    expect(c.facingMode).toBe('user');
  });

  test('save-data and a slow link drop it further', async ({ page }) => {
    await fakeMobileUA(page);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'connection', {
        get: () => ({ saveData: true, effectiveType: '4g' }),
        configurable: true,
      });
    });
    await page.goto('/');
    expect(await page.evaluate(() => cameraMaxBitrate())).toBe(150000);
  });

  // WebKit — every iOS browser — has no Network Information API at all. Its
  // absence must fall through to the plain mobile cap, never to the desktop one.
  test('no Network Information API falls back to the mobile cap, not the desktop one', async ({ page }) => {
    await fakeMobileUA(page);
    await page.addInitScript(() => {
      delete navigator.connection;
      Object.defineProperty(navigator, 'connection', { get: () => undefined, configurable: true });
    });
    await page.goto('/');
    expect(await page.evaluate(() => cameraMaxBitrate())).toBe(300000);
  });
});

test.describe('camera flip', () => {
  test.use({ viewport: PHONE });

  test.beforeEach(async ({ page }) => {
    await fakeMobileUA(page);
  });

  test('the facing mode drives the capture constraints', async ({ page }) => {
    await page.goto('/');
    expect(await page.evaluate(() => selectedCameraConstraints().facingMode)).toBe('user');
    await page.evaluate(() => { _cameraFacing = 'environment'; });
    expect(await page.evaluate(() => selectedCameraConstraints().facingMode)).toBe('environment');
  });

  // On a phone the device list is not stable enough for a pinned deviceId to
  // mean anything, and the flip is expressed as a facing mode — so the facing
  // mode has to win. On a desktop the stored id still rules.
  test('a stored camera id does not override the facing mode on mobile', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('camera-device-id', 'cam-abc'));
    await page.goto('/');
    const c = await page.evaluate(() => selectedCameraConstraints());
    expect(c.deviceId).toBeUndefined();
    expect(c.facingMode).toBe('user');
  });

  // The rule that matters: a flip is not a stop. Re-publishing would renegotiate
  // and drop every viewer's tile, and a `video-stop` on the wire would clear the
  // peers' `videoActive` flag — which a live share never re-announces.
  test('swaps the track in place and says nothing on the wire', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(async () => {
      const sent = [];
      const replaced = [];
      const newTrack = { kind: 'video', stop() {}, enabled: true };
      // A real MediaStream, because the stage assigns it to video.srcObject —
      // only its track accessors are stubbed.
      const fakeStream = new MediaStream();
      fakeStream.getVideoTracks = () => [newTrack];
      fakeStream.getTracks = () => [newTrack];
      navigator.mediaDevices.getUserMedia = async () => fakeStream;

      const sender = {
        track: { kind: 'video' },
        replaceTrack: (t) => { replaced.push(t); return Promise.resolve(); },
        getParameters: () => ({ encodings: [{}] }),
        setParameters: () => Promise.resolve(),
      };
      const pc = { getSenders: () => [sender] };

      peer = { id: 'self' };
      inRoom = true;
      isHost = true;
      localVideoActive = true;
      const oldStream = new MediaStream();
      oldStream.getTracks = () => [{ stop() {} }];
      oldStream.getVideoTracks = () => [];
      localVideoStream = oldStream;
      connections.clear();
      connections.set('p1', {
        data: { send: (m) => sent.push(m) },
        videoMediaOut: { closed: false, peerConnection: pc },
      });

      await flipCamera();
      return {
        facing: _cameraFacing,
        replacedCount: replaced.length,
        replacedIsNew: replaced[0] === newTrack,
        stopMessages: sent.filter((m) => m && m.type === 'video-stop').length,
        anyMessages: sent.length,
        streamSwapped: localVideoStream === fakeStream,
      };
    });
    expect(result.facing).toBe('environment');
    expect(result.replacedCount).toBe(1);
    expect(result.replacedIsNew).toBe(true);
    expect(result.stopMessages).toBe(0);
    expect(result.anyMessages).toBe(0);
    expect(result.streamSwapped).toBe(true);
  });

  // A failed flip that leaves the call with a dead camera is far worse than one
  // that does nothing, so the old stream stays wired up and the facing reverts.
  test('a failed acquisition keeps the previous camera', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(async () => {
      navigator.mediaDevices.getUserMedia = async () => { throw new Error('NotAllowedError'); };
      const original = { getTracks: () => [], getVideoTracks: () => [] };
      peer = { id: 'self' };
      inRoom = true;
      localVideoActive = true;
      localVideoStream = original;
      connections.clear();
      await flipCamera();
      return { facing: _cameraFacing, kept: localVideoStream === original, active: localVideoActive };
    });
    expect(result.facing).toBe('user');
    expect(result.kept).toBe(true);
    expect(result.active).toBe(true);
  });

  test('the self-view stops being mirrored on the rear camera', async ({ page }) => {
    await page.goto('/');
    await enterRoom(page, { knownPeerIds: [], connections: [] });
    await page.evaluate(() => {
      localVideoActive = true;
      window._voxalVideoStream = new MediaStream();
      localVideoStream = window._voxalVideoStream;
      _cameraFacing = 'environment';
      updatePeerList();
    });
    const tile = page.locator('#video-stage [data-key="camera:self"]');
    expect(await tile.count()).toBe(1);
    expect(await tile.getAttribute('data-facing')).toBe('environment');
    const transform = await page.evaluate(() =>
      getComputedStyle(document.querySelector('#video-stage [data-key="camera:self"] video')).transform);
    expect(transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)').toBe(true);
  });
});

test.describe('background pause and wake lock', () => {
  test.use({ viewport: PHONE });

  test('backgrounding disables the camera track without stopping it', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(() => {
      let stopped = false;
      const track = { kind: 'video', enabled: true, stop() { stopped = true; } };
      localVideoStream = { getVideoTracks: () => [track], getTracks: () => [track] };
      setLocalCameraSuspended(true);
      const paused = { enabled: track.enabled, stopped };
      setLocalCameraSuspended(false);
      return { paused, resumedEnabled: track.enabled, stopped };
    });
    expect(result.paused.enabled).toBe(false);
    expect(result.paused.stopped).toBe(false);   // never stop(): that would renegotiate
    expect(result.resumedEnabled).toBe(true);
    expect(result.stopped).toBe(false);
  });

  test('a wake lock is taken while the stage is up and released when it stands down', async ({ page }) => {
    await page.addInitScript(() => {
      window.__wakeLocks = { requested: 0, released: 0 };
      Object.defineProperty(navigator, 'wakeLock', {
        get: () => ({
          request: async () => {
            window.__wakeLocks.requested++;
            return {
              release: () => { window.__wakeLocks.released++; },
              addEventListener: () => {},
            };
          },
        }),
        configurable: true,
      });
    });
    await page.goto('/');
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    await expect.poll(() => page.evaluate(() => window.__wakeLocks.requested)).toBeGreaterThan(0);

    await page.evaluate(() => {
      connections.get('p1').videoActive = false;
      updatePeerList();
    });
    await expect.poll(() => page.evaluate(() => window.__wakeLocks.released)).toBeGreaterThan(0);
  });

  test('an audio-only room never asks for a wake lock', async ({ page }) => {
    await page.addInitScript(() => {
      window.__wakeLocks = { requested: 0 };
      Object.defineProperty(navigator, 'wakeLock', {
        get: () => ({
          request: async () => {
            window.__wakeLocks.requested++;
            return { release: () => {}, addEventListener: () => {} };
          },
        }),
        configurable: true,
      });
    });
    await page.goto('/');
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true }],
    });
    expect(await page.evaluate(() => window.__wakeLocks.requested)).toBe(0);
  });

  // Feature-detected: older WebKit has no Wake Lock API and must not throw.
  test('no Wake Lock API is survivable', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'wakeLock', { get: () => undefined, configurable: true });
    });
    await page.goto('/');
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    expect(await page.evaluate(() => document.body.classList.contains('video-stage-immersive'))).toBe(true);
  });
});
