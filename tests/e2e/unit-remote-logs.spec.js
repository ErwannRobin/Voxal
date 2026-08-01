import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// Remote debug logs (dev mode): a viewer asks a peer for its live log stream,
// the peer's own device must authorize it, and only then does anything flow.
// All of it lives on window globals in the flat main.js script, so the real
// implementation is driven in-browser.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    try {
      localStorage.removeItem('dev-mode');
      localStorage.removeItem('debug-share-device-info');
    } catch (_) {}
  });
});

// Capture everything a peer sends on its host connection.
async function captureHostSends(page) {
  await page.evaluate(() => {
    window.__sent = [];
    connections.get(roomCode).data.send = function(m) { window.__sent.push(m); };
  });
}

test.describe('authorization is required before anything is captured', () => {
  test('a request only raises the prompt — it sends nothing and starts no capture', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'me', isHost: false, hostId: 'host', roomCode: 'host',
      connections: [{ id: 'host', pseudo: 'Host' }],
    });
    await captureHostSends(page);

    const state = await page.evaluate(() => {
      handleLogSessionRequest('host', 'Alice');
      return { sent: window.__sent, sharing: logSharingActive(), prompted: !!_logSharePrompt };
    });
    expect(state.sent).toEqual([]);       // nothing leaves the device
    expect(state.sharing).toBe(false);    // and nothing is being captured
    expect(state.prompted).toBe(true);

    // The prompt names who is asking.
    await expect(page.locator('#log-consent-prompt')).toBeVisible();
    await expect(page.locator('#log-consent-prompt')).toContainText('Alice');
  });

  test('Deny answers the viewer and leaves the console untouched', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'me', isHost: false, hostId: 'host', roomCode: 'host',
      connections: [{ id: 'host', pseudo: 'Host' }],
    });
    await captureHostSends(page);

    const r = await page.evaluate(() => {
      const originalWarn = console.warn;
      handleLogSessionRequest('host', 'Alice');
      declineLogSessionRequest();
      return { sent: window.__sent, sharing: logSharingActive(), consoleIntact: console.warn === originalWarn };
    });
    expect(r.sent.length).toBe(1);
    expect(r.sent[0].type).toBe('log-session-response');
    expect(r.sent[0].granted).toBe(false);
    expect(r.sent[0].reason).toBe('declined');
    expect(r.sharing).toBe(false);
    expect(r.consoleIntact).toBe(true);
    await expect(page.locator('#log-consent-prompt')).toBeHidden();
  });

  test('a device that refused diagnostics outright is declined without a prompt', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'me', isHost: false, hostId: 'host', roomCode: 'host',
      connections: [{ id: 'host', pseudo: 'Host' }],
    });
    await captureHostSends(page);

    const r = await page.evaluate(() => {
      setDeviceInfoConsent('declined');
      handleLogSessionRequest('host', 'Alice');
      return { sent: window.__sent, prompted: !!_logSharePrompt };
    });
    expect(r.prompted).toBe(false);
    expect(r.sent.length).toBe(1);
    expect(r.sent[0].granted).toBe(false);
    await expect(page.locator('#log-consent-prompt')).toBeHidden();
  });

  test('a refusal cannot be re-asked straight away', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'me', isHost: false, hostId: 'host', roomCode: 'host',
      connections: [{ id: 'host', pseudo: 'Host' }],
    });
    await captureHostSends(page);

    const r = await page.evaluate(() => {
      handleLogSessionRequest('host', 'Alice');
      declineLogSessionRequest();
      window.__sent.length = 0;
      handleLogSessionRequest('host', 'Alice'); // immediately asks again
      return { sent: window.__sent, prompted: !!_logSharePrompt };
    });
    expect(r.prompted).toBe(false);
    expect(r.sent.length).toBe(1);
    expect(r.sent[0].granted).toBe(false);
    await expect(page.locator('#log-consent-prompt')).toBeHidden();
  });

  test('a pending prompt is not swapped out by another requester', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'me', isHost: false, hostId: 'host', roomCode: 'host',
      connections: [{ id: 'host', pseudo: 'Host' }],
    });
    await captureHostSends(page);

    const r = await page.evaluate(() => {
      handleLogSessionRequest('host', 'Alice');
      window.__sent.length = 0;
      handleLogSessionRequest('peer-b', 'Bob');
      const who = _logSharePrompt.pseudo;
      dismissLogConsentPrompt();
      return { who, sent: window.__sent };
    });
    expect(r.who).toBe('Alice');
    expect(r.sent.some((m) => m.reason === 'busy')).toBe(true);
  });

  test('a second viewer is refused while one session is running', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'me', isHost: false, hostId: 'host', roomCode: 'host',
      connections: [{ id: 'host', pseudo: 'Host' }],
    });
    await captureHostSends(page);

    const r = await page.evaluate(() => {
      handleLogSessionRequest('host', 'Alice');
      acceptLogSessionRequest();
      window.__sent.length = 0;
      handleLogSessionRequest('peer-b', 'Bob');
      const sent = window.__sent.slice();
      stopLogSharing('stopped');
      return { sent, prompted: !!_logSharePrompt };
    });
    expect(r.prompted).toBe(false);
    expect(r.sent.some((m) => m.type === 'log-session-response' && m.granted === false && m.reason === 'busy')).toBe(true);
  });
});

