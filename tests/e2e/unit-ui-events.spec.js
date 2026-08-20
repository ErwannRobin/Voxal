import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// The listeners wired up at load: the keyboard push-to-talk path, the settings
// controls that write straight to localStorage, and the `storage` channel the
// desktop preferences window uses to drive the main window (see the
// cross-window command bridge notes in CLAUDE.md).
//
// These are only reachable through real events, so every test dispatches one.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

/**
 * Open the settings modal with everything on screen: the sidebar collapses all
 * but one card, and the relay/advanced controls sit inside a closed <details>.
 */
async function openSettings(page) {
  await page.click('#btn-open-settings');
  await page.evaluate(() => {
    document.querySelectorAll('#modal-settings details').forEach((d) => { d.open = true; });
    document.querySelectorAll('#modal-settings .settings-card').forEach((c) => {
      c.classList.remove('is-collapsed');
      c.style.display = 'block'; // the sidebar shows one card at a time
    });
  });
}

/** Set an input's value and fire the `input` event its listener waits for. */
async function typeInto(page, id, value) {
  await page.evaluate(({ id, value }) => {
    const el = document.getElementById(id);
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, { id, value });
}

/** Dispatch a keydown/keyup on document, the way a real key press arrives. */
async function key(page, type, code, init = {}) {
  await page.evaluate(({ type, code, init }) => {
    document.dispatchEvent(new KeyboardEvent(type, Object.assign({
      code, key: code, bubbles: true, cancelable: true,
    }, init)));
  }, { type, code, init });
}

test.describe('push-to-talk from the keyboard', () => {
  test('space holds the mic open, and releasing closes it', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true });
    await page.evaluate(() => { stream = new MediaStream(); audioTrack = { enabled: false }; freeHandMode = false; isTalking = false; });
    await key(page, 'keydown', 'Space');
    expect(await page.evaluate(() => isTalking)).toBe(true);
    await key(page, 'keyup', 'Space');
    expect(await page.evaluate(() => isTalking)).toBe(false);
  });

  test('double-tapping space latches hands-free, and again releases it', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true });
    await page.evaluate(() => { stream = new MediaStream(); audioTrack = { enabled: false }; freeHandMode = false; });
    await key(page, 'keydown', 'Space');
    await key(page, 'keyup', 'Space');
    await key(page, 'keydown', 'Space'); // second tap, inside the double-tap window
    expect(await page.evaluate(() => freeHandMode)).toBe(true);
    // The keyup that closes the double tap must not immediately undo it.
    await key(page, 'keyup', 'Space');
    expect(await page.evaluate(() => freeHandMode)).toBe(true);
  });

  test('Enter toggles hands-free while in a room', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true });
    await page.evaluate(() => { stream = new MediaStream(); audioTrack = { enabled: false }; freeHandMode = false; });
    await key(page, 'keydown', 'Enter');
    expect(await page.evaluate(() => freeHandMode)).toBe(true);
    await key(page, 'keydown', 'Enter');
    expect(await page.evaluate(() => freeHandMode)).toBe(false);
  });

  test('the configured shortcut talks, and its release stops', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true });
    await page.evaluate(() => { stream = new MediaStream(); audioTrack = { enabled: false }; shortcutStr = 'KeyK'; freeHandMode = false; });
    await key(page, 'keydown', 'KeyK');
    expect(await page.evaluate(() => isTalking)).toBe(true);
    await key(page, 'keyup', 'KeyK');
    expect(await page.evaluate(() => isTalking)).toBe(false);
  });

  test('a bare-modifier shortcut talks on either side of the keyboard', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true });
    await page.evaluate(() => { stream = new MediaStream(); audioTrack = { enabled: false }; shortcutStr = 'Alt'; freeHandMode = false; });
    await key(page, 'keydown', 'AltRight', { altKey: true });
    expect(await page.evaluate(() => isTalking)).toBe(true);
    await key(page, 'keyup', 'AltRight');
    expect(await page.evaluate(() => isTalking)).toBe(false);
  });

  test('while renaming yourself, keys type instead of talking', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true });
    await page.evaluate(() => { stream = new MediaStream(); audioTrack = { enabled: false }; editingSelfPseudo = true; isTalking = false; });
    await key(page, 'keydown', 'Space');
    const seen = await page.evaluate(() => { const v = isTalking; editingSelfPseudo = false; return v; });
    expect(seen).toBe(false);
  });

  test('while recording a shortcut, the next key becomes the shortcut', async ({ page }) => {
    await page.evaluate(() => { startRecordingShortcut(); });
    await key(page, 'keydown', 'KeyJ', { ctrlKey: true });
    const seen = await page.evaluate(() => ({ shortcutStr, recording: recordingShortcut }));
    expect(seen).toEqual({ shortcutStr: 'Ctrl+KeyJ', recording: false });
  });

  test('recording accepts a bare modifier on release', async ({ page }) => {
    await page.evaluate(() => { startRecordingShortcut(); });
    await key(page, 'keyup', 'ShiftLeft');
    const seen = await page.evaluate(() => ({ shortcutStr, recording: recordingShortcut }));
    expect(seen).toEqual({ shortcutStr: 'Shift', recording: false });
  });
});

