import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// Outgoing-audio quality tuning: the Opus fmtp rewrite, the jitter-buffer
// escalation, and the guard that stops us uploading the same mic twice to a
// peer whose full-duplex MediaConnection already carries it.

const OFFER_SDP = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 103',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=sendrecv',
  '',
].join('\r\n');

function fmtpLine(sdp, pt) {
  return sdp.split('\r\n').find((l) => l.startsWith('a=fmtp:' + pt + ' '));
}

test.describe('opusSdpTransform', () => {
  test('forces FEC on, DTX off, mono and a bitrate cap on the opus fmtp line', async ({ page }) => {
    await page.goto('/');
    const out = await page.evaluate((sdp) => window.opusSdpTransform(sdp), OFFER_SDP);

    const fmtp = fmtpLine(out, '111');
    expect(fmtp).toBeTruthy();
    expect(fmtp).toContain('useinbandfec=1');
    expect(fmtp).toContain('usedtx=0');
    expect(fmtp).toContain('stereo=0');
    expect(fmtp).toContain('sprop-stereo=0');
    expect(fmtp).toContain('maxaveragebitrate=32000');
    // Pre-existing params the browser set must survive.
    expect(fmtp).toContain('minptime=10');
  });

  test('leaves the rest of the SDP byte-identical and keeps CRLF line endings', async ({ page }) => {
    await page.goto('/');
    const out = await page.evaluate((sdp) => window.opusSdpTransform(sdp), OFFER_SDP);

    expect(out).not.toContain('\r\r');
    expect(out).not.toContain('\n\n');
    // The opus rtpmap must stay intact — a naive replace corrupts the "/2" suffix.
    expect(out).toContain('a=rtpmap:111 opus/48000/2\r\n');
    expect(out).toContain('a=rtpmap:63 red/48000/2');
    expect(out.split('\r\n').length).toBe(OFFER_SDP.split('\r\n').length);
  });

  test('adds an fmtp line when the offer has none', async ({ page }) => {
    await page.goto('/');
    const stripped = OFFER_SDP.split('\r\n').filter((l) => !l.startsWith('a=fmtp:111')).join('\r\n');
    const out = await page.evaluate((sdp) => window.opusSdpTransform(sdp), stripped);

    expect(fmtpLine(out, '111')).toContain('useinbandfec=1');
    // Inserted directly after the rtpmap it belongs to.
    expect(out).toContain('a=rtpmap:111 opus/48000/2\r\na=fmtp:111 ');
  });

  test('is a no-op on SDP without opus, and never throws on junk input', async ({ page }) => {
    await page.goto('/');
    const results = await page.evaluate(() => {
      const noOpus = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 8\r\na=rtpmap:8 PCMA/8000\r\n';
      return {
        noOpus: window.opusSdpTransform(noOpus) === noOpus,
        empty: window.opusSdpTransform(''),
        nullIn: window.opusSdpTransform(null),
        undef: window.opusSdpTransform(undefined),
      };
    });
    expect(results.noOpus).toBe(true);
    expect(results.empty).toBe('');
    expect(results.nullIn).toBe(null);
    expect(results.undef).toBe(undefined);
  });

  test('is idempotent — re-transforming an already tuned offer changes nothing', async ({ page }) => {
    await page.goto('/');
    const twice = await page.evaluate((sdp) => {
      const once = window.opusSdpTransform(sdp);
      return { once, twice: window.opusSdpTransform(once) };
    }, OFFER_SDP);
    expect(twice.twice).toBe(twice.once);
  });
});

