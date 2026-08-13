import { test, expect } from './fixtures.js';
import { seedRoom, callFn } from './_helpers.js';

// Network-usage sampling: bytes actually moved on the wire, split by media kind
// and direction, feeding the Settings → Advanced panel.
//
// The delta arithmetic is the part worth guarding. Byte counters are cumulative
// PER PEER CONNECTION, so the obvious implementation — sum every pc's totals,
// diff against last tick — spikes when a peer joins (their whole lifetime lands
// in one sample) and goes negative when one leaves. Each pc is compared only
// against its own previous reading instead, which is what the tests below pin.

/**
 * A fake RTCPeerConnection whose getStats() returns one nominated candidate
 * pair. `bytes` is mutated between ticks to simulate traffic.
 */
async function installFakePcs(page) {
  await page.evaluate(() => {
    // Rates are bytes-per-elapsed-second, so wall-clock jitter between two
    // sample() calls would make every expected value approximate. Freeze the
    // clock instead and step it explicitly — the arithmetic is the thing under
    // test, not the scheduler.
    window.__now = Date.now();
    Date.now = function() { return window.__now; };
    window.__advance = function(ms) { window.__now += ms; };

    window.__mkPc = function(sent, received) {
      const pc = {
        _sent: sent, _received: received,
        getStats() {
          const reports = [{
            type: 'candidate-pair', nominated: true, state: 'succeeded',
            bytesSent: pc._sent, bytesReceived: pc._received,
          }];
          return Promise.resolve({ forEach: (fn) => reports.forEach(fn) });
        },
      };
      return pc;
    };
    // A PeerJS-shaped MediaConnection wrapper around one of those.
    window.__mkMedia = function(pc) { return { closed: false, peerConnection: pc }; };
  });
}

test.describe('bandwidth sampling — per-kind attribution', () => {
  test('attributes each peer connection to the media kind that owns it', async ({ page }) => {
    await page.goto('/');
    await installFakePcs(page);
    await seedRoom(page, {
      selfId: 'self', isHost: true, roomCode: 'self',
      connections: [{ id: 'peer-1', pseudo: 'p1', open: true }],
    });
    await page.evaluate(() => {
      const conn = connections.get('peer-1');
      window.__audio  = window.__mkPc(0, 0);
      window.__camera = window.__mkPc(0, 0);
      window.__screen = window.__mkPc(0, 0);
      conn.media       = window.__mkMedia(window.__audio);
      conn.videoMedia  = window.__mkMedia(window.__camera);
      conn.screenMedia = window.__mkMedia(window.__screen);
    });

    // First tick establishes the baseline and must report nothing — counting a
    // connection's lifetime total as one tick's worth would read as a huge
    // false spike the moment it is first seen.
    const first = await callFn(page, '_collectBandwidthSample');
    expect(first.out.audio).toBe(0);
    expect(first.in.camera).toBe(0);

    await page.evaluate(() => {
      // 5s of traffic: 10 kB up on audio, 500 kB down on camera, 250 kB up on screen.
      window.__advance(5000);
      window.__audio._sent      = 10000;
      window.__camera._received = 500000;
      window.__screen._sent     = 250000;
    });
    const second = await callFn(page, '_collectBandwidthSample');

    expect(second.out.audio).toBe(16000);    // 10000 bytes * 8 / 5s
    expect(second.in.camera).toBe(800000);   // 500000 * 8 / 5
    expect(second.out.screen).toBe(400000);  // 250000 * 8 / 5
    // Nothing bleeds across kinds.
    expect(second.in.audio).toBe(0);
    expect(second.out.camera).toBe(0);
  });

  test('a peer leaving mid-window never produces a negative or spiked sample', async ({ page }) => {
    // The bug this guards: summing totals across a changing set of connections
    // and diffing that sum. A departure removes bytes from the total, so the
    // next delta goes negative; an arrival adds a lifetime total at once.
    await page.goto('/');
    await installFakePcs(page);
    await seedRoom(page, {
      selfId: 'self', isHost: true, roomCode: 'self',
      connections: [
        { id: 'peer-1', pseudo: 'p1', open: true },
        { id: 'peer-2', pseudo: 'p2', open: true },
      ],
    });
    await page.evaluate(() => {
      window.__a = window.__mkPc(1000000, 1000000); // a long-lived, chatty link
      window.__b = window.__mkPc(2000000, 2000000);
      connections.get('peer-1').media = window.__mkMedia(window.__a);
      connections.get('peer-2').media = window.__mkMedia(window.__b);
    });
    await callFn(page, '_collectBandwidthSample'); // baseline

    await page.evaluate(() => {
      window.__advance(5000);
      window.__a._sent += 5000;
      connections.delete('peer-2'); // the chatty peer with 2 MB of history leaves
    });
    const sample = await callFn(page, '_collectBandwidthSample');

    expect(sample.out.audio).toBe(8000); // only peer-1's 5000 bytes, nothing else
    expect(sample.out.audio).toBeGreaterThanOrEqual(0);
    expect(sample.in.audio).toBe(0);
  });

  test('an SFU publish leg is counted even though it belongs to no peer', async ({ page }) => {
    // Routing through the relay means one upload for everyone instead of one
    // per peer — if this leg were missed, the panel would show upload dropping
    // to nothing rather than dropping to one stream.
    await page.goto('/');
    await installFakePcs(page);
    await seedRoom(page, { selfId: 'self', isHost: true, roomCode: 'self' });
    await page.evaluate(() => {
      window.__sfu = window.__mkPc(0, 0);
      _sfuPublishSessions.video = { pc: window.__sfu, cfSessionId: 'cf-1', trackName: 'self-video' };
    });
    await callFn(page, '_collectBandwidthSample');
    await page.evaluate(() => {
      window.__advance(5000);
      window.__sfu._sent = 125000;
    });
    const sample = await callFn(page, '_collectBandwidthSample');
    expect(sample.out.camera).toBe(200000); // 125000 * 8 / 5
  });

  test('history is capped at 10 minutes of samples', async ({ page }) => {
    await page.goto('/');
    await seedRoom(page, { selfId: 'self', isHost: true, roomCode: 'self' });
    const length = await page.evaluate(async () => {
      for (let i = 0; i < NET_USAGE_HISTORY_MAX + 25; i++) await _collectBandwidthSample();
      return networkUsageSnapshot().history.length;
    });
    expect(length).toBe(120);
  });

  test('leaving a room clears the history and the per-connection cursors', async ({ page }) => {
    await page.goto('/');
    await seedRoom(page, { selfId: 'self', isHost: true, roomCode: 'self' });
    await page.evaluate(async () => { await _collectBandwidthSample(); await _collectBandwidthSample(); });
    expect(await page.evaluate(() => networkUsageSnapshot().history.length)).toBe(2);
    await page.evaluate(() => resetBandwidthHistory());
    expect(await page.evaluate(() => networkUsageSnapshot().history.length)).toBe(0);
    expect(await page.evaluate(() => networkUsageSnapshot().current)).toBeNull();
  });
});

