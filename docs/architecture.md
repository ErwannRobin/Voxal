# Architecture & Protocol

This document contains the technical reference moved out of the top-level README.

## Topology

```text
Signaling topology : star  (host ↔ peers via PeerJS DataConnection)
Audio topology     : mesh  (peer ↔ peer via WebRTC MediaConnection) — ALWAYS, never server-routed
Video/screen       : mesh by default; optionally routed through Cloudflare's
                      Realtime SFU per participant, see below
Codec              : Opus (browser default), 16 kHz mono
Signaling server   : PeerJS public server by default (self-hostable)
```

### Video/screen routing (optional SFU)

Camera and screen-share tracks are architecturally separate from audio: each
is its own full-mesh set of `MediaConnection`s, independent of the audio mesh.
Because video/screen (not audio) is what actually hits mesh bandwidth limits
in larger rooms, they alone can optionally route through Cloudflare's Realtime
SFU instead of the mesh — a `selectVideoTopology()` decision governed by a
user preference (Settings → Advanced → Video routing), never applied to
audio. The decision and its outcome are always carried over the existing star
signaling above; Cloudflare's SFU carries only the video/screen media plane,
never application state, and no Cloudflare DataChannel is used. See [Video
routing](video-routing.md) for the full design, including the privacy
distinction from TURN relaying and the backend authorization model.

