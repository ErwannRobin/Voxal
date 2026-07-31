import { test, expect } from './fixtures.js';

// The connection-status badge and popover.
//
// These used to read localStorage['metered-status'], which only the ORG path
// ever writes — so an anonymous user with a working Cloudflare relay was told
// "TURN not configured". The status is now derived from what fetchIceServers()
// actually resolved, which fixes that and the opposite staleness (claiming "ok"
// long after a credential died).

const ANON_BODY = {
  ice_servers: [{ urls: ['turn:cf:3478?transport=tcp', 'turns:cf:5349'], username: 'u', credential: 'c' }],
  expires_at: new Date(Date.now() + 3600e3).toISOString(),
};

function stubAnon(page, body = ANON_BODY, status = 200) {
  return page.route('**/api/ice-servers', (route) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }));
}

async function statusAfterResolve(page) {
  return page.evaluate(async () => {
    await window.fetchIceServers();
    window.updateTurnBadge();
    return {
      text: document.getElementById('conn-status-content').textContent,
      badge: document.getElementById('turn-badge').className,
    };
  });
}

test.describe('TURN status — by resolution source', () => {
  test('anonymous credentials read as configured, naming the source', async ({ page }) => {
    await page.goto('/');
    await stubAnon(page);
    const s = await statusAfterResolve(page);
    // The exact report: working relay, menu must not say "not configured".
    expect(s.text).not.toContain('TURN not configured');
    expect(s.text).toContain('TURN — 1 server');
    expect(s.text).toContain('(Cloudflare, anonymous)');
    expect(s.badge).toContain('ok');
  });

  test('an embed-provided relay is credited to the site', async ({ page }) => {
    await page.goto('/');
    const s = await page.evaluate(async () => {
      window.applyIframeConfig({ iceServers: [{ urls: 'turn:site:3478', username: 'u' }] });
      await window.fetchIceServers();
      window.updateTurnBadge();
      return {
        text: document.getElementById('conn-status-content').textContent,
        badge: document.getElementById('turn-badge').className,
      };
    });
    expect(s.text).toContain('provided by this site');
    expect(s.badge).toContain('ok');
  });

  test('a custom relay counts as configured', async ({ page }) => {
    await page.goto('/');
    await page.route('**/api/ice-servers', (route) => route.abort());
    await page.evaluate(() => localStorage.setItem('turn-fallback',
      JSON.stringify([{ urls: 'turn:my.relay:443', username: 'u', credential: 'p' }])));
    const s = await statusAfterResolve(page);
    expect(s.text).toContain('custom relay');
    expect(s.badge).toContain('ok');
  });

  // The regression this fix must not introduce: four dead openrelay entries are
  // still four "relay servers", and a naive count would show a green tick.
  test('the retired built-in relay is NOT reported as working', async ({ page }) => {
    await page.goto('/');
    await page.route('**/api/ice-servers', (route) => route.abort());
    const s = await statusAfterResolve(page);
    expect(s.text).toContain('retired');
    // Scope to the TURN row — the popover has a separate "✓ STUN available".
    expect(s.text).not.toContain('✓ TURN');
    expect(s.badge).toContain('partial');
    expect(s.badge).not.toContain('ok');
  });

  test('relay Off reads as not configured', async ({ page }) => {
    await page.goto('/');
    await page.route('**/api/ice-servers', (route) => route.abort());
    await page.evaluate(() => localStorage.setItem('turn-fallback', '[]'));
    const s = await statusAfterResolve(page);
    expect(s.text).toContain('TURN not configured');
    expect(s.badge).toContain('partial');
  });

  test('shows "checking" before anything has resolved', async ({ page }) => {
    await page.goto('/');
    const s = await page.evaluate(() => {
      window._lastIceResolution = null;
      window.updateTurnBadge();
      return {
        text: document.getElementById('conn-status-content').textContent,
        badge: document.getElementById('turn-badge').className,
      };
    });
    // Never claim "not configured" before we have looked.
    expect(s.text).toContain('Checking relay');
    expect(s.text).not.toContain('not configured');
    expect(s.badge).toContain('partial');
  });
});

test.describe('TURN status — independence from the persisted key', () => {
  test('a stale metered-status=ok does not fake a working relay', async ({ page }) => {
    await page.goto('/');
    await page.route('**/api/ice-servers', (route) => route.abort());
    const s = await page.evaluate(async () => {
      // Left over from an org credential that has since stopped working.
      localStorage.setItem('metered-status', 'ok');
      localStorage.setItem('metered-count', '5');
      localStorage.setItem('turn-fallback', '[]');
      await window.fetchIceServers();
      window.updateTurnBadge();
      return {
        text: document.getElementById('conn-status-content').textContent,
        badge: document.getElementById('turn-badge').className,
      };
    });
    expect(s.text).toContain('TURN not configured');
    expect(s.badge).toContain('partial');
  });

  test('a blank metered-status does not hide a working relay', async ({ page }) => {
    await page.goto('/');
    await stubAnon(page);
    const s = await page.evaluate(async () => {
      localStorage.removeItem('metered-status');
      await window.fetchIceServers();
      window.updateTurnBadge();
      return document.getElementById('conn-status-content').textContent;
    });
    expect(s).toContain('TURN — 1 server');
  });
});

test.describe('TURN status — relay verification', () => {
  test('a relayed echo run marks the line verified', async ({ page }) => {
    await page.goto('/');
    await stubAnon(page);
    const text = await page.evaluate(async () => {
      await window.fetchIceServers();
      window._relayVerifiedAt = Date.now();
      window.updateTurnBadge();
      return document.getElementById('conn-status-content').textContent;
    });
    expect(text).toContain('verified');
  });

  test('verification is not claimed on a relay we do not believe in', async ({ page }) => {
    await page.goto('/');
    await page.route('**/api/ice-servers', (route) => route.abort());
    const text = await page.evaluate(async () => {
      await window.fetchIceServers();       // falls through to the retired default
      window._relayVerifiedAt = Date.now(); // stale marker from an earlier run
      window.updateTurnBadge();
      return document.getElementById('conn-status-content').textContent;
    });
    expect(text).not.toContain('verified');
  });
});

test.describe('noteIceResolution', () => {
  test('counts only turn:/turns: entries, ignoring STUN', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(() => {
      window.noteIceResolution('org', [
        { urls: 'stun:s:1' },
        { urls: 'turn:a:2' },
        { urls: ['stun:s:3', 'turns:b:4'] },
      ]);
      return window._lastIceResolution;
    });
    expect(r.source).toBe('org');
    expect(r.relayCount).toBe(2);
    expect(r.at).toBeGreaterThan(0);
  });

  test('returns the servers unchanged so it can wrap a return', async ({ page }) => {
    await page.goto('/');
    const same = await page.evaluate(() => {
      const servers = [{ urls: 'turn:a:1' }];
      return window.noteIceResolution('org', servers) === servers;
    });
    expect(same).toBe(true);
  });
});
