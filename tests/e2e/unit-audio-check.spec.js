import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// The "can you hear me?" check and the per-peer WebRTC stats it sits next to.
// `remote-inbound-rtp` proves our packets arrived; only the peer can say whether
// anything was actually heard, so the whole thing is a request/measure/reply
// round trip over the data channel.
//
// Everything reads RTCStatsReport, so each test installs a stats double: a Map,
// which is exactly the `forEach`-able shape getStats() resolves to.

/** Attach a fake audio MediaConnection carrying the given stats reports. */
async function installStats(page) {
  await page.evaluate(() => {
    window.__mkPc = function(reports) {
      return { getStats: () => Promise.resolve(new Map(reports.map((r, i) => [r.id || 'r' + i, r]))) };
    };
    window.__attachAudioLink = function(peerId, reports) {
      const c = connections.get(peerId);
      c.media = { closed: false, peerConnection: window.__mkPc(reports) };
      return c;
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await installStats(page);
});

test.describe('sampling a peer\'s inbound audio', () => {
  test('sums the counters across every link and reports playback state', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1' }] });
    const sample = await page.evaluate(async () => {
      const c = connections.get('p1');
      c.media = { closed: false, peerConnection: window.__mkPc([
        { type: 'inbound-rtp', kind: 'audio', totalAudioEnergy: 1, totalSamplesReceived: 1000,
          concealedSamples: 10, concealmentEvents: 2, packetsReceived: 100, packetsLost: 3 },
        { type: 'media-playout', synthesizedSamplesDuration: 0.5, totalSamplesCount: 4000 },
      ]) };
      c.audioMediaOut = { closed: false, peerConnection: window.__mkPc([
        { type: 'inbound-rtp', kind: 'audio', totalAudioEnergy: 2, totalSamplesReceived: 500,
          concealedSamples: 5, concealmentEvents: 1, packetsReceived: 50, packetsLost: 1 },
      ]) };
      attachAudio('p1', new MediaStream());
      return sampleInboundAudio('p1');
    });
    expect(sample.energy).toBe(3);
    expect(sample.samples).toBe(1500);
    expect(sample.concealed).toBe(15);
    expect(sample.concealmentEvents).toBe(3);
    expect(sample.packetsLost).toBe(4);
    expect(sample.synthesizedMs).toBe(500);
    expect(sample.playback.present).toBe(true);
    // The sink id is a device identifier — only whether one is set is reported.
    expect(sample.playback).not.toHaveProperty('sinkId');
  });

  test('a peer with no audio link samples to nothing', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1' }] });
    expect(await page.evaluate(() => sampleInboundAudio('p1'))).toBe(null);
    expect(await page.evaluate(() => sampleInboundAudio('nobody'))).toBe(null);
  });

  test('a link carrying no inbound audio samples to nothing', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1' }] });
    const sample = await page.evaluate(async () => {
      window.__attachAudioLink('p1', [{ type: 'outbound-rtp', kind: 'audio', packetsSent: 10 }]);
      return sampleInboundAudio('p1');
    });
    expect(sample).toBe(null);
  });

  test('with no audio element the playback section says so', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1' }] });
    const playback = await page.evaluate(async () => {
      window.__attachAudioLink('p1', [{ type: 'inbound-rtp', kind: 'audio', totalSamplesReceived: 1 }]);
      const s = await sampleInboundAudio('p1');
      return s.playback;
    });
    expect(playback).toEqual({ present: false });
  });

  test('sampleLocalMicEnergy reads the media-source energy off any link', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1' }, { id: 'p2' }] });
    const energy = await page.evaluate(async () => {
      window.__attachAudioLink('p1', [{ type: 'inbound-rtp', kind: 'audio' }]);
      window.__attachAudioLink('p2', [{ type: 'media-source', kind: 'audio', totalAudioEnergy: 4.25 }]);
      return sampleLocalMicEnergy();
    });
    expect(energy).toBe(4.25);
  });

  test('sampleLocalMicEnergy reports nothing when the mic is not in the graph', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1' }] });
    const energy = await page.evaluate(async () => {
      window.__attachAudioLink('p1', [{ type: 'inbound-rtp', kind: 'audio' }]);
      return sampleLocalMicEnergy();
    });
    expect(energy).toBe(null);
  });
});

