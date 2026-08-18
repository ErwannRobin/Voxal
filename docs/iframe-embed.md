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
  src="https://web.voxal.app?ui=tiny&hideHeader=true&forceWeb=true"
  allow="camera; microphone"
  style="width: 400px; height: 600px; border: none; border-radius: 12px;"
></iframe>
```

> **`allow="camera; microphone"` is required for video.** Cross-origin iframes do not inherit the parent page's camera or microphone permission — this attribute explicitly delegates both.

### Useful embed URL parameters

| Parameter | Values | Effect |
|---|---|---|
| `ui=tiny` / `embed=tiny` | — | Compact tiny embed layout |
| `tiny`, `compact` | `1`, `true` | Compact tiny embed layout |
| `hideHeader`, `noHeader` | `1`, `true`, `yes` | Hides room header (iframe only) |
| `forceWeb`, `webOnly`, `web` | `1`, `true`, `yes` | Skip native-app redirection and stay on web |
| `popout`, `allowPopout`, `canPopout` | `1`, `true`, `yes` | Show a **pop-out** button that detaches the session into a standalone `web.voxal.app` window (see [Pop out](#5--pop-out-to-a-standalone-window)). Tiny embeds only. |
| `parentOrigin` | absolute `https://...` origin | Locks the bridge to your origin: outbound events are sent only to it, **and inbound commands from any other origin are rejected** (see [Security](#security)). Strongly recommended. |

> `name` and `color` are also read from the URL, but you don't set these — Voxal adds them itself when opening a [pop-out window](#5--pop-out-to-a-standalone-window) to carry the user's identity across.

### Embedding modes by width

The tiny embed adapts to the iframe's rendered width via a `ResizeObserver`. Size the iframe to pick a mode — no extra parameter needed:

| Mode | Width | Layout |
|---|---|---|
| **Micro** | `≤ 100 px` | Just the self mic chip — tap-to-talk, nothing else. No peer names, no pop-out, no attribution. Auto-joins on load (too small for a name prompt; a random name is used). |
| **Compact** | `101–199 px` | Self chip + a "N peers connected" count + the current speaker's name below. Other-peer chips are hidden. |
| **Tiny** | `≥ 200 px` | Full tiny layout: self chip + all peer chips, the [pop-out](#5--pop-out-to-a-standalone-window) button (if enabled), and a small "powered by voxal.app" note. |

All three are the *same* embed (`ui=tiny`); only the width differs. Below ~100 px the UI is intentionally bare so it fits a toolbar/badge slot.

---

## 2 — Send commands to Voxal

```js
const frame = document.getElementById('voxal-frame').contentWindow;
const VOXAL_ORIGIN = 'https://web.voxal.app'; // tighten to the actual origin

// Join an existing room (pass the room code / host peer ID)
frame.postMessage({ type: 'join', roomCode: 'abc123' }, VOXAL_ORIGIN);

// Create a new room (Voxal becomes the host)
frame.postMessage({ type: 'create' }, VOXAL_ORIGIN);

// Leave the current room
frame.postMessage({ type: 'leave' }, VOXAL_ORIGIN);
```

> Send commands only **after** the iframe has finished loading, or better: wait for the `ready` event (see below), otherwise the message may be dropped.

### Command reference

| `type`   | Extra fields                          | Description                                          |
|----------|---------------------------------------|------------------------------------------------------|
| `auth`   | `token: string`, `orgId?: string`     | Pass the user's session token — skips the OAuth flow. Also makes Voxal use the org's backend-managed TURN. |
| `join`   | `roomCode: string`                    | Join an existing room by its code (host peer ID)     |
| `create` | `channelName?: string`, `roomCode?: string` | Create a new room; Voxal becomes the host. Optionally label it with a presence channel name. |
| `leave`  | —                                     | Leave the current room and return to the home UI     |
| `key`    | `source: 'voxal-parent'`, `code: 'Space'`, `down: boolean` | Drive push-to-talk from the parent page's own key handler (`down:true` = start, `false` = stop). `source` must be `'voxal-parent'`. |
| `config` | `iceServers: RTCIceServer[]`          | Supply your own STUN/TURN servers (see [Providing TURN](#4--providing-your-own-turn-relay)). **Requires `parentOrigin`.** |

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
      // e.data.peers: Array<{ id: string, pseudo: string, pseudoColor?: string, self: boolean, talking: boolean }>
      break;

    case 'error':
      console.error('Voxal error:', e.data.message);
      break;

    case 'ready':
      // Fired once on load — safe to send the auth command now
      frame.contentWindow.postMessage(
        { type: 'auth', token: mySessionToken, orgId: myOrgId },
        'https://web.voxal.app'
      );
      break;
  }
});
```

### Event reference

| `type`         | Fields                                                            | When                                          |
|----------------|-------------------------------------------------------------------|-----------------------------------------------|
| `ready`        | —                                                                 | iframe finished loading, ready to receive commands |
| `joined`       | `roomCode: string`, `peerId: string`                              | WebRTC connection established                 |
| `left`         | —                                                                 | Room left (any reason)                        |
| `talking`      | `active: boolean`                                                 | Local user starts / stops transmitting        |
| `peers`        | `peers: Array<{ id, pseudo, pseudoColor?, self, talking }>`       | On join and on any peer-list change           |
| `host-changed` | `roomCode: string`, `isSelf: boolean`                             | Host migration: a new host took over (`isSelf:true` = this peer became host). `roomCode` may change. |
| `config-applied` | `iceServers: number`                                            | Acknowledges a `config` command — number of ICE servers accepted |
| `popout`       | `url: string`                                                     | User popped the session out to a standalone window; the embed then leaves the room (a `left` event follows). |
| `popout-blocked` | `url: string`                                                   | The browser blocked the pop-out window (e.g. `sandbox` without `allow-popups`); the embed **keeps** its session. |
| `popout-closed` | `url: string`                                                    | The popped-out window was closed. Detected by the iframe polling `window.closed` (~1s); the parent can't watch it directly. Use it to re-show your embed / offer to rejoin. |
| `error`        | `message: string`                                                 | Microphone denied, PeerJS error, etc.         |

---

## 4 — Providing your own TURN relay

A direct peer-to-peer connection fails behind symmetric NAT or strict/corporate
firewalls; those need a **TURN relay**. A cross-origin embedder can't write the
iframe's `localStorage`, so there are two ways to give an embed real TURN:

**Option A — your own STUN/TURN servers, via `config`** (no Voxal account needed):

```js
const VOXAL_ORIGIN = 'https://web.voxal.app';

