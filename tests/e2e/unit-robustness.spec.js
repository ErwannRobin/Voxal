import { test, expect } from './fixtures.js';

// Robustness hardening: malformed peer messages must never throw out of a data
// handler (any peer drives the data channel in a P2P room), and a large room
// shows an advisory size warning.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test.describe('malformed message handling', () => {
  test('handleHostMessage does not throw on malformed shapes', async ({ page }) => {
    const errors = await page.evaluate(() => {
      // eslint-disable-next-line no-undef
      peer = { id: 'self' }; inRoom = true; roomCode = 'host-x';
      const shapes = [
        null, undefined, 'garbage', 42, {},
        { type: 'peer-list' },               // missing peers array (the original crash)
        { type: 'peer-list', peers: null },  // null peers
        { type: 'heartbeat' },
      ];
      const errs = [];
      for (const m of shapes) {
        try { handleHostMessage(m); } catch (e) { errs.push(String(m && m.type) + ': ' + e.message); }
      }
      return errs;
    });
    expect(errors).toEqual([]);
  });

  test('safeHandleHostMessage swallows anything, even fields that would throw', async ({ page }) => {
    const threw = await page.evaluate(() => {
      // eslint-disable-next-line no-undef
      peer = { id: 'self' }; inRoom = true; roomCode = 'host-x';
      try {
        safeHandleHostMessage({ type: 'peer-joined' });   // missing peerId
        safeHandleHostMessage({ type: 'peer-renamed' });
        safeHandleHostMessage({ type: 'talking' });
        safeHandleHostMessage('not-an-object');
        safeHandleHostMessage(null);
        return false;
      } catch (e) {
        return true;
      }
    });
    expect(threw).toBe(false);
  });
});

test.describe('room size warning', () => {
  async function setRoomSize(page, n) {
    await page.evaluate((n) => {
      // eslint-disable-next-line no-undef
      inRoom = true;
      const list = document.getElementById('peers-list');
      list.innerHTML = '';
      for (let i = 0; i < n; i++) {
        const d = document.createElement('div');
        d.className = 'peer-item';
        list.appendChild(d);
      }
      updateRoomSizeWarning();
    }, n);
  }

  test('stays hidden below the soft threshold (7)', async ({ page }) => {
    await setRoomSize(page, 7);
    await expect(page.locator('#room-size-warning')).toHaveClass(/hidden/);
  });

  test('shows a soft warning at 8 (no "hard" class)', async ({ page }) => {
    await setRoomSize(page, 8);
    const el = page.locator('#room-size-warning');
    await expect(el).not.toHaveClass(/hidden/);
    await expect(el).not.toHaveClass(/hard/);
    await expect(el).toContainText('8 people');
  });

  test('shows a hard warning at 12', async ({ page }) => {
    await setRoomSize(page, 12);
    const el = page.locator('#room-size-warning');
    await expect(el).not.toHaveClass(/hidden/);
    await expect(el).toHaveClass(/hard/);
    await expect(el).toContainText('splitting');
  });

  test('re-hides when the room shrinks back below the threshold', async ({ page }) => {
    await setRoomSize(page, 12);
    await expect(page.locator('#room-size-warning')).not.toHaveClass(/hidden/);
    await setRoomSize(page, 3);
    await expect(page.locator('#room-size-warning')).toHaveClass(/hidden/);
  });
});
