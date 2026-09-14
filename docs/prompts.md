# LLM integration prompts

Copy-paste prompts for coding agents (Claude Code, Cursor, Copilot, Codex,
ChatGPT…) that integrate, deploy, fork or extend Voxal.

Every prompt is deliberately **short**. None of them tries to describe Voxal —
each one tells the agent *which document to download and read first*, then
states the goal and the constraints. That keeps the prompt small, keeps the
agent accurate, and means a prompt never goes stale when a doc changes.

---

## How to use this page

1. Find your use case below.
2. Copy the fenced block into your agent, replacing the `<...>` placeholders.
3. If your agent has **no network access**, download the listed docs yourself
   and attach them instead — the prompts still work, only the fetch step
   changes.

Most prompts also assume the agent can read your own project. Point it at the
right folder before you start.

### Optional preamble

Prepend this to any prompt when the agent knows nothing about Voxal:

```text
Voxal is an open-source push-to-talk voice app: WebRTC full-mesh audio (Opus,
16 kHz mono) that is never routed through a media server, star signaling over
PeerJS, no account required, and a host-migration protocol that keeps a room
alive when the host leaves. Camera and screen-share are separate link sets that
may optionally route through an SFU; voice never does.
Repo: https://github.com/ErwannRobin/Voxal
Hosted web app: https://web.voxal.app
```

---

## Document map

Raw base URL for all of these:
`https://raw.githubusercontent.com/ErwannRobin/Voxal/main/`

| Document | Path | Covers |
|---|---|---|
| Architecture & protocol | `docs/architecture.md` | Topology, room lifecycle, data protocol, project layout |
| iframe embed | `docs/iframe-embed.md` | Embed URL params, `postMessage` commands/events, pop-out, security |
| Video routing | `docs/video-routing.md` | Mesh vs. SFU, routing preference, SFU wire protocol, env vars |
| Camera effects | `docs/video-effects.md` | Background blur/replacement pipeline, WASM assets, settings |
| TURN & ICE | `docs/turn-and-ice.md` | Resolution order, anonymous credentials, self-hosting coturn |
| Deployment | `docs/deployment.md` | Static deploy, serverless TURN/SFU, self-host checklist, Connect |
| Host migration | `docs/host-migration.md` | Successor chain, state machine, heartbeats, split-brain |
| Mobile | `docs/mobile.md` | iOS/Android workflow, capabilities, forking identity/signing |
| Release | `docs/release.md` | Version sync, signing, CI release builds |
| Contributor rules | `CLAUDE.md` | Conventions, localStorage keys, helper functions, commands |
| Contributing | `CONTRIBUTING.md` | PR process and expectations |

---

## A — Embedding Voxal in your product

### A1. Drop a voice room into a page

```text
Download and read https://raw.githubusercontent.com/ErwannRobin/Voxal/main/docs/iframe-embed.md
in full before writing any code.

Task: embed a Voxal voice room in <file/route in my app>.
- Use the hosted app at https://web.voxal.app.
- Layout: <full panel | sidebar widget | toolbar badge>. Pick the embed mode
  and iframe size that matches, per the "Embedding modes by width" table.
- Set parentOrigin to <https://my.site> and keep the iframe permissions minimal.
Deliver the iframe markup plus any CSS, and explain which URL parameters you
chose and why.
```

### A2. Control the room from my page (postMessage bridge)

```text
Download and read https://raw.githubusercontent.com/ErwannRobin/Voxal/main/docs/iframe-embed.md
in full, especially the command and event reference tables.

Task: wire my page's UI to an embedded Voxal room.
- My buttons must: <join a room code from my DB | create a room | leave>.
- My UI must react to: joined, left, peers, talking, host-changed, error.
- Wait for the `ready` event before sending any command; always post with an
  explicit target origin, never '*'; filter inbound by `source === 'voxal'`.
Deliver a single self-contained module with no dependencies.
```

### A3. Wrap the embed as a framework component

```text
Download and read https://raw.githubusercontent.com/ErwannRobin/Voxal/main/docs/iframe-embed.md
in full before writing any code.

Task: build a <React | Vue | Svelte | Angular> component `<VoxalRoom>` around the
Voxal iframe.
- Props: roomCode, parentOrigin, tiny, hideHeader, popout, authToken, orgId.
- Events/callbacks: onJoined, onLeft, onPeers, onTalking, onError.
- The bridge listener must be added and removed with the component lifecycle,
  and commands must queue until the `ready` event arrives.
Match the conventions already used in <my components folder>.
```

### A4. Lock the embed down for production

```text
Download and read the "Security" and "Providing your own TURN relay" sections of
https://raw.githubusercontent.com/ErwannRobin/Voxal/main/docs/iframe-embed.md,
then review my embed at <path>.

Task: audit and harden it.
- Confirm parentOrigin is set, that outbound postMessage uses an explicit
  origin, and that inbound events are filtered by source and origin.
- If we pass a presence token via the `auth` command, check it is only sent
  after `ready` and never logged or put in the iframe URL.
Report findings as a short list, then apply the fixes.
```

### A5. Give the embed our own TURN relay

