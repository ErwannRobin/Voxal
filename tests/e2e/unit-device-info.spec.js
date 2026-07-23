import { test, expect } from './fixtures.js';
import { seedRoom, callFn } from './_helpers.js';

// Dev-mode device-info diagnostics: on-demand collection, the "i" button
// visibility gate, the sharing opt-out preference, and the host relay of
// device-info request/response messages. All logic lives on window globals in
// the flat main.js script, so we drive the real implementation in-browser.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // Dev tooling short-circuits inside tiny embeds; make sure we're not one.
  await page.evaluate(() => { try { localStorage.removeItem('dev-mode'); } catch (_) {} });
});

test.describe('collectDeviceInfo', () => {
  test('returns a well-formed snapshot without throwing', async ({ page }) => {
    const info = await page.evaluate(async () => collectDeviceInfo());
    expect(info).toBeTruthy();
    expect(info.device).toBeTruthy();
    expect(info.audio).toBeTruthy();
    expect(info.network).toBeTruthy();
    // Device type is always one of the known buckets.
    expect(['Desktop', 'Laptop', 'Phone', 'Tablet']).toContain(info.device.type);
    // Setup reflects the plain-web harness.
    expect(info.device.setup).toBe('Web browser');
    // Timezone resolves in any modern browser.
    expect(typeof info.device.timezone === 'string' && info.device.timezone.length).toBeTruthy();
    // Battery block is always present (present:false when unavailable).
    expect(info.network.battery).toBeTruthy();
    expect(typeof info.network.battery.background).toBe('boolean');
  });
});

test.describe('sharing preference (opt-out, default on)', () => {
  test('defaults to enabled when unset', async ({ page }) => {
    const on = await page.evaluate(() => isDeviceInfoSharingEnabled());
    expect(on).toBe(true);
  });

  test('honors an explicit "false"', async ({ page }) => {
    const on = await page.evaluate(() => {
      localStorage.setItem('debug-share-device-info', 'false');
      return isDeviceInfoSharingEnabled();
    });
    expect(on).toBe(false);
  });
});

test.describe('device-info button visibility', () => {
  test('hidden when dev mode is off', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, roomCode: 'host' });
    const visible = await page.evaluate(() => deviceInfoButtonVisible());
    expect(visible).toBe(false);
  });

  test('shown for the host when dev mode is on', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, roomCode: 'host' });
    const visible = await page.evaluate(() => {
      localStorage.setItem('dev-mode', 'true');
      return deviceInfoButtonVisible();
    });
    expect(visible).toBe(true);
  });

  test('hidden for a non-host until the host advertises debug mode', async ({ page }) => {
    await seedRoom(page, { selfId: 'peer-a', isHost: false, hostId: 'host', roomCode: 'host' });
    const before = await page.evaluate(() => {
      localStorage.setItem('dev-mode', 'true');
      _hostDebugMode = false;
      return deviceInfoButtonVisible();
    });
    expect(before).toBe(false);

    // The host's debug flag arrives in a heartbeat; the mirror flips it on.
    const after = await page.evaluate(() => {
      handleHostMessage({ type: 'heartbeat', at: Date.now(), debugMode: true });
      return { flag: _hostDebugMode, visible: deviceInfoButtonVisible() };
    });
    expect(after.flag).toBe(true);
    expect(after.visible).toBe(true);
  });
});

test.describe('self panel respects the sharing preference', () => {
  test('shows an "off" notice for your own row when sharing is disabled', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, roomCode: 'host' });
    await page.evaluate(() => {
      localStorage.setItem('dev-mode', 'true');
      localStorage.setItem('debug-share-device-info', 'false');
      showScreen('room');
      updatePeerList();
    });
    await page.locator('#peer-item-self .peer-info-btn').click();
    await expect(page.locator('#device-info-popover')).toBeVisible();
    await expect(page.locator('#device-info-popover')).toContainText('Device sharing is off');
    await expect(page.locator('#device-info-popover')).not.toContainText('Timezone');
  });

  test('shows diagnostics for your own row when sharing is enabled', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, roomCode: 'host' });
    await page.evaluate(() => {
      localStorage.setItem('dev-mode', 'true');
      localStorage.setItem('debug-share-device-info', 'true');
      showScreen('room');
      updatePeerList();
    });
    await page.locator('#peer-item-self .peer-info-btn').click();
    await expect(page.locator('#device-info-popover')).toContainText('Timezone');
    await expect(page.locator('#device-info-popover')).not.toContainText('Device sharing is off');
  });
});

test.describe('a peer with sharing off declines requests', () => {
  test('respondToDeviceInfoRequest sends a declined response to the host', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'peer-a', isHost: false, hostId: 'host', roomCode: 'host',
      connections: [{ id: 'host', pseudo: 'Host' }],
    });
    const sent = await page.evaluate(() => {
      localStorage.setItem('debug-share-device-info', 'false');
      const captured = [];
      const hc = connections.get('host');
      hc.data.send = function(m) { captured.push(m); };
      respondToDeviceInfoRequest(null);
      return captured;
    });
    expect(sent.length).toBe(1);
    expect(sent[0].type).toBe('device-info-response');
    expect(sent[0].declined).toBe(true);
    expect(sent[0].info).toBeNull();
  });
});

test.describe('host relay of device-info messages', () => {
  test('host stores a peer response and does not throw on malformed shapes', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host', isHost: true, roomCode: 'host',
      connections: [{ id: 'peer-a', pseudo: 'A' }],
    });
    const result = await page.evaluate(() => {
      const errs = [];
      // Malformed device-info messages must never throw out of the handler.
      for (const m of [
        { type: 'device-info-request' },
        { type: 'device-info-response' },
        { type: 'device-info-response', peerId: 'peer-a' },
      ]) {
        try { safeHandleHostMessage(m); } catch (e) { errs.push(e.message); }
      }
      // A well-formed response updates the peer's cached snapshot.
      updatePeerDeviceInfo('peer-a', { device: { type: 'Phone' } }, false);
      const conn = connections.get('peer-a');
      return { errs, cached: conn && conn.deviceInfo && conn.deviceInfo.info.device.type };
    });
    expect(result.errs).toEqual([]);
    expect(result.cached).toBe('Phone');
  });

  test('declined responses are recorded as such', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host', isHost: true, roomCode: 'host',
      connections: [{ id: 'peer-a', pseudo: 'A' }],
    });
    const declined = await page.evaluate(() => {
      updatePeerDeviceInfo('peer-a', null, true);
      const conn = connections.get('peer-a');
      return conn.deviceInfo.declined;
    });
    expect(declined).toBe(true);
  });
});
