import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// The chat on a phone. Everything here is about a screen with no hover, no
// spare width and — turned on its side — no spare height either:
//
//   * the row's actions move behind a long press, because a strip on every row
//     is a column of chrome down the side of a busy transcript;
//   * a long press on a reaction says who reacted, which on a desktop is the
//     chip's tooltip and on a phone was nothing at all;
//   * a message and the reaction chasing it peek SIDE BY SIDE;
//   * a peek never draws under the open drawer;
//   * the self-view can be parked beside the mic, in the black band that is the
//     only part of an upright phone's screen that is not somebody's face.

const PHONE = { width: 390, height: 844 };
const PHONE_LANDSCAPE = { width: 844, height: 390 };

async function room(page, viewport = PHONE) {
  await page.setViewportSize(viewport);
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
    // The gesture stands in for the hover strip, so it is offered exactly where
    // there is no hover. Playwright's default context reports a mouse, so the
    // media query is stubbed rather than the whole context re-made.
    window.chatLongPressAvailable = () => true;
  });
}

const say = (page, id, text, extra = {}) => page.evaluate(({ id, text, extra }) => {
  handleHostMessage(Object.assign(
    { type: 'chat', id, peerId: id.split(':')[0], text, at: Date.now() }, extra));
}, { id, text, extra });

// A press held past the threshold, on whatever is at the centre of `selector`.
async function longPress(page, selector) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const b = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerId: 1, pointerType: 'touch',
      clientX: b.left + b.width / 2, clientY: b.top + b.height / 2,
    }));
  }, selector);
  await page.waitForSelector('#chat-msg-menu:not(.hidden)');
}

test.describe('a long press on a message', () => {
  test.beforeEach(async ({ page }) => {
    await room(page);
    await page.evaluate(() => toggleChatPanel(true, { focus: false }));
  });

  test('the always-on tools are gone and the sheet has the actions', async ({ page }) => {
    await say(page, 'other:1', 'a message');
    await longPress(page, '.chat-msg[data-msg-id="other:1"]');
    const labels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.chat-msg-menu-action')).map((b) => b.textContent));
    expect(labels).toEqual(['Reply', 'React', 'Copy text']);
    expect(await page.textContent('#chat-msg-menu-title')).toContain('Alice');
  });

  test('your own recent message can be corrected from it', async ({ page }) => {
    await page.evaluate(() => {
      handleHostMessage({ type: 'chat', id: 'me:1', peerId: 'me', text: 'mine', at: Date.now() });
    });
    await longPress(page, '.chat-msg[data-msg-id="me:1"]');
    const labels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.chat-msg-menu-action')).map((b) => b.textContent));
    expect(labels).toEqual(['Reply', 'React', 'Edit', 'Copy text']);
    await page.click('.chat-msg-menu-action:has-text("Edit")');
    expect(await page.inputValue('#chat-input')).toBe('mine');
  });

  test('choosing Reply puts the strip over the composer', async ({ page }) => {
    await say(page, 'other:1', 'answer me');
    await longPress(page, '.chat-msg[data-msg-id="other:1"]');
    await page.click('.chat-msg-menu-action:has-text("Reply")');
    expect(await page.evaluate(() => chatMessageMenuOpen())).toBe(false);
    expect(await page.textContent('#chat-reply-bar')).toContain('answer me');
  });

  test('a finger that travels is scrolling, not pressing', async ({ page }) => {
    await say(page, 'other:1', 'a message');
    const opened = await page.evaluate(async () => {
      const el = document.querySelector('.chat-msg[data-msg-id="other:1"]');
      const b = el.getBoundingClientRect();
      const at = (type, dy) => el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, pointerId: 1, pointerType: 'touch',
        clientX: b.left + 10, clientY: b.top + 5 + dy,
      }));
      at('pointerdown', 0);
      at('pointermove', 60);
      await new Promise((r) => setTimeout(r, 600));
      return chatMessageMenuOpen();
    });
    expect(opened).toBe(false);
  });

  test('a tap off the sheet dismisses it', async ({ page }) => {
    await say(page, 'other:1', 'a message');
    await longPress(page, '.chat-msg[data-msg-id="other:1"]');
    await page.evaluate(() => document.getElementById('chat-msg-menu').click());
    expect(await page.evaluate(() => chatMessageMenuOpen())).toBe(false);
  });
});

test.describe('a long press on a reaction', () => {
  test('prints who reacted', async ({ page }) => {
    await room(page);
    await page.evaluate(() => {
      toggleChatPanel(true, { focus: false });
      handleHostMessage({ type: 'chat', id: 'other:1', peerId: 'other', text: 'a message', at: Date.now() });
      handleHostMessage({ type: 'chat-react', msgId: 'other:1', emoji: '\u{1F44D}', peerId: 'third' });
      handleHostMessage({ type: 'chat-react', msgId: 'other:1', emoji: '\u{1F44D}', peerId: 'me' });
    });
    await longPress(page, '.chat-msg[data-msg-id="other:1"] .chat-reaction');
    const seen = await page.evaluate(() => ({
      title: document.getElementById('chat-msg-menu-title').textContent,
      who: Array.from(document.querySelectorAll('.chat-react-who-item')).map((li) => li.textContent),
      // The reaction itself must not also be toggled by the press.
      count: chatLog[0].reactions.get('\u{1F44D}').size,
    }));
    expect(seen.title).toContain('2 reactions');
    expect(seen.who).toEqual(['Ana Lucia', 'Me']);
    expect(seen.count).toBe(2);
  });
});

