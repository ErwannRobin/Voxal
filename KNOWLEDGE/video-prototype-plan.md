# Video Prototype — Implementation Plan

## Overview
Add optional 1:1 video streaming to Voxal, gated behind developer mode. The host can enable "video mode" for the room; each participant then independently decides whether to share their camera. When a peer is streaming, a camera icon appears next to their name — clicking it opens a video viewer (separate Tauri window on desktop, fullscreen overlay on web/mobile).

---

## Design Decisions

### Separate MediaConnection for video
Video is sent as a **separate** PeerJS `MediaConnection` from the audio one. This avoids renegotiating the audio connection and keeps PTT / free-hand logic completely untouched. PeerJS supports multiple concurrent calls between two peers.

### Dev mode gating, no peer-count enforcement
The video toggle is only visible when `isDevModeEnabled()` returns `true`. No hard limit on participant count — the feature is experimental.

### Distinguishing video from audio calls
Use `call.metadata.type === 'video'` on the PeerJS `peer.call()` options. In `handleIncomingCall`, branch on this metadata to route video streams to the video pipeline instead of `attachAudio`.

### Desktop viewer: floating panel (not a separate WebviewWindow)
MediaStream objects cannot be transferred across Tauri WebviewWindow boundaries (separate web contexts). The pragmatic prototype approach is a **floating draggable `<div>` panel** inside the main window, styled to look like a separate window (title bar, close button, resizable). This avoids the complexity of a relay/proxy while still giving a decent UX. A future iteration could explore a proper WebviewWindow with a local WebRTC loopback.

### Web/Mobile viewer: fullscreen overlay
A fullscreen CSS overlay with the `<video>` element and a close button. On mobile, use the Fullscreen API if available.

---

## Data Protocol Additions

| Message | Direction | Payload |
|---------|-----------|---------|
| `video-mode` | host → peer | `{ enabled: bool }` |
| `video-offer` | peer → host (relayed to all) | `{ peerId }` |
| `video-stop` | peer → host (relayed to all) | `{ peerId }` |

