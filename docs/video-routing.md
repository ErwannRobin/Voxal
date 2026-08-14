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
| **Allow relay for large rooms** *(default)* | Still prefers peer-to-peer when it looks viable; uses Cloudflare's SFU once the room is large enough that a mesh stops being practical (more than 2 participants). |
| **Prefer direct** | Video/screen try peer-to-peer first. If a room outgrows a comfortable mesh, Voxal reports it and offers to allow a relay — it never switches on its own. |
| **Direct only — never relay video** | Never uses an SFU, full stop, regardless of room size or whether one is configured. Large rooms may see video fail to establish; voice is unaffected either way. |

> **The default relays video in group calls.** Because **Allow relay for large
> rooms** ships as the default, a user who changes nothing will have their
> *camera and screen-share* routed through Cloudflare once a call passes two
> participants — and, per the section above, an SFU can technically see that
> video. Voice is never affected under any setting. Choose **Prefer direct**
> or **Direct only** to keep video off the relay.

This setting is `localStorage['video-routing-mode']` (`'prefer-p2p' \|
'allow-sfu' \| 'p2p-only'`), read by `videoRoutingPreference()` in
`src/main.js`. It governs camera/screen-share routing **only** — there is no
equivalent setting for audio, because audio has only one routing mode.

## How the decision is made

`selectVideoTopology(kind, opts)` in `src/main.js` is the single function that
decides P2P vs. SFU for a `video` or `screen` track. It is pure (no network,
no DOM) and has one property enforced by construction, checked by an explicit
unit test: **it can only ever return `sfu` when the preference is `allow-sfu`.**
A user who has selected `prefer-p2p` is never moved onto a relay by the
selector; a degraded mesh under that preference is reported back as a P2P
decision with a reason the UI turns into an explicit prompt. Note this is a
statement about the *preference*, not about the shipped default — since
`allow-sfu` is now the default, the common case is that the selector is
permitted to choose the relay without asking (see the warning above).

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

### Migration — the decision is re-run mid-call

The room that needs a relay usually becomes that room while people are already
talking, so the decision cannot be made once at share time. `decideVideoTopology`
reads `connections.size + 1`, and `reconcileVideoTopologyForRoster()` re-runs it
whenever the roster changes — debounced ~1.5 s and memoized on the participant
count, so a burst of joins settles before anything moves and the many
`updatePeerList()` calls that are about talking state cost nothing. Without it,
only *new joiners* ever used the relay: someone who started sharing in a
two-person room stayed on the mesh for the life of the call.

Migrating is not the same problem as deciding. The losing path has to be torn
down on both sides, or one track ends up carried twice:

- **Publisher** — `unpublishLocalTrack(kind)` closes whichever path is live: the
  outgoing mesh `MediaConnection`s (`p2pUnpublishVideo`/`p2pUnpublishScreen`) or
  the SFU publish session. An earlier version only handled the SFU branch, so a
  P2P→SFU migration kept uploading N direct streams *and* one to Cloudflare —
  strictly worse than not migrating at all. A `_topologyReconcileInFlight` guard
  stops a second reconcile landing during the awaited SFU publish, when
  `_localVideoTopology[kind]` still reads as the old mode.
- **Viewer** — `applyRemoteTrackTopology()` treats a re-announced
  `video-offer`/`screen-offer` as a possible migration: it drops the incoming
  mesh stream before subscribing via the SFU, or unsubscribes before letting the
  mesh call arrive. It is a deliberate no-op when the mode *and* the
  `{sessionId, trackName}` are both unchanged, because `sfuRenegotiatePublish()`
  re-announces on every republish and churning a healthy subscription there would
  drop video for no reason.

Two things follow, and neither is hidden:

- Migrating interrupts video briefly for viewers (teardown → republish →
  resubscribe). Audio is untouched, as always.
- Video that was flowing directly starts flowing through Cloudflare, mid-call.
  That is the `allow-sfu` bargain, and the ☁ Relayed badge updates to say so.
  The selector invariant is what keeps this bounded: `prefer-p2p` and `p2p-only`
  never migrate onto the relay, at any room size.

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

### Why a relayed tile can be black

A ☁ Relayed badge means "this track is routed through the relay", not "media is
arriving". A subscription that fails leaves a black tile, so the badge switches
to **⚠ Relay failed** and the reason goes to the dev log — a silent black
rectangle is how every bug in this feature stayed hidden.

The failure worth knowing about is capability minting. `/api/sfu-session`
rate-limits to **30 requests per IP per minute** (`SFU_RATE_LIMIT`), and that
budget is *per IP* — several participants behind one NAT, or several test
windows on one machine, all share it. Three things keep normal use far below it:

