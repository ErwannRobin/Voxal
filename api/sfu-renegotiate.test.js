// Handler-level tests for the SFU renegotiation leg.
//
// This is the endpoint whose absence produced the original "connected session,
// permanently black tile" bug: pulling a remote track makes Cloudflare answer
// with an *offer*, and until the subscriber's answer gets back to Cloudflare no
// media flows. So these tests care about two things the pure helpers cannot
// see — that the answer reaches the right Cloudflare session URL in the shape
// Cloudflare expects, and that an unauthorized or failed call never reaches it
// at all (and never leaks the app secret when it does).
//
// `node --test`, zero deps, no network.
import test from 'node:test';
import assert from 'node:assert';

import handler from './sfu-renegotiate.js';
import { signCapability } from './_sfu.js';

const SECRET = 'test-capability-secret';
const APP_ID = 'test-app-id';
const APP_SECRET = 'test-app-secret-never-leaks';
const ANSWER = 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n';
const SESSION_ID = 'cf-sess-1';

const TUPLE = { roomCode: 'room-abc', participantId: 'peer-2', kind: 'video', action: 'subscribe' };

function configure(env = {}) {
  process.env.SFU_CAPABILITY_SECRET = SECRET;
  process.env.CF_SFU_APP_ID = APP_ID;
  process.env.CF_SFU_APP_SECRET = APP_SECRET;
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

function makeReq(body, method = 'POST') {
  return { method, body };
}

function capability(tuple = TUPLE, ttlMs = 60_000) {
  return signCapability(SECRET, tuple, Date.now() + ttlMs);
}

function validBody(overrides = {}) {
  return {
    ...TUPLE,
    capability: capability(),
    answer: ANSWER,
    sessionId: SESSION_ID,
    ...overrides,
  };
}

/** Replace global fetch with a recorder. `responder(url, init)` returns the
 *  parsed JSON body Cloudflare would send back, or `{ __status, payload }`. */
function stubFetch(responder) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers || {},
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    });
    const result = await responder(url, init);
    const status = (result && result.__status) || 200;
    const payload = result && result.__status ? result.payload : result;
    return {
      ok: status >= 200 && status < 300,
      status,
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
  const res = makeRes();
  await handler(makeReq(undefined, 'OPTIONS'), res);

  assert.equal(res.statusCode, 204);
  assert.ok(res.ended);
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
  assert.match(res.headers['Access-Control-Allow-Methods'], /POST/);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('a non-POST method is rejected with 405', async () => {
  configure();
  const res = makeRes();
  await handler(makeReq(validBody(), 'GET'), res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.body.error, 'method_not_allowed');
});

test('a deployment missing any SFU env var returns 503 without calling Cloudflare', async () => {
  for (const missing of ['SFU_CAPABILITY_SECRET', 'CF_SFU_APP_ID', 'CF_SFU_APP_SECRET']) {
    configure({ [missing]: undefined });
    const calls = stubFetch(() => ({}));
    const res = makeRes();
    await handler(makeReq(validBody()), res);

    assert.equal(res.statusCode, 503, missing);
    assert.equal(res.body.error, 'not_configured');
    assert.equal(calls.length, 0);
  }
});

// --- request validation ------------------------------------------------------

test('an answer-less or session-less request is a 400, and never reaches Cloudflare', async () => {
  configure();
  const cases = [
    [validBody({ answer: undefined }), /answer/],
    [validBody({ answer: '' }), /answer/],
    [validBody({ answer: 42 }), /answer/],
    [validBody({ sessionId: undefined }), /sessionId/],
    [validBody({ sessionId: '' }), /sessionId/],
  ];

  for (const [body, message] of cases) {
    const calls = stubFetch(() => ({}));
    const res = makeRes();
    await handler(makeReq(body), res);

    assert.equal(res.statusCode, 400, JSON.stringify(Object.keys(body)));
    assert.equal(res.body.error, 'invalid_request');
    assert.match(res.body.message, message);
    assert.equal(calls.length, 0);
  }
});

test('a non-object body is rejected rather than dereferenced', async () => {
  configure();
  const calls = stubFetch(() => ({}));
  for (const body of [undefined, null, 'answer=x']) {
    const res = makeRes();
    await handler(makeReq(body), res);
    assert.equal(res.statusCode, 400);
  }
  assert.equal(calls.length, 0);
});

// --- authorization -----------------------------------------------------------

test('a missing, forged, expired or mis-scoped capability is a 403 and never reaches Cloudflare', async () => {
  configure();
  const cases = [
    ['missing', validBody({ capability: undefined }), 'malformed'],
    ['garbage', validBody({ capability: 'not-a-token' }), 'malformed'],
    ['wrong secret', validBody({ capability: signCapability('other-secret', TUPLE, Date.now() + 60_000) }), 'bad_signature'],
    ['expired', validBody({ capability: signCapability(SECRET, TUPLE, Date.now() - 1) }), 'expired'],
    // A token minted to publish must not authorize a subscribe, and one minted
    // for another room must not authorize this one.
    ['wrong action', validBody({ capability: signCapability(SECRET, { ...TUPLE, action: 'publish' }, Date.now() + 60_000) }), 'tuple_mismatch'],
    ['wrong room', validBody({ capability: signCapability(SECRET, { ...TUPLE, roomCode: 'other-room' }, Date.now() + 60_000) }), 'tuple_mismatch'],
    ['wrong participant', validBody({ capability: signCapability(SECRET, { ...TUPLE, participantId: 'peer-9' }, Date.now() + 60_000) }), 'tuple_mismatch'],
  ];

  for (const [label, body, reason] of cases) {
    const calls = stubFetch(() => ({}));
    const res = makeRes();
    await handler(makeReq(body), res);

    assert.equal(res.statusCode, 403, label);
    assert.equal(res.body.error, 'unauthorized', label);
    assert.equal(res.body.message, reason, label);
    assert.equal(calls.length, 0, `${label} must not reach Cloudflare`);
  }
});

// --- the happy path ----------------------------------------------------------

test('the answer is PUT to this session\'s renegotiate URL in Cloudflare\'s shape', async () => {
  configure();
  const calls = stubFetch(() => ({}));
  const res = makeRes();
  await handler(makeReq(validBody()), res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { ok: true });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].url, `https://rtc.live.cloudflare.com/v1/apps/${APP_ID}/sessions/${SESSION_ID}/renegotiate`);
  // Cloudflare wants the answer wrapped as a sessionDescription — a bare SDP
  // string is accepted by nothing and leaves the tile black.
  assert.deepEqual(calls[0].body, { sessionDescription: { type: 'answer', sdp: ANSWER } });
  assert.equal(calls[0].headers.authorization, `Bearer ${APP_SECRET}`);
  assert.equal(calls[0].headers['content-type'], 'application/json');
});

