// Handler-level tests for the SFU capability-token mint.
//
// _sfu.test.js covers signCapability/verifyCapability as functions. What it
// cannot cover is the property this endpoint exists to hold: the HMAC signing
// secret is never returned, never derivable from the token, and the token the
// client gets back is scoped to exactly the tuple it asked for — no more. A
// token that verified for the wrong room or the wrong action would hand any
// caller a subscription to somebody else's camera.
//
// This endpoint never talks to Cloudflare, so no fetch stub is needed: any
// outbound call at all would itself be the bug, and the tests assert that.
//
// The rate-limit map lives in module scope, so each test imports its own fresh
// copy of the module (`?fresh=N`).
//
// `node --test`, zero deps, no network.
import test from 'node:test';
import assert from 'node:assert';

import { verifyCapability } from './_sfu.js';

const SECRET = 'test-capability-secret-never-leaks';
const APP_ID = 'test-app-id';

let freshCount = 0;
/** A handler with its own module scope, i.e. an empty rate-limit map. */
async function freshHandler() {
  const mod = await import(`./sfu-session.js?fresh=${freshCount++}`);
  return mod.default;
}

function configure(env = {}) {
  process.env.SFU_CAPABILITY_SECRET = SECRET;
  process.env.CF_SFU_APP_ID = APP_ID;
  delete process.env.SFU_CAPABILITY_TTL;
  delete process.env.SFU_RATE_LIMIT;
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

function makeReq(body, { method = 'POST', headers = {} } = {}) {
  return { method, headers, body };
}

const TUPLE = { roomCode: 'room-abc', participantId: 'peer-1', kind: 'video', action: 'publish' };

/** Any outbound fetch from this endpoint is itself a defect — record and fail. */
const realFetch = globalThis.fetch;
function forbidFetch() {
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(url); throw new Error(`unexpected fetch: ${url}`); };
  return calls;
}
test.afterEach(() => { globalThis.fetch = realFetch; });

// --- method + configuration gates --------------------------------------------

