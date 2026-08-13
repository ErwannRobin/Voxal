# Video routing (camera & screen-share)

Voxal audio is always peer-to-peer — see [TURN & ICE
configuration](turn-and-ice.md). **Camera and screen-share video is different:**
it can optionally route through Cloudflare's Realtime SFU (a media server) when
a room grows past what a peer-to-peer mesh handles comfortably. This document
explains what that means, when it happens, and — critically — how it differs
from the TURN relay.

## TURN relay vs. SFU: not the same privacy guarantee

> **An SFU decrypts media in order to selectively forward it.** Cloudflare's
> Realtime SFU can technically access video and screen-share content that
> passes through it when the "Allow relay" preference is enabled and a room
> is large enough to use it.
>
> This is fundamentally different from the **TURN relay** described in [TURN
> & ICE configuration](turn-and-ice.md), which only ever forwards opaque
> **encrypted DTLS-SRTP** — a TURN relay cannot decode what it forwards, an
> SFU can.

Because of this distinction, **Voxal never routes voice/PTT audio through any
SFU, under any setting.** Voice always stays peer-to-peer, optionally
TURN-relayed (still encrypted, never decoded server-side). This is a
deliberate, permanent product decision — not a current limitation to be lifted
later. It reaffirms, rather than reverses, the reasoning recorded in
`KNOWLEDGE/learning.md` for why an SFU was previously rejected for Voxal's
audio path.