test.describe('answering an audio check', () => {
  test('a peer with sharing off declines', async ({ page }) => {
    await seedRoom(page, { selfId: 'p2', isHost: false, roomCode: 'host', connections: [{ id: 'host' }] });
    const sent = await page.evaluate(() => {
      setDeviceInfoConsent('declined');
      const out = [];
      connections.get('host').data.send = (m) => out.push(m);
      respondToAudioCheckRequest('asker', 2500);
      return out;
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'audio-check-response', declined: true, report: null, from: 'asker' });
  });

  test('a peer with sharing on measures across the window and replies', async ({ page }) => {
    await seedRoom(page, { selfId: 'p2', isHost: false, roomCode: 'host', connections: [{ id: 'host' }] });
    const sent = await page.evaluate(async () => {
      setDeviceInfoConsent('accepted');
      window.__attachAudioLink('host', [
        { type: 'inbound-rtp', kind: 'audio', totalSamplesReceived: 1000, concealedSamples: 5 },
      ]);
      const out = [];
      connections.get('host').data.send = (m) => out.push(m);
      respondToAudioCheckRequest(null, 500);
      await new Promise((r) => setTimeout(r, 900));
      return out;
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('audio-check-response');
    expect(sent[0].declined).toBe(false);
    expect(sent[0].report).toBeTruthy();
  });

  test('a failed sample is reported as such rather than as silence', async ({ page }) => {
    await seedRoom(page, { selfId: 'p2', isHost: false, roomCode: 'host', connections: [{ id: 'host' }] });
    const sent = await page.evaluate(async () => {
      setDeviceInfoConsent('accepted');
      const c = connections.get('host');
      c.media = { closed: false, peerConnection: { getStats: () => Promise.reject(new Error('gone')) } };
      const out = [];
      c.data.send = (m) => out.push(m);
      respondToAudioCheckRequest(null, 500);
      await new Promise((r) => setTimeout(r, 300));
      return out;
    });
    expect(sent[0].report).toEqual({ ok: false, reason: 'sample-failed' });
  });

  test('the host answers for itself and relays for anyone else', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      connections: [{ id: 'asker' }, { id: 'target' }],
    });
    const seen = await page.evaluate(() => {
      setDeviceInfoConsent('declined');
      const toAsker = [];
      const toTarget = [];
      connections.get('asker').data.send = (m) => toAsker.push(m);
      connections.get('target').data.send = (m) => toTarget.push(m);
      handleAudioCheckRequestAtHost('asker', 'host', 2500);   // about the host itself
      handleAudioCheckRequestAtHost('asker', 'target', 2500); // about someone else
      return { toAsker, toTarget };
    });
    expect(seen.toAsker).toHaveLength(1);
    expect(seen.toAsker[0].declined).toBe(true);
    expect(seen.toTarget).toHaveLength(1);
    expect(seen.toTarget[0]).toMatchObject({ type: 'audio-check-request', peerId: 'target', from: 'asker' });
  });
});

