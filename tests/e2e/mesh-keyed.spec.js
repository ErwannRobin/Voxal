import { test, expect } from './mesh-fixtures.js';
import {
  createRoom,
  joinRoom,
  getState,
  rosterCount,
  killPeer,
  waitForSharedDeputy,
  installCanvasCamera,
  startGreenWatchdog,
  greenWatchdogReport,
  greenWatchdogSelfTest,
} from './mesh-helpers.js';

// "Let others draw my scene" between real peers: real PeerJS signalling, real
// WebRTC, real VP8, real WebGL — the one place the sender's pipeline, the
// handshake in main.js and the receiver's cut-out meet. The unit specs pin each
// half against fakes; what only this can show is that, across a live room, the
// promise the whole feature rests on holds: nobody is ever shown a keyed frame
// raw (design invariant I1).
//
// Four peers: a host, a non-host SENDER (the only camera), a receiver A that
// can draw scenes and a receiver B that cannot. The host must be able to as
// well — between two non-hosts every keyed message goes through it, and a host
// that cannot relay them keys nobody — so the host receives keyed frames too.
// Joined in that order, so the deputy is the sender or A: a room whose new host
// cannot relay would stop keying by design, and the last step needs it to
// recover.
//
// A green watchdog runs on the host, A and B from before the camera starts:
// every 250 ms each remote camera tile on screen is drawn into a probe canvas,
// and a frame that carries the sender's markers, or is more than 30% pure
// green, is a violation. The test fails on the first one, through every step:
// keying on, scene to scene, scene to blur and back, the setting off and on,
// the camera off and on, and the host leaving.
//
// Software GL (SwiftShader in CI) is refused by canKeyIn() and is far too slow
// for the receiver's production frame budget, so capable peers set the
// test-only overrides video-effects.js reads at call time; B instead is made
// to report no capability at all before it joins, so its hello carries none.

const POLL = { timeout: 90_000, intervals: [250, 500, 1000] };

const BASE = {
  'noise-suppression': 'off',
  'video-routing-mode': 'p2p-only',
  'video-mode-enabled': 'true',
};

// Every peer here shares one browser, so on software GL (SwiftShader, in CI)
// they share one GPU process too, and that shapes three choices:
//
//  * Each scene's first draw holds its page's main thread for seconds. That is
//    fine for the feature and fatal for the room's 7 s heartbeat, which would
//    take a peer that is merely compiling for gone and split the room. The
//    timeout is a plain `var`; the test gives it room for a compile, so a host
//    that really leaves is still detected, only later.
//  * A redraw of a scene costs tens of milliseconds here, so the camera is small
//    and slow and the scenes are the two cheapest to draw. Two gates would still
//    refuse to key at all, so the test lifts them with test-only overrides that
//    video-effects.js reads at call time, like the canKeyIn() ones: the
//    receiver's frame budget (`__voxalKeyInFrameBudgetMs`) and the sender's
//    keyed-copy budget (`__voxalKeyCopyBudgetMs`, a read-back queued behind
//    every other peer's scene). The production budgets are untouched.
//  * The sender's own pipeline would step down and, at the bottom of its
//    ladder, switch its background off as a device that cannot keep up — on a
//    real machine the right call, here the end of the test. Its overload hook
//    records the give-up instead (see `pipeline.overloads` in a failure dump).
async function prepare(page, { capable, sender = false }) {
  await page.evaluate(({ capable, sender }) => {
    window.__voxalSegStub = true;
    HOST_HEARTBEAT_TIMEOUT_MS = 20000;
    if (capable) {
      window.__voxalKeyInOnSoftwareGL = true;
      window.__voxalKeyInAnyEngine = true;
      window.__voxalKeyInFrameBudgetMs = 1000;
    } else {
      delete window.__voxalKeyInOnSoftwareGL;
      delete window.__voxalKeyInAnyEngine;
      VideoEffects.canKeyIn = () => false;
    }
    if (sender) {
      window.__voxalKeyCopyBudgetMs = 1000;
      window.__overloads = [];
      VideoEffects.onOverload((why) => window.__overloads.push(why));
    }
  }, { capable, sender });
  await installCanvasCamera(page, { width: 160, height: 120, fps: 8 });
}

