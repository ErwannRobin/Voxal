import { test, expect } from './fixtures.js';

// The settings modal has two layouts driven by one piece of state.
//
// Wide (≥ 861px): a sidebar picks one card and the rest are hidden outright.
// Narrow: the sidebar has nowhere to go, so the same cards become an accordion —
// each group title is replaced by a toggle button, and opening one closes the
// others. "Advanced" is deliberately outside the accordion (it is a <details>
// of its own) but still has to close the accordion when it opens, or the two
// disclosure mechanisms fight and the modal scrolls forever.
//
// The layouts share `activeId`, which is what makes a resize continuous: what
// you had open narrow is what the sidebar lands on wide, and back again.

const WIDE = { width: 1200, height: 900 };
const NARROW = { width: 600, height: 900 };

/** Every non-Advanced card's collapsed / hidden state, keyed by card id. */
function cardStates(page) {
  return page.evaluate(() => {
    const root = document.querySelector('#modal-settings .modal-settings-scrollable');
    const out = {};
    for (const card of root.querySelectorAll('.settings-card[id]')) {
      const toggle = card.querySelector(':scope > .settings-card-toggle');
      out[card.id] = {
        collapsed: card.classList.contains('is-collapsed'),
        hidden: card.classList.contains('hidden-by-sidebar'),
        hasToggle: !!toggle,
        expanded: toggle ? toggle.getAttribute('aria-expanded') : null,
      };
    }
    return out;
  });
}

/** The ids of the accordion's toggles, in document order. */
function toggleIds(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#modal-settings .settings-card[id]'))
      .filter((c) => c.querySelector(':scope > .settings-card-toggle'))
      .map((c) => c.id));
}

const clickToggle = (page, id) => page.click(`#${id} > .settings-card-toggle`);

/**
 * Wait for the layout to actually change after a resize.
 *
 * The switch runs off a matchMedia 'change' listener, which fires a beat after
 * setViewportSize() returns — reading the cards straight away is a race that
 * only shows up under a loaded machine. `modal-sidebar-visible` is set by the
 * same function that rearranges the cards, so it is the honest signal.
 */
const layoutSettled = (page, wide) =>
  page.waitForFunction(
    (wide) => document.body.classList.contains('modal-sidebar-visible') === wide,
    wide);

async function resizeTo(page, size) {
  await page.setViewportSize(size);
  await layoutSettled(page, size === WIDE);
}

const activeNavTarget = (page) =>
  page.evaluate(() => {
    const btn = document.querySelector('#modal-settings-sidebar .prefs-nav-btn.active');
    return btn ? btn.dataset.target : null;
  });

