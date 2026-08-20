import { test, expect } from './fixtures.js';
import { seedRoom, callFn } from './_helpers.js';

// Publishing a room to the public lobby, and the presence (org channels) API
// around it. Everything here talks HTTP, so each test installs its own `fetch`
// double and asserts on the request that was actually made.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    window.__requests = [];
    window.__reply = { ok: true, status: 200, body: {} };
    window.fetch = function(url, opts) {
      window.__requests.push({ url: String(url), opts: opts || {} });
      const r = window.__reply;
      return Promise.resolve({
        ok: r.ok,
        status: r.status,
        json: () => Promise.resolve(r.body),
      });
    };
  });
});

test.describe('publishRoom', () => {
  test('posts the room and keeps the secret it gets back', async ({ page }) => {
    await seedRoom(page, { selfId: 'host-id', isHost: true, roomCode: 'host-id', connections: [{ id: 'p1' }] });
    const seen = await page.evaluate(async () => {
      window.__reply = { ok: true, status: 200, body: { secret: 'sh', room_code: 'happy-otter', share_url: 'https://x/y' } };
      _lastPublishAt = 0;
      await publishRoom();
      const req = window.__requests[0];
      const out = {
        body: JSON.parse(req.opts.body),
        secret: _publishSecret,
        roomId: _publishedRoomId,
        shareUrl: _publishedShareUrl,
        heartbeat: !!_publishHeartbeatId,
      };
      unpublishRoom();
      return out;
    });
    expect(seen.body).toEqual({ room_id: 'host-id', peer_count: 2 });
    expect(seen.secret).toBe('sh');
    expect(seen.roomId).toBe('happy-otter');
    expect(seen.shareUrl).toBe('https://x/y');
    expect(seen.heartbeat).toBe(true);
  });

  test('a requested room code rides along with the post', async ({ page }) => {
    await seedRoom(page, { selfId: 'host-id', isHost: true, roomCode: 'host-id' });
    const body = await page.evaluate(async () => {
      window.__reply = { ok: true, status: 200, body: { secret: 's', room_code: 'wanted' } };
      _lastPublishAt = 0;
      await publishRoom({ room_code: 'wanted' });
      const out = JSON.parse(window.__requests[0].opts.body);
      unpublishRoom();
      return out;
    });
    expect(body.room_code).toBe('wanted');
  });

  test('an existing secret is sent as the room credential', async ({ page }) => {
    await seedRoom(page, { selfId: 'host-id', isHost: true, roomCode: 'host-id' });
    const header = await page.evaluate(async () => {
      window.__reply = { ok: true, status: 200, body: { secret: 's2', room_code: 'r' } };
      _publishSecret = 'existing';
      _lastPublishAt = 0;
      await publishRoom();
      const out = window.__requests[0].opts.headers['x-room-secret'];
      unpublishRoom();
      return out;
    });
    expect(header).toBe('existing');
  });

  test('a rejection surfaces the API error text', async ({ page }) => {
    await seedRoom(page, { selfId: 'host-id', isHost: true, roomCode: 'host-id' });
    const message = await page.evaluate(async () => {
      window.__reply = { ok: false, status: 409, body: { error: 'that name is taken' } };
      _lastPublishAt = 0;
      try { await publishRoom(); return null; } catch (e) { return e.message; }
    });
    expect(message).toBe('that name is taken');
  });

  test('a rejection with no body falls back to the status code', async ({ page }) => {
    await seedRoom(page, { selfId: 'host-id', isHost: true, roomCode: 'host-id' });
    const message = await page.evaluate(async () => {
      window.__reply = { ok: false, status: 500, body: null };
      _lastPublishAt = 0;
      try { await publishRoom(); return null; } catch (e) { return e.message; }
    });
    expect(message).toBe('HTTP 500');
  });

  test('a non-host never publishes', async ({ page }) => {
    await seedRoom(page, { selfId: 'p2', isHost: false, roomCode: 'host' });
    const count = await page.evaluate(async () => {
      _lastPublishAt = 0;
      await publishRoom();
      return window.__requests.length;
    });
    expect(count).toBe(0);
  });

  test('a second publish inside the cooldown is deferred, not sent', async ({ page }) => {
    await seedRoom(page, { selfId: 'host-id', isHost: true, roomCode: 'host-id' });
    const seen = await page.evaluate(async () => {
      window.__reply = { ok: true, status: 200, body: { secret: 's', room_code: 'r' } };
      _lastPublishAt = 0;
      await publishRoom();
      const afterFirst = window.__requests.length;
      await publishRoom();
      const out = { afterFirst, afterSecond: window.__requests.length, deferred: !!_publishDebounceId };
      unpublishRoom();
      return out;
    });
    expect(seen).toEqual({ afterFirst: 1, afterSecond: 1, deferred: true });
  });
});

