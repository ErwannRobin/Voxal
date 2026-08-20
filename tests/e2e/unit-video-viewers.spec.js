import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// The floating camera / screen viewers: opening one onto a peer's stream,
// keeping it pointed at that peer as the transport changes underneath, popping
// it into Picture-in-Picture, and tearing everything down on the way out.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await seedRoom(page, {
    selfId: 'self',
    isHost: true,
    connections: [{ id: 'p1', pseudo: 'Ada' }, { id: 'p2', pseudo: 'Grace' }],
  });
  await page.evaluate(() => {
    // A canvas capture is a real MediaStream with a real video track, which is
    // what the viewer, the FPS overlay and PiP all read.
    window.__mkVideoStream = function() {
      const c = document.createElement('canvas');
      c.width = 320; c.height = 240;
      c.getContext('2d').fillRect(0, 0, 1, 1);
      return c.captureStream(5);
    };
  });
});

test.describe('the camera viewer', () => {
  test('opens onto the peer it was asked for, with their name on it', async ({ page }) => {
    const seen = await page.evaluate(() => {
      connections.get('p1').remoteVideoStream = window.__mkVideoStream();
      openVideoViewer('p1');
      const panel = document.getElementById('video-viewer-panel');
      const vid = document.getElementById('video-viewer-element');
      return {
        viewer: _videoViewerPeerId,
        hidden: panel.classList.contains('hidden'),
        hasStream: !!vid.srcObject,
        title: document.getElementById('video-viewer-title').textContent,
      };
    });
    expect(seen).toEqual({ viewer: 'p1', hidden: false, hasStream: true, title: '📹 Ada' });
  });

  test('a peer with no stream does not open anything', async ({ page }) => {
    const seen = await page.evaluate(() => {
      openVideoViewer('p2');
      openVideoViewer('nobody');
      return {
        viewer: _videoViewerPeerId,
        hidden: document.getElementById('video-viewer-panel').classList.contains('hidden'),
      };
    });
    expect(seen).toEqual({ viewer: null, hidden: true });
  });

  test('closing clears the element and forgets the peer', async ({ page }) => {
    const seen = await page.evaluate(() => {
      connections.get('p1').remoteVideoStream = window.__mkVideoStream();
      openVideoViewer('p1');
      closeVideoViewer();
      const panel = document.getElementById('video-viewer-panel');
      return {
        viewer: _videoViewerPeerId,
        hidden: panel.classList.contains('hidden'),
        pip: panel.classList.contains('pip-active'),
        srcObject: document.getElementById('video-viewer-element').srcObject,
      };
    });
    expect(seen).toEqual({ viewer: null, hidden: true, pip: false, srcObject: null });
  });

  test('a stream arriving for the open viewer re-attaches it', async ({ page }) => {
    const seen = await page.evaluate(() => {
      connections.get('p1').remoteVideoStream = window.__mkVideoStream();
      openVideoViewer('p1');
      document.getElementById('video-viewer-element').srcObject = null;
      // A reconnect delivers a fresh stream for the same peer.
      const next = window.__mkVideoStream();
      attachRemoteVideo('p1', next);
      return {
        stored: connections.get('p1').remoteVideoStream === next,
        reattached: document.getElementById('video-viewer-element').srcObject === next,
      };
    });
    expect(seen).toEqual({ stored: true, reattached: true });
  });

  test('a peer stopping their camera closes the viewer that was watching them', async ({ page }) => {
    const seen = await page.evaluate(() => {
      connections.get('p1').remoteVideoStream = window.__mkVideoStream();
      connections.get('p1').videoActive = true;
      openVideoViewer('p1');
      markPeerVideoActive('p1', false);
      return { viewer: _videoViewerPeerId, active: connections.get('p1').videoActive };
    });
    expect(seen).toEqual({ viewer: null, active: false });
  });

  test('someone else stopping theirs leaves the viewer alone', async ({ page }) => {
    const viewer = await page.evaluate(() => {
      connections.get('p1').remoteVideoStream = window.__mkVideoStream();
      openVideoViewer('p1');
      markPeerVideoActive('p2', false);
      return _videoViewerPeerId;
    });
    expect(viewer).toBe('p1');
  });

  test('detaching drops the stream, the transport and the viewer together', async ({ page }) => {
    const seen = await page.evaluate(() => {
      let closed = false;
      const c = connections.get('p1');
      c.remoteVideoStream = window.__mkVideoStream();
      c.videoActive = true;
      c.videoMedia = { close: () => { closed = true; } };
      openVideoViewer('p1');
      detachRemoteVideo('p1');
      return { closed, stream: c.remoteVideoStream, active: c.videoActive, viewer: _videoViewerPeerId };
    });
    expect(seen).toEqual({ closed: true, stream: null, active: false, viewer: null });
  });

  test('a transport-only detach keeps the share alive and the viewer open', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const c = connections.get('p1');
      c.remoteVideoStream = window.__mkVideoStream();
      c.videoActive = true;
      c.videoMedia = { close() {} };
      openVideoViewer('p1');
      // Only the route is changing (mesh <-> SFU) — the peer is still sharing.
      detachRemoteVideoTransport('p1');
      return { stream: c.remoteVideoStream, media: c.videoMedia, active: c.videoActive, viewer: _videoViewerPeerId };
    });
    expect(seen).toEqual({ stream: null, media: null, active: true, viewer: 'p1' });
  });

  test('a transport detach for an unknown peer is a no-op', async ({ page }) => {
    const threw = await page.evaluate(() => {
      try { detachRemoteVideoTransport('nobody'); return false; } catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });
});