test.describe('net-usage.js — formatting and chart geometry', () => {
  test('formatBitrate switches units without ever showing a negative', async ({ page }) => {
    await page.goto('/');
    expect(await callFn(page, 'formatBitrate', 0)).toBe('0 b/s');
    expect(await callFn(page, 'formatBitrate', 900)).toBe('900 b/s');
    expect(await callFn(page, 'formatBitrate', 16000)).toBe('16 kb/s');
    expect(await callFn(page, 'formatBitrate', 2500000)).toBe('2.5 Mb/s');
    expect(await callFn(page, 'formatBitrate', -5)).toBe('0 b/s');
    expect(await callFn(page, 'formatBitrate', undefined)).toBe('0 b/s');
  });

  test('totals sum across kinds, per direction', async ({ page }) => {
    await page.goto('/');
    const totals = await callFn(page, 'netUsageTotals', {
      in:  { audio: 1000, camera: 2000, screen: 500 },
      out: { audio: 100, camera: 200, screen: 0 },
    });
    expect(totals).toEqual({ in: 3500, out: 300 });
  });

  test('the y-axis has a floor so an idle call is not amplified into a wall', async ({ page }) => {
    await page.goto('/');
    const quiet = await callFn(page, 'netUsagePeak', [
      { in: { audio: 100, camera: 0, screen: 0 }, out: { audio: 100, camera: 0, screen: 0 } },
    ]);
    expect(quiet).toBe(64000);

    // Both directions share one scale, so ↓ and ↑ stay comparable by eye.
    const busy = await callFn(page, 'netUsagePeak', [
      { in: { audio: 1000, camera: 0, screen: 0 }, out: { audio: 900000, camera: 0, screen: 0 } },
    ]);
    expect(busy).toBe(900000);
  });

  test('a single sample draws nothing rather than a degenerate polygon', async ({ page }) => {
    await page.goto('/');
    const bands = await page.evaluate(() => {
      const svg = buildNetUsageArea([{ in: { audio: 1 }, out: { audio: 1 } }], 'in', 64000);
      return svg.querySelectorAll('polygon').length;
    });
    expect(bands).toBe(0);
  });

  test('the newest sample sits at the right edge, so a short history does not fake a full window', async ({ page }) => {
    await page.goto('/');
    const geometry = await page.evaluate(() => {
      const history = [];
      for (let i = 0; i < 3; i++) history.push({ in: { audio: 1000, camera: 0, screen: 0 }, out: { audio: 0 } });
      const svg = buildNetUsageArea(history, 'in', 64000);
      const points = svg.querySelector('polygon').getAttribute('points').split(' ');
      return { first: parseFloat(points[0].split(',')[0]), last: parseFloat(points[2].split(',')[0]) };
    });
    // 3 of 120 samples: the band occupies only the rightmost sliver.
    expect(geometry.last).toBeCloseTo(280, 1);
    expect(geometry.first).toBeGreaterThan(270);
  });

  test('the detail panel says why it is empty rather than drawing a blank chart', async ({ page }) => {
    await page.goto('/');
    const outOfRoom = await page.evaluate(() => {
      const el = document.createElement('div');
      renderNetUsageDetail(el, { inRoom: false, history: [], current: null });
      return el.textContent;
    });
    expect(outOfRoom).toContain('join a call');

    const warming = await page.evaluate(() => {
      const el = document.createElement('div');
      renderNetUsageDetail(el, { inRoom: true, history: [{ in: {}, out: {} }], current: null });
      return el.textContent;
    });
    expect(warming).toContain('Measuring');
  });

  test('the summary shows a dash outside a call, and real numbers inside one', async ({ page }) => {
    await page.goto('/');
    const values = await page.evaluate(() => {
      const inEl = document.createElement('strong');
      const outEl = document.createElement('strong');
      renderNetUsageSummary(inEl, outEl, { inRoom: false, current: null });
      const idle = [inEl.textContent, outEl.textContent];
      renderNetUsageSummary(inEl, outEl, {
        inRoom: true,
        current: { in: { audio: 16000, camera: 800000, screen: 0 }, out: { audio: 16000, camera: 0, screen: 0 } },
      });
      return { idle, live: [inEl.textContent, outEl.textContent] };
    });
    expect(values.idle).toEqual(['—', '—']);
    expect(values.live).toEqual(['816 kb/s', '16 kb/s']);
  });
});
