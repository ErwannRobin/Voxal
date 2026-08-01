# Deployment & Self-Hosting

## Web deployment

The `src/` folder is a self-contained static app.

```sh
make build-web
```

Then deploy `dist/` to any static host (Vercel/Netlify/GitHub Pages/etc.).

The app needs HTTPS (or `localhost`) for microphone access.

`vercel.json` includes `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers required for SharedArrayBuffer / RNNoise use.

## Anonymous TURN relay (recommended)

`api/ice-servers.js` deploys alongside the static site as a serverless function
and hands short-lived TURN credentials to users with no account. Set two
environment variables on the deployment:

```
CF_TURN_TOKEN_ID=<TURN key id>
CF_TURN_TOKEN_SECRET=<TURN key secret>
```

Get them from the Cloudflare dashboard → Realtime → TURN Server → Create
(1,000 GB/month free). Optional: `CF_TURN_TTL` (default `3600`) and
`ICE_RATE_LIMIT` (default `30` per IP per minute).

Without them the endpoint returns `503` and the app falls back to STUN-only, so
deploying before the account exists is safe. Full detail, including why the key
cannot live in the client, is in [TURN & ICE configuration](turn-and-ice.md#anonymous-turn-credentials-apiice-servers).

## Optional presence backend

Presence is optional. Voxal works in pure P2P mode without any account/token.

If enabled, the app uses the configured service URL in Settings → Advanced (`service-url`) and sends channel/session metadata updates (including peer counts) as membership changes.

## Self-host checklist

For production-grade deployments:

1. Run your own PeerJS signaling server.
2. Configure TURN credentials for strict NAT/firewall networks — see [TURN & ICE configuration](turn-and-ice.md).
3. Host the static web app over HTTPS with the required security headers.
4. Configure deep-link domain files (`.well-known`) for mobile app links.
5. Optionally run a presence backend and point Voxal to your API base URL.

## Known operational limits

- Browser keyboard PTT only works while the tab is focused.
- PeerJS public infrastructure has free-tier limits; self-host for larger scale.
- TURN is recommended for reliability across restrictive enterprise networks.

## Voxal Connect (account sign-in)

Web sign-in returns over **https**, not the `voxal://` custom scheme:

```
app  → voxal.app/connect?state=…&responseMode=redirect&redirect_uri=https://ptt.voxal.app/auth/callback
     ← 302 https://ptt.voxal.app/auth/callback?token=…&state=…
```

The token is validated against the stored `state`, then stripped from the URL
with `history.replaceState` so it never lingers in history or the `Referer`
header. `/auth/callback` is a real file (`src/auth/callback.html`) that forwards
into the app — **not** a rewrite: with `cleanUrls` a rewrite to `/index.html`
404s, and a file works on any static host.

Native (Tauri desktop, iOS/Android) sends `responseMode=deep-link` and keeps
using `voxal://auth` — that is how the OS routes back into the app.

The server side lives in **`ErwannRobin/voxal-presence`**
(`src/pages/ConnectPage.tsx` + `src/lib/authCallback.ts`). Any new web origin
must be added to the redirect allowlist there — `DEFAULT_ALLOWED_REDIRECT_ORIGINS`,
or `VITE_AUTH_REDIRECT_ORIGINS` for preview/dev deployments — otherwise
`/connect` refuses to redirect to it.
