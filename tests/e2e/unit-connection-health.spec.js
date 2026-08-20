import { test, expect } from './fixtures.js';
import { seedRoom, callFn } from './_helpers.js';

// The parts that keep a live call honest: the stats tick, the SFU's reconnect
// ladder, the errors PeerJS raises at runtime, and the presence session a host
// keeps refreshed while people come and go.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test.describe('the stats tick', () => {
  test('samples every peer and refreshes an open popover', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1', pseudo: 'Ada' }] });
    const seen = await page.evaluate(async () => {
      const c = connections.get('p1');
      c.media = {
        closed: false,
        peerConnection: {
          getStats: () => Promise.resolve(new Map([
            ['pair', { id: 'pair', type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'lc', currentRoundTripTime: 0.04 }],
            ['lc', { id: 'lc', type: 'local-candidate', candidateType: 'relay' }],
            ['in', { type: 'inbound-rtp', kind: 'audio', packetsReceived: 100, packetsLost: 1, jitter: 0.005 }],
          ])),
        },
      };
      const anchor = document.createElement('button');
      document.body.appendChild(anchor);
      c.webrtcStats = { rttMs: 0, iceType: 'host' };
      showStatsPopover('p1', anchor);

      startStatsPolling();
      // The tick runs immediately as well as on the interval.
      await new Promise((r) => setTimeout(r, 100));
      stopStatsPolling();
      const out = {
        stats: connections.get('p1').webrtcStats,
        popoverText: document.getElementById('stats-popover').textContent,
      };
      closeStatsPopover();
      anchor.remove();
      return out;
    });
    expect(seen.stats.iceType).toBe('relay');
    expect(seen.stats.rttMs).toBe(40);
    expect(seen.popoverText.length).toBeGreaterThan(0);
  });

  test('refreshing a popover that is not open does nothing', async ({ page }) => {
    const threw = await page.evaluate(() => {
      closeStatsPopover();
      try { _refreshOpenStatsPopover(); return false; } catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });

  test('a click inside the popover keeps it open, outside closes it', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1', pseudo: 'Ada' }] });
    const seen = await page.evaluate(async () => {
      connections.get('p1').webrtcStats = { rttMs: 20, jitterMs: 3, lossPercent: 0.1, iceType: 'host' };
      const anchor = document.createElement('button');
      document.body.appendChild(anchor);
      showStatsPopover('p1', anchor);
      await new Promise((r) => setTimeout(r, 10));
      document.getElementById('stats-popover').click();
      await new Promise((r) => setTimeout(r, 10));
      const stillOpen = !!document.getElementById('stats-popover');
      document.body.click();
      const afterOutside = !!document.getElementById('stats-popover');
      anchor.remove();
      return { stillOpen, afterOutside };
    });
    expect(seen).toEqual({ stillOpen: true, afterOutside: false });
  });

  test('the loss history keeps a bounded window', async ({ page }) => {
    const seen = await page.evaluate(() => {
      let history = [];
      for (let i = 0; i < LOSS_HISTORY_MAX + 10; i++) history = _pushLossHistory(history, i);
      return { length: history.length, first: history[0], last: history[history.length - 1] };
    });
    expect(seen.length).toBe(await page.evaluate(() => LOSS_HISTORY_MAX));
    expect(seen.last).toBe(seen.length + 9);
    expect(seen.first).toBe(10);
  });

  test('a non-numeric sample is recorded as zero, never as a gap', async ({ page }) => {
    const history = await callFn(page, '_pushLossHistory', [1, 2], null);
    expect(history).toEqual([1, 2, 0]);
  });
});

