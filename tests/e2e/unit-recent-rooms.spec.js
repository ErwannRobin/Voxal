import { test, expect } from './fixtures.js';

// Recent rooms: the home screen lists the last few *named* anonymous room
// codes joined (newest first, capped, UUID peer-ids excluded) for one-tap
// rejoin. Backed by localStorage['recent-rooms'].

test.describe('recordRecentRoom / loadRecentRooms', () => {
  test('records newest first and de-duplicates', async ({ page }) => {
    await page.goto('/');
    const list = await page.evaluate(() => {
      recordRecentRoom('alpha');
      recordRecentRoom('beta');
      recordRecentRoom('alpha'); // re-join bumps to front, no duplicate
      return loadRecentRooms();
    });
    expect(list).toEqual(['alpha', 'beta']);
  });

  test('caps the list at 5', async ({ page }) => {
    await page.goto('/');
    const list = await page.evaluate(() => {
      ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].forEach((c) => recordRecentRoom(c));
      return loadRecentRooms();
    });
    expect(list).toEqual(['r6', 'r5', 'r4', 'r3', 'r2']);
  });

  test('ignores UUID peer-ids and empty codes', async ({ page }) => {
    await page.goto('/');
    const list = await page.evaluate(() => {
      recordRecentRoom('named-room');
      recordRecentRoom('11111111-2222-3333-4444-555555555555');
      recordRecentRoom('');
      recordRecentRoom('   ');
      return loadRecentRooms();
    });
    expect(list).toEqual(['named-room']);
  });

  test('survives corrupted storage', async ({ page }) => {
    await page.goto('/');
    const list = await page.evaluate(() => {
      localStorage.setItem('recent-rooms', '{not json');
      return loadRecentRooms();
    });
    expect(list).toEqual([]);
  });

  test('removeRecentRoom deletes a single entry', async ({ page }) => {
    await page.goto('/');
    const list = await page.evaluate(() => {
      recordRecentRoom('keep');
      recordRecentRoom('drop');
      removeRecentRoom('drop');
      return loadRecentRooms();
    });
    expect(list).toEqual(['keep']);
  });
});

test.describe('home screen list', () => {
  test('hidden when there are no recent rooms', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#recent-rooms')).toBeHidden();
  });

  test('renders stored rooms newest first', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('recent-rooms', JSON.stringify(['newest', 'older']));
      window._updateRecentRooms();
    });
    await expect(page.locator('#recent-rooms')).toBeVisible();
    await expect(page.locator('.recent-room-join')).toHaveText(['newest', 'older']);
  });

  test('clicking a chip fills the join input', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('recent-rooms', JSON.stringify(['my-room']));
      window._updateRecentRooms();
    });
    // Stub the join CTA so the click doesn't hit the network — we only assert
    // the chip routes through the normal Join flow (input filled + click).
    await page.evaluate(() => {
      window.__joinClicked = 0;
      const btn = document.getElementById('btn-join');
      const clone = btn.cloneNode(true);
      clone.addEventListener('click', () => { window.__joinClicked++; });
      btn.replaceWith(clone);
    });
    await page.locator('.recent-room-join').click();
    await expect(page.locator('#input-code')).toHaveValue('my-room');
    expect(await page.evaluate(() => window.__joinClicked)).toBe(1);
  });

  test('the ✕ button removes the chip and hides an emptied list', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('recent-rooms', JSON.stringify(['solo']));
      window._updateRecentRooms();
    });
    await page.locator('.recent-room-remove').click();
    await expect(page.locator('#recent-rooms')).toBeHidden();
    expect(await page.evaluate(() => loadRecentRooms())).toEqual([]);
  });
});