```text
Download and read:
- https://raw.githubusercontent.com/ErwannRobin/Voxal/main/docs/iframe-embed.md (section 4)
- https://raw.githubusercontent.com/ErwannRobin/Voxal/main/docs/turn-and-ice.md

Task: make our embedded rooms work behind <corporate firewall | symmetric NAT>.
- Our relay is <coturn at turn.example.com | Cloudflare | a provider>.
- Send the ICE servers through the bridge rather than any client storage, and
  respect the origin requirement that comes with it.
- Include STUN entries too, and a TLS entry on 443/TCP.
Explain the precedence order you are relying on, and where credentials live.
```

### A6. Make a "video call" link instead of push-to-talk

```text
Download and read the embed URL parameter table in
https://raw.githubusercontent.com/ErwannRobin/Voxal/main/docs/iframe-embed.md,
plus https://raw.githubusercontent.com/ErwannRobin/Voxal/main/docs/video-routing.md.

Task: generate invite links / embeds in <my app> that open a room with the
camera already sharing and the mic open, like a normal video-conference link.
- State exactly which iframe permissions are required and why.
- Explain in one paragraph what routing the video will take by default, and
  confirm voice routing is unaffected.
```

---

## B — Running Voxal yourself

### B1. Deploy the web app

```text
Download and read:
- https://raw.githubusercontent.com/ErwannRobin/Voxal/main/docs/deployment.md
- https://raw.githubusercontent.com/ErwannRobin/Voxal/main/README.md

Task: deploy Voxal to <Vercel | Netlify | Cloudflare Pages | our own nginx>.
- Cover HTTPS, the required cross-origin isolation headers, and the build step.
- Note anything in the repo that is staged at build time rather than committed.
Deliver the exact commands and config file for that host.
```

### B2. Stand up anonymous TURN credentials

```text
Download and read:
- https://raw.githubusercontent.com/ErwannRobin/Voxal/main/docs/deployment.md
- https://raw.githubusercontent.com/ErwannRobin/Voxal/main/docs/turn-and-ice.md

Task: enable short-lived TURN credentials for users with no account on our
deployment at <host>.
- List every environment variable, where to get its value, and the defaults.
- Describe the behaviour when the variables are absent, and confirm it is safe
  to deploy before the account exists.
- Add rate limiting appropriate to <expected traffic>.
```

### B3. Self-host a coturn relay

```text
Download and read the self-hosting section of
https://raw.githubusercontent.com/ErwannRobin/Voxal/main/docs/turn-and-ice.md.

Task: produce a production coturn setup for <domain> on <OS/distro>.
- Prefer short-lived credentials over static ones.
- Include TLS on 443/TCP, firewall ports, and a certificate renewal note.
- Then show how to point Voxal at it, for both a standalone user and an embed.
```

### B4. Enable the optional SFU for video

```text
Download and read:
- https://raw.githubusercontent.com/ErwannRobin/Voxal/main/docs/video-routing.md
- https://raw.githubusercontent.com/ErwannRobin/Voxal/main/docs/deployment.md

Task: turn on relayed camera/screen-share for our deployment.
- List the environment variables and which dashboard value maps to each.
- Explain when the app chooses the relay over the mesh, and how a user can
  refuse it.
- State explicitly, in the runbook, what happens to voice. Do not change it.
Deliver a short runbook plus the fallback behaviour when the variables are unset.
```

### B5. Self-host signaling and assets

```text
Download and read:
- https://raw.githubusercontent.com/ErwannRobin/Voxal/main/docs/deployment.md
- https://raw.githubusercontent.com/ErwannRobin/Voxal/main/docs/architecture.md
- https://raw.githubusercontent.com/ErwannRobin/Voxal/main/CLAUDE.md

Task: remove every dependency on public infrastructure for our deployment.
- Run our own PeerJS broker and point the app at it through the documented
  override, without hardcoding it into the source.
- Serve the segmentation runtime from our own origin rather than the public one.
- Keep the bundled PeerJS build; never load it from a CDN.
Deliver the config changes and a checklist of what is now self-hosted.
```

---

## C — Native apps

### C1. Fork and rebrand the mobile apps

```text
Download and read:
- https://raw.githubusercontent.com/ErwannRobin/Voxal/main/docs/mobile.md
- https://raw.githubusercontent.com/ErwannRobin/Voxal/main/docs/release.md

Task: rebrand the iOS and Android apps as <App name> under <bundle id>.
- Change app identity, icons, deep-link/app-link domains and signing.
- List the files that must change on each platform, and the sync step required
  after any web asset change.
Deliver a step-by-step fork checklist. Flag anything that needs a paid
developer account.
```

### C2. Build and sign the desktop app

```text
Download and read:
- https://raw.githubusercontent.com/ErwannRobin/Voxal/main/docs/release.md
- https://raw.githubusercontent.com/ErwannRobin/Voxal/main/README.md
- https://raw.githubusercontent.com/ErwannRobin/Voxal/main/CLAUDE.md

Task: produce a signed desktop build for <macOS | Windows | Linux>.
- Use the repo's own make targets rather than inventing commands.
- Cover the custom URL scheme registration and why a dev run cannot do it.
- List signing prerequisites and the version files kept in sync by a release.
```