- **Tokens are cached for their TTL** (`SFU_CAPABILITY_TTL`, 300 s) per
  `kind:action`, and the in-flight promise is cached too, so a burst of
  concurrent subscribes collapses into one request. They are dropped when the
  room code or participant id changes, since the server checks that tuple.
- **Subscriptions are idempotent.** A `peer-list` is broadcast on every join,
  leave, prune, rename and settings change; re-announcing the same
  `{sessionId, trackName}` for a track that already has a live peer connection
  does nothing. Before this, every broadcast re-subscribed every viewer to every
  publisher — which both leaked peer connections and exhausted the mint budget,
  making a new joiner's camera black for everyone else.
- **A subscribe already negotiating is joined, not duplicated.** Idempotency
  above keys off a *live* peer connection, and a subscribe takes two round trips
  (mint, then negotiate) before there is one — so a `peer-list` landing in that
  window used to open a second connection for the same track and orphan the
  first, which stayed alive pulling media. `_sfuSubscribeInFlight` returns the
  pending promise instead.
- **A 429 is treated as temporary.** It is reported distinctly from a 503, never
  marks the SFU unavailable (that would demote the whole room to P2P over a
  transient limit), and is retried with backoff honouring `Retry-After`.

Note that "already subscribed" requires an actual live peer connection, not just
a remembered ref — the ref is stored before the subscribe is attempted, so a
failed attempt would otherwise be indistinguishable from a healthy one forever.

### Why a relayed peer can be missing entirely

A black tile and *no tile* are different failures with different causes, and the
second is the more confusing one: the peer is in the roster, but has no entry on
the video stage at all.

`videoStageTiles()` builds the stage from `conn.videoActive` / `conn.screenActive`
— "is this peer sharing", which is signaling state, set by `video-offer` and
cleared by `video-stop`. It is deliberately *not* derived from whether a stream
is currently attached, so a tile survives a momentary reconnect.

The consequence is that anything clearing that flag removes the peer from the
stage until the next `video-offer`, and a live share does not re-announce itself.
So swapping a track's transport (mesh ↔ SFU) must go through
`detachRemoteVideoTransport` / `detachRemoteScreenTransport`, which drop the
stream and the connection carrying it but leave the flag alone.
`detachRemoteVideo` / `detachRemoteScreen` clear it, and are only for a share
that genuinely ended.

Getting this wrong produced a distinctive symptom worth recognising: a peer
joining a room that had already switched to the SFU saw *nobody*, while everyone
already in the room saw the newcomer fine. The asymmetry is the diagnosis — a
newcomer learns about existing publishers from `peer-list`, everyone learns about
a newcomer from `video-offer`, and only the first path ran a teardown.

### Network usage (Settings → Advanced)

A live `↓`/`↑` readout that expands into the last 10 minutes of traffic, split
by media kind (voice / camera / screen) in each direction. This exists so the
routing decisions above are *observable*: switching camera and screen onto the
relay should show up as a visible step down in upload while the voice band stays
flat, and if it doesn't, the setting isn't doing what it claims.

Sampled on the existing 5 s stats tick from each peer connection's nominated
candidate pair, so the numbers are transport-level and include RTP, RTCP, STUN
and DTLS overhead — what a data plan is actually billed for. Each connection
carries exactly one kind, which is what makes the per-kind split possible without
reading individual RTP reports.

Rendering lives in `src/net-usage.js`, a plain classic script loaded by both
`index.html` and `settings.html` — the desktop preferences window has no peer
connections of its own, so the main window samples and publishes over the
`net-usage-state` localStorage bridge (same shape as the echo-test bridge) and
the preferences window renders the identical charts. Publishing is gated on an
open panel; *sampling* is not, so the graph is already ten minutes deep when it
opens.

## Backend (Cloudflare Realtime SFU)

Three new serverless endpoints, following the same pattern as the existing
anonymous TURN endpoint (`api/ice-servers.js`): pure logic in a `_prefixed.js`
module (unit-tested with `node --test`, no network), a thin routed handler,
secrets only ever read from `process.env`, never returned to the client.

- **`POST /api/sfu-session`** (`api/sfu-session.js`) — cheap, rate-limited,
  makes no Cloudflare API call. Mints a short-lived, HMAC-signed *capability
  token* scoped to one `{roomCode, participantId, kind, action}` tuple.
