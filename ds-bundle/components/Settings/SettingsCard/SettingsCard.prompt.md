# SettingsCard

Collapsible settings section card. Contains labeled fields separated by `.settings-separator` dividers.

## HTML
```html
<div class="settings-card">
  <button class="settings-card-toggle">Profile</button>
  <div class="settings-field">
    <label>Display name</label>
    <input type="text" value="Alice" placeholder="Your name…">
    <span class="field-helper">Shown to other participants.</span>
  </div>
  <div class="settings-separator"></div>
  <div class="settings-field settings-inline-toggle">
    <label>Join muted</label>
    <button class="toggle-btn">OFF</button>
  </div>
</div>
```

## Collapsed state
Add `.is-collapsed` to `.settings-card` — the CSS hides all children except the toggle button, and rotates the `▶` arrow:
```html
<div class="settings-card is-collapsed">
  <button class="settings-card-toggle">Audio</button>
  <!-- content hidden -->
</div>
```

## Spacing
Cards stack with `margin-top: 24px` between them (`.settings-card + .settings-card`).

## Field variants
- `.settings-field` — vertical stack (label above input).
- `.settings-field.settings-inline-toggle` — horizontal row for label + toggle button side-by-side.

## Notes
- In the wide modal (≥861px), a sidebar nav (`.modal-settings-sidebar`) replaces the collapsible toggles.
- The modal scrollable area is `.modal-settings-scrollable` with `padding: 16px 20px`.
