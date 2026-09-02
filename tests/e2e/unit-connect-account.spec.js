import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// Starting a Voxal Connect sign-in, which is three different journeys wearing
// one button.
//
// Desktop and mobile hand the URL to the SYSTEM browser and wait for the OS to
// route a voxal:// deep link back into the app; the page never navigates, so a
// live call survives signing in. The web build has no deep link to come back
// through, so it redirects this tab — which is why it refuses outright while a
// call is up, and why it leaves a marker so a return with no token can be
// reported instead of silently landing on the home screen signed out.
//
// unit-auth-callback.spec.js and unit-deep-link-auth.spec.js cover the URL that
// is built and the token that comes back; this file is about where the URL is
// sent, per platform.

/** A Tauri bridge whose shell and deep-link event are both observable. */
async function stubTauriDesktop(page, { shellFails = false } = {}) {
  await page.addInitScript(({ shellFails }) => {
    const opened = [];
    const onceHandlers = new Map();
    window.__desktop = {
      opened,
      deliverDeepLink: (payload) =>
        Promise.all((onceHandlers.get('deep-link://new-url') || []).map((h) => h({ payload }))),
    };
    window.__TAURI__ = {
      core: { invoke: () => Promise.resolve() },
      shell: {
        open: (url) => {
          opened.push(url);
          return shellFails ? Promise.reject(new Error('shell plugin unavailable')) : Promise.resolve();
        },
      },
      webviewWindow: { WebviewWindow: class { constructor() {} once() { return Promise.resolve(() => {}); } } },
      event: {
        listen: () => Promise.resolve(() => {}),
        once(name, handler) {
          if (!onceHandlers.has(name)) onceHandlers.set(name, []);
          onceHandlers.get(name).push(handler);
          return Promise.resolve(() => {});
        },
        emit: () => Promise.resolve(),
      },
    };
  }, { shellFails });
}

async function stubNativeMobile(page) {
  await page.addInitScript(() => {
    window.Capacitor = { isNativePlatform: () => true, Plugins: {} };
  });
}

/** Record window.open instead of performing it. */
async function stubNavigation(page) {
  await page.evaluate(() => {
    window.__opened = [];
    window.open = (url, target) => { window.__opened.push({ url, target }); return { focus() {} }; };
  });
}

const connect = (page) => page.evaluate(() => window.connectWithVoxalAccount());

test.describe('on Tauri desktop', () => {
  test.beforeEach(async ({ page }) => {
    await stubTauriDesktop(page);
    await page.goto('/');
    await stubNavigation(page);
  });

  test('the connect URL goes to the system browser, not to this window', async ({ page }) => {
    expect(await connect(page)).toBe(true);

    const state = await page.evaluate(() => ({ opened: window.__desktop.opened, inPage: window.__opened }));
    expect(state.opened).toHaveLength(1);
    expect(state.opened[0]).toContain('/connect');
    expect(state.opened[0]).toContain('caller=desktop');
    expect(state.opened[0]).toContain('responseMode=deep-link');
    // Nothing may open in-app: that is what would tear the call down.
    expect(state.inPage).toEqual([]);
  });

  test('the deep link that comes back is routed to the auth handler', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      const urls = [];
      window.handleDeepLink = (u) => urls.push(u);
      await window.connectWithVoxalAccount();
      await window.__desktop.deliverDeepLink(['voxal://auth?token=t1&state=s1']);
      return urls;
    });

    expect(seen).toEqual(['voxal://auth?token=t1&state=s1']);
  });

  test('a bare-string deep-link payload is handled too', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      const urls = [];
      window.handleDeepLink = (u) => urls.push(u);
      await window.connectWithVoxalAccount();
      await window.__desktop.deliverDeepLink('voxal://auth?token=t2');
      return urls;
    });

    expect(seen).toEqual(['voxal://auth?token=t2']);
  });

  test('signing in is allowed during a call — the page never navigates', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: false, roomCode: 'host-1' });
    expect(await connect(page)).toBe(true);

    // Still on the app, and not told to leave the room first.
    expect(new URL(page.url()).pathname).toBe('/');
    const error = await page.evaluate(() => document.getElementById('error-message').textContent);
    expect(error).not.toContain('Leave the room');
  });

  test('a missing shell plugin falls back to opening a window', async ({ page }) => {
    await page.goto('about:blank');
    await stubTauriDesktop(page, { shellFails: true });
    await page.goto('/');
    await stubNavigation(page);

    expect(await connect(page)).toBe(true);
    const opened = await page.evaluate(() => window.__opened);
    expect(opened).toHaveLength(1);
    expect(opened[0].target).toBe('_blank');
    expect(opened[0].url).toContain('/connect');
  });
});

