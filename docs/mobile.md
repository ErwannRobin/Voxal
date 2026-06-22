# Mobile Guide (iOS + Android)

Voxal wraps the shared `src/` web app using Capacitor.

## Prerequisites

- iOS: macOS + Xcode + Apple Developer account (device builds/signing)
- Android: Android Studio

## Daily workflow

```sh
make cap-sync
make cap-ios
make cap-android
```

`make cap-sync` must be run after every `src/` change before native mobile builds.

## Mobile capabilities

- Full room create/join flow
- Tap-and-hold push-to-talk
- Free-hand mode
- Talking indicators and pseudonyms
- Audio cues + haptics
- Optional video/screen features
- Deep links (custom scheme `voxal://` works everywhere; HTTPS Universal/App Links — see below)
- iOS Dynamic Island / Lock-Screen Push-to-Talk integration *(see requirements below)*

> **iOS Push-to-Talk & Universal Links require a paid Apple Developer Program
> membership.** The PushToTalk and Associated Domains capabilities cannot be
> granted to a free "personal team", so on a personal team the system PTT UI and
> HTTPS Universal Links do not work and `CODE_SIGN_ENTITLEMENTS` is left unset.
> The PTT plugin degrades gracefully to the in-app PTT fallback. These paths are
> implemented and compile clean but are **unverified on a real device** pending
> enrollment. The `voxal://` custom-scheme deep links work regardless.

## Differences vs desktop

- No global keyboard shortcut in background on mobile
- Touch PTT is the primary mode
- Hardware keyboard shortcuts are limited to focused app contexts

## Forking: iOS app identity

When shipping your own fork, update:

1. `capacitor.config.json` `appId`
2. Xcode bundle identifier in `ios/App/App.xcodeproj`
3. `src/.well-known/apple-app-site-association` appID (`<TEAM_ID>.<bundle_id>`)

Without the AASA update, Universal Links open web instead of your app.

## Forking: Android app links/signing

1. Create a release keystore
2. Configure `android/keystore.properties` (gitignored)
3. Get SHA-256 certificate fingerprint
4. Update `src/.well-known/assetlinks.json` (`package_name` + fingerprint)
5. Build signed release (`make build-android`)

This is required for Android App Links (`https://...`) to open your app directly.
