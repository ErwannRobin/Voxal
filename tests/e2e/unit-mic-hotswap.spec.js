import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// Changing the noise-suppression mode or the microphone device used to write
// localStorage and stop. Both values are only ever read inside getMicStream(),
// which runs once per room join — so a change made during a call did nothing
// until the NEXT session. reacquireMicForRoom() closes that gap by re-acquiring
// and swapping the track on every live sender without renegotiating.
//
// These drive the real globals in main.js (a flat classic script — see
// _helpers.js) with getMicStream and the peer connections stubbed, so the
// swap/teardown bookkeeping is exercised without real WebRTC or a real mic.

// Install a fake capture pipeline: getMicStream() hands out numbered streams and
// every acquisition/stop is recorded so the test can assert on the sequence.
async function stubCapture(page) {
  await page.evaluate(() => {
    window.__mic = { acquired: [], stopped: [], swapped: [], nextId: 1 };

    window.makeFakeStream = (id, opts) => {
      opts = opts || {};
      const track = {
        kind: 'audio', id: 'track-' + id, readyState: 'live', enabled: false,
        stop() { this.readyState = 'ended'; window.__mic.stopped.push(id); },
        addEventListener() {}, removeEventListener() {},
      };
      const s = {
        __id: id,
        getAudioTracks: () => [track],
        getTracks: () => [track],
      };
      if (opts.rnnoise) {
        // Mirror applyRNNoise's shape: the returned stream is a graph
        // DESTINATION whose source is a separate raw getUserMedia stream.
        const rawTrack = {
          kind: 'audio', id: 'raw-' + id, readyState: 'live',
          stop() { this.readyState = 'ended'; window.__mic.stopped.push('raw-' + id); },
        };
        s._rnnoiseSource = { disconnect() { window.__mic.stopped.push('source-' + id); } };
        s._rnnoiseDest = { __dest: id };
        s._rnnoiseOriginal = { getTracks: () => [rawTrack], getAudioTracks: () => [rawTrack] };
      }
      return s;
    };

    window.getMicStream = async () => {
      const id = window.__mic.nextId++;
      window.__mic.acquired.push({ id, mode: window.getNoiseSuppressionMode() });
      return window.makeFakeStream(id, { rnnoise: window.getNoiseSuppressionMode() === 'rnnoise' });
    };
  });
}

// Give a seeded peer a MediaConnection whose sender records replaceTrack calls.
async function stubSenders(page, peerIds) {
  await page.evaluate((ids) => {
    ids.forEach((id) => {
      const conn = connections.get(id) || {};
      const sender = {
        track: { kind: 'audio', id: 'old-track', readyState: 'live' },
        async replaceTrack(t) { this.track = t; window.__mic.swapped.push(id); },
      };
      conn.media = { closed: false, peerConnection: { getSenders: () => [sender] } };
      conn.__sender = sender;
      connections.set(id, conn);
    });
  }, peerIds);
}

async function enterCallWithMic(page, { mode = 'rnnoise', peers = ['peer-a', 'peer-b'] } = {}) {
  await page.goto('/');
  await page.evaluate((m) => localStorage.setItem('noise-suppression', m), mode);
  await stubCapture(page);
  await seedRoom(page, { selfId: 'self', isHost: true, inRoom: true, connections: peers.map((id) => ({ id })) });
  await stubSenders(page, peers);
  // Acquire the initial mic the way the room does.
  await page.evaluate(async () => {
    stream = await window.getMicStream();
    audioTrack = stream.getAudioTracks()[0];
    audioTrack.enabled = false;
  });
}

const micState = (page) => page.evaluate(() => ({
  ...window.__mic,
  currentStreamId: stream && stream.__id,
  currentTrackId: audioTrack && audioTrack.id,
  enabled: audioTrack && audioTrack.enabled,
}));

test('changing the mode mid-call re-acquires and swaps every live sender', async ({ page }) => {
  await enterCallWithMic(page, { mode: 'rnnoise' });

  await page.evaluate(async () => {
    localStorage.setItem('noise-suppression', 'browser');
    await window.reacquireMicForRoom();
  });

  const s = await micState(page);
  // Second acquisition saw the NEW mode — the whole point of the fix.
  expect(s.acquired.map((a) => a.mode)).toEqual(['rnnoise', 'browser']);
  expect(s.currentStreamId).toBe(2);
  // Both peers' senders were swapped, without tearing the calls down.
  expect(s.swapped.sort()).toEqual(['peer-a', 'peer-b']);
});

test('the previous RNNoise graph is fully torn down on swap', async ({ page }) => {
  await enterCallWithMic(page, { mode: 'rnnoise' });
  await page.evaluate(async () => { await window.reacquireMicForRoom(); });

  const s = await micState(page);
  // The old destination stream's track, its RNNoise source node, AND the raw
  // getUserMedia track hiding behind _rnnoiseOriginal. Missing the last one is
  // what left the mic indicator lit after every call.
  expect(s.stopped).toContain(1);
  expect(s.stopped).toContain('source-1');
  expect(s.stopped).toContain('raw-1');
  // ...and only the old one. The replacement stays live.
  expect(s.stopped).not.toContain(2);
});

