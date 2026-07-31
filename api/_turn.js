// Pure helpers behind the anonymous TURN credential endpoint. Kept separate from
// the handler so they can be unit-tested with `node --test` and no network.

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

/**
 * Best-effort per-IP sliding window.
 *
 * Honest about what this is: Vercel runs many ephemeral instances, each with its
 * own module scope, so this throttles a single hot instance rather than a
 * distributed attack. It exists to stop one client hammering the endpoint, not
 * to be a security boundary. Move to Vercel KV / Upstash if quota burn appears.
 */
export function rateLimit(hits, key, now, limit, windowMs) {
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return { allowed: false, retryAfter: Math.ceil((windowMs - (now - recent[0])) / 1000) };
  }
  recent.push(now);
  hits.set(key, recent);
  return { allowed: true, remaining: limit - recent.length };
}

// Keep the map from growing without bound across a warm instance's lifetime.
export function pruneHits(hits, now, windowMs) {
  for (const [key, times] of hits) {
    const recent = times.filter((t) => now - t < windowMs);
    if (recent.length) hits.set(key, recent);
    else hits.delete(key);
  }
}

// Vercel sits behind a proxy, so the client address is the FIRST entry of
// x-forwarded-for; the rest are intermediaries and are trivially spoofable.
export function clientIp(headers) {
  const fwd = headers['x-forwarded-for'] || headers['X-Forwarded-For'];
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  if (Array.isArray(fwd) && fwd.length) return String(fwd[0]).split(',')[0].trim();
  return headers['x-real-ip'] || 'unknown';
}

export function credentialsUrl(tokenId) {
  return `${CF_TURN_API}/${encodeURIComponent(tokenId)}/credentials/generate`;
}

