import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// Chat's pure logic: what goes into the transcript, what the host is allowed to
// believe about a packet, and what a message body may turn into on screen.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test.describe('the transcript', () => {
  test.beforeEach(async ({ page }) => {
    await seedRoom(page, {
      selfId: 'me',
      isHost: false,
      roomCode: 'the-host',
      connections: [{ id: 'the-host', pseudo: 'Host' }, { id: 'other', pseudo: 'Other' }],
    });
    await page.evaluate(() => resetChatState());
  });

  test('a message from the host is appended', async ({ page }) => {
    const log = await page.evaluate(() => {
      handleHostMessage({ type: 'chat', id: 'other:1', peerId: 'other', text: 'hello', at: 1 });
      return chatLog.map((m) => [m.id, m.peerId, m.text]);
    });
    expect(log).toEqual([['other:1', 'other', 'hello']]);
  });

  test('the same id twice is one message', async ({ page }) => {
    const n = await page.evaluate(() => {
      const msg = { type: 'chat', id: 'other:1', peerId: 'other', text: 'hello', at: 1 };
      handleHostMessage(msg);
      handleHostMessage(msg);
      return chatLog.length;
    });
    expect(n).toBe(1);
  });

  test('a backfill merges with what is already held, without re-notifying', async ({ page }) => {
    const seen = await page.evaluate(() => {
      handleHostMessage({ type: 'chat', id: 'other:2', peerId: 'other', text: 'second', at: 2 });
      _chatUnread = 0;
      handleHostMessage({
        type: 'chat-history',
        messages: [
          { id: 'other:1', peerId: 'other', text: 'first', at: 1 },
          { id: 'other:2', peerId: 'other', text: 'second', at: 2 },
        ],
      });
      return { ids: chatLog.map((m) => m.id), unread: _chatUnread };
    });
    expect(seen.ids.sort()).toEqual(['other:1', 'other:2']);
    expect(seen.unread).toBe(0);
  });

  test('the log is trimmed to CHAT_LOG_MAX, oldest first', async ({ page }) => {
    const seen = await page.evaluate(() => {
      for (let i = 0; i < CHAT_LOG_MAX + 5; i++) {
        appendChatMessage({ id: 'other:' + i, peerId: 'other', text: 'm' + i, at: i }, { quiet: true });
      }
      return { length: chatLog.length, first: chatLog[0].text, ids: _chatIds.size };
    });
    expect(seen.length).toBe(200);
    expect(seen.first).toBe('m5');
    // The dedupe set must be trimmed with the log, or it leaks for the whole call.
    expect(seen.ids).toBe(200);
  });

  test('an empty or oversize body never enters the transcript', async ({ page }) => {
    const n = await page.evaluate(() => {
      handleHostMessage({ type: 'chat', id: 'other:a', peerId: 'other', text: '   ', at: 1 });
      handleHostMessage({ type: 'chat', id: 'other:b', peerId: 'other', text: 'x'.repeat(CHAT_TEXT_MAX + 1), at: 1 });
      handleHostMessage({ type: 'chat', id: 'other:c', peerId: 'other', text: { not: 'a string' }, at: 1 });
      return chatLog.length;
    });
    expect(n).toBe(0);
  });

  test('a message the host echoes back clears the pending copy', async ({ page }) => {
    const seen = await page.evaluate(() => {
      _chatPending.set('me:1', { id: 'me:1', text: 'mine' });
      handleHostMessage({ type: 'chat', id: 'me:1', peerId: 'me', text: 'mine', at: 1 });
      return { pending: _chatPending.size, log: chatLog.length };
    });
    expect(seen).toEqual({ pending: 0, log: 1 });
  });
});

