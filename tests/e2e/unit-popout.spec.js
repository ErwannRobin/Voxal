import { test, expect } from './fixtures.js';
import { seedRoom, callFn } from './_helpers.js';

// Pop-out URL building for the tiny embed: the standalone window must reopen the
// same room, force an in-browser (web) join, and carry the current display name
// so the session continues under the same identity.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test.describe('tinyPopoutUrl', () => {
  test('includes room, forceWeb, and a manual name', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, roomCode: 'myroom', myPseudo: 'Alice', connections: [] });
    const raw = await callFn(page, 'tinyPopoutUrl');
    const url = new URL(raw);
    expect(url.searchParams.get('room')).toBe('myroom');
    expect(url.searchParams.get('forceWeb')).toBe('1');
    expect(url.searchParams.get('name')).toBe('Alice');
    // Embed params must not leak into the standalone window.
    expect(url.searchParams.get('tiny')).toBeNull();
  });

  test('carries an anonymous color+animal name', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      roomCode: 'myroom',
      myPseudo: '',
      anonymousProfile: { pseudo: 'Azure Fox', pseudoColor: '#3b82f6' },
      connections: [],
    });
    const url = new URL(await callFn(page, 'tinyPopoutUrl'));
    expect(url.searchParams.get('name')).toBe('Azure Fox');
  });

  test('returns empty string when there is no room', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: false, roomCode: '', inRoom: false, connections: [] });
    expect(await callFn(page, 'tinyPopoutUrl')).toBe('');
  });
});

test.describe('ALLOW_POPOUT — opt-in flag', () => {
  test('off by default', async ({ page }) => {
    await page.goto('/');
    expect(await page.evaluate(() => ALLOW_POPOUT)).toBe(false);
  });

  test('enabled by ?popout=1 and its aliases', async ({ page }) => {
    await page.goto('/?popout=1');
    expect(await page.evaluate(() => ALLOW_POPOUT)).toBe(true);
    await page.goto('/?allowPopout=true');
    expect(await page.evaluate(() => ALLOW_POPOUT)).toBe(true);
    await page.goto('/?canPopout=yes');
    expect(await page.evaluate(() => ALLOW_POPOUT)).toBe(true);
  });
});

test.describe('loadInitialPseudo — ?name= inheritance', () => {
  test('a name query param becomes the session pseudo', async ({ page }) => {
    await page.goto('/?name=Popped%20Out');
    const pseudo = await page.evaluate(() => loadInitialPseudo());
    expect(pseudo).toBe('Popped Out');
    const session = await page.evaluate(() => sessionStorage.getItem('pseudo-session'));
    expect(session).toBe('Popped Out');
  });
});
