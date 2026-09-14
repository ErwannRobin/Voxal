import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// The video stage on a phone: the same tiles, but filling the screen with the
// voice UI overlaid, on mobile web AND in the Capacitor apps. Plus the things a
// phone needs that a laptop does not — a camera flip, tighter capture and
// bitrate caps, a wake lock, and capture that stops when the app backgrounds.
//
// The invariant carried over from unit-video-stage.spec.js and re-asserted here
// at phone size: an audio-only room gets NEITHER body class, so it renders
// exactly as it did before any of this existed.

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

async function enterRoom(page, cfg = {}) {
  await seedRoom(page, { selfId: 'self', isHost: true, roomCode: 'room1', ...cfg });
  await page.evaluate(() => {
    showScreen('room');
    updatePeerList();
  });
}

// IS_NATIVE_MOBILE / IS_MOBILE_DEVICE are `const`s evaluated while main.js
// loads, so every platform stub must be installed with addInitScript, before
// goto — setting them afterwards is far too late.
async function fakeNative(page) {
  await page.addInitScript(() => {
    window.Capacitor = { isNativePlatform: () => true, Plugins: {} };
  });
}

async function fakeMobileUA(page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', {
      get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
      configurable: true,
    });
  });
}

test.describe('videoStageMode — which shape of stage applies where', () => {
  test('a wide web viewport gets the desktop grid', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/');
    expect(await page.evaluate(() => videoStageMode())).toBe('desktop');
  });

  test('a phone-width web viewport gets the immersive stage', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/');
    expect(await page.evaluate(() => videoStageMode())).toBe('immersive');
    expect(await page.evaluate(() => videoStageAvailable())).toBe(true);
  });

  // A native tablet in portrait is wider than the desktop breakpoint, but the
  // desktop grid is `html.is-web`-qualified and can never apply there — so
  // native must resolve to immersive at ANY width, not by measuring.
  test('native is immersive even at desktop width', async ({ page }) => {
    await fakeNative(page);
    await page.setViewportSize(DESKTOP);
    await page.goto('/');
    expect(await page.evaluate(() => document.documentElement.classList.contains('is-native'))).toBe(true);
    expect(await page.evaluate(() => videoStageMode())).toBe('immersive');
  });

  // Neither class = no layout regime to render a stage into. (The Tauri desktop
  // app is NOT this case any more: it carries `is-web` + `is-desktop-app` and
  // sizes its own window to the landscape shape — see unit-desktop-window.)
  test('a surface that is neither web nor native has no stage', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/');
    await page.evaluate(() => document.documentElement.classList.remove('is-web'));
    expect(await page.evaluate(() => videoStageMode())).toBe('none');
    expect(await page.evaluate(() => videoStageAvailable())).toBe(false);
  });

  test('a tiny embed has no stage, at any width', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/?embed=tiny');
    expect(await page.evaluate(() => videoStageMode())).toBe('none');
  });

  test('crossing the breakpoint switches mode without a reload', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/');
    expect(await page.evaluate(() => videoStageMode())).toBe('desktop');
    await page.setViewportSize(PHONE);
    expect(await page.evaluate(() => videoStageMode())).toBe('immersive');
  });
});

