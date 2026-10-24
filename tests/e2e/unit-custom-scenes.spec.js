import { test, expect } from './fixtures.js';
import { buildGlb } from '../../scripts/custom-scene-sample.mjs';

// Scenes people add themselves (Settings → Video → the cube chip): a 360°
// panorama or a 3D model (.glb), stored on this device, drawn by the scene
// engine from src/scenes/custom.js, never offered to a keyed peer. See
// docs/custom-scenes.md.

const GLB = Buffer.from(buildGlb()).toString('base64');
const GLB_BARE = Buffer.from(buildGlb({ camera: false, light: false, animation: false })).toString('base64');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { window.__voxalSegStub = true; });
  await page.goto('/');
  await page.evaluate(async () => {
    localStorage.removeItem('custom-scenes');
    localStorage.removeItem(VideoEffects.STORAGE_KEY);
    window.__sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__waitFor = async (fn, ms) => {
      const end = Date.now() + ms;
      while (!fn() && Date.now() < end) await window.__sleep(50);
      return fn();
    };
    // A 2:1 panorama with a marker at each quarter: green straight ahead
    // (u = 0.5), blue at u = 0.75 (90° to the right), red at u = 0.25 (90° to
    // the left); sky above the horizon, grass below.
    window.__panorama = async (w = 1024, h = 512, name = 'my-lake_panorama.jpg') => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const x = c.getContext('2d');
      x.fillStyle = '#b8cde6'; x.fillRect(0, 0, w, h / 2);
      x.fillStyle = '#5e6e3e'; x.fillRect(0, h / 2, w, h / 2);
      const bar = (u, col) => { x.fillStyle = col; x.fillRect(u * w - w * 0.03, h * 0.2, w * 0.06, h * 0.6); };
      bar(0.5, '#00ff00'); bar(0.75, '#0000ff'); bar(0.25, '#ff0000');
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      return new File([blob], name, { type: 'image/png' });
    };
    window.__file = (b64, name) => new File([Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))], name);
    // Draw a scene once at w x h and hand back its pixels (bottom row first).
    window.__draw = async (id, { w = 160, h = 90, t = 37, view = null } = {}) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const gl = c.getContext('webgl2', { alpha: false, preserveDrawingBuffer: true });
      const r = await VideoScenes.createRenderer(gl, id, { quality: 'full' });
      const look = VideoScenes.defaultLook();
      look.cx = 0.5; look.cy = 3; look.sx = 0.01; look.sy = 0.01;
      r.draw(null, w, h, t, look, null, view);
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      r.dispose();
      VideoScenes.releaseContext(gl);
      gl.getExtension('WEBGL_lose_context').loseContext();
      return { w, h, px: Array.from(px) };
    };
    window.__at = (img, x, y) => { const i = ((img.h - 1 - y) * img.w + x) * 4; return img.px.slice(i, i + 3); };
  });
});

test.afterEach(async ({ page }) => {
  await page.evaluate(async () => {
    try { VideoEffects.stop(); } catch (e) { /* none running */ }
    for (const m of VideoScenes.customScenes()) await VideoEffects.removeCustomScene(m.id);
  });
});

