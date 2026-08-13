// Completes the SDP exchange for a Cloudflare Realtime SFU subscription.
//
// Pulling a REMOTE track (see api/sfu-track.js) makes Cloudflare answer with
// an *offer* plus `requiresImmediateRenegotiation`, rather than an answer to
// ours — it has to describe the track it is about to forward. The subscribing
// client answers that offer and sends it here, which closes the loop and lets
// media actually flow. Without this leg the subscriber holds a negotiated
// transceiver that never receives anything: a connected session and a
// permanently black video tile.
//
// Authorization is identical to api/sfu-track.js — the same short-lived,
// HMAC-signed capability token scoped to {roomCode, participantId, kind,
// action}, verified here before anything reaches Cloudflare. The Cloudflare
// app secret never leaves the server.
//
// Scope: video and screen-share ONLY, same boundary as the other SFU
// endpoints. Voice/PTT audio never reaches this code path.
//
// Env:
//   SFU_CAPABILITY_SECRET — must match api/sfu-session.js's signing secret
//   CF_SFU_APP_ID          — Cloudflare Realtime (Calls) app id
//   CF_SFU_APP_SECRET      — Cloudflare Realtime app secret (never logged, never returned)

import { verifyCapability, sfuRenegotiateUrl, cloudflareTrackError } from './_sfu.js';

async function callCloudflare(url, appSecret, body) {
  const res = await fetch(url, {
    method: 'PUT',
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
  const { capability, roomCode, participantId, kind, action, answer, sessionId } = body;
  if (typeof answer !== 'string' || !answer) {
    res.status(400).json({ error: 'invalid_request', message: 'missing sdp answer' });
    return;
  }
  if (typeof sessionId !== 'string' || !sessionId) {
    res.status(400).json({ error: 'invalid_request', message: 'missing sessionId' });
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
    const result = await callCloudflare(sfuRenegotiateUrl(appId, sessionId), appSecret, {
      sessionDescription: { type: 'answer', sdp: answer },
    });
    const trackErr = cloudflareTrackError(result);
    if (trackErr) {
      const err = new Error('Cloudflare rejected the renegotiation');
      err.detail = trackErr;
      throw err;
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[sfu-renegotiate] failed:', err.message, err.detail || '');
    res.status(502).json({ error: 'renegotiate_failed', message: err.message, detail: err.detail || undefined });
  }
}
