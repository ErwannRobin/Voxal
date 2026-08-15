import { test, expect } from './fixtures.js';
import { seedRoom, callFn } from './_helpers.js';

// How the stage divides itself up once a call is a real conference.
//
// Two halves, and they are one policy:
//   * the ARRANGEMENT — maximise the video, then balance the number of vertical
//     and horizontal cuts, then prefer the extra column (a vertical split), and
//     recompute all of it whenever the participant count or the box changes;
//   * the OVERFLOW — past a bounded number of tiles (a hard 4 on a phone) the
//     rest are minimized into a ribbon ordered by most recent speaker, which
//     scrolls and says how many it is still hiding.

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

async function enterRoom(page, cfg = {}) {
  await seedRoom(page, { selfId: 'self', isHost: true, roomCode: 'room1', ...cfg });
  await page.evaluate(() => {
    showScreen('room');
    updatePeerList();
  });
}

// N remote peers, all with a live camera and a stream, so every one of them is
// a real tile rather than a placeholder.
async function roomOfCameras(page, n) {
  const ids = Array.from({ length: n }, (_, i) => 'p' + (i + 1));
  await enterRoom(page, {
    knownPeerIds: ids,
    connections: ids.map((id, i) => ({
      id, pseudo: 'Peer ' + (i + 1), open: true, videoActive: true,
    })),
  });
  await page.evaluate((peerIds) => {
    peerIds.forEach((id) => { connections.get(id).remoteVideoStream = new MediaStream(); });
    updatePeerList();
  }, ids);
  return ids;
}

const keysIn = (page, sel) =>
  page.evaluate((s) => Array.from(document.querySelectorAll(s + ' [data-key]')).map((e) => e.dataset.key), sel);

const gridKeys = (page) => keysIn(page, '#video-stage-grid');
const ribbonKeys = (page) => keysIn(page, '#video-stage-ribbon');

// The arrangement as the browser actually laid it out. Columns are counted as
// the widest row, NOT as the number of distinct lefts: an incomplete last row is
// centred, so its tiles start half a tile off every other row's grid lines.
async function gridShape(page) {
  return page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll('#video-stage-grid .video-tile'))
      .map((e) => e.getBoundingClientRect());
    const byRow = new Map();
    boxes.forEach((b) => {
      const top = Math.round(b.top);
      byRow.set(top, (byRow.get(top) || 0) + 1);
    });
    return {
      rows: byRow.size,
      cols: Math.max(0, ...byRow.values()),
      tiles: boxes.length,
    };
  });
}

// What the layout policy says the arrangement should be for the box the grid
// actually got — so a DOM test asserts that the rendered grid FOLLOWS the
// policy, instead of hard-coding numbers that depend on the room's chrome.
async function expectedShape(page, count) {
  return page.evaluate((n) => {
    const grid = document.getElementById('video-stage-grid');
    const box = stageGridBox(grid);
    const l = bestGridLayout(n, box.width, box.height, 16 / 9);
    return { cols: l.cols, rows: l.rows };
  }, count);
}

test.describe('bestGridLayout — the arrangement', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });

  const layout = (page, n, w, h) => callFn(page, 'bestGridLayout', n, w, h, 16 / 9);

  // The tie is the common case, not an edge case: two tiles on a 16:9 stage
  // come out exactly the same size stacked or side by side. Faces belong side
  // by side at eye level.
  test('an exact tie takes the vertical split', async ({ page }) => {
    const l = await layout(page, 2, 1600, 900);
    expect(l.cols).toBe(2);
    expect(l.rows).toBe(1);
  });

  test('balances the cuts rather than running one long strip', async ({ page }) => {
    expect((await layout(page, 4, 1200, 700)).cols).toBe(2);   // 2x2, never 4x1
    expect((await layout(page, 6, 1200, 700)).cols).toBe(3);   // 3x2
    expect((await layout(page, 9, 1200, 900)).cols).toBe(3);   // 3x3
  });

  // Balance is the tie-break, not the rule: a portrait phone genuinely fits
  // three 16:9 tiles better stacked, and that is a 2.3x difference in area.
  test('a big win in tile size still beats balance', async ({ page }) => {
    const l = await layout(page, 3, 390, 500);
    expect(l.cols).toBe(1);
    expect(l.rows).toBe(3);
  });

  test('a wide, short stage puts everyone on one row', async ({ page }) => {
    expect((await layout(page, 3, 1200, 260)).cols).toBe(3);
  });

  // An arrangement with a column that would stand entirely empty is never the
  // answer — 3x2 for four tiles is the 2x2 it degenerates into, minus the space.
  test('never proposes an arrangement with an empty column', async ({ page }) => {
    for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      const l = await layout(page, n, 1280, 720);
      expect((l.cols - 1) * l.rows).toBeLessThan(n);
      expect(l.cols * l.rows).toBeGreaterThanOrEqual(n);
    }
  });

  test('degrades safely when there is nothing to measure', async ({ page }) => {
    expect(await callFn(page, 'bestGridColumns', 0, 900, 700, 16 / 9)).toBe(1);
    expect(await callFn(page, 'bestGridColumns', 3, 0, 0, 16 / 9)).toBe(1);
  });
});

