import { test, expect } from '@playwright/test';
import { seedRoom, callFn } from './_helpers.js';

// The authoritative peer-list the host broadcasts (and the shortId fallback it
// uses when a peer has no known pseudo yet).

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test.describe('shortId', () => {
  test('passes short ids through unchanged', async ({ page }) => {
    expect(await callFn(page, 'shortId', 'alice')).toBe('alice');
  });

  test('truncates long ids with an ellipsis', async ({ page }) => {
    const r = await callFn(page, 'shortId', '12345678-1234-1234-1234-123456789abc');
    expect(r).toBe('123456…' + '9abc');
  });
});

test.describe('buildHostPeerList', () => {
  test('lists connected peers with their pseudos and colors', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      knownPeerIds: ['p1', 'p2'],
      connections: [
        { id: 'p1', pseudo: 'Alice', pseudoColor: '#ef4444', open: true },
        { id: 'p2', pseudo: 'Bob', pseudoColor: null, open: true },
      ],
    });
    const list = await callFn(page, 'buildHostPeerList', null);
    expect(list).toEqual([
      { id: 'p1', pseudo: 'Alice', pseudoColor: '#ef4444' },
      { id: 'p2', pseudo: 'Bob', pseudoColor: null },
    ]);
  });

  test('excludes the excluded peer id', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      knownPeerIds: ['p1', 'p2'],
      connections: [
        { id: 'p1', pseudo: 'Alice', open: true },
        { id: 'p2', pseudo: 'Bob', open: true },
      ],
    });
    const list = await callFn(page, 'buildHostPeerList', 'p1');
    expect(list.map((e) => e.id)).toEqual(['p2']);
  });

  test('falls back to a shortId when a peer has no pseudo', async ({ page }) => {
    const longId = '12345678-1234-1234-1234-123456789abc';
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      knownPeerIds: [longId],
      connections: [{ id: longId, open: true }],
    });
    const list = await callFn(page, 'buildHostPeerList', null);
    expect(list[0].pseudo).toBe('123456…' + '9abc');
  });

  test('surfaces video / screen-share flags', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      knownPeerIds: ['p1', 'p2'],
      connections: [
        { id: 'p1', pseudo: 'Alice', open: true, videoActive: true },
        { id: 'p2', pseudo: 'Bob', open: true, screenActive: true },
      ],
    });
    const list = await callFn(page, 'buildHostPeerList', null);
    expect(list.find((e) => e.id === 'p1').videoActive).toBe(true);
    expect(list.find((e) => e.id === 'p2').screenActive).toBe(true);
  });
});
