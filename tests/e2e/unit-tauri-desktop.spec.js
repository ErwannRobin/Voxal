import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// The desktop-only half of main.js: the extra windows Tauri gives us
// (Preferences, About), the menu-bar and updater events that open them, the
// deep link that carries a sign-in token back into the app, and the global
// push-to-talk shortcut that keeps working while Voxal is in the background.
//
// None of it runs on web, and `IS_TAURI_DESKTOP` / the `window.__TAURI__`
// checks are evaluated as main.js loads — so the bridge has to be installed by
// an init script, before the page script runs, rather than assigned afterwards.

/** A fake Tauri bridge: an event bus, plus a recording WebviewWindow. */
async function stubTauri(page) {
  await page.addInitScript(() => {
    const listeners = new Map();
    const windows = [];

    class FakeWebviewWindow {
      constructor(label, options) {
        this.label = label;
        this.options = options;
        this.onceHandlers = {};
        this.closed = false;
        // Windows are "alive" by default; a test can make setFocus reject to
        // stand in for one the user already closed.
        this.focusRejects = false;
        this.focusCalls = 0;
        windows.push(this);
      }
      setFocus() {
        this.focusCalls++;
        return this.focusRejects ? Promise.reject(new Error('window is gone')) : Promise.resolve();
      }
      once(name, handler) { this.onceHandlers[name] = handler; return Promise.resolve(() => {}); }
      close() { this.closed = true; return Promise.resolve(); }
    }

    window.__TAURI__ = {
      core: { invoke: () => Promise.resolve() },
      shell: { open: () => Promise.resolve() },
      webviewWindow: { WebviewWindow: FakeWebviewWindow },
      event: {
        listen(name, handler) {
          if (!listeners.has(name)) listeners.set(name, []);
          listeners.get(name).push(handler);
          return Promise.resolve(() => {});
        },
        once(name, handler) { return this.listen(name, handler); },
        emit: () => Promise.resolve(),
      },
    };

    window.__tauriTest = {
      windows,
      /** Deliver a Tauri event, as the Rust side would. */
      deliver: (name, payload) =>
        Promise.all((listeners.get(name) || []).map((h) => h({ payload }))),
      fireWindow: (index, name, arg) => {
        const h = windows[index] && windows[index].onceHandlers[name];
        return h ? h(arg) : null;
      },
      windowsWithLabel: (label) => windows.filter((w) => w.label === label),
    };
  });
}

test.beforeEach(async ({ page }) => {
  await stubTauri(page);
  await page.goto('/');
});

// --- the Preferences window --------------------------------------------------

test.describe('Preferences window', () => {
  test('the menu-bar item opens settings.html in its own window', async ({ page }) => {
    const win = await page.evaluate(async () => {
      await window.__tauriTest.deliver('open-preferences');
      const w = window.__tauriTest.windowsWithLabel('preferences')[0];
      return w && { label: w.label, ...w.options };
    });

    expect(win).toBeTruthy();
    expect(win.url).toBe('settings.html');
    expect(win.title).toContain('Preferences');
    expect(win.resizable).toBe(true);
  });

  test('the in-room gear opens the same window, not the in-page modal', async ({ page }) => {
    const state = await page.evaluate(async () => {
      document.getElementById('btn-open-settings-room').click();
      await new Promise((r) => setTimeout(r, 0));
      return {
        windows: window.__tauriTest.windowsWithLabel('preferences').length,
        modalOpen: !document.getElementById('modal-settings').classList.contains('hidden'),
      };
    });

    expect(state.windows).toBe(1);
    expect(state.modalOpen).toBe(false);
  });

  test('asking twice focuses the window it already opened', async ({ page }) => {
    const state = await page.evaluate(async () => {
      await window.__tauriTest.deliver('open-preferences');
      await window.__tauriTest.deliver('open-preferences');
      const wins = window.__tauriTest.windowsWithLabel('preferences');
      return { count: wins.length, focusCalls: wins[0].focusCalls };
    });

    expect(state.count).toBe(1);
    expect(state.focusCalls).toBe(1);
  });

  test('a window the user already closed is replaced, not focused into nothing', async ({ page }) => {
    const count = await page.evaluate(async () => {
      const t = window.__tauriTest;
      await t.deliver('open-preferences');
      // Tauri only reports the closure when we try to touch the window.
      t.windowsWithLabel('preferences')[0].focusRejects = true;
      await t.deliver('open-preferences');
      await new Promise((r) => setTimeout(r, 10));
      return t.windowsWithLabel('preferences').length;
    });

    expect(count).toBe(2);
  });

  test('a closed window is forgotten, so the next request opens a fresh one', async ({ page }) => {
    const count = await page.evaluate(async () => {
      const t = window.__tauriTest;
      await t.deliver('open-preferences');
      await t.fireWindow(0, 'tauri://destroyed');
      await t.deliver('open-preferences');
      return t.windowsWithLabel('preferences').length;
    });

    expect(count).toBe(2);
  });
});

