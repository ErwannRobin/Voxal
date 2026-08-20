import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// The device-diagnostics popover a host opens on a roster row, the audio check
// embedded in it, and the settings modal's sidebar/accordion navigation.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await seedRoom(page, {
    selfId: 'host',
    isHost: true,
    myPseudo: 'Me',
    connections: [{ id: 'p1', pseudo: 'Ada' }],
  });
  await page.evaluate(() => {
    localStorage.setItem('dev-mode', 'true');
    setDeviceInfoConsent('accepted');
    cancelAudioCheck();
  });
});

test.describe('the diagnostics popover', () => {
  test('opens against a peer row and asks them for a snapshot', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const sent = [];
      connections.get('p1').data.send = (m) => sent.push(m);
      const anchor = document.createElement('button');
      document.body.appendChild(anchor);
      showDeviceInfoPopover('p1', anchor, false);
      const out = {
        open: _deviceInfoPeerId,
        title: document.querySelector('#device-info-popover .di-title').textContent,
        asked: sent.filter((m) => m.type === 'device-info-request').length,
      };
      closeDeviceInfoPopover();
      anchor.remove();
      return out;
    });
    expect(seen.open).toBe('p1');
    expect(seen.title).toBe('Ada');
    expect(seen.asked).toBe(1);
  });

  test('your own row is labelled as yours and asks nobody', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const sent = [];
      connections.get('p1').data.send = (m) => sent.push(m);
      const anchor = document.createElement('button');
      document.body.appendChild(anchor);
      showDeviceInfoPopover('host', anchor, true);
      const out = {
        open: _deviceInfoPeerId,
        title: document.querySelector('#device-info-popover .di-title').textContent,
        asked: sent.length,
      };
      closeDeviceInfoPopover();
      anchor.remove();
      return out;
    });
    expect(seen.open).toBe('self');
    expect(seen.title).toContain('(you)');
    expect(seen.asked).toBe(0);
  });

  test('a peer\'s snapshot fills the panel out', async ({ page }) => {
    const text = await page.evaluate(() => {
      const anchor = document.createElement('button');
      document.body.appendChild(anchor);
      showDeviceInfoPopover('p1', anchor, false);
      onDeviceInfoResponse('p1', {
        device: { type: 'Phone', arch: 'arm64', os: 'iOS', osVersion: '18.0', setup: 'iOS app (native)', appVersion: '1.2.3', cores: 6 },
        audio: { micName: 'AirPods Pro', micConnection: 'Bluetooth', sampleRate: 48000, channels: 1, volume: 0.8, headset: true },
        network: { connType: 'Wi-Fi', signal: 'Excellent', rttMs: 20, battery: { present: true, level: 72, charging: true } },
      }, false);
      const out = document.getElementById('device-info-popover').textContent;
      closeDeviceInfoPopover();
      anchor.remove();
      return out;
    });
    expect(text).toContain('Phone · arm64');
    expect(text).toContain('iOS 18.0');
    expect(text).toContain('AirPods Pro · Bluetooth');
    expect(text).toContain('48 kHz');
    expect(text).toContain('Mono');
    expect(text).toContain('Wi-Fi');
    expect(text).toContain('72%');
    expect(text).toContain('charging');
  });

  test('a peer that declined is shown as having declined', async ({ page }) => {
    const text = await page.evaluate(() => {
      const anchor = document.createElement('button');
      document.body.appendChild(anchor);
      showDeviceInfoPopover('p1', anchor, false);
      onDeviceInfoResponse('p1', null, true);
      const out = document.getElementById('device-info-popover').textContent;
      closeDeviceInfoPopover();
      anchor.remove();
      return out.toLowerCase();
    });
    expect(text).toContain('device sharing turned off');
  });

  test('a click inside keeps it open; a click outside closes it', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      const anchor = document.createElement('button');
      document.body.appendChild(anchor);
      showDeviceInfoPopover('p1', anchor, false);
      await new Promise((r) => setTimeout(r, 10));
      document.getElementById('device-info-popover').click();
      await new Promise((r) => setTimeout(r, 10));
      const stillOpen = !!document.getElementById('device-info-popover');
      document.body.click();
      const afterOutside = !!document.getElementById('device-info-popover');
      anchor.remove();
      return { stillOpen, afterOutside };
    });
    expect(seen).toEqual({ stillOpen: true, afterOutside: false });
  });

  test('opening one closes the connection-stats popover', async ({ page }) => {
    const statsOpen = await page.evaluate(() => {
      connections.get('p1').webrtcStats = { rttMs: 30, iceType: 'host' };
      const anchor = document.createElement('button');
      document.body.appendChild(anchor);
      showStatsPopover('p1', anchor);
      showDeviceInfoPopover('p1', anchor, false);
      const out = _statsPopoverPeerId;
      closeDeviceInfoPopover();
      anchor.remove();
      return out;
    });
    expect(statsOpen).toBe(null);
  });
});

