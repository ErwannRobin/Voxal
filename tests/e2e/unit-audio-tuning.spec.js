import { test, expect } from './fixtures.js';
import { seedRoom, callFn } from './_helpers.js';

// The knobs turned on a live audio link — sender bitrate and priority, receiver
// playout delay — plus the smaller helpers around them that nothing else pins
// down: the device snapshot, the identity a host can force on you, and the
// invite screen's entry point.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test.describe('tuning the outgoing audio sender', () => {
  /** A sender stub that records what it was set to. */
  async function installSenders(page) {
    await page.evaluate(() => {
      window.__mkSender = function(kind, initial) {
        return {
          track: kind ? { kind } : null,
          params: initial || {},
          setCalls: 0,
          getParameters() { return this.params; },
          setParameters(p) { this.setCalls++; this.params = p; return Promise.resolve(); },
        };
      };
      window.__mkPc = function(senders) { return { getSenders: () => senders }; };
    });
  }

  test('pins the Opus ceiling and asks the network to prioritise it', async ({ page }) => {
    await installSenders(page);
    const seen = await page.evaluate(() => {
      const sender = window.__mkSender('audio');
      tuneAudioSenders(window.__mkPc([sender]));
      return { enc: sender.params.encodings[0], calls: sender.setCalls, max: OPUS_MAX_BITRATE };
    });
    expect(seen.enc.maxBitrate).toBe(seen.max);
    expect(seen.enc.networkPriority).toBe('high');
    expect(seen.enc.priority).toBe('high');
    expect(seen.calls).toBe(1);
  });

  test('an already-tuned sender is left alone', async ({ page }) => {
    await installSenders(page);
    const calls = await page.evaluate(() => {
      const sender = window.__mkSender('audio');
      const pc = window.__mkPc([sender]);
      tuneAudioSenders(pc);
      tuneAudioSenders(pc);
      return sender.setCalls;
    });
    expect(calls).toBe(1);
  });

  test('a video sender is not an audio sender', async ({ page }) => {
    await installSenders(page);
    const calls = await page.evaluate(() => {
      const video = window.__mkSender('video');
      const trackless = window.__mkSender(null);
      tuneAudioSenders(window.__mkPc([video, trackless]));
      return video.setCalls + trackless.setCalls;
    });
    expect(calls).toBe(0);
  });

  test('a sender with no parameters API is skipped, not crashed on', async ({ page }) => {
    await installSenders(page);
    const threw = await page.evaluate(() => {
      try {
        tuneAudioSenders(window.__mkPc([{ track: { kind: 'audio' } }]));
        tuneAudioSenders(null);
        tuneAudioSenders({});
        return false;
      } catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });

  test('a setParameters that rejects is swallowed', async ({ page }) => {
    await installSenders(page);
    const threw = await page.evaluate(() => {
      const sender = window.__mkSender('audio');
      sender.setParameters = () => Promise.reject(new Error('not now'));
      try { tuneAudioSenders(window.__mkPc([sender])); return false; } catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });
});

test.describe('tuning the incoming audio receiver', () => {
  test('sets the playout hint where the engine has one', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const chromium = { track: { kind: 'audio' }, playoutDelayHint: 0 };
      const webkit = { track: { kind: 'audio' } }; // no hint property at all
      const video = { track: { kind: 'video' }, playoutDelayHint: 0 };
      tuneAudioReceivers({ getReceivers: () => [chromium, webkit, video] }, 0.12);
      return {
        chromium: chromium.playoutDelayHint,
        webkit: 'playoutDelayHint' in webkit,
        video: video.playoutDelayHint,
      };
    });
    expect(seen.chromium).toBeCloseTo(0.12);
    expect(seen.webkit).toBe(false);
    expect(seen.video).toBe(0);
  });

  test('a connection with no receivers API is skipped', async ({ page }) => {
    const threw = await page.evaluate(() => {
      try { tuneAudioReceivers(null, 0.1); tuneAudioReceivers({}, 0.1); return false; } catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });

  test('applyAudioTuning walks both links to a peer', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1' }] });
    const seen = await page.evaluate(() => {
      const mkPc = () => {
        const receiver = { track: { kind: 'audio' }, playoutDelayHint: 0 };
        return {
          receiver,
          getSenders: () => [],
          getReceivers: () => [receiver],
        };
      };
      const a = mkPc();
      const b = mkPc();
      const c = connections.get('p1');
      c.media = { closed: false, peerConnection: a };
      c.audioMediaOut = { closed: false, peerConnection: b };
      applyAudioTuning(c, 0.2);
      return [a.receiver.playoutDelayHint, b.receiver.playoutDelayHint];
    });
    expect(seen[0]).toBeCloseTo(0.2);
    expect(seen[1]).toBeCloseTo(0.2);
  });

  test('reapplying reaches every peer at once', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1' }, { id: 'p2' }] });
    const seen = await page.evaluate(() => {
      const hints = [];
      connections.forEach((c) => {
        const receiver = { track: { kind: 'audio' }, playoutDelayHint: 0 };
        hints.push(receiver);
        c.media = { closed: false, peerConnection: { getSenders: () => [], getReceivers: () => [receiver] } };
      });
      localStorage.setItem('jitter-buffer', '200');
      reapplyAudioTuningToAllPeers();
      localStorage.removeItem('jitter-buffer');
      return hints.map((r) => r.playoutDelayHint);
    });
    expect(seen[0]).toBeCloseTo(0.2);
    expect(seen[1]).toBeCloseTo(0.2);
  });

  test('applying to a peer that is not there is a no-op', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true });
    const threw = await page.evaluate(() => {
      try { applyAudioTuningToPeer('nobody'); return false; } catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });
});

