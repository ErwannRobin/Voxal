import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// A live remote-log session, from both ends: the device that agrees to stream
// its console, and the viewer watching it. Peer-supplied text is untrusted at
// every step — bounded on the way out and again on the way in, and rendered
// with textContent so it can never be markup.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test.describe('the device that shares its log', () => {
  test.beforeEach(async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      myPseudo: 'Me',
      connections: [{ id: 'viewer', pseudo: 'Nosy' }],
    });
    await page.evaluate(() => {
      setDeviceInfoConsent('accepted');
      _logSharePrompt = null;
      _logDeclineCooldown.clear();
      if (typeof stopLogSharing === 'function') stopLogSharing('reset');
    });
  });

  test('accepting grants the session and back-fills what already happened', async ({ page }) => {
    const sent = await page.evaluate(() => {
      devLog('something interesting happened earlier');
      const out = [];
      connections.get('viewer').data.send = (m) => out.push(m);
      handleLogSessionRequest('viewer', 'Nosy');
      acceptLogSessionRequest();
      const result = { out, sharing: logSharingActive() };
      stopLogSharing('stopped');
      return result;
    });
    const granted = sent.out.find((m) => m.type === 'log-session-response');
    expect(granted).toMatchObject({ granted: true });
    expect(granted.expiresInMs).toBeGreaterThan(0);
    expect(sent.sharing).toBe(true);
    // The backfill leads with what the log is from — build and role.
    const entries = sent.out.filter((m) => m.type === 'log-entries');
    expect(entries.length).toBeGreaterThan(0);
    const all = entries.flatMap((m) => m.entries);
    expect(all[0].msg).toContain('remote log started');
    expect(all.some((e) => e.msg.includes('something interesting happened earlier'))).toBe(true);
  });

  test('console output is captured and flushed to the viewer', async ({ page }) => {
    const sent = await page.evaluate(async () => {
      const out = [];
      connections.get('viewer').data.send = (m) => out.push(m);
      handleLogSessionRequest('viewer', 'Nosy');
      acceptLogSessionRequest();
      out.length = 0;
      console.log('a captured line', { detail: 1 });
      console.warn('a warning');
      flushLogShareQueue();
      const result = out.filter((m) => m.type === 'log-entries').flatMap((m) => m.entries);
      stopLogSharing('stopped');
      return result;
    });
    expect(sent.some((e) => e.msg.includes('a captured line'))).toBe(true);
    expect(sent.some((e) => e.lvl === 'warn' && e.msg.includes('a warning'))).toBe(true);
  });

  test('a very long line is truncated before it leaves the device', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const long = 'x'.repeat(5000);
      const truncated = truncateLogMessage(long);
      return { len: truncated.length, max: REMOTE_LOG_MSG_MAX, tail: truncated.slice(-1) };
    });
    expect(seen.len).toBe(seen.max + 1);
    expect(seen.tail).toBe('…');
  });

  test('stopping tells the viewer why, and drains what is left', async ({ page }) => {
    const sent = await page.evaluate(() => {
      const out = [];
      connections.get('viewer').data.send = (m) => out.push(m);
      handleLogSessionRequest('viewer', 'Nosy');
      acceptLogSessionRequest();
      console.log('one last line');
      out.length = 0;
      stopLogSharing('stopped-by-viewer');
      return { out, sharing: logSharingActive() };
    });
    expect(sent.sharing).toBe(false);
    const end = sent.out.find((m) => m.type === 'log-session-end');
    expect(end).toMatchObject({ reason: 'stopped-by-viewer' });
    const drained = sent.out.filter((m) => m.type === 'log-entries').flatMap((m) => m.entries);
    expect(drained.some((e) => e.msg.includes('one last line'))).toBe(true);
  });

  test('a peer that vanished is not sent a goodbye it cannot receive', async ({ page }) => {
    const sent = await page.evaluate(() => {
      const out = [];
      connections.get('viewer').data.send = (m) => out.push(m);
      handleLogSessionRequest('viewer', 'Nosy');
      acceptLogSessionRequest();
      out.length = 0;
      stopLogSharing('peer-gone');
      return out;
    });
    expect(sent).toEqual([]);
  });

  test('a viewer leaving ends the session it was watching', async ({ page }) => {
    const sharing = await page.evaluate(() => {
      handleLogSessionRequest('viewer', 'Nosy');
      acceptLogSessionRequest();
      noteLogPeerGone('viewer');
      return logSharingActive();
    });
    expect(sharing).toBe(false);
  });

  test('a second viewer is refused while one is already streaming', async ({ page }) => {
    const sent = await page.evaluate(() => {
      handleLogSessionRequest('viewer', 'Nosy');
      acceptLogSessionRequest();
      connections.set('other', { data: { open: true, closed: false, send() {}, close() {} } });
      const out = [];
      connections.get('other').data.send = (m) => out.push(m);
      handleLogSessionRequest('other', 'Second');
      const result = out;
      stopLogSharing('stopped');
      return result;
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'log-session-response', granted: false, reason: 'busy' });
  });

  test('the same viewer asking again is a no-op, not a refusal', async ({ page }) => {
    const sent = await page.evaluate(() => {
      handleLogSessionRequest('viewer', 'Nosy');
      acceptLogSessionRequest();
      const out = [];
      connections.get('viewer').data.send = (m) => out.push(m);
      handleLogSessionRequest('viewer', 'Nosy');
      const result = out.filter((m) => m.type === 'log-session-response');
      stopLogSharing('stopped');
      return result;
    });
    expect(sent).toEqual([]);
  });

  test('the sharing indicator names who is watching', async ({ page }) => {
    const seen = await page.evaluate(() => {
      handleLogSessionRequest('viewer', 'Nosy');
      acceptLogSessionRequest();
      const on = {
        hidden: document.getElementById('log-share-indicator').classList.contains('hidden'),
        who: document.getElementById('log-share-with').textContent,
      };
      stopLogSharing('stopped');
      return { on, offHidden: document.getElementById('log-share-indicator').classList.contains('hidden') };
    });
    expect(seen.on).toEqual({ hidden: false, who: 'Nosy' });
    expect(seen.offHidden).toBe(true);
  });

  test('a viewer name is bounded and never rendered as markup', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const long = sanitizeLogPseudo('  ' + 'n'.repeat(200) + '  ');
      return {
        length: long.length,
        blank: sanitizeLogPseudo('   '),
        notAString: sanitizeLogPseudo(42),
      };
    });
    expect(seen.length).toBe(40);
    expect(seen.blank).toBe(null);
    expect(seen.notAString).toBe(null);
  });

  test('the consent prompt shows the requester, escaped', async ({ page }) => {
    const seen = await page.evaluate(() => {
      handleLogSessionRequest('viewer', '<img src=x>');
      const el = document.getElementById('log-consent-prompt');
      const out = {
        hidden: el.classList.contains('hidden'),
        text: document.getElementById('log-consent-who').textContent,
        html: document.getElementById('log-consent-who').innerHTML,
      };
      dismissLogConsentPrompt();
      _logDeclineCooldown.clear();
      return out;
    });
    expect(seen.hidden).toBe(false);
    expect(seen.text).toBe('<img src=x>');
    expect(seen.html).not.toContain('<img');
  });
});

