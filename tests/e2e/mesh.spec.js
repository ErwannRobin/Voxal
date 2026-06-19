import { test, expect } from './mesh-fixtures.js';
import {
  createRoom,
  joinRoom,
  speak,
  killPeer,
  killPeerGraceful,
  getState,
  rosterCount,
  rosterText,
  waitForSharedDeputy,
} from './mesh-helpers.js';

// Multi-peer mesh tests — real PeerJS signaling + real WebRTC between isolated
// headless-Chromium contexts, driven through a local PeerServer broker. These
// exercise the connection / mesh / host-migration glue in main.js that the
// pure-logic unit tests can't reach. Tagged @mesh so the fast suite skips them.

const POLL = { timeout: 25_000, intervals: [200, 400, 800] };

test.describe('mesh @mesh', () => {
  test('three peers converge on one host and a shared roster', async ({ makePeer }) => {
    const host = await makePeer({ pseudo: 'Hostie' });
    const code = await createRoom(host);
    expect(code).toBeTruthy();

    const a = await makePeer({ pseudo: 'Alice' });
    const b = await makePeer({ pseudo: 'Bob' });
    await joinRoom(a, code);
    await joinRoom(b, code);

    // Everyone sees all three participants.
    for (const p of [host, a, b]) {
      await expect.poll(() => rosterCount(p), POLL).toBe(3);
    }

    // Exactly one host, and all peers agree on the room code.
    const states = await Promise.all([host, a, b].map(getState));
    expect(states.filter((s) => s.isHost)).toHaveLength(1);
    expect(new Set(states.map((s) => s.roomCode)).size).toBe(1);
    expect(states.find((s) => s.isHost).peerId).toBe(code);
  });

  test('a rename propagates across the mesh', async ({ makePeer }) => {
    const host = await makePeer({ pseudo: 'Hostie' });
    const code = await createRoom(host);
    const a = await makePeer({ pseudo: 'Alice' });
    await joinRoom(a, code);

    for (const p of [host, a]) {
      await expect.poll(() => rosterCount(p), POLL).toBe(2);
    }

    // A non-host renames itself; the new name must reach the host's roster.
    await a.evaluate(() => window.setMyPseudo('RenamedAlice'));
    await expect.poll(() => rosterText(host), POLL).toContain('RenamedAlice');

    // And a host rename must reach the joiner.
    await host.evaluate(() => window.setMyPseudo('RenamedHost'));
    await expect.poll(() => rosterText(a), POLL).toContain('RenamedHost');
  });

  test('audio mesh forms once peers transmit', async ({ makePeer }) => {
    const host = await makePeer({ pseudo: 'Hostie' });
    const code = await createRoom(host);
    const a = await makePeer({ pseudo: 'Alice' });
    await joinRoom(a, code);

    for (const p of [host, a]) {
      await expect.poll(() => rosterCount(p), POLL).toBe(2);
    }

    // Both acquire the fake mic and transmit, opening MediaConnections both ways.
    await Promise.all([speak(host), speak(a)]);

    for (const p of [host, a]) {
      await expect.poll(async () => (await getState(p)).incomingAudio, POLL).toBeGreaterThanOrEqual(1);
    }
  });

  test('host migration: the lone survivor takes over when the host crashes', async ({ makePeer }) => {
    const host = await makePeer({ pseudo: 'Hostie' });
    const code = await createRoom(host);
    const a = await makePeer({ pseudo: 'Alice' });
    await joinRoom(a, code);

    for (const p of [host, a]) {
      await expect.poll(() => rosterCount(p), POLL).toBe(2);
    }
    // Alice must recognise herself as deputy before the host disappears.
    await waitForSharedDeputy(expect, [a], POLL);

    // The host crashes (detected via heartbeat timeout).
    await killPeer(host);

    // Alice promotes herself and the room is a stable, single-host room of one.
    await expect.poll(async () => (await getState(a)).isHost, POLL).toBe(true);
    await expect.poll(() => rosterCount(a), POLL).toBe(1);
    expect((await getState(a)).roomCode).toBe((await getState(a)).peerId);
  });

  test('a new peer can join a room that has already migrated', async ({ makePeer }) => {
    const host = await makePeer({ pseudo: 'Hostie' });
    const code = await createRoom(host);
    const a = await makePeer({ pseudo: 'Alice' });
    await joinRoom(a, code);
    for (const p of [host, a]) {
      await expect.poll(() => rosterCount(p), POLL).toBe(2);
    }
    await waitForSharedDeputy(expect, [a], POLL);

    // Host dies; Alice becomes the new host.
    await killPeer(host);
    await expect.poll(async () => (await getState(a)).isHost, POLL).toBe(true);

    // A brand-new peer joins using the new host's code and the room reaches two.
    const newCode = (await getState(a)).roomCode;
    const c = await makePeer({ pseudo: 'Carol' });
    await joinRoom(c, newCode);

    for (const p of [a, c]) {
      await expect.poll(() => rosterCount(p), POLL).toBe(2);
    }
  });

  // Regression guard for a host-migration split-brain this harness found and we
  // fixed: when a host disappeared and 2+ peers survived, a dying host could
  // broadcast a shrunken peer-list/successorIds during its own connection
  // teardown, poisoning a survivor's successor chain so it elected itself too
  // (two hosts). The fix defers the host's peer-left broadcast one tick and skips
  // it once `peer.destroyed` is set, so survivors migrate from the last healthy
  // chain. Both host-loss paths are exercised.
  for (const variant of [
    { name: 'crash (heartbeat timeout)', kill: killPeer },
    { name: 'simultaneous graceful close', kill: killPeerGraceful },
  ]) {
    test(`multi-survivor host migration does not split-brain — ${variant.name}`, async ({ makePeer }) => {
      const host = await makePeer({ pseudo: 'Hostie' });
      const code = await createRoom(host);
      const a = await makePeer({ pseudo: 'Alice' });
      const b = await makePeer({ pseudo: 'Bob' });
      await joinRoom(a, code);
      await joinRoom(b, code);
      for (const p of [host, a, b]) await expect.poll(() => rosterCount(p), POLL).toBe(3);
      await waitForSharedDeputy(expect, [a, b], POLL);

      await variant.kill(host);

      // Wait for the room to CONVERGE (one combined poll, so we assert the final
      // settled state rather than catching a transient mid-migration window):
      // exactly one host, a single shared room code, and a 2-peer roster on both.
      // A true split-brain (two permanent hosts) never satisfies this and fails.
      await expect
        .poll(async () => {
          const [sa, sb] = await Promise.all([a, b].map(getState));
          const hosts = [sa, sb].filter((s) => s.isHost).length;
          const codes = new Set([sa, sb].map((s) => s.roomCode)).size;
          const rosters = await Promise.all([a, b].map(rosterCount));
          return hosts === 1 && codes === 1 && rosters.every((n) => n === 2);
        }, POLL)
        .toBe(true);
    });
  }
});
