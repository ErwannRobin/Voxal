import { test, expect } from './fixtures.js';

// Two readouts the settings modal fills in when it opens, both of which have to
// survive the thing being absent.
//
// About: `build-info.js` is stamped by the build (`make gen-build-info`) and is
// simply not there in a plain checkout — index.html drops the tag on error. So
// the panel has to show something either way, and it shows different things on
// web and on native: on web there is no app version worth naming, so the commit
// stands in for it; on native the real version stays and the commit rides next
// to the build date.
//
// Relay: the last "Test over network" result is persisted, so reopening
// settings must restore what it said rather than starting blank — and must not
// restore a hover popover for servers it no longer has.

const openSettings = (page) => page.click('#btn-open-settings');

/** Stamp a build-info.js's worth of globals before main.js runs. */
async function stampBuild(page, { commit, date }) {
  await page.addInitScript(({ commit, date }) => {
    window.VOXAL_COMMIT = commit;
    window.VOXAL_WEB_BUILD_DATE = date;
  }, { commit, date });
}

/** Make main.js believe it is running inside the iOS/Android shell. */
async function stubNativeMobile(page) {
  await page.addInitScript(() => {
    window.Capacitor = {
      isNativePlatform: () => true,
      Plugins: { App: { getInfo: () => Promise.resolve({ version: '9.9.9' }) } },
    };
  });
}

const aboutText = (page) =>
  page.evaluate(() => ({
    version: document.getElementById('about-version-modal').textContent,
    date: document.getElementById('about-build-date-modal').textContent,
  }));

test.describe('the About readout', () => {
  test('an unstamped checkout falls back to the version.js constants', async ({ page }) => {
    await page.goto('/');
    await openSettings(page);
    const about = await aboutText(page);

    // build-info.js is gitignored, so this is what a contributor sees locally.
    expect(about.version).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(about.date).not.toBe('—');
    expect(about.date).not.toContain('Invalid');
  });

  test('on web the commit stands in for a version there is no such thing as', async ({ page }) => {
    await stampBuild(page, { commit: 'abc1234', date: '2026-03-04T10:00:00Z' });
    await page.goto('/');
    await openSettings(page);
    const about = await aboutText(page);

    expect(about.version).toBe('abc1234');
    expect(about.date).toBe('4 Mar 2026');
  });

  test('on native the app version stays and the commit rides with the date', async ({ page }) => {
    await stubNativeMobile(page);
    await stampBuild(page, { commit: 'abc1234', date: '2026-03-04T10:00:00Z' });
    await page.goto('/');
    await openSettings(page);
    await expect(page.locator('#about-version-modal')).toHaveText('v9.9.9');

    const about = await aboutText(page);
    expect(about.date).toBe('4 Mar 2026 · abc1234');
  });

  test('a native shell that cannot report its version falls back to version.js', async ({ page }) => {
    await page.addInitScript(() => {
      window.Capacitor = {
        isNativePlatform: () => true,
        Plugins: { App: { getInfo: () => Promise.reject(new Error('no plugin')) } },
      };
    });
    await page.goto('/');
    await openSettings(page);

    await expect(page.locator('#about-version-modal')).toHaveText(/^v\d+\.\d+\.\d+$/);
  });
});

test.describe('the saved relay-test readout', () => {
  const status = (page) =>
    page.evaluate(() => {
      const el = document.getElementById('turn-test-status');
      return { text: el.textContent, color: el.style.color, hasHover: typeof el.onmouseenter === 'function' };
    });

  test('a previous success is restored, with the server count', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('metered-status', 'ok');
      localStorage.setItem('metered-count', '3');
      localStorage.setItem('metered-servers', JSON.stringify([{ urls: 'turn:relay.example:3478' }]));
    });
    await openSettings(page);

    const s = await status(page);
    expect(s.text).toContain('3 servers ready');
    expect(s.color).toContain('--green');
    // The stored server list is reachable on hover.
    expect(s.hasHover).toBe(true);
  });

  test('a previous failure is restored as a failure, with no server list to hover', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.setItem('metered-status', 'error'));
    await openSettings(page);

    const s = await status(page);
    expect(s.text).toContain('Test failed');
    expect(s.hasHover).toBe(false);
  });

  test('no previous test leaves it blank rather than claiming anything', async ({ page }) => {
    await page.goto('/');
    await openSettings(page);

    const s = await status(page);
    expect(s.text).toBe('');
    expect(s.hasHover).toBe(false);
  });

  test('an "ok" with no count is not reported as a success', async ({ page }) => {
    // Half-written state (count cleared, status left behind) must not render as
    // "✓ null servers ready".
    await page.goto('/');
    await page.evaluate(() => localStorage.setItem('metered-status', 'ok'));
    await openSettings(page);

    expect((await status(page)).text).toBe('');
  });

  test('hovering the restored success lists the servers it remembers', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('metered-status', 'ok');
      localStorage.setItem('metered-count', '2');
      localStorage.setItem('metered-servers', JSON.stringify([
        { urls: ['turn:relay.example:3478', 'turns:relay.example:5349'] },
      ]));
    });
    await openSettings(page);

    const popover = await page.evaluate(() => {
      document.getElementById('turn-test-status').onmouseenter();
      const pop = document.getElementById('turn-servers-popover');
      return { hidden: pop.classList.contains('hidden'), text: pop.textContent };
    });

    expect(popover.hidden).toBe(false);
    expect(popover.text).toContain('turn:relay.example:3478');
    expect(popover.text).toContain('turns:relay.example:5349');
  });

  test('leaving the status hides the popover again', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('metered-status', 'ok');
      localStorage.setItem('metered-count', '1');
      localStorage.setItem('metered-servers', JSON.stringify([{ urls: 'turn:relay.example:3478' }]));
    });
    await openSettings(page);

    const hidden = await page.evaluate(() => {
      const el = document.getElementById('turn-test-status');
      el.onmouseenter();
      el.onmouseleave();
      return document.getElementById('turn-servers-popover').classList.contains('hidden');
    });

    expect(hidden).toBe(true);
  });

  test('an unreadable stored server list does not break the hover', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('metered-status', 'ok');
      localStorage.setItem('metered-count', '1');
      localStorage.setItem('metered-servers', 'not json');
    });
    await openSettings(page);

    const ok = await page.evaluate(() => {
      document.getElementById('turn-test-status').onmouseenter();
      return true;
    });
    expect(ok).toBe(true);
  });
});
