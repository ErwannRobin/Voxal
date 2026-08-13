// Pure-logic tests for the SFU capability-token endpoint. `node --test`, zero
// deps, no network — mirrors api/_turn.test.js's shape.
import test from 'node:test';
import assert from 'node:assert';

import {
  signCapability,
  verifyCapability,
  validateMintRequest,
  sfuSessionsUrl,
  sfuTracksUrl,
  sfuRenegotiateUrl,
  cloudflareTrackError,
} from './_sfu.js';

const SECRET = 'test-secret-do-not-use-in-prod';
const TUPLE = { roomCode: 'room-abc', participantId: 'peer-123', kind: 'video', action: 'publish' };

test('signCapability + verifyCapability round-trip for a valid token', () => {
  const token = signCapability(SECRET, TUPLE, 1_000_000);
  const result = verifyCapability(SECRET, token, TUPLE, 500_000);
  assert.equal(result.valid, true);
  assert.equal(result.payload.roomCode, TUPLE.roomCode);
  assert.equal(result.payload.participantId, TUPLE.participantId);
});

test('verifyCapability rejects an expired token', () => {
  const token = signCapability(SECRET, TUPLE, 1_000_000);
  const result = verifyCapability(SECRET, token, TUPLE, 1_000_000);
  assert.equal(result.valid, false);
  assert.equal(result.error, 'expired');
});

test('verifyCapability rejects a tampered payload', () => {
  const token = signCapability(SECRET, TUPLE, 1_000_000);
  const [, sig] = token.split('.');
  const tamperedPayload = Buffer.from(
    JSON.stringify({ ...TUPLE, participantId: 'someone-else', exp: 1_000_000 })
  ).toString('base64url');
  const tampered = `${tamperedPayload}.${sig}`;
  const result = verifyCapability(SECRET, tampered, { ...TUPLE, participantId: 'someone-else' }, 500_000);
  assert.equal(result.valid, false);
  assert.equal(result.error, 'bad_signature');
});

test('verifyCapability rejects a tampered signature', () => {
  const token = signCapability(SECRET, TUPLE, 1_000_000);
  const [payloadB64] = token.split('.');
  const forged = `${payloadB64}.${Buffer.from('not-the-real-signature-bytes!!!!').toString('base64url')}`;
  const result = verifyCapability(SECRET, forged, TUPLE, 500_000);
  assert.equal(result.valid, false);
  assert.equal(result.error, 'bad_signature');
});

test('verifyCapability rejects when the wrong secret signed it', () => {
  const token = signCapability('a-different-secret', TUPLE, 1_000_000);
  const result = verifyCapability(SECRET, token, TUPLE, 500_000);
  assert.equal(result.valid, false);
  assert.equal(result.error, 'bad_signature');
});

test('verifyCapability rejects a token minted for a different room, participant, or kind', () => {
  const token = signCapability(SECRET, TUPLE, 1_000_000);
  assert.equal(
    verifyCapability(SECRET, token, { ...TUPLE, roomCode: 'other-room' }, 500_000).error,
    'tuple_mismatch'
  );
  assert.equal(
    verifyCapability(SECRET, token, { ...TUPLE, participantId: 'other-peer' }, 500_000).error,
    'tuple_mismatch'
  );
  assert.equal(
    verifyCapability(SECRET, token, { ...TUPLE, kind: 'screen' }, 500_000).error,
    'tuple_mismatch'
  );
  assert.equal(
    verifyCapability(SECRET, token, { ...TUPLE, action: 'subscribe' }, 500_000).error,
    'tuple_mismatch'
  );
});

test('verifyCapability rejects malformed tokens', () => {
  assert.equal(verifyCapability(SECRET, '', TUPLE, 0).error, 'malformed');
  assert.equal(verifyCapability(SECRET, 'no-dot-here', TUPLE, 0).error, 'malformed');
  assert.equal(verifyCapability(SECRET, 'a.', TUPLE, 0).error, 'malformed');
  assert.equal(verifyCapability(SECRET, '.b', TUPLE, 0).error, 'malformed');
  assert.equal(verifyCapability(SECRET, undefined, TUPLE, 0).error, 'malformed');
});

test('validateMintRequest accepts a well-formed body', () => {
  assert.equal(validateMintRequest(TUPLE).valid, true);
});

test('validateMintRequest rejects missing or malformed fields', () => {
  assert.equal(validateMintRequest(null).valid, false);
  assert.equal(validateMintRequest({}).valid, false);
  assert.equal(validateMintRequest({ ...TUPLE, roomCode: '' }).valid, false);
  assert.equal(validateMintRequest({ ...TUPLE, participantId: 42 }).valid, false);
  assert.equal(validateMintRequest({ ...TUPLE, kind: 'audio' }).valid, false, 'audio must never be a valid kind');
  assert.equal(validateMintRequest({ ...TUPLE, action: 'delete' }).valid, false);
});

test('sfuSessionsUrl and sfuTracksUrl build and escape Cloudflare Realtime URLs', () => {
  assert.equal(sfuSessionsUrl('app1'), 'https://rtc.live.cloudflare.com/v1/apps/app1/sessions/new');
  assert.equal(
    sfuTracksUrl('app1', 'sess1'),
    'https://rtc.live.cloudflare.com/v1/apps/app1/sessions/sess1/tracks/new'
  );
  assert.ok(sfuSessionsUrl('a/b').includes('a%2Fb'));
  assert.ok(sfuTracksUrl('app1', 'a/b').includes('a%2Fb'));
});

test('sfuRenegotiateUrl builds and escapes the renegotiate endpoint', () => {
  assert.equal(
    sfuRenegotiateUrl('app1', 'sess1'),
    'https://rtc.live.cloudflare.com/v1/apps/app1/sessions/sess1/renegotiate'
  );
  assert.ok(sfuRenegotiateUrl('a/b', 'sess1').includes('a%2Fb'));
  assert.ok(sfuRenegotiateUrl('app1', 'a/b').includes('a%2Fb'));
});

test('cloudflareTrackError surfaces per-track failures hidden inside a 200 response', () => {
  // The failure mode this exists for: Cloudflare answers 200 while rejecting
  // the individual track, so an HTTP-status-only check hands back a session
  // that forwards no media at all.
  assert.equal(cloudflareTrackError(null), '');
  assert.equal(cloudflareTrackError({}), '');
  assert.equal(cloudflareTrackError({ tracks: [{ trackName: 'ok' }] }), '');

  assert.match(
    cloudflareTrackError({ tracks: [{ trackName: 'peer-video', errorCode: 'no_such_track', errorDescription: 'not found' }] }),
    /no_such_track: not found \(track peer-video\)/
  );
  assert.match(
    cloudflareTrackError({ errorCode: 'bad_session', errorDescription: 'expired' }),
    /bad_session: expired/
  );
});
