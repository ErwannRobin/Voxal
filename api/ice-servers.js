// Anonymous TURN credentials for Voxal.
//
// The app is static files, so a relay API key can never ship inside it — anyone
// could read it and drain the quota. This endpoint holds the secret instead and
// hands out SHORT-LIVED credentials that anonymous users can use to connect
// through a relay when a direct/STUN path is impossible (symmetric NAT, strict
// corporate firewalls).
//
// Backed by Cloudflare's standalone TURN service, which relays encrypted
// DTLS-SRTP and therefore cannot hear the audio — the privacy guarantee in
// docs/turn-and-ice.md still holds. (This is NOT the Cloudflare SFU, which would
// decrypt media; that was deliberately rejected.)
//
// Env:
//   CF_TURN_TOKEN_ID      — TURN key id      (Cloudflare dashboard → Realtime → TURN)
//   CF_TURN_TOKEN_SECRET  — TURN key secret  (never logged, never returned)
//   CF_TURN_TTL           — credential lifetime in seconds (default 3600)
//   ICE_RATE_LIMIT        — requests per IP per window (default 30)

import {
  toIceServers,
  isCacheFresh,
  rateLimit,
  pruneHits,
  clientIp,
  credentialsUrl,
} from './_turn.js';

const DEFAULT_TTL = 3600;
const RATE_WINDOW_MS = 60 * 1000;
const DEFAULT_RATE_LIMIT = 30;
// How long the CDN may serve one mint. Short relative to CF_TURN_TTL (3600s)
// so an edge hit always has plenty of credential life left.
const EDGE_CACHE_SECONDS = 300;

// Module scope: survives between invocations on a warm instance, resets on a
// cold start. Both of these are caches, so losing them is never incorrect.
let _cache = null;
const _hits = new Map();

async function mintCredentials(tokenId, tokenSecret, ttl) {
  const res = await fetch(credentialsUrl(tokenId), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tokenSecret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ttl }),
  });

  // Cloudflare answers 201 Created on success.
  if (res.status !== 201) {
    const detail = await res.text().catch(() => '');
    // Surface the status but never the request we signed — the bearer token
    // must not reach a log line or a response body.
    const err = new Error(`Cloudflare TURN API returned ${res.status}`);
    err.status = res.status;
    err.detail = detail.slice(0, 200);
    throw err;
  }
  return res.json();
}

export default async function handler(req, res) {
  // Native apps (Capacitor/Tauri) have no usable Origin, so this has to be open.
  // Acceptable: the body carries a time-boxed credential and never the secret.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  // The BROWSER must never cache this: a cached credential is one that outlives
  // its own expiry, the exact failure KNOWLEDGE/learning.md records for the
  // anonymous-rooms GETs. The client keeps its own in-memory copy and checks
  // expires_at explicitly.
  res.setHeader('Cache-Control', 'no-store');
  // The EDGE may, and should. Every caller already receives the same credential
  // — the module cache below hands out one mint for ~80% of its TTL — so edge
  // caching changes only WHO serves it, not what. It removes the cold-start
  // latency that was showing up as a slow relay resolve on the welcome screen.
  // Well under the TTL, so a client never receives one close to expiry.
  res.setHeader('Vercel-CDN-Cache-Control', `max-age=${EDGE_CACHE_SECONDS}`);
  res.setHeader('CDN-Cache-Control', `max-age=${EDGE_CACHE_SECONDS}`);

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const tokenId = process.env.CF_TURN_TOKEN_ID;
  const tokenSecret = process.env.CF_TURN_TOKEN_SECRET;
  if (!tokenId || !tokenSecret) {
    res.status(503).json({
      error: 'not_configured',
      message: 'No TURN provider configured on this deployment. Set CF_TURN_TOKEN_ID and CF_TURN_TOKEN_SECRET.',
    });
    return;
  }

  const ttl = Number(process.env.CF_TURN_TTL) > 0 ? Number(process.env.CF_TURN_TTL) : DEFAULT_TTL;
  const limit = Number(process.env.ICE_RATE_LIMIT) > 0 ? Number(process.env.ICE_RATE_LIMIT) : DEFAULT_RATE_LIMIT;
  const now = Date.now();

  pruneHits(_hits, now, RATE_WINDOW_MS);
  const gate = rateLimit(_hits, clientIp(req.headers || {}), now, limit, RATE_WINDOW_MS);
  if (!gate.allowed) {
    res.setHeader('Retry-After', String(gate.retryAfter));
    res.status(429).json({ error: 'rate_limited', retry_after: gate.retryAfter });
    return;
  }

  // Serve the cached credential for most of its life. This is what makes request
  // volume free: N callers cost one Cloudflare API call per refresh window.
  if (isCacheFresh(_cache, now)) {
    res.status(200).json({
      ice_servers: _cache.iceServers,
      ttl: _cache.ttl,
      expires_at: _cache.expiresAt,
      cached: true,
    });
    return;
  }

  try {
    const minted = await mintCredentials(tokenId, tokenSecret, ttl);
    const iceServers = toIceServers(minted);
    if (!iceServers.length) throw new Error('Cloudflare TURN API returned no ICE servers');

    _cache = {
      iceServers,
      ttl,
      mintedAt: now,
      expiresAt: new Date(now + ttl * 1000).toISOString(),
    };
    res.status(200).json({
      ice_servers: iceServers,
      ttl,
      expires_at: _cache.expiresAt,
      cached: false,
    });
  } catch (err) {
    console.error('[ice-servers] mint failed:', err.message, err.detail || '');
    // Fall back to a still-valid cached credential rather than failing the call.
    if (_cache && now - _cache.mintedAt < _cache.ttl * 1000) {
      res.status(200).json({
        ice_servers: _cache.iceServers,
        ttl: _cache.ttl,
        expires_at: _cache.expiresAt,
        cached: true,
        stale: true,
      });
      return;
    }
    res.status(502).json({ error: 'mint_failed', message: err.message });
  }
};
