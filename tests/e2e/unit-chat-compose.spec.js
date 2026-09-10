import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// The composer's own language: answering a message, naming a person, typing an
// emoji by its name, and reacting without leaving the box. Plus the two things
// a body can turn into that are not text — a mention and a gesture.

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await seedRoom(page, {
    selfId: 'me',
    isHost: false,
    roomCode: 'the-host',
    myPseudo: 'Me',
    connections: [
      { id: 'the-host', pseudo: 'Host' },
      { id: 'other', pseudo: 'Alice' },
      { id: 'third', pseudo: 'Ana Lucia' },
    ],
  });
  await page.evaluate(() => {
    showScreen('room');
    resetChatState();
    updatePeerList();
    toggleChatPanel(true, { focus: false });
  });
});

const say = (page, id, text, extra = {}) => page.evaluate(({ id, text, extra }) => {
  handleHostMessage(Object.assign(
    { type: 'chat', id, peerId: id.split(':')[0], text, at: Date.now() }, extra));
}, { id, text, extra });

const compose = (page, text) => page.evaluate((t) => {
  const input = document.getElementById('chat-input');
  input.value = t;
  input.setSelectionRange(t.length, t.length);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}, text);

test.describe('answering a message', () => {
  test('the reply is carried on the wire and drawn as a quote', async ({ page }) => {
    await say(page, 'other:1', 'the original');
    const seen = await page.evaluate(() => {
      const out = [];
      connections.get('the-host').data.send = (m) => out.push(m);
      setChatReplyTo('other:1');
      const bar = document.getElementById('chat-reply-bar');
      const barText = bar.textContent;
      document.getElementById('chat-input').value = 'the answer';
      submitChatInput();
      // The host echoes it back, which is what puts it in the transcript.
      handleHostMessage({ type: 'chat', id: out[0].id, peerId: 'me',
                          text: out[0].text, replyTo: out[0].replyTo, at: Date.now() });
      const row = Array.from(document.querySelectorAll('.chat-msg'))
        .find((el) => el.dataset.msgId === out[0].id);
      return {
        wire: out[0].replyTo,
        bar: barText,
        // The strip is put away by the send: the next message is not a reply.
        barGone: bar.classList.contains('hidden'),
        stored: chatLog[chatLog.length - 1].replyTo,
        quote: row.querySelector('.chat-quote').textContent,
      };
    });
    expect(seen.wire).toBe('other:1');
    expect(seen.bar).toContain('Alice');
    expect(seen.barGone).toBe(true);
    expect(seen.stored).toBe('other:1');
    expect(seen.quote).toBe('Alicethe original');
  });

  test('a reply always names its author, even mid-run', async ({ page }) => {
    const named = await page.evaluate(() => {
      const at = Date.now();
      handleHostMessage({ type: 'chat', id: 'other:1', peerId: 'other', text: 'one', at });
      handleHostMessage({ type: 'chat', id: 'other:2', peerId: 'other', text: 'two', at: at + 10 });
      handleHostMessage({ type: 'chat', id: 'other:3', peerId: 'other', text: 'three',
                          at: at + 20, replyTo: 'other:1' });
      return Array.from(document.querySelectorAll('.chat-msg')).map(
        (el) => !el.querySelector('.chat-msg-author').classList.contains('chat-msg-author-repeat'));
    });
    expect(named).toEqual([true, false, true]);
  });

  test('a quote for a message that is gone says so rather than vanishing', async ({ page }) => {
    const text = await page.evaluate(() => {
      handleHostMessage({ type: 'chat', id: 'other:9', peerId: 'other', text: 'an answer',
                          at: Date.now(), replyTo: 'other:long-gone' });
      const q = document.querySelector('.chat-quote');
      return { text: q.textContent, disabled: q.disabled };
    });
    expect(text).toEqual({ text: 'Message no longer available', disabled: true });
  });

  test('a reply whose target is no longer held is sent as a plain message', async ({ page }) => {
    const wire = await page.evaluate(() => {
      const out = [];
      connections.get('the-host').data.send = (m) => out.push(m);
      sendChatMessage('hello', { replyTo: 'other:never-existed' });
      return out[0].replyTo;
    });
    expect(wire).toBe(null);
  });

  test('the up arrow on an empty composer answers the last thing said', async ({ page }) => {
    await say(page, 'other:1', 'the last word');
    await page.focus('#chat-input');
    await page.keyboard.press('ArrowUp');
    expect(await page.textContent('#chat-reply-bar')).toContain('the last word');
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() =>
      document.getElementById('chat-reply-bar').classList.contains('hidden'))).toBe(true);
  });

  test('the quote is the way back to what is being answered', async ({ page }) => {
    const flashed = await page.evaluate(() => {
      handleHostMessage({ type: 'chat', id: 'other:1', peerId: 'other', text: 'first', at: Date.now() });
      handleHostMessage({ type: 'chat', id: 'other:2', peerId: 'other', text: 'second',
                          at: Date.now(), replyTo: 'other:1' });
      document.querySelector('.chat-msg[data-msg-id="other:2"] .chat-quote').click();
      const row = Array.from(document.querySelectorAll('.chat-msg'))
        .find((el) => el.dataset.msgId === 'other:1');
      return row.classList.contains('chat-msg-flash');
    });
    expect(flashed).toBe(true);
  });
});