test.describe('the grid is re-divided for every participant', () => {
  test.use({ viewport: DESKTOP });
  test.beforeEach(async ({ page }) => { await page.goto('/'); });

  test('each new camera re-runs the arrangement', async ({ page }) => {
    await roomOfCameras(page, 2);
    expect(await gridShape(page)).toMatchObject({ tiles: 2, ...(await expectedShape(page, 2)) });

    // A third and a fourth peer arrive; the split is recomputed both times.
    for (const id of ['p3', 'p4']) {
      await page.evaluate((peerId) => {
        knownPeerIds.add(peerId);
        connections.set(peerId, {
          data: { open: true, closed: false, send() {}, close() {} },
          pseudo: peerId, videoActive: true, remoteVideoStream: new MediaStream(),
        });
        updatePeerList();
      }, id);
    }
    expect(await gridShape(page)).toMatchObject({ tiles: 4, ...(await expectedShape(page, 4)) });
    // Four faces on a stage this shape is the balanced 2x2, never a 4x1 strip.
    expect(await gridShape(page)).toMatchObject({ cols: 2, rows: 2 });
  });

  test('a resize re-divides it without a roster change', async ({ page }) => {
    await roomOfCameras(page, 3);
    expect((await gridShape(page)).rows).toBeGreaterThan(1);

    // Short and wide: everyone onto one row, two vertical cuts and no
    // horizontal one — the arrangement follows the box, not the roster.
    await page.setViewportSize({ width: 1280, height: 340 });
    await expect.poll(async () => (await gridShape(page)).rows).toBe(1);
    expect((await gridShape(page)).cols).toBe(3);
  });

  // A last row that does not fill sits centred under the rest, rather than
  // jammed against the left edge with a hole beside it.
  test('an incomplete last row is centred', async ({ page }) => {
    await roomOfCameras(page, 3);
    const { rows, cols } = await gridShape(page);
    expect({ rows, cols }).toEqual({ rows: 2, cols: 2 });

    const boxes = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#video-stage-grid .video-tile'))
        .map((e) => e.getBoundingClientRect().toJSON()));
    const lastRowTop = Math.max(...boxes.map((b) => Math.round(b.top)));
    const top = boxes.filter((b) => Math.round(b.top) < lastRowTop);
    const bottom = boxes.filter((b) => Math.round(b.top) === lastRowTop);
    expect(bottom.length).toBe(1);
    const centre = (bs) => (Math.min(...bs.map((b) => b.left)) + Math.max(...bs.map((b) => b.right))) / 2;
    expect(Math.abs(centre(bottom) - centre(top))).toBeLessThanOrEqual(2);
  });
});

test.describe('stageGridCapacity — how many tiles the grid keeps', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });

  const cap = (page, n, w, h, immersive) => callFn(page, 'stageGridCapacity', n, w, h, immersive);

  test('a phone stops at four, however many are connected', async ({ page }) => {
    expect(await cap(page, 3, 390, 600, true)).toBe(3);
    expect(await cap(page, 4, 390, 600, true)).toBe(4);
    expect(await cap(page, 9, 390, 600, true)).toBe(4);
  });

  test('a desktop stage keeps more, but not unboundedly', async ({ page }) => {
    expect(await cap(page, 30, 1200, 700, false)).toBe(12);
  });

  // Measurement bounds it further: a short stage cannot "fit" nine tiles that
  // would each be 40px tall.
  test('tiles that would be unreadably small are minimized instead', async ({ page }) => {
    const small = await cap(page, 12, 520, 300, false);
    expect(small).toBeLessThan(12);
    expect(small).toBeGreaterThanOrEqual(1);
  });

  test('before the first measurement it trusts the cap rather than guessing', async ({ page }) => {
    expect(await cap(page, 9, 0, 0, true)).toBe(4);
    expect(await cap(page, 2, 0, 0, false)).toBe(2);
  });
});

