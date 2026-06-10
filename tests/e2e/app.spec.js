import { test, expect } from '@playwright/test';

test('home screen renders key controls', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#input-pseudo')).toBeVisible();
  await expect(page.locator('#btn-create')).toBeVisible();
  await expect(page.locator('#btn-join')).toBeVisible();
});

test('settings modal opens and closes', async ({ page }) => {
  await page.goto('/');
  await page.click('#btn-open-settings');
  await expect(page.locator('#modal-settings')).not.toHaveClass(/hidden/);
  await page.click('#btn-close-settings');
  await expect(page.locator('#modal-settings')).toHaveClass(/hidden/);
});

test('rejoin bar stays hidden when snapshot has zero rejoin candidates', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('rejoin-snapshot', JSON.stringify({
      hostId: 'self-peer',
      deputyId: null,
      peerIds: [],
      wasHost: true,
      savedAt: Date.now(),
    }));
  });
  await page.goto('/');
  await expect(page.locator('#rejoin-bar')).toHaveClass(/hidden/);
});

test('rejoin bar appears when snapshot has an available candidate', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('rejoin-snapshot', JSON.stringify({
      hostId: 'host-peer',
      deputyId: null,
      peerIds: ['peer-1'],
      wasHost: false,
      savedAt: Date.now(),
    }));
    if (window._updateRejoinBar) window._updateRejoinBar();
  });
  await expect(page.locator('#rejoin-bar')).not.toHaveClass(/hidden/);
  await expect(page.locator('#btn-rejoin')).toBeVisible();
});
