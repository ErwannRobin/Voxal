import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { test, expect } from './fixtures.js';

// UI translation (src/i18n.js, src/locales/*.json). English is the markup and
// the tr() defaults; every other language is a JSON file fetched on demand.

const locale = (code) => JSON.parse(fs.readFileSync(`src/locales/${code}.json`, 'utf8'));
const LANGS = ['fr', 'es', 'de', 'pt', 'ro', 'ru', 'uk', 'id', 'zh', 'ja', 'ar'];

test('locale files carry exactly the same keys and placeholders as en.json', () => {
  const out = execFileSync('node', ['scripts/i18n-check.mjs'], { encoding: 'utf8' });
  expect(out).toContain('i18n ok');
});

test('English is untouched and the document says so', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#btn-create')).toHaveText('Create Room');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('data-text-dir', 'ltr');
});

test('a stored language translates markup, placeholders and tooltips', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('language', 'fr'));
  await page.goto('/');
  const fr = locale('fr');
  await expect(page.locator('#btn-create')).toHaveText(fr['ui.create_room']);
  await expect(page.locator('#input-code')).toHaveAttribute('placeholder', fr['ui.room_code']);
  await expect(page.locator('#btn-open-settings')).toHaveAttribute('aria-label', fr['ui.open_settings']);
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
});

test('Arabic keeps the left-to-right layout but gets right-to-left text', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('language', 'ar'));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-text-dir', 'rtl');
  await expect(page.locator('html')).not.toHaveAttribute('dir', 'rtl');
  await expect(page.locator('#btn-create')).toHaveText(locale('ar')['ui.create_room']);
});

test('switching language live repaints, and "automatic" falls back to the device', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => I18N.setLanguage('de'));
  await expect(page.locator('#btn-create')).toHaveText(locale('de')['ui.create_room']);
  expect(await page.evaluate(() => localStorage.getItem('language'))).toBe('de');
  await page.evaluate(() => I18N.setLanguage(''));
  await expect(page.locator('#btn-create')).toHaveText('Create Room');
  expect(await page.evaluate(() => localStorage.getItem('language'))).toBeNull();
});

test('every shipped language loads and repaints a mixed element without losing its icon', async ({ page }) => {
  await page.goto('/');
  for (const code of LANGS) {
    await page.evaluate((c) => I18N.setLanguage(c), code);
    await expect(page.locator('html')).toHaveAttribute('lang', code);
    await expect(page.locator('#btn-create')).toHaveText(locale(code)['ui.create_room']);
  }
  // The gear icon sits inside a tagged button's siblings; the tagged <li> keeps its <strong>.
  expect(await page.locator('#btn-open-settings svg').count()).toBe(1);
});

test('text the page changed itself is not overwritten by a language switch', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { document.getElementById('rejoin-label').textContent = 'Last room · 3 peers'; });
  await page.evaluate(() => I18N.setLanguage('es'));
  await expect(page.locator('#btn-create')).toHaveText(locale('es')['ui.create_room']);
  await expect(page.locator('#rejoin-label')).toHaveText('Last room · 3 peers');
});

test('tr() interpolates and picks the plural form of the language', async ({ page }) => {
  await page.goto('/');
  const en = await page.evaluate(() => [
    tr('t.k', 'Hi {name}', { name: 'Ana' }),
    tr('t.p', { one: '{n} peer', other: '{n} peers' }, { n: 1 }),
    tr('t.p', { one: '{n} peer', other: '{n} peers' }, { n: 5 }),
  ]);
  expect(en).toEqual(['Hi Ana', '1 peer', '5 peers']);
  // Russian has a "few" form (2-4): the shipped file must give it its own text.
  await page.evaluate(() => I18N.setLanguage('ru'));
  const ru = await page.evaluate(() => [1, 2, 5].map((n) => tr('js.lines_count', { one: '', other: '' }, { n })));
  expect(new Set(ru).size).toBe(3);
});

test.describe('device language', () => {
  test.use({ locale: 'pt-BR' });
  test('is followed when nothing was chosen', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'pt');
    await expect(page.locator('#btn-create')).toHaveText(locale('pt')['ui.create_room']);
  });
});

test('the language picker lists every language and applies the choice', async ({ page }) => {
  await page.goto('/');
  const values = await page.$$eval('#select-language option', (o) => o.map((x) => x.value));
  expect(values).toEqual(['', 'en', 'fr', 'es', 'de', 'pt', 'ro', 'ru', 'uk', 'id', 'zh', 'ja', 'ar']);
  await page.evaluate(() => {
    const s = document.getElementById('select-language');
    s.value = 'ja'; s.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
});
