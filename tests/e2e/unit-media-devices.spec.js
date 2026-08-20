import { test, expect } from './fixtures.js';
import { callFn } from './_helpers.js';

// The Settings → Audio/Video hardware controls: the device pickers, the mic
// level test, the camera preview and the speaker chime. Headless Chromium has
// no capture hardware, so every test hands `getUserMedia` a synthetic stream —
// a real MediaStream with a real track, just one the machine generated.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    window.__gumCalls = [];
    window.__gumFail = null;
    window.__liveStreams = [];

    window.__mkAudioStream = function() {
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      const osc = ctx.createOscillator();
      osc.connect(dest);
      osc.start();
      return dest.stream;
    };
    window.__mkVideoStream = function() {
      const c = document.createElement('canvas');
      c.width = 320; c.height = 240;
      c.getContext('2d').fillRect(0, 0, 1, 1);
      return c.captureStream(5);
    };

    navigator.mediaDevices.getUserMedia = function(constraints) {
      window.__gumCalls.push(constraints);
      if (window.__gumFail) return Promise.reject(window.__gumFail);
      const s = constraints && constraints.video ? window.__mkVideoStream() : window.__mkAudioStream();
      window.__liveStreams.push(s);
      return Promise.resolve(s);
    };
  });
});

test.describe('device selection', () => {
  test('each picker reads its own stored id', async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem('mic-device-id', 'mic-1');
      localStorage.setItem('camera-device-id', 'cam-1');
      localStorage.setItem('speaker-device-id', 'spk-1');
    });
    expect(await callFn(page, 'selectedMicDeviceId')).toBe('mic-1');
    expect(await callFn(page, 'selectedCameraDeviceId')).toBe('cam-1');
    expect(await callFn(page, 'selectedSpeakerDeviceId')).toBe('spk-1');
  });

  test('with nothing stored, every picker is empty', async ({ page }) => {
    const seen = await page.evaluate(() => {
      ['mic-device-id', 'camera-device-id', 'speaker-device-id'].forEach((k) => localStorage.removeItem(k));
      return [selectedMicDeviceId(), selectedCameraDeviceId(), selectedSpeakerDeviceId()];
    });
    expect(seen).toEqual(['', '', '']);
  });

  test('a chosen microphone becomes an exact constraint', async ({ page }) => {
    const seen = await page.evaluate(() => {
      localStorage.setItem('mic-device-id', 'mic-1');
      const withId = selectedMicConstraints();
      localStorage.removeItem('mic-device-id');
      return { withId, without: selectedMicConstraints() };
    });
    expect(seen.withId).toEqual({ deviceId: { exact: 'mic-1' } });
    expect(seen.without).toEqual({});
  });

  test('setDeviceSelectOptions labels, escapes and selects', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const sel = document.createElement('select');
      setDeviceSelectOptions(sel, [
        { deviceId: 'a', label: 'Built-in <Mic> & Co' },
        { deviceId: 'b', label: '' },
      ], 'b', 'Microphone', {});
      return { html: sel.innerHTML, value: sel.value };
    });
    expect(seen.html).toContain('System default');
    // A label is peer/OS-supplied text, so it is escaped rather than injected.
    expect(seen.html).toContain('Built-in &lt;Mic&gt; &amp; Co');
    // An unlabelled device falls back to a numbered placeholder.
    expect(seen.html).toContain('Microphone 2');
    expect(seen.value).toBe('b');
  });

  test('a remembered label stands in when the browser withholds one', async ({ page }) => {
    const html = await page.evaluate(() => {
      const sel = document.createElement('select');
      setDeviceSelectOptions(sel, [{ deviceId: 'a', label: '' }], '', 'Microphone', { a: 'Remembered Mic' });
      return sel.innerHTML;
    });
    expect(html).toContain('Remembered Mic');
  });

  test('a stored id that is no longer plugged in falls back to the default', async ({ page }) => {
    const value = await page.evaluate(() => {
      const sel = document.createElement('select');
      setDeviceSelectOptions(sel, [{ deviceId: 'a', label: 'A' }], 'unplugged', 'Microphone', {});
      return sel.value;
    });
    expect(value).toBe('');
  });

  test('a null select is simply ignored', async ({ page }) => {
    const threw = await page.evaluate(() => {
      try { setDeviceSelectOptions(null, [], '', 'x', {}); return false; } catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });

  test('device labels survive a round trip through storage', async ({ page }) => {
    const seen = await page.evaluate(() => {
      writeStoredDeviceLabels({ 'dev-1': 'Studio Mic' });
      const read = readStoredDeviceLabels();
      localStorage.setItem('media-device-labels', '{not json');
      return { read, corrupted: readStoredDeviceLabels() };
    });
    expect(seen.read).toEqual({ 'dev-1': 'Studio Mic' });
    expect(seen.corrupted).toEqual({});
  });

  test('refreshMediaDeviceSelectors fills the pickers from the device list', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      navigator.mediaDevices.enumerateDevices = () => Promise.resolve([
        { kind: 'audioinput', deviceId: 'mic-a', label: 'Mic A' },
        { kind: 'videoinput', deviceId: 'cam-a', label: 'Cam A' },
        { kind: 'audiooutput', deviceId: 'spk-a', label: 'Speaker A' },
      ]);
      await refreshMediaDeviceSelectors();
      return {
        mic: document.getElementById('select-mic-device').innerHTML,
        cam: document.getElementById('select-camera-device').innerHTML,
        remembered: readStoredDeviceLabels(),
      };
    });
    expect(seen.mic).toContain('Mic A');
    expect(seen.cam).toContain('Cam A');
    // Labels are cached so they still read correctly before permission is granted.
    expect(seen.remembered).toMatchObject({ 'mic-a': 'Mic A' });
  });

  test('an enumerate failure leaves the pickers alone instead of throwing', async ({ page }) => {
    const threw = await page.evaluate(async () => {
      navigator.mediaDevices.enumerateDevices = () => Promise.reject(new Error('denied'));
      try { await refreshMediaDeviceSelectors(); return false; } catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });
});

