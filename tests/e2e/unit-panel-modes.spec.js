import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// How the room's two side panels are shown on a desktop-sized screen.
//
// The participants rail on the desktop video stage: pinned beside the picture,
// floating over it, or put away (and brought back from the left edge handle) —
// the talk button never goes with it.
//
// The chat: pinned (a column of its own), over the room (no reflow, no scrim),
// or in a window of its own — the panel's own nodes moved into another
// document, still driven from this one.

test.use({ viewport: { width: 1400, height: 860 } });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

async function enterVideoRoom(page) {
  await seedRoom(page, {
    selfId: 'self', isHost: true, roomCode: 'room1',
    knownPeerIds: ['p1'],
    connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
  });
  await page.evaluate(() => {
    connections.get('p1').remoteVideoStream = new MediaStream();
    showScreen('room');
    updatePeerList();
    updateVideoStage();
  });
  await expect(page.locator('body')).toHaveClass(/video-stage-desktop/);
}

const rect = (page, sel) => page.evaluate((s) => {
  const r = document.querySelector(s).getBoundingClientRect();
  return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
}, sel);

test.describe('participants rail on the desktop stage', () => {
  test('pinned by default: the stage starts right of the rail', async ({ page }) => {
    await enterVideoRoom(page);
    const rail = await rect(page, '#room-peers-panel');
    const stage = await rect(page, '#video-stage');
    expect(stage.left).toBeGreaterThanOrEqual(rail.right);
    await expect(page.locator('#btn-roster-mode-pinned')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.room-peers-tools')).toBeVisible();
  });

  test('over the video: the stage takes the rail column, the roster floats on it', async ({ page }) => {
    await enterVideoRoom(page);
    await page.click('#btn-roster-mode-overlay');
    await expect(page.locator('body')).toHaveClass(/roster-overlay/);
    const rail = await rect(page, '#room-peers-panel');
    const stage = await rect(page, '#video-stage');
    expect(stage.left).toBeLessThan(rail.left + 1);
    expect(await page.evaluate(() => localStorage.getItem('roster-panel-mode'))).toBe('overlay');
    await expect(page.locator('#room-peers-panel')).toBeVisible();
    // On top of the picture, where it is.
    const onTop = await page.evaluate(() => {
      const r = document.getElementById('peers-list').getBoundingClientRect();
      const el = document.elementFromPoint(r.left + 20, r.top + 10);
      return !!el && !!el.closest('#room-peers-panel');
    });
    expect(onTop).toBe(true);
  });

  test('hidden: the roster goes, the talk button stays, the edge handle brings it back', async ({ page }) => {
    await enterVideoRoom(page);
    await page.click('#btn-roster-hide');
    await expect(page.locator('body')).toHaveClass(/roster-hidden/);
    await expect(page.locator('#room-peers-panel')).toBeHidden();
    await expect(page.locator('#ptt-btn')).toBeVisible();
    const handle = page.locator('#stage-handle-roster');
    await expect(handle).toBeVisible();
    await expect(handle).toHaveAttribute('aria-expanded', 'false');
    const stage = await rect(page, '#video-stage');
    const room = await rect(page, '#screen-room');
    expect(stage.left - room.left).toBeLessThan(40);

    await handle.click();
    await expect(page.locator('body')).not.toHaveClass(/roster-hidden/);
    await expect(page.locator('#room-peers-panel')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('roster-panel-hidden'))).toBeNull();
  });

  test('headed like the chat: a title, the modes, a collapse control — and no window of its own', async ({ page }) => {
    await enterVideoRoom(page);
    const header = page.locator('#room-peers-panel .room-peers-header');
    await expect(header).toBeVisible();
    await expect(header.locator('.room-chat-title')).toHaveText('Participants');
    await expect(header.locator('#btn-roster-hide')).toBeVisible();
    expect(await page.locator('[id^="btn-roster-mode-window"]').count()).toBe(0);
  });

  test('the edge handle wears an icon and rides the open rail, like the chat handle', async ({ page }) => {
    await enterVideoRoom(page);
    const handle = page.locator('#stage-handle-roster');
    await expect(handle).toBeVisible();
    await expect(handle.locator('svg')).toHaveCount(1);
    await expect(handle).toHaveAttribute('aria-expanded', 'true');
    const rail = await rect(page, '#room-peers-panel');
    const h = await rect(page, '#stage-handle-roster');
    expect(Math.abs(h.left - rail.right)).toBeLessThan(3);
    // A click on it while open puts the rail away, as the chat's does.
    await handle.click();
    await expect(page.locator('body')).toHaveClass(/roster-hidden/);
  });

  test('over the video it is one card the height of the room, roster and talk button in it', async ({ page }) => {
    await enterVideoRoom(page);
    await page.click('#btn-roster-mode-overlay');
    await expect(page.locator('body')).toHaveClass(/roster-overlay/);
    const geo = await page.evaluate(() => {
      const room = document.getElementById('screen-room');
      const card = getComputedStyle(room, '::before');
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      return {
        content: card.content, bg: card.backgroundColor,
        panelBg: getComputedStyle(document.getElementById('room-peers-panel')).backgroundColor,
        barBg: getComputedStyle(document.querySelector('#screen-room .room-bottom-bar')).backgroundColor,
        panelTop: r('#room-peers-panel').top, barBottom: r('#screen-room .room-bottom-bar').bottom,
        stageTop: r('#video-stage').top, stageBottom: r('#video-stage').bottom,
      };
    });
    expect(geo.content).not.toBe('none');
    expect(geo.bg).not.toBe('rgba(0, 0, 0, 0)');
    // The pieces paint nothing of their own: the card is behind both.
    expect(geo.panelBg).toBe('rgba(0, 0, 0, 0)');
    expect(geo.barBg).toBe('rgba(0, 0, 0, 0)');
    expect(geo.panelTop - geo.stageTop).toBeLessThan(20);
    expect(geo.stageBottom - geo.barBottom).toBeLessThan(20);
  });

  test('hidden: the mic stands alone at the bottom centre of the picture, nothing behind it', async ({ page }) => {
    await enterVideoRoom(page);
    await page.click('#btn-roster-hide');
    await expect(page.locator('body')).toHaveClass(/roster-hidden/);
    const geo = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      const bar = document.querySelector('#screen-room .room-bottom-bar');
      const cs = getComputedStyle(bar);
      const ptt = r('#ptt-btn'), stage = r('#video-stage');
      return {
        pttMid: ptt.left + ptt.width / 2, stageMid: stage.left + stage.width / 2,
        pttBottom: ptt.bottom, stageBottom: stage.bottom,
        bg: cs.backgroundColor, border: cs.borderTopStyle,
        hint: getComputedStyle(document.getElementById('ptt-hint')).display,
      };
    });
    expect(Math.abs(geo.pttMid - geo.stageMid)).toBeLessThan(2);
    expect(geo.pttBottom).toBeLessThan(geo.stageBottom);
    expect(geo.bg).toBe('rgba(0, 0, 0, 0)');
    expect(geo.border).toBe('none');
    expect(geo.hint).toBe('none');
    // Still the thing you press: nothing is on top of it.
    const onTop = await page.evaluate(() => {
      const r = document.getElementById('ptt-btn').getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!el && !!el.closest('#ptt-btn');
    });
    expect(onTop).toBe(true);
  });

  test('the choice is remembered and survives a relayout', async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem('roster-panel-mode', 'overlay');
    });
    await enterVideoRoom(page);
    await page.evaluate(() => updateVideoStage());
    await expect(page.locator('body')).toHaveClass(/roster-overlay/);
    await expect(page.locator('#btn-roster-mode-overlay')).toHaveAttribute('aria-pressed', 'true');
  });

  test('no stage, no classes: a voice room is untouched', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('roster-panel-hidden', '1'));
    await seedRoom(page, { selfId: 'self', isHost: true, roomCode: 'room1' });
    await page.evaluate(() => { showScreen('room'); updatePeerList(); updateVideoStage(); });
    const cls = await page.evaluate(() => document.body.className);
    expect(cls).not.toMatch(/roster-hidden|roster-overlay/);
    await expect(page.locator('#room-peers-panel')).toBeVisible();
    await expect(page.locator('.room-peers-tools')).toBeHidden();
  });
});