// The sender's side of it: what it offers, and what each peer's camera call
// carries. `latest` is the sender of the call that carries the camera now;
// `anyKeyed` looks at every media connection PeerJS still holds to that peer,
// orphans from earlier re-calls included.
function senderView(page) {
  return page.evaluate(() => {
    const comp = localVideoStream ? localVideoStream.getVideoTracks()[0] : null;
    const peers = {};
    connections.forEach((c, id) => {
      const latest = meshVideoSender(id);
      let all = [];
      const held = (peer && peer.connections && peer.connections[id]) || [];
      held.forEach((mc) => {
        const pc = mc && mc.type === 'media' && mc.peerConnection;
        if (!pc || pc.connectionState === 'closed') return;
        all = all.concat(pc.getSenders().filter((s) => s.track && s.track.kind === 'video'));
      });
      const ack = _keyedAcks.get(id);
      const calls = held.filter((mc) => mc && mc.type === 'media' && mc.open &&
        mc.metadata && mc.metadata.type === 'video').length;
      peers[id] = {
        calls,
        latest: latest
          ? (isKeyedVideoTrack(latest.track) ? 'keyed' : latest.track === comp ? 'composite' : 'other')
          : null,
        anyKeyed: all.some((s) => isKeyedVideoTrack(s.track)),
        ack: ack ? { ok: ack.ok, epoch: ack.epoch, scene: ack.scene, age: Date.now() - ack.at } : null,
        caps: c.caps || null,
      };
    });
    let st;
    try { st = localVideoStream ? VideoEffects.keyedState(localVideoStream) : null; } catch (e) { st = null; }
    return {
      isHost, roomCode, epoch: _keyedEpoch, demand: _keyedDemand, bg: videoBackgroundMode(),
      offer: _keyedSentOffer ? { epoch: _keyedSentOffer.epoch, scene: _keyedSentOffer.scene } : null,
      state: st ? { scene: st.scene, reason: st.reason } : null,
      pipeline: (() => {
        const pr = localVideoStream && localVideoStream._effectsProcessor;
        return pr ? { segStep: pr.segStep, sceneStep: pr.sceneStep, overloads: window.__overloads || [] } : null;
      })(),
      peers,
    };
  });
}

// A receiver's side: the offer it holds for the sender, its cut-out, and what
// the sender's camera tile is showing.
function receiverView(page, senderId) {
  return page.evaluate((senderId) => {
    const conn = connections.get(senderId);
    const e = _keyedReceivers.get(senderId);
    const tile = document.querySelector('#video-stage .video-tile-camera[data-peer-id="' + senderId + '"] video');
    let shows = 'missing';
    if (tile) {
      if (!tile.srcObject) shows = 'none';
      else if (e && e.handle && tile.srcObject === e.handle.stream) shows = 'cutout';
      else if (conn && tile.srcObject === conn.remoteVideoStream) shows = 'raw';
      else shows = 'other';
    }
    let scene;
    try { scene = e && e.handle ? e.handle.scene() : null; } catch (err) { scene = null; }
    return {
      room: { inRoom, isHost, roomCode, peers: connections.size },
      sharing: { active: !!(conn && conn.videoActive), raw: !!(conn && conn.remoteVideoStream), call: !!(conn && conn.videoMedia) },
      caps: localCaps(),
      offer: conn && conn.keyedOffer ? { epoch: conn.keyedOffer.epoch, scene: conn.keyedOffer.scene } : null,
      entry: e ? { state: e.state, scene, gaveUp: e.gaveUp || null, alive: keyedHandleAlive(e.handle) } : null,
      shows,
      playing: !!(tile && tile.srcObject && tile.readyState >= 2 && tile.videoWidth),
      failures: Array.from((_keyedFailures.get(senderId) || new Map()).entries())
        .map(([k, v]) => k.split('|')[0] + ' x' + v.count),
    };
  }, senderId);
}

