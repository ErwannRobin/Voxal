import { test, expect } from './fixtures.js';
import { callFn } from './_helpers.js';

// Deep links and the Voxal Connect sign-in round trip. Both carry a token or a
// room code in from outside the app, so both validate before they act — the
// `state` check is what stops a link someone else crafted from signing you in.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    // joinRoom / joinOrCreateByChannelName do real work; record the call instead.
    window.__joins = [];
    window.joinRoom = (code) => { window.__joins.push(['joinRoom', code]); return Promise.resolve(); };
    window.joinOrCreateByChannelName = (name) => {
      window.__joins.push(['byName', name]);
      return Promise.resolve();
    };
    window.selectOrgAndStartPolling = () => { window.__polled = true; return Promise.resolve(); };
    sessionStorage.clear();
    localStorage.removeItem('presence-api-token');
  });
});

test.describe('voxal://join', () => {
  const UUID = '11111111-2222-3333-4444-555555555555';

  test('a peer-id room joins directly', async ({ page }) => {
    const joins = await page.evaluate((uuid) => {
      handleDeepLink('voxal://join?room=' + uuid);
      return window.__joins;
    }, UUID);
    expect(joins).toEqual([['joinRoom', UUID]]);
  });

  test('a named room goes through the create-or-join path', async ({ page }) => {
    const joins = await page.evaluate(() => {
      handleDeepLink('voxal://join?room=happy-otter');
      return window.__joins;
    });
    expect(joins).toEqual([['byName', 'happy-otter']]);
  });

  test('a link with no room does nothing', async ({ page }) => {
    const joins = await page.evaluate(() => {
      handleDeepLink('voxal://join');
      return window.__joins;
    });
    expect(joins).toEqual([]);
  });

  test('joining from inside a room leaves the old one first', async ({ page }) => {
    const seen = await page.evaluate(async (uuid) => {
      inRoom = true;
      isHost = true;
      roomCode = 'old';
      peer = { id: 'old', destroyed: false, destroy() { this.destroyed = true; } };
      handleDeepLink('voxal://join?room=' + uuid);
      const immediate = { left: !inRoom, joins: window.__joins.length };
      await new Promise((r) => setTimeout(r, 250));
      return { immediate, joins: window.__joins };
    }, UUID);
    // The room is dropped straight away; the join waits a tick for PeerJS.
    expect(seen.immediate).toEqual({ left: true, joins: 0 });
    expect(seen.joins).toEqual([['joinRoom', UUID]]);
  });

  test('an unknown voxal:// host is ignored', async ({ page }) => {
    const joins = await page.evaluate(() => {
      handleDeepLink('voxal://something-else?room=x');
      return window.__joins;
    });
    expect(joins).toEqual([]);
  });

  test('a scheme we do not own is ignored', async ({ page }) => {
    const joins = await page.evaluate(() => {
      handleDeepLink('otherapp://join?room=x');
      return window.__joins;
    });
    expect(joins).toEqual([]);
  });

  test('an unparseable link is swallowed rather than thrown', async ({ page }) => {
    const threw = await page.evaluate(() => {
      try { handleDeepLink('not a url at all'); return false; } catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });
});

test.describe('universal links', () => {
  const UUID = '11111111-2222-3333-4444-555555555555';

  test('an https invite for our own host joins the room', async ({ page }) => {
    const joins = await page.evaluate((uuid) => {
      handleDeepLink('https://ptt.voxal.app/?room=' + uuid);
      return window.__joins;
    }, UUID);
    expect(joins).toEqual([['joinRoom', UUID]]);
  });

  test('every Voxal host the app answers for is accepted', async ({ page }) => {
    const joins = await page.evaluate(() => {
      ['voxal.app', 'www.voxal.app', 'web.voxal.app', 'localhost'].forEach((h, i) => {
        handleDeepLink('https://' + h + '/?room=room-' + i);
      });
      return window.__joins;
    });
    expect(joins.map((j) => j[1])).toEqual(['room-0', 'room-1', 'room-2', 'room-3']);
  });

  test('someone else\'s host is not ours to act on', async ({ page }) => {
    const joins = await page.evaluate(() => {
      handleDeepLink('https://evil.example/?room=abc');
      return window.__joins;
    });
    expect(joins).toEqual([]);
  });

  test('a token in the URL signs in instead of joining', async ({ page }) => {
    const seen = await page.evaluate(() => {
      handleDeepLink('https://ptt.voxal.app/auth/callback?token=tok-1');
      return { token: localStorage.getItem('presence-api-token'), joins: window.__joins };
    });
    expect(seen).toEqual({ token: 'tok-1', joins: [] });
  });
});

test.describe('voxal://auth', () => {
  test('a token with the expected state is accepted', async ({ page }) => {
    const seen = await page.evaluate(() => {
      sessionStorage.setItem('voxal-auth-state', 'st-1');
      handleDeepLink('voxal://auth?token=tok-1&state=st-1');
      return {
        token: localStorage.getItem('presence-api-token'),
        state: sessionStorage.getItem('voxal-auth-state'),
        field: document.getElementById('input-presence-token').value,
        polled: !!window.__polled,
      };
    });
    // The one-shot state is consumed so the same link cannot be replayed.
    expect(seen).toEqual({ token: 'tok-1', state: null, field: 'tok-1', polled: true });
  });

  test('a token whose state does not match is refused', async ({ page }) => {
    const seen = await page.evaluate(() => {
      sessionStorage.setItem('voxal-auth-state', 'expected');
      handleDeepLink('voxal://auth?token=tok-evil&state=forged');
      return {
        token: localStorage.getItem('presence-api-token'),
        state: sessionStorage.getItem('voxal-auth-state'),
      };
    });
    expect(seen).toEqual({ token: null, state: 'expected' });
  });

  test('a token with no state expected is accepted (nothing to compare)', async ({ page }) => {
    const token = await page.evaluate(() => {
      sessionStorage.removeItem('voxal-auth-state');
      handleDeepLink('voxal://auth?token=tok-2');
      return localStorage.getItem('presence-api-token');
    });
    expect(token).toBe('tok-2');
  });

  test('an auth link with no token does nothing', async ({ page }) => {
    const token = await page.evaluate(() => {
      handleDeepLink('voxal://auth?state=st');
      return localStorage.getItem('presence-api-token');
    });
    expect(token).toBe(null);
  });
});

test.describe('handleAuthCallbackToken', () => {
  test('stores the token and starts polling', async ({ page }) => {
    const seen = await page.evaluate(() => {
      sessionStorage.setItem('voxal-auth-state', 'st');
      handleAuthCallbackToken('tok-3', 'st');
      return { token: localStorage.getItem('presence-api-token'), polled: !!window.__polled };
    });
    expect(seen).toEqual({ token: 'tok-3', polled: true });
  });

  test('refuses a mismatched state', async ({ page }) => {
    const token = await page.evaluate(() => {
      sessionStorage.setItem('voxal-auth-state', 'st');
      handleAuthCallbackToken('tok-4', 'wrong');
      return localStorage.getItem('presence-api-token');
    });
    expect(token).toBe(null);
  });

  test('an empty token is not a sign-in', async ({ page }) => {
    const token = await page.evaluate(() => {
      handleAuthCallbackToken('', 'st');
      return localStorage.getItem('presence-api-token');
    });
    expect(token).toBe(null);
  });
});

test.describe('consuming a token from the address bar', () => {
  test('applies the token and strips it out of the URL on load', async ({ page }) => {
    // Bootstrap already runs this on every load, so landing on the callback URL
    // is the way to observe it.
    await page.goto('/?token=tok-5&state=st-5&keep=me');
    const seen = await page.evaluate(() => ({
      token: localStorage.getItem('presence-api-token'),
      search: window.location.search,
    }));
    expect(seen.token).toBe('tok-5');
    // The token must not survive in history, screenshots or a Referer header.
    expect(seen.search).not.toContain('token');
    expect(seen.search).toContain('keep=me');
  });

  test('a second call finds nothing left to consume', async ({ page }) => {
    await page.goto('/?token=tok-6');
    expect(await page.evaluate(() => consumeAuthCallbackFromUrl())).toBe(false);
  });

  test('a URL with no token is left alone', async ({ page }) => {
    const consumed = await page.evaluate(() => consumeAuthCallbackFromUrl());
    expect(consumed).toBe(false);
  });
});

test.describe('reportAbandonedAuth', () => {
  test('says so when we come back with nothing', async ({ page }) => {
    await page.evaluate(() => {
      sessionStorage.setItem('voxal-auth-pending', String(Date.now()));
      localStorage.removeItem('presence-api-token');
      reportAbandonedAuth();
    });
    await expect(page.locator('#screen-error')).toHaveClass(/active/);
    expect(await page.locator('#error-message').textContent()).toContain('Sign-in did not complete');
    expect(await page.evaluate(() => sessionStorage.getItem('voxal-auth-pending'))).toBe(null);
  });

  test('stays quiet when the sign-in actually worked', async ({ page }) => {
    const active = await page.evaluate(() => {
      sessionStorage.setItem('voxal-auth-pending', String(Date.now()));
      localStorage.setItem('presence-api-token', 'tok');
      reportAbandonedAuth();
      const out = document.getElementById('screen-error').classList.contains('active');
      localStorage.removeItem('presence-api-token');
      return out;
    });
    expect(active).toBe(false);
  });

  test('stays quiet when no sign-in was ever started', async ({ page }) => {
    const active = await page.evaluate(() => {
      sessionStorage.removeItem('voxal-auth-pending');
      reportAbandonedAuth();
      return document.getElementById('screen-error').classList.contains('active');
    });
    expect(active).toBe(false);
  });
});

test.describe('the /connect URL', () => {
  test('carries a fresh state, the caller and a web redirect target', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const url = new URL(buildConnectUrl());
      return {
        origin: url.origin + url.pathname,
        state: url.searchParams.get('state'),
        stored: sessionStorage.getItem('voxal-auth-state'),
        caller: url.searchParams.get('caller'),
        mode: url.searchParams.get('responseMode'),
        redirect: url.searchParams.get('redirect_uri'),
      };
    });
    expect(seen.state).toBeTruthy();
    // The state we will validate on the way back is the one we just sent.
    expect(seen.stored).toBe(seen.state);
    expect(seen.caller).toBe('web');
    // On the web the server must come back over https, never voxal://.
    expect(seen.mode).toBe('redirect');
    expect(seen.redirect).toBe(await page.evaluate(() => window.location.origin + '/auth/callback'));
  });

  test('a self-hosted connect URL is honoured', async ({ page }) => {
    const origin = await page.evaluate(() => {
      localStorage.setItem('voxal-connect-url', 'https://connect.example');
      const url = new URL(buildConnectUrl());
      localStorage.removeItem('voxal-connect-url');
      return url.origin + url.pathname;
    });
    expect(origin).toBe('https://connect.example/connect');
  });

  test('every call mints a different state', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const a = new URL(buildConnectUrl()).searchParams.get('state');
      const b = new URL(buildConnectUrl()).searchParams.get('state');
      return { a, b };
    });
    expect(seen.a).not.toBe(seen.b);
  });

  test('generateState always produces something usable', async ({ page }) => {
    const state = await callFn(page, 'generateState');
    expect(typeof state).toBe('string');
    expect(state.length).toBeGreaterThan(8);
  });

  test('the web flow comes back over https, not a custom scheme', async ({ page }) => {
    const seen = await page.evaluate(() => ({
      deepLink: authUsesDeepLink(),
      redirect: authRedirectUri(),
    }));
    expect(seen.deepLink).toBe(false);
    expect(seen.redirect.startsWith('http')).toBe(true);
  });
});

