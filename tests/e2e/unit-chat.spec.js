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

test.describe('the transcript on screen', () => {
  const seed = (page) => seedRoom(page, {
    selfId: 'me', isHost: false, roomCode: 'the-host', myPseudo: 'Me',
    connections: [{ id: 'the-host', pseudo: 'Host' }, { id: 'other', pseudo: 'Alice' }],
  });

  test('a name and its message are one line, with no stamp on the row', async ({ page }) => {
    await seed(page);
    const seen = await page.evaluate(() => {
      resetChatState();
      appendChatMessage({ id: 'other:1', peerId: 'other', text: 'hi', at: Date.now() }, { quiet: true });
      renderChat();
      const row = document.querySelector('#chat-messages .chat-msg');
      return {
        line: row.querySelector('.chat-msg-line').textContent,
        // The separator above already says when this stretch happened; a stamp
        // on every row is what made the column mostly chrome.
        anyTime: !!row.querySelector('time'),
        // It is still one hover away.
        title: row.title,
        react: !!row.querySelector('.chat-msg-tools .chat-react-open'),
        // An icon, not an emoji — the button is not one of the things it offers.
        reactIsIcon: !!row.querySelector('.chat-react-open svg'),
      };
    });
    expect(seen.line).toBe('Alice hi');
    expect(seen.anyTime).toBe(false);
    expect(seen.title).toBeTruthy();
    expect(seen.react).toBe(true);
    expect(seen.reactIsIcon).toBe(true);
  });

  test('a run from one person names them once', async ({ page }) => {
    await seed(page);
    const seen = await page.evaluate(() => {
      resetChatState();
      const now = Date.now();
      appendChatMessage({ id: 'other:1', peerId: 'other', text: 'one', at: now - 1000 }, { quiet: true });
      appendChatMessage({ id: 'other:2', peerId: 'other', text: 'two', at: now }, { quiet: true });
      appendChatMessage({ id: 'the-host:1', peerId: 'the-host', text: 'three', at: now }, { quiet: true });
      renderChat();
      return Array.from(document.querySelectorAll('#chat-messages .chat-msg')).map((row) => ({
        text: row.querySelector('.chat-msg-body').textContent,
        // Still in the DOM for a screen reader; only the repetition is hidden.
        repeat: row.querySelector('.chat-msg-author').classList.contains('chat-msg-author-repeat'),
      }));
    });
    expect(seen).toEqual([
      { text: 'one', repeat: false },
      { text: 'two', repeat: true },
      { text: 'three', repeat: false },
    ]);
  });

  test('a long pause and a new day each get a separator', async ({ page }) => {
    await seed(page);
    const labels = await page.evaluate(() => {
      resetChatState();
      const now = Date.now();
      appendChatMessage({ id: 'other:1', peerId: 'other', text: 'yesterday', at: now - 26 * 3600 * 1000 }, { quiet: true });
      appendChatMessage({ id: 'other:2', peerId: 'other', text: 'after a pause', at: now - CHAT_BREAK_MS - 1000 }, { quiet: true });
      appendChatMessage({ id: 'other:3', peerId: 'other', text: 'right after', at: now }, { quiet: true });
      appendChatMessage({ id: 'other:4', peerId: 'other', text: 'and again', at: now + 1000 }, { quiet: true });
      renderChat();
      return Array.from(document.querySelectorAll('#chat-messages .chat-break')).map((b) => b.textContent);
    });
    // One to open the transcript, one for the day change, one for the pause —
    // and none for the message that followed straight on.
    expect(labels).toHaveLength(3);
    expect(labels[0]).toContain('Yesterday');
  });

  test('a reaction row only exists once there is a reaction', async ({ page }) => {
    await seed(page);
    const seen = await page.evaluate(() => {
      resetChatState();
      appendChatMessage({ id: 'other:1', peerId: 'other', text: 'hi', at: Date.now() }, { quiet: true });
      renderChat();
      const before = !!document.querySelector('#chat-messages .chat-msg-foot');
      applyChatReaction('other:1', CHAT_REACTIONS[0], 'p1');
      renderChat();
      return { before, after: !!document.querySelector('#chat-messages .chat-msg-foot') };
    });
    expect(seen).toEqual({ before: false, after: true });
  });
});