test.describe('body.video-stage-immersive', () => {
  test.use({ viewport: PHONE });

  test.beforeEach(async ({ page }) => { await page.goto('/'); });

  // The assertion that matters most: the feature is strictly additive.
  test('an audio-only room gets neither class', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true }],
    });
    expect(await page.evaluate(() => document.body.classList.contains('video-stage'))).toBe(false);
    expect(await page.evaluate(() => document.body.classList.contains('video-stage-immersive'))).toBe(false);
  });

  test('appears with the first camera and goes away with the last', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    expect(await page.evaluate(() => document.body.classList.contains('video-stage-immersive'))).toBe(true);

    await page.evaluate(() => {
      connections.get('p1').videoActive = false;
      updatePeerList();
    });
    expect(await page.evaluate(() => document.body.classList.contains('video-stage-immersive'))).toBe(false);
  });

  test('the desktop grid never claims a phone', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    const display = await page.evaluate(() =>
      getComputedStyle(document.getElementById('screen-room')).display);
    expect(display).not.toBe('grid');
  });

  // The stage cancels the room's safe-area padding exactly, so video reaches
  // the physical edges instead of sitting in an inset box.
  test('the stage fills the room edge to edge', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    const { stage, room } = await page.evaluate(() => ({
      stage: document.getElementById('video-stage').getBoundingClientRect().toJSON(),
      room: document.getElementById('screen-room').getBoundingClientRect().toJSON(),
    }));
    expect(Math.round(stage.width)).toBe(Math.round(room.width));
    expect(Math.round(stage.height)).toBe(Math.round(room.height));
  });

  // The tiles run full-bleed UNDER the dock. The control stack is a translucent
  // panel lying on the picture, not a bar the video has to stop above — which is
  // exactly what makes "tap the video to put it away" reveal anything. The
  // header and roster overlay the video too, so the only thing left costing the
  // tiles any height is the top drag handle.
  test('tiles run full-bleed under the dock, clearing only the top handle', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1', 'p2'],
      connections: [
        { id: 'p1', pseudo: 'Alice', open: true, videoActive: true },
        { id: 'p2', pseudo: 'Bob', open: true, videoActive: true },
      ],
    });
    const boxes = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect().toJSON();
      return {
        bar: r('.room-bottom-bar'),
        stage: r('#video-stage'),
        tiles: [...document.querySelectorAll('#video-stage-grid .video-tile')]
          .map((e) => e.getBoundingClientRect().toJSON()),
      };
    });
    expect(boxes.tiles.length).toBe(2);
    for (const t of boxes.tiles) expect(t.height).toBeGreaterThan(0);
    // The last tile reaches the bottom of the stage, i.e. past the dock's top.
    const last = boxes.tiles[boxes.tiles.length - 1];
    expect(last.bottom).toBeGreaterThanOrEqual(boxes.stage.bottom - 1);
    expect(last.bottom).toBeGreaterThan(boxes.bar.top);

    const pad = await page.evaluate(() => {
      const st = getComputedStyle(document.getElementById('video-stage-grid'));
      return { top: parseFloat(st.paddingTop), bottom: parseFloat(st.paddingBottom) };
    });
    // Only the top handle sits above the tiles, so the top inset stays small —
    // if this grows, a panel has started reserving space again.
    expect(pad.top).toBeLessThanOrEqual(30);
    expect(pad.bottom).toBe(0);
  });

  // The talk button and the control row are never hidden — this is a
  // push-to-talk app, and the talk button is the one control people reach for
  // without looking.
  test('the PTT button and controls stay visible with a panel open', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    await page.evaluate(() => setStagePanel('roster', true));
    const visible = (sel) => page.evaluate((s) => {
      const st = getComputedStyle(document.querySelector(s));
      return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
    }, sel);
    expect(await visible('#ptt-btn')).toBe(true);
    expect(await visible('.room-controls')).toBe(true);

    // Visible is not enough — the scrim behind an open panel must stop above the
    // control stack, or it swallows the tap it does not dim.
    const hit = await page.evaluate(() => {
      const b = document.getElementById('ptt-btn').getBoundingClientRect();
      const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return { isPtt: el === document.getElementById('ptt-btn') || document.getElementById('ptt-btn').contains(el),
               got: el && el.id };
    });
    expect(hit.isPtt).toBe(true);
  });
});