test.describe('naming somebody', () => {
  test('a name in a body is highlighted, and yours is marked as yours', async ({ page }) => {
    const seen = await page.evaluate(() => {
      handleHostMessage({ type: 'chat', id: 'other:1', peerId: 'other',
                          text: 'ping @Me and @Alice', at: Date.now() });
      const row = document.querySelector('.chat-msg[data-msg-id="other:1"]');
      return {
        marks: Array.from(row.querySelectorAll('.chat-mention')).map((el) => el.textContent),
        mine: Array.from(row.querySelectorAll('.chat-mention-me')).map((el) => el.textContent),
        addressed: row.classList.contains('chat-msg-mention'),
      };
    });
    expect(seen.marks).toEqual(['@Me', '@Alice']);
    expect(seen.mine).toEqual(['@Me']);
    expect(seen.addressed).toBe(true);
  });

  test('the longest name wins, so a name with a space is one mention', async ({ page }) => {
    const marks = await page.evaluate(() => {
      handleHostMessage({ type: 'chat', id: 'other:1', peerId: 'other',
                          text: 'hi @Ana Lucia', at: Date.now() });
      // Scoped to the transcript: the same body is also on screen as a peek.
      return Array.from(document.querySelectorAll('.chat-msg .chat-mention')).map((el) => el.textContent);
    });
    expect(marks).toEqual(['@Ana Lucia']);
  });

  test('an address is not a mention', async ({ page }) => {
    const marks = await page.evaluate(() => {
      handleHostMessage({ type: 'chat', id: 'other:1', peerId: 'other',
                          text: 'write to alice@Alice.example', at: Date.now() });
      return document.querySelectorAll('.chat-msg .chat-mention').length;
    });
    expect(marks).toBe(0);
  });

  test('a name inside a link stays part of the link', async ({ page }) => {
    const seen = await page.evaluate(() => {
      handleHostMessage({ type: 'chat', id: 'other:1', peerId: 'other',
                          text: 'https://example.com/@Alice/page', at: Date.now() });
      const row = document.querySelector('.chat-msg[data-msg-id="other:1"]');
      return { links: row.querySelectorAll('a').length, mentions: row.querySelectorAll('.chat-mention').length };
    });
    expect(seen).toEqual({ links: 1, mentions: 0 });
  });

  test('@ offers the room, and picking one writes the whole name', async ({ page }) => {
    await compose(page, 'hey @An');
    const offered = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#chat-suggest .chat-suggest-item .chat-suggest-label'))
        .map((el) => el.textContent));
    expect(offered).toEqual(['Ana Lucia']);
    const value = await page.evaluate(() => { acceptChatSuggest(); return document.getElementById('chat-input').value; });
    expect(value).toBe('hey @Ana Lucia ');
  });

  test('your own name is never offered — you are not someone to notify', async ({ page }) => {
    await compose(page, '@');
    const offered = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#chat-suggest .chat-suggest-label')).map((el) => el.textContent));
    expect(offered).not.toContain('Me');
    expect(offered).toContain('Alice');
  });
});

test.describe('typing an emoji by name', () => {
  test('nothing is offered until two characters follow the colon', async ({ page }) => {
    await compose(page, 'well :t');
    expect(await page.evaluate(() => chatSuggestOpen())).toBe(false);
    await compose(page, 'well :ta');
    expect(await page.evaluate(() => chatSuggestOpen())).toBe(true);
  });

  test('a colon inside a word is a colon, not a menu', async ({ page }) => {
    await compose(page, 'at 12:30');
    expect(await page.evaluate(() => chatSuggestOpen())).toBe(false);
  });

  test('picking one replaces the shortcode with the emoji', async ({ page }) => {
    await compose(page, 'ship it :party_pop');
    const value = await page.evaluate(() => {
      acceptChatSuggest();
      return document.getElementById('chat-input').value;
    });
    expect(value).toBe('ship it \u{1F389} ');
  });

  test('the shortest name that starts with what was typed comes first', async ({ page }) => {
    const first = await page.evaluate(() => emojiShortcodeMatches('smil', 8)[0][1]);
    expect(first.startsWith('smil')).toBe(true);
    expect(first.length).toBeLessThanOrEqual('smiling_face'.length);
  });

  test('a shortcode resolves to exactly one emoji', async ({ page }) => {
    expect(await page.evaluate(() => emojiForShortcode('party_popper'))).toBe('\u{1F389}');
    expect(await page.evaluate(() => emojiForShortcode('not_an_emoji_at_all'))).toBe(null);
  });
});

