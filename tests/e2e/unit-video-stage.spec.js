import { test, expect } from './fixtures.js';
import { seedRoom, callFn } from './_helpers.js';

// The video stage: a tile grid that takes over the room's main area while any
// camera or screen is live, with Voxal's voice UI (roster + PTT + controls)
// stacked into a right-hand rail. It is strictly additive — an audio-only room
// must render exactly as it did before the stage existed, which is the
// assertion that matters most here.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

// Put the page in a room with a rendered roster, the way the app does.
async function enterRoom(page, cfg = {}) {
  await seedRoom(page, { selfId: 'self', isHost: true, roomCode: 'room1', ...cfg });
  await page.evaluate(() => {
    showScreen('room');
    updatePeerList();
  });
}

// Give a seeded connection a fake remote stream, so it renders as a live tile
// rather than a placeholder. MediaStream is constructible in Chromium.
async function giveStream(page, peerId, kind) {
  await page.evaluate(({ peerId, kind }) => {
    const conn = connections.get(peerId);
    conn[kind === 'screen' ? 'remoteScreenStream' : 'remoteVideoStream'] = new MediaStream();
    updatePeerList();
  }, { peerId, kind });
}

const tileKeys = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('#video-stage [data-key]')).map((el) => el.dataset.key)
  );

test.describe('videoStageTiles', () => {
  test('is empty for an audio-only room', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true }],
    });
    expect(await callFn(page, 'videoStageTiles')).toEqual([]);
  });

  test('tiles a peer sharing a camera, and leaves camera-off peers out', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1', 'p2'],
      connections: [
        { id: 'p1', pseudo: 'Alice', open: true, videoActive: true },
        { id: 'p2', pseudo: 'Bob', open: true },
      ],
    });
    const tiles = await callFn(page, 'videoStageTiles');
    expect(tiles.map((t) => t.key)).toEqual(['camera:p1']);
    expect(tiles[0].label).toBe('Alice');
  });

  test('orders screens first, then remote cameras, then self last', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1', 'p2'],
      connections: [
        { id: 'p1', pseudo: 'Alice', open: true, videoActive: true },
        { id: 'p2', pseudo: 'Bob', open: true, screenActive: true },
      ],
    });
    await page.evaluate(() => { localVideoActive = true; });
    const keys = (await callFn(page, 'videoStageTiles')).map((t) => t.key);
    expect(keys).toEqual(['screen:p2', 'camera:p1', 'camera:self']);
  });

  test('respects the video-mode switch', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    expect(await callFn(page, 'videoStageTiles')).toHaveLength(1);
    await page.evaluate(() => { videoModeEnabled = false; });
    expect(await callFn(page, 'videoStageTiles')).toEqual([]);
  });
});

test.describe('videoStageFocusKey', () => {
  test('focuses a screen share automatically, nothing when only cameras', async ({ page }) => {
    const cameras = [{ key: 'camera:p1', kind: 'camera' }];
    const withScreen = [{ key: 'camera:p1', kind: 'camera' }, { key: 'screen:p2', kind: 'screen' }];
    expect(await callFn(page, 'videoStageFocusKey', cameras)).toBe('');
    expect(await callFn(page, 'videoStageFocusKey', withScreen)).toBe('screen:p2');
  });

  test('an explicit pin wins over the screen share', async ({ page }) => {
    await page.evaluate(() => { _stagePinnedKey = 'camera:p1'; });
    const tiles = [{ key: 'camera:p1', kind: 'camera' }, { key: 'screen:p2', kind: 'screen' }];
    expect(await callFn(page, 'videoStageFocusKey', tiles)).toBe('camera:p1');
  });

  test('a pin on a tile that has gone away is dropped, not held', async ({ page }) => {
    await page.evaluate(() => { _stagePinnedKey = 'camera:gone'; });
    const tiles = [{ key: 'camera:p1', kind: 'camera' }];
    expect(await callFn(page, 'videoStageFocusKey', tiles)).toBe('');
    expect(await page.evaluate(() => _stagePinnedKey)).toBeNull();
  });
});

