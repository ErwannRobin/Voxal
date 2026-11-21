import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// The Mac app's window is part of its layout: it ships as a narrow voice column
// and grows for the two configurations that need more room — the pinned chat
// drawer (by exactly the drawer's width, as a delta on the window as it is:
// to the right, else shifted left, else not at all) and a live camera (to the
// landscape shape the desktop web app uses). Both hand back what they took.
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

  test('what the open chat added stays added to the shape', async ({ page }) => {
    const t = await page.evaluate(() => {
      _desktopChatGrowth = { width: 420, shift: 0 };
      return desktopWindowTarget();
    });
    expect(t.width).toBe(350 + 420);
    expect(t.height).toBe(680);
  });

  // readChatWidth() clamps to 90% of the CURRENT window — the one we are about
  // to grow. Asking for that number would leave a strip narrower than the drawer.
  test('the growth asked for is the stored width, not the width the narrow window allows', async ({ page }) => {
    const out = await page.evaluate(() => {
      localStorage.setItem('chat-width', '400');
      Object.defineProperty(window, 'innerWidth', { value: 350, configurable: true });
      window.__windowTest.sizes.length = 0;
      toggleChatPanel(true, { focus: false });
      return { stored: storedChatWidth(), sizes: window.__windowTest.sizes.slice() };
    });
    expect(out.stored).toBe(400);
    expect(out.sizes[0].width).toBe(750);
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
      document.body.classList.add('video-stage');
      _desktopChatGrowth = { width: 360, shift: 0 };
      const withBoth = desktopWindowTarget().width;
      _desktopChatGrowth = null;
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
      _desktopChatGrowth = { width: 360, shift: 0 };
      document.body.classList.add('video-stage');
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
      Object.defineProperty(window, 'innerWidth', { value: 350, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 680, configurable: true });
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
      Object.defineProperty(window, 'innerWidth', { value: 350, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 680, configurable: true });
      toggleChatPanel(true, { focus: false });
      Object.defineProperty(window, 'innerWidth', { value: 710, configurable: true });   // it grew
      window.__windowTest.sizes.length = 0;
      toggleChatPanel(false, { remember: true });
      return window.__windowTest.sizes;
    });
    expect(sizes).toEqual([{ width: 350, height: 680 }]);
  });

  // The bug this replaced: the chat recomputed the WHOLE window from a
  // remembered column, so a window the user had made 1000x900 snapped to
  // 350+360 x 680 the moment the chat opened.
  test('only the width changes, by the drawer, from the window as it is', async ({ page }) => {
    const sizes = await page.evaluate(() => {
      localStorage.setItem('chat-width', '360');
      _desktopAppliedSize = null;
      Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
      window.__windowTest.sizes.length = 0;
      toggleChatPanel(true, { focus: false });
      return window.__windowTest.sizes.slice();
    });
    expect(sizes).toEqual([{ width: 1360, height: 900 }]);
  });

  test('no room on the right: it shifts left by just enough, and moves back on close', async ({ page }) => {
    const out = await page.evaluate(async () => {
      localStorage.setItem('chat-width', '360');
      Object.defineProperty(window, 'screenX', { value: 2000, configurable: true });
      Object.defineProperty(window, 'screenY', { value: 40, configurable: true });
      Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 700, configurable: true });
      window.__windowTest.sizes.length = 0;
      window.__windowTest.positions.length = 0;
      toggleChatPanel(true, { focus: false });
      await new Promise((r) => setTimeout(r, 0));
      const opened = { sizes: window.__windowTest.sizes.slice(), positions: window.__windowTest.positions.slice() };
      // The window is where it was put: 2560 - 760 = 1800, and 760 wide.
      Object.defineProperty(window, 'screenX', { value: 1800, configurable: true });
      Object.defineProperty(window, 'innerWidth', { value: 760, configurable: true });
      window.__windowTest.sizes.length = 0;
      window.__windowTest.positions.length = 0;
      toggleChatPanel(false, { remember: true });
      await new Promise((r) => setTimeout(r, 0));
      return { opened, closed: { sizes: window.__windowTest.sizes.slice(), positions: window.__windowTest.positions.slice() } };
    });
    expect(out.opened.positions).toEqual([{ x: 1800, y: 40 }]);
    expect(out.opened.sizes).toEqual([{ width: 760, height: 700 }]);
    expect(out.closed.sizes).toEqual([{ width: 400, height: 700 }]);
    expect(out.closed.positions).toEqual([{ x: 2000, y: 40 }]);
  });

  test('already as wide as the screen: nothing resizes, the drawer opens inside', async ({ page }) => {
    const out = await page.evaluate(() => {
      localStorage.setItem('chat-width', '360');
      Object.defineProperty(window, 'innerWidth', { value: 2560, configurable: true });
      window.__windowTest.sizes.length = 0;
      window.__windowTest.positions.length = 0;
      toggleChatPanel(true, { focus: false });
      const opened = { sizes: window.__windowTest.sizes.slice(), beside: document.body.classList.contains('chat-side') };
      toggleChatPanel(false, { remember: true });
      return { opened, closed: window.__windowTest.sizes.slice(), positions: window.__windowTest.positions.slice() };
    });
    expect(out.opened.sizes).toEqual([]);
    expect(out.opened.beside).toBe(true);    // the strip comes out of a 2560px room
    expect(out.closed).toEqual([]);
    expect(out.positions).toEqual([]);
  });

  test('desktopChatPlacement: right, else shifted, else partly, else inside', async ({ page }) => {
    const out = await page.evaluate(() => {
      const area = { x: 0, width: 1440 };
      return {
        right:   desktopChatPlacement({ x: 100, width: 400 }, 360, area),
        shifted: desktopChatPlacement({ x: 1000, width: 400 }, 360, area),
        partly:  desktopChatPlacement({ x: 0, width: 1240 }, 360, area),
        inside:  desktopChatPlacement({ x: 0, width: 1420 }, 360, area),
      };
    });
    expect(out.right).toEqual({ grown: 360, x: 100, shift: 0 });
    expect(out.shifted).toEqual({ grown: 360, x: 680, shift: 320 });
    expect(out.partly).toEqual({ grown: 200, x: 0, shift: 0 });
    expect(out.inside).toBeNull();
  });

  test('an overlay chat never touches the window', async ({ page }) => {
    const sizes = await page.evaluate(() => {
      localStorage.setItem('chat-panel-mode', 'overlay');
      window.__windowTest.sizes.length = 0;
      toggleChatPanel(true, { focus: false });
      toggleChatPanel(false, { remember: true });
      return window.__windowTest.sizes.slice();
    });
    expect(sizes).toEqual([]);
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
  test('the chat is not open on join unless it was left open', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 });
    const opens = await page.evaluate(() => {
      inRoom = true;
      localStorage.removeItem('chat-open');
      _chatCollapsedHere = false;
      return chatOpensOnEntry();
    });
    expect(opens).toBe(false);
  });
});

