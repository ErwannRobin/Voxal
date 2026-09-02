// Handler-level tests for the anonymous TURN credential endpoint.
//
// The pure helpers in _turn.js are already covered by _turn.test.js, but they
// cannot see the two things this endpoint actually has to get right: that the
// Cloudflare token secret only ever travels *outbound* in an Authorization
// header (never into a response body or a log line), and that the module-scope
// mint cache is what keeps request volume free. Both are handler behaviour.
//
// The handler keeps its cache and its rate-limiter in module scope, which
// survives between calls on a warm instance — so every test imports its own
// fresh copy of the module (`?fresh=N`) rather than trying to reset state that
// is deliberately not exported.
//
// `node --test`, zero deps, no network.
import test from 'node:test';
import assert from 'node:assert';

const TOKEN_ID = 'test-token-id';
const TOKEN_SECRET = 'test-token-secret-never-leaks';

let freshCount = 0;
/** A handler with its own module scope: empty cache, empty rate-limit map. */
async function freshHandler() {
  const mod = await import(`./ice-servers.js?fresh=${freshCount++}`);
  return mod.default;
}

function configure(env = {}) {
  process.env.CF_TURN_TOKEN_ID = TOKEN_ID;
  process.env.CF_TURN_TOKEN_SECRET = TOKEN_SECRET;
  delete process.env.CF_TURN_TTL;
  delete process.env.ICE_RATE_LIMIT;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** Minimal stand-in for the Vercel response object. */
function makeRes() {
  return {
    statusCode: null,
    body: null,
    ended: false,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { this.ended = true; return this; },
  };
}

function makeReq(headers = {}, method = 'GET') {
  return { method, headers };
}

const CF_OK = {
  iceServers: {
    urls: [
      'stun:stun.cloudflare.com:3478',
      'turn:turn.cloudflare.com:3478?transport=udp',
      'turns:turn.cloudflare.com:5349?transport=tcp',
    ],
    username: 'cf-user',
    credential: 'cf-pass',
  },
};

/**
 * Replace global fetch with a recorder. `responder(url, init, callIndex)`
 * returns either a plain payload (treated as 201 Created, which is what
 * Cloudflare answers on success) or `{ __status, payload }`.
 */
function stubFetch(responder) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const index = calls.length;
    calls.push({ url, method: init.method, headers: init.headers || {}, rawBody: init.body });
    const result = await responder(url, init, index);
    const status = (result && result.__status) || 201;
    const payload = result && result.__status ? result.payload : result;
    return {
      status,
      json: async () => payload ?? {},
      text: async () => JSON.stringify(payload ?? {}),
    };
  };
  return calls;
}

const realFetch = globalThis.fetch;
const realError = console.error;
test.afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realError;
});

/** Swallow the handler's own console.error and hand back what it logged. */
function captureErrors() {
  const lines = [];
  console.error = (...args) => lines.push(args.join(' '));
  return lines;
}

// --- method + configuration gates --------------------------------------------

test('OPTIONS preflight answers 204 with the CORS headers native apps need', async () => {
  configure();
  const handler = await freshHandler();
  const res = makeRes();
  await handler(makeReq({}, 'OPTIONS'), res);

  assert.equal(res.statusCode, 204);
  assert.ok(res.ended);
  // Native apps (Capacitor/Tauri) have no usable Origin, so this must be open.
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
  assert.match(res.headers['Access-Control-Allow-Methods'], /GET/);
});

test('a non-GET method is rejected with 405', async () => {
  configure();
  const handler = await freshHandler();
  const res = makeRes();
  await handler(makeReq({}, 'POST'), res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.body.error, 'method_not_allowed');
});

test('an unconfigured deployment returns 503 without calling Cloudflare', async () => {
  configure({ CF_TURN_TOKEN_ID: undefined, CF_TURN_TOKEN_SECRET: undefined });
  const calls = stubFetch(() => CF_OK);
  const handler = await freshHandler();
  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'not_configured');
  assert.equal(calls.length, 0);
});

test('a half-configured deployment (id but no secret) is also 503', async () => {
  configure({ CF_TURN_TOKEN_SECRET: undefined });
  const calls = stubFetch(() => CF_OK);
  const handler = await freshHandler();
  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res.statusCode, 503);
  assert.equal(calls.length, 0);
});

// --- the mint itself ---------------------------------------------------------

