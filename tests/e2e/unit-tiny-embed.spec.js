import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// The tiny embed — the app squeezed into an iframe a few hundred pixels wide.
// It renders its own compact roster, its own invite screen, and deliberately
// refuses to do things a full-size window does (dev mode, an unprompted
// microphone request).

test.beforeEach(async ({ page }) => {
  await page.goto('/?embed=tiny');
  await expect.poll(async () => page.evaluate(() => typeof updatePeerList)).toBe('function');
});

test.describe('the compact roster', () => {
  test('renders one chip per peer, with your own first', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'self',
      isHost: true,
      myPseudo: 'Me',
      connections: [{ id: 'p1', pseudo: 'Ada' }, { id: 'p2', pseudo: 'Grace' }],
    });
    const seen = await page.evaluate(() => {
      updatePeerList();
      const items = Array.from(document.querySelectorAll('#peers-list .peer-item-compact'));
      return {
        count: items.length,
        self: items[0].classList.contains('peer-self'),
        labels: items.map((el) => el.textContent.replace(/\s+/g, ' ').trim()),
      };
    });
    expect(seen.count).toBe(3);
    expect(seen.self).toBe(true);
    expect(seen.labels.join(' ')).toContain('Ada');
    expect(seen.labels.join(' ')).toContain('Grace');
  });

  test('dev mode is refused outright in an embed', async ({ page }) => {
    const enabled = await page.evaluate(() => {
      localStorage.setItem('dev-mode', 'true');
      const out = isDevModeEnabled();
      localStorage.setItem('dev-mode', 'false');
      return out;
    });
    expect(enabled).toBe(false);
  });

  test('the diagnostics button never appears', async ({ page }) => {
    const visible = await page.evaluate(() => {
      localStorage.setItem('dev-mode', 'true');
      isHost = true;
      const out = deviceInfoButtonVisible();
      localStorage.setItem('dev-mode', 'false');
      return out;
    });
    expect(visible).toBe(false);
  });

  test('there is no invite nudge to squeeze in', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, roomCode: 'room-x' });
    const present = await page.evaluate(() => {
      updatePeerList();
      return !!document.querySelector('.room-invite-nudge');
    });
    expect(present).toBe(false);
  });

  test('the room-size warning is suppressed too', async ({ page }) => {
    const hidden = await page.evaluate(() => {
      peer = { id: 'self' };
      isHost = true;
      inRoom = true;
      connections.clear();
      for (let i = 0; i < 14; i++) {
        connections.set('p' + i, { data: { open: true, closed: false, send() {}, close() {} }, pseudo: 'P' + i });
      }
      updatePeerList();
      return document.getElementById('room-size-warning').classList.contains('hidden');
    });
    expect(hidden).toBe(true);
  });

  test('the compact status names whoever is speaking, then clears', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'self',
      isHost: true,
      connections: [{ id: 'p1', pseudo: 'Ada' }],
    });
    const seen = await page.evaluate(async () => {
      connections.get('p1').talking = true;
      updatePeerList();
      updateTinyCompactStatus();
      const speaking = document.getElementById('tiny-compact-status').textContent;
      connections.get('p1').talking = false;
      updatePeerList();
      updateTinyCompactStatus();
      const immediately = document.getElementById('tiny-compact-status').textContent;
      await new Promise((r) => setTimeout(r, 1700));
      return { speaking, immediately, later: document.getElementById('tiny-compact-status').textContent };
    });
    expect(seen.speaking).toBe('Ada is speaking');
    // It lingers briefly rather than flickering off between syllables.
    expect(seen.immediately).toBe('Ada is speaking');
    expect(seen.later).toBe('');
  });

  test('the mic spinner is shown on your own chip', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true });
    const seen = await page.evaluate(() => {
      updatePeerList();
      setTinyMicAcquiring(true);
      const on = document.getElementById('peer-item-self').classList.contains('acquiring-mic');
      setTinyMicAcquiring(false);
      return { on, off: document.getElementById('peer-item-self').classList.contains('acquiring-mic') };
    });
    expect(seen).toEqual({ on: true, off: false });
  });
});

