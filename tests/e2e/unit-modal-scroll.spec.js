import { test, expect } from './fixtures.js';

// The settings modal must stay fully usable on mobile when a tall section is
// expanded. Two coupled fixes are guarded here:
//
//  1. min-height:0 on every flex ancestor of the scroll chain (.modal-body and
//     .modal-settings-scrollable) so the middle flex child can shrink and the
//     inner element is the one that scrolls (WebKit refuses otherwise).
//  2. On mobile the modal fills the *dynamic* viewport (100dvh) and anchors to
//     the top (align-items:stretch). With 100vh + vertical centering, a tall
//     expanded section pushes the fixed header above the visible area (mobile
//     100vh = the larger address-bar-hidden viewport) and it can't be reached.
//
// Chromium (Playwright) doesn't reproduce the on-device geometry break — dvh==vh
// and there's no browser chrome — so we assert the computed CSS + the pinned
// header/footer layout rather than rely on the visual bug appearing.

test('scroll chain keeps min-height:0 on every flex ancestor', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    document.getElementById('modal-settings').classList.remove('hidden');
  });
  const mins = await page.evaluate(() => {
    const cs = (s) => getComputedStyle(document.querySelector('#modal-settings ' + s));
    return {
      body: cs('.modal-body').minHeight,
      scroll: cs('.modal-settings-scrollable').minHeight,
      overflowY: cs('.modal-settings-scrollable').overflowY,
    };
  });
  expect(mins.body).toBe('0px');
  expect(mins.scroll).toBe('0px');
  expect(mins.overflowY).toBe('auto');
});

test('mobile: header/footer stay pinned and the middle scrolls with a big section open', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 660 });
  await page.goto('/');
  await page.evaluate(() => {
    document.getElementById('modal-settings').classList.remove('hidden');
    if (typeof initModalSettingsSidebar === 'function') initModalSettingsSidebar();
    const d = document.getElementById('turn-details'); // Advanced — the tall section
    if (d) d.open = true;
  });

  const g = await page.evaluate(() => {
    const q = (s) => document.querySelector('#modal-settings ' + s);
    const rect = (el) => el.getBoundingClientRect();
    const modalAlign = getComputedStyle(q('.modal') || document.getElementById('modal-settings')).alignItems;
    const content = rect(q('.modal-content'));
    const header = rect(q('.modal-header'));
    const footer = rect(q('.modal-footer'));
    const scroll = q('.modal-settings-scrollable');
    return {
      vh: window.innerHeight,
      modalAlign,
      contentHeight: Math.round(content.height),
      headerTop: Math.round(header.top),
      headerBottom: Math.round(header.bottom),
      footerBottom: Math.round(footer.bottom),
      scrollH: scroll.scrollHeight,
      clientH: scroll.clientHeight,
    };
  });

  // The modal is anchored (not centered) and fills the visible viewport.
  expect(g.modalAlign).toBe('stretch');
  expect(Math.abs(g.contentHeight - g.vh)).toBeLessThanOrEqual(1);
  // Header pinned at the very top and fully visible; footer within the viewport.
  expect(g.headerTop).toBeLessThanOrEqual(1);
  expect(g.headerBottom).toBeLessThanOrEqual(g.vh);
  expect(g.footerBottom).toBeLessThanOrEqual(g.vh + 1);
  // The expanded content overflows the inner scroller (not the modal itself).
  expect(g.scrollH).toBeGreaterThan(g.clientH);

  // And the top of that scroller is reachable.
  await page.evaluate(() => { const s = document.querySelector('#modal-settings .modal-settings-scrollable'); s.scrollTop = s.scrollHeight; });
  await page.evaluate(() => { const s = document.querySelector('#modal-settings .modal-settings-scrollable'); s.scrollTop = 0; });
  const top = await page.evaluate(() => document.querySelector('#modal-settings .modal-settings-scrollable').scrollTop);
  expect(top).toBe(0);
});
