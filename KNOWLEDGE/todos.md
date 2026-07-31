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

## ✅ Fixed multi-survivor host-migration split-brain (found by mesh harness)

When a host vanished and 2+ peers survived, the room could split into two hosts.
Fixed via two changes in `main.js`:
1. A host tearing down its own Peer no longer broadcasts `peer-left`/a shrunken
   `peer-list` during the close cascade — the broadcast is deferred one tick and
   skipped once `peer.destroyed`/`!inRoom` (it read `false` inside the close
   handler, hence the defer). Stops survivors' successor chain being poisoned.
2. Survivors are more patient reaching the elected deputy before self-promoting
   (`HOST_MAX_RETRIES` 3→8, `HOST_RETRY_DELAY` 2000→1500), so they outlast the
   deputy's promotion window (~7s heartbeat timeout + `becomeHost`).
3. **Host + deputy (or deeper) failing together**: the ordered successor chain
   already walks to the next successor via `_migrationExcluded`, but the wider
   retry budget made a *dead* deputy slow to skip. `handlePeerRuntimeError` now
   fast-fails on `peer-unavailable` for the current `_migrationCandidateId`
   (broker says it's gone) → `initiateHostMigration(id)` re-elects immediately,
   while a slow-but-alive deputy still gets the full budget.

Regression-guarded in `tests/e2e/mesh.spec.js`: the two `multi-survivor host
migration does not split-brain — …` cases (crash + graceful) and `host and
deputy crashing together converges on the next successor`.

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
- **Scenarios (all green):** 3-peer formation (one host, agreed deputy); rename
  propagation (both directions); audio mesh after speaking; single-survivor
  crash migration; new peer joins a migrated room; multi-survivor migration
  (crash + graceful kill paths); host + deputy crashing together → walks the
  successor chain. The migration cases regression-guard the split-brain fix above.

## 📈 Scaling to large audiences (deferred — only if needed)

A full WebRTC mesh can't do one→many broadcast: a single speaker uploads one
Opus stream per listener, which caps practical room size regardless of how many
peers are "only listening". For now we just **warn** (`updateRoomSizeWarning`,
soft at 8 / hard at 12 — no hard cap). If large town-hall/audience rooms become a
real goal, the path is:
- an **optional SFU/relay** (server forwards one upload to many) — the only thing
  that actually scales one→many; conflicts with the "no server" default, so make
  it opt-in;
- an **explicit listen-only role** (skip mic permission, a speaker-aware cap, an
  "audience" roster) — modest UX wins but does NOT remove the speaker fan-out.
Decided **not** to build either now; the mesh + size warning is enough for the
small-room product.

## 🩺 Device-info diagnostics panel (dev mode)

**Status:** ✅ Implemented — `collectDeviceInfo()` + host-side "i" panel in `main.js`,
sharing opt-out in Settings → Advanced (both `index.html` modal and `settings.html`).

When a room host has dev mode on, an "i" button appears next to each roster name
showing 📱 Device / 🎤 Audio / 🌐 Network diagnostics. Snapshots are collected on
demand only (host relays a `device-info-request`/`-response` round-trip) and each
peer can opt out (`debug-share-device-info`, default on). Regression-tested in
`tests/e2e/unit-device-info.spec.js`.

**Native desktop stats:** ✅ Done — the Tauri command `get_device_stats`
(`sysinfo` + `starship-battery`) surfaces real process/total memory, process/
system CPU %, and battery level/charging on the desktop app (WKWebView exposes
none of these). `collectDeviceInfo()` merges it in.

**Remaining follow-up (Capacitor native mobile):** connection type, battery, and
memory on the iOS/Android *native* apps still fall back to web APIs. Adding
`@capacitor/device` + `@capacitor/network` would fill these, but needs a native
rebuild (not OTA). Battery low-power mode and connection type on iOS/desktop
WebKit remain unavailable regardless — the panel renders "—" for them.

## 🔊 CONFIRMED DEAD: the built-in fallback TURN relay (high priority)

**Goal:** Ship a default relay that actually works, or stop pretending to have one.

**Status: confirmed broken.** metered.ca has **retired** the shared
`openrelayproject` credentials in favour of per-account API keys, so every entry
in `DEFAULT_FALLBACK_TURN` fails. Anonymous users have **no working TURN at
all** — direct/STUN peers connect, but anyone behind symmetric NAT or a strict
firewall cannot. Surfaced by Settings → Audio → *Test over network*, which now
names the retired default explicitly.

**Decision needed** (product call, not a code fix):
- host a coturn behind a rate-limited short-lived-credential endpoint, or
- ship metered.ca free-tier credentials in the build, or
- drop `DEFAULT_FALLBACK_TURN` entirely so the app stops spending ICE-gathering
  time on four dead servers and tells the user plainly to configure one.

`fetchIceServers()` step 3 returns `DEFAULT_FALLBACK_TURN` — four allocations
against `openrelay.metered.ca` with public credentials Open Relay has been
retiring in favour of per-account keys. Nothing verifies they still work, and a
peer that genuinely needs a relay has no alternative.

The outgoing-audio tuning work mitigates the symptoms (a relayed path
immediately gets the wide jitter buffer, Opus FEC is on, the uplink is no longer
wasted on duplicate streams) but cannot manufacture relay capacity.

Exit criteria:
- Either a self-hosted coturn behind a rate-limited short-lived-credential
  endpoint, or a funded metered.ca tier, reachable without a Voxal account
- `DEFAULT_FALLBACK_TURN` points at it (TCP/443 + `turns:` included)
- A liveness probe so a dead relay is visible in the TURN badge instead of
  silently degrading calls

---

## 🖥️ Network echo test is missing from the Tauri preferences window

**Goal:** Offer Settings → Audio → *Test over network* on the desktop app's
standalone preferences window, not just the in-page modal.

`settings.html` duplicates its logic by hand (no module system) and has none of
`fetchIceServers()`, `opusSdpTransform()` or the RNNoise capture path — porting
the echo test means ~400 duplicated lines including a WASM worklet, into the
file that already caused the noise-suppression default to drift. For now it
shows a hint pointing at the main window.

Exit criteria (either):
- `settings.html` and `main.js` share a real module for ICE + Opus + capture, or
- the preferences window can ask the main window to run the test and show the
  result where the user is looking

---

## 🎙️ Eliminate the audio-connection glare duplicate (3+ peer rooms)

**Goal:** Exactly one MediaConnection carrying our mic per remote peer, always.

`connectOutgoingAudioToPeers` skips a peer that can already be *seen* to receive
our mic, but when two peers call each other simultaneously neither has answered
yet, so both connections survive and that speaker uploads twice to that peer.
Bounded at one outgoing call per peer, so it is waste rather than a leak.

The fix is a deterministic tie-break (lower peer ID closes its own redundant
`audioMediaOut`), but it is **blocked on audio continuity**: closing it fires the
remote's `clearPeerMedia`, which `detachAudio`s the peer and nulls `media`,
killing playback the surviving connection had already attached. So:

Exit criteria:
- `clearPeerMedia` re-attaches from the surviving connection's remote stream
  (needs the remote stream kept on the connection entry) instead of detaching
- Lower-ID-closes tie-break added to the stats reconciliation pass
- The `@mesh` case `a speaker opens at most one outgoing audio call per listener`
  tightened from "at most 2 senders" back to "exactly 1"

---

_Add new items above this line._