On the mesh, the camera's outgoing track can differ per peer: with **Let others
draw my scene** on, a peer that can draw the sender's animated scene is sent a
keyed picture of the person instead of the finished composite. That choice is
mesh-only — the SFU is always sent the composite. See [Keyed sending and
receiving](video-effects.md#keyed-sending-and-receiving).

### Diagrams

[Topology diagrams](https://erwannrobin.github.io/Voxal/topology.html) draw the
three cases end to end — a voice-only room (join sequence, steady-state star vs.
mesh, which server sees what, host migration), a two-peer video call, and video
above two participants (mesh vs. SFU side by side, uplink cost, and the SFU
control plane). [Room Lab](https://erwannrobin.github.io/Voxal/topology-lab.html) is the
interactive one: add people, hand out cameras, change the routing preference and
watch the star, the mesh and the video links rearrange, with a log of the wire
messages each action would send. The
[flow explorer](https://erwannrobin.github.io/Voxal/architecture.html) covers the
same system component by component.

All three are served from GitHub Pages out of this folder. GitHub renders a `.html`
file in the repository as source, not as a page, so link the Pages URL rather
than the file. Locally, `make docs` serves them on `http://localhost:8090`
(sources: [`topology.html`](topology.html), [`topology-lab.html`](topology-lab.html),
[`architecture.html`](architecture.html)).

## Room lifecycle

1. Host creates a room and gets a PeerJS ID.
2. Joiner resolves the room target and opens a signaling DataConnection to the host.
3. Host sends authoritative `peer-list`, then notifies others with `peer-joined`.
4. Peers open direct MediaConnections for audio.
5. Talking state is relayed through host signaling.
6. On host loss, peers migrate to the next successor/deputy without intentionally tearing down healthy non-host media links.

For a detailed breakdown of election, retries, settle windows, and split-brain safeguards, see [Host migration](host-migration.md).

## Data protocol (summary)

| Message | Direction | Payload |
|---|---|---|
| `hello` | joiner → host (and to every new host) | `{ pseudo, pseudoColor?, protocolVersion, appVersion, caps, keyedOffer }` — authoritative for its sender: the host stores `caps` (what this device can do for others, e.g. `['keyed-video-1']` = it can draw a sender's scene behind a keyed camera picture) and `keyedOffer` as said, and an older app that says nothing has neither |
| `pseudo-assigned` | host → peer | `{ pseudo, pseudoColor? }` |
| `peer-list` | host → peer | `{ peers, hostId, deputyId, successorIds, hostCaps, hostKeyedOffer, protocolVersion, appVersion, ... }` — each entry of `peers` carries `caps` and `keyedOffer` only when the host knows them. A receiver never downgrades `caps` on silence, and reads a missing `keyedOffer` as "none" only from a host that advertises `keyed-video-1`, outside the settle window after a migration |
| `peer-joined` | host → all | `{ peerId, pseudo, pseudoColor? }` |
| `peer-left` | host → all | `{ peerId }` |
| `peer-renamed` | host → all | `{ peerId, pseudo, pseudoColor? }` |
| `talking` | peer → host → all | `{ peerId, active }` |
| `heartbeat` | host ↔ peers | `{ at, deputyId, successorIds }` |
| `redirect` | peer → joiner | `{ hostId, hostPseudo }` |
| `room-published` | host → all | `{ roomId, secret? }` |
| `video-offer` | peer → host (relay) | `{ peerId, topology: 'p2p'\|'sfu', providerRef? }` — see [Video routing](video-routing.md) |
| `video-stop` | peer → host (relay) | `{ peerId }` |
| `video-keyed` | peer → host → all others (a host sends its own to all) | `{ peerId, offer }` — the sender's keyed-camera offer changed: `{ epoch, scene, look, edgeE, size }`, or `null` for "I key nobody". `scene` is `null` while the sender holds keying back (blur, an image, a green shirt); its keyed track then carries the plain composite. The host relays it with `peerId` set to the connection it came in on (never the claimed one), stores it for late joiners' `peer-list`, and passes at most 2 non-null offers a second per source. Host and receivers both sanitise it. See [Keyed sending and receiving](video-effects.md#keyed-sending-and-receiving) |
| `video-keyed-ready` | receiver → host → `to` only | `{ peerId, to, ok, call, epoch, scene }` — "I can draw your scene on THIS call (the mesh `MediaConnection`'s `connectionId`, which PeerJS gives both ends), for THIS offer epoch, with THIS scene compiled", or `ok: false`, "stop keying me". `ok` counts only when it is literally `true`. Re-sent every 10 s and to every new host; a sender forgets one after 25 s |
| `chat` | peer → host → **all, sender included** | in `{ id, text, replyTo }`; out `{ id, peerId, text, at, replyTo }` — the host stamps the sender and the time; the echo back to the sender is its ack. `replyTo` is the id of the message being answered, or `null`. A stored message also carries `editedAt` (see `chat-edit`) |
| `chat-history` | host → joiner | `{ messages }` — the transcript so far, served from the host's own replica |
| `chat-edit` | peer → host → **all, sender included** | in `{ msgId, text }`; out `{ msgId, text, peerId, editedAt }` — the author correcting their own line, up to `CHAT_EDIT_WINDOW_MS` (5 min) after sending. The host is the authority on both rules: it stamped `at`, so it owns the clock, and it takes the sender from the connection, so a peer can never rewrite somebody else's message. A request it refuses is dropped silently |
| `chat-react` | peer → host (relay) | `{ msgId, emoji, peerId }` — toggles that peer's reaction |
| `chat-typing` | peer → host (relay to others) | `{ peerId, active }` — transient, never stored |

## Protocol versioning & updates

The `hello` and `peer-list` messages carry a `protocolVersion` (integer, bump on
wire-protocol changes — currently `4`: `2` when chat was added, `3` when
`chat-edit` was, `4` when the keyed camera's `caps`/`keyedOffer` fields and its
two messages were) and `appVersion` (display string). Peers record each other's
versions and warn on skew; if any peer is on a *newer*
protocol, the client shows a one-time "refresh to update" hint.

Because the protocol lives entirely in `src/` (the web bundle the native shells
load), version skew is expected during rollout and is handled by keeping changes
**additive and tolerant** (default missing fields, ignore unknown ones) rather
than forcing everyone to upgrade at once. Updates reach users automatically: web
always loads the latest; desktop via the Tauri updater; native mobile via Capgo
OTA (`autoUpdate`), so protocol/JS changes ship without an App/Play Store review
— only native-shell changes need a store release.

## Stack

| Layer | Technology |
|---|---|
| Desktop shell | Tauri 2 (Rust + WebView) |
| Mobile shell | Capacitor 8 (iOS + Android) |
| Frontend | Vanilla HTML/CSS/JS (no bundler) |
| Signaling | PeerJS (bundled locally) |
| Audio | WebRTC + Web Audio API |
| Noise suppression | RNNoise WASM / browser constraints |

## Project layout

```text
voxal/
├── src/            Frontend shared by desktop, mobile, web
├── src-tauri/      Tauri backend + plugins + capabilities
├── ios/            Capacitor iOS project
├── android/        Capacitor Android project
├── docs/           Architecture, deployment, mobile, release docs
└── KNOWLEDGE/      Persistent development gotchas and notes
```
