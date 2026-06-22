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

test.describe('advanced settings: fallback relay control', () => {
  test('relayStateFromStorage maps the stored value to a UI mode', async ({ page }) => {
    const r = await page.evaluate(() => {
      const out = {};
      localStorage.removeItem('turn-fallback'); out.auto = relayStateFromStorage().mode;
      localStorage.setItem('turn-fallback', '[]'); out.off = relayStateFromStorage().mode;
      localStorage.setItem('turn-fallback', JSON.stringify([{ urls: 'turn:h:443?transport=tcp', username: 'u', credential: 'p' }]));
      const c = relayStateFromStorage();
      out.custom = c.mode; out.url = c.url; out.user = c.username; out.pass = c.credential;
      localStorage.setItem('turn-fallback', 'bad{'); out.bad = relayStateFromStorage().mode;
      return out;
    });
    expect(r).toMatchObject({ auto: 'auto', off: 'off', custom: 'custom', bad: 'auto', url: 'turn:h:443?transport=tcp', user: 'u', pass: 'p' });
  });

  test('loadRelayControls reflects a saved custom server in the DOM', async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem('turn-fallback', JSON.stringify([{ urls: 'turn:my.coturn:443?transport=tcp', username: 'alice', credential: 'secret' }]));
      loadRelayControls();
    });
    expect(await page.locator('input[name="relay-mode"][value="custom"]').isChecked()).toBe(true);
    await expect(page.locator('#input-relay-url')).toHaveValue('turn:my.coturn:443?transport=tcp');
    await expect(page.locator('#input-relay-user')).toHaveValue('alice');
    await expect(page.locator('#relay-custom')).not.toHaveClass(/hidden/);
  });

  test('selecting "Off" stores []', async ({ page }) => {
    const stored = await page.evaluate(() => {
      document.querySelector('input[name="relay-mode"][value="off"]').checked = true;
      syncRelayFromControls();
      return localStorage.getItem('turn-fallback');
    });
    expect(stored).toBe('[]');
  });

  test('custom server fields persist to turn-fallback', async ({ page }) => {
    const stored = await page.evaluate(() => {
      document.querySelector('input[name="relay-mode"][value="custom"]').checked = true;
      document.getElementById('input-relay-url').value = 'turn:relay.example:443?transport=tcp';
      document.getElementById('input-relay-user').value = 'bob';
      document.getElementById('input-relay-pass').value = 'pw';
      syncRelayFromControls();
      return JSON.parse(localStorage.getItem('turn-fallback'));
    });
    expect(stored).toEqual([{ urls: 'turn:relay.example:443?transport=tcp', username: 'bob', credential: 'pw' }]);
  });

  test('selecting "Automatic" clears the override', async ({ page }) => {
    const stored = await page.evaluate(() => {
      localStorage.setItem('turn-fallback', '[]');
      document.querySelector('input[name="relay-mode"][value="auto"]').checked = true;
      syncRelayFromControls();
      return localStorage.getItem('turn-fallback');
    });
    expect(stored).toBe(null);
  });
});