test.describe('the host as the stamp of authority', () => {
  // Drive the real per-joiner data handler: the guard under test lives in it,
  // not in a helper it calls.
  async function seedHost(page) {
    await seedRoom(page, { selfId: 'host-id', isHost: true, roomCode: 'host-id' });
    await page.evaluate(() => {
      resetChatState();
      window.__sent = [];
      const conn = {
        peer: 'joiner',
        open: true,
        closed: false,
        _h: {},
        on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); },
        send(msg) { window.__sent.push(msg); },
        close() {},
      };
      handleJoinerDataConnection(conn);
      conn._h.open.forEach((fn) => fn());
      window.__deliver = (msg) => conn._h.data.forEach((fn) => fn(msg));
    });
  }

  test('the sender id is the connection\'s, never the one in the packet', async ({ page }) => {
    await seedHost(page);
    const seen = await page.evaluate(() => {
      window.__deliver({ type: 'chat', id: 'joiner:1', text: 'hi', peerId: 'somebody-else' });
      return {
        log: chatLog.map((m) => [m.id, m.peerId, m.text]),
        sent: window.__sent.filter((m) => m.type === 'chat'),
      };
    });
    expect(seen.log).toEqual([['joiner:1', 'joiner', 'hi']]);
    expect(seen.sent).toHaveLength(1);
    expect(seen.sent[0].peerId).toBe('joiner');
  });

  test('an id not prefixed with the sender is refused', async ({ page }) => {
    await seedHost(page);
    // Otherwise a peer could mint the id another peer is about to use and
    // pre-empt that message through everyone's dedupe.
    const n = await page.evaluate(() => {
      window.__deliver({ type: 'chat', id: 'victim:7', text: 'not mine to send' });
      window.__deliver({ type: 'chat', id: 'x'.repeat(CHAT_ID_MAX + 1), text: 'too long' });
      window.__deliver({ type: 'chat', id: 42, text: 'not a string' });
      return chatLog.length;
    });
    expect(n).toBe(0);
  });

  test('the sender gets its own message back — that echo is the ack', async ({ page }) => {
    await seedHost(page);
    const sent = await page.evaluate(() => {
      window.__deliver({ type: 'chat', id: 'joiner:1', text: 'hi' });
      return window.__sent.filter((m) => m.type === 'chat').length;
    });
    expect(sent).toBe(1);
  });

  test('a typing flag is relayed to everyone but its sender', async ({ page }) => {
    await seedHost(page);
    const sent = await page.evaluate(() => {
      window.__deliver({ type: 'chat-typing', active: true });
      return window.__sent.filter((m) => m.type === 'chat-typing');
    });
    expect(sent).toHaveLength(0);
  });
});

test.describe('reactions', () => {
  test.beforeEach(async ({ page }) => {
    await seedRoom(page, {
      selfId: 'me',
      isHost: false,
      roomCode: 'the-host',
      connections: [{ id: 'the-host', pseudo: 'Host' }],
    });
    await page.evaluate(() => {
      resetChatState();
      appendChatMessage({ id: 'other:1', peerId: 'other', text: 'hi', at: 1 }, { quiet: true });
    });
  });

  test('the same peer and emoji twice is add then remove', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const emoji = CHAT_REACTIONS[0];
      handleHostMessage({ type: 'chat-react', msgId: 'other:1', emoji, peerId: 'p1' });
      const after1 = Array.from(chatLog[0].reactions.get(emoji) || []);
      handleHostMessage({ type: 'chat-react', msgId: 'other:1', emoji, peerId: 'p1' });
      return { after1, keys: Array.from(chatLog[0].reactions.keys()) };
    });
    expect(seen.after1).toEqual(['p1']);
    // The empty bucket is dropped, not left behind as a zero-count chip.
    expect(seen.keys).toEqual([]);
  });

  test('an emoji outside the offered set is refused', async ({ page }) => {
    const keys = await page.evaluate(() => {
      handleHostMessage({ type: 'chat-react', msgId: 'other:1', emoji: '<script>', peerId: 'p1' });
      return Array.from(chatLog[0].reactions.keys());
    });
    expect(keys).toEqual([]);
  });

  test('a reaction for a message we do not hold is dropped', async ({ page }) => {
    const threw = await page.evaluate(() => {
      try {
        handleHostMessage({ type: 'chat-react', msgId: 'gone:9', emoji: CHAT_REACTIONS[0], peerId: 'p1' });
        return false;
      } catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });
});