test('OPTIONS preflight answers 204 with the CORS headers native apps need', async () => {
  configure();
  const res = makeRes();
  await (await freshHandler())(makeReq(undefined, { method: 'OPTIONS' }), res);

  assert.equal(res.statusCode, 204);
  assert.ok(res.ended);
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
  assert.match(res.headers['Access-Control-Allow-Methods'], /POST/);
  // A capability token is single-use-ish and time-boxed: never cache it.
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('a non-POST method is rejected with 405', async () => {
  configure();
  const res = makeRes();
  await (await freshHandler())(makeReq(TUPLE, { method: 'GET' }), res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.body.error, 'method_not_allowed');
});

test('a deployment with no signing secret returns 503 and mints nothing', async () => {
  configure({ SFU_CAPABILITY_SECRET: undefined });
  const res = makeRes();
  await (await freshHandler())(makeReq(TUPLE), res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'not_configured');
  assert.equal(res.body.capability, undefined);
});

test('a deployment with no Cloudflare app id returns 503', async () => {
  configure({ CF_SFU_APP_ID: undefined });
  const res = makeRes();
  await (await freshHandler())(makeReq(TUPLE), res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'not_configured');
});

// --- request validation ------------------------------------------------------

test('a malformed body is rejected with 400 and a reason', async () => {
  configure();
  const handler = await freshHandler();

  const cases = [
    [{ ...TUPLE, roomCode: '' }, 'invalid_room_code'],
    [{ ...TUPLE, participantId: undefined }, 'invalid_participant_id'],
    // Voice/PTT audio must never be able to mint an SFU token: audio is not a
    // valid kind here and never will be. See docs/video-routing.md.
    [{ ...TUPLE, kind: 'audio' }, 'invalid_kind'],
    [{ ...TUPLE, action: 'relay' }, 'invalid_action'],
  ];

  for (const [body, reason] of cases) {
    const res = makeRes();
    await handler(makeReq(body), res);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res.body.error, 'invalid_request');
    assert.equal(res.body.message, reason);
  }
});

test('a missing or non-object body is rejected rather than signed', async () => {
  configure();
  const handler = await freshHandler();

  for (const body of [undefined, null, 'roomCode=x', 42]) {
    const res = makeRes();
    await handler(makeReq(body), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.capability, undefined);
  }
});

// --- the mint itself ---------------------------------------------------------

test('a valid request returns a capability that verifies for exactly that tuple', async () => {
  configure();
  const outbound = forbidFetch();
  const res = makeRes();
  await (await freshHandler())(makeReq({ ...TUPLE }), res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.sfu_app_id, APP_ID);
  assert.equal(outbound.length, 0, 'the mint step must never talk to Cloudflare');

  const ok = verifyCapability(SECRET, res.body.capability, TUPLE, Date.now());
  assert.equal(ok.valid, true, ok.error);
  assert.equal(ok.payload.roomCode, TUPLE.roomCode);
});

test('the token is scoped: it does not verify for another room, peer, kind or action', async () => {
  configure();
  const res = makeRes();
  await (await freshHandler())(makeReq({ ...TUPLE }), res);
  const token = res.body.capability;
  const now = Date.now();

  const others = [
    { ...TUPLE, roomCode: 'someone-elses-room' },
    { ...TUPLE, participantId: 'peer-2' },
    { ...TUPLE, kind: 'screen' },
    { ...TUPLE, action: 'subscribe' },
  ];
  for (const expected of others) {
    const check = verifyCapability(SECRET, token, expected, now);
    assert.equal(check.valid, false, JSON.stringify(expected));
    assert.equal(check.error, 'tuple_mismatch');
  }
});

test('the signing secret is never returned and never recoverable from the token', async () => {
  configure();
  const res = makeRes();
  await (await freshHandler())(makeReq({ ...TUPLE }), res);

  const serialised = JSON.stringify(res.body);
  assert.ok(!serialised.includes(SECRET), 'the raw secret must not appear in the response');
  // The token is base64url; decoding either half must not surface it either.
  for (const part of res.body.capability.split('.')) {
    assert.ok(!Buffer.from(part, 'base64url').toString('utf8').includes(SECRET));
  }
  // A different secret must not validate the token we just handed out.
  assert.equal(verifyCapability('some-other-secret', res.body.capability, TUPLE, Date.now()).valid, false);
});

test('the capability expires after SFU_CAPABILITY_TTL, defaulting to 300s', async () => {
  configure();
  let res = makeRes();
  let before = Date.now();
  await (await freshHandler())(makeReq({ ...TUPLE }), res);
  let expires = Date.parse(res.body.expires_at);
  assert.ok(expires >= before + 300_000 && expires <= Date.now() + 300_000);

  configure({ SFU_CAPABILITY_TTL: '30' });
  res = makeRes();
  before = Date.now();
  await (await freshHandler())(makeReq({ ...TUPLE }), res);
  expires = Date.parse(res.body.expires_at);
  assert.ok(expires >= before + 30_000 && expires <= Date.now() + 30_000);

  // Verification must agree with the advertised expiry, in both directions.
  assert.equal(verifyCapability(SECRET, res.body.capability, TUPLE, expires - 1).valid, true);
  assert.equal(verifyCapability(SECRET, res.body.capability, TUPLE, expires).error, 'expired');
});

test('a junk SFU_CAPABILITY_TTL falls back to the default rather than minting a dead token', async () => {
  configure({ SFU_CAPABILITY_TTL: '-5' });
  const res = makeRes();
  const before = Date.now();
  await (await freshHandler())(makeReq({ ...TUPLE }), res);

  const expires = Date.parse(res.body.expires_at);
  assert.ok(expires >= before + 300_000, 'a negative TTL must not produce an already-expired token');
  assert.equal(verifyCapability(SECRET, res.body.capability, TUPLE, Date.now()).valid, true);
});

// --- rate limiting -----------------------------------------------------------

test('a client over the per-IP limit inside the window is rate limited', async () => {
  configure({ SFU_RATE_LIMIT: '2' });
  const handler = await freshHandler();
  const headers = { 'x-forwarded-for': '203.0.113.7' };

  for (let i = 0; i < 2; i++) {
    const res = makeRes();
    await handler(makeReq({ ...TUPLE }, { headers }), res);
    assert.equal(res.statusCode, 200, `request ${i + 1} should pass`);
  }

  const blocked = makeRes();
  await handler(makeReq({ ...TUPLE }, { headers }), blocked);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.body.error, 'rate_limited');
  assert.ok(blocked.body.retry_after > 0);
  assert.equal(blocked.headers['Retry-After'], String(blocked.body.retry_after));
  assert.equal(blocked.body.capability, undefined);

  // A different client is not caught in someone else's bucket.
  const other = makeRes();
  await handler(makeReq({ ...TUPLE }, { headers: { 'x-forwarded-for': '198.51.100.4' } }), other);
  assert.equal(other.statusCode, 200);
});

test('the rate limit is checked before the body is, so junk cannot be used to probe for free', async () => {
  configure({ SFU_RATE_LIMIT: '1' });
  const handler = await freshHandler();
  const headers = { 'x-forwarded-for': '203.0.113.9' };

  const first = makeRes();
  await handler(makeReq({ ...TUPLE, kind: 'audio' }, { headers }), first);
  assert.equal(first.statusCode, 400, 'the first attempt is rejected on its body');

  const second = makeRes();
  await handler(makeReq({ ...TUPLE }, { headers }), second);
  assert.equal(second.statusCode, 429, 'but it still consumed the budget');
});
