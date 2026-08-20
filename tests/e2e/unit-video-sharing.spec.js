import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// Starting and stopping a camera or screen share: the capture, the p2p mesh
// calls it fans out, the stop message every peer needs, and the video-mode
// switch that gates the whole feature.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    window.__mkVideoStream = function() {
      const c = document.createElement('canvas');
      c.width = 320; c.height = 240;
      c.getContext('2d').fillRect(0, 0, 1, 1);
      return c.captureStream(5);
    };
    window.__gumFail = null;
    window.__displayFail = null;
    navigator.mediaDevices.getUserMedia = function() {
      if (window.__gumFail) return Promise.reject(window.__gumFail);
      return Promise.resolve(window.__mkVideoStream());
    };
    navigator.mediaDevices.getDisplayMedia = function() {
      if (window.__displayFail) return Promise.reject(window.__displayFail);
      return Promise.resolve(window.__mkVideoStream());
    };
    navigator.mediaDevices.enumerateDevices = () => Promise.resolve([
      { kind: 'videoinput', deviceId: 'cam-1', label: 'Front' },
      { kind: 'videoinput', deviceId: 'cam-2', label: 'Back' },
    ]);
    // Keep every share on the mesh: the SFU needs a live endpoint.
    localStorage.setItem('video-routing-mode', 'p2p-only');
  });
});

/** A room where every peer can take a mesh MediaConnection. */
async function seedSharingRoom(page) {
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
  });
}

test.describe('sharing your camera', () => {
  test('captures, calls every peer and announces the offer', async ({ page }) => {
    await seedSharingRoom(page);
    const seen = await page.evaluate(async () => {
      const sent = [];
      connections.forEach((c) => { c.data.send = (m) => sent.push(m); });
      await startVideoShare();
      return {
        active: localVideoActive,
        hasStream: !!localVideoStream,
        calls: window.__calls.map((c) => ({ peer: c.peer, kind: c.metadata && c.metadata.type })),
        offers: sent.filter((m) => m.type === 'video-offer'),
        freeHand: freeHandMode,
      };
    });
    expect(seen.active).toBe(true);
    expect(seen.hasStream).toBe(true);
    expect(seen.calls).toEqual([
      { peer: 'p1', kind: 'video' },
      { peer: 'p2', kind: 'video' },
    ]);
    expect(seen.offers).toHaveLength(2);
    expect(seen.offers[0].topology).toBe('p2p');
    // Sharing your face while holding a key would be absurd — it latches.
    expect(seen.freeHand).toBe(true);
  });

  test('a second start is a no-op', async ({ page }) => {
    await seedSharingRoom(page);
    const calls = await page.evaluate(async () => {
      await startVideoShare();
      const first = window.__calls.length;
      await startVideoShare();
      return { first, second: window.__calls.length };
    });
    expect(calls.second).toBe(calls.first);
  });

  test('a refused camera leaves the room unchanged and says why', async ({ page }) => {
    await seedSharingRoom(page);
    const seen = await page.evaluate(async () => {
      window.__gumFail = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
      await startVideoShare();
      return { active: localVideoActive, stream: localVideoStream, calls: window.__calls.length };
    });
    expect(seen).toEqual({ active: false, stream: null, calls: 0 });
    await expect(page.locator('#copy-toast')).toHaveText('Camera access was blocked by the browser.');
  });

  test('stopping closes the calls, stops the track and tells the room', async ({ page }) => {
    await seedSharingRoom(page);
    const seen = await page.evaluate(async () => {
      await startVideoShare();
      const track = localVideoStream.getVideoTracks()[0];
      const sent = [];
      connections.forEach((c) => { c.data.send = (m) => sent.push(m); });
      stopVideoShare();
      return {
        active: localVideoActive,
        stream: localVideoStream,
        trackLive: track.readyState === 'live',
        closed: window.__calls.every((c) => c.closed),
        stops: sent.filter((m) => m.type === 'video-stop'),
      };
    });
    expect(seen.active).toBe(false);
    expect(seen.stream).toBe(null);
    expect(seen.trackLive).toBe(false);
    expect(seen.closed).toBe(true);
    expect(seen.stops).toHaveLength(2);
    expect(seen.stops[0].peerId).toBe('host');
  });

  test('stopping when nothing is shared does nothing', async ({ page }) => {
    await seedSharingRoom(page);
    const sent = await page.evaluate(() => {
      const out = [];
      connections.forEach((c) => { c.data.send = (m) => out.push(m); });
      stopVideoShare();
      return out;
    });
    expect(sent).toEqual([]);
  });

  test('a non-host sends its stop to the host only', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'p2',
      isHost: false,
      roomCode: 'host',
      connections: [{ id: 'host' }, { id: 'p3' }],
    });
    const seen = await page.evaluate(() => {
      peer = { id: 'p2', destroyed: false, call: () => null };
      localVideoActive = true;
      localVideoStream = null;
      const to = [];
      connections.forEach((c, id) => { c.data.send = (m) => { if (m.type === 'video-stop') to.push(id); }; });
      stopVideoShare();
      return to;
    });
    expect(seen).toEqual(['host']);
  });
});

