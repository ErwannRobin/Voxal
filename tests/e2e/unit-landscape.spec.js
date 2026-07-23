import { test as base, expect } from './fixtures.js';

// Web landscape support: on a short landscape viewport (phone in landscape, or a
// short desktop window) Home and Room reflow to a two-column CSS grid so nothing
// overflows. Portrait and tall/desktop viewports keep the default flex stack.

function display(page, sel) {
  return page.evaluate((s) => getComputedStyle(document.querySelector(s)).display, sel);
}

async function enterRoom(page) {
  await page.evaluate(() => {
    inRoom = true; isHost = true; roomCode = 'abc'; peer = { id: 'abc' };
    showScreen('room');
    connections.set('p1', { pseudo: 'Alice', data: { open: true }, talking: false });
    updatePeerList();
  });
}

base.describe('landscape reflow (mobile web)', () => {
  base.use({ hasTouch: true, isMobile: true });

  base('Home and Room switch to a grid in short landscape', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto('/');
    expect(await display(page, '#screen-home')).toBe('grid');
    await enterRoom(page);
    expect(await display(page, '#screen-room')).toBe('grid');
  });

  base('portrait keeps the default flex stack', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    expect(await display(page, '#screen-home')).toBe('flex');
    await enterRoom(page);
    expect(await display(page, '#screen-room')).toBe('flex');
  });
});

base.describe('desktop is unaffected', () => {
  base('tall landscape desktop keeps the flex stack', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    expect(await display(page, '#screen-home')).toBe('flex');
  });
});

base.describe('handedness (talk button side in landscape)', () => {
  base.use({ hasTouch: true, isMobile: true });

  function sides(page) {
    return page.evaluate(() => {
      const peers = document.querySelector('#screen-room .room-peers-panel').getBoundingClientRect();
      const talk = document.querySelector('#screen-room .room-bottom-bar').getBoundingClientRect();
      return { peersLeft: peers.left, talkLeft: talk.left, peersW: peers.width, talkW: talk.width };
    });
  }

  base('defaults to right-handed: peers left (2/3), talk button right (1/3)', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto('/');
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-hand'))).toBe('right');
    await enterRoom(page);
    const s = await sides(page);
    expect(s.peersLeft).toBeLessThan(s.talkLeft); // peers column is on the left
    expect(s.peersW).toBeGreaterThan(s.talkW);    // peers is the wider (2/3) column
  });

  base('left-handed setting moves the talk button to the left', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto('/');
    await page.evaluate(() => { document.documentElement.setAttribute('data-hand', 'left'); });
    await enterRoom(page);
    const s = await sides(page);
    expect(s.talkLeft).toBeLessThan(s.peersLeft); // talk column is now on the left
    expect(s.peersW).toBeGreaterThan(s.talkW);    // peers is still the wider (2/3) column
  });
});