test.describe('body.video-stage', () => {
  const hasClass = (page) => page.evaluate(() => document.body.classList.contains('video-stage'));

  test('an audio-only room never gets the class', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true }],
    });
    expect(await hasClass(page)).toBe(false);
    expect(await page.locator('#video-stage').isVisible()).toBe(false);
  });

  test('appears with the first camera and goes away with the last', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    expect(await hasClass(page)).toBe(true);

    await page.evaluate(() => {
      connections.get('p1').videoActive = false;
      updatePeerList();
    });
    expect(await hasClass(page)).toBe(false);
  });

  test('is dropped when the room ends', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    expect(await hasClass(page)).toBe(true);
    await page.evaluate(() => { inRoom = false; updateVideoStage(); });
    expect(await hasClass(page)).toBe(false);
  });
});

test.describe('room layout', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the room becomes a grid and escapes the 480px column', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    const style = await page.evaluate(() => {
      const cs = getComputedStyle(document.getElementById('screen-room'));
      return { display: cs.display, maxWidth: cs.maxWidth };
    });
    expect(style.display).toBe('grid');
    // Without the max-width override the grid stays trapped in the centered
    // desktop column and the stage is ~480px wide regardless of the viewport.
    expect(style.maxWidth).toBe('none');
  });

  test('the voice UI stays on screen, to the right of the stage', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    const boxes = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      return { stage: r('#video-stage'), roster: r('#room-peers-panel'), ptt: r('.room-bottom-bar') };
    });
    expect(boxes.roster.left).toBeGreaterThan(boxes.stage.left);
    expect(boxes.ptt.left).toBeGreaterThan(boxes.stage.left);
    // The PTT column sits below the roster in the same rail.
    expect(boxes.ptt.top).toBeGreaterThanOrEqual(boxes.roster.top);
  });

  test('an audio-only room keeps the flex stack', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true }],
    });
    const display = await page.evaluate(
      () => getComputedStyle(document.getElementById('screen-room')).display
    );
    expect(display).toBe('flex');
  });

  // The consent banner shared the `header` grid area with .room-header, so its
  // Accept / Decline buttons landed on top of the room's own header controls.
  test('the debug consent banner sits above the header, not on top of it', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    await page.evaluate(() => document.getElementById('debug-consent-banner').classList.remove('hidden'));
    const boxes = await page.evaluate(() => {
      const r = (s) => {
        const b = document.querySelector(s).getBoundingClientRect();
        return { top: b.top, bottom: b.bottom, height: b.height };
      };
      return { banner: r('#debug-consent-banner'), header: r('.room-header'), stage: r('#video-stage') };
    });
    expect(boxes.banner.height).toBeGreaterThan(0);
    expect(boxes.banner.bottom).toBeLessThanOrEqual(boxes.header.top + 1);
    expect(boxes.header.bottom).toBeLessThanOrEqual(boxes.stage.top + 1);
  });

  test('and its row collapses to nothing while it is hidden', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    const withoutBanner = await page.evaluate(
      () => document.querySelector('.room-header').getBoundingClientRect().top
    );
    await page.evaluate(() => document.getElementById('debug-consent-banner').classList.remove('hidden'));
    const withBanner = await page.evaluate(
      () => document.querySelector('.room-header').getBoundingClientRect().top
    );
    expect(withBanner).toBeGreaterThan(withoutBanner);
  });
});

