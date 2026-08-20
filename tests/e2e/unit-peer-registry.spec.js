import { test, expect } from './fixtures.js';
import { seedRoom, callFn } from './_helpers.js';

// The membership bookkeeping every other subsystem reads: which peers we know
// about, which data channels are actually usable, and the heartbeat sweep that
// evicts a peer whose connection object is still there but whose device is gone.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test.describe('knownPeerIds bookkeeping', () => {
  test('rememberPeer adds, forgetPeer removes', async ({ page }) => {
    const ids = await page.evaluate(() => {
      peer = { id: 'self' };
      knownPeerIds.clear();
      rememberPeer('a');
      rememberPeer('b');
      forgetPeer('a');
      return Array.from(knownPeerIds);
    });
    expect(ids).toEqual(['b']);
  });

  test('never remembers our own id, or a blank one', async ({ page }) => {
    const ids = await page.evaluate(() => {
      peer = { id: 'self' };
      knownPeerIds.clear();
      rememberPeer('self');
      rememberPeer('');
      rememberPeer(null);
      rememberPeer('other');
      return Array.from(knownPeerIds);
    });
    expect(ids).toEqual(['other']);
  });

  test('forgetPeer on an unknown id is a no-op', async ({ page }) => {
    const ids = await page.evaluate(() => {
      peer = { id: 'self' };
      knownPeerIds.clear();
      rememberPeer('a');
      forgetPeer('nobody');
      forgetPeer(null);
      return Array.from(knownPeerIds);
    });
    expect(ids).toEqual(['a']);
  });

  test('resetKnownPeers replaces the whole roster', async ({ page }) => {
    const ids = await page.evaluate(() => {
      peer = { id: 'self' };
      knownPeerIds.clear();
      rememberPeer('stale');
      resetKnownPeers(['a', 'b', 'self']);
      return Array.from(knownPeerIds).sort();
    });
    expect(ids).toEqual(['a', 'b']);
  });

  test('as host, remembering a peer re-reconciles the successor chain', async ({ page }) => {
    const chain = await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      connections: [{ id: 'p1' }, { id: 'p2' }],
    }).then(() => page.evaluate(() => {
      resetKnownPeers(['p1', 'p2']);
      return _authoritativeSuccessorIds.slice();
    }));
    expect(chain).toEqual(['p1', 'p2']);
  });
});

test.describe('data-channel liveness', () => {
  test('hasOpenDataConnection is true only for an open, unclosed channel', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      connections: [{ id: 'open' }, { id: 'closed', open: false }],
    });
    expect(await callFn(page, 'hasOpenDataConnection', 'open')).toBe(true);
    expect(await callFn(page, 'hasOpenDataConnection', 'closed')).toBe(false);
    expect(await callFn(page, 'hasOpenDataConnection', 'absent')).toBe(false);
  });

  test('sendDataIfOpen delivers on an open channel and refuses a dead one', async ({ page }) => {
    const result = await page.evaluate(() => {
      const sent = [];
      const open = { open: true, closed: false, send: (m) => sent.push(m) };
      const shut = { open: false, closed: true, send: (m) => sent.push(m) };
      return {
        toOpen: sendDataIfOpen(open, { type: 'x' }),
        toShut: sendDataIfOpen(shut, { type: 'y' }),
        toNothing: sendDataIfOpen(null, { type: 'z' }),
        sent,
      };
    });
    expect(result.toOpen).toBe(true);
    expect(result.toShut).toBe(false);
    expect(result.toNothing).toBe(false);
    expect(result.sent).toEqual([{ type: 'x' }]);
  });

  test('hostConnectedPeerIds lists only live channels, sorted', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      connections: [{ id: 'z' }, { id: 'a' }, { id: 'm', open: false }],
    });
    expect(await callFn(page, 'hostConnectedPeerIds')).toEqual(['a', 'z']);
  });

  test('isCurrentPeerDataConnection rejects a stale channel and anything after leaving', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const live = { open: true, closed: false, send() {}, close() {} };
      const stale = { open: true, closed: false, send() {}, close() {} };
      inRoom = true;
      connections.clear();
      connections.set('p1', { data: live });
      const current = isCurrentPeerDataConnection('p1', live);
      const old = isCurrentPeerDataConnection('p1', stale);
      const unknown = isCurrentPeerDataConnection('nobody', live);
      inRoom = false;
      const afterLeave = isCurrentPeerDataConnection('p1', live);
      return { current, old, unknown, afterLeave };
    });
    expect(seen).toEqual({ current: true, old: false, unknown: false, afterLeave: false });
  });
});

