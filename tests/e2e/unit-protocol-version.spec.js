import { test, expect } from './fixtures.js';

// Protocol version is exchanged in the hello / peer-list handshake so peers can
// detect version skew (and warn / hint) without breaking mixed-version rooms.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('helloMessage carries protocolVersion and appVersion', async ({ page }) => {
  const hello = await page.evaluate(() => helloMessage());
  expect(hello.type).toBe('hello');
  expect(hello.protocolVersion).toBe(1);
  expect(typeof hello.appVersion).toBe('string');
});

test('buildHostPeerList includes each connected peer\'s version', async ({ page }) => {
  const entry = await page.evaluate(() => {
    peer = { id: 'host' };
    isHost = true;
    knownPeerIds.clear();
    knownPeerIds.add('p1');
    connections.clear();
    connections.set('p1', {
      data: { open: true, closed: false, send() {} },
      pseudo: 'Alice',
      protocolVersion: 1,
      appVersion: '1.0.0',
    });
    return buildHostPeerList(null).find((e) => e.id === 'p1');
  });
  expect(entry).toMatchObject({ id: 'p1', protocolVersion: 1, appVersion: '1.0.0' });
});

test('noteRemoteVersion records the version on the connection', async ({ page }) => {
  const v = await page.evaluate(() => {
    connections.clear();
    connections.set('p1', { data: null, pseudo: 'Alice' });
    noteRemoteVersion('peer p1', 2, '2.0.0', 'p1');
    const c = connections.get('p1');
    return { protocolVersion: c.protocolVersion, appVersion: c.appVersion };
  });
  expect(v).toEqual({ protocolVersion: 2, appVersion: '2.0.0' });
});

test('a newer remote protocol flags this client as outdated', async ({ page }) => {
  const flagged = await page.evaluate(() => {
    _sawNewerProtocol = false;
    noteRemoteVersion('host', 99, '9.9.9', null);
    return _sawNewerProtocol;
  });
  expect(flagged).toBe(true);
});

test('an equal or older (pre-versioning) protocol does not flag outdated', async ({ page }) => {
  const flagged = await page.evaluate(() => {
    _sawNewerProtocol = false;
    noteRemoteVersion('equal', 1, '1.0.0', null); // same protocol
    noteRemoteVersion('old', undefined, undefined, null); // pre-versioning peer → treated as 0
    return _sawNewerProtocol;
  });
  expect(flagged).toBe(false);
});

test('receiving a peer-list from a newer host flags outdated (full receiver path)', async ({ page }) => {
  const flagged = await page.evaluate(() => {
    peer = { id: 'me' };
    inRoom = true;
    roomCode = 'host-x';
    isHost = false;
    connections.clear();
    connections.set('host-x', { data: { open: true }, pseudo: 'Host' });
    _sawNewerProtocol = false;
    safeHandleHostMessage({
      type: 'peer-list',
      peers: [],
      hostId: 'host-x',
      hostPseudo: 'Host',
      protocolVersion: 5,
      appVersion: '5.0.0',
    });
    return _sawNewerProtocol;
  });
  expect(flagged).toBe(true);
});