test.describe('the SFU reconnect ladder', () => {
  /** A stub peer connection whose ICE state can be driven by hand. */
  async function fakePc(page) {
    await page.evaluate(() => {
      window.__mkPc = function() {
        const listeners = [];
        return {
          iceConnectionState: 'new',
          removed: 0,
          addEventListener(_, fn) { listeners.push(fn); },
          removeEventListener() { this.removed++; },
          set(state) { this.iceConnectionState = state; listeners.forEach((fn) => fn()); },
        };
      };
    });
  }

  test('a disconnected subscription is marked as reconnecting', async ({ page }) => {
    await fakePc(page);
    const state = await page.evaluate(() => {
      const pc = window.__mkPc();
      _wireSfuReconnect(pc, 'video', 'p1', 'subscriber', () => Promise.resolve());
      pc.set('disconnected');
      return remoteTrackState('p1', 'video');
    });
    expect(state).toBe('reconnecting');
  });

  test('a failure schedules a renegotiation, and a recovery resets the ladder', async ({ page }) => {
    await fakePc(page);
    const seen = await page.evaluate(async () => {
      let renegotiations = 0;
      const pc = window.__mkPc();
      _wireSfuReconnect(pc, 'video', 'p1', 'subscriber', () => {
        renegotiations++;
        return Promise.resolve();
      });
      pc.set('failed');
      await new Promise((r) => setTimeout(r, SFU_RECONNECT_BASE_DELAY_MS + 200));
      const afterFirst = renegotiations;
      pc.set('connected'); // it came back
      return { afterFirst, exhausted: pc.removed };
    });
    expect(seen.afterFirst).toBe(1);
    expect(seen.exhausted).toBe(0);
  });

  test('exhausting the ladder gives up and marks the SFU unhealthy', async ({ page }) => {
    await fakePc(page);
    const seen = await page.evaluate(() => {
      const pc = window.__mkPc();
      _wireSfuReconnect(pc, 'video', 'p1', 'subscriber', () => Promise.resolve());
      // Trip it once past the budget without waiting out the backoff.
      for (let i = 0; i <= SFU_RECONNECT_MAX_ATTEMPTS; i++) pc.set('failed');
      return { state: remoteTrackState('p1', 'video'), unwired: pc.removed > 0, hint: sfuAvailabilityHint() };
    });
    expect(seen.state).toBe('error');
    expect(seen.unwired).toBe(true);
    // A persistently unhealthy relay must stop being recommended.
    expect(seen.hint).toBe(false);
  });

  test('a renegotiation that itself fails is logged, not thrown', async ({ page }) => {
    await fakePc(page);
    const threw = await page.evaluate(async () => {
      const pc = window.__mkPc();
      _wireSfuReconnect(pc, 'video', 'p1', 'subscriber', () => Promise.reject(new Error('still down')));
      pc.set('failed');
      await new Promise((r) => setTimeout(r, SFU_RECONNECT_BASE_DELAY_MS + 200));
      return false;
    }).catch(() => true);
    expect(threw).toBe(false);
  });

  test('wiring nothing is safe', async ({ page }) => {
    const threw = await page.evaluate(() => {
      try { _wireSfuReconnect(null, 'video', 'p1', 'subscriber', () => Promise.resolve()); return false; }
      catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });
});

test.describe('runtime errors from the broker', () => {
  test('an unreachable migration target is re-elected immediately', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'z-me',
      isHost: false,
      roomCode: 'dead-host',
      successorIds: ['a-deputy', 'z-me'],
    });
    const seen = await page.evaluate(() => {
      roomState = ROOM_STATE_MIGRATING;
      _migrationCandidateId = 'a-deputy';
      _migrationExcluded = new Set(['dead-host']);
      const err = Object.assign(new Error('Could not connect to peer a-deputy'), { type: 'peer-unavailable' });
      // Settled = the join already succeeded, so this is a live-room error.
      handlePeerRuntimeError(err, true, () => {});
      return { isHost, roomCode, candidate: _migrationCandidateId };
    });
    // The broker says the deputy is gone, so we skip the retry budget entirely.
    expect(seen).toEqual({ isHost: true, roomCode: 'z-me', candidate: null });
  });

  test('an unrelated non-fatal error while in a room is only logged', async ({ page }) => {
    await seedRoom(page, { selfId: 'me', isHost: false, roomCode: 'host', successorIds: ['me'] });
    const seen = await page.evaluate(() => {
      roomState = ROOM_STATE_CONNECTED;
      const err = Object.assign(new Error('Could not connect to peer someone-else'), { type: 'peer-unavailable' });
      handlePeerRuntimeError(err, true, () => {});
      return {
        isHost,
        errorScreen: document.getElementById('screen-error').classList.contains('active'),
      };
    });
    expect(seen).toEqual({ isHost: false, errorScreen: false });
  });

  test('a fatal error mid-call is shown to the user', async ({ page }) => {
    await seedRoom(page, { selfId: 'me', isHost: false, roomCode: 'host' });
    await page.evaluate(() => {
      handlePeerRuntimeError(Object.assign(new Error('gone'), { type: 'server-error' }), true, () => {});
    });
    expect(await page.locator('#error-message').textContent())
      .toBe('Could not reach the signalling server. Try again in a moment.');
  });

  test('an error before the join settled rejects rather than showing a screen', async ({ page }) => {
    const seen = await page.evaluate(() => {
      let rejected = null;
      const err = Object.assign(new Error('offline'), { type: 'network' });
      handlePeerRuntimeError(err, false, (e) => { rejected = e.message; });
      return { rejected, errorScreen: document.getElementById('screen-error').classList.contains('active') };
    });
    expect(seen.rejected).toBe('Network error — please check your connection and try again.');
    expect(seen.errorScreen).toBe(false);
  });

  test('the id of an unreachable peer is read out of the message', async ({ page }) => {
    expect(await callFn(page, 'unavailablePeerIdFromError',
      { message: 'Could not connect to peer abc-123' })).toBe('abc-123');
    expect(await callFn(page, 'unavailablePeerIdFromError', { message: 'something else' })).toBe(null);
    expect(await callFn(page, 'unavailablePeerIdFromError', null)).toBe(null);
  });

  test('only a peer-unavailable error is treated as non-fatal', async ({ page }) => {
    expect(await callFn(page, 'isNonFatalPeerRuntimeError', { type: 'peer-unavailable' })).toBe(true);
    expect(await callFn(page, 'isNonFatalPeerRuntimeError', { message: 'Could not connect to peer x' })).toBe(true);
    expect(await callFn(page, 'isNonFatalPeerRuntimeError', { type: 'server-error' })).toBe(false);
    expect(await callFn(page, 'isNonFatalPeerRuntimeError', null)).toBe(false);
  });
});

