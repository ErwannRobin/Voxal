# PeerItem

A single row in the full peer list. Shows name, ICE connection quality dot, optional role tag, UUID, and WebRTC stat badges.

## States
- **Self row** (`.peer-self`): text color is `--text` (brighter). Green dot. Optional "host" role tag.
- **Remote row**: muted text color. Dot color reflects ICE type: green (direct), yellow (STUN), red (relay).
- **Talking** (`.talking`): green-tinted background, animated pulsing dot.

## HTML
```html
<!-- Self (host) -->
<div class="peer-item peer-self">
  <span class="peer-dot"></span>
  <span class="peer-main">
    <span class="peer-label-row">
      <span>Alice</span>
      <span class="peer-role">host</span>
    </span>
  </span>
</div>

<!-- Remote peer talking -->
<div class="peer-item talking">
  <span class="peer-dot"></span>
  <span class="peer-main">
    <span class="peer-label-row"><span>Bob</span></span>
  </span>
</div>
```

## Dot colors
- `.peer-self .peer-dot` → green (`--green`)
- `.peer-dot-direct` → green (direct P2P)
- `.peer-dot-stun` → yellow (#fbbf24, STUN traversal)
- `.peer-dot-relay` → red (#f87171, TURN relay)
- `.talking .peer-dot` → always green + pulsing glow (overrides ICE color)

## Stat badges
Add `.peer-webrtc-stats` div inside `.peer-main` after `.peer-uuid`:
```html
<div class="peer-webrtc-stats">
  <span class="stat-badge ice-direct">direct</span>
  <span class="stat-badge stat-neutral">24 ms</span>
</div>
```
Badge variants: `.ice-direct`, `.ice-stun`, `.ice-relay`, `.stat-neutral`, `.stat-warn`.

## Notes
- Non-self dots are clickable (`.peer-dot-clickable`) to show a stats popover.
- Clicking the pencil icon on self row opens an inline name-edit input (`.peer-name-inline`).
