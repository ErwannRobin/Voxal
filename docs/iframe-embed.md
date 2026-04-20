# Embedding Voxal in a web portal

Voxal exposes a **`postMessage` bridge** that lets any web page control an embedded Voxal instance and react to its state — no API keys, no SDK, just a standard browser `<iframe>`.

---

## How it works

```
Portal page                         Voxal iframe
──────────────────────────────────────────────────────
frame.postMessage({type:'join'…})  →  joins the room
                                   ←  {source:'voxal', type:'joined', …}
                                   ←  {source:'voxal', type:'peers',  …}
                                   ←  {source:'voxal', type:'talking',…}
frame.postMessage({type:'leave'})  →  disconnects
                                   ←  {source:'voxal', type:'left'}
```

All Voxal-originated events carry `source: 'voxal'` so they are trivial to filter out from other `postMessage` traffic on the page.

---

## 1 — Add the iframe

```html
<iframe
  id="voxal-frame"
  src="https://voxal-ptt.vercel.app"
  allow="microphone"
  style="width: 400px; height: 600px; border: none; border-radius: 12px;"
></iframe>
```

> **`allow="microphone"` is required.** Cross-origin iframes do not inherit the parent page's microphone permission — this attribute explicitly delegates it.

---

## 2 — Send commands to Voxal

```js
const frame = document.getElementById('voxal-frame').contentWindow;
const VOXAL_ORIGIN = 'https://voxal-ptt.vercel.app'; // tighten to the actual origin

// Join an existing room (pass the room code / host peer ID)
frame.postMessage({ type: 'join', roomCode: 'abc123' }, VOXAL_ORIGIN);

// Create a new room (Voxal becomes the host)
frame.postMessage({ type: 'create' }, VOXAL_ORIGIN);

// Leave the current room
frame.postMessage({ type: 'leave' }, VOXAL_ORIGIN);
```

> Send commands only **after** the iframe has finished loading (`iframe.onload`), otherwise the message may be dropped.

### Command reference

| `type`   | Extra fields              | Description                                       |
|----------|---------------------------|---------------------------------------------------|
| `join`   | `roomCode: string`        | Join an existing room by its code (host peer ID)  |
| `create` | —                         | Create a new room; Voxal becomes the host         |
| `leave`  | —                         | Leave the current room and return to the home UI  |

---

## 3 — Receive events from Voxal

```js
window.addEventListener('message', (e) => {
  // Always filter by source to avoid processing unrelated messages
  if (e.data?.source !== 'voxal') return;

  switch (e.data.type) {

    case 'joined':
      // Fired as soon as the WebRTC connection is established
      console.log('Joined room', e.data.roomCode, '— my peer ID:', e.data.peerId);
      break;

    case 'left':
      // Fired when the user leaves (or is kicked / host migrates away)
      console.log('Left room');
      break;

    case 'talking':
      // Fired every time the local user starts or stops transmitting audio
      updateMicIndicator(e.data.active); // true = transmitting, false = muted
      break;

    case 'peers':
      // Fired on join and whenever someone joins / leaves / starts talking
      renderMemberList(e.data.peers);
      // e.data.peers: Array<{ id: string, pseudo: string, self: boolean, talking: boolean }>
      break;

    case 'error':
      console.error('Voxal error:', e.data.message);
      break;
  }
});
```

### Event reference

| `type`    | Fields                                                                 | When                                          |
|-----------|------------------------------------------------------------------------|-----------------------------------------------|
| `joined`  | `roomCode: string`, `peerId: string`                                   | WebRTC connection established                 |
| `left`    | —                                                                      | Room left (any reason)                        |
| `talking` | `active: boolean`                                                      | Local user starts / stops transmitting        |
| `peers`   | `peers: Array<{ id, pseudo, self, talking }>`                          | On join and on any peer-list change           |
| `error`   | `message: string`                                                      | Microphone denied, PeerJS error, etc.         |

---

## Full example

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>My Portal</title>
</head>
<body>

  <button id="btn-join">Join #general</button>
  <button id="btn-leave" disabled>Leave</button>
  <p id="status">Not connected</p>
  <ul id="member-list"></ul>

  <iframe
    id="voxal-frame"
    src="https://voxal-ptt.vercel.app"
    allow="microphone"
    style="width:400px;height:600px;border:none;"
  ></iframe>

  <script>
    const ROOM_CODE   = 'your-room-code-here';
    const VOXAL_ORIGIN = 'https://voxal-ptt.vercel.app';
    const frame       = document.getElementById('voxal-frame');
    const status      = document.getElementById('status');
    const memberList  = document.getElementById('member-list');

    document.getElementById('btn-join').addEventListener('click', () => {
      frame.contentWindow.postMessage({ type: 'join', roomCode: ROOM_CODE }, VOXAL_ORIGIN);
    });

    document.getElementById('btn-leave').addEventListener('click', () => {
      frame.contentWindow.postMessage({ type: 'leave' }, VOXAL_ORIGIN);
    });

    window.addEventListener('message', (e) => {
      if (e.data?.source !== 'voxal') return;

      switch (e.data.type) {
        case 'joined':
          status.textContent = `Connected · room ${e.data.roomCode}`;
          document.getElementById('btn-join').disabled  = true;
          document.getElementById('btn-leave').disabled = false;
          break;

        case 'left':
          status.textContent = 'Not connected';
          document.getElementById('btn-join').disabled  = false;
          document.getElementById('btn-leave').disabled = true;
          memberList.innerHTML = '';
          break;

        case 'talking':
          status.textContent = e.data.active ? '🔴 Transmitting…' : 'Connected · idle';
          break;

        case 'peers':
          memberList.innerHTML = e.data.peers
            .map(p => `<li>${p.pseudo}${p.self ? ' (you)' : ''}${p.talking ? ' 🔴' : ''}</li>`)
            .join('');
          break;
      }
    });
  </script>

</body>
</html>
```

---

## Notes

- **Room codes** are PeerJS peer IDs (UUIDs). They are created by Voxal when a user clicks "Create room". You can obtain one from the `joined` event (`e.data.roomCode`) and store it in your presence database so others can join later.
- **Microphone permission** is requested by Voxal the first time the user joins a room. The browser will prompt the user; no action is needed on the portal side.
- **No same-origin restriction** — the bridge uses `*` as the target origin when emitting events outward. To harden security you can restrict inbound commands by checking `e.origin` against your portal's origin inside Voxal's message listener.
- **No authentication passthrough** — the iframe loads Voxal independently. If you want the embedded Voxal to be pre-logged-in with a presence account, pass the token via `postMessage` after the frame loads, or use a URL hash/query parameter that Voxal reads on startup.
