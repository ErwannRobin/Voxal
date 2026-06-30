# RejoinBar

A compact bar on the home screen that offers to rejoin the previous room. Appears after leaving a room when a `lastRoomCode` is in `localStorage`.

## HTML
```html
<div class="rejoin-bar" id="rejoin-bar">
  <span class="rejoin-icon">↩️</span>
  <span class="rejoin-label">abc-xyz-7f3k</span>
  <button class="btn btn-secondary rejoin-btn">Rejoin</button>
  <button class="rejoin-dismiss" title="Dismiss">×</button>
</div>
```

## Notes
- Hidden with `display: none` by default; toggled visible when `lastRoomCode` exists.
- `.rejoin-label` truncates with ellipsis if the room code is long.
- Dismiss permanently clears `lastRoomCode` from localStorage for this session.
