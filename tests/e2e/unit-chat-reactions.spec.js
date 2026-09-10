import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// A reaction over the call: the bare glyph at the name that sent it, and the
// flight that says WHICH message it belongs to without a word of text.
//
// Distances are measured from the LAYOUT box (offsetLeft/offsetTop), never from
// getBoundingClientRect: both the flight and the bubble's own pop are transform
// animations, so a rect read mid-animation is not where the element was placed.
// The anchored peek host is a fixed overlay pinned to all four edges, so a
// child's offset box is already in window coordinates.

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await seedRoom(page, {
    selfId: 'me',
    isHost: false,
    roomCode: 'the-host',
    myPseudo: 'Me',
    connections: [{ id: 'the-host', pseudo: 'Host' }, { id: 'other', pseudo: 'Alice' }],
  });
  await page.evaluate(() => {
    showScreen('room');
    resetChatState();
    updatePeerList();
    toggleChatPanel(false);
  });
});

const react = (page, msgId, emoji, peerId) => page.evaluate(({ msgId, emoji, peerId }) => {
  handleHostMessage({ type: 'chat-react', msgId, emoji, peerId });
}, { msgId, emoji, peerId });

const say = (page, id, text) => page.evaluate(({ id, text }) => {
  handleHostMessage({ type: 'chat', id, peerId: id.split(':')[0], text, at: Date.now() });
}, { id, text });

test('a reaction surfaces as the bare glyph, with no bubble and no tail', async ({ page }) => {
  await say(page, 'the-host:1', 'something worth reacting to');
  await react(page, 'the-host:1', '\u{1F389}', 'other');
  const seen = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('#chat-peek .chat-peek-item'))
      .find((x) => x._voxalPeekKind === 'react');
    const style = getComputedStyle(el);
    return {
      glyph: el.querySelector('.chat-peek-react-glyph').textContent,
      from: el._voxalPeekPeerId,
      tailed: el.classList.contains('peek-tail-left') || el.classList.contains('peek-tail-right')
              || el.classList.contains('peek-tail-up'),
      bordered: parseFloat(style.borderTopWidth) > 0,
      // The name is what the position is already saying.
      named: getComputedStyle(el.querySelector('.chat-peek-author')).display !== 'none',
    };
  });
  expect(seen).toEqual({ glyph: '\u{1F389}', from: 'other', tailed: false, bordered: false, named: false });
});

test('it flies to the peek of the message it reacted to', async ({ page }) => {
  await say(page, 'the-host:1', 'the message');
  await react(page, 'the-host:1', '\u{1F389}', 'other');
  const seen = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('#chat-peek .chat-peek-item'));
    const glyph = items.find((x) => x._voxalPeekKind === 'react');
    const bubble = items.find((x) => x._voxalPeekMsgId === 'the-host:1' && x._voxalPeekKind === 'message');
    const centre = (el) => ({ x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop + el.offsetHeight / 2 });
    const g = centre(glyph);
    const b = centre(bubble);
    return {
      flying: glyph.classList.contains('peek-react-fly'),
      hit: bubble.classList.contains('chat-peek-hit'),
      dx: parseFloat(glyph.style.getPropertyValue('--react-fly-x')),
      dy: parseFloat(glyph.style.getPropertyValue('--react-fly-y')),
      wantX: b.x - g.x,
      wantY: b.y - g.y,
    };
  });
  expect(seen.flying).toBe(true);
  expect(seen.hit).toBe(true);
  // offsetLeft is a rounded integer and the distance itself is rounded on the
  // way into the custom property, so a couple of pixels of slack is the
  // measurement, not the placement.
  expect(Math.abs(seen.dx - seen.wantX)).toBeLessThanOrEqual(3);
  expect(Math.abs(seen.dy - seen.wantY)).toBeLessThanOrEqual(3);
});

