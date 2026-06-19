# Voxal — TODO

Things to implement or investigate, ordered roughly by priority.

---

## 🧩 Revisit glib security update unblock

**Goal:** Remove temporary Dependabot ignore for `glib` and upgrade to `glib >= 0.20` once upstream supports it.

Current blocker:
- `tauri 2.11.x` pulls `gtk 0.18.x`, which requires `glib ^0.18`.
- Forced update (`cargo update -p glib --precise 0.20.0`) fails with resolver conflict.

Exit criteria:
- Tauri/gtk-rs chain allows `glib 0.20+`
- Remove `glib` ignore from `.github/dependabot.yml`
- Run `make check` and commit lockfile updates

---

## 🧩 Revisit rand 0.7 security update unblock

**Goal:** Eliminate `rand 0.7.3` from the lockfile once upstream dependencies stop requiring `rand ^0.7`.

Current state:
- `rand 0.8.5` was updated to `0.8.6` in `src-tauri/Cargo.lock`.
- `rand 0.7.3` still comes from `tauri-utils -> kuchikiki -> selectors 0.24 -> phf_codegen 0.8 -> phf_generator 0.8`.
- Forcing `rand@0.7.3` to `0.8.6` fails due semver constraints in that upstream chain.

Exit criteria:
- Upstream `tauri-utils` / `kuchikiki` / `selectors` chain no longer pulls `phf_generator 0.8` (`rand ^0.7`)
- `cargo tree --target all -i rand@0.7.3` returns nothing
- Run `make check` and commit lockfile updates

---

## 🔗 Universal Links for room sharing

**Goal:** Make shared room links clickable in WhatsApp, iMessage, etc.

Custom scheme URLs (`voxal://`) are treated as plain text in most messaging apps.
The fix is to share `https://ptt.voxal.app/?room=<uuid>` instead.

See [universal-links-aasa.md](./universal-links-aasa.md) for full setup instructions.

**Status:** ✅ Implemented
- AASA file at `src/.well-known/apple-app-site-association` (Team `RFJ383NTK7`, app `com.erwann.voxal.app`)
- Xcode bundle ID updated to `com.erwann.voxal.app` (now matches `capacitor.config.json`)
- Vercel header added to serve AASA as `application/json`
- `ios/App/App/App.entitlements` — `applinks:ptt.voxal.app` associated domain
- `src/main.js` — native invite links now use `https://ptt.voxal.app/` as base
- `src/main.js` — `handleDeepLink()` handles `https://ptt.voxal.app/?room=` Universal Links
- **Requires:** deploy to Vercel to publish AASA, then rebuild iOS app in Xcode on a real device

---

## 🎙️ iOS Lock-Screen Push-to-Talk — verify on device

**Goal:** Talk into a Voxal room from the Lock Screen / Dynamic Island via Apple's PushToTalk framework.

**Status:** ✅ Implemented (compiles clean; needs on-device verification)
- `ios/App/App/PTTPlugin.swift` rewritten against the real SDK: all required `PTChannelManagerDelegate` methods, correct `didActivate`/`didDeactivate` Swift names, `didBeginTransmittingFrom`/`didEndTransmittingFrom` → `ptt-press`/`ptt-release` (ignoring `.developerRequest` echo), `.fullDuplex` transmission mode, async-init race guarded with a 5s cap, system "Leave" button → `ptt-left` → `leaveRoom()`.
- `PTTPlugin.swift` was **missing from `project.pbxproj`** (never compiled / `Plugins.PTTPlugin` was `undefined`) — now registered in PBXBuildFile / PBXFileReference / App group / Sources phase.
- JS: `nativePTTJoin()` now shows the friendly channel name (`activeChannel`) in the system UI; `ptt-left` listener leaves the room.
- Verified: `xcodebuild -sdk iphonesimulator … CODE_SIGNING_ALLOWED=NO` → **BUILD SUCCEEDED**.

**⚠️ Blocked on a paid Apple Developer Program membership ($99/yr).** Free
"personal team" signing cannot grant the `com.apple.developer.push-to-talk`
or `com.apple.developer.associated-domains` capabilities ("Personal
development teams … do not support the Associated Domains and Push to Talk
capabilities") — this also means Universal Links never actually worked on a
personal team. `CODE_SIGN_ENTITLEMENTS` was therefore left unset so on-device
builds keep working; re-add `CODE_SIGN_ENTITLEMENTS = App/App.entitlements`
(or add the capability via Xcode → Signing & Capabilities) once enrolled.
The plugin degrades gracefully meanwhile (PTChannelManager init throws →
`join()` returns `supported:false` → in-app PTT fallback).

**Needs a real device (simulator can't run PushToTalk):**
- System PTT UI appears on room join; Lock-Screen Talk button transmits to peers.
- Receiving still works after a transmit (confirm `didDeactivate`'s `setActive(false)` doesn't kill WebRTC playback — if it does, drop that call).
- Background JS stays alive (keep-alive oscillator) long enough to handle button events.
- Requires the `com.apple.developer.push-to-talk` entitlement in the provisioning profile.

---

## 🐛 Fix multi-survivor host-migration split-brain (found by mesh harness)

**Goal:** When a host disappears and 2+ peers survive, exactly one new host
should emerge. Today the room can split into two hosts that never reconcile.

**Root cause:** the elected deputy calls `becomeHost()` and immediately
broadcasts an authoritative `peer-list`/`successorIds` built only from its open
**data** connections. In the star topology survivors hold no data link to each
other (and, in a silent room, no media link either — audio is lazy), so that
list is **empty** and resets the other survivor's `_authoritativeSuccessorIds` /
`_lastAuthoritativePeerIds` while it is still mid-election → it elects itself too.

**Reproduction:** `tests/e2e/mesh.spec.js` → the two `test.fixme(
'multi-survivor host migration must not split-brain — …')` cases (crash /
heartbeat-timeout path = flaky; simultaneous graceful close = fails ~always).
Remove `.fixme` once fixed.

**Candidate fix:** on `becomeHost()`, keep placeholders for `knownPeerIds`
instead of broadcasting an empty roster until the migration settle window has
reattached data channels (cf. `startMigrationSettle` /
`ensurePlaceholdersForKnownPeers`), AND/OR have a peer ignore an empty
authoritative `peer-list` while `roomState === 'migrating'`. Verify by removing
`.fixme` and running `make test-mesh`.

---

## 🕸️ Multi-peer E2E harness (real PeerJS + WebRTC + host migration)

**Status:** ✅ Implemented — `tests/e2e/mesh.spec.js` (tag `@mesh`), run with
`make test-mesh`.

- Local PeerServer (`peer` dev dep) per worker (`generateClientId` → UUIDs);
  each peer is its own browser context pointed at the broker via
  `localStorage['peerjs-server']` (read by `peerServerOptions()` in `main.js`,
  defaults to `{}` = cloud broker in prod).
- Chromium fake-media flags + `--disable-features=WebRtcHideLocalIpsWithMdns`
  (loopback ICE) in a dedicated `mesh` Playwright project (`retries: 2`,
  90s timeout); the `unit` project `grepInvert`s `@mesh` so the fast suite is
  untouched. `make coverage-e2e` runs both projects so the mesh glue lands in
  the report.
- **Green scenarios:** 3-peer formation (one host, agreed deputy); rename
  propagation (both directions); audio mesh after speaking; single-survivor
  crash migration; new peer joins a migrated room.
- **Documented `fixme`:** multi-survivor migration split-brain (see the fix
  item above).

_Add new items above this line._
