import { test, expect } from './fixtures.js';

// fetchIceServers() walks four sources in strict precedence — embed, org,
// locally configured metered.ca, anonymous — and only then falls back to public
// STUN. Every step has a "configured but broken" case, and getting those wrong
// is invisible until somebody behind a strict NAT cannot hear anybody: the app
// still connects, it just quietly has no relay.
//
// unit-anon-turn.spec.js covers the anonymous endpoint itself and the embed
// override; what is exercised here is the chain around them — the org leg, the
// metered.ca leg, and the Tauri proxy both of them go through on desktop.

const ORG_SERVERS = [
  { urls: 'stun:stun.example:3478' },
  { urls: 'turn:relay.example:3478?transport=udp', username: 'org-u', credential: 'org-c' },
];
const METERED_SERVERS = [
  { urls: 'stun:stun.metered:3478' },
  { urls: 'turn:relay.metered:443?transport=tcp', username: 'm-u', credential: 'm-c' },
];

/** Sign in to an org, so the org leg of the chain is taken. */
async function signIn(page) {
  await page.evaluate(() => {
    localStorage.setItem('presence-api-token', 'test-token');
    localStorage.setItem('presence-org-id', 'org-1');
    localStorage.setItem('service-url', 'https://presence.test');
  });
}

/** Keep the anonymous endpoint out of the way unless a test wants it. */
async function noAnonymousRelay(page) {
  await page.route('**/api/ice-servers', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"not_configured"}' }));
}

const resolve = (page) =>
  page.evaluate(async () => {
    const servers = await window.fetchIceServers();
    return { servers, resolution: window._lastIceResolution };
  });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await noAnonymousRelay(page);
});

// --- the org leg -------------------------------------------------------------

test.describe('org ICE servers', () => {
  test('a signed-in user gets the org relay, and the settings panel remembers it', async ({ page }) => {
    await signIn(page);
    await page.route('**/org/org-1/ice-servers', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ice_servers: ORG_SERVERS }) }));

    const out = await resolve(page);
    expect(out.resolution.source).toBe('org');
    expect(out.servers).toEqual(ORG_SERVERS);
    expect(out.resolution.relayCount).toBe(1);

    // Only the org leg writes these — they back the settings panel's readout.
    const stored = await page.evaluate(() => ({
      status: localStorage.getItem('metered-status'),
      count: localStorage.getItem('metered-count'),
      servers: JSON.parse(localStorage.getItem('metered-servers') || 'null'),
    }));
    expect(stored.status).toBe('ok');
    expect(stored.count).toBe('2');
    expect(stored.servers).toEqual(ORG_SERVERS);
  });

  test('an org with TURN switched off falls through instead of ending the chain', async ({ page }) => {
    await signIn(page);
    await page.route('**/org/org-1/ice-servers', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ice_servers: null }) }));

    const out = await resolve(page);
    expect(out.resolution.source).toBe('fallback');
    expect(out.servers.length).toBeGreaterThan(0);
  });

  test('an org endpoint returning an error falls through rather than failing the join', async ({ page }) => {
    await signIn(page);
    await page.route('**/org/org-1/ice-servers', (route) => route.fulfill({ status: 500, body: 'boom' }));

    const out = await resolve(page);
    expect(out.resolution.source).toBe('fallback');
  });

  test('an org endpoint that never answers falls through too', async ({ page }) => {
    await signIn(page);
    await page.route('**/org/org-1/ice-servers', (route) => route.abort('connectionrefused'));

    const out = await resolve(page);
    expect(out.resolution.source).toBe('fallback');
  });

  test('a signed-out user never asks the org endpoint at all', async ({ page }) => {
    let asked = 0;
    await page.route('**/org/**/ice-servers', (route) => { asked++; return route.fulfill({ status: 200, body: '{}' }); });

    const out = await resolve(page);
    expect(asked).toBe(0);
    expect(out.resolution.source).toBe('fallback');
  });
});

// --- the locally configured metered.ca leg -----------------------------------

test.describe('locally configured metered.ca credentials', () => {
  test.beforeEach(async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem('metered-app-name', 'myapp');
      localStorage.setItem('metered-api-key', 'secret-key');
    });
  });

  test('are used when present, and are asked for over the configured app name', async ({ page }) => {
    const urls = [];
    await page.route('**/*.metered.live/**', (route) => {
      urls.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(METERED_SERVERS) });
    });

    const out = await resolve(page);
    expect(out.resolution.source).toBe('metered');
    expect(out.servers).toEqual(METERED_SERVERS);
    expect(urls[0]).toContain('https://myapp.metered.live/');
    expect(urls[0]).toContain('apiKey=secret-key');
  });

  test('lose to an org relay — an explicitly managed relay outranks a manual one', async ({ page }) => {
    await signIn(page);
    let meteredAsked = 0;
    await page.route('**/org/org-1/ice-servers', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ice_servers: ORG_SERVERS }) }));
    await page.route('**/*.metered.live/**', (route) => { meteredAsked++; return route.fulfill({ status: 200, body: '[]' }); });

    const out = await resolve(page);
    expect(out.resolution.source).toBe('org');
    expect(meteredAsked).toBe(0);
  });

  test('an HTTP error falls through to the rest of the chain', async ({ page }) => {
    await page.route('**/*.metered.live/**', (route) => route.fulfill({ status: 403, body: 'nope' }));
    expect((await resolve(page)).resolution.source).toBe('fallback');
  });

  test('an empty list is treated as no relay, not as success', async ({ page }) => {
    await page.route('**/*.metered.live/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    expect((await resolve(page)).resolution.source).toBe('fallback');
  });

  test('half-configured credentials are ignored rather than sent', async ({ page }) => {
    await page.evaluate(() => localStorage.removeItem('metered-api-key'));
    let asked = 0;
    await page.route('**/*.metered.live/**', (route) => { asked++; return route.fulfill({ status: 200, body: '[]' }); });

    await resolve(page);
    expect(asked).toBe(0);
  });
});

