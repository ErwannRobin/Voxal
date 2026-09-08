import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// ?video=1 — the "join like a video-conference link" parameter. It has to do
// three things at once (turn the video controls on, open the microphone, start
// the camera) and it has to do them exactly once per page load, or it would keep
// switching the camera back on for a user who turned it off.

/** A media-free page: both capture paths return synthetic tracks. */
async function stubMedia(page) {
  await page.evaluate(() => {
    window.__gumFail = null;
    window.__audioStreams = [];
    navigator.mediaDevices.getUserMedia = function(c) {
      if (window.__gumFail) return Promise.reject(window.__gumFail);
      if (c && c.audio) {
        const ctx = new AudioContext();
        const dest = ctx.createMediaStreamDestination();
        const osc = ctx.createOscillator();
        osc.connect(dest);
        osc.start();
        window.__audioStreams.push(dest.stream);
        return Promise.resolve(dest.stream);
      }
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 240;
      canvas.getContext('2d').fillRect(0, 0, 1, 1);
      return Promise.resolve(canvas.captureStream(5));
    };
    navigator.mediaDevices.enumerateDevices = () => Promise.resolve([]);
    // Keep the capture paths raw: RNNoise needs a WASM worklet, the SFU a live
    // endpoint. Neither is what this file is about.
    localStorage.setItem('noise-suppression', 'off');
    localStorage.setItem('video-routing-mode', 'p2p-only');
    stream = null;
    audioTrack = null;
    _micAcquirePromise = null;
  });
}

/** A one-peer room whose peer can take a mesh MediaConnection. */
async function seedVideoRoom(page) {
  await seedRoom(page, { selfId: 'host', isHost: true, connections: [{ id: 'p1', pseudo: 'Ada' }] });
  await page.evaluate(() => {
    window.__calls = [];
    peer = {
      id: 'host',
      destroyed: false,
      call(peerId, s, opts) {
        const handlers = {};
        const c = {
          peer: peerId,
          metadata: opts && opts.metadata,
          closed: false,
          peerConnection: { getSenders: () => [], getStats: () => Promise.resolve(new Map()) },
          close() { this.closed = true; },
          on(e, fn) { (handlers[e] = handlers[e] || []).push(fn); },
        };
        window.__calls.push(c);
        return c;
      },
    };
  });
}

test.describe('reading the parameter', () => {
  test('?video=1 and its aliases arm the auto-start', async ({ page }) => {
    for (const query of ['?video=1', '?video=true', '?video=yes', '?video=on',
                         '?camera=1', '?cam=true', '?autoVideo=1']) {
      await page.goto('/' + query);
      expect(await page.evaluate(() => AUTO_VIDEO_JOIN), query).toBe(true);
    }
  });

  test('absent, empty or explicitly off leaves it alone', async ({ page }) => {
    for (const query of ['', '?tiny=1', '?video=0', '?video=false', '?video=']) {
      await page.goto('/' + query);
      expect(await page.evaluate(() => AUTO_VIDEO_JOIN), query).toBe(false);
    }
  });
});

test.describe('autoStartVideoOnJoin', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?video=1');
    await stubMedia(page);
    await seedVideoRoom(page);
  });

  test('starts the camera and latches hands-free', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      autoStartVideoOnJoin();
      for (let i = 0; i < 200 && !localVideoActive; i++) await new Promise((r) => setTimeout(r, 10));
      return {
        video: localVideoActive,
        freeHand: freeHandMode,
        calls: window.__calls.map((c) => c.metadata && c.metadata.type).filter((t) => t === 'video'),
      };
    });
    expect(seen.video).toBe(true);
    expect(seen.freeHand).toBe(true);
    expect(seen.calls).toEqual(['video']);
  });

  test('turns the video controls on for this session without rewriting the setting', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      localStorage.setItem('video-mode-enabled', 'false');
      videoModeEnabled = false;
      autoStartVideoOnJoin();
      for (let i = 0; i < 200 && !localVideoActive; i++) await new Promise((r) => setTimeout(r, 10));
      return { enabled: videoModeEnabled, stored: localStorage.getItem('video-mode-enabled') };
    });
    // The URL asked for this room, not for a new preference.
    expect(seen).toEqual({ enabled: true, stored: 'false' });
  });

  test('opens the microphone, unmuted, alongside the camera', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      autoStartVideoOnJoin();
      for (let i = 0; i < 200 && !audioTrack; i++) await new Promise((r) => setTimeout(r, 10));
      return { hasTrack: !!audioTrack, enabled: audioTrack && audioTrack.enabled };
    });
    // setFreeHand() ran before the device finished starting: the track still has
    // to land enabled, or the room shows "Live" over a muted microphone.
    expect(seen).toEqual({ hasTrack: true, enabled: true });
  });

  test('is honoured once per page load', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      autoStartVideoOnJoin();
      for (let i = 0; i < 200 && !localVideoActive; i++) await new Promise((r) => setTimeout(r, 10));
      // Audio rides the same mesh, so count camera calls only.
      const videoCalls = () => window.__calls.filter((c) => c.metadata && c.metadata.type === 'video').length;
      const first = videoCalls();
      // The user turns the camera off, then re-joins from the same page.
      stopVideoShare();
      autoStartVideoOnJoin();
      await new Promise((r) => setTimeout(r, 100));
      return { first, active: localVideoActive, calls: videoCalls() };
    });
    expect(seen.first).toBe(1);
    expect(seen.active).toBe(false);
    expect(seen.calls).toBe(1);
  });

  test('a refused camera still leaves the microphone open', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      window.__gumFail = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
      autoStartVideoOnJoin();
      await new Promise((r) => setTimeout(r, 200));
      return { video: localVideoActive, freeHand: freeHandMode };
    });
    expect(seen).toEqual({ video: false, freeHand: true });
  });
});