test.describe('the settings modal swallows the keyboard', () => {
  test('Escape closes it', async ({ page }) => {
    await openSettings(page);
    expect(await page.locator('#modal-settings').isVisible()).toBe(true);
    await key(page, 'keydown', 'Escape', { key: 'Escape' });
    await expect(page.locator('#modal-settings')).toBeHidden();
  });

  test('Enter moves through the credential fields, then closes', async ({ page }) => {
    await openSettings(page);
    await page.evaluate(() => document.getElementById('input-metered-app').focus());
    await key(page, 'keydown', 'Enter', { key: 'Enter' });
    expect(await page.evaluate(() => document.activeElement.id)).toBe('input-metered-key');
    // Enter anywhere outside that chain closes the modal instead of moving on.
    await page.evaluate(() => document.activeElement.blur());
    await key(page, 'keydown', 'Enter', { key: 'Enter' });
    await expect(page.locator('#modal-settings')).toBeHidden();
  });

  test('Tab cycles the credential fields in both directions', async ({ page }) => {
    await openSettings(page);
    await page.evaluate(() => document.getElementById('input-metered-app').focus());
    await key(page, 'keydown', 'Tab', { key: 'Tab' });
    expect(await page.evaluate(() => document.activeElement.id)).toBe('input-metered-key');
    await key(page, 'keydown', 'Tab', { key: 'Tab', shiftKey: true });
    expect(await page.evaluate(() => document.activeElement.id)).toBe('input-metered-app');
  });

  test('push-to-talk is inert while it is open', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true });
    await page.evaluate(() => { stream = new MediaStream(); audioTrack = { enabled: false }; isTalking = false; });
    await openSettings(page);
    await key(page, 'keydown', 'Space');
    expect(await page.evaluate(() => isTalking)).toBe(false);
  });

  test('the close button and the backdrop both dismiss it', async ({ page }) => {
    await openSettings(page);
    await page.click('#btn-close-settings');
    await expect(page.locator('#modal-settings')).toBeHidden();
    await page.click('#btn-open-settings');
    await page.evaluate(() => document.getElementById('modal-backdrop').click());
    await expect(page.locator('#modal-settings')).toBeHidden();
  });
});

