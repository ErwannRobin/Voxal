import { test, expect } from './fixtures.js';

// The dev log's pop-out window.
//
// Two implementations of the same idea: a Tauri WebviewWindow on desktop, a
// plain window.open() everywhere else. Either way the window is a separate
// document, so the log has to cross to it over a BroadcastChannel — the popped
// window announces itself with `ready` and is sent the whole buffer back; the
// two panels' Clear buttons have to reach each other; and "dock" has to close
// the window from the popped side.
//
// The channel is opened once and kept, so it is also the thing that keeps
// working after the window has been closed and reopened.

/** A fake Tauri bridge that records the WebviewWindows main.js constructs. */
async function stubTauri(page) {
  await page.addInitScript(() => {
    const windows = [];
    class FakeWebviewWindow {
      constructor(label, options) {
        this.label = label;
        this.options = options;
        this.onceHandlers = {};
        this.focusRejects = false;
        this.focusCalls = 0;
        this.closeCalls = 0;
        windows.push(this);
      }
      setFocus() {
        this.focusCalls++;
        return this.focusRejects ? Promise.reject(new Error('gone')) : Promise.resolve();
      }
      once(name, handler) { this.onceHandlers[name] = handler; return Promise.resolve(() => {}); }
      close() { this.closeCalls++; return Promise.resolve(); }
    }
    window.__TAURI__ = {
      core: { invoke: () => Promise.resolve() },
      shell: { open: () => Promise.resolve() },
      webviewWindow: { WebviewWindow: FakeWebviewWindow },
      event: { listen: () => Promise.resolve(() => {}), once: () => Promise.resolve(() => {}), emit: () => Promise.resolve() },
    };
    window.__tauriTest = {
      windows,
      devlogWindows: () => windows.filter((w) => w.label === 'devlog'),
      fireWindow: (w, name) => (w.onceHandlers[name] ? w.onceHandlers[name]() : null),
    };
  });
}

/** Stand in for the popped-out document on the other end of the channel. */
async function openPeerChannel(page) {
  await page.evaluate(() => {
    window.__peer = new BroadcastChannel('voxal-devlog');
    window.__peerMessages = [];
    window.__peer.onmessage = (e) => window.__peerMessages.push(e.data);
  });
}

// The panel is only shown in dev mode; clicking through the DOM rather than
// through Playwright keeps these tests about the window, not the panel's
// visibility (which unit-diagnostics-panel.spec.js already covers).
const popOut = (page) =>
  page.evaluate(() => document.getElementById('btn-popout-dev-log').click());
const isPopped = (page) =>
  page.evaluate(() => document.getElementById('dev-log-panel').classList.contains('popped-out'));

/** Let a BroadcastChannel message make its round trip. */
const settle = (page) => page.evaluate(() => new Promise((r) => setTimeout(r, 20)));

test.describe('on Tauri desktop', () => {
  test.beforeEach(async ({ page }) => {
    await stubTauri(page);
    await page.goto('/');
  });

  test('opens devlog.html in a window and marks the panel popped out', async ({ page }) => {
    await popOut(page);
    const win = await page.evaluate(() => {
      const w = window.__tauriTest.devlogWindows()[0];
      return w && { label: w.label, ...w.options };
    });

    expect(win).toBeTruthy();
    expect(win.url).toBe('devlog.html');
    expect(win.title).toContain('Dev Log');
    expect(win.resizable).toBe(true);
    expect(await isPopped(page)).toBe(true);
  });

  test('a second click focuses the window rather than opening another', async ({ page }) => {
    await popOut(page);
    await popOut(page);
    const state = await page.evaluate(() => {
      const wins = window.__tauriTest.devlogWindows();
      return { count: wins.length, focusCalls: wins[0].focusCalls };
    });

    expect(state.count).toBe(1);
    expect(state.focusCalls).toBe(1);
  });

  test('closing the window docks the panel again', async ({ page }) => {
    await popOut(page);
    await page.evaluate(() => window.__tauriTest.fireWindow(window.__tauriTest.devlogWindows()[0], 'tauri://destroyed'));

    expect(await isPopped(page)).toBe(false);
    // …and the next click opens a fresh window instead of focusing a dead one.
    await popOut(page);
    expect(await page.evaluate(() => window.__tauriTest.devlogWindows().length)).toBe(2);
  });

  test('a window that turns out to be gone is replaced, and the panel stays popped', async ({ page }) => {
    await popOut(page);
    await page.evaluate(() => { window.__tauriTest.devlogWindows()[0].focusRejects = true; });
    await popOut(page);
    await page.waitForFunction(() => window.__tauriTest.devlogWindows().length === 2);

    expect(await isPopped(page)).toBe(true);
  });

  test('"dock" from the popped window closes it', async ({ page }) => {
    await openPeerChannel(page);
    await popOut(page);
    await page.evaluate(() => window.__peer.postMessage({ type: 'dock' }));
    await settle(page);

    const state = await page.evaluate(() => ({
      closeCalls: window.__tauriTest.devlogWindows()[0].closeCalls,
      popped: document.getElementById('dev-log-panel').classList.contains('popped-out'),
    }));

    expect(state.closeCalls).toBe(1);
    expect(state.popped).toBe(false);
  });
});