test.describe('the invite screen', () => {
  const UUID = '11111111-2222-3333-4444-555555555555';

  test('offers Start rather than joining unprompted', async ({ page }) => {
    const seen = await page.evaluate((uuid) => {
      window.fetch = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });
      showTinyInviteConnect(uuid, 3);
      const btn = document.getElementById('btn-cancel-invite-join');
      return {
        pending: _invitePendingRoomId,
        action: btn.dataset.action,
        label: btn.textContent,
        status: document.getElementById('invite-join-status').textContent,
        peers: document.getElementById('invite-peer-count').textContent,
        screen: document.querySelector('.screen.active').id,
      };
    }, UUID);
    expect(seen.pending).toBe(UUID);
    expect(seen.action).toBe('connect');
    expect(seen.label).toBe('Start');
    expect(seen.status).toBe('Tap Start to join this room.');
    expect(seen.peers).toBe('3 peers connected');
    expect(seen.screen).toBe('screen-invite-loading');
  });

  test('one peer is singular', async ({ page }) => {
    const text = await page.evaluate(() => {
      setTinyInvitePeerCount(1);
      return document.getElementById('invite-peer-count').textContent;
    });
    expect(text).toBe('1 peer connected');
  });

  test('an unknown peer count is hidden rather than guessed', async ({ page }) => {
    const seen = await page.evaluate(() => {
      setTinyInvitePeerCount(2);
      setTinyInvitePeerCount(null);
      const el = document.getElementById('invite-peer-count');
      return { text: el.textContent, hidden: el.classList.contains('hidden') };
    });
    expect(seen).toEqual({ text: '', hidden: true });
  });

  test('a blank room id shows nothing', async ({ page }) => {
    const pending = await page.evaluate(() => {
      _invitePendingRoomId = '';
      showTinyInviteConnect('');
      return _invitePendingRoomId;
    });
    expect(pending).toBe('');
  });

  test('the live peer count is filled in from the lobby', async ({ page }) => {
    const text = await page.evaluate(async (uuid) => {
      window.fetch = () => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ room_id: uuid, peer_count: 5 }),
      });
      // A named code is what the lobby can answer for.
      showTinyInviteConnect('happy-otter');
      await new Promise((r) => setTimeout(r, 60));
      return document.getElementById('invite-peer-count').textContent;
    }, UUID);
    expect(text).toBe('5 peers connected');
  });

  test('Start hands the room to the join flow', async ({ page }) => {
    const joined = await page.evaluate(async (uuid) => {
      window.__joined = [];
      window.joinRoom = (code) => { window.__joined.push(code); return Promise.resolve(); };
      window.fetch = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });
      showTinyInviteConnect(uuid);
      document.getElementById('btn-cancel-invite-join').click();
      await new Promise((r) => setTimeout(r, 20));
      return window.__joined;
    }, UUID);
    expect(joined).toEqual([UUID]);
  });

  test('the connecting screen replaces Start with Cancel', async ({ page }) => {
    const seen = await page.evaluate(() => {
      showInviteLoading('happy-otter', 'Connecting…');
      const btn = document.getElementById('btn-cancel-invite-join');
      return {
        action: btn.dataset.action,
        // The embed has no room to name; it just says it is connecting.
        label: document.getElementById('invite-room-code').textContent,
        status: document.getElementById('invite-join-status').textContent,
        connecting: document.getElementById('screen-invite-loading').classList.contains('tiny-connecting'),
      };
    });
    expect(seen.action).toBe('cancel');
    expect(seen.label).toBe('');
    expect(seen.status).toBe('Connecting …');
    expect(seen.connecting).toBe(true);
  });

  test('cancelling goes back to the Start screen, not the home screen', async ({ page }) => {
    const seen = await page.evaluate(async (uuid) => {
      window.fetch = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });
      showTinyInviteConnect(uuid);
      showInviteLoading(uuid, 'Connecting…');
      _cancelJoin = () => {};
      document.getElementById('btn-cancel-invite-join').click();
      await new Promise((r) => setTimeout(r, 20));
      return {
        screen: document.querySelector('.screen.active').id,
        action: document.getElementById('btn-cancel-invite-join').dataset.action,
      };
    }, UUID);
    expect(seen).toEqual({ screen: 'screen-invite-loading', action: 'connect' });
  });

  test('the CTA can offer a web fallback after a native hand-off', async ({ page }) => {
    const seen = await page.evaluate(() => {
      setInviteLoadingCtaMode('join-web');
      const btn = document.getElementById('btn-cancel-invite-join');
      return { action: btn.dataset.action, label: btn.textContent };
    });
    expect(seen).toEqual({ action: 'join-web', label: 'Join on web' });
  });

  test('the spinner can be hidden and shown', async ({ page }) => {
    const seen = await page.evaluate(() => {
      setInviteLoadingSpinnerVisible(false);
      const spinner = document.getElementById('invite-spinner') || document.querySelector('.invite-spinner');
      const hidden = spinner.classList.contains('hidden');
      setInviteLoadingSpinnerVisible(true);
      return { hidden, shown: !spinner.classList.contains('hidden') };
    });
    expect(seen).toEqual({ hidden: true, shown: true });
  });
});

