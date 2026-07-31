import { test, expect } from './fixtures.js';

// Anonymous TURN credentials. A relay API key can never ship in the client, so
// a server endpoint mints short-lived credentials instead — these cover how the
// client finds that endpoint, caches its answer, and where it sits in the ICE
// resolution order.

test.describe('anonymousTurnUrl', () => {
  test('uses a same-origin path on plain web', async ({ page }) => {
    await page.goto('/');
    // Same-origin means a self-hosted deploy automatically uses its own
    // endpoint rather than spending ptt.voxal.app's quota.
    expect(await page.evaluate(() => window.anonymousTurnUrl())).toBe('/api/ice-servers');
  });

  test('an explicit override wins', async ({ page }) => {
    await page.goto('/');
    const url = await page.evaluate(() => {
      localStorage.setItem('anon-turn-url', '  https://my.host/turn  ');
      return window.anonymousTurnUrl();
    });
    expect(url).toBe('https://my.host/turn');
  });

  test('native falls back to the absolute URL — there is no same-origin server', async ({ page }) => {
    await page.addInitScript(() => {
      window.Capacitor = { isNativePlatform: () => true };
    });
    await page.goto('/');
    // Under capacitor:// or the Tauri asset protocol a relative path resolves
    // to nothing, so the absolute default is required.
    expect(await page.evaluate(() => window.anonymousTurnUrl())).toBe('https://ptt.voxal.app/api/ice-servers');
  });
});

test.describe('fetchAnonymousIceServers', () => {
  async function stubEndpoint(page, body, status = 200) {
    await page.route('**/api/ice-servers', (route) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }));
  }

  test('returns the servers the endpoint hands out', async ({ page }) => {
    await page.goto('/');
    await stubEndpoint(page, {
      ice_servers: [{ urls: ['turn:t:3478?transport=tcp', 'turns:t:5349'], username: 'u', credential: 'c' }],
      ttl: 3600,
      expires_at: new Date(Date.now() + 3600e3).toISOString(),
    });
    const servers = await page.evaluate(() => window.fetchAnonymousIceServers());
    expect(servers).toHaveLength(1);
    expect(servers[0].username).toBe('u');
    // The firewall-traversing transports must survive end to end.
    expect(servers[0].urls.some((u) => u.includes('transport=tcp'))).toBe(true);
    expect(servers[0].urls.some((u) => u.startsWith('turns:'))).toBe(true);
  });

  test('caches until expiry, then re-fetches', async ({ page }) => {
    await page.goto('/');
    let calls = 0;
    await page.route('**/api/ice-servers', (route) => {
      calls++;
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          ice_servers: [{ urls: ['turn:t:3478'], username: 'u' + calls }],
          expires_at: new Date(Date.now() + 3600e3).toISOString(),
        }),
      });
    });
    await page.evaluate(() => window.fetchAnonymousIceServers());
    await page.evaluate(() => window.fetchAnonymousIceServers());
    expect(calls).toBe(1);

    // Expire the cache and it goes back to the endpoint.
    await page.evaluate(() => { window._anonIceCache.expiresAt = Date.now() - 1; });
    await page.evaluate(() => window.fetchAnonymousIceServers());
    expect(calls).toBe(2);
  });

  test('expires the cache early so a credential is never handed out about to die', async ({ page }) => {
    await page.goto('/');
    const expiresAt = Date.now() + 3600e3;
    await stubEndpoint(page, {
      ice_servers: [{ urls: ['turn:t:3478'] }],
      expires_at: new Date(expiresAt).toISOString(),
    });
    const cached = await page.evaluate(async () => {
      await window.fetchAnonymousIceServers();
      return window._anonIceCache.expiresAt;
    });
    expect(cached).toBeLessThan(expiresAt);
  });

  test('returns null when the endpoint has no relay configured', async ({ page }) => {
    await page.goto('/');
    await stubEndpoint(page, { ice_servers: [] });
    expect(await page.evaluate(() => window.fetchAnonymousIceServers())).toBe(null);
  });

  test('throws on an endpoint error so the caller can fall through', async ({ page }) => {
    await page.goto('/');
    await stubEndpoint(page, { error: 'not_configured' }, 503);
    const err = await page.evaluate(() =>
      window.fetchAnonymousIceServers().then(() => null, (e) => e.message));
    expect(err).toContain('503');
  });
});

test.describe('fetchIceServers precedence', () => {
  test('uses the anonymous endpoint instead of the retired public relay', async ({ page }) => {
    await page.goto('/');
    await page.route('**/api/ice-servers', (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          ice_servers: [{ urls: ['turn:cf:3478'], username: 'u', credential: 'c' }],
          expires_at: new Date(Date.now() + 3600e3).toISOString(),
        }),
      }));
    const servers = await page.evaluate(() => window.fetchIceServers());
    const urls = servers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
    expect(urls.some((u) => u.includes('cf'))).toBe(true);
    // The dead openrelay default must not be reached any more.
    expect(urls.some((u) => u.includes('openrelay'))).toBe(false);
    // STUN is still bundled alongside, for the cheap direct path.
    expect(urls.some((u) => u.startsWith('stun:'))).toBe(true);
  });

  test('an explicitly configured custom relay still outranks it', async ({ page }) => {
    await page.goto('/');
    let anonCalls = 0;
    await page.route('**/api/ice-servers', (route) => { anonCalls++; route.abort(); });
    const servers = await page.evaluate(() => {
      // Embed-provided config is the highest-precedence source.
      window.applyIframeConfig({ iceServers: [{ urls: 'turn:mine:3478', username: 'me' }] });
      return window.fetchIceServers();
    });
    expect(servers).toEqual([{ urls: 'turn:mine:3478', username: 'me' }]);
    expect(anonCalls).toBe(0);
  });

  test('falls through to the public fallback when the endpoint is down', async ({ page }) => {
    await page.goto('/');
    await page.route('**/api/ice-servers', (route) => route.abort());
    const servers = await page.evaluate(() => window.fetchIceServers());
    const urls = servers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
    expect(urls.some((u) => u.includes('openrelay'))).toBe(true);
    // …and the failure is remembered, so the echo test can name the real cause.
    expect(await page.evaluate(() => window._anonTurnError)).toBeTruthy();
  });

  test('the echo test blames the credential service, not the retired relay', async ({ page }) => {
    await page.goto('/');
    await page.route('**/api/ice-servers', (route) => route.abort());
    const msg = await page.evaluate(async () => {
      await window.fetchIceServers();
      return window.diagnoseRelayFailure(4, [{ code: 701 }], true);
    });
    expect(msg).toContain('credential service');
    expect(msg).toContain('/api/ice-servers');
    expect(msg).not.toContain('shared credentials have been retired');
  });
});
