import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// `setTalking` is the one funnel every way of speaking goes through — a key, a
// pointer, the iOS lock-screen button, a parent page's postMessage. Its job is
// to reconcile "the user wants to talk" with "is there a microphone yet", and
// each of those combinations behaves differently.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await seedRoom(page, { selfId: 'self', isHost: true });
  await page.evaluate(() => {
    window.__gumCalls = 0;
    navigator.mediaDevices.getUserMedia = function() {
      window.__gumCalls++;
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      const osc = ctx.createOscillator();
      osc.connect(dest);
      osc.start();
      return Promise.resolve(dest.stream);
    };
    localStorage.setItem('noise-suppression', 'off');
    stream = null;
    audioTrack = null;
    _micAcquirePromise = null;
    _pendingTalkingStart = false;
    freeHandMode = false;
    isTalking = false;
    peer = { id: 'self', destroyed: false, call: () => null };
  });
});

test.describe('setTalking with a microphone already held', () => {
  test('opens and closes the track, and says so on screen', async ({ page }) => {
    const seen = await page.evaluate(() => {
      audioTrack = { enabled: false, kind: 'audio' };
      setTalking(true);
      const on = {
        talking: isTalking,
        trackEnabled: audioTrack.enabled,
        button: document.getElementById('ptt-btn').classList.contains('active'),
        status: document.getElementById('ptt-status').textContent,
      };
      setTalking(false);
      return {
        on,
        off: {
          talking: isTalking,
          trackEnabled: audioTrack.enabled,
          button: document.getElementById('ptt-btn').classList.contains('active'),
          status: document.getElementById('ptt-status').textContent,
        },
      };
    });
    expect(seen.on.talking).toBe(true);
    expect(seen.on.trackEnabled).toBe(true);
    expect(seen.on.button).toBe(true);
    expect(seen.on.status).toContain('Transmitting');
    expect(seen.off).toEqual({ talking: false, trackEnabled: false, button: false, status: '' });
  });

  test('the room is told when you start and stop', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1' }] });
    const sent = await page.evaluate(() => {
      audioTrack = { enabled: false, kind: 'audio' };
      const out = [];
      connections.get('p1').data.send = (m) => out.push(m);
      setTalking(true);
      setTalking(false);
      return out.filter((m) => m.type === 'talking').map((m) => m.active);
    });
    expect(sent).toEqual([true, false]);
  });

  test('pressing twice does not re-announce', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1' }] });
    const sent = await page.evaluate(() => {
      audioTrack = { enabled: false, kind: 'audio' };
      const out = [];
      connections.get('p1').data.send = (m) => out.push(m);
      setTalking(true);
      setTalking(true);
      return out.filter((m) => m.type === 'talking').length;
    });
    expect(sent).toBe(1);
  });
});

test.describe('setTalking with no microphone yet', () => {
  test('a release before the mic arrives still resets the UI', async ({ page }) => {
    const seen = await page.evaluate(() => {
      audioTrack = null;
      isTalking = true;
      document.getElementById('ptt-btn').classList.add('active');
      document.getElementById('ptt-status').textContent = '● Transmitting…';
      setTalking(false);
      return {
        talking: isTalking,
        button: document.getElementById('ptt-btn').classList.contains('active'),
        status: document.getElementById('ptt-status').textContent,
        gumCalls: window.__gumCalls,
      };
    });
    expect(seen).toEqual({ talking: false, button: false, status: '', gumCalls: 0 });
  });

  test('a press goes and gets one', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      setTalking(true);
      const pending = _pendingTalkingStart;
      await _micAcquirePromise;
      return { pending, gumCalls: window.__gumCalls, talking: isTalking };
    });
    expect(seen.pending).toBe(true);
    expect(seen.gumCalls).toBe(1);
    expect(seen.talking).toBe(true);
  });

  test('a press landing mid-acquisition opens no second microphone', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      setTalking(true);
      setTalking(true);
      await _micAcquirePromise;
      return { gumCalls: window.__gumCalls, talking: isTalking };
    });
    expect(seen).toEqual({ gumCalls: 1, talking: true });
  });

  test('a press released before the mic arrives does not transmit', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      setTalking(true);
      setTalking(false); // released while the device was still starting
      await _micAcquirePromise;
      return { talking: isTalking, pending: _pendingTalkingStart, gumCalls: window.__gumCalls };
    });
    expect(seen.talking).toBe(false);
    expect(seen.pending).toBe(false);
    expect(seen.gumCalls).toBe(1);
  });
});

test.describe('setTalking when it should do nothing', () => {
  test('outside a room', async ({ page }) => {
    const seen = await page.evaluate(() => {
      inRoom = false;
      audioTrack = { enabled: false, kind: 'audio' };
      setTalking(true);
      inRoom = true;
      return { talking: isTalking, gumCalls: window.__gumCalls };
    });
    expect(seen).toEqual({ talking: false, gumCalls: 0 });
  });

  test('in hands-free, where the mic is already live', async ({ page }) => {
    const seen = await page.evaluate(() => {
      freeHandMode = true;
      audioTrack = { enabled: true, kind: 'audio' };
      setTalking(false);
      const out = { talking: isTalking, trackEnabled: audioTrack.enabled };
      freeHandMode = false;
      return out;
    });
    // Releasing a key must not cut a hands-free stream.
    expect(seen).toEqual({ talking: false, trackEnabled: true });
  });
});

