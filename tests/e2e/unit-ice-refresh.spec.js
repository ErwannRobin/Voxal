import { test, expect } from './fixtures.js';

// Which ICE source wins depends on WHO YOU ARE: an org relay outranks the
// anonymous one. Signing in, signing out or switching org therefore invalidates
// the previous answer — and the stale direction that matters is claiming a relay
// is available when the account it belonged to is gone.

// The anonymous endpoint does not exist on the static test server, so stub it or
// every resolution lands on the public fallback.
function stubAnon(page) {
  return page.route('**/api/ice-servers', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        ice_servers: [{ urls: ['turn:cf:3478?transport=tcp'], username: 'u', credential: 'c' }],
        expires_at: new Date(Date.now() + 3600e3).toISOString(),
      }),
    }));
}

const settled = (page) => page.waitForFunction(() => window._lastIceResolution !== null);

test.describe('refreshIceServers', () => {
  test('drops the previous resolution before re-resolving', async ({ page }) => {
    await stubAnon(page);
    await page.goto('/');
    await settled(page);

    // Mid-refresh the badge must not still be showing the old identity's answer.
    const during = await page.evaluate(() => {
      const p = window.refreshIceServers();
      const snapshot = window._lastIceResolution;
      return p.then(() => snapshot);
    });
    expect(during).toBe(null);
    await settled(page);
  });

  test('forgets that a relay was verified — that proof was about the old relay', async ({ page }) => {
    await stubAnon(page);
    await page.goto('/');
    await settled(page);
    const after = await page.evaluate(async () => {
      _relayVerifiedAt = Date.now();
      await window.refreshIceServers();
      return window._relayVerifiedAt;
    });
    expect(after).toBe(null);
  });

  test('clears the org-only status keys when leaving an org resolution', async ({ page }) => {
    await stubAnon(page);
    await page.goto('/');
    await settled(page);
    const left = await page.evaluate(async () => {
      // Pretend the last resolution came from an org, as fetchIceServers() would
      // have recorded after a successful org fetch.
      _lastIceResolution = { source: 'org', relayCount: 2, at: Date.now() };
      localStorage.setItem('metered-status', 'ok');
      localStorage.setItem('metered-count', '2');
      localStorage.setItem('metered-servers', '[{"urls":"turn:org:3478"}]');
      await window.refreshIceServers();
      return {
        status: localStorage.getItem('metered-status'),
        count: localStorage.getItem('metered-count'),
        servers: localStorage.getItem('metered-servers'),
      };
    });
    // Otherwise the settings panel keeps reporting servers from a signed-out org.
    expect(left).toEqual({ status: null, count: null, servers: null });
  });

  test('leaves a manual metered.ca test result alone', async ({ page }) => {
    await stubAnon(page);
    await page.goto('/');
    await settled(page);
    const kept = await page.evaluate(async () => {
      // Same keys, but written by the manual "Test" button rather than the org
      // leg — a sign-out has no business wiping it.
      _lastIceResolution = { source: 'anonymous', relayCount: 1, at: Date.now() };
      localStorage.setItem('metered-status', 'ok');
      await window.refreshIceServers();
      return localStorage.getItem('metered-status');
    });
    expect(kept).toBe('ok');
  });

  test('re-resolves, so the badge ends up populated again', async ({ page }) => {
    await stubAnon(page);
    await page.goto('/');
    await settled(page);
    const text = await page.evaluate(async () => {
      await window.refreshIceServers();
      return document.getElementById('conn-status-content').textContent;
    });
    expect(text).toContain('TURN — 1 server');
  });

  test('keeps the anonymous credential cache — it is not tied to the account', async ({ page }) => {
    let calls = 0;
    await page.route('**/api/ice-servers', (route) => {
      calls++;
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          ice_servers: [{ urls: ['turn:cf:3478'], username: 'u', credential: 'c' }],
          expires_at: new Date(Date.now() + 3600e3).toISOString(),
        }),
      });
    });
    await page.goto('/');
    await settled(page);
    const before = calls;
    await page.evaluate(() => window.refreshIceServers());
    // Signing in or out does not invalidate a credential that was never bound to
    // an identity, so this must not cost another round trip.
    expect(calls).toBe(before);
  });

  test('survives an endpoint failure instead of rejecting', async ({ page }) => {
    await page.route('**/api/ice-servers', (route) => route.abort());
    await page.goto('/');
    await settled(page);
    const r = await page.evaluate(() =>
      window.refreshIceServers().then(() => 'resolved', (e) => 'rejected: ' + e.message));
    // Every caller treats this as fire-and-forget; a rejection would surface as
    // an unhandled promise error on each sign-out.
    expect(r).toBe('resolved');
    expect(await page.evaluate(() => window._lastIceResolution.source)).toBe('fallback');
  });
});

test.describe('identity changes trigger a refresh', () => {
  test('disconnecting the account re-resolves ICE', async ({ page }) => {
    await stubAnon(page);
    await page.goto('/');
    await settled(page);

    const r = await page.evaluate(async () => {
      let refreshes = 0;
      const real = window.refreshIceServers;
      window.refreshIceServers = function() { refreshes++; return real.apply(this, arguments); };
      // disconnectAccount() lives in the bootstrap closure; reach it through the
      // button that invokes it.
      localStorage.setItem('presence-api-token', 'tok');
      document.getElementById('btn-disconnect').click();
      await new Promise((r2) => setTimeout(r2, 50));
      return refreshes;
    });
    expect(r).toBeGreaterThan(0);
  });

  test('switching organisation re-resolves ICE', async ({ page }) => {
    await stubAnon(page);
    await page.goto('/');
    await settled(page);
    const r = await page.evaluate(async () => {
      let refreshes = 0;
      const real = window.refreshIceServers;
      window.refreshIceServers = function() { refreshes++; return real.apply(this, arguments); };
      const sel = document.getElementById('select-presence-org');
      sel.innerHTML = '<option value="a">A</option><option value="b">B</option>';
      sel.value = 'b';
      sel.dispatchEvent(new Event('change'));
      await new Promise((r2) => setTimeout(r2, 50));
      return { refreshes, org: localStorage.getItem('presence-org-id') };
    });
    // A different org can have an entirely different relay — or none.
    expect(r.refreshes).toBeGreaterThan(0);
    expect(r.org).toBe('b');
  });
});