// The sliding panels keep the app's own surface colours — that is what makes
// them legible over video without a video-only palette. The control stack is the
// deliberate exception: on the phone stage it is glass lying on the picture, so
// its contents take light-on-glass colours. The talk button is the exception to
// the exception, and keeps the border it wears everywhere else in the app.
test.describe('the room keeps its colours in video mode', () => {
  test.use({ viewport: PHONE });

  // The dock cross-fades into place (see its `transition` in styles.css), so a
  // colour read on the frame the class lands is the value it is coming FROM.
  const pick = (page, sel, props) => page.evaluate(({ sel, props }) => {
    const st = getComputedStyle(document.querySelector(sel));
    const out = {};
    for (const p of props) out[p] = st[p];
    return out;
  }, { sel, props });

  async function pickSettled(page, sel, props) {
    let prev = null;
    for (let i = 0; i < 40; i++) {
      const now = await pick(page, sel, props);
      if (prev && JSON.stringify(prev) === JSON.stringify(now)) return now;
      prev = now;
      await page.waitForTimeout(60);
    }
    return prev;
  }

  async function enterAudioRoom(page) {
    await page.goto('/');
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true }],
    });
    expect(await page.evaluate(() => document.body.classList.contains('video-stage-immersive'))).toBe(false);
  }

  async function turnCameraOn(page) {
    await page.evaluate(() => {
      connections.get('p1').videoActive = true;
      updatePeerList();
    });
    expect(await page.evaluate(() => document.body.classList.contains('video-stage-immersive'))).toBe(true);
  }

  test('the talk button is identical with and without video', async ({ page }) => {
    await enterAudioRoom(page);
    const props = ['backgroundColor', 'borderTopColor', 'width', 'height'];
    const audioOnly = await pickSettled(page, '#ptt-btn', props);
    await turnCameraOn(page);
    expect(await pickSettled(page, '#ptt-btn', props)).toEqual(audioOnly);
  });

  test('the status line keeps its own colour', async ({ page }) => {
    await enterAudioRoom(page);
    const audioOnly = await pickSettled(page, '.ptt-status', ['color']);
    await turnCameraOn(page);
    expect(await pickSettled(page, '.ptt-status', ['color'])).toEqual(audioOnly);
  });

  // The slab is painted by a pseudo-element that reaches outside the bar, so
  // turning a camera on adds no padding, no border and no reordering. The two
  // controls people reach for without looking are exactly where they were.
  test('the control row does not move when the camera comes on', async ({ page }) => {
    await enterAudioRoom(page);
    const box = (sel) => page.evaluate((s) => {
      const b = document.querySelector(s).getBoundingClientRect();
      return { x: Math.round(b.left), y: Math.round(b.top),
               w: Math.round(b.width), h: Math.round(b.height) };
    }, sel);
    const audioOnly = await box('.room-controls');
    await turnCameraOn(page);
    expect(await box('.room-controls')).toEqual(audioOnly);
  });

  // A status line that only takes space when it has something to say pushes the
  // talk button around every time the room has news.
  test('the status line always reserves its space, so the mic cannot shift', async ({ page }) => {
    await enterAudioRoom(page);
    await turnCameraOn(page);
    const micY = () => page.evaluate(() =>
      Math.round(document.getElementById('ptt-btn').getBoundingClientRect().top));
    const quiet = await micY();
    await page.evaluate(() => { document.getElementById('ptt-status').textContent = 'Microphone muted'; });
    expect(await micY()).toBe(quiet);
  });

  test('the controls beside it do take the glass treatment', async ({ page }) => {
    await enterAudioRoom(page);
    const audioOnly = await pickSettled(page, '#btn-freehand', ['backgroundColor', 'color']);
    await turnCameraOn(page);
    expect(await pickSettled(page, '#btn-freehand', ['backgroundColor', 'color'])).not.toEqual(audioOnly);
  });
});

