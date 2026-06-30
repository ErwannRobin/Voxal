# PeerItemCompact

Pill-shaped peer chip for the tiny embed view (≤418px iframe). Self chip is tall (62px) with a mic icon; remote peers are flat 28px pills.

## Variants
- **Self** (`.peer-self`): 62×~62px, flex-column, dim accent border, mic icon + name (2-line clamp).
- **Remote** (default): 28px height, flat pill, single-line name.
- **Talking** (`.talking`): green-tinted background + inner glow, label turns `#d1fae5`.

## HTML
```html
<!-- Self chip -->
<div class="peer-item peer-item-compact peer-self">
  <span class="peer-mic-icon">🎙️</span>
  <span class="peer-compact-label">Alice</span>
</div>

<!-- Remote peer -->
<div class="peer-item peer-item-compact">
  <span class="peer-compact-label">Bob</span>
</div>

<!-- Talking -->
<div class="peer-item peer-item-compact talking">
  <span class="peer-compact-label">Dave</span>
</div>
```

## Layout context
These chips live inside `.peers-list` which in tiny embed mode becomes a horizontal flex row (`flex-direction: row`). The self chip is always first. Remote chips are wrapped in `.tiny-peers-others` (a 2-row grid, horizontally scrollable).

## Notes
- In "compact" embed (101–199px wide), `.tiny-compact` hides other-peer chips and shows only self + a peer count.
- In "micro" embed (≤100px), the entire iframe is a large 🎙️ emoji; the mic icon is the only thing rendered.
- Anonymous Color Animal names get a `labelColor` applied via inline `style.color`.
