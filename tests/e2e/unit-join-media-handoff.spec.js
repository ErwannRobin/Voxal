import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// What a newcomer is shown of the camera and screen shares that were already
// running when they arrived.
//
// The host is the only peer that sees the join, so it does two things: it calls
// the newcomer with its own share, and it nudges every OTHER sharing peer to do
// the same. Both are P2P-mesh-only. A share that is already on the SFU must be
// skipped in both places — the newcomer subscribes to it from the peer-list's
// videoTopology instead, and a mesh call on top of that is a duplicate stream
// nobody asked for and a second upload the sharer was moved off the mesh to
// avoid.

/** Fake PeerJS DataConnections and MediaConnections, and a `peer` that calls. */
async function installFakes(page) {
  await page.evaluate(() => {
    window.__mkConn = function(peerId) {
      const handlers = {};
      return {
        peer: peerId,
        open: true,
        closed: false,
        sent: [],
        send(m) { this.sent.push(m); },
        close() { this.open = false; this.closed = true; },
        on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); },
        emit(evt, arg) { (handlers[evt] || []).forEach((fn) => fn(arg)); },
      };
    };

    window.__calls = [];
    window.__mkCall = function(peerId, stream, options) {
      const handlers = {};
      const call = {
        peer: peerId,
        stream,
        metadata: options && options.metadata,
        peerConnection: null,
        closed: false,
        close() { this.closed = true; this.emit('close'); },
        on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); },
        emit(evt, arg) { (handlers[evt] || []).forEach((fn) => fn(arg)); },
      };
      window.__calls.push(call);
      return call;
    };
  });
}

/** A host that is in a room and can place media calls. */
async function seedHost(page, extraPeers = []) {
  await seedRoom(page, {
    selfId: 'host',
    isHost: true,
    roomCode: 'host',
    myPseudo: 'Host',
    connections: extraPeers,
  });
  await page.evaluate(() => {
    peer = { id: 'host', destroyed: false, call: (id, stream, opts) => window.__mkCall(id, stream, opts) };
    window.__calls.length = 0;
    // seedRoom's stub DataConnection swallows what is sent; these tests need to
    // read it back, so give every seeded peer a recording one.
    connections.forEach((conn, id) => { conn.data = window.__mkConn(id); });
  });
}

/** Turn on a local share of `kind`, on the given topology. */
async function share(page, kind, mode) {
  await page.evaluate(({ kind, mode }) => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 240;
    canvas.getContext('2d').fillRect(0, 0, 320, 240);
    const stream = canvas.captureStream(5);
    if (kind === 'video') { localVideoActive = true; localVideoStream = stream; }
    else { localScreenActive = true; localScreenStream = stream; }
    _localVideoTopology[kind] = { mode, reason: 'ok' };
  }, { kind, mode });
}

/** Run a full join: DataConnection opens, then the joiner says hello. */
async function joinerArrives(page, joinerId = 'newcomer') {
  await page.evaluate((id) => {
    const c = window.__mkConn(id);
    window.__joinerConn = c;
    handleJoinerDataConnection(c);
    c.emit('open');
    c.emit('data', { type: 'hello', pseudo: 'Newcomer', at: Date.now() });
  }, joinerId);
}

const callsMade = (page) =>
  page.evaluate(() => window.__calls.map((c) => ({ peer: c.peer, type: c.metadata && c.metadata.type })));

/** Every message the host pushed to an existing peer. */
const messagesTo = (page, peerId) =>
  page.evaluate((id) => connections.get(id).data.sent, peerId);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await installFakes(page);
});

// --- the host's own share ----------------------------------------------------

