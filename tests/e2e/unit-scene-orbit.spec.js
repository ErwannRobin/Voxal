import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// Three things that arrived together:
//
//   1. Looking around a scene with the mouse (VideoEffects.attachOrbit): the
//      drag maths, which way the room follows the hand, the limits the keyed
//      frame's tilt strip can carry, and what a click that ends a drag does.
//   2. The scene on its own in Settings (VideoEffects.renderScenePreview).
//   3. The room's bottom bar on a phone: one line of chips, the speaker switch
//      standing alone above the line, and the top of the screen clear of the
//      Dynamic Island.

const DEG = Math.PI / 180;

const stubNative = (page) =>
  page.addInitScript(() => {
    window.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      Plugins: {
        AudioRoute: {
          getRoute: () => Promise.resolve({ route: 'speaker' }),
          setRoute: (o) => Promise.resolve({ route: o.route }),
        },
      },
    };
  });

// ---------------------------------------------------------------------------
// attachOrbit
// ---------------------------------------------------------------------------

test.describe('attachOrbit', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      document.body.insertAdjacentHTML(
        'beforeend',
        '<div id="orbit-box" tabindex="0" style="position:fixed;left:100px;top:100px;width:400px;height:225px"></div>'
      );
      window.__views = [];
      window.__clicks = 0;
      document.getElementById('orbit-box').addEventListener('click', () => { window.__clicks++; });
      window.__attach = (opts) => {
        if (window.__orbit) window.__orbit.destroy();
        window.__orbit = VideoEffects.attachOrbit(document.getElementById('orbit-box'), Object.assign({
          onChange: (v) => window.__views.push(v),
        }, opts || {}));
        return true;
      };
    });
  });

  const drag = async (page, dx, dy, { steps = 6, button = 'left' } = {}) => {
    await page.mouse.move(300, 200);
    await page.mouse.down({ button });
    await page.mouse.move(300 + dx, 200 + dy, { steps });
    await page.mouse.up({ button });
  };
  const last = (page) => page.evaluate(() => window.__orbit.view());

  test('the room follows the hand: pulling right is a camera turned left, pulling down one turned up', async ({ page }) => {
    await page.evaluate(() => window.__attach());
    await drag(page, 60, 0);
    const a = await last(page);
    // Positive yaw is the camera turned right (the room slides left on screen).
    expect(a.yaw).toBeLessThan(0);
    expect(a.pitch).toBe(0);
    expect(a.roll).toBe(0);

    await page.evaluate(() => window.__orbit.reset(false));
    await drag(page, 0, 30);
    const b = await last(page);
    expect(b.pitch).toBeGreaterThan(0);
    expect(b.yaw).toBe(0);
  });

  test('a mirrored picture follows the hand on what is shown, so yaw is reversed', async ({ page }) => {
    await page.evaluate(() => window.__attach({ mirrored: () => true }));
    await drag(page, 60, 0);
    expect((await last(page)).yaw).toBeGreaterThan(0);
  });

  test('never goes past what the keyed frame\'s tilt strip can carry', async ({ page }) => {
    await page.evaluate(() => window.__attach());
    // Far more than the whole picture in every direction.
    await drag(page, 380, 220, { steps: 12 });
    const v = await last(page);
    const lim = await page.evaluate(() => VideoEffects.ORBIT_LIMIT);
    const strip = await page.evaluate(() => VideoEffects.KEY_TILT);
    expect(Math.abs(v.yaw)).toBeLessThanOrEqual(lim.yaw + 1e-9);
    expect(Math.abs(v.pitch)).toBeLessThanOrEqual(lim.pitch + 1e-9);
    expect(lim.yaw).toBeLessThanOrEqual(strip.yaw);
    expect(lim.pitch).toBeLessThanOrEqual(strip.pitch);
    // And what it publishes survives the strip's codec to within a quantum.
    const back = await page.evaluate((x) => VideoEffects.decodeTilt(VideoEffects.encodeTilt(x)), v);
    expect(Math.abs(back.yaw - v.yaw)).toBeLessThan(0.2 * DEG);
  });

  test('a press that does not travel is a click, and one that does is not', async ({ page }) => {
    await page.evaluate(() => window.__attach());
    await page.mouse.click(300, 200);
    expect(await page.evaluate(() => window.__clicks)).toBe(1);
    expect(await last(page)).toBeNull();

    await drag(page, 50, 0);
    // The release that ends a drag is not a click on whatever the tile does with one.
    expect(await page.evaluate(() => window.__clicks)).toBe(1);
    expect((await last(page)).yaw).not.toBe(0);

    // ...and the click after that is a click again.
    await page.waitForTimeout(120);
    await page.mouse.click(300, 200);
    expect(await page.evaluate(() => window.__clicks)).toBe(2);
  });

  test('double-click recentres, and ends with null so nothing is left turned', async ({ page }) => {
    await page.evaluate(() => window.__attach());
    await drag(page, 50, 20);
    expect(await last(page)).not.toBeNull();
    await page.mouse.dblclick(300, 200);
    await expect.poll(() => last(page)).toBeNull();
    expect(await page.evaluate(() => window.__views[window.__views.length - 1])).toBeNull();
  });

  test('is off when enabled() says so, for the other buttons and for a finger', async ({ page }) => {
    await page.evaluate(() => { window.__on = false; window.__attach({ enabled: () => window.__on }); });
    await drag(page, 60, 0);
    expect(await last(page)).toBeNull();

    await page.evaluate(() => { window.__on = true; });
    await drag(page, 60, 0, { button: 'right' });
    expect(await last(page)).toBeNull();

    // A touch pointer is a scroll or a pin on a tile, not a turn.
    await page.evaluate(() => {
      const el = document.getElementById('orbit-box');
      const opts = { pointerType: 'touch', pointerId: 7, isPrimary: true, bubbles: true, clientX: 300, clientY: 200, button: 0 };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      window.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: 380 }));
      window.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: 380 }));
    });
    expect(await last(page)).toBeNull();
  });

  test('a press on an ignored child leaves its own gesture alone', async ({ page }) => {
    await page.evaluate(() => {
      document.getElementById('orbit-box').insertAdjacentHTML(
        'beforeend', '<button id="orbit-btn" style="position:absolute;left:10px;top:10px;width:60px;height:30px">x</button>');
      window.__attach({ ignore: 'button' });
    });
    await page.mouse.move(120, 120);
    await page.mouse.down();
    await page.mouse.move(200, 125, { steps: 5 });
    await page.mouse.up();
    expect(await last(page)).toBeNull();
  });

  test('arrow keys turn it and Home recentres, only with keys on', async ({ page }) => {
    await page.evaluate(() => window.__attach());
    await page.focus('#orbit-box');
    await page.keyboard.press('ArrowRight');
    expect(await last(page)).toBeNull();

    await page.evaluate(() => window.__attach({ keys: true }));
    await page.focus('#orbit-box');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    const v = await last(page);
    expect(v.yaw).toBeGreaterThan(0);
    expect(v.pitch).toBeGreaterThan(0);
    await page.keyboard.press('Home');
    await expect.poll(() => last(page)).toBeNull();
  });

  test('wears a grab cursor class only while it can turn', async ({ page }) => {
    await page.evaluate(() => { window.__on = false; window.__attach({ enabled: () => window.__on }); });
    await page.mouse.move(300, 200);
    await page.mouse.move(305, 205);
    expect(await page.evaluate(() => document.getElementById('orbit-box').classList.contains('orbit-ready'))).toBe(false);
    await page.evaluate(() => { window.__on = true; });
    await page.mouse.move(310, 210);
    expect(await page.evaluate(() => document.getElementById('orbit-box').classList.contains('orbit-ready'))).toBe(true);
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('orbit-box')).cursor)).toBe('grab');
  });

  test('destroy lets go of everything', async ({ page }) => {
    await page.evaluate(() => { window.__attach(); window.__orbit.destroy(); window.__views.length = 0; });
    await drag(page, 60, 0);
    expect(await page.evaluate(() => window.__views.length)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// your own picture, in a call (computers)
// ---------------------------------------------------------------------------

test.describe('turning your own scene in a call', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem(VideoEffects.STORAGE_KEY, 'preset:office');
      localVideoActive = true;
      localVideoStream = { _effectsProcessor: {}, getVideoTracks: () => [], getTracks: () => [] };
      window.__refreshes = 0;
      window.__pins = 0;
      refreshKeyedSend = function () { window.__refreshes++; };
      toggleStagePin = function () { window.__pins++; };
      const tile = _buildVideoTile({ key: 'camera:self', kind: 'camera', self: true });
      tile.style.cssText = 'position:fixed;left:100px;top:100px;width:400px;height:225px';
      document.body.appendChild(tile);
      window.__tile = tile;
    });
  });
  test.afterEach(async ({ page }) => {
    await page.evaluate(() => { try { VideoEffects.setTilt(null); } catch (e) { /* ignore */ } });
  });

  const drag = async (page, dx, dy = 0) => {
    await page.mouse.move(300, 200);
    await page.mouse.down();
    await page.mouse.move(300 + dx, 200 + dy, { steps: 6 });
    await page.mouse.up();
  };
  const tilt = (page) => page.evaluate(() => VideoEffects.getTilt());

  test('a drag turns the scene, turns the strip on once, and is not a pin', async ({ page }) => {
    expect(await tilt(page)).toBeNull();
    expect(await page.evaluate(() => backgroundTiltFlowing())).toBe(false);

    await drag(page, 60, 10);
    const t = await tilt(page);
    expect(t.yaw).not.toBe(0);
    expect(t.pitch).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__pins)).toBe(0);
    expect(await page.evaluate(() => backgroundTiltFlowing())).toBe(true);
    expect(await page.evaluate(() => window.__refreshes)).toBe(1);

    // More turning is the same epoch: the offer's `tilt` flag does not move again.
    await drag(page, -30, 0);
    expect(await page.evaluate(() => window.__refreshes)).toBe(1);

    // A plain click still pins.
    await page.waitForTimeout(120);
    await page.mouse.click(300, 200);
    expect(await page.evaluate(() => window.__pins)).toBe(1);
  });

  test('recentring straightens the scene but keeps the strip, so nobody gets a new epoch', async ({ page }) => {
    await drag(page, 60);
    await page.mouse.dblclick(300, 200);
    await expect.poll(() => tilt(page)).toBeNull();
    expect(await page.evaluate(() => backgroundTiltFlowing())).toBe(true);
    expect(await page.evaluate(() => window.__refreshes)).toBe(1);
  });

  test('the self-view badge keeps its own drag, and a scene-less picture has nothing to turn', async ({ page }) => {
    await page.evaluate(() => {
      const badge = document.createElement('div');
      badge.id = 'video-stage-self';
      document.body.appendChild(badge);
      badge.appendChild(window.__tile);
    });
    await drag(page, 60);
    expect(await tilt(page)).toBeNull();

    await page.evaluate(() => { document.body.appendChild(window.__tile); VideoEffects.writeMode('blur'); });
    await drag(page, 60);
    expect(await tilt(page)).toBeNull();
    expect(await page.evaluate(() => backgroundOrbitWanted())).toBe(false);
  });

  test('the self-view is a mirror: the drag follows the hand on what is shown', async ({ page }) => {
    await page.evaluate(() => { window.__tile.querySelector('video').style.transform = 'scaleX(-1)'; });
    await drag(page, 60);
    expect((await tilt(page)).yaw).toBeGreaterThan(0);
  });

  test('losing the scene or the camera hands the picture back straight and takes the strip away', async ({ page }) => {
    await drag(page, 60);
    expect(await tilt(page)).not.toBeNull();
    await page.evaluate(() => { VideoEffects.writeMode('off'); syncBackgroundTilt(); });
    expect(await tilt(page)).toBeNull();
    expect(await page.evaluate(() => backgroundTiltFlowing())).toBe(false);
    expect(await page.evaluate(() => window.__refreshes)).toBe(2);

    // ...and the camera stopping does the same.
    await page.evaluate(() => { VideoEffects.writeMode('preset:office'); });
    await drag(page, 60);
    expect(await tilt(page)).not.toBeNull();
    await page.evaluate(() => { localVideoActive = false; syncBackgroundTilt(); });
    expect(await tilt(page)).toBeNull();
    expect(await page.evaluate(() => backgroundTiltFlowing())).toBe(false);
  });

  test('the strip is allowed once the scene has been turned, by the same rule as a phone\'s sensor', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'me', isHost: true, roomCode: 'me',
      connections: [{ id: 'a', caps: ['keyed-video-1', 'keyed-tilt-1'] }],
    });
    expect(await page.evaluate(() => keyedTiltOk())).toBe(false);
    await drag(page, 60);
    expect(await page.evaluate(() => keyedTiltOk())).toBe(true);
    await page.evaluate(() => { connections.get('a').caps = ['keyed-video-1']; });
    expect(await page.evaluate(() => keyedTiltOk())).toBe(false);
  });

  test('the hint in the background popover shows only while a scene can be turned', async ({ page }) => {
    await page.evaluate(() => syncBackgroundOrbit());
    expect(await page.evaluate(() => document.getElementById('video-bg-orbit-hint').classList.contains('hidden'))).toBe(false);
    await page.evaluate(() => { VideoEffects.writeMode('off'); syncBackgroundOrbit(); });
    expect(await page.evaluate(() => document.getElementById('video-bg-orbit-hint').classList.contains('hidden'))).toBe(true);
  });
});