// Full screen is the user's shape (green button, View → Enter Full Screen):
// nothing resizes the window while it lasts, and none of its sizes, nor the
// frames of the way back out, are taken for the voice column.
test.describe('full screen', () => {
  test.beforeEach(async ({ page }) => {
    await seedRoom(page, { selfId: 'me', isHost: true, roomCode: 'me' });
    await asVoiceColumn(page);
    await page.evaluate(() => {
      window.__fs = false;
      tauriWindowHandle().isFullscreen = () => Promise.resolve(window.__fs);
    });
  });

  test('a full-screen window is never resized, and its size is not the column', async ({ page }) => {
    const out = await page.evaluate(async () => {
      window.__fs = true;
      Object.defineProperty(window, 'innerWidth', { value: 2560, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 1440, configurable: true });
      noteDesktopWindowResize();
      await new Promise((r) => setTimeout(r, 0));
      window.__windowTest.sizes.length = 0;
      localStorage.setItem('chat-width', '360');
      toggleChatPanel(true, { focus: false });
      return { sizes: window.__windowTest.sizes.slice(), voice: _desktopVoiceSize, fs: _desktopFullscreen };
    });
    expect(out.fs).toBe(true);
    expect(out.sizes).toEqual([]);
    expect(out.voice).toEqual({ width: 350, height: 680 });
  });

  test('leaving it re-applies the shape once macOS has put the frame back', async ({ page }) => {
    const out = await page.evaluate(async () => {
      window.__fs = true;
      noteDesktopWindowResize();
      await new Promise((r) => setTimeout(r, 0));
      localStorage.setItem('chat-width', '360');
      toggleChatPanel(true, { focus: false });     // opened while full screen
      window.__windowTest.sizes.length = 0;
      window.__fs = false;
      Object.defineProperty(window, 'innerWidth', { value: 600, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 500, configurable: true });
      noteDesktopWindowResize();                   // a frame of the way out
      await new Promise((r) => setTimeout(r, 0));
      const during = { voice: { ..._desktopVoiceSize }, sizes: window.__windowTest.sizes.slice() };
      await new Promise((r) => setTimeout(r, DESKTOP_FULLSCREEN_SETTLE_MS + 100));
      return { during, after: window.__windowTest.sizes.slice() };
    });
    expect(out.during.voice).toEqual({ width: 350, height: 680 });
    expect(out.during.sizes).toEqual([]);
    expect(out.after).toEqual([{ width: 350 + 360, height: 680 }]);
  });
});