test.describe('the log channel between the two windows', () => {
  test.beforeEach(async ({ page }) => {
    await stubTauri(page);
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('dev-mode', '1');
      _devLogBuffer.length = 0;
      devLog('first line');
      devLog('second line', 'warn');
    });
    await openPeerChannel(page);
  });

  test('a popped window announcing itself is sent the whole buffer', async ({ page }) => {
    await popOut(page);
    await page.evaluate(() => window.__peer.postMessage({ type: 'ready' }));
    await settle(page);

    const backfill = await page.evaluate(() =>
      window.__peerMessages.find((m) => m.type === 'backfill'));

    expect(backfill).toBeTruthy();
    expect(backfill.entries.length).toBe(2);
    expect(JSON.stringify(backfill.entries)).toContain('first line');
    expect(JSON.stringify(backfill.entries)).toContain('second line');
  });

  test('the backfill is a copy — the popped window cannot mutate our buffer', async ({ page }) => {
    await popOut(page);
    const still = await page.evaluate(async () => {
      window.__peer.postMessage({ type: 'ready' });
      await new Promise((r) => setTimeout(r, 20));
      return _devLogBuffer.length;
    });
    expect(still).toBe(2);
  });

  test('Clear in the popped window empties this one as well', async ({ page }) => {
    await popOut(page);
    const after = await page.evaluate(async () => {
      window.__peer.postMessage({ type: 'clear' });
      await new Promise((r) => setTimeout(r, 20));
      return {
        buffer: _devLogBuffer.length,
        entries: document.getElementById('dev-log-entries').children.length,
      };
    });

    expect(after.buffer).toBe(0);
    expect(after.entries).toBe(0);
  });

  test('Clear in this window is forwarded to the popped one', async ({ page }) => {
    await popOut(page);
    await page.evaluate(() => document.getElementById('btn-clear-dev-log').click());
    await settle(page);

    const seen = await page.evaluate(() => window.__peerMessages.map((m) => m.type));
    expect(seen).toContain('clear');
  });

  test('an unknown message from the other window is ignored', async ({ page }) => {
    await popOut(page);
    const after = await page.evaluate(async () => {
      window.__peer.postMessage({ type: 'something-else' });
      window.__peer.postMessage(null);
      await new Promise((r) => setTimeout(r, 20));
      return _devLogBuffer.length;
    });

    expect(after).toBe(2);
  });
});

test.describe('on web, where there is no WebviewWindow', () => {
  test('falls back to window.open and still marks the panel popped', async ({ page }) => {
    await page.goto('/');
    const opened = await page.evaluate(() => {
      const calls = [];
      window.open = (url, name, features) => {
        calls.push({ url, name, features });
        return { focus() { this.focused = true; }, close() {}, closed: false };
      };
      document.getElementById('btn-popout-dev-log').click();
      return {
        calls,
        popped: document.getElementById('dev-log-panel').classList.contains('popped-out'),
      };
    });

    expect(opened.calls).toHaveLength(1);
    expect(opened.calls[0].url).toBe('devlog.html');
    expect(opened.calls[0].name).toBe('voxal-devlog');
    expect(opened.calls[0].features).toContain('resizable=yes');
    expect(opened.popped).toBe(true);
  });

  test('a blocked pop-up leaves the panel docked rather than pretending it worked', async ({ page }) => {
    await page.goto('/');
    const popped = await page.evaluate(() => {
      window.open = () => null;   // what a pop-up blocker returns
      document.getElementById('btn-popout-dev-log').click();
      return document.getElementById('dev-log-panel').classList.contains('popped-out');
    });

    expect(popped).toBe(false);
  });

  test('leaving the page closes the popped window behind us', async ({ page }) => {
    await page.goto('/');
    const closed = await page.evaluate(() => {
      let closeCalls = 0;
      window.open = () => ({ focus() {}, close() { closeCalls++; }, closed: false });
      document.getElementById('btn-popout-dev-log').click();
      window.dispatchEvent(new Event('beforeunload'));
      return { closeCalls, popped: document.getElementById('dev-log-panel').classList.contains('popped-out') };
    });

    expect(closed.closeCalls).toBe(1);
    expect(closed.popped).toBe(false);
  });
});