test.describe('camera constraints', () => {
  test('capture is capped, and never with exact dimensions', async ({ page }) => {
    const c = await page.evaluate(() => {
      localStorage.removeItem('camera-device-id');
      return selectedCameraConstraints();
    });
    expect(c.width).toEqual({ ideal: 1280, max: 1280 });
    expect(c.height).toEqual({ ideal: 720, max: 720 });
    expect(c.frameRate).toEqual({ ideal: 30, max: 30 });
    expect(JSON.stringify(c)).not.toContain('exact');
    expect(c.facingMode).toBe('user');
  });

  test('a chosen camera is pinned alongside the cap', async ({ page }) => {
    const c = await page.evaluate(() => {
      localStorage.setItem('camera-device-id', 'cam-9');
      const out = selectedCameraConstraints();
      localStorage.removeItem('camera-device-id');
      return out;
    });
    expect(c.deviceId).toEqual({ exact: 'cam-9' });
    expect(c.width).toEqual({ ideal: 1280, max: 1280 });
  });
});

test.describe('the microphone test', () => {
  test('starting captures, records and shows the level meter', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      await startMicTest();
      const out = {
        capturing: !!_micTestStream,
        constraints: window.__gumCalls[0],
        button: document.getElementById('btn-test-mic').textContent,
        meterHidden: document.getElementById('mic-test-level-fill').closest('.media-level').classList.contains('hidden'),
      };
      await stopMicTest();
      return out;
    });
    expect(seen.capturing).toBe(true);
    expect(seen.constraints.audio.echoCancellation).toBe(true);
    expect(seen.constraints.video).toBe(false);
    expect(seen.button).toBe('Stop & Replay');
    expect(seen.meterHidden).toBe(false);
  });

  test('the chosen microphone is the one it opens', async ({ page }) => {
    const constraints = await page.evaluate(async () => {
      localStorage.setItem('mic-device-id', 'mic-7');
      await startMicTest();
      const out = window.__gumCalls[0];
      await stopMicTest();
      localStorage.removeItem('mic-device-id');
      return out;
    });
    expect(constraints.audio.deviceId).toEqual({ exact: 'mic-7' });
  });

  test('stopping releases the microphone and resets the button', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      await startMicTest();
      const track = _micTestStream.getAudioTracks()[0];
      await stopMicTest();
      return {
        stream: _micTestStream,
        ctx: _micTestCtx,
        analyser: _micTestAnalyser,
        trackLive: track.readyState === 'live',
        button: document.getElementById('btn-test-mic').textContent,
        width: document.getElementById('mic-test-level-fill').style.width,
      };
    });
    expect(seen).toEqual({
      stream: null, ctx: null, analyser: null, trackLive: false, button: 'Test', width: '0%',
    });
  });

  test('stopping with replay offers the recording back', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      await startMicTest();
      await new Promise((r) => setTimeout(r, 250));
      await stopMicTest({ replay: true });
      const audio = document.getElementById('mic-test-playback');
      return { hidden: audio.classList.contains('hidden'), hasSrc: !!audio.getAttribute('src') };
    });
    // MediaRecorder may produce nothing at all in a headless run; what matters
    // is that the two outcomes stay consistent with each other.
    expect(seen.hidden).toBe(!seen.hasSrc);
  });

  test('stopping with no test running is harmless', async ({ page }) => {
    const threw = await page.evaluate(async () => {
      try { await stopMicTest(); await stopMicTest({ replay: true }); return false; } catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });

  test('the toggle starts, then stops and replays', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      await toggleMicTest();
      const running = !!_micTestStream;
      await toggleMicTest();
      return { running, stopped: !_micTestStream };
    });
    expect(seen).toEqual({ running: true, stopped: true });
  });

  test('a refused microphone reports the failure rather than throwing', async ({ page }) => {
    await page.evaluate(async () => {
      window.__gumFail = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
      await toggleMicTest();
    });
    await expect(page.locator('#copy-toast')).toHaveText('Microphone test failed');
  });

  test('clearMicTestPlayback releases the object URL it handed out', async ({ page }) => {
    const seen = await page.evaluate(() => {
      renderMicTestPlayback(new Blob(['abc'], { type: 'audio/webm' }));
      const during = { url: _micTestPlaybackUrl, hidden: document.getElementById('mic-test-playback').classList.contains('hidden') };
      clearMicTestPlayback();
      return { during, after: _micTestPlaybackUrl };
    });
    expect(seen.during.url).not.toBe('');
    expect(seen.during.hidden).toBe(false);
    expect(seen.after).toBe('');
  });

  test('an empty recording is not offered for playback', async ({ page }) => {
    const hidden = await page.evaluate(() => {
      renderMicTestPlayback(new Blob([], { type: 'audio/webm' }));
      return document.getElementById('mic-test-playback').classList.contains('hidden');
    });
    expect(hidden).toBe(true);
  });
});