// A tap on the video puts the dock's panel away and brings it back; the talk
// button never goes with it. Pinning a tile — which reshapes the whole stage —
// moved to a long press, so the two gestures cannot be confused.
test.describe('tap the video to put the chrome away', () => {
  test.use({ viewport: PHONE });

  const twoCameras = (page) => enterRoom(page, {
    knownPeerIds: ['p1', 'p2'],
    connections: [
      { id: 'p1', pseudo: 'Alice', open: true, videoActive: true },
      { id: 'p2', pseudo: 'Bob', open: true, videoActive: true },
    ],
  });

  const hidden = (page) =>
    page.evaluate(() => document.body.classList.contains('stage-chrome-hidden'));

  // Somewhere on the top tile, well clear of the dock and of the handles.
  const tapVideo = (page) => page.mouse.click(PHONE.width / 2, 200);

  test.beforeEach(async ({ page }) => { await page.goto('/'); });

  test('it starts shown, and the tap toggles it both ways', async ({ page }) => {
    await twoCameras(page);
    expect(await hidden(page)).toBe(false);
    await tapVideo(page);
    expect(await hidden(page)).toBe(true);
    await tapVideo(page);
    expect(await hidden(page)).toBe(false);
  });

  test('the talk button neither goes away nor moves', async ({ page }) => {
    await twoCameras(page);
    const btn = () => page.evaluate(() => {
      const b = document.getElementById('ptt-btn').getBoundingClientRect();
      const st = getComputedStyle(document.getElementById('ptt-btn'));
      return { x: Math.round(b.left), y: Math.round(b.top),
               w: Math.round(b.width), h: Math.round(b.height), display: st.display };
    });
    const shown = await btn();
    await tapVideo(page);
    expect(await hidden(page)).toBe(true);
    expect(await btn()).toEqual(shown);
  });

  const shown = (page, sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden';
  }, sel);

  test('the control row and the handles go, and the video takes the space', async ({ page }) => {
    await twoCameras(page);
    const stageTop = () => page.evaluate(() =>
      document.querySelectorAll('#video-stage-grid .video-tile')[0].getBoundingClientRect().top);
    expect(await shown(page, '.room-controls')).toBe(true);
    expect(await shown(page, '#stage-handle-header')).toBe(true);
    const before = await stageTop();

    await tapVideo(page);
    expect(await shown(page, '.room-controls')).toBe(false);
    expect(await shown(page, '#stage-handle-header')).toBe(false);
    expect(await shown(page, '#ptt-btn')).toBe(true);
    expect(await stageTop()).toBeLessThan(before);
  });

  // The row loses its ink, not its space: the bar is anchored to the bottom of
  // the screen, so collapsing the row would drag the talk button down with it.
  // It costs no picture — the bar paints nothing once the slab has gone.
  test('the control row keeps its box, so nothing below it shifts', async ({ page }) => {
    await twoCameras(page);
    const box = () => page.evaluate(() => {
      const b = document.querySelector('.room-controls').getBoundingClientRect();
      return { y: Math.round(b.top), h: Math.round(b.height) };
    });
    const before = await box();
    await tapVideo(page);
    expect(await box()).toEqual(before);
  });

  // The bar keeps its full height while the chrome is away, so the band it
  // covers is not part of the stage and its taps would otherwise go nowhere.
  test('a tap on the invisible bar brings the chrome back', async ({ page }) => {
    await twoCameras(page);
    await tapVideo(page);
    expect(await hidden(page)).toBe(true);
    const where = await page.evaluate(() => {
      const bar = document.querySelector('.room-bottom-bar').getBoundingClientRect();
      const row = document.querySelector('.room-controls').getBoundingClientRect();
      return { x: bar.left + 8, y: row.top + row.height / 2 };
    });
    await page.mouse.click(where.x, where.y);
    expect(await hidden(page)).toBe(false);
  });

  test('a long press pins the tile and does not toggle the chrome', async ({ page }) => {
    await twoCameras(page);
    await page.mouse.move(PHONE.width / 2, 200);
    await page.mouse.down();
    await page.waitForTimeout(650);
    await page.mouse.up();
    expect(await page.evaluate(() => _stagePinnedKey)).toBe('camera:p1');
    expect(await hidden(page)).toBe(false);
  });

  test('a tap on a control in the dock is not a tap on the video', async ({ page }) => {
    await twoCameras(page);
    await page.locator('#btn-freehand').click();
    expect(await hidden(page)).toBe(false);
  });

  test('leaving the stage stands the chrome back up', async ({ page }) => {
    await twoCameras(page);
    await tapVideo(page);
    expect(await hidden(page)).toBe(true);
    await page.evaluate(() => {
      connections.get('p1').videoActive = false;
      connections.get('p2').videoActive = false;
      updatePeerList();
    });
    expect(await hidden(page)).toBe(false);
  });

  test('a desktop stage keeps click-to-pin, and has no chrome to hide', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await twoCameras(page);
    expect(await page.evaluate(() => stageChromeToggles())).toBe(false);
    await page.locator('#video-stage-grid [data-key="camera:p1"]').click();
    expect(await page.evaluate(() => _stagePinnedKey)).toBe('camera:p1');
    expect(await hidden(page)).toBe(false);
  });
});