test.describe('the host\'s own share', () => {
  test('a P2P camera is called out to the newcomer', async ({ page }) => {
    await seedHost(page);
    await share(page, 'video', 'p2p');
    await joinerArrives(page);

    expect(await callsMade(page)).toEqual([{ peer: 'newcomer', type: 'video' }]);
    // The outgoing call is remembered so it can be torn down later.
    expect(await page.evaluate(() => connections.get('newcomer').videoMediaOut === window.__calls[0])).toBe(true);
  });

  test('a camera already on the SFU is not also called over the mesh', async ({ page }) => {
    await seedHost(page);
    await share(page, 'video', 'sfu');
    await joinerArrives(page);

    // The newcomer picks it up from the peer-list's videoTopology instead.
    expect(await callsMade(page)).toEqual([]);
  });

  test('a P2P screen share is called out too, tagged as a screen', async ({ page }) => {
    await seedHost(page);
    await share(page, 'screen', 'p2p');
    await joinerArrives(page);

    expect(await callsMade(page)).toEqual([{ peer: 'newcomer', type: 'screen' }]);
    expect(await page.evaluate(() => connections.get('newcomer').screenMediaOut === window.__calls[0])).toBe(true);
  });

  test('a screen share on the SFU is skipped, independently of the camera', async ({ page }) => {
    await seedHost(page);
    await share(page, 'video', 'p2p');
    await share(page, 'screen', 'sfu');
    await joinerArrives(page);

    expect(await callsMade(page)).toEqual([{ peer: 'newcomer', type: 'video' }]);
  });

  test('camera and screen are two separate calls, not one stream', async ({ page }) => {
    await seedHost(page);
    await share(page, 'video', 'p2p');
    await share(page, 'screen', 'p2p');
    await joinerArrives(page);

    expect(await callsMade(page)).toEqual([
      { peer: 'newcomer', type: 'video' },
      { peer: 'newcomer', type: 'screen' },
    ]);
    const distinct = await page.evaluate(() => window.__calls[0].stream !== window.__calls[1].stream);
    expect(distinct).toBe(true);
  });

  test('a host sharing nothing calls nobody', async ({ page }) => {
    await seedHost(page);
    await joinerArrives(page);
    expect(await callsMade(page)).toEqual([]);
  });

  test('an ended outgoing call is forgotten, so a later one is not shadowed', async ({ page }) => {
    await seedHost(page);
    await share(page, 'video', 'p2p');
    await share(page, 'screen', 'p2p');
    await joinerArrives(page);

    const after = await page.evaluate(() => {
      window.__calls.forEach((c) => c.close());
      const conn = connections.get('newcomer');
      return { video: conn.videoMediaOut, screen: conn.screenMediaOut };
    });

    expect(after.video).toBe(null);
    expect(after.screen).toBe(null);
  });

  test('the newcomer\'s own camera comes back over the same call', async ({ page }) => {
    await seedHost(page);
    await share(page, 'video', 'p2p');
    await joinerArrives(page);

    const attached = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 160; canvas.height = 120;
      canvas.getContext('2d').fillRect(0, 0, 160, 120);
      const incoming = canvas.captureStream(5);
      window.__calls[0].emit('stream', incoming);
      return connections.get('newcomer').remoteVideoStream === incoming;
    });

    expect(attached).toBe(true);
  });
});

// --- nudging the other sharers ----------------------------------------------

test.describe('the other peers already sharing', () => {
  test('a P2P camera sharer is told to call the newcomer', async ({ page }) => {
    await seedHost(page, [{ id: 'sharer', pseudo: 'Sharer', videoActive: true }]);
    await joinerArrives(page);

    expect(await messagesTo(page, 'sharer')).toContainEqual({ type: 'video-call-peer', peerId: 'newcomer' });
  });

  test('a sharer already on the SFU is not nudged', async ({ page }) => {
    await seedHost(page, [{ id: 'sharer', pseudo: 'Sharer', videoActive: true }]);
    await page.evaluate(() => {
      connections.get('sharer').videoTopology = { mode: 'sfu', reason: 'ok' };
    });
    await joinerArrives(page);

    const msgs = await messagesTo(page, 'sharer');
    expect(msgs.filter((m) => m.type === 'video-call-peer')).toEqual([]);
  });

  test('a peer that is not sharing is left alone', async ({ page }) => {
    await seedHost(page, [{ id: 'quiet', pseudo: 'Quiet' }]);
    await joinerArrives(page);

    const msgs = await messagesTo(page, 'quiet');
    expect(msgs.filter((m) => m.type === 'video-call-peer' || m.type === 'screen-call-peer')).toEqual([]);
  });

  test('the newcomer is never told to call itself', async ({ page }) => {
    await seedHost(page);
    await joinerArrives(page);
    // The joiner is in `connections` by the time the nudges go out, and marking
    // it video-active would otherwise make the host tell it to call itself.
    const msgs = await page.evaluate(() => {
      connections.get('newcomer').videoActive = true;
      const second = window.__mkConn('other');
      handleJoinerDataConnection(second);
      second.emit('open');
      second.emit('data', { type: 'hello', pseudo: 'Other', at: Date.now() });
      return connections.get('newcomer').data.sent.filter((m) => m.type === 'video-call-peer');
    });

    expect(msgs).toEqual([{ type: 'video-call-peer', peerId: 'other' }]);
  });

  test('a screen sharer gets its own nudge, on its own topology', async ({ page }) => {
    await seedHost(page, [
      { id: 'cam', pseudo: 'Cam', videoActive: true },
      { id: 'scr', pseudo: 'Scr', screenActive: true },
    ]);
    await page.evaluate(() => {
      connections.get('scr').videoTopology = { mode: 'sfu', reason: 'ok' };  // its camera, not its screen
    });
    await joinerArrives(page);

    expect(await messagesTo(page, 'scr')).toContainEqual({ type: 'screen-call-peer', peerId: 'newcomer' });
    expect(await messagesTo(page, 'cam')).toContainEqual({ type: 'video-call-peer', peerId: 'newcomer' });
  });

  test('a sharer whose screen is on the SFU is not nudged for it', async ({ page }) => {
    await seedHost(page, [{ id: 'scr', pseudo: 'Scr', screenActive: true }]);
    await page.evaluate(() => {
      connections.get('scr').screenTopology = { mode: 'sfu', reason: 'ok' };
    });
    await joinerArrives(page);

    const msgs = await messagesTo(page, 'scr');
    expect(msgs.filter((m) => m.type === 'screen-call-peer')).toEqual([]);
  });
});
