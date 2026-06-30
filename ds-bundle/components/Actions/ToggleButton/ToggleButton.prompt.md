# ToggleButton

Pill-shaped ON/OFF control. Used in the room controls bar for Hands-free mode.

## States
- Default: raised background, muted border, muted text — "OFF".
- `active`: green-tinted background, green border, green text — "ON".

## HTML
```html
<!-- Off -->
<button class="toggle-btn">OFF</button>

<!-- On -->
<button class="toggle-btn active">ON</button>
```

## Notes
- Typically paired with a `.label` text to describe what it toggles (e.g. "Hands-free").
- Lives inside `.ctrl-row` in the room controls section alongside the PTT hint.
