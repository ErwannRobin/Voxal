// Joining a named presence channel: the room must keep the channel's identity.
//
// Hosting an empty org channel goes through joinChannel() → createRoom(), then
// registers the session with the presence API. The API echoes the payload back,
// which used to overwrite the channel name with our own PeerJS peer id — the
// room header flipped to a UUID a fraction of a second after joining, exactly as
// if the user had landed in a fresh anonymous room.
import { test, expect } from './fixtures.js';

const SESSION_BASE = 'https://presence.test/session';
const ROOMS_BASE = '**/functions/v1/anonymous-rooms/**';
const FAKE_PEER_ID = '11111111-2222-3333-4444-555555555555';

// Stub every network dependency of the presence-channel join path, plus PeerJS.
// `postEcho` decides what the presence API returns for POST /session — the real
// backend echoes the stored session row, room_id included.
async function stubPresenceEnv(page, { postEcho = 'echo' } = {}) {
  await page.route(SESSION_BASE + '/org/*/ice-servers', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ice_servers: [{ urls: 'stun:stun.test:3478' }] }),
    }));

  await page.route(SESSION_BASE + '/org/*/presence', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ presence: [{ channel: { id: 'c1', name: 'SecondChannel' }, connected: [] }] }),
    }));

  const posted = [];
  await page.route(SESSION_BASE, async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.fulfill({ status: 200, body: '{}' });
    const body = JSON.parse(req.postData() || '{}');
    posted.push(body);
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(postEcho === 'echo' ? body : {}),
    });
  });

  // No published lobby under this channel name.
  await page.route(ROOMS_BASE, (route) => route.fulfill({ status: 404, body: '{}' }));

  await page.addInitScript(() => {
    localStorage.setItem('presence-api-token', 'tok');
    localStorage.setItem('presence-org-id', 'org1');
    localStorage.setItem('service-url', 'https://presence.test/session');
    localStorage.setItem('pseudo', 'Tester');
  });

  return posted;
}

async function hostEmptyChannel(page) {
  // Minimal PeerJS stand-in: opens immediately, never talks to a broker. Must be
  // installed after peerjs.min.js has loaded, or the real Peer wins.
  await page.evaluate((peerId) => {
    window.Peer = function FakePeer() {
      const handlers = {};
      this.id = peerId;
      this.destroyed = false;
      this.on = function(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); };
      this.destroy = function() { this.destroyed = true; };
      setTimeout(() => (handlers.open || []).forEach((fn) => fn(peerId)), 0);
    };
  }, FAKE_PEER_ID);
  await page.evaluate(() => window.joinChannel({
    channel: { id: 'c1', name: 'SecondChannel' },
    connected: [],
  }));
  // Let the presence POST and its callback settle.
  await page.waitForTimeout(300);
}

test.describe('hosting an empty presence channel', () => {
  test('keeps the channel name as the room identity', async ({ page }) => {
    await stubPresenceEnv(page);
    await page.goto('/');
    await hostEmptyChannel(page);

    expect(await page.evaluate(() => isHost)).toBe(true);
    expect(await page.evaluate(() => activeChannel)).toBe('SecondChannel');
    // The regression: the echoed room_id (our own peer id) replaced the channel
    // name, so the header advertised an anonymous-looking room code instead.
    expect(await page.evaluate(() => activeChannelRoomId || '')).toBe('');
    await expect(page.locator('#room-code-display')).toHaveText('SecondChannel');
  });

  test('does not advertise the raw peer id as the channel room id', async ({ page }) => {
    const posted = await stubPresenceEnv(page);
    await page.goto('/');
    await hostEmptyChannel(page);

    expect(posted.length).toBeGreaterThan(0);
    expect(posted[0].channel_name).toBe('SecondChannel');
    expect(posted[0].peer_id).toBe(FAKE_PEER_ID);
    // room_id is the *public* identifier of the room (a published lobby slug).
    // The peer id is already carried by peer_id; repeating it here is what fed
    // the UUID back into the room header.
    expect(posted[0].room_id || '').not.toBe(FAKE_PEER_ID);
  });

  test('still adopts a real associated room id from the API', async ({ page }) => {
    await stubPresenceEnv(page);
    await page.unroute(SESSION_BASE);
    await page.route(SESSION_BASE, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ room_id: 'team-standup' }),
      }));
    await page.goto('/');
    await hostEmptyChannel(page);

    expect(await page.evaluate(() => activeChannelRoomId)).toBe('team-standup');
    await expect(page.locator('#room-code-display')).toHaveText('team-standup');
  });
});