test.describe('hands-free', () => {
  test('turning it on opens the track and rewrites the hint', async ({ page }) => {
    const seen = await page.evaluate(() => {
      audioTrack = { enabled: false, kind: 'audio' };
      setFreeHand(true);
      const on = {
        free: freeHandMode,
        trackEnabled: audioTrack.enabled,
        pressed: document.getElementById('btn-freehand').getAttribute('aria-pressed'),
        status: document.getElementById('ptt-status').textContent,
        hint: document.getElementById('ptt-hint').textContent,
      };
      setFreeHand(false);
      return {
        on,
        off: {
          free: freeHandMode,
          trackEnabled: audioTrack.enabled,
          status: document.getElementById('ptt-status').textContent,
          hint: document.getElementById('ptt-hint').textContent,
        },
      };
    });
    expect(seen.on.free).toBe(true);
    expect(seen.on.trackEnabled).toBe(true);
    expect(seen.on.pressed).toBe('true');
    expect(seen.on.status).toContain('Live');
    expect(seen.on.hint).toContain('Hands-free');
    expect(seen.off.free).toBe(false);
    expect(seen.off.trackEnabled).toBe(false);
    expect(seen.off.status).toBe('');
    expect(seen.off.hint).toContain('Hold');
  });

  test('the room is told, with no microphone needed to say it', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1' }] });
    const sent = await page.evaluate(() => {
      audioTrack = null;
      const out = [];
      connections.get('p1').data.send = (m) => out.push(m);
      setFreeHand(true);
      setFreeHand(false);
      return out.filter((m) => m.type === 'talking').map((m) => m.active);
    });
    expect(sent).toEqual([true, false]);
  });
});

test.describe('the diagnostics-sharing switch', () => {
  test('mirrors the stored consent, and flips it', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const btn = document.getElementById('toggle-debug-share-modal');
      setDeviceInfoConsent('declined');
      syncDeviceShareToggles();
      const off = {
        checked: btn.getAttribute('aria-checked'),
        label: btn.textContent,
        active: btn.classList.contains('active'),
      };
      setDeviceInfoConsent('accepted');
      syncDeviceShareToggles();
      return {
        off,
        on: {
          checked: btn.getAttribute('aria-checked'),
          label: btn.textContent,
          active: btn.classList.contains('active'),
        },
      };
    });
    expect(seen.off).toEqual({ checked: 'false', label: 'OFF', active: false });
    expect(seen.on).toEqual({ checked: 'true', label: 'ON', active: true });
  });

  test('the button itself toggles consent both ways', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const btn = document.getElementById('toggle-debug-share-modal');
      setDeviceInfoConsent('declined');
      syncDeviceShareToggles();
      btn.click();
      const on = deviceInfoConsent();
      btn.click();
      return { on, off: deviceInfoConsent() };
    });
    expect(seen).toEqual({ on: 'accepted', off: 'declined' });
  });
});

test.describe('the RNNoise capture graph', () => {
  test('wires the microphone through the worklet and keeps the original', async ({ page }) => {
    const seen = await page.evaluate(() => {
      // Stand in for the worklet graph initRNNoise builds; the plumbing under
      // test is the routing, not the WASM.
      const ctx = new AudioContext();
      const node = ctx.createGain(); // a real node the graph can connect through
      _rnnoiseCtx = ctx;
      _rnnoiseNode = node;
      _rnnoiseReady = true;

      const src = ctx.createMediaStreamDestination();
      const osc = ctx.createOscillator();
      osc.connect(src);
      osc.start();
      const original = src.stream;

      const out = applyRNNoise(original);
      const result = {
        different: out !== original,
        tracks: out.getAudioTracks().length,
        keepsOriginal: out._rnnoiseOriginal === original,
        hasSource: !!out._rnnoiseSource,
        hasDest: !!out._rnnoiseDest,
      };

      // Releasing it must stop the real microphone behind the graph too.
      stopMicStreamFully(out);
      result.originalStopped = original.getAudioTracks()[0].readyState !== 'live';

      _rnnoiseReady = false;
      _rnnoiseCtx = null;
      _rnnoiseNode = null;
      return result;
    });
    expect(seen.different).toBe(true);
    expect(seen.tracks).toBe(1);
    expect(seen.keepsOriginal).toBe(true);
    expect(seen.hasSource).toBe(true);
    expect(seen.hasDest).toBe(true);
    expect(seen.originalStopped).toBe(true);
  });

  test('a suspended context is resumed rather than left silent', async ({ page }) => {
    const state = await page.evaluate(async () => {
      const ctx = new AudioContext();
      await ctx.suspend();
      _rnnoiseCtx = ctx;
      _rnnoiseNode = ctx.createGain();
      _rnnoiseReady = true;

      const src = ctx.createMediaStreamDestination();
      applyRNNoise(src.stream);
      await new Promise((r) => setTimeout(r, 50));
      const out = ctx.state;

      _rnnoiseReady = false;
      _rnnoiseCtx = null;
      _rnnoiseNode = null;
      return out;
    });
    expect(state).not.toBe('suspended');
  });
});
