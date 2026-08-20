import { test, expect } from './fixtures.js';
import { seedRoom, callFn } from './_helpers.js';

// The in-room roster: who is listed, what each row carries in dev mode, the
// inline rename, the invite nudge and the room-size warning. Every membership
// change funnels through updatePeerList(), so this is the widest-reach piece of
// UI in the app.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

const rows = (page) => page.evaluate(() =>
  Array.from(document.querySelectorAll('#peers-list .peer-item')).map((el) => ({
    id: el.id,
    text: el.textContent.trim(),
    self: el.classList.contains('peer-self'),
    talking: el.classList.contains('talking'),
  })));

test.describe('who is listed', () => {
  test('you come first, then everyone else', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'self',
      isHost: true,
      myPseudo: 'Me',
      connections: [{ id: 'p1', pseudo: 'Ada' }, { id: 'p2', pseudo: 'Grace' }],
    });
    await page.evaluate(() => updatePeerList());
    const list = await rows(page);
    expect(list.map((r) => r.id)).toEqual(['peer-item-self', 'peer-item-p1', 'peer-item-p2']);
    expect(list[0].self).toBe(true);
    expect(list[1].text).toContain('Ada');
    expect(list[2].text).toContain('Grace');
  });

  test('a peer with no name falls back to a short id', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'self',
      isHost: true,
      connections: [{ id: 'abcdefghijklmnopqrst' }],
    });
    await page.evaluate(() => {
      connections.get('abcdefghijklmnopqrst').pseudo = undefined;
      updatePeerList();
    });
    const list = await rows(page);
    expect(list[1].text).toContain('abcdef');
    expect(list[1].text).not.toContain('ghijklmnop');
  });

  test('the talking flag lands on the right row', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'self',
      isHost: true,
      connections: [{ id: 'p1', pseudo: 'Ada' }, { id: 'p2', pseudo: 'Grace' }],
    });
    await page.evaluate(() => {
      connections.get('p2').talking = true;
      updatePeerList();
    });
    const list = await rows(page);
    expect(list.map((r) => r.talking)).toEqual([false, false, true]);
  });

  test('your own row shows as talking while transmitting or hands-free', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true });
    const seen = await page.evaluate(() => {
      isTalking = true;
      updatePeerList();
      const talking = document.getElementById('peer-item-self').classList.contains('talking');
      isTalking = false;
      freeHandMode = true;
      updatePeerList();
      const freehand = document.getElementById('peer-item-self').classList.contains('talking');
      freeHandMode = false;
      return { talking, freehand };
    });
    expect(seen).toEqual({ talking: true, freehand: true });
  });
});

test.describe('dev-mode extras on a row', () => {
  test('off by default: no peer ids, no copy button, no stats badge', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1', pseudo: 'Ada' }] });
    const html = await page.evaluate(() => {
      localStorage.setItem('dev-mode', 'false');
      connections.get('p1').webrtcStats = { rttMs: 20, iceType: 'host' };
      updatePeerList();
      return document.getElementById('peers-list').innerHTML;
    });
    expect(html).not.toContain('peer-copy-btn');
    expect(html).not.toContain('peer-uuid');
  });

  test('on: the peer id, a copy button and the link badge all appear', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1', pseudo: 'Ada' }] });
    const html = await page.evaluate(() => {
      localStorage.setItem('dev-mode', 'true');
      connections.get('p1').webrtcStats = { rttMs: 20, jitterMs: 4, lossPercent: 0.2, iceType: 'relay' };
      updatePeerList();
      const out = document.getElementById('peers-list').innerHTML;
      localStorage.setItem('dev-mode', 'false');
      return out;
    });
    expect(html).toContain('peer-copy-btn');
    expect(html).toContain('p1');
  });

  test('the ICE dot colour follows the measured candidate type', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1', pseudo: 'Ada' }] });
    const cls = await page.evaluate(() => {
      localStorage.setItem('dev-mode', 'true');
      connections.get('p1').webrtcStats = { iceType: 'relay' };
      updatePeerList();
      const out = document.querySelector('#peer-item-p1 .peer-dot').className;
      localStorage.setItem('dev-mode', 'false');
      return out;
    });
    expect(cls).toContain('peer-dot-relay');
  });

  test('copying a peer id says so', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1', pseudo: 'Ada' }] });
    const copied = await page.evaluate(async () => {
      localStorage.setItem('dev-mode', 'true');
      const seen = [];
      navigator.clipboard.writeText = (t) => { seen.push(t); return Promise.resolve(); };
      updatePeerList();
      document.querySelector('#peer-item-p1 .peer-copy-btn').click();
      localStorage.setItem('dev-mode', 'false');
      return seen;
    });
    expect(copied).toEqual(['p1']);
  });

  test('clicking a peer dot opens its stats, and again closes them', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1', pseudo: 'Ada' }] });
    const seen = await page.evaluate(() => {
      connections.get('p1').webrtcStats = { rttMs: 20, iceType: 'host' };
      updatePeerList();
      const dot = document.querySelector('#peer-item-p1 .peer-dot');
      dot.click();
      const opened = _statsPopoverPeerId;
      dot.click();
      return { opened, closed: _statsPopoverPeerId };
    });
    expect(seen).toEqual({ opened: 'p1', closed: null });
  });

  test('your own dot is not clickable — there are no stats about yourself', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true });
    const clickable = await page.evaluate(() => {
      updatePeerList();
      return document.querySelector('#peer-item-self .peer-dot').classList.contains('peer-dot-clickable');
    });
    expect(clickable).toBe(false);
  });
});

