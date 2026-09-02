import { test, expect } from './fixtures.js';
import { seedRoom } from './_helpers.js';

// becomeHost() — what the winner of a host election actually does.
//
// The room code IS the host's peer id, so promotion renames the room. Everyone
// still in it learns the new code from the authoritative peer-list this
// broadcasts; an embedding page learns it from the host-changed event. And if
// the room was listed as a public lobby, the listing has to be repointed at the
// new host or the code people are sharing dials a peer that has gone.
//
// There are two ways a lobby can be ours to repoint, and they use different
// calls: the original host holds the publish secret and re-POSTs; a peer that
// claimed an abandoned listing has no secret and PATCHes itself in.

/** A room with two other peers still connected, and a destroyable peer. */
async function seedPromotion(page) {
  await seedRoom(page, {
    selfId: 'me',
    isHost: false,
    roomCode: 'old-host',
    myPseudo: 'Me',
    knownPeerIds: ['me', 'peer-a', 'peer-b'],
    connections: [
      { id: 'peer-a', pseudo: 'A' },
      { id: 'peer-b', pseudo: 'B' },
    ],
  });
  await page.evaluate(() => {
    peer = { id: 'me', destroyed: false, destroy() { this.destroyed = true; }, call: () => null };
    // Recording data connections, so the broadcast can be read back.
    connections.forEach((conn, id) => {
      const sent = [];
      conn.data = { peer: id, open: true, closed: false, sent, send: (m) => sent.push(m), close() {} };
    });
    _publishedRoomId = null;
    _publishSecret = null;
    window.__api = [];
  });
}

/** Record every anonymous-rooms call and answer it. */
async function stubRoomsApi(page, body = {}, status = 200) {
  await page.route('**/anonymous-rooms**', async (route) => {
    const req = route.request();
    await page.evaluate((call) => window.__api.push(call), {
      method: req.method(),
      url: req.url(),
      body: req.postData(),
    });
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

const apiCalls = (page) => page.evaluate(() => window.__api);
const messagesTo = (page, id) => page.evaluate((i) => connections.get(i).data.sent, id);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await seedPromotion(page);
});

test('the room is renamed to the new host\'s own peer id', async ({ page }) => {
  const after = await page.evaluate(() => {
    window.becomeHost();
    return {
      isHost,
      roomCode,
      connecting: connectingToHostId,
      stored: localStorage.getItem('active-room-code'),
    };
  });

  expect(after.isHost).toBe(true);
  expect(after.roomCode).toBe('me');
  // Any in-flight connection attempt to the old host is abandoned.
  expect(after.connecting).toBe(null);
  expect(after.stored).toBe('me');
});

test('every remaining peer is told, authoritatively', async ({ page }) => {
  await page.evaluate(() => window.becomeHost());

  for (const id of ['peer-a', 'peer-b']) {
    const lists = (await messagesTo(page, id)).filter((m) => m.type === 'peer-list');
    expect(lists.length).toBeGreaterThan(0);

    const latest = lists.at(-1);
    // The peer-list is what carries the new host id AND the deputy chain. A
    // peer-joined carries no successorIds, so peers told that way would keep
    // electing against stale state — split-brain if this host dies too.
    expect(latest.hostId).toBe('me');
    expect(Array.isArray(latest.successorIds)).toBe(true);
    expect(latest.deputyId).toBe(latest.successorIds[0] ?? null);
    // The recipient is not listed to itself, but the other peer is.
    const listed = latest.peers.map((p) => p.id ?? p);
    expect(listed).not.toContain(id);
    expect(listed).toContain(id === 'peer-a' ? 'peer-b' : 'peer-a');
  }
});

test('an embedding page is told the room changed hands, and that it is us', async ({ page }) => {
  const emitted = await page.evaluate(() => {
    const seen = [];
    window.iframeEmit = (msg) => seen.push(msg);
    window.becomeHost();
    return seen;
  });

  expect(emitted).toContainEqual(expect.objectContaining({
    type: 'host-changed', roomCode: 'me', isSelf: true,
  }));
});

test.describe('repointing a published lobby', () => {
  test('an unpublished room never touches the API', async ({ page }) => {
    await stubRoomsApi(page);
    await page.evaluate(() => window.becomeHost());
    await page.waitForTimeout(100);

    expect(await apiCalls(page)).toEqual([]);
  });

  test('the original host re-publishes with its secret', async ({ page }) => {
    await stubRoomsApi(page, { room_code: 'happy-otter' });
    await page.evaluate(() => {
      _publishedRoomId = 'happy-otter';
      _publishSecret = 'the-secret';
      window.becomeHost();
    });
    await page.waitForFunction(() => window.__api.length > 0);

    const calls = await apiCalls(page);
    expect(calls[0].method).toBe('POST');
    // The new host's peer id is what the listing has to point at now.
    expect(calls[0].body).toContain('me');
  });

  test('a peer that claimed the listing PATCHes itself in as the host', async ({ page }) => {
    await stubRoomsApi(page, { room_code: 'happy-otter' });
    await page.evaluate(() => {
      _publishedRoomId = 'happy-otter';
      _publishSecret = null;         // claimed, not created — no secret to POST with
      window.becomeHost();
    });
    await page.waitForFunction(() => window.__api.length > 0);

    const calls = await apiCalls(page);
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url).toContain('/by-code/happy-otter');
    expect(JSON.parse(calls[0].body)).toEqual({ voxal_room_code: 'me' });
  });

  test('a listing that comes back under a different code is adopted', async ({ page }) => {
    await stubRoomsApi(page, { room_code: 'renamed-otter' });
    await page.evaluate(() => {
      _publishedRoomId = 'happy-otter';
      _publishSecret = null;
      window.becomeHost();
    });
    await page.waitForFunction(() => window._publishedRoomId === 'renamed-otter');

    expect(await page.evaluate(() => window._publishedRoomId)).toBe('renamed-otter');
  });

  test('a lobby update that fails does not take the promotion down with it', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/anonymous-rooms**', (route) => route.abort('connectionrefused'));

    const after = await page.evaluate(() => {
      _publishedRoomId = 'happy-otter';
      _publishSecret = null;
      window.becomeHost();
      return { isHost, roomCode };
    });
    await page.waitForTimeout(200);

    // Promotion is local and already done; the listing is best-effort.
    expect(after).toEqual({ isHost: true, roomCode: 'me' });
    expect(errors).toEqual([]);
  });

  test('a 404 from the API leaves the published id alone rather than clearing it', async ({ page }) => {
    await stubRoomsApi(page, { error: 'not found' }, 404);
    await page.evaluate(() => {
      _publishedRoomId = 'happy-otter';
      _publishSecret = null;
      window.becomeHost();
    });
    await page.waitForFunction(() => window.__api.length > 0);
    await page.waitForTimeout(100);

    expect(await page.evaluate(() => window._publishedRoomId)).toBe('happy-otter');
  });
});
