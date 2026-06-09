# Security Policy

## Supported Versions

Only the latest release is actively maintained. Security patches are applied to the current major version only.

| Version | Supported |
|---------|-----------|
| 1.x (latest) | ✅ |
| < 1.0 | ❌ |

## Security Model

Voxal is a **serverless, peer-to-peer** voice chat app. Understanding its threat model helps determine what constitutes a security vulnerability.

### What is protected

- **Audio streams** are encrypted with **DTLS-SRTP** — mandatory in all WebRTC implementations. Audio cannot be intercepted in transit by a network observer.
- **Signaling messages** (display names, room events) travel over **DTLS-encrypted DataChannels** once the peer connection is established.
- **No user data is stored server-side.** Voxal has no backend database, no user accounts, and no persistent session data.
- **Room codes are ephemeral.** A room only exists while at least one peer is connected.

### What is not guaranteed

- **Room codes are not secret by design.** Sharing a room code grants access to the room. Treat room codes like meeting links.
- **Display names are unauthenticated.** Any peer can claim any name.
- **The PeerJS signaling server** is used to exchange ICE candidates during connection setup. A compromised signaling server could theoretically attempt a man-in-the-middle attack on the DTLS handshake, though modern browsers detect forged certificates.
- **TURN relay servers**, if configured, can observe encrypted packet metadata but not content.

### Out of scope

The following are known limitations and are **not treated as vulnerabilities**:

- Peers with knowledge of a room code can join that room.
- Display names can be spoofed by any peer.
- The PeerJS public cloud service is a third-party dependency.

## Reporting a Vulnerability

If you discover a security vulnerability in Voxal, please report it **privately** using GitHub's built-in vulnerability reporting:

👉 [Report a vulnerability](https://github.com/ErwannRobin/Voxal/security/advisories/new)

Please include:
- A clear description of the vulnerability
- Steps to reproduce it
- The version(s) affected
- Any suggested mitigations (optional)

**Please do not open a public GitHub issue for security vulnerabilities.**

You can expect an acknowledgement within **72 hours** and a resolution or status update within **14 days**. If a fix is warranted, a patched release will be published and you will be credited in the release notes (unless you prefer to remain anonymous).
