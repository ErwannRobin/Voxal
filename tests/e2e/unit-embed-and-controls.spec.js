import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// Three things that only exist through a real event: the commands an embedding
// page sends over postMessage, the pointer path on the push-to-talk button, and
// the settings controls that are wired up at load rather than called directly.

test.describe('commands from the embedding page', () => {
  /** Run the app inside a same-origin iframe so its message listener is live. */
  async function embed(page, query) {
    await page.goto('/');
    const name = 'vox-' + Math.random().toString(36).slice(2, 8);
    await page.evaluate(({ name, query }) => new Promise((resolve) => {
      const f = document.createElement('iframe');
      f.name = name;
      f.allow = 'camera; microphone';
      f.src = '/' + (query || '');
      f.addEventListener('load', () => resolve());
      document.body.appendChild(f);
    }), { name, query });
    const frame = page.frame({ name });
    await expect.poll(async () => frame.evaluate(() => typeof fetchIceServers)).toBe('function');
    return { frame, name };
  }

  function post(page, name, msg) {
    return page.evaluate(({ name, msg }) => {
      document.querySelector(`iframe[name="${name}"]`).contentWindow.postMessage(msg, '*');
    }, { name, msg });
  }

  test('an auth command signs the embed in', async ({ page }) => {
    const { frame, name } = await embed(page, '');
    await frame.evaluate(() => {
      // Org lookup would hit the network; the token is what matters here.
      window.selectOrgAndStartPolling = () => Promise.resolve();
    });
    await post(page, name, { type: 'auth', token: 'tok-embed', orgId: 'org-embed' });
    await expect.poll(async () => frame.evaluate(() => localStorage.getItem('presence-api-token')))
      .toBe('tok-embed');
    expect(await frame.evaluate(() => localStorage.getItem('presence-org-id'))).toBe('org-embed');
  });

  test('a join command joins the room it names', async ({ page }) => {
    const { frame, name } = await embed(page, '');
    await frame.evaluate(() => {
      window.__joined = [];
      window.joinRoom = (code) => { window.__joined.push(code); return Promise.resolve(); };
    });
    await post(page, name, { type: 'join', roomCode: 'embedded-room' });
    await expect.poll(async () => frame.evaluate(() => window.__joined)).toEqual(['embedded-room']);
  });

  test('a create command starts a room, carrying the channel name', async ({ page }) => {
    const { frame, name } = await embed(page, '');
    await frame.evaluate(() => {
      window.__created = 0;
      window.createRoom = () => { window.__created++; return Promise.resolve(); };
    });
    await post(page, name, { type: 'create', channelName: 'Standup', roomCode: 'standup-room' });
    await expect.poll(async () => frame.evaluate(() => window.__created)).toBe(1);
    expect(await frame.evaluate(() => activeChannel)).toBe('Standup');
    expect(await frame.evaluate(() => activeChannelRoomId)).toBe('standup-room');
  });

  test('a leave command only acts when there is a room to leave', async ({ page }) => {
    const { frame, name } = await embed(page, '');
    await frame.evaluate(() => {
      window.__left = 0;
      window.leaveRoom = () => { window.__left++; };
      inRoom = false;
    });
    await post(page, name, { type: 'leave' });
    await page.waitForTimeout(150);
    expect(await frame.evaluate(() => window.__left)).toBe(0);

    await frame.evaluate(() => { inRoom = true; });
    await post(page, name, { type: 'leave' });
    await expect.poll(async () => frame.evaluate(() => window.__left)).toBe(1);
  });

  test('a key command drives push-to-talk from the parent page', async ({ page }) => {
    const { frame, name } = await embed(page, '');
    await frame.evaluate(() => {
      window.__talking = [];
      window.setTalking = (v) => window.__talking.push(v);
    });
    await post(page, name, { type: 'key', source: 'voxal-parent', code: 'Space', down: true });
    await post(page, name, { type: 'key', source: 'voxal-parent', code: 'Space', down: false });
    await expect.poll(async () => frame.evaluate(() => window.__talking)).toEqual([true, false]);
  });

  test('a key command that is not ours is ignored', async ({ page }) => {
    const { frame, name } = await embed(page, '');
    await frame.evaluate(() => {
      window.__talking = [];
      window.setTalking = (v) => window.__talking.push(v);
    });
    await post(page, name, { type: 'key', code: 'Space', down: true }); // no source
    await post(page, name, { type: 'key', source: 'someone-else', code: 'Space', down: true });
    await page.waitForTimeout(150);
    expect(await frame.evaluate(() => window.__talking)).toEqual([]);
  });

  test('a message that is not an object at all is ignored', async ({ page }) => {
    const { frame, name } = await embed(page, '');
    await post(page, name, 'just a string');
    await post(page, name, null);
    await page.waitForTimeout(150);
    // Still alive and answering.
    expect(await frame.evaluate(() => typeof fetchIceServers)).toBe('function');
  });

  test('the embed announces itself as ready to its parent', async ({ page }) => {
    await page.goto('/');
    const got = await page.evaluate(() => new Promise((resolve) => {
      const seen = [];
      window.addEventListener('message', (e) => {
        if (e.data && e.data.source === 'voxal') seen.push(e.data.type);
      });
      const f = document.createElement('iframe');
      f.src = '/';
      document.body.appendChild(f);
      setTimeout(() => resolve(seen), 2000);
    }));
    expect(got).toContain('ready');
  });
});