test.describe('audioPlayoutDelayFor', () => {
  test('uses the base jitter buffer on a clean direct link', async ({ page }) => {
    await page.goto('/');
    const delay = await page.evaluate(() =>
      window.audioPlayoutDelayFor({ iceType: 'host', lossPercent: 0, jitterMs: 3 }));
    expect(delay).toBe(0.08);
  });

  test('widens the buffer on a relayed path before any loss shows up', async ({ page }) => {
    await page.goto('/');
    // Anonymous rooms have no org TURN and fall back to a shared public relay,
    // so a relayed link is treated as poor up front.
    const delay = await page.evaluate(() =>
      window.audioPlayoutDelayFor({ iceType: 'relay', lossPercent: 0, jitterMs: 1 }));
    expect(delay).toBe(0.2);
  });

  test('widens the buffer on inbound loss, outbound loss, or high jitter', async ({ page }) => {
    await page.goto('/');
    const delays = await page.evaluate(() => ({
      inLoss:  window.audioPlayoutDelayFor({ iceType: 'host', lossPercent: 4 }),
      outLoss: window.audioPlayoutDelayFor({ iceType: 'host', outLossPercent: 6 }),
      jitter:  window.audioPlayoutDelayFor({ iceType: 'host', jitterMs: 45 }),
    }));
    expect(delays.inLoss).toBe(0.2);
    expect(delays.outLoss).toBe(0.2);
    expect(delays.jitter).toBe(0.2);
  });

  test('falls back to the base delay with no stats yet', async ({ page }) => {
    await page.goto('/');
    expect(await page.evaluate(() => window.audioPlayoutDelayFor(null))).toBe(0.08);
  });
});

test.describe('peerAlreadyReceivesOurAudio', () => {
  // A peer that called us gets our mic through the connection we answered, so
  // opening a second outgoing call would upload the same mic twice — the
  // speaker's uplink is the mesh bottleneck, so that alone chops their audio.
  async function seedPeerWithAnsweredCall(page, { senderTrackIsOurs, closed = false }) {
    return page.evaluate((opts) => {
      const track = { kind: 'audio', readyState: 'live' };
      stream = { getAudioTracks: () => [track] };
      const senderTrack = opts.senderTrackIsOurs ? track : { kind: 'audio', readyState: 'live' };
      connections.set('peer-a', {
        data: null,
        pseudo: 'A',
        media: {
          closed: opts.closed,
          peerConnection: { getSenders: () => [{ track: senderTrack }] },
        },
      });
      return window.peerAlreadyReceivesOurAudio(connections.get('peer-a'));
    }, { senderTrackIsOurs, closed });
  }

  test('true when the answered connection already sends our current mic track', async ({ page }) => {
    await page.goto('/');
    await seedRoom(page, { isHost: false });
    expect(await seedPeerWithAnsweredCall(page, { senderTrackIsOurs: true })).toBe(true);
  });

  test('false when the answered connection carries a different (stale) track', async ({ page }) => {
    await page.goto('/');
    await seedRoom(page, { isHost: false });
    expect(await seedPeerWithAnsweredCall(page, { senderTrackIsOurs: false })).toBe(false);
  });

  test('false once that connection is closed', async ({ page }) => {
    await page.goto('/');
    await seedRoom(page, { isHost: false });
    expect(await seedPeerWithAnsweredCall(page, { senderTrackIsOurs: true, closed: true })).toBe(false);
  });

  test('false with no mic yet (join-muted), so the lazy first-speak call still happens', async ({ page }) => {
    await page.goto('/');
    await seedRoom(page, { isHost: false });
    const result = await page.evaluate(() => {
      stream = null;
      connections.set('peer-a', {
        data: null,
        media: { closed: false, peerConnection: { getSenders: () => [{ track: { kind: 'audio', readyState: 'live' } }] } },
      });
      return window.peerAlreadyReceivesOurAudio(connections.get('peer-a'));
    });
    expect(result).toBe(false);
  });

  test('false when the peer has no answered connection at all', async ({ page }) => {
    await page.goto('/');
    await seedRoom(page, { isHost: false });
    const result = await page.evaluate(() => {
      stream = { getAudioTracks: () => [{ kind: 'audio', readyState: 'live' }] };
      connections.set('peer-a', { data: null, media: null });
      return window.peerAlreadyReceivesOurAudio(connections.get('peer-a'));
    });
    expect(result).toBe(false);
  });
});