test.describe('unpublishRoom', () => {
  test('deletes the lobby entry and clears local state', async ({ page }) => {
    await seedRoom(page, { selfId: 'host-id', isHost: true, roomCode: 'host-id' });
    const seen = await page.evaluate(() => {
      _publishSecret = 'sec';
      _publishedRoomId = 'happy-otter';
      _publishedShareUrl = 'https://x';
      window.__requests.length = 0;
      unpublishRoom();
      const req = window.__requests[0];
      return {
        method: req.opts.method,
        url: req.url,
        secretHeader: req.opts.headers['x-room-secret'],
        secret: _publishSecret,
        roomId: _publishedRoomId,
        shareUrl: _publishedShareUrl,
      };
    });
    expect(seen.method).toBe('DELETE');
    expect(seen.url).toContain('host-id');
    expect(seen.secretHeader).toBe('sec');
    expect(seen.secret).toBe(null);
    expect(seen.roomId).toBe(null);
    expect(seen.shareUrl).toBe(null);
  });

  test('with nothing published it makes no request', async ({ page }) => {
    await seedRoom(page, { selfId: 'host-id', isHost: true, roomCode: 'host-id' });
    const count = await page.evaluate(() => {
      _publishSecret = null;
      window.__requests.length = 0;
      unpublishRoom();
      return window.__requests.length;
    });
    expect(count).toBe(0);
  });

  test('clearPublishState forgets the lobby without deleting it', async ({ page }) => {
    await seedRoom(page, { selfId: 'host-id', isHost: true, roomCode: 'host-id' });
    const seen = await page.evaluate(() => {
      _publishSecret = 'sec';
      _publishedRoomId = 'happy-otter';
      window.__requests.length = 0;
      clearPublishState();
      return { requests: window.__requests.length, secret: _publishSecret, roomId: _publishedRoomId };
    });
    expect(seen).toEqual({ requests: 0, secret: null, roomId: null });
  });
});

test.describe('broadcastRoomPublished', () => {
  test('gives the secret to the deputy alone', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      connections: [{ id: 'a-deputy' }, { id: 'z-other' }],
    });
    const seen = await page.evaluate(() => {
      _publishedRoomId = 'lobby';
      _publishSecret = 'sec';
      const got = {};
      connections.forEach((c, id) => { c.data.send = (m) => { got[id] = m; }; });
      broadcastRoomPublished();
      _publishedRoomId = null;
      _publishSecret = null;
      return got;
    });
    expect(seen['a-deputy']).toEqual({ type: 'room-published', roomId: 'lobby', secret: 'sec' });
    expect(seen['z-other']).toEqual({ type: 'room-published', roomId: 'lobby', secret: null });
  });

  test('a non-host broadcasts nothing', async ({ page }) => {
    await seedRoom(page, { selfId: 'p2', isHost: false, roomCode: 'host', connections: [{ id: 'host' }] });
    const count = await page.evaluate(() => {
      let n = 0;
      connections.get('host').data.send = () => { n++; };
      broadcastRoomPublished();
      return n;
    });
    expect(count).toBe(0);
  });
});

