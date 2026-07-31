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
  outgoingAudioSenderCounts,
  negotiatedOpusFmtp,
} from './mesh-helpers.js';

// Multi-peer mesh tests — real PeerJS signaling + real WebRTC between isolated
// headless-Chromium contexts, driven through a local PeerServer broker. These
// exercise the connection / mesh / host-migration glue in main.js that the
// pure-logic unit tests can't reach. Tagged @mesh so the fast suite skips them.

// Generous timeout: real WebRTC + heartbeat-timeout host-loss detection (~7s)
// and multi-hop migration (e.g. host+deputy failing together) can take ~20s to
// converge. expect.poll resolves as soon as the condition holds, so this only
// adds headroom for slow/CI runs — it does not slow the common case.
const POLL = { timeout: 45_000, intervals: [200, 400, 800] };

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

  // Guards the outgoing-audio bound. A speaker uploads one Opus stream per
  // listener, so wasted uplink is what makes the *other* side sound chopped.
  //
  // NOTE: this asserts at most ONE outgoing call per peer, not exactly one.
  // `connectOutgoingAudioToPeers` skips a peer that can already be seen to be
  // receiving our mic (via the connection we answered), but when two peers call
  // each other simultaneously neither has answered yet, so the glare is not
  // observable and both calls survive — see KNOWLEDGE/learning.md. What must
  // always hold is that we never open more than one outgoing call per peer, and
  // that repeated `connectOutgoingAudioToPeers` passes add nothing.
  test('a speaker opens at most one outgoing audio call per listener', async ({ makePeer }) => {
    const host = await makePeer({ pseudo: 'Hostie' });
    const code = await createRoom(host);
    const a = await makePeer({ pseudo: 'Alice' });
    const b = await makePeer({ pseudo: 'Bob' });
    await joinRoom(a, code);
    await joinRoom(b, code);

    for (const p of [host, a, b]) {
      await expect.poll(() => rosterCount(p), POLL).toBe(3);
    }

    await Promise.all([speak(host), speak(a), speak(b)]);

    // Wait until our mic is reaching both remote peers, then bound the count.
    for (const p of [host, a, b]) {
      await expect
        .poll(async () => {
          const counts = Object.values(await outgoingAudioSenderCounts(p));
          return counts.length === 2 && counts.every((n) => n >= 1);
        }, POLL)
        .toBe(true);
      Object.values(await outgoingAudioSenderCounts(p)).forEach((n) => {
        expect(n).toBeLessThanOrEqual(2); // …over at most the two links
      });
    }

    // Re-running the pass must not add links — the audioMediaOut guard holds.
    const before = await Promise.all([host, a, b].map(outgoingAudioSenderCounts));
    await Promise.all([host, a, b].map((p) => p.evaluate(() => window.connectOutgoingAudioToPeers())));
    const after = await Promise.all([host, a, b].map(outgoingAudioSenderCounts));
    expect(after).toEqual(before);
  });

  test('audio links negotiate Opus with in-band FEC and DTX off', async ({ makePeer }) => {
    const host = await makePeer({ pseudo: 'Hostie' });
    const code = await createRoom(host);
    const a = await makePeer({ pseudo: 'Alice' });
    await joinRoom(a, code);
    await Promise.all([speak(host), speak(a)]);

    for (const p of [host, a]) {
      await expect.poll(async () => (await negotiatedOpusFmtp(p)).length, POLL).toBeGreaterThanOrEqual(1);
      for (const line of await negotiatedOpusFmtp(p)) {
        // FEC lets the decoder rebuild isolated lost packets instead of
        // dropping them; DTX off keeps the jitter buffer warm between presses.
        expect(line).toContain('useinbandfec=1');
        expect(line).toContain('usedtx=0');
        expect(line).toContain('stereo=0');
      }
    }
  });

  // The "can they hear me?" round trip, over real WebRTC. This is the only check
  // that can distinguish "packets arrived" from "audio was actually heard".
  test('audio check reports a peer really hearing us', async ({ makePeer }) => {
    const host = await makePeer({ pseudo: 'Hostie' });
    const code = await createRoom(host);
    const a = await makePeer({ pseudo: 'Alice' });
    await joinRoom(a, code);

    for (const p of [host, a]) {
      await expect.poll(() => rosterCount(p), POLL).toBe(2);
      // The check reports on playback state, so it needs sharing consent.
      await p.evaluate(() => {
        localStorage.setItem('dev-mode', 'true');
        localStorage.setItem('debug-share-device-info', 'accepted');
      });
    }
    await Promise.all([speak(host), speak(a)]);
    for (const p of [host, a]) {
      await expect.poll(async () => (await getState(p)).incomingAudio, POLL).toBeGreaterThanOrEqual(1);
    }

    const alice = await a.evaluate(() => peer.id);
    await host.evaluate((id) => window.startAudioCheck(id), alice);

    const result = await host.evaluate(async () => {
      for (let i = 0; i < 100; i++) {
        if (window._audioCheck && window._audioCheck.result) return window._audioCheck.result;
        await new Promise((r) => setTimeout(r, 200));
      }
      return null;
    });

    expect(result).toBeTruthy();
    // Chromium's fake device emits a continuous tone, so a healthy loopback link
    // must come back as audible — never "silent" or "unheard".
    expect(['good', 'choppy', 'bad']).toContain(result.status);

    const report = await host.evaluate(() => window._audioCheck.report);
    expect(report.ok).toBe(true);
    expect(report.samples).toBeGreaterThan(0);   // audio was decoded
    expect(report.energy).toBeGreaterThan(0);    // …and it was not silence
    expect(report.playback.present).toBe(true);  // …attached to an output
    expect(report.playback.muted).toBe(false);
  });

  test('audio check reports a peer whose playback is muted', async ({ makePeer }) => {
    const host = await makePeer({ pseudo: 'Hostie' });
    const code = await createRoom(host);
    const a = await makePeer({ pseudo: 'Alice' });
    await joinRoom(a, code);
    for (const p of [host, a]) {
      await expect.poll(() => rosterCount(p), POLL).toBe(2);
      await p.evaluate(() => {
        localStorage.setItem('dev-mode', 'true');
        localStorage.setItem('debug-share-device-info', 'accepted');
      });
    }
    await Promise.all([speak(host), speak(a)]);
    for (const p of [host, a]) {
      await expect.poll(async () => (await getState(p)).incomingAudio, POLL).toBeGreaterThanOrEqual(1);
    }

    const hostId = await host.evaluate(() => peer.id);
    // Alice mutes the element carrying the host's audio: packets keep arriving
    // perfectly, but she hears nothing — invisible to the host's own stats.
    await a.evaluate((id) => {
      const el = document.getElementById('audio-' + id);
      if (el) el.muted = true;
    }, hostId);

    const alice = await a.evaluate(() => peer.id);
    await host.evaluate((id) => window.startAudioCheck(id), alice);
    const result = await host.evaluate(async () => {
      for (let i = 0; i < 100; i++) {
        if (window._audioCheck && window._audioCheck.result) return window._audioCheck.result;
        await new Promise((r) => setTimeout(r, 200));
      }
      return null;
    });

    expect(result).toBeTruthy();
    expect(result.status).toBe('unheard');
    expect(result.headline).toContain('muted');
  });

  // The network echo test, driven for real: mic -> Opus -> loopback -> decode ->
  // recorded -> replayed. CI has no TURN server, so the policy is relaxed to
  // 'all'; everything else is the production code path.
  test('echo test records the returned audio and scores it', async ({ makePeer }) => {
    const p = await makePeer({ pseudo: 'Solo' });

    const out = await p.evaluate(async () => {
      await window.startEchoTest({ iceTransportPolicy: 'all' });
      if (!window.echoTestRunning()) {
        return { failed: document.getElementById('echo-test-status').textContent };
      }
      const midStatus = document.getElementById('echo-test-status').textContent;
      await new Promise((r) => setTimeout(r, 4000));
      await window.stopEchoTest({ replay: true });
      const audio = document.getElementById('mic-test-playback');
      return {
        midStatus,
        finalStatus: document.getElementById('echo-test-status').textContent,
        statusClass: document.getElementById('echo-test-status').className,
        // The replay element is fed from the RETURNED stream, not the raw mic.
        replayed: !!audio.src && !audio.classList.contains('hidden'),
        stillRunning: window.echoTestRunning(),
        button: document.getElementById('btn-test-echo').textContent,
      };
    });

    expect(out.failed).toBeUndefined();
    expect(out.midStatus).toContain('Speak now');
    expect(out.replayed).toBe(true);
    // Audio genuinely made the round trip, so it must be scored, never "silent".
    expect(out.statusClass).toMatch(/ac-(good|choppy|bad)/);
    expect(out.finalStatus).toContain('You would sound');
    // A loopback that did not use a relay must say so rather than implying it did.
    expect(out.finalStatus).toContain('not relayed');
    // Everything is torn down afterwards.
    expect(out.stillRunning).toBe(false);
    expect(out.button).toBe('Test over network');
  });

  // Guards the bug where `ontrack` (which fires on NEGOTIATION, not media flow)
  // was treated as success: the test reported "recording" with no relay, no ICE
  // connection and not one packet exchanged.
  test('echo test reports no relay instead of pretending to work', async ({ makePeer }) => {
    const p = await makePeer({ pseudo: 'Solo' });
    // Fallback relay → Off, so relay-only ICE can gather nothing at all.
    await p.evaluate(() => localStorage.setItem('turn-fallback', '[]'));

    const out = await p.evaluate(async () => {
      await window.startEchoTest(); // real 'relay' policy
      return {
        status: document.getElementById('echo-test-status').textContent,
        cls: document.getElementById('echo-test-status').className,
        running: window.echoTestRunning(),
        button: document.getElementById('btn-test-echo').textContent,
      };
    });

    expect(out.running).toBe(false);
    expect(out.cls).toContain('ac-error');
    expect(out.status).toContain('No TURN relay reachable');
    expect(out.button).toBe('Test over network');
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

  test('host and deputy crashing together converges on the next successor', async ({ makePeer }) => {
    const host = await makePeer({ pseudo: 'Hostie' });
    const code = await createRoom(host);
    const a = await makePeer({ pseudo: 'Alice' });
    const b = await makePeer({ pseudo: 'Bob' });
    const c = await makePeer({ pseudo: 'Carol' });
    await joinRoom(a, code);
    await joinRoom(b, code);
    await joinRoom(c, code);
    for (const p of [host, a, b, c]) await expect.poll(() => rosterCount(p), POLL).toBe(4);

    // Identify the agreed deputy and kill BOTH the host and the deputy at once.
    // Survivors first elect the (now dead) deputy; the broker reports it
    // unavailable, so they fast-fail and walk the successor chain to the next one.
    const deputyId = await waitForSharedDeputy(expect, [a, b, c], POLL);
    const byId = {};
    for (const p of [a, b, c]) byId[(await getState(p)).peerId] = p;
    const deputyPage = byId[deputyId];
    const survivors = [a, b, c].filter((p) => p !== deputyPage);

    await Promise.all([killPeer(host), killPeer(deputyPage)]);

    // The two remaining peers converge on exactly one host, one room code, roster 2.
    await expect
      .poll(async () => {
        const states = await Promise.all(survivors.map(getState));
        const hosts = states.filter((s) => s.isHost).length;
        const codes = new Set(states.map((s) => s.roomCode)).size;
        const rosters = await Promise.all(survivors.map(rosterCount));
        return hosts === 1 && codes === 1 && rosters.every((n) => n === 2);
      }, POLL)
      .toBe(true);
  });
});