test.describe('an allowed session streams, then stops cleanly', () => {
  test('Allow sends a grant plus the buffered backfill, and captures new console output', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'me', isHost: false, hostId: 'host', roomCode: 'host',
      connections: [{ id: 'host', pseudo: 'Host' }],
    });
    await captureHostSends(page);

    const r = await page.evaluate(() => {
      const originalWarn = console.warn;
      devLog('something happened earlier');       // lands in the ring buffer
      handleLogSessionRequest('host', 'Alice');
      acceptLogSessionRequest();

      const grant = window.__sent[0];
      const backfill = window.__sent.filter((m) => m.type === 'log-entries')
        .reduce((acc, m) => acc.concat(m.entries), []);

      window.__sent.length = 0;
      console.warn('live line after consent');
      flushLogShareQueue();
      const live = window.__sent.filter((m) => m.type === 'log-entries')
        .reduce((acc, m) => acc.concat(m.entries), []);

      const hooked = console.warn !== originalWarn;
      window.__sent.length = 0;
      stopLogSharing('stopped');
      return {
        grant, backfill, live, hooked,
        restored: console.warn === originalWarn,
        endMsg: window.__sent.find((m) => m.type === 'log-session-end'),
        sharing: logSharingActive(),
      };
    });

    expect(r.grant.type).toBe('log-session-response');
    expect(r.grant.granted).toBe(true);
    // Backfill leads with the context line and carries the pre-existing buffer.
    expect(r.backfill[0].msg).toContain('remote log started');
    expect(r.backfill.some((e) => e.msg.includes('something happened earlier'))).toBe(true);
    // New output is captured while the session runs…
    expect(r.hooked).toBe(true);
    expect(r.live.some((e) => e.msg.includes('live line after consent') && e.lvl === 'warn')).toBe(true);
    // …and the console is handed back untouched when it ends.
    expect(r.restored).toBe(true);
    expect(r.sharing).toBe(false);
    expect(r.endMsg).toBeTruthy();
    expect(r.endMsg.reason).toBe('stopped');
  });

  test('the sharing device shows a banner it can stop from', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'me', isHost: false, hostId: 'host', roomCode: 'host',
      connections: [{ id: 'host', pseudo: 'Alice' }],
    });
    await page.evaluate(() => { handleLogSessionRequest('host', 'Alice'); });
    await page.locator('#btn-log-consent-allow').click();

    const indicator = page.locator('#log-share-indicator');
    await expect(indicator).toBeVisible();
    await expect(indicator).toContainText('Alice');

    await page.locator('#btn-log-share-stop').click();
    await expect(indicator).toBeHidden();
    expect(await page.evaluate(() => logSharingActive())).toBe(false);
  });

  test('a stop from the viewer ends the session on the sharing device', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'me', isHost: false, hostId: 'host', roomCode: 'host',
      connections: [{ id: 'host', pseudo: 'Host' }],
    });
    const sharing = await page.evaluate(() => {
      handleLogSessionRequest('host', 'Alice');
      acceptLogSessionRequest();
      const before = logSharingActive();
      handleHostMessage({ type: 'log-session-stop' });
      return { before, after: logSharingActive() };
    });
    expect(sharing.before).toBe(true);
    expect(sharing.after).toBe(false);
  });
});

