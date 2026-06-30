# NoiseCard

A radio-button option card used in settings. Grid layout: radio on the left, title + description on the right.

## HTML
```html
<label class="noise-card">
  <input type="radio" name="noise" checked>
  <span class="noise-card-title"><em>AI</em> Noise Suppression</span>
  <span class="noise-card-desc">Removes background noise using Krisp.</span>
</label>
```

## Notes
- `<em>` inside `.noise-card-title` renders in accent color (`--accent`), used to highlight technology names.
- Wrap multiple cards in `.noise-card-group` (`flex-direction: column; gap: 8px`).
- Use `<label>` as the wrapper so clicking anywhere on the card selects the radio.
- Used in the "Noise suppression" section of the Audio settings card.
