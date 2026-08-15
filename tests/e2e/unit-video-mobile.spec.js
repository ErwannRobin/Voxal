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
  // The header and roster OVERLAY the video, so they cost the tiles nothing —
  // only the always-present control stack does.
  test('tiles clear the control stack, and nothing else', async ({ page }) => {
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
        bar: r('.room-bottom-bar'),
        tiles: [...document.querySelectorAll('#video-stage-grid .video-tile')]
          .map((e) => e.getBoundingClientRect().toJSON()),
      };
    });
    expect(boxes.tiles.length).toBe(2);
    for (const t of boxes.tiles) {
      expect(t.bottom).toBeLessThanOrEqual(Math.ceil(boxes.bar.top));
      expect(t.height).toBeGreaterThan(0);
    }
    // Only the top handle sits above the tiles, so the top inset stays small —
    // if this grows, a panel has started reserving space again.
    const padTop = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.getElementById('video-stage-grid')).paddingTop));
    expect(padTop).toBeLessThanOrEqual(30);
  });

  // The talk button and the control row are never hidden — this is a
  // push-to-talk app, and the talk button is the one control people reach for
  // without looking.
  test('the PTT button and controls stay visible with a panel open', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    await page.evaluate(() => setStagePanel('roster', true));
    const visible = (sel) => page.evaluate((s) => {
      const st = getComputedStyle(document.querySelector(s));
      return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
    }, sel);
    expect(await visible('#ptt-btn')).toBe(true);
    expect(await visible('.room-controls')).toBe(true);

    // Visible is not enough — the scrim behind an open panel must stop above the
    // control stack, or it swallows the tap it does not dim.
    const hit = await page.evaluate(() => {
      const b = document.getElementById('ptt-btn').getBoundingClientRect();
      const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return { isPtt: el === document.getElementById('ptt-btn') || document.getElementById('ptt-btn').contains(el),
               got: el && el.id };
    });
    expect(hit.isPtt).toBe(true);
  });
});

// Switching a camera on must not restyle the room. The panels keep the app's
// own surface colours, which is also what makes them legible over video without
// a video-only palette.
test.describe('the room keeps its colours in video mode', () => {
  test.use({ viewport: PHONE });

  test('the control buttons look identical with and without video', async ({ page }) => {
    await page.goto('/');
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true }],
    });
    const styles = () => page.evaluate(() => {
      const pick = (s) => {
        const st = getComputedStyle(document.querySelector(s));
        return { bg: st.backgroundColor, color: st.color, border: st.borderColor };
      };
      return { btn: pick('#btn-freehand'), status: pick('.ptt-status') };
    });
    const audioOnly = await styles();
    expect(await page.evaluate(() => document.body.classList.contains('video-stage-immersive'))).toBe(false);

    await page.evaluate(() => {
      connections.get('p1').videoActive = true;
      updatePeerList();
    });
    expect(await page.evaluate(() => document.body.classList.contains('video-stage-immersive'))).toBe(true);
    expect(await styles()).toEqual(audioOnly);
  });
});

