# StatBadge

Monospace pill badge used inside `.peer-webrtc-stats` to show ICE connection type and live metrics.

## Variants
- `.ice-direct` — green tint. Direct P2P connection (host candidate).
- `.ice-stun` — yellow tint. STUN-traversed connection (srflx candidate).
- `.ice-relay` — red tint. TURN-relayed connection (relay candidate).
- `.ice-unknown` / `.stat-neutral` — neutral. Metrics (latency, bitrate) or unknown state.
- `.stat-warn` — red tint. Warning state (e.g. high packet loss).

## HTML
```html
<div class="peer-webrtc-stats">
  <span class="stat-badge ice-direct">direct</span>
  <span class="stat-badge stat-neutral">24 ms</span>
  <span class="stat-badge stat-warn">packet loss 5%</span>
</div>
```

## Placement
Always inside `.peer-webrtc-stats` which is `flex-basis: 100%` — it wraps to its own line below the peer name. Use `padding-left: 15px` to align under the name text (past the ICE dot + gap).