test.describe('the screen viewer', () => {
  test('opens onto the peer it was asked for', async ({ page }) => {
    const seen = await page.evaluate(() => {
      connections.get('p2').remoteScreenStream = window.__mkVideoStream();
      openScreenViewer('p2');
      return {
        viewer: _screenViewerPeerId,
        hidden: document.getElementById('screen-viewer-panel').classList.contains('hidden'),
        title: document.getElementById('screen-viewer-title').textContent,
      };
    });
    expect(seen).toEqual({ viewer: 'p2', hidden: false, title: '🖥 Grace' });
  });

  test('closes when the sharer stops, and on request', async ({ page }) => {
    const seen = await page.evaluate(() => {
      connections.get('p2').remoteScreenStream = window.__mkVideoStream();
      connections.get('p2').screenActive = true;
      openScreenViewer('p2');
      markPeerScreenActive('p2', false);
      const afterStop = _screenViewerPeerId;

      connections.get('p2').remoteScreenStream = window.__mkVideoStream();
      openScreenViewer('p2');
      closeScreenViewer();
      return { afterStop, afterClose: _screenViewerPeerId };
    });
    expect(seen).toEqual({ afterStop: null, afterClose: null });
  });

  test('a stream arriving for the open viewer re-attaches it', async ({ page }) => {
    const attached = await page.evaluate(() => {
      connections.get('p2').remoteScreenStream = window.__mkVideoStream();
      openScreenViewer('p2');
      const next = window.__mkVideoStream();
      attachRemoteScreen('p2', next);
      return document.getElementById('screen-viewer-element').srcObject === next;
    });
    expect(attached).toBe(true);
  });

  test('detaching drops the stream, the transport and the viewer together', async ({ page }) => {
    const seen = await page.evaluate(() => {
      let closed = false;
      const c = connections.get('p2');
      c.remoteScreenStream = window.__mkVideoStream();
      c.screenActive = true;
      c.screenMedia = { close: () => { closed = true; } };
      openScreenViewer('p2');
      detachRemoteScreen('p2');
      return { closed, stream: c.remoteScreenStream, active: c.screenActive, viewer: _screenViewerPeerId };
    });
    expect(seen).toEqual({ closed: true, stream: null, active: false, viewer: null });
  });
});

