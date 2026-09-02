import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// What happens to a relayed video tile when the SFU leg goes wrong.
//
// unit-video-routing.spec.js covers which topology gets chosen and what goes
// over the wire when it works. This file is the other half: the reconnect
// ladder on a peer connection that drops, and the retry ladder on a
// subscription that is refused. Both exist for the same reason — a failure that
// only writes a dev-log line leaves the viewer looking at a black tile still
// badged "☁ Relayed", indistinguishable from a working one.

/** A stand-in for the client↔Cloudflare RTCPeerConnection. */
async function installFakePc(page) {
  await page.evaluate(() => {
    class FakePc extends EventTarget {
      constructor() {
        super();
        this.iceConnectionState = 'new';
        this.listenerCount = 0;
      }
      addEventListener(...args) { this.listenerCount++; return super.addEventListener(...args); }
      removeEventListener(...args) { this.listenerCount--; return super.removeEventListener(...args); }
      /** Move to a state and fire the event main.js listens for. */
      go(state) {
        this.iceConnectionState = state;
        this.dispatchEvent(new Event('iceconnectionstatechange'));
      }
    }
    window.__makePc = () => new FakePc();
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await seedRoom(page, {
    selfId: 'self',
    isHost: false,
    roomCode: 'host-1',
    connections: [{ id: 'peer-1', pseudo: 'Alice' }],
  });
  await installFakePc(page);
  await page.evaluate(() => {
    _videoTrackRegistry.clear();
    for (const k of Object.keys(_sfuSubscribeRetries)) delete _sfuSubscribeRetries[k];
  });
});

const trackState = (page, peerId = 'peer-1', kind = 'video') =>
  page.evaluate(({ peerId, kind }) => window.remoteTrackState(peerId, kind), { peerId, kind });

// --- the reconnect ladder on a dropped SFU leg -------------------------------

test.describe('_wireSfuReconnect', () => {
  test('a dropped leg is shown as reconnecting, not left looking healthy', async ({ page }) => {
    await page.evaluate(() => {
      const pc = window.__makePc();
      window.__pc = pc;
      _setTrackState('peer-1', 'video', { state: 'subscribed', topology: 'sfu' });
      window._wireSfuReconnect(pc, 'video', 'peer-1', 'subscribe', () => Promise.resolve());
      pc.go('disconnected');
    });

    expect(await trackState(page)).toBe('reconnecting');
  });

  test('a failed leg renegotiates, backing further off on each attempt', async ({ page }) => {
    const attempts = await page.evaluate(async () => {
      const pc = window.__makePc();
      const at = [];
      const t0 = Date.now();
      window._wireSfuReconnect(pc, 'video', 'peer-1', 'subscribe', () => {
        at.push(Date.now() - t0);
        return Promise.resolve();
      });

      pc.go('failed');
      await new Promise((r) => setTimeout(r, SFU_RECONNECT_BASE_DELAY_MS + 200));
      const first = at.length;
      pc.go('failed');
      await new Promise((r) => setTimeout(r, SFU_RECONNECT_BASE_DELAY_MS + 200));
      // The second attempt waits 2× the base delay, so it has not fired yet.
      const secondNotYet = at.length;
      await new Promise((r) => setTimeout(r, SFU_RECONNECT_BASE_DELAY_MS + 200));
      return { first, secondNotYet, total: at.length, base: SFU_RECONNECT_BASE_DELAY_MS };
    });

    expect(attempts.first).toBe(1);
    expect(attempts.secondNotYet).toBe(1);
    expect(attempts.total).toBe(2);
  });

  test('a leg that comes back resets the ladder, so the next drop retries promptly', async ({ page }) => {
    const timing = await page.evaluate(async () => {
      const pc = window.__makePc();
      const at = [];
      window._wireSfuReconnect(pc, 'video', 'peer-1', 'subscribe', () => {
        at.push(Date.now());
        return Promise.resolve();
      });

      pc.go('failed');
      await new Promise((r) => setTimeout(r, SFU_RECONNECT_BASE_DELAY_MS + 200));
      pc.go('connected');           // the retry worked
      const t = Date.now();
      pc.go('failed');              // and it drops again later
      await new Promise((r) => setTimeout(r, SFU_RECONNECT_BASE_DELAY_MS + 200));
      return { count: at.length, secondDelay: at[1] - t, base: SFU_RECONNECT_BASE_DELAY_MS };
    });

    expect(timing.count).toBe(2);
    // One base delay, not two: 'connected' zeroed the attempt counter.
    expect(timing.secondDelay).toBeLessThan(timing.base * 2);
  });

  test('an exhausted ladder marks the track errored, unhooks, and tells the topology selector', async ({ page }) => {
    const out = await page.evaluate(async () => {
      const pc = window.__makePc();
      let renegotiations = 0;
      window._wireSfuReconnect(pc, 'video', 'peer-1', 'subscribe', () => { renegotiations++; return Promise.resolve(); });

      // Every 'failed' consumes one attempt; the delays never have to elapse
      // for the ladder to be exhausted.
      for (let i = 0; i <= SFU_RECONNECT_MAX_ATTEMPTS; i++) pc.go('failed');

      const state = window.remoteTrackState('peer-1', 'video');
      const listenersAfter = pc.listenerCount;
      // Further events must be ignored entirely once it has given up.
      pc.go('failed');
      return {
        state,
        listenersAfter,
        stillError: window.remoteTrackState('peer-1', 'video'),
        // A persistently unhealthy SFU must stop being recommended.
        sfuHint: window.sfuAvailabilityHint(),
        max: SFU_RECONNECT_MAX_ATTEMPTS,
        renegotiations,
      };
    });

    expect(out.state).toBe('error');
    expect(out.listenersAfter).toBe(0);
    expect(out.stillError).toBe('error');
    expect(out.sfuHint).toBe(false);
  });

  test('a renegotiate that itself fails is caught, not left unhandled', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.evaluate(async () => {
      const pc = window.__makePc();
      window._wireSfuReconnect(pc, 'video', 'peer-1', 'publish', () => Promise.reject(new Error('mint refused')));
      pc.go('failed');
      await new Promise((r) => setTimeout(r, SFU_RECONNECT_BASE_DELAY_MS + 300));
    });

    expect(errors).toEqual([]);
  });

  test('no peer connection at all is a no-op rather than a throw', async ({ page }) => {
    const ok = await page.evaluate(() => {
      window._wireSfuReconnect(null, 'video', 'peer-1', 'subscribe', () => Promise.resolve());
      return true;
    });
    expect(ok).toBe(true);
  });
});

