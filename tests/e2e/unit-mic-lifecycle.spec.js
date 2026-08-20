import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// Acquiring, swapping and releasing the room's microphone. One promise
// (`_micAcquirePromise`) serialises the join-time acquire and the first press,
// because two live capture tracks in one room is the failure mode this whole
// path exists to prevent.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    window.__gumCalls = [];
    window.__gumFail = null;
    window.__streams = [];
    window.__mkAudioStream = function() {
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      const osc = ctx.createOscillator();
      osc.connect(dest);
      osc.start();
      window.__streams.push(dest.stream);
      return dest.stream;
    };
    navigator.mediaDevices.getUserMedia = function(c) {
      window.__gumCalls.push(c);
      if (window.__gumFail) return Promise.reject(window.__gumFail);
      return Promise.resolve(window.__mkAudioStream());
    };
    // Keep the capture path raw — RNNoise needs its WASM worklet.
    localStorage.setItem('noise-suppression', 'off');
    stream = null;
    audioTrack = null;
    _micAcquirePromise = null;
  });
});

test.describe('getMicStream', () => {
  test('asks for one mono channel with echo cancellation', async ({ page }) => {
    const c = await page.evaluate(async () => {
      await getMicStream();
      return window.__gumCalls[0];
    });
    expect(c.video).toBe(false);
    expect(c.audio.channelCount).toBe(1);
    expect(c.audio.echoCancellation).toBe(true);
    expect(c.audio.autoGainControl).toBe(true);
  });

  test('browser suppression is asked for only when that mode is chosen', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      localStorage.setItem('noise-suppression', 'browser');
      await getMicStream();
      const browser = window.__gumCalls[0].audio;
      localStorage.setItem('noise-suppression', 'off');
      await getMicStream();
      return { browser: browser.noiseSuppression, off: window.__gumCalls[1].audio.noiseSuppression };
    });
    expect(seen).toEqual({ browser: true, off: false });
  });

  test('the chosen microphone is pinned', async ({ page }) => {
    const deviceId = await page.evaluate(async () => {
      localStorage.setItem('mic-device-id', 'mic-7');
      await getMicStream();
      localStorage.removeItem('mic-device-id');
      return window.__gumCalls[0].audio.deviceId;
    });
    expect(deviceId).toEqual({ exact: 'mic-7' });
  });

  test('an old WebView is served through its prefixed API', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      const originalWebkit = navigator.webkitGetUserMedia;
      let asked = null;
      Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
      navigator.webkitGetUserMedia = function(c, ok) { asked = c; ok(window.__mkAudioStream()); };
      const s = await getMicStream();
      delete navigator.mediaDevices;
      navigator.webkitGetUserMedia = originalWebkit;
      return { asked: !!asked, tracks: s.getAudioTracks().length };
    });
    expect(seen).toEqual({ asked: true, tracks: 1 });
  });

  test('an environment with no capture API at all says so plainly', async ({ page }) => {
    const message = await page.evaluate(async () => {
      const originals = ['webkitGetUserMedia', 'mozGetUserMedia', 'msGetUserMedia']
        .map((k) => [k, navigator[k]]);
      Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
      originals.forEach(([k]) => { navigator[k] = undefined; });
      let out = null;
      try { await getMicStream(); } catch (e) { out = e.message; }
      delete navigator.mediaDevices;
      originals.forEach(([k, v]) => { navigator[k] = v; });
      return out;
    });
    expect(message).toBe('Microphone access is not available in this environment.');
  });
});