test.describe('adding a scene', () => {
  test('a 2:1 picture becomes a panorama scene: stored, listed, named, with a thumbnail', async ({ page }) => {
    test.setTimeout(90_000);
    const seen = await page.evaluate(async () => {
      const meta = await VideoEffects.addCustomScene(await window.__panorama());
      const entry = VideoScenes.byId(meta.id);
      return {
        meta: { kind: meta.kind, name: meta.name, id: meta.id, thumb: /^data:image\/jpeg;base64,/.test(meta.thumb) },
        listed: VideoScenes.customScenes().map((m) => m.id),
        entry: { custom: entry.custom, mirror: entry.mirror, kbps: entry.kbps, label: entry.label, name: entry.name },
        resolves: VideoScenes.resolveId(meta.id) === meta.id,
        mode: VideoEffects.normalizeMode('preset:' + meta.id) === 'preset:' + meta.id,
        stored: localStorage.getItem('custom-scenes').length > 0
      };
    });
    expect(seen.meta).toMatchObject({ kind: 'panorama', name: 'my lake panorama', thumb: true });
    expect(seen.meta.id).toMatch(/^u-[0-9a-f]{8}$/);
    expect(seen.listed).toEqual([seen.meta.id]);
    expect(seen.entry).toEqual({ custom: true, mirror: false, kbps: null, label: '360° panorama', name: 'my lake panorama' });
    expect(seen.resolves).toBe(true);
    expect(seen.mode).toBe(true);
    expect(seen.stored).toBe(true);
  });

  test('the panorama is the right way round and up: straight ahead is its middle, its right is on the right', async ({ page }) => {
    test.setTimeout(90_000);
    const seen = await page.evaluate(async () => {
      const meta = await VideoEffects.addCustomScene(await window.__panorama());
      const ahead = await window.__draw(meta.id);
      await VideoEffects.updateCustomScene(meta.id, { options: { yaw: 90 } });
      const right = await window.__draw(meta.id);
      await VideoEffects.updateCustomScene(meta.id, { options: { yaw: -90 } });
      const left = await window.__draw(meta.id);
      return {
        ahead: window.__at(ahead, 80, 45), right: window.__at(right, 80, 45), left: window.__at(left, 80, 45),
        top: window.__at(ahead, 20, 5), bottom: window.__at(ahead, 20, 85)
      };
    });
    const dominant = (c) => ['r', 'g', 'b'][c.indexOf(Math.max(...c))];
    expect(dominant(seen.ahead)).toBe('g');
    expect(dominant(seen.right)).toBe('b');
    expect(dominant(seen.left)).toBe('r');
    // Sky above (light, blue-ish), grass below (darker, green-ish).
    expect(seen.top[2]).toBeGreaterThan(seen.top[1] - 30);
    expect(seen.top.reduce((a, b) => a + b)).toBeGreaterThan(seen.bottom.reduce((a, b) => a + b));
  });

  // "Keep this view" in the preview stores the turn as the panorama's own
  // yaw and pitch: drawn straight, it must show what the turn showed.
  test('a view kept as the panorama\'s own draws what the turn drew', async ({ page }) => {
    test.setTimeout(90_000);
    const seen = await page.evaluate(async () => {
      const meta = await VideoEffects.addCustomScene(await window.__panorama());
      const horizon = (img) => {
        // The first row from the top whose middle is grass-dark.
        for (let y = 0; y < img.h; y++) { const c = window.__at(img, 20, y); if (c[0] + c[1] + c[2] < 400) return y; }
        return img.h;
      };
      const turned = await window.__draw(meta.id, { view: { yaw: 0.3, pitch: 0.15, roll: 0 } });
      const deg = 180 / Math.PI;
      // What the preview's Keep this view writes for that turn.
      await VideoEffects.updateCustomScene(meta.id, { options: { yaw: -0.3 * deg, pitch: -0.15 * deg } });
      const kept = await window.__draw(meta.id);
      let diff = 0;
      for (let i = 0; i < kept.px.length; i += 4) diff += Math.abs(kept.px[i] - turned.px[i]) + Math.abs(kept.px[i + 1] - turned.px[i + 1]) + Math.abs(kept.px[i + 2] - turned.px[i + 2]);
      return { turned: horizon(turned), kept: horizon(kept), straight: horizon(await window.__draw(meta.id, { view: null })), mean: diff / (kept.px.length / 4) };
    });
    expect(Math.abs(seen.kept - seen.turned)).toBeLessThanOrEqual(2);
    expect(seen.mean).toBeLessThan(20);
  });

  test('a model is drawn through its own camera, its animation runs on the scene clock, and without a camera it is framed whole', async ({ page }) => {
    test.setTimeout(120_000);
    const seen = await page.evaluate(async ({ glb, bare }) => {
      const m = await VideoEffects.addCustomScene(window.__file(glb, 'sample room.glb'));
      const a = await window.__draw(m.id, { t: 0 });
      const b = await window.__draw(m.id, { t: 3 });
      let diff = 0;
      for (let i = 0; i < a.px.length; i += 4) diff += Math.abs(a.px[i] - b.px[i]) + Math.abs(a.px[i + 1] - b.px[i + 1]) + Math.abs(a.px[i + 2] - b.px[i + 2]);
      const n = await VideoEffects.addCustomScene(window.__file(bare, 'bare.glb'));
      const c = await window.__draw(n.id);
      let lit = 0;
      for (let i = 0; i < c.px.length; i += 4) if (c.px[i] + c.px[i + 1] + c.px[i + 2] > 60) lit++;
      return { kind: m.kind, label: VideoScenes.byId(m.id).label, wall: window.__at(a, 80, 30), moved: diff, bareLit: lit / (c.px.length / 4) };
    }, { glb: GLB, bare: GLB_BARE });
    expect(seen.kind).toBe('model');
    expect(seen.label).toBe('3D model');
    // Through the file's camera: the plaster back wall fills the middle.
    expect(Math.min(...seen.wall)).toBeGreaterThan(60);
    // The cube turned between t = 0 and t = 3.
    expect(seen.moved).toBeGreaterThan(500);
    // Lit by the sky and sun Voxal adds when a file brings no lights.
    expect(seen.bareLit).toBeGreaterThan(0.3);
  });

  test('a file that is not a panorama or a glTF binary is refused, and nothing is kept', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      const codes = [];
      const flat = await window.__panorama(800, 600, 'flat.png');
      try { await VideoEffects.addCustomScene(flat); } catch (e) { codes.push(e.code); }
      try { await VideoEffects.addCustomScene(new File([new Uint8Array([1, 2, 3, 4, 5])], 'nope.glb')); } catch (e) { codes.push(e.code); }
      try { await VideoEffects.addCustomScene(new File(['not a picture'], 'nope.png', { type: 'image/png' })); } catch (e) { codes.push(e.code); }
      return { codes, listed: VideoScenes.customScenes().length };
    });
    expect(seen.codes).toEqual(['not-panorama', 'not-glb', 'unreadable']);
    expect(seen.listed).toBe(0);
  });
});