// A window macOS has placed — Window → Fill, Zoom, Move & Resize, a drag onto a
// screen edge — is the user's arrangement: growing it for the chat would pull
// it out of its tile. There is no event for a tile, so it is read from the
// frame against the screen's work area.
test.describe('placed by macOS (Fill, tiles)', () => {
  const AREA = { x: 0, y: 25, width: 1440, height: 875 };   // under the menu bar

  test('desktopFramePlaced tells a tile from a window that merely sits somewhere', async ({ page }) => {
    const r = await page.evaluate((a) => {
      const f = (x, y, width, height) => desktopFramePlaced({ x, y, width, height }, a);
      return {
        fill:        f(0, 25, 1440, 875),
        leftHalf:    f(0, 25, 720, 875),
        rightHalf:   f(720, 25, 720, 875),
        topHalf:     f(0, 25, 1440, 437),
        quarter:     f(720, 462, 720, 438),
        withMargins: f(8, 33, 708, 859),       // Sequoia's tiled-window margins
        column:      f(545, 135, 350, 680),    // the app's own, wherever it is
        cornered:    f(0, 25, 350, 680),       // pushed into a corner, not a quarter
      };
    }, AREA);
    expect(r).toEqual({
      fill: true, leftHalf: true, rightHalf: true, topHalf: true, quarter: true,
      withMargins: true, column: false, cornered: false,
    });
  });

  /** The fake window reports this frame, in physical px at 2x. */
  async function frameIs(page, f, { zoomed = false } = {}) {
    await page.evaluate(({ f, a, zoomed }) => {
      const h = tauriWindowHandle();
      h.isFullscreen = () => Promise.resolve(false);
      h.isMaximized = () => Promise.resolve(zoomed);
      h.outerPosition = () => Promise.resolve({ x: f.x * 2, y: f.y * 2, toLogical: () => ({ x: f.x, y: f.y }) });
      h.outerSize = () => Promise.resolve({ width: f.width * 2, height: f.height * 2 });
      window.__TAURI__.window.currentMonitor = () => Promise.resolve({
        scaleFactor: 2,
        workArea: { position: { x: a.x * 2, y: a.y * 2 }, size: { width: a.width * 2, height: a.height * 2 } },
      });
      Object.defineProperty(window, 'innerWidth', { value: f.width, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: f.height - 28, configurable: true });
      noteDesktopWindowResize();
    }, { f, a: AREA, zoomed });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 20)));
  }

  test.beforeEach(async ({ page }) => {
    await seedRoom(page, { selfId: 'me', isHost: true, roomCode: 'me' });
    await asVoiceColumn(page);
  });

  test('a tiled window is not resized for the chat, and its size is not the column', async ({ page }) => {
    await frameIs(page, { x: 0, y: 25, width: 720, height: 875 });
    const out = await page.evaluate(() => {
      window.__windowTest.sizes.length = 0;
      localStorage.setItem('chat-width', '360');
      toggleChatPanel(true, { focus: false });
      return { placed: _desktopPlaced, sizes: window.__windowTest.sizes.slice(), voice: _desktopVoiceSize,
        beside: document.body.classList.contains('chat-side') };
    });
    expect(out.placed).toBe(true);
    expect(out.sizes).toEqual([]);
    expect(out.voice).toEqual({ width: 350, height: 680 });
    // 720 - 360 still leaves a voice column, so the drawer takes its strip.
    expect(out.beside).toBe(true);
  });

  test('in a quarter too narrow to share, the drawer lies over the room', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('chat-width', '420'));
    await frameIs(page, { x: 720, y: 462, width: 720, height: 438 });
    const beside = await page.evaluate(() => {
      toggleChatPanel(true, { focus: false });
      return document.body.classList.contains('chat-side');
    });
    expect(beside).toBe(false);
  });

  test('Fill / Zoom reads as placed from isMaximized alone', async ({ page }) => {
    await frameIs(page, { x: 200, y: 100, width: 900, height: 700 }, { zoomed: true });
    expect(await page.evaluate(() => _desktopPlaced)).toBe(true);
  });

  test('dragged out of its tile, the window is theirs again', async ({ page }) => {
    await frameIs(page, { x: 0, y: 25, width: 720, height: 875 });
    await page.evaluate(() => {
      localStorage.setItem('chat-width', '360');
      toggleChatPanel(true, { focus: false });    // opened while tiled: no growth
      window.__windowTest.sizes.length = 0;
    });
    await frameIs(page, { x: 300, y: 200, width: 800, height: 728 });
    const out = await page.evaluate(() => ({
      placed: _desktopPlaced, voice: _desktopVoiceSize, sizes: window.__windowTest.sizes.slice(),
    }));
    expect(out.placed).toBe(false);
    // The frame it landed in is the new voice column (the drawer was opened
    // inside the tile, so none of it is the chat's) — so the shape it
    // re-applies is the window it already is: no resize.
    expect(out.voice).toEqual({ width: 800, height: 700 });
    expect(out.sizes).toEqual([]);
    // A chat that opened inside gave the window nothing, so closing it takes
    // nothing back.
    const back = await page.evaluate(() => {
      toggleChatPanel(false, { remember: true });
      return window.__windowTest.sizes.slice();
    });
    expect(back).toEqual([]);
  });
});