// The header and the participant list slide off-screen while video is live and
// are pulled back over the tiles by a drag handle.
test.describe('sliding panels', () => {
  test.use({ viewport: PHONE });

  test.beforeEach(async ({ page }) => { await page.goto('/'); });

  const withVideo = (page) => enterRoom(page, {
    knownPeerIds: ['p1'],
    connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
  });

  const onScreen = (page, sel) => page.evaluate((s) => {
    const b = document.querySelector(s).getBoundingClientRect();
    return b.left < window.innerWidth && b.right > 0 && b.top < window.innerHeight && b.bottom > 0;
  }, sel);

  test('both panels start off-screen, and their handles are on it', async ({ page }) => {
    await withVideo(page);
    expect(await onScreen(page, '#screen-room .room-header')).toBe(false);
    expect(await onScreen(page, '#screen-room .room-peers-panel')).toBe(false);
    for (const id of ['#stage-handle-header', '#stage-handle-roster', '#stage-handle-chat']) {
      expect(await page.evaluate((s) =>
        getComputedStyle(document.querySelector(s)).display, id)).toBe('flex');
    }
  });

  test('an audio-only room keeps both in their normal place', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true }],
    });
    expect(await onScreen(page, '#screen-room .room-header')).toBe(true);
    expect(await onScreen(page, '#screen-room .room-peers-panel')).toBe(true);
    expect(await page.evaluate(() =>
      getComputedStyle(document.getElementById('stage-handle-header')).display)).toBe('none');
  });

  test('tapping a handle slides its panel in, and again slides it out', async ({ page }) => {
    await withVideo(page);
    await page.locator('#stage-handle-header').click();
    await expect.poll(() => onScreen(page, '#screen-room .room-header')).toBe(true);
    expect(await page.locator('#stage-handle-header').getAttribute('aria-expanded')).toBe('true');

    await page.locator('#stage-handle-header').click();
    await expect.poll(() => onScreen(page, '#screen-room .room-header')).toBe(false);
  });

  test('the roster handle slides the participant list in from the left', async ({ page }) => {
    await withVideo(page);
    await page.locator('#stage-handle-roster').click();
    await expect.poll(() => onScreen(page, '#screen-room .room-peers-panel')).toBe(true);
    // It overlays the video rather than reflowing it: the tiles are unmoved.
    const tileBefore = await page.evaluate(() =>
      document.querySelector('#video-stage-grid .video-tile').getBoundingClientRect().toJSON());
    await page.evaluate(() => setStagePanel('roster', false));
    await page.waitForTimeout(300);
    const tileAfter = await page.evaluate(() =>
      document.querySelector('#video-stage-grid .video-tile').getBoundingClientRect().toJSON());
    expect(Math.round(tileAfter.height)).toBe(Math.round(tileBefore.height));
  });

  test('each panel comes from the edge its own handle sits on', async ({ page }) => {
    await withVideo(page);
    const sides = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      return {
        rosterHandle: r('#stage-handle-roster').left,
        chatHandle: r('#stage-handle-chat').left,
        mid: window.innerWidth / 2,
        chatHandleShown: getComputedStyle(document.getElementById('stage-handle-chat')).display,
      };
    });
    // Participants on the left edge, the conversation on the right.
    expect(sides.rosterHandle).toBeLessThan(sides.mid);
    expect(sides.chatHandle).toBeGreaterThan(sides.mid);
    expect(sides.chatHandleShown).toBe('flex');
  });

  test('the chat handle pulls the conversation in from the right', async ({ page }) => {
    await withVideo(page);
    await page.locator('#stage-handle-chat').click();
    await expect.poll(() => onScreen(page, '#screen-room .room-chat-panel')).toBe(true);
    expect(await page.locator('#stage-handle-chat').getAttribute('aria-expanded')).toBe('true');

    await page.locator('#stage-handle-chat').click();
    await expect.poll(() => onScreen(page, '#screen-room .room-chat-panel')).toBe(false);
  });

  // Three edges, one phone: any of them opening puts the others away.
  test('the chat and the roster are alternatives', async ({ page }) => {
    await withVideo(page);
    await page.evaluate(() => setStagePanel('roster', true));
    await page.evaluate(() => toggleChatPanel(true));
    expect(await page.evaluate(() => stagePanelOpen('roster'))).toBe(false);

    await page.evaluate(() => setStagePanel('roster', true));
    expect(await page.evaluate(() => chatPanelOpen())).toBe(false);
  });

  test('the unread count rides on the handle, where the header cannot', async ({ page }) => {
    await withVideo(page);
    const seen = await page.evaluate(() => {
      toggleChatPanel(false);
      appendChatMessage({ id: 'p1:1', peerId: 'p1', text: 'over here', at: Date.now() });
      updateChatUnreadBadge();
      const badge = document.querySelector('#stage-handle-chat .chat-unread');
      return { text: badge.textContent, hidden: badge.classList.contains('hidden') };
    });
    expect(seen).toEqual({ text: '1', hidden: false });
  });

  // They are alternatives — two panels open at once on a phone would overlap.
  test('opening one panel closes the other', async ({ page }) => {
    await withVideo(page);
    await page.evaluate(() => setStagePanel('header', true));
    await page.evaluate(() => setStagePanel('roster', true));
    expect(await page.evaluate(() => stagePanelOpen('header'))).toBe(false);
    expect(await page.evaluate(() => stagePanelOpen('roster'))).toBe(true);
  });

  test('a drag past the commit threshold opens the panel; a short one snaps back', async ({ page }) => {
    await withVideo(page);
    const handle = page.locator('#stage-handle-header');
    const box = await handle.boundingBox();
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    // A few pixels: under the threshold, so it must snap back closed.
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x, from.y + 10, { steps: 3 });
    await page.mouse.up();
    expect(await page.evaluate(() => stagePanelOpen('header'))).toBe(false);

    // Well past it: opens.
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x, from.y + 200, { steps: 8 });
    await page.mouse.up();
    expect(await page.evaluate(() => stagePanelOpen('header'))).toBe(true);
  });

  test('leaving the stage never strands a panel open', async ({ page }) => {
    await withVideo(page);
    await page.evaluate(() => setStagePanel('roster', true));
    await page.evaluate(() => {
      connections.get('p1').videoActive = false;
      updatePeerList();
    });
    expect(await page.evaluate(() => stagePanelOpen('roster'))).toBe(false);
  });
});