test.describe('in the picker', () => {
  test('the cube chip adds one, its chip picks it, the ✕ removes it and falls back to blur', async ({ page }) => {
    test.setTimeout(90_000);
    await page.click('#btn-open-settings');
    await page.click('#modal-settings [data-target="settings-video"]');
    const add = page.locator('#settings-bg-picker .bg-chip-add-scene');
    await expect(add).toBeVisible();
    // The room's popover only picks: adding is a Settings thing.
    expect(await page.locator('#video-bg-picker .bg-chip-add-scene').count()).toBe(0);

    const png = await page.evaluate(async () => {
      const f = await window.__panorama();
      const b = new Uint8Array(await f.arrayBuffer());
      let s = '';
      for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
      return btoa(s);
    });
    await page.locator('#settings-bg-picker .bg-scene-input').setInputFiles({ name: 'beach.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    const own = page.locator('#settings-bg-picker .bg-chip-own');
    await expect(own).toHaveCount(1, { timeout: 60_000 });
    await expect(own).toHaveAttribute('aria-label', 'beach');
    await expect(own).toHaveAttribute('aria-checked', 'true');
    const id = await own.getAttribute('data-scene');
    expect(await page.evaluate(() => localStorage.getItem(VideoEffects.STORAGE_KEY))).toBe('preset:' + id);
    // The other picker on the page (the room's popover) shows it too.
    await expect(page.locator('#video-bg-picker .bg-chip-own')).toHaveCount(1);
    // The preview says what it is.
    await expect(page.locator('#settings-bg-preview .scene-preview-name')).toHaveText('beach');
    await expect(page.locator('#settings-bg-preview .scene-cost-upload dd')).toHaveText('not measured: it depends on your file');

    await page.locator('#settings-bg-picker .bg-chip-own + .bg-chip-clear').click();
    await expect(own).toHaveCount(0);
    // Once the stored file is gone, the background falls back to blur.
    await expect.poll(() => page.evaluate(() => VideoEffects.readMode())).toBe('blur');
    const gone = await page.evaluate((sid) => new Promise((resolve) => {
      const req = indexedDB.open('voxal-bg', 1);
      req.onsuccess = () => {
        const g = req.result.transaction('images').objectStore('images').get('scene:' + sid);
        g.onsuccess = () => { resolve(g.result === undefined); req.result.close(); };
      };
    }), id);
    expect(gone).toBe(true);
  });

  test('a scene added in the preferences window appears here through `storage`, and survives a reload', async ({ page }) => {
    test.setTimeout(90_000);
    const id = await page.evaluate(async () => {
      const meta = await VideoEffects.addCustomScene(await window.__panorama());
      // As if another window had written it: forget, then hear the event.
      const raw = localStorage.getItem('custom-scenes');
      localStorage.setItem('custom-scenes', '[]');
      window.dispatchEvent(new StorageEvent('storage', { key: 'custom-scenes' }));
      localStorage.setItem('custom-scenes', raw);
      window.dispatchEvent(new StorageEvent('storage', { key: 'custom-scenes' }));
      VideoEffects.writeMode('preset:' + meta.id);
      return meta.id;
    });
    await expect(page.locator('#settings-bg-picker .bg-chip-own')).toHaveCount(1);
    await page.reload();
    expect(await page.evaluate(() => VideoEffects.readMode())).toBe('preset:' + id);
    await expect(page.locator('#settings-bg-picker .bg-chip-own')).toHaveCount(1);
  });
});

test.describe('in a call', () => {
  test('a scene you added is drawn behind you, and never offered to a peer who draws scenes', async ({ page }) => {
    test.setTimeout(120_000);
    const seen = await page.evaluate(async () => {
      const meta = await VideoEffects.addCustomScene(await window.__panorama());
      const c = document.createElement('canvas');
      c.width = 320; c.height = 240;
      const x = c.getContext('2d');
      const paint = () => { x.fillStyle = '#888'; x.fillRect(0, 0, 320, 240); };
      paint();
      const stream = c.captureStream(15);
      setInterval(paint, 66);
      const out = await VideoEffects.wrap(stream, 'preset:' + meta.id);
      const p = VideoEffects.active();
      await window.__waitFor(() => p.sceneId === meta.id, 60000);
      VideoEffects.keyedTrack(out);
      await window.__sleep(300);
      return { drawn: p.sceneId === meta.id, snap: p.keyedSnapshot() };
    });
    expect(seen.drawn).toBe(true);
    expect(seen.snap.scene).toBeNull();
    expect(seen.snap.reason).toBe('custom');
  });
});