test.describe('the push-to-talk button', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await seedRoom(page, { selfId: 'self', isHost: true });
    await page.evaluate(() => {
      stream = new MediaStream();
      audioTrack = { enabled: false };
      freeHandMode = false;
      isTalking = false;
      showScreen('room');
    });
  });

  /** Dispatch a pointer event the button's handlers understand. */
  async function pointer(page, type, id = 1) {
    await page.evaluate(({ type, id }) => {
      const btn = document.getElementById('ptt-btn');
      btn.setPointerCapture = () => {};
      btn.releasePointerCapture = () => {};
      btn.dispatchEvent(new PointerEvent(type, {
        pointerId: id, button: 0, bubbles: true, cancelable: true,
      }));
    }, { type, id });
  }

  test('holding it transmits, releasing stops', async ({ page }) => {
    await pointer(page, 'pointerdown');
    expect(await page.evaluate(() => isTalking)).toBe(true);
    await pointer(page, 'pointerup');
    expect(await page.evaluate(() => isTalking)).toBe(false);
  });

  test('a double tap latches hands-free', async ({ page }) => {
    await pointer(page, 'pointerdown');
    await pointer(page, 'pointerup');
    await pointer(page, 'pointerdown');
    expect(await page.evaluate(() => freeHandMode)).toBe(true);
    await pointer(page, 'pointerup');
    expect(await page.evaluate(() => freeHandMode)).toBe(true);
  });

  test('a press while hands-free is a visual cue only', async ({ page }) => {
    await page.evaluate(() => { freeHandMode = true; });
    await pointer(page, 'pointerdown');
    const seen = await page.evaluate(() => ({
      active: document.getElementById('ptt-btn').classList.contains('active'),
      talking: isTalking,
    }));
    // The mic is already live in hands-free; the press must not re-toggle it.
    expect(seen.active).toBe(true);
    expect(seen.talking).toBe(false);
    await pointer(page, 'pointerup');
    expect(await page.evaluate(() => freeHandMode)).toBe(false);
  });

  test('a cancelled pointer stops transmitting too', async ({ page }) => {
    await pointer(page, 'pointerdown');
    expect(await page.evaluate(() => isTalking)).toBe(true);
    await pointer(page, 'pointercancel');
    expect(await page.evaluate(() => isTalking)).toBe(false);
  });

  test('the hands-free button toggles the same state', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const btn = document.getElementById('btn-freehand');
      btn.click();
      const on = { free: freeHandMode, pressed: btn.getAttribute('aria-pressed') };
      btn.click();
      return { on, off: freeHandMode };
    });
    expect(seen.on).toEqual({ free: true, pressed: 'true' });
    expect(seen.off).toBe(false);
  });
});

