import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// The network echo test sends your voice out over the real network and records
// what comes back, so you can hear what others hear. These cover the pure
// verdict logic and the guards; the real loopback runs in the @mesh project,
// which has the fake-media Chromium flags.

const clean = {
  ok: true, windowMs: 4000, samples: 190000, concealed: 900,
  concealmentEvents: 1, packets: 200, packetsLost: 0, jitterBufferMs: 85,
};
const summarize = (page, report, rms) =>
  page.evaluate(([r, e]) => window.summarizeEchoTest(r, e), [report, rms]);

test.describe('summarizeEchoTest', () => {
  test('good when little had to be filled in', async ({ page }) => {
    await page.goto('/');
    const v = await summarize(page, clean, 0.3);
    expect(v.status).toBe('good');
    // Self-test wording, not the peer check's "They hear you…".
    expect(v.headline).toBe('You would sound clear');
  });

  test('choppy between 2% and 10% filled in', async ({ page }) => {
    await page.goto('/');
    const v = await summarize(page, { ...clean, concealed: 9500, concealmentEvents: 3 }, 0.3);
    expect(v.status).toBe('choppy');
    expect(v.headline).toBe('You would sound choppy');
    expect(v.detail).toContain('5.0%');
    expect(v.detail).toContain('3 dropout(s)');
  });

  test('bad above 10% filled in', async ({ page }) => {
    await page.goto('/');
    const v = await summarize(page, { ...clean, concealed: 47500 }, 0.3);
    expect(v.status).toBe('bad');
    expect(v.concealPercent).toBeCloseTo(25, 5);
  });

  test('shares the peer check thresholds, so the same measurement means the same thing', async ({ page }) => {
    await page.goto('/');
    // 1.9% -> good, 2.1% -> choppy: the AUDIO_CHECK_CONCEAL_GOOD boundary.
    const justUnder = await summarize(page, { ...clean, samples: 100000, concealed: 1900 }, 0.3);
    const justOver  = await summarize(page, { ...clean, samples: 100000, concealed: 2100 }, 0.3);
    expect(justUnder.status).toBe('good');
    expect(justOver.status).toBe('choppy');
  });

  test('silent when the round trip carried no audible sound', async ({ page }) => {
    await page.goto('/');
    const v = await summarize(page, clean, 0.0001);
    expect(v.status).toBe('silent');
    expect(v.headline).toBe('Nothing was heard');
    expect(v.detail).toContain('microphone');
  });

  test('errors when nothing came back at all', async ({ page }) => {
    await page.goto('/');
    expect((await summarize(page, null, 0.3)).status).toBe('error');
    expect((await summarize(page, { ok: false, reason: 'no-audio-link' }, 0.3)).status).toBe('error');
  });

  test('handles a report with no samples without dividing by zero', async ({ page }) => {
    await page.goto('/');
    const v = await summarize(page, { ...clean, samples: 0, concealed: 0 }, 0.3);
    expect(v.status).toBe('good');
    expect(v.detail).toContain('0.0%');
  });
});

test.describe('echo test guards', () => {
  test('refuses to run while in a room, pointing at the per-peer check', async ({ page }) => {
    await page.goto('/');
    await seedRoom(page, { isHost: false, roomCode: 'host-1' });
    const r = await page.evaluate(async () => {
      await window.startEchoTest();
      return {
        running: window.echoTestRunning(),
        status: document.getElementById('echo-test-status').textContent,
      };
    });
    // applyRNNoise shares one AudioContext + worklet, so a second mic source
    // would mix into the live call.
    expect(r.running).toBe(false);
    expect(r.status).toContain('Leave the room');
    expect(r.status).toContain('Can they hear me');
  });

  test('stopEchoTest is a safe no-op when nothing is running', async ({ page }) => {
    await page.goto('/');
    const ok = await page.evaluate(async () => {
      await window.stopEchoTest({ replay: true });
      await window.stopEchoTest();
      return window.echoTestRunning() === false;
    });
    expect(ok).toBe(true);
  });
});

test.describe('echo verdict rendering', () => {
  test('annotates whether the run actually went through a relay', async ({ page }) => {
    await page.goto('/');
    const texts = await page.evaluate(() => {
      const el = document.getElementById('echo-test-status');
      const out = {};
      window.renderEchoVerdict({ status: 'good', headline: 'You would sound clear',
        detail: 'Only 0.4% of audio needed filling in.', iceType: 'relay' }, { ok: true, jitterBufferMs: 120 });
      out.relayed = el.textContent;
      out.relayedClass = el.className;
      window.renderEchoVerdict({ status: 'good', headline: 'You would sound clear',
        detail: 'Only 0.4% of audio needed filling in.', iceType: 'host' }, null);
      out.direct = el.textContent;
      return out;
    });
    expect(texts.relayed).toContain('via TURN relay');
    expect(texts.relayed).toContain('120 ms buffer');
    expect(texts.relayedClass).toContain('ac-good');
    // A run that did not use the relay must say so — otherwise it reads as a
    // relay test when it never touched one.
    expect(texts.direct).toContain('not relayed');
  });

  test('clears the status when there is no verdict', async ({ page }) => {
    await page.goto('/');
    const hidden = await page.evaluate(() => {
      window.renderEchoVerdict(null, null);
      return document.getElementById('echo-test-status').classList.contains('hidden');
    });
    expect(hidden).toBe(true);
  });
});

