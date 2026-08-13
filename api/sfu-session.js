// Mints a short-lived capability token authorizing ONE participant to publish
// or subscribe ONE video-or-screen track kind in ONE room, over Cloudflare's
// Realtime SFU. This endpoint never talks to Cloudflare — it's the cheap,
// rate-limited "may I?" step. The client then presents the returned token to
// POST /api/sfu-track (api/sfu-track.js), which actually negotiates media with
// Cloudflare and is the only place the Cloudflare app secret is used.
//
// Scope: video and screen-share ONLY. Voice/PTT audio never calls this endpoint
// and is never routed through Cloudflare's SFU, under any setting — see
// docs/video-routing.md.
//
// Authorization model (see docs/video-routing.md "Authorization model" for the
// full writeup): the token proves the server issued it for this exact
// {roomCode, participantId, kind, action} tuple before it expires. It does NOT
// prove the participant is genuinely present in that PeerJS room right now —
// Voxal has no server-side room registry (same posture api/ice-servers.js
// already has for anonymous TURN: rate-limited, not membership-checked).
//
// Env:
//   SFU_CAPABILITY_SECRET — HMAC signing secret for capability tokens (required;
//                            distinct from CF_SFU_APP_SECRET so rotating one
//                            never requires rotating the other)
//   SFU_CAPABILITY_TTL    — token lifetime in seconds (default 300)
//   SFU_RATE_LIMIT         — requests per IP per window (default 30)
//   CF_SFU_APP_ID          — Cloudflare Realtime (Calls) app id (required; public,
//                            returned to the client — not a secret)

import { validateMintRequest, signCapability } from './_sfu.js';
import { rateLimit, pruneHits, clientIp } from './_shared.js';

const DEFAULT_TTL = 300;
const RATE_WINDOW_MS = 60 * 1000;
const DEFAULT_RATE_LIMIT = 30;

const _hits = new Map();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const secret = process.env.SFU_CAPABILITY_SECRET;
  const appId = process.env.CF_SFU_APP_ID;
  if (!secret || !appId) {
    res.status(503).json({
      error: 'not_configured',
      message: 'No SFU provider configured on this deployment. Set CF_SFU_APP_ID and SFU_CAPABILITY_SECRET.',
    });
    return;
  }

  const now = Date.now();
  pruneHits(_hits, now, RATE_WINDOW_MS);
  const limit = Number(process.env.SFU_RATE_LIMIT) > 0 ? Number(process.env.SFU_RATE_LIMIT) : DEFAULT_RATE_LIMIT;
  const gate = rateLimit(_hits, clientIp(req.headers || {}), now, limit, RATE_WINDOW_MS);
  if (!gate.allowed) {
    res.setHeader('Retry-After', String(gate.retryAfter));
    res.status(429).json({ error: 'rate_limited', retry_after: gate.retryAfter });
    return;
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const check = validateMintRequest(body);
  if (!check.valid) {
    res.status(400).json({ error: 'invalid_request', message: check.error });
    return;
  }

  const ttl = Number(process.env.SFU_CAPABILITY_TTL) > 0 ? Number(process.env.SFU_CAPABILITY_TTL) : DEFAULT_TTL;
  const exp = now + ttl * 1000;
  const capability = signCapability(secret, {
    roomCode: body.roomCode,
    participantId: body.participantId,
    kind: body.kind,
    action: body.action,
  }, exp);

  res.status(200).json({
    capability,
    expires_at: new Date(exp).toISOString(),
    sfu_app_id: appId,
  });
}
