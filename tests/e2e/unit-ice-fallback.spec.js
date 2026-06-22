import { test, expect } from './fixtures.js';

// fetchIceServers() with no org/metered TURN configured (a fresh page) must fall
// back to public STUN *plus* a best-effort free TURN relay, so peers behind
// symmetric NAT / strict firewalls can still connect. Overridable via
// localStorage['turn-fallback'].

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

const iceUrls = (page) =>
  page.evaluate(async () => (await fetchIceServers()).map((s) => s.urls));

test('falls back to public STUN + free TURN when nothing is configured', async ({ page }) => {
  const urls = await iceUrls(page);
  // STUN is always present.
  expect(urls.some((u) => u.startsWith('stun:'))).toBe(true);
  // A relay reachable over TCP/443 (the transport that gets through firewalls).
  expect(urls.some((u) => /^turn:.*:443\?transport=tcp/.test(u))).toBe(true);
  // And a TLS relay (turns:) that looks like HTTPS.
  expect(urls.some((u) => u.startsWith('turns:'))).toBe(true);
});

test('respects a turn-fallback override (own coturn)', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem(
      'turn-fallback',
      JSON.stringify([{ urls: 'turn:my.coturn:443?transport=tcp', username: 'u', credential: 'p' }])
    );
  });
  const urls = await iceUrls(page);
  expect(urls).toContain('turn:my.coturn:443?transport=tcp');
  expect(urls.some((u) => u.includes('openrelay'))).toBe(false);
  // STUN is still included.
  expect(urls.some((u) => u.startsWith('stun:'))).toBe(true);
});

test('turn-fallback="[]" disables the relay but keeps STUN', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('turn-fallback', '[]'));
  const urls = await iceUrls(page);
  expect(urls.length).toBeGreaterThan(0);
  expect(urls.every((u) => u.startsWith('stun:'))).toBe(true);
});

test('malformed turn-fallback JSON falls back to the default relay', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('turn-fallback', 'not json{'));
  const urls = await iceUrls(page);
  expect(urls.some((u) => u.startsWith('turn:') || u.startsWith('turns:'))).toBe(true);
});

test.describe('advanced settings: fallback TURN field', () => {
  test('turnFallbackStatus reflects the input', async ({ page }) => {
    const r = await page.evaluate(() => ({
      empty: turnFallbackStatus(''),
      disabled: turnFallbackStatus('[]'),
      valid: turnFallbackStatus('[{"urls":"turn:x"}]'),
      notArray: turnFallbackStatus('{"urls":"turn:x"}'),
      invalid: turnFallbackStatus('nope{'),
    }));
    expect(r.empty).toMatch(/default/i);
    expect(r.disabled).toMatch(/disabled/i);
    expect(r.valid).toMatch(/1 custom/i);
    expect(r.notArray).toMatch(/array/i);
    expect(r.invalid).toMatch(/invalid/i);
  });

  test('the field loads the saved override when settings open', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('turn-fallback', '[]'));
    await page.click('#btn-open-settings');
    await expect(page.locator('#input-turn-fallback')).toHaveValue('[]');
    await expect(page.locator('#turn-fallback-status')).toHaveText(/disabled/i);
  });

  test('editing the field saves to localStorage and updates the status', async ({ page }) => {
    await page.click('#btn-open-settings');
    await page.evaluate(() => {
      const el = document.getElementById('input-turn-fallback');
      el.value = '[{"urls":"turn:my.coturn:443?transport=tcp","username":"u","credential":"p"}]';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const stored = await page.evaluate(() => localStorage.getItem('turn-fallback'));
    expect(stored).toContain('my.coturn');
    await expect(page.locator('#turn-fallback-status')).toHaveText(/1 custom relay/i);
  });

  test('clearing the field removes the override (back to default)', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('turn-fallback', '[]'));
    await page.click('#btn-open-settings');
    await page.evaluate(() => {
      const el = document.getElementById('input-turn-fallback');
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(await page.evaluate(() => localStorage.getItem('turn-fallback'))).toBe(null);
    await expect(page.locator('#turn-fallback-status')).toHaveText(/default/i);
  });
});
