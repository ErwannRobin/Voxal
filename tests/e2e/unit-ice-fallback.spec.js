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