test.describe('acquireMicForRoom', () => {
  test('captures once and wires the track up muted', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true });
    const seen = await page.evaluate(async () => {
      peer = { id: 'self', destroyed: false, call: () => null };
      _pendingTalkingStart = false;
      // The resolved value answers "did this press start transmitting?", which
      // a background acquire never does — the mic itself is the side effect.
      const startedTalking = await acquireMicForRoom('join');
      return {
        startedTalking,
        hasStream: !!stream,
        // PTT gates with `enabled`, so a fresh track starts silent.
        enabled: audioTrack.enabled,
        status: document.getElementById('ptt-status').textContent,
        gumCalls: window.__gumCalls.length,
      };
    });
    expect(seen).toEqual({
      startedTalking: false, hasStream: true, enabled: false, status: '', gumCalls: 1,
    });
  });

  test('two callers share one acquisition', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true });
    const calls = await page.evaluate(async () => {
      peer = { id: 'self', destroyed: false, call: () => null };
      const a = acquireMicForRoom('join');
      const b = acquireMicForRoom('press');
      await Promise.all([a, b]);
      return { same: a === b, gumCalls: window.__gumCalls.length };
    });
    expect(calls).toEqual({ same: true, gumCalls: 1 });
  });

  test('a mic acquired after we left the room is released, not kept', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      inRoom = true;
      peer = { id: 'self', destroyed: false, call: () => null };
      connections.clear();
      let release;
      navigator.mediaDevices.getUserMedia = () => new Promise((r) => {
        release = () => r(window.__mkAudioStream());
      });
      const p = acquireMicForRoom('join');
      for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 10));
      inRoom = false; // the user left while the device was starting
      release();
      const ok = await p;
      return { ok, stream, released: window.__streams[0].getAudioTracks()[0].readyState !== 'live' };
    });
    expect(seen.ok).toBe(false);
    expect(seen.stream).toBe(null);
    expect(seen.released).toBe(true);
  });

  test('a press that fails gets an explanation; a background acquire does not', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true });
    const quiet = await page.evaluate(async () => {
      window.__gumFail = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
      _pendingTalkingStart = false;
      await acquireMicForRoom('join');
      return document.getElementById('screen-error').classList.contains('active');
    });
    expect(quiet).toBe(false);

    const loud = await page.evaluate(async () => {
      window.__gumFail = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
      _pendingTalkingStart = true;
      await acquireMicForRoom('press');
      _pendingTalkingStart = false;
      return document.getElementById('screen-error').classList.contains('active');
    });
    expect(loud).toBe(true);
  });

  test('a press waiting on the mic starts transmitting as soon as it arrives', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true });
    const talking = await page.evaluate(async () => {
      peer = { id: 'self', destroyed: false, call: () => null };
      freeHandMode = false;
      _pendingTalkingStart = true;
      await acquireMicForRoom('press');
      const out = isTalking;
      _pendingTalkingStart = false;
      return out;
    });
    expect(talking).toBe(true);
  });
});

test.describe('connectOutgoingAudioToPeers', () => {
  test('opens one call per peer and records it', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'self',
      isHost: true,
      connections: [{ id: 'p1' }, { id: 'p2' }],
    });
    const seen = await page.evaluate(() => {
      const made = [];
      peer = {
        id: 'self',
        call(peerId) {
          made.push(peerId);
          return { peer: peerId, closed: false, peerConnection: { getSenders: () => [] }, close() {}, on() {} };
        },
      };
      stream = window.__mkAudioStream();
      connectOutgoingAudioToPeers();
      return { made, wired: ['p1', 'p2'].map((id) => !!connections.get(id).audioMediaOut) };
    });
    expect(seen.made).toEqual(['p1', 'p2']);
    expect(seen.wired).toEqual([true, true]);
  });

  test('never calls a peer twice, and never calls itself', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'self',
      isHost: true,
      connections: [{ id: 'self' }, { id: 'p1' }],
    });
    const made = await page.evaluate(() => {
      const out = [];
      peer = {
        id: 'self',
        call(peerId) {
          out.push(peerId);
          return { peer: peerId, closed: false, peerConnection: { getSenders: () => [] }, close() {}, on() {} };
        },
      };
      stream = window.__mkAudioStream();
      connectOutgoingAudioToPeers();
      connectOutgoingAudioToPeers();
      return out;
    });
    expect(made).toEqual(['p1']);
  });

  test('with no microphone yet it opens nothing', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1' }] });
    const made = await page.evaluate(() => {
      const out = [];
      peer = { id: 'self', call: (id) => { out.push(id); return null; } };
      stream = null;
      connectOutgoingAudioToPeers();
      return out;
    });
    expect(made).toEqual([]);
  });
});

