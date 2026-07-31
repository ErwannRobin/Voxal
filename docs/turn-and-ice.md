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
| 2.5 | **Anonymous TURN credentials** | Short-lived credentials from this deployment's own `/api/ice-servers` endpoint — **this is what gives account-less users a relay**. See below. |
| 3 | **Public STUN + free relay fallback** | Last resort. Google STUN plus the (retired, see warning) public relay. |

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

> **⚠️ The default public relay no longer works.** metered.ca has **retired** the
> shared `openrelayproject` credentials in favour of per-account API keys, so the
> built-in step-3 relay fails for everyone. **The fix is step 2.5 below** —
> configure `/api/ice-servers` and anonymous users get a working relay again.
> Until then, direct/STUN connections still work, but peers behind symmetric NAT
> or a strict firewall cannot connect.
>
> **To get a working relay today**, pick one:
> - **[Anonymous TURN credentials](#anonymous-turn-credentials-apiice-servers)** —
>   the built-in path; set two env vars and every anonymous user is covered.
> - **metered.ca free tier** (20 GB/month) — sign up, create an app, then paste the
>   app name + API key into *Settings → Advanced* (step 2 above). No rebuild needed.
> - **Your own coturn** (below) — enter it under *Fallback relay → Custom relay server*.
> - **Org TURN** via a signed-in Voxal account (step 1).
>
> *Settings → Audio → Test over network* will tell you which of these is in play —
> it names the retired default explicitly rather than blaming your network.

## What the status badge means

The dot at the top-right, and the popover behind it, report **which source
supplied your relay** — derived from the last `fetchIceServers()` resolution, not
from any stored flag:

| Shown | Meaning |
|---|---|
| `✓ TURN — N servers (Cloudflare, anonymous)` | The `/api/ice-servers` endpoint below. This is the normal state for a user with no account. |
| `✓ TURN — N servers (your Voxal organisation / metered.ca / provided by this site / custom relay)` | An explicitly configured source won. |
| `⚠ TURN — built-in public relay (retired, unlikely to work)` | Fell through to the dead default. Amber, deliberately: those servers exist but do not work. |
| `— TURN not configured` | No relay at all (e.g. *Fallback relay → Off*). Direct/STUN only. |
| `… Checking relay` | ICE has not resolved yet. |

`· verified` is appended only after a *Test over network* run that actually
completed **through a relay** — configured and working are different claims.

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

## Anonymous TURN credentials (`/api/ice-servers`)

**You cannot ship a relay API key in the app.** `src/` is static files served to
the browser, so anything embedded is readable by anyone and your quota gets
drained. Instead this repo ships a serverless function that holds the secret and
hands out **short-lived** credentials to anonymous callers.

Backed by [Cloudflare's TURN service](https://developers.cloudflare.com/realtime/turn/):
**1,000 GB/month free**, which is on the order of 30,000 relayed call-hours (a
relayed 2-peer call costs roughly 29 MB/hour). This is Cloudflare's *TURN*
service, **not** its SFU — it relays encrypted DTLS-SRTP and cannot hear the
audio, so the guarantee at the top of this document still holds.

### Setup

1. Cloudflare dashboard → **Realtime** → **TURN Server** → **Create**. Note the
   **TURN Token ID** and **API Token**.
2. Set them as environment variables on the deployment (Vercel → Settings →
   Environment Variables):

   | Variable | Required | Meaning |
   |---|---|---|
   | `CF_TURN_TOKEN_ID` | yes | TURN key id |
   | `CF_TURN_TOKEN_SECRET` | yes | TURN key secret — never logged or returned |
   | `CF_TURN_TTL` | no | Credential lifetime in seconds (default `3600`) |
   | `ICE_RATE_LIMIT` | no | Requests per IP per minute (default `30`) |

3. Redeploy. `Settings → Audio → Test over network` should now report
   **“via TURN relay”**.

Without the variables the endpoint returns `503 not_configured` and the app falls
through to the public fallback, exactly as before — so this is safe to deploy
before the account exists.

### How it behaves

- The minted credential is **cached server-side** for ~80% of its TTL and shared
  by all callers, so request volume costs no extra Cloudflare API calls.
- Per-IP rate limiting is **best-effort**: serverless instances are ephemeral and
  plural, so it throttles a hot instance rather than a distributed attack. Move
  it to a real store (Vercel KV / Upstash) if you ever see quota burn.
- Clients resolve the endpoint as **same-origin `/api/ice-servers`** on the web —
  so a self-hosted deployment automatically uses its own, not `ptt.voxal.app`'s —
  and the absolute URL on native, which has no same-origin server. Override with
  `localStorage['anon-turn-url']`.
- A public endpoint is inherently harvestable. Short TTLs bound the damage from a
  leaked credential to one window; watch the Cloudflare dashboard after launch.

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