test('a session id with URL-significant characters is escaped, not injected', async () => {
  configure();
  const calls = stubFetch(() => ({}));
  const res = makeRes();
  await handler(makeReq(validBody({ sessionId: 'a/../b?x=1' })), res);

  assert.equal(res.statusCode, 200);
  assert.ok(calls[0].url.endsWith('/sessions/a%2F..%2Fb%3Fx%3D1/renegotiate'), calls[0].url);
});

test('a screen-share capability works the same way as a camera one', async () => {
  configure();
  const screen = { ...TUPLE, kind: 'screen' };
  const calls = stubFetch(() => ({}));
  const res = makeRes();
  await handler(makeReq({ ...screen, capability: signCapability(SECRET, screen, Date.now() + 60_000), answer: ANSWER, sessionId: SESSION_ID }), res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(calls.length, 1);
});

// --- Cloudflare failures -----------------------------------------------------

test('a Cloudflare HTTP error becomes a 502 and never echoes the app secret', async () => {
  configure();
  const logged = captureErrors();
  stubFetch(() => ({ __status: 400, payload: { errorDescription: 'session not found' } }));
  const res = makeRes();
  await handler(makeReq(validBody()), res);

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, 'renegotiate_failed');
  assert.match(res.body.message, /400/);
  // Cloudflare's own words are useful; our bearer token is not ours to share.
  assert.match(res.body.detail, /session not found/);
  assert.ok(!JSON.stringify(res.body).includes(APP_SECRET));
  assert.ok(!logged.join('\n').includes(APP_SECRET));
});

test('a track-level error hidden inside a 200 is still a failure', async () => {
  configure();
  captureErrors();
  // Cloudflare reports some failures with a 200 and an errorCode in the body;
  // an HTTP-status-only check would call this a success and leave a black tile.
  stubFetch(() => ({ errorCode: 'renegotiation_error', errorDescription: 'sdp mismatch' }));
  const res = makeRes();
  await handler(makeReq(validBody()), res);

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, 'renegotiate_failed');
  assert.match(res.body.detail, /renegotiation_error: sdp mismatch/);
});

test('a network-level fetch failure is a 502, not an unhandled rejection', async () => {
  configure();
  const logged = captureErrors();
  globalThis.fetch = async () => { throw new Error('ECONNRESET'); };
  const res = makeRes();
  await handler(makeReq(validBody()), res);

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, 'renegotiate_failed');
  assert.match(res.body.message, /ECONNRESET/);
  assert.ok(logged.length);
});

test('an empty 200 from Cloudflare is the success case', async () => {
  configure();
  // The renegotiate leg has no payload to return — Cloudflare answering with an
  // empty body is normal, and must not be mistaken for a failure.
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '' });
  const res = makeRes();
  await handler(makeReq(validBody()), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
});
