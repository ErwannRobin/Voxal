import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// Watching someone else's camera or screen in its own window.
//
// Two entirely different mechanisms hide behind one button. On web and mobile
// it is the Picture-in-Picture API. On Tauri desktop there is no PiP, so the
// stream is relayed into a second WebviewWindow over a local RTCPeerConnection
// loopback, signalled through Tauri events — and that leg has three failure
// modes worth pinning down: registering the event listener AFTER opening the
// window (the popup's `ready` is then missed and the window stays black), never
// answering the popup's SDP, and leaking the loopback peer connection when the
// window goes away.
//
// The stream is a real canvas capture, so the SDP that goes over the fake event
// bus is a real one negotiated by a real RTCPeerConnection.

/** A fake Tauri bridge: an event bus plus a recording WebviewWindow. */
async function stubTauri(page) {
  await page.addInitScript(() => {
    const listeners = new Map();   // event name → [handler]
    const emitted = [];            // everything main.js emitted
    const windows = [];            // every WebviewWindow it constructed

    function on(name, handler) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(handler);
    }

    class FakeWebviewWindow {
      constructor(label, options) {
        this.label = label;
        this.options = options;
        this.onceHandlers = {};
        this.closed = false;
        this.closeCalls = 0;
        windows.push(this);
      }
      once(name, handler) { this.onceHandlers[name] = handler; return Promise.resolve(() => {}); }
      close() { this.closeCalls++; this.closed = true; return Promise.resolve(); }
    }

    window.__TAURI__ = {
      core: { invoke: () => Promise.resolve() },
      shell: { open: () => Promise.resolve() },
      webviewWindow: { WebviewWindow: FakeWebviewWindow },
      event: {
        listen(name, handler) {
          on(name, handler);
          // The unlisten function main.js stores and is expected to call.
          return Promise.resolve(() => {
            window.__tauriTest.unlistened.push(name);
            const list = listeners.get(name) || [];
            const i = list.indexOf(handler);
            if (i >= 0) list.splice(i, 1);
          });
        },
        once(name, handler) { on(name, handler); return Promise.resolve(() => {}); },
        emit(name, payload) { emitted.push({ name, payload }); return Promise.resolve(); },
      },
    };

    // The test's handle on the bridge.
    window.__tauriTest = {
      emitted,
      windows,
      unlistened: [],
      listenerCount: (name) => (listeners.get(name) || []).length,
      /** Deliver an event from the popup to main.js, as Tauri would. */
      deliver: (name, payload) =>
        Promise.all((listeners.get(name) || []).map((h) => h({ payload }))),
      /** Fire one of the `once` handlers a WebviewWindow registered. */
      fireWindow: (index, name, arg) => {
        const h = windows[index] && windows[index].onceHandlers[name];
        return h ? h(arg) : null;
      },
      /**
       * Deliver the popup's `ready` and wait for the offer to be emitted.
       *
       * main.js waits for end-of-candidates before emitting, and a sandboxed
       * CI container with no UDP never finishes ICE gathering — so nudge the
       * peer connection with the same end-of-candidates event a real gathering
       * completion fires. Where gathering does complete on its own the handler
       * has already moved on and the nudge is a no-op.
       */
      ready: async (channel) => {
        const pcName = channel === 'screen' ? '_screenLoopbackPC' : '_videoLoopbackPC';
        const pending = window.__tauriTest.deliver(`${channel}-popup-signal`, { type: 'ready' });
        let settled = false;
        pending.then(() => { settled = true; }, () => { settled = true; });
        for (let i = 0; i < 250 && !settled; i++) {
          if (window[pcName]) window[pcName].dispatchEvent(new Event('icecandidate'));
          await new Promise((r) => setTimeout(r, 20));
        }
        return pending;
      },
    };
  });
}

/**
 * Put a real, live video stream on a peer and open the viewer for them.
 * `width`/`height` become the track's real settings, which is what sizes the
 * pop-out window.
 */
async function seedRemoteStream(page, { kind = 'video', width = 640, height = 480 } = {}) {
  await seedRoom(page, {
    selfId: 'self',
    isHost: false,
    roomCode: 'host-1',
    connections: [{ id: 'peer-1', pseudo: 'Alice' }],
  });
  await page.evaluate(({ kind, width, height }) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#123456';
    ctx.fillRect(0, 0, width, height);
    // Keep it painting so the track stays live.
    window.__paintTimer = setInterval(() => ctx.fillRect(0, 0, width, height), 100);
    const stream = canvas.captureStream(10);
    const conn = connections.get('peer-1');
    if (kind === 'screen') conn.remoteScreenStream = stream;
    else conn.remoteVideoStream = stream;
  }, { kind, width, height });
}

// --- web / mobile: the Picture-in-Picture path -------------------------------