test.describe('chat display', () => {
  test('pinned docks beside the stage; over the room does not, and publishes no scrim', async ({ page }) => {
    await enterVideoRoom(page);
    await page.evaluate(() => toggleChatPanel(true, { focus: false }));
    await expect(page.locator('body')).toHaveClass(/chat-docked/);

    await page.click('#btn-chat-mode-overlay');
    const cls = await page.evaluate(() => document.body.className);
    expect(cls).toMatch(/chat-mode-overlay/);
    expect(cls).not.toMatch(/chat-docked|chat-overlay\b/);
    await expect(page.locator('#btn-chat-mode-overlay')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => localStorage.getItem('chat-panel-mode'))).toBe('overlay');
    // A card over the picture that starts below the room header.
    await page.waitForTimeout(350);
    const geo = await page.evaluate(() => ({
      panel: document.getElementById('room-chat-panel').getBoundingClientRect().top,
      header: document.querySelector('#screen-room .room-header').getBoundingClientRect().bottom,
    }));
    expect(geo.panel).toBeGreaterThanOrEqual(geo.header);

    await page.click('#btn-chat-mode-pinned');
    await expect(page.locator('body')).toHaveClass(/chat-docked/);
    expect(await page.evaluate(() => localStorage.getItem('chat-panel-mode'))).toBeNull();
  });

  test('in its own window: the panel moves out, keeps working, and comes back', async ({ page }) => {
    await enterVideoRoom(page);
    await page.evaluate(() => toggleChatPanel(true, { focus: false }));
    const popupPromise = page.waitForEvent('popup');
    await page.click('#btn-chat-mode-window');
    const popup = await popupPromise;

    await expect.poll(() => page.evaluate(() => chatPoppedOut())).toBe(true);
    // Gone from the room, open as far as the room is concerned.
    expect(await page.evaluate(() => !!document.getElementById('room-chat-panel'))).toBe(false);
    expect(await page.evaluate(() => chatPanelOpen())).toBe(true);
    const cls = await page.evaluate(() => document.body.className);
    expect(cls).not.toMatch(/\bchat-open\b|chat-docked/);

    // In the window, styled and driven from here.
    await expect(popup.locator('#room-chat-panel')).toBeVisible();
    expect(await popup.evaluate(() => document.documentElement.classList.contains('chat-window-doc'))).toBe(true);
    await page.evaluate(() => { chatEl('chat-input').value = 'hello'; });
    expect(await popup.locator('#chat-input').inputValue()).toBe('hello');

    // Back to pinned: home in the room, still open.
    await popup.click('#btn-chat-mode-pinned');
    await expect.poll(() => page.evaluate(() => chatPoppedOut())).toBe(false);
    expect(await page.evaluate(() => !!document.querySelector('#screen-room #room-chat-panel'))).toBe(true);
    await expect(page.locator('body')).toHaveClass(/chat-open/);
    await expect.poll(() => popup.isClosed()).toBe(true);
  });

  test('closing the chat window from its title bar puts the chat away', async ({ page }) => {
    await enterVideoRoom(page);
    await page.evaluate(() => localStorage.setItem('chat-panel-mode', 'window'));
    const popupPromise = page.waitForEvent('popup');
    await page.click('#stage-handle-chat');
    const popup = await popupPromise;
    await expect.poll(() => page.evaluate(() => chatPoppedOut())).toBe(true);
    await popup.close();
    await expect.poll(() => page.evaluate(() => chatPoppedOut())).toBe(false);
    expect(await page.evaluate(() => chatPanelOpen())).toBe(false);
    expect(await page.evaluate(() => !!document.querySelector('#screen-room #room-chat-panel'))).toBe(true);
  });

  test('a window nobody clicked for stays in the room', async ({ page }) => {
    await enterVideoRoom(page);
    const out = await page.evaluate(() => {
      localStorage.setItem('chat-panel-mode', 'window');
      // Playwright's evaluate carries a user gesture; the app's restore does not.
      Object.defineProperty(navigator, 'userActivation', { value: { isActive: false }, configurable: true });
      toggleChatPanel(true, { focus: false });
      return { popped: chatPoppedOut(), open: document.body.classList.contains('chat-open'),
        docked: document.body.classList.contains('chat-docked') };
    });
    expect(out).toEqual({ popped: false, open: true, docked: true });
  });
});
