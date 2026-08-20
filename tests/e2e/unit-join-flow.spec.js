import { test, expect } from './fixtures.js';

// The three ways a session starts — create, join, rejoin — plus the connect
// state machine underneath them (retries, redirects, generation fencing) and
// the teardown that has to undo all of it.
//
// `Peer` is a plain global from the vendored PeerJS bundle, so swapping in a
// stub drives every one of these paths without a broker or real WebRTC.

async function installFakePeer(page) {
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
        close() { this.closeCalls++; this.open = false; this.closed = true; (handlers.close || []).forEach((fn) => fn()); },
        on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); },
        emit(evt, arg) { (handlers[evt] || []).forEach((fn) => fn(arg)); },
      };
    };

    window.__peers = [];
    window.__lastPeer = null;
    window.__lastHostConn = null;
    // fetchIceServers() does real (failing) network work first, so every flow
    // that builds a Peer has to be awaited rather than assumed.
    window.__waitPeer = async function() {
      for (let i = 0; i < 300 && !window.__lastPeer; i++) await new Promise((r) => setTimeout(r, 10));
      return window.__lastPeer;
    };
    window.__waitHostConn = async function() {
      for (let i = 0; i < 300 && !window.__lastHostConn; i++) await new Promise((r) => setTimeout(r, 10));
      return window.__lastHostConn;
    };
    window.Peer = function FakePeer(opts) {
      const handlers = {};
      const self = {
        id: 'self-peer-id',
        options: opts,
        destroyed: false,
        disconnected: false,
        connectCalls: [],
        reconnectCalls: 0,
        connectReturns: null, // set to null-returning to simulate a dead broker
        on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); },
        emit(evt, arg) { (handlers[evt] || []).forEach((fn) => fn(arg)); },
        destroy() { this.destroyed = true; },
        reconnect() { this.reconnectCalls++; },
        call() { return null; },
        connect(id) {
          this.connectCalls.push(id);
          if (this.connectReturns === 'undefined') return undefined;
          const c = window.__mkConn(id);
          window.__lastHostConn = c;
          return c;
        },
      };
      window.__peers.push(self);
      window.__lastPeer = self;
      return self;
    };

    // Nothing here needs a real microphone: a pre-set stream makes the
    // fire-and-forget acquisition on join a no-op.
    stream = new MediaStream();
    // Keep every test offline — the local static server has no lobby API.
    localStorage.setItem('turn-fallback', '[]');
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await installFakePeer(page);
});

test.describe('createRoom', () => {
  test('opening the broker makes us the host of our own peer id', async ({ page }) => {
    const state = await page.evaluate(async () => {
      const joined = [];
      const p = createRoom((id) => joined.push(id));
      (await window.__waitPeer()).emit('open', 'room-abc');
      await p;
      return {
        joined,
        isHost,
        inRoom,
        roomCode,
        roomState,
        stored: localStorage.getItem('active-room-code'),
        screen: document.querySelector('.screen.active') && document.querySelector('.screen.active').id,
      };
    });
    expect(state.joined).toEqual(['room-abc']);
    expect(state.isHost).toBe(true);
    expect(state.inRoom).toBe(true);
    expect(state.roomCode).toBe('room-abc');
    expect(state.roomState).toBe('connected');
    expect(state.stored).toBe('room-abc');
    expect(state.screen).toBe('screen-room');
  });

  test('the room state is wiped before the new peer is built', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      knownPeerIds.add('stale-peer');
      setAuthoritativeSuccessorIds(['stale-successor']);
      const p = createRoom();
      (await window.__waitPeer()).emit('open', 'room-abc');
      await p;
      return { known: Array.from(knownPeerIds), chain: _authoritativeSuccessorIds.slice() };
    });
    expect(seen).toEqual({ known: [], chain: [] });
  });

  test('cancelling mid-flight rejects and destroys the peer', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      const p = createRoom();
      await window.__waitPeer();
      _cancelJoin();
      let message = null;
      try { await p; } catch (e) { message = e.message; }
      return { message, destroyed: window.__lastPeer.destroyed, inRoom };
    });
    expect(seen.message).toBe('Connection cancelled.');
    expect(seen.destroyed).toBe(true);
    expect(seen.inRoom).toBe(false);
  });

  test('a broker error before opening rejects with a readable message', async ({ page }) => {
    const message = await page.evaluate(async () => {
      const p = createRoom();
      await window.__waitPeer();
      const err = new Error('lost the socket');
      err.type = 'network';
      window.__lastPeer.emit('error', err);
      try { await p; return null; } catch (e) { return e.message; }
    });
    expect(message).toBe('Network error — please check your connection and try again.');
  });
});

