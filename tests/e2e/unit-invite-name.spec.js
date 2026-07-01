import { test, expect } from './fixtures.js';

// Tiny-compact pre-join Start screen (#screen-invite-loading): the "Your name"
// input is shown on its own line above the Start button so the user can set a
// name before connecting.

async function showCompactStart(page, { anon = true } = {}) {
  await page.setViewportSize({ width: 160, height: 240 });
  await page.goto('/?ui=tiny&room=demo');
  await page.evaluate((isAnon) => {
    document.body.classList.add('embed-tiny', 'tiny-compact');
    if (isAnon) { _anonymousProfile = { pseudo: 'Azure Fox', pseudoColor: '#3b82f6' }; myPseudo = ''; }
    else { myPseudo = 'Alice'; }
    showTinyInviteConnect('demo');
  }, anon);
}

test('shows the name input on its own line above the Start button', async ({ page }) => {
  await showCompactStart(page, { anon: true });
  const info = await page.evaluate(() => {
    const field = document.querySelector('#screen-invite-loading .invite-pseudo-field');
    const input = document.getElementById('input-pseudo-invite');
    const btn = document.getElementById('btn-cancel-invite-join');
    const ir = input.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    return {
      fieldDisplay: getComputedStyle(field).display,
      startText: btn.textContent,
      inputAboveButton: ir.bottom <= br.top + 1,
    };
  });
  expect(info.fieldDisplay).not.toBe('none');
  expect(info.startText).toBe('Start');
  expect(info.inputAboveButton).toBe(true);
});

test('anonymous name is shown as placeholder, value stays empty', async ({ page }) => {
  await showCompactStart(page, { anon: true });
  const input = page.locator('#input-pseudo-invite');
  expect(await input.inputValue()).toBe('');
  expect(await input.getAttribute('placeholder')).toBe('Azure Fox');
});

test('a manual name is shown as the value', async ({ page }) => {
  await showCompactStart(page, { anon: false });
  expect(await page.locator('#input-pseudo-invite').inputValue()).toBe('Alice');
});

test('typing a name propagates via setMyPseudo', async ({ page }) => {
  await showCompactStart(page, { anon: true });
  await page.fill('#input-pseudo-invite', 'Alice');
  expect(await page.evaluate(() => myPseudo)).toBe('Alice');
});

test('the field is hidden while connecting', async ({ page }) => {
  await showCompactStart(page, { anon: true });
  await page.evaluate(() => document.getElementById('screen-invite-loading').classList.add('tiny-connecting'));
  const display = await page.evaluate(
    () => getComputedStyle(document.querySelector('#screen-invite-loading .invite-pseudo-field')).display
  );
  expect(display).toBe('none');
});