test.describe('the camera preview', () => {
  test('starting shows the video, stopping releases the camera', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      await startCameraPreview();
      const video = document.getElementById('camera-preview-video');
      const during = {
        streaming: !!_cameraPreviewStream,
        shown: !video.classList.contains('hidden'),
        button: document.getElementById('btn-preview-camera').textContent,
      };
      const track = _cameraPreviewStream.getVideoTracks()[0];
      stopCameraPreview();
      return {
        during,
        after: {
          stream: _cameraPreviewStream,
          hidden: video.classList.contains('hidden'),
          srcObject: video.srcObject,
          trackLive: track.readyState === 'live',
          button: document.getElementById('btn-preview-camera').textContent,
        },
      };
    });
    expect(seen.during).toEqual({ streaming: true, shown: true, button: 'Stop Preview' });
    expect(seen.after).toEqual({
      stream: null, hidden: true, srcObject: null, trackLive: false, button: 'Preview',
    });
  });

  test('the toggle flips between the two', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      await toggleCameraPreview();
      const on = !!_cameraPreviewStream;
      await toggleCameraPreview();
      return { on, off: !_cameraPreviewStream };
    });
    expect(seen).toEqual({ on: true, off: true });
  });

  test('a refused camera explains what to do about it', async ({ page }) => {
    await page.evaluate(async () => {
      window.__gumFail = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
      await toggleCameraPreview();
    });
    const toast = await page.locator('#copy-toast').textContent();
    expect(toast.length).toBeGreaterThan(0);
  });

  test('cameraAccessHint separates a blocked camera from a broken one', async ({ page }) => {
    const seen = await page.evaluate(() => ({
      denied: cameraAccessHint({ name: 'NotAllowedError' }),
      policy: cameraAccessHint({ name: 'SecurityError', message: 'permissions policy' }),
      other: cameraAccessHint({ name: 'NotFoundError', message: 'no camera' }),
      nothing: cameraAccessHint(null),
    }));
    expect(seen.denied).toBe('Camera access was blocked by the browser.');
    expect(seen.policy).toBe('Camera access was blocked by the browser.');
    expect(seen.other).toBe('Camera access failed');
    expect(seen.nothing).toBe('Camera access failed');
  });
});

test.describe('the speaker test', () => {
  test('plays the chime and clears its status afterwards', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      const statusEl = document.getElementById('speaker-test-status');
      await testSpeakerOutput();
      const during = statusEl.textContent;
      await new Promise((r) => setTimeout(r, 1400));
      return { during, after: statusEl.textContent };
    });
    expect(seen.during).toBe('Playing…');
    expect(seen.after).toBe('');
  });

  test('a refused output device says routing is unavailable', async ({ page }) => {
    const status = await page.evaluate(async () => {
      const proto = Object.getPrototypeOf(new Audio());
      const original = proto.setSinkId;
      proto.setSinkId = () => Promise.reject(new Error('not permitted'));
      localStorage.setItem('speaker-device-id', 'spk-x');
      await testSpeakerOutput();
      const out = document.getElementById('speaker-test-status').textContent;
      if (original) proto.setSinkId = original; else delete proto.setSinkId;
      localStorage.removeItem('speaker-device-id');
      return out;
    });
    expect(status).toBe('Output routing unavailable');
  });
});