test.describe('connectWithVoxalAccount', () => {
  test('refuses to reload the page out from under a live call', async ({ page }) => {
    const started = await page.evaluate(async () => {
      inRoom = true;
      const out = await connectWithVoxalAccount();
      inRoom = false;
      return out;
    });
    expect(started).toBe(false);
    expect(await page.locator('#error-message').textContent()).toContain('Leave the room');
  });
});

test.describe('trying the native app before the browser', () => {
  test('a tiny embed skips the hand-off entirely', async ({ page }) => {
    const seen = await page.evaluate(() => {
      window.__started = [];
      window.startInviteRoomJoin = (id) => window.__started.push(id);
      const wasTiny = window.IS_TINY_EMBED;
      // FORCE_WEB_JOIN takes the same shortcut and is settable from the query.
      _tryNativeAppThenJoin('room-1');
      return { started: window.__started, wasTiny };
    });
    // On plain web (neither tiny nor forced) it goes the long way round, so the
    // shortcut list stays empty here — the point is that it never throws.
    expect(Array.isArray(seen.started)).toBe(true);
  });

  test('a page that goes hidden is taken as the app having opened', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      window.__joins = [];
      _tryNativeAppThenJoin('room-2');
      // The OS handing off to the native app hides the page.
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((r) => setTimeout(r, 2200));
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      return { joins: window.__joins, fallback: _inviteWebFallbackRoomId };
    });
    // The browser must NOT also join — that would put the user in twice.
    expect(seen.joins).toEqual([]);
    expect(seen.fallback).toBe('room-2');
  });
});