test.describe('narrow layout — the accordion', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(NARROW);
    await page.goto('/');
    await page.click('#btn-open-settings');
  });

  test('each card gets a toggle button in place of its plain title', async ({ page }) => {
    const ids = await toggleIds(page);
    expect(ids.length).toBeGreaterThan(1);
    // Advanced keeps its own <details>; it must not be given a second one.
    expect(ids).not.toContain('settings-advanced');

    const states = await cardStates(page);
    for (const id of ids) {
      expect(states[id].hasToggle).toBe(true);
      // The accordion replaces the sidebar's hide/show: nothing is hidden here,
      // it is collapsed. Both at once would leave an unreachable card.
      expect(states[id].hidden).toBe(false);
    }
  });

  test('exactly one card is open to begin with, and it is the one the nav points at', async ({ page }) => {
    const ids = await toggleIds(page);
    const states = await cardStates(page);
    const open = ids.filter((id) => !states[id].collapsed);

    expect(open).toHaveLength(1);
    expect(await activeNavTarget(page)).toBe(open[0]);
    expect(states[open[0]].expanded).toBe('true');
  });

  test('opening one card closes the one that was open', async ({ page }) => {
    const ids = await toggleIds(page);
    const first = ids[0];
    const second = ids[1];

    await clickToggle(page, second);
    const states = await cardStates(page);

    expect(states[second].collapsed).toBe(false);
    expect(states[second].expanded).toBe('true');
    expect(states[first].collapsed).toBe(true);
    expect(states[first].expanded).toBe('false');
    // The sidebar nav follows along even though it is off-screen, so a resize
    // back to wide lands on the section the user was actually reading.
    expect(await activeNavTarget(page)).toBe(second);
  });

  test('clicking the open card closes it, leaving nothing expanded', async ({ page }) => {
    const ids = await toggleIds(page);
    const first = ids[0];

    await clickToggle(page, first);
    const states = await cardStates(page);

    expect(states[first].collapsed).toBe(true);
    expect(ids.every((id) => states[id].collapsed)).toBe(true);
    expect(await activeNavTarget(page)).toBe(null);
  });

  test('a sidebar nav button still drives the accordion', async ({ page }) => {
    const ids = await toggleIds(page);
    const target = ids[ids.length - 1];

    await page.evaluate((id) => {
      document.querySelector(`#modal-settings-sidebar .prefs-nav-btn[data-target="${id}"]`).click();
    }, target);

    const states = await cardStates(page);
    expect(states[target].collapsed).toBe(false);
    expect(ids.filter((id) => !states[id].collapsed)).toEqual([target]);
  });

  test('opening Advanced collapses the accordion instead of stacking with it', async ({ page }) => {
    const ids = await toggleIds(page);
    await page.evaluate(() => {
      const d = document.getElementById('turn-details');
      d.open = true;
      d.dispatchEvent(new Event('toggle'));
    });

    const states = await cardStates(page);
    expect(ids.every((id) => states[id].collapsed)).toBe(true);
    expect(await activeNavTarget(page)).toBe('settings-advanced');
  });

  test('opening an accordion card closes Advanced again', async ({ page }) => {
    await page.evaluate(() => {
      const d = document.getElementById('turn-details');
      d.open = true;
      d.dispatchEvent(new Event('toggle'));
    });

    const ids = await toggleIds(page);
    await clickToggle(page, ids[0]);

    expect(await page.evaluate(() => document.getElementById('turn-details').open)).toBe(false);
    expect(await activeNavTarget(page)).toBe(ids[0]);
  });

  test('reopening the modal does not bind the toggles a second time', async ({ page }) => {
    const ids = await toggleIds(page);
    await page.click('#btn-close-settings');
    await page.click('#btn-open-settings');

    // A double binding would collapse-then-expand on a single click, so the
    // card would appear not to react at all.
    await clickToggle(page, ids[1]);
    const states = await cardStates(page);
    expect(states[ids[1]].collapsed).toBe(false);
    expect(states[ids[0]].collapsed).toBe(true);
  });
});

test.describe('resizing between the two layouts', () => {
  test('what was open narrow is what the sidebar selects wide', async ({ page }) => {
    await page.setViewportSize(NARROW);
    await page.goto('/');
    await page.click('#btn-open-settings');

    const ids = await toggleIds(page);
    const chosen = ids[1];
    await clickToggle(page, chosen);

    await resizeTo(page, WIDE);
    const states = await cardStates(page);

    expect(await activeNavTarget(page)).toBe(chosen);
    // Wide hides the other cards outright rather than collapsing them.
    expect(states[chosen].hidden).toBe(false);
    expect(states[chosen].collapsed).toBe(false);
    expect(states[ids[0]].hidden).toBe(true);
    expect(states[ids[0]].collapsed).toBe(false);
  });

  test('and what the sidebar selected wide is what is open narrow', async ({ page }) => {
    await page.setViewportSize(WIDE);
    await page.goto('/');
    await page.click('#btn-open-settings');
    await page.click('#modal-settings-sidebar .prefs-nav-btn[data-target="settings-system"]');

    await resizeTo(page, NARROW);
    const states = await cardStates(page);
    const ids = await toggleIds(page);

    expect(states['settings-system'].collapsed).toBe(false);
    expect(ids.filter((id) => !states[id].collapsed)).toEqual(['settings-system']);
    // Nothing may stay hidden-by-sidebar once the sidebar is gone.
    expect(ids.every((id) => !states[id].hidden)).toBe(true);
  });

  test('Advanced survives the trip in both directions', async ({ page }) => {
    await page.setViewportSize(NARROW);
    await page.goto('/');
    await page.click('#btn-open-settings');
    await page.evaluate(() => {
      const d = document.getElementById('turn-details');
      d.open = true;
      d.dispatchEvent(new Event('toggle'));
    });

    await resizeTo(page, WIDE);
    expect(await activeNavTarget(page)).toBe('settings-advanced');
    expect(await page.evaluate(() => document.getElementById('turn-details').open)).toBe(true);

    await resizeTo(page, NARROW);
    expect(await page.evaluate(() => document.getElementById('turn-details').open)).toBe(true);
    const states = await cardStates(page);
    const ids = await toggleIds(page);
    expect(ids.every((id) => states[id].collapsed)).toBe(true);
  });
});