test.describe('speaker routing for room audio', () => {
  test('applySpeakerSinkToAllAudio points every element at the chosen output', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      const sinks = [];
      const proto = Object.getPrototypeOf(new Audio());
      const original = proto.setSinkId;
      proto.setSinkId = function(id) { sinks.push(id); return Promise.resolve(); };
      attachAudio('p1', new MediaStream());
      attachAudio('p2', new MediaStream());
      await new Promise((r) => setTimeout(r, 20));
      // Attaching already routes each element; the interesting part is the
      // re-route after the preference changes.
      sinks.length = 0;
      localStorage.setItem('speaker-device-id', 'spk-2');
      applySpeakerSinkToAllAudio();
      await new Promise((r) => setTimeout(r, 20));
      if (original) proto.setSinkId = original; else delete proto.setSinkId;
      localStorage.removeItem('speaker-device-id');
      document.querySelectorAll('audio[id^="audio-"]').forEach((el) => el.remove());
      return sinks;
    });
    expect(seen).toEqual(['spk-2', 'spk-2']);
  });

  test('detachAudio removes the element it created', async ({ page }) => {
    const seen = await page.evaluate(() => {
      attachAudio('p1', new MediaStream());
      const created = !!document.getElementById('audio-p1');
      detachAudio('p1');
      detachAudio('never-existed');
      return { created, removed: !document.getElementById('audio-p1') };
    });
    expect(seen).toEqual({ created: true, removed: true });
  });
});

test.describe('noise suppression', () => {
  test('reads the stored mode, defaulting by device class', async ({ page }) => {
    const seen = await page.evaluate(() => {
      localStorage.removeItem('noise-suppression');
      const dflt = getNoiseSuppressionMode();
      localStorage.setItem('noise-suppression', 'browser');
      const browser = getNoiseSuppressionMode();
      localStorage.setItem('noise-suppression', 'off');
      const off = getNoiseSuppressionMode();
      localStorage.removeItem('noise-suppression');
      return { dflt, browser, off, mobile: IS_MOBILE_DEVICE };
    });
    expect(seen.browser).toBe('browser');
    expect(seen.off).toBe('off');
    // RNNoise's 48 kHz worklet underruns on phones, so mobile defaults to the
    // OS voice processing instead.
    expect(seen.dflt).toBe(seen.mobile ? 'browser' : 'rnnoise');
  });

  test('the radios mirror whichever mode is in force', async ({ page }) => {
    const checked = await page.evaluate(() => {
      localStorage.setItem('noise-suppression', 'off');
      syncNoiseSuppressionControls();
      const out = Array.from(document.querySelectorAll('input[name=\"noise-suppression-mode\"]'))
        .filter((r) => r.checked).map((r) => r.value);
      localStorage.removeItem('noise-suppression');
      return out;
    });
    expect(checked).toEqual(['off']);
  });

  test('applyRNNoise hands the stream straight back when the worklet is not up', async ({ page }) => {
    const same = await page.evaluate(() => {
      _rnnoiseReady = false;
      const s = window.__mkAudioStream();
      return applyRNNoise(s) === s;
    });
    expect(same).toBe(true);
  });

  test('stopMicStreamFully stops a plain stream', async ({ page }) => {
    const live = await page.evaluate(() => {
      const s = window.__mkAudioStream();
      const track = s.getAudioTracks()[0];
      stopMicStreamFully(s);
      stopMicStreamFully(null); // must not throw
      return track.readyState === 'live';
    });
    expect(live).toBe(false);
  });

  test('stopMicStreamFully also stops the real microphone behind an RNNoise graph', async ({ page }) => {
    const seen = await page.evaluate(() => {
      // Stand in for the graph applyRNNoise builds: a destination stream whose
      // real capture is a *separate* stream hanging off it.
      const original = window.__mkAudioStream();
      const dest = window.__mkAudioStream();
      dest._rnnoiseOriginal = original;
      dest._rnnoiseSource = { disconnect() { dest.__srcDisconnected = true; } };
      dest._rnnoiseDest = { disconnect() { dest.__destDisconnected = true; } };
      const outer = dest.getAudioTracks()[0];
      const inner = original.getAudioTracks()[0];
      stopMicStreamFully(dest);
      return {
        outerLive: outer.readyState === 'live',
        innerLive: inner.readyState === 'live',
        srcDisconnected: !!dest.__srcDisconnected,
      };
    });
    expect(seen).toEqual({ outerLive: false, innerLive: false, srcDisconnected: true });
  });
});