test.describe('the viewer watching a log', () => {
  test.beforeEach(async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      connections: [{ id: 'target', pseudo: 'Ada' }],
    });
    await page.evaluate(() => resetRemoteLogState());
  });

  test('requesting sends the ask and waits', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const out = [];
      connections.get('target').data.send = (m) => out.push(m);
      requestRemoteLogs('target');
      const session = remoteLogSession('target');
      return { out, state: session.state, entries: session.entries.length };
    });
    expect(seen.out).toHaveLength(1);
    expect(seen.out[0].type).toBe('log-session-request');
    expect(seen.state).toBe('requesting');
    expect(seen.entries).toBe(0);
  });

  test('asking about yourself, or nobody, does nothing', async ({ page }) => {
    const seen = await page.evaluate(() => {
      requestRemoteLogs('self');
      requestRemoteLogs('host');
      requestRemoteLogs(null);
      return _remoteLogSessions.size;
    });
    expect(seen).toBe(0);
  });

  test('a peer we cannot reach ends the session straight away', async ({ page }) => {
    const seen = await page.evaluate(() => {
      requestRemoteLogs('nobody-here');
      const s = remoteLogSession('nobody-here');
      return { state: s.state, note: s.note };
    });
    expect(seen).toEqual({ state: 'ended', note: 'Could not reach that peer.' });
  });

  test('a grant makes the session live', async ({ page }) => {
    const state = await page.evaluate(() => {
      requestRemoteLogs('target');
      onRemoteLogResponse('target', true);
      const s = remoteLogSession('target');
      return { state: s.state, note: s.note };
    });
    expect(state).toEqual({ state: 'active', note: null });
  });

  test('a refusal explains itself', async ({ page }) => {
    const seen = await page.evaluate(() => {
      requestRemoteLogs('target');
      onRemoteLogResponse('target', false, 'busy');
      const busy = remoteLogSession('target').note;
      requestRemoteLogs('target');
      onRemoteLogResponse('target', false, 'declined');
      return { busy, declined: remoteLogSession('target').note };
    });
    expect(seen.busy).toContain('already sharing');
    expect(seen.declined).toBe('They declined.');
  });

  test('entries only land on a session we actually asked for', async ({ page }) => {
    const seen = await page.evaluate(() => {
      // Nobody asked this peer for anything.
      onRemoteLogEntries('stranger', [{ t: '00:00:00.000', msg: 'unsolicited', lvl: 'info' }]);
      const stranger = _remoteLogSessions.has('stranger');

      requestRemoteLogs('target');
      // Still only requesting — not yet granted.
      onRemoteLogEntries('target', [{ t: '00:00:00.000', msg: 'too early', lvl: 'info' }]);
      const early = remoteLogSession('target').entries.length;

      onRemoteLogResponse('target', true);
      onRemoteLogEntries('target', [{ t: '00:00:01.000', msg: 'now we are live', lvl: 'warn' }]);
      return { stranger, early, live: remoteLogSession('target').entries };
    });
    expect(seen.stranger).toBe(false);
    expect(seen.early).toBe(0);
    expect(seen.live).toEqual([{ t: '00:00:01.000', msg: 'now we are live', lvl: 'warn' }]);
  });

  test('incoming entries are sanitised, not trusted', async ({ page }) => {
    const entries = await page.evaluate(() => {
      requestRemoteLogs('target');
      onRemoteLogResponse('target', true);
      onRemoteLogEntries('target', [
        { t: 'a-very-long-timestamp-indeed', msg: 'y'.repeat(5000), lvl: 'not-a-level' },
        null,
        'not an object',
      ]);
      const e = remoteLogSession('target').entries[0];
      return { t: e.t.length, msgLen: e.msg.length, lvl: e.lvl, count: remoteLogSession('target').entries.length };
    });
    expect(entries.t).toBeLessThanOrEqual(16);
    expect(entries.lvl).toBe('info');
    expect(entries.msgLen).toBeLessThan(5000);
    expect(entries.count).toBe(1);
  });

  test('a malformed batch is dropped whole', async ({ page }) => {
    const count = await page.evaluate(() => {
      requestRemoteLogs('target');
      onRemoteLogResponse('target', true);
      onRemoteLogEntries('target', 'not an array');
      onRemoteLogEntries('target', []);
      return remoteLogSession('target').entries.length;
    });
    expect(count).toBe(0);
  });

  test('the end of a session says why it ended', async ({ page }) => {
    const notes = await page.evaluate(() => {
      const reasons = ['expired', 'left', 'peer-gone', 'stopped'];
      return reasons.map((r) => {
        requestRemoteLogs('target');
        onRemoteLogResponse('target', true);
        onRemoteLogEnd('target', r);
        const s = remoteLogSession('target');
        return { state: s.state, note: s.note };
      });
    });
    expect(notes.map((n) => n.state)).toEqual(['ended', 'ended', 'ended', 'ended']);
    expect(new Set(notes.map((n) => n.note)).size).toBe(4);
  });

  test('stopping tells the device and marks the session ended', async ({ page }) => {
    const seen = await page.evaluate(() => {
      requestRemoteLogs('target');
      onRemoteLogResponse('target', true);
      const out = [];
      connections.get('target').data.send = (m) => out.push(m);
      stopRemoteLogs('target');
      const s = remoteLogSession('target');
      return { out, state: s.state, note: s.note };
    });
    expect(seen.out).toHaveLength(1);
    expect(seen.out[0].type).toBe('log-session-stop');
    expect(seen.state).toBe('ended');
    expect(seen.note).toBe('Stopped.');
  });

  test('the panel renders what has arrived and can be closed', async ({ page }) => {
    const seen = await page.evaluate(() => {
      requestRemoteLogs('target');
      onRemoteLogResponse('target', true);
      onRemoteLogEntries('target', [
        { t: '00:00:01.000', msg: 'first', lvl: 'info' },
        { t: '00:00:02.000', msg: 'second', lvl: 'error' },
      ]);
      showRemoteLogPanel('target');
      const open = {
        hidden: document.getElementById('remote-log-panel').classList.contains('hidden'),
        title: document.getElementById('remote-log-title').textContent,
        lines: document.querySelectorAll('#remote-log-entries .dev-log-entry').length,
        status: document.getElementById('remote-log-status').textContent,
      };
      closeRemoteLogPanel();
      return { open, closed: document.getElementById('remote-log-panel').classList.contains('hidden') };
    });
    expect(seen.open.hidden).toBe(false);
    expect(seen.open.title).toBe('🪵 Ada');
    expect(seen.open.lines).toBe(2);
    expect(seen.open.status).toContain('2 lines');
    expect(seen.closed).toBe(true);
  });

  test('a line arriving while the panel is open is appended live', async ({ page }) => {
    const lines = await page.evaluate(() => {
      requestRemoteLogs('target');
      onRemoteLogResponse('target', true);
      showRemoteLogPanel('target');
      onRemoteLogEntries('target', [{ t: '00:00:03.000', msg: 'live line', lvl: 'info' }]);
      const out = document.getElementById('remote-log-entries').textContent;
      closeRemoteLogPanel();
      return out;
    });
    expect(lines).toContain('live line');
  });

  test('the log can be read out as plain text', async ({ page }) => {
    const text = await page.evaluate(() => {
      requestRemoteLogs('target');
      onRemoteLogResponse('target', true);
      onRemoteLogEntries('target', [
        { t: '00:00:01.000', msg: 'plain', lvl: 'info' },
        { t: '00:00:02.000', msg: 'shouty', lvl: 'error' },
      ]);
      return { text: remoteLogAsText('target'), missing: remoteLogAsText('nobody') };
    });
    expect(text.text).toBe('00:00:01.000  plain\n00:00:02.000  ERROR shouty');
    expect(text.missing).toBe('');
  });

  test('leaving the room forgets every session', async ({ page }) => {
    const size = await page.evaluate(() => {
      requestRemoteLogs('target');
      onRemoteLogResponse('target', true);
      resetRemoteLogState();
      return { sessions: _remoteLogSessions.size, viewing: _remoteLogViewPeerId };
    });
    expect(size).toEqual({ sessions: 0, viewing: null });
  });
});

test.describe('formatting a console argument', () => {
  test('renders each kind of value legibly', async ({ page }) => {
    const seen = await page.evaluate(() => ({
      string: formatLogArg('plain'),
      nul: formatLogArg(null),
      undef: formatLogArg(undefined),
      number: formatLogArg(42),
      object: formatLogArg({ a: 1 }),
      error: formatLogArg(Object.assign(new Error('boom'), { stack: 'Error: boom\n  at one\n  at two' })),
    }));
    expect(seen.string).toBe('plain');
    expect(seen.nul).toBe('null');
    expect(seen.undef).toBe('undefined');
    expect(seen.number).toBe('42');
    expect(seen.object).toBe('{"a":1}');
    // An error keeps the head of its stack — usually the whole point of asking.
    expect(seen.error).toContain('Error: boom');
    expect(seen.error).toContain('at one');
  });

  test('an object that cannot be stringified still renders', async ({ page }) => {
    const out = await page.evaluate(() => {
      const cyclic = {};
      cyclic.self = cyclic;
      return formatLogArg(cyclic);
    });
    expect(out).toContain('object');
  });
});