// Every 250 ms on the sender: is any media connection to `peerId` carrying
// the keyed track? A peer that cannot draw the scene must never be sent it,
// for a single frame — orphaned calls included.
function watchNeverKeyed(page, peerId) {
  return page.evaluate((peerId) => {
    window.__neverKeyed = { peerId, hits: [], samples: 0 };
    setInterval(() => {
      const w = window.__neverKeyed;
      const held = (peer && peer.connections && peer.connections[w.peerId]) || [];
      w.samples++;
      held.forEach((mc) => {
        const pc = mc && mc.type === 'media' && mc.peerConnection;
        if (!pc || pc.connectionState === 'closed') return;
        pc.getSenders().forEach((s) => {
          if (s.track && isKeyedVideoTrack(s.track)) w.hits.push({ at: Math.round(performance.now()), phase: window.__greenPhase || null });
        });
      });
    }, 250);
  }, peerId);
}

// Every 250 ms on the sender: a peer's call is on the keyed track only once
// that peer has said ok:true for that very call. The acks are caught as they
// arrive, at noteKeyedAck() — the one place both a host and a non-host
// sender take them in — so this asks "was it ever acked", never "is the ack
// still fresh": a closing receiver revokes its ack a moment before the
// sender's swap back lands, and that moment is the design, not a violation.
function watchKeyedOnlyAfterAck(page, peerIds) {
  return page.evaluate((peerIds) => {
    const w = { acked: {}, hits: [], keyed: {} };
    window.__keyedAfterAck = w;
    peerIds.forEach((id) => { w.acked[id] = []; w.keyed[id] = 0; });
    const take = noteKeyedAck;
    noteKeyedAck = function (sourceId, msg) {
      if (w.acked[sourceId] && msg && typeof msg === 'object') {
        const ack = sanitizeKeyedAck(msg);
        if (ack.ok && ack.call && !w.acked[sourceId].includes(ack.call)) w.acked[sourceId].push(ack.call);
      }
      return take.apply(this, arguments);
    };
    setInterval(() => {
      peerIds.forEach((id) => {
        const s = meshVideoSender(id);
        if (!s || !isKeyedVideoTrack(s.track)) return;
        w.keyed[id]++;
        const c = connections.get(id);
        const call = c && c.videoMediaOut ? String(c.videoMediaOut.connectionId) : null;
        if (!w.acked[id].includes(call)) {
          w.hits.push({ at: Math.round(performance.now()), peerId: id, call, phase: window.__greenPhase || null });
        }
      });
    }, 250);
  }, peerIds);
}