test.describe('viewer session state', () => {
  test('request → granted → entries → end', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host', isHost: true, roomCode: 'host',
      connections: [{ id: 'peer-a', pseudo: 'Alice' }],
    });
    const r = await page.evaluate(() => {
      const sent = [];
      connections.get('peer-a').data.send = function(m) { sent.push(m); };

      requestRemoteLogs('peer-a');
      const requesting = remoteLogSession('peer-a').state;

      onRemoteLogResponse('peer-a', true);
      const active = remoteLogSession('peer-a').state;

      onRemoteLogEntries('peer-a', [{ t: '10:00:00.000', msg: 'hello from the peer', lvl: 'warn' }]);
      const entries = remoteLogSession('peer-a').entries.slice();

      onRemoteLogEnd('peer-a', 'expired');
      const ended = remoteLogSession('peer-a');
      return { sent, requesting, active, entries, endedState: ended.state, note: ended.note };
    });
    expect(r.sent[0].type).toBe('log-session-request');
    expect(r.requesting).toBe('requesting');
    expect(r.active).toBe('active');
    expect(r.entries.length).toBe(1);
    expect(r.entries[0].msg).toBe('hello from the peer');
    expect(r.entries[0].lvl).toBe('warn');
    expect(r.endedState).toBe('ended');
    expect(r.note).toContain('expired');
  });

  test('a declined request is reported, not retried', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host', isHost: true, roomCode: 'host',
      connections: [{ id: 'peer-a', pseudo: 'Alice' }],
    });
    const r = await page.evaluate(() => {
      requestRemoteLogs('peer-a');
      onRemoteLogResponse('peer-a', false, 'declined');
      const s = remoteLogSession('peer-a');
      return { state: s.state, note: s.note };
    });
    expect(r.state).toBe('denied');
    expect(r.note).toContain('declined');
  });

  test('unsolicited log entries are dropped', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host', isHost: true, roomCode: 'host',
      connections: [{ id: 'peer-a', pseudo: 'Alice' }],
    });
    const r = await page.evaluate(() => {
      // No session at all…
      onRemoteLogEntries('peer-a', [{ t: '10:00:00.000', msg: 'push', lvl: 'info' }]);
      const none = remoteLogSession('peer-a');
      // …and none for a session that already ended.
      requestRemoteLogs('peer-a');
      onRemoteLogResponse('peer-a', true);
      onRemoteLogEnd('peer-a', 'stopped');
      onRemoteLogEntries('peer-a', [{ t: '10:00:00.000', msg: 'push', lvl: 'info' }]);
      return { none, afterEnd: remoteLogSession('peer-a').entries.length };
    });
    expect(r.none).toBeNull();
    expect(r.afterEnd).toBe(0);
  });

  test('peer-supplied entries are bounded and normalized', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host', isHost: true, roomCode: 'host',
      connections: [{ id: 'peer-a', pseudo: 'Alice' }],
    });
    const r = await page.evaluate(() => {
      requestRemoteLogs('peer-a');
      onRemoteLogResponse('peer-a', true);
      onRemoteLogEntries('peer-a', [
        { t: 'x'.repeat(50), msg: 'y'.repeat(5000), lvl: 'catastrophic' },
        null,
        'not an entry',
      ]);
      const e = remoteLogSession('peer-a').entries;
      return { count: e.length, t: e[0].t.length, msgLen: e[0].msg.length, lvl: e[0].lvl };
    });
    expect(r.count).toBe(1);          // junk shapes dropped
    expect(r.t).toBeLessThanOrEqual(16);
    expect(r.msgLen).toBeLessThanOrEqual(401); // REMOTE_LOG_MSG_MAX + ellipsis
    expect(r.lvl).toBe('info');       // unknown level normalized
  });

  test('a peer disappearing ends the session both ways', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host', isHost: true, roomCode: 'host',
      connections: [{ id: 'peer-a', pseudo: 'Alice' }],
    });
    const r = await page.evaluate(() => {
      requestRemoteLogs('peer-a');
      onRemoteLogResponse('peer-a', true);
      // We are also sharing our own log with that same peer.
      handleLogSessionRequest('peer-a', 'Alice');
      acceptLogSessionRequest();
      removePeer('peer-a');
      return { viewer: remoteLogSession('peer-a').state, sharing: logSharingActive() };
    });
    expect(r.viewer).toBe('ended');
    expect(r.sharing).toBe(false);
  });
});

