import { test, expect } from './fixtures.js';

// Joining a room by NAME rather than by peer id. Two services can answer:
// an org's presence channel list, and the anonymous-rooms lobby. Whichever
// answers, the same rule holds — join whoever is already hosting, and only
// become the host when nobody is.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    window.__joined = [];
    window.__created = 0;
    window.__joinFails = null;   // Error to throw from joinRoom
    window.__publishes = [];
    window.__requests = [];
    window.__reply = { ok: false, status: 404, body: null };

    window.joinRoom = (code, onJoined) => {
      window.__joined.push(code);
      if (window.__joinFails) return Promise.reject(window.__joinFails);
      roomCode = code;
      inRoom = true;
      isHost = false;
      if (onJoined) onJoined('my-peer-id');
      return Promise.resolve();
    };
    window.createRoom = (onJoined) => {
      window.__created++;
      peer = { id: 'new-host-id', destroyed: false, destroy() { this.destroyed = true; } };
      roomCode = 'new-host-id';
      inRoom = true;
      isHost = true;
      if (onJoined) onJoined('new-host-id');
      return Promise.resolve();
    };
    window.publishRoom = (opts) => { window.__publishes.push(opts || null); return Promise.resolve(); };

    window.fetch = function(url, opts) {
      window.__requests.push({ url: String(url), opts: opts || {} });
      const r = window.__reply;
      return Promise.resolve({ ok: r.ok, status: r.status, json: () => Promise.resolve(r.body) });
    };

    presenceData = [];
    localStorage.removeItem('presence-api-token');
    localStorage.removeItem('presence-org-id');
    inRoom = false;
  });
});

test.describe('joinOrCreateByChannelName without an account', () => {
  test('a blank name does nothing', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      await joinOrCreateByChannelName('   ');
      return { joined: window.__joined, created: window.__created };
    });
    expect(seen).toEqual({ joined: [], created: 0 });
  });

  test('an unknown name creates the room and claims the slug', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      window.__reply = { ok: false, status: 404, body: null };
      await joinOrCreateByChannelName('happy-otter');
      return { joined: window.__joined, created: window.__created, publishes: window.__publishes };
    });
    expect(seen.joined).toEqual([]);
    expect(seen.created).toBe(1);
    expect(seen.publishes).toEqual([{ room_code: 'happy-otter' }]);
  });

  test('a lobby with a live host is joined, not replaced', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      window.__reply = { ok: true, status: 200, body: { room_id: 'live-host', room_code: 'happy-otter' } };
      await joinOrCreateByChannelName('happy-otter');
      return { joined: window.__joined, created: window.__created, display: activeChannelRoomId };
    });
    expect(seen.joined).toEqual(['live-host']);
    expect(seen.created).toBe(0);
    // The shareable name, not the host's peer id, is what the header shows.
    expect(seen.display).toBe('happy-otter');
  });

  test('a stale host is replaced, and the slug re-pointed at us', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      window.__reply = { ok: true, status: 200, body: { room_id: 'dead-host', room_code: 'happy-otter' } };
      window.__joinFails = Object.assign(new Error('Could not connect to peer dead-host'), { type: 'peer-unavailable' });
      await joinOrCreateByChannelName('happy-otter');
      await new Promise((r) => setTimeout(r, 20));
      return {
        joined: window.__joined,
        created: window.__created,
        display: activeChannelRoomId,
        patch: window.__requests.filter((r) => (r.opts.method || '') === 'PATCH').map((r) => r.url),
      };
    });
    expect(seen.joined).toEqual(['dead-host']);
    expect(seen.created).toBe(1);
    expect(seen.display).toBe('happy-otter');
    expect(seen.patch).toHaveLength(1);
    expect(seen.patch[0]).toContain('happy-otter');
  });

  test('a lobby entry with no host at all is claimed directly', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      window.__reply = { ok: true, status: 200, body: { room_code: 'happy-otter' } };
      await joinOrCreateByChannelName('happy-otter');
      return { joined: window.__joined, created: window.__created };
    });
    expect(seen).toEqual({ joined: [], created: 1 });
  });

  test('a cancelled join propagates instead of forking the room', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      window.__reply = { ok: true, status: 200, body: { room_id: 'live-host', room_code: 'happy-otter' } };
      window.__joinFails = new Error('Connection cancelled.');
      let message = null;
      try { await joinOrCreateByChannelName('happy-otter'); } catch (e) { message = e.message; }
      return { message, created: window.__created };
    });
    expect(seen).toEqual({ message: 'Connection cancelled.', created: 0 });
  });

  test('cancelling mid-lookup stops before anything is created', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      let release;
      window.fetch = () => new Promise((r) => { release = () => r({ ok: false, status: 404, json: () => Promise.resolve(null) }); });
      const p = joinOrCreateByChannelName('happy-otter');
      _cancelJoin();
      release();
      let message = null;
      try { await p; } catch (e) { message = e.message; }
      return { message, created: window.__created };
    });
    expect(seen).toEqual({ message: 'Connection cancelled.', created: 0 });
  });
});

