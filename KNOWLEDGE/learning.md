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
- **`PTChannelManager`** (PushToTalkUI) manages the AVAudioSession exclusively. Do NOT call `setActive(true)` on app launch — only inside `didActivateAudioSession` / `didDeactivateAudioSession` callbacks.
- **`call.resolve()` / `call.reject()`** in Capacitor plugins must be called on the main thread when inside a Swift `Task {}`. Use `await MainActor.run { call.resolve() }` to avoid `unsafeForcedSync` warnings.
- **UIScene lifecycle** warning ("UIScene lifecycle will soon be required"): requires `SceneDelegate.swift` + `UIApplicationSceneManifest` in `Info.plist`. `AppDelegate` loses `var window: UIWindow?`; deep links must also be handled in `scene(_:openURLContexts:)`.
- **`voxal://` custom scheme** is registered in `ios/App/App/Info.plist` under `CFBundleURLSchemes`. Cold-launch deep links come via `App.getLaunchUrl()`, runtime links via `appUrlOpen` event.

## macOS / Tauri

- **`make dev`** (`npx tauri dev`) does NOT register the `voxal://` URL scheme. Run `make build-debug` once and open the `.app` bundle to register it. The registration persists while switching back to `make dev`.
- **Global PTT shortcut default** is `Shift+Space` (changed from `Ctrl+Backquote`).

## Web / CSS

- **`min-height: 100vh` + `overflow-y: auto`** causes the page to scroll. Use `height: 100vh; overflow: hidden` on `body` and `.screen`, with `flex: 1; overflow-y: auto; min-height: 0` only on the scrollable child.
- **Toast positioning**: `position: fixed` at the bottom of the viewport (not `position: absolute` inside a screen) — otherwise clipped by `overflow: hidden` on `.screen`.
- **Copy toast** uses `.visible` class (opacity 1) / no class (opacity 0), not `.hidden`. This avoids a flash of the toast on page load.
- **Status dot** (`#turn-badge`): `position: fixed` top-right. Use a CSS circle (`width`/`height` + `background-color`) not a text glyph — glyphs are too small and color-dependent.
- **`white-space: nowrap` alone is not enough** to prevent a popover from stretching — also add `width: max-content`.

## Sync rule

Every change to `src/` MUST be mirrored to:
- `ios/App/App/public/`
- `android/app/src/main/assets/public/`

Use Python string replacement scripts for multi-line patches to avoid manual errors.

---

_Copilot: append new learnings here as they are discovered. Keep entries concise and actionable._