test.describe('settings UI', () => {
  async function openAudio(page) {
    await page.click('#btn-open-settings');
    await page.click('#modal-settings-sidebar .prefs-nav-btn[data-target="settings-audio"]');
  }

  test('the button sits beside the raw mic test and is not the destructive variant', async ({ page }) => {
    await page.goto('/');
    await openAudio(page);
    const btn = page.locator('#btn-test-echo');
    await expect(btn).toBeVisible();
    await expect(btn).toHaveText('Test over network');
    // .btn-ghost is this codebase's destructive/quiet variant (red hover).
    await expect(btn).not.toHaveClass(/btn-ghost/);
    await expect(btn).toHaveClass(/btn-secondary/);
  });

  test('the status line starts hidden', async ({ page }) => {
    await page.goto('/');
    await openAudio(page);
    await expect(page.locator('#echo-test-status')).toBeHidden();
  });
});

test.describe('relay failure diagnosis', () => {
  const diagnose = (page, count, errors, isDefault) =>
    page.evaluate(([c, e, d]) => window.diagnoseRelayFailure(c, e, d), [count, errors, isDefault]);

  test('names the retired built-in relay outright instead of blaming the network', async ({ page }) => {
    await page.goto('/');
    // metered.ca retired the shared `openrelayproject` credentials in favour of
    // per-account API keys, so this default is known-dead — say so.
    const msg = await diagnose(page, 4, [{ code: 701, text: 'Failed to establish connection' }], true);
    expect(msg).toContain('no longer works');
    expect(msg).toContain('retired');
    expect(msg).toContain('metered.ca');
    expect(msg).not.toContain('701');
  });

  test('distinguishes rejected credentials from an unreachable relay', async ({ page }) => {
    await page.goto('/');
    const rejected = await diagnose(page, 1, [{ code: 401, text: 'Unauthorized' }], false);
    const unreachable = await diagnose(page, 2, [{ code: 701, text: 'Failed to establish connection' }], false);
    expect(rejected).toContain('rejected our credentials');
    expect(rejected).toContain('401');
    expect(unreachable).toContain('could not connect');
    expect(unreachable).toContain('701');
    expect(unreachable).toContain('TCP/443');
  });

  test('reads total silence as a likely UDP block', async ({ page }) => {
    await page.goto('/');
    const msg = await diagnose(page, 2, [], false);
    expect(msg).toContain('no reply at all');
    expect(msg).toContain('UDP');
  });

  test('tells you when no relay is configured at all', async ({ page }) => {
    await page.goto('/');
    const msg = await diagnose(page, 0, [], false);
    expect(msg).toContain('No relay server is configured');
    expect(msg).toContain('Fallback relay');
  });

  test('falls back to reporting an unrecognised error code verbatim', async ({ page }) => {
    await page.goto('/');
    const msg = await diagnose(page, 1, [{ code: 600, text: 'Weird' }], false);
    expect(msg).toContain('600');
    expect(msg).toContain('Weird');
  });

  test('counts only turn:/turns: entries as relays, not STUN', async ({ page }) => {
    await page.goto('/');
    const counts = await page.evaluate(() => ({
      stunOnly: window.countRelayServers([{ urls: 'stun:stun.l.google.com:19302' }]),
      mixed: window.countRelayServers([
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'turn:a.example:3478' },
        { urls: 'turns:b.example:443?transport=tcp' },
      ]),
      arrayUrls: window.countRelayServers([{ urls: ['stun:x:1', 'turn:y:2'] }]),
      empty: window.countRelayServers(null),
    }));
    expect(counts.stunOnly).toBe(0);
    expect(counts.mixed).toBe(2);
    expect(counts.arrayUrls).toBe(1);
    expect(counts.empty).toBe(0);
  });

  test('only calls it the default relay when every relay is a built-in one', async ({ page }) => {
    await page.goto('/');
    // DEFAULT_FALLBACK_TURN is a top-level `const`, so it is NOT on `window`
    // (only `var`/function declarations are). Spell the built-ins out here —
    // which also documents what the shipped default actually is.
    const BUILT_IN = [
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    ];
    const r = await page.evaluate((builtIn) => ({
      allDefault: window.usingDefaultFallbackRelay([{ urls: 'stun:s:1' }].concat(builtIn)),
      custom: window.usingDefaultFallbackRelay([{ urls: 'turn:my.relay:443', username: 'u', credential: 'p' }]),
      mixed: window.usingDefaultFallbackRelay(builtIn.concat([{ urls: 'turn:my.relay:443' }])),
      none: window.usingDefaultFallbackRelay([{ urls: 'stun:s:1' }]),
    }), BUILT_IN);
    expect(r.allDefault).toBe(true);
    // A user who configured their own relay must not be told theirs is retired.
    expect(r.custom).toBe(false);
    expect(r.mixed).toBe(false);
    expect(r.none).toBe(false);
  });
});