test.describe('joinOrCreateByChannelName with an account', () => {
  test('a channel already in the presence list is joined through it', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      localStorage.setItem('presence-api-token', 'tok');
      localStorage.setItem('presence-org-id', 'org');
      presenceData = [{ channel: { name: 'General' }, connected: [{ peer_id: 'host-1' }] }];
      await joinOrCreateByChannelName('general');
      return { joined: window.__joined, channel: activeChannel };
    });
    expect(seen.joined).toEqual(['host-1']);
    expect(seen.channel).toBe('General');
  });

  test('a channel the org does not have falls through to the lobby', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      localStorage.setItem('presence-api-token', 'tok');
      localStorage.setItem('presence-org-id', 'org');
      presenceData = [{ channel: { name: 'Other' }, connected: [] }];
      window.__reply = { ok: true, status: 200, body: { room_id: 'anon-host', room_code: 'happy-otter' } };
      await joinOrCreateByChannelName('happy-otter');
      return window.__joined;
    });
    expect(seen).toEqual(['anon-host']);
  });
});

test.describe('joinChannel', () => {
  test('an empty channel is created, and presence registered for it', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      localStorage.setItem('presence-api-token', 'tok');
      localStorage.setItem('presence-org-id', 'org');
      window.__reply = { ok: false, status: 404, body: null };
      await joinChannel({ channel: { name: 'General' }, connected: [] });
      return { created: window.__created, channel: activeChannel, joined: window.__joined };
    });
    expect(seen).toEqual({ created: 1, channel: 'General', joined: [] });
  });

  test('an empty channel with a live anonymous host joins it instead', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      localStorage.setItem('presence-api-token', 'tok');
      localStorage.setItem('presence-org-id', 'org');
      // Presence lag: nobody listed, but the lobby knows a host.
      window.__reply = { ok: true, status: 200, body: { room_id: 'anon-host' } };
      await joinChannel({ channel: { name: 'General' }, connected: [] });
      return { joined: window.__joined, created: window.__created };
    });
    expect(seen).toEqual({ joined: ['anon-host'], created: 0 });
  });

  test('the lowest peer id is dialled first, so everyone picks the same host', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      localStorage.setItem('presence-api-token', 'tok');
      localStorage.setItem('presence-org-id', 'org');
      await joinChannel({
        channel: { name: 'General' },
        connected: [{ peer_id: 'z-peer' }, { peer_id: 'a-peer' }, { peer_id: 'a-peer' }],
      });
      return window.__joined;
    });
    expect(seen).toEqual(['a-peer']);
  });

  test('every listed peer being unreachable ends in creating the room', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      localStorage.setItem('presence-api-token', 'tok');
      localStorage.setItem('presence-org-id', 'org');
      window.__joinFails = Object.assign(new Error('Could not connect to peer x'), { type: 'peer-unavailable' });
      window.__reply = { ok: false, status: 404, body: null };
      await joinChannel({
        channel: { name: 'General' },
        connected: [{ peer_id: 'a-peer' }, { peer_id: 'b-peer' }],
      });
      return { joined: window.__joined, created: window.__created };
    });
    // Both are tried before giving up on them.
    expect(seen.joined).toEqual(['a-peer', 'b-peer']);
    expect(seen.created).toBe(1);
  });

  test('a fatal error stops the walk and is re-thrown', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      localStorage.setItem('presence-api-token', 'tok');
      localStorage.setItem('presence-org-id', 'org');
      window.__joinFails = Object.assign(new Error('broker is down'), { type: 'server-error' });
      let message = null;
      try {
        await joinChannel({
          channel: { name: 'General' },
          connected: [{ peer_id: 'a-peer' }, { peer_id: 'b-peer' }],
        });
      } catch (e) { message = e.message; }
      return { message, joined: window.__joined, created: window.__created };
    });
    expect(seen.message).toBe('broker is down');
    expect(seen.joined).toEqual(['a-peer']);
    expect(seen.created).toBe(0);
  });

  test('a channel with a public room id adopts it as the display code', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      localStorage.setItem('presence-api-token', 'tok');
      localStorage.setItem('presence-org-id', 'org');
      await joinChannel({
        channel: { name: 'General', room_id: 'happy-otter' },
        connected: [{ peer_id: 'a-peer' }],
      });
      return activeChannelRoomId;
    });
    expect(seen).toBe('happy-otter');
  });
});