test.describe('the composer', () => {
  test.beforeEach(async ({ page }) => {
    await seedRoom(page, {
      selfId: 'me', isHost: false, roomCode: 'the-host',
      connections: [{ id: 'the-host', pseudo: 'Host' }],
    });
    await page.evaluate(() => { showScreen('room'); resetChatState(); toggleChatPanel(true); });
  });

  test('an empty composer has no scrollbar, a long one does', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const input = document.getElementById('chat-input');
      input.value = '';
      autoGrowChatInput(input);
      const empty = input.style.overflowY;
      input.value = Array.from({ length: 40 }, (_, i) => 'line ' + i).join('\n');
      autoGrowChatInput(input);
      return { empty, full: input.style.overflowY, height: parseInt(input.style.height, 10) };
    });
    expect(seen.empty).toBe('hidden');
    expect(seen.full).toBe('auto');
    expect(seen.height).toBe(120);
  });
});

test.describe('the emoji picker', () => {
  const ROCKET = '\u{1F680}';

  test.beforeEach(async ({ page }) => {
    await seedRoom(page, {
      selfId: 'me', isHost: false, roomCode: 'the-host',
      connections: [{ id: 'the-host', pseudo: 'Host' }],
    });
    await page.evaluate(() => {
      showScreen('room');
      resetChatState();
      localStorage.removeItem(EMOJI_RECENT_KEY);
      toggleChatPanel(true);
    });
  });

  test('the catalog loaded, and any emoji in it may be a reaction', async ({ page }) => {
    const seen = await page.evaluate((rocket) => ({
      groups: emojiCatalog().length,
      total: emojiCatalog().reduce((n, g) => n + g.items.length, 0),
      // Not one of the six seeds: the picker is an offer, not a whitelist.
      rocket: isChatEmoji(rocket),
      seed: isChatEmoji(CHAT_REACTIONS[0]),
      markup: isChatEmoji('<script>'),
      sentence: isChatEmoji(rocket + ' and some words'),
      empty: isChatEmoji(''),
    }), ROCKET);
    expect(seen.groups).toBe(9);
    expect(seen.total).toBeGreaterThan(1800);
    expect(seen).toMatchObject({ rocket: true, seed: true, markup: false, sentence: false, empty: false });
  });

  test('search finds an emoji by its Unicode name', async ({ page }) => {
    const first = await page.evaluate(() => {
      openEmojiPicker({ mode: 'compose' });
      renderEmojiGrid('rocket');
      const cell = document.querySelector('#emoji-grid .emoji-cell');
      return { emoji: cell && cell.dataset.emoji, label: cell && cell.title };
    });
    expect(first.emoji).toBe(ROCKET);
    expect(first.label).toContain('rocket');
  });

  test('picking inserts at the caret, not at the end', async ({ page }) => {
    const value = await page.evaluate((rocket) => {
      const input = document.getElementById('chat-input');
      input.value = 'ab';
      input.focus();
      input.setSelectionRange(1, 1);
      openEmojiPicker({ mode: 'compose' });
      chooseEmoji(rocket);
      return input.value;
    }, ROCKET);
    expect(value).toBe('a' + ROCKET + 'b');
  });

  test('picking in react mode sends a reaction and closes', async ({ page }) => {
    const seen = await page.evaluate((rocket) => {
      appendChatMessage({ id: 'other:1', peerId: 'other', text: 'hi', at: Date.now() }, { quiet: true });
      const sent = [];
      connections.get('the-host').data.send = (m) => sent.push(m);
      openEmojiPicker({ mode: 'react', msgId: 'other:1' });
      chooseEmoji(rocket);
      return { sent, open: emojiPickerOpen() };
    }, ROCKET);
    expect(seen.open).toBe(false);
    expect(seen.sent).toEqual([{ type: 'chat-react', msgId: 'other:1', emoji: ROCKET }]);
  });

  test('a click outside dismisses the picker, but the button that opened it toggles', async ({ page }) => {
    await page.evaluate(() => { document.getElementById('chat-messages').style.minHeight = '120px'; });
    await page.click('#btn-emoji');
    expect(await page.evaluate(() => emojiPickerOpen())).toBe(true);
    // The same button again closes it rather than reopening.
    await page.click('#btn-emoji');
    expect(await page.evaluate(() => emojiPickerOpen())).toBe(false);

    await page.click('#btn-emoji');
    await page.click('#chat-messages');
    expect(await page.evaluate(() => emojiPickerOpen())).toBe(false);
  });

  test('what you picked comes back at the top of Recent', async ({ page }) => {
    const recent = await page.evaluate((rocket) => {
      openEmojiPicker({ mode: 'compose' });
      chooseEmoji(rocket);
      return readRecentEmoji();
    }, ROCKET);
    expect(recent[0]).toBe(ROCKET);
    // The seeds stay behind it rather than the list starting empty.
    expect(recent).toContain('\u{1F44D}');
  });
});