test.describe('renderVideoStage', () => {
  test('places a screen share in the focus slot and cameras in the grid', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1', 'p2'],
      connections: [
        { id: 'p1', pseudo: 'Alice', open: true, videoActive: true },
        { id: 'p2', pseudo: 'Bob', open: true, screenActive: true },
      ],
    });
    const where = await page.evaluate(() => ({
      focus: Array.from(document.querySelectorAll('#video-stage-focus [data-key]')).map((e) => e.dataset.key),
      grid: Array.from(document.querySelectorAll('#video-stage-grid [data-key]')).map((e) => e.dataset.key),
      hasFocus: document.getElementById('video-stage').classList.contains('has-focus'),
    }));
    expect(where.focus).toEqual(['screen:p2']);
    expect(where.grid).toEqual(['camera:p1']);
    expect(where.hasFocus).toBe(true);
  });

  test('does not reassign srcObject when nothing changed', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    await giveStream(page, 'p1', 'camera');

    // Re-running the render must not touch srcObject: reassigning it restarts
    // playback and visibly flashes every tile, and updatePeerList() (which
    // drives the stage) runs on every roster tick.
    const writes = await page.evaluate(() => {
      const vid = document.querySelector('#video-stage [data-key="camera:p1"] video');
      let count = 0;
      // srcObject is defined on HTMLMediaElement.prototype, not HTMLVideoElement's.
      let desc = null;
      for (let p = Object.getPrototypeOf(vid); p && !desc; p = Object.getPrototypeOf(p)) {
        desc = Object.getOwnPropertyDescriptor(p, 'srcObject');
      }
      Object.defineProperty(vid, 'srcObject', {
        configurable: true,
        get() { return desc.get.call(this); },
        set(v) { count++; desc.set.call(this, v); },
      });
      updatePeerList();
      updatePeerList();
      return count;
    });
    expect(writes).toBe(0);
  });

  test('keeps a slot as a placeholder while a stream has not arrived', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    const state = await page.evaluate(() => {
      const tile = document.querySelector('#video-stage [data-key="camera:p1"]');
      const ph = tile.querySelector('.video-tile-placeholder');
      return { exists: !!tile, hidden: ph.classList.contains('hidden'), text: ph.textContent };
    });
    expect(state.exists).toBe(true);
    expect(state.hidden).toBe(false);
    expect(state.text).toBe('A');

    await giveStream(page, 'p1', 'camera');
    const after = await page.evaluate(() =>
      document
        .querySelector('#video-stage [data-key="camera:p1"] .video-tile-placeholder')
        .classList.contains('hidden')
    );
    expect(after).toBe(true);
  });

  test('releases the stream reference when a tile goes away', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    await giveStream(page, 'p1', 'camera');
    expect(await tileKeys(page)).toEqual(['camera:p1']);

    await page.evaluate(() => {
      connections.get('p1').videoActive = false;
      updatePeerList();
    });
    expect(await tileKeys(page)).toEqual([]);
  });

  test('every tile is muted — audio rides its own connection', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    const allMuted = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#video-stage video')).every((v) => v.muted)
    );
    expect(allMuted).toBe(true);
  });
});

test.describe('grid sizing', () => {
  // Pure CSS can size columns but knows nothing about the leftover height, which
  // left an auto-fit grid stranded in the top third of the stage.
  test('picks the column count that makes tiles largest', async ({ page }) => {
    const cols = (n, w, h) => callFn(page, 'bestGridColumns', n, w, h, 16 / 9);
    // A wide, short stage: everything fits on one row.
    expect(await cols(3, 1200, 260)).toBe(3);
    // A roughly square stage: 2x2 beats 3x1 and 1x3.
    expect(await cols(3, 900, 700)).toBe(2);
    expect(await cols(4, 900, 700)).toBe(2);
    expect(await cols(1, 900, 700)).toBe(1);
  });

  test('degrades safely when there is nothing to measure', async ({ page }) => {
    expect(await callFn(page, 'bestGridColumns', 0, 900, 700, 16 / 9)).toBe(1);
    expect(await callFn(page, 'bestGridColumns', 3, 0, 0, 16 / 9)).toBe(1);
  });
});