test.describe('lobby lookup', () => {
  test('resolves a named code to the host peer id', async ({ page }) => {
    const resolved = await page.evaluate(async () => {
      window.__reply = { ok: true, status: 200, body: { room_id: 'peer-abc' } };
      return lookupRoom('happy-otter');
    });
    expect(resolved).toBe('peer-abc');
  });

  test('a UUID is already a peer id and is never looked up', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      const out = await lookupRoom('11111111-2222-3333-4444-555555555555');
      return { out, requests: window.__requests.length };
    });
    expect(seen).toEqual({ out: null, requests: 0 });
  });

  test('a missing lobby resolves to nothing', async ({ page }) => {
    const resolved = await page.evaluate(async () => {
      window.__reply = { ok: false, status: 404, body: null };
      return lookupRoom('gone');
    });
    expect(resolved).toBe(null);
  });

  test('a network failure resolves to nothing rather than throwing', async ({ page }) => {
    const resolved = await page.evaluate(async () => {
      window.fetch = () => Promise.reject(new Error('offline'));
      return lookupRoom('anything');
    });
    expect(resolved).toBe(null);
  });

  test('lookupRoomInfo also reports how many people are in there', async ({ page }) => {
    const info = await page.evaluate(async () => {
      window.__reply = { ok: true, status: 200, body: { room_id: 'peer-abc', peer_count: '3' } };
      return lookupRoomInfo('happy-otter');
    });
    expect(info).toEqual({ roomId: 'peer-abc', peerCount: 3 });
  });

  test('lookupRoomInfo reports a null count when the API omits one', async ({ page }) => {
    const info = await page.evaluate(async () => {
      window.__reply = { ok: true, status: 200, body: { room_id: 'peer-abc' } };
      return lookupRoomInfo('happy-otter');
    });
    expect(info).toEqual({ roomId: 'peer-abc', peerCount: null });
  });

  test('lookupRoomInfo declines a blank or UUID code', async ({ page }) => {
    const seen = await page.evaluate(async () => ({
      blank: await lookupRoomInfo(''),
      uuid: await lookupRoomInfo('11111111-2222-3333-4444-555555555555'),
      requests: window.__requests.length,
    }));
    expect(seen).toEqual({ blank: null, uuid: null, requests: 0 });
  });
});

test.describe('resolving a presence channel to its host', () => {
  test('does nothing without an account', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      localStorage.removeItem('presence-api-token');
      return resolvePresenceChannelHost('general');
    });
    expect(seen).toBe(null);
  });

  test('finds the channel already in hand and names its first peer', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      localStorage.setItem('presence-api-token', 'tok');
      localStorage.setItem('presence-org-id', 'org');
      presenceData = [{
        channel: { name: 'General' },
        connected: [{ peer_id: 'z-peer' }, { peer_id: 'a-peer' }],
      }];
      return resolvePresenceChannelHost('general');
    });
    // Lowest peer id wins, so every client picks the same host.
    expect(seen).toEqual({ channelName: 'General', hostId: 'a-peer' });
  });

  test('reports an empty channel as found-but-hostless', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      localStorage.setItem('presence-api-token', 'tok');
      localStorage.setItem('presence-org-id', 'org');
      presenceData = [{ channel: { name: 'Empty' }, connected: [] }];
      return resolvePresenceChannelHost('empty');
    });
    expect(seen).toEqual({ channelName: 'Empty', hostId: null });
  });

  test('re-fetches when the channel is not in the cached list', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      localStorage.setItem('presence-api-token', 'tok');
      localStorage.setItem('presence-org-id', 'org');
      presenceData = [];
      window.__reply = {
        ok: true,
        status: 200,
        body: { presence: [{ channel: { name: 'Fresh' }, connected: [{ peer_id: 'p9' }] }] },
      };
      return resolvePresenceChannelHost('fresh');
    });
    expect(seen).toEqual({ channelName: 'Fresh', hostId: 'p9' });
  });

  test('a failed re-fetch resolves to nothing', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      localStorage.setItem('presence-api-token', 'tok');
      localStorage.setItem('presence-org-id', 'org');
      presenceData = [];
      window.fetch = () => Promise.reject(new Error('offline'));
      return resolvePresenceChannelHost('anything');
    });
    expect(seen).toBe(null);
  });
});