test.describe('the drawer\'s width', () => {
  test.beforeEach(async ({ page }) => {
    await seedRoom(page, {
      selfId: 'me', isHost: false, roomCode: 'the-host',
      connections: [{ id: 'the-host', pseudo: 'Host' }],
    });
    await page.evaluate(() => { showScreen('room'); toggleChatPanel(true); });
  });

  test('a stored width is applied, and an absurd one is clamped', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const read = (px) => { localStorage.setItem(CHAT_WIDTH_KEY, String(px)); return readChatWidth(); };
      return {
        normal: read(420),
        tiny: read(10),
        huge: read(99999),
        junk: (localStorage.setItem(CHAT_WIDTH_KEY, 'wide'), readChatWidth()),
        min: CHAT_WIDTH_MIN,
        max: CHAT_WIDTH_MAX,
        def: CHAT_WIDTH_DEFAULT,
      };
    });
    expect(seen.normal).toBe(420);
    expect(seen.tiny).toBe(seen.min);
    expect(seen.huge).toBeLessThanOrEqual(seen.max);
    expect(seen.junk).toBe(seen.def);
  });

  test('nudging the separator moves the drawer and remembers it', async ({ page }) => {
    const seen = await page.evaluate(() => {
      applyChatWidth(400);
      saveChatWidth(400);
      nudgeChatWidth(24);
      return {
        widened: document.getElementById('room-chat-panel').getBoundingClientRect().width,
        stored: Number(localStorage.getItem(CHAT_WIDTH_KEY)),
      };
    });
    expect(seen.widened).toBe(424);
    expect(seen.stored).toBe(424);
  });

  test('dragging the separator resizes the drawer and persists on release', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 760 });
    await page.evaluate(() => { applyChatWidth(360); saveChatWidth(360); });
    const grip = page.locator('#chat-resizer');
    const box = await grip.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // Drag left: the drawer's left edge moves left, so the drawer gets wider.
    await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2, { steps: 6 });
    const during = await page.evaluate(() => document.getElementById('room-chat-panel').getBoundingClientRect().width);
    await page.mouse.up();
    const after = await page.evaluate(() => ({
      width: document.getElementById('room-chat-panel').getBoundingClientRect().width,
      stored: Number(localStorage.getItem(CHAT_WIDTH_KEY)),
      dragging: document.body.classList.contains('chat-resizing'),
    }));
    expect(during).toBeGreaterThan(400);
    expect(after.width).toBe(during);
    expect(after.stored).toBe(during);
    expect(after.dragging).toBe(false);
  });

  test('double-clicking the separator puts it back', async ({ page }) => {
    await page.evaluate(() => { applyChatWidth(600); saveChatWidth(600); });
    await page.dblclick('#chat-resizer');
    const seen = await page.evaluate(() => ({
      width: document.getElementById('room-chat-panel').getBoundingClientRect().width,
      def: CHAT_WIDTH_DEFAULT,
    }));
    expect(seen.width).toBe(seen.def);
  });

  test('a window narrower than the stored width does not leave the drawer hanging off', async ({ page }) => {
    await page.evaluate(() => { applyChatWidth(700); saveChatWidth(700); });
    await page.setViewportSize({ width: 700, height: 700 });
    const width = await page.evaluate(() => {
      applyChatWidth(readChatWidth());
      return document.getElementById('room-chat-panel').getBoundingClientRect().width;
    });
    expect(width).toBeLessThanOrEqual(700);
  });
});