test('with the panel open it flies to the row in the transcript', async ({ page }) => {
  await page.evaluate(() => { toggleChatPanel(true, { focus: false }); });
  await say(page, 'the-host:1', 'the message');
  // The message's own peek is dropped so the row is the only target left.
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('#chat-peek .chat-peek-item'))
      .filter((el) => el._voxalPeekKind === 'message')
      .forEach(dropChatPeek);
  });
  await react(page, 'the-host:1', '❤️', 'other');
  const seen = await page.evaluate(() => {
    const glyph = Array.from(document.querySelectorAll('#chat-peek .chat-peek-item'))
      .find((x) => x._voxalPeekKind === 'react');
    const row = Array.from(document.querySelectorAll('.chat-msg'))
      .find((el) => el.dataset.msgId === 'the-host:1');
    const r = row.getBoundingClientRect();
    return {
      flying: glyph.classList.contains('peek-react-fly'),
      flashed: row.classList.contains('chat-msg-flash'),
      dx: parseFloat(glyph.style.getPropertyValue('--react-fly-x')),
      wantX: (r.left + r.width / 2) - (glyph.offsetLeft + glyph.offsetWidth / 2),
    };
  });
  expect(seen.flying).toBe(true);
  expect(seen.flashed).toBe(true);
  expect(Math.abs(seen.dx - seen.wantX)).toBeLessThanOrEqual(3);
});

test("with neither on screen it flies to the author's own name", async ({ page }) => {
  await page.evaluate(() => {
    // The message is in the log but nothing of it is on screen: no peek (it was
    // seeded quietly) and the panel is shut.
    appendChatMessage({ id: 'the-host:1', peerId: 'the-host', text: 'older', at: Date.now() }, { quiet: true });
  });
  await react(page, 'the-host:1', '\u{1F44D}', 'other');
  const seen = await page.evaluate(() => {
    const glyph = Array.from(document.querySelectorAll('#chat-peek .chat-peek-item'))
      .find((x) => x._voxalPeekKind === 'react');
    const name = document.querySelector('#peer-item-the-host .peer-name').getBoundingClientRect();
    return {
      flying: glyph.classList.contains('peek-react-fly'),
      dx: parseFloat(glyph.style.getPropertyValue('--react-fly-x')),
      wantX: (name.left + name.width / 2) - (glyph.offsetLeft + glyph.offsetWidth / 2),
    };
  });
  expect(seen.flying).toBe(true);
  expect(Math.abs(seen.dx - seen.wantX)).toBeLessThanOrEqual(3);
});

test('taking a reaction back does not fly anything', async ({ page }) => {
  await say(page, 'the-host:1', 'the message');
  await react(page, 'the-host:1', '\u{1F389}', 'other');
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('#chat-peek .chat-peek-item'))
      .filter((el) => el._voxalPeekKind === 'react')
      .forEach(dropChatPeek);
  });
  await react(page, 'the-host:1', '\u{1F389}', 'other');   // the same one again = undo
  const glyphs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#chat-peek .chat-peek-item'))
      .filter((el) => el._voxalPeekKind === 'react').length);
  expect(glyphs).toBe(0);
});

test('your own reaction is not announced back to you', async ({ page }) => {
  await say(page, 'the-host:1', 'the message');
  await react(page, 'the-host:1', '\u{1F389}', 'me');
  const glyphs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#chat-peek .chat-peek-item'))
      .filter((el) => el._voxalPeekKind === 'react').length);
  expect(glyphs).toBe(0);
});

test('a restored transcript keeps reactions outside the seed row', async ({ page }) => {
  const kept = await page.evaluate(() => {
    // 🪐 is in the catalog but not in CHAT_REACTIONS.
    const saved = { id: 'other:1', peerId: 'other', text: 'hi', at: Date.now(),
                    reactions: { '\u{1FA90}': ['me'] } };
    resetChatState();
    appendChatMessage(saved, { quiet: true });
    return Array.from(chatLog[0].reactions.keys());
  });
  expect(kept).toEqual(['\u{1FA90}']);
});
