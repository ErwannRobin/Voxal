import { test, expect } from './fixtures.js';
import { seedRoom, callFn } from './_helpers.js';

// Pop-out URL building for the tiny embed: the standalone window must reopen the
// same room, force an in-browser (web) join, and carry the current display name
// so the session continues under the same identity.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test.describe('tinyPopoutUrl', () => {
  test('includes room, forceWeb, and a manual name (no color)', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, roomCode: 'myroom', myPseudo: 'Alice', connections: [] });
    const raw = await callFn(page, 'tinyPopoutUrl');
    const url = new URL(raw);
    expect(url.searchParams.get('room')).toBe('myroom');
    expect(url.searchParams.get('forceWeb')).toBe('1');
    expect(url.searchParams.get('name')).toBe('Alice');
    // A manual name has no color to carry.
    expect(url.searchParams.get('color')).toBeNull();
    // Embed params must not leak into the standalone window.
    expect(url.searchParams.get('tiny')).toBeNull();
  });

  test('carries an anonymous name together with its color', async ({ page }) => {
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
    expect(url.searchParams.get('color')).toBe('#3b82f6');
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

test.describe('pop-out button stacking', () => {
  // Regression: the button used to live inside .room-bottom-bar (z-index 20),
  // whose stacking context sits below the peers panel (z-index 30) — so the
  // panel overlaid the left of the button and stole its clicks. It must be a
  // direct child of #screen-room and hit-testable across its full width.

  test('is a direct child of #screen-room, not inside .room-bottom-bar', async ({ page }) => {
    const html = await page.evaluate(() => fetch('/index.html').then((r) => r.text()));
    const loc = await page.evaluate((markup) => {
      const doc = new DOMParser().parseFromString(markup, 'text/html');
      const btn = doc.getElementById('btn-popout-tiny');
      return {
        inBottomBar: !!btn.closest('.room-bottom-bar'),
        parentIsScreenRoom: btn.parentElement.id === 'screen-room',
      };
    }, html);
    expect(loc.inBottomBar).toBe(false);
    expect(loc.parentIsScreenRoom).toBe(true);
  });

  test('is hit-testable across its whole width (not overlaid by the peers panel)', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 220 });
    await page.goto('/?ui=tiny&popout=1');
    await page.evaluate(() => document.body.classList.add('embed-tiny', 'embed-can-popout'));
    await seedRoom(page, { selfId: 'host', isHost: true, roomCode: 'probe', myPseudo: 'Alice', connections: [] });
    await page.evaluate(() => { showScreen('room'); updatePeerList(); });

    const hits = await page.evaluate(() => {
      // Bootstrap removes the button when the page isn't a real iframe; re-insert
      // it in its real DOM slot (direct child of #screen-room) to test stacking.
      let btn = document.getElementById('btn-popout-tiny');
      if (!btn) {
        btn = document.createElement('button');
        btn.id = 'btn-popout-tiny';
        btn.className = 'btn-icon tiny-popout-btn';
        document.getElementById('screen-room').appendChild(btn);
      }
      const r = btn.getBoundingClientRect();
      const y = r.top + r.height / 2;
      return [r.left + 3, r.left + r.width / 2, r.right - 3].map((x) => {
        const el = document.elementFromPoint(x, y);
        return !!el && btn.contains(el); // el is the button or its <svg>
      });
    });
    expect(hits).toEqual([true, true, true]);
  });
});

test.describe('applyPopoutIdentityFromUrl — ?name= / ?color= inheritance', () => {
  test('a manual name becomes the session pseudo (runs on load)', async ({ page }) => {
    await page.goto('/?name=Popped%20Out');
    // applyPopoutIdentityFromUrl() runs in the DOMContentLoaded bootstrap.
    expect(await page.evaluate(() => myPseudo)).toBe('Popped Out');
    expect(await page.evaluate(() => sessionStorage.getItem('pseudo-session'))).toBe('Popped Out');
    expect(await page.evaluate(() => selfPseudoProfile().anonymous)).toBeFalsy();
  });

  test('a name + valid color restores an anonymous profile (colored + detectable)', async ({ page }) => {
    await page.goto('/?name=Azure%20Fox&color=%233b82f6');
    expect(await page.evaluate(() => displayPseudoForSelf())).toBe('Azure Fox');
    expect(await page.evaluate(() => pseudoColorForSelf())).toBe('#3b82f6');
    expect(await page.evaluate(() => selfPseudoProfile().anonymous)).toBe(true);
    // Anonymous identity must not be stored as a manual pseudo.
    expect(await page.evaluate(() => myPseudo)).toBe('');
  });

  test('a name with a non-anon color falls back to a manual pseudo', async ({ page }) => {
    await page.goto('/?name=Azure%20Fox&color=%23000000');
    expect(await page.evaluate(() => myPseudo)).toBe('Azure Fox');
    expect(await page.evaluate(() => selfPseudoProfile().anonymous)).toBeFalsy();
  });
});
