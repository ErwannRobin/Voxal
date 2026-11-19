# Voxal — push-to-talk voice chat in the browser

Peer-to-peer push-to-talk voice chat. No accounts, no server in the middle of your voice: share a room code and start talking.

## Start talking

1. Open <https://web.voxal.app/> and press **Create Room**.
2. Share the invite link shown in the room — it looks like `https://web.voxal.app/?room=<code>`.
3. Hold the talk button (or your shortcut on desktop) to speak.

To join, open an invite link, or type the room code on the home page and press **Join**. A room code that is a plain name (for example `?room=standup`) is created by whoever arrives first.

## In a room

- Voice: Opus, sent directly between participants (full mesh WebRTC). If a direct path is impossible, an encrypted TURN relay is used; it cannot hear the audio.
- Camera and screen sharing, with background blur and animated 3D backgrounds.
- Text chat with replies, reactions and @mentions.
- Host migration: if the person who created the room leaves, the room stays up.

## Get the app

Voxal also runs as a macOS app and on iOS and Android. See <https://www.voxal.app/>.

## For agents

- Machine-readable summary: <https://web.voxal.app/llms.txt>
- Agent skills: <https://web.voxal.app/.well-known/agent-skills/index.json>
- API catalog: <https://web.voxal.app/.well-known/api-catalog>
- Source: <https://github.com/ErwannRobin/Voxal> (MIT)
