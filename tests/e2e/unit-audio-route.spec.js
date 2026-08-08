import { test, expect } from './fixtures.js';

// In-room speaker ⇄ earpiece switching.
//
// `setSinkId` — the desktop output picker — cannot do this on mobile: Android
// does not implement it at all (browser and WebView alike) and WebKit never
// shipped it. So the route goes through one of two backends, probed once per
// load, and the button is hidden outright when neither answers. These tests pin
// the probe's precedence, the "every room starts on the loudspeaker" rule, and
// the fact that a rejected switch never lies about where the audio is.
//
// IS_NATIVE_MOBILE / IS_MOBILE_DEVICE are `const`s evaluated while main.js
// loads, so every stub has to be installed with addInitScript, before goto.

// A Capacitor native platform. Also makes IS_MOBILE_DEVICE true, which is what
// gates the web backend (desktop Safari exposes navigator.audioSession too, and
// an "Earpiece" button on a Mac would be nonsense).
const stubNative = (page, plugins = {}) =>
  page.addInitScript((p) => {
    window.__routeCalls = [];
    const built = {};
    if (p.audioRoute === 'ok' || p.audioRoute === 'failSet') {
      built.AudioRoute = {
        getRoute: () => Promise.resolve({ route: 'speaker' }),
        setRoute: (opts) => {
          window.__routeCalls.push(opts.route);
          return p.audioRoute === 'failSet'
            ? Promise.reject(new Error('device busy'))
            : Promise.resolve({ route: opts.route });
        },
      };
    } else if (p.audioRoute === 'stale') {
      // A binary older than this JS bundle: Capgo ships main.js over the air, so
      // Capacitor.Plugins exists but the native method does not. Capacitor
      // rejects the call rather than throwing at property access, which is
      // exactly why a presence check is not enough to detect support.
      built.AudioRoute = {
        getRoute: () => Promise.reject(new Error('not implemented')),
        setRoute: () => Promise.reject(new Error('not implemented')),
      };
    }
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: built };
  }, plugins);

const stubAudioSession = (page) =>
  page.addInitScript(() => {
    window.__audioSessionTypes = [];
    let type = 'auto';
    navigator.audioSession = {
      get type() { return type; },
      set type(v) { type = v; window.__audioSessionTypes.push(v); },
    };
  });

const backend = (page) => page.evaluate(() => window.probeAudioRouteBackend());

const btnState = (page) =>
  page.evaluate(() => {
    const btn = document.getElementById('btn-audio-route');
    return {
      hidden: btn.classList.contains('hidden'),
      active: btn.classList.contains('active'),
      pressed: btn.getAttribute('aria-pressed'),
      title: btn.title,
      label: btn.querySelector('.audio-route-label').textContent,
      speakerIconHidden: btn.querySelector('.audio-route-icon-speaker').classList.contains('hidden'),
      earpieceIconHidden: btn.querySelector('.audio-route-icon-earpiece').classList.contains('hidden'),
    };
  });