// The header and the participant list slide off-screen while video is live and
// are pulled back over the tiles by a drag handle.
test.describe('sliding panels', () => {
  test.use({ viewport: PHONE });

  test.beforeEach(async ({ page }) => { await page.goto('/'); });

  const withVideo = (page) => enterRoom(page, {
    knownPeerIds: ['p1'],
    connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
  });

  const onScreen = (page, sel) => page.evaluate((s) => {
    const b = document.querySelector(s).getBoundingClientRect();
    return b.left < window.innerWidth && b.right > 0 && b.top < window.innerHeight && b.bottom > 0;
  }, sel);

  test('both panels start off-screen, and their handles are on it', async ({ page }) => {
    await withVideo(page);
    expect(await onScreen(page, '#screen-room .room-header')).toBe(false);
    expect(await onScreen(page, '#screen-room .room-peers-panel')).toBe(false);
    for (const id of ['#stage-handle-header', '#stage-handle-roster']) {
      expect(await page.evaluate((s) =>
        getComputedStyle(document.querySelector(s)).display, id)).toBe('flex');
    }
  });

  test('an audio-only room keeps both in their normal place', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true }],
    });
    expect(await onScreen(page, '#screen-room .room-header')).toBe(true);
    expect(await onScreen(page, '#screen-room .room-peers-panel')).toBe(true);
    expect(await page.evaluate(() =>
      getComputedStyle(document.getElementById('stage-handle-header')).display)).toBe('none');
  });

  test('tapping a handle slides its panel in, and again slides it out', async ({ page }) => {
    await withVideo(page);
    await page.locator('#stage-handle-header').click();
    await expect.poll(() => onScreen(page, '#screen-room .room-header')).toBe(true);
    expect(await page.locator('#stage-handle-header').getAttribute('aria-expanded')).toBe('true');

    await page.locator('#stage-handle-header').click();
    await expect.poll(() => onScreen(page, '#screen-room .room-header')).toBe(false);
  });

  test('the roster handle slides the participant list in from the right', async ({ page }) => {
    await withVideo(page);
    await page.locator('#stage-handle-roster').click();
    await expect.poll(() => onScreen(page, '#screen-room .room-peers-panel')).toBe(true);
    // It overlays the video rather than reflowing it: the tiles are unmoved.
    const tileBefore = await page.evaluate(() =>
      document.querySelector('#video-stage-grid .video-tile').getBoundingClientRect().toJSON());
    await page.evaluate(() => setStagePanel('roster', false));
    await page.waitForTimeout(300);
    const tileAfter = await page.evaluate(() =>
      document.querySelector('#video-stage-grid .video-tile').getBoundingClientRect().toJSON());
    expect(Math.round(tileAfter.height)).toBe(Math.round(tileBefore.height));
  });

  // They are alternatives — two panels open at once on a phone would overlap.
  test('opening one panel closes the other', async ({ page }) => {
    await withVideo(page);
    await page.evaluate(() => setStagePanel('header', true));
    await page.evaluate(() => setStagePanel('roster', true));
    expect(await page.evaluate(() => stagePanelOpen('header'))).toBe(false);
    expect(await page.evaluate(() => stagePanelOpen('roster'))).toBe(true);
  });

  test('a drag past the commit threshold opens the panel; a short one snaps back', async ({ page }) => {
    await withVideo(page);
    const handle = page.locator('#stage-handle-header');
    const box = await handle.boundingBox();
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    // A few pixels: under the threshold, so it must snap back closed.
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x, from.y + 10, { steps: 3 });
    await page.mouse.up();
    expect(await page.evaluate(() => stagePanelOpen('header'))).toBe(false);

    // Well past it: opens.
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x, from.y + 200, { steps: 8 });
    await page.mouse.up();
    expect(await page.evaluate(() => stagePanelOpen('header'))).toBe(true);
  });

  test('leaving the stage never strands a panel open', async ({ page }) => {
    await withVideo(page);
    await page.evaluate(() => setStagePanel('roster', true));
    await page.evaluate(() => {
      connections.get('p1').videoActive = false;
      updatePeerList();
    });
    expect(await page.evaluate(() => stagePanelOpen('roster'))).toBe(false);
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

  // Flip belongs to the camera, not to the room — so it lives on the self-view
  // tile, and because renderVideoStage() MOVES the same element between the grid
  // and the minimized badge, one button serves both.
  test('the button rides on the self-view tile, not the control row', async ({ page }) => {
    await page.goto('/');
    await enterRoom(page, { knownPeerIds: [], connections: [] });
    await page.evaluate(() => {
      localVideoActive = true;
      localVideoStream = new MediaStream();
      window._voxalVideoStream = localVideoStream;
      _cameraFlipSupported = true;
      updatePeerList();
    });
    expect(await page.locator('#video-stage [data-key="camera:self"] .video-tile-flip').count()).toBe(1);
    expect(await page.locator('.room-controls #btn-flip-camera').count()).toBe(0);
  });

  test('it is offered only when there is a second camera to switch to', async ({ page }) => {
    await page.goto('/');
    await enterRoom(page, { knownPeerIds: [], connections: [] });
    await page.evaluate(() => {
      localVideoActive = true;
      localVideoStream = new MediaStream();
      window._voxalVideoStream = localVideoStream;
      _cameraFlipSupported = false;
      updatePeerList();
    });
    const btn = page.locator('#video-stage [data-key="camera:self"] .video-tile-flip');
    expect(await btn.evaluate((e) => getComputedStyle(e).display)).toBe('none');
    await page.evaluate(() => { _cameraFlipSupported = true; updatePeerList(); });
    expect(await btn.evaluate((e) => getComputedStyle(e).display)).toBe('flex');
  });

  // Every tile carries a click-to-pin handler and the badge carries a drag;
  // pressing flip must trigger neither.
  test('pressing it does not also pin the tile', async ({ page }) => {
    await page.goto('/');
    await enterRoom(page, { knownPeerIds: [], connections: [] });
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        const s = new MediaStream();
        s.getVideoTracks = () => [{ kind: 'video', enabled: true, stop() {} }];
        s.getTracks = () => s.getVideoTracks();
        return s;
      };
      localVideoActive = true;
      localVideoStream = new MediaStream();
      window._voxalVideoStream = localVideoStream;
      _cameraFlipSupported = true;
      updatePeerList();
    });
    await page.locator('#video-stage [data-key="camera:self"] .video-tile-flip').click();
    expect(await page.evaluate(() => _stagePinnedKey)).toBeNull();
    await expect.poll(() => page.evaluate(() => _cameraFacing)).toBe('environment');
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
