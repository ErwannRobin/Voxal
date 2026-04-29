# Voxal — Learnings

Things discovered during development that aren't obvious from the code.
Copilot should read this file at the start of every session.

---

## iOS / Capacitor

- **`navigator.clipboard.writeText`** fails silently in WKWebView (Capacitor iOS). Always use `fallbackCopy()` (textarea + `execCommand('copy')`) as a fallback.
- **`navigator.share()` with custom scheme URLs** (`voxal://`) — iOS rejects `url:` field for non-http(s) schemes. Pass the deep link in the `text:` field instead. WhatsApp won't make it clickable; Universal Links (HTTPS) are required for that.
- **`navigator.share()` logs** "Unable to hide query parameters from script (missing data)" — harmless WebKit internal privacy warning, not an error.
- **`position: fixed`** elements are NOT clipped by `overflow: hidden` ancestors in standard CSS, but the dot visibility issue on desktop was caused by the element being too small (single `●` glyph at 9px). Use a CSS circle (`width`/`height` + `background`) instead of a text character.
- **`navigator.onLine`** is `true` even when there is no TURN configured. Use the stored `METERED_STATUS_STORE_KEY` to determine TURN availability separately.
- **`PTChannelManager`** (PushToTalkUI) manages the AVAudioSession exclusively. Do NOT call `setActive(true)` on app launch — only inside `didActivateAudioSession` / `didDeactivateAudioSession` callbacks. Also, do NOT call `setCategory` inside `didActivate` — it disrupts WebRTC's existing audio pipeline. Just call `setActive(true)`.
- **WKWebView JS is suspended in background** even with `audio`/`voip`/`push-to-talk` background modes. The WebContent process (which runs JS) is independent from the main app process. Solution: keep an active Web Audio API graph running (`OscillatorNode → GainNode(0) → destination`) while in a room — iOS's `audio` background mode protects the WebContent process when audio is actively flowing. This makes `evaluateJavaScript` work in background. Route mic through a `GainNode` instead of using `audioTrack.enabled`, so Swift can control PTT gain without JS being needed for the toggle.
- **AudioContext may be suspended in background** by WebKit even if the process is alive. In `didBeginTransmittingFrom`, call `audioCtx.resume().then(function(){ gainNode.gain.value=1 })` to ensure the context is running before setting gain. Direct `gain.value=1` on a suspended context has no effect.
- **PTChannelManager async init race**: `PTChannelManager.channelManager(delegate:restorationDelegate:)` is async. If `join()` is called before it completes, the channel is never joined and the Dynamic Island button press silently does nothing. Fix: store `CheckedContinuation` objects and signal them once the manager is ready; `join()` awaits them with a 5s timeout.
- **`call.resolve()` / `call.reject()`** in Capacitor plugins must be called on the main thread when inside a Swift `Task {}`. Use `await MainActor.run { call.resolve() }` to avoid `unsafeForcedSync` warnings.
- **UIScene lifecycle** warning ("UIScene lifecycle will soon be required"): requires `SceneDelegate.swift` + `UIApplicationSceneManifest` in `Info.plist`. `AppDelegate` loses `var window: UIWindow?`; deep links must also be handled in `scene(_:openURLContexts:)`.
- **`voxal://` custom scheme** is registered in `ios/App/App/Info.plist` under `CFBundleURLSchemes`. Cold-launch deep links come via `App.getLaunchUrl()`, runtime links via `appUrlOpen` event.

## macOS / Tauri

- **`make dev`** (`npx tauri dev`) does NOT register the `voxal://` URL scheme. Run `make build-debug` once and open the `.app` bundle to register it. The registration persists while switching back to `make dev`.
- **Global PTT shortcut default** is `Shift+Space` (changed from `Ctrl+Backquote`).

## Android / Capacitor

