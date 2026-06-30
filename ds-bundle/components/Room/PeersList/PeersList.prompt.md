# PeersList

Scrollable container for peer rows. Surface background, rounded border, `max-height: 180px` (260px on desktop ≥640px).

## HTML
```html
<div class="peers-list">
  <!-- Self row first -->
  <div class="peer-item peer-self">
    <span class="peer-dot"></span><span>You (Alice)</span>
  </div>
  <!-- Remote peers -->
  <div class="peer-item talking">
    <span class="peer-dot"></span><span>Bob</span>
  </div>
</div>
```

## Invite nudge
When the user is alone, append a `.room-invite-nudge` after the self row:
```html
<div class="room-invite-nudge">
  <span class="room-invite-nudge-text">Share the room code to invite others</span>
  <button class="btn btn-secondary btn-sm">Copy link</button>
</div>
```

## Notes
- In the full room screen (`#screen-room`), the list has no max-height constraint — it grows to fill `flex: 1`.
- ID is `#peers-list` in the actual DOM.
- Wrapped in `.room-peers-panel` which is `flex-direction: column`.