test.describe('pop-out on web — Picture-in-Picture', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await seedRemoteStream(page);
  });

  test('a successful request marks the panel as PiP, not as closed', async ({ page }) => {
    const state = await page.evaluate(async () => {
      const vid = document.getElementById('video-viewer-element');
      Object.defineProperty(document, 'pictureInPictureEnabled', { value: true, configurable: true });
      let asked = 0;
      vid.requestPictureInPicture = () => { asked++; return Promise.resolve({}); };

      window.openVideoViewer('peer-1');
      window.popOutVideoViewer();
      await new Promise((r) => setTimeout(r, 0));

      const panel = document.getElementById('video-viewer-panel');
      return { asked, pip: panel.classList.contains('pip-active'), hidden: panel.classList.contains('hidden') };
    });

    expect(state.asked).toBe(1);
    expect(state.pip).toBe(true);
    // The panel stays open behind the PiP window — hiding it here is what used
    // to leave nothing to come back to when the user exited PiP.
    expect(state.hidden).toBe(false);
  });

  test('a browser that refuses PiP says so instead of failing silently', async ({ page }) => {
    const toast = await page.evaluate(async () => {
      const vid = document.getElementById('video-viewer-element');
      Object.defineProperty(document, 'pictureInPictureEnabled', { value: true, configurable: true });
      vid.requestPictureInPicture = () => Promise.reject(new Error('denied'));

      window.openVideoViewer('peer-1');
      window.popOutVideoViewer();
      await new Promise((r) => setTimeout(r, 0));

      const el = document.getElementById('copy-toast');
      return { text: el.textContent, visible: el.classList.contains('visible') };
    });

    expect(toast.text).toBe('Picture-in-Picture not available');
    expect(toast.visible).toBe(true);
  });

  test('Safari\'s presentation-mode API is used when the standard one is absent', async ({ page }) => {
    const state = await page.evaluate(async () => {
      const vid = document.getElementById('video-viewer-element');
      Object.defineProperty(document, 'pictureInPictureEnabled', { value: false, configurable: true });
      const modes = [];
      vid.webkitSetPresentationMode = (m) => modes.push(m);

      window.openVideoViewer('peer-1');
      window.popOutVideoViewer();
      await new Promise((r) => setTimeout(r, 0));

      return { modes, pip: document.getElementById('video-viewer-panel').classList.contains('pip-active') };
    });

    expect(state.modes).toEqual(['picture-in-picture']);
    expect(state.pip).toBe(true);
  });

  test('a browser with neither API gets the toast, not an exception', async ({ page }) => {
    const toast = await page.evaluate(async () => {
      const vid = document.getElementById('video-viewer-element');
      Object.defineProperty(document, 'pictureInPictureEnabled', { value: false, configurable: true });
      delete vid.webkitSetPresentationMode;

      window.openVideoViewer('peer-1');
      window.popOutVideoViewer();
      await new Promise((r) => setTimeout(r, 0));
      return document.getElementById('copy-toast').textContent;
    });

    expect(toast).toBe('Picture-in-Picture not available');
  });

  test('pop-out does nothing at all when nobody is being watched', async ({ page }) => {
    const asked = await page.evaluate(() => {
      const vid = document.getElementById('video-viewer-element');
      let calls = 0;
      Object.defineProperty(document, 'pictureInPictureEnabled', { value: true, configurable: true });
      vid.requestPictureInPicture = () => { calls++; return Promise.resolve({}); };
      window.closeVideoViewer();
      window.popOutVideoViewer();
      return calls;
    });
    expect(asked).toBe(0);
  });
});

// --- Tauri desktop: the WebviewWindow + loopback path ------------------------

