// Negotiates media with Cloudflare's Realtime SFU on behalf of an already-
// authorized client. This is the ONLY place the Cloudflare Realtime app secret
// is used — the client never sees it, mirroring how api/ice-servers.js never
// returns CF_TURN_TOKEN_SECRET.
//
// The client must first call POST /api/sfu-session (api/sfu-session.js) to get
// a `capability` token scoped to {roomCode, participantId, kind, action}. This
// endpoint verifies that token, then proxies the client's local SDP offer to
// Cloudflare's `sessions/new` (first publish/subscribe for this participant in
// this room) or `tracks/new` (adding a track to an existing session — reuses
// `sessionId` so a participant doesn't need a new Cloudflare session per track)
// and returns Cloudflare's SDP answer.
//
// NOTE for implementers: Cloudflare's exact Realtime (Calls) request/response
// shape for sessions/new and tracks/new should be re-verified against current
// Cloudflare docs before shipping this to production — this proxies a
// reasonable/expected shape but has not been exercised against a live
// Cloudflare account (see the plan's open questions on renegotiation support
// and whether the client<->SFU leg needs its own STUN/TURN).
//
// Scope: video and screen-share ONLY, same boundary as api/sfu-session.js.
//
// Env:
//   SFU_CAPABILITY_SECRET — must match api/sfu-session.js's signing secret
//   CF_SFU_APP_ID          — Cloudflare Realtime (Calls) app id
//   CF_SFU_APP_SECRET      — Cloudflare Realtime app secret (never logged, never returned)

import { verifyCapability, sfuSessionsUrl, sfuTracksUrl } from './_sfu.js';

async function callCloudflare(url, appSecret, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${appSecret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const detail = await res.text().catch(() => '');
  let parsed = null;
  try { parsed = detail ? JSON.parse(detail) : null; } catch { /* leave null, surface raw below */ }
  if (!res.ok) {
    const err = new Error(`Cloudflare Realtime API returned ${res.status}`);
    err.status = res.status;
    // Never surface the bearer token — only Cloudflare's own response body.
    err.detail = detail.slice(0, 300);
    throw err;
  }
  return parsed;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const capabilitySecret = process.env.SFU_CAPABILITY_SECRET;
  const appId = process.env.CF_SFU_APP_ID;
  const appSecret = process.env.CF_SFU_APP_SECRET;
  if (!capabilitySecret || !appId || !appSecret) {
    res.status(503).json({
      error: 'not_configured',
      message: 'No SFU provider configured on this deployment.',
    });
    return;
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { capability, roomCode, participantId, kind, action, offer, sessionId } = body;
  if (typeof offer !== 'string' || !offer) {
    res.status(400).json({ error: 'invalid_request', message: 'missing sdp offer' });
    return;
  }

  const verified = verifyCapability(
    capabilitySecret,
    capability,
    { roomCode, participantId, kind, action },
    Date.now()
  );
  if (!verified.valid) {
    res.status(403).json({ error: 'unauthorized', message: verified.error });
    return;
  }

  try {
    let cfSessionId = sessionId;
    let answer;

    if (!cfSessionId) {
      const created = await callCloudflare(sfuSessionsUrl(appId), appSecret, {
        sessionDescription: { type: 'offer', sdp: offer },
      });
      cfSessionId = created && created.sessionId;
      answer = created && created.sessionDescription;
      if (!cfSessionId || !answer) throw new Error('Cloudflare Realtime API returned no session');
    } else {
      const tracked = await callCloudflare(sfuTracksUrl(appId, cfSessionId), appSecret, {
        sessionDescription: { type: 'offer', sdp: offer },
      });
      answer = tracked && tracked.sessionDescription;
      if (!answer) throw new Error('Cloudflare Realtime API returned no answer');
    }

    res.status(200).json({ sessionId: cfSessionId, answer: answer.sdp || answer });
  } catch (err) {
    console.error('[sfu-track] negotiate failed:', err.message, err.detail || '');
    res.status(502).json({ error: 'negotiate_failed', message: err.message });
  }
}
