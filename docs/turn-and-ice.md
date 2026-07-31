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

## Testing the relay: Settings → Audio → *Test over network*

The **Test** button next to the microphone records the **raw mic** and replays it,
so it only proves capture works. **Test over network** proves the rest: it opens
two `RTCPeerConnection`s in the page, both forced to `iceTransportPolicy: 'relay'`,
and connects them through whatever `fetchIceServers()` resolved. Your audio is
Opus-encoded, leaves the device, transits the TURN relay, comes back, is decoded,
and **the returned audio is what gets recorded and replayed** — so you hear what a
remote listener actually hears, without needing a second person.

It reports the concealment ratio (how much audio the jitter buffer had to
fabricate — a better measure of what was heard than packet loss, since it is
counted *after* FEC recovery), the negotiated jitter buffer, and whether the run
genuinely went through a relay.

Two outcomes are worth knowing:

- **“No TURN relay reachable — audio never left the device.”** Relay-only ICE
  gathered no candidates. This is a real diagnostic, not a bug in the test: it
  means peers behind strict firewalls cannot reach you either. Check the
  *Fallback relay* setting above, or configure org/metered/custom TURN.
- **“… not relayed.”** The loopback connected over a direct/host path instead of
  the relay. The quality figures are still valid, but they did not exercise TURN.

The test is unavailable while you are in a room (the RNNoise capture graph is
shared with the live call) — use the per-peer **“Can they hear me?”** check in
dev mode instead. On the Tauri desktop **preferences window** the test is not
available; run it from the main window.

> **Why not a server-side echo service?** Cloudflare **Workers** cannot do this:
> they are V8 isolates with no UDP sockets, no ICE agent and no DTLS/SRTP stack,
> so they cannot terminate WebRTC media at all. The only way to build a real
> remote echo is an **SFU** (e.g. Cloudflare Realtime), and an SFU **decrypts**
> media — which would break the guarantee at the top of this document that a
> relay never has access to your audio. The loopback keeps that guarantee and
> tests the path Voxal actually uses.

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
