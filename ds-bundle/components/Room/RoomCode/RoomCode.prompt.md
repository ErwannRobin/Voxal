# RoomCode

Monospace accent-colored room code with a copy button. Appears in the room header. Clicking copies the invite link to clipboard.

## HTML
```html
<div class="room-code-copy" title="Copy room link">
  <span class="room-code">abc-xyz-7f3k</span>
  <svg class="copy-icon" width="14" height="14" ...><!-- copy icon SVG --></svg>
</div>
```

## Copy toast
After copying, show `.copy-toast` for ~1.5s:
```html
<div class="copy-toast">✅ Link copied!</div>
```
The toast uses `position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%)` in the actual app, with a 300ms fade-out animation on `.hiding`.

## Notes
- `.room-code` has `max-width: 160px; overflow: hidden; text-overflow: ellipsis` — handles long peer IDs.
- The room code IS the host's PeerJS peer ID (a UUID-like string).
- `.room-code-copy` lives in `.room-meta` inside `.room-header`.