test('a swap while transmitting keeps the new track enabled', async ({ page }) => {
  await enterCallWithMic(page);
  await page.evaluate(async () => {
    audioTrack.enabled = true;             // mid-press
    await window.reacquireMicForRoom();
  });
  expect((await micState(page)).enabled).toBe(true);
});

test('a swap while released keeps the new track muted', async ({ page }) => {
  await enterCallWithMic(page);
  await page.evaluate(async () => { await window.reacquireMicForRoom(); });
  expect((await micState(page)).enabled).toBe(false);
});

test('no re-acquire outside a room', async ({ page }) => {
  await page.goto('/');
  await stubCapture(page);
  await page.evaluate(() => { inRoom = false; stream = null; });
  expect(await page.evaluate(() => window.reacquireMicForRoom())).toBe(false);
  expect((await micState(page)).acquired).toEqual([]);
});

test('no re-acquire before the room has a microphone', async ({ page }) => {
  await page.goto('/');
  await stubCapture(page);
  await seedRoom(page, { selfId: 'self', isHost: true, inRoom: true });
  await page.evaluate(() => { stream = null; });
  expect(await page.evaluate(() => window.reacquireMicForRoom())).toBe(false);
  // Nothing to swap yet — the join-time acquisition will read the new value.
  expect((await micState(page)).acquired).toEqual([]);
});

test('a failed re-acquire keeps the call on the previous microphone', async ({ page }) => {
  await enterCallWithMic(page);
  await page.evaluate(async () => {
    window.getMicStream = async () => { throw new Error('NotReadableError'); };
    await window.reacquireMicForRoom();
  });
  const s = await micState(page);
  // Still on stream 1, still wired up — a failed swap must never mute the call.
  expect(s.currentStreamId).toBe(1);
  expect(s.stopped).not.toContain(1);
});

test('leaving the room stops the raw mic behind the RNNoise graph', async ({ page }) => {
  await enterCallWithMic(page, { mode: 'rnnoise' });
  await page.evaluate(() => { window.stopMicStreamFully(stream); });
  const s = await micState(page);
  expect(s.stopped).toEqual(expect.arrayContaining([1, 'source-1', 'raw-1']));
});

test('stopMicStreamFully is safe on a raw (non-RNNoise) stream', async ({ page }) => {
  await page.goto('/');
  await stubCapture(page);
  const ok = await page.evaluate(() => {
    const s = window.makeFakeStream(9, { rnnoise: false });
    try { window.stopMicStreamFully(s); } catch (e) { return e.message; }
    return window.__mic.stopped;
  });
  expect(ok).toEqual([9]);
});

test('stopMicStreamFully tolerates a null stream', async ({ page }) => {
  await page.goto('/');
  expect(await page.evaluate(() => {
    try { window.stopMicStreamFully(null); return true; } catch (e) { return e.message; }
  })).toBe(true);
});

test.describe('cross-window sync', () => {
  // The desktop preferences window is a separate WebView with no module system,
  // so it cannot touch the capture pipeline itself — it writes localStorage and
  // the main window does the work via a storage event. The key has to be in that
  // listener's relevantKeys or the change is dropped entirely.
  const dispatchStorage = (page, key, newValue) => page.evaluate(({ key, newValue }) => {
    localStorage.setItem(key, newValue);
    window.dispatchEvent(new StorageEvent('storage', { key, newValue }));
  }, { key, newValue });

  test('a mode change from the preferences window re-acquires here', async ({ page }) => {
    await enterCallWithMic(page, { mode: 'rnnoise' });
    await dispatchStorage(page, 'noise-suppression', 'off');
    await expect.poll(async () => (await micState(page)).acquired.length).toBe(2);
    expect((await micState(page)).acquired[1].mode).toBe('off');
  });

  test('a mic device change from the preferences window re-acquires here', async ({ page }) => {
    await enterCallWithMic(page);
    await dispatchStorage(page, 'mic-device-id', 'other-mic');
    await expect.poll(async () => (await micState(page)).acquired.length).toBe(2);
  });

  test('an unrelated key does not disturb the microphone', async ({ page }) => {
    await enterCallWithMic(page);
    await dispatchStorage(page, 'some-unrelated-key', 'x');
    await page.waitForTimeout(100);
    expect((await micState(page)).acquired.length).toBe(1);
  });
});

test.describe('room-active flag', () => {
  // Published for the desktop preferences window, whose device-label probe runs
  // a getUserMedia in a SEPARATE WebView — on macOS that reconfigures the shared
  // capture session and killed the main window's live audio and video.
  test('set while in a room, cleared on leave', async ({ page }) => {
    await page.goto('/');
    const read = () => page.evaluate(() => localStorage.getItem('room-active'));
    expect(await read()).toBeNull();
    await page.evaluate(() => window.publishRoomActive(true));
    expect(await read()).not.toBeNull();
    await page.evaluate(() => window.publishRoomActive(false));
    expect(await read()).toBeNull();
  });

  test('a value left over from a previous run is cleared on load', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.setItem('room-active', '123'));
    // A crash or a mid-call reload would otherwise leave the flag set forever,
    // permanently suppressing the probe.
    await page.reload();
    expect(await page.evaluate(() => localStorage.getItem('room-active'))).toBeNull();
  });
});
