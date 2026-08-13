// Negotiates media with Cloudflare's Realtime SFU on behalf of an already-
// authorized client. This is the ONLY place the Cloudflare Realtime app secret
// is used — the client never sees it, mirroring how api/ice-servers.js never
// returns CF_TURN_TOKEN_SECRET.
//
// The client must first call POST /api/sfu-session (api/sfu-session.js) to get
// a `capability` token scoped to {roomCode, participantId, kind, action}. This
// endpoint verifies that token, then proxies to Cloudflare:
//
//   publish   — POST sessions/new {sessionDescription: offer}   -> {sessionId, sessionDescription: answer}
//               POST sessions/{id}/tracks/new
//                 {tracks:[{location:'local', mid, trackName}], sessionDescription}
//   subscribe — POST sessions/new {sessionDescription: offer}   -> {sessionId, ...}
//               POST sessions/{id}/tracks/new
//                 {tracks:[{location:'remote', sessionId:<publisher>, trackName}]}
//               -> Cloudflare replies with an OFFER and requiresImmediateRenegotiation,
//                  which the client answers via /api/sfu-renegotiate.
//
// The `tracks` array is the part that actually routes media. Omitting it (as
// an earlier version of this file did) still yields a healthy-looking session
// and SDP exchange while Cloudflare forwards nothing at all — the failure
// mode is a connected peer connection whose video tile stays black.
//
// This endpoint deliberately does NOT flatten Cloudflare's answer: it returns
// sessionDescription/requiresImmediateRenegotiation/tracks as-is so the client
// can tell an offer from an answer, and surfaces Cloudflare's own
// errorCode/errorDescription (which can appear on a 200 response, per track)
// rather than reporting success for a session that will never carry media.
//
// Scope: video and screen-share ONLY, same boundary as api/sfu-session.js.
//
// Env:
//   SFU_CAPABILITY_SECRET — must match api/sfu-session.js's signing secret
//   CF_SFU_APP_ID          — Cloudflare Realtime (Calls) app id
//   CF_SFU_APP_SECRET      — Cloudflare Realtime app secret (never logged, never returned)

import { verifyCapability, sfuSessionsUrl, sfuTracksUrl, cloudflareTrackError } from './_sfu.js';

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
  const { capability, roomCode, participantId, kind, action, offer, sessionId, tracks } = body;

  if (!Array.isArray(tracks) || !tracks.length) {
    // Without this the SFU has nothing to route: the session negotiates fine
    // and forwards no media. Reject loudly rather than returning a session
    // that can only ever produce a black tile.
    res.status(400).json({ error: 'invalid_request', message: 'missing tracks[]' });
    return;
  }
  // A local (publish) track carries its own SDP; a remote (subscribe) pull is
  // driven by Cloudflare, which generates the offer, so no SDP is required.
  const needsOffer = tracks.some((t) => t && t.location !== 'remote');
  if (needsOffer && (typeof offer !== 'string' || !offer)) {
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

    // Establish the transport first if this client has no session yet. Its
    // answer is discarded for the remote-pull case — Cloudflare re-offers
    // below once it knows which track to forward.
    let created = null;
    if (!cfSessionId) {
      created = await callCloudflare(sfuSessionsUrl(appId), appSecret, {
        sessionDescription: offer ? { type: 'offer', sdp: offer } : undefined,
      });
      cfSessionId = created && created.sessionId;
      if (!cfSessionId) throw new Error('Cloudflare Realtime API returned no sessionId');
    }

    const trackBody = { tracks };
    if (needsOffer) trackBody.sessionDescription = { type: 'offer', sdp: offer };
    const tracked = await callCloudflare(sfuTracksUrl(appId, cfSessionId), appSecret, trackBody);

    // Cloudflare reports per-track failures inside a 200 — treat those as
    // errors rather than handing back a session that forwards nothing.
    const trackErr = cloudflareTrackError(tracked);
    if (trackErr) {
      const err = new Error('Cloudflare rejected the track');
      err.detail = trackErr;
      throw err;
    }

    // For a publish the useful SDP is the session answer; for a remote pull
    // it is the tracks/new response, which is an OFFER needing renegotiation.
    const sessionDescription = (tracked && tracked.sessionDescription)
      || (created && created.sessionDescription)
      || null;

    res.status(200).json({
      sessionId: cfSessionId,
      sessionDescription,
      requiresImmediateRenegotiation: !!(tracked && tracked.requiresImmediateRenegotiation),
      tracks: (tracked && tracked.tracks) || [],
    });
  } catch (err) {
    console.error('[sfu-track] negotiate failed:', err.message, err.detail || '');
    // err.detail is Cloudflare's own error text (never our request/secret) —
    // returning it is what makes a failure diagnosable from the client's dev
    // log instead of surfacing as an unexplained black video tile.
    res.status(502).json({ error: 'negotiate_failed', message: err.message, detail: err.detail || undefined });
  }
}