// --- the About window --------------------------------------------------------

test.describe('About window', () => {
  test('opens about.html at a fixed, non-resizable size', async ({ page }) => {
    const win = await page.evaluate(async () => {
      await window.__tauriTest.deliver('open-about');
      const w = window.__tauriTest.windowsWithLabel('about')[0];
      return w && { ...w.options };
    });

    expect(win).toBeTruthy();
    expect(win.url).toBe('about.html');
    expect(win.title).toBe('About Voxal');
    // A tiny fixed panel: resizing, minimizing and maximizing are all off.
    expect(win.resizable).toBe(false);
    expect(win.minimizable).toBe(false);
    expect(win.maximizable).toBe(false);
  });

  test('asking twice focuses the one already open', async ({ page }) => {
    const state = await page.evaluate(async () => {
      const t = window.__tauriTest;
      await t.deliver('open-about');
      await t.deliver('open-about');
      const wins = t.windowsWithLabel('about');
      return { count: wins.length, focusCalls: wins[0].focusCalls };
    });

    expect(state.count).toBe(1);
    expect(state.focusCalls).toBe(1);
  });

  test('a stale reference is replaced rather than silently doing nothing', async ({ page }) => {
    const count = await page.evaluate(async () => {
      const t = window.__tauriTest;
      await t.deliver('open-about');
      t.windowsWithLabel('about')[0].focusRejects = true;
      await t.deliver('open-about');
      await new Promise((r) => setTimeout(r, 10));
      return t.windowsWithLabel('about').length;
    });

    expect(count).toBe(2);
  });

  test('closing it lets the next request open a new one', async ({ page }) => {
    const count = await page.evaluate(async () => {
      const t = window.__tauriTest;
      await t.deliver('open-about');
      await t.fireWindow(0, 'tauri://destroyed');
      await t.deliver('open-about');
      return t.windowsWithLabel('about').length;
    });

    expect(count).toBe(2);
  });
});

// --- updater + deep links ----------------------------------------------------

test('an available update is announced by version, not silently installed', async ({ page }) => {
  const toast = await page.evaluate(async () => {
    await window.__tauriTest.deliver('update-available', '1.2.3');
    return document.getElementById('copy-toast').textContent;
  });

  expect(toast).toContain('1.2.3');
});

test('a deep link arriving from the OS is routed to the deep-link handler', async ({ page }) => {
  const seen = await page.evaluate(async () => {
    const urls = [];
    window.handleDeepLink = (u) => urls.push(u);
    // Tauri delivers these as an array of URLs.
    await window.__tauriTest.deliver('deep-link://new-url', ['voxal://auth?token=t1&state=s1']);
    // …and, on some platforms, as a bare string.
    await window.__tauriTest.deliver('deep-link://new-url', 'voxal://join?room=abc');
    return urls;
  });

  expect(seen).toEqual(['voxal://auth?token=t1&state=s1', 'voxal://join?room=abc']);
});

// --- cross-window name sync --------------------------------------------------

test('a name changed in the Preferences window lands in every field of the main one', async ({ page }) => {
  // The preferences window is a separate WebviewWindow: the only channel back
  // to the main window is localStorage plus the storage event it raises.
  const state = await page.evaluate(async () => {
    localStorage.setItem('pseudo', 'Renamed Elsewhere');
    window.dispatchEvent(new StorageEvent('storage', { key: 'pseudo', newValue: 'Renamed Elsewhere' }));
    await new Promise((r) => setTimeout(r, 0));
    return {
      pseudo: myPseudo,
      session: sessionStorage.getItem('pseudo-session'),
      settings: document.getElementById('input-pseudo-settings').value,
      invite: document.getElementById('input-pseudo-invite').value,
    };
  });

  expect(state.pseudo).toBe('Renamed Elsewhere');
  expect(state.session).toBe('Renamed Elsewhere');
  expect(state.settings).toBe('Renamed Elsewhere');
  expect(state.invite).toBe('Renamed Elsewhere');
});