- **Host connection check gotcha**: host peers do not have a `connections.get(roomCode)` DataConnection entry to themselves. Running host-connection liveness checks unconditionally (host + non-host) triggers false host-migration on resume/foreground.
- **Host migration race**: stale `close` events from the dead host can fire after a new host is elected. Guard `initiateHostMigration(...)` with the specific disconnected host id, and preserve existing `media` links when a reconnected joiner replaces only its `data` channel.
- **Host migration timing**: the elected host can receive incoming `DataConnection`s before it has locally flipped `isHost = true`. Non-host peers should accept those migration-time joiner connections when they are the smaller peer ID, and `MediaConnection.close` handlers must not tear down an otherwise healthy `data` channel for that peer.
- **Host election source of truth**: elect the next host from a stable membership set updated by `peer-list` / `peer-joined` / `peer-left`, not from `connections.keys()`. Live media/data links can disappear transiently and cause split-brain if they drive election.
- **Host migration: retry before re-electing**: when `connectToNewHost()` fails to open a DataConnection, do NOT immediately trigger `initiateHostMigration()` (which forgets the elected host and self-promotes). Instead, retry with a generation counter to discard stale events. Only re-elect after exhausting retries.
- **Old room codes should stay joinable**: any peer still in the room can accept a misdirected late joiner and send a `redirect` message to the current host. Only the deputy should auto-promote on incoming joiners when the current host connection is actually gone.
- **Heartbeat is bidirectional**: the host broadcasts periodic heartbeats so non-host peers can detect a dead host, and non-host peers send heartbeats back so the host can evict stale peer connections. PeerJS may not emit prompt `close` events for silent disconnects.
- **Freeze room membership during host migration**: when the host dies, snapshot the remaining peers, keep placeholders/aliases for that frozen set through handoff, and only prune peers that still have not reattached after a settle timeout. Do not let the first post-migration `peer-list` immediately shrink the logical room.
- **`peer-list` must refresh aliases even for peers with live media**: after host migration, some peers are already connected by `MediaConnection`. Do not skip pseudo updates just because `prev.media` exists, or names stay stale until another rename event arrives.
- **Peer list reset during migration**: non-host peers often track other members with media-only connections. `MediaConnection.close` must keep a placeholder entry for any peer still present in `knownPeerIds`, or host migration will wipe the visible peer list until everyone reconnects.
- **Duplicate joiner DataConnections**: the host must replace duplicate `DataConnection`s from the same peer and ignore stale callbacks. Otherwise an old connection's `close` handler can remove the new one and re-broadcast `peer-joined` / `peer-left` incorrectly.
- **Duplicate reconnect ordering matters**: when replacing a peer's `DataConnection`, store the new connection in `connections` first, then close the old one. Closing the old connection first lets a synchronous stale `close` handler think it is still current and evict the peer.
- **`peer-unavailable` during room runtime is often non-fatal**: after joining, PeerJS can emit `Could not connect to peer ...` for a side `MediaConnection` to a non-host peer that has gone stale or is reconnecting. Do not route those through the global fatal `showError(...)` path once `inRoom` is true; warn and let host reconciliation / later retries fix the mesh.
- **Authoritative `peer-list` on duplicate reconnect**: when the host replaces a duplicate joiner connection, it should broadcast a fresh `peer-list` to all peers, and clients should remove peers omitted from that list to clear stale room entries.
- **Host migration is "rejoin the room with the new host"**: a single `connectToHost(hostId, { mode: 'initial' | 'migration' })` primitive handles both flows. Migration success is defined as **the new host's first authoritative `peer-list` arriving** — not the DataConnection opening. A `roomState` machine (`idle`/`connecting`/`connected`/`migrating`) makes the trigger idempotent. Failed candidates are added to `_migrationExcluded` so re-election skips them. Audio MediaConnections to non-host peers are never touched during migration; only the old host's `data` and `media` are torn down.
- **`connectToHost(..., { mode: 'initial' })` must not require `inRoom`**: first-time joins run before `finishJoin()` flips `inRoom = true`. Keep the `inRoom` guard for migration/reconnect paths only, or peers can connect to PeerJS but never actually join a host-created room.
- **Split brain can start from asymmetric `peer-left` delivery before host death**: one peer may process a final host-relayed `peer-left` while another does not, so `knownPeerIds` diverges just before election. Fix by basing migration election on the last authoritative host `peer-list` snapshot, not the live incrementally mutated roster.
- **Custom Capacitor Android plugin methods** must use `@PluginMethod` from `com.getcapacitor.PluginMethod`; without it, JS calls (e.g. `window.Capacitor.Plugins.AudioForeground.start()`) are not exposed.
- **Android 12+ `AppOps` attribution logs** (`attributionTag ... not declared in manifest`) can come from service `getSystemService(...)` calls using the default empty context. Declare a `<attribution>` tag in `AndroidManifest.xml` and use `createAttributionContext(...)` before accessing services like `AudioManager` or `NotificationManager`.

