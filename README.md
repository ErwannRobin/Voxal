# Voxal

> Serverless push-to-talk voice chat for your desktop and browser — no accounts, no central server, just a room code.

![screenshot placeholder](docs/voxal-screenshot.png)

---

## Features

- 🎙 **Push-to-talk** — hold a configurable keyboard shortcut (or click-and-hold the mic button) to transmit
- 🔓 **Free-hand mode** — toggle always-on mic when you don't want to hold a key
- 🔑 **Private rooms** — share a room code; only people with the code can join
- 👤 **Pseudonyms** — pick a nickname that shows in the participant list
- 🟢 **Talking indicator** — speaking participants are highlighted in real time
- 🔔 **Audio cues** — synthesized sounds for PTT on/off, peer join, and peer leave
- 🖥 **Desktop + web** — runs as a native Tauri app or as a plain static web page
- ☁️ **No server** — P2P audio via WebRTC; only the PeerJS free signaling tier is used

---

## Architecture

```
Signaling topology  :  star  — host ↔ each peer via PeerJS DataConnection
Audio topology      :  mesh  — every peer ↔ every peer via WebRTC MediaConnection
Codec               :  Opus (browser default for WebRTC), 16 kHz mono
Signaling server    :  PeerJS public server (0.peerjs.com) — free tier, ~50 users/IP
```

### How a room works

1. **Host** creates a room → PeerJS assigns them a peer ID (this *is* the room code)
2. **Joiner** enters the room code → connects to host via DataConnection, sends `hello { pseudo }`
3. Host replies with the full peer list, then broadcasts `peer-joined` to all existing peers
4. Everyone calls everyone else directly over WebRTC (full mesh) for audio
5. Talking state is relayed through the host's data channel so all participants see who's speaking

### Data protocol

| Message | Direction | Payload |
|---|---|---|
| `hello` | joiner → host | `{ pseudo }` |
| `peer-list` | host → joiner | `{ peers:[{id,pseudo}], hostId, hostPseudo }` |
| `peer-joined` | host → all | `{ peerId, pseudo }` |
| `peer-left` | host → all | `{ peerId }` |
| `talking` | peer → host → all | `{ peerId, active }` |

---

## Stack

| Layer | Technology |
|---|---|
| Desktop shell | [Tauri 2](https://v2.tauri.app) (Rust + WebView) |
| Frontend | Vanilla HTML / CSS / JS (no build step) |
| P2P signaling | [PeerJS 1.5](https://peerjs.com) — bundled locally (`src/assets/peerjs.min.js`) |
| Audio | WebRTC `getUserMedia` + Opus |
| Audio feedback | Web Audio API (synthesized, no audio files) |
| Global shortcut | `tauri-plugin-global-shortcut` (desktop only) |

The desktop binary is ~10–20 MB. The web version is three static files.

---

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | ≥ 18 |
| Rust | stable (via [rustup](https://rustup.rs)) |
| Tauri CLI | installed via `npm install` |

On macOS you also need Xcode Command Line Tools (`xcode-select --install`).
On a blank Mac, install Xcode Command Line Tools first, then Node.js, then Rust.

---

## Getting started

```sh
# Install all dependencies (npm + Rust crates)
make install

# Start the desktop app in dev mode (hot reload)
make dev

# Or serve the web version locally
make run-web          # → http://localhost:8080
```

If `make install` reports that `npm` is missing, install Node.js first and rerun it.

---

## All Makefile targets

```
make help        Show this list
make dev         Tauri hot-reload dev mode
make run         Build & launch the desktop release binary
make build       Full Tauri release build (produces installer)
make run-web     Serve src/ on http://localhost:8080
make build-web   Copy src/ to dist/ for static hosting
make install     npm install + cargo fetch
make check       Rust type-check without building
make clean       Remove Cargo build artifacts and dist/
```

---

## Mobile (Capacitor — iOS & Android)

The `src/` web app is wrapped as a native mobile app via [Capacitor](https://capacitorjs.com). All Tauri-specific calls are already guarded so they silently no-op on mobile.

### Prerequisites
- **iOS:** Mac + Xcode + Apple Developer account (for device builds)
- **Android:** Android Studio

### Workflow

```sh
# After any change to src/, sync assets to both platforms
make cap-sync

# Open in Xcode (then build/run from there)
make cap-ios

# Open in Android Studio (then build/run from there)
make cap-android
```

### What works on mobile
- Full P2P room creation and joining
- Push-to-talk via tap-and-hold on the mic button
- Free-hand mode toggle
- Pseudonyms and talking indicators
- Audio cues and haptic feedback on PTT (via `@capacitor/haptics`)
- Microphone permissions declared for both platforms

### What's different vs desktop
- No global keyboard shortcut (mobile has no background keyboard access) — PTT is touch-only
- Space/Enter shortcuts only work if a hardware keyboard is connected



The `src/` folder is a self-contained static web app — no bundler, no build step.

```sh
# Copy to dist/
make build-web

# Then deploy dist/ to any static host, for example:
npx netlify deploy --dir dist
# or drag dist/ into Netlify/Vercel/GitHub Pages
```

> **Note:** the web version requires the page to be served over **HTTPS** (or `localhost`) for `getUserMedia` microphone access.

---

## Push-to-talk

### Desktop (Tauri)
The global shortcut works **even when the app is in the background**. Default: `Ctrl+\``. You can change it inside the app — press the **Edit** button next to the shortcut display, then press your desired key combination.

### Web (browser)
PTT only works when the **tab is focused**. The configured shortcut is respected in the same way.

### Free-hand mode
Click the **Free hand OFF/ON** button to keep your mic permanently open without holding any key.

---

## Audio cues

All sounds are synthesized via the Web Audio API — no audio files are bundled.

| Event | Sound |
|---|---|
| PTT activated | Short rising chirp (880 Hz → 1200 Hz) |
| PTT released | Short falling chirp (800 Hz → 500 Hz) |
| Peer joins room | Ascending triad chime (C5 → E5 → G5) |
| Peer leaves room | Descending fifth (G5 → C5) |

---

## Project structure

```
voxal/
├── src/                       # Frontend (desktop + web)
│   ├── index.html             # App shell (home, room, error screens)
│   ├── main.js                # All app logic (no framework)
│   ├── styles.css             # Dark theme, responsive layout
│   └── assets/
│       └── peerjs.min.js      # PeerJS bundled locally (no CDN)
├── src-tauri/                 # Tauri / Rust backend
│   ├── src/
│   │   ├── lib.rs             # Global shortcut + update_ptt_shortcut command
│   │   └── main.rs            # Entry point
│   ├── Cargo.toml
│   ├── tauri.conf.json        # Window config (340×520, resizable)
│   └── capabilities/
│       └── default.json       # IPC permissions
├── Makefile
└── package.json
```

---

## Known limitations

- **NAT traversal** — PeerJS uses Google's STUN servers by default. Users behind very strict NAT/firewalls may fail to connect. For maximum reliability, add a TURN server to the PeerJS config.
- **PeerJS free tier** — `0.peerjs.com` allows ~50 simultaneous connections per IP. For larger groups or production use, [self-host the PeerJS server](https://github.com/peers/peerjs-server).
- **Browser PTT scope** — the keyboard shortcut only fires when the tab is focused (browser security limitation). Click-and-hold the mic button always works.
- **Room persistence** — rooms exist only while at least one participant remains. When the host leaves, the remaining peer with the smallest peer ID is automatically elected as the new host; audio is uninterrupted since MediaConnections are fully peer-to-peer. The room code updates to reflect the new host's ID.

---

## License

MIT