test.describe('replaceOutgoingAudioTrack', () => {
  test('swaps the track on every live sender and counts them', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'self',
      isHost: true,
      connections: [{ id: 'p1' }, { id: 'p2' }],
    });
    const seen = await page.evaluate(async () => {
      const swapped = [];
      const mkSender = (kind) => ({
        track: { kind },
        replaceTrack(t) { swapped.push(t); return Promise.resolve(); },
      });
      const mkLink = () => ({
        closed: false,
        peerConnection: { getSenders: () => [mkSender('audio'), mkSender('video')] },
      });
      connections.get('p1').media = mkLink();
      connections.get('p1').audioMediaOut = mkLink();
      connections.get('p2').media = mkLink();
      const track = window.__mkAudioStream().getAudioTracks()[0];
      const count = await replaceOutgoingAudioTrack(track);
      // Only the audio senders are touched — a video sender is left alone.
      return { count, swappedAll: swapped.every((t) => t === track), swappedCount: swapped.length };
    });
    expect(seen).toEqual({ count: 3, swappedAll: true, swappedCount: 3 });
  });

  test('a sender that refuses the swap is reported, not fatal', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1' }] });
    const count = await page.evaluate(async () => {
      connections.get('p1').media = {
        closed: false,
        peerConnection: {
          getSenders: () => [{ track: { kind: 'audio' }, replaceTrack: () => Promise.reject(new Error('nope')) }],
        },
      };
      return replaceOutgoingAudioTrack(window.__mkAudioStream().getAudioTracks()[0]);
    });
    expect(count).toBe(0);
  });

  test('a closed link is skipped', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1' }] });
    const count = await page.evaluate(async () => {
      connections.get('p1').media = {
        closed: true,
        peerConnection: { getSenders: () => [{ track: { kind: 'audio' }, replaceTrack: () => Promise.resolve() }] },
      };
      return replaceOutgoingAudioTrack(window.__mkAudioStream().getAudioTracks()[0]);
    });
    expect(count).toBe(0);
  });
});

