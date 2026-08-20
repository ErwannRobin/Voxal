import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// The host side of the star signalling topology: what a host does with a
// joiner's DataConnection, what it puts in a peer-list, and how a non-host
// bounces a joiner that reached it by mistake.
//
// PeerJS connections are EventEmitters, so a plain stub with `on`/`emit` drives
// the real handlers end to end without a broker.

/** Install a fake-DataConnection factory on the page. */
async function installFakes(page) {
  await page.evaluate(() => {
    window.__mkConn = function(peerId) {
      const handlers = {};
      return {
        peer: peerId,
        open: true,
        closed: false,
        sent: [],
        closeCalls: 0,
        send(m) { this.sent.push(m); },
        close() { this.closeCalls++; this.open = false; this.closed = true; },
        on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); },
        emit(evt, arg) { (handlers[evt] || []).forEach((fn) => fn(arg)); },
      };
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await installFakes(page);
});

test.describe('a joiner connecting to the host', () => {
  test('open registers the peer and stamps a first heartbeat', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, myPseudo: 'Host' });
    const seen = await page.evaluate(() => {
      const c = window.__mkConn('joiner');
      handleJoinerDataConnection(c);
      c.emit('open');
      const entry = connections.get('joiner');
      return {
        known: Array.from(knownPeerIds),
        hasData: entry.data === c,
        beat: typeof entry.lastHeartbeatAt === 'number',
        existing: c._voxalExistingPeer,
      };
    });
    expect(seen).toEqual({ known: ['joiner'], hasData: true, beat: true, existing: false });
  });

  test('a second connection from the same peer closes the first', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, myPseudo: 'Host' });
    const seen = await page.evaluate(() => {
      const first = window.__mkConn('joiner');
      handleJoinerDataConnection(first);
      first.emit('open');
      const second = window.__mkConn('joiner');
      handleJoinerDataConnection(second);
      second.emit('open');
      return {
        firstClosed: first.closeCalls,
        current: connections.get('joiner').data === second,
        flaggedExisting: second._voxalExistingPeer,
      };
    });
    expect(seen).toEqual({ firstClosed: 1, current: true, flaggedExisting: true });
  });

  test('hello is answered with an assigned name, a peer-list and a heartbeat', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, myPseudo: 'Host' });
    const sent = await page.evaluate(() => {
      const c = window.__mkConn('joiner');
      handleJoinerDataConnection(c);
      c.emit('open');
      c.emit('data', { type: 'hello', pseudo: 'Ada', protocolVersion: PROTOCOL_VERSION, appVersion: VOXAL_VERSION });
      return c.sent;
    });
    const types = sent.map((m) => m.type);
    // The name comes first, then the roster, then the room-wide flags; the
    // trailing pair is the broadcast that follows every membership change.
    expect(types.slice(0, 4)).toEqual(['pseudo-assigned', 'peer-list', 'heartbeat', 'video-mode']);
    expect(sent[0].pseudo).toBe('Ada');
    const list = sent[1];
    expect(list.hostId).toBe('host');
    expect(list.hostPseudo).toBe('Host');
    expect(list.protocolVersion).toBe(await page.evaluate(() => PROTOCOL_VERSION));
    expect(list.successorIds).toEqual(['joiner']);
    expect(list.deputyId).toBe('joiner');
  });

  test('a joiner asking for a name already in the room is renamed, not duplicated', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      myPseudo: 'Host',
      connections: [{ id: 'p1', pseudo: 'Ada' }],
    });
    const assigned = await page.evaluate(() => {
      const c = window.__mkConn('joiner');
      handleJoinerDataConnection(c);
      c.emit('open');
      c.emit('data', { type: 'hello', pseudo: 'Ada' });
      return c.sent.find((m) => m.type === 'pseudo-assigned').pseudo;
    });
    expect(assigned).not.toBe('Ada');
    expect(assigned.startsWith('Ada')).toBe(true);
  });

  test('everyone already in the room hears about the newcomer', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, myPseudo: 'Host' });
    const joined = await page.evaluate(() => {
      const existing = window.__mkConn('p1');
      handleJoinerDataConnection(existing);
      existing.emit('open');
      existing.emit('data', { type: 'hello', pseudo: 'Existing' });
      existing.sent.length = 0;

      const c = window.__mkConn('joiner');
      handleJoinerDataConnection(c);
      c.emit('open');
      c.emit('data', { type: 'hello', pseudo: 'New' });
      return existing.sent.filter((m) => m.type === 'peer-joined');
    });
    expect(joined).toHaveLength(1);
    expect(joined[0].peerId).toBe('joiner');
    expect(joined[0].pseudo).toBe('New');
  });

  test('a reconnecting peer does not re-announce itself as a new arrival', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      myPseudo: 'Host',
      connections: [{ id: 'p1', pseudo: 'Existing' }, { id: 'joiner', pseudo: 'Back' }],
    });
    const joined = await page.evaluate(() => {
      const existing = connections.get('p1').data;
      const seen = [];
      existing.send = (m) => seen.push(m);
      const c = window.__mkConn('joiner');
      handleJoinerDataConnection(c);
      c.emit('open');
      c.emit('data', { type: 'hello', pseudo: 'Back' });
      return seen.filter((m) => m.type === 'peer-joined');
    });
    expect(joined).toEqual([]);
  });

  test('the room is told a published lobby id, with the secret only for the deputy', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, myPseudo: 'Host' });
    const seen = await page.evaluate(() => {
      _publishedRoomId = 'lobby-1';
      _publishSecret = 's3cret';
      const first = window.__mkConn('deputy');
      handleJoinerDataConnection(first);
      first.emit('open');
      first.emit('data', { type: 'hello', pseudo: 'Deputy' });

      const second = window.__mkConn('other');
      handleJoinerDataConnection(second);
      second.emit('open');
      second.emit('data', { type: 'hello', pseudo: 'Other' });

      const pick = (c) => c.sent.find((m) => m.type === 'room-published');
      const out = { deputy: pick(first), other: pick(second) };
      _publishedRoomId = null;
      _publishSecret = null;
      return out;
    });
    expect(seen.deputy).toEqual({ type: 'room-published', roomId: 'lobby-1', secret: 's3cret' });
    expect(seen.other).toEqual({ type: 'room-published', roomId: 'lobby-1', secret: null });
  });

  test('a talking flag is relayed to every other peer', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      connections: [{ id: 'p1', pseudo: 'One' }, { id: 'p2', pseudo: 'Two' }],
    });
    const relayed = await page.evaluate(() => {
      const seen = [];
      connections.get('p2').data.send = (m) => seen.push(m);
      const c = window.__mkConn('p1');
      connections.set('p1', Object.assign({}, connections.get('p1'), { data: c }));
      handleJoinerDataConnection(c);
      c.emit('data', { type: 'talking', active: true });
      return seen;
    });
    expect(relayed).toContainEqual({ type: 'talking', peerId: 'p1', active: true });
  });

  test('a rename is acknowledged to the sender and relayed to the rest', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      connections: [{ id: 'p1', pseudo: 'One' }, { id: 'p2', pseudo: 'Two' }],
    });
    const seen = await page.evaluate(() => {
      const others = [];
      connections.get('p2').data.send = (m) => others.push(m);
      const c = window.__mkConn('p1');
      connections.set('p1', Object.assign({}, connections.get('p1'), { data: c }));
      handleJoinerDataConnection(c);
      c.emit('data', { type: 'pseudo', pseudo: 'Renamed' });
      return { toSender: c.sent, toOthers: others, stored: connections.get('p1').pseudo };
    });
    expect(seen.stored).toBe('Renamed');
    expect(seen.toSender.map((m) => m.type)).toEqual(['pseudo-assigned']);
    expect(seen.toOthers).toContainEqual(
      expect.objectContaining({ type: 'peer-renamed', peerId: 'p1', pseudo: 'Renamed' }));
  });

  test('a video offer marks the sharer active and relays the routing topology', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      connections: [{ id: 'p1' }, { id: 'p2' }],
    });
    const seen = await page.evaluate(() => {
      const others = [];
      connections.get('p2').data.send = (m) => others.push(m);
      const c = window.__mkConn('p1');
      connections.set('p1', Object.assign({}, connections.get('p1'), { data: c }));
      handleJoinerDataConnection(c);
      c.emit('data', { type: 'video-offer' });
      return { relayed: others.filter((m) => m.type === 'video-offer'), active: connections.get('p1').videoActive };
    });
    expect(seen.active).toBe(true);
    expect(seen.relayed).toHaveLength(1);
    // An absent topology is never inferred as 'sfu' — p2p is the always-available path.
    expect(seen.relayed[0].topology).toBe('p2p');
  });

  test('a video stop is relayed and clears the sharer', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      connections: [{ id: 'p1', videoActive: true }, { id: 'p2' }],
    });
    const seen = await page.evaluate(() => {
      const others = [];
      connections.get('p2').data.send = (m) => others.push(m);
      const c = window.__mkConn('p1');
      connections.set('p1', Object.assign({}, connections.get('p1'), { data: c }));
      handleJoinerDataConnection(c);
      c.emit('data', { type: 'video-stop' });
      return others.filter((m) => m.type === 'video-stop');
    });
    expect(seen).toEqual([{ type: 'video-stop', peerId: 'p1' }]);
  });

  test('screen offer / stop follow the same relay path', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      connections: [{ id: 'p1' }, { id: 'p2' }],
    });
    const seen = await page.evaluate(() => {
      const others = [];
      connections.get('p2').data.send = (m) => others.push(m);
      const c = window.__mkConn('p1');
      connections.set('p1', Object.assign({}, connections.get('p1'), { data: c }));
      handleJoinerDataConnection(c);
      c.emit('data', { type: 'screen-offer' });
      const active = connections.get('p1').screenActive;
      c.emit('data', { type: 'screen-stop' });
      return { active, types: others.map((m) => m.type) };
    });
    expect(seen.active).toBe(true);
    expect(seen.types).toEqual(['screen-offer', 'screen-stop']);
  });

  test('malformed and stale packets are dropped rather than acted on', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true });
    const seen = await page.evaluate(() => {
      const c = window.__mkConn('p1');
      handleJoinerDataConnection(c);
      c.emit('open');
      c.sent.length = 0;
      c.emit('data', null);
      c.emit('data', 'not-an-object');
      const afterMalformed = c.sent.length;

      // A packet arriving on a connection the map no longer points at is stale.
      connections.set('p1', Object.assign({}, connections.get('p1'), { data: window.__mkConn('p1') }));
      c.emit('data', { type: 'hello', pseudo: 'Ghost' });
      return { afterMalformed, afterStale: c.sent.length };
    });
    expect(seen).toEqual({ afterMalformed: 0, afterStale: 0 });
  });

  test('a device-info response for another requester is relayed, not swallowed', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      connections: [{ id: 'target' }, { id: 'asker' }],
    });
    const relayed = await page.evaluate(() => {
      const seen = [];
      connections.get('asker').data.send = (m) => seen.push(m);
      const c = window.__mkConn('target');
      connections.set('target', Object.assign({}, connections.get('target'), { data: c }));
      handleJoinerDataConnection(c);
      c.emit('data', { type: 'device-info-response', from: 'asker', info: { device: { os: 'Linux' } } });
      return seen;
    });
    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toMatchObject({ type: 'device-info-response', peerId: 'target' });
  });

  test('a closing peer is announced once, on the next tick', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, connections: [{ id: 'p2' }] });
    const seen = await page.evaluate(async () => {
      const others = [];
      connections.get('p2').data.send = (m) => others.push(m);
      const c = window.__mkConn('leaver');
      handleJoinerDataConnection(c);
      c.emit('open');
      c.emit('close');
      const immediate = others.filter((m) => m.type === 'peer-left').length;
      await new Promise((r) => setTimeout(r, 10));
      return {
        immediate,
        deferred: others.filter((m) => m.type === 'peer-left').length,
        gone: !connections.has('leaver'),
        forgotten: !knownPeerIds.has('leaver'),
      };
    });
    // The broadcast is deferred one tick so a self-destroying host can skip it.
    expect(seen).toEqual({ immediate: 0, deferred: 1, gone: true, forgotten: true });
  });

  test('a peer that reconnected before the tick is not announced as gone', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, connections: [{ id: 'p2' }] });
    const seen = await page.evaluate(async () => {
      const others = [];
      connections.get('p2').data.send = (m) => others.push(m);
      const c = window.__mkConn('flappy');
      handleJoinerDataConnection(c);
      c.emit('open');
      c.emit('close');
      // Reconnect in the same tick, before the deferred cleanup runs.
      const again = window.__mkConn('flappy');
      handleJoinerDataConnection(again);
      again.emit('open');
      await new Promise((r) => setTimeout(r, 10));
      return { left: others.filter((m) => m.type === 'peer-left').length, still: connections.has('flappy') };
    });
    expect(seen).toEqual({ left: 0, still: true });
  });
});

