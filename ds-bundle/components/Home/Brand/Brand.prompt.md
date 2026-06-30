# Brand

Home screen hero section: large emoji icon, app name, and tagline. Centered column layout with generous vertical padding.

## HTML
```html
<div class="brand">
  <span class="brand-icon">🎙️</span>
  <h1>Voxal</h1>
  <p>Push-to-talk for your team</p>
</div>
```

## Sizing
- Mobile: `padding: 28px 0 20px`, icon 42px, h1 22px.
- Desktop (≥640px): `padding: 44px 0 32px`, icon 52px, h1 26px.
- Taller desktop (≥640px + ≥700px): `padding: 56px 0 40px`.

## Background
The body gets a subtle accent radial glow at ≥640px:
```css
background-image: radial-gradient(ellipse 110% 45% at 50% -5%, rgba(124,106,247,0.09) 0%, transparent 65%);
```

## Notes
- Sits at the very top of `#screen-home`, above `.home-actions`.
- Hidden in tiny embed mode (`body.embed-tiny`).