// The roster row is where a participant's state already lives, so it is also
// where the control belongs. On someone else's row the icon decides whether YOU
// watch them — never whether they transmit; on your own it is your camera.
test.describe('the roster keeps a camera icon for everyone with a camera', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('a peer shown on the stage still carries the icon on their row', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    expect(await page.locator('#peer-item-p1 .peer-cam-btn').count()).toBe(1);
    expect(await page.locator('#video-stage [data-key="camera:p1"]').count()).toBe(1);
    expect(await page.locator('#peer-item-p1 .peer-cam-btn').getAttribute('aria-pressed')).toBe('true');
  });

  test('pressing it stops watching that peer, pressing again resumes', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1', 'p2'],
      connections: [
        { id: 'p1', pseudo: 'Alice', open: true, videoActive: true },
        { id: 'p2', pseudo: 'Bob', open: true, videoActive: true },
      ],
    });
    expect(await tileKeys(page)).toEqual(['camera:p1', 'camera:p2']);

    await page.locator('#peer-item-p1 .peer-cam-btn').click();
    expect(await tileKeys(page)).toEqual(['camera:p2']);
    // The row keeps the icon — it is the only thing that can bring them back.
    const btn = page.locator('#peer-item-p1 .peer-cam-btn');
    expect(await btn.count()).toBe(1);
    expect(await btn.getAttribute('aria-pressed')).toBe('false');
    // Their camera is untouched: hiding is local, nothing is signalled.
    expect(await page.evaluate(() => connections.get('p1').videoActive)).toBe(true);

    await btn.click();
    expect(await tileKeys(page)).toEqual(['camera:p1', 'camera:p2']);
  });

  test('a camera going off releases the hide, so a re-share is visible again', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1', 'p2'],
      connections: [
        { id: 'p1', pseudo: 'Alice', open: true, videoActive: true },
        { id: 'p2', pseudo: 'Bob', open: true, videoActive: true },
      ],
    });
    await page.locator('#peer-item-p1 .peer-cam-btn').click();
    expect(await page.evaluate(() => _hiddenStageKeys.has('camera:p1'))).toBe(true);

    await page.evaluate(() => { connections.get('p1').videoActive = false; updatePeerList(); });
    await page.evaluate(() => { connections.get('p1').videoActive = true; updatePeerList(); });
    expect(await page.evaluate(() => _hiddenStageKeys.has('camera:p1'))).toBe(false);
    expect(await tileKeys(page)).toEqual(['camera:p1', 'camera:p2']);
  });

  test('hiding the last visible camera does not strand the icon', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    await page.locator('#peer-item-p1 .peer-cam-btn').click();
    // The stage has nothing left to show and stands down…
    expect(await page.evaluate(() => document.body.classList.contains('video-stage'))).toBe(false);
    // …but the icon still means "watch Alice", not "open a floating viewer".
    await page.locator('#peer-item-p1 .peer-cam-btn').click();
    expect(await page.evaluate(() => _videoViewerPeerId)).toBeNull();
    expect(await tileKeys(page)).toEqual(['camera:p1']);
  });

  // Your own icon is about your self-view only. The footer Camera button owns
  // the stream, and two controls for one stream is how you end up switching off
  // a camera you only meant to stop looking at.
  test('your own row hides your self-view without touching the stream', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    await page.evaluate(() => { localVideoActive = true; updatePeerList(); });
    const btn = page.locator('#peer-item-self .peer-cam-btn');
    expect(await btn.getAttribute('aria-pressed')).toBe('true');

    await btn.click();
    expect(await page.evaluate(() => localVideoActive)).toBe(true);   // still transmitting
    expect(await page.locator('#video-stage [data-key="camera:self"]').count()).toBe(0);
    expect(await btn.getAttribute('aria-pressed')).toBe('false');

    await btn.click();
    expect(await page.locator('#video-stage [data-key="camera:self"]').count()).toBe(1);
  });

  test('no self-view to hide means no icon on your own row', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    // Camera off: the footer button is what turns it on, not this row.
    expect(await page.locator('#peer-item-self .peer-cam-btn').count()).toBe(0);
    // Camera on, on a surface with no stage at all (Tauri has neither is-web
    // nor is-native and keeps its pop-out window): still no self-view to hide.
    await page.evaluate(() => {
      document.documentElement.classList.remove('is-web');
      localVideoActive = true;
      updatePeerList();
    });
    expect(await page.evaluate(() => videoStageMode())).toBe('none');
    expect(await page.locator('#peer-item-self .peer-cam-btn').count()).toBe(0);
  });

  // A phone is no longer a surface without a stage — it gets the immersive one —
  // so the self-view icon has to be there to hide it, exactly as on desktop.
  test('a narrow web viewport gets the immersive stage, self-view icon and all', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    await page.evaluate(() => { localVideoActive = true; updatePeerList(); });
    expect(await page.evaluate(() => videoStageMode())).toBe('immersive');
    expect(await page.locator('#peer-item-self .peer-cam-btn').count()).toBe(1);
  });

  test('the icons follow the video-mode switch', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    await page.evaluate(() => { localVideoActive = true; updatePeerList(); });
    expect(await page.locator('.peer-cam-btn').count()).toBe(2);   // Alice + self
    await page.evaluate(() => { videoModeEnabled = false; updatePeerList(); });
    expect(await page.locator('.peer-cam-btn').count()).toBe(0);
  });

  // Where there is no stage — Tauri (its own pop-out window) and the tiny embed —
  // the same icon keeps its original meaning: open a floating viewer on that
  // peer. Both readings are "am I watching this person".
  test('with no stage available the icon still drives the floating viewer', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    await page.evaluate(() => document.documentElement.classList.remove('is-web'));
    await giveStream(page, 'p1', 'camera');
    expect(await page.evaluate(() => videoStageAvailable())).toBe(false);
    expect(await page.evaluate(() => document.body.classList.contains('video-stage'))).toBe(false);

    await page.locator('#peer-item-p1 .peer-cam-btn').click();
    expect(await page.evaluate(() => _videoViewerPeerId)).toBe('p1');
    await page.locator('#peer-item-p1 .peer-cam-btn').click();
    expect(await page.evaluate(() => _videoViewerPeerId)).toBeNull();
  });
});