test.describe('capture and bitrate caps are mobile-aware', () => {
  test('a desktop keeps 720p30 and the full bitrate', async ({ page }) => {
    await page.goto('/');
    const cap = await page.evaluate(() => cameraCaptureCap());
    expect(cap.height.max).toBe(720);
    expect(await page.evaluate(() => cameraMaxBitrate())).toBe(600000);
  });

  test('a phone captures smaller and uploads less', async ({ page }) => {
    await fakeMobileUA(page);
    await page.goto('/');
    expect(await page.evaluate(() => IS_MOBILE_DEVICE)).toBe(true);
    const cap = await page.evaluate(() => cameraCaptureCap());
    expect(cap.height.max).toBe(360);
    expect(cap.frameRate.max).toBe(24);
    expect(await page.evaluate(() => cameraMaxBitrate())).toBe(300000);
  });

  // Never `exact` — forcing fixed dimensions renders a split frame on Desk View
  // and virtual cameras (KNOWLEDGE/learning.md).
  test('mobile capture constraints are still ideal/max, never exact', async ({ page }) => {
    await fakeMobileUA(page);
    await page.goto('/');
    const c = await page.evaluate(() => selectedCameraConstraints());
    expect(c.width.exact).toBeUndefined();
    expect(c.height.exact).toBeUndefined();
    expect(c.facingMode).toBe('user');
  });

  test('save-data and a slow link drop it further', async ({ page }) => {
    await fakeMobileUA(page);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'connection', {
        get: () => ({ saveData: true, effectiveType: '4g' }),
        configurable: true,
      });
    });
    await page.goto('/');
    expect(await page.evaluate(() => cameraMaxBitrate())).toBe(150000);
  });

  // WebKit — every iOS browser — has no Network Information API at all. Its
  // absence must fall through to the plain mobile cap, never to the desktop one.
  test('no Network Information API falls back to the mobile cap, not the desktop one', async ({ page }) => {
    await fakeMobileUA(page);
    await page.addInitScript(() => {
      delete navigator.connection;
      Object.defineProperty(navigator, 'connection', { get: () => undefined, configurable: true });
    });
    await page.goto('/');
    expect(await page.evaluate(() => cameraMaxBitrate())).toBe(300000);
  });
});

