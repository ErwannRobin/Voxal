import { test as base, expect } from './fixtures.js';

// Web mobile portrait lock: a rotate-to-portrait overlay is shown only on a
// phone-sized landscape viewport with a coarse pointer, and never on desktop or
// in portrait. (Native apps are hard-locked via Info.plist / AndroidManifest —
// not covered here.) The gating class `allow-rotate-lock` is set outside iframe
// embeds so the overlay can't hijack an embedded player.

base.describe('rotate-to-portrait overlay (mobile web)', () => {
  base.use({ hasTouch: true, isMobile: true });

  base('hidden in portrait, shown in landscape, and gated on the body class', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 }); // phone portrait
    await page.goto('/');
    await expect(page.locator('body')).toHaveClass(/allow-rotate-lock/);
    await expect(page.locator('#rotate-overlay')).toBeHidden();

    await page.setViewportSize({ width: 844, height: 390 }); // phone landscape
    await expect(page.locator('#rotate-overlay')).toBeVisible();
    await expect(page.locator('#rotate-overlay')).toContainText('rotate your device');
  });
});

base.describe('overlay does not appear on desktop', () => {
  // Default context: fine pointer, no touch.
  base('stays hidden on a large landscape viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.locator('#rotate-overlay')).toBeHidden();
    // A small desktop window in landscape must also not trigger it (fine pointer).
    await page.setViewportSize({ width: 800, height: 380 });
    await expect(page.locator('#rotate-overlay')).toBeHidden();
  });
});
