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
