// Handler-level tests for the Cloudflare Realtime SFU negotiation proxy.
//
// The pure helpers in _sfu.js already have their own tests, but they cannot see
// the shape of what actually goes over the wire — and every SFU bug that has
// reached a live user so far has been exactly that: a well-formed request sent
// to the wrong endpoint, or missing the one field that routes media. These
// tests stub `globalThis.fetch` and assert on the outbound Cloudflare request
// bodies themselves.
//
// `node --test`, zero deps, no network.
import test from 'node:test';
import assert from 'node:assert';

import handler from './sfu-track.js';
import { signCapability } from './_sfu.js';

const SECRET = 'test-capability-secret';
const APP_ID = 'test-app-id';
const APP_SECRET = 'test-app-secret-never-leaks';
const OFFER = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n';

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
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
  return res;
}

function makeReq(body) {
  return { method: 'POST', body };
}

function capability(tuple, ttlMs = 60_000) {
  return signCapability(SECRET, tuple, Date.now() + ttlMs);
}

/**
 * Replace global fetch with a recorder. `responder(url, init, callIndex)`
 * returns the parsed JSON body Cloudflare would send back.
 * Returns the list of recorded calls, with the request body already parsed
 * (or `undefined` when no body was sent at all — a distinction that matters:
 * `sessions/new` must be called with NO body, and `{}` is not the same thing).
 */
function stubFetch(responder) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const index = calls.length;
    calls.push({
      url,
      method: init.method,
      headers: init.headers || {},
      rawBody: init.body,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    });
    const result = await responder(url, init, index);
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
test.afterEach(() => { globalThis.fetch = realFetch; });

const PUBLISH_TUPLE = { roomCode: 'room-abc', participantId: 'peer-1', kind: 'video', action: 'publish' };
const SUBSCRIBE_TUPLE = { roomCode: 'room-abc', participantId: 'peer-2', kind: 'video', action: 'subscribe' };

function publishBody(overrides = {}) {
  return {
    ...PUBLISH_TUPLE,
    capability: capability(PUBLISH_TUPLE),
    offer: OFFER,
    tracks: [{ location: 'local', mid: '0', trackName: 'peer-1-video' }],
    ...overrides,
  };
}

// --- the regression this file exists for -------------------------------------