test.describe('settings inputs write straight through to storage', () => {
  test('the service URL is stored, and cleared when emptied', async ({ page }) => {
    await openSettings(page);
    await typeInto(page, 'input-service-url', 'https://example.test');
    expect(await page.evaluate(() => localStorage.getItem('service-url'))).toBe('https://example.test');
    await typeInto(page, 'input-service-url', '   ');
    expect(await page.evaluate(() => localStorage.getItem('service-url'))).toBe(null);
  });

  test('metered.ca credentials invalidate the cached relay status', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('metered-status', 'ok'));
    await openSettings(page);
    await typeInto(page, 'input-metered-app', 'myapp');
    await typeInto(page, 'input-metered-key', 'k3y');
    const seen = await page.evaluate(() => ({
      app: localStorage.getItem('metered-app-name'),
      key: localStorage.getItem('metered-api-key'),
      status: localStorage.getItem('metered-status'),
    }));
    expect(seen).toEqual({ app: 'myapp', key: 'k3y', status: null });
  });

  test('typing a presence token resets the org picker', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('presence-org-id', 'org-old'));
    await openSettings(page);
    await typeInto(page, 'input-presence-token', 'tok-123');
    const seen = await page.evaluate(() => ({
      token: localStorage.getItem('presence-api-token'),
      org: localStorage.getItem('presence-org-id'),
      disabled: document.getElementById('select-presence-org').disabled,
    }));
    expect(seen).toEqual({ token: 'tok-123', org: null, disabled: true });
  });

  test('picking an organisation stores it', async ({ page }) => {
    await page.click('#btn-open-settings');
    await page.evaluate(() => {
      const sel = document.getElementById('select-presence-org');
      sel.disabled = false;
      sel.innerHTML = '<option value="org-a">A</option><option value="org-b">B</option>';
      sel.value = 'org-b';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(await page.evaluate(() => localStorage.getItem('presence-org-id'))).toBe('org-b');
  });

  test('the video routing radios drive the stored mode', async ({ page }) => {
    await openSettings(page);
    const stored = await page.evaluate(() => {
      const radios = Array.from(document.querySelectorAll('input[name="video-routing-mode"]'));
      const p2pOnly = radios.find((r) => r.value === 'p2p-only');
      p2pOnly.checked = true;
      p2pOnly.dispatchEvent(new Event('change', { bubbles: true }));
      return localStorage.getItem('video-routing-mode');
    });
    expect(stored).toBe('p2p-only');
  });

  test('the noise-suppression radios drive the stored mode', async ({ page }) => {
    await openSettings(page);
    const stored = await page.evaluate(() => {
      const radios = Array.from(document.querySelectorAll('input[name="noise-suppression-mode"]'));
      const off = radios.find((r) => r.value === 'off');
      off.checked = true;
      off.dispatchEvent(new Event('change', { bubbles: true }));
      return localStorage.getItem('noise-suppression');
    });
    expect(stored).toBe('off');
  });

  test('the speaker picker stores a device and clears on "system default"', async ({ page }) => {
    await openSettings(page);
    const seen = await page.evaluate(() => {
      const sel = document.getElementById('select-speaker-device');
      if (!sel) return null;
      sel.innerHTML = '<option value=""></option><option value="spk-1">Speaker</option>';
      sel.value = 'spk-1';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      const set = localStorage.getItem('speaker-device-id');
      sel.value = '';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return { set, cleared: localStorage.getItem('speaker-device-id') };
    });
    expect(seen).toEqual({ set: 'spk-1', cleared: null });
  });

  test('the dev-mode switch flips the stored flag and its own label', async ({ page }) => {
    await openSettings(page);
    const seen = await page.evaluate(() => {
      const el = document.getElementById('toggle-dev-mode-modal');
      el.click();
      const on = { stored: localStorage.getItem('dev-mode'), label: el.textContent, checked: el.getAttribute('aria-checked') };
      el.click();
      const off = { stored: localStorage.getItem('dev-mode'), label: el.textContent, checked: el.getAttribute('aria-checked') };
      return { on, off };
    });
    expect(seen.on).toEqual({ stored: 'true', label: 'ON', checked: 'true' });
    expect(seen.off).toEqual({ stored: 'false', label: 'OFF', checked: 'false' });
  });

  test('the network-usage summary expands and collapses its panel', async ({ page }) => {
    await openSettings(page);
    const seen = await page.evaluate(() => {
      const el = document.getElementById('net-usage-summary');
      el.click();
      const opened = _netUsageExpanded;
      el.click();
      return { opened, closed: _netUsageExpanded };
    });
    expect(seen).toEqual({ opened: true, closed: false });
  });
});