// Every resize runs a layout pass (scheduleStageRelayout → updateVideoStage →
// applyDesktopWindowShape). The shape must not be re-asserted there, or every
// size the user or macOS gives the window snaps back on the next frame.
test.describe('a resize is never undone by the layout pass that follows it', () => {
  test.beforeEach(async ({ page }) => {
    await seedRoom(page, { selfId: 'me', isHost: true, roomCode: 'me' });
    await asVoiceColumn(page);
    await page.evaluate(() => applyDesktopWindowShape());   // the room's shape, as on entry
  });

  async function userResizesTo(page, width, height, { isFullscreen } = {}) {
    return page.evaluate(async ({ width, height, isFullscreen }) => {
      if (isFullscreen) {
        // A real bridge answers asynchronously: the layout pass runs first.
        tauriWindowHandle().isFullscreen = () => new Promise((r) => setTimeout(() => r(false), 30));
      }
      window.__windowTest.sizes.length = 0;
      Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
      window.dispatchEvent(new Event('resize'));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      updateVideoStage();
      await new Promise((r) => setTimeout(r, 60));
      return { sizes: window.__windowTest.sizes.slice(), voice: _desktopVoiceSize };
    }, { width, height, isFullscreen });
  }

  test('a voice room keeps the size it was dragged to', async ({ page }) => {
    const out = await userResizesTo(page, 900, 820);
    expect(out.sizes).toEqual([]);
    expect(out.voice).toEqual({ width: 900, height: 820 });
  });

  test('…also while the bridge is still answering whether it is full screen', async ({ page }) => {
    const out = await userResizesTo(page, 1440, 875, { isFullscreen: true });
    expect(out.sizes).toEqual([]);
    expect(out.voice).toEqual({ width: 1440, height: 875 });
  });

  test('a live stage keeps a size the user gave it', async ({ page }) => {
    await page.evaluate(() => {
      // No real tiles here, so the real layout pass would take the stage down;
      // keep only the part of it under test.
      window.updateVideoStage = function() { applyDesktopWindowShape(); };
      document.body.classList.add('video-stage');
      applyDesktopWindowShape();                  // the stage's landscape shape
    });
    const out = await userResizesTo(page, 1400, 900);
    expect(out.sizes).toEqual([]);
  });

  test('a change of configuration still reshapes it', async ({ page }) => {
    await userResizesTo(page, 900, 820);
    const sizes = await page.evaluate(() => {
      localStorage.setItem('chat-width', '360');
      toggleChatPanel(true, { focus: false });
      return window.__windowTest.sizes.slice();
    });
    expect(sizes).toEqual([{ width: 900 + 360, height: 820 }]);
  });
});