test.describe('pruneHostGhostPeers', () => {
  test('drops every peer whose data channel is gone, keeps the live ones', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      knownPeerIds: ['live', 'ghost'],
      connections: [{ id: 'live' }, { id: 'ghost', open: false }],
    });
    const after = await page.evaluate(() => {
      pruneHostGhostPeers('test');
      return { conns: Array.from(connections.keys()), known: Array.from(knownPeerIds) };
    });
    expect(after.conns).toEqual(['live']);
    expect(after.known).toEqual(['live']);
  });

  test('does nothing when we are not the host', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'p2',
      isHost: false,
      knownPeerIds: ['ghost'],
      connections: [{ id: 'ghost', open: false }],
    });
    const conns = await page.evaluate(() => {
      pruneHostGhostPeers('test');
      return Array.from(connections.keys());
    });
    expect(conns).toEqual(['ghost']);
  });
});

test.describe('shouldAcceptJoinerDataConnection', () => {
  test('a host accepts anyone', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true });
    expect(await callFn(page, 'shouldAcceptJoinerDataConnection', 'joiner')).toBe(true);
  });

  test('a peer outside a room accepts nobody', async ({ page }) => {
    const accepted = await page.evaluate(() => {
      inRoom = false;
      isHost = false;
      return shouldAcceptJoinerDataConnection('joiner');
    });
    expect(accepted).toBe(false);
  });

  test('a peer with a live host connection refuses — the host owns signalling', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'p2',
      isHost: false,
      roomCode: 'host',
      connections: [{ id: 'host' }],
    });
    expect(await callFn(page, 'shouldAcceptJoinerDataConnection', 'p3')).toBe(false);
  });

  test('mid-connect to a host, it refuses rather than racing', async ({ page }) => {
    await seedRoom(page, { selfId: 'p2', isHost: false, roomCode: 'host' });
    const accepted = await page.evaluate(() => {
      connections.delete('host');
      connectingToHostId = 'host';
      const v = shouldAcceptJoinerDataConnection('p3');
      connectingToHostId = null;
      return v;
    });
    expect(accepted).toBe(false);
  });

  test('the elected successor accepts a stranded joiner once the host is gone', async ({ page }) => {
    // Host 'host' died; we are the first successor, so joiners belong to us.
    await seedRoom(page, {
      selfId: 'a-peer',
      isHost: false,
      roomCode: 'host',
      knownPeerIds: ['z-peer'],
      successorIds: ['a-peer', 'z-peer'],
    });
    expect(await callFn(page, 'shouldAcceptJoinerDataConnection', 'joiner')).toBe(true);
    // ...but never a connection claiming to be the dead host itself.
    expect(await callFn(page, 'shouldAcceptJoinerDataConnection', 'host')).toBe(false);
  });

  test('a peer that is not the successor leaves the joiner to whoever is', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'z-peer',
      isHost: false,
      roomCode: 'host',
      knownPeerIds: ['a-peer'],
      successorIds: ['a-peer', 'z-peer'],
    });
    expect(await callFn(page, 'shouldAcceptJoinerDataConnection', 'joiner')).toBe(false);
  });
});

test.describe('peer removal', () => {
  test('removePeer closes both channels and drops the entry', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const closed = [];
      inRoom = true;
      connections.clear();
      connections.set('p1', {
        data: { open: true, closed: false, close: () => closed.push('data') },
        media: { close: () => closed.push('media') },
        audioMediaOut: { close: () => closed.push('audioOut') },
      });
      removePeer('p1');
      removePeer('never-existed'); // no-op, must not throw
      return { closed, has: connections.has('p1') };
    });
    expect(seen.closed.sort()).toEqual(['audioOut', 'data', 'media']);
    expect(seen.has).toBe(false);
  });

  test('clearPeerMedia keeps a peer that still has a data channel', async ({ page }) => {
    const seen = await page.evaluate(() => {
      inRoom = true;
      peer = { id: 'self' };
      knownPeerIds.clear();
      connections.clear();
      connections.set('p1', {
        data: { open: true, closed: false, close() {} },
        media: { close() {} },
        talking: true,
      });
      clearPeerMedia('p1');
      const c = connections.get('p1');
      return { kept: !!c, media: c && c.media, talking: c && c.talking };
    });
    expect(seen).toEqual({ kept: true, media: null, talking: false });
  });

  test('clearPeerMedia keeps a data-less peer that is still on the roster', async ({ page }) => {
    const kept = await page.evaluate(() => {
      inRoom = true;
      peer = { id: 'self' };
      knownPeerIds.clear();
      knownPeerIds.add('p1');
      connections.clear();
      connections.set('p1', { data: null, media: { close() {} } });
      clearPeerMedia('p1');
      return connections.has('p1');
    });
    expect(kept).toBe(true);
  });

  test('clearPeerMedia drops a peer with neither a channel nor a roster entry', async ({ page }) => {
    const kept = await page.evaluate(() => {
      inRoom = true;
      peer = { id: 'self' };
      knownPeerIds.clear();
      connections.clear();
      connections.set('p1', { data: null, media: { close() {} } });
      clearPeerMedia('p1');
      return connections.has('p1');
    });
    expect(kept).toBe(false);
  });

  test('shouldRetainPeerWithoutMedia follows the roster', async ({ page }) => {
    await seedRoom(page, { selfId: 'self', knownPeerIds: ['p1'] });
    expect(await callFn(page, 'shouldRetainPeerWithoutMedia', 'p1')).toBe(true);
    expect(await callFn(page, 'shouldRetainPeerWithoutMedia', 'p2')).toBe(false);
  });
});

