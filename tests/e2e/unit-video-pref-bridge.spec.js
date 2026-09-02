import { test, expect } from './fixtures.js';

// The desktop Preferences window can store a camera-background preference but
// cannot apply one: it is a separate WebviewWindow with no capture pipeline of
// its own. So it writes to localStorage and the main window, which does hold
// the running processor, picks the change up from the storage event.
//
// Four of these preferences are pure uniform / timer changes — blur strength,
// edge sharpness, detection accuracy, low-light adaptation — and must NOT swap
// the published track: a renegotiation for a slider is a visible stutter on
// every other participant's screen for no reason. The fifth, the background
// mode itself, does cross off↔on and goes through applyVideoBackground().
//
// Each also has to re-sync its own control in the in-page settings modal, or
// the two windows disagree about what is selected.

/** Install a recording stand-in for the running effects processor. */
async function installProcessor(page) {
  await page.evaluate(() => {
    window.__applied = [];
    window.__throwOn = null;
    const proc = {
      applyStrength() { window.__applied.push('strength'); this._maybeThrow('strength'); },
      applyEdge() { window.__applied.push('edge'); this._maybeThrow('edge'); },
      applyQuality() { window.__applied.push('quality'); this._maybeThrow('quality'); },
      applyLightAdapt() { window.__applied.push('light'); this._maybeThrow('light'); },
      _maybeThrow(which) { if (window.__throwOn === which) throw new Error('GL context lost'); },
    };
    VideoEffects.active = () => proc;

    // Nothing may reach the published track for a preference change.
    window.__trackSwaps = 0;
    window.applyVideoBackground = (mode) => { window.__trackSwaps++; window.__lastMode = mode; };
  });
}

/** Raise the storage event the Preferences window's write would raise here. */
async function changePreference(page, key, value) {
  await page.evaluate(({ key, value }) => {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: value }));
  }, { key, value });
}

const applied = (page) => page.evaluate(() => window.__applied);
const trackSwaps = (page) => page.evaluate(() => window.__trackSwaps);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await installProcessor(page);
});

test.describe('preferences that are uniforms, not renegotiations', () => {
  const cases = [
    ['blur strength', 'blur-strength', '0.15', 'strength'],
    ['edge sharpness', 'edge-sharpness', '0.9', 'edge'],
    ['detection accuracy', 'detection-quality', 'high', 'quality'],
    ['low-light adaptation', 'light-adapt', 'off', 'light'],
  ];

  for (const [label, key, value, method] of cases) {
    test(`${label} is re-read by the running processor`, async ({ page }) => {
      await changePreference(page, key, value);

      expect(await applied(page)).toEqual([method]);
      // The far side sees nothing at all: no track swap, no renegotiation.
      expect(await trackSwaps(page)).toBe(0);
    });
  }

  test('each key drives only its own half of the bridge', async ({ page }) => {
    await changePreference(page, 'edge-sharpness', '0.2');
    await changePreference(page, 'detection-quality', 'battery');
    await changePreference(page, 'light-adapt', null);

    expect(await applied(page)).toEqual(['edge', 'quality', 'light']);
  });

  test('a processor that throws does not take the call\'s video down', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.evaluate(() => { window.__throwOn = 'edge'; });

    await changePreference(page, 'edge-sharpness', '1');
    // The next preference still works — the failure was contained.
    await page.evaluate(() => { window.__throwOn = null; });
    await changePreference(page, 'detection-quality', 'high');

    expect(errors).toEqual([]);
    expect(await applied(page)).toEqual(['edge', 'quality']);
  });

  test('with no camera running the change is stored and nothing is applied', async ({ page }) => {
    await page.evaluate(() => { VideoEffects.active = () => null; });
    await changePreference(page, 'edge-sharpness', '0.4');

    expect(await applied(page)).toEqual([]);
    expect(await trackSwaps(page)).toBe(0);
  });

  test('the in-page control is re-synced so the two windows agree', async ({ page }) => {
    await page.click('#btn-open-settings');
    await changePreference(page, 'detection-quality', 'high');

    // The picker in this window must show what the other window chose.
    const selected = await page.evaluate(() => {
      const seg = document.getElementById('settings-detection-quality');
      const active = seg.querySelector('[aria-checked="true"], .active, [aria-pressed="true"]');
      return active ? active.textContent.trim() : seg.textContent.trim();
    });
    expect(selected.toLowerCase()).toContain('high');
  });
});

test.describe('the background mode itself', () => {
  test('a change does go through applyVideoBackground — it can cross off↔on', async ({ page }) => {
    await changePreference(page, 'video-background', 'blur');

    expect(await page.evaluate(() => window.__lastMode)).toBe('blur');
    expect(await trackSwaps(page)).toBe(1);
    // The uniform-only path must not also have run.
    expect(await applied(page)).toEqual([]);
  });

  test('clearing it is read as "off", not as an empty mode', async ({ page }) => {
    await changePreference(page, 'video-background', null);
    expect(await page.evaluate(() => window.__lastMode)).toBe('off');
  });

  test('a preset selection is passed through verbatim', async ({ page }) => {
    await changePreference(page, 'video-background', 'preset:office');
    expect(await page.evaluate(() => window.__lastMode)).toBe('preset:office');
  });
});

test('a storage key nothing on this bridge cares about is ignored', async ({ page }) => {
  await changePreference(page, 'some-unrelated-key', 'x');

  expect(await applied(page)).toEqual([]);
  expect(await trackSwaps(page)).toBe(0);
});