test.describe('camera flip', () => {
  test.use({ viewport: PHONE });

  test.beforeEach(async ({ page }) => {
    await fakeMobileUA(page);
  });

  test('the facing mode drives the capture constraints', async ({ page }) => {
    await page.goto('/');
    expect(await page.evaluate(() => selectedCameraConstraints().facingMode)).toBe('user');
    await page.evaluate(() => { _cameraFacing = 'environment'; });
    expect(await page.evaluate(() => selectedCameraConstraints().facingMode)).toBe('environment');
  });

  // On a phone the device list is not stable enough for a pinned deviceId to
  // mean anything, and the flip is expressed as a facing mode — so the facing
  // mode has to win. On a desktop the stored id still rules.
  test('a stored camera id does not override the facing mode on mobile', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('camera-device-id', 'cam-abc'));
    await page.goto('/');
    const c = await page.evaluate(() => selectedCameraConstraints());
    expect(c.deviceId).toBeUndefined();
    expect(c.facingMode).toBe('user');
  });

  // The rule that matters: a flip is not a stop. Re-publishing would renegotiate
  // and drop every viewer's tile, and a `video-stop` on the wire would clear the
  // peers' `videoActive` flag — which a live share never re-announces.
  test('swaps the track in place and says nothing on the wire', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(async () => {
      const sent = [];
      const replaced = [];
      const newTrack = { kind: 'video', stop() {}, enabled: true };
      // A real MediaStream, because the stage assigns it to video.srcObject —
      // only its track accessors are stubbed.
      const fakeStream = new MediaStream();
      fakeStream.getVideoTracks = () => [newTrack];
      fakeStream.getTracks = () => [newTrack];
      navigator.mediaDevices.getUserMedia = async () => fakeStream;

      const sender = {
        track: { kind: 'video' },
        replaceTrack: (t) => { replaced.push(t); return Promise.resolve(); },
        getParameters: () => ({ encodings: [{}] }),
        setParameters: () => Promise.resolve(),
      };
      const pc = { getSenders: () => [sender] };

      peer = { id: 'self' };
      inRoom = true;
      isHost = true;
      localVideoActive = true;
      const oldStream = new MediaStream();
      oldStream.getTracks = () => [{ stop() {} }];
      oldStream.getVideoTracks = () => [];
      localVideoStream = oldStream;
      connections.clear();
      connections.set('p1', {
        data: { send: (m) => sent.push(m) },
        videoMediaOut: { closed: false, peerConnection: pc },
      });

      await flipCamera();
      return {
        facing: _cameraFacing,
        replacedCount: replaced.length,
        replacedIsNew: replaced[0] === newTrack,
        stopMessages: sent.filter((m) => m && m.type === 'video-stop').length,
        anyMessages: sent.length,
        streamSwapped: localVideoStream === fakeStream,
      };
    });
    expect(result.facing).toBe('environment');
    expect(result.replacedCount).toBe(1);
    expect(result.replacedIsNew).toBe(true);
    expect(result.stopMessages).toBe(0);
    expect(result.anyMessages).toBe(0);
    expect(result.streamSwapped).toBe(true);
  });

  // A failed flip that leaves the call with a dead camera is far worse than one
  // that does nothing, so the old stream stays wired up and the facing reverts.
  test('a failed acquisition keeps the previous camera', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(async () => {
      navigator.mediaDevices.getUserMedia = async () => { throw new Error('NotAllowedError'); };
      const original = { getTracks: () => [], getVideoTracks: () => [] };
      peer = { id: 'self' };
      inRoom = true;
      localVideoActive = true;
      localVideoStream = original;
      connections.clear();
      await flipCamera();
      return { facing: _cameraFacing, kept: localVideoStream === original, active: localVideoActive };
    });
    expect(result.facing).toBe('user');
    expect(result.kept).toBe(true);
    expect(result.active).toBe(true);
  });

  // Flip belongs to the camera, not to the room — so it lives on the self-view
  // tile, and because renderVideoStage() MOVES the same element between the grid
  // and the minimized badge, one button serves both.
  test('the button rides on the self-view tile, not the control row', async ({ page }) => {
    await page.goto('/');
    await enterRoom(page, { knownPeerIds: [], connections: [] });
    await page.evaluate(() => {
      localVideoActive = true;
      localVideoStream = new MediaStream();
      window._voxalVideoStream = localVideoStream;
      _cameraFlipSupported = true;
      updatePeerList();
    });
    expect(await page.locator('#video-stage [data-key="camera:self"] .video-tile-flip').count()).toBe(1);
    expect(await page.locator('.room-controls #btn-flip-camera').count()).toBe(0);
  });

  test('it is offered only when there is a second camera to switch to', async ({ page }) => {
    await page.goto('/');
    await enterRoom(page, { knownPeerIds: [], connections: [] });
    await page.evaluate(() => {
      localVideoActive = true;
      localVideoStream = new MediaStream();
      window._voxalVideoStream = localVideoStream;
      _cameraFlipSupported = false;
      updatePeerList();
    });
    const btn = page.locator('#video-stage [data-key="camera:self"] .video-tile-flip');
    expect(await btn.evaluate((e) => getComputedStyle(e).display)).toBe('none');
    await page.evaluate(() => { _cameraFlipSupported = true; updatePeerList(); });
    expect(await btn.evaluate((e) => getComputedStyle(e).display)).toBe('flex');
  });

  // Every tile carries a click-to-pin handler and the badge carries a drag;
  // pressing flip must trigger neither.
  test('pressing it does not also pin the tile', async ({ page }) => {
    await page.goto('/');
    await enterRoom(page, { knownPeerIds: [], connections: [] });
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        const s = new MediaStream();
        s.getVideoTracks = () => [{ kind: 'video', enabled: true, stop() {} }];
        s.getTracks = () => s.getVideoTracks();
        return s;
      };
      localVideoActive = true;
      localVideoStream = new MediaStream();
      window._voxalVideoStream = localVideoStream;
      _cameraFlipSupported = true;
      updatePeerList();
    });
    await page.locator('#video-stage [data-key="camera:self"] .video-tile-flip').click();
    expect(await page.evaluate(() => _stagePinnedKey)).toBeNull();
    await expect.poll(() => page.evaluate(() => _cameraFacing)).toBe('environment');
  });

  test('the self-view stops being mirrored on the rear camera', async ({ page }) => {
    await page.goto('/');
    await enterRoom(page, { knownPeerIds: [], connections: [] });
    await page.evaluate(() => {
      localVideoActive = true;
      window._voxalVideoStream = new MediaStream();
      localVideoStream = window._voxalVideoStream;
      _cameraFacing = 'environment';
      updatePeerList();
    });
    const tile = page.locator('#video-stage [data-key="camera:self"]');
    expect(await tile.count()).toBe(1);
    expect(await tile.getAttribute('data-facing')).toBe('environment');
    const transform = await page.evaluate(() =>
      getComputedStyle(document.querySelector('#video-stage [data-key="camera:self"] video')).transform);
    expect(transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)').toBe(true);
  });
});