test.describe('typing indicators', () => {
  test.beforeEach(async ({ page }) => {
    await seedRoom(page, {
      selfId: 'me',
      isHost: false,
      roomCode: 'the-host',
      connections: [{ id: 'the-host', pseudo: 'Host' }, { id: 'other', pseudo: 'Other' }],
    });
    await page.evaluate(() => resetChatState());
  });

  test('a flag expires on its own', async ({ page }) => {
    const seen = await page.evaluate(() => {
      handleHostMessage({ type: 'chat-typing', peerId: 'other', active: true });
      const live = activeChatTypists();
      _chatTyping.set('other', Date.now() - 1);   // as if CHAT_TYPING_TTL_MS had passed
      return { live, expired: activeChatTypists() };
    });
    expect(seen.live).toEqual(['other']);
    expect(seen.expired).toEqual([]);
  });

  test('a peer that has left stops being a typist', async ({ page }) => {
    const typists = await page.evaluate(() => {
      handleHostMessage({ type: 'chat-typing', peerId: 'other', active: true });
      connections.delete('other');
      return activeChatTypists();
    });
    expect(typists).toEqual([]);
  });

  test('our own id is ignored — we never watch ourselves type', async ({ page }) => {
    const typists = await page.evaluate(() => {
      handleHostMessage({ type: 'chat-typing', peerId: 'me', active: true });
      return activeChatTypists();
    });
    expect(typists).toEqual([]);
  });
});

test.describe('rendering a message body', () => {
  test.beforeEach(async ({ page }) => {
    await seedRoom(page, {
      selfId: 'me',
      isHost: false,
      roomCode: 'the-host',
      connections: [{ id: 'the-host', pseudo: 'Host' }],
    });
    await page.evaluate(() => resetChatState());
  });

  async function renderBody(page, text) {
    return page.evaluate((t) => {
      const el = document.createElement('div');
      renderChatText(el, t);
      return el.innerHTML;
    }, text);
  }

  test('markup in a body is text, never markup', async ({ page }) => {
    const html = await renderBody(page, '<img src=x onerror=alert(1)> & <b>bold</b>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;img');
  });

  test('an http(s) link becomes an anchor that cannot reach back', async ({ page }) => {
    const html = await renderBody(page, 'see https://example.com/x?a=1 for more');
    expect(html).toContain('href="https://example.com/x?a=1"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  test('a bare www. host is linked over https, never http', async ({ page }) => {
    const html = await renderBody(page, 'www.example.com');
    expect(html).toContain('href="https://www.example.com/"');
  });

  test('javascript: and data: URLs stay plain text', async ({ page }) => {
    for (const evil of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>']) {
      const html = await renderBody(page, evil);
      expect(html).not.toContain('<a');
    }
  });
});

test.describe('persistence', () => {
  test('the transcript survives a reload of the same room', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'me',
      isHost: false,
      roomCode: 'the-host',
      connections: [{ id: 'the-host', pseudo: 'Host' }],
    });
    const seen = await page.evaluate(() => {
      resetChatState();
      appendChatMessage({ id: 'other:1', peerId: 'other', text: 'kept', at: 1 }, { quiet: true });
      applyChatReaction('other:1', CHAT_REACTIONS[0], 'p1');
      saveChatLog();

      resetChatState();
      loadChatLog('the-host');
      const restored = chatLog.map((m) => [m.id, m.text, Array.from(m.reactions.get(CHAT_REACTIONS[0]) || [])]);

      // A different room's transcript is not ours to show.
      resetChatState();
      loadChatLog('some-other-host');
      return { restored, foreign: chatLog.length };
    });
    expect(seen.restored).toEqual([['other:1', 'kept', ['p1']]]);
    expect(seen.foreign).toBe(0);
  });

  test('a transcript older than the rejoin TTL is dropped, not shown', async ({ page }) => {
    await seedRoom(page, { selfId: 'me', isHost: false, roomCode: 'the-host' });
    const seen = await page.evaluate(() => {
      localStorage.setItem(CHAT_LOG_KEY, JSON.stringify({
        roomCode: 'the-host',
        savedAt: Date.now() - REJOIN_TTL_MS - 1000,
        messages: [{ id: 'other:1', peerId: 'other', text: 'stale', at: 1, reactions: {} }],
      }));
      resetChatState();
      loadChatLog('the-host');
      return { length: chatLog.length, stored: localStorage.getItem(CHAT_LOG_KEY) };
    });
    expect(seen.length).toBe(0);
    expect(seen.stored).toBeNull();
  });
});