test.describe('the overflow ribbon', () => {
  test.use({ viewport: PHONE });
  test.beforeEach(async ({ page }) => { await page.goto('/'); });

  const ribbonVisible = (page) =>
    page.evaluate(() => {
      const wrap = document.getElementById('video-stage-ribbon-wrap');
      return !!wrap && !wrap.classList.contains('hidden');
    });

  test('stays away while everyone fits', async ({ page }) => {
    await roomOfCameras(page, 4);
    expect(await ribbonVisible(page)).toBe(false);
    expect((await gridKeys(page)).length).toBe(4);
  });

  test('takes the fifth participant and beyond', async ({ page }) => {
    await roomOfCameras(page, 6);
    expect(await ribbonVisible(page)).toBe(true);
    expect((await gridKeys(page)).length).toBe(4);
    expect((await ribbonKeys(page)).length).toBe(2);
    // Everyone is still on the stage somewhere — nobody is silently dropped.
    const all = [...(await gridKeys(page)), ...(await ribbonKeys(page))].sort();
    expect(all).toEqual(['camera:p1', 'camera:p2', 'camera:p3', 'camera:p4', 'camera:p5', 'camera:p6']);
  });

  test('minimized tiles are marked as such and stay muted', async ({ page }) => {
    await roomOfCameras(page, 6);
    const state = await page.evaluate(() => {
      const tiles = Array.from(document.querySelectorAll('#video-stage-ribbon .video-tile'));
      return {
        mini: tiles.every((t) => t.classList.contains('video-tile-mini')),
        muted: tiles.every((t) => t.querySelector('video').muted),
      };
    });
    expect(state).toEqual({ mini: true, muted: true });
  });

  test('the ribbon is ordered by most recent speaker', async ({ page }) => {
    await roomOfCameras(page, 7);
    // Whoever is in the grid at this point has never spoken; make three of the
    // minimized peers speak, oldest first.
    const minimized = await ribbonKeys(page);
    expect(minimized.length).toBe(3);
    const ids = minimized.map((k) => k.split(':')[1]);

    await page.evaluate((order) => {
      // Speaking promotes, so silence the grid's own claim first by having the
      // minimized peers speak in a known order.
      order.forEach((id) => { updatePeerTalking(id, true); updatePeerTalking(id, false); });
      updatePeerList();
    }, ids);

    // All three spoke and so all three were promoted; the four they displaced
    // are now in the ribbon, and the one that spoke least recently of THOSE
    // sits last. Have two of the newly minimized speak, in a known order.
    const nowMinimized = (await ribbonKeys(page)).map((k) => k.split(':')[1]);
    await page.evaluate((order) => {
      updatePeerTalking(order[1], true);
      updatePeerTalking(order[1], false);
      updatePeerTalking(order[0], true);
      updatePeerTalking(order[0], false);
      updatePeerList();
    }, nowMinimized);

    // Those two are in the grid now; the ribbon holds the rest, most recent
    // speaker first — which here means the peers that never spoke are last.
    const finalGrid = await gridKeys(page);
    expect(finalGrid).toContain('camera:' + nowMinimized[0]);
    expect(finalGrid).toContain('camera:' + nowMinimized[1]);
  });

  // The point of the recency order: someone who starts talking while minimized
  // becomes visible without anybody having to go looking for them.
  test('a minimized peer who speaks is promoted into the grid', async ({ page }) => {
    await roomOfCameras(page, 6);
    const [minimizedKey] = await ribbonKeys(page);
    const speaker = minimizedKey.split(':')[1];

    await page.evaluate((id) => updatePeerTalking(id, true), speaker);

    expect(await gridKeys(page)).toContain(minimizedKey);
    expect(await ribbonKeys(page)).not.toContain(minimizedKey);
    expect((await gridKeys(page)).length).toBe(4);
  });

  // ...but only the displacement moves. A grid that re-sorted itself on every
  // press would be unreadable.
  test('the grid does not reshuffle when someone already in it speaks', async ({ page }) => {
    await roomOfCameras(page, 6);
    const before = await gridKeys(page);
    const speaker = before[before.length - 1].split(':')[1];

    await page.evaluate((id) => { updatePeerTalking(id, true); updatePeerList(); }, speaker);
    expect(await gridKeys(page)).toEqual(before);
  });

  test('a promotion swaps exactly one tile, and the demoted one keeps playing', async ({ page }) => {
    await roomOfCameras(page, 6);
    const before = await gridKeys(page);
    const speaker = (await ribbonKeys(page))[0].split(':')[1];

    await page.evaluate((id) => updatePeerTalking(id, true), speaker);
    const after = await gridKeys(page);
    const gone = before.filter((k) => !after.includes(k));
    expect(gone.length).toBe(1);
    // Moving a tile between containers must MOVE the element, never rebuild it,
    // or the demoted peer's video flashes and restarts.
    const stillHasStream = await page.evaluate((key) => {
      const el = document.querySelector('#video-stage-ribbon [data-key="' + key + '"] video');
      return !!(el && el.srcObject);
    }, gone[0]);
    expect(stillHasStream).toBe(true);
  });

  test('a screen share keeps the scrolling filmstrip and raises no ribbon', async ({ page }) => {
    await roomOfCameras(page, 6);
    await page.evaluate(() => {
      connections.get('p1').screenActive = true;
      connections.get('p1').remoteScreenStream = new MediaStream();
      updatePeerList();
    });
    expect(await page.evaluate(() =>
      document.getElementById('video-stage').classList.contains('has-focus'))).toBe(true);
    expect(await ribbonVisible(page)).toBe(false);
    expect((await gridKeys(page)).length).toBe(6);
  });

  // The immersive stage runs under the chrome, so the bottom clearance belongs
  // to whatever is actually last in the stack. A ribbon under a grid that still
  // carried the inset would sit squarely on the talk button.
  test('the ribbon clears the control stack, and the grid clears the ribbon', async ({ page }) => {
    await roomOfCameras(page, 6);
    const boxes = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect().toJSON();
      return {
        bar: r('.room-bottom-bar'),
        ribbon: r('#video-stage-ribbon'),
        tiles: [...document.querySelectorAll('#video-stage-grid .video-tile')]
          .map((e) => e.getBoundingClientRect().toJSON()),
      };
    });
    expect(boxes.ribbon.height).toBeGreaterThan(0);
    expect(boxes.ribbon.bottom).toBeLessThanOrEqual(Math.ceil(boxes.bar.top));
    for (const t of boxes.tiles) {
      expect(t.height).toBeGreaterThan(0);
      expect(t.bottom).toBeLessThanOrEqual(Math.ceil(boxes.ribbon.top));
    }
  });

  test('leaving the room forgets the grid membership and the speaking order', async ({ page }) => {
    await roomOfCameras(page, 6);
    await page.evaluate(() => { updatePeerTalking('p6', true); resetVideoState(); });
    expect(await page.evaluate(() => _stageGridKeys.length + _stageRibbonKeys.length)).toBe(0);
    expect(await page.evaluate(() => _speakerRecency.size)).toBe(0);
  });
});