test.describe('connectOutgoingAudioToPeers dedup', () => {
  test('skips peers already receiving our mic, still calls the others', async ({ page }) => {
    await page.goto('/');
    await seedRoom(page, { isHost: false });

    const called = await page.evaluate(() => {
      const track = { kind: 'audio', readyState: 'live' };
      stream = { getAudioTracks: () => [track] };
      const calls = [];
      peer = {
        id: 'me',
        call: (id) => {
          calls.push(id);
          return { on: () => {}, closed: false, peerConnection: null };
        },
      };
      // duplex-peer already carries our track via the connection we answered.
      connections.set('duplex-peer', {
        data: null,
        media: { closed: false, peerConnection: { getSenders: () => [{ track }] } },
      });
      // silent-peer answered us with an empty stream (it was join-muted), so its
      // connection has no sender of ours and it still needs an outgoing call.
      connections.set('silent-peer', {
        data: null,
        media: { closed: false, peerConnection: { getSenders: () => [] } },
      });
      window.connectOutgoingAudioToPeers();
      return calls;
    });

    expect(called).toEqual(['silent-peer']);
  });

  test('passes the opus sdpTransform to every outgoing audio call', async ({ page }) => {
    await page.goto('/');
    await seedRoom(page, { isHost: false });

    const hasTransform = await page.evaluate(() => {
      stream = { getAudioTracks: () => [{ kind: 'audio', readyState: 'live' }] };
      let opts = null;
      peer = {
        id: 'me',
        call: (id, s, o) => { opts = o; return { on: () => {}, closed: false }; },
      };
      connections.set('peer-a', { data: null, media: null });
      window.connectOutgoingAudioToPeers();
      return !!opts && opts.sdpTransform === window.opusSdpTransform;
    });

    expect(hasTransform).toBe(true);
  });
});

test.describe('jitter buffer setting', () => {
  test('defaults to auto, so the adaptive value is used', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(() => ({
      setting: window.jitterBufferSetting(),
      source: window.playoutDelaySource(),
      delay: window.effectivePlayoutDelay({ iceType: 'host' }),
    }));
    expect(r.setting).toEqual({ mode: 'auto', ms: 0 });
    expect(r.source).toBe('auto');
    expect(r.delay).toBe(0.08);
  });

  test('a manual value overrides the adaptive one in both directions', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(() => {
      window.setJitterBufferSetting('manual', 250);
      const onPoorLink = window.effectivePlayoutDelay({ iceType: 'relay', lossPercent: 40 });
      const onCleanLink = window.effectivePlayoutDelay({ iceType: 'host' });
      return { onPoorLink, onCleanLink, source: window.playoutDelaySource() };
    });
    // Manual wins even where auto would have escalated (0.2) or stayed low (0.08).
    expect(r.onPoorLink).toBe(0.25);
    expect(r.onCleanLink).toBe(0.25);
    expect(r.source).toBe('manual');
  });

  test('clamps out-of-range and junk values instead of trusting them', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(() => {
      const out = {};
      window.setJitterBufferSetting('manual', 9999);
      out.tooBig = window.jitterBufferSetting();
      window.setJitterBufferSetting('manual', -50);
      out.negative = window.jitterBufferSetting();
      localStorage.setItem('jitter-buffer', 'not-a-number');
      out.junk = window.jitterBufferSetting();
      return out;
    });
    expect(r.tooBig).toEqual({ mode: 'manual', ms: 500 });
    expect(r.negative).toEqual({ mode: 'manual', ms: 0 });
    // A corrupt value must fall back to auto, never wedge audio at a silly size.
    expect(r.junk).toEqual({ mode: 'auto', ms: 0 });
  });

  test('switching back to auto clears the stored override', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(() => {
      window.setJitterBufferSetting('manual', 200);
      window.setJitterBufferSetting('auto');
      return { stored: localStorage.getItem('jitter-buffer'), setting: window.jitterBufferSetting() };
    });
    expect(r.stored).toBe(null);
    expect(r.setting).toEqual({ mode: 'auto', ms: 0 });
  });
});