// Your own camera is a self-view, not content: it takes a small draggable badge
// over the stage. The exception is being the only camera in the room — there is
// then nothing for it to be small beside.
test.describe('the self-view badge', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  const badgeKeys = (page) =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('#video-stage-self [data-key]')).map((e) => e.dataset.key)
    );

  test('selfBadgeTileKey minimizes only when someone else has a camera on', async ({ page }) => {
    const self = { key: 'camera:self', kind: 'camera', self: true };
    const alice = { key: 'camera:p1', kind: 'camera', self: false };
    const screen = { key: 'screen:p1', kind: 'screen', self: false };
    expect(await callFn(page, 'selfBadgeTileKey', [self], '')).toBe('');
    expect(await callFn(page, 'selfBadgeTileKey', [alice, self], '')).toBe('camera:self');
    // A screen share is not a camera: alone with one, you are still the camera.
    expect(await callFn(page, 'selfBadgeTileKey', [screen, self], 'screen:p1')).toBe('');
    // An explicit pin means "show me this big" and outranks minimising.
    expect(await callFn(page, 'selfBadgeTileKey', [alice, self], 'camera:self')).toBe('');
    expect(await callFn(page, 'selfBadgeTileKey', [alice], '')).toBe('');
  });

  test('alone with a camera, the self-view takes the stage', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true }],
    });
    await page.evaluate(() => { localVideoActive = true; updatePeerList(); });
    expect(await badgeKeys(page)).toEqual([]);
    expect(await page.locator('#video-stage-grid [data-key="camera:self"]').count()).toBe(1);
    expect(await page.locator('#video-stage-self').isVisible()).toBe(false);
  });

  test('a second camera minimizes it into the badge, and back out again', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true }],
    });
    await page.evaluate(() => { localVideoActive = true; updatePeerList(); });
    await page.evaluate(() => { connections.get('p1').videoActive = true; updatePeerList(); });
    expect(await badgeKeys(page)).toEqual(['camera:self']);
    expect(await page.locator('#video-stage-grid [data-key]').count()).toBe(1);
    expect(await page.locator('#video-stage-self').isVisible()).toBe(true);

    await page.evaluate(() => { connections.get('p1').videoActive = false; updatePeerList(); });
    expect(await badgeKeys(page)).toEqual([]);
    expect(await page.locator('#video-stage-grid [data-key="camera:self"]').count()).toBe(1);
  });

  test('moving between badge and grid never reassigns srcObject', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true }],
    });
    await page.evaluate(() => {
      localVideoStream = new MediaStream();
      localVideoActive = true;
      updatePeerList();
    });
    const writes = await page.evaluate(() => {
      const vid = document.querySelector('#video-stage [data-key="camera:self"] video');
      let count = 0;
      let desc = null;
      for (let p = Object.getPrototypeOf(vid); p && !desc; p = Object.getPrototypeOf(p)) {
        desc = Object.getOwnPropertyDescriptor(p, 'srcObject');
      }
      Object.defineProperty(vid, 'srcObject', {
        configurable: true,
        get() { return desc.get.call(this); },
        set(v) { count++; desc.set.call(this, v); },
      });
      connections.get('p1').videoActive = true;   // minimize into the badge
      updatePeerList();
      connections.get('p1').videoActive = false;  // and back to the grid
      updatePeerList();
      return count;
    });
    expect(writes).toBe(0);
  });

  test('nearestBadgeCorner snaps by the badge centre', async ({ page }) => {
    const stage = { width: 1000, height: 600 };
    const at = (left, top) => callFn(page, 'nearestBadgeCorner', { left, top, width: 200, height: 120 }, stage);
    expect(await at(0, 0)).toBe('tl');
    expect(await at(800, 0)).toBe('tr');
    expect(await at(0, 480)).toBe('bl');
    expect(await at(800, 480)).toBe('br');
    // Centre just past the midpoint counts as the far corner, not the near one.
    expect(await at(401, 241)).toBe('br');
    expect(await at(399, 239)).toBe('tl');
  });

  test('the corner is remembered, and a stored nonsense value is ignored', async ({ page }) => {
    await page.evaluate(() => setSelfBadgeCorner('tl'));
    expect(await page.evaluate(() => localStorage.getItem('self-video-corner'))).toBe('tl');
    expect(await page.evaluate(() => document.getElementById('video-stage-self').dataset.corner)).toBe('tl');
    expect(await page.evaluate(() => readSelfBadgeCorner())).toBe('tl');

    await page.evaluate(() => localStorage.setItem('self-video-corner', 'somewhere'));
    expect(await page.evaluate(() => readSelfBadgeCorner())).toBe('br');
  });

  test('dragging it snaps to the nearest corner without pinning the tile', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    await page.evaluate(() => { localVideoActive = true; updatePeerList(); });
    const badge = page.locator('#video-stage-self');
    expect(await badge.getAttribute('data-corner')).toBe('br');

    const box = await badge.boundingBox();
    const stage = await page.locator('#video-stage').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(stage.x + 30, stage.y + 30, { steps: 8 });
    await page.mouse.up();

    expect(await badge.getAttribute('data-corner')).toBe('tl');
    expect(await page.evaluate(() => localStorage.getItem('self-video-corner'))).toBe('tl');
    // A drag ends in a click; letting it through would pin the tile to focus.
    expect(await page.evaluate(() => _stagePinnedKey)).toBeNull();
    // Snapped back to a corner: no inline offset survives the drop.
    expect(await page.evaluate(() => document.getElementById('video-stage-self').style.left)).toBe('');

    const after = await badge.boundingBox();
    expect(after.x).toBeLessThan(stage.x + stage.width / 2);
    expect(after.y).toBeLessThan(stage.y + stage.height / 2);
  });

  test('the badge stays inside the stage when dragged past its edge', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    await page.evaluate(() => { localVideoActive = true; updatePeerList(); });
    const badge = page.locator('#video-stage-self');
    const box = await badge.boundingBox();
    const stage = await page.locator('#video-stage').boundingBox();

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(stage.x - 400, stage.y - 400, { steps: 6 });
    const during = await badge.boundingBox();
    expect(during.x).toBeGreaterThanOrEqual(stage.x - 1);
    expect(during.y).toBeGreaterThanOrEqual(stage.y - 1);
    await page.mouse.up();
  });

  test('a plain click still pins the self-view, as on any other tile', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    await page.evaluate(() => { localVideoActive = true; updatePeerList(); });
    await page.locator('#video-stage-self .video-tile').click();
    expect(await page.evaluate(() => _stagePinnedKey)).toBe('camera:self');
    // Pinned, it is the focus rather than a badge.
    expect(await page.locator('#video-stage-focus [data-key="camera:self"]').count()).toBe(1);
  });
});

