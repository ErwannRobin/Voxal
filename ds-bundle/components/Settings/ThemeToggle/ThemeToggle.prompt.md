# ThemeToggle

Segmented pill control for selecting the app theme. Three options: Dark, Light, System.

## HTML
```html
<div class="theme-toggle">
  <button class="active">🌙 Dark</button>
  <button>☀️ Light</button>
  <button>💻 System</button>
</div>
```

## Notes
- Active button gets `background: var(--accent); color: #fff`.
- Value stored in `localStorage['theme']` as `'dark'`, `'light'`, or `'system'`.
- Applied before first paint via inline `<script>` in `<head>` — sets `data-theme` on `<html>`.
- `data-theme="system"` uses `@media (prefers-color-scheme: light) { html[data-theme="system"] }`.
- Dark is the default (no `data-theme` attribute needed).