test.describe('joinRoom', () => {
  const HOST = '11111111-2222-3333-4444-555555555555';

  test('a peer-id join connects, then finishes on the first peer-list', async ({ page }) => {
    const state = await page.evaluate(async (host) => {
      const p = joinRoom(host);
      (await window.__waitPeer()).emit('open');
      const conn = await window.__waitHostConn();
      conn.emit('open');
      conn.emit('data', { type: 'peer-list', peers: [], hostId: host, hostPseudo: 'Host' });
      await p;
      return {
        hello: conn.sent.filter((m) => m.type === 'hello').length,
        inRoom,
        isHost,
        roomCode,
        roomState,
        knowsHost: knownPeerIds.has(host),
        hostConn: connections.get(host).data === conn,
      };
    }, HOST);
    expect(state.hello).toBe(1);
    expect(state.inRoom).toBe(true);
    expect(state.isHost).toBe(false);
    expect(state.roomCode).toBe(HOST);
    expect(state.roomState).toBe('connected');
    expect(state.knowsHost).toBe(true);
    expect(state.hostConn).toBe(true);
  });

  test('a host renaming us is applied, and the old name kept for the way out', async ({ page }) => {
    const seen = await page.evaluate(async (host) => {
      myPseudo = 'Ada';
      _preRenameMyPseudo = null;
      const p = joinRoom(host);
      (await window.__waitPeer()).emit('open');
      const conn = await window.__waitHostConn();
      conn.emit('open');
      conn.emit('data', { type: 'pseudo-assigned', pseudo: 'Ada 2', pseudoColor: null });
      conn.emit('data', { type: 'peer-list', peers: [], hostId: host });
      await p;
      return { myPseudo, restoreTo: _preRenameMyPseudo };
    }, HOST);
    expect(seen).toEqual({ myPseudo: 'Ada 2', restoreTo: 'Ada' });
  });

  test('a redirect is followed to the real host', async ({ page }) => {
    const seen = await page.evaluate(async (host) => {
      const real = '99999999-2222-3333-4444-555555555555';
      const p = joinRoom(host);
      (await window.__waitPeer()).emit('open');
      const first = await window.__waitHostConn();
      first.emit('open');
      first.emit('data', { type: 'redirect', hostId: real });
      const second = window.__lastHostConn;
      second.emit('open');
      second.emit('data', { type: 'peer-list', peers: [], hostId: real });
      await p;
      return { connects: window.__lastPeer.connectCalls, roomCode, firstClosed: first.closeCalls > 0 };
    }, HOST);
    expect(seen.connects).toEqual([HOST, '99999999-2222-3333-4444-555555555555']);
    expect(seen.roomCode).toBe('99999999-2222-3333-4444-555555555555');
    expect(seen.firstClosed).toBe(true);
  });

  test('a redirect loop back to the same host is refused', async ({ page }) => {
    const message = await page.evaluate(async (host) => {
      const p = joinRoom(host);
      (await window.__waitPeer()).emit('open');
      const conn = await window.__waitHostConn();
      conn.emit('open');
      conn.emit('data', { type: 'redirect', hostId: host });
      try { await p; return null; } catch (e) { return e.message; }
    }, HOST);
    expect(message).toBe('Received a redirect back to the same host.');
  });

  test('a redirect with no host id is refused', async ({ page }) => {
    const message = await page.evaluate(async (host) => {
      const p = joinRoom(host);
      (await window.__waitPeer()).emit('open');
      (await window.__waitHostConn()).emit('data', { type: 'redirect' });
      try { await p; return null; } catch (e) { return e.message; }
    }, HOST);
    expect(message).toBe('Received redirect without a host id.');
  });

  test('a channel of redirects is cut off before it can loop forever', async ({ page }) => {
    const message = await page.evaluate(async (host) => {
      const p = joinRoom(host);
      (await window.__waitPeer()).emit('open');
      await window.__waitHostConn();
      // Redirect one more time than the budget allows.
      for (let i = 0; i <= MAX_JOIN_REDIRECTS; i++) {
        const conn = window.__lastHostConn;
        conn.emit('open');
        conn.emit('data', { type: 'redirect', hostId: 'hop-' + i });
      }
      try { await p; return null; } catch (e) { return e.message; }
    }, HOST);
    expect(message).toBe('Too many host redirects while joining.');
  });

  test('a host that hangs up before sending a peer-list fails the join', async ({ page }) => {
    const message = await page.evaluate(async (host) => {
      const p = joinRoom(host);
      (await window.__waitPeer()).emit('open');
      (await window.__waitHostConn()).emit('close');
      try { await p; return null; } catch (e) { return e.message; }
    }, HOST);
    expect(message).toBe('Connection to host closed before joining.');
  });

  test('a broker that cannot open a channel fails the join rather than hanging', async ({ page }) => {
    const message = await page.evaluate(async (host) => {
      const p = joinRoom(host);
      const fake = await window.__waitPeer();
      fake.connectReturns = 'undefined';
      fake.disconnected = true;
      fake.emit('open');
      try { await p; return null; } catch (e) { return e.message; }
    }, HOST);
    expect(message).toBe('Lost connection to the signaling server. Please try again.');
  });

  test('a blank code is a no-op', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      await joinRoom('   ');
      return { peers: window.__peers.length, inRoom };
    });
    expect(seen).toEqual({ peers: 0, inRoom: false });
  });

  test('an unresolvable named code makes us the host instead', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      const p = joinRoom('a-named-room');
      // lookupRoom / presence resolution both fail against the static test
      // server, so the join falls through to createRoom().
      (await window.__waitPeer()).emit('open', 'new-host-id');
      await p;
      return { isHost, roomCode, inRoom };
    });
    expect(seen).toEqual({ isHost: true, roomCode: 'new-host-id', inRoom: true });
  });
});

