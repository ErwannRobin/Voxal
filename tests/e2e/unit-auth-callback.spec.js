import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// Voxal Connect on the web.
//
// The auth server used to always redirect to voxal://auth, which on a browser
// dead-ends at an OS dialog ("no application is configured to open this URL")
// and never signs the user in. Web now uses an ordinary https redirect back to
// /auth/callback on our own origin — the shape Google and Facebook use — and
// the custom scheme is reserved for native.

test.describe('connect URL parameters', () => {
  // buildConnectUrl() is asserted directly: location.assign cannot be reliably
  // stubbed in a real browser, and the URL is the whole contract with the server.
  const connectUrlFor = (page) => page.evaluate(() => window.buildConnectUrl());

  test('web asks for an https redirect back to our own origin', async ({ page }) => {
    await page.goto('/');
    const url = new URL(await connectUrlFor(page));
    expect(url.searchParams.get('responseMode')).toBe('redirect');
    expect(url.searchParams.get('caller')).toBe('web');
    expect(url.searchParams.get('redirect_uri')).toBe(new URL(page.url()).origin + '/auth/callback');
    expect(url.searchParams.get('state')).toBeTruthy();
    // The old contract the server ignored.
    expect(url.searchParams.get('callbackOrigin')).toBeNull();
  });

  test('native mobile asks for the deep link, not a redirect', async ({ page }) => {
    // The bug this guards: Capacitor took the web branch and asked for
    // post-message while actually waiting for a voxal:// deep link.
    await page.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true }; });
    await page.goto('/');
    const url = new URL(await connectUrlFor(page));
    expect(url.searchParams.get('responseMode')).toBe('deep-link');
    expect(url.searchParams.get('caller')).toBe('mobile');
    expect(url.searchParams.get('redirect_uri')).toBeNull();
  });

  test('the state is stored so the callback can be validated', async ({ page }) => {
    await page.goto('/');
    const url = new URL(await connectUrlFor(page));
    const stored = await page.evaluate(() => sessionStorage.getItem('voxal-auth-state'));
    expect(stored).toBe(url.searchParams.get('state'));
  });

  test('refuses to navigate away while in a room', async ({ page }) => {
    await page.goto('/');
    await seedRoom(page, { isHost: false, roomCode: 'host-1' });
    const r = await page.evaluate(async () => {
      let shown = null;
      window.showError = (m) => { shown = m; };
      const started = await window.connectWithVoxalAccount();
      return { started, shown };
    });
    // A same-tab redirect would tear down the live call.
    expect(r.started).toBe(false);
    expect(r.shown).toContain('Leave the room');
  });
});

test.describe('consumeAuthCallbackFromUrl', () => {
  test('accepts a matching state, connects, and scrubs the token from the URL', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(() => {
      history.replaceState({}, '', '/auth/callback?token=tok-123&state=st-abc');
      sessionStorage.setItem('voxal-auth-state', 'st-abc');
      const consumed = window.consumeAuthCallbackFromUrl();
      return {
        consumed,
        token: localStorage.getItem('presence-api-token'),
        search: window.location.search,
        path: window.location.pathname,
        stateLeft: sessionStorage.getItem('voxal-auth-state'),
      };
    });
    expect(r.consumed).toBe(true);
    expect(r.token).toBe('tok-123');
    // A token in the address bar leaks via history, screenshots and Referer.
    expect(r.search).toBe('');
    expect(r.path).toBe('/');
    expect(r.stateLeft).toBe(null);
  });

  test('rejects a mismatched state and stores nothing', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(() => {
      history.replaceState({}, '', '/auth/callback?token=tok-123&state=WRONG');
      sessionStorage.setItem('voxal-auth-state', 'st-abc');
      window.consumeAuthCallbackFromUrl();
      return { token: localStorage.getItem('presence-api-token'), search: window.location.search };
    });
    expect(r.token).toBe(null);
    // Still scrubbed — a rejected token should not linger in the URL either.
    expect(r.search).toBe('');
  });

  test('keeps unrelated query params while removing the credentials', async ({ page }) => {
    await page.goto('/');
    const search = await page.evaluate(() => {
      history.replaceState({}, '', '/auth/callback?token=tok-123&state=st-abc&next=%2Fsettings');
      sessionStorage.setItem('voxal-auth-state', 'st-abc');
      window.consumeAuthCallbackFromUrl();
      return window.location.search;
    });
    expect(search).toBe('?next=%2Fsettings');
    expect(search).not.toContain('token');
  });

  test('does nothing when there is no token', async ({ page }) => {
    await page.goto('/?foo=bar');
    const r = await page.evaluate(() => ({
      consumed: window.consumeAuthCallbackFromUrl(),
      search: window.location.search,
    }));
    expect(r.consumed).toBe(false);
    expect(r.search).toBe('?foo=bar');
  });
});

