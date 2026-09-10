import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// One key to every room control, including the ones a layout has put behind an
// edge handle. What it offers is read off the room's own buttons, so a control
// that is not there is not an action.

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await seedRoom(page, {
    selfId: 'me', isHost: false, roomCode: 'the-host',
    connections: [{ id: 'the-host', pseudo: 'Host' }],
  });
  await page.evaluate(() => {
    showScreen('room');
    resetChatState();
    toggleChatPanel(false);
    closeCommandPalette();
    // The camera row is only on screen when the room offers video at all.
    document.getElementById('btn-share-camera').classList.remove('hidden');
    document.getElementById('btn-share-screen').classList.remove('hidden');
  });
});

const labels = (page) => page.evaluate(() =>
  Array.from(document.querySelectorAll('#command-palette-list .command-palette-item .command-palette-label'))
    .map((el) => el.textContent));

test('the accelerator opens it, and opens it only inside a room', async ({ page }) => {
  await page.keyboard.press('Control+k');
  expect(await page.evaluate(() => commandPaletteOpen())).toBe(true);
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => commandPaletteOpen())).toBe(false);

  await page.evaluate(() => { inRoom = false; });
  await page.keyboard.press('Control+k');
  expect(await page.evaluate(() => commandPaletteOpen())).toBe(false);
});

test('it lists the room controls, with their own keys beside them', async ({ page }) => {
  await page.evaluate(() => openCommandPalette());
  expect(await labels(page)).toEqual([
    'Turn camera on', 'Share your screen', 'Show the chat', 'Go hands-free', 'Hold to talk',
  ]);
  const keys = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#command-palette-list .command-palette-keys')).map((el) => el.textContent));
  expect(keys).toContain('Enter');
  expect(keys.some((k) => /E$/.test(k))).toBe(true);
});

test('a control the room does not offer is not an action', async ({ page }) => {
  await page.evaluate(() => {
    document.getElementById('btn-share-camera').classList.add('hidden');
    document.getElementById('btn-share-screen').classList.add('hidden');
    openCommandPalette();
  });
  expect(await labels(page)).toEqual(['Show the chat', 'Go hands-free', 'Hold to talk']);
});

test('the participants are only listed where they are behind a handle', async ({ page }) => {
  await page.evaluate(() => openCommandPalette());
  expect(await labels(page)).not.toContain('Show the participants');
  // The immersive phone stage is the one layout where the roster is not simply
  // a column already on screen.
  await page.evaluate(() => closeCommandPalette());
  await page.setViewportSize({ width: 420, height: 780 });
  await page.evaluate(() => openCommandPalette());
  expect(await labels(page)).toContain('Show the participants');
});

test('running one does the thing and puts the palette away', async ({ page }) => {
  await page.evaluate(() => openCommandPalette());
  await page.keyboard.type('chat');
  await page.keyboard.press('Enter');
  const seen = await page.evaluate(() => ({ open: commandPaletteOpen(), chat: chatPanelOpen() }));
  expect(seen).toEqual({ open: false, chat: true });
});

test('the arrows never land on the row that is only a reminder', async ({ page }) => {
  await page.evaluate(() => openCommandPalette());
  const active = await page.evaluate(() => {
    const rows = [];
    for (let i = 0; i < _paletteItems.length + 1; i++) {
      rows.push(_paletteItems[_paletteIndex].id);
      moveCommandPalette(1);
    }
    return rows;
  });
  expect(active).not.toContain('talk');
});

test('what is already on says so', async ({ page }) => {
  await page.evaluate(() => { toggleChatPanel(true, { focus: false }); openCommandPalette(); });
  const seen = await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll('.command-palette-item'))
      .find((el) => el.textContent.indexOf('chat') !== -1);
    return { label: row.textContent, on: row.classList.contains('command-palette-on') };
  });
  expect(seen.label).toContain('Hide the chat');
  expect(seen.on).toBe(true);
});

test('a click on the backdrop closes it, a click on the box does not', async ({ page }) => {
  await page.evaluate(() => openCommandPalette());
  await page.evaluate(() => document.querySelector('.command-palette-box').click());
  expect(await page.evaluate(() => commandPaletteOpen())).toBe(true);
  await page.evaluate(() => document.getElementById('command-palette').click());
  expect(await page.evaluate(() => commandPaletteOpen())).toBe(false);
});

test.describe('the direct keys', () => {
  test('the chat has one, and it works from inside the composer', async ({ page }) => {
    await page.evaluate(() => { toggleChatPanel(true, { focus: false }); });
    await page.focus('#chat-input');
    await page.keyboard.press('Control+b');
    expect(await page.evaluate(() => chatPanelOpen())).toBe(false);
  });

  test('the camera key is ignored where there is no camera control', async ({ page }) => {
    const ran = await page.evaluate(() => {
      document.getElementById('btn-share-camera').classList.add('hidden');
      let started = false;
      const real = window.startVideoShare;
      window.startVideoShare = () => { started = true; };
      const e = new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, bubbles: true, cancelable: true });
      const handled = handleRoomAccelShortcut(e);
      window.startVideoShare = real;
      return { started, handled };
    });
    expect(ran).toEqual({ started: false, handled: false });
  });

  test("push-to-talk keeps its own binding", async ({ page }) => {
    const handled = await page.evaluate(() => {
      applyNewShortcut('Ctrl+KeyE');
      const e = new KeyboardEvent('keydown', { key: 'e', code: 'KeyE', ctrlKey: true, bubbles: true, cancelable: true });
      return handleRoomAccelShortcut(e);
    });
    expect(handled).toBe(false);
  });
});