test.describe('background pause and wake lock', () => {
  test.use({ viewport: PHONE });

  test('backgrounding disables the camera track without stopping it', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(() => {
      let stopped = false;
      const track = { kind: 'video', enabled: true, stop() { stopped = true; } };
      localVideoStream = { getVideoTracks: () => [track], getTracks: () => [track] };
      setLocalCameraSuspended(true);
      const paused = { enabled: track.enabled, stopped };
      setLocalCameraSuspended(false);
      return { paused, resumedEnabled: track.enabled, stopped };
    });
    expect(result.paused.enabled).toBe(false);
    expect(result.paused.stopped).toBe(false);   // never stop(): that would renegotiate
    expect(result.resumedEnabled).toBe(true);
    expect(result.stopped).toBe(false);
  });

  test('a wake lock is taken while the stage is up and released when it stands down', async ({ page }) => {
    await page.addInitScript(() => {
      window.__wakeLocks = { requested: 0, released: 0 };
      Object.defineProperty(navigator, 'wakeLock', {
        get: () => ({
          request: async () => {
            window.__wakeLocks.requested++;
            return {
              release: () => { window.__wakeLocks.released++; },
              addEventListener: () => {},
            };
          },
        }),
        configurable: true,
      });
    });
    await page.goto('/');
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    await expect.poll(() => page.evaluate(() => window.__wakeLocks.requested)).toBeGreaterThan(0);

    await page.evaluate(() => {
      connections.get('p1').videoActive = false;
      updatePeerList();
    });
    await expect.poll(() => page.evaluate(() => window.__wakeLocks.released)).toBeGreaterThan(0);
  });

  test('an audio-only room never asks for a wake lock', async ({ page }) => {
    await page.addInitScript(() => {
      window.__wakeLocks = { requested: 0 };
      Object.defineProperty(navigator, 'wakeLock', {
        get: () => ({
          request: async () => {
            window.__wakeLocks.requested++;
            return { release: () => {}, addEventListener: () => {} };
          },
        }),
        configurable: true,
      });
    });
    await page.goto('/');
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true }],
    });
    expect(await page.evaluate(() => window.__wakeLocks.requested)).toBe(0);
  });

  // Feature-detected: older WebKit has no Wake Lock API and must not throw.
  test('no Wake Lock API is survivable', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'wakeLock', { get: () => undefined, configurable: true });
    });
    await page.goto('/');
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    expect(await page.evaluate(() => document.body.classList.contains('video-stage-immersive'))).toBe(true);
  });
});