test.describe('abandoned sign-in', () => {
  test('explains a return with no token instead of failing silently', async ({ page }) => {
    await page.goto('/');
    const err = await page.evaluate(() => {
      sessionStorage.setItem('voxal-auth-pending', String(Date.now()));
      localStorage.removeItem('presence-api-token');
      let shown = null;
      window.showError = (m) => { shown = m; };
      window.reportAbandonedAuth();
      return { shown, pending: sessionStorage.getItem('voxal-auth-pending') };
    });
    expect(err.shown).toContain('did not complete');
    // Names the actual cause rather than leaving a mystery.
    expect(err.shown).toContain('voxal://');
    expect(err.pending).toBe(null);
  });

  test('stays quiet when the sign-in actually worked', async ({ page }) => {
    await page.goto('/');
    const shown = await page.evaluate(() => {
      sessionStorage.setItem('voxal-auth-pending', String(Date.now()));
      localStorage.setItem('presence-api-token', 'tok');
      let s = null;
      window.showError = (m) => { s = m; };
      window.reportAbandonedAuth();
      return s;
    });
    expect(shown).toBe(null);
  });

  test('stays quiet when no sign-in was in flight', async ({ page }) => {
    await page.goto('/');
    const shown = await page.evaluate(() => {
      sessionStorage.removeItem('voxal-auth-pending');
      let s = null;
      window.showError = (m) => { s = m; };
      window.reportAbandonedAuth();
      return s;
    });
    expect(shown).toBe(null);
  });
});

test.describe('/auth/callback is actually served', () => {
  // It 404'd in production: vercel.json rewrote it to /index.html, but with
  // cleanUrls Vercel redirects /index.html -> / so the rewrite never resolved.
  // It is now a real file (src/auth/callback.html), which also means it works
  // on any static host rather than depending on Vercel rewrite semantics.
  test('the path exists and is not a 404', async ({ page }) => {
    const res = await page.goto('/auth/callback?token=tok-123&state=st-abc');
    expect(res.status()).toBe(200);
  });

  test('forwards into the app, which consumes the token and scrubs the URL', async ({ page }) => {
    // Seed the state on the origin before the callback lands.
    await page.goto('/');
    await page.evaluate(() => sessionStorage.setItem('voxal-auth-state', 'st-abc'));

    await page.goto('/auth/callback?token=tok-123&state=st-abc');
    await page.waitForFunction(() => window.location.pathname === '/');

    expect(await page.evaluate(() => localStorage.getItem('presence-api-token'))).toBe('tok-123');
    expect(new URL(page.url()).search).toBe('');
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('the hop does not leave a token-bearing history entry', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => sessionStorage.setItem('voxal-auth-state', 'st-abc'));
    await page.goto('/auth/callback?token=tok-123&state=st-abc');
    await page.waitForFunction(() => window.location.pathname === '/');

    // location.replace() means going back must not land on the callback URL.
    await page.goBack();
    expect(page.url()).not.toContain('token=');
  });
});