test.describe('the peek over the call', () => {
  test.beforeEach(async ({ page }) => {
    await seedRoom(page, {
      selfId: 'me', isHost: false, roomCode: 'the-host',
      connections: [{ id: 'the-host', pseudo: 'Host' }, { id: 'other', pseudo: 'Alice' }],
    });
    await page.evaluate(() => { showScreen('room'); resetChatState(); toggleChatPanel(false); });
  });

  const peeks = (page) => page.evaluate(() =>
    Array.from(document.querySelectorAll('#chat-peek .chat-peek-item')).map((el) => el.textContent));

  test('a message arriving with the panel shut surfaces briefly', async ({ page }) => {
    await page.evaluate(() => {
      handleHostMessage({ type: 'chat', id: 'other:1', peerId: 'other', text: 'over here', at: Date.now() });
    });
    expect(await peeks(page)).toEqual(['Alice over here']);
  });

  test('nothing peeks while the panel is showing the same thing', async ({ page }) => {
    await page.evaluate(() => {
      toggleChatPanel(true);
      handleHostMessage({ type: 'chat', id: 'other:1', peerId: 'other', text: 'seen', at: Date.now() });
    });
    expect(await peeks(page)).toEqual([]);
  });

  test('your own message never peeks', async ({ page }) => {
    await page.evaluate(() => {
      handleHostMessage({ type: 'chat', id: 'me:1', peerId: 'me', text: 'mine', at: Date.now() });
    });
    expect(await peeks(page)).toEqual([]);
  });

  test('it is a glance, not a second transcript', async ({ page }) => {
    const seen = await page.evaluate(() => {
      for (let i = 0; i < CHAT_PEEK_MAX + 3; i++) {
        handleHostMessage({ type: 'chat', id: 'other:' + i, peerId: 'other', text: 'm' + i, at: Date.now() });
      }
      return {
        count: document.querySelectorAll('#chat-peek .chat-peek-item').length,
        max: CHAT_PEEK_MAX,
        // The oldest fall off the top, so what is left is the newest.
        last: document.querySelector('#chat-peek .chat-peek-item:last-child').textContent,
      };
    });
    expect(seen.count).toBe(seen.max);
    expect(seen.last).toBe('Alice m' + (seen.max + 2));
  });

  test('opening the chat takes the peek away with it', async ({ page }) => {
    const seen = await page.evaluate(() => {
      handleHostMessage({ type: 'chat', id: 'other:1', peerId: 'other', text: 'hi', at: Date.now() });
      const before = document.querySelectorAll('#chat-peek .chat-peek-item').length;
      toggleChatPanel(true);
      return { before, after: document.querySelectorAll('#chat-peek .chat-peek-item').length };
    });
    expect(seen).toEqual({ before: 1, after: 0 });
  });
});