window.addEventListener('message', (e) => {
  if (e.data?.source === 'voxal' && e.data.type === 'ready') {
    frame.contentWindow.postMessage({
      type: 'config',
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'turns:turn.your-company.com:443?transport=tcp',
          username: 'user', credential: 'pass' }
      ]
    }, VOXAL_ORIGIN);
  }
});
```

- These take **precedence over every other source** — you're stating exactly which servers to use, so include STUN entries too if you want direct connections.
- They are held **in memory only** (never written to `localStorage`), so re-send on each load. An empty `iceServers: []` clears the override.
- Use `turns:` (TLS) and `:443?transport=tcp` for the entries that must punch through firewalls — UDP/3478 is commonly blocked.
- **Requires `?parentOrigin=https://your.site` on the iframe `src`** — the message is rejected from any other origin because it carries credentials. Send it after the `ready` event. Voxal replies with `config-applied`.

**Option B — a Voxal presence account, via `auth`:** posting `{ type: 'auth', token, orgId }` makes Voxal fetch your org's backend-managed (short-lived) TURN credentials automatically.

> A TURN relay only forwards **encrypted** DTLS-SRTP — it can't decrypt the audio, so using one doesn't change Voxal's "no server hears your voice" property.

Standalone (non-embedded) users configure the same thing under **Settings → Advanced → Fallback relay** (Automatic / Off / Custom). See [TURN & ICE configuration](turn-and-ice.md) for the full precedence order and self-hosting a coturn relay.

---

## 5 — Pop out to a standalone window

A tiny embed can offer a **pop-out** button that moves the session into a dedicated `web.voxal.app` browser window, independent of your page — handy when a user wants a persistent, full-size call while navigating away.

Enable it by adding `popout=1` to the iframe `src`:

```html
<iframe
  src="https://web.voxal.app?ui=tiny&popout=1"
  allow="camera; microphone"
  style="width: 320px; height: 200px; border: none;"
></iframe>
```

The button only appears in **tiny** mode (≥ 200 px wide) — never in compact/micro. When clicked:

1. Voxal opens a standalone window on the same room, carrying the user's display name (and color, for auto-assigned names) so the identity is preserved. It also passes `forceWeb=1` so the new window joins in-browser immediately.
2. The embed emits `{ source:'voxal', type:'popout', url }` and **leaves the room** — WebRTC sessions can't be transferred between windows, so there's a brief reconnect in the new window.
3. When the user later closes that window, the embed emits `{ source:'voxal', type:'popout-closed', url }`. Your page can't detect this itself (the window handle belongs to the iframe, not you), so listen for this event — e.g. to un-hide your embed or prompt the user to rejoin.

> **`window.open` needs a user gesture and pop-ups allowed.** If your iframe uses `sandbox`, include `allow-popups` (and `allow-popups-to-escape-sandbox`), otherwise the browser blocks the window: Voxal keeps the current session and emits `{ type:'popout-blocked', url }` so you can react (e.g. surface your own "open in new tab" link).

You can also trigger the same detach from your own UI by opening that `url` yourself — listen for `popout`/`popout-blocked`, or just open `https://web.voxal.app?room=<code>&forceWeb=1` in a new window.

---

## Security

- **Set `?parentOrigin=https://your.site`.** When present, Voxal **rejects every inbound command** (`auth`, `join`, `create`, `key`, `config`) whose `MessageEvent.origin` isn't that origin, and only emits outbound events to it. Without it, inbound commands are accepted from any origin (legacy/back-compat) — so always set it in production.
- **`config` is always strict:** it is rejected cross-origin even if you forget `parentOrigin`, because it carries credentials. In practice this means `config` only works when `parentOrigin` is set.
- **Always post with an explicit target origin** (`frame.postMessage(msg, 'https://web.voxal.app')`), never `'*'`, so your commands/tokens aren't leaked to a hijacked frame.
- **Filter inbound events by `source: 'voxal'`** and ideally check `e.origin` on your side too.

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
    src="https://web.voxal.app"
    allow="camera; microphone"
    style="width:400px;height:600px;border:none;"
  ></iframe>

  <script>
    const ROOM_CODE   = 'your-room-code-here';
    const VOXAL_ORIGIN = 'https://web.voxal.app';
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
- **Camera permission** must be delegated by the embedding page with `allow="camera"` (or `allow="camera; microphone"`). If Voxal is nested inside another iframe, every ancestor iframe must also allow camera access.
- **Origin gating is opt-in via `parentOrigin`** — see [Security](#security). Set it in production to lock the bridge to your origin in both directions; without it, the bridge stays permissive for backward compatibility.
- **Authentication passthrough** — the iframe loads Voxal independently. To pre-log-in with a presence account, send `{ type: 'auth', token, orgId }` via `postMessage` after the `ready` event (this also enables the org's managed TURN).
