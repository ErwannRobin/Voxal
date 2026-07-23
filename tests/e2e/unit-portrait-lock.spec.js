import { test as base, expect } from './fixtures.js';

// Web-mobile portrait lock: when a phone is held in landscape the whole page is
// counter-rotated 90° so the UI stays in a portrait layout (mirrors the native
// Info.plist / AndroidManifest lock). Gated on `body.allow-rotate-lock` (set in
// JS, off inside iframe embeds) + a phone-sized landscape viewport with a coarse
// pointer, so desktop and tablets are never rotated.

function bodyTransform(page) {
  return page.evaluate(() => getComputedStyle(document.body).transform);
}

base.describe('counter-rotation on mobile web', () => {
  base.use({ hasTouch: true, isMobile: true });

  base('rotates in landscape, upright in portrait, and sets the gating class', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 }); // phone portrait
    await page.goto('/');
    await expect(page.locator('body')).toHaveClass(/allow-rotate-lock/);
    expect(await bodyTransform(page)).toBe('none');

    await page.setViewportSize({ width: 844, height: 390 }); // phone landscape
    // 90° rotation → matrix(0, 1, -1, 0, …); the app is now laid out in portrait.
    const t = await bodyTransform(page);
    expect(t).toMatch(/^matrix\(/);
    expect(t.replace(/\s/g, '')).toContain('0,1,-1,0');
    // The rotated body fills the viewport (its bounding box spans the screen).
    const box = await page.evaluate(() => {
      const r = document.body.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight };
    });
    expect(box.w).toBe(box.vw);
    expect(box.h).toBe(box.vh);
  });

  base('the settings modal stays in mobile layout while rotated', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto('/');
    await page.evaluate(() => {
      document.getElementById('modal-settings').classList.remove('hidden');
      if (typeof initModalSettingsSidebar === 'function') initModalSettingsSidebar();
    });
    const m = await page.evaluate(() => {
      const content = document.querySelector('#modal-settings .modal-content');
      const sidebar = getComputedStyle(document.querySelector('#modal-settings .modal-settings-sidebar')).display;
      // Local (pre-transform) box fills the portrait frame: narrow width, tall height.
      return { offW: content.offsetWidth, offH: content.offsetHeight, sidebar };
    });
    expect(m.sidebar).toBe('none');       // desktop 2-column layout suppressed
    expect(m.offH).toBeGreaterThan(m.offW); // fills portrait height, not the short side
  });
});

base.describe('no rotation on desktop', () => {
  base('stays upright on a landscape desktop viewport (fine pointer)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    expect(await bodyTransform(page)).toBe('none');
    await page.setViewportSize({ width: 800, height: 380 }); // short desktop window
    expect(await bodyTransform(page)).toBe('none');
  });
});