test.describe('reacting from the composer', () => {
  test('+:shortcode reacts to the last message instead of sending one', async ({ page }) => {
    await say(page, 'other:1', 'the last word');
    const seen = await page.evaluate(() => {
      const out = [];
      connections.get('the-host').data.send = (m) => out.push(m);
      const input = document.getElementById('chat-input');
      input.value = '+:party_popper';
      submitChatInput();
      return { sent: out, value: input.value, log: chatLog.length };
    });
    expect(seen.sent).toEqual([{ type: 'chat-react', msgId: 'other:1', emoji: '\u{1F389}' }]);
    expect(seen.value).toBe('');
    expect(seen.log).toBe(1);
  });

  test('the emoji itself works too, and the trailing colon is optional', async ({ page }) => {
    expect(await page.evaluate(() => chatQuickReactionFor('+\u{1F44D}'))).toBe('\u{1F44D}');
    // The catalog is Unicode's own names, so a shortcode is a Unicode name —
    // there are no Slack-style aliases to look up.
    expect(await page.evaluate(() => chatQuickReactionFor('+:party_popper:'))).toBe('\u{1F389}');
    expect(await page.evaluate(() => chatQuickReactionFor('+1 for that'))).toBe(null);
    expect(await page.evaluate(() => chatQuickReactionFor('plus'))).toBe(null);
  });

  test('with nothing to react to it is sent as the message it looks like', async ({ page }) => {
    const sent = await page.evaluate(() => {
      const out = [];
      connections.get('the-host').data.send = (m) => out.push(m);
      document.getElementById('chat-input').value = '+:party_popper';
      submitChatInput();
      return out;
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('chat');
  });
});

test.describe('a message that is only emoji', () => {
  test('one gesture is printed large', async ({ page }) => {
    const seen = await page.evaluate(() => {
      handleHostMessage({ type: 'chat', id: 'other:1', peerId: 'other', text: '\u{1F44D}', at: Date.now() });
      const row = document.querySelector('.chat-msg[data-msg-id="other:1"]');
      return {
        jumbo: row.classList.contains('chat-msg-jumbo'),
        size: parseFloat(getComputedStyle(row.querySelector('.chat-msg-body')).fontSize),
      };
    });
    expect(seen.jumbo).toBe(true);
    expect(seen.size).toBeGreaterThan(20);
  });

  test('a sentence written in emoji goes back to the normal size', async ({ page }) => {
    expect(await page.evaluate(() => chatIsJumbo('\u{1F44D}\u{1F389}❤️'))).toBe(true);
    expect(await page.evaluate(() => chatIsJumbo('\u{1F44D}\u{1F389}❤️\u{1F440}'))).toBe(false);
    expect(await page.evaluate(() => chatIsJumbo('\u{1F44D} nice'))).toBe(false);
    expect(await page.evaluate(() => chatIsJumbo('hello'))).toBe(false);
  });

  test('a joined family counts as the one glyph it draws', async ({ page }) => {
    expect(await page.evaluate(() => chatEmojiOnlyCount('\u{1F468}‍\u{1F469}‍\u{1F467}'))).toBe(1);
  });
});

// --- Correcting what you said ------------------------------------------------
//
// A message stays yours for five minutes. The gesture is the up arrow, which
// answered the last thing ANYONE said before this existed — so the fallback
// matters as much as the new behaviour.

test.describe('editing your own last message', () => {
  const mine = (page, text, ageMs = 0) => page.evaluate(({ text, ageMs }) => {
    handleHostMessage({ type: 'chat', id: 'me:1', peerId: 'me', text,
                        at: Date.now() - ageMs });
  }, { text, ageMs });

  test('the up arrow loads your last message into the composer', async ({ page }) => {
    await mine(page, 'teh answer');
    await page.focus('#chat-input');
    await page.keyboard.press('ArrowUp');
    expect(await page.inputValue('#chat-input')).toBe('teh answer');
    expect(await page.evaluate(() =>
      document.getElementById('chat-edit-bar').classList.contains('hidden'))).toBe(false);
  });

  test('sending replaces the line rather than adding one', async ({ page }) => {
    await mine(page, 'teh answer');
    const seen = await page.evaluate(() => {
      const out = [];
      connections.get('the-host').data.send = (m) => out.push(m);
      setChatEditing('me:1');
      document.getElementById('chat-input').value = 'the answer';
      submitChatInput();
      // The host is the one that stamps it, exactly as for a new message.
      handleHostMessage({ type: 'chat-edit', msgId: 'me:1', text: out[0].text,
                          peerId: 'me', editedAt: Date.now() });
      return {
        wire: out[0],
        rows: document.querySelectorAll('.chat-msg').length,
        text: chatLog[0].text,
        marked: !!document.querySelector('.chat-msg[data-msg-id="me:1"] .chat-msg-edited'),
        box: document.getElementById('chat-input').value,
        barGone: document.getElementById('chat-edit-bar').classList.contains('hidden'),
      };
    });
    expect(seen.wire).toEqual({ type: 'chat-edit', msgId: 'me:1', text: 'the answer' });
    expect(seen.rows).toBe(1);
    expect(seen.text).toBe('the answer');
    expect(seen.marked).toBe(true);
    expect(seen.box).toBe('');
    expect(seen.barGone).toBe(true);
  });

  test('Escape abandons the correction and takes its text with it', async ({ page }) => {
    await mine(page, 'as written');
    await page.focus('#chat-input');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Escape');
    expect(await page.inputValue('#chat-input')).toBe('');
    expect(await page.evaluate(() => chatLog[0].text)).toBe('as written');
  });

  test('past the window the arrow falls back to answering', async ({ page }) => {
    await mine(page, 'said six minutes ago', 6 * 60 * 1000);
    await page.focus('#chat-input');
    await page.keyboard.press('ArrowUp');
    expect(await page.inputValue('#chat-input')).toBe('');
    expect(await page.textContent('#chat-reply-bar')).toContain('said six minutes ago');
  });

  test('with nothing of your own it still answers the last thing said', async ({ page }) => {
    await say(page, 'other:1', 'somebody else');
    await page.focus('#chat-input');
    await page.keyboard.press('ArrowUp');
    expect(await page.inputValue('#chat-input')).toBe('');
    expect(await page.textContent('#chat-reply-bar')).toContain('somebody else');
  });

  test('somebody else\'s line is never offered', async ({ page }) => {
    await say(page, 'other:1', 'not yours');
    expect(await page.evaluate(() => setChatEditing('other:1'))).toBe(false);
    expect(await page.evaluate(() =>
      document.querySelector('.chat-msg[data-msg-id="other:1"] .chat-edit-open'))).toBe(null);
  });

  test('an edit for a message the sender did not write is dropped', async ({ page }) => {
    await say(page, 'other:1', 'theirs');
    const after = await page.evaluate(() => {
      // 'me' naming somebody else's id: the host stamps peerId, so this is what
      // a forged request looks like on the receiving side.
      handleHostMessage({ type: 'chat-edit', msgId: 'other:1', text: 'rewritten',
                          peerId: 'me', editedAt: Date.now() });
      return chatLog[0].text;
    });
    expect(after).toBe('theirs');
  });
});

test.describe('the host is where the five minutes are enforced', () => {
  test.beforeEach(async ({ page }) => {
    await page.evaluate(() => {
      isHost = true;
      peer = { id: 'the-host', destroyed: false };
      roomCode = 'the-host';
      resetChatState();
    });
  });

  test('an edit inside the window is fanned out to everyone', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const out = [];
      connections.get('other').data.send = (m) => out.push(m);
      fanOutChatMessage('other', 'other:1', 'teh thing', null);
      fanOutChatEdit('other', 'other:1', 'the thing');
      return { sent: out[out.length - 1], text: chatLog[0].text };
    });
    expect(seen.sent.type).toBe('chat-edit');
    expect(seen.sent.text).toBe('the thing');
    expect(seen.sent.peerId).toBe('other');
    expect(typeof seen.sent.editedAt).toBe('number');
    expect(seen.text).toBe('the thing');
  });

  test('an edit past the window changes nothing and goes nowhere', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const out = [];
      fanOutChatMessage('other', 'other:1', 'long ago', null);
      chatLog[0].at = Date.now() - 6 * 60 * 1000;   // the host's own clock is the judge
      connections.get('other').data.send = (m) => out.push(m);
      fanOutChatEdit('other', 'other:1', 'rewritten');
      return { sent: out.length, text: chatLog[0].text };
    });
    expect(seen).toEqual({ sent: 0, text: 'long ago' });
  });

  test('one peer may not rewrite another\'s line', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const out = [];
      fanOutChatMessage('other', 'other:1', 'theirs', null);
      connections.get('other').data.send = (m) => out.push(m);
      fanOutChatEdit('third', 'other:1', 'rewritten');
      return { sent: out.length, text: chatLog[0].text };
    });
    expect(seen).toEqual({ sent: 0, text: 'theirs' });
  });
});
