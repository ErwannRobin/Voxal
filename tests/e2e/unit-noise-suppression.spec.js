import { test, expect } from './fixtures.js';

// Default noise-suppression mode is platform-dependent: RNNoise's 48kHz
// AudioWorklet crackles on iOS/Android WebViews, so mobile defaults to the OS
// ('browser') suppression while desktop/web keep RNNoise.

test('web defaults to rnnoise', async ({ page }) => {
  await page.goto('/');
  expect(await page.evaluate(() => getNoiseSuppressionMode())).toBe('rnnoise');
});

test('a stored preference overrides the default', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('noise-suppression', 'off'));
  expect(await page.evaluate(() => getNoiseSuppressionMode())).toBe('off');
});

test('native mobile defaults to browser (system) suppression', async ({ page }) => {
  // IS_NATIVE_MOBILE is evaluated at load from window.Capacitor — inject it first.
  await page.addInitScript(() => {
    window.Capacitor = { isNativePlatform: () => true };
  });
  await page.goto('/');
  expect(await page.evaluate(() => IS_NATIVE_MOBILE)).toBe(true);
  expect(await page.evaluate(() => getNoiseSuppressionMode())).toBe('browser');
});

test('the Standard option is labelled "System built-in suppression"', async ({ page }) => {
  await page.goto('/');
  const desc = await page.evaluate(() => {
    const input = document.querySelector('input[name="noise-suppression-mode"][value="browser"]');
    return input.closest('.noise-card').querySelector('.noise-card-desc').textContent.trim();
  });
  expect(desc).toBe('System built-in suppression');
});
