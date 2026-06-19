import { test, expect } from '@playwright/test';
import { callFn } from './_helpers.js';

const UUID = '12345678-1234-1234-1234-123456789abc';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test.describe('normalizeRoomCode', () => {
  test('passes a bare UUID through unchanged', async ({ page }) => {
    expect(await callFn(page, 'normalizeRoomCode', UUID)).toBe(UUID);
  });

  test('extracts the room UUID from a full invite URL', async ({ page }) => {
    expect(await callFn(page, 'normalizeRoomCode', `https://ptt.voxal.app/?room=${UUID}`)).toBe(UUID);
  });

  test('decodes a percent-encoded room param', async ({ page }) => {
    const code = await callFn(page, 'normalizeRoomCode', `https://ptt.voxal.app/?room=${encodeURIComponent(UUID)}`);
    expect(code).toBe(UUID);
  });

  test('finds a room query fragment embedded in free text', async ({ page }) => {
    const code = await callFn(page, 'normalizeRoomCode', `join me here ?room=${UUID} now`);
    expect(code).toBe(UUID);
  });

  test('extracts a bare UUID embedded in arbitrary text', async ({ page }) => {
    expect(await callFn(page, 'normalizeRoomCode', `code is ${UUID} ok`)).toBe(UUID);
  });

  test('keeps a non-UUID channel name as-is (case preserved)', async ({ page }) => {
    expect(await callFn(page, 'normalizeRoomCode', 'Team-Standup')).toBe('Team-Standup');
  });

  test('trims surrounding whitespace', async ({ page }) => {
    expect(await callFn(page, 'normalizeRoomCode', `   ${UUID}   `)).toBe(UUID);
  });

  test('returns empty string for empty / nullish input', async ({ page }) => {
    expect(await callFn(page, 'normalizeRoomCode', '')).toBe('');
    expect(await callFn(page, 'normalizeRoomCode', '   ')).toBe('');
    expect(await callFn(page, 'normalizeRoomCode', null)).toBe('');
  });
});

test.describe('parseRoomFromUrlCandidate', () => {
  test('returns the room param from a valid URL', async ({ page }) => {
    expect(await callFn(page, 'parseRoomFromUrlCandidate', `https://x/?room=${UUID}`)).toBe(UUID);
  });

  test('returns empty string for a non-URL string', async ({ page }) => {
    expect(await callFn(page, 'parseRoomFromUrlCandidate', 'not a url')).toBe('');
  });

  test('returns empty string when the URL has no room param', async ({ page }) => {
    expect(await callFn(page, 'parseRoomFromUrlCandidate', 'https://voxal.app/about')).toBe('');
  });
});

test.describe('firstConnectedPeerId', () => {
  test('returns the lexicographically smallest connected peer id', async ({ page }) => {
    const item = { connected: [{ peer_id: 'zeta' }, { peer_id: 'alpha' }, { peer_id: 'mid' }] };
    expect(await callFn(page, 'firstConnectedPeerId', item)).toBe('alpha');
  });

  test('returns null when there are no connected peers', async ({ page }) => {
    expect(await callFn(page, 'firstConnectedPeerId', { connected: [] })).toBe(null);
    expect(await callFn(page, 'firstConnectedPeerId', {})).toBe(null);
  });

  test('ignores blank / missing peer ids', async ({ page }) => {
    const item = { connected: [{ peer_id: '  ' }, { peer_id: 'real' }, {}] };
    expect(await callFn(page, 'firstConnectedPeerId', item)).toBe('real');
  });
});