test.describe('the cross-window storage bridge', () => {
  /** Fire the storage event the desktop preferences window would produce. */
  async function storageEvent(page, key, newValue) {
    await page.evaluate(({ key, newValue }) => {
      if (newValue === null) localStorage.removeItem(key);
      else localStorage.setItem(key, newValue);
      window.dispatchEvent(new StorageEvent('storage', { key, newValue }));
    }, { key, newValue });
  }

  test('a theme change is applied immediately', async ({ page }) => {
    await storageEvent(page, 'theme', 'light');
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('light');
    await storageEvent(page, 'theme', null);
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('system');
  });

  test('a jitter change is mirrored into the in-page controls', async ({ page }) => {
    await storageEvent(page, 'jitter-buffer', '120');
    const seen = await page.evaluate(() => ({
      mode: jitterBufferSetting(),
      radio: document.querySelector('input[name="jitter-mode"][value="manual"]').checked,
    }));
    expect(seen.mode).toEqual({ mode: 'manual', ms: 120 });
    expect(seen.radio).toBe(true);
  });

  test('a video-routing change is mirrored into the in-page radios', async ({ page }) => {
    await storageEvent(page, 'video-routing-mode', 'p2p-only');
    const checked = await page.evaluate(() =>
      document.querySelector('input[name="video-routing-mode"][value="p2p-only"]').checked);
    expect(checked).toBe(true);
  });

  test('a noise-suppression change is mirrored into the in-page radios', async ({ page }) => {
    await storageEvent(page, 'noise-suppression', 'off');
    const checked = await page.evaluate(() =>
      document.querySelector('input[name="noise-suppression-mode"][value="off"]').checked);
    expect(checked).toBe(true);
  });

  test('a dev-mode change re-renders the room while in one', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, connections: [{ id: 'p1', pseudo: 'One' }] });
    await storageEvent(page, 'dev-mode', 'true');
    // Dev mode is what puts the peer id on a roster row.
    const html = await page.evaluate(() => document.getElementById('peers-list').innerHTML);
    expect(html).toContain('One');
  });

  test('a network-usage request starts and stops the feed', async ({ page }) => {
    await storageEvent(page, 'net-usage-request', JSON.stringify({ watching: true, at: Date.now() }));
    expect(await page.evaluate(() => _networkUsageWatchers)).toBe(true);
    await storageEvent(page, 'net-usage-request', JSON.stringify({ watching: false, at: Date.now() }));
    expect(await page.evaluate(() => _networkUsageWatchers)).toBe(false);
  });

  test('an unparseable network-usage request stops the feed rather than throwing', async ({ page }) => {
    await storageEvent(page, 'net-usage-request', '{not json');
    expect(await page.evaluate(() => _networkUsageWatchers)).toBe(false);
  });

  test('an echo-test request that matches the current state re-publishes it', async ({ page }) => {
    // The bridge only exists on Tauri desktop, so stand in for it.
    const published = await page.evaluate(async () => {
      const seen = [];
      window.__TAURI__ = { core: { invoke: () => Promise.resolve() } };
      localStorage.setItem('echo-test-request', JSON.stringify({ action: 'stop', at: Date.now() }));
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'echo-test-request', newValue: localStorage.getItem('echo-test-request'),
      }));
      seen.push(JSON.parse(localStorage.getItem('echo-test-state') || 'null'));
      delete window.__TAURI__;
      return seen[0];
    });
    expect(published).toMatchObject({ running: false });
  });

  test('an unparseable echo-test request is ignored', async ({ page }) => {
    await page.evaluate(() => localStorage.removeItem('echo-test-state'));
    await storageEvent(page, 'echo-test-request', 'nonsense{');
    expect(await page.evaluate(() => localStorage.getItem('echo-test-state'))).toBe(null);
  });

  test('a key nobody listens for is ignored', async ({ page }) => {
    const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    await storageEvent(page, 'some-unrelated-key', 'x');
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(before);
  });

  test('signing out elsewhere sends this window home', async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem('presence-api-token', 'tok');
      localStorage.setItem('presence-org-id', 'org');
    });
    await storageEvent(page, 'presence-api-token', null);
    const screen = await page.evaluate(() =>
      document.querySelector('.screen.active') && document.querySelector('.screen.active').id);
    expect(screen).toBe('screen-home');
  });
});

