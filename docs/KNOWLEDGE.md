# Voxal — Project Knowledge Base

Complete reference for the Voxal codebase. Covers architecture, data flows, platform specifics, all global state, localStorage schema, and every non-obvious decision.

---

## Table of Contents

1. [What Voxal Is](#what-voxal-is)
2. [Repository Layout](#repository-layout)
3. [Build & Dev Commands](#build--dev-commands)
4. [Architecture Overview](#architecture-overview)
5. [WebRTC & Signaling Deep Dive](#webrtc--signaling-deep-dive)
6. [Host Migration](#host-migration)
7. [Presence API & Auth Flow](#presence-api--auth-flow)
8. [ICE / TURN Resolution](#ice--turn-resolution)
9. [Frontend Structure](#frontend-structure)
10. [Global State (main.js)](#global-state-mainjs)
11. [localStorage Schema](#localstorage-schema)
12. [Audio System](#audio-system)
13. [iOS Background Keep-Alive](#ios-background-keep-alive)
14. [Tauri Backend (Rust)](#tauri-backend-rust)
15. [Platform Detection & Guards](#platform-detection--guards)
16. [Settings Window Architecture](#settings-window-architecture)
17. [Theme System](#theme-system)
18. [Deep Link / OAuth Flow (voxal://)](#deep-link--oauth-flow-voxal)
19. [Keyboard Shortcuts](#keyboard-shortcuts)
20. [Mobile (Capacitor / iOS)](#mobile-capacitor--ios)
21. [macOS Entitlements & Permissions](#macos-entitlements--permissions)
22. [Known Constraints & Edge Cases](#known-constraints--edge-cases)

---

## What Voxal Is

A serverless, push-to-talk voice chat app. Users share a room code; audio is relayed peer-to-peer over WebRTC. There is no backend required for a basic call — only PeerJS signaling (which uses a free public server) is needed.

Optional: a "Voxal Connect" service (`https://voxal.app`) adds named channels, organisations, managed TURN servers, and OAuth-style login. It is configured separately and the core PTT functionality works without it.

Targets:
- **macOS desktop** via Tauri 2
- **iOS / Android** via Capacitor
- **Web** — plain static files, no bundler

---

## Repository Layout

```
push2talk/
├── src/                        # Frontend — no bundler, no framework
│   ├── index.html              # App shell (home, room, settings modal, error screens)
│   ├── main.js                 # ~1240 lines — all app logic
│   ├── settings.html           # Tauri preferences window (self-contained)
│   ├── styles.css              # Dark/light theme, all UI
│   └── assets/
│       └── peerjs.min.js       # PeerJS bundled locally — never loaded from CDN
├── src-tauri/                  # Rust / Tauri backend
│   ├── src/
│   │   ├── lib.rs              # Plugins, global shortcut, menu, IPC command
│   │   └── main.rs             # Entry point (calls lib::run())
│   ├── Cargo.toml
│   ├── tauri.conf.json         # Window config, URL scheme, macOS bundle config
│   ├── entitlements.plist      # macOS sandbox entitlements (audio-input)
│   ├── Info.plist              # Extra macOS Info.plist keys (NSMicrophoneUsageDescription)
│   └── capabilities/
│       └── default.json        # Tauri IPC permissions for both windows
├── ios/
│   └── App/App/
│       ├── AppDelegate.swift   # AVAudioSession, keep-alive engine, deep link forwarding
│       └── Info.plist          # iOS permissions + voxal:// URL scheme
├── capacitor.config.json       # Capacitor: appId, webDir=src, StatusBar config
├── Makefile
└── package.json
```

---

## Build & Dev Commands

| Command | What it does |
|---|---|
| `make install` | `npm install` + `cargo fetch` |
| `make dev` | Tauri hot-reload dev mode (`npx tauri dev`) |
| `make run-web` | Serve `src/` on `http://localhost:8080` via `npx serve` |
| `make check` | `cargo check` — Rust type-check without building |
| `make build-debug` | Debug `.app` bundle — **required once to register `voxal://` on macOS** |
| `make build` | Full Tauri release build (installer) |
| `make build-web` | Copy `src/` to `dist/` for static hosting |
| `make cap-sync` | `npx cap sync` — sync web assets to iOS & Android |
| `make cap-ios` | `cap-sync` then `npx cap open ios` (Xcode) |
| `make cap-android` | `cap-sync` then `npx cap open android` (Android Studio) |
| `make clean` | `cargo clean` + remove `dist/` |

There are **no automated tests**. `make check` is the only validation step.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  Tauri window "main"  ──  index.html + main.js          │
│  Tauri window "preferences" ──  settings.html           │
│  (shared localStorage; storage events for sync)         │
└────────────────────┬────────────────────────────────────┘
                     │  IPC (invoke / emit)
┌────────────────────▼────────────────────────────────────┐
│  Rust (lib.rs)                                          │
│  - update_ptt_shortcut command                         │
│  - Emits: ptt-press, ptt-release, open-preferences     │
│  - Plugins: global-shortcut, shell, deep-link          │
└─────────────────────────────────────────────────────────┘

P2P Audio topology — full mesh:
  peer A ◄──MediaConnection──► peer B
  peer A ◄──MediaConnection──► peer C
  peer B ◄──MediaConnection──► peer C

Signaling topology — star (DataConnections only):
  peer A (host) ◄──DataConnection──► peer B
  peer A (host) ◄──DataConnection──► peer C
  (B and C do NOT have a DataConnection to each other)
```

The **room code is the host's PeerJS peer ID**. When someone creates a room, PeerJS gives them a UUID as their peer ID; that UUID is the room code. Joiners connect directly to that peer ID.

---

## WebRTC & Signaling Deep Dive

### Data protocol (DataConnections — host only)

| Message type | Direction | Payload |
|---|---|---|
| `hello` | joiner → host | `{ pseudo: string }` |
| `peer-list` | host → joiner | `{ peers: [{id, pseudo}], hostId, hostPseudo }` |
| `peer-joined` | host → all existing peers | `{ peerId, pseudo }` |
| `peer-left` | host → all | `{ peerId }` |
| `talking` | any peer → host → relayed to all | `{ peerId, active: bool }` |

### Connection setup sequence

**Creating a room (host):**
1. `getMicStream()` → get `MediaStream`; mute track (`audioTrack.enabled = false`)
2. `fetchIceServers()` → get ICE config
3. `new Peer({ config: { iceServers } })` → PeerJS assigns peer ID
4. `peer.on('open')` → `roomCode = id`, `isHost = true`, `inRoom = true`
5. Accept incoming `DataConnection` via `peer.on('connection')`
6. Accept incoming `MediaConnection` via `peer.on('call')`

**Joining a room:**
1. Same steps 1–3 above
2. `peer.on('open')` → connect to host via `peer.connect(code, { reliable: true })`
3. Send `hello` on DataConnection open
4. Receive `peer-list` → call each listed peer via `peer.call(peerId, stream)`
5. Answer any incoming calls from peers added after you joined

### `connections` Map structure

The `connections` Map (keyed by peer ID) stores:
```js
{
  data:    DataConnection | null,   // only exists for host↔peer relationship
  media:   MediaConnection | null,  // WebRTC audio call
  pseudo:  string,                  // display name
  talking: boolean                  // current talking state
}
```

### Audio muting strategy

The mic `MediaStream` is always active once joined. PTT is implemented by toggling `audioTrack.enabled`:
- `true` → mic audio flows to all peers
- `false` → silence sent (track still exists, no renegotiation needed)

---

## Host Migration

When the host disconnects (DataConnection `close` event fires), all remaining peers independently run the same election algorithm:

1. Collect all known peer IDs from `connections.keys()` + own `peer.id`
2. Sort lexicographically
3. Smallest ID wins → becomes new host

If elected: `becomeHost()` — sets `isHost = true`, updates `roomCode = peer.id`. The existing `peer.on('connection')` handler in `joinRoom()` is guarded by `if (isHost)`, so it automatically starts accepting new joiners.

If not elected: `connectToNewHost(newHostId)` — opens a new DataConnection to the new host, sends `hello` again, registers a new `data` + `close` handler chain.

**Audio is unaffected** — MediaConnections are fully peer-to-peer and survive the host change.

---

## Presence API & Auth Flow

### What the Presence API provides
- Named organisations and channels
- Who is currently connected in each channel (with their `peer_id`)
- Managed ICE/TURN server credentials per organisation
- User identity (display names)

All calls go to `presenceBase()` which reads `localStorage['service-url']` with fallback to `https://voxal.app`.

### API endpoints used

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/orgs` | List organisations for the authenticated user |
| `GET` | `/org/:orgId/presence` | Get all channels + connected peers for the org (`peer_count`, `display_name`, `room_id`, `deputy_peer_id`) |
| `GET` | `/org/:orgId/ice-servers` | Get TURN credentials for the org |
| `POST` | `/` (presence base) | Register session: `{ org_id, channel_name, peer_id, room_id, peer_count, deputy_peer_id }` |
| `DELETE` | `/` (presence base) | Delete current session (on leave) |

All requests include `x-api-token: <token>` header.

### OAuth-style auth flow (three environments)

**Desktop (Tauri):**
1. `connectWithVoxalAccount()` generates a random `state`, stores in `sessionStorage`
2. Opens `https://voxal.app/connect?state=<state>&caller=desktop&responseMode=deep-link` in the **system browser** via `window.__TAURI__.shell.open()`
3. Listens once for `deep-link://new-url` Tauri event
4. Service redirects browser to `voxal://auth?token=<token>&state=<state>`
5. macOS routes `voxal://` to the registered app → Tauri fires `deep-link://new-url`
6. `handleDeepLink()` validates state, saves token to `localStorage`

**iOS (Capacitor):**
1. Same state generation
2. Opens URL in system browser via `window.open(connectUrl, '_system')`
3. Service redirects to `voxal://auth?token=…`
4. iOS routes to app → `AppDelegate.application(_:open:)` → `ApplicationDelegateProxy` → `@capacitor/app` fires `appUrlOpen`
5. Listener in `main.js` calls `handleDeepLink()`

**Web (browser):**
1. Same state generation
2. Opens popup: `window.open(connectUrl, 'voxal-auth', 'width=520,height=720')`
3. Service can either send `postMessage({ token, state })` from the auth origin or redirect the popup back to `https://web.voxal.app/?token=…&state=…`
4. `window.addEventListener('message')` in `main.js` validates origin + state, closes popup, calls `handleDeepLink()`
5. `handleDeepLink()` also accepts `https://web.voxal.app/?token=…` and relays it back to the opener when a popup callback is used

### Important: voxal:// requires a real .app bundle

`make dev` (`npx tauri dev`) cannot register the URL scheme — it's registered by macOS when a proper `.app` bundle is launched. Workflow:
1. Run `make build-debug` once
2. Open `src-tauri/target/debug/bundle/macos/Voxal.app`
3. Switch back to `make dev` — the scheme stays registered in macOS's Launch Services database

Both debug and release builds share the same bundle ID (`com.erwannrobin.voxal`) and therefore share `localStorage`.

### joinChannel flow

When the user clicks a channel in the presence panel:
1. `joinChannel(item)` sets `activeChannel = item.channel.name`
2. If `connected.length === 0`: `createRoom(postPresence)` — user becomes host
3. Otherwise: sort `connected` peers by `peer_id`, `joinRoom(connected[0].peer_id, postPresence)`
4. `postPresence(myPeerId)` is called once the peer has its ID → `postSession(channelName, peerId, { room_id, peer_count, deputy_peer_id })`
5. On leave: `deleteSession()` is called, `activeChannel = null`

---

## ICE / TURN Resolution

Three-tier fallback, tried in order on each room join/create:

1. **Org TURN** — `GET /org/:orgId/ice-servers` with 5s timeout. Used if org has TURN configured. Returns `null` if not configured (falls through, not an error).
2. **Local metered.ca** — reads `localStorage['metered-app-name']` + `localStorage['metered-api-key']`, fetches from `https://<app>.metered.live/api/v1/turn/credentials?apiKey=<key>`.
3. **STUN fallback** — `stun:stun.l.google.com:19302` + `stun:stun1.l.google.com:19302`

---

## Frontend Structure

### `index.html` — three screens + one modal

- `#screen-home` — landing: pseudo field (hidden if already set), create/join room, presence channels panel
- `#screen-room` — active call: peer list, PTT button, free-hand toggle, shortcut display, copy/leave
- `#screen-error` — error display
- `#modal-settings` — in-app settings (used on web/mobile; Tauri desktop opens `settings.html` as a separate window instead)

Screen switching: `showScreen(name)` removes `.active` from all `.screen` elements, adds it to `#screen-<name>`.

### `settings.html` — standalone page

Loaded as a second Tauri `WebviewWindow` named `"preferences"`. Contains a **full duplicate** of all constants and helper functions from `main.js` (there is no module system). Communicates back to the main window through `localStorage` writes, which trigger `storage` events in `main.js`.

### DOM helper convention

`main.js` uses `$('id')` → `document.getElementById('id')`.
`settings.html` uses `$id('id')` → `document.getElementById('id')`.

---

## Global State (main.js)

All mutable state is at module scope:

| Variable | Type | Purpose |
|---|---|---|
| `peer` | `Peer \| null` | PeerJS instance |
| `stream` | `MediaStream \| null` | Local mic stream |
| `audioTrack` | `MediaStreamTrack \| null` | The single audio track (muted/unmuted for PTT) |
| `isHost` | `boolean` | Whether this peer is currently the room host |
| `roomCode` | `string` | Current room code (= host peer ID) |
| `inRoom` | `boolean` | Whether in an active room |
| `isTalking` | `boolean` | Whether PTT is currently active |
| `freeHandMode` | `boolean` | Whether always-on mic mode is enabled |
| `recordingShortcut` | `boolean` | Whether shortcut-capture mode is active |
| `myPseudo` | `string` | Local user's display name |
| `shortcutStr` | `string` | PTT keyboard shortcut (e.g. `Ctrl+Backquote`) |
| `connections` | `Map<string, ConnObj>` | All peer connections |
| `presenceData` | `array` | Last fetched `[{channel, connected}]` |
| `activeChannel` | `string \| null` | Channel name for current presence session |
| `presenceInterval` | `number \| null` | `setInterval` ID for presence polling |
| `_audioCtx` | `AudioContext` | Shared Web Audio context |
| `_keepAliveSource` | `OscillatorNode \| null` | iOS background keep-alive oscillator |

---

## localStorage Schema

| Key | Constant | Default | Description |
|---|---|---|---|
| `pseudo` | — | `''` | Display name |
| `ptt-shortcut` | — | `'Ctrl+Backquote'` | Keyboard shortcut string |
| `presence-api-token` | `PRESENCE_TOKEN_KEY` | `''` | Auth token for Voxal Connect |
| `presence-org-id` | `PRESENCE_ORG_KEY` | `''` | Selected organisation UUID |
| `service-url` | `SERVICE_URL_KEY` | `'https://voxal.app'` | API base URL override |
| `metered-app-name` | `METERED_APP_STORE_KEY` | `''` | metered.ca app name for TURN |
| `metered-api-key` | `METERED_API_STORE_KEY` | `''` | metered.ca API key |
| `metered-status` | `METERED_STATUS_STORE_KEY` | `null` | `'ok'` / `'error'` — TURN test result badge |
| `theme` | `THEME_KEY` | `'system'` | `'dark'` / `'light'` / `'system'` |
| `voxal-connect-url` | — | `'https://voxal.app'` | OAuth service URL override |

`sessionStorage` (not persisted across launches):
- `voxal-auth-state` — CSRF state token during OAuth flow

---

## Audio System

All sounds are synthesized via Web Audio API. No audio files are bundled.

| Function | Trigger | Description |
|---|---|---|
| `playBlip(true)` | PTT activated | Rising chirp 880 Hz → 1200 Hz |
| `playBlip(false)` | PTT released | Falling chirp 800 Hz → 500 Hz |
| `playCarillon()` | Peer joins | Ascending triad: C5 → E5 → G5 |
| `playGoodbye()` | Peer leaves | Descending fifth: G5 → C5 |

`_audioCtx` is shared across all audio functions. It must be resumed inside a user gesture (`ctx.state === 'suspended' → ctx.resume()`).

---

## iOS Background Keep-Alive

iOS suspends WKWebView JS when the app goes to background. Two layers prevent this:

**JavaScript layer (`main.js`):** `startKeepAlive()` creates a 20 Hz sine oscillator at −60 dB (below hearing threshold) connected to `AudioContext.destination`. Non-silent audio output prevents WKWebView from being paused.

**Native layer (`AppDelegate.swift`):** On `applicationDidEnterBackground`, starts an `AVAudioEngine` with an `AVAudioPlayerNode` playing a 1 Hz sine at `0.001` amplitude in a loop. This holds the `AVAudioSession` active, which keeps the WKWebView JS engine running.

Both layers are stopped on `applicationDidBecomeActive`. The `AVAudioSession` is configured as `.playAndRecord / .voiceChat` with Bluetooth and speaker routing options.

---

## Tauri Backend (Rust)

Located in `src-tauri/src/lib.rs`.

### Plugins

| Plugin | Purpose |
|---|---|
| `tauri-plugin-global-shortcut` | System-wide PTT keyboard shortcut |
| `tauri-plugin-shell` | Open URLs in system browser (`shell.open`) |
| `tauri-plugin-deep-link` | Handle `voxal://` URL scheme callbacks |

### IPC command

`update_ptt_shortcut(shortcut: String) -> Result<(), String>`
- Unregisters the current shortcut
- Re-registers with the new key combo
- Updates `PttShortcut` state (Mutex-wrapped `String`)

### Events emitted from Rust → JS

| Event | When |
|---|---|
| `ptt-press` | Global shortcut key pressed |
| `ptt-release` | Global shortcut key released |
| `open-preferences` | "Voxal → Preferences…" menu item clicked |

### Default shortcut
`Ctrl+Backquote` (backtick `` ` ``). Defined as `DEFAULT_SHORTCUT` constant in both `lib.rs` and `main.js`.

### Capabilities (`default.json`)
Both windows (`"main"` and `"preferences"`) share one capability file. Permissions include `core:default`, `core:webview:allow-create-webview-window`, window management, global shortcut, `shell:allow-open`, and `deep-link:default`.

---

## Platform Detection & Guards

All platform-specific code is guarded at runtime:

```js
if (window.__TAURI__)                              // Tauri desktop
else if (window.Capacitor?.isNativePlatform())     // iOS / Android
else                                               // plain web browser
```

Specific Capacitor plugins accessed via:
```js
window.Capacitor.Plugins.Haptics    // haptic feedback
window.Capacitor.Plugins.StatusBar  // status bar styling
window.Capacitor.Plugins.App        // appUrlOpen (deep link)
window.Capacitor.Plugins.PTTPlugin  // iOS PushToTalk framework (if available)
```

Mobile-specific UI: `document.body.classList.add('platform-mobile')` is added at init when `isNativePlatform()` is true.

---

## Settings Window Architecture

**On Tauri desktop:** `openSettings()` creates a new `WebviewWindow('preferences', { url: 'settings.html', … })`. A reference is kept in `_prefsWin`; if the window already exists, it is focused instead of recreated.

**On web / mobile:** `openSettings()` shows `#modal-settings` (in-page modal in `index.html`).

**Cross-window synchronisation:** `settings.html` writes to `localStorage` on every field change. The main window listens via `window.addEventListener('storage', …)` and reacts to:
- `THEME_KEY` → re-applies theme
- `PRESENCE_TOKEN_KEY` / `PRESENCE_ORG_KEY` → restarts or stops presence polling
- `METERED_*` keys → updates TURN badge

---

## Theme System

Three modes: `dark` (default), `light`, `system` (follows OS preference).

Stored in `localStorage['theme']`. Applied via `data-theme` attribute on `<html>`.

**CSS structure:**
- `:root` — dark theme vars (always present)
- `html[data-theme="light"]` — light overrides
- `@media (prefers-color-scheme: light) { html[data-theme="system"] }` — system auto

**Flash prevention:** Both `index.html` and `settings.html` include an inline `<script>` immediately after `<head>` (before any CSS loads) that reads `localStorage['theme']` and sets `document.documentElement.setAttribute('data-theme', …)`.

**Cross-window sync:** `storage` event in `main.js` listens for `THEME_KEY` changes written by `settings.html` and calls `applyTheme()`.

---

## Deep Link / OAuth Flow (voxal://)

### Registration
- **macOS:** `CFBundleURLTypes` is generated from `tauri.conf.json` `plugins.deep-link.desktop.schemes: ["voxal"]`. Only registered by macOS when a proper `.app` bundle is launched. `make dev` alone is not sufficient.
- **iOS:** `CFBundleURLTypes` in `ios/App/App/Info.plist` with scheme `voxal`.

### State / CSRF protection
`generateState()` produces a random UUID (or random string fallback). Stored in `sessionStorage['voxal-auth-state']`. On callback, `handleDeepLink()` compares incoming `state` to stored value before accepting the token. Mismatch → token ignored, warning logged.

### Token lifecycle
- Stored: `localStorage[PRESENCE_TOKEN_KEY]`
- On disconnect (`disconnectAccount()`): both token and org are removed from `localStorage`
- Presence polling stops and UI resets when token is removed

---

## Keyboard Shortcuts

### PTT shortcut (configurable)
- Default: `Ctrl+Backquote`
- Stored in `localStorage['ptt-shortcut']`
- Format: `Modifier+KeyCode` (e.g. `Ctrl+KeyA`, `Alt+Space`)
- `shortcutFromEvent(e)` builds the string from a `KeyboardEvent`
- `matchesShortcut(e)` checks if an event matches the stored shortcut
- `displayShortcut(raw)` converts key codes to readable labels

### In-browser shortcuts (when tab focused)
| Key | Action | Condition |
|---|---|---|
| `Space` | PTT hold | Always (in-browser) |
| `Enter` | Toggle free-hand | Only when `inRoom === true` |
| Configured shortcut | PTT hold | Always |

### Global shortcut (Tauri — works when app is in background)
Registered in Rust via `tauri-plugin-global-shortcut`. Fires `ptt-press` / `ptt-release` events to JS. Shortcut can be changed from JS via `update_ptt_shortcut` IPC command.

### Recording a new shortcut
`startRecordingShortcut()` → UI switches to capture mode → next keydown (non-modifier only) → `applyNewShortcut()` → updates Rust via IPC + saves to localStorage.

---

## Mobile (Capacitor / iOS)

### What works
- Full P2P room create/join
- PTT via tap-and-hold on the mic button (`pointerdown` / `pointerup` / `pointercancel`)
- Free-hand mode
- Haptic feedback on PTT via `@capacitor/haptics`
- `voxal://` deep links for OAuth
- Background audio (via `AVAudioEngine` keep-alive — see above)

### What doesn't work on mobile
- Global keyboard shortcut (no background keyboard access)
- `Space`/`Enter` shortcuts (no hardware keyboard assumed)

### Capacitor config (`capacitor.config.json`)
```json
{
  "appId": "com.erwannrobin.voxal",
  "webDir": "src",
  "plugins": {
    "StatusBar": { "overlaysWebView": true, "style": "DARK", "backgroundColor": "#16161e" }
  }
}
```

### Mobile sync workflow
After any `src/` change: `make cap-sync` (syncs web assets) → build from Xcode / Android Studio.

---

## macOS Entitlements & Permissions

### Files
- `src-tauri/entitlements.plist` — referenced by `tauri.conf.json` `bundle.macOS.entitlements`
- `src-tauri/Info.plist` — referenced by `tauri.conf.json` `bundle.macOS.infoPlist`

### `entitlements.plist` content
```xml
<key>com.apple.security.device.audio-input</key><true/>
<key>com.apple.security.app-sandbox</key><false/>
```

### `Info.plist` content
```xml
<key>NSMicrophoneUsageDescription</key>
<string>Voxal needs microphone access to transmit your voice in a room.</string>
```

Both are required for macOS to grant mic access. The entitlement grants the capability; the usage description is shown to the user in the system permission dialog.

> **Important:** `tauri.conf.json`'s `bundle.macOS.infoPlist` must be a **file path string**, not an inline JSON object. The field only accepts a path.

---

## Known Constraints & Edge Cases

### PeerJS public server limits
`0.peerjs.com` allows ~50 simultaneous connections per IP. For larger groups or production use, self-host the PeerJS server.

### NAT traversal
Without TURN, peers behind strict NAT/firewalls may fail to connect. The presence API provides managed TURN credentials per org. Local metered.ca config is the manual fallback.

### `make dev` and `voxal://` scheme
`npx tauri dev` does not register `voxal://` with macOS Launch Services — only a proper `.app` bundle does. Run `make build-debug` once, open the resulting `.app`, then return to `make dev`. The scheme registration persists in the OS database.

### Debug vs release build and shared localStorage
Both debug and release builds share `localStorage` because they use the same bundle ID (`com.erwannrobin.voxal`). Tokens and settings carry over between builds.

### Web version requires HTTPS
`getUserMedia` requires either HTTPS or `localhost`. Plain HTTP will result in `navigator.mediaDevices` being `undefined`. The `getMicStream()` function handles both `navigator.mediaDevices.getUserMedia` and the `webkitGetUserMedia` prefixed version.

### AudioContext user-gesture requirement
`_audioCtx` is created at module load time but starts `suspended`. It must be resumed inside a user gesture. All audio-playing functions call `ctx.resume()` before using the context.

### settings.html is not a module
`settings.html` uses an inline `<script>` block with its own copy of all constants (`DEFAULT_PRESENCE_BASE`, `SERVICE_URL_KEY`, `PRESENCE_TOKEN_KEY`, etc.) and helper functions (`presenceBase()`, `voxalConnectUrl()`, etc.). If you update these in `main.js`, you must update `settings.html` too.

### Host election determinism
All peers use the same algorithm (sort peer IDs lexicographically, pick smallest). It is important that the election is **deterministic and independent** — no coordination message is needed. This means a temporary network split could theoretically elect two hosts, but in practice the DataConnection `close` event fires reliably.

### Presence polling interval
`startPresencePolling()` fetches `/org/:orgId/presence` every 10 seconds (or whichever interval is set in `presenceInterval`). Polling only starts if `presenceConfigured()` returns true (both token and org ID are set). It stops when the user disconnects or the tab/app closes.