test('clearing the name elsewhere clears it here too', async ({ page }) => {
  const pseudo = await page.evaluate(async () => {
    window.dispatchEvent(new StorageEvent('storage', { key: 'pseudo', newValue: null }));
    await new Promise((r) => setTimeout(r, 0));
    return { pseudo: myPseudo, invite: document.getElementById('input-pseudo-invite').value };
  });

  expect(pseudo.pseudo).toBe('');
  expect(pseudo.invite).toBe('');
});

// --- the global push-to-talk shortcut ---------------------------------------

test.describe('global PTT shortcut', () => {
  test.beforeEach(async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true });
    await page.evaluate(() => {
      // A microphone already held, so setTalking() takes its synchronous path.
      audioTrack = { enabled: false, kind: 'audio' };
      freeHandMode = false;
      isTalking = false;
      recordingShortcut = false;
      peer = { id: 'self', destroyed: false, call: () => null };
    });
  });

  const talking = (page) =>
    page.evaluate(() => ({
      isTalking: isTalking,
      track: audioTrack.enabled,
      freeHand: freeHandMode,
      button: document.getElementById('ptt-btn').classList.contains('active'),
    }));

  test('press transmits and release stops, even with the app in the background', async ({ page }) => {
    await page.evaluate(() => window.__tauriTest.deliver('ptt-press'));
    expect(await talking(page)).toMatchObject({ isTalking: true, track: true, button: true });

    await page.evaluate(() => window.__tauriTest.deliver('ptt-release'));
    expect(await talking(page)).toMatchObject({ isTalking: false, track: false, button: false });
  });

  test('a quick second press toggles hands-free, exactly like a double-tap', async ({ page }) => {
    await page.evaluate(async () => {
      const t = window.__tauriTest;
      await t.deliver('ptt-press');
      await t.deliver('ptt-release');
      await t.deliver('ptt-press');   // inside the double-tap window
    });

    expect(await talking(page)).toMatchObject({ freeHand: true });
  });

  test('the release that ends a double-press does not immediately undo it', async ({ page }) => {
    await page.evaluate(async () => {
      const t = window.__tauriTest;
      await t.deliver('ptt-press');
      await t.deliver('ptt-release');
      await t.deliver('ptt-press');
      await t.deliver('ptt-release'); // the one that completes the double-press
    });

    expect(await talking(page)).toMatchObject({ freeHand: true });
  });

  test('a slow second press is an ordinary press, not a toggle', async ({ page }) => {
    await page.evaluate(async () => {
      const t = window.__tauriTest;
      await t.deliver('ptt-press');
      await t.deliver('ptt-release');
    });
    // Past the 300 ms double-tap window.
    await page.waitForTimeout(350);
    await page.evaluate(() => window.__tauriTest.deliver('ptt-press'));

    expect(await talking(page)).toMatchObject({ freeHand: false, isTalking: true });
  });

  test('pressing while hands-free only shows feedback; releasing ends hands-free', async ({ page }) => {
    await page.evaluate(async () => {
      setFreeHand(true);
      await window.__tauriTest.deliver('ptt-press');
    });
    // The mic is already live — the press must not re-arm anything, just light up.
    expect(await talking(page)).toMatchObject({ freeHand: true, button: true });

    await page.evaluate(() => window.__tauriTest.deliver('ptt-release'));
    expect(await talking(page)).toMatchObject({ freeHand: false, button: false });
  });

  test('the shortcut is inert while a new shortcut is being recorded', async ({ page }) => {
    // Otherwise pressing the keys you are trying to bind also transmits.
    await page.evaluate(async () => {
      recordingShortcut = true;
      await window.__tauriTest.deliver('ptt-press');
    });

    expect(await talking(page)).toMatchObject({ isTalking: false, button: false });
  });

  test('the shortcut is inert while the display name is being edited', async ({ page }) => {
    await page.evaluate(async () => {
      editingSelfPseudo = true;
      await window.__tauriTest.deliver('ptt-press');
    });

    expect(await talking(page)).toMatchObject({ isTalking: false });
  });
});