test.describe('connecting to a newly elected host', () => {
  test('stops our own beats and dials the elected peer', async ({ page }) => {
    await seedRoom(page, { selfId: 'me', isHost: false, roomCode: 'dead-host' });
    const seen = await page.evaluate(() => {
      inRoom = true;
      const dialled = [];
      peer = {
        id: 'me',
        destroyed: false,
        connect(id) {
          dialled.push(id);
          const handlers = {};
          return { peer: id, open: true, closed: false, send() {}, close() {},
                   on(e, fn) { (handlers[e] = handlers[e] || []).push(fn); } };
        },
      };
      startHostHeartbeat();
      startPeerHeartbeatSweep();
      connectToNewHost('new-host');
      return {
        dialled,
        connecting: connectingToHostId,
        candidate: _migrationCandidateId,
        known: knownPeerIds.has('new-host'),
        hostBeat: _hostHeartbeatInterval,
        sweep: _peerHeartbeatSweepInterval,
      };
    });
    expect(seen.dialled).toEqual(['new-host']);
    expect(seen.connecting).toBe('new-host');
    expect(seen.candidate).toBe('new-host');
    expect(seen.known).toBe(true);
    // Whatever we were doing as a host stops the moment we start following one.
    expect(seen.hostBeat).toBe(null);
    expect(seen.sweep).toBe(null);
  });
});

test.describe('the presence session a host keeps fresh', () => {
  test('is refreshed, debounced, while people come and go', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, connections: [{ id: 'p1' }] });
    const seen = await page.evaluate(async () => {
      localStorage.setItem('presence-api-token', 'tok');
      localStorage.setItem('presence-org-id', 'org');
      activeChannel = 'General';
      const posts = [];
      window.fetch = (url, opts) => {
        posts.push({ url: String(url), method: (opts || {}).method });
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ room_id: 'happy-otter' }) });
      };
      schedulePresenceRefresh();
      schedulePresenceRefresh(); // a burst collapses into one
      const immediate = posts.length;
      await new Promise((r) => setTimeout(r, 1400));
      const out = { immediate, later: posts.filter((p) => p.method === 'POST').length, code: activeChannelRoomId };
      activeChannel = null;
      return out;
    });
    expect(seen.immediate).toBe(0);
    expect(seen.later).toBe(1);
    // A public room id coming back is adopted as the shareable code.
    expect(seen.code).toBe('happy-otter');
  });

  test('a non-host never registers a session', async ({ page }) => {
    await seedRoom(page, { selfId: 'p2', isHost: false, roomCode: 'host' });
    const posts = await page.evaluate(async () => {
      localStorage.setItem('presence-api-token', 'tok');
      localStorage.setItem('presence-org-id', 'org');
      activeChannel = 'General';
      const seen = [];
      window.fetch = (url) => { seen.push(String(url)); return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); };
      syncPresenceChannelSession();
      schedulePresenceRefresh();
      await new Promise((r) => setTimeout(r, 1400));
      activeChannel = null;
      return seen;
    });
    expect(posts).toEqual([]);
  });

  test('a failed refresh is logged, not surfaced', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true });
    const errorScreen = await page.evaluate(async () => {
      localStorage.setItem('presence-api-token', 'tok');
      localStorage.setItem('presence-org-id', 'org');
      activeChannel = 'General';
      window.fetch = () => Promise.reject(new Error('presence is down'));
      syncPresenceChannelSession();
      await new Promise((r) => setTimeout(r, 50));
      activeChannel = null;
      return document.getElementById('screen-error').classList.contains('active');
    });
    expect(errorScreen).toBe(false);
  });
});