test.describe('running an audio check', () => {
  test('asks the peer, transmits, and holds a pending result', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, connections: [{ id: 'p1' }] });
    const seen = await page.evaluate(() => {
      const sent = [];
      connections.get('p1').data.send = (m) => sent.push(m);
      startAudioCheck('p1');
      const out = { sent, peerId: _audioCheck && _audioCheck.peerId, timer: !!(_audioCheck && _audioCheck.timer) };
      cancelAudioCheck();
      return out;
    });
    expect(seen.sent).toHaveLength(1);
    expect(seen.sent[0].type).toBe('audio-check-request');
    expect(seen.peerId).toBe('p1');
    expect(seen.timer).toBe(true);
  });

  test('a non-host routes its request through the host', async ({ page }) => {
    await seedRoom(page, { selfId: 'p2', isHost: false, roomCode: 'host', connections: [{ id: 'host' }] });
    const sent = await page.evaluate(() => {
      const out = [];
      connections.get('host').data.send = (m) => out.push(m);
      startAudioCheck('p3');
      cancelAudioCheck();
      return out;
    });
    expect(sent[0]).toMatchObject({ type: 'audio-check-request', peerId: 'p3' });
  });

  test('a second check for the same peer does not restart it', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, connections: [{ id: 'p1' }] });
    const sent = await page.evaluate(() => {
      const out = [];
      connections.get('p1').data.send = (m) => out.push(m);
      startAudioCheck('p1');
      startAudioCheck('p1');
      cancelAudioCheck();
      return out.length;
    });
    expect(sent).toBe(1);
  });

  test('nothing runs outside a room', async ({ page }) => {
    const check = await page.evaluate(() => {
      inRoom = false;
      startAudioCheck('p1');
      startAudioCheck(null);
      return _audioCheck;
    });
    expect(check).toBe(null);
  });

  test('a declined reply is shown as declined', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, connections: [{ id: 'p1' }] });
    const result = await page.evaluate(() => {
      startAudioCheck('p1');
      onAudioCheckResponse('p1', null, true);
      const out = _audioCheck && _audioCheck.result;
      cancelAudioCheck();
      return out;
    });
    expect(result).toEqual({
      status: 'error',
      headline: 'Declined',
      detail: 'That peer has diagnostics sharing turned off.',
    });
  });

  test('a reply for a peer we are not checking is ignored', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, connections: [{ id: 'p1' }] });
    const result = await page.evaluate(() => {
      startAudioCheck('p1');
      onAudioCheckResponse('someone-else', { ok: true }, false);
      const out = _audioCheck && _audioCheck.result;
      cancelAudioCheck();
      return out === undefined ? 'none' : out;
    });
    expect(result).toBe('none');
  });

  test('a reply with no check running is ignored', async ({ page }) => {
    const threw = await page.evaluate(() => {
      cancelAudioCheck();
      try { onAudioCheckResponse('p1', { ok: true }, false); return false; } catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });

  test('a scored reply becomes a verdict once our own energy is known', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, connections: [{ id: 'p1' }] });
    const result = await page.evaluate(async () => {
      startAudioCheck('p1');
      // Stand in for the local-energy measurement, which needs a real mic.
      _audioCheck.localEnergyPromise = Promise.resolve(1);
      onAudioCheckResponse('p1', { ok: true, samples: 1000, concealed: 5, concealmentEvents: 1 }, false);
      await new Promise((r) => setTimeout(r, 20));
      const out = _audioCheck && _audioCheck.result;
      cancelAudioCheck();
      return out;
    });
    expect(result.status).toBe('good');
  });

  test('cancelling clears the timer and the state', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, connections: [{ id: 'p1' }] });
    const check = await page.evaluate(() => {
      startAudioCheck('p1');
      cancelAudioCheck();
      cancelAudioCheck(); // twice must be safe
      return _audioCheck;
    });
    expect(check).toBe(null);
  });
});

test.describe('requesting device info', () => {
  test('a host asks the peer directly', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, connections: [{ id: 'p1' }] });
    const sent = await page.evaluate(() => {
      const out = [];
      connections.get('p1').data.send = (m) => out.push(m);
      requestDeviceInfo('p1');
      return out;
    });
    expect(sent).toEqual([{ type: 'device-info-request' }]);
  });

  test('a non-host routes the request through the host', async ({ page }) => {
    await seedRoom(page, { selfId: 'p2', isHost: false, roomCode: 'host', connections: [{ id: 'host' }] });
    const sent = await page.evaluate(() => {
      const out = [];
      connections.get('host').data.send = (m) => out.push(m);
      requestDeviceInfo('p3');
      return out;
    });
    expect(sent).toEqual([{ type: 'device-info-request', peerId: 'p3' }]);
  });

  test('the host answers about itself and relays about anyone else', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, connections: [{ id: 'asker' }, { id: 'target' }] });
    const seen = await page.evaluate(async () => {
      setDeviceInfoConsent('accepted');
      const toAsker = [];
      const toTarget = [];
      connections.get('asker').data.send = (m) => toAsker.push(m);
      connections.get('target').data.send = (m) => toTarget.push(m);
      handleDeviceInfoRequestAtHost('asker', 'host');
      handleDeviceInfoRequestAtHost('asker', 'target');
      await new Promise((r) => setTimeout(r, 200));
      return { toAsker, toTarget };
    });
    expect(seen.toAsker).toHaveLength(1);
    expect(seen.toAsker[0]).toMatchObject({ type: 'device-info-response', peerId: 'host', declined: false });
    expect(seen.toTarget[0]).toMatchObject({ type: 'device-info-request', peerId: 'target', from: 'asker' });
  });

  test('a response for a peer we never knew is dropped', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, connections: [{ id: 'p1' }] });
    const threw = await page.evaluate(() => {
      try { updatePeerDeviceInfo('nobody', { device: {} }, false); return false; } catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });

  test('a response is stamped onto the peer it describes', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, connections: [{ id: 'p1' }] });
    const stored = await page.evaluate(() => {
      onDeviceInfoResponse('p1', { device: { os: 'Linux' } }, false);
      return connections.get('p1').deviceInfo;
    });
    expect(stored.declined).toBe(false);
    expect(stored.info).toEqual({ device: { os: 'Linux' } });
    expect(typeof stored.at).toBe('number');
  });
});

