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

  // KNOWN ISSUE — reproduced by this harness. When a host dies and 2+ peers
  // survive, migration can split-brain (two hosts that never reconcile). Root
  // cause: the elected deputy calls becomeHost() and immediately broadcasts an
  // authoritative peer-list/successorIds built only from its open *data*
  // connections. In the star topology survivors have no data link to each other
  // (and, in a silent room, no media link either — audio is lazy), so that list
  // is empty and RESETS the other survivor's authoritative successor chain while
  // it is still mid-election → it elects itself too.
  //   - Graceful simultaneous close (tab closed without leaveRoom): fails ~always.
  //   - Crash / heartbeat-timeout: races — the connectToNewHost retry usually but
  //     not reliably lets the deputy stabilise first, so it is flaky, not safe.
  // Likely fix: a freshly-promoted host should keep placeholders for knownPeerIds
  // (cf. startMigrationSettle/ensurePlaceholdersForKnownPeers) instead of
  // broadcasting an empty roster, and/or a peer should ignore an empty
  // authoritative peer-list while roomState === 'migrating'. Both kill paths are
  // exercised below; remove `.fixme` once migration no longer splits.
  for (const variant of [
    { name: 'crash (heartbeat timeout)', kill: killPeer },
    { name: 'simultaneous graceful close', kill: killPeerGraceful },
  ]) {
    test.fixme(`multi-survivor host migration must not split-brain — ${variant.name}`, async ({ makePeer }) => {
      const host = await makePeer({ pseudo: 'Hostie' });
      const code = await createRoom(host);
      const a = await makePeer({ pseudo: 'Alice' });
      const b = await makePeer({ pseudo: 'Bob' });
      await joinRoom(a, code);
      await joinRoom(b, code);
      for (const p of [host, a, b]) await expect.poll(() => rosterCount(p), POLL).toBe(3);
      await waitForSharedDeputy(expect, [a, b], POLL);

      await variant.kill(host);

      // Eventually exactly one host, one shared room code, roster of 2 on both.
      await expect
        .poll(async () => (await Promise.all([a, b].map(getState))).filter((s) => s.isHost).length, POLL)
        .toBe(1);
      for (const p of [a, b]) await expect.poll(() => rosterCount(p), POLL).toBe(2);
      const survivors = await Promise.all([a, b].map(getState));
      expect(new Set(survivors.map((s) => s.roomCode)).size).toBe(1);
    });
  }
});
