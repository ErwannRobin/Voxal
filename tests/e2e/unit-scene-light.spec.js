import { test, expect } from './fixtures.js';

// Settings → Video → Scene light: match my room (the camera's measured light,
// the default), a fixed time of day, the clock, or the screen's light or dark
// mode. Only the look's exposure and tint are chosen (VideoScenes.chosenLight),
// so the camera pipeline draws and OFFERS the chosen light, and the preview
// draws it too. See video-effects.js, "the scene's light".

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { window.__voxalSegStub = true; });
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.removeItem(VideoEffects.SCENE_LIGHT_KEY);
    window.__sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__waitFor = async (fn, ms) => {
      const end = Date.now() + ms;
      while (!fn() && Date.now() < end) await window.__sleep(50);
      return fn();
    };
  });
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => {
    try { VideoEffects.stop(); } catch (e) { /* none running */ }
    try { VideoEffects.writeSceneLight('auto'); } catch (e) { /* gone */ }
  });
});

test.describe('the lights', () => {
  test('five times of day, from bright to dark, each a colour of unit luma', async ({ page }) => {
    const seen = await page.evaluate(() => ['morning', 'midday', 'afternoon', 'evening', 'night'].map((id) => {
      const L = VideoScenes.chosenLight(id);
      return { id, exposure: L.exposure, luma: 0.2126 * L.tint[0] + 0.7152 * L.tint[1] + 0.0722 * L.tint[2], tint: L.tint };
    }));
    const by = Object.fromEntries(seen.map((s) => [s.id, s]));
    for (const s of seen) expect(s.luma).toBeCloseTo(1, 5);
    expect(by.midday.exposure).toBeGreaterThan(by.afternoon.exposure);
    expect(by.afternoon.exposure).toBeGreaterThan(by.evening.exposure);
    expect(by.evening.exposure).toBeGreaterThan(by.night.exposure);
    // The engine's evening: day above 0.62, fully night at 0.28 and below.
    expect(by.morning.exposure).toBeGreaterThan(0.62);
    expect(by.evening.exposure).toBeGreaterThan(0.28);
    expect(by.evening.exposure).toBeLessThan(0.62);
    expect(by.night.exposure).toBeLessThanOrEqual(0.28);
    // The afternoon and evening are warm, the night and morning cool.
    expect(by.afternoon.tint[0]).toBeGreaterThan(by.afternoon.tint[2]);
    expect(by.evening.tint[0]).toBeGreaterThan(by.evening.tint[2]);
    expect(by.night.tint[2]).toBeGreaterThan(by.night.tint[0]);
    expect(by.morning.tint[2]).toBeGreaterThan(by.morning.tint[0]);
  });

  test('the clock follows the day without a jump, and the screen follows light or dark mode', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const at = (h, m = 0) => { const d = new Date(2026, 5, 1, h, m); return VideoScenes.chosenLight('clock', d); };
      const named = (id) => VideoScenes.chosenLight(id);
      let maxStep = 0;
      for (let h = 0; h < 24; h += 0.05) {
        const a = VideoScenes.lightAtHour(h).exposure, b = VideoScenes.lightAtHour(h + 0.05).exposure;
        maxStep = Math.max(maxStep, Math.abs(Math.log(b / a)));
      }
      return {
        three: at(3).exposure, night: named('night').exposure,
        nine: at(9).exposure, morning: named('morning').exposure,
        one: at(13).exposure, midday: named('midday').exposure,
        dusk: at(20, 30).exposure, evening: named('evening').exposure,
        maxStep,
        names: [8.5, 13, 18, 20.5, 23].map((h) => VideoScenes.clockLightName(h)),
        dark: VideoScenes.chosenLight('screen', null, true).exposure,
        light: VideoScenes.chosenLight('screen', null, false).exposure,
        auto: VideoScenes.chosenLight('auto'),
      };
    });
    expect(seen.three).toBeCloseTo(seen.night, 5);
    expect(seen.nine).toBeCloseTo(seen.morning, 5);
    expect(seen.one).toBeCloseTo(seen.midday, 5);
    expect(seen.dusk).toBeLessThan(seen.evening);
    expect(seen.dusk).toBeGreaterThan(seen.night);
    // Three minutes of the clock never move the light by more than a few
    // percent: the scene eases into it anyway, but it should not need to.
    expect(seen.maxStep).toBeLessThan(0.06);
    expect(seen.names).toEqual(['morning', 'midday', 'afternoon>evening', 'evening>night', 'night']);
    expect(seen.dark).toBeCloseTo(seen.evening, 5);
    expect(seen.light).toBeCloseTo(seen.midday, 5);
    expect(seen.auto).toBeNull();
  });
});

