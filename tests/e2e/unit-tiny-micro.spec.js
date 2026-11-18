import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// The micro embed: a 56×56 iframe that the embedding page clips to a circle
// (`clip-path: circle(50%)`), so only the inscribed circle is ever seen.
// Everything it can show — the boot frame, "joining", the mic UI, the spinner
// while the mic is acquired, an error — must sit dead centre, or it is cut off
// by the circle and the frame visibly jumps from one state to the next.

const SIZE = 56;
const CENTRE = SIZE / 2;

test.use({ viewport: { width: SIZE, height: SIZE } });

// Centre of the element's box, in viewport px.
async function centreOf(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    // a hidden ancestor leaves the element itself `display: block` but unboxed
    if (cs.display === 'none' || cs.visibility === 'hidden' || !r.width || !r.height) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }, selector);
}

function expectCentred(box) {
  expect(box).not.toBeNull();
  expect(Math.abs(box.x - CENTRE)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(box.y - CENTRE)).toBeLessThanOrEqual(0.5);
}

async function expectNoScroll(page) {
  const seen = await page.evaluate(() => ({
    w: document.documentElement.scrollWidth,
    h: document.documentElement.scrollHeight,
    overflow: getComputedStyle(document.body).overflow,
  }));
  expect(seen).toEqual({ w: 56, h: 56, overflow: 'hidden' });
}

test.describe('booting, before main.js has run', () => {
  test('shows one centred spinner instead of the home screen', async ({ page }) => {
    await page.route('**/main.js', (route) => route.abort());
    await page.goto('/?tiny=1&room=demo');
    const seen = await page.evaluate(() => {
      const after = getComputedStyle(document.body, '::after');
      return {
        boot: document.documentElement.classList.contains('embed-tiny-boot'),
        screensShown: Array.from(document.querySelectorAll('.screen'))
          .filter((el) => getComputedStyle(el).display !== 'none').map((el) => el.id),
        content: after.content,
        position: after.position,
        size: [after.width, after.height],
        // margin:auto on a fixed box with inset:0 resolves to the centring offset
        margin: [after.marginTop, after.marginLeft],
        overflow: getComputedStyle(document.body).overflow,
      };
    });
    expect(seen).toEqual({
      boot: true,
      screensShown: [],
      content: '""',
      position: 'fixed',
      size: ['22px', '22px'],
      margin: ['17px', '17px'],
      overflow: 'hidden',
    });
  });

  test('a plain page is never tagged', async ({ page }) => {
    await page.goto('/');
    const boot = await page.evaluate(() => document.documentElement.classList.contains('embed-tiny-boot'));
    expect(boot).toBe(false);
  });
});

test.describe('once running', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?tiny=1');
    await expect.poll(async () => page.evaluate(() => typeof updatePeerList)).toBe('function');
    await expect(page.locator('body')).toHaveClass(/tiny-micro/);
  });

  test('the joining spinner is centred, with nothing beside it', async ({ page }) => {
    await page.evaluate(() => showInviteLoading('', ''));
    await expect(page.locator('#screen-invite-loading')).toHaveClass(/active/);
    expectCentred(await centreOf(page, '#invite-spinner'));
    for (const sel of ['#invite-join-status', '#btn-cancel-invite-join', '.invite-pseudo-field']) {
      expect(await centreOf(page, sel), sel).toBeNull();
    }
    await expectNoScroll(page);
  });

  test('the mic UI is centred where the spinner was, and so is the mic-acquire spinner', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, myPseudo: 'Me' });
    await page.evaluate(() => { showScreen('room'); updatePeerList(); });
    expectCentred(await centreOf(page, '#peer-item-self .ptt-emoji'));

    await page.evaluate(() => setTinyMicAcquiring(true));
    expect(await centreOf(page, '#peer-item-self .ptt-emoji')).toBeNull();
    const spinner = await centreOf(page, '#peer-item-self .peer-mic-spinner');
    expectCentred(spinner);
    expect(spinner.w).toBeLessThanOrEqual(24);
    await expectNoScroll(page);

    await page.evaluate(() => setTinyMicAcquiring(false));
    expectCentred(await centreOf(page, '#peer-item-self .ptt-emoji'));
  });

  test('an error shows only a centred icon', async ({ page }) => {
    await page.evaluate(() => showError('Room not found'));
    expectCentred(await centreOf(page, '#screen-error .error-icon'));
    expect(await centreOf(page, '#btn-back')).toBeNull();
    await expect(page.locator('#error-message')).toHaveText('Room not found');
    await expectNoScroll(page);
  });
});