test.describe('reacquireMicForRoom', () => {
  test('is a no-op outside a room, or with no mic held', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      inRoom = false;
      const outside = await reacquireMicForRoom();
      inRoom = true;
      stream = null;
      const noMic = await reacquireMicForRoom();
      inRoom = false;
      return { outside, noMic, gumCalls: window.__gumCalls.length };
    });
    expect(seen).toEqual({ outside: false, noMic: false, gumCalls: 0 });
  });

  test('swaps in a fresh track and releases the old one', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1' }] });
    const seen = await page.evaluate(async () => {
      const swapped = [];
      peer = { id: 'self', call: () => null };
      connections.get('p1').media = {
        closed: false,
        peerConnection: {
          getSenders: () => [{ track: { kind: 'audio' }, replaceTrack(t) { swapped.push(t); return Promise.resolve(); } }],
        },
      };
      const original = window.__mkAudioStream();
      stream = original;
      audioTrack = original.getAudioTracks()[0];
      audioTrack.enabled = true; // mid-press

      const ok = await reacquireMicForRoom();
      return {
        ok,
        replaced: stream !== original,
        oldReleased: original.getAudioTracks()[0].readyState !== 'live',
        // A swap mid-press must not mute the speaker.
        enabled: audioTrack.enabled,
        swaps: swapped.length,
      };
    });
    expect(seen).toEqual({ ok: true, replaced: true, oldReleased: true, enabled: true, swaps: 1 });
  });

  test('with nothing to swap it opens the calls normally instead', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1' }] });
    const called = await page.evaluate(async () => {
      const out = [];
      peer = {
        id: 'self',
        call(peerId) {
          out.push(peerId);
          return { peer: peerId, closed: false, peerConnection: { getSenders: () => [] }, close() {}, on() {} };
        },
      };
      stream = window.__mkAudioStream();
      audioTrack = stream.getAudioTracks()[0];
      await reacquireMicForRoom();
      return out;
    });
    expect(called).toEqual(['p1']);
  });

  test('a failed re-acquire keeps the microphone that still works', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true });
    const seen = await page.evaluate(async () => {
      peer = { id: 'self', call: () => null };
      const original = window.__mkAudioStream();
      stream = original;
      audioTrack = original.getAudioTracks()[0];
      window.__gumFail = new Error('device busy');
      const ok = await reacquireMicForRoom();
      return { ok, kept: stream === original, live: audioTrack.readyState === 'live' };
    });
    expect(seen).toEqual({ ok: false, kept: true, live: true });
    await expect(page.locator('#copy-toast')).toHaveText('Could not switch microphone — keeping the current one');
  });

  test('a re-acquire that lands after leaving is discarded', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      inRoom = true;
      peer = { id: 'self', call: () => null };
      connections.clear();
      const original = window.__mkAudioStream();
      stream = original;
      audioTrack = original.getAudioTracks()[0];
      let release;
      navigator.mediaDevices.getUserMedia = () => new Promise((r) => {
        release = () => r(window.__mkAudioStream());
      });
      const p = reacquireMicForRoom();
      for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 10));
      inRoom = false;
      release();
      const ok = await p;
      return { ok, kept: stream === original };
    });
    expect(seen).toEqual({ ok: false, kept: true });
  });

  test('two overlapping re-acquires share one capture', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true });
    const seen = await page.evaluate(async () => {
      peer = { id: 'self', call: () => null };
      stream = window.__mkAudioStream();
      audioTrack = stream.getAudioTracks()[0];
      window.__gumCalls.length = 0;
      const a = reacquireMicForRoom();
      const b = reacquireMicForRoom();
      await Promise.all([a, b]);
      return { same: a === b, gumCalls: window.__gumCalls.length };
    });
    expect(seen).toEqual({ same: true, gumCalls: 1 });
  });
});

test.describe('the capture watchdog', () => {
  test('a track dying under us triggers a re-acquire', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true });
    const seen = await page.evaluate(async () => {
      peer = { id: 'self', call: () => null };
      const original = window.__mkAudioStream();
      stream = original;
      audioTrack = original.getAudioTracks()[0];
      watchMicTrackEnded(original);
      // Something else on the machine grabbed the device.
      original.getAudioTracks()[0].dispatchEvent(new Event('ended'));
      await new Promise((r) => setTimeout(r, 50));
      return { replaced: stream !== original };
    });
    expect(seen.replaced).toBe(true);
  });

  test('a track ending for a stream we no longer use is ignored', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true });
    const seen = await page.evaluate(async () => {
      peer = { id: 'self', call: () => null };
      const stale = window.__mkAudioStream();
      const current = window.__mkAudioStream();
      watchMicTrackEnded(stale);
      stream = current;
      audioTrack = current.getAudioTracks()[0];
      window.__gumCalls.length = 0;
      stale.getAudioTracks()[0].dispatchEvent(new Event('ended'));
      await new Promise((r) => setTimeout(r, 50));
      return { kept: stream === current, gumCalls: window.__gumCalls.length };
    });
    expect(seen).toEqual({ kept: true, gumCalls: 0 });
  });

  test('a stream with no audio track is not watched', async ({ page }) => {
    const threw = await page.evaluate(() => {
      try { watchMicTrackEnded(new MediaStream()); watchMicTrackEnded(null); return false; } catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });
});
