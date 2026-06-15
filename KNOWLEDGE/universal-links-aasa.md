# Universal Links & AASA Setup

Make `https://voxal.app/join?room=<uuid>` open the native iOS app directly
(instead of sharing `voxal://` which isn't clickable in WhatsApp/iMessage).

---

## 1. Host the AASA file on voxal.app

Create this file at the root of the Lovable project:

**Path:** `public/.well-known/apple-app-site-association`
**Content-Type must be:** `application/json` (no `.json` extension)

```json
{
  "applinks": {
    "apps": [],
    "details": [
      {
        "appIDs": ["<TEAM_ID>.com.erwann.push2talk.app"],
        "components": [
          {
            "/": "/join",
            "?": { "room": "?*" },
            "comment": "Matches https://voxal.app/join?room=<anything>"
          }
        ]
      }
    ]
  }
}
```

Replace `<TEAM_ID>` with the Apple Developer Team ID (10-character string, e.g. `AB12CD34EF`).

> Lovable serves files from `public/` at the root. Verify the file is reachable at:
> `https://voxal.app/.well-known/apple-app-site-association`

---

## 2. Add Associated Domains entitlement to iOS app

In Xcode → Target **App** → **Signing & Capabilities** → **+ Capability** → **Associated Domains**

Add entry:
```
applinks:voxal.app
```

Or edit `ios/App/App/App.entitlements` directly:
```xml
<key>com.apple.developer.associated-domains</key>
<array>
    <string>applinks:voxal.app</string>
</array>
```

---

## 3. Update the share URL in main.js

In `src/main.js`, change the share handler from:
```js
var shareUrl = 'voxal://join?room=' + encodeURIComponent(text);
navigator.share({ title: 'Join my Voxal room', text: shareUrl })
```
to:
```js
var shareUrl = 'https://voxal.app/join?room=' + encodeURIComponent(text);
navigator.share({ title: 'Join my Voxal room', url: shareUrl })
```

Note: HTTPS URLs can use the `url` field in `navigator.share()` (custom schemes cannot).

---

## 4. Add web fallback: handle `?room=` param in index.html

At the top of `src/main.js` (outside DOMContentLoaded), add:
```js
// Auto-join from URL param (web fallback when app not installed)
(function() {
  var params = new URLSearchParams(window.location.search);
  var roomId = params.get('room');
  if (roomId) {
    // Store for after peer is ready
    window._autoJoinRoom = roomId;
    // Clean URL without reloading
    history.replaceState(null, '', window.location.pathname);
  }
})();
```

Then in DOMContentLoaded, after peer initialisation:
```js
if (window._autoJoinRoom) {
  joinRoom(window._autoJoinRoom).catch(function(err) { showError(err.message); });
  window._autoJoinRoom = null;
}
```

---

## 5. Add a `/join` route to voxal.app (optional)

If the Lovable project uses a SPA router, add a `/join` route that:
- On mobile with app installed → iOS intercepts the link before the page loads (Universal Link)
- On mobile without app → shows "Get Voxal" page with App Store link + web join button
- On desktop → redirects to `/?room=<uuid>` and joins via web

---

## Testing

1. Build & install via Xcode on a real device (Universal Links don't work in Simulator)
2. Send `https://voxal.app/join?room=test-uuid` to yourself via iMessage
3. Tap the link → should open Voxal app directly (not Safari)
4. If it opens Safari instead: verify AASA file is reachable, Team ID is correct, and the entitlement is present in the signed build
