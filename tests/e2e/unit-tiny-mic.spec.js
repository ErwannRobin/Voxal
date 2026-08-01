import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// A tiny embed joins muted on purpose: an iframe the user never interacted with
// throwing a microphone prompt at them is hostile, so the mic waits for the
// first press. That trade only buys something while a prompt is actually
// possible — once the browser holds a persisted grant, getUserMedia() resolves
// silently and staying lazy just costs the start of the first press. So the
// embed asks what the next call would do, and acquires eagerly when the answer
// is "nothing visible".

// The unit project runs without fake-media flags (and the container has no audio
// hardware), so getUserMedia is stubbed. It counts its calls, which is what the
// "no second mic" and "no prompt" assertions are actually about.
const stubMic = (page) =>
  page.addInitScript(() => {
    window.__gumCalls = 0;
    navigator.mediaDevices.getUserMedia = () => {
      window.__gumCalls++;
      const track = {
        kind: 'audio',
        enabled: true,
        readyState: 'live',
        stop() { track.readyState = 'ended'; },
        getSettings: () => ({}),
      };
      const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
      // A real acquisition is never synchronous — the delay is what lets a press
      // land mid-flight in the test below.
      return new Promise((resolve) => setTimeout(() => resolve(stream), 40));
    };
  });

// Reproduces the shape Safari/Firefox present: no Permissions API, and nothing
// labelled to probe. micPermissionState() then reports 'unknown'.
const stubUndetectable = (page) =>
  page.addInitScript(() => {
    navigator.permissions.query = () => Promise.reject(new TypeError('unsupported'));
    navigator.mediaDevices.enumerateDevices = () => Promise.resolve([]);
  });

async function openRoom(page, url) {
  await stubMic(page);
  await page.goto(url);
  // Keep the acquisition to the plain getUserMedia path: RNNoise would pull in a
  // WASM worklet that has nothing to do with what is under test.
  await page.evaluate(() => localStorage.setItem('noise-suppression', 'off'));
  await seedRoom(page, { isHost: true, roomCode: 'abc-def' });
  await page.evaluate(() => showScreen('room'));
}

const gumCalls = (page) => page.evaluate(() => window.__gumCalls);
const decide = (page) => page.evaluate(() => window.shouldAcquireMicOnJoin());

test.describe('should the mic be acquired at join?', () => {
  test('the full app always does — the user opened it themselves', async ({ page }) => {
    await page.goto('/');
    // Permission is 'prompt' here, and that is fine: a prompt is expected when
    // someone opens Voxal and joins a room.
    expect(await page.evaluate(() => window.micPermissionState())).toBe('prompt');
    expect(await decide(page)).toBe(true);
  });

  test('a tiny embed stays lazy while a prompt is still possible', async ({ page }) => {
    await page.goto('/?tiny=1');
    expect(await decide(page)).toBe(false);
  });

  test('a tiny embed acquires immediately once the grant is persisted', async ({ page, context }) => {
    await context.grantPermissions(['microphone']);
    await page.goto('/?tiny=1');
    expect(await decide(page)).toBe(true);
  });

  test('an undetectable permission state stays lazy — guessing wrong is the prompt', async ({ page }) => {
    await stubUndetectable(page);
    await page.goto('/?tiny=1');
    expect(await page.evaluate(() => window.micPermissionState())).toBe('unknown');
    expect(await decide(page)).toBe(false);
  });
});

test.describe('autoAcquireMicOnJoin', () => {
  test('a granted tiny embed holds the mic before the first press', async ({ page, context }) => {
    await context.grantPermissions(['microphone']);
    await openRoom(page, '/?tiny=1');
    await page.evaluate(() => window.autoAcquireMicOnJoin());

    await expect.poll(() => page.evaluate(() => !!stream)).toBe(true);
    expect(await gumCalls(page)).toBe(1);
    // Acquired, but muted: the track exists so the first press transmits from
    // its first syllable, and it is disabled so nothing leaks before that.
    expect(await page.evaluate(() => audioTrack.enabled)).toBe(false);
  });

  test('an ungranted tiny embed touches nothing — no prompt the user did not ask for', async ({ page }) => {
    await openRoom(page, '/?tiny=1');
    await page.evaluate(() => window.autoAcquireMicOnJoin());
    // Long enough for the permission probe to resolve and the acquisition to
    // have started, had it been going to.
    await page.waitForTimeout(300);
    expect(await gumCalls(page)).toBe(0);
    expect(await page.evaluate(() => stream)).toBe(null);
  });

  test('the full app still auto-acquires — the tiny gate must not catch it', async ({ page }) => {
    await openRoom(page, '/');
    await page.evaluate(() => window.autoAcquireMicOnJoin());
    await expect.poll(() => page.evaluate(() => !!stream)).toBe(true);
    expect(await page.evaluate(() => audioTrack.enabled)).toBe(false);
  });

  test('a press during the join-time acquisition opens no second mic, and still transmits', async ({ page, context }) => {
    await context.grantPermissions(['microphone']);
    await openRoom(page, '/?tiny=1');
    await page.evaluate(() => {
      window.autoAcquireMicOnJoin();
      // Straight onto the talk button while the mic is still coming up. Both
      // paths share _micAcquirePromise, so this must join the one in flight.
      setTalking(true);
    });

    await expect.poll(() => page.evaluate(() => isTalking)).toBe(true);
    expect(await gumCalls(page)).toBe(1);
    expect(await page.evaluate(() => audioTrack.enabled)).toBe(true);
  });

  test('a failure nobody asked for is logged, not thrown in the user\'s face', async ({ page, context }) => {
    await context.grantPermissions(['microphone']);
    await stubMic(page);
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => {
        window.__gumCalls++;
        const err = new Error('Permission denied');
        err.name = 'NotAllowedError';
        return Promise.reject(err);
      };
    });
    await page.goto('/?tiny=1');
    await page.evaluate(() => localStorage.setItem('noise-suppression', 'off'));
    await seedRoom(page, { isHost: true, roomCode: 'abc-def' });
    await page.evaluate(() => { showScreen('room'); window.autoAcquireMicOnJoin(); });

    await expect.poll(() => gumCalls(page)).toBe(1);
    // showError()/showMicDeniedError() take over the whole screen. Nobody asked
    // for this acquisition, so nobody gets a dialog about it failing — the next
    // press tries again and reports properly.
    await expect(page.locator('#screen-error')).not.toHaveClass(/active/);
    await expect(page.locator('#screen-room')).toHaveClass(/active/);
    expect(await page.evaluate(() => stream)).toBe(null);
  });

  test('a press that fails still explains itself', async ({ page }) => {
    await stubMic(page);
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => {
        window.__gumCalls++;
        const err = new Error('Permission denied');
        err.name = 'NotAllowedError';
        return Promise.reject(err);
      };
    });
    await page.goto('/?tiny=1');
    await page.evaluate(() => localStorage.setItem('noise-suppression', 'off'));
    await seedRoom(page, { isHost: true, roomCode: 'abc-def' });
    await page.evaluate(() => { showScreen('room'); setTalking(true); });

    await expect(page.locator('#screen-error')).toHaveClass(/active/);
  });
});