test.describe('keyed camera @mesh', () => {
  test('only the peer that can draw the scene is sent the keyed picture, and nobody ever sees green @mesh', async ({ makePeer }) => {
    test.setTimeout(600_000);

    const logs = {};
    // An exception nobody caught, on any peer, at any step, fails the test too:
    // a handler that throws halfway through leaves keyed state half-updated,
    // which is exactly where a green frame would come from.
    const pageErrors = [];
    const listen = (label, page) => {
      logs[label] = [];
      page.on('console', (m) => {
        const t = m.text();
        if (/\[Video\]|key-in|keyed|migration/i.test(t)) logs[label].push(t.slice(0, 300));
      });
      page.on('pageerror', (err) => {
        logs[label].push('PAGE ERROR: ' + String(err).slice(0, 300));
        pageErrors.push(label + ': ' + String(err).slice(0, 300));
      });
    };

    const host = await makePeer({ pseudo: 'Hostie', storage: BASE });
    listen('host', host);
    await prepare(host, { capable: true });
    const code = await createRoom(host);
    expect(code).toBeTruthy();

    const sender = await makePeer({ pseudo: 'Sender', storage: { ...BASE, 'video-background': 'preset:cybercafe' } });
    listen('sender', sender);
    await prepare(sender, { capable: true, sender: true });
    await joinRoom(sender, code);
    await expect.poll(() => rosterCount(host), POLL).toBe(2);

    const a = await makePeer({ pseudo: 'Alice', storage: BASE });
    listen('a', a);
    await prepare(a, { capable: true });
    await joinRoom(a, code);
    await expect.poll(() => rosterCount(host), POLL).toBe(3);

    const b = await makePeer({ pseudo: 'Bob', storage: BASE });
    listen('b', b);
    await prepare(b, { capable: false });
    await joinRoom(b, code);
    for (const p of [host, sender, a, b]) await expect.poll(() => rosterCount(p), POLL).toBe(4);

    const senderId = (await getState(sender)).peerId;
    const aId = (await getState(a)).peerId;
    const bId = (await getState(b)).peerId;
    const deputy = await waitForSharedDeputy(expect, [host, sender, a, b], POLL);
    expect([senderId, aId]).toContain(deputy);

    // Capabilities as the sender has heard them: A and the host can, B cannot.
    await expect.poll(() => sender.evaluate(([aId, bId]) => [
      peerSupports(aId, KEYED_VIDEO_CAP), peerSupports(bId, KEYED_VIDEO_CAP), peerSupports(roomCode, KEYED_VIDEO_CAP),
    ], [aId, bId]), POLL).toEqual([true, false, true]);

    const setPhase = (name) => Promise.all([host, sender, a, b]
      .filter((p) => !p.isClosed())
      .map((p) => p.evaluate((n) => { window.__greenPhase = n; }, name).catch(() => {})));

    await startGreenWatchdog(host, { label: 'host' });
    await startGreenWatchdog(a, { label: 'a', raw: true });
    await startGreenWatchdog(b, { label: 'b', raw: true });
    await watchNeverKeyed(sender, bId);
    const hostId = code;
    await watchKeyedOnlyAfterAck(sender, [aId, hostId]);
    // A watchdog that cannot see green proves nothing by staying quiet.
    for (const p of [host, a, b]) {
      expect(await greenWatchdogSelfTest(p)).toEqual({
        keyed: { marked: true, overGreen: true },
        'keyed-full': { marked: true, overGreen: false },
        camera: { marked: false, overGreen: false },
      });
    }

    const dump = async () => {
      const out = {};
      try { out.sender = await senderView(sender); } catch (e) { out.sender = String(e); }
      try { out.a = await receiverView(a, senderId); } catch (e) { out.a = String(e); }
      try { out.b = await receiverView(b, senderId); } catch (e) { out.b = String(e); }
      if (!host.isClosed()) { try { out.host = await receiverView(host, senderId); } catch (e) { out.host = String(e); } }
      out.logs = Object.fromEntries(Object.entries(logs).map(([k, v]) => [k, v.slice(-25)]));
      return out;
    };

    // Zero violations, everywhere, after every step. The pictures of the first
    // ones are attached to the report.
    const clean = [];
    const seen = {};
    const expectClean = async (step) => {
      const watched = [['a', a], ['b', b]];
      if (!host.isClosed()) watched.push(['host', host]);
      for (const [label, page] of watched) {
        const r = await greenWatchdogReport(page);
        if (r.violations.length) {
          for (const [i, v] of r.violations.slice(0, 3).entries()) {
            if (v.shot) {
              await test.info().attach(`${label}-violation-${i}.png`, {
                body: Buffer.from(v.shot.split(',')[1], 'base64'), contentType: 'image/png',
              });
            }
          }
          const brief = r.violations.slice(0, 5).map((v) => Object.assign({}, v, { shot: undefined }));
          const err = new Error(`green on ${label}'s screen during "${step}": ${JSON.stringify(brief)}\n` +
            JSON.stringify(await dump(), null, 1));
          err.__dumped = true;
          throw err;
        }
        seen[label] = { scans: r.frames, frames: r.presented };
      }
      const bWatch = await b.evaluate(() => window.__greenWatch.rawMarked);
      expect(bWatch, `B received a marked frame during "${step}"`).toEqual({});
      const never = await sender.evaluate(() => window.__neverKeyed);
      expect(never.hits, `the sender keyed B during "${step}"`).toEqual([]);
      const early = await sender.evaluate(() => window.__keyedAfterAck.hits);
      expect(early, `the sender keyed a call nobody had acked during "${step}"`).toEqual([]);
      expect(pageErrors, `uncaught errors during "${step}"`).toEqual([]);
      clean.push(step);
    };

    // Keyed for A (its tile showing the cut-out, never the raw stream), the
    // composite for B — read in ONE poll, since every part of it moves.
    const keyedFor = async (scene, ids = { aId, bId }) => {
      try {
        await expect.poll(async () => {
          const s = await senderView(sender);
          const r = await receiverView(a, senderId);
          return {
            offer: s.offer && s.offer.scene,
            toA: s.peers[ids.aId] ? s.peers[ids.aId].latest : 'no-conn',
            toB: s.peers[ids.bId] ? s.peers[ids.bId].latest : 'no-conn',
            entry: r.entry && r.entry.state,
            drawn: r.entry && r.entry.scene,
            shows: r.shows,
          };
        }, POLL).toEqual({ offer: scene, toA: 'keyed', toB: 'composite', entry: 'ready', drawn: scene, shows: 'cutout' });
      } catch (e) {
        e.message += '\n' + JSON.stringify(await dump(), null, 1);
        e.__dumped = true;
        throw e;
      }
    };

    // And the frames really are keyed on the wire to A: its raw stream carries
    // markers. Without this the cut-out could be passing composites through
    // and every assertion above would still hold.
    const markedArrivesAt = async (page) => {
      const before = (await greenWatchdogReport(page)).rawMarked[senderId] || 0;
      await expect.poll(async () => ((await greenWatchdogReport(page)).rawMarked[senderId] || 0) - before, POLL)
        .toBeGreaterThan(2);
    };

    const hold = (ms) => new Promise((r) => setTimeout(r, ms));

    // Every step, run so that a failure anywhere carries the state of the room.
    const script = async () => {
      // --- the camera comes on: the plain composite, everywhere -----------------
      await setPhase('camera');
      await sender.evaluate(() => window.startVideoShare());
      for (const p of [host, a, b]) {
        await expect.poll(async () => {
          const r = await receiverView(p, senderId);
          return [r.shows, r.playing];
        }, POLL).toEqual(['raw', true]);
      }
      await hold(2000);
      await expectClean('camera on, setting off');

      // --- keying on -------------------------------------------------------------
      await setPhase('key-on');
      await sender.evaluate(() => VideoEffects.setSubjectOnly(true));
      await keyedFor('cybercafe');
      await markedArrivesAt(a);
      await expect.poll(async () => (await greenWatchdogReport(b)).rawFrames[senderId] || 0, POLL).toBeGreaterThan(8);
      await hold(3000);
      await expectClean('keying on');

      // --- one scene to another ---------------------------------------------------
      await setPhase('scene-scene');
      await sender.evaluate(() => applyVideoBackground('preset:countryside'));
      await keyedFor('countryside');
      await markedArrivesAt(a);
      await hold(2000);
      await expectClean('scene to scene');

      // --- scene -> blur -> scene -------------------------------------------------
      // With blur there is nothing to key: the offer loses its scene, and A stays
      // on the keyed track, which now carries the plain composite that A's cut-out
      // passes through — no track swap, no tile change.
      await setPhase('scene-blur');
      await sender.evaluate(() => applyVideoBackground('blur'));
      await expect.poll(async () => {
        const s = await senderView(sender);
        const r = await receiverView(a, senderId);
        return { offer: s.offer && s.offer.scene, toA: s.peers[aId].latest, offerAtA: r.offer && r.offer.scene, shows: r.shows };
      }, POLL).toEqual({ offer: null, toA: 'keyed', offerAtA: null, shows: 'cutout' });
      await hold(3000);
      await expectClean('scene to blur');
      await setPhase('blur-scene');
      await sender.evaluate(() => applyVideoBackground('preset:cybercafe'));
      await keyedFor('cybercafe');
      await markedArrivesAt(a);
      await hold(2000);
      await expectClean('blur back to a scene');

      // --- the setting off, then on -----------------------------------------------
      await setPhase('setting-off');
      await sender.evaluate(() => VideoEffects.setSubjectOnly(false));
      await expect.poll(async () => {
        const s = await senderView(sender);
        const r = await receiverView(a, senderId);
        return { offer: s.offer, toA: s.peers[aId].latest, toB: s.peers[bId].latest, entry: r.entry, shows: r.shows };
      }, POLL).toEqual({ offer: null, toA: 'composite', toB: 'composite', entry: null, shows: 'raw' });
      await hold(3000);
      await expectClean('setting off');
      await setPhase('setting-on');
      await sender.evaluate(() => VideoEffects.setSubjectOnly(true));
      await keyedFor('cybercafe');
      await markedArrivesAt(a);
      await hold(2000);
      await expectClean('setting back on');

      // --- the camera off, then on --------------------------------------------------
      await setPhase('camera-off');
      await sender.evaluate(() => window.stopVideoShare());
      for (const p of [host, a, b]) {
        await expect.poll(async () => (await receiverView(p, senderId)).shows, POLL).toBe('missing');
      }
      await expect.poll(async () => (await receiverView(a, senderId)).entry, POLL).toBe(null);
      await hold(1500);
      await expectClean('camera off');
      await setPhase('camera-on');
      await sender.evaluate(() => window.startVideoShare());
      await keyedFor('cybercafe');
      await markedArrivesAt(a);
      await hold(2000);
      await expectClean('camera back on');

      // --- the host leaves ------------------------------------------------------------
      // Everything the host knew about who keys whom goes with it. The new host
      // learns caps and offers from every hello, the receivers say they are ready
      // again, and keying between the sender and A comes back on its own.
      await setPhase('host-leaves');
      await expectClean('before the host leaves');
      await killPeer(host);
      await expect.poll(async () => {
        const states = await Promise.all([sender, a, b].map(getState));
        const hosts = states.filter((s) => s.isHost).map((s) => s.peerId);
        return {
          hosts,
          codes: new Set(states.map((s) => s.roomCode)).size,
          rosters: await Promise.all([sender, a, b].map(rosterCount)),
        };
      }, POLL).toEqual({ hosts: [deputy], codes: 1, rosters: [3, 3, 3] });
      await keyedFor('cybercafe');
      await markedArrivesAt(a);
      await hold(3000);
      await expectClean('after the host left');

      expect(clean).toHaveLength(11);
      // And it was watching all along: every displayed frame of the sender's
      // camera, minutes of them at 8 fps, on every receiver.
      console.log('[mesh-keyed] watched: ' + JSON.stringify(seen));
      for (const label of ['a', 'b', 'host']) {
        expect(seen[label].scans, `${label} scans`).toBeGreaterThan(label === 'host' ? 100 : 200);
        expect(seen[label].frames, `${label} frames checked`).toBeGreaterThan(label === 'host' ? 100 : 200);
      }
      // The ack watch above was not quiet for want of anything to look at.
      const keyedSeen = await sender.evaluate((aId) => window.__keyedAfterAck.keyed[aId], aId);
      expect(keyedSeen, 'samples of A on the keyed track').toBeGreaterThan(40);
    };
    try {
      await script();
    } catch (e) {
      if (!e.__dumped) e.message += '\n' + JSON.stringify(await dump(), null, 1);
      throw e;
    }
  });
});
