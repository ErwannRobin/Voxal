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

_Add new items above this line._
