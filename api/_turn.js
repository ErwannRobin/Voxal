// Pure helpers behind the anonymous TURN credential endpoint. Kept separate from
// the handler so they can be unit-tested with `node --test` and no network.
//
// rateLimit/pruneHits/clientIp used to live here; they moved to _shared.js once
// api/_sfu.js needed the identical per-IP limiter, and are re-exported below so
// existing imports of './_turn.js' keep working.

export { rateLimit, pruneHits, clientIp } from './_shared.js';

export const CF_TURN_API = 'https://rtc.live.cloudflare.com/v1/turn/keys';

/**
 * Normalise what Cloudflare returns into an RTCIceServer[] the app can use.
 *
 * Cloudflare's own `turn-worker` example filters this down to `turn:` + `udp`
 * ONLY. Do not copy that here: `turn:…?transport=tcp` and `turns:` on 443 are
 * precisely the transports that get through the strict firewalls TURN exists to
 * traverse (UDP/3478 is commonly blocked). Dropping them would leave exactly the
 * users who need a relay without one.
 */
export function toIceServers(cfResponse) {
  const ice = cfResponse && cfResponse.iceServers;
  if (!ice) return [];
  const list = Array.isArray(ice) ? ice : [ice];
  return list
    .map((entry) => {
      const urls = Array.isArray(entry.urls) ? entry.urls : entry.urls ? [entry.urls] : [];
      if (!urls.length) return null;
      const server = { urls };
      if (entry.username) server.username = entry.username;
      if (entry.credential) server.credential = entry.credential;
      return server;
    })
    .filter(Boolean);
}

/**
 * Re-mint once ~80% of the TTL has elapsed, so a credential handed out at the
 * edge of the window still has usable life left. Returning the cached value for
 * the rest of the window bounds outbound Cloudflare API calls no matter how much
 * traffic the endpoint sees — request volume then costs nothing extra.
 */
export function isCacheFresh(cache, now, refreshRatio = 0.8) {
  // Check the type, not truthiness: a timestamp of 0 is a valid instant, and a
  // falsy test would reject a perfectly good cache entry.
  if (!cache || typeof cache.mintedAt !== 'number' || !cache.ttl) return false;
  return now - cache.mintedAt < cache.ttl * 1000 * refreshRatio;
}

// rateLimit's per-endpoint note: this endpoint's limiter now only sees CDN cache
// misses — edge-cached responses never reach the function. That's fine, the
// point was bounding provider API calls, and edge caching bounds them harder.
// The credential TTL remains what limits abuse.

export function credentialsUrl(tokenId) {
  return `${CF_TURN_API}/${encodeURIComponent(tokenId)}/credentials/generate`;
}

