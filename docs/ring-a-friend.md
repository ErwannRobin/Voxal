# Ring a friend — client-held contacts, stateless relay

> **Status: proposal.** Nothing here is implemented. This documents a design and
> the two problems that decide whether it works, so the decisions are on record
> before any code is written.

## Why

Voxal's magic moment is hard to copy: **send a link, be talking in three seconds,
no install, no account, sub-100 ms P2P audio.**

But the loop dies immediately after, and the reason is structural rather than
cosmetic:

- **Nobody can be reached.** There is no service worker anywhere in `src/`
  (`src/manifest.json` exists, but no SW is ever registered) and no notification
  path on any platform. Both parties must *already* have Voxal open.
- **Nothing persists.** Named rooms (`joinOrCreateByChannelName` in `main.js`)
  are published to the `anonymous-rooms` service and expire 1 h after the last
  heartbeat — and `KNOWLEDGE/learning.md` records that after host migration
  nobody holds `_publishSecret`, so the record rots. A channel is a disposable
  pointer, not a place.

The consequence: **to use Voxal you must first use something else.** You text
someone on WhatsApp to say "open this link". The competitor Voxal actually loses
to is that text message. A walkie-talkie you have to schedule is not a
walkie-talkie.

## Architecture

The doorbell needs a server, but **it does not need a database.** Push addresses
are exchanged peer-to-peer when two people become contacts and are stored **only
on their devices**. The backend is a pure function that signs and forwards.

```
Alice                          /api/push/relay            Bob's device
  │  {address, ciphertext} ──────►  (no storage;              │
  │                                  holds only APNs/FCM ──►  │ ring
  │  ◄── provider status             app credentials)         │
```

Three properties make this better than a central registry:

- **The social graph never leaves the devices.** A breach of the relay yields
  nothing, because nothing is stored. "No server holds your contacts" becomes a
  real, checkable claim.
- **It generalises.** Once a device can address a contact, the same rails carry a
  ring, a room invite, or a short text — one mechanism, several features.
- **It scales to zero.** One stateless Vercel function beside the existing
  `api/ice-servers.js`.

**Contact card**, exchanged by QR, link, or in-room:
`{displayName, publicKey, pushAddress, rendezvousId}`.

### Can we do this without collecting push tokens at all?

Not for waking a **closed** app. Web Push, APNs and FCM are all token-addressed —
something must hold an endpoint to POST to, and none of them offer anonymous or
broadcast addressing. What this design does instead is make sure **no server ever
holds one**: the addresses live on the devices of people you have deliberately
added, and the relay only sees one in flight.

Worth noting that Apple's PushToTalk token is *already* the shape we want:
`channelManager(_:receivedEphemeralPushToken:)` in `ios/App/App/PTTPlugin.swift`
is handed a token that rotates, dies when you leave the channel, and cannot be
correlated across channels. That delegate method and its sibling
`incomingPushResult` are **already implemented as empty stubs** — the framework
is wired up, the hooks just do nothing today.

## The two problems that decide whether this works

### 1. Token rotation — the make-or-break issue

FCM and APNs tokens rotate on reinstall, restore and long inactivity; Apple's PTT
token is *ephemeral by design*. With a central registry, rotation is one row.
With client-held copies, **every friend's copy goes stale at once** — and Bob can
only distribute a new address by reaching people he can no longer reach.

Three mechanisms, none of which need server state:

- **Gossip.** Every successful contact — a room join, a ring, an ack —
  piggybacks the sender's current address. Normal use keeps the graph fresh.
- **Provider feedback.** The relay returns the provider's `410 Gone` /
  `NotRegistered` **to the sender**, who marks that contact stale and surfaces
  "reconnect with Bob".
- **PeerJS rendezvous — the one that actually rescues it.** Each identity derives
  a stable peer ID from its keypair. A contact whose token is dead is still
  reachable over the broker **whenever their app is running**, which delivers the
  ring *and* refreshes the stored address. This reuses signalling the app already
  runs.

### 2. A stateless forwarder is an open push relay