test.describe('tile state cues', () => {
  test('talking lands on the tile as well as the roster row', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    await callFn(page, 'updatePeerTalking', 'p1', true);
    let state = await page.evaluate(() => ({
      tile: document.querySelector('#video-stage [data-key="camera:p1"]').classList.contains('talking'),
      row: document.getElementById('peer-item-p1').classList.contains('talking'),
    }));
    expect(state).toEqual({ tile: true, row: true });

    await callFn(page, 'updatePeerTalking', 'p1', false);
    state = await page.evaluate(
      () => document.querySelector('#video-stage [data-key="camera:p1"]').classList.contains('talking')
    );
    expect(state).toBe(false);
  });

  test('the ICE quality dot mirrors the measured candidate type', async ({ page }) => {
    await enterRoom(page, {
      knownPeerIds: ['p1'],
      connections: [{ id: 'p1', pseudo: 'Alice', open: true, videoActive: true }],
    });
    await page.evaluate(() => {
      connections.get('p1').webrtcStats = { iceType: 'relay' };
      updatePeerList();
    });
    const cls = await page.evaluate(
      () => document.querySelector('#video-stage [data-key="camera:p1"] .video-tile-ice').className
    );
    expect(cls).toContain('peer-dot-relay');
  });
});

test.describe('video mode is a real setting', () => {
  test('defaults to on without writing the key', async ({ page }) => {
    expect(await page.evaluate(() => readVideoModeEnabled())).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('video-mode-enabled'))).toBeNull();
  });

  test('an explicit off is honoured and survives leaving the room', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('video-mode-enabled', 'false'));
    expect(await page.evaluate(() => readVideoModeEnabled())).toBe(false);
    // resetVideoState() used to force the key back to 'true' on every leave.
    await page.evaluate(() => { videoModeEnabled = false; resetVideoState(); });
    expect(await page.evaluate(() => videoModeEnabled)).toBe(false);
    expect(await page.evaluate(() => localStorage.getItem('video-mode-enabled'))).toBe('false');
  });
});