test.describe('sending', () => {
  test('a non-host holds its message until the host echoes it', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'me',
      isHost: false,
      roomCode: 'the-host',
      connections: [{ id: 'the-host', pseudo: 'Host' }],
    });
    const seen = await page.evaluate(() => {
      resetChatState();
      const sent = [];
      connections.get('the-host').data.send = (m) => sent.push(m);
      sendChatMessage('  hello  ');
      return { sent, pending: Array.from(_chatPending.values()), log: chatLog.length };
    });
    expect(seen.sent).toHaveLength(1);
    expect(seen.sent[0]).toMatchObject({ type: 'chat', text: 'hello' });
    expect(seen.pending).toHaveLength(1);
    // Not in the transcript yet: it is on the wire, not in the room.
    expect(seen.log).toBe(0);
  });

  test('an empty message is not sent', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'me',
      isHost: false,
      roomCode: 'the-host',
      connections: [{ id: 'the-host', pseudo: 'Host' }],
    });
    const sent = await page.evaluate(() => {
      resetChatState();
      const out = [];
      connections.get('the-host').data.send = (m) => out.push(m);
      sendChatMessage('   \n  ');
      sendChatMessage('');
      return out;
    });
    expect(sent).toHaveLength(0);
  });

  test('anything unacked goes out again after a migration', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'me',
      isHost: false,
      roomCode: 'new-host',
      connections: [{ id: 'new-host', pseudo: 'NewHost' }],
    });
    const sent = await page.evaluate(() => {
      resetChatState();
      const out = [];
      connections.get('new-host').data.send = (m) => out.push(m);
      _chatPending.set('me:1', { id: 'me:1', text: 'in flight' });
      resendPendingChat();
      return out;
    });
    expect(sent).toEqual([{ type: 'chat', id: 'me:1', text: 'in flight' }]);
  });

  test('a body longer than the cap is clamped, not dropped', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'me',
      isHost: false,
      roomCode: 'the-host',
      connections: [{ id: 'the-host', pseudo: 'Host' }],
    });
    const length = await page.evaluate(() => {
      resetChatState();
      let seen = null;
      connections.get('the-host').data.send = (m) => { seen = m; };
      sendChatMessage('x'.repeat(CHAT_TEXT_MAX + 500));
      return seen.text.length;
    });
    expect(length).toBe(2000);
  });
});

test.describe('the panel', () => {
  test.beforeEach(async ({ page }) => {
    await seedRoom(page, {
      selfId: 'me',
      isHost: false,
      roomCode: 'the-host',
      connections: [{ id: 'the-host', pseudo: 'Host' }],
    });
    await page.evaluate(() => { resetChatState(); toggleChatPanel(false); });
  });

  test('a message that arrives while the panel is shut counts as unread', async ({ page }) => {
    const seen = await page.evaluate(() => {
      handleHostMessage({ type: 'chat', id: 'other:1', peerId: 'other', text: 'hi', at: 1 });
      const closed = _chatUnread;
      toggleChatPanel(true);
      return { closed, opened: _chatUnread };
    });
    expect(seen.closed).toBe(1);
    expect(seen.opened).toBe(0);
  });

  test('your own message never counts as unread', async ({ page }) => {
    const unread = await page.evaluate(() => {
      handleHostMessage({ type: 'chat', id: 'me:1', peerId: 'me', text: 'mine', at: 1 });
      return _chatUnread;
    });
    expect(unread).toBe(0);
  });

  test('opening the chat closes the roster — a phone fits one of them', async ({ page }) => {
    const seen = await page.evaluate(() => {
      setStagePanel('roster', true);
      const rosterFirst = document.body.classList.contains('stage-roster-open');
      toggleChatPanel(true);
      const afterChat = document.body.classList.contains('stage-roster-open');
      setStagePanel('roster', true);
      return { rosterFirst, afterChat, chatAfterRoster: document.body.classList.contains('chat-open') };
    });
    expect(seen).toEqual({ rosterFirst: true, afterChat: false, chatAfterRoster: false });
  });

  test('a focused composer takes the keyboard away from push-to-talk', async ({ page }) => {
    const ignored = await page.evaluate(async () => {
      showScreen('room');   // the composer is only focusable on the live screen
      toggleChatPanel(true);
      document.getElementById('chat-input').focus();
      return shouldIgnorePTTShortcuts();
    });
    expect(ignored).toBe(true);
  });
});