test.describe('sharing your screen', () => {
  test('captures, calls every peer and announces the offer', async ({ page }) => {
    await seedSharingRoom(page);
    const seen = await page.evaluate(async () => {
      const sent = [];
      connections.forEach((c) => { c.data.send = (m) => sent.push(m); });
      await startScreenShare();
      return {
        active: localScreenActive,
        calls: window.__calls.map((c) => c.metadata && c.metadata.type),
        offers: sent.filter((m) => m.type === 'screen-offer').length,
      };
    });
    expect(seen.active).toBe(true);
    expect(seen.calls).toEqual(['screen', 'screen']);
    expect(seen.offers).toBe(2);
  });

  test('the browser\'s own "stop sharing" ends the share', async ({ page }) => {
    await seedSharingRoom(page);
    const active = await page.evaluate(async () => {
      await startScreenShare();
      // The picker's Stop button fires `ended` on the track.
      localScreenStream.getVideoTracks()[0].dispatchEvent(new Event('ended'));
      return localScreenActive;
    });
    expect(active).toBe(false);
  });

  test('cancelling the picker leaves the room unchanged', async ({ page }) => {
    await seedSharingRoom(page);
    const seen = await page.evaluate(async () => {
      window.__displayFail = new Error('user cancelled');
      await startScreenShare();
      return { active: localScreenActive, calls: window.__calls.length };
    });
    expect(seen).toEqual({ active: false, calls: 0 });
    await expect(page.locator('#copy-toast')).toHaveText('Screen share cancelled');
  });

  test('a browser with no screen capture says so', async ({ page }) => {
    await seedSharingRoom(page);
    const active = await page.evaluate(async () => {
      navigator.mediaDevices.getDisplayMedia = undefined;
      await startScreenShare();
      return localScreenActive;
    });
    expect(active).toBe(false);
    await expect(page.locator('#copy-toast')).toHaveText('Screen sharing not supported');
  });

  test('stopping closes the calls and tells the room', async ({ page }) => {
    await seedSharingRoom(page);
    const seen = await page.evaluate(async () => {
      await startScreenShare();
      const sent = [];
      connections.forEach((c) => { c.data.send = (m) => sent.push(m); });
      stopScreenShare();
      return {
        active: localScreenActive,
        stream: localScreenStream,
        stops: sent.filter((m) => m.type === 'screen-stop').length,
      };
    });
    expect(seen).toEqual({ active: false, stream: null, stops: 2 });
  });
});

test.describe('the video-mode switch', () => {
  test('turning it off stops whatever was being shared', async ({ page }) => {
    await seedSharingRoom(page);
    const seen = await page.evaluate(async () => {
      videoModeEnabled = true;
      await startVideoShare();
      await startScreenShare();
      toggleVideoMode();
      return {
        enabled: videoModeEnabled,
        stored: localStorage.getItem('video-mode-enabled'),
        video: localVideoActive,
        screen: localScreenActive,
      };
    });
    expect(seen).toEqual({ enabled: false, stored: 'false', video: false, screen: false });
  });

  test('a host tells the room when it flips', async ({ page }) => {
    await seedSharingRoom(page);
    const sent = await page.evaluate(() => {
      const out = [];
      connections.forEach((c) => { c.data.send = (m) => out.push(m); });
      videoModeEnabled = false;
      toggleVideoMode();
      return out.filter((m) => m.type === 'video-mode');
    });
    expect(sent).toHaveLength(2);
    expect(sent[0].enabled).toBe(true);
  });

  test('the room controls follow the switch', async ({ page }) => {
    await seedSharingRoom(page);
    const seen = await page.evaluate(() => {
      videoModeEnabled = true;
      updateVideoModeUI();
      const on = !document.getElementById('btn-share-camera').classList.contains('hidden');
      videoModeEnabled = false;
      updateVideoModeUI();
      return { on, off: !document.getElementById('btn-share-camera').classList.contains('hidden') };
    });
    expect(seen).toEqual({ on: true, off: false });
  });

  test('the camera button shows as active while sharing', async ({ page }) => {
    await seedSharingRoom(page);
    const seen = await page.evaluate(async () => {
      videoModeEnabled = true;
      await startVideoShare();
      const btn = document.getElementById('btn-share-camera');
      const on = { active: btn.classList.contains('active'), pressed: btn.getAttribute('aria-pressed') };
      stopVideoShare();
      return { on, off: btn.classList.contains('active') };
    });
    expect(seen.on).toEqual({ active: true, pressed: 'true' });
    expect(seen.off).toBe(false);
  });

  test('an absent key means video is on — shipping it needed no migration', async ({ page }) => {
    const seen = await page.evaluate(() => {
      localStorage.removeItem('video-mode-enabled');
      const dflt = readVideoModeEnabled();
      localStorage.setItem('video-mode-enabled', 'false');
      const off = readVideoModeEnabled();
      localStorage.setItem('video-mode-enabled', 'true');
      const on = readVideoModeEnabled();
      localStorage.removeItem('video-mode-enabled');
      return { dflt, off, on };
    });
    expect(seen).toEqual({ dflt: true, off: false, on: true });
  });
});