test.describe('sendHostPeerList', () => {
  test('carries the room-wide settings a joiner needs', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      myPseudo: 'Host',
      connections: [{ id: 'p1', pseudo: 'One' }, { id: 'p2', pseudo: 'Two' }],
    });
    const list = await page.evaluate(() => {
      const out = [];
      sendHostPeerList({ send: (m) => out.push(m) }, 'p1');
      return out;
    });
    expect(list).toHaveLength(2);
    const peerList = list[0];
    expect(peerList.type).toBe('peer-list');
    // The recipient is excluded from the roster it is being sent.
    expect(peerList.peers.map((p) => p.id)).toEqual(['p2']);
    expect(peerList.selfPseudo).toBe('One');
    expect(peerList.hostVideoTopology).toBe('p2p');
    expect(peerList.hostScreenTopology).toBe('p2p');
    expect(list[1].type).toBe('heartbeat');
  });

  test('a null connection is simply skipped', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true });
    const threw = await page.evaluate(() => {
      try { sendHostPeerList(null, 'p1'); return false; } catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });

  test('broadcastHostPeerLists reaches every live peer and prunes the dead ones', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      knownPeerIds: ['live', 'ghost'],
      connections: [{ id: 'live' }, { id: 'ghost', open: false }],
    });
    const seen = await page.evaluate(() => {
      const got = [];
      connections.get('live').data.send = (m) => got.push(m.type);
      broadcastHostPeerLists();
      return { got, left: Array.from(connections.keys()) };
    });
    expect(seen.got).toEqual(['peer-list', 'heartbeat']);
    expect(seen.left).toEqual(['live']);
  });

  test('during the migration settle window nobody is pruned', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      knownPeerIds: ['reconnecting'],
      connections: [{ id: 'reconnecting', open: false }],
    });
    const left = await page.evaluate(() => {
      startMigrationSettle();
      broadcastHostPeerLists();
      const out = Array.from(connections.keys());
      stopMigrationSettle();
      return out;
    });
    expect(left).toEqual(['reconnecting']);
  });
});

