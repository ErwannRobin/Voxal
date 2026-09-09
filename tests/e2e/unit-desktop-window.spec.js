import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// The Mac app's window is part of its layout: it ships as a narrow voice column
// and grows for the two configurations that need more room — the chat drawer
// (to the right, by exactly the drawer's width) and a live camera (to the
// landscape shape the desktop web app uses). Both hand the column back.
//
// The sizing decisions are pure (desktopWindowTarget) and the applying leg is
// one Tauri call, so both halves are testable against a fake bridge: a window
// handle that records every setSize, plus the `dpi` classes main.js constructs.

/** A fake Tauri bridge whose window handle records what it was asked to be. */
async function stubTauriWindow(page) {
  await page.addInitScript(() => {
    const sizes = [];
    const positions = [];
    let position = { x: 0, y: 0 };

    class LogicalSize {
      constructor(width, height) { this.type = 'Logical'; this.width = width; this.height = height; }
    }
    class LogicalPosition {
      constructor(x, y) { this.type = 'Logical'; this.x = x; this.y = y; }
    }

    const handle = {
      setSize(size) { sizes.push({ width: size.width, height: size.height }); return Promise.resolve(); },
      setPosition(pos) { positions.push({ x: pos.x, y: pos.y }); position = pos; return Promise.resolve(); },
      scaleFactor() { return Promise.resolve(1); },
      outerPosition() {
        return Promise.resolve({ toLogical: () => ({ x: position.x, y: position.y }) });
      },
    };

    window.__TAURI__ = {
      core: { invoke: () => Promise.resolve() },
      shell: { open: () => Promise.resolve() },
      webviewWindow: { WebviewWindow: class { constructor() {} once() { return Promise.resolve(() => {}); } close() {} } },
      event: {
        listen: () => Promise.resolve(() => {}),
        once: () => Promise.resolve(() => {}),
        emit: () => Promise.resolve(),
      },
      window: { getCurrentWindow: () => handle },
      dpi: { LogicalSize, LogicalPosition },
    };

    window.__windowTest = {
      sizes,
      positions,
      setOuterPosition: (x, y) => { position = { x, y }; },
    };
  });
}

/** The narrow voice column the app opens with, whatever the test viewport is. */
async function asVoiceColumn(page) {
  await page.evaluate(() => { _desktopVoiceSize = { width: 350, height: 680 }; });
}

/** A screen big enough that the clamp is never what is under test. */
async function onABigScreen(page) {
  await page.evaluate(() => {
    Object.defineProperty(window.screen, 'availWidth',  { value: 2560, configurable: true });
    Object.defineProperty(window.screen, 'availHeight', { value: 1440, configurable: true });
  });
}

test.beforeEach(async ({ page }) => {
  await stubTauriWindow(page);
  await page.goto('/');
  await onABigScreen(page);
  await asVoiceColumn(page);
});

test.describe('the platform tag', () => {
  test('the desktop app takes the web layout regimes, not the mobile one', async ({ page }) => {
    const cls = await page.evaluate(() => ({
      web: document.documentElement.classList.contains('is-web'),
      native: document.documentElement.classList.contains('is-native'),
      desktopApp: document.documentElement.classList.contains('is-desktop-app'),
    }));
    expect(cls).toEqual({ web: true, native: false, desktopApp: true });
  });

  // A window wide enough for the stage is one the app made wide, so the desktop
  // grid has to be reachable there — the alternative is a phone layout on a Mac.
  test('a wide desktop-app window resolves to the desktop stage', async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 760 });
    expect(await page.evaluate(() => videoStageMode())).toBe('desktop');
  });
});

test.describe('desktopWindowTarget — what the window should be', () => {
  test.beforeEach(async ({ page }) => {
    await seedRoom(page, { selfId: 'me', isHost: true, roomCode: 'me' });
    await asVoiceColumn(page);
  });

  test('a plain voice room is the column it started as', async ({ page }) => {
    const t = await page.evaluate(() => desktopWindowTarget());
    expect(t.width).toBe(350);
    expect(t.height).toBe(680);
  });

  test('an open chat adds exactly the drawer width, to the right', async ({ page }) => {
    const t = await page.evaluate(() => {
      localStorage.setItem('chat-width', '420');
      document.body.classList.add('chat-open');
      return desktopWindowTarget();
    });
    expect(t.width).toBe(350 + 420);
    expect(t.height).toBe(680);
  });

  // readChatWidth() clamps to 90% of the CURRENT window — the one we are about
  // to grow. Reserving that number would leave a strip narrower than the drawer.
  test('the strip is the stored width, not the width the narrow window allows', async ({ page }) => {
    const out = await page.evaluate(() => {
      localStorage.setItem('chat-width', '400');
      document.body.classList.add('chat-open');
      _desktopVoiceSize = { width: 350, height: 680 };
      return { stored: storedChatWidth(), target: desktopWindowTarget().width };
    });
    expect(out.stored).toBe(400);
    expect(out.target).toBe(750);
  });

  test('a live stage takes the landscape shape, wide enough to dock the chat', async ({ page }) => {
    const t = await page.evaluate(() => {
      document.body.classList.add('video-stage');
      return desktopWindowTarget();
    });
    expect(t.width).toBeGreaterThanOrEqual(1100);   // CHAT_DOCK_MIN_WIDTH
    expect(t.height).toBe(760);
  });

  test('the stage plus the chat is the landscape width plus the drawer', async ({ page }) => {
    const out = await page.evaluate(() => {
      localStorage.setItem('chat-width', '360');
      document.body.classList.add('video-stage', 'chat-open');
      const withBoth = desktopWindowTarget().width;
      document.body.classList.remove('chat-open');
      return { withBoth, stageOnly: desktopWindowTarget().width };
    });
    expect(out.withBoth).toBe(out.stageOnly + 360);
  });

  // A window the user made taller is theirs; the stage only ever raises height.
  test('a taller window than the stage needs is kept', async ({ page }) => {
    const h = await page.evaluate(() => {
      _desktopVoiceSize = { width: 350, height: 1000 };
      document.body.classList.add('video-stage');
      return desktopWindowTarget().height;
    });
    expect(h).toBe(1000);
  });

  test('leaving the room hands the voice column back', async ({ page }) => {
    const t = await page.evaluate(() => {
      document.body.classList.add('video-stage', 'chat-open');
      inRoom = false;
      return desktopWindowTarget();
    });
    expect(t).toEqual({ width: 350, height: 680 });
  });

  test('nothing grows past the screen it is on', async ({ page }) => {
    const t = await page.evaluate(() => {
      Object.defineProperty(window.screen, 'availWidth', { value: 900, configurable: true });
      _desktopVoiceSize = { width: 350, height: 680 };
      document.body.classList.add('video-stage', 'chat-open');
      return desktopWindowTarget().width;
    });
    expect(t).toBe(900);
  });
});