test.describe('audio output route', () => {
  test('desktop resolves no backend even when navigator.audioSession exists', async ({ page }) => {
    await stubAudioSession(page);
    await page.goto('/');
    // Safari on macOS implements the AudioSession API; the device check is the
    // only thing keeping an earpiece button off a laptop.
    expect(await backend(page)).toBeNull();
    await page.evaluate(() => window.updateAudioRouteUI());
    expect((await btnState(page)).hidden).toBe(true);
  });

  test('the native plugin wins over navigator.audioSession', async ({ page }) => {
    await stubAudioSession(page);
    await stubNative(page, { audioRoute: 'ok' });
    await page.goto('/');
    expect(await backend(page)).toBe('native');
  });

  test('a native binary without the method falls through to the web backend', async ({ page }) => {
    await stubAudioSession(page);
    await stubNative(page, { audioRoute: 'stale' });
    await page.goto('/');
    expect(await backend(page)).toBe('web-audiosession');
  });

  test('mobile with neither backend resolves null and keeps the button hidden', async ({ page }) => {
    await stubNative(page, {});
    await page.goto('/');
    expect(await backend(page)).toBeNull();
    await page.evaluate(() => window.initAudioRouteForRoom());
    expect((await btnState(page)).hidden).toBe(true);
  });

  test('a supported backend reveals the button, starting on the speaker', async ({ page }) => {
    await stubNative(page, { audioRoute: 'ok' });
    await page.goto('/');
    await page.evaluate(() => window.initAudioRouteForRoom());
    expect(await btnState(page)).toMatchObject({
      hidden: false,
      active: false,
      pressed: 'false',
      title: 'Switch to earpiece',
      label: 'Speaker',
      speakerIconHidden: false,
      earpieceIconHidden: true,
    });
    expect(await page.evaluate(() => window.__routeCalls)).toEqual(['speaker']);
  });

  test('toggling switches to the earpiece and back', async ({ page }) => {
    await stubNative(page, { audioRoute: 'ok' });
    await page.goto('/');
    await page.evaluate(() => window.initAudioRouteForRoom());

    await page.evaluate(() => window.toggleAudioRoute());
    expect(await btnState(page)).toMatchObject({
      active: true,
      pressed: 'true',
      title: 'Switch to speaker',
      label: 'Earpiece',
      speakerIconHidden: true,
      earpieceIconHidden: false,
    });

    await page.evaluate(() => window.toggleAudioRoute());
    expect(await btnState(page)).toMatchObject({ active: false, label: 'Speaker' });
    expect(await page.evaluate(() => window.__routeCalls)).toEqual(['speaker', 'earpiece', 'speaker']);
  });

  test('every room starts on the speaker, even after the last one ended on the earpiece', async ({ page }) => {
    await stubNative(page, { audioRoute: 'ok' });
    await page.goto('/');
    await page.evaluate(() => window.initAudioRouteForRoom());
    await page.evaluate(() => window.toggleAudioRoute());
    expect((await btnState(page)).label).toBe('Earpiece');

    // The route is session state and is deliberately never persisted, so the
    // next join must come back on the loudspeaker.
    await page.evaluate(() => window.initAudioRouteForRoom());
    expect(await btnState(page)).toMatchObject({ active: false, label: 'Speaker' });
  });

  test('leaving hands the device back to the speaker', async ({ page }) => {
    await stubNative(page, { audioRoute: 'ok' });
    await page.goto('/');
    await page.evaluate(() => window.initAudioRouteForRoom());
    await page.evaluate(() => window.toggleAudioRoute());

    await page.evaluate(() => window.resetAudioRouteOnLeave());
    expect((await btnState(page)).label).toBe('Speaker');
    await expect
      .poll(() => page.evaluate(() => window.__routeCalls))
      .toEqual(['speaker', 'earpiece', 'speaker']);
  });

  test('a rejected switch leaves the button telling the truth', async ({ page }) => {
    await stubNative(page, { audioRoute: 'failSet' });
    await page.goto('/');
    await page.evaluate(() => window.initAudioRouteForRoom());
    // The initial speaker assert failed too, so the button must still read
    // "Speaker" — the state it never left.
    expect(await page.evaluate(() => window.toggleAudioRoute())).toBe(false);
    expect(await btnState(page)).toMatchObject({ active: false, pressed: 'false', label: 'Speaker' });
  });

  test('the web backend drives navigator.audioSession.type', async ({ page }) => {
    await stubAudioSession(page);
    await stubNative(page, {});
    await page.goto('/');
    expect(await backend(page)).toBe('web-audiosession');

    await page.evaluate(() => window.setAudioRoute('earpiece'));
    // 'play-and-record' declares the page a call, which is what moves WebKit's
    // output to the receiver; 'auto' hands routing back to the platform.
    expect(await page.evaluate(() => navigator.audioSession.type)).toBe('play-and-record');
    await page.evaluate(() => window.setAudioRoute('speaker'));
    expect(await page.evaluate(() => navigator.audioSession.type)).toBe('auto');
  });
});