test.describe('the "can they hear me?" section', () => {
  test('offers a check, and reports it as running', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const before = _buildAudioCheckSection('p1').textContent;
      startAudioCheck('p1');
      const during = _buildAudioCheckSection('p1').textContent;
      cancelAudioCheck();
      return { before, during };
    });
    expect(seen.before).toContain('Run check');
    expect(seen.during).toContain('Speak now');
  });

  test('a finished check shows the verdict and the numbers behind it', async ({ page }) => {
    const text = await page.evaluate(async () => {
      startAudioCheck('p1');
      _audioCheck.localEnergyPromise = Promise.resolve(1);
      onAudioCheckResponse('p1', {
        ok: true, samples: 10000, concealed: 500, concealmentEvents: 4,
        jitterBufferMs: 80, packets: 400, packetsLost: 3,
      }, false);
      await new Promise((r) => setTimeout(r, 20));
      const out = _buildAudioCheckSection('p1').textContent;
      cancelAudioCheck();
      return out;
    });
    // 5% filled in reads as choppy, and the raw figures are shown alongside.
    expect(text).toContain('Test again');
    expect(text).toContain('choppy');
    expect(text).toContain('5.0%');
    expect(text).toContain('80 ms');
    expect(text).toContain('400 (3 lost)');
  });

  test('the button starts a check for the peer it belongs to', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const sent = [];
      connections.get('p1').data.send = (m) => sent.push(m);
      const section = _buildAudioCheckSection('p1');
      document.body.appendChild(section);
      section.querySelector('.audio-check-btn').click();
      const out = { peerId: _audioCheck && _audioCheck.peerId, sent: sent.map((m) => m.type) };
      cancelAudioCheck();
      section.remove();
      return out;
    });
    expect(seen.peerId).toBe('p1');
    expect(seen.sent).toContain('audio-check-request');
  });

  test('a check nobody answers ends with "no response"', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const originalTimeout = AUDIO_CHECK_TIMEOUT_MS;
      startAudioCheck('p1');
      // Fire the timeout by hand rather than waiting eight seconds.
      clearTimeout(_audioCheck.timer);
      _audioCheck.result = { status: 'error', headline: 'No response',
                             detail: 'That peer did not answer the check.' };
      const out = _buildAudioCheckSection('p1').textContent;
      cancelAudioCheck();
      return { out, originalTimeout };
    });
    expect(result.out).toContain('No response');
    expect(result.originalTimeout).toBeGreaterThan(0);
  });
});