test.describe('connectToHost generation fencing', () => {
  test('a superseded attempt closes itself instead of joining', async ({ page }) => {
    const seen = await page.evaluate(() => {
      inRoom = false;
      peer = { id: 'me', destroyed: false, connect: (id) => (window.__lastHostConn = window.__mkConn(id)) };
      const rejects = [];
      connectToHost('old-host', { onInitialJoinReject: (e) => rejects.push(e.message) });
      const stale = window.__lastHostConn;
      // A second attempt bumps the generation, fencing the first.
      connectToHost('new-host', {});
      stale.emit('open');
      stale.emit('data', { type: 'peer-list', peers: [] });
      return { staleClosed: stale.closeCalls > 0, inRoom, rejects };
    });
    expect(seen.staleClosed).toBe(true);
    expect(seen.inRoom).toBe(false);
    expect(seen.rejects).toEqual([]);
  });

  test('a destroyed peer is never dialled', async ({ page }) => {
    const dialled = await page.evaluate(() => {
      let calls = 0;
      peer = { id: 'me', destroyed: true, connect: () => { calls++; } };
      connectToHost('host', {});
      peer = null;
      connectToHost('host', {});
      return calls;
    });
    expect(dialled).toBe(0);
  });
});

test.describe('_attemptHostConnection', () => {
  test('a peer-list from the elected host completes the migration', async ({ page }) => {
    const state = await page.evaluate(() => {
      inRoom = true;
      isHost = false;
      roomCode = 'dead-host';
      roomState = ROOM_STATE_MIGRATING;
      connections.clear();
      peer = { id: 'me', destroyed: false, connect: (id) => (window.__lastHostConn = window.__mkConn(id)) };
      _migrationCandidateId = 'new-host';
      _migrationExcluded = new Set(['dead-host']);
      _attemptHostConnection('new-host', 3);
      const conn = window.__lastHostConn;
      conn.emit('open');
      conn.emit('data', { type: 'peer-list', peers: [], hostId: 'new-host', hostPseudo: 'Newbie' });
      return {
        roomState,
        roomCode,
        isHost,
        candidate: _migrationCandidateId,
        excluded: _migrationExcluded.size,
        hostPseudo: connections.get('new-host').pseudo,
        hello: conn.sent.filter((m) => m.type === 'hello').length,
      };
    });
    expect(state).toEqual({
      roomState: 'connected',
      roomCode: 'new-host',
      isHost: false,
      candidate: null,
      excluded: 0,
      hostPseudo: 'Newbie',
      hello: 1,
    });
  });

  test('an attempt for a candidate we no longer want is dropped', async ({ page }) => {
    const dialled = await page.evaluate(() => {
      inRoom = true;
      let calls = 0;
      peer = { id: 'me', destroyed: false, connect: () => { calls++; return window.__mkConn('x'); } };
      _migrationCandidateId = 'wanted';
      _attemptHostConnection('no-longer-wanted', 3);
      return calls;
    });
    expect(dialled).toBe(0);
  });

  test('a failure with no retries left excludes the candidate and re-elects', async ({ page }) => {
    const seen = await page.evaluate(() => {
      inRoom = true;
      isHost = false;
      roomCode = 'dead-host';
      roomState = ROOM_STATE_MIGRATING;
      connections.clear();
      knownPeerIds.clear();
      peer = { id: 'z-me', destroyed: false, connect: (id) => (window.__lastHostConn = window.__mkConn(id)) };
      _migrationExcluded = new Set(['dead-host']);
      setAuthoritativeSuccessorIds(['a-deputy', 'z-me']);
      _migrationCandidateId = 'a-deputy';
      _attemptHostConnection('a-deputy', 0);
      window.__lastHostConn.emit('close');
      return { isHost, roomCode, candidate: _migrationCandidateId, roomState };
    });
    // The dead deputy is excluded, the election runs again and we are next in
    // line — becoming host clears the exclusion set on the way through.
    expect(seen).toEqual({ isHost: true, roomCode: 'z-me', candidate: null, roomState: 'connected' });
  });

  test('a broker with no channel to give retries rather than re-electing straight away', async ({ page }) => {
    const seen = await page.evaluate(() => {
      inRoom = true;
      isHost = false;
      roomCode = 'dead-host';
      roomState = ROOM_STATE_MIGRATING;
      peer = {
        id: 'me',
        destroyed: false,
        disconnected: true,
        reconnectCalls: 0,
        reconnect() { this.reconnectCalls++; },
        connect: () => undefined,
      };
      _migrationCandidateId = 'deputy';
      _migrationExcluded = new Set();
      _attemptHostConnection('deputy', 2);
      return { reconnects: peer.reconnectCalls, excluded: _migrationExcluded.size };
    });
    expect(seen).toEqual({ reconnects: 1, excluded: 0 });
  });
});