Video and screen-share are optional, add-on features distinct from Voxal's
core voice product, and are the one part of the app that genuinely hits the
O(n²) bandwidth ceiling of a peer-to-peer mesh in larger rooms (see [the
scaling note in TURN & ICE configuration](turn-and-ice.md#a-note-on-scale)).
That scaling problem — not a change of heart about audio — is what motivates
this feature.

## Routing preference (Settings → Advanced → Video routing)

| Choice | Behaviour |
|---|---|
| **Prefer direct** *(default)* | Video/screen try peer-to-peer first. If a room outgrows a comfortable mesh, Voxal reports it and offers to allow a relay — it never switches on its own. |
| **Allow relay for large rooms** | Still prefers peer-to-peer when it looks viable; uses Cloudflare's SFU once the room is large enough that a mesh stops being practical. |
| **Direct only — never relay video** | Never uses an SFU, full stop, regardless of room size or whether one is configured. Large rooms may see video fail to establish; voice is unaffected either way. |

This setting is `localStorage['video-routing-mode']` (`'prefer-p2p' \|
'allow-sfu' \| 'p2p-only'`), read by `videoRoutingPreference()` in
`src/main.js`. It governs camera/screen-share routing **only** — there is no
equivalent setting for audio, because audio has only one routing mode.

## How the decision is made

`selectVideoTopology(kind, opts)` in `src/main.js` is the single function that
decides P2P vs. SFU for a `video` or `screen` track. It is pure (no network,
no DOM) and has one property enforced by construction, checked by an explicit
unit test: **it can only ever return `sfu` when the preference is `allow-sfu`.**
A `prefer-p2p` user is never silently moved onto a relay; a degraded mesh
under that preference is reported back as a P2P decision with a reason the UI
turns into an explicit prompt, never an automatic switch.

| Reason | Meaning |
|---|---|
| `ok` | Direct connection working, or not yet attempted anything else. |
| `sfu-unavailable` | The SFU backend isn't configured or reachable on this deployment. Distinct from a P2P failure — this is "there is nothing else to try", not "retry me". |
| `p2p-failed-temporary` | The mesh connection for this peer isn't negotiating right now; may recover on its own. |
| `p2p-unsuitable` | The mesh is technically working but the room has grown past a size a full mesh handles well. |
| `preference-p2p-only` | The user has forbidden relaying video — informational, never triggers a switch. |
| `preference-allow-sfu` | The user has opted in and the selector judged the relay was warranted. |

"Room too large for a comfortable mesh" uses its own dedicated threshold,
`VIDEO_SFU_THRESHOLD_PEERS` (2 — i.e. `overCapacity` once a room has **more
than 2 participants**), deliberately decoupled from `ROOM_SOFT_WARN_PEERS`
(the unrelated, audio-only room-size warning banner, 8 participants). An
earlier version of this feature reused `ROOM_SOFT_WARN_PEERS` for video too;
testing showed that was too high in practice — an 8-participant room with a
camera on still read "Direct" — so video/screen now gets its own, much lower
bar, reflecting that it's far heavier per participant than audio.

## What the user sees

- **Working peer-to-peer**: no change from before this feature — no badge, no
  prompt.
- **Prefer direct, degraded**: a one-time modal explaining that video is
  struggling and offering to allow a relay, naming the privacy trade-off
  plainly (see below). Declining does not persist — Voxal will ask again only
  if you re-encounter the same situation in a new share.
- **Allow relay, actually relaying**: a small **☁ Relayed** badge appears on
  that video/screen tile (roster and video-stage), distinct from the
  existing per-peer ICE-quality dot — "using a relay for the SFU leg" and
  "using TURN for the peer-to-peer leg" are different, unrelated questions,
  so they're shown separately rather than conflated into one indicator.
- **Direct only, hitting a wall**: a toast explaining that video couldn't
  establish a direct connection because relaying is disabled in Settings,
  with a shortcut to turn video off or change the setting. Voice is
  unaffected.

## Backend (Cloudflare Realtime SFU)

Two new serverless endpoints, following the same pattern as the existing
anonymous TURN endpoint (`api/ice-servers.js`): pure logic in a `_prefixed.js`
module (unit-tested with `node --test`, no network), a thin routed handler,
secrets only ever read from `process.env`, never returned to the client.

- **`POST /api/sfu-session`** (`api/sfu-session.js`) — cheap, rate-limited,
  makes no Cloudflare API call. Mints a short-lived, HMAC-signed *capability
  token* scoped to one `{roomCode, participantId, kind, action}` tuple.
- **`POST /api/sfu-track`** (`api/sfu-track.js`) — verifies that token, then
  proxies the client's SDP offer to Cloudflare's Realtime API using the
  Cloudflare app secret (which never leaves this endpoint), and returns
  Cloudflare's SDP answer.

### Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `CF_SFU_APP_ID` | yes | Cloudflare Realtime (Calls) application id — public, returned to clients |
| `CF_SFU_APP_SECRET` | yes | Cloudflare Realtime application secret — never logged, never returned |
| `SFU_CAPABILITY_SECRET` | yes | HMAC signing secret for capability tokens. Deliberately **separate** from `CF_SFU_APP_SECRET` so rotating one never requires rotating the other |
| `SFU_CAPABILITY_TTL` | no | Capability token lifetime in seconds (default `300` — only needs to cover the negotiate round-trip) |
| `SFU_RATE_LIMIT` | no | Requests per IP per minute to `/api/sfu-session` (default `30`) |

Without `CF_SFU_APP_ID`/`SFU_CAPABILITY_SECRET` configured, both endpoints
return `503 not_configured` and the app falls back to peer-to-peer for every
preference except a persistently-attempted `allow-sfu`, which simply keeps
using P2P — exactly as before this feature existed. **Safe to deploy before
the Cloudflare account exists.**

### Authorization model — an explicit limitation, not a bug

The capability token proves the server issued it for exactly this
`{roomCode, participantId, kind, action}` tuple, before it expired. **It does
not prove the participant is genuinely present in that room right now** —
Voxal has no server-side room registry anywhere in this repository (the only
other backend, the optional presence service, lives in a separate repository
and is frequently absent entirely). This is the **same posture
`api/ice-servers.js` already has** for anonymous TURN credentials: rate-limited,
not membership-checked. It is not a regression introduced by this feature.

If real abuse pressure appears, the smallest fix is layering
presence-token-asserted room membership on top when presence is configured —
not standing up a general-purpose database.

## Voxal-level track model

Cloudflare identifiers (session ids, track names) live only inside the SFU
router functions in `src/main.js` (`sfuPublishTrack`, `sfuSubscribeTrack`, and
friends) and `api/_sfu.js`. Everywhere else in the app, a track is described
purely in Voxal terms:

```js
{ callId, participantId, kind: 'video'|'screen', state, topology: 'p2p'|'sfu', _providerRef }
```

`_providerRef` is the one field that carries an opaque, SFU-internal token —
treated the same as a TURN credential: never logged, never displayed.

## Signaling stays with Voxal

Cloudflare's SFU carries only the video/screen RTP media plane. All
application state — who is publishing what, and on which topology — travels
over Voxal's existing PeerJS star signaling, extended with an optional
`topology`/`providerRef` field on the existing `video-offer`/`screen-offer`
messages (see the protocol table at the top of `src/main.js`). Cloudflare's
DataChannels are never used for this.

## Reconnection

SFU video/screen sessions get their own lightweight state machine
(`publishing → published → reconnecting → published`, or `→ failed` after a
bounded retry budget), scoped **exclusively** to the new SFU
`RTCPeerConnection`s. It never touches `roomState`, host migration, or the
logical call — a flaky video relay cannot end your room. Voxal's pre-existing
mesh (peer-to-peer) connections have no equivalent ICE-restart logic today;
that is a known, separate gap this feature does not attempt to fix (see
`KNOWLEDGE/todos.md`).

## Debugging

Dev mode (Settings → Advanced → Dev mode) logs every topology decision,
publish/subscribe attempt, and reconnect event with a `[SFU]` tag in the
existing dev-log panel, following the same convention as `[Video]`/`[ICE]`
logging elsewhere. Nothing about stream content, credentials, or Cloudflare
session identifiers is ever logged.

## Testing without Cloudflare credentials

`make test` (the `unit` Playwright project and the `node --test` API suite)
runs with **zero** real Cloudflare credentials — `tests/e2e/unit-video-routing.spec.js`
stubs `/api/sfu-session`/`/api/sfu-track` the same way
`tests/e2e/unit-turn-status.spec.js` stubs `/api/ice-servers`, and
`api/_sfu.test.js` tests the capability token logic with no network at all.
Any future test that needs a real Cloudflare account should be isolated
behind explicit opt-in configuration, kept out of `make test`.