test('a successful mint returns the ICE servers and never the token secret', async () => {
  configure();
  const calls = stubFetch(() => CF_OK);
  const handler = await freshHandler();
  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.cached, false);
  assert.equal(res.body.ttl, 3600);
  assert.deepEqual(res.body.ice_servers, [
    {
      urls: CF_OK.iceServers.urls,
      username: 'cf-user',
      credential: 'cf-pass',
    },
  ]);

  // The secret is what authorizes us to Cloudflare, and must go nowhere else.
  assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN_SECRET}`);
  assert.ok(!JSON.stringify(res.body).includes(TOKEN_SECRET));
  assert.match(calls[0].url, /\/keys\/test-token-id\/credentials\/generate$/);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].rawBody), { ttl: 3600 });
});

test('the browser is told never to cache, while the edge is told it may', async () => {
  configure();
  stubFetch(() => CF_OK);
  const handler = await freshHandler();
  const res = makeRes();
  await handler(makeReq(), res);

  // A credential cached by the browser is one that outlives its own expiry.
  assert.equal(res.headers['Cache-Control'], 'no-store');
  // The edge may: every caller receives the same mint anyway.
  assert.equal(res.headers['Vercel-CDN-Cache-Control'], 'max-age=300');
  assert.equal(res.headers['CDN-Cache-Control'], 'max-age=300');
});

test('CF_TURN_TTL overrides the default lifetime, and a junk value does not', async () => {
  configure({ CF_TURN_TTL: '600' });
  const calls = stubFetch(() => CF_OK);
  let res = makeRes();
  await (await freshHandler())(makeReq(), res);
  assert.equal(res.body.ttl, 600);
  assert.deepEqual(JSON.parse(calls[0].rawBody), { ttl: 600 });

  configure({ CF_TURN_TTL: 'not-a-number' });
  const calls2 = stubFetch(() => CF_OK);
  res = makeRes();
  await (await freshHandler())(makeReq(), res);
  assert.equal(res.body.ttl, 3600);
  assert.deepEqual(JSON.parse(calls2[0].rawBody), { ttl: 3600 });
});

test('expires_at is the mint time plus the TTL', async () => {
  configure({ CF_TURN_TTL: '120' });
  stubFetch(() => CF_OK);
  const before = Date.now();
  const res = makeRes();
  await (await freshHandler())(makeReq(), res);
  const after = Date.now();

  const expires = Date.parse(res.body.expires_at);
  assert.ok(expires >= before + 120_000, 'expiry must not predate the mint window');
  assert.ok(expires <= after + 120_000);
});

// --- the module cache: what makes request volume free ------------------------

test('a second request is served from the module cache, with no second Cloudflare call', async () => {
  configure();
  const calls = stubFetch(() => CF_OK);
  const handler = await freshHandler();

  const first = makeRes();
  await handler(makeReq(), first);
  const second = makeRes();
  await handler(makeReq(), second);

  assert.equal(calls.length, 1, 'N callers must cost one Cloudflare API call');
  assert.equal(first.body.cached, false);
  assert.equal(second.body.cached, true);
  assert.deepEqual(second.body.ice_servers, first.body.ice_servers);
  assert.equal(second.body.expires_at, first.body.expires_at);
});

// --- failure paths -----------------------------------------------------------

test('a Cloudflare error with no cache to fall back on is a 502', async () => {
  configure();
  const logged = captureErrors();
  stubFetch(() => ({ __status: 500, payload: { error: 'cloudflare exploded' } }));
  const res = makeRes();
  await (await freshHandler())(makeReq(), res);

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, 'mint_failed');
  assert.match(res.body.message, /500/);
  // Neither the body nor the log line may carry the request we signed.
  assert.ok(!JSON.stringify(res.body).includes(TOKEN_SECRET));
  assert.ok(!logged.join('\n').includes(TOKEN_SECRET));
});

test('a 201 carrying no usable ICE server is treated as a failed mint', async () => {
  configure();
  captureErrors();
  stubFetch(() => ({ iceServers: { urls: [] } }));
  const res = makeRes();
  await (await freshHandler())(makeReq(), res);

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, 'mint_failed');
});

test('a failed re-mint falls back to the still-valid cached credential', async () => {
  // Short TTL so the cache goes stale (past 80% of its life) but stays valid.
  configure({ CF_TURN_TTL: '1' });
  const handler = await freshHandler();
  const logged = captureErrors();

  let fail = false;
  const calls = stubFetch(() => (fail ? { __status: 503, payload: {} } : CF_OK));

  const first = makeRes();
  await handler(makeReq(), first);
  assert.equal(first.statusCode, 200);

  // Past 80% of a 1s TTL, so isCacheFresh() is false and a re-mint is attempted.
  await new Promise((r) => setTimeout(r, 850));
  fail = true;
  const second = makeRes();
  await handler(makeReq(), second);

  assert.equal(calls.length, 2, 'the stale cache must still have triggered a re-mint attempt');
  assert.equal(second.statusCode, 200, 'a live credential beats failing the call');
  assert.equal(second.body.cached, true);
  assert.equal(second.body.stale, true);
  assert.deepEqual(second.body.ice_servers, first.body.ice_servers);
  assert.ok(logged.length, 'the failed re-mint should still be logged');
});

// --- rate limiting -----------------------------------------------------------

test('a client over the per-IP limit inside the window is rate limited', async () => {
  configure({ ICE_RATE_LIMIT: '3' });
  const calls = stubFetch(() => CF_OK);
  const handler = await freshHandler();
  const headers = { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' };

  for (let i = 0; i < 3; i++) {
    const res = makeRes();
    await handler(makeReq(headers), res);
    assert.equal(res.statusCode, 200, `request ${i + 1} should pass`);
  }

  const blocked = makeRes();
  await handler(makeReq(headers), blocked);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.body.error, 'rate_limited');
  assert.ok(blocked.body.retry_after > 0);
  assert.equal(blocked.headers['Retry-After'], String(blocked.body.retry_after));
  // Only the first request ever reached Cloudflare — the rest were cache hits.
  assert.equal(calls.length, 1);
});

test('the rate limiter keys on the client IP, not on every forwarded hop', async () => {
  configure({ ICE_RATE_LIMIT: '1' });
  stubFetch(() => CF_OK);
  const handler = await freshHandler();

  const a = makeRes();
  await handler(makeReq({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }), a);
  assert.equal(a.statusCode, 200);

  // Same client, different intermediary: still the same bucket.
  const again = makeRes();
  await handler(makeReq({ 'x-forwarded-for': '203.0.113.7, 10.0.0.9' }), again);
  assert.equal(again.statusCode, 429);

  // A genuinely different client is not punished for it.
  const other = makeRes();
  await handler(makeReq({ 'x-forwarded-for': '198.51.100.4' }), other);
  assert.equal(other.statusCode, 200);
});
