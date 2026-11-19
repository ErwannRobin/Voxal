---
name: join-voice-room
description: Start or join a Voxal push-to-talk voice room in the browser and share its link. Use when the user wants a quick voice call with no account, a walkie-talkie style room, or to join a Voxal room from a link or a code.
---

# Start or join a Voxal voice room

Voxal (https://web.voxal.app) is a peer-to-peer push-to-talk voice chat that runs in the browser. No account is needed. A room is a code; everyone with the code is in the same room.

## Join or create by link (no browser automation needed)

Give the user this link, or open it for them:

    https://web.voxal.app/?room=<code>

- `<code>` that is a plain name (letters, digits, dashes — e.g. `team-standup`) is a **named room**: the first person to open it creates it, everyone after joins it. Pick a name that is hard to guess if the room should stay private.
- `<code>` that is a UUID is a room someone already created; it only works while that room is open.
- Append `&video=1` to arrive with the camera on.

## Driving the page (WebMCP)

When the page is open in a browser that supports WebMCP, it registers these tools on `navigator.modelContext`:

| Tool | Input | Does |
|---|---|---|
| `create_voice_room` | — | Creates a new room and returns its invite link |
| `join_voice_room` | `{ "room": "<code or invite link>" }` | Joins (or, for a name, creates) that room |
| `get_room_status` | — | Whether the page is in a room, and the room's invite link |
| `leave_voice_room` | — | Leaves the current room |

## Things only the user can do

- **Grant microphone access.** The browser asks; an agent cannot answer that prompt.
- **Talk.** Voxal is push-to-talk: the user holds the big button (or their keyboard shortcut on desktop) while speaking.

## Don'ts

- Do not post a room link publicly unless the user asked: anyone with it can join.
- Do not poll `/api/ice-servers`; it is rate limited and only useful to the app itself.