test.describe('per-peer WebRTC stats', () => {
  test('reports the worst ICE path and the highest round trip', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1' }] });
    const stats = await page.evaluate(async () => {
      const c = connections.get('p1');
      c.media = { closed: false, peerConnection: window.__mkPc([
        { id: 'pair1', type: 'candidate-pair', nominated: true, state: 'succeeded',
          localCandidateId: 'lc1', currentRoundTripTime: 0.05 },
        { id: 'lc1', type: 'local-candidate', candidateType: 'host' },
        { type: 'inbound-rtp', kind: 'audio', packetsReceived: 100, packetsLost: 2, jitter: 0.01 },
        { type: 'remote-inbound-rtp', kind: 'audio', packetsLost: 1, roundTripTime: 0.12 },
      ]) };
      c.audioMediaOut = { closed: false, peerConnection: window.__mkPc([
        { id: 'pair2', type: 'candidate-pair', nominated: true, state: 'succeeded',
          localCandidateId: 'lc2', currentRoundTripTime: 0.02 },
        { id: 'lc2', type: 'local-candidate', candidateType: 'relay' },
        { type: 'inbound-rtp', kind: 'audio', packetsReceived: 50, packetsLost: 0, jitter: 0.03 },
      ]) };
      await _collectPeerStats('p1', c);
      return c.webrtcStats;
    });
    // A relayed leg makes the whole peer relayed — that is the one degrading it.
    expect(stats.iceType).toBe('relay');
    expect(stats.rttMs).toBe(120);
    expect(stats.jitterMs).toBe(30);
  });

  test('a peer with no audio link produces no stats', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1' }] });
    const stats = await page.evaluate(async () => {
      const c = connections.get('p1');
      await _collectPeerStats('p1', c);
      return c.webrtcStats;
    });
    expect(stats).toBe(undefined);
  });

  test('a failing getStats leaves the previous reading in place', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1' }] });
    const stats = await page.evaluate(async () => {
      const c = connections.get('p1');
      c.webrtcStats = { rttMs: 42 };
      c.media = { closed: false, peerConnection: { getStats: () => Promise.reject(new Error('gone')) } };
      await _collectPeerStats('p1', c);
      return c.webrtcStats;
    });
    expect(stats).toEqual({ rttMs: 42 });
  });

  test('a srflx path is reported when nothing is relayed', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1' }] });
    const iceType = await page.evaluate(async () => {
      const c = connections.get('p1');
      c.media = { closed: false, peerConnection: window.__mkPc([
        { id: 'p', type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'l' },
        { id: 'l', type: 'local-candidate', candidateType: 'srflx' },
      ]) };
      await _collectPeerStats('p1', c);
      return c.webrtcStats.iceType;
    });
    expect(iceType).toBe('srflx');
  });

  test('the stats popover opens onto a peer and closes again', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1', pseudo: 'Ada' }] });
    const seen = await page.evaluate(() => {
      connections.get('p1').webrtcStats = { rttMs: 30, jitterMs: 5, lossPercent: 0.5, iceType: 'host' };
      const anchor = document.createElement('button');
      document.body.appendChild(anchor);
      showStatsPopover('p1', anchor);
      const open = { id: _statsPopoverPeerId, el: !!document.getElementById('stats-popover') };
      closeStatsPopover();
      const closed = { id: _statsPopoverPeerId, el: !!document.getElementById('stats-popover') };
      anchor.remove();
      return { open, closed };
    });
    expect(seen.open.id).toBe('p1');
    expect(seen.open.el).toBe(true);
    expect(seen.closed.id).toBe(null);
    expect(seen.closed.el).toBe(false);
  });

  test('closing a popover that is not open is safe', async ({ page }) => {
    const threw = await page.evaluate(() => {
      try { closeStatsPopover(); closeStatsPopover(); return false; } catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });

  test('the stats poll ticks while a room is live and stops on demand', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', isHost: true, connections: [{ id: 'p1' }] });
    const seen = await page.evaluate(() => {
      startStatsPolling();
      const running = !!_statsIntervalId;
      startStatsPolling(); // restarting must not leak the previous timer
      const replaced = !!_statsIntervalId;
      stopStatsPolling();
      return { running, replaced, stopped: _statsIntervalId };
    });
    expect(seen.running).toBe(true);
    expect(seen.replaced).toBe(true);
    expect(seen.stopped).toBe(null);
  });
});
