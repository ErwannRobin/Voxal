# Copilot Instructions — Voxal

Voxal is a serverless P2P push-to-talk voice chat app. It runs as a native desktop app (Tauri 2), a mobile app (Capacitor), and as a plain static web page — all from the same `src/` folder. There is **no bundler or build step** for the frontend.

---

## KNOWLEDGE folder

The `KNOWLEDGE/` folder at the root of the repo is a persistent knowledge base. **Read it at the start of every session.**

| File | Purpose |
|---|---|
| `KNOWLEDGE/learning.md` | Facts and gotchas discovered during development. Read on every launch. Append new learnings as they are discovered. |
| `KNOWLEDGE/todos.md` | Long-term backlog of features and investigations. Update when items are completed or new ones are added. |
| `KNOWLEDGE/universal-links-aasa.md` | Step-by-step guide to set up Universal Links (AASA) for clickable room share links. |

**Rules:**
- Read `KNOWLEDGE/learning.md` before starting any task — it contains non-obvious platform gotchas.
- Append to `KNOWLEDGE/learning.md` whenever something non-obvious is discovered (iOS quirks, CSS pitfalls, Tauri limitations, etc.).
- Update `KNOWLEDGE/todos.md` when a backlog item is completed (mark it done or remove it) or when a new one is identified.

---

## Commands

```sh
make dev          # Tauri desktop — hot reload (primary dev workflow)
make run-web      # Serve src/ on http://localhost:8080 (web-only testing)
make check        # Rust type-check without building (fast feedback)
make build-debug  # macOS debug bundle — also registers voxal:// URL scheme
make build        # Full release build
make install      # npm install + cargo fetch (first-time setup)
```

There are no tests. `make check` is the closest equivalent to a lint/type-check step.

> **macOS URL scheme note:** `make dev` (`npx tauri dev`) cannot register the `voxal://` custom scheme — it requires a real `.app` bundle. Run `make build-debug` once, open `src-tauri/target/debug/bundle/macos/Voxal.app`, then switch back to `make dev`. The registered scheme persists.

---

## Architecture

### Frontend (`src/`)
- **No framework, no bundler.** Three files: `index.html`, `main.js`, `styles.css` + `settings.html`.
- All app logic lives in `main.js` (~1150 lines). `settings.html` is a self-contained standalone page with its own inline `<script>` block — it duplicates constants and helper functions from `main.js` rather than importing them.
- PeerJS is bundled locally at `src/assets/peerjs.min.js` — never loaded from a CDN.

### WebRTC topology
- **Signaling: star.** The room host maintains a `DataConnection` to every peer.
- **Audio: full mesh.** Every peer opens a `MediaConnection` directly to every other peer (Opus codec, 16 kHz mono).
- The room code IS the host's PeerJS peer ID. When the host leaves, all remaining peers independently elect a new host by sorting peer IDs and picking the smallest.

### Tauri backend (`src-tauri/src/lib.rs`)
- One Rust command: `update_ptt_shortcut` — re-registers the global shortcut and returns a `Result<(), String>`.
- Emits two events: `ptt-press` and `ptt-release` (listened to in `main.js`).
- Emits `open-preferences` from the menu (listened to in `main.js` to open `settings.html`).
- Three plugins: `tauri-plugin-global-shortcut`, `tauri-plugin-shell`, `tauri-plugin-deep-link`.

### Settings window
On Tauri desktop, settings open as a second `WebviewWindow` loading `settings.html`. On web/mobile, an in-app modal in `index.html` is used instead. Both share state via `localStorage`. The main window syncs changes from `settings.html` via the `storage` event.

### Platform detection pattern
```js
if (window.__TAURI__)                              // Tauri desktop
else if (window.Capacitor?.isNativePlatform())     // iOS / Android
else                                               // plain web
```
Every Tauri/Capacitor-specific feature must be guarded this way.

### Presence / auth
- Optional. Requires a token + org ID stored in `localStorage`.
- All API calls go through `presenceBase()` which reads `localStorage['service-url']` with fallback to `https://voxal.lovable.app`.
- Auth flow: `connectWithVoxalAccount()` opens `https://voxal.lovable.app/connect?state=…` in the system browser. The service redirects back via `voxal://auth?token=…` (desktop) or `postMessage` (web).
- Deep link handled by `handleDeepLink()` — always validate the `state` parameter against `sessionStorage`.

---

## Key conventions

### localStorage keys
All persistence uses `localStorage`. Keys are defined as constants at the top of `main.js` (and duplicated in `settings.html`'s inline script):

| Key | Constant | Purpose |
|---|---|---|
| `pseudo` | — | Display name |
| `ptt-shortcut` | — | Keyboard shortcut string |
| `presence-api-token` | `PRESENCE_TOKEN_KEY` | Auth token |
| `presence-org-id` | `PRESENCE_ORG_KEY` | Selected org |
| `service-url` | `SERVICE_URL_KEY` | API base URL override |
| `metered-app-name` | `METERED_APP_STORE_KEY` | TURN app name |
| `metered-api-key` | `METERED_API_STORE_KEY` | TURN API key |
| `theme` | `THEME_KEY` | `dark` / `light` / `system` |

### Theme system
Applied before first paint via an inline `<script>` at the top of both HTML files. `data-theme` attribute on `<html>`. Dark is the default (`:root` vars). Light overrides via `html[data-theme="light"]`. System uses `@media (prefers-color-scheme: light) { html[data-theme="system"] }`.

### DOM helper
`main.js` uses `$('id')` as a shorthand for `document.getElementById('id')`. `settings.html` uses `$id('id')`.

### Microphone access
Always call `getMicStream()` — not `navigator.mediaDevices.getUserMedia` directly. It handles the `webkitGetUserMedia` fallback and throws a clear error if neither is available.

### Adding a new Tauri IPC command
1. Define the function in `lib.rs` with `#[tauri::command]`
2. Add to `tauri::generate_handler![...]`
3. Call via `window.__TAURI__.core.invoke('command_name', { arg })` in JS, always guarded with `if (window.__TAURI__)`
4. Add any new plugin permissions to `src-tauri/capabilities/default.json`

### macOS entitlements
`src-tauri/entitlements.plist` and `src-tauri/Info.plist` are referenced in `tauri.conf.json` under `bundle.macOS`. Edit these files directly — do not use inline JSON in `tauri.conf.json` (the `infoPlist` key expects a file path, not an object).
