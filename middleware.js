// Vercel Routing Middleware — Markdown content negotiation for the home page.
//
// An agent that asks for `/` with `Accept: text/markdown` gets src/index.md
// instead of the app's HTML. This cannot be a vercel.json rewrite: Vercel serves
// a static file that matches the path (here /index.html) BEFORE it looks at
// rewrites, so a header-conditioned rewrite of `/` never fires. Middleware runs
// before the filesystem and the cache.
//
// Scoped to `/` by the matcher, so no other request ever invokes it. The
// response headers for /index.md (Content-Type, Vary) are in vercel.json.
import { rewrite, next } from '@vercel/functions';

export const config = { matcher: '/' };

// True when text/markdown is acceptable and not explicitly refused (q=0).
export function wantsMarkdown(accept) {
  return String(accept || '')
    .split(',')
    .map((part) => part.trim().toLowerCase().split(';').map((s) => s.trim()))
    .some(([type, ...params]) => type === 'text/markdown' && !params.some((p) => /^q=0(\.0*)?$/.test(p)));
}

export default function middleware(request) {
  if (wantsMarkdown(request.headers.get('accept'))) {
    return rewrite(new URL('/index.md', request.url), { headers: { Vary: 'Accept' } });
  }
  return next({ headers: { Vary: 'Accept' } });
}
