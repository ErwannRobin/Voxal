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
- Camera video, in an immersive full-screen stage with the voice UI overlaid
  (front/back flip, 360p24 capture, screen wake lock, capture paused in the
  background) — see [video routing](video-routing.md#on-phones)
- Screen sharing, through a native capture plugin *(see requirements below)*
- Deep links (custom scheme `voxal://` works everywhere; HTTPS Universal/App Links — see below)
- iOS Dynamic Island / Lock-Screen Push-to-Talk integration *(see requirements below)*

> **iOS Push-to-Talk & Universal Links require a paid Apple Developer Program
> membership.** The PushToTalk and Associated Domains capabilities cannot be
> granted to a free "personal team", so on a personal team the system PTT UI and
> HTTPS Universal Links do not work. `App/App.entitlements` holds both keys but
> the App target does **not** point at it — see the screen-sharing note below
> for why, and for the one-line change that turns them on once you enrol.
> The PTT plugin degrades gracefully to the in-app PTT fallback. These paths are
> implemented and compile clean but are **unverified on a real device** pending
> enrollment. Note that until `VoxalViewController` was added, no app-target
> Swift plugin registered with the bridge at all (see
> `KNOWLEDGE/learning.md` → "An app-target Swift plugin does NOT auto-register
> on iOS"), so PTT could not have worked on device regardless of entitlements —
> worth re-testing now that it does register. The `voxal://` custom-scheme deep links work regardless.

### Screen sharing

No mobile browser or WebView implements `getDisplayMedia` — WebKit has never
shipped it, and Chromium hides it on Android deliberately so that feature
detection works. So capture is native on both platforms and the frames are
carried into the WebView instead:

| | Android | iOS |
|---|---|---|
| Capture | `MediaProjection` → `VirtualDisplay` | ReplayKit Broadcast Upload Extension |
| Encode | `MediaCodec` (H.264, Annex-B) | `VTCompressionSession`, converted to Annex-B |
| To the WebView | Capacitor bridge, base64 | App Group Unix socket → Capacitor bridge |
| Trigger | system consent dialog | `RPSystemBroadcastPickerView` |

`src/main.js` then decodes with WebCodecs, draws to a canvas and publishes
`canvas.captureStream()` through the ordinary screen-share path — so routing,
the SFU preference and the video stage all behave exactly as on desktop.
Capture is capped to 1280 px on the long edge, 24 fps, and 800 kbps per
listener (`screenMaxBitrate()`); resolution is never scaled down, because a
screen that stays sharp at fewer frames is readable and a smaller one is not.

> **iOS screen sharing needs the App Group.** The `VoxalBroadcast` extension
> and the app must share `group.com.erwann.voxal.app`, which is where the frame
> socket lives. Both targets carry `CODE_SIGN_ENTITLEMENTS`, so this is wired
> and should build as-is.
>
> The App target points at **`App/AppGroup.entitlements`**, which holds the App
> Group and nothing else, rather than at `App/App.entitlements`. Entitlements
> are granted per *file*: `App.entitlements` also carries
> `com.apple.developer.push-to-talk` and Associated Domains, which a free
> personal team cannot sign — and one unsignable key fails the whole file,
> taking the App Group down with it. Apple lists **App groups** as available to
> free accounts, so splitting it out is what lets a personal team build and
> test screen sharing at all.
>
> **On a paid membership, switch `CODE_SIGN_ENTITLEMENTS` back to
> `App/App.entitlements`** — it carries the same App Group plus PushToTalk and
> Associated Domains, so that one change turns on all three. Leaving it pointed
> at `AppGroup.entitlements` is not a regression (the setting was unset
> entirely before, so PTT and Universal Links were already off), but it does
> mean a store build ships without them.
>
> This is a **signing** requirement, not a distribution one:
> `CODE_SIGN_ENTITLEMENTS` applies to every build, so a development build run
> on a device from Xcode is enough to test it. Nothing here needs TestFlight,
> App Store review, or a release. One caveat if you are on a personal team:
> Apple's capability table says App groups is available, but there are field
> reports of `provisioning profile doesn't include
> com.apple.developer.app-groups` on personal teams, and personal-team profiles
> expire after 7 days — so treat it as probably-fine, verify on first build.
>
> The App Group identifier appears in four places and they must agree:
> `App/AppGroup.entitlements`, `App/App.entitlements`,
> `VoxalBroadcast/VoxalBroadcast.entitlements`, and
> `BroadcastFrameChannel.appGroup` in Swift.
>
> It also needs **iOS 16.4+**, the release where WebKit shipped the WebCodecs
> `VideoDecoder` the frames are decoded with.

> **Both platforms need a store release.** The plugins, the manifest permissions
> and the extension are native-shell changes, so unlike `src/` JavaScript they
> cannot reach installed apps through Capgo OTA. On Android the new permissions
> are `FOREGROUND_SERVICE_MEDIA_PROJECTION` and `POST_NOTIFICATIONS`.

> **Android camera requires a Play Store build.** `android.permission.CAMERA`
> lives in `AndroidManifest.xml`, so unlike `src/` JavaScript it cannot reach
> installed apps through Capgo OTA. An app built before that permission was
> added will show the immersive stage and can watch other people's cameras, but
> `getUserMedia({video})` fails on its own camera until a new store build lands.
> iOS needs no native change.

## Differences vs desktop

- No global keyboard shortcut in background on mobile
- Touch PTT is the primary mode
- Hardware keyboard shortcuts are limited to focused app contexts
- Both apps are hard portrait-locked (see `KNOWLEDGE/learning.md`); the video
  stage is designed for portrait rather than unlocking rotation
- Screen sharing needs a native plugin rather than `getDisplayMedia`, so it is
  absent from any build older than the one that added it (see below)

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