test.describe('incoming media calls', () => {
  test('a video call is answered and its stream becomes the peer\'s camera', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const handlers = {};
      const call = {
        peer: 'p1',
        answered: false,
        answer() { this.answered = true; },
        on(e, fn) { (handlers[e] = handlers[e] || []).push(fn); },
      };
      handleIncomingVideoCall(call);
      const s = window.__mkVideoStream();
      handlers.stream.forEach((fn) => fn(s));
      const c = connections.get('p1');
      return { answered: call.answered, stream: c.remoteVideoStream === s, active: c.videoActive, media: c.videoMedia === call };
    });
    expect(seen).toEqual({ answered: true, stream: true, active: true, media: true });
  });

  test('a video call closing clears the peer, but only if it is still the live one', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const handlers = {};
      const call = { peer: 'p1', answer() {}, on(e, fn) { (handlers[e] = handlers[e] || []).push(fn); } };
      handleIncomingVideoCall(call);
      handlers.stream.forEach((fn) => fn(window.__mkVideoStream()));

      // A newer call has since replaced this one — the old close must not clear it.
      connections.get('p1').videoMedia = { close() {} };
      handlers.close.forEach((fn) => fn());
      const survived = !!connections.get('p1').remoteVideoStream;

      connections.get('p1').videoMedia = call;
      handlers.close.forEach((fn) => fn());
      const c = connections.get('p1');
      return { survived, stream: c.remoteVideoStream, active: c.videoActive, media: c.videoMedia };
    });
    expect(seen).toEqual({ survived: true, stream: null, active: false, media: null });
  });

  test('a screen call follows the same lifecycle', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const handlers = {};
      const call = { peer: 'p2', answered: false, answer() { this.answered = true; }, on(e, fn) { (handlers[e] = handlers[e] || []).push(fn); } };
      handleIncomingScreenCall(call);
      handlers.stream.forEach((fn) => fn(window.__mkVideoStream()));
      const opened = { active: connections.get('p2').screenActive, media: connections.get('p2').screenMedia === call };
      handlers.close.forEach((fn) => fn());
      const c = connections.get('p2');
      return { answered: call.answered, opened, closedStream: c.remoteScreenStream, closedActive: c.screenActive };
    });
    expect(seen.answered).toBe(true);
    expect(seen.opened).toEqual({ active: true, media: true });
    expect(seen.closedStream).toBe(null);
    expect(seen.closedActive).toBe(false);
  });
});

test.describe('popping the camera viewer out', () => {
  test('uses Picture-in-Picture where the browser offers it', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      connections.get('p1').remoteVideoStream = window.__mkVideoStream();
      openVideoViewer('p1');
      const vid = document.getElementById('video-viewer-element');
      let asked = false;
      Object.defineProperty(document, 'pictureInPictureEnabled', { value: true, configurable: true });
      vid.requestPictureInPicture = () => { asked = true; return Promise.resolve(); };
      popOutVideoViewer();
      await new Promise((r) => setTimeout(r, 10));
      return { asked, pip: document.getElementById('video-viewer-panel').classList.contains('pip-active') };
    });
    expect(seen).toEqual({ asked: true, pip: true });
  });

  test('falls back to WebKit presentation mode', async ({ page }) => {
    const seen = await page.evaluate(() => {
      connections.get('p1').remoteVideoStream = window.__mkVideoStream();
      openVideoViewer('p1');
      const vid = document.getElementById('video-viewer-element');
      let mode = null;
      Object.defineProperty(document, 'pictureInPictureEnabled', { value: false, configurable: true });
      vid.requestPictureInPicture = undefined;
      vid.webkitSetPresentationMode = (m) => { mode = m; };
      popOutVideoViewer();
      return { mode, pip: document.getElementById('video-viewer-panel').classList.contains('pip-active') };
    });
    expect(seen).toEqual({ mode: 'picture-in-picture', pip: true });
  });

  test('says so when neither is available', async ({ page }) => {
    await page.evaluate(() => {
      connections.get('p1').remoteVideoStream = window.__mkVideoStream();
      openVideoViewer('p1');
      const vid = document.getElementById('video-viewer-element');
      Object.defineProperty(document, 'pictureInPictureEnabled', { value: false, configurable: true });
      vid.requestPictureInPicture = undefined;
      vid.webkitSetPresentationMode = undefined;
      popOutVideoViewer();
    });
    await expect(page.locator('#copy-toast')).toHaveText('Picture-in-Picture not available');
  });

  test('a rejected request reports the failure instead of claiming success', async ({ page }) => {
    const pip = await page.evaluate(async () => {
      connections.get('p1').remoteVideoStream = window.__mkVideoStream();
      openVideoViewer('p1');
      const vid = document.getElementById('video-viewer-element');
      Object.defineProperty(document, 'pictureInPictureEnabled', { value: true, configurable: true });
      vid.requestPictureInPicture = () => Promise.reject(new Error('denied'));
      popOutVideoViewer();
      await new Promise((r) => setTimeout(r, 10));
      return document.getElementById('video-viewer-panel').classList.contains('pip-active');
    });
    expect(pip).toBe(false);
  });

  test('with no viewer open there is nothing to pop out', async ({ page }) => {
    const threw = await page.evaluate(() => {
      _videoViewerPeerId = null;
      try { popOutVideoViewer(); popOutScreenViewer(); return false; } catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });
});

