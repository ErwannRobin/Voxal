# Host Migration

This document explains how Voxal keeps a room alive when the current host disappears.

## Why this exists

Voxal uses:

- **Star signaling** (host ↔ each peer over PeerJS DataConnection)
- **Full-mesh audio** (peer ↔ peer over WebRTC MediaConnection)

If the host signaling link dies, signaling must be re-established quickly without tearing down healthy peer-to-peer audio links.

## Design goals

1. Keep voice flowing during host handoff.
2. Avoid split-brain (different peers electing different hosts).
3. Make migration idempotent and resilient to stale/late events.
4. Recover automatically from failed host candidates.

## Core mechanics

### Authoritative successor chain

The active host publishes `deputyId` + `successorIds` in:

- `peer-list`
- `heartbeat`

On host loss, peers follow this **authoritative chain** rather than recomputing only from local transient state.

### Room state machine

`roomState` values:

- `idle`
- `connecting`
- `connected`
- `migrating`

Migration entrypoint is `initiateHostMigration(...)`, which is state-aware and ignores stale events.

### Heartbeat-based liveness

- Host heartbeat interval: `2000ms`
- Host heartbeat timeout: `7000ms`

Peers trigger migration when host heartbeat timeout is exceeded.

## Migration flow

1. Current host is considered failed (DataConnection close or heartbeat timeout).
2. Peer transitions `connected -> migrating`.
3. Failed host is excluded from candidacy (`_migrationExcluded`).
4. Candidate is chosen from authoritative successor order.
5. If elected self, peer runs `becomeHost()`.
6. Otherwise peer runs `connectToNewHost(newHostId)`.
7. Migration is considered successful **only after receiving the new host `peer-list`**.

## Retry and fallback behavior

When connecting to an elected host candidate:

- Per-attempt timeout: `8000ms`
- Retry delay: `2000ms`
- Max retries: `3`

If retries are exhausted, candidate is excluded and election proceeds with the next successor.

## Split-brain protections

- Successor chain comes from host-authoritative messages.
- Host always rebroadcasts fresh `peer-list` to propagate current successor chain.
- Connection attempt generation (`_hostConnGeneration`) invalidates stale callbacks/timers.
- Migration path excludes failed candidates to prevent election loops.

## Audio continuity guarantees

During migration, Voxal intentionally cleans up only the **old host** signaling/media link.  
Audio links to other peers are preserved, which minimizes audible interruption.

## Settle window after becoming host

After `becomeHost()`, Voxal starts a migration settle window (`8000ms`) where known peers are kept as placeholders while they reconnect.  
After the window, the host rebroadcasts and prunes ghosts that never reattached.

## Important messages in migration

| Message | Role in migration |
|---|---|
| `heartbeat` | Liveness detection + successor/deputy hints |
| `peer-list` | Authoritative room/successor state; marks migration success |
| `redirect` | Sends misdirected joiners to current host |
| `peer-joined` / `peer-left` | Membership updates between authoritative snapshots |

## Debugging tips

Watch browser/dev logs for:

- `[heartbeat] ... missed heartbeat timeout ... Starting migration`
- `[migration] ... Elected: ...`
- `[migration] Connected to new host ... Received peer-list`
- `[migration] Candidate ... failed; re-electing`

If a room oscillates, verify successor-chain propagation (`successorIds`) and confirm fresh `peer-list` broadcasts are reaching all peers.
