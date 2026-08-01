import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// A web page cannot persist a getUserMedia grant — the browser owns it, keyed by
// origin, with no API to extend or restore it. All the app can do is name the
// exact control that makes it stick, per platform, and only once the browser has
// demonstrably failed to keep it.

const spoof = (page, ua, extra = {}) =>
  page.addInitScript(([u, e]) => {
    Object.defineProperty(navigator, 'userAgent', { get: () => u });
    if (e.platform !== undefined) Object.defineProperty(navigator, 'platform', { get: () => e.platform });
    if (e.maxTouchPoints !== undefined) Object.defineProperty(navigator, 'maxTouchPoints', { get: () => e.maxTouchPoints });
    if (e.capacitor) window.Capacitor = { isNativePlatform: () => true };
  }, [ua, extra]);

const hint = (page) => page.evaluate(() => window.micPermissionHint());

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  odd: 'SomeBrowser/1.0',
};

test.describe('micPermissionHint — per platform', () => {
  test('iOS names Website Settings, the only thing that survives a reload there', async ({ page }) => {
    await spoof(page, UA.iphone);
    await page.goto('/');
    const h = await hint(page);
    expect(h.platform).toBe('ios');
    // WebKit scopes the grant to the document, so nothing chosen in the prompt
    // itself can help — the per-site toggle is the whole answer.
    expect(h.html).toContain('Website Settings');
    expect(h.html).toContain('aA');
  });

  test('iPadOS is caught despite claiming to be macOS', async ({ page }) => {
    await spoof(page, UA.macSafari, { platform: 'MacIntel', maxTouchPoints: 5 });
    await page.goto('/');
    expect((await hint(page)).platform).toBe('ios');
  });

  test('desktop Safari gets its own menu path, not the iOS one', async ({ page }) => {
    await spoof(page, UA.macSafari, { platform: 'MacIntel', maxTouchPoints: 0 });
    await page.goto('/');
    const h = await hint(page);
    expect(h.platform).toBe('safari');
    expect(h.html).toContain('Settings for This Website');
    expect(h.html).not.toContain('aA');
  });

  test('Firefox points at the checkbox that is unticked by default', async ({ page }) => {
    await spoof(page, UA.firefox);
    await page.goto('/');
    const h = await hint(page);
    expect(h.platform).toBe('firefox');
    expect(h.html).toContain('Remember this decision');
  });

  test('Chromium desktop names the persistent option in the prompt', async ({ page }) => {
    await spoof(page, UA.chrome, { platform: 'MacIntel', maxTouchPoints: 0 });
    await page.goto('/');
    const h = await hint(page);
    expect(h.platform).toBe('chromium');
    expect(h.html).toContain('Allow on every visit');
  });

  test('Edge is Chromium, not Safari — despite carrying Safari in its UA', async ({ page }) => {
    await spoof(page, UA.edge, { platform: 'Win32', maxTouchPoints: 0 });
    await page.goto('/');
    expect((await hint(page)).platform).toBe('chromium');
  });

  test('Chromium on Android gets the address-bar path, not the desktop one', async ({ page }) => {
    await spoof(page, UA.chromeAndroid);
    await page.goto('/');
    const h = await hint(page);
    expect(h.platform).toBe('chromium-android');
    expect(h.html).toContain('Permissions');
  });

  test('an unknown browser still gets something actionable', async ({ page }) => {
    await spoof(page, UA.odd, { platform: '', maxTouchPoints: 0 });
    await page.goto('/');
    const h = await hint(page);
    expect(h.platform).toBe('unknown');
    expect(h.html).toMatch(/remember|always allow/i);
  });

  test('native builds get no hint — the OS permission already persists', async ({ page }) => {
    await spoof(page, UA.iphone, { capacitor: true });
    await page.goto('/');
    // Advice about browser settings for a browser the user is not using.
    expect(await hint(page)).toBe(null);
  });
});