// --- what the chain reports --------------------------------------------------

test.describe('re-resolving after the identity changes', () => {
  test('signing out drops the org servers the panel was showing', async ({ page }) => {
    await signIn(page);
    await page.route('**/org/org-1/ice-servers', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ice_servers: ORG_SERVERS }) }));
    await resolve(page);

    const after = await page.evaluate(async () => {
      localStorage.removeItem('presence-api-token');
      localStorage.removeItem('presence-org-id');
      await window.refreshIceServers();
      return {
        source: window._lastIceResolution && window._lastIceResolution.source,
        status: localStorage.getItem('metered-status'),
        servers: localStorage.getItem('metered-servers'),
      };
    });

    expect(after.source).toBe('fallback');
    // Otherwise the panel keeps naming a relay we can no longer mint for.
    expect(after.status).toBe(null);
    expect(after.servers).toBe(null);
  });

  test('a refresh clears the "verified over a round trip" mark — it proved the old relay', async ({ page }) => {
    const verified = await page.evaluate(async () => {
      window._relayVerifiedAt = Date.now();
      await window.refreshIceServers();
      return window._relayVerifiedAt;
    });
    expect(verified).toBe(null);
  });
});

// --- the Tauri presence proxy both legs go through ---------------------------

test.describe('tauriFetch — the Rust CORS proxy', () => {
  test('a successful proxied call looks exactly like a fetch response', async ({ page }) => {
    const out = await page.evaluate(async () => {
      const calls = [];
      window.__TAURI__ = {
        core: {
          invoke: (cmd, args) => { calls.push({ cmd, args }); return Promise.resolve({ hello: 'world' }); },
        },
      };
      const res = await window.tauriFetch('https://presence.test/org/o/presence', {
        method: 'POST',
        headers: { 'x-api-token': 'tok', 'x-room-secret': 'sec' },
        body: '{"a":1}',
      });
      const body = await res.json();
      delete window.__TAURI__;
      return { calls, ok: res.ok, status: res.status, body };
    });

    expect(out.ok).toBe(true);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ hello: 'world' });
    expect(out.calls[0].cmd).toBe('presence_fetch');
    expect(out.calls[0].args).toMatchObject({
      url: 'https://presence.test/org/o/presence',
      method: 'POST',
      token: 'tok',
      secret: 'sec',
      body: '{"a":1}',
    });
  });

  test('a GET with no headers sends nulls, not undefined, to Rust', async ({ page }) => {
    // `undefined` does not survive the IPC boundary as an absent argument, and
    // the Rust side takes Option<String> — so the JS side must send null.
    const args = await page.evaluate(async () => {
      let seen = null;
      window.__TAURI__ = { core: { invoke: (cmd, a) => { seen = a; return Promise.resolve(null); } } };
      await window.tauriFetch('https://presence.test/thing');
      delete window.__TAURI__;
      return seen;
    });

    expect(args).toEqual({
      url: 'https://presence.test/thing',
      method: 'GET',
      token: null,
      secret: null,
      body: null,
    });
  });

  test('an HTTP status the proxy reports as an error is turned back into that status', async ({ page }) => {
    const out = await page.evaluate(async () => {
      window.__TAURI__ = { core: { invoke: () => Promise.reject('HTTP 404') } };
      const res = await window.tauriFetch('https://presence.test/missing');
      const body = await res.json();
      delete window.__TAURI__;
      return { ok: res.ok, status: res.status, body };
    });

    expect(out.ok).toBe(false);
    expect(out.status).toBe(404);
    expect(out.body).toBe(null);
  });

  test('a failure with no HTTP status in it reads as a server error', async ({ page }) => {
    const status = await page.evaluate(async () => {
      window.__TAURI__ = { core: { invoke: () => Promise.reject(new Error('connection reset')) } };
      const res = await window.tauriFetch('https://presence.test/thing');
      delete window.__TAURI__;
      return res.status;
    });

    expect(status).toBe(500);
  });

  test('off Tauri it is a plain fetch, with the options passed straight through', async ({ page }) => {
    await page.route('**/presence.test/echo', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ method: route.request().method() }) }));

    const out = await page.evaluate(async () => {
      const res = await window.tauriFetch('https://presence.test/echo', { method: 'POST', body: 'x' });
      return { ok: res.ok, body: await res.json() };
    });

    expect(out.ok).toBe(true);
    expect(out.body).toEqual({ method: 'POST' });
  });
});
