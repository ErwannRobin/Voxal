# Toast

Floating confirmation notification. Appears centered at the bottom of the screen after clipboard copy or other user actions. Auto-hides after ~1.5s.

## HTML
```html
<div class="copy-toast" id="copy-toast">✅ Link copied!</div>
```

## Positioning (in the actual app)
```css
.copy-toast {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 500;
  /* fade-out handled via .hiding class + CSS transition */
}
```

## Notes
- The class name is `.copy-toast` (named for its original copy-confirmation use case) but used for any brief feedback.
- Show/hide via adding/removing from DOM or toggling visibility; add `.hiding` class during fade-out.
- Safe area: on mobile add `bottom: max(calc(env(safe-area-inset-bottom) + 20px), 20px)`.