test.describe('selectOrgAndStartPolling', () => {
  test('picks the saved org when it is still valid', async ({ page }) => {
    const org = await page.evaluate(async () => {
      localStorage.setItem('presence-api-token', 'tok');
      localStorage.setItem('presence-org-id', 'org-b');
      window.__reply = {
        ok: true,
        status: 200,
        body: { organisations: [{ id: 'org-a', name: 'A' }, { id: 'org-b', name: 'B' }] },
      };
      await selectOrgAndStartPolling();
      stopPresencePolling();
      return localStorage.getItem('presence-org-id');
    });
    expect(org).toBe('org-b');
  });

  test('falls back to the first org when the saved one is gone', async ({ page }) => {
    const org = await page.evaluate(async () => {
      localStorage.setItem('presence-api-token', 'tok');
      localStorage.setItem('presence-org-id', 'org-gone');
      window.__reply = {
        ok: true,
        status: 200,
        body: { organisations: [{ id: 'org-a', name: 'A', role: 'admin' }] },
      };
      await selectOrgAndStartPolling();
      stopPresencePolling();
      return localStorage.getItem('presence-org-id');
    });
    expect(org).toBe('org-a');
  });

  test('a failure is logged, not thrown', async ({ page }) => {
    const threw = await page.evaluate(async () => {
      localStorage.setItem('presence-api-token', 'tok');
      window.fetch = () => Promise.reject(new Error('offline'));
      try { await selectOrgAndStartPolling(); return false; } catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });

  test('the poll starts and stops cleanly', async ({ page }) => {
    const seen = await page.evaluate(() => {
      localStorage.setItem('presence-api-token', 'tok');
      localStorage.setItem('presence-org-id', 'org');
      startPresencePolling();
      const running = !!presenceInterval;
      stopPresencePolling();
      return { running, stopped: presenceInterval };
    });
    expect(seen.running).toBe(true);
    expect(seen.stopped).toBe(null);
  });

  test('the poll does not start without an account', async ({ page }) => {
    const running = await page.evaluate(() => {
      localStorage.removeItem('presence-api-token');
      stopPresencePolling();
      startPresencePolling();
      const out = !!presenceInterval;
      stopPresencePolling();
      return out;
    });
    expect(running).toBe(false);
  });
});