// --- the retry ladder on a refused subscription ------------------------------

test.describe('_sfuSubscribeFailed', () => {
  test('the failure is recorded on the tile, with the reason', async ({ page }) => {
    const track = await page.evaluate(() => {
      _setTrackState('peer-1', 'video', { state: 'subscribed', topology: 'sfu' });
      window._sfuSubscribeFailed('video', 'peer-1', { sessionId: 's', trackName: 't' }, new Error('HTTP 502'));
      return _videoTrackRegistry.get('peer-1:video');
    });

    // A black tile still badged "Relayed" is the failure this prevents.
    expect(track.state).toBe('failed');
    expect(track.error).toBe('HTTP 502');
  });

  test('an ordinary failure is not retried — only a rate limit is transient', async ({ page }) => {
    const retries = await page.evaluate(async () => {
      let subscribes = 0;
      window.sfuSubscribeTrack = () => { subscribes++; return Promise.resolve(); };
      window._sfuSubscribeFailed('video', 'peer-1', { sessionId: 's', trackName: 't' },
        Object.assign(new Error('negotiate failed'), { code: 'negotiate_failed' }));
      await new Promise((r) => setTimeout(r, 300));
      return subscribes;
    });

    expect(retries).toBe(0);
  });

  test('a rate limit is retried, honouring the server\'s Retry-After', async ({ page }) => {
    const out = await page.evaluate(async () => {
      const calls = [];
      window.sfuSubscribeTrack = (kind, id, ref) => { calls.push({ kind, id, ref }); return Promise.resolve(); };
      window._sfuSubscribeFailed('video', 'peer-1', { sessionId: 's', trackName: 't' },
        Object.assign(new Error('rate limited'), { code: 'rate_limited', retryAfterMs: 100 }));

      await new Promise((r) => setTimeout(r, 50));
      const beforeDue = calls.length;
      await new Promise((r) => setTimeout(r, 200));
      return { beforeDue, calls };
    });

    expect(out.beforeDue).toBe(0);
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]).toMatchObject({ kind: 'video', id: 'peer-1', ref: { sessionId: 's', trackName: 't' } });
  });

  test('a successful retry clears the attempt count for that track', async ({ page }) => {
    const left = await page.evaluate(async () => {
      window.sfuSubscribeTrack = () => Promise.resolve();
      window._sfuSubscribeFailed('video', 'peer-1', { sessionId: 's', trackName: 't' },
        Object.assign(new Error('rate limited'), { code: 'rate_limited', retryAfterMs: 50 }));
      await new Promise((r) => setTimeout(r, 200));
      return _sfuSubscribeRetries['peer-1:video'];
    });

    expect(left).toBe(undefined);
  });

  test('it gives up after the retry budget instead of hammering forever', async ({ page }) => {
    const out = await page.evaluate(async () => {
      const ref = { sessionId: 's', trackName: 't' };
      const err = () => Object.assign(new Error('rate limited'), { code: 'rate_limited', retryAfterMs: 1 });
      // Burn the budget without waiting for the (growing) delays to elapse.
      for (let i = 0; i < SFU_SUBSCRIBE_MAX_RETRIES; i++) {
        window._sfuSubscribeFailed('video', 'peer-1', ref, err());
      }
      const atBudget = _sfuSubscribeRetries['peer-1:video'];

      let extra = 0;
      window.sfuSubscribeTrack = () => { extra++; return Promise.resolve(); };
      window._sfuSubscribeFailed('video', 'peer-1', ref, err());   // one over
      return { atBudget, over: _sfuSubscribeRetries['peer-1:video'], max: SFU_SUBSCRIBE_MAX_RETRIES };
    });

    expect(out.atBudget).toBe(out.max);
    // The over-budget attempt must not be counted, and must schedule nothing.
    expect(out.over).toBe(out.max);
  });

  test('a retry that comes due after the peer left does nothing', async ({ page }) => {
    const subscribes = await page.evaluate(async () => {
      let calls = 0;
      window.sfuSubscribeTrack = () => { calls++; return Promise.resolve(); };
      window._sfuSubscribeFailed('video', 'peer-1', { sessionId: 's', trackName: 't' },
        Object.assign(new Error('rate limited'), { code: 'rate_limited', retryAfterMs: 100 }));
      connections.delete('peer-1');       // they hung up while we waited
      await new Promise((r) => setTimeout(r, 250));
      return calls;
    });

    expect(subscribes).toBe(0);
  });

  test('a retry that comes due after we left the room does nothing either', async ({ page }) => {
    const subscribes = await page.evaluate(async () => {
      let calls = 0;
      window.sfuSubscribeTrack = () => { calls++; return Promise.resolve(); };
      window._sfuSubscribeFailed('screen', 'peer-1', { sessionId: 's', trackName: 't' },
        Object.assign(new Error('rate limited'), { code: 'rate_limited', retryAfterMs: 100 }));
      inRoom = false;
      await new Promise((r) => setTimeout(r, 250));
      return calls;
    });

    expect(subscribes).toBe(0);
  });

  test('each kind has its own budget — a failing screen share does not exhaust the camera\'s', async ({ page }) => {
    const counts = await page.evaluate(() => {
      const ref = { sessionId: 's', trackName: 't' };
      const err = () => Object.assign(new Error('rate limited'), { code: 'rate_limited', retryAfterMs: 100000 });
      window._sfuSubscribeFailed('screen', 'peer-1', ref, err());
      window._sfuSubscribeFailed('screen', 'peer-1', ref, err());
      window._sfuSubscribeFailed('video', 'peer-1', ref, err());
      return { screen: _sfuSubscribeRetries['peer-1:screen'], video: _sfuSubscribeRetries['peer-1:video'] };
    });

    expect(counts.screen).toBe(2);
    expect(counts.video).toBe(1);
  });
});