### Flow
1. Host toggles "Video Mode" ON → sends `video-mode { enabled: true }` to the other peer.
2. Either participant clicks "Share Camera" → acquires camera → opens `peer.call(peerId, videoStream, { metadata: { type: 'video' } })` → sends `video-offer { peerId }` through the data channel (so both sides know who's streaming).
3. Receiver's `handleIncomingCall` detects `metadata.type === 'video'` → answers with empty stream (or own camera if also sharing) → attaches remote video to a hidden `<video>` element → shows camera icon in peer list.
4. Participant clicks "Stop Camera" → closes video MediaConnection → sends `video-stop { peerId }`.
5. Host toggles "Video Mode" OFF → sends `video-mode { enabled: false }` → both sides tear down video.

---

## Implementation Steps

### Step 1: Data protocol handlers
**Files:** `src/main.js`

Add handling for the three new message types in both the host message handler and the non-host message handler:

```
// In handleHostMessage (messages from peers to host):
} else if (msg.type === 'video-offer') {
    // Relay to all other peers
    connections.forEach(function(c, pid) {
      if (pid !== msg.peerId && c.data) c.data.send(msg);
    });
} else if (msg.type === 'video-stop') {
    // Relay to all other peers
    connections.forEach(function(c, pid) {
      if (pid !== msg.peerId && c.data) c.data.send(msg);
    });
}

// In handlePeerMessage (messages from host to non-host):
} else if (msg.type === 'video-mode') {
    videoModeEnabled = msg.enabled;
    updateVideoModeUI();
} else if (msg.type === 'video-offer') {
    // Mark peer as video-streaming
    markPeerVideoActive(msg.peerId, true);
} else if (msg.type === 'video-stop') {
    markPeerVideoActive(msg.peerId, false);
}
```

### Step 2: Video mode toggle (host UI)
**Files:** `src/main.js`, `src/index.html`, `src/styles.css`

- Add a "📹 Video" toggle button in the room controls area, next to existing controls.
- Only rendered/visible when `isDevModeEnabled() && isHost`.
- On toggle:
  - Set `videoModeEnabled = true/false`
  - Send `video-mode { enabled }` to the peer via DataConnection.
  - Call `updateVideoModeUI()` locally.

### Step 3: "Share Camera" button
**Files:** `src/main.js`, `src/index.html`, `src/styles.css`

- Shown when `videoModeEnabled === true` (for both host and non-host).
- Button text: "Share Camera" / "Stop Camera" (toggle).
- On share:
  ```js
  async function startVideoShare() {
    localVideoStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false
    });
    // Call each connected peer with video stream
    connections.forEach(function(c, peerId) {
      if (peerId === peer.id) return;
      const videoCall = peer.call(peerId, localVideoStream, { metadata: { type: 'video' } });
      videoCall.on('stream', function(remote) { attachRemoteVideo(peerId, remote); });
      videoCall.on('close', function() { detachRemoteVideo(peerId); });
      c.videoMedia = videoCall;
    });
    // Notify via data channel
    sendToHost({ type: 'video-offer', peerId: peer.id });
    localVideoActive = true;
    updateVideoModeUI();
  }
  ```
- On stop:
  ```js
  function stopVideoShare() {
    if (localVideoStream) {
      localVideoStream.getTracks().forEach(t => t.stop());
      localVideoStream = null;
    }
    connections.forEach(function(c) {
      if (c.videoMedia) { c.videoMedia.close(); c.videoMedia = null; }
    });
    sendToHost({ type: 'video-stop', peerId: peer.id });
    localVideoActive = false;
    updateVideoModeUI();
  }
  ```

### Step 4: Incoming video call handling
**Files:** `src/main.js`

Modify `handleIncomingCall`:
```js
function handleIncomingCall(call) {
  if (call.metadata && call.metadata.type === 'video') {
    handleIncomingVideoCall(call);
    return;
  }
  // ... existing audio handling unchanged ...
}

function handleIncomingVideoCall(call) {
  // Answer with own video stream if sharing, else empty
  var answerStream = localVideoStream || new MediaStream();
  call.answer(answerStream);
  call.on('stream', function(remote) {
    attachRemoteVideo(call.peer, remote);
    markPeerVideoActive(call.peer, true);
  });
  call.on('close', function() {
    detachRemoteVideo(call.peer);
    markPeerVideoActive(call.peer, false);
  });
  var conn = connections.get(call.peer);
  if (conn) conn.videoMedia = call;
}
```

### Step 5: Camera icon in peer list
**Files:** `src/main.js`, `src/styles.css`

In `updatePeerList()`, after rendering the peer name, check if the peer has an active video stream:
```js
if (conn && conn.videoActive) {
  const camBtn = document.createElement('button');
  camBtn.className = 'btn-icon peer-cam-btn';
  camBtn.title = 'View camera';
  camBtn.innerHTML = '📹'; // or an SVG camera icon
  camBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    openVideoViewer(peerId);
  });
  peerMain.appendChild(camBtn);
}
```

### Step 6: Video viewer (desktop — floating panel)
**Files:** `src/main.js`, `src/styles.css`, `src/index.html`

Add a floating panel element to `index.html`:
```html
<div id="video-viewer-panel" class="hidden">
  <div class="video-viewer-titlebar">
    <span class="video-viewer-title">Camera</span>
    <button id="video-viewer-close" class="btn-icon">✕</button>
  </div>
  <video id="video-viewer-element" autoplay playsinline></video>
</div>
```

CSS: position fixed, draggable, resizable, z-index above main content, dark background. Default size ~320×240, aspect-ratio maintained.

JS `openVideoViewer(peerId)`:
```js
function openVideoViewer(peerId) {
  var panel = $('video-viewer-panel');
  var video = $('video-viewer-element');
  var conn = connections.get(peerId);
  if (!conn || !conn.remoteVideoStream) return;
  video.srcObject = conn.remoteVideoStream;
  panel.classList.remove('hidden');
  _videoViewerPeerId = peerId;
}
```

Make the panel draggable (mousedown on titlebar → track mousemove → update `left`/`top`).

### Step 7: Video viewer (web/mobile — fullscreen overlay)
**Files:** `src/main.js`, `src/styles.css`, `src/index.html`

On non-Tauri platforms, `openVideoViewer` shows a fullscreen overlay instead:
```js
function openVideoViewer(peerId) {
  if (window.__TAURI__) {
    openVideoPanel(peerId); // floating panel
  } else {
    openVideoFullscreen(peerId); // overlay
  }
}
```

Fullscreen overlay: fixed div covering the viewport, black background, centered `<video>`, close button top-right. On mobile, request `element.requestFullscreen()` if available.

### Step 8: Cleanup
**Files:** `src/main.js`

- In `leaveRoom()`: call `stopVideoShare()`, close video viewer panel, reset `videoModeEnabled`.
- In `removePeer(peerId)`: close `conn.videoMedia`, `detachRemoteVideo(peerId)`.
- On `video-mode { enabled: false }`: call `stopVideoShare()`, close viewer if open.
- On peer disconnect: the existing `clearPeerMedia` won't touch video since it's stored separately — add a `clearPeerVideo(peerId)` helper.

---

## New State Variables

```js
var videoModeEnabled = false;    // Room-level: host has enabled video mode
var localVideoActive = false;    // This peer is sharing their camera
var localVideoStream = null;     // MediaStream from getUserMedia (video only)
var _videoViewerPeerId = null;   // Which peer's video is currently in the viewer
```

Each entry in the `connections` Map gains:
```js
{
  ...existing fields,
  videoMedia: null,          // PeerJS MediaConnection for video (outgoing or incoming)
  remoteVideoStream: null,  // Remote video MediaStream (for viewer)
  videoActive: false         // Whether this peer is currently streaming video
}
```

---

## Files Changed Summary

| File | Changes |
|------|---------|
| `src/main.js` | All JS logic: protocol handlers, stream management, UI updates, viewer |
| `src/index.html` | Video mode toggle button, share camera button, video viewer panel/overlay |
| `src/styles.css` | Styles for video toggle, camera icon, floating panel, fullscreen overlay |

Remember: changes to `src/` must also be synced to `ios/App/App/public/` and `android/app/src/main/assets/public/`.

---

## Permissions Needed (future, not for prototype)

- **iOS**: Add `NSCameraUsageDescription` to `ios/App/App/Info.plist`
- **Android**: Add `<uses-permission android:name="android.permission.CAMERA" />` to `AndroidManifest.xml`
- **Tauri**: No special permission needed (camera access is via web APIs in the webview)

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| MediaStream can't cross WebviewWindows | Use in-app floating panel (decided above) |
| Camera permission denied | Show toast error, disable share button |
| Video stream adds bandwidth pressure | Limit to 640×480, single peer only |
| PeerJS metadata not always delivered | Fallback: check if incoming stream has video tracks |
| Prototype scope creep | Keep it dev-mode only, no polish, no screen sharing |

---

_This plan is for reference. Implementation can be done incrementally following the step order above._
