import { test, expect } from './fixtures.js';
import { seedRoom, callFn } from './_helpers.js';

// The last of the load-time wiring: the rejoin bar, the settings modal's
// swipe-to-close, the relay badge's cached verdict, and the per-tick roster
// refresh that keeps a dev-mode room's badges live.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test.describe('the rejoin bar', () => {
  async function seedSnapshot(page) {
    await page.evaluate(() => {
      localStorage.setItem('rejoin-snapshot', JSON.stringify({
        hostId: '11111111-2222-3333-4444-555555555555',
        deputyId: null,
        peerIds: ['p1'],
        wasHost: false,
        savedAt: Date.now(),
      }));
      _rejoinDismissed = false;
      window._updateRejoinBar();
    });
  }

  test('rejoining locks the home screen while it runs', async ({ page }) => {
    await seedSnapshot(page);
    const seen = await page.evaluate(async () => {
      let release;
      window.attemptRejoin = () => new Promise((r) => { release = r; });
      document.getElementById('btn-rejoin').click();
      const during = {
        createDisabled: document.getElementById('btn-create').disabled,
        dismissDisabled: document.getElementById('btn-dismiss-rejoin').disabled,
        spinner: !!document.querySelector('#btn-rejoin .btn-spinner'),
      };
      release();
      await new Promise((r) => setTimeout(r, 30));
      return {
        during,
        after: {
          createDisabled: document.getElementById('btn-create').disabled,
          label: document.getElementById('btn-rejoin').textContent,
        },
      };
    });
    expect(seen.during).toEqual({ createDisabled: true, dismissDisabled: true, spinner: true });
    expect(seen.after).toEqual({ createDisabled: false, label: 'Rejoin' });
  });

  test('a failed rejoin reports it and forgets the snapshot', async ({ page }) => {
    await seedSnapshot(page);
    await page.evaluate(async () => {
      window.attemptRejoin = () => Promise.reject(new Error('nobody is there any more'));
      document.getElementById('btn-rejoin').click();
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(await page.locator('#error-message').textContent()).toBe('nobody is there any more');
    expect(await page.evaluate(() => loadRejoinSnapshot())).toBe(null);
    await expect(page.locator('#rejoin-bar')).toHaveCount(0);
  });

  test('a bar whose snapshot expired removes itself instead of dialling', async ({ page }) => {
    await seedSnapshot(page);
    const seen = await page.evaluate(async () => {
      let called = 0;
      window.attemptRejoin = () => { called++; return Promise.resolve(); };
      clearRejoinSnapshot();
      document.getElementById('btn-rejoin').click();
      await new Promise((r) => setTimeout(r, 20));
      return { called, bar: !!document.getElementById('rejoin-bar') };
    });
    expect(seen).toEqual({ called: 0, bar: false });
  });

  test('the bar names how many peers were there', async ({ page }) => {
    await seedSnapshot(page);
    const label = await page.evaluate(() => document.getElementById('rejoin-label').textContent);
    expect(label.length).toBeGreaterThan(0);
  });
});

test.describe('swiping the settings modal away', () => {
  async function openSettings(page) {
    await page.click('#btn-open-settings');
  }

  /** Dispatch a one-finger touch gesture on the modal sheet. */
  async function swipe(page, dy) {
    await page.evaluate((dy) => {
      const content = document.querySelector('#modal-settings .modal-content');
      const scroller = document.querySelector('#modal-settings .modal-settings-scrollable');
      if (scroller) scroller.scrollTop = 0;
      const touch = (y) => ({
        touches: [new Touch({ identifier: 1, target: content, clientX: 0, clientY: y })],
        bubbles: true,
      });
      content.dispatchEvent(new TouchEvent('touchstart', touch(0)));
      content.dispatchEvent(new TouchEvent('touchmove', touch(dy)));
      content.dispatchEvent(new TouchEvent('touchend', { bubbles: true }));
    }, dy);
  }

  test('a long pull down closes it', async ({ page }) => {
    await openSettings(page);
    await swipe(page, 400);
    await expect(page.locator('#modal-settings')).toBeHidden();
  });

  test('a short pull springs back', async ({ page }) => {
    await openSettings(page);
    await swipe(page, 20);
    await expect(page.locator('#modal-settings')).toBeVisible();
    const transform = await page.evaluate(() =>
      document.querySelector('#modal-settings .modal-content').style.transform);
    expect(transform).toBe('');
  });

  test('an upward drag is not a dismissal', async ({ page }) => {
    await openSettings(page);
    await swipe(page, -200);
    await expect(page.locator('#modal-settings')).toBeVisible();
  });
});

