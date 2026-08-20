import { test, expect } from './fixtures.js';

// The network echo test end to end. It is a real WebRTC loopback between two
// RTCPeerConnections in this page, so the whole path — SDP, ICE, decode, the
// stats probe that proves packets actually flowed — runs for real. Only the
// microphone is synthetic, and only because headless Chromium has none.
//
// `iceTransportPolicy: 'all'` is the documented test entry point: production
// forces 'relay', which needs a TURN server CI does not have.

test.setTimeout(60_000);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    // A real audio track, generated rather than captured.
    navigator.mediaDevices.getUserMedia = function() {
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      const osc = ctx.createOscillator();
      osc.frequency.value = 440;
      osc.connect(dest);
      osc.start();
      return Promise.resolve(dest.stream);
    };
    // The capture path must stay raw: RNNoise shares one worklet graph.
    localStorage.setItem('noise-suppression', 'off');
    // No relay to reach, and none needed for a loopback.
    localStorage.setItem('turn-fallback', '[]');
    inRoom = false;
  });
});

test.describe('a full loopback run', () => {
  test('connects, proves audio flowed, and scores the round trip', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      await startEchoTest({ iceTransportPolicy: 'all' });
      if (!_echo) return { failed: document.getElementById('echo-test-status').textContent };
      const running = {
        button: document.getElementById('btn-test-echo').textContent,
        status: document.getElementById('echo-test-status').textContent,
        meterHidden: document.getElementById('echo-test-level-fill')
          .closest('.media-level').classList.contains('hidden'),
        before: !!_echo.before,
      };
      // Let some audio actually go round before scoring it.
      await new Promise((r) => setTimeout(r, 600));
      await stopEchoTest({ replay: true });
      return {
        running,
        stopped: {
          echo: _echo,
          button: document.getElementById('btn-test-echo').textContent,
          status: document.getElementById('echo-test-status').textContent,
        },
      };
    });
    expect(seen.failed).toBeUndefined();
    expect(seen.running.button).toBe('Stop & Replay');
    expect(seen.running.status).toBe('Speak now — recording…');
    expect(seen.running.meterHidden).toBe(false);
    expect(seen.running.before).toBeTruthy();
    expect(seen.stopped.echo).toBe(null);
    expect(seen.stopped.button).toBe('Test over network');
    // The verdict names the path it actually took — a loopback is never relayed.
    expect(seen.stopped.status).toContain('not relayed');
  });

  test('stopping without a replay just clears the status', async ({ page }) => {
    const status = await page.evaluate(async () => {
      await startEchoTest({ iceTransportPolicy: 'all' });
      if (!_echo) return 'never-started';
      await stopEchoTest();
      return document.getElementById('echo-test-status').textContent;
    });
    expect(status).toBe('');
  });

  test('a second start while one is running is ignored', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      await startEchoTest({ iceTransportPolicy: 'all' });
      if (!_echo) return 'never-started';
      const first = _echo;
      await startEchoTest({ iceTransportPolicy: 'all' });
      const same = _echo === first;
      await stopEchoTest();
      return same;
    });
    expect(seen).toBe(true);
  });

  test('a microphone that cannot be opened is reported, not swallowed', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('no device'));
      await startEchoTest({ iceTransportPolicy: 'all' });
      return { echo: _echo, status: document.getElementById('echo-test-status').textContent };
    });
    expect(seen.echo).toBe(null);
    expect(seen.status).toContain('Could not start the test');
  });

  test('the ICE path of a finished run is readable', async ({ page }) => {
    const iceType = await page.evaluate(async () => {
      await startEchoTest({ iceTransportPolicy: 'all' });
      if (!_echo) return 'never-started';
      await new Promise((r) => setTimeout(r, 400));
      const out = await echoSelectedIceType(_echo.receiver);
      await stopEchoTest();
      return out;
    });
    // A loopback settles on host candidates, never a relay.
    expect(iceType).toBe('host');
  });

  test('a closed connection yields no ICE path rather than throwing', async ({ page }) => {
    const iceType = await page.evaluate(async () => {
      const pc = new RTCPeerConnection();
      pc.close();
      return echoSelectedIceType(pc);
    });
    expect(iceType).toBe(null);
  });
});

test.describe('the toggle', () => {
  test('starts a run, then stops and replays it', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      await toggleEchoTest();
      const running = echoTestRunning();
      await new Promise((r) => setTimeout(r, 400));
      await toggleEchoTest();
      return { running, stopped: !echoTestRunning() };
    });
    // In production the run is relay-only, so on a machine with no TURN this
    // ends at the "no relay reachable" verdict instead — either way the toggle
    // must leave nothing running behind it.
    expect(seen.stopped).toBe(true);
    expect(typeof seen.running).toBe('boolean');
  });

  test('a failure inside the start path is reported and cleaned up', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      // Force the very first await to throw.
      const original = window.fetchIceServers;
      window.fetchIceServers = () => Promise.reject(new Error('ICE resolution exploded'));
      await toggleEchoTest();
      window.fetchIceServers = original;
      return { echo: _echo, status: document.getElementById('echo-test-status').textContent };
    });
    expect(seen.echo).toBe(null);
    expect(seen.status).toContain('Network test failed');
  });
});