test.describe('pop-out on Tauri desktop — camera', () => {
  test.beforeEach(async ({ page }) => {
    await stubTauri(page);
    await page.goto('/');
    await seedRemoteStream(page, { width: 640, height: 480 });
  });

  test('the signal listener is registered BEFORE the window is opened', async ({ page }) => {
    // The popup emits `ready` as soon as it loads. Opening the window first is
    // a race the popup usually wins, and the pop-out then stays black forever.
    const order = await page.evaluate(async () => {
      const t = window.__tauriTest;
      window.openVideoViewer('peer-1');
      const listenedBeforeAnyWindow = t.listenerCount('video-popup-signal') > 0 && t.windows.length === 0;
      await new Promise((r) => setTimeout(r, 50));
      return { listenedBeforeAnyWindow, windows: t.windows.length };
    });

    expect(order.listenedBeforeAnyWindow).toBe(true);
    expect(order.windows).toBe(1);
  });

  test('on Tauri the integrated panel is not used at all', async ({ page }) => {
    const hidden = await page.evaluate(async () => {
      window.openVideoViewer('peer-1');
      await new Promise((r) => setTimeout(r, 50));
      return document.getElementById('video-viewer-panel').classList.contains('hidden');
    });
    expect(hidden).toBe(true);
  });

  test('the window is labelled and titled for the peer being watched', async ({ page }) => {
    const win = await page.evaluate(async () => {
      window.openVideoViewer('peer-1');
      await new Promise((r) => setTimeout(r, 50));
      const w = window.__tauriTest.windows[0];
      return { label: w.label, ...w.options };
    });

    expect(win.label).toBe('video-popup');
    expect(win.url).toBe('video-popup.html');
    expect(win.title).toBe('Alice');
    expect(win.alwaysOnTop).toBe(true);
    expect(win.width).toBe(640);
    expect(win.height).toBe(480);
  });

  test('an oversized camera is scaled down, keeping its aspect ratio', async ({ page }) => {
    await page.goto('/');
    await seedRemoteStream(page, { width: 1920, height: 1080 });
    const size = await page.evaluate(async () => {
      window.openVideoViewer('peer-1');
      await new Promise((r) => setTimeout(r, 50));
      const w = window.__tauriTest.windows[0];
      return { width: w.options.width, height: w.options.height };
    });

    expect(size.width).toBe(1280);
    expect(size.height).toBe(720);
  });

  test('the popup\'s "ready" is answered with a real offer carrying the video track', async ({ page }) => {
    const offer = await page.evaluate(async () => {
      const t = window.__tauriTest;
      window.openVideoViewer('peer-1');
      await new Promise((r) => setTimeout(r, 50));
      await t.ready('video');
      return t.emitted.find((e) => e.name === 'video-main-signal');
    });

    expect(offer).toBeTruthy();
    expect(offer.payload.type).toBe('offer');
    expect(offer.payload.sdp.type).toBe('offer');
    // A real negotiated offer, with the camera track in it — not a placeholder.
    expect(offer.payload.sdp.sdp).toContain('m=video');
  });

  test('the popup\'s answer completes the loopback', async ({ page }) => {
    const state = await page.evaluate(async () => {
      const t = window.__tauriTest;
      window.openVideoViewer('peer-1');
      await new Promise((r) => setTimeout(r, 50));
      await t.ready('video');
      const offer = t.emitted.find((e) => e.name === 'video-main-signal').payload.sdp;

      // Stand in for the popup: a second peer connection that answers for real.
      const popup = new RTCPeerConnection();
      await popup.setRemoteDescription(offer);
      const answer = await popup.createAnswer();
      await popup.setLocalDescription(answer);

      await t.deliver('video-popup-signal', {
        type: 'answer',
        sdp: { type: answer.type, sdp: answer.sdp },
      });
      popup.close();
      return { signalingState: window._videoLoopbackPC && window._videoLoopbackPC.signalingState };
    });

    // 'stable' is the whole point: the loopback is negotiated and media flows.
    expect(state.signalingState).toBe('stable');
  });

  test('an answer arriving with no loopback left is ignored, not thrown', async ({ page }) => {
    const ok = await page.evaluate(async () => {
      const t = window.__tauriTest;
      window.openVideoViewer('peer-1');
      await new Promise((r) => setTimeout(r, 50));
      // No 'ready' first, so there is no peer connection to answer.
      await t.deliver('video-popup-signal', { type: 'answer', sdp: { type: 'answer', sdp: 'v=0\r\n' } });
      return true;
    });
    expect(ok).toBe(true);
  });

  test('"pop in" tears down the loopback and forgets who was being watched', async ({ page }) => {
    const after = await page.evaluate(async () => {
      const t = window.__tauriTest;
      window.openVideoViewer('peer-1');
      await new Promise((r) => setTimeout(r, 50));
      await t.ready('video');
      const pc = window._videoLoopbackPC;

      await t.deliver('video-popup-signal', { type: 'pop-in' });
      return {
        pcClosed: pc.connectionState === 'closed' || pc.signalingState === 'closed',
        loopback: window._videoLoopbackPC,
        viewer: window._videoViewerPeerId,
        unlistened: t.unlistened,
      };
    });

    expect(after.pcClosed).toBe(true);
    expect(after.loopback).toBe(null);
    expect(after.viewer).toBe(null);
    // The Tauri listener must be released too, or a second pop-out doubles up.
    expect(after.unlistened).toContain('video-popup-signal');
  });

  test('closing the pop-out window cleans up exactly like "pop in" does', async ({ page }) => {
    const after = await page.evaluate(async () => {
      const t = window.__tauriTest;
      window.openVideoViewer('peer-1');
      await new Promise((r) => setTimeout(r, 50));
      await t.ready('video');

      await t.fireWindow(0, 'tauri://destroyed');
      return { loopback: window._videoLoopbackPC, viewer: window._videoViewerPeerId, unlistened: t.unlistened };
    });

    expect(after.loopback).toBe(null);
    expect(after.viewer).toBe(null);
    expect(after.unlistened).toContain('video-popup-signal');
  });

  test('a window that fails to open releases the loopback rather than leaking it', async ({ page }) => {
    const after = await page.evaluate(async () => {
      const t = window.__tauriTest;
      window.openVideoViewer('peer-1');
      await new Promise((r) => setTimeout(r, 50));
      await t.ready('video');

      await t.fireWindow(0, 'tauri://error', new Error('no window server'));
      return { loopback: window._videoLoopbackPC };
    });
    expect(after.loopback).toBe(null);
  });

  test('closing the viewer closes the pop-out window it opened', async ({ page }) => {
    const closes = await page.evaluate(async () => {
      const t = window.__tauriTest;
      window.openVideoViewer('peer-1');
      await new Promise((r) => setTimeout(r, 50));
      window.closeVideoViewer();
      return { closeCalls: t.windows[0].closeCalls, viewer: window._videoViewerPeerId };
    });

    expect(closes.closeCalls).toBe(1);
    expect(closes.viewer).toBe(null);
  });
});

