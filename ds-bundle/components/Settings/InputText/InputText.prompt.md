# InputText

Standard text input. Raised background, accent border on focus. Optional clearable variant with an × button overlaid on the right.

## HTML
```html
<!-- Basic -->
<input type="text" placeholder="Room code…">

<!-- Focused (accent border) -->
<input type="text" value="abc-xyz-7f3k">
<!-- Focus is handled via :focus selector — no extra class needed -->

<!-- Clearable -->
<div class="input-clearable">
  <input type="text" value="My API key">
  <button class="input-clear" title="Clear">×</button>
</div>
```

## Notes
- `font-size: 16px` + `transform: scale(0.8125)` prevents iOS auto-zoom (inputs < 16px trigger it).
- `width: calc(100% / 0.8125)` compensates for the scale transform shrinking the box.
- `user-select: text; -webkit-user-select: text` required on iOS to allow text selection.
- `.input-clearable input` adds `padding-right: 36px` to leave room for the × button.
- Password inputs (`.input-type-password`) use the same styles.