test.describe('attemptRejoin', () => {
  test('refuses when there is no snapshot to work from', async ({ page }) => {
    const message = await page.evaluate(async () => {
      clearRejoinSnapshot();
      try { await attemptRejoin(); return null; } catch (e) { return e.message; }
    });
    expect(message).toBe('No room to rejoin.');
  });

  test('refuses a snapshot whose candidates are all gone', async ({ page }) => {
    const message = await page.evaluate(async () => {
      // We were the host, so our own (now dead) id is skipped and nothing else
      // was recorded — there is no candidate left to dial.
      localStorage.setItem('rejoin-snapshot', JSON.stringify({
        hostId: 'our-old-id', deputyId: null, peerIds: [], wasHost: true, savedAt: Date.now(),
      }));
      try { await attemptRejoin(); return null; } catch (e) { return e.message; }
    });
    expect(message).toBe('No peers from the previous room are available.');
  });

  test('rejoins through the first candidate that answers', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      const host = '11111111-2222-3333-4444-555555555555';
      localStorage.setItem('rejoin-snapshot', JSON.stringify({
        hostId: host, deputyId: null, peerIds: [], wasHost: false, savedAt: Date.now(),
      }));
      const p = attemptRejoin();
      (await window.__waitPeer()).emit('open');
      const conn = await window.__waitHostConn();
      conn.emit('open');
      conn.emit('data', { type: 'peer-list', peers: [], hostId: host });
      await p;
      return { inRoom, roomCode };
    });
    expect(seen.inRoom).toBe(true);
    expect(seen.roomCode).toBe('11111111-2222-3333-4444-555555555555');
  });

  test('a fatal error stops the walk instead of trying the next candidate', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      const a = '11111111-2222-3333-4444-555555555555';
      const b = '22222222-2222-3333-4444-555555555555';
      localStorage.setItem('rejoin-snapshot', JSON.stringify({
        hostId: a, deputyId: b, peerIds: [], wasHost: false, savedAt: Date.now(),
      }));
      const p = attemptRejoin();
      await window.__waitPeer();
      const err = new Error('broker is down');
      err.type = 'server-error';
      window.__lastPeer.emit('error', err);
      let message = null;
      try { await p; } catch (e) { message = e.message; }
      return { message, peersBuilt: window.__peers.length };
    });
    expect(seen.message).toBe('Could not reach the signalling server. Try again in a moment.');
    expect(seen.peersBuilt).toBe(1);
  });
});

