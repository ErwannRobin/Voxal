import { test, expect } from './fixtures.js';

// maybeApplyVideoEffects() is the one gate between "I picked a background" and
// the camera track that actually goes out.
//
// Its whole contract is that a background is a nicety and must never be the
// reason a camera fails to share: whatever goes wrong — an unsupported browser,
// a 12 MB WASM runtime that will not download, a GL context that will not
// initialise — the raw device stream is what comes back, and the share goes
// ahead without the effect.
//
// The one failure that is not an error is the user cancelling the download.
// That is a decision, so the preference is turned off to match: leaving it set
// would re-attempt the same download on the next share.

/** A canvas capture standing in for the raw camera stream. */
async function installRawStream(page) {
  await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 240;
    canvas.getContext('2d').fillRect(0, 0, 320, 240);
    window.__raw = canvas.captureStream(5);
    const wrapped = document.createElement('canvas');
    wrapped.width = 320; wrapped.height = 240;
    wrapped.getContext('2d').fillRect(0, 0, 320, 240);
    window.__wrapped = wrapped.captureStream(5);
  });
}

/** Point VideoEffects at a controllable wrap(), and record what it is asked. */
async function stubEffects(page, { supported = true, behaviour = 'ok' } = {}) {
  await page.evaluate(({ supported, behaviour }) => {
    window.__wrapCalls = [];
    window.__modeWrites = [];
    VideoEffects.isSupported = () => supported;
    VideoEffects.writeMode = (m) => { window.__modeWrites.push(m); };
    VideoEffects.wrap = (stream, mode) => {
      window.__wrapCalls.push({ stream, mode });
      if (behaviour === 'abort') {
        const e = new Error('The user aborted a request.');
        e.name = 'AbortError';
        return Promise.reject(e);
      }
      if (behaviour === 'fail') return Promise.reject(new Error('WebGL context creation failed'));
      return Promise.resolve(window.__wrapped);
    };
  }, { supported, behaviour });
}

/** Ask for the effect and report which stream came back. */
const applyTo = (page) =>
  page.evaluate(async () => {
    const out = await window.maybeApplyVideoEffects(window.__raw);
    return {
      isRaw: out === window.__raw,
      isWrapped: out === window.__wrapped,
      wrapCalls: window.__wrapCalls,
      modeWrites: window.__modeWrites,
      toast: document.getElementById('copy-toast').textContent,
    };
  });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await installRawStream(page);
});

test('with no background selected the device stream is passed straight through', async ({ page }) => {
  await stubEffects(page);
  await page.evaluate(() => localStorage.removeItem('video-background'));

  const out = await applyTo(page);
  expect(out.isRaw).toBe(true);
  // Not even asked for: no WASM download, no GL context, on every share.
  expect(out.wrapCalls).toEqual([]);
});

test('a selected background is applied, and the wrapped stream is what goes out', async ({ page }) => {
  await stubEffects(page);
  await page.evaluate(() => localStorage.setItem('video-background', 'blur'));

  const out = await applyTo(page);
  expect(out.isWrapped).toBe(true);
  expect(out.wrapCalls).toHaveLength(1);
  expect(out.wrapCalls[0].mode).toBe('blur');
});

test('a preset background is passed through by name', async ({ page }) => {
  await stubEffects(page);
  await page.evaluate(() => localStorage.setItem('video-background', 'preset:studio'));

  const out = await applyTo(page);
  expect(out.wrapCalls[0].mode).toBe('preset:studio');
});

test('a browser that cannot do effects shares the raw camera without trying', async ({ page }) => {
  await stubEffects(page, { supported: false });
  await page.evaluate(() => localStorage.setItem('video-background', 'blur'));

  const out = await applyTo(page);
  expect(out.isRaw).toBe(true);
  expect(out.wrapCalls).toEqual([]);
  // The preference is left alone — the same browser may support it next time.
  expect(out.modeWrites).toEqual([]);
});

test('an effect that fails to start shares the camera anyway, and says so', async ({ page }) => {
  await stubEffects(page, { behaviour: 'fail' });
  await page.evaluate(() => localStorage.setItem('video-background', 'blur'));

  const out = await applyTo(page);
  expect(out.isRaw).toBe(true);
  expect(out.toast).toContain('Background effect unavailable');
  // A failure is not a decision: the preference stays, so it retries next time.
  expect(out.modeWrites).toEqual([]);
});

test('cancelling the download turns the background off, quietly', async ({ page }) => {
  await stubEffects(page, { behaviour: 'abort' });
  await page.evaluate(() => localStorage.setItem('video-background', 'blur'));

  const out = await applyTo(page);
  expect(out.isRaw).toBe(true);
  // The user chose to stop: don't re-attempt the same download on every share.
  expect(out.modeWrites).toEqual(['off']);
  // And don't scold them about a thing they did on purpose.
  expect(out.toast).not.toContain('unavailable');
});

test('cancelling re-syncs the pickers, so the UI agrees the background is off', async ({ page }) => {
  await stubEffects(page, { behaviour: 'abort' });
  await page.evaluate(() => {
    localStorage.setItem('video-background', 'blur');
    // writeMode is stubbed, so make readMode agree with what was written.
    VideoEffects.readMode = () => (window.__modeWrites.length ? window.__modeWrites.at(-1) : 'blur');
  });

  const synced = await page.evaluate(async () => {
    let seen = null;
    const picker = { sync: (mode) => { seen = mode; } };
    window._videoBgPickers.push(picker);
    await window.maybeApplyVideoEffects(window.__raw);
    return seen;
  });

  expect(synced).toBe('off');
});