test.describe('camera bitrate on this device', () => {
  test('a desktop gets the full ceiling', async ({ page }) => {
    const seen = await page.evaluate(() => ({
      cap: cameraMaxBitrate(),
      full: CAMERA_MAX_BITRATE,
      mobile: IS_MOBILE_DEVICE,
    }));
    expect(seen.mobile).toBe(false);
    expect(seen.cap).toBe(seen.full);
  });

  test('resolution scales down as the room grows', async ({ page }) => {
    expect(await callFn(page, 'videoScaleForPeerCount', 2)).toBe(1);
    expect(await callFn(page, 'videoScaleForPeerCount', 4)).toBe(1.5);
    expect(await callFn(page, 'videoScaleForPeerCount', 9)).toBe(2);
  });
});

test.describe('a device snapshot', () => {
  test('always resolves, with every section present', async ({ page }) => {
    const info = await page.evaluate(() => collectDeviceInfo());
    expect(info).toHaveProperty('device');
    expect(info).toHaveProperty('audio');
    expect(info).toHaveProperty('network');
    expect(typeof info.device.os).toBe('string');
    expect(typeof info.device.setup).toBe('string');
  });

  test('resolves even when every probe underneath it fails', async ({ page }) => {
    const info = await page.evaluate(async () => {
      navigator.getBattery = () => Promise.reject(new Error('no battery'));
      const original = Object.getOwnPropertyDescriptor(Navigator.prototype, 'mediaDevices');
      Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
      const out = await collectDeviceInfo();
      delete navigator.mediaDevices;
      if (original) Object.defineProperty(Navigator.prototype, 'mediaDevices', original);
      return out;
    });
    expect(info).toHaveProperty('device');
    expect(info.network.battery).toMatchObject({ present: false });
  });

  test('the audio section reads the live capture track', async ({ page }) => {
    const info = await page.evaluate(() => {
      audioTrack = {
        label: 'Studio USB Mic',
        getSettings: () => ({ sampleRate: 48000, channelCount: 1, volume: 0.5 }),
      };
      const out = _collectAudioInfo();
      audioTrack = null;
      return out;
    });
    expect(info.micName).toBe('Studio USB Mic');
    expect(info.micConnection).toBe('USB');
    expect(info.sampleRate).toBe(48000);
    expect(info.channels).toBe(1);
    expect(info.volume).toBe(0.5);
  });

  test('with no capture track it reports nothing rather than guessing', async ({ page }) => {
    const info = await page.evaluate(() => {
      audioTrack = null;
      stream = null;
      return _collectAudioInfo();
    });
    expect(info.micName).toBe(null);
    expect(info.micConnection).toBe(null);
  });
});

