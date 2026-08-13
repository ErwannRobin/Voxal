// Pure helpers shared by every serverless endpoint under api/. Kept dependency-
// free and side-effect-free so they can be unit-tested with `node --test` and no
// network, and reused verbatim rather than re-implemented per endpoint (the
// original per-IP rate limiter lived only in _turn.js; SFU credential minting in
// _sfu.js needs an identical one, so it moved here instead of being copy-pasted).

/**
 * Best-effort per-IP sliding window.
 *
 * Honest about what this is: Vercel runs many ephemeral instances, each with its
 * own module scope, so this throttles a single hot instance rather than a
 * distributed attack. It exists to stop one client hammering an endpoint, not
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