test.describe('room controls', () => {
  test('copy puts the room code on the clipboard and says so', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, roomCode: 'room-xyz' });
    await page.evaluate(() => {
      _publishedRoomId = null;
      activeChannel = null;
      activeChannelRoomId = null;
      window.__copied = [];
      navigator.clipboard.writeText = (t) => { window.__copied.push(t); return Promise.resolve(); };
      document.getElementById('btn-copy').click();
    });
    await expect(page.locator('#copy-toast')).toBeVisible();
    expect(await page.evaluate(() => window.__copied)).toEqual(['room-xyz']);
  });

  test('copy with no room code does nothing', async ({ page }) => {
    const copied = await page.evaluate(() => {
      roomCode = '';
      _publishedRoomId = null;
      activeChannel = null;
      activeChannelRoomId = null;
      const seen = [];
      navigator.clipboard.writeText = (t) => { seen.push(t); return Promise.resolve(); };
      document.getElementById('btn-copy').click();
      return seen;
    });
    expect(copied).toEqual([]);
  });

  test('share builds an invite URL for the room', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, roomCode: 'room-xyz' });
    const shared = await page.evaluate(() => {
      _publishedRoomId = null;
      activeChannel = null;
      activeChannelRoomId = null;
      const seen = [];
      navigator.clipboard.writeText = (t) => { seen.push(t); return Promise.resolve(); };
      navigator.share = undefined;
      document.getElementById('btn-share-room').click();
      return seen;
    });
    expect(shared).toHaveLength(1);
    expect(shared[0]).toContain('room=room-xyz');
  });

  test('leaving from the room header returns home', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, roomCode: 'room-xyz' });
    await page.evaluate(() => {
      peer = { id: 'host', destroyed: false, destroy() { this.destroyed = true; } };
      showScreen('room');
      document.getElementById('btn-leave').click();
    });
    const seen = await page.evaluate(() => ({
      inRoom,
      screen: document.querySelector('.screen.active') && document.querySelector('.screen.active').id,
    }));
    expect(seen).toEqual({ inRoom: false, screen: 'screen-home' });
  });
});

test.describe('the rejoin bar', () => {
  test('appears for a snapshot with peers, and dismissing forgets it', async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem('rejoin-snapshot', JSON.stringify({
        hostId: 'old-host', deputyId: null, peerIds: ['p1', 'p2'], wasHost: false, savedAt: Date.now(),
      }));
      _rejoinDismissed = false;
      window._updateRejoinBar();
    });
    await expect(page.locator('#rejoin-bar')).toBeVisible();
    await page.click('#btn-dismiss-rejoin');
    await expect(page.locator('#rejoin-bar')).toHaveCount(0);
    expect(await page.evaluate(() => loadRejoinSnapshot())).toBe(null);
  });

  test('stays away when the snapshot has nobody left to dial', async ({ page }) => {
    const visible = await page.evaluate(() => {
      localStorage.setItem('rejoin-snapshot', JSON.stringify({
        hostId: 'our-own-id', deputyId: null, peerIds: [], wasHost: true, savedAt: Date.now(),
      }));
      _rejoinDismissed = false;
      window._updateRejoinBar();
      const bar = document.getElementById('rejoin-bar');
      return !!bar && !bar.classList.contains('hidden');
    });
    expect(visible).toBe(false);
  });
});

test.describe('network status', () => {
  test('coming back online reconnects a dropped signalling channel', async ({ page }) => {
    const reconnects = await page.evaluate(() => {
      inRoom = true;
      let n = 0;
      peer = { disconnected: true, destroyed: false, reconnect: () => { n++; } };
      window.dispatchEvent(new Event('online'));
      inRoom = false;
      peer = null;
      return n;
    });
    expect(reconnects).toBe(1);
  });

  test('going offline only refreshes the relay badge', async ({ page }) => {
    const threw = await page.evaluate(() => {
      try { window.dispatchEvent(new Event('offline')); return false; } catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });
});

test.describe('returning to the foreground', () => {
  test('a peer whose host link died starts a migration', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'a-peer',
      isHost: false,
      roomCode: 'dead-host',
      knownPeerIds: ['z-peer'],
      successorIds: ['a-peer', 'z-peer'],
    });
    const state = await page.evaluate(() => {
      roomState = ROOM_STATE_CONNECTED;
      connectingToHostId = null;
      peer = { id: 'a-peer', disconnected: false, destroyed: false, reconnect() {} };
      connections.set('dead-host', { data: { open: false, closed: true, close() {} } });
      document.dispatchEvent(new Event('visibilitychange'));
      return { isHost, roomCode };
    });
    expect(state).toEqual({ isHost: true, roomCode: 'a-peer' });
  });

  test('a healthy host link is left alone', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'a-peer',
      isHost: false,
      roomCode: 'the-host',
      connections: [{ id: 'the-host' }],
      successorIds: ['a-peer'],
    });
    const state = await page.evaluate(() => {
      roomState = ROOM_STATE_CONNECTED;
      connectingToHostId = null;
      peer = { id: 'a-peer', disconnected: false, destroyed: false, reconnect() {} };
      document.dispatchEvent(new Event('visibilitychange'));
      return { isHost, roomCode };
    });
    expect(state).toEqual({ isHost: false, roomCode: 'the-host' });
  });
});