## Web / CSS

- **Pseudo storage scope**: on plain web, store the pseudo in `sessionStorage` so each browser tab can have its own name. On Tauri/Capacitor, keep using `localStorage` so the single app window persists it and the desktop settings window can sync it.
- **`min-height: 100vh` + `overflow-y: auto`** causes the page to scroll. Use `height: 100vh; overflow: hidden` on `body` and `.screen`, with `flex: 1; overflow-y: auto; min-height: 0` only on the scrollable child.
- **Toast positioning**: `position: fixed` at the bottom of the viewport (not `position: absolute` inside a screen) — otherwise clipped by `overflow: hidden` on `.screen`.
- **Copy toast** uses `.visible` class (opacity 1) / no class (opacity 0), not `.hidden`. This avoids a flash of the toast on page load.
- **Status dot** (`#turn-badge`): `position: fixed` top-right. Use a CSS circle (`width`/`height` + `background-color`) not a text glyph — glyphs are too small and color-dependent.
- **`white-space: nowrap` alone is not enough** to prevent a popover from stretching — also add `width: max-content`.

- **PushToTalk framework iOS 17 Swift method names** (read from Xcode SDK + Swift overlay): `channelDescriptor(restoredChannelUUID:)`, `channelManager(_:didJoinChannel:reason:)`, `channelManager(_:didLeaveChannel:reason:)`, `channelManager(_:channelUUID:didBeginTransmittingFrom:)`, `channelManager(_:channelUUID:didEndTransmittingFrom:)`, `incomingPushResult(channelManager:channelUUID:pushPayload:)`, `channelManager(_:didActivate:)`, `channelManager(_:didDeactivate:)`. The PTT button events are `didBeginTransmittingFrom`/`didEndTransmittingFrom`, NOT `didActivate`/`didDeactivate` (those are only audio session lifecycle).
 added as `.swift` files inside `ios/App/App/` must be manually registered in `project.pbxproj` (PBXBuildFile, PBXFileReference, PBXGroup, and PBXSourcesBuildPhase). The file existing on disk is not enough — if not in the project file, it is never compiled and `window.Capacitor.Plugins.PluginName` will be `undefined` at runtime.

## Sync rule

Every change to `src/` MUST be mirrored to:
- `ios/App/App/public/`
- `android/app/src/main/assets/public/`

Use Python string replacement scripts for multi-line patches to avoid manual errors.

## Workflow

- Suggest a commit message in the final response only when the current turn actually changed repository files.

## Host migration refactor

- Host migration uses a state machine (`idle`/`connecting`/`connected`/`migrating`) and reuses `connectToHost(hostId, { mode })` for both initial join and migration. Migration success = first authoritative `peer-list` from the new host, not DataConnection open. Failed candidates are added to `_migrationExcluded` to allow re-election without restart. Audio MediaConnections to non-host peers are never touched during migration.

---

_Copilot: append new learnings here as they are discovered. Keep entries concise and actionable._