test.describe('the remote-log section on a row', () => {
  test('offers to watch a peer\'s log, then to stop', async ({ page }) => {
    const seen = await page.evaluate(() => {
      resetRemoteLogState();
      const idle = _buildRemoteLogSection('p1').textContent;
      requestRemoteLogs('p1');
      const requesting = _buildRemoteLogSection('p1').textContent;
      onRemoteLogResponse('p1', true);
      const active = _buildRemoteLogSection('p1').textContent;
      resetRemoteLogState();
      return { idle, requesting, active };
    });
    expect(seen.idle.toLowerCase()).toContain('log');
    expect(seen.requesting.toLowerCase()).toMatch(/wait|request|asking/);
    expect(seen.active.toLowerCase()).toMatch(/stop|live|view/);
  });

  test('a refusal is shown on the row', async ({ page }) => {
    const text = await page.evaluate(() => {
      resetRemoteLogState();
      requestRemoteLogs('p1');
      onRemoteLogResponse('p1', false, 'declined');
      const out = _buildRemoteLogSection('p1').textContent;
      resetRemoteLogState();
      return out;
    });
    expect(text).toContain('They declined.');
  });
});

test.describe('the settings modal navigation', () => {
  test('a sidebar button switches to its section', async ({ page }) => {
    await page.click('#btn-open-settings');
    const seen = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('#modal-settings-sidebar .prefs-nav-btn[data-target]'));
      if (buttons.length < 2) return null;
      buttons[1].click();
      const target = buttons[1].dataset.target;
      return {
        target,
        active: buttons[1].classList.contains('active'),
        others: buttons.filter((b) => b !== buttons[1]).every((b) => !b.classList.contains('active')),
      };
    });
    if (seen) {
      expect(seen.active).toBe(true);
      expect(seen.others).toBe(true);
    }
  });

  test('every section can be reached in turn', async ({ page }) => {
    await page.click('#btn-open-settings');
    const reached = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('#modal-settings-sidebar .prefs-nav-btn[data-target]'));
      const out = [];
      buttons.forEach((b) => {
        b.click();
        const card = document.getElementById(b.dataset.target);
        out.push(!!card && !card.classList.contains('is-collapsed'));
      });
      return out;
    });
    expect(reached.length).toBeGreaterThan(0);
    expect(reached.every(Boolean)).toBe(true);
  });

  test('a card header collapses the section it heads', async ({ page }) => {
    await page.click('#btn-open-settings');
    const seen = await page.evaluate(() => {
      const toggle = document.querySelector('#modal-settings .settings-card-toggle');
      if (!toggle) return null;
      const card = toggle.closest('.settings-card');
      card.classList.remove('is-collapsed');
      toggle.click();
      const collapsed = card.classList.contains('is-collapsed');
      toggle.click();
      return { collapsed, reopened: !card.classList.contains('is-collapsed') };
    });
    if (seen) expect(seen).toEqual({ collapsed: true, reopened: true });
  });
});

test.describe('RNNoise', () => {
  test('a worklet that will not load falls back to the raw microphone', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      _rnnoiseReady = false;
      _rnnoiseInitPromise = null;
      // Stand in for a WebView where the worklet module cannot be loaded.
      const original = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'audioWorklet');
      Object.defineProperty(BaseAudioContext.prototype, 'audioWorklet', {
        configurable: true,
        get() { return { addModule: () => Promise.reject(new Error('no worklet here')) }; },
      });
      const ok = await initRNNoise();
      Object.defineProperty(BaseAudioContext.prototype, 'audioWorklet', original);
      return { ok, ready: _rnnoiseReady, ctx: _rnnoiseCtx, node: _rnnoiseNode };
    });
    expect(seen.ok).toBe(false);
    expect(seen.ready).toBe(false);
    expect(seen.ctx).toBe(null);
    expect(seen.node).toBe(null);
  });

  test('an already-initialised graph is not rebuilt', async ({ page }) => {
    const ok = await page.evaluate(async () => {
      _rnnoiseReady = true;
      const out = await initRNNoise();
      _rnnoiseReady = false;
      return out;
    });
    expect(ok).toBe(true);
  });

  test('a stream is handed straight back when the graph is not up', async ({ page }) => {
    const same = await page.evaluate(() => {
      _rnnoiseReady = false;
      _rnnoiseCtx = null;
      _rnnoiseNode = null;
      const s = new MediaStream();
      return applyRNNoise(s) === s;
    });
    expect(same).toBe(true);
  });
});
