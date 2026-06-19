import { test, expect } from './fixtures.js';
import { seedRoom, callFn } from './_helpers.js';

// Pseudo de-duplication and anonymous-profile assignment: the logic that keeps
// two peers from showing the same name / same color+animal in a room.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test.describe('normalizePseudoKey', () => {
  test('trims and lowercases', async ({ page }) => {
    expect(await callFn(page, 'normalizePseudoKey', '  AzUre Fox  ')).toBe('azure fox');
    expect(await callFn(page, 'normalizePseudoKey', null)).toBe('');
  });
});

test.describe('collectTakenPseudoKeys', () => {
  test('includes self and connected peers, excluding the excluded id', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      myPseudo: 'Host',
      connections: [
        { id: 'p1', pseudo: 'Alice' },
        { id: 'p2', pseudo: 'Bob' },
      ],
    });
    const keys = await page.evaluate(() => Array.from(collectTakenPseudoKeys('p2')).sort());
    expect(keys).toEqual(['alice', 'host']); // self + p1; p2 excluded
  });
});

test.describe('ensureUniquePseudoForRoom', () => {
  test('returns the base name when it is free', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, myPseudo: 'Host', connections: [] });
    expect(await callFn(page, 'ensureUniquePseudoForRoom', 'Alice', null)).toBe('Alice');
  });

  test('appends an incrementing suffix when the name is taken', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      myPseudo: 'Host',
      connections: [
        { id: 'p1', pseudo: 'Alice' },
        { id: 'p2', pseudo: 'Alice 2' },
      ],
    });
    expect(await callFn(page, 'ensureUniquePseudoForRoom', 'Alice', null)).toBe('Alice 3');
  });

  test('falls back to "Anonymous" for an empty base', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, myPseudo: 'Host', connections: [] });
    expect(await callFn(page, 'ensureUniquePseudoForRoom', '', null)).toBe('Anonymous');
  });
});

test.describe('isAnonymousProfile', () => {
  test('true for a known "<Color> <Animal>" pair with the matching hex', async ({ page }) => {
    expect(await callFn(page, 'isAnonymousProfile', 'Azure Fox', '#3b82f6')).toBe(true);
  });

  test('false for a manual name with no color', async ({ page }) => {
    expect(await callFn(page, 'isAnonymousProfile', 'Alice', null)).toBe(false);
  });

  test('false when the hex is not one of the anon palette colors', async ({ page }) => {
    expect(await callFn(page, 'isAnonymousProfile', 'Azure Fox', '#000000')).toBe(false);
  });

  test('false when the words are not a known color + animal', async ({ page }) => {
    expect(await callFn(page, 'isAnonymousProfile', 'Random Name', '#3b82f6')).toBe(false);
  });
});

test.describe('assignUniqueAnonProfile', () => {
  test('keeps the requested color + animal when both are free', async ({ page }) => {
    // Self is anon "Azure Fox"; request "Crimson Wolf" for a different peer.
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      myPseudo: '',
      anonymousProfile: { pseudo: 'Azure Fox', pseudoColor: '#3b82f6' },
      connections: [],
    });
    const r = await callFn(page, 'assignUniqueAnonProfile', 'Crimson Wolf', 'newpeer');
    expect(r).toEqual({ pseudo: 'Crimson Wolf', pseudoColor: '#ef4444' });
  });

  test('reassigns a color already taken by another peer', async ({ page }) => {
    // Self is anon "Azure Fox"; a new peer also requests Azure -> color must change,
    // free animal (Otter) is preserved.
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      myPseudo: '',
      anonymousProfile: { pseudo: 'Azure Fox', pseudoColor: '#3b82f6' },
      connections: [],
    });
    const r = await callFn(page, 'assignUniqueAnonProfile', 'Azure Otter', 'newpeer');
    expect(r.pseudoColor).not.toBe('#3b82f6'); // not Azure
    expect(r.pseudo.endsWith('Otter')).toBe(true);
  });
});

test.describe('canonicalizePeerProfile', () => {
  test('de-duplicates a colliding manual name and preserves a custom color', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      myPseudo: 'Alice',
      connections: [],
    });
    const r = await callFn(page, 'canonicalizePeerProfile', 'newpeer', 'Alice', '#123456');
    expect(r).toEqual({ pseudo: 'Alice 2', pseudoColor: '#123456' });
  });

  test('routes a known anon pair through the anon de-duplication path', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      myPseudo: '',
      anonymousProfile: { pseudo: 'Azure Fox', pseudoColor: '#3b82f6' },
      connections: [],
    });
    const r = await callFn(page, 'canonicalizePeerProfile', 'newpeer', 'Crimson Wolf', '#ef4444');
    expect(r).toEqual({ pseudo: 'Crimson Wolf', pseudoColor: '#ef4444' });
  });
});