test.describe('applyDesktopWindowShape — the window actually resizes', () => {
  test.beforeEach(async ({ page }) => {
    await seedRoom(page, { selfId: 'me', isHost: true, roomCode: 'me' });
    await asVoiceColumn(page);
  });

  test('opening the chat resizes the window and marks the drawer as beside', async ({ page }) => {
    const out = await page.evaluate(() => {
      localStorage.setItem('chat-width', '360');
      window.__windowTest.sizes.length = 0;
      toggleChatPanel(true, { focus: false });
      return {
        sizes: window.__windowTest.sizes,
        beside: document.body.classList.contains('chat-side'),
        docked: document.body.classList.contains('chat-docked'),
      };
    });
    expect(out.sizes.length).toBe(1);
    expect(out.sizes[0].width).toBe(710);
    expect(out.beside).toBe(true);
    expect(out.docked).toBe(false);
  });

  test('closing it asks for the column back', async ({ page }) => {
    const sizes = await page.evaluate(() => {
      localStorage.setItem('chat-width', '360');
      toggleChatPanel(true, { focus: false });
      window.__windowTest.sizes.length = 0;
      toggleChatPanel(false, { remember: true });
      return window.__windowTest.sizes;
    });
    expect(sizes).toEqual([{ width: 350, height: 680 }]);
  });

  // The room is not asked to shrink for the drawer — the window grew instead —
  // so the strip is reserved on body, where the fixed panel lands.
  test('the reserved strip matches the drawer that lands in it', async ({ page }) => {
    await page.setViewportSize({ width: 710, height: 680 });
    const out = await page.evaluate(() => {
      localStorage.setItem('chat-width', '360');
      showScreen('room');
      toggleChatPanel(true, { focus: false });
      const panel = document.getElementById('room-chat-panel');
      return {
        pad: getComputedStyle(document.body).paddingRight,
        panel: Math.round(panel.getBoundingClientRect().width),
      };
    });
    expect(out.pad).toBe('360px');
    expect(out.panel).toBe(360);
  });

  test('a size we did not ask for is remembered as the new voice column', async ({ page }) => {
    const target = await page.evaluate(() => {
      // The user drags the window wider while the room is plain.
      _desktopAppliedSize = { width: 350, height: 680 };
      Object.defineProperty(window, 'innerWidth', { value: 520, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
      noteDesktopWindowResize();
      return _desktopVoiceSize;
    });
    expect(target).toEqual({ width: 520, height: 900 });
  });

  test('a resize made under a live stage is not mistaken for the column', async ({ page }) => {
    const kept = await page.evaluate(() => {
      document.body.classList.add('video-stage');
      _desktopAppliedSize = { width: 1180, height: 760 };
      Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
      noteDesktopWindowResize();
      return _desktopVoiceSize;
    });
    expect(kept).toEqual({ width: 350, height: 680 });
  });

  test('a window grown past the right edge is pulled back on screen', async ({ page }) => {
    const out = await page.evaluate(async () => {
      // 2560px of screen, a window starting at 2160 and now 900 wide: 500px of
      // it is off the right edge.
      window.__windowTest.setOuterPosition(2160, 40);
      Object.defineProperty(window, 'innerWidth', { value: 900, configurable: true });
      await keepDesktopWindowOnScreen();
      return window.__windowTest.positions;
    });
    expect(out).toEqual([{ x: 1660, y: 40 }]);
  });

  test('a window that fits is left where the user put it', async ({ page }) => {
    const out = await page.evaluate(async () => {
      window.__windowTest.setOuterPosition(100, 40);
      Object.defineProperty(window, 'innerWidth', { value: 900, configurable: true });
      await keepDesktopWindowOnScreen();
      return window.__windowTest.positions;
    });
    expect(out).toEqual([]);
  });
});

test.describe('what the desktop app does NOT do', () => {
  test('the chat never opens by itself — that would resize the window on join', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 });
    const opens = await page.evaluate(() => {
      inRoom = true;
      localStorage.removeItem('chat-collapsed');
      _chatCollapsedHere = false;
      return chatOpensOnEntry();
    });
    expect(opens).toBe(false);
  });
});