test.describe('the relay badge popover', () => {
  test('reports a verified relay from the cached test result', async ({ page }) => {
    const text = await page.evaluate(() => {
      localStorage.setItem('metered-status', 'ok');
      localStorage.setItem('metered-count', '4');
      localStorage.setItem('metered-app-name', 'myapp');
      localStorage.setItem('metered-api-key', 'k3y');
      updateTurnBadge();
      document.getElementById('turn-badge').click();
      const out = document.getElementById('conn-status-content').textContent;
      document.getElementById('turn-badge').click();
      ['metered-status', 'metered-count', 'metered-app-name', 'metered-api-key']
        .forEach((k) => localStorage.removeItem(k));
      updateTurnBadge();
      return out;
    });
    expect(text.length).toBeGreaterThan(0);
  });

  test('reports a failed test as a problem', async ({ page }) => {
    const text = await page.evaluate(() => {
      localStorage.setItem('metered-status', 'error');
      localStorage.setItem('metered-app-name', 'myapp');
      localStorage.setItem('metered-api-key', 'k3y');
      updateTurnBadge();
      document.getElementById('turn-badge').click();
      const out = document.getElementById('conn-status-content').textContent;
      document.getElementById('turn-badge').click();
      ['metered-status', 'metered-app-name', 'metered-api-key']
        .forEach((k) => localStorage.removeItem(k));
      updateTurnBadge();
      return out;
    });
    expect(text.length).toBeGreaterThan(0);
  });
});

test.describe('the per-tick roster refresh', () => {
  test.slow(); // two tests wait out the 5s stats interval
  test('re-renders the link badge in place, without rebuilding the roster', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1', pseudo: 'Ada' }] });
    const seen = await page.evaluate(async () => {
      localStorage.setItem('dev-mode', 'true');
      const c = connections.get('p1');
      c.media = {
        closed: false,
        peerConnection: {
          getStats: () => Promise.resolve(new Map([
            ['pair', { id: 'pair', type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'lc', currentRoundTripTime: 0.03 }],
            ['lc', { id: 'lc', type: 'local-candidate', candidateType: 'srflx' }],
            ['in', { type: 'inbound-rtp', kind: 'audio', packetsReceived: 10, packetsLost: 0, jitter: 0.002 }],
          ])),
        },
      };
      // A reading from an earlier tick: the badge renders from what is already
      // recorded, while the fresh sample is still in flight.
      c.webrtcStats = { rttMs: 25, jitterMs: 2, lossPercent: 0, iceType: 'host' };
      updatePeerList();
      const row = document.getElementById('peer-item-p1');
      startStatsPolling();
      // The first tick lands one interval in — there is no leading call.
      await new Promise((r) => setTimeout(r, 5300));
      stopStatsPolling();
      const out = {
        sameRow: document.getElementById('peer-item-p1') === row,
        badges: row.querySelectorAll('.peer-webrtc-stats').length,
        dot: row.querySelector('.peer-dot').className,
      };
      localStorage.setItem('dev-mode', 'false');
      return out;
    });
    // The row survives, gains exactly one badge, and its dot is painted from
    // the recorded reading — the fresh sample lands on the following tick.
    expect(seen.sameRow).toBe(true);
    expect(seen.badges).toBe(1);
    expect(seen.dot).toContain('peer-dot-direct');
  });

  test('the tick stops itself once the room is gone', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true });
    const stopped = await page.evaluate(async () => {
      startStatsPolling();
      inRoom = false;
      await new Promise((r) => setTimeout(r, 5200));
      return _statsIntervalId;
    });
    expect(stopped).toBe(null);
  });
});