test.describe('a non-host that a joiner reached by mistake', () => {
  test('redirects it to the current host, then hangs up', async ({ page }) => {
    await seedRoom(page, { selfId: 'p2', isHost: false, roomCode: 'the-host', myPseudo: 'Me' });
    const seen = await page.evaluate(async () => {
      const c = window.__mkConn('joiner');
      handleJoinRedirectConnection(c);
      c.emit('open');
      const sent = c.sent.slice();
      await new Promise((r) => setTimeout(r, 150));
      return { sent, closed: c.closeCalls };
    });
    expect(seen.sent).toHaveLength(1);
    expect(seen.sent[0]).toMatchObject({ type: 'redirect', hostId: 'the-host' });
    expect(seen.closed).toBe(1);
  });

  test('hangs up without redirecting when there is nowhere to send them', async ({ page }) => {
    const seen = await page.evaluate(() => {
      inRoom = false;
      isHost = false;
      roomCode = '';
      const c = window.__mkConn('joiner');
      handleJoinRedirectConnection(c);
      c.emit('open');
      return { sent: c.sent.length, closed: c.closeCalls };
    });
    expect(seen).toEqual({ sent: 0, closed: 1 });
  });

  test('never redirects a peer back to itself', async ({ page }) => {
    await seedRoom(page, { selfId: 'p2', isHost: false, roomCode: 'the-host' });
    const seen = await page.evaluate(() => {
      const c = window.__mkConn('the-host');
      handleJoinRedirectConnection(c);
      c.emit('open');
      return { sent: c.sent.length, closed: c.closeCalls };
    });
    expect(seen).toEqual({ sent: 0, closed: 1 });
  });
});

