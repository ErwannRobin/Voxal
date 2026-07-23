import { test, expect } from './fixtures.js';

// The settings modal's scroll chain must keep `min-height: 0` on every flex
// ancestor (.modal-body and .modal-settings-scrollable). Without it, WebKit/iOS
// refuses to shrink the middle flex child below its content height, so an
// expanded section overflows .modal-content (max-height:100vh, overflow:hidden)
// and — because .modal centers it — the top is clipped out of reach. Chromium
// does not reproduce the geometry bug, so we guard the computed fix directly.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('settings modal scroll chain keeps min-height:0 on every flex ancestor', async ({ page }) => {
  await page.evaluate(() => {
    if (typeof openSettings === 'function') openSettings();
    else document.getElementById('modal-settings').classList.remove('hidden');
  });
  await expect(page.locator('#modal-settings')).toBeVisible();

  const mins = await page.evaluate(() => {
    const body = document.querySelector('#modal-settings .modal-body');
    const scroll = document.querySelector('#modal-settings .modal-settings-scrollable');
    const cs = (el) => getComputedStyle(el);
    return {
      body: cs(body).minHeight,
      scroll: cs(scroll).minHeight,
      scrollOverflowY: cs(scroll).overflowY,
    };
  });

  expect(mins.body).toBe('0px');
  expect(mins.scroll).toBe('0px');
  expect(mins.scrollOverflowY).toBe('auto');
});
