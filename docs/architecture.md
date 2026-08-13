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
| `hello` | joiner → host | `{ pseudo, pseudoColor?, protocolVersion, appVersion }` |
| `pseudo-assigned` | host → peer | `{ pseudo, pseudoColor? }` |
| `peer-list` | host → peer | `{ peers, hostId, deputyId, successorIds, protocolVersion, appVersion, ... }` |
| `peer-joined` | host → all | `{ peerId, pseudo, pseudoColor? }` |
| `peer-left` | host → all | `{ peerId }` |
| `peer-renamed` | host → all | `{ peerId, pseudo, pseudoColor? }` |
| `talking` | peer → host → all | `{ peerId, active }` |
| `heartbeat` | host ↔ peers | `{ at, deputyId, successorIds }` |
| `redirect` | peer → joiner | `{ hostId, hostPseudo }` |
| `room-published` | host → all | `{ roomId, secret? }` |
| `video-offer` | peer → host (relay) | `{ peerId, topology: 'p2p'\|'sfu', providerRef? }` — see [Video routing](video-routing.md) |
| `video-stop` | peer → host (relay) | `{ peerId }` |

## Protocol versioning & updates

The `hello` and `peer-list` messages carry a `protocolVersion` (integer, bump on
wire-protocol changes — currently `1`) and `appVersion` (display string). Peers
record each other's versions and warn on skew; if any peer is on a *newer*
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
