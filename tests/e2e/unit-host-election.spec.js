import { test, expect } from '@playwright/test';
import { seedRoom, callFn } from './_helpers.js';

// Host migration is the most-iterated, most-fragile subsystem in main.js
// (see KNOWLEDGE/learning.md). These tests lock in the election + successor-chain
// invariants that the documented split-brain fixes depend on.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test.describe('authoritativeElectHostId', () => {
  test('elects the lexicographically smallest candidate', async ({ page }) => {
    await seedRoom(page, { selfId: 'm-self', knownPeerIds: ['z-peer', 'a-peer'] });
    expect(await callFn(page, 'authoritativeElectHostId', null)).toBe('a-peer');
  });

  test('includes self as a candidate', async ({ page }) => {
    await seedRoom(page, { selfId: 'a-self', knownPeerIds: ['z-peer'] });
    expect(await callFn(page, 'authoritativeElectHostId', null)).toBe('a-self');
  });

  test('excludes the excluded (dead host) peer id', async ({ page }) => {
    await seedRoom(page, { selfId: 'm-self', knownPeerIds: ['a-deadhost', 'b-peer'] });
    expect(await callFn(page, 'authoritativeElectHostId', 'a-deadhost')).toBe('b-peer');
  });

  test('elects from the authoritative snapshot, not the live roster (split-brain guard)', async ({ page }) => {
    // Documented root cause: basing election on the locally-mutated live roster
    // (knownPeerIds) diverges between peers. The snapshot must win.
    await seedRoom(page, {
      selfId: 'c-self',
      knownPeerIds: ['a-peer', 'b-driftedin'], // live roster has drifted
      authoritativePeerIds: ['a-peer'],          // last authoritative host snapshot
    });
    expect(await callFn(page, 'authoritativeElectHostId', null)).toBe('a-peer');
  });

  test('returns null when there are no candidates', async ({ page }) => {
    await page.evaluate(() => {
      peer = { id: null };
      knownPeerIds.clear();
      resetAuthoritativePeerIds([]);
    });
    expect(await callFn(page, 'authoritativeElectHostId', null)).toBe(null);
  });
});

test.describe('successor chain', () => {
  test('setAuthoritativeSuccessorIds de-duplicates and drops blanks', async ({ page }) => {
    const chain = await page.evaluate(() => {
      setAuthoritativeSuccessorIds(['b', 'b', '', 'c', null, 'b']);
      return _authoritativeSuccessorIds.slice();
    });
    expect(chain).toEqual(['b', 'c']);
  });

  test('currentDeputyId (non-host) follows the authoritative successor chain', async ({ page }) => {
    await seedRoom(page, { selfId: 'z-self', isHost: false, successorIds: ['b-deputy', 'c-next'] });
    expect(await callFn(page, 'currentDeputyId')).toBe('b-deputy');
  });

  test('currentDeputyId (non-host) falls back to local election with no chain', async ({ page }) => {
    await seedRoom(page, { selfId: 'm-self', isHost: false, knownPeerIds: ['a-peer'], successorIds: [] });
    // electHostId uses knownPeerIds + self → smallest is 'a-peer'
    expect(await callFn(page, 'currentDeputyId')).toBe('a-peer');
  });
});

test.describe('reconcileHostSuccessorIds (host side)', () => {
  test('drops successors without an open data connection', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      successorIds: ['gone', 'live'],
      connections: [
        { id: 'gone', open: false },
        { id: 'live', open: true },
      ],
    });
    const chain = await callFn(page, 'reconcileHostSuccessorIds');
    expect(chain).toEqual(['live']);
  });

  test('appends newly connected peers while preserving existing order', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      successorIds: ['first'],
      connections: [
        { id: 'first', open: true },
        { id: 'newcomer', open: true },
      ],
    });
    const chain = await callFn(page, 'reconcileHostSuccessorIds');
    expect(chain).toEqual(['first', 'newcomer']);
  });

  test('host currentDeputyId is the first connected successor', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      successorIds: ['dead', 'alive'],
      connections: [
        { id: 'dead', open: false },
        { id: 'alive', open: true },
      ],
    });
    expect(await callFn(page, 'currentDeputyId')).toBe('alive');
  });
});

test.describe('preferredSuccessorCandidates', () => {
  test('uses the authoritative chain, excludes the excluded peer, appends self last', async ({ page }) => {
    await seedRoom(page, { selfId: 'a-self', successorIds: ['b', 'c'] });
    expect(await callFn(page, 'preferredSuccessorCandidates', 'b')).toEqual(['c', 'a-self']);
  });

  test('de-duplicates self when already present in the chain', async ({ page }) => {
    await seedRoom(page, { selfId: 'b', successorIds: ['b', 'c'] });
    expect(await callFn(page, 'preferredSuccessorCandidates', null)).toEqual(['b', 'c']);
  });

  test('falls back to authoritative election candidates when no chain exists', async ({ page }) => {
    await seedRoom(page, { selfId: 'm-self', knownPeerIds: ['a-peer', 'z-peer'], successorIds: [] });
    // base = authoritativeElectionCandidates(null) sorted = ['a-peer','m-self','z-peer'];
    // self ('m-self') already included, so order is preserved.
    expect(await callFn(page, 'preferredSuccessorCandidates', null)).toEqual(['a-peer', 'm-self', 'z-peer']);
  });
});
