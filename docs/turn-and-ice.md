# TURN & ICE configuration

Voxal audio is peer-to-peer (WebRTC). To connect, two peers exchange **ICE
candidates** and pick a path:

- **STUN** lets a peer discover its public address so two *permissively*-NAT'd
  peers can connect directly. It's free and always on, but it does **not** get
  through symmetric NAT or strict/corporate firewalls.
- **TURN** is a relay: when a direct path is impossible, media is forwarded
  through a TURN server. This is the only thing that traverses strict firewalls
  — especially over **TCP/443** and **TLS (`turns:`)**, since UDP/3478 is
  commonly blocked. A TURN relay only forwards **encrypted** DTLS-SRTP, so it
  never has access to the audio.

## Resolution order

`fetchIceServers()` returns the first source that yields servers:

| # | Source | How it's set |
|---|--------|--------------|
| 0 | **Embed-provided** ICE servers | Embedding page posts `{ type: 'config', iceServers }` — see [iframe embedding](iframe-embed.md#4--providing-your-own-turn-relay). Highest precedence; in-memory only. |
| 1 | **Org / presence** TURN | Backend-managed, short-lived credentials fetched when signed in (or after an `auth` postMessage with `token` + `orgId`). Preferred for quality. |
| 2 | **metered.ca** credentials | Settings → Advanced → *metered.ca app name* + *API key* (`localStorage`: `metered-app-name`, `metered-api-key`). |
| 3 | **Public STUN + free relay fallback** | Default. Google STUN plus a best-effort public TURN relay, configurable below. |

## Fallback relay (Settings → Advanced)

When no org/metered TURN is configured, the **Fallback relay** control decides
what the step-3 fallback does:

| Choice | Behaviour | Storage (`localStorage['turn-fallback']`) |
|--------|-----------|-------------------------------------------|
| **Automatic** *(default)* | Public STUN + a best-effort free public TURN relay | key unset |
| **Off** | Direct / STUN only — no relay | `[]` |
| **Custom relay server** | Your own TURN (Server URL / Username / Password) | `[{ "urls": "...", "username": "...", "credential": "..." }]` |

You can also set `localStorage['turn-fallback']` directly to a JSON
`RTCIceServer[]` (e.g. multiple servers) — the UI handles the single-server case.

> **The default public relay is best-effort.** It uses shared, rate-limited
> public Open Relay credentials that are **not guaranteed** (Open Relay has moved
> toward per-account API keys). For anything production-grade, use your own
> relay (below), org/metered TURN, or the embed `config` channel.

## Self-hosting a TURN relay (coturn)

For reliable traversal, run your own [coturn](https://github.com/coturn/coturn).
A minimal setup that survives firewalls:

```conf
# /etc/turnserver.conf
listening-port=3478
tls-listening-port=443
listening-ip=0.0.0.0
realm=turn.your-company.com
# static credentials (simple) — prefer use-auth-secret for short-lived creds
user=voxal:a-strong-password
cert=/etc/letsencrypt/live/turn.your-company.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.your-company.com/privkey.pem
```

Then point Voxal at it via any of:

- **Custom relay server** in Settings → Advanced (single user / self-host),
- the embed **`config`** postMessage (per-embed), or
- your **org backend** issuing short-lived credentials (best for many users —
  static client-side credentials get scraped and drained).

Always advertise the firewall-friendly transports:

```json
[
  { "urls": "stun:turn.your-company.com:3478" },
  { "urls": "turn:turn.your-company.com:443?transport=tcp",  "username": "voxal", "credential": "a-strong-password" },
  { "urls": "turns:turn.your-company.com:443?transport=tcp", "username": "voxal", "credential": "a-strong-password" }
]
```

## A note on scale

TURN relays all media through the server, and Voxal audio is a **full mesh**, so
relayed bandwidth grows ~O(n²) with room size. Keep relayed rooms small; see the
room-size warning (soft at 8, hard at 12 participants).