test.describe('without the parameter', () => {
  test('joining does not touch the camera', async ({ page }) => {
    await page.goto('/');
    await stubMedia(page);
    await seedVideoRoom(page);
    const seen = await page.evaluate(async () => {
      autoStartVideoOnJoin();
      await new Promise((r) => setTimeout(r, 150));
      return { video: localVideoActive, freeHand: freeHandMode, calls: window.__calls.length };
    });
    expect(seen).toEqual({ video: false, freeHand: false, calls: 0 });
  });
});

test.describe('deep links', () => {
  test('voxal://join?room=…&video=1 arms an app that is already running', async ({ page }) => {
    await page.goto('/');
    const armed = await page.evaluate(() => {
      // Stop the join itself: this asserts the flag, not the connection.
      const realJoin = window.joinRoom;
      window.joinRoom = () => Promise.resolve();
      handleDeepLink('voxal://join?room=11111111-2222-3333-4444-555555555555&video=1');
      window.joinRoom = realJoin;
      return _autoVideoJoinPending;
    });
    expect(armed).toBe(true);
  });

  test('a deep link without the parameter leaves it disarmed', async ({ page }) => {
    await page.goto('/');
    const armed = await page.evaluate(() => {
      const realJoin = window.joinRoom;
      window.joinRoom = () => Promise.resolve();
      handleDeepLink('voxal://join?room=11111111-2222-3333-4444-555555555555');
      window.joinRoom = realJoin;
      return _autoVideoJoinPending;
    });
    expect(armed).toBe(false);
  });
});

test.describe('handing the parameter on in an invite', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await seedRoom(page, { selfId: 'host', isHost: true, roomCode: 'myroom', myPseudo: 'Alice', connections: [] });
  });

  test('an audio-only room hands out an audio-only link', async ({ page }) => {
    const url = new URL(await page.evaluate(() => roomInviteUrl('myroom')));
    expect(url.searchParams.get('room')).toBe('myroom');
    // Never switch on a stranger's camera by default.
    expect(url.searchParams.get('video')).toBeNull();
  });

  test('a live camera makes the invite a video invite', async ({ page }) => {
    const url = new URL(await page.evaluate(() => {
      localVideoActive = true;
      return roomInviteUrl('myroom');
    }));
    expect(url.searchParams.get('room')).toBe('myroom');
    expect(url.searchParams.get('video')).toBe('1');
  });

  test('the link follows the camera, not how this window was opened', async ({ page }) => {
    // Opened with ?video=1 but the camera is off now — an invite must describe
    // the room as it is, not as this window was launched.
    await page.goto('/?video=1');
    await seedRoom(page, { selfId: 'host', isHost: true, roomCode: 'myroom', connections: [] });
    const url = new URL(await page.evaluate(() => roomInviteUrl('myroom')));
    expect(url.searchParams.get('video')).toBeNull();
  });

  test('the pop-out keeps the camera it was sharing', async ({ page }) => {
    const off = new URL(await page.evaluate(() => tinyPopoutUrl()));
    const on = new URL(await page.evaluate(() => {
      localVideoActive = true;
      return tinyPopoutUrl();
    }));
    expect(off.searchParams.get('video')).toBeNull();
    expect(on.searchParams.get('video')).toBe('1');
    // The rest of the pop-out contract is untouched.
    expect(on.searchParams.get('forceWeb')).toBe('1');
    expect(on.searchParams.get('room')).toBe('myroom');
  });

  test('an invite with no room is still empty', async ({ page }) => {
    expect(await page.evaluate(() => {
      localVideoActive = true;
      return roomInviteUrl('');
    })).toBe('');
  });
});