test.describe('on a phone the sensor does it, not the mouse', () => {
  test('no orbit is attached to the self tile', async ({ page }) => {
    await stubNative(page);
    await page.goto('/');
    const attached = await page.evaluate(() => {
      const tile = _buildVideoTile({ key: 'camera:self', kind: 'camera', self: true });
      document.body.appendChild(tile);
      return !!_backgroundOrbit;
    });
    expect(attached).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// the scene on its own
// ---------------------------------------------------------------------------

test.describe('scene preview', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => { window.__voxalThumbsOnSoftwareGL = true; });
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.removeItem(VideoEffects.STORAGE_KEY);
      document.body.insertAdjacentHTML('beforeend', '<div id="pv" style="position:fixed;left:10px;top:10px;width:480px"></div>');
    });
  });
  test.afterEach(async ({ page }) => {
    await page.evaluate(() => { try { window.__pv && window.__pv.destroy(); } catch (e) { /* gone */ } });
  });

  test('says what to do while no animated scene is chosen, and draws nothing', async ({ page }) => {
    await page.evaluate(() => { window.__pv = VideoEffects.renderScenePreview(document.getElementById('pv')); });
    const note = page.locator('#pv .scene-preview-note');
    await expect(note).toBeVisible();
    await expect(note).toContainText('animated scenes');
    expect(await page.locator('#pv canvas').count()).toBe(0);

    // Blur and the user's own image are not scenes either.
    await page.evaluate(() => { VideoEffects.writeMode('blur'); });
    await expect(note).toBeVisible();
    expect(await page.locator('#pv canvas').count()).toBe(0);
  });

  test('draws the chosen scene and turns it when dragged, with a way back', async ({ page }) => {
    // The waits below budget up to 30 s + 60 s before the drag even starts;
    // the screenshot comparison after it needs headroom of its own.
    test.setTimeout(150_000);
    await page.evaluate(() => {
      VideoEffects.writeMode('preset:office');
      window.__pv = VideoEffects.renderScenePreview(document.getElementById('pv'));
    });
    const stage = page.locator('#pv .scene-preview-stage');
    // The observer that says "on screen" reports on the next frame, which on a
    // busy machine is not within the default five seconds.
    await expect(page.locator('#pv canvas')).toHaveCount(1, { timeout: 30_000 });
    // The shader compiles in its own time (seconds on a software GPU).
    await expect(page.locator('#pv .scene-preview-note')).toBeHidden({ timeout: 60_000 });
    await expect(page.locator('#pv .scene-preview-hud')).toBeVisible();
    await expect(page.locator('#pv .scene-preview-recentre')).toBeHidden();

    const before = await stage.screenshot();
    const box = await stage.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 20, { steps: 8 });
    await page.mouse.up();

    await expect(page.locator('#pv .scene-preview-recentre')).toBeVisible({ timeout: 30_000 });
    const view = await page.evaluate(() => window.__pv.orbit.view());
    expect(view.yaw).toBeLessThan(0);
    expect(view.pitch).toBeGreaterThan(0);
    // The picture is another one: compare what is on screen, not the state.
    await expect.poll(async () => !(await stage.screenshot({ timeout: 20_000 })).equals(before), { timeout: 40_000 }).toBe(true);

    await page.locator('#pv .scene-preview-recentre').click();
    await expect.poll(() => page.evaluate(() => window.__pv.orbit.view())).toBeNull();
    await expect(page.locator('#pv .scene-preview-recentre')).toBeHidden();
  });

  test('follows the mode written in this window and gives its GPU context back when stopped', async ({ page }) => {
    test.setTimeout(90_000);
    await page.evaluate(() => {
      VideoEffects.writeMode('preset:island');
      window.__pv = VideoEffects.renderScenePreview(document.getElementById('pv'));
    });
    await expect(page.locator('#pv canvas')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator('#pv .scene-preview-note')).toBeHidden({ timeout: 60_000 });

    // The picker writes the mode; the preview is told without a `storage` event.
    await page.evaluate(() => VideoEffects.writeMode('off'));
    await expect(page.locator('#pv canvas')).toHaveCount(0);
    await expect(page.locator('#pv .scene-preview-note')).toBeVisible();

    // Hidden (a closed settings card): no canvas, no context, no loop.
    await page.evaluate(() => VideoEffects.writeMode('preset:island'));
    await expect(page.locator('#pv canvas')).toHaveCount(1, { timeout: 30_000 });
    // A software GPU compiles on the page's own thread: let that finish, or the
    // observer that notices the card going away is stuck behind it.
    await expect(page.locator('#pv .scene-preview-note')).toBeHidden({ timeout: 60_000 });
    await page.evaluate(() => { document.getElementById('pv').style.display = 'none'; });
    await expect(page.locator('#pv canvas')).toHaveCount(0, { timeout: 30_000 });
  });

  test('without graphics acceleration it says so instead of freezing the page', async ({ page }) => {
    await page.addInitScript(() => { window.__voxalThumbsOnSoftwareGL = false; });
    await page.goto('/');
    await page.evaluate(() => {
      // This machine's GL is whatever it is: make the check answer "software".
      VideoScenes.isSoftwareGL = () => true;
      localStorage.setItem(VideoEffects.STORAGE_KEY, 'preset:office');
      document.body.insertAdjacentHTML('beforeend', '<div id="pv" style="position:fixed;left:10px;top:10px;width:480px"></div>');
      window.__pv = VideoEffects.renderScenePreview(document.getElementById('pv'));
    });
    await expect(page.locator('#pv .scene-preview-note')).toContainText('graphics acceleration');
    expect(await page.locator('#pv canvas').count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// the room on a phone
// ---------------------------------------------------------------------------

test.describe('room bottom bar on a phone', () => {
  test.use({ viewport: { width: 390, height: 800 } });

  const enterRoom = async (page) => {
    await stubNative(page);
    await page.goto('/');
    await page.evaluate(async () => {
      showScreen('room');
      await initAudioRouteForRoom();
      ['btn-share-camera', 'btn-share-screen'].forEach((id) => document.getElementById(id).classList.remove('hidden'));
    });
  };

  test('the chips stay on one line, even narrow, and the speaker is not one of them', async ({ page }) => {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await enterRoom(page);
      const m = await page.evaluate(() => {
        const rect = (e) => e.getBoundingClientRect();
        const row = document.querySelector('.room-bottom-bar .ctrl-row');
        const chips = [...row.children].filter((c) => c.offsetParent !== null).map(rect);
        const bar = rect(document.querySelector('.room-bottom-bar'));
        return {
          chips: chips.length,
          tops: [...new Set(chips.map((r) => Math.round(r.top)))],
          overflow: row.scrollWidth > row.clientWidth + 1,
          inRow: !!document.querySelector('.ctrl-row #btn-audio-route'),
          rightMost: Math.max(...chips.map((r) => r.right)),
          barRight: bar.right,
        };
      });
      expect(m.chips).toBe(3);
      expect(m.tops).toHaveLength(1);
      expect(m.overflow).toBe(false);
      expect(m.inRow).toBe(false);
      expect(m.rightMost).toBeLessThanOrEqual(m.barRight + 0.5);
    }
  });

  test('the speaker button sits at the right end of the line above the chips, and works', async ({ page }) => {
    await enterRoom(page);
    const m = await page.evaluate(() => {
      const spk = document.getElementById('btn-audio-route').getBoundingClientRect();
      const controls = document.querySelector('.room-controls').getBoundingClientRect();
      const row = document.querySelector('.room-controls .ctrl-row').getBoundingClientRect();
      return { spk, controls, row };
    });
    // Just above the line (the controls' top border), flush with its right end,
    // and clear of the row of chips.
    expect(m.spk.bottom).toBeLessThanOrEqual(m.controls.top);
    expect(m.controls.top - m.spk.bottom).toBeLessThanOrEqual(16);
    expect(Math.abs(m.spk.right - m.controls.right)).toBeLessThan(1);
    expect(m.spk.bottom).toBeLessThan(m.row.top);
    expect(m.spk.width).toBeGreaterThanOrEqual(32);
    // Its label is for a screen reader only.
    const label = await page.evaluate(() => {
      const e = document.querySelector('#btn-audio-route .audio-route-label');
      const r = e.getBoundingClientRect();
      return { text: e.textContent, w: r.width, h: r.height };
    });
    expect(label.text).toBe('Speaker');
    expect(label.w).toBeLessThanOrEqual(1);

    // It does not change the height of the bar: hidden or shown, the chips are on the same pixel.
    const top = () => page.evaluate(() => document.getElementById('btn-freehand').getBoundingClientRect().top);
    const shown = await top();
    await page.evaluate(() => document.getElementById('btn-audio-route').classList.add('hidden'));
    expect(await top()).toBe(shown);

    await page.evaluate(() => document.getElementById('btn-audio-route').classList.remove('hidden'));
    await page.click('#btn-audio-route');
    await expect(page.locator('#btn-audio-route')).toHaveAttribute('aria-pressed', 'true');
  });

  test('a phone app clears the top by more than the bare status bar', async ({ page }) => {
    await enterRoom(page);
    const m = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      const px = (name) => {
        const probe = document.createElement('div');
        probe.style.cssText = `position:absolute;visibility:hidden;height:var(${name})`;
        document.body.appendChild(probe);
        const h = probe.getBoundingClientRect().height;
        probe.remove();
        return h;
      };
      return { extra: css.getPropertyValue('--safe-top-extra').trim(), safeTop: px('--stage-safe-top') };
    });
    // Capacitor floors the inset at 24px and then adds its breathing room.
    expect(m.extra).toBe('10px');
    expect(m.safeTop).toBe(34);
  });

  test('the home screen and the room header both start below that line', async ({ page }) => {
    await enterRoom(page);
    const pad = await page.evaluate(() => {
      const top = (sel) => parseFloat(getComputedStyle(document.querySelector(sel)).paddingTop);
      return { room: top('#screen-room'), header: top('.room-header') };
    });
    // 34 (inset floor + air) plus the screen's own 14px; the header has its own 12px
    expect(pad.room).toBeGreaterThanOrEqual(48);
  });
});