test('publish: sessions/new is called with NO request body', async () => {
  configure();
  const calls = stubFetch((url, init, i) =>
    i === 0
      ? { sessionId: 'cf-sess-1' }
      : { sessionDescription: { type: 'answer', sdp: 'answer-sdp' }, requiresImmediateRenegotiation: false });

  const res = makeRes();
  await handler(makeReq(publishBody()), res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.match(calls[0].url, /\/sessions\/new$/);
  // The offer belongs on tracks/new. Sending it here — or sending any body at
  // all — makes Cloudflare reject the subsequent track push with
  // `session_error: Session is not ready yet`.
  assert.equal(calls[0].rawBody, undefined, 'sessions/new must send no body');
  assert.equal(calls[0].headers['content-type'], undefined);
});

test('publish: tracks/new carries the offer and the local tracks[]', async () => {
  configure();
  const calls = stubFetch((url, init, i) =>
    i === 0
      ? { sessionId: 'cf-sess-1' }
      : { sessionDescription: { type: 'answer', sdp: 'answer-sdp' }, requiresImmediateRenegotiation: false });

  const res = makeRes();
  await handler(makeReq(publishBody()), res);

  assert.match(calls[1].url, /\/sessions\/cf-sess-1\/tracks\/new$/);
  assert.deepEqual(calls[1].body.sessionDescription, { type: 'offer', sdp: OFFER });
  assert.deepEqual(calls[1].body.tracks, [{ location: 'local', mid: '0', trackName: 'peer-1-video' }]);
  // The answer must come from tracks/new, not from sessions/new.
  assert.deepEqual(res.body.sessionDescription, { type: 'answer', sdp: 'answer-sdp' });
  assert.equal(res.body.sessionId, 'cf-sess-1');
});

test('subscribe: sessions/new sends no body and tracks/new names the remote track', async () => {
  configure();
  const calls = stubFetch((url, init, i) =>
    i === 0
      ? { sessionId: 'cf-sess-2' }
      : { sessionDescription: { type: 'offer', sdp: 'cf-offer' }, requiresImmediateRenegotiation: true });

  const res = makeRes();
  await handler(makeReq({
    ...SUBSCRIBE_TUPLE,
    capability: capability(SUBSCRIBE_TUPLE),
    tracks: [{ location: 'remote', sessionId: 'cf-sess-1', trackName: 'peer-1-video' }],
  }), res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(calls[0].rawBody, undefined, 'sessions/new must send no body');
  // A remote pull is driven by Cloudflare: no local SDP goes up, and what
  // comes back is an OFFER the client must answer via /api/sfu-renegotiate.
  assert.equal(calls[1].body.sessionDescription, undefined);
  assert.deepEqual(calls[1].body.tracks, [
    { location: 'remote', sessionId: 'cf-sess-1', trackName: 'peer-1-video' },
  ]);
  assert.equal(res.body.requiresImmediateRenegotiation, true);
  assert.deepEqual(res.body.sessionDescription, { type: 'offer', sdp: 'cf-offer' });
});

test('an existing sessionId skips sessions/new entirely', async () => {
  configure();
  const calls = stubFetch(() => ({
    sessionDescription: { type: 'answer', sdp: 'answer-sdp' },
    requiresImmediateRenegotiation: false,
  }));

  const res = makeRes();
  await handler(makeReq(publishBody({ sessionId: 'cf-existing' })), res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/sessions\/cf-existing\/tracks\/new$/);
});

// --- error surfacing ---------------------------------------------------------

test('a per-track Cloudflare error inside a 200 becomes a 502 with the reason', async () => {
  configure();
  stubFetch((url, init, i) =>
    i === 0
      ? { sessionId: 'cf-sess-1' }
      : {
          sessionDescription: { type: 'answer', sdp: 'answer-sdp' },
          requiresImmediateRenegotiation: false,
          tracks: [{ trackName: 'peer-1-video', errorCode: 'track_error', errorDescription: 'no such track' }],
        });

  const res = makeRes();
  await handler(makeReq(publishBody()), res);

  assert.equal(res.statusCode, 502);
  assert.match(res.body.detail, /track_error: no such track/);
});

test('a session-creation error inside a 200 becomes a 502 rather than a confusing downstream failure', async () => {
  configure();
  const calls = stubFetch(() => ({ errorCode: 'session_error', errorDescription: 'nope' }));

  const res = makeRes();
  await handler(makeReq(publishBody()), res);

  assert.equal(res.statusCode, 502);
  assert.match(res.body.detail, /session_error: nope/);
  assert.equal(calls.length, 1, 'must not push tracks into a session that failed to create');
});

test('a non-2xx from Cloudflare surfaces its response body as detail', async () => {
  configure();
  stubFetch(() => ({
    __status: 400,
    payload: { errorCode: 'session_error', errorDescription: 'Session is not ready yet' },
  }));

  const res = makeRes();
  await handler(makeReq(publishBody()), res);

  assert.equal(res.statusCode, 502);
  assert.match(res.body.detail, /Session is not ready yet/);
});

// --- guards ------------------------------------------------------------------

test('missing tracks[] is rejected before anything reaches Cloudflare', async () => {
  configure();
  const calls = stubFetch(() => ({ sessionId: 'cf-sess-1' }));

  const res = makeRes();
  await handler(makeReq(publishBody({ tracks: [] })), res);

  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
});

test('a publish without an SDP offer is rejected', async () => {
  configure();
  const calls = stubFetch(() => ({ sessionId: 'cf-sess-1' }));

  const res = makeRes();
  await handler(makeReq(publishBody({ offer: undefined })), res);

  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
});

test('a capability token minted for a different tuple is rejected', async () => {
  configure();
  const calls = stubFetch(() => ({ sessionId: 'cf-sess-1' }));

  const res = makeRes();
  // Token says 'screen', the request says 'video'.
  await handler(makeReq(publishBody({
    capability: capability({ ...PUBLISH_TUPLE, kind: 'screen' }),
  })), res);

  assert.equal(res.statusCode, 403);
  assert.equal(calls.length, 0, 'an unauthorized request must never reach Cloudflare');
});

test('an unconfigured deployment returns 503 without calling Cloudflare', async () => {
  configure({ CF_SFU_APP_SECRET: undefined });
  const calls = stubFetch(() => ({ sessionId: 'cf-sess-1' }));

  const res = makeRes();
  await handler(makeReq(publishBody()), res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'not_configured');
  assert.equal(calls.length, 0);
  configure();
});

test('the Cloudflare app secret is sent to Cloudflare and never to the client', async () => {
  configure();
  const calls = stubFetch(() => ({
    __status: 500,
    payload: { errorDescription: 'boom' },
  }));

  const res = makeRes();
  await handler(makeReq(publishBody()), res);

  assert.equal(calls[0].headers.authorization, `Bearer ${APP_SECRET}`);
  assert.ok(!JSON.stringify(res.body).includes(APP_SECRET), 'response must not leak the app secret');
});
