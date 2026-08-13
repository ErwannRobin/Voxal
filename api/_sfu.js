// Pure helpers behind the Cloudflare Realtime SFU integration. Kept separate
// from the handlers (api/sfu-session.js, api/sfu-track.js) so the capability
// token logic can be unit-tested with `node --test` and no network — the same
// split api/_turn.js uses for the TURN endpoint.
//
// Scope: this backs VIDEO and SCREEN-SHARE routing only. Voice/PTT audio never
// goes through this endpoint, this token, or Cloudflare's SFU, under any
// setting — see docs/video-routing.md and the note next to the TURN privacy
// guarantee in docs/turn-and-ice.md for why that boundary is permanent.
//
// Cloudflare Realtime (Calls) API base — distinct product/billing line from the
// TURN service api/_turn.js talks to. An SFU decrypts media to selectively
// forward it, unlike TURN which only relays opaque encrypted DTLS-SRTP; that is
// exactly why this endpoint is scoped to video/screen and never audio.
import crypto from 'node:crypto';

export const CF_SFU_API = 'https://rtc.live.cloudflare.com/v1/apps';

export function sfuSessionsUrl(appId) {
  return `${CF_SFU_API}/${encodeURIComponent(appId)}/sessions/new`;
}

export function sfuTracksUrl(appId, sessionId) {
  return `${CF_SFU_API}/${encodeURIComponent(appId)}/sessions/${encodeURIComponent(sessionId)}/tracks/new`;
}

// Pulling a REMOTE track makes Cloudflare answer with an *offer* plus
// `requiresImmediateRenegotiation`, which the client must answer back here.
// Without this leg a subscriber negotiates a transceiver that never receives
// media — which is exactly how the first version of this integration
// presented: a connected session and a permanently black video tile.
export function sfuRenegotiateUrl(appId, sessionId) {
  return `${CF_SFU_API}/${encodeURIComponent(appId)}/sessions/${encodeURIComponent(sessionId)}/renegotiate`;
}

/**
 * Cloudflare reports track-level failures inside a 200 response
 * (`tracks[].errorCode` / `.errorDescription`) as well as at the top level, so
 * an HTTP-status-only check silently accepts a session that will never carry
 * media. Returns a short human-readable reason, or '' when nothing failed.
 * Never includes anything we signed or sent — only Cloudflare's own words.
 */
export function cloudflareTrackError(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  if (parsed.errorCode || parsed.errorDescription) {
    return [parsed.errorCode, parsed.errorDescription].filter(Boolean).join(': ');
  }
  const tracks = Array.isArray(parsed.tracks) ? parsed.tracks : [];
  for (const t of tracks) {
    if (t && (t.errorCode || t.errorDescription)) {
      const who = t.trackName ? ` (track ${t.trackName})` : '';
      return [t.errorCode, t.errorDescription].filter(Boolean).join(': ') + who;
    }
  }
  return '';
}

const VALID_KINDS = new Set(['video', 'screen']);
const VALID_ACTIONS = new Set(['publish', 'subscribe']);

function base64urlEncode(input) {
  return Buffer.from(input).toString('base64url');
}

function base64urlDecode(input) {
  return Buffer.from(input, 'base64url');
}

function hmacDigest(secret, payloadB64) {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest();
}

/**
 * Mint an opaque, short-lived capability token binding one participant to one
 * room + track-kind + action. Format: base64url(JSON payload) + '.' +
 * base64url(HMAC-SHA256 of the payload).
 *
 * This is deliberately NOT proof that `participantId` is currently present in
 * `roomCode` — Voxal has no server-side room registry (see docs/video-routing.md
 * "Authorization model"). It only proves the token was issued by this server for
 * exactly this tuple, before `exp`. Same posture api/ice-servers.js already has
 * for TURN: anonymous, rate-limited, no membership check.
 */
export function signCapability(secret, { roomCode, participantId, kind, action }, exp) {
  const payload = { roomCode, participantId, kind, action, exp };
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const sig = hmacDigest(secret, payloadB64).toString('base64url');
  return `${payloadB64}.${sig}`;
}

/**
 * Verify a capability token against the expected tuple and current time.
 * Returns { valid: true, payload } or { valid: false, error }.
 */
export function verifyCapability(secret, token, expected, now) {
  if (typeof token !== 'string' || !token.includes('.')) {
    return { valid: false, error: 'malformed' };
  }
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return { valid: false, error: 'malformed' };

  const expectedSig = hmacDigest(secret, payloadB64);
  let providedSig;
  try {
    providedSig = base64urlDecode(sig);
  } catch {
    return { valid: false, error: 'malformed' };
  }
  // Constant-time compare, and only ever on equal-length buffers — a length
  // mismatch is itself a safe, non-timing-sensitive rejection.
  if (providedSig.length !== expectedSig.length || !crypto.timingSafeEqual(providedSig, expectedSig)) {
    return { valid: false, error: 'bad_signature' };
  }

  let payload;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString('utf8'));
  } catch {
    return { valid: false, error: 'malformed' };
  }

  if (typeof payload.exp !== 'number' || now >= payload.exp) {
    return { valid: false, error: 'expired' };
  }
  if (
    payload.roomCode !== expected.roomCode ||
    payload.participantId !== expected.participantId ||
    payload.kind !== expected.kind ||
    payload.action !== expected.action
  ) {
    return { valid: false, error: 'tuple_mismatch' };
  }

  return { valid: true, payload };
}

/** Validate the shape of a mint request body before touching the signer. */
export function validateMintRequest(body) {
  if (!body || typeof body !== 'object') return { valid: false, error: 'invalid_body' };
  const { roomCode, participantId, kind, action } = body;
  if (typeof roomCode !== 'string' || !roomCode) return { valid: false, error: 'invalid_room_code' };
  if (typeof participantId !== 'string' || !participantId) return { valid: false, error: 'invalid_participant_id' };
  if (!VALID_KINDS.has(kind)) return { valid: false, error: 'invalid_kind' };
  if (!VALID_ACTIONS.has(action)) return { valid: false, error: 'invalid_action' };
  return { valid: true };
}