---

## D — Working on the Voxal codebase

### D1. Add a frontend feature

```text
Download and read https://raw.githubusercontent.com/ErwannRobin/Voxal/main/CLAUDE.md
in full before editing anything, then read the source files it points you to.

Task: implement <feature> in the Voxal frontend.
Hard constraints from that document:
- No framework, no bundler, no new dependency without asking.
- Guard every desktop-only or mobile-only path by platform detection.
- Use the documented microphone and camera helpers; never call getUserMedia or
  stop tracks directly.
- Any new setting needs a storage key documented in the same table.
- Run the repo's sync step after touching web assets, and run the test suite.
Show me the plan before you write code.
```

### D2. Add a desktop (Tauri) command

```text
Download and read the "Adding a Tauri IPC command" section of
https://raw.githubusercontent.com/ErwannRobin/Voxal/main/CLAUDE.md, plus
https://raw.githubusercontent.com/ErwannRobin/Voxal/main/docs/architecture.md.

Task: expose <native capability> to the frontend.
- Follow all four steps in that section, including the capability/permission
  declaration — a missing permission fails silently at runtime.
- Keep the JS call site guarded so web and mobile are unaffected.
Deliver the Rust side, the JS call site, and the permission change.
```

### D3. Write tests for a change

```text
Download and read:
- https://raw.githubusercontent.com/ErwannRobin/Voxal/main/CLAUDE.md (Commands section)
- https://raw.githubusercontent.com/ErwannRobin/Voxal/main/CONTRIBUTING.md

Task: add tests covering <change>.
- Choose the right suite: fast UI/logic, multi-peer WebRTC, Rust, or API.
- Import the test helpers the repo's own specs import, not the framework
  directly, so coverage instrumentation still works.
- Multi-peer specs must carry the tag that keeps them out of the fast suite.
Run the suite and paste the real output, including failures.
```

### D4. Debug a connection failure

```text
Download and read:
- https://raw.githubusercontent.com/ErwannRobin/Voxal/main/docs/turn-and-ice.md
- https://raw.githubusercontent.com/ErwannRobin/Voxal/main/docs/video-routing.md (Debugging)

Symptoms: <what the user sees — no audio, black tile, missing peer, one-way
audio, works on wifi but not on the office network…>
Environment: <browser/app, OS, network>.

Walk through the documented resolution order and diagnostics in that order,
tell me which layer is failing, and what to change. Ask for the specific logs
or badge states you need rather than guessing.
```

### D5. Change anything touching host migration

```text
Download and read:
- https://raw.githubusercontent.com/ErwannRobin/Voxal/main/docs/host-migration.md
- https://raw.githubusercontent.com/ErwannRobin/Voxal/main/docs/architecture.md
- https://raw.githubusercontent.com/ErwannRobin/Voxal/main/CLAUDE.md

Task: <change> in the signaling / peer-list / migration path.
- Preserve the invariants that document states: the authoritative successor
  chain, the room state machine, and audio links that must survive a handoff.
- Explain the split-brain implications of your change before implementing it.
- Run the multi-peer test suite, not just the fast one.
```

### D6. Extend camera background effects

```text
Download and read https://raw.githubusercontent.com/ErwannRobin/Voxal/main/docs/video-effects.md
in full — it is long, and the pipeline details matter.

Task: <add an effect | change a control | tune quality/performance>.
- Keep all segmentation local; no frame may leave the device.
- Do not renegotiate the connection for a change that is only a shader uniform.
- Respect the documented teardown path so the camera is really released.
Explain which part of the pipeline you are touching before you edit.
```

---

## E — Accounts and presence

### E1. Integrate Voxal Connect sign-in

```text
Download and read:
- the "Voxal Connect" section of
  https://raw.githubusercontent.com/ErwannRobin/Voxal/main/docs/deployment.md
- https://raw.githubusercontent.com/ErwannRobin/Voxal/main/docs/iframe-embed.md
  (the auth command)

Task: sign our users into Voxal from <my app> without a second login prompt.
- Describe the web redirect flow and the native deep-link flow separately.
- The state parameter must be validated, and the token must never linger in the
  URL, history or referrer.
- Say clearly what has to be allowlisted on the server side for a new origin.
Deliver the client integration and a list of server-side prerequisites.
```

---

## Writing your own prompt

The pattern that works:

1. **Fetch first.** Name the exact raw URL and say "read it before writing code".
   An agent that guesses Voxal's API invents `postMessage` types that do not exist.
2. **One use case per prompt.** Deploying and embedding are different jobs.
3. **State the invariants.** Voice is never server-routed; PeerJS is vendored,
   never CDN-loaded; platform-specific code is always guarded. An agent that is
   not told will happily break all three.
4. **Ask for the plan first** on anything touching the codebase.
5. **Placeholders in `<angle brackets>`** so it is obvious what you must replace.

Found a prompt that works better? Pull requests to this page are welcome —
see [CONTRIBUTING.md](../CONTRIBUTING.md).