test.describe('renaming yourself from the roster', () => {
  test('the edit button swaps the name for an input', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, myPseudo: 'Me' });
    const value = await page.evaluate(() => {
      updatePeerList();
      document.querySelector('#peer-item-self .peer-edit-btn').click();
      return document.querySelector('#peer-item-self .peer-name-inline').value;
    });
    expect(value).toBe('Me');
    expect(await page.evaluate(() => editingSelfPseudo)).toBe(true);
  });

  test('Enter commits the new name', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, myPseudo: 'Me' });
    const seen = await page.evaluate(() => {
      updatePeerList();
      document.querySelector('#peer-item-self .peer-edit-btn').click();
      const input = document.querySelector('#peer-item-self .peer-name-inline');
      input.value = 'Renamed';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return { myPseudo, editing: editingSelfPseudo };
    });
    expect(seen).toEqual({ myPseudo: 'Renamed', editing: false });
  });

  test('Escape abandons the edit', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, myPseudo: 'Me' });
    const seen = await page.evaluate(() => {
      updatePeerList();
      document.querySelector('#peer-item-self .peer-edit-btn').click();
      const input = document.querySelector('#peer-item-self .peer-name-inline');
      input.value = 'Discarded';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return { myPseudo, editing: editingSelfPseudo };
    });
    expect(seen).toEqual({ myPseudo: 'Me', editing: false });
  });

  test('a rename in a room is announced to everyone', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      myPseudo: 'Me',
      connections: [{ id: 'p1', pseudo: 'Ada' }],
    });
    const sent = await page.evaluate(() => {
      const out = [];
      connections.get('p1').data.send = (m) => out.push(m);
      setMyPseudo('Renamed');
      return out;
    });
    expect(sent).toContainEqual(expect.objectContaining({ type: 'peer-renamed', pseudo: 'Renamed' }));
  });

  test('a silent rename is not announced', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      myPseudo: 'Me',
      connections: [{ id: 'p1', pseudo: 'Ada' }],
    });
    const sent = await page.evaluate(() => {
      const out = [];
      connections.get('p1').data.send = (m) => out.push(m);
      setMyPseudo('Quiet', { silentAnnounce: true });
      return out.filter((m) => m.type === 'peer-renamed');
    });
    expect(sent).toEqual([]);
  });

  test('a non-host announces its rename to the host', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'p2',
      isHost: false,
      roomCode: 'host',
      myPseudo: 'Me',
      connections: [{ id: 'host' }],
    });
    const sent = await page.evaluate(() => {
      const out = [];
      connections.get('host').data.send = (m) => out.push(m);
      announcePseudoChange();
      return out;
    });
    expect(sent).toContainEqual(expect.objectContaining({ type: 'pseudo', pseudo: 'Me' }));
  });
});

test.describe('the invite nudge', () => {
  test('appears while you are alone in the room', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, roomCode: 'room-x' });
    const text = await page.evaluate(() => {
      updatePeerList();
      const el = document.querySelector('.room-invite-nudge');
      return el && el.textContent;
    });
    expect(text).toContain('Share your invite link');
  });

  test('goes away as soon as somebody joins', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1', pseudo: 'Ada' }] });
    const present = await page.evaluate(() => {
      updatePeerList();
      return !!document.querySelector('.room-invite-nudge');
    });
    expect(present).toBe(false);
  });

  test('its button copies the invite link', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, roomCode: 'room-x' });
    const copied = await page.evaluate(() => {
      _publishedRoomId = null;
      activeChannel = null;
      activeChannelRoomId = null;
      const seen = [];
      navigator.clipboard.writeText = (t) => { seen.push(t); return Promise.resolve(); };
      updatePeerList();
      document.querySelector('.room-invite-nudge button').click();
      return seen;
    });
    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain('room=room-x');
  });
});