test.describe('heartbeats', () => {
  test('noteHostHeartbeat stamps the arrival time', async ({ page }) => {
    const seen = await page.evaluate(() => {
      noteHostHeartbeat(1234);
      const explicit = _lastHostHeartbeatAt;
      noteHostHeartbeat();
      return { explicit, defaulted: _lastHostHeartbeatAt > 0 };
    });
    expect(seen).toEqual({ explicit: 1234, defaulted: true });
  });

  test('notePeerHeartbeat stamps a known peer and ignores an unknown one', async ({ page }) => {
    const seen = await page.evaluate(() => {
      connections.clear();
      connections.set('p1', { data: { open: true, closed: false, send() {} } });
      notePeerHeartbeat('p1', 999);
      notePeerHeartbeat('nobody', 999); // must not create an entry
      return { at: connections.get('p1').lastHeartbeatAt, size: connections.size };
    });
    expect(seen).toEqual({ at: 999, size: 1 });
  });

  test('the host broadcasts its successor chain with every beat', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      connections: [{ id: 'a' }, { id: 'b' }],
    });
    const msgs = await page.evaluate(() => {
      const seen = [];
      connections.forEach((c) => { c.data.send = (m) => seen.push(m); });
      broadcastHostHeartbeat();
      return seen;
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].type).toBe('heartbeat');
    expect(msgs[0].deputyId).toBe('a');
    expect(msgs[0].successorIds).toEqual(['a', 'b']);
  });

  test('a non-host never broadcasts a host heartbeat', async ({ page }) => {
    await seedRoom(page, { selfId: 'p2', isHost: false, roomCode: 'host', connections: [{ id: 'host' }] });
    const count = await page.evaluate(() => {
      let n = 0;
      connections.get('host').data.send = () => { n++; };
      broadcastHostHeartbeat();
      return n;
    });
    expect(count).toBe(0);
  });

  test('a peer beats only to the host', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'p2',
      isHost: false,
      roomCode: 'host',
      connections: [{ id: 'host' }, { id: 'p3' }],
    });
    const seen = await page.evaluate(() => {
      const to = [];
      connections.forEach((c, id) => { c.data.send = () => to.push(id); });
      sendPeerHeartbeat();
      return to;
    });
    expect(seen).toEqual(['host']);
  });

  test('the host start/stop helpers own exactly one interval', async ({ page }) => {
    const seen = await page.evaluate(() => {
      inRoom = true;
      isHost = true;
      peer = { id: 'host' };
      connections.clear();
      startHostHeartbeat();
      const first = _hostHeartbeatInterval;
      startHostHeartbeat(); // restarting must not leak the previous timer
      const second = _hostHeartbeatInterval;
      stopHostHeartbeat();
      return { started: !!first, replaced: first !== second, stopped: _hostHeartbeatInterval };
    });
    expect(seen).toEqual({ started: true, replaced: true, stopped: null });
  });

  test('the peer heartbeat, monitor and sweep timers all stop cleanly', async ({ page }) => {
    const seen = await page.evaluate(() => {
      inRoom = true;
      isHost = false;
      peer = { id: 'p2' };
      roomCode = 'host';
      connections.clear();
      startPeerHeartbeat();
      startHostHeartbeatMonitor();
      startPeerHeartbeatSweep();
      const running = [_peerHeartbeatInterval, _hostHeartbeatMonitorInterval, _peerHeartbeatSweepInterval]
        .every(Boolean);
      stopPeerHeartbeat();
      stopHostHeartbeatMonitor();
      stopPeerHeartbeatSweep();
      return {
        running,
        cleared: [_peerHeartbeatInterval, _hostHeartbeatMonitorInterval, _peerHeartbeatSweepInterval],
      };
    });
    expect(seen.running).toBe(true);
    expect(seen.cleared).toEqual([null, null, null]);
  });
});