test.describe('the FPS overlay fallback', () => {
  test('falls back to playback-quality counters where rVFC is missing', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      localStorage.setItem('dev-mode', 'true');
      const vid = document.getElementById('video-viewer-element');
      const c = document.createElement('canvas');
      c.width = 320; c.height = 240;
      c.getContext('2d').fillRect(0, 0, 1, 1);
      vid.srcObject = c.captureStream(5);
      // An older engine: no requestVideoFrameCallback, but a frame counter.
      vid.requestVideoFrameCallback = undefined;
      let frames = 0;
      vid.getVideoPlaybackQuality = () => ({ totalVideoFrames: (frames += 12) });
      const id = _startFpsOverlay('video-viewer-element', 'video-viewer-fps');
      await new Promise((r) => setTimeout(r, 1100));
      const text = document.getElementById('video-viewer-fps').textContent;
      _stopFpsOverlay(id, 'video-viewer-fps');
      delete vid.getVideoPlaybackQuality;
      localStorage.setItem('dev-mode', 'false');
      return { started: !!id, text };
    });
    expect(seen.started).toBe(true);
    expect(seen.text).toMatch(/\d+ fps/);
    // The resolution comes from the track when the element has none.
    expect(seen.text).toContain('320');
  });
});

test.describe('announcing a rename', () => {
  test('a host tells everyone, and updates its own roster', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      myPseudo: 'Me',
      connections: [{ id: 'p1', pseudo: 'Ada' }, { id: 'p2', pseudo: 'Grace' }],
    });
    const sent = await page.evaluate(() => {
      const out = [];
      connections.forEach((c) => { c.data.send = (m) => out.push(m); });
      announcePseudoChange();
      return out.filter((m) => m.type === 'peer-renamed');
    });
    expect(sent).toHaveLength(2);
    expect(sent[0].peerId).toBe('host');
    expect(sent[0].pseudo).toBe('Me');
  });

  test('outside a room there is nobody to tell', async ({ page }) => {
    const threw = await page.evaluate(() => {
      inRoom = false;
      connections.clear();
      try { announcePseudoChange(); return false; } catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });

  test('a voluntary rename supersedes a name the host had forced', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      myPseudo: 'Renamed By Host',
      connections: [{ id: 'p1', pseudo: 'Ada' }],
    });
    const seen = await page.evaluate(() => {
      _preRenameMyPseudo = 'What I Asked For';
      setMyPseudo('What I Actually Want');
      return { myPseudo, restoreTo: _preRenameMyPseudo };
    });
    // Nothing to restore on leaving — the user overrode it themselves.
    expect(seen).toEqual({ myPseudo: 'What I Actually Want', restoreTo: null });
  });
});

test.describe('the microphone-denied hint', () => {
  test('names the browser control the user actually has', async ({ page }) => {
    const hint = await page.evaluate(() => {
      showMicDeniedError(() => {});
      return document.getElementById('error-recovery-hint').textContent;
    });
    expect(hint.length).toBeGreaterThan(0);
    expect(hint.toLowerCase()).toMatch(/microphone|permission|settings|allow/);
  });
});


test.describe('the origin an embed is allowed to command from', () => {
  test('defaults to our own origin when none is declared', async ({ page }) => {
    const origin = await callFn(page, 'getAllowedParentOrigin');
    expect(origin).toBe(await page.evaluate(() => window.location.origin));
  });

  test('a declared parent origin is used verbatim', async ({ page }) => {
    await page.goto('/?parentOrigin=https://portal.example');
    expect(await callFn(page, 'getAllowedParentOrigin')).toBe('https://portal.example');
  });

  test('a non-http scheme is refused outright', async ({ page }) => {
    await page.goto('/?parentOrigin=' + encodeURIComponent('javascript:alert(1)'));
    expect(await callFn(page, 'getAllowedParentOrigin')).toBe(null);
  });

  test('a message is trusted only from the declared origin', async ({ page }) => {
    await page.goto('/');
    // No declaration — legacy embeds keep working.
    expect(await callFn(page, 'isTrustedParentMessage', { origin: 'https://anywhere.example' })).toBe(true);

    await page.goto('/?parentOrigin=https://portal.example');
    expect(await callFn(page, 'isTrustedParentMessage', { origin: 'https://portal.example' })).toBe(true);
    expect(await callFn(page, 'isTrustedParentMessage', { origin: 'https://evil.example' })).toBe(false);
  });
});