test.describe('the presence channel list', () => {
  test('a channel row joins on click and on Enter', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      window.__joined = [];
      window.joinChannel = (item) => { window.__joined.push(item.channel.name); return Promise.resolve(); };
      presenceData = [{ channel: { id: 1, name: 'General' }, peer_count: 1, connected: [] }];
      renderPresenceChannels();
      const row = document.querySelector('#channels-list .channel-item');
      row.click();
      await new Promise((r) => setTimeout(r, 20));
      endHomeAction();
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 20));
      endHomeAction();
      return window.__joined;
    });
    expect(seen).toEqual(['General', 'General']);
  });

  test('a failed join is reported', async ({ page }) => {
    await page.evaluate(async () => {
      window.joinChannel = () => Promise.reject(new Error('channel is unreachable'));
      presenceData = [{ channel: { id: 1, name: 'General' }, peer_count: 0, connected: [] }];
      renderPresenceChannels();
      document.querySelector('#channels-list .channel-item').click();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(await page.locator('#error-message').textContent()).toBe('channel is unreachable');
  });

  test('a cancelled join is not an error', async ({ page }) => {
    const errorScreen = await page.evaluate(async () => {
      window.joinChannel = () => Promise.reject(new Error('Connection cancelled.'));
      presenceData = [{ channel: { id: 1, name: 'General' }, peer_count: 0, connected: [] }];
      renderPresenceChannels();
      document.querySelector('#channels-list .channel-item').click();
      await new Promise((r) => setTimeout(r, 30));
      endHomeAction();
      return document.getElementById('screen-error').classList.contains('active');
    });
    expect(errorScreen).toBe(false);
  });
});

test.describe('the microphone-denied recovery screen', () => {
  test('offers a retry that re-runs what failed', async ({ page }) => {
    const seen = await page.evaluate(() => {
      let retried = 0;
      showMicDeniedError(() => { retried++; });
      const hintVisible = !document.getElementById('error-recovery-hint').classList.contains('hidden');
      const retryVisible = !document.getElementById('btn-retry-mic').classList.contains('hidden');
      document.getElementById('btn-retry-mic').click();
      return { hintVisible, retryVisible, retried };
    });
    expect(seen.hintVisible).toBe(true);
    expect(seen.retryVisible).toBe(true);
    expect(seen.retried).toBe(1);
  });

  test('a plain error hides the recovery affordances again', async ({ page }) => {
    const seen = await page.evaluate(() => {
      showMicDeniedError(() => {});
      showError('something else went wrong');
      return {
        message: document.getElementById('error-message').textContent,
        hintHidden: document.getElementById('error-recovery-hint').classList.contains('hidden'),
        retryHidden: document.getElementById('btn-retry-mic').classList.contains('hidden'),
      };
    });
    expect(seen).toEqual({
      message: 'something else went wrong', hintHidden: true, retryHidden: true,
    });
  });

  test('isMicDeniedError recognises the shapes browsers actually raise', async ({ page }) => {
    expect(await callFn(page, 'isMicDeniedError', { name: 'NotAllowedError' })).toBe(true);
    expect(await callFn(page, 'isMicDeniedError', { name: 'PermissionDeniedError' })).toBe(true);
    expect(await callFn(page, 'isMicDeniedError', { name: 'NotFoundError' })).toBe(false);
    expect(await callFn(page, 'isMicDeniedError', null)).toBe(false);
  });
});