test.describe('host-pushed jitter buffer', () => {
  test('a host on dev mode broadcasts its manual value, otherwise null', async ({ page }) => {
    await page.goto('/');
    await seedRoom(page, { isHost: true, selfId: 'host-1' });
    const r = await page.evaluate(() => {
      const out = {};
      localStorage.setItem('dev-mode', 'true');
      window.setJitterBufferSetting('manual', 180);
      out.devOnManual = window.hostJitterBroadcastMs();
      window.setJitterBufferSetting('auto');
      out.devOnAuto = window.hostJitterBroadcastMs();
      window.setJitterBufferSetting('manual', 180);
      localStorage.setItem('dev-mode', 'false');
      out.devOff = window.hostJitterBroadcastMs();
      return out;
    });
    expect(r.devOnManual).toBe(180);
    // Auto means "no opinion" — nothing is pushed.
    expect(r.devOnAuto).toBe(null);
    // Gated on dev mode so a stale setting can't govern other people's audio.
    expect(r.devOff).toBe(null);
  });

  test('a non-host never broadcasts', async ({ page }) => {
    await page.goto('/');
    await seedRoom(page, { isHost: false });
    const value = await page.evaluate(() => {
      localStorage.setItem('dev-mode', 'true');
      window.setJitterBufferSetting('manual', 180);
      return window.hostJitterBroadcastMs();
    });
    expect(value).toBe(null);
  });

  test('a peer applies the host value, but a local choice still wins', async ({ page }) => {
    await page.goto('/');
    await seedRoom(page, { isHost: false, roomCode: 'host-1' });
    const r = await page.evaluate(() => {
      window.handleHostMessage({ type: 'heartbeat', jitterMs: 300 });
      const onAuto = {
        delay: window.effectivePlayoutDelay({ iceType: 'host' }),
        source: window.playoutDelaySource(),
      };
      window.setJitterBufferSetting('manual', 120);
      const withLocal = {
        delay: window.effectivePlayoutDelay({ iceType: 'host' }),
        source: window.playoutDelaySource(),
      };
      return { onAuto, withLocal };
    });
    expect(r.onAuto).toEqual({ delay: 0.3, source: 'host' });
    expect(r.withLocal).toEqual({ delay: 0.12, source: 'manual' });
  });

  test('clamps a hostile or malformed pushed value', async ({ page }) => {
    await page.goto('/');
    await seedRoom(page, { isHost: false, roomCode: 'host-1' });
    const r = await page.evaluate(() => {
      const out = {};
      window.handleHostMessage({ type: 'heartbeat', jitterMs: 999999 });
      out.huge = window.effectivePlayoutDelay(null);
      window.handleHostMessage({ type: 'heartbeat', jitterMs: -10 });
      out.negative = window.effectivePlayoutDelay(null);
      window.handleHostMessage({ type: 'heartbeat', jitterMs: 'lots' });
      out.junkSource = window.playoutDelaySource();
      return out;
    });
    expect(r.huge).toBe(0.5);       // clamped to JITTER_BUFFER_MAX_MS
    expect(r.negative).toBe(0);
    // A non-numeric push clears the override rather than being coerced.
    expect(r.junkSource).toBe('auto');
  });

  test('a host omitting the field (older build) leaves no override', async ({ page }) => {
    await page.goto('/');
    await seedRoom(page, { isHost: false, roomCode: 'host-1' });
    const source = await page.evaluate(() => {
      window.handleHostMessage({ type: 'heartbeat' });
      return window.playoutDelaySource();
    });
    expect(source).toBe('auto');
  });
});

