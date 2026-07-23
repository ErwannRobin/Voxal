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