It will send to any address handed to it, so a scraped address could be used to
spam a device — and the throttling would land on our APNs/FCM credentials.

The defence has to be **client-side**, because the relay holds no state and
therefore cannot authenticate anyone. Every ring is **signed by the sender**, and
the recipient **drops anything not signed by a key in its own contact list** —
silently, with no notification shown. On iOS that fits the existing
`incomingPushResult` hook; on Android and web the service worker decides whether
to display.

The relay itself does only coarse best-effort IP throttling, reusing
`rateLimit` / `clientIp` from `api/_turn.js` — whose own comment is already
honest that per-instance limiting "is not a security boundary". That is the
correct layering: the relay cannot authenticate, so the device does.

## Phases

Each phase is independently shippable, and the first two need **no backend, no
push, and no Apple membership**.

**1 — Identity and contacts (no backend).** Keypair via `crypto.subtle` (unused
in `main.js` today), contact list in `localStorage`, QR/link pairing built on the
existing share sheet and `roomInviteUrl()`, stable rendezvous peer ID. Contacts
appear on the home screen.

**2 — Ring over rendezvous (no backend, no push).** Ring any contact whose app is
running, entirely P2P over the PeerJS broker. Zero tokens, zero server.

**3 — Stateless relay + native push.** `POST /api/push/relay`. iOS: implement the
two existing stubs in `PTTPlugin.swift` so a PTT push wakes the app onto the Lock
Screen with the Talk button live — precisely what Apple built the framework for.
Android: Capacitor FCM + a foreground service. Signed-ring verification on both.

**4 — Async text on the same rails.** A short message rides inside the encrypted
push payload (~4 KB budget), with a **sender-side outbox retrying until ack** —
still nothing stored server-side.

## Files this would touch

| File | Change |
|---|---|
| `src/main.js` | Identity keypair, contact store, QR pairing, rendezvous ring, signed-ring verification, outbox |
| `src/index.html`, `src/styles.css` | Contacts list, ring affordance, pairing sheet |
| `src/sw.js` | **New** — receives push, verifies signature, decides whether to notify |
| `ios/App/App/PTTPlugin.swift` | Implement the existing push stubs |
| `api/push/relay.js` | **New**, stateless; mirrors `api/ice-servers.js`, reuses `api/_turn.js` helpers |
| `android/…` | FCM + foreground service |
| `tests/e2e/unit-contacts.spec.js` | **New** |

## Verification

- **Phases 1–2:** three Chromium contexts pair by QR payload, then one rings
  another and it connects — asserting **zero** requests to any Voxal API via
  `page.route`. Extend `tests/e2e/mesh.spec.js`, which already drives real PeerJS.
- **Rotation (the risky part):** simulate a rotated address — assert the sender
  marks the contact stale on a `410`, and that the rendezvous path both delivers
  the ring and refreshes the stored address.
- **Abuse:** a ring signed by an unknown key must produce **no** notification.
- **Relay:** `node --test` asserting it stores nothing and rejects malformed
  input; add to the existing `make test-api`.
- `make test` + `make test-mesh` + `make test-api` green; `make cap-sync`.

## Honest limits

- **Async text is best-effort, not a message store.** APNs collapses and FCM
  expires undelivered pushes, so a device off for days can miss messages. The
  sender-side outbox mitigates this; it does not make Voxal WhatsApp, and it
  should not be marketed as reliable messaging.
- **Cross-platform contact sync has no common cloud.** iCloud KV and Google Drive
  appdata are per-platform conveniences; **QR/link device pairing is the
  primitive**. On web, `localStorage` is subject to Safari ITP eviction — web is
  the weak platform here, which is consistent with going native-first.
- **iOS needs the paid Apple Developer membership** already flagged in
  `KNOWLEDGE/todos.md`. Phases 1–2 deliberately require none of it.
- **The README's "No server required" would need rewording** to "your voice and
  your contacts never touch a server" — still true, and a stronger claim.
- **Mesh caps at ~6–8 peers.** This targets 1:1 and small squads. It must not
  pull the architecture toward an SFU, which would forfeit the one advantage
  nobody else has.