test.describe('the room-size warning', () => {
  test('stays away for a small room', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'self',
      isHost: true,
      connections: [{ id: 'p1' }, { id: 'p2' }],
    });
    const hidden = await page.evaluate(() => {
      updatePeerList();
      return document.getElementById('room-size-warning').classList.contains('hidden');
    });
    expect(hidden).toBe(true);
  });

  test('warns softly once the mesh gets wide, then harder', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const mk = (n) => {
        connections.clear();
        for (let i = 0; i < n; i++) {
          connections.set('p' + i, { data: { open: true, closed: false, send() {}, close() {} }, pseudo: 'P' + i });
        }
        updatePeerList();
        const el = document.getElementById('room-size-warning');
        return { hidden: el.classList.contains('hidden'), hard: el.classList.contains('hard') };
      };
      peer = { id: 'self' };
      isHost = true;
      inRoom = true;
      return { small: mk(3), soft: mk(8), hard: mk(14) };
    });
    expect(seen.small.hidden).toBe(true);
    expect(seen.soft).toEqual({ hidden: false, hard: false });
    expect(seen.hard).toEqual({ hidden: false, hard: true });
  });
});

test.describe('the room header', () => {
  test('shows the code people should actually share', async ({ page }) => {
    await seedRoom(page, { selfId: 'peer-uuid', isHost: true, roomCode: 'peer-uuid' });
    const shown = await page.evaluate(() => {
      _publishedRoomId = 'happy-otter';
      activeChannel = null;
      activeChannelRoomId = null;
      updateRoomHeader();
      const out = document.getElementById('room-code-display').textContent;
      _publishedRoomId = null;
      return out;
    });
    expect(shown).toContain('happy-otter');
  });

  test('roomDisplayCode prefers a named code over the raw peer id', async ({ page }) => {
    await seedRoom(page, { selfId: 'peer-uuid', isHost: true, roomCode: 'peer-uuid' });
    const seen = await page.evaluate(() => {
      activeChannelRoomId = null;
      activeChannel = null;
      _publishedRoomId = null;
      const bare = roomDisplayCode();
      _publishedRoomId = 'happy-otter';
      const published = roomDisplayCode();
      activeChannel = 'General';
      const channel = roomDisplayCode();
      activeChannelRoomId = 'general-room';
      const channelRoom = roomDisplayCode();
      activeChannel = null;
      activeChannelRoomId = null;
      _publishedRoomId = null;
      return { bare, published, channel, channelRoom };
    });
    expect(seen).toEqual({
      bare: 'peer-uuid',
      published: 'happy-otter',
      channel: 'General',
      channelRoom: 'general-room',
    });
  });

  test('an invite URL is built from the display code', async ({ page }) => {
    const url = await callFn(page, 'roomInviteUrl', 'happy-otter');
    expect(url).toContain('room=happy-otter');
    expect(await callFn(page, 'roomInviteUrl', '')).toBe('');
  });
});

test.describe('the peers a talking flag lands on', () => {
  test('updatePeerTalking marks and unmarks a row', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1', pseudo: 'Ada' }] });
    const seen = await page.evaluate(() => {
      updatePeerList();
      updatePeerTalking('p1', true);
      const on = document.getElementById('peer-item-p1').classList.contains('talking');
      updatePeerTalking('p1', false);
      const off = document.getElementById('peer-item-p1').classList.contains('talking');
      updatePeerTalking('nobody', true); // must not throw
      return { on, off };
    });
    expect(seen).toEqual({ on: true, off: false });
  });

  test('updateSelfTalking marks your own row', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true });
    const seen = await page.evaluate(() => {
      updatePeerList();
      updateSelfTalking(true);
      const on = document.getElementById('peer-item-self').classList.contains('talking');
      updateSelfTalking(false);
      return { on, off: document.getElementById('peer-item-self').classList.contains('talking') };
    });
    expect(seen).toEqual({ on: true, off: false });
  });
});
