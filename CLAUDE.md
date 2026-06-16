# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## KNOWLEDGE folder

Read `KNOWLEDGE/learning.md` at the start of every session — it contains non-obvious platform gotchas for iOS, Android, Tauri, and web that are not derivable from the code alone. Append new learnings as they are discovered. Update `KNOWLEDGE/todos.md` when items are completed or new ones identified.

## Commands

```sh
make install      # First-time setup: npm install + cargo fetch (with preflight checks)
make dev          # Tauri desktop — hot reload (primary dev workflow)
make run-web      # Serve src/ on http://localhost:8080 (web-only testing)
make check        # Rust type-check without building (fast feedback, no tests)
make test         # Full suite: Rust type-check + Rust unit tests + Playwright E2E
make test-rust    # Rust unit tests only
make test-e2e     # Playwright E2E only (auto-starts dev server)
make build-debug  # macOS debug bundle — registers voxal:// URL scheme
make build        # Release build
make cap-sync     # Sync src/ assets to ios/ and android/ after any src/ change
make cap-ios      # Open Xcode
make cap-android  # Open Android Studio
make build-android # Signed release AAB for Google Play
make release      # Bump version, build signed release, publish GitHub Release
```

**macOS URL scheme:** `make dev` cannot register `voxal://` (needs a real `.app` bundle). Run `make build-debug` once, open the `.app`, then return to `make dev`. The registration persists.

**E2E tests** use Playwright against `http://127.0.0.1:8080` (config: `playwright.config.js`, tests in `tests/e2e/`).

## Architecture

### Frontend (`src/`)

No framework, no bundler. The frontend is plain HTML/CSS/JS served as static files:
- `index.html` / `main.js` / `styles.css` — main app (~1150 lines of logic in `main.js`)
- `settings.html` — standalone page with its own inline `<script>`. It **duplicates** constants and helpers from `main.js` rather than importing them (no module system).
- `screen-popup.html`, `video-popup.html` — feature popups
- `version.js` — exports `VOXAL_VERSION` and `VOXAL_BUILD_DATE`
- PeerJS is bundled at `src/assets/peerjs.min.js` — never loaded from a CDN.

After any `src/` change, run `make cap-sync` to mirror changes to `ios/App/App/public/` and `android/app/src/main/assets/public/`.

### WebRTC topology

- **Signaling: star** — host maintains a `DataConnection` to every peer via PeerJS.
- **Audio: full mesh** — every peer opens a `MediaConnection` directly to every other peer (Opus, 16 kHz mono).
- The room code IS the host's PeerJS peer ID.
- **Host migration**: when the host disconnects, all remaining peers follow the authoritative `deputyId`/`successorIds` chain broadcast in every `peer-list` and heartbeat. Migration uses a state machine (`idle`/`connecting`/`connected`/`migrating`) via `connectToHost(hostId, { mode: 'initial' | 'migration' })`. Success = first authoritative `peer-list` from the new host. Audio `MediaConnection`s to non-host peers are never torn down during migration.

### Tauri backend (`src-tauri/src/lib.rs`)

One Rust command: `update_ptt_shortcut` — re-registers the global shortcut. Emits three events to the frontend: `ptt-press`, `ptt-release`, `open-preferences`. Plugins: `tauri-plugin-global-shortcut`, `tauri-plugin-shell`, `tauri-plugin-deep-link`.

Capabilities/permissions are declared in `src-tauri/capabilities/default.json`. macOS entitlements are in `src-tauri/entitlements.plist` and `src-tauri/Info.plist` (not inline JSON in `tauri.conf.json`).

### Settings window

On Tauri, settings open as a second `WebviewWindow` loading `settings.html`. On web/mobile, an in-page modal in `index.html` is used. Both share state via `localStorage`; the main window syncs changes via the `storage` event.

### Platform detection

```js
if (window.__TAURI__)                          // Tauri desktop
else if (window.Capacitor?.isNativePlatform()) // iOS / Android
else                                           // plain web
```

Every Tauri/Capacitor-specific feature must be guarded this way.

### Presence (optional)

Auth token + org ID stored in `localStorage`. All API calls go through `presenceBase()` which reads `localStorage['service-url']` with fallback to `https://voxal.app`. Deep links from the auth flow arrive via `voxal://auth?token=…` (desktop) or `postMessage` (web) and are handled by `handleDeepLink()` — always validate the `state` parameter against `sessionStorage`.

## Key conventions

### Adding a Tauri IPC command
1. Define in `lib.rs` with `#[tauri::command]`
2. Add to `tauri::generate_handler![...]`
3. Call via `window.__TAURI__.core.invoke('command_name', { arg })` in JS, guarded with `if (window.__TAURI__)`
4. Add plugin permissions to `src-tauri/capabilities/default.json`

### DOM helpers
`main.js` uses `$('id')` = `document.getElementById('id')`. `settings.html` uses `$id('id')`.

### Microphone access
Always call `getMicStream()`, not `navigator.mediaDevices.getUserMedia` directly. With "join muted" mode, `stream` is `null` until first speak — use `connectOutgoingAudioToPeers()` (not raw `peer.call`) for outgoing audio at join time.

### localStorage keys (defined as constants at top of `main.js`, duplicated in `settings.html`)

| Key | Constant | Purpose |
|---|---|---|
| `pseudo` | — | Display name |
| `ptt-shortcut` | — | Keyboard shortcut |
| `presence-api-token` | `PRESENCE_TOKEN_KEY` | Auth token |
| `presence-org-id` | `PRESENCE_ORG_KEY` | Selected org |
| `service-url` | `SERVICE_URL_KEY` | API base URL override |
| `metered-app-name` | `METERED_APP_STORE_KEY` | TURN app name |
| `metered-api-key` | `METERED_API_STORE_KEY` | TURN API key |
| `theme` | `THEME_KEY` | `dark` / `light` / `system` |

### Theme
Applied before first paint via inline `<script>` at the top of both HTML files. `data-theme` on `<html>`. Dark is the default; light overrides via `html[data-theme="light"]`; system uses `@media (prefers-color-scheme: light) { html[data-theme="system"] }`.

### Release versioning
`make release VERSION=x.y.z` syncs version across `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src/version.js`, and `android/app/build.gradle` (also increments `versionCode`). Omit `VERSION` to auto-bump the patch.
