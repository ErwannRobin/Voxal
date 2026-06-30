# ChannelItem

A presence channel row. Clicking joins the associated room. Shows channel name, active member names, and a live member count.

## States
- Default: raised background, hover brightens background and adds accent border.
- `loading`: 60% opacity, no pointer events.

## HTML
```html
<div class="channel-item">
  <div class="channel-info">
    <span class="channel-name">Engineering</span>
    <span class="channel-members">Alice, Bob, Carol</span>
  </div>
  <span class="channel-count">3</span>
  <span class="channel-join-icon">→</span>
</div>
```

## Container
Wrap in `.channels-list` (`flex-direction: column; gap: 4px; max-height: 160px; overflow-y: auto`). Wrapped in `.presence-panel`.

## Notes
- Hover border color uses `--purple` (same as `--accent`).
- `.channel-count` is green (`--green`) when > 0.
- The join icon can be an SVG chevron in place of the text arrow.
- This component only appears when the user is authenticated with Voxal presence.