test.describe('leaving a tiny embed', () => {
  test('returns to the Start screen instead of the home screen', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, roomCode: 'happy-otter' });
    const seen = await page.evaluate(() => {
      window.fetch = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });
      peer = { id: 'self', destroyed: false, destroy() { this.destroyed = true; } };
      _publishedRoomId = null;
      activeChannel = null;
      activeChannelRoomId = null;
      leaveRoom();
      return {
        screen: document.querySelector('.screen.active').id,
        pending: _invitePendingRoomId,
      };
    });
    expect(seen.screen).toBe('screen-invite-loading');
    expect(seen.pending).toBe('happy-otter');
  });
});

test.describe('popping out of an embed', () => {
  test('opens a standalone window carrying the room and identity', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, roomCode: 'happy-otter', myPseudo: 'Ada' });
    const opened = await page.evaluate(() => {
      const seen = [];
      window.open = (url, target, features) => { seen.push({ url, target, features }); return {}; };
      window.fetch = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });
      // Popping out hands the session over, so it leaves the room on the way.
      peer = { id: 'self', destroyed: false, destroy() { this.destroyed = true; } };
      _publishedRoomId = null;
      activeChannel = null;
      activeChannelRoomId = null;
      popOutTinyEmbed();
      return seen;
    });
    expect(opened).toHaveLength(1);
    expect(opened[0].url).toContain('room=happy-otter');
    expect(opened[0].url).toContain('forceWeb=1');
    expect(opened[0].url).toContain('name=Ada');
  });

  test('with no room there is nothing to pop out to', async ({ page }) => {
    const opened = await page.evaluate(() => {
      const seen = [];
      window.open = (url) => { seen.push(url); return {}; };
      roomCode = '';
      _publishedRoomId = null;
      activeChannel = null;
      activeChannelRoomId = null;
      popOutTinyEmbed();
      return seen;
    });
    expect(opened).toEqual([]);
  });
});

test.describe('the full-size app, for contrast', () => {
  test('renders the full roster rows, not compact chips', async ({ page }) => {
    await page.goto('/');
    await seedRoom(page, {
      selfId: 'self',
      isHost: true,
      connections: [{ id: 'p1', pseudo: 'Ada' }],
    });
    const seen = await page.evaluate(() => {
      updatePeerList();
      return {
        compact: document.querySelectorAll('#peers-list .peer-item-compact').length,
        full: document.querySelectorAll('#peers-list .peer-item').length,
      };
    });
    expect(seen.compact).toBe(0);
    expect(seen.full).toBe(2);
  });

  test('the compact status helper is inert outside an embed', async ({ page }) => {
    await page.goto('/');
    const threw = await page.evaluate(() => {
      try { updateTinyCompactStatus(); setTinyMicAcquiring(true); return false; } catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });
});
