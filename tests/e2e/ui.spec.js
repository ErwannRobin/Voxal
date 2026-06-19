import { test, expect } from './fixtures.js';

// DOM / interaction flows that don't require a live PeerJS connection.

test.describe('navigation & screens', () => {
  test('home is the active screen on load', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#screen-home')).toHaveClass(/active/);
  });

  test('showError switches to the error screen with the message', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => showError('Something broke'));
    await expect(page.locator('#screen-error')).toHaveClass(/active/);
    await expect(page.locator('#screen-home')).not.toHaveClass(/active/);
    await expect(page.locator('#error-message')).toHaveText('Something broke');
  });

  test('showScreen can navigate back to home', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => showScreen('error'));
    await expect(page.locator('#screen-error')).toHaveClass(/active/);
    await page.evaluate(() => showScreen('home'));
    await expect(page.locator('#screen-home')).toHaveClass(/active/);
  });
});

test.describe('room code input', () => {
  test('clear (×) button empties the field', async ({ page }) => {
    await page.goto('/');
    const input = page.locator('#input-code');
    await input.fill('some-room');
    await expect(input).toHaveValue('some-room');
    await page.locator('.input-clear[data-target="input-code"]').click();
    await expect(input).toHaveValue('');
  });
});

test.describe('theme toggle', () => {
  // The theme toggle lives in the "System" settings section, reached via the
  // settings sidebar nav.
  async function openThemeSection(page) {
    await page.click('#btn-open-settings');
    await page.click('#modal-settings-sidebar .prefs-nav-btn[data-target="settings-system"]');
  }

  test('selecting Light updates data-theme and persists it', async ({ page }) => {
    await page.goto('/');
    await openThemeSection(page);
    await page.click('#theme-toggle button[data-theme="light"]');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const stored = await page.evaluate(() => localStorage.getItem('theme'));
    expect(stored).toBe('light');
  });

  test('selecting Dark updates data-theme and persists it', async ({ page }) => {
    await page.goto('/');
    await openThemeSection(page);
    await page.click('#theme-toggle button[data-theme="dark"]');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('dark');
  });

  test('a persisted theme is applied before first paint on reload', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('theme', 'light'));
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });
});