test.describe('dropped-packet history', () => {
  test('keeps a rolling window and never exceeds the cap', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(() => {
      let history = [];
      for (let i = 0; i < 80; i++) history = window._pushLossHistory(history, i);
      return { length: history.length, first: history[0], last: history[history.length - 1] };
    });
    expect(r.length).toBe(60);
    expect(r.first).toBe(20);  // oldest 20 dropped
    expect(r.last).toBe(79);
  });

  test('records a missing sample as 0 rather than a gap', async ({ page }) => {
    await page.goto('/');
    const history = await page.evaluate(() => window._pushLossHistory([1.5], undefined));
    expect(history).toEqual([1.5, 0]);
  });

  test('renders a sparkline scaled to at least 5% so low loss stays readable', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(() => {
      const flat = window._buildLossSparkline([0, 0, 0], 'loss-spark-in');
      const spiky = window._buildLossSparkline([0, 40, 0], 'loss-spark-in');
      return {
        flatPoints: flat.querySelector('polyline').getAttribute('points'),
        spikyPoints: spiky.querySelector('polyline').getAttribute('points'),
        hasArea: !!spiky.querySelector('polygon'),
      };
    });
    // A flat-zero series sits on the baseline (y = height - 1 = 21).
    expect(r.flatPoints).toBe('0.0,21.0 66.0,21.0 132.0,21.0');
    // A 40% spike reaches the top of the 22px box.
    expect(r.spikyPoints).toBe('0.0,21.0 66.0,1.0 132.0,21.0');
    expect(r.hasArea).toBe(true);
  });

  test('the popover shows both directions, totals and the active buffer', async ({ page }) => {
    await page.goto('/');
    const text = await page.evaluate(() => {
      const el = window._buildLossDetail({
        lossPercent: 2.5, peakLossPercent: 9.1,
        packetsLostTotal: 120, packetsReceivedTotal: 4880,
        outLossPercent: 6.25, peakOutLossPercent: 12,
        outPacketsLostTotal: 300, outPacketsSentTotal: 4800,
        lossHistory: [0, 2.5], outLossHistory: [1, 6.25],
        playoutDelayMs: 200, playoutDelaySource: 'host',
      });
      return el.textContent;
    });
    expect(text).toContain('↓ Incoming');
    expect(text).toContain('↑ Outgoing (reported by peer)');
    expect(text).toContain('2.5% / 9.1%');
    // Denominator is packets expected (received + lost), not just received.
    expect(text).toContain('120 of 5,000');
    expect(text).toContain('300 of 4,800');
    expect(text).toContain('200 ms (set by host)');
  });
});

test.describe('jitter buffer settings control', () => {
  // The control lives in the Advanced section's <details>, reached via the
  // settings sidebar nav.
  async function openAdvanced(page) {
    await page.click('#btn-open-settings');
    await page.click('#modal-settings-sidebar .prefs-nav-btn[data-target="settings-advanced"]');
    await page.evaluate(() => { document.getElementById('turn-details').open = true; });
  }

  test('the slider is hidden on Automatic and revealed on Manual', async ({ page }) => {
    await page.goto('/');
    await openAdvanced(page);

    await expect(page.locator('input[name="jitter-mode"][value="auto"]')).toBeChecked();
    await expect(page.locator('#jitter-manual')).toHaveClass(/hidden/);

    await page.check('input[name="jitter-mode"][value="manual"]');
    await expect(page.locator('#jitter-manual')).not.toHaveClass(/hidden/);
  });

  test('moving the slider persists the value and updates the readout', async ({ page }) => {
    await page.goto('/');
    await openAdvanced(page);
    await page.check('input[name="jitter-mode"][value="manual"]');

    await page.locator('#input-jitter-ms').fill('240');
    await page.locator('#input-jitter-ms').dispatchEvent('input');

    await expect(page.locator('#jitter-ms-value')).toHaveText('240 ms');
    expect(await page.evaluate(() => localStorage.getItem('jitter-buffer'))).toBe('240');
    expect(await page.evaluate(() => window.effectivePlayoutDelay(null))).toBe(0.24);
  });

  test('the slider starts from the adaptive baseline, not 0', async ({ page }) => {
    await page.goto('/');
    await openAdvanced(page);
    // Switching to Manual should begin at what Automatic would have used, so the
    // first drag does not dump the buffer to nothing.
    await page.check('input[name="jitter-mode"][value="manual"]');
    await expect(page.locator('#input-jitter-ms')).toHaveValue('80');
  });

  test('returning to Automatic clears the override and restores adaptive behaviour', async ({ page }) => {
    await page.goto('/');
    await openAdvanced(page);
    await page.check('input[name="jitter-mode"][value="manual"]');
    await page.locator('#input-jitter-ms').fill('300');
    await page.locator('#input-jitter-ms').dispatchEvent('input');

    await page.check('input[name="jitter-mode"][value="auto"]');
    await expect(page.locator('#jitter-manual')).toHaveClass(/hidden/);
    expect(await page.evaluate(() => localStorage.getItem('jitter-buffer'))).toBe(null);
    expect(await page.evaluate(() => window.effectivePlayoutDelay({ iceType: 'relay' }))).toBe(0.2);
  });
});