test.describe('on iOS / Android', () => {
  test.beforeEach(async ({ page }) => {
    await stubNativeMobile(page);
    await page.goto('/');
    await stubNavigation(page);
  });

  test('the URL is handed to the OS browser with the _system target', async ({ page }) => {
    expect(await connect(page)).toBe(true);

    const opened = await page.evaluate(() => window.__opened);
    expect(opened).toHaveLength(1);
    // '_system' is what tells the Capacitor WebView to leave the app.
    expect(opened[0].target).toBe('_system');
    expect(opened[0].url).toContain('caller=mobile');
    expect(opened[0].url).toContain('responseMode=deep-link');
  });

  test('signing in during a call is allowed here too', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: false, roomCode: 'host-1' });
    expect(await connect(page)).toBe(true);
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('no pending-auth marker is left — there is no reload to come back from', async ({ page }) => {
    await connect(page);
    expect(await page.evaluate(() => sessionStorage.getItem('voxal-auth-pending'))).toBe(null);
  });
});

test.describe('on plain web', () => {
  // location.assign cannot be stubbed in a real browser, so point the connect
  // URL at this origin: the tab really does navigate, and sessionStorage
  // survives to be read on the other side.
  const sameOriginConnect = (page) =>
    page.evaluate(() => localStorage.setItem('voxal-connect-url', window.location.origin));

  test('this tab is navigated to the connect page, and the trip is marked as pending', async ({ page }) => {
    await page.goto('/');
    await sameOriginConnect(page);
    await page.evaluate(() => {
      window.__opened = [];
      window.open = (url, target) => { window.__opened.push({ url, target }); return null; };
    });

    await Promise.all([
      page.waitForURL(/\/connect\?/),
      page.evaluate(() => window.connectWithVoxalAccount()),
    ]);

    const url = new URL(page.url());
    expect(url.pathname).toBe('/connect');
    expect(url.searchParams.get('caller')).toBe('web');
    // No deep link to come back through, so the server has to redirect back.
    expect(url.searchParams.get('responseMode')).toBe('redirect');
    expect(url.searchParams.get('redirect_uri')).toContain('/auth/callback');

    const pending = await page.evaluate(() => sessionStorage.getItem('voxal-auth-pending'));
    expect(Number(pending)).toBeGreaterThan(0);
  });

  test('coming back with no token says so instead of landing silently signed out', async ({ page }) => {
    await page.goto('/');
    const shown = await page.evaluate(() => {
      let message = null;
      window.showError = (m) => { message = m; };
      // What connectWithVoxalAccount() left behind before it navigated away.
      sessionStorage.setItem('voxal-auth-pending', String(Date.now()));
      window.reportAbandonedAuth();
      return { message, pending: sessionStorage.getItem('voxal-auth-pending') };
    });

    expect(shown.message).toContain('Sign-in did not complete');
    // The marker is consumed, so it is reported once and not on every reload.
    expect(shown.pending).toBe(null);
  });

  test('coming back signed in says nothing at all', async ({ page }) => {
    await page.goto('/');
    const message = await page.evaluate(() => {
      let shown = null;
      window.showError = (m) => { shown = m; };
      sessionStorage.setItem('voxal-auth-pending', String(Date.now()));
      localStorage.setItem('presence-api-token', 'tok');
      window.reportAbandonedAuth();
      localStorage.removeItem('presence-api-token');
      return shown;
    });

    expect(message).toBe(null);
  });

  test('a return with no pending trip is not reported either', async ({ page }) => {
    await page.goto('/');
    const message = await page.evaluate(() => {
      let shown = null;
      window.showError = (m) => { shown = m; };
      window.reportAbandonedAuth();
      return shown;
    });

    expect(message).toBe(null);
  });
});