- **`POST /api/sfu-track`** (`api/sfu-track.js`) — verifies that token, then
  proxies the SDP and the `tracks[]` instruction to Cloudflare's Realtime API
  using the Cloudflare app secret (which never leaves this endpoint). It
  returns Cloudflare's `sessionDescription`, `requiresImmediateRenegotiation`
  and `tracks` unflattened, so the client can tell an offer from an answer,
  and surfaces Cloudflare's `errorCode`/`errorDescription` — including the
  per-track errors Cloudflare reports inside a `200` — rather than reporting
  success for a session that will never carry media.
- **`POST /api/sfu-renegotiate`** (`api/sfu-renegotiate.js`) — same token
  verification; hands the subscriber's answer back to Cloudflare to complete a
  remote pull.

### The wire protocol (what actually routes media)

The part that trips people up: **an established SFU session forwards nothing on
its own.** Routing is driven by the `tracks[]` instruction, not by the SDP
exchange, so it is entirely possible to negotiate a healthy peer connection,
show a connected session, and receive no media at all. The first version of
this integration did exactly that — it omitted `tracks[]` and never named the
remote track, producing perfectly "connected" black video tiles.

The second thing that trips people up: **the offer goes on `tracks/new`, not on
`sessions/new`.** Cloudflare's lifecycle is

```
POST sessions/new              (no body)  -> { sessionId }
POST sessions/<id>/tracks/new  (offer)    -> (answer)
ICE -> DTLS -> connectionstatechange: connected -> media flows
```

`sessions/new` only creates the session; the *first* `tracks/new` is what
exchanges offer/answer and brings the transport up. Handing `sessions/new` an
SDP and then pushing tracks before the client has applied the resulting answer
makes Cloudflare reject the push with `session_error: Session is not ready yet.
Please ensure the PeerConnection is connected before making this request` —
which is what the second version of this integration did. `api/sfu-track.js`
performs both hops server-side, so the client still sees a single round trip.

Publishing (`sfuPublishTrack`):

1. `addTransceiver(track, { direction: 'sendonly' })` — keep the transceiver,
   Cloudflare needs each track's `mid`.
2. Offer → `POST /api/sfu-track` with `action:'publish'`, the SDP, and
   `tracks: [{ location:'local', mid, trackName }]`.
3. Apply Cloudflare's answer — which comes from `tracks/new`.
   `trackName` is `<voxal peer id>-<kind>`.

Subscribing (`sfuSubscribeTrack`) — note the asymmetry:

1. `POST /api/sfu-track` with `action:'subscribe'` and
   `tracks: [{ location:'remote', sessionId: <publisher's>, trackName }]`,
   **with no local SDP**.
2. Cloudflare replies with an **offer** (it describes the track it will
   forward) plus `requiresImmediateRenegotiation`.
3. Answer it and `POST /api/sfu-renegotiate` to close the loop.

The publisher's `{ sessionId, trackName }` travels to subscribers as
`providerRef` on the existing `video-offer`/`screen-offer` messages, and on
`peer-list` for anyone joining a share already in progress. A subscriber
without it refuses to negotiate rather than opening a connection that can
never receive — silence there was the original black-tile bug.

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

## On phones

Camera video works on mobile web and in the iOS/Android apps, with the same
routing rules as desktop — the routing preference above is platform-independent.
What differs is the presentation and the capture budget:

| | Desktop web (≥861px) | Phone (mobile web + iOS/Android apps) | Tauri desktop / tiny embed |
|---|---|---|---|
| Layout | Tile grid, voice UI railed right | **Immersive** — tiles fill the screen, voice UI overlaid | Floating viewer panel / pop-out window |
| Capture | 720p30 | 360p24 | 720p30 |
| Bitrate cap | 600 kbps | 300 kbps, or 150 kbps on save-data / 2g / 3g | 600 kbps |
| Camera flip | — | Front/back button while the camera is on | — |
| Screen share | Yes | No — no mobile browser implements `getDisplayMedia` | Yes |

Which layout applies is decided by `videoStageMode()` in `src/main.js`, not by
CSS media queries, and published as the `video-stage` / `video-stage-immersive`
body classes. Both are set **only** while a camera or screen is genuinely live,
so an audio-only room renders exactly as it did before video existed.

On a phone the stage also takes a screen wake lock (so the display does not
sleep mid-call) and **pauses capture when the app is backgrounded** — the local
video track is disabled, not stopped, so no renegotiation happens and no peer's
tile disappears.

> **Android needs a store build for camera.** `android.permission.CAMERA` is a
> manifest change, so it cannot ship through Capgo OTA the way `src/` JavaScript
> does. The layout and capture changes reach existing installs over the air; the
> camera itself lights up only once a Play Store build carrying the permission
> lands. iOS needs no native change — `NSCameraUsageDescription` was already
> present.

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