test.describe('the ribbon says what it is still hiding', () => {
  test.use({ viewport: PHONE });
  test.beforeEach(async ({ page }) => { await page.goto('/'); });

  const more = (page) =>
    page.evaluate(() => {
      const el = document.getElementById('video-stage-ribbon-more');
      return { hidden: el.classList.contains('hidden'), text: el.textContent };
    });

  test('no pill while every minimized tile is reachable', async ({ page }) => {
    await roomOfCameras(page, 6);   // 2 thumbnails on a 390px strip: all visible
    expect((await more(page)).hidden).toBe(true);
  });

  test('counts the ones off the end of the strip', async ({ page }) => {
    await roomOfCameras(page, 14);  // 10 minimized, far more than a phone strip fits
    const shown = await more(page);
    expect(shown.hidden).toBe(false);
    expect(shown.text).toMatch(/^\+\d+$/);
    expect(Number(shown.text.slice(1))).toBeGreaterThan(0);
    expect(Number(shown.text.slice(1))).toBeLessThan(10);
  });

  test('the strip scrolls horizontally, and the count follows it', async ({ page }) => {
    await roomOfCameras(page, 14);
    const before = Number((await more(page)).text.slice(1));

    const scrolled = await page.evaluate(async () => {
      const strip = document.getElementById('video-stage-ribbon');
      const room = strip.scrollWidth - strip.clientWidth;
      strip.scrollLeft = room;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return { room, at: strip.scrollLeft };
    });
    // Overflowing horizontally is what makes the hidden ones reachable at all.
    expect(scrolled.room).toBeGreaterThan(0);
    expect(scrolled.at).toBeGreaterThan(0);

    // Scrolled to the end, the ones now out of sight are the ones at the start.
    const after = Number((await more(page)).text.slice(1));
    expect(after).toBeGreaterThan(0);
    expect(after).toBe(before);   // same strip, same number off-screen
  });
});

test.describe('the ribbon on the desktop stage', () => {
  test.use({ viewport: DESKTOP });
  test.beforeEach(async ({ page }) => { await page.goto('/'); });

  test('holds whatever the measured grid could not', async ({ page }) => {
    await roomOfCameras(page, 16);
    const grid = await gridKeys(page);
    const strip = await ribbonKeys(page);
    expect(grid.length).toBeLessThanOrEqual(12);
    expect(grid.length + strip.length).toBe(16);
    expect(strip.length).toBeGreaterThan(0);
  });

  test('the tiles it keeps are still laid out by the same rules', async ({ page }) => {
    await roomOfCameras(page, 16);
    const { rows, cols, tiles } = await gridShape(page);
    expect(cols * rows).toBeGreaterThanOrEqual(tiles);
    expect(Math.abs(cols - rows)).toBeLessThanOrEqual(1);
  });
});