test.describe('the peek beside the name that sent it', () => {
  // The PLACED box, from the inline left/top layoutChatPeeks() wrote and the
  // element's own untransformed width — never getBoundingClientRect(), which on
  // a reaction is partway through its flight to the message it landed on.
  const peekBoxes = (page) => page.evaluate(() => {
    layoutChatPeeks();
    return Array.from(document.getElementById('chat-peek').children).map((el) => {
      const left = Math.round(parseFloat(el.style.left) || 0);
      return { top: Math.round(parseFloat(el.style.top) || 0), left, right: left + el.offsetWidth };
    });
  });

  test('two bubbles from one person share a line rather than stacking', async ({ page }) => {
    await room(page);
    await page.evaluate(() => {
      const at = Date.now();
      const long = 'a message long enough to want the whole width of a phone to itself';
      handleHostMessage({ type: 'chat', id: 'other:1', peerId: 'other', text: long, at });
      handleHostMessage({ type: 'chat', id: 'other:2', peerId: 'other', text: long, at: at + 10 });
    });
    const boxes = await peekBoxes(page);
    expect(boxes.length).toBe(2);
    // Side by side: same line, one after the other. Both bubbles gave up width
    // for it — neither is at the 320px cap any more.
    expect(Math.abs(boxes[0].top - boxes[1].top)).toBeLessThan(24);
    expect(boxes[1].left).toBeGreaterThanOrEqual(boxes[0].right - 1);
    expect(boxes[0].right - boxes[0].left).toBeLessThan(320);
  });

  test('a message and the reaction chasing it sit side by side', async ({ page }) => {
    await room(page);
    await page.evaluate(() => {
      handleHostMessage({ type: 'chat', id: 'other:1', peerId: 'other',
                          text: 'a message long enough to want the whole width of a phone',
                          at: Date.now() });
      handleHostMessage({ type: 'chat-react', msgId: 'other:1', emoji: '\u{1F44D}', peerId: 'other' });
    });
    const boxes = await peekBoxes(page);
    expect(boxes.length).toBe(2);
    expect(Math.abs(boxes[0].top - boxes[1].top)).toBeLessThan(24);
    expect(boxes[1].left).toBeGreaterThanOrEqual(boxes[0].right - 1);
  });

  test('nothing is drawn under the open drawer', async ({ page }) => {
    await room(page);
    const seen = await page.evaluate(() => {
      toggleChatPanel(true, { focus: false });
      const view = chatPeekViewport();
      const panel = document.querySelector('#screen-room .room-chat-panel');
      return { view: view.width, drawer: panel.offsetWidth, window: window.innerWidth };
    });
    expect(seen.view).toBeLessThanOrEqual(seen.window - seen.drawer);
  });

  test('an overlaying drawer publishes a scrim, a docked one does not', async ({ page }) => {
    await room(page);
    expect(await page.evaluate(() => {
      toggleChatPanel(true, { focus: false });
      applyChatDock();
      return document.body.classList.contains('chat-overlay');
    })).toBe(true);
    expect(await page.evaluate(() => {
      toggleChatPanel(false);
      applyChatDock();
      return document.body.classList.contains('chat-overlay');
    })).toBe(false);
  });
});

test.describe('the self-view beside the mic', () => {
  test('a badge dropped in the band beside the mic parks there', async ({ page }) => {
    await room(page);
    const corner = await page.evaluate(() => nearestBadgeCorner(
      { left: 20, top: 700, width: 120, height: 68 },
      { width: 390, height: 800 },
      { top: 640, centre: 90, width: 130 }
    ));
    expect(corner).toBe('barl');
  });

  test('the right-hand side of the band is its own slot', async ({ page }) => {
    await room(page);
    const corner = await page.evaluate(() => nearestBadgeCorner(
      { left: 250, top: 700, width: 120, height: 68 },
      { width: 390, height: 800 },
      { top: 640, centre: 90, width: 130 }
    ));
    expect(corner).toBe('barr');
  });

  test('with no band the drop is a corner, exactly as before', async ({ page }) => {
    await room(page);
    const corner = await page.evaluate(() => nearestBadgeCorner(
      { left: 20, top: 700, width: 120, height: 68 },
      { width: 390, height: 800 },
      null
    ));
    expect(corner).toBe('bl');
  });

  test('a phone on its side hands a parked badge back to a corner', async ({ page }) => {
    await room(page, PHONE_LANDSCAPE);
    const corner = await page.evaluate(() => {
      setSelfBadgeCorner('barr');
      // No band: the talk button fills the short strip it sits in.
      return effectiveSelfBadgeCorner(null);
    });
    expect(corner).toBe('br');
    // …and the stored choice survives, so turning back upright restores it.
    expect(await page.evaluate(() => effectiveSelfBadgeCorner({ top: 300, centre: 60, width: 120 })))
      .toBe('barr');
  });
});