test.describe('the FPS overlay', () => {
  test('stays off unless dev mode is on', async ({ page }) => {
    const id = await page.evaluate(() => {
      localStorage.setItem('dev-mode', 'false');
      return _startFpsOverlay('video-viewer-element', 'video-viewer-fps');
    });
    expect(id).toBe(null);
  });

  test('runs while dev mode is on, and stops cleanly', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      localStorage.setItem('dev-mode', 'true');
      const vid = document.getElementById('video-viewer-element');
      vid.srcObject = window.__mkVideoStream();
      const id = _startFpsOverlay('video-viewer-element', 'video-viewer-fps');
      const overlayShown = !document.getElementById('video-viewer-fps').classList.contains('hidden');
      await new Promise((r) => setTimeout(r, 1100));
      const text = document.getElementById('video-viewer-fps').textContent;
      const stopped = _stopFpsOverlay(id, 'video-viewer-fps');
      localStorage.setItem('dev-mode', 'false');
      return { started: !!id, overlayShown, text, stopped };
    });
    expect(seen.started).toBe(true);
    expect(seen.overlayShown).toBe(true);
    expect(seen.text).toMatch(/\d+ fps/);
    expect(seen.stopped).toBe(null);
  });

  test('stopping nothing is safe', async ({ page }) => {
    expect(await page.evaluate(() => _stopFpsOverlay(null, 'video-viewer-fps'))).toBe(null);
  });

  test('an unknown video element yields no overlay', async ({ page }) => {
    const id = await page.evaluate(() => {
      localStorage.setItem('dev-mode', 'true');
      const out = _startFpsOverlay('no-such-video', 'video-viewer-fps');
      localStorage.setItem('dev-mode', 'false');
      return out;
    });
    expect(id).toBe(null);
  });
});

test.describe('resetVideoState', () => {
  test('clears every peer\'s media and both viewers', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const c = connections.get('p1');
      c.remoteVideoStream = window.__mkVideoStream();
      c.videoActive = true;
      c.videoMedia = { close() {} };
      const d = connections.get('p2');
      d.remoteScreenStream = window.__mkVideoStream();
      d.screenActive = true;
      openVideoViewer('p1');
      openScreenViewer('p2');
      localVideoActive = true;
      localScreenActive = true;
      _stagePinnedKey = 'camera:p1';
      _hiddenStageKeys.add('camera:p2');

      resetVideoState();

      return {
        p1: { stream: c.remoteVideoStream, active: c.videoActive, media: c.videoMedia },
        p2: { stream: d.remoteScreenStream, active: d.screenActive },
        localVideoActive,
        localScreenActive,
        videoViewer: _videoViewerPeerId,
        screenViewer: _screenViewerPeerId,
        pinned: _stagePinnedKey,
        hidden: _hiddenStageKeys.size,
        facing: _cameraFacing,
        speakers: _speakerRecency.size,
      };
    });
    expect(seen.p1).toEqual({ stream: null, active: false, media: null });
    expect(seen.p2).toEqual({ stream: null, active: false });
    expect(seen.localVideoActive).toBe(false);
    expect(seen.localScreenActive).toBe(false);
    expect(seen.videoViewer).toBe(null);
    expect(seen.screenViewer).toBe(null);
    expect(seen.pinned).toBe(null);
    expect(seen.hidden).toBe(0);
    expect(seen.facing).toBe('user');
    expect(seen.speakers).toBe(0);
  });

  test('leaving does not overwrite the user\'s video-mode choice', async ({ page }) => {
    const enabled = await page.evaluate(() => {
      localStorage.setItem('video-mode-enabled', 'false');
      resetVideoState();
      return videoModeEnabled;
    });
    expect(enabled).toBe(false);
  });
});