test.describe('the presence session a host registers', () => {
  test('carries the peer count, the deputy and the public room id', async ({ page }) => {
    await seedRoom(page, {
      selfId: 'host',
      isHost: true,
      connections: [{ id: 'a-deputy' }, { id: 'z-other' }],
    });
    const payload = await page.evaluate(() => {
      activeChannelRoomId = 'happy-otter';
      return buildPresenceSessionPayload('host');
    });
    expect(payload).toEqual({ peer_count: 3, deputy_peer_id: 'a-deputy', room_id: 'happy-otter' });
  });

  test('omits a room id there is nothing public to report', async ({ page }) => {
    await seedRoom(page, { selfId: 'host', isHost: true });
    const payload = await page.evaluate(() => {
      activeChannelRoomId = null;
      _publishedRoomId = null;
      return buildPresenceSessionPayload('host');
    });
    expect(payload).toEqual({ peer_count: 1, deputy_peer_id: null });
  });

  test('postSession retries with the legacy payload when metadata is refused', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      localStorage.setItem('presence-api-token', 'tok');
      localStorage.setItem('presence-org-id', 'org');
      let call = 0;
      window.fetch = function(url, opts) {
        call++;
        window.__requests.push({ url: String(url), opts });
        // The first (rich) post is rejected; the minimal retry is accepted.
        return Promise.resolve({ ok: call > 1, status: call > 1 ? 200 : 400, json: () => Promise.resolve({ ok: true }) });
      };
      await postSession('general', 'peer-1', { peer_count: 2, deputy_peer_id: 'd' });
      return window.__requests.map((r) => JSON.parse(r.opts.body));
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ peer_count: 2, deputy_peer_id: 'd' });
    expect(seen[1]).toEqual({ org_id: 'org', channel_name: 'general', peer_id: 'peer-1' });
  });

  test('postSession gives up when even the legacy payload is refused', async ({ page }) => {
    const message = await page.evaluate(async () => {
      localStorage.setItem('presence-api-token', 'tok');
      localStorage.setItem('presence-org-id', 'org');
      window.__reply = { ok: false, status: 503, body: {} };
      try { await postSession('general', 'peer-1'); return null; } catch (e) { return e.message; }
    });
    expect(message).toBe('HTTP 503');
  });

  test('deleteSession only fires for a configured account', async ({ page }) => {
    const seen = await page.evaluate(() => {
      localStorage.removeItem('presence-api-token');
      deleteSession();
      const withoutAccount = window.__requests.length;
      localStorage.setItem('presence-api-token', 'tok');
      localStorage.setItem('presence-org-id', 'org');
      deleteSession();
      return { withoutAccount, withAccount: window.__requests.length };
    });
    expect(seen).toEqual({ withoutAccount: 0, withAccount: 1 });
  });

  test('fetchPresence and fetchOrgs both refuse a non-OK response', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      localStorage.setItem('presence-api-token', 'tok');
      localStorage.setItem('presence-org-id', 'org');
      window.__reply = { ok: false, status: 401, body: {} };
      const out = {};
      try { await fetchPresence(); } catch (e) { out.presence = e.message; }
      try { await fetchOrgs(); } catch (e) { out.orgs = e.message; }
      return out;
    });
    expect(seen).toEqual({ presence: 'HTTP 401', orgs: 'HTTP 401' });
  });
});

test.describe('the channels list', () => {
  test('renders a row per channel with its members and count', async ({ page }) => {
    const html = await page.evaluate(() => {
      presenceData = [
        { channel: { id: 1, name: 'General' }, peer_count: 2, connected: [{ display_name: 'Ada' }, { display_name: null }] },
        { channel: { id: 2, name: 'Empty' }, peer_count: 0, connected: [] },
      ];
      renderPresenceChannels();
      return document.getElementById('channels-list').innerHTML;
    });
    expect(html).toContain('General');
    expect(html).toContain('Ada, Anonymous');
    expect(html).toContain('>2<');
    expect(html).toContain('Empty');
  });

  test('says so when there is nothing to show', async ({ page }) => {
    const text = await page.evaluate(() => {
      presenceData = [];
      renderPresenceChannels();
      return document.getElementById('channels-list').textContent;
    });
    expect(text).toBe('No channels found.');
  });

  test('a failed refresh shows the error in place of the list', async ({ page }) => {
    const text = await page.evaluate(async () => {
      localStorage.setItem('presence-api-token', 'tok');
      localStorage.setItem('presence-org-id', 'org');
      window.fetch = () => Promise.reject(new Error('presence is down'));
      await refreshPresence();
      return document.getElementById('channels-list').textContent;
    });
    expect(text).toBe('presence is down');
  });

  test('a refresh without an account does nothing at all', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      localStorage.removeItem('presence-api-token');
      document.getElementById('channels-list').textContent = 'untouched';
      await refreshPresence();
      return document.getElementById('channels-list').textContent;
    });
    expect(seen).toBe('untouched');
  });
});

