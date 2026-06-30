# Button

Voxal's base interactive element. Three variants set the visual hierarchy.

## Variants
- `primary` — filled `--accent` (#7c6af7), white text. Main CTAs: "Create room", "Connect with Voxal".
- `secondary` — raised surface with border. Supporting actions: "Join room", "Cancel".
- `ghost` — transparent, muted text, hover turns red. Low-emphasis or destructive: "Leave room".

## Sizes
Default: `padding: 9px 16px`, `font-size: 13px`.
`sm`: `padding: 5px 12px`, `font-size: 12px`. Used in compact contexts like the peer-list header.

## HTML
```html
<button class="btn btn-primary">Create room</button>
<button class="btn btn-secondary btn-sm">Cancel</button>
<button class="btn btn-ghost">Leave room</button>
<button class="btn btn-primary btn-full">Connect with Voxal</button>
```

## Notes
- `touch-action: manipulation` removes 300ms tap delay on mobile — always keep it.
- `btn-full` sets `width: 100%`; wrap in a sized container to control max-width.
- Pair with `.btn-spinner` (inline `<span>`) to show loading state inside the button.