test.describe('pop-out on Tauri desktop — screen share', () => {
  test.beforeEach(async ({ page }) => {
    await stubTauri(page);
    await page.goto('/');
  });

  test('a shared screen gets its own window, capped at 1920 wide', async ({ page }) => {
    await seedRemoteStream(page, { kind: 'screen', width: 3840, height: 2160 });
    const win = await page.evaluate(async () => {
      window.openScreenViewer('peer-1');
      await new Promise((r) => setTimeout(r, 50));
      const w = window.__tauriTest.windows[0];
      return { label: w.label, url: w.options.url, title: w.options.title, width: w.options.width, height: w.options.height };
    });

    expect(win.label).toBe('screen-popup');
    expect(win.url).toBe('screen-popup.html');
    expect(win.title).toBe('Alice — Screen');
    expect(win.width).toBe(1920);
    expect(win.height).toBe(1080);
  });

  test('the screen loopback negotiates on its own channel, not the camera\'s', async ({ page }) => {
    await seedRemoteStream(page, { kind: 'screen', width: 1280, height: 720 });
    const emitted = await page.evaluate(async () => {
      const t = window.__tauriTest;
      window.openScreenViewer('peer-1');
      await new Promise((r) => setTimeout(r, 50));
      await t.ready('screen');
      return t.emitted.map((e) => e.name);
    });

    expect(emitted).toContain('screen-main-signal');
    expect(emitted).not.toContain('video-main-signal');
  });

  test('a screen share with no video track is refused instead of negotiating nothing', async ({ page }) => {
    await seedRemoteStream(page, { kind: 'screen' });
    const result = await page.evaluate(async () => {
      const t = window.__tauriTest;
      window.openScreenViewer('peer-1');
      await new Promise((r) => setTimeout(r, 50));
      // The sharer stopped sharing between opening the window and the popup
      // reporting ready.
      const conn = connections.get('peer-1');
      conn.remoteScreenStream.getVideoTracks().forEach((t2) => conn.remoteScreenStream.removeTrack(t2));

      await t.ready('screen');
      return { loopback: window._screenLoopbackPC, emitted: t.emitted.map((e) => e.name) };
    });

    expect(result.loopback).toBe(null);
    expect(result.emitted).not.toContain('screen-main-signal');
  });

  test('"pop in" on the screen window leaves the camera pop-out untouched', async ({ page }) => {
    await seedRemoteStream(page, { kind: 'screen', width: 1280, height: 720 });
    const after = await page.evaluate(async () => {
      const t = window.__tauriTest;
      window.openScreenViewer('peer-1');
      await new Promise((r) => setTimeout(r, 50));
      await t.ready('screen');
      window._videoViewerPeerId = 'peer-1';

      await t.deliver('screen-popup-signal', { type: 'pop-in' });
      return { screenLoopback: window._screenLoopbackPC, screenViewer: window._screenViewerPeerId, videoViewer: window._videoViewerPeerId };
    });

    expect(after.screenLoopback).toBe(null);
    expect(after.screenViewer).toBe(null);
    expect(after.videoViewer).toBe('peer-1');
  });

  test('closing the screen viewer closes its window', async ({ page }) => {
    await seedRemoteStream(page, { kind: 'screen', width: 1280, height: 720 });
    const closes = await page.evaluate(async () => {
      const t = window.__tauriTest;
      window.openScreenViewer('peer-1');
      await new Promise((r) => setTimeout(r, 50));
      window.closeScreenViewer();
      return { closeCalls: t.windows[0].closeCalls, viewer: window._screenViewerPeerId };
    });

    expect(closes.closeCalls).toBe(1);
    expect(closes.viewer).toBe(null);
  });
});