test.describe('settings controls wired at load', () => {
  async function openSettings(page) {
    await page.click('#btn-open-settings');
    await page.evaluate(() => {
      document.querySelectorAll('#modal-settings details').forEach((d) => { d.open = true; });
      document.querySelectorAll('#modal-settings .settings-card').forEach((c) => {
        c.classList.remove('is-collapsed');
        c.style.display = 'block';
      });
    });
  }

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('leaving the token field loads the organisations', async ({ page }) => {
    await openSettings(page);
    const seen = await page.evaluate(async () => {
      window.fetch = () => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ organisations: [{ id: 'org-a', name: 'Alpha', role: 'admin' }] }),
      });
      localStorage.setItem('presence-api-token', 'tok');
      const input = document.getElementById('input-presence-token');
      input.value = 'tok';
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
      stopPresencePolling();
      return {
        html: document.getElementById('select-presence-org').innerHTML,
        status: document.getElementById('org-load-status').textContent,
        stored: localStorage.getItem('presence-org-id'),
      };
    });
    expect(seen.html).toContain('Alpha ★');
    expect(seen.status).toBe('');
    expect(seen.stored).toBe('org-a');
  });

  test('Enter in the token field loads them too', async ({ page }) => {
    await openSettings(page);
    const html = await page.evaluate(async () => {
      window.fetch = () => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ organisations: [{ id: 'org-b', name: 'Beta' }] }),
      });
      localStorage.setItem('presence-api-token', 'tok');
      const input = document.getElementById('input-presence-token');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
      stopPresencePolling();
      return document.getElementById('select-presence-org').innerHTML;
    });
    expect(html).toContain('Beta');
  });

  test('a failed org load says why, in place of the list', async ({ page }) => {
    await openSettings(page);
    const status = await page.evaluate(async () => {
      window.fetch = () => Promise.reject(new Error('presence is down'));
      localStorage.setItem('presence-api-token', 'tok');
      document.getElementById('input-presence-token').dispatchEvent(new Event('blur', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
      return document.getElementById('org-load-status').textContent;
    });
    expect(status).toBe('presence is down');
  });

  test('the relay servers popover lists what was verified', async ({ page }) => {
    await openSettings(page);
    const seen = await page.evaluate(async () => {
      window.fetch = () => Promise.resolve({
        ok: true,
        json: () => Promise.resolve([{ urls: 'turn:a:3478' }, { urls: ['turn:b:3478', 'turns:b:5349'] }]),
      });
      document.getElementById('input-metered-app').value = 'app';
      document.getElementById('input-metered-key').value = 'key';
      document.getElementById('btn-test-turn').click();
      await new Promise((r) => setTimeout(r, 60));
      const status = document.getElementById('turn-test-status');
      status.dispatchEvent(new MouseEvent('mouseenter'));
      const pop = document.getElementById('turn-servers-popover');
      const shown = { html: pop.innerHTML, hidden: pop.classList.contains('hidden') };
      status.dispatchEvent(new MouseEvent('mouseleave'));
      return { shown, hiddenAfter: pop.classList.contains('hidden') };
    });
    expect(seen.shown.hidden).toBe(false);
    expect(seen.shown.html).toContain('turn:a:3478');
    expect(seen.shown.html).toContain('turns:b:5349');
    expect(seen.hiddenAfter).toBe(true);
  });

  test('disconnecting clears the account and its org', async ({ page }) => {
    await openSettings(page);
    const seen = await page.evaluate(() => {
      window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      localStorage.setItem('presence-api-token', 'tok');
      localStorage.setItem('presence-org-id', 'org');
      document.getElementById('btn-disconnect').click();
      return {
        token: localStorage.getItem('presence-api-token'),
        org: localStorage.getItem('presence-org-id'),
        field: document.getElementById('input-presence-token').value,
        orgDisabled: document.getElementById('select-presence-org').disabled,
      };
    });
    expect(seen).toEqual({ token: null, org: null, field: '', orgDisabled: true });
  });

  test('the diagnostics-sharing toggle writes an explicit choice', async ({ page }) => {
    await openSettings(page);
    const seen = await page.evaluate(() => {
      const el = document.getElementById('toggle-device-share-modal');
      if (!el) return null;
      setDeviceInfoConsent('declined');
      syncDeviceShareToggles();
      const before = el.textContent;
      el.click();
      const after = { consent: deviceInfoConsent(), label: el.textContent };
      return { before, after };
    });
    if (seen) {
      expect(seen.before).toBe('OFF');
      expect(seen.after).toEqual({ consent: 'accepted', label: 'ON' });
    }
  });

  test('the mic-hint toggle writes its preference both ways', async ({ page }) => {
    await openSettings(page);
    const seen = await page.evaluate(() => {
      const el = document.getElementById('toggle-mic-hint-modal');
      if (!el) return null;
      setMicHintEnabled(true);
      syncMicHintToggle();
      el.click();
      const off = { enabled: micHintEnabled(), stored: localStorage.getItem('mic-hint-dismissed') };
      el.click();
      return { off, on: micHintEnabled() };
    });
    if (seen) {
      expect(seen.off.enabled).toBe(false);
      expect(seen.off.stored).toBeTruthy();
      expect(seen.on).toBe(true);
    }
  });
});

