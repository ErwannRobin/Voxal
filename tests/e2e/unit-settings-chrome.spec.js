import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// Settings entry points and the layering around them.

test.describe('connection-status popover vs the settings modal', () => {
  // Reported on web: the popover painted straight through the settings dialog,
  // and the badge that dismisses it was underneath the modal — so once open it
  // could not be closed.
  test('opening settings closes the popover', async ({ page }) => {
    await page.goto('/');
    await page.locator('#turn-badge').click();
    await expect(page.locator('#conn-status-popover')).toBeVisible();

    await page.locator('#btn-open-settings').click();
    await expect(page.locator('#modal-settings')).toBeVisible();
    await expect(page.locator('#conn-status-popover')).toBeHidden();
  });

  test('the modal outranks the popover even if one is somehow left open', async ({ page }) => {
    await page.goto('/');
    const z = await page.evaluate(() => {
      const zOf = (sel) => Number(getComputedStyle(document.querySelector(sel)).zIndex);
      document.getElementById('conn-status-popover').classList.remove('hidden');
      document.getElementById('modal-settings').classList.remove('hidden');
      return { popover: zOf('#conn-status-popover'), modal: zOf('#modal-settings') };
    });
    expect(z.modal).toBeGreaterThan(z.popover);
  });

  test('the TURN server list still shows above the modal it belongs to', async ({ page }) => {
    // It hangs off #turn-test-status INSIDE the modal but is appended to <body>,
    // so it is a sibling of .modal and has to outrank it to be visible at all.
    await page.goto('/');
    const z = await page.evaluate(() => {
      const pop = document.createElement('div');
      pop.className = 'turn-servers-popover';
      document.body.appendChild(pop);
      const modal = document.getElementById('modal-settings');
      modal.classList.remove('hidden');
      return {
        servers: Number(getComputedStyle(pop).zIndex),
        modal: Number(getComputedStyle(modal).zIndex),
      };
    });
    expect(z.servers).toBeGreaterThan(z.modal);
  });
});

test.describe('in-room settings gear', () => {
  test('is available on web, where there is no menu bar', async ({ page }) => {
    await page.goto('/');
    await seedRoom(page, { isHost: true, roomCode: 'abc-def' });
    await page.evaluate(() => showScreen('room'));
    await expect(page.locator('#btn-open-settings-room')).toBeVisible();
    await page.locator('#btn-open-settings-room').click();
    await expect(page.locator('#modal-settings')).toBeVisible();
  });

  test('is hidden on Tauri desktop — the menu bar already has Preferences', async ({ page }) => {
    // Duplicating an entry point that the OS menu already provides, in a header
    // that is otherwise just the room code.
    await page.addInitScript(() => {
      window.__TAURI__ = { event: { listen() {}, once() {} } };
    });
    await page.goto('/');
    await seedRoom(page, { isHost: true, roomCode: 'abc-def' });
    await page.evaluate(() => showScreen('room'));
    await expect(page.locator('#btn-open-settings-room')).toBeHidden();
  });
});

test.describe('network test bridge', () => {
  // The desktop preferences window is a separate WebviewWindow and cannot run
  // the test itself, so it asks the main window over localStorage. Without this
  // the feature was unreachable on desktop entirely: settings.html had only a
  // hint pointing at a gear that is hidden on that platform.
  const REQUEST = 'echo-test-request';
  const STATE = 'echo-test-state';

  test('a start request from the other window runs the real test', async ({ page }) => {
    await page.addInitScript(() => {
      window.__TAURI__ = { event: { listen() {}, once() {} } };
    });
    await page.goto('/');
    const called = await page.evaluate(() => {
      let ran = 0;
      window.toggleEchoTest = function() { ran++; return Promise.resolve(); };
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'echo-test-request',
        newValue: JSON.stringify({ action: 'start', at: Date.now() }),
      }));
      return ran;
    });
    expect(called).toBe(1);
  });

  test('status text is published for the other window to mirror', async ({ page }) => {
    await page.addInitScript(() => {
      window.__TAURI__ = { event: { listen() {}, once() {} } };
    });
    await page.goto('/');
    const state = await page.evaluate(() => {
      window.echoStatus('Speak now — recording…', 'good');
      return JSON.parse(localStorage.getItem('echo-test-state'));
    });
    expect(state.text).toBe('Speak now — recording…');
    expect(state.kind).toBe('good');
    expect(state.running).toBe(false); // no test actually in flight here
  });

  test('nothing is published on web — there is no second window to talk to', async ({ page }) => {
    await page.goto('/');
    const stored = await page.evaluate(() => {
      localStorage.removeItem('echo-test-state');
      window.echoStatus('hello');
      return localStorage.getItem('echo-test-state');
    });
    expect(stored).toBe(null);
  });

  test('a stop request with nothing running re-publishes idle instead of hanging', async ({ page }) => {
    await page.addInitScript(() => {
      window.__TAURI__ = { event: { listen() {}, once() {} } };
    });
    await page.goto('/');
    const state = await page.evaluate(() => {
      localStorage.removeItem('echo-test-state');
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'echo-test-request',
        newValue: JSON.stringify({ action: 'stop', at: Date.now() }),
      }));
      return JSON.parse(localStorage.getItem('echo-test-state'));
    });
    // A reopened preferences window starts from a blank slate and can disagree
    // about what is running; it must not be left stuck on "Stopping…".
    expect(state.running).toBe(false);
    expect(state.text).toBe('');
  });

  test('a malformed request is ignored rather than throwing', async ({ page }) => {
    await page.addInitScript(() => {
      window.__TAURI__ = { event: { listen() {}, once() {} } };
    });
    await page.goto('/');
    const threw = await page.evaluate(() => {
      try {
        window.dispatchEvent(new StorageEvent('storage', {
          key: 'echo-test-request', newValue: 'not json',
        }));
        return false;
      } catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });

  // Keep the two halves of the bridge in step: settings.html duplicates these
  // strings by hand because there is no module system to share them.
  test('the preferences window uses the same key names', async ({ page }) => {
    const res = await page.request.get('/settings.html');
    const html = await res.text();
    expect(html).toContain("'" + REQUEST + "'");
    expect(html).toContain("'" + STATE + "'");
    // …and offers a real control rather than pointing at a gear that desktop hides.
    expect(html).toContain('id="btn-test-echo"');
    expect(html).toContain('id="echo-test-status"');
  });
});
