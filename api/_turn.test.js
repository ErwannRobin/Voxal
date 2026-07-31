// Pure-logic tests for the anonymous TURN endpoint. `node --test`, zero deps,
// no network.
import test from 'node:test';
import assert from 'node:assert';

import {
  toIceServers,
  isCacheFresh,
  rateLimit,
  pruneHits,
  clientIp,
  credentialsUrl,
} from './_turn.js';

test('toIceServers keeps the TCP and TLS transports', () => {
  // The whole reason we need TURN is firewalls that block UDP/3478. Cloudflare's
  // own example Worker filters to udp-only; copying that would strip exactly the
  // transports the users who need a relay depend on.
  const out = toIceServers({
    iceServers: {
      urls: [
        'stun:stun.cloudflare.com:3478',
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp',
        'turns:turn.cloudflare.com:5349?transport=tcp',
      ],
      username: 'u',
      credential: 'c',
    },
  });
  assert.equal(out.length, 1);
  assert.ok(out[0].urls.some((u) => u.includes('transport=tcp')));
  assert.ok(out[0].urls.some((u) => u.startsWith('turns:')));
  assert.equal(out[0].username, 'u');
  assert.equal(out[0].credential, 'c');
});

test('toIceServers normalises a single urls string and an array response', () => {
  assert.deepEqual(
    toIceServers({ iceServers: { urls: 'turn:a:3478', username: 'u', credential: 'c' } }),
    [{ urls: ['turn:a:3478'], username: 'u', credential: 'c' }]
  );
  assert.equal(toIceServers({ iceServers: [{ urls: 'turn:a:1' }, { urls: 'turn:b:2' }] }).length, 2);
});

test('toIceServers returns empty on missing or malformed input', () => {
  assert.deepEqual(toIceServers(null), []);
  assert.deepEqual(toIceServers({}), []);
  assert.deepEqual(toIceServers({ iceServers: { username: 'u' } }), []);
});

test('isCacheFresh re-mints once 80% of the TTL has elapsed', () => {
  const cache = { mintedAt: 0, ttl: 100 };
  assert.equal(isCacheFresh(cache, 79 * 1000), true);
  assert.equal(isCacheFresh(cache, 81 * 1000), false);
  // A credential handed out at the edge must still have usable life left.
  assert.equal(isCacheFresh(cache, 100 * 1000), false);
});

test('isCacheFresh is false with no cache at all', () => {
  assert.equal(isCacheFresh(null, 1000), false);
  assert.equal(isCacheFresh({ mintedAt: 0 }, 1000), false);
});

test('rateLimit allows up to the limit then blocks with a retry hint', () => {
  const hits = new Map();
  for (let i = 0; i < 3; i++) {
    assert.equal(rateLimit(hits, 'ip', 1000 + i, 3, 60000).allowed, true);
  }
  const blocked = rateLimit(hits, 'ip', 1005, 3, 60000);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfter > 0);
});

test('rateLimit lets the window slide', () => {
  const hits = new Map();
  rateLimit(hits, 'ip', 0, 1, 1000);
  assert.equal(rateLimit(hits, 'ip', 500, 1, 1000).allowed, false);
  assert.equal(rateLimit(hits, 'ip', 1500, 1, 1000).allowed, true);
});

test('rateLimit tracks each IP separately', () => {
  const hits = new Map();
  rateLimit(hits, 'a', 0, 1, 1000);
  assert.equal(rateLimit(hits, 'a', 1, 1, 1000).allowed, false);
  assert.equal(rateLimit(hits, 'b', 1, 1, 1000).allowed, true);
});

test('pruneHits drops IPs that fell out of the window', () => {
  const hits = new Map([['old', [0]], ['new', [900]]]);
  pruneHits(hits, 1000, 500);
  assert.equal(hits.has('old'), false);
  assert.equal(hits.has('new'), true);
});

test('clientIp takes the first x-forwarded-for entry', () => {
  // Behind Vercel's proxy the client is first; later entries are intermediaries.
  assert.equal(clientIp({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1, 10.0.0.2' }), '1.2.3.4');
  assert.equal(clientIp({ 'x-forwarded-for': ['5.6.7.8, 10.0.0.1'] }), '5.6.7.8');
  assert.equal(clientIp({ 'x-real-ip': '9.9.9.9' }), '9.9.9.9');
  assert.equal(clientIp({}), 'unknown');
});

test('credentialsUrl builds the Cloudflare generate endpoint and escapes the id', () => {
  assert.equal(
    credentialsUrl('abc123'),
    'https://rtc.live.cloudflare.com/v1/turn/keys/abc123/credentials/generate'
  );
  assert.ok(credentialsUrl('a/b').includes('a%2Fb'));
});