test.describe('capture and sender limits', () => {
  test('camera capture is capped, and never with exact dimensions', async ({ page }) => {
    const c = await callFn(page, 'selectedCameraConstraints');
    expect(c.width).toEqual({ ideal: 1280, max: 1280 });
    expect(c.height).toEqual({ ideal: 720, max: 720 });
    expect(c.frameRate).toEqual({ ideal: 30, max: 30 });
    // `exact` dimensions render a split frame on Desk View / virtual cameras.
    expect(JSON.stringify(c)).not.toContain('"exact":1280');
  });

  test('a selected device id survives alongside the cap', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('camera-device-id', 'cam-7'));
    const c = await callFn(page, 'selectedCameraConstraints');
    expect(c.deviceId).toEqual({ exact: 'cam-7' });
    expect(c.height).toEqual({ ideal: 720, max: 720 });
  });

  test('scales resolution down as the room grows', async ({ page }) => {
    expect(await callFn(page, 'videoScaleForPeerCount', 2)).toBe(1);
    expect(await callFn(page, 'videoScaleForPeerCount', 4)).toBe(1.5);
    expect(await callFn(page, 'videoScaleForPeerCount', 8)).toBe(2);
  });

  test('tunes camera senders for motion and screens for legibility', async ({ page }) => {
    const applied = await page.evaluate(() => {
      const make = () => {
        const track = { kind: 'video', contentHint: '' };
        let params = { encodings: [{}] };
        return {
          track,
          getParameters: () => params,
          setParameters: (p) => { params = p; return Promise.resolve(); },
          read: () => params,
        };
      };
      const cam = make();
      const scr = make();
      tuneVideoSenders({ getSenders: () => [cam] }, 'camera');
      tuneVideoSenders({ getSenders: () => [scr] }, 'screen');
      return {
        camHint: cam.track.contentHint,
        camBitrate: cam.read().encodings[0].maxBitrate,
        camDegradation: cam.read().degradationPreference,
        scrHint: scr.track.contentHint,
        scrBitrate: scr.read().encodings[0].maxBitrate,
        scrDegradation: scr.read().degradationPreference,
        scrScale: scr.read().encodings[0].scaleResolutionDownBy,
      };
    });
    expect(applied.camHint).toBe('motion');
    expect(applied.camBitrate).toBe(600000);
    expect(applied.camDegradation).toBe('balanced');
    // A screen keeps its resolution — dropping it makes text unreadable, which
    // is the whole point of sharing a screen.
    expect(applied.scrHint).toBe('detail');
    expect(applied.scrBitrate).toBe(1500000);
    expect(applied.scrDegradation).toBe('maintain-resolution');
    expect(applied.scrScale).toBeUndefined();
  });

  test('survives a sender with no setParameters support', async ({ page }) => {
    const threw = await page.evaluate(() => {
      try {
        tuneVideoSenders({ getSenders: () => [{ track: { kind: 'video' } }] }, 'camera');
        return false;
      } catch (_) {
        return true;
      }
    });
    expect(threw).toBe(false);
  });
});