test.describe('host relay', () => {
  test('relays a request toward the target and a reply back to the requester', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host', isHost: true, roomCode: 'host',
      connections: [{ id: 'viewer', pseudo: 'Vic' }, { id: 'target', pseudo: 'Tam' }],
    });
    const r = await page.evaluate(() => {
      const toTarget = [], toViewer = [];
      connections.get('target').data.send = function(m) { toTarget.push(m); };
      connections.get('viewer').data.send = function(m) { toViewer.push(m); };

      // Viewer -> host -> target
      handleLogControlAtHost('viewer', 'target', 'log-session-request', 'spoofed');
      // Target -> host -> viewer (the host is not the requester, so it relays)
      handleLogReplyAtHost('target', {
        type: 'log-entries', peerId: 'target', from: 'viewer',
        entries: [{ t: '10:00:00.000', msg: 'line', lvl: 'info' }],
      });
      return { toTarget, toViewer };
    });
    expect(r.toTarget.length).toBe(1);
    expect(r.toTarget[0].type).toBe('log-session-request');
    expect(r.toTarget[0].from).toBe('viewer');
    // The roster name wins over whatever the requester claimed.
    expect(r.toTarget[0].fromPseudo).toBe('Vic');
    expect(r.toViewer.length).toBe(1);
    expect(r.toViewer[0].type).toBe('log-entries');
    expect(r.toViewer[0].peerId).toBe('target');
  });

  test('malformed log messages never throw out of the handler', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'me', isHost: false, hostId: 'host', roomCode: 'host',
      connections: [{ id: 'host', pseudo: 'Host' }],
    });
    const errs = await page.evaluate(() => {
      const caught = [];
      for (const m of [
        { type: 'log-session-request' },
        { type: 'log-session-stop' },
        { type: 'log-session-response' },
        { type: 'log-session-end' },
        { type: 'log-entries' },
        { type: 'log-entries', peerId: 'nobody', entries: 'not-an-array' },
      ]) {
        try { safeHandleHostMessage(m); } catch (e) { caught.push(e.message); }
      }
      dismissLogConsentPrompt();
      return caught;
    });
    expect(errs).toEqual([]);
  });
});

test.describe('device-info popover integration', () => {
  test('the log section is offered for a remote peer and requests on click', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host', isHost: true, roomCode: 'host',
      connections: [{ id: 'peer-a', pseudo: 'Alice' }],
    });
    await page.evaluate(() => {
      localStorage.setItem('dev-mode', 'true');
      showScreen('room');
      updatePeerList();
    });
    await page.locator('#peer-item-peer-a .peer-info-btn').click();
    const pop = page.locator('#device-info-popover');
    await expect(pop).toContainText('Debug logs');
    await expect(pop).toContainText('They must allow it on their device');

    await pop.getByRole('button', { name: 'Request debug logs' }).click();
    await expect(pop).toContainText('Waiting for them to allow it');
    expect(await page.evaluate(() => remoteLogSession('peer-a').state)).toBe('requesting');
  });

  test('an active session opens a log panel that outlives the popover', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host', isHost: true, roomCode: 'host',
      connections: [{ id: 'peer-a', pseudo: 'Alice' }],
    });
    await page.evaluate(() => {
      localStorage.setItem('dev-mode', 'true');
      showScreen('room');
      updatePeerList();
      requestRemoteLogs('peer-a');
      onRemoteLogResponse('peer-a', true);
      onRemoteLogEntries('peer-a', [{ t: '10:00:00.000', msg: 'remote line one', lvl: 'info' }]);
      showRemoteLogPanel('peer-a');
    });
    const panel = page.locator('#remote-log-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Alice');
    await expect(panel).toContainText('remote line one');
    await expect(page.locator('#remote-log-status')).toContainText('live');

    // Live entries land in the open panel, and rebuilding the roster (which
    // closes the popover) leaves the panel alone.
    await page.evaluate(() => {
      onRemoteLogEntries('peer-a', [{ t: '10:00:01.000', msg: 'remote line two', lvl: 'error' }]);
      updatePeerList();
    });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('remote line two');

    await page.locator('#btn-close-remote-log').click();
    await expect(panel).toBeHidden();
  });

  test('leaving the room clears every session and panel', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host', isHost: true, roomCode: 'host',
      connections: [{ id: 'peer-a', pseudo: 'Alice' }],
    });
    const cleared = await page.evaluate(() => {
      requestRemoteLogs('peer-a');
      onRemoteLogResponse('peer-a', true);
      showRemoteLogPanel('peer-a');
      resetRemoteLogState();
      return {
        session: remoteLogSession('peer-a'),
        panelHidden: document.getElementById('remote-log-panel').classList.contains('hidden'),
        sharing: logSharingActive(),
      };
    });
    expect(cleared.session).toBeNull();
    expect(cleared.panelHidden).toBe(true);
    expect(cleared.sharing).toBe(false);
  });
});