test.describe('a name the host forces on you', () => {
  test('a manual name is replaced, and remembered for the way out', async ({ page }) => {
    const seen = await page.evaluate(() => {
      myPseudo = 'Ada';
      _preRenameMyPseudo = null;
      applyAssignedSelfProfile('Ada 2', null);
      return { myPseudo, restoreTo: _preRenameMyPseudo };
    });
    expect(seen).toEqual({ myPseudo: 'Ada 2', restoreTo: 'Ada' });
  });

  test('being assigned the name you already asked for changes nothing', async ({ page }) => {
    const seen = await page.evaluate(() => {
      myPseudo = 'Ada';
      _preRenameMyPseudo = null;
      applyAssignedSelfProfile('Ada', null);
      return { myPseudo, restoreTo: _preRenameMyPseudo };
    });
    expect(seen).toEqual({ myPseudo: 'Ada', restoreTo: null });
  });

  test('an anonymous identity is renamed in place, colour and all', async ({ page }) => {
    const seen = await page.evaluate(() => {
      myPseudo = '';
      _anonymousProfile = null;
      _preRenameAnonPseudo = null;
      ensureAnonymousProfile();
      const before = _anonymousProfile.pseudo;
      applyAssignedSelfProfile('Teal Otter 2', '#14b8a6');
      return {
        changed: _anonymousProfile.pseudo !== before,
        pseudo: _anonymousProfile.pseudo,
        color: _anonymousProfile.pseudoColor,
        restoreTo: _preRenameAnonPseudo,
      };
    });
    expect(seen.changed).toBe(true);
    expect(seen.pseudo).toBe('Teal Otter 2');
    expect(seen.color).toBe('#14b8a6');
    expect(seen.restoreTo).toBeTruthy();
  });

  test('a blank assignment is ignored', async ({ page }) => {
    const pseudo = await page.evaluate(() => {
      myPseudo = 'Ada';
      applyAssignedSelfProfile('   ', null);
      applyAssignedSelfProfile(null, null);
      return myPseudo;
    });
    expect(pseudo).toBe('Ada');
  });
});

test.describe('starting a join from an invite', () => {
  test('a peer id goes straight to the room', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      const uuid = '11111111-2222-3333-4444-555555555555';
      window.__joined = [];
      window.joinRoom = (c) => { window.__joined.push(['joinRoom', c]); return Promise.resolve(); };
      window.joinOrCreateByChannelName = (c) => { window.__joined.push(['byName', c]); return Promise.resolve(); };
      startInviteRoomJoin(uuid);
      await new Promise((r) => setTimeout(r, 20));
      return { joined: window.__joined, screen: document.querySelector('.screen.active').id };
    });
    expect(seen.joined).toEqual([['joinRoom', '11111111-2222-3333-4444-555555555555']]);
    expect(seen.screen).toBe('screen-invite-loading');
  });

  test('a named code goes through create-or-join', async ({ page }) => {
    const joined = await page.evaluate(async () => {
      window.__joined = [];
      window.joinOrCreateByChannelName = (c) => { window.__joined.push(c); return Promise.resolve(); };
      startInviteRoomJoin('happy-otter');
      await new Promise((r) => setTimeout(r, 20));
      return window.__joined;
    });
    expect(joined).toEqual(['happy-otter']);
  });

  test('a blank code does nothing at all', async ({ page }) => {
    const joined = await page.evaluate(async () => {
      window.__joined = [];
      window.joinRoom = (c) => { window.__joined.push(c); return Promise.resolve(); };
      window.joinOrCreateByChannelName = (c) => { window.__joined.push(c); return Promise.resolve(); };
      startInviteRoomJoin('   ');
      await new Promise((r) => setTimeout(r, 20));
      return window.__joined;
    });
    expect(joined).toEqual([]);
  });

  test('a failure is reported, but a cancellation is not', async ({ page }) => {
    await page.evaluate(async () => {
      window.joinOrCreateByChannelName = () => Promise.reject(new Error('Connection cancelled.'));
      startInviteRoomJoin('happy-otter');
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(await page.evaluate(() =>
      document.getElementById('screen-error').classList.contains('active'))).toBe(false);

    await page.evaluate(async () => {
      window.joinOrCreateByChannelName = () => Promise.reject(new Error('that room is gone'));
      startInviteRoomJoin('happy-otter');
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(await page.locator('#error-message').textContent()).toBe('that room is gone');
  });
});
