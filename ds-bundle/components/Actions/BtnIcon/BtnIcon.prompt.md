# BtnIcon

Borderless icon-only button. Used for room header actions (settings gear, leave door, share).

## Variants
- Default: muted color, hover → accent (#7c6af7).
- `leave` (add `#btn-leave` or override hover): hover → red (#f87171).

## HTML
```html
<!-- Settings trigger -->
<button class="btn-icon" title="Settings">⚙️</button>

<!-- Leave room — red hover -->
<button id="btn-leave" class="btn-icon" title="Leave">🚪</button>

<!-- SVG icon -->
<button class="btn-icon" title="Share">
  <svg width="18" height="18" ...>...</svg>
</button>
```

## Notes
- The `.gear-icon` modifier sets `font-size: 22px` for the settings gear specifically.
- SVG icons inside use `stroke="currentColor"` so they inherit the button's color transition.
- Pair with small font-size (`font-size: 0` on wrapper) for SVG-only buttons where emoji text would interfere.