test.describe('publishing over the mesh', () => {
  test('a peer that joins later is called with the live camera', async ({ page }) => {
    await seedSharingRoom(page);
    const called = await page.evaluate(async () => {
      await startVideoShare();
      window.__calls.length = 0;
      connections.set('late', { data: { open: true, closed: false, send() {}, close() {} } });
      p2pPublishVideo('late', connections.get('late'), localVideoStream);
      return window.__calls.map((c) => ({ peer: c.peer, kind: c.metadata && c.metadata.type }));
    });
    expect(called).toEqual([{ peer: 'late', kind: 'video' }]);
  });

  test('a late screen share reaches a newcomer the same way', async ({ page }) => {
    await seedSharingRoom(page);
    const called = await page.evaluate(async () => {
      await startScreenShare();
      window.__calls.length = 0;
      connections.set('late', { data: { open: true, closed: false, send() {}, close() {} } });
      p2pPublishScreen('late', connections.get('late'), localScreenStream);
      return window.__calls.map((c) => ({ peer: c.peer, kind: c.metadata && c.metadata.type }));
    });
    expect(called).toEqual([{ peer: 'late', kind: 'screen' }]);
  });

  test('unpublishing closes the outgoing call it opened', async ({ page }) => {
    await seedSharingRoom(page);
    const seen = await page.evaluate(async () => {
      await startVideoShare();
      const c = connections.get('p1');
      const had = !!c.videoMediaOut;
      p2pUnpublishVideo('p1', c);
      return { had, after: c.videoMediaOut, closed: window.__calls[0].closed };
    });
    expect(seen).toEqual({ had: true, after: null, closed: true });
  });

  test('unpublishing a peer that was never published is safe', async ({ page }) => {
    await seedSharingRoom(page);
    const threw = await page.evaluate(() => {
      try {
        p2pUnpublishVideo('p1', connections.get('p1'));
        p2pUnpublishScreen('p1', connections.get('p1'));
        return false;
      } catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });
});

test.describe('camera flip', () => {
  test('is never offered on a desktop, whatever the device list says', async ({ page }) => {
    // Front/back is a phone concept; a desktop with two webcams gets no flip.
    const seen = await page.evaluate(async () => {
      const twoCameras = await cameraFlipAvailable();
      navigator.mediaDevices.enumerateDevices = () => Promise.reject(new Error('denied'));
      const failed = await cameraFlipAvailable();
      return { twoCameras, failed, mobile: IS_MOBILE_DEVICE };
    });
    expect(seen.mobile).toBe(false);
    expect(seen.twoCameras).toBe(false);
    expect(seen.failed).toBe(false);
  });

  test('suspending the local camera only disables the track', async ({ page }) => {
    await seedSharingRoom(page);
    const seen = await page.evaluate(async () => {
      await startVideoShare();
      const track = localVideoStream.getVideoTracks()[0];
      setLocalCameraSuspended(true);
      const suspended = { enabled: track.enabled, live: track.readyState === 'live' };
      setLocalCameraSuspended(false);
      return { suspended, resumed: track.enabled };
    });
    // Stopping the track instead would need a fresh permission prompt to resume.
    expect(seen.suspended).toEqual({ enabled: false, live: true });
    expect(seen.resumed).toBe(true);
  });

  test('stopStreamTracks stops everything, and tolerates nothing', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const s = window.__mkVideoStream();
      const track = s.getVideoTracks()[0];
      stopStreamTracks(s);
      stopStreamTracks(null);
      return track.readyState === 'live';
    });
    expect(seen).toBe(false);
  });
});