test.describe('the setting', () => {
  test('a select in Settings → Video, stored as an absence for "match my room"', async ({ page }) => {
    await page.click('#btn-open-settings');
    await page.click('#modal-settings [data-target="settings-video"]');
    const sel = page.locator('#select-scene-light');
    await expect(sel).toBeVisible();
    await expect(sel).toHaveValue('auto');
    const options = await sel.locator('option').evaluateAll((os) => os.map((o) => [o.value, o.textContent]));
    expect(options.map((o) => o[0])).toEqual(['auto', 'morning', 'midday', 'afternoon', 'evening', 'night', 'clock', 'screen']);
    expect(options[0][1]).toBe('Match my room');

    await sel.selectOption('evening');
    expect(await page.evaluate(() => localStorage.getItem(VideoEffects.SCENE_LIGHT_KEY))).toBe('evening');
    expect(await page.evaluate(() => VideoEffects.sceneLight().exposure)).toBeCloseTo(0.42, 5);

    await sel.selectOption('clock');
    await expect(page.locator('#settings-scene-light .scene-light-now')).toContainText(/^Now \(\d\d:\d\d\): /);
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await sel.selectOption('screen');
    await expect(page.locator('#settings-scene-light .scene-light-now')).toHaveText('Now: dark mode, so the evening.');
    expect(await page.evaluate(() => VideoEffects.sceneLight().exposure)).toBeCloseTo(0.42, 5);
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await sel.selectOption('night');
    await sel.selectOption('screen');
    await expect(page.locator('#settings-scene-light .scene-light-now')).toHaveText('Now: light mode, so the middle of the day.');
    expect(await page.evaluate(() => VideoEffects.sceneLight().exposure)).toBeCloseTo(1.2, 5);

    await sel.selectOption('auto');
    expect(await page.evaluate(() => localStorage.getItem(VideoEffects.SCENE_LIGHT_KEY))).toBeNull();
    await expect(page.locator('#settings-scene-light .scene-light-now')).toBeHidden();
  });

  test('a change in the preferences window reaches this one through `storage`', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const before = VideoEffects.sceneLight();
      // What settings.html does in its own window: store, and this window
      // hears a storage event (never raised in the window that wrote it).
      localStorage.setItem(VideoEffects.SCENE_LIGHT_KEY, 'night');
      window.dispatchEvent(new StorageEvent('storage', { key: VideoEffects.SCENE_LIGHT_KEY, newValue: 'night' }));
      const after = VideoEffects.sceneLight();
      return { before, after: after && after.exposure, select: document.getElementById('select-scene-light').value };
    });
    expect(seen.before).toBeNull();
    expect(seen.after).toBeCloseTo(0.25, 5);
    expect(seen.select).toBe('night');
  });
});

test.describe('in the camera pipeline', () => {
  test('the chosen light is the look drawn and offered, taken whole before anything is measured', async ({ page }) => {
    test.setTimeout(90_000);
    const seen = await page.evaluate(async () => {
      VideoEffects.writeSceneLight('night');
      const c = document.createElement('canvas');
      c.width = 320; c.height = 240;
      const ctx = c.getContext('2d');
      const paint = () => { ctx.fillStyle = '#ddd'; ctx.fillRect(0, 0, 320, 240); };
      paint();
      const stream = c.captureStream(15);
      const timer = setInterval(paint, 66);
      stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
      const out = await VideoEffects.wrap(stream, 'preset:office');
      const p = VideoEffects.active();
      await window.__waitFor(() => p.sceneId === 'office', 60000);
      await window.__sleep(400);
      VideoEffects.keyedTrack(out);
      const night = { target: p.lookTarget.exposure, look: p.look.exposure, offered: p.keyedSnapshot().look.exposure };
      // Back to the room's own light: the next measurement takes over.
      VideoEffects.writeSceneLight('midday');
      await window.__sleep(2500);
      const midday = { target: p.lookTarget.exposure, look: p.look.exposure };
      return { night, midday };
    });
    expect(seen.night.target).toBeCloseTo(0.25, 5);
    expect(seen.night.look).toBeCloseTo(0.25, 2);
    expect(seen.night.offered).toBeCloseTo(0.25, 3);
    expect(seen.midday.target).toBeCloseTo(1.2, 5);
    // Eased toward it, not jumped: a change mid-call fades like any light.
    expect(seen.midday.look).toBeGreaterThan(0.6);
  });
});

test.describe('in the preview', () => {
  test('the preview is drawn in the chosen light, and the full window can change it', async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(() => { window.__voxalThumbsOnSoftwareGL = true; });
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem(VideoEffects.STORAGE_KEY, 'preset:mountain');
      document.body.insertAdjacentHTML('beforeend', '<div id="pv" style="position:fixed;left:10px;top:10px;width:480px"></div>');
      window.__pv = VideoEffects.renderScenePreview(document.getElementById('pv'));
    });
    await expect(page.locator('#pv .scene-preview-note')).toBeHidden({ timeout: 60_000 });
    // What is on screen (the WebGL canvas keeps no drawing buffer to read).
    const luma = async () => {
      const b64 = (await page.locator('#pv canvas').screenshot()).toString('base64');
      return page.evaluate(async (data) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + data;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = 64; c.height = 36;
        const x = c.getContext('2d');
        x.drawImage(img, 0, 0, 64, 36);
        const d = x.getImageData(0, 0, 64, 36).data;
        let s = 0;
        for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        return s / (d.length / 4);
      }, b64);
    };
    await page.waitForTimeout(500);
    const day = await luma();
    await page.evaluate(() => VideoEffects.writeSceneLight('night'));
    await expect.poll(luma, { timeout: 30_000 }).toBeLessThan(day * 0.7);

    await page.locator('#pv .scene-preview-full').click();
    const stage = page.locator('body > .scene-preview-stage.is-full');
    const sel = stage.locator('.scene-preview-light select');
    await expect(sel).toBeVisible();
    await expect(sel).toHaveValue('night');
    await sel.selectOption('midday');
    expect(await page.evaluate(() => VideoEffects.readSceneLight())).toBe('midday');
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__pv.destroy());
  });
});