test.describe('when the hint appears', () => {
  // The hint is a row in the PEER LIST, next to the invite nudge — not a banner
  // in the PTT column, where it displaced the talk button. So it is built with
  // the list and simply absent when it should not show.
  async function inRoom(page, { count, dismissed, ua = UA.iphone } = {}) {
    await spoof(page, ua);
    await page.goto('/');
    await seedRoom(page, { isHost: true, roomCode: 'abc-def' });
    await page.evaluate(([c, d]) => {
      if (c === null) localStorage.removeItem('mic-prompt-count');
      else localStorage.setItem('mic-prompt-count', String(c));
      if (d) localStorage.setItem('mic-hint-dismissed', '1');
      else localStorage.removeItem('mic-hint-dismissed');
      showScreen('room');
      updatePeerList();
    }, [count === undefined ? null : count, !!dismissed]);
  }

  test('stays hidden on a first visit — one prompt is normal', async ({ page }) => {
    await inRoom(page, { count: 1 });
    await expect(page.locator('#mic-hint-banner')).toHaveCount(0);
  });

  test('appears once the browser has asked on two separate visits', async ({ page }) => {
    await inRoom(page, { count: 2 });
    await expect(page.locator('#mic-hint-banner')).toBeVisible();
  });

  test('stays hidden once dismissed, however many prompts follow', async ({ page }) => {
    await inRoom(page, { count: 9, dismissed: true });
    await expect(page.locator('#mic-hint-banner')).toHaveCount(0);
  });

  test('sits inside the peer list, beside the invite nudge', async ({ page }) => {
    await inRoom(page, { count: 2 });
    const parent = await page.evaluate(() =>
      document.getElementById('mic-hint-banner').parentElement.id);
    expect(parent).toBe('peers-list');
  });

  test('does not displace the talk button', async ({ page }) => {
    await spoof(page, UA.iphone);
    await page.goto('/');
    await seedRoom(page, { isHost: true, roomCode: 'abc-def' });
    const before = await page.evaluate(() => {
      localStorage.removeItem('mic-prompt-count');
      showScreen('room');
      updatePeerList();
      return document.getElementById('ptt-btn').getBoundingClientRect().top;
    });
    const after = await page.evaluate(() => {
      localStorage.setItem('mic-prompt-count', '3');
      updatePeerList();
      return document.getElementById('ptt-btn').getBoundingClientRect().top;
    });
    // The whole point of moving it out of the PTT column.
    expect(after).toBe(before);
  });

  test('closes with an X, not a button labelled "Got it"', async ({ page }) => {
    await inRoom(page, { count: 3 });
    const close = page.locator('#btn-dismiss-mic-hint');
    await expect(close).toHaveText('✕');
    await expect(close).toHaveAttribute('aria-label', 'Dismiss');
  });

  test('the close button hides it and the choice survives a reload', async ({ page }) => {
    await inRoom(page, { count: 3 });
    await expect(page.locator('#mic-hint-banner')).toBeVisible();
    await page.locator('#btn-dismiss-mic-hint').click();
    await expect(page.locator('#mic-hint-banner')).toHaveCount(0);

    await page.reload();
    await seedRoom(page, { isHost: true, roomCode: 'abc-def' });
    await page.evaluate(() => { showScreen('room'); updatePeerList(); });
    await expect(page.locator('#mic-hint-banner')).toHaveCount(0);
  });

  test('renders the steps for the platform actually in use', async ({ page }) => {
    await inRoom(page, { count: 2, ua: UA.firefox });
    await expect(page.locator('#mic-hint-banner')).toContainText('Remember this decision');
  });

  test('is kept out of tiny embeds, which have no room for it', async ({ page }) => {
    await spoof(page, UA.iphone);
    await page.goto('/?tiny=1');
    await seedRoom(page, { isHost: true, roomCode: 'abc-def' });
    await page.evaluate(() => {
      localStorage.setItem('mic-prompt-count', '5');
      showScreen('room');
      updatePeerList();
    });
    await expect(page.locator('#mic-hint-banner')).toHaveCount(0);
  });
});

test.describe('counting prompts', () => {
  // The signal is timing: a grant the browser remembered resolves in
  // milliseconds, one that needed a human tap cannot. There is no API — neither
  // Safari nor Firefox exposes `microphone` to navigator.permissions.query().
  const note = (page, ms) => page.evaluate((m) => {
    localStorage.removeItem('mic-prompt-count');
    window.noteMicAcquisition(m);
    return localStorage.getItem('mic-prompt-count');
  }, ms);

  test('a fast grant is not counted — the browser clearly remembered', async ({ page }) => {
    await spoof(page, UA.iphone);
    await page.goto('/');
    expect(await note(page, 40)).toBe(null);
  });

  test('a slow grant is counted — someone had to answer a prompt', async ({ page }) => {
    await spoof(page, UA.iphone);
    await page.goto('/');
    expect(await note(page, 2500)).toBe('1');
  });

  test('counts accumulate across visits, which is what makes it meaningful', async ({ page }) => {
    await spoof(page, UA.iphone);
    await page.goto('/');
    await seedRoom(page, { isHost: true, roomCode: 'abc-def' });
    const n = await page.evaluate(() => {
      showScreen('room');
      localStorage.removeItem('mic-prompt-count');
      window.noteMicAcquisition(1500);
      window.noteMicAcquisition(1500);
      return localStorage.getItem('mic-prompt-count');
    });
    expect(n).toBe('2');
    // The second one re-rendered the peer list, so it is on screen already.
    await expect(page.locator('#mic-hint-banner')).toBeVisible();
  });

  test('native never counts, so the hint can never surface there', async ({ page }) => {
    await spoof(page, UA.iphone, { capacitor: true });
    await page.goto('/');
    expect(await note(page, 5000)).toBe(null);
  });
});
