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
