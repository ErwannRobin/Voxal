# Deployment & Self-Hosting

## Web deployment

The `src/` folder is a self-contained static app.

```sh
make build-web
```

Then deploy `dist/` to any static host (Vercel/Netlify/GitHub Pages/etc.).

The app needs HTTPS (or `localhost`) for microphone access.

`vercel.json` includes `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers required for SharedArrayBuffer / RNNoise use.

## Optional presence backend

Presence is optional. Voxal works in pure P2P mode without any account/token.

If enabled, the app uses the configured service URL in Settings → Advanced (`service-url`) and sends channel/session metadata updates (including peer counts) as membership changes.

## Self-host checklist

For production-grade deployments:

1. Run your own PeerJS signaling server.
2. Configure TURN credentials for strict NAT/firewall networks.
3. Host the static web app over HTTPS with the required security headers.
4. Configure deep-link domain files (`.well-known`) for mobile app links.
5. Optionally run a presence backend and point Voxal to your API base URL.

## Known operational limits

- Browser keyboard PTT only works while the tab is focused.
- PeerJS public infrastructure has free-tier limits; self-host for larger scale.
- TURN is recommended for reliability across restrictive enterprise networks.