test.describe('leaveRoom', () => {
  test('tears the whole session down and returns home', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      const p = createRoom();
      (await window.__waitPeer()).emit('open', 'room-abc');
      await p;
      const created = window.__lastPeer;
      leaveRoom();
      return {
        inRoom,
        isHost,
        roomCode,
        roomState,
        peer,
        destroyed: created.destroyed,
        stored: localStorage.getItem('active-room-code'),
        screen: document.querySelector('.screen.active') && document.querySelector('.screen.active').id,
      };
    });
    expect(seen.inRoom).toBe(false);
    expect(seen.isHost).toBe(false);
    expect(seen.roomCode).toBe('');
    expect(seen.roomState).toBe('idle');
    expect(seen.peer).toBe(null);
    expect(seen.destroyed).toBe(true);
    expect(seen.stored).toBe(null);
    expect(seen.screen).toBe('screen-home');
  });

  test('every peer, audio element and heartbeat timer goes with it', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      const p = createRoom();
      (await window.__waitPeer()).emit('open', 'room-abc');
      await p;
      const c = window.__mkConn('p1');
      handleJoinerDataConnection(c);
      c.emit('open');
      attachAudio('p1', new MediaStream());
      leaveRoom();
      return {
        connections: connections.size,
        known: knownPeerIds.size,
        audioEls: document.querySelectorAll('audio[id^="audio-"]').length,
        timers: [_hostHeartbeatInterval, _peerHeartbeatInterval, _peerHeartbeatSweepInterval,
                 _hostHeartbeatMonitorInterval],
      };
    });
    expect(seen.connections).toBe(0);
    expect(seen.known).toBe(0);
    expect(seen.audioEls).toBe(0);
    expect(seen.timers).toEqual([null, null, null, null]);
  });

  test('leaving writes a snapshot the rejoin button can use', async ({ page }) => {
    const snapshot = await page.evaluate(async () => {
      const p = createRoom();
      (await window.__waitPeer()).emit('open', 'room-abc');
      await p;
      leaveRoom();
      return loadRejoinSnapshot();
    });
    expect(snapshot).toMatchObject({ hostId: 'room-abc', wasHost: true });
  });
});
