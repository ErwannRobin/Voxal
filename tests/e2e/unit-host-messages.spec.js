import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// What a non-host does with each message the host sends it. Any peer drives
// this channel, so a malformed or hostile packet must never throw out of the
// data handler — at worst one packet is dropped.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await seedRoom(page, {
    selfId: 'me',
    isHost: false,
    roomCode: 'the-host',
    connections: [{ id: 'the-host', pseudo: 'Host' }],
  });
});

test.describe('the envelope every message carries', () => {
  test('any message counts as a heartbeat from the host', async ({ page }) => {
    const at = await page.evaluate(() => {
      _lastHostHeartbeatAt = 0;
      handleHostMessage({ type: 'heartbeat', at: 4242 });
      return _lastHostHeartbeatAt;
    });
    expect(at).toBe(4242);
  });

  test('a successor chain on any message updates the election state', async ({ page }) => {
    const chain = await page.evaluate(() => {
      handleHostMessage({ type: 'heartbeat', successorIds: ['a', 'b'] });
      return _authoritativeSuccessorIds.slice();
    });
    expect(chain).toEqual(['a', 'b']);
  });

  test('the host\'s debug flag is mirrored, and re-renders the roster', async ({ page }) => {
    const seen = await page.evaluate(() => {
      _hostDebugMode = false;
      handleHostMessage({ type: 'heartbeat', debugMode: true });
      const on = _hostDebugMode;
      handleHostMessage({ type: 'heartbeat', debugMode: false });
      return { on, off: _hostDebugMode };
    });
    expect(seen).toEqual({ on: true, off: false });
  });

  test('a host-pushed jitter buffer is clamped before it reaches the audio path', async ({ page }) => {
    const seen = await page.evaluate(() => {
      handleHostMessage({ type: 'heartbeat', jitterMs: 120 });
      const normal = _hostJitterMs;
      handleHostMessage({ type: 'heartbeat', jitterMs: 99999 });
      const clamped = _hostJitterMs;
      handleHostMessage({ type: 'heartbeat', jitterMs: -5 });
      const floored = _hostJitterMs;
      handleHostMessage({ type: 'heartbeat', jitterMs: null });
      const cleared = _hostJitterMs;
      return { normal, clamped, floored, cleared };
    });
    // A peer drives this channel, so it is clamped like any other untrusted input.
    expect(seen).toEqual({ normal: 120, clamped: 500, floored: 0, cleared: null });
  });

  test('a malformed message is dropped rather than thrown', async ({ page }) => {
    const threw = await page.evaluate(() => {
      try {
        handleHostMessage(null);
        handleHostMessage('not an object');
        handleHostMessage({ type: 'nonsense-nobody-sends' });
        return false;
      } catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });

  test('safeHandleHostMessage swallows a handler that throws', async ({ page }) => {
    const threw = await page.evaluate(() => {
      try {
        // A peer-list whose `peers` is not an array reaches straight into the
        // roster code; the wrapper is what keeps the room alive.
        safeHandleHostMessage({ type: 'peer-list', peers: 'not-an-array' });
        return false;
      } catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });
});

test.describe('a peer-list from the host', () => {
  test('replaces the roster and adds the host itself', async ({ page }) => {
    const seen = await page.evaluate(() => {
      connections.set('gone', { data: null, media: null });
      handleHostMessage({
        type: 'peer-list',
        peers: [{ id: 'p1', pseudo: 'Ada' }, { id: 'p2', pseudo: 'Grace' }],
        hostId: 'the-host',
        hostPseudo: 'Host',
      });
      return {
        conns: Array.from(connections.keys()).sort(),
        known: Array.from(knownPeerIds).sort(),
        host: connections.get('the-host').pseudo,
        ada: connections.get('p1').pseudo,
      };
    });
    // Anyone missing from the authoritative list is dropped.
    expect(seen.conns).toEqual(['p1', 'p2', 'the-host']);
    expect(seen.known).toEqual(['p1', 'p2', 'the-host']);
    expect(seen.host).toBe('Host');
    expect(seen.ada).toBe('Ada');
  });

  test('a name the host assigned us is applied', async ({ page }) => {
    const pseudo = await page.evaluate(() => {
      myPseudo = 'Ada';
      _preRenameMyPseudo = null;
      handleHostMessage({ type: 'peer-list', peers: [], hostId: 'the-host', selfPseudo: 'Ada 2' });
      return myPseudo;
    });
    expect(pseudo).toBe('Ada 2');
  });

  test('a sharing peer keeps its flags across the list', async ({ page }) => {
    const seen = await page.evaluate(() => {
      handleHostMessage({
        type: 'peer-list',
        peers: [{ id: 'p1', pseudo: 'Ada', videoActive: true, screenActive: true }],
        hostId: 'the-host',
        hostVideoActive: true,
      });
      return {
        p1: { video: connections.get('p1').videoActive, screen: connections.get('p1').screenActive },
        host: connections.get('the-host').videoActive,
      };
    });
    expect(seen.p1).toEqual({ video: true, screen: true });
    expect(seen.host).toBe(true);
  });

  test('the host\'s video-mode setting is adopted', async ({ page }) => {
    const enabled = await page.evaluate(() => {
      videoModeEnabled = false;
      handleHostMessage({ type: 'peer-list', peers: [], hostId: 'the-host', videoModeEnabled: true });
      return videoModeEnabled;
    });
    expect(enabled).toBe(true);
  });

  test('a peer-list leaves a snapshot the rejoin bar can use', async ({ page }) => {
    const snapshot = await page.evaluate(() => {
      handleHostMessage({ type: 'peer-list', peers: [{ id: 'p1', pseudo: 'Ada' }], hostId: 'the-host' });
      return loadRejoinSnapshot();
    });
    expect(snapshot).toMatchObject({ hostId: 'the-host', wasHost: false });
    expect(snapshot.peerIds).toContain('p1');
  });
});

test.describe('membership messages', () => {
  test('peer-joined adds the newcomer', async ({ page }) => {
    const seen = await page.evaluate(() => {
      handleHostMessage({ type: 'peer-joined', peerId: 'p9', pseudo: 'New', pseudoColor: '#ef4444' });
      const c = connections.get('p9');
      return { known: knownPeerIds.has('p9'), pseudo: c.pseudo, color: c.pseudoColor };
    });
    expect(seen).toEqual({ known: true, pseudo: 'New', color: '#ef4444' });
  });

  test('peer-joined for someone already here does not re-announce them', async ({ page }) => {
    const pseudo = await page.evaluate(() => {
      connections.set('p9', { data: null, media: null, pseudo: 'Old' });
      handleHostMessage({ type: 'peer-joined', peerId: 'p9', pseudo: 'Renamed' });
      return connections.get('p9').pseudo;
    });
    expect(pseudo).toBe('Renamed');
  });

  test('peer-left removes them', async ({ page }) => {
    const seen = await page.evaluate(() => {
      connections.set('p9', { data: null, media: null, pseudo: 'Bye' });
      knownPeerIds.add('p9');
      handleHostMessage({ type: 'peer-left', peerId: 'p9' });
      return { conn: connections.has('p9'), known: knownPeerIds.has('p9') };
    });
    expect(seen).toEqual({ conn: false, known: false });
  });

  test('peer-renamed updates the name and colour', async ({ page }) => {
    const seen = await page.evaluate(() => {
      connections.set('p9', { data: null, media: null, pseudo: 'Before' });
      handleHostMessage({ type: 'peer-renamed', peerId: 'p9', pseudo: 'After', pseudoColor: '#22c55e' });
      const c = connections.get('p9');
      return { pseudo: c.pseudo, color: c.pseudoColor };
    });
    expect(seen).toEqual({ pseudo: 'After', color: '#22c55e' });
  });

  test('a rename with no name falls back to a short id', async ({ page }) => {
    const pseudo = await page.evaluate(() => {
      connections.set('abcdefghijklmnopqrst', { data: null, media: null, pseudo: 'Before' });
      handleHostMessage({ type: 'peer-renamed', peerId: 'abcdefghijklmnopqrst' });
      return connections.get('abcdefghijklmnopqrst').pseudo;
    });
    expect(pseudo).toBe('abcdef…qrst');
  });

  test('talking is reflected on the roster row', async ({ page }) => {
    const talking = await page.evaluate(() => {
      connections.set('p9', { data: null, media: null, pseudo: 'Ada' });
      updatePeerList();
      handleHostMessage({ type: 'talking', peerId: 'p9', active: true });
      return document.getElementById('peer-item-p9').classList.contains('talking');
    });
    expect(talking).toBe(true);
  });
});

test.describe('room-wide announcements', () => {
  test('room-published records the lobby id and the secret', async ({ page }) => {
    const seen = await page.evaluate(() => {
      handleHostMessage({ type: 'room-published', roomId: 'happy-otter', secret: 'sec' });
      const withSecret = { id: _publishedRoomId, secret: _publishSecret };
      handleHostMessage({ type: 'room-published', roomId: null, secret: null });
      const cleared = { id: _publishedRoomId, secret: _publishSecret };
      return { withSecret, cleared };
    });
    expect(seen.withSecret).toEqual({ id: 'happy-otter', secret: 'sec' });
    expect(seen.cleared).toEqual({ id: null, secret: null });
  });

  test('video-mode turns the controls on', async ({ page }) => {
    const enabled = await page.evaluate(() => {
      videoModeEnabled = false;
      handleHostMessage({ type: 'video-mode', enabled: true });
      return videoModeEnabled;
    });
    expect(enabled).toBe(true);
  });
});

test.describe('media announcements', () => {
  test('a video offer marks the sharer active', async ({ page }) => {
    const active = await page.evaluate(() => {
      connections.set('p9', { data: null, media: null, pseudo: 'Ada' });
      handleHostMessage({ type: 'video-offer', peerId: 'p9', topology: 'p2p' });
      return connections.get('p9').videoActive;
    });
    expect(active).toBe(true);
  });

  test('a video stop clears the stream and the flag', async ({ page }) => {
    const seen = await page.evaluate(() => {
      connections.set('p9', {
        data: null, media: null, pseudo: 'Ada',
        videoActive: true, remoteVideoStream: new MediaStream(),
      });
      handleHostMessage({ type: 'video-stop', peerId: 'p9' });
      const c = connections.get('p9');
      return { active: c.videoActive, stream: c.remoteVideoStream };
    });
    expect(seen).toEqual({ active: false, stream: null });
  });

  test('a screen offer and stop follow the same shape', async ({ page }) => {
    const seen = await page.evaluate(() => {
      connections.set('p9', { data: null, media: null, pseudo: 'Ada' });
      handleHostMessage({ type: 'screen-offer', peerId: 'p9', topology: 'p2p' });
      const on = connections.get('p9').screenActive;
      handleHostMessage({ type: 'screen-stop', peerId: 'p9' });
      return { on, off: connections.get('p9').screenActive };
    });
    expect(seen).toEqual({ on: true, off: false });
  });

  test('being told to call a newcomer does nothing while we share nothing', async ({ page }) => {
    const calls = await page.evaluate(() => {
      let n = 0;
      peer = { id: 'me', destroyed: false, call: () => { n++; return null; } };
      localVideoActive = false;
      localScreenActive = false;
      handleHostMessage({ type: 'video-call-peer', peerId: 'p9' });
      handleHostMessage({ type: 'screen-call-peer', peerId: 'p9' });
      return n;
    });
    expect(calls).toBe(0);
  });

  test('being told to call a newcomer while sharing opens one call per kind', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const made = [];
      peer = {
        id: 'me',
        destroyed: false,
        call(peerId, stream, opts) {
          made.push({ peerId, kind: opts && opts.metadata && opts.metadata.type });
          return {
            peer: peerId, closed: false,
            peerConnection: { getSenders: () => [] },
            close() {}, on() {},
          };
        },
      };
      connections.set('p9', { data: null, media: null, pseudo: 'New' });
      const c = document.createElement('canvas');
      c.width = 32; c.height = 24;
      c.getContext('2d').fillRect(0, 0, 1, 1);
      localVideoStream = c.captureStream(1);
      localScreenStream = c.captureStream(1);
      localVideoActive = true;
      localScreenActive = true;
      handleHostMessage({ type: 'video-call-peer', peerId: 'p9' });
      handleHostMessage({ type: 'screen-call-peer', peerId: 'p9' });
      localVideoActive = false;
      localScreenActive = false;
      return made;
    });
    expect(seen).toEqual([
      { peerId: 'p9', kind: 'video' },
      { peerId: 'p9', kind: 'screen' },
    ]);
  });
});

test.describe('diagnostics messages', () => {
  test('a device-info request is answered over the host link', async ({ page }) => {
    const sent = await page.evaluate(() => {
      setDeviceInfoConsent('declined');
      const out = [];
      connections.get('the-host').data.send = (m) => out.push(m);
      handleHostMessage({ type: 'device-info-request', from: 'asker' });
      return out;
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'device-info-response', declined: true, from: 'asker' });
  });

  test('a device-info response is stored against its peer', async ({ page }) => {
    const stored = await page.evaluate(() => {
      connections.set('p9', { data: null, media: null, pseudo: 'Ada' });
      handleHostMessage({ type: 'device-info-response', peerId: 'p9', info: { device: { os: 'iOS' } } });
      return connections.get('p9').deviceInfo.info;
    });
    expect(stored).toEqual({ device: { os: 'iOS' } });
  });

  test('an audio-check request is answered', async ({ page }) => {
    const sent = await page.evaluate(() => {
      setDeviceInfoConsent('declined');
      const out = [];
      connections.get('the-host').data.send = (m) => out.push(m);
      handleHostMessage({ type: 'audio-check-request', from: 'asker', durationMs: 500 });
      return out;
    });
    expect(sent[0]).toMatchObject({ type: 'audio-check-response', declined: true });
  });

  test('a log-session request with sharing declined is refused outright', async ({ page }) => {
    const sent = await page.evaluate(() => {
      setDeviceInfoConsent('declined');
      const out = [];
      connections.get('the-host').data.send = (m) => out.push(m);
      handleHostMessage({ type: 'log-session-request', from: 'asker', fromPseudo: 'Nosy' });
      return out;
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'log-session-response', granted: false, reason: 'declined' });
  });

  test('a log-session request with sharing on raises a consent prompt', async ({ page }) => {
    const seen = await page.evaluate(() => {
      setDeviceInfoConsent('accepted');
      _logSharePrompt = null;
      _logDeclineCooldown.clear();
      handleHostMessage({ type: 'log-session-request', from: 'asker', fromPseudo: 'Nosy' });
      const prompt = _logSharePrompt && { requesterId: _logSharePrompt.requesterId, pseudo: _logSharePrompt.pseudo };
      declineLogSessionRequest();
      return prompt;
    });
    expect(seen).toEqual({ requesterId: 'asker', pseudo: 'Nosy' });
  });

  test('declining puts that viewer on a cooldown', async ({ page }) => {
    const sent = await page.evaluate(() => {
      setDeviceInfoConsent('accepted');
      _logSharePrompt = null;
      _logDeclineCooldown.clear();
      handleHostMessage({ type: 'log-session-request', from: 'asker' });
      declineLogSessionRequest();
      const out = [];
      connections.get('the-host').data.send = (m) => out.push(m);
      // Asking again straight away must not re-raise the prompt.
      handleHostMessage({ type: 'log-session-request', from: 'asker' });
      const prompt = _logSharePrompt;
      _logDeclineCooldown.clear();
      return { refused: out.filter((m) => m.type === 'log-session-response'), raised: !!prompt };
    });
    expect(sent.raised).toBe(false);
    expect(sent.refused).toHaveLength(1);
    expect(sent.refused[0]).toMatchObject({ granted: false, reason: 'declined' });
  });

  test('a second viewer is refused while one is already prompted', async ({ page }) => {
    const sent = await page.evaluate(() => {
      setDeviceInfoConsent('accepted');
      _logSharePrompt = null;
      _logDeclineCooldown.clear();
      handleHostMessage({ type: 'log-session-request', from: 'first' });
      const out = [];
      connections.get('the-host').data.send = (m) => out.push(m);
      handleHostMessage({ type: 'log-session-request', from: 'second' });
      const stillFirst = _logSharePrompt && _logSharePrompt.requesterId;
      declineLogSessionRequest();
      _logDeclineCooldown.clear();
      return { out, stillFirst };
    });
    expect(sent.stillFirst).toBe('first');
    expect(sent.out.some((m) => m.type === 'log-session-response' && m.reason === 'busy')).toBe(true);
  });

  test('a log-session stop is handled without a session open', async ({ page }) => {
    const threw = await page.evaluate(() => {
      try { handleHostMessage({ type: 'log-session-stop', from: 'asker' }); return false; } catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });
});

test.describe('the dev log', () => {
  test('entries are buffered and rendered while dev mode is on', async ({ page }) => {
    const seen = await page.evaluate(() => {
      localStorage.setItem('dev-mode', 'true');
      updateDevLogPanel();
      const before = document.querySelectorAll('#dev-log-entries .dev-log-entry').length;
      devLog('hello there');
      devLog('careful', 'warn');
      devLog('broken', 'error');
      const out = {
        added: document.querySelectorAll('#dev-log-entries .dev-log-entry').length - before,
        html: document.getElementById('dev-log-entries').innerHTML,
        hidden: document.getElementById('dev-log-panel').classList.contains('hidden'),
      };
      localStorage.setItem('dev-mode', 'false');
      updateDevLogPanel();
      return out;
    });
    expect(seen.added).toBe(3);
    expect(seen.html).toContain('hello there');
    expect(seen.html).toContain('warn');
    expect(seen.html).toContain('error');
    expect(seen.hidden).toBe(false);
  });

  test('a log line is escaped, never injected as markup', async ({ page }) => {
    const html = await page.evaluate(() => {
      localStorage.setItem('dev-mode', 'true');
      const container = document.createElement('div');
      appendDevLogEntryToContainer(container, { t: '00:00:00.000', msg: '<img src=x onerror=1>', lvl: 'info' });
      localStorage.setItem('dev-mode', 'false');
      return container.innerHTML;
    });
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
  });

  test('the panel is hidden with dev mode off', async ({ page }) => {
    const hidden = await page.evaluate(() => {
      localStorage.setItem('dev-mode', 'false');
      updateDevLogPanel();
      return document.getElementById('dev-log-panel').classList.contains('hidden');
    });
    expect(hidden).toBe(true);
  });

  test('the container keeps at most 200 lines', async ({ page }) => {
    const count = await page.evaluate(() => {
      const container = document.createElement('div');
      for (let i = 0; i < 250; i++) {
        appendDevLogEntryToContainer(container, { t: '00:00:00.000', msg: 'line ' + i, lvl: 'info' });
      }
      return { children: container.children.length, first: container.firstChild.textContent };
    });
    expect(count.children).toBe(200);
    expect(count.first).toContain('line 50');
  });
});
