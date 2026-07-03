import { test, expect } from './fixtures.js';

// Default noise-suppression mode is platform-dependent: RNNoise's 48kHz
// AudioWorklet crackles on phones/tablets (native WebViews and mobile browsers
// alike), so mobile defaults to the OS ('browser') suppression while desktop
// keeps RNNoise.

// IS_MOBILE_DEVICE is evaluated at load — spoof a phone browser before it runs.
function spoofMobileBrowserUA(page) {
  return page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', {
      get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
  });
}

test('desktop web defaults to rnnoise', async ({ page }) => {
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

test('mobile browser (web, no Capacitor) defaults to browser (system) suppression', async ({ page }) => {
  await spoofMobileBrowserUA(page);
  await page.goto('/');
  expect(await page.evaluate(() => IS_NATIVE_MOBILE)).toBe(false);
  expect(await page.evaluate(() => IS_MOBILE_DEVICE)).toBe(true);
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

function readBadges(page) {
  return page.evaluate(() => {
    const has = (v) => {
      const input = document.querySelector(`input[name="noise-suppression-mode"][value="${v}"]`);
      return !!input.closest('.noise-card').querySelector('.noise-card-title em');
    };
    return { rnnoise: has('rnnoise'), browser: has('browser') };
  });
}

test('desktop web keeps the (Recommended) badge on RNNoise', async ({ page }) => {
  await page.goto('/');
  expect(await readBadges(page)).toEqual({ rnnoise: true, browser: false });
});

test('native mobile moves the (Recommended) badge to Standard', async ({ page }) => {
  await page.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true }; });
  await page.goto('/');
  expect(await readBadges(page)).toEqual({ rnnoise: false, browser: true });
});

test('mobile browser moves the (Recommended) badge to Standard', async ({ page }) => {
  await spoofMobileBrowserUA(page);
  await page.goto('/');
  expect(await readBadges(page)).toEqual({ rnnoise: false, browser: true });
});