test.describe('the dev log panel controls', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('dev-mode', 'true');
      updateDevLogPanel();
      devLog('a line worth copying');
    });
  });

  test('copying takes the whole panel', async ({ page }) => {
    const copied = await page.evaluate(async () => {
      const seen = [];
      navigator.clipboard.writeText = (t) => { seen.push(t); return Promise.resolve(); };
      const btn = document.getElementById('btn-copy-dev-log');
      if (!btn) return null;
      btn.click();
      await new Promise((r) => setTimeout(r, 20));
      return seen;
    });
    if (copied) {
      expect(copied).toHaveLength(1);
      expect(copied[0]).toContain('a line worth copying');
    }
  });

  test('clearing empties it', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const btn = document.getElementById('btn-clear-dev-log');
      if (!btn) return null;
      btn.click();
      return document.getElementById('dev-log-entries').children.length;
    });
    if (seen !== null) expect(seen).toBe(0);
  });
});

test.describe('the screen viewer pop-out', () => {
  test('uses Picture-in-Picture where the browser offers it', async ({ page }) => {
    await page.goto('/');
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1', pseudo: 'Ada' }] });
    const seen = await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 320; c.height = 240;
      c.getContext('2d').fillRect(0, 0, 1, 1);
      connections.get('p1').remoteScreenStream = c.captureStream(5);
      openScreenViewer('p1');
      const vid = document.getElementById('screen-viewer-element');
      let asked = false;
      Object.defineProperty(document, 'pictureInPictureEnabled', { value: true, configurable: true });
      vid.requestPictureInPicture = () => { asked = true; return Promise.resolve(); };
      popOutScreenViewer();
      await new Promise((r) => setTimeout(r, 10));
      return { asked, pip: document.getElementById('screen-viewer-panel').classList.contains('pip-active') };
    });
    expect(seen).toEqual({ asked: true, pip: true });
  });

  test('says so where the browser has no Picture-in-Picture', async ({ page }) => {
    await page.goto('/');
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1', pseudo: 'Ada' }] });
    await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 320; c.height = 240;
      c.getContext('2d').fillRect(0, 0, 1, 1);
      connections.get('p1').remoteScreenStream = c.captureStream(5);
      openScreenViewer('p1');
      const vid = document.getElementById('screen-viewer-element');
      Object.defineProperty(document, 'pictureInPictureEnabled', { value: false, configurable: true });
      vid.requestPictureInPicture = undefined;
      popOutScreenViewer();
    });
    await expect(page.locator('#copy-toast')).toHaveText('Picture-in-Picture not available');
  });

  test('a rejected request reports the failure', async ({ page }) => {
    await page.goto('/');
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1', pseudo: 'Ada' }] });
    const pip = await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 320; c.height = 240;
      c.getContext('2d').fillRect(0, 0, 1, 1);
      connections.get('p1').remoteScreenStream = c.captureStream(5);
      openScreenViewer('p1');
      const vid = document.getElementById('screen-viewer-element');
      Object.defineProperty(document, 'pictureInPictureEnabled', { value: true, configurable: true });
      vid.requestPictureInPicture = () => Promise.reject(new Error('denied'));
      popOutScreenViewer();
      await new Promise((r) => setTimeout(r, 20));
      return document.getElementById('screen-viewer-panel').classList.contains('pip-active');
    });
    expect(pip).toBe(false);
    await expect(page.locator('#copy-toast')).toHaveText('Picture-in-Picture not available');
  });
});

test.describe('microphone connection guessing', () => {
  test('reads the connection type out of the device label', async ({ page }) => {
    await page.goto('/');
    const seen = await page.evaluate(() => ({
      bluetooth: _guessMicConnection('AirPods Pro'),
      usb: _guessMicConnection('Yeti USB Microphone'),
      builtin: _guessMicConnection('MacBook Pro Microphone'),
      other: _guessMicConnection('Some Interface Input 1'),
      none: _guessMicConnection(''),
    }));
    expect(seen.bluetooth).toBe('Bluetooth');
    expect(seen.usb).toBe('USB');
    expect(seen.builtin).toBe('Built-in');
    expect(seen.other).toBe('Wired / other');
    expect(seen.none).toBe(null);
  });
});
