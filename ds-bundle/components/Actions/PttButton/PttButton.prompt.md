# PttButton

The central push-to-talk control. Circular (80px), prominent, with three live states.

## States
- `idle` — raised background, dim accent border. Ready, not transmitting.
- `active` — filled accent (#7c6af7), scale(0.95). Mic is live (held press).
- `freehand` — green border + pulsing glow. Hands-free / continuous broadcast.

## HTML
```html
<!-- Idle -->
<button class="ptt-btn">🎙️</button>

<!-- Active (transmitting) -->
<button class="ptt-btn active">🎙️</button>

<!-- Hands-free -->
<button class="ptt-btn freehand">🎙️</button>
```

## Notes
- Use `pointerdown`/`pointerup`/`pointercancel` events (not mouse/touch) for cross-platform hold detection.
- `touch-action: none` prevents scroll during hold on mobile.
- `clip-path: circle(50%)` is needed on Android WebView to enforce circular shape during CSS transform.
- Desktop size (≥640px): `width: 96px; height: 96px; font-size: 36px`.
- Status text below the button uses `.ptt-status` (red, 12px, 600 weight) for error states.