test.describe('the chat as a column of the room', () => {
  test.beforeEach(async ({ page }) => {
    await seedRoom(page, {
      selfId: 'me', isHost: false, roomCode: 'the-host',
      connections: [{ id: 'the-host', pseudo: 'Host' }],
    });
    await page.evaluate(() => { showScreen('room'); resetChatState(); });
  });

  test('the only way in is the edge handle, in a voice room as much as a video one', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const handle = document.getElementById('stage-handle-chat');
      return {
        // No button in the header and none among the call controls: the handle
        // is on the right edge of every room, whether or not a camera is live.
        inHeader: !!document.querySelector('#screen-room .room-header #btn-chat'),
        inControls: !!document.querySelector('#screen-room .room-controls #btn-chat'),
        onScreen: getComputedStyle(handle).display,
        badgeInside: !!handle.querySelector('.chat-unread'),
        // Leave is not the tail of the room-code controls.
        leaveSpacer: !!document.querySelector('#screen-room .room-actions .room-actions-spacer'),
      };
    });
    expect(seen).toEqual({
      inHeader: false, inControls: false, onScreen: 'flex', badgeInside: true, leaveSpacer: true,
    });
  });

  test('the unread count rides on that handle and clears when the chat opens', async ({ page }) => {
    await page.evaluate(() => toggleChatPanel(false));
    const shut = await page.evaluate(() => {
      handleHostMessage({ type: 'chat', id: 'other:1', peerId: 'other', text: 'one', at: Date.now() });
      handleHostMessage({ type: 'chat', id: 'other:2', peerId: 'other', text: 'two', at: Date.now() });
      const badge = document.querySelector('#stage-handle-chat .chat-unread');
      return { text: badge.textContent, hidden: badge.classList.contains('hidden') };
    });
    expect(shut).toEqual({ text: '2', hidden: false });

    const opened = await page.evaluate(() => {
      toggleChatPanel(true);
      const badge = document.querySelector('#stage-handle-chat .chat-unread');
      return { text: badge.textContent, hidden: badge.classList.contains('hidden') };
    });
    expect(opened).toEqual({ text: '0', hidden: true });
  });

  test('a wide room with a live stage docks it beside the participants', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 });
    const seen = await page.evaluate(() => {
      // Stand in for a live camera: updateVideoStage() publishes this class, and
      // applyChatDock() is what reads it.
      document.body.classList.add('video-stage');
      applyChatDock();
      const shut = chatPanelOpen();
      toggleChatPanel(true);
      const panel = document.getElementById('room-chat-panel');
      const roster = document.getElementById('room-peers-panel').getBoundingClientRect();
      return {
        docked: document.body.classList.contains('chat-docked'),
        // Docking decides WHERE an open chat goes, never whether it is open: a
        // call must not hand a third of the stage to a conversation nobody has
        // started.
        openedItself: shut,
        // In the flow, not floating over the room…
        transform: getComputedStyle(panel).transform,
        position: getComputedStyle(panel).position,
        // …on the far side of the room from the participants. (That the stage
        // itself sits between them is unit-video-stage.spec.js's assertion; no
        // camera is live here, so it has no box to measure.)
        oppositeTheRoster: panel.getBoundingClientRect().left > roster.right,
      };
    });
    expect(seen.docked).toBe(true);
    expect(seen.openedItself).toBe(false);
    expect(seen.oppositeTheRoster).toBe(true);
    expect(seen.position).toBe('relative');
    expect(seen.transform === 'none' || seen.transform === 'matrix(1, 0, 0, 1, 0, 0)').toBe(true);
  });

  test('a narrow room keeps it a drawer', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    const docked = await page.evaluate(() => {
      document.body.classList.add('video-stage');
      applyChatDock();
      return document.body.classList.contains('chat-docked');
    });
    expect(docked).toBe(false);
  });

  test('the phone stage never docks it — there is one column to have', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 });
    const docked = await page.evaluate(() => {
      document.body.classList.add('video-stage', 'video-stage-immersive');
      applyChatDock();
      return document.body.classList.contains('chat-docked');
    });
    expect(docked).toBe(false);
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