test.describe('the stale-peer sweep', () => {
  test('evicts a peer past the timeout and tells everyone else', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      knownPeerIds: ['stale', 'fresh'],
      connections: [{ id: 'stale' }, { id: 'fresh' }],
    });
    const seen = await page.evaluate(() => {
      const announced = [];
      connections.get('fresh').data.send = (m) => announced.push(m);
      notePeerHeartbeat('fresh', Date.now());
      notePeerHeartbeat('stale', Date.now() - (HOST_HEARTBEAT_TIMEOUT_MS + 5000));
      checkPeerHeartbeats();
      return {
        left: Array.from(connections.keys()),
        known: Array.from(knownPeerIds),
        announced: announced.filter((m) => m.type === 'peer-left'),
      };
    });
    expect(seen.left).toEqual(['fresh']);
    expect(seen.known).toEqual(['fresh']);
    expect(seen.announced).toContainEqual({ type: 'peer-left', peerId: 'stale' });
  });

  test('a peer that has never beaten yet is given the benefit of the doubt', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      knownPeerIds: ['justJoined'],
      connections: [{ id: 'justJoined' }],
    });
    const left = await page.evaluate(() => {
      checkPeerHeartbeats(); // lastHeartbeatAt is unset
      return Array.from(connections.keys());
    });
    expect(left).toEqual(['justJoined']);
  });

  test('a non-host never sweeps', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'p2',
      isHost: false,
      roomCode: 'host',
      connections: [{ id: 'host' }],
    });
    const left = await page.evaluate(() => {
      notePeerHeartbeat('host', Date.now() - (HOST_HEARTBEAT_TIMEOUT_MS + 5000));
      checkPeerHeartbeats();
      return Array.from(connections.keys());
    });
    expect(left).toEqual(['host']);
  });

  test('removeStalePeer on an unknown id does nothing', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true, connections: [{ id: 'a' }] });
    const left = await page.evaluate(() => {
      removeStalePeer('nobody', 'test');
      return Array.from(connections.keys());
    });
    expect(left).toEqual(['a']);
  });
});

test.describe('checkHostHeartbeat', () => {
  test('starts a migration once the host goes quiet past the timeout', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'a-peer',
      isHost: false,
      roomCode: 'dead-host',
      knownPeerIds: ['z-peer'],
      successorIds: ['a-peer', 'z-peer'],
    });
    const state = await page.evaluate(() => {
      roomState = ROOM_STATE_CONNECTED;
      connectingToHostId = null;
      _lastHostHeartbeatAt = Date.now() - (HOST_HEARTBEAT_TIMEOUT_MS + 5000);
      checkHostHeartbeat();
      return { roomState, isHost, roomCode };
    });
    // We were the first successor, so we promoted ourselves.
    expect(state.roomState).toBe('connected');
    expect(state.isHost).toBe(true);
    expect(state.roomCode).toBe('a-peer');
  });

  test('a fresh beat, or a migration already under way, leaves it alone', async ({ page }) => {
    await seedRoom(page, { selfId: 'a-peer', isHost: false, roomCode: 'host', successorIds: ['a-peer'] });
    const seen = await page.evaluate(() => {
      roomState = ROOM_STATE_CONNECTED;
      connectingToHostId = null;
      _lastHostHeartbeatAt = Date.now();
      checkHostHeartbeat();
      const afterFresh = roomState;

      _lastHostHeartbeatAt = Date.now() - (HOST_HEARTBEAT_TIMEOUT_MS + 5000);
      roomState = ROOM_STATE_MIGRATING;
      checkHostHeartbeat();
      const afterMigrating = roomState;

      roomState = ROOM_STATE_CONNECTED;
      connectingToHostId = 'someone';
      checkHostHeartbeat();
      const afterConnecting = { roomState, isHost };
      connectingToHostId = null;
      return { afterFresh, afterMigrating, afterConnecting };
    });
    expect(seen.afterFresh).toBe('connected');
    expect(seen.afterMigrating).toBe('migrating');
    expect(seen.afterConnecting).toEqual({ roomState: 'connected', isHost: false });
  });
});