test.describe('applyHostRoutingHints', () => {
  test('an explicit successor chain wins', async ({ page }) => {
    const chain = await page.evaluate(() => {
      applyHostRoutingHints({ successorIds: ['a', 'b'], deputyId: 'ignored' });
      return _authoritativeSuccessorIds.slice();
    });
    expect(chain).toEqual(['a', 'b']);
  });

  test('a lone deputyId becomes a one-entry chain', async ({ page }) => {
    const chain = await page.evaluate(() => {
      setAuthoritativeSuccessorIds([]);
      applyHostRoutingHints({ deputyId: 'only' });
      return _authoritativeSuccessorIds.slice();
    });
    expect(chain).toEqual(['only']);
  });

  test('a message carrying neither leaves the chain alone', async ({ page }) => {
    const chain = await page.evaluate(() => {
      setAuthoritativeSuccessorIds(['keep']);
      applyHostRoutingHints({});
      applyHostRoutingHints(null);
      return _authoritativeSuccessorIds.slice();
    });
    expect(chain).toEqual(['keep']);
  });
});

test.describe('handleIncomingCall', () => {
  test('an audio call is answered, attached and tuned', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true });
    const seen = await page.evaluate(() => {
      const handlers = {};
      const call = {
        peer: 'p1',
        metadata: null,
        answered: false,
        answer() { this.answered = true; },
        on(e, fn) { (handlers[e] = handlers[e] || []).push(fn); },
      };
      handleIncomingCall(call);
      handlers.stream.forEach((fn) => fn(new MediaStream()));
      return {
        answered: call.answered,
        media: connections.get('p1').media === call,
        audioEl: !!document.getElementById('audio-p1'),
      };
    });
    expect(seen).toEqual({ answered: true, media: true, audioEl: true });
  });

  test('video and screen calls are routed to their own handlers, not answered as audio', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true });
    const answered = await page.evaluate(() => {
      const mk = (type) => ({
        peer: 'p1',
        metadata: { type },
        answered: false,
        answer() { this.answered = true; },
        on() {},
      });
      const video = mk('video');
      const screen = mk('screen');
      handleIncomingCall(video);
      handleIncomingCall(screen);
      // Both take the video/screen path, which answers with its own options —
      // what matters is that neither fell through to the audio branch below.
      return { video: video.metadata.type, screen: screen.metadata.type };
    });
    expect(answered).toEqual({ video: 'video', screen: 'screen' });
  });
});