test.describe('room ids reported by the presence API', () => {
  test('roomIdFromPayload accepts every spelling the API uses', async ({ page }) => {
    expect(await callFn(page, 'roomIdFromPayload', { room_id: ' a ' })).toBe('a');
    expect(await callFn(page, 'roomIdFromPayload', { roomId: 'b' })).toBe('b');
    expect(await callFn(page, 'roomIdFromPayload', { room_code: 'c' })).toBe('c');
    expect(await callFn(page, 'roomIdFromPayload', { roomCode: 'd' })).toBe('d');
    expect(await callFn(page, 'roomIdFromPayload', {})).toBe('');
    expect(await callFn(page, 'roomIdFromPayload', null)).toBe('');
  });

  test('a presence item falls back from its channel to its connected peers', async ({ page }) => {
    expect(await callFn(page, 'associatedRoomIdFromPresenceItem',
      { channel: { room_id: 'from-channel' }, connected: [{ room_id: 'from-peer' }] })).toBe('from-channel');
    expect(await callFn(page, 'associatedRoomIdFromPresenceItem',
      { channel: {}, connected: [{}, { room_id: 'from-peer' }] })).toBe('from-peer');
    expect(await callFn(page, 'associatedRoomIdFromPresenceItem', null)).toBe('');
  });

  test('a session response is searched at every level the API nests it', async ({ page }) => {
    expect(await callFn(page, 'associatedRoomIdFromSessionResponse', { room_id: 'top' })).toBe('top');
    expect(await callFn(page, 'associatedRoomIdFromSessionResponse', { session: { room_id: 'in-session' } })).toBe('in-session');
    expect(await callFn(page, 'associatedRoomIdFromSessionResponse', { channel: { channel: { room_id: 'nested' } } })).toBe('nested');
    expect(await callFn(page, 'associatedRoomIdFromSessionResponse', { data: { room_id: 'in-data' } })).toBe('in-data');
    expect(await callFn(page, 'associatedRoomIdFromSessionResponse', null)).toBe('');
  });

  test('only a named, shareable id is adopted as the room code', async ({ page }) => {
    await seedRoom(page, { selfId: 'my-peer-id', isHost: true, roomCode: 'my-peer-id' });
    expect(await callFn(page, 'publicAssociatedRoomId', 'happy-otter')).toBe('happy-otter');
    // A bare peer id is not a shareable code, and neither is our own.
    expect(await callFn(page, 'publicAssociatedRoomId', '11111111-2222-3333-4444-555555555555')).toBe('');
    expect(await callFn(page, 'publicAssociatedRoomId', 'my-peer-id')).toBe('');
    expect(await callFn(page, 'publicAssociatedRoomId', '  ')).toBe('');
  });

  test('activePresenceItem matches the channel we are actually in', async ({ page }) => {
    const seen = await page.evaluate(() => {
      localStorage.setItem('presence-api-token', 'tok');
      localStorage.setItem('presence-org-id', 'org');
      activeChannel = 'General';
      activeChannelRoomId = 'happy-otter';
      presenceData = [
        { channel: { name: 'General', room_id: 'other-room' }, connected: [] },
        { channel: { name: 'General', room_id: 'happy-otter' }, connected: [{ display_name: 'Ada' }] },
      ];
      const exact = activePresenceItem();
      // With no room id to disambiguate, the first channel of that name wins.
      activeChannelRoomId = '';
      const fallback = activePresenceItem();
      activeChannel = null;
      return {
        exact: exact && exact.channel.room_id,
        fallback: fallback && fallback.channel.room_id,
      };
    });
    expect(seen).toEqual({ exact: 'happy-otter', fallback: 'other-room' });
  });

  test('activePresenceItem is nothing without an account or a channel', async ({ page }) => {
    const seen = await page.evaluate(() => {
      localStorage.removeItem('presence-api-token');
      activeChannel = 'General';
      const noAccount = activePresenceItem();
      localStorage.setItem('presence-api-token', 'tok');
      localStorage.setItem('presence-org-id', 'org');
      activeChannel = null;
      const noChannel = activePresenceItem();
      return { noAccount, noChannel };
    });
    expect(seen).toEqual({ noAccount: null, noChannel: null });
  });
});
