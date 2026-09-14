# LLM integration prompts

Copy-paste prompts for coding agents (Claude Code, Cursor, Copilot, Codex,
ChatGPT…) that embed, deploy or connect to Voxal.

Every prompt is deliberately **short**. None of them tries to describe Voxal —
each one tells the agent *which document to download and read first*, then
states the goal and the constraints. That keeps the prompt small, keeps the
agent accurate, and means a prompt never goes stale when a doc changes.

---

## Contents

**A — [Embedding Voxal in your product](#a--embedding-voxal-in-your-product)**

1. [Drop a voice room into a page](#a1-drop-a-voice-room-into-a-page)
2. [Control the room from my page (postMessage bridge)](#a2-control-the-room-from-my-page-postmessage-bridge)
3. [Wrap the embed as a framework component](#a3-wrap-the-embed-as-a-framework-component)
4. [Lock the embed down for production](#a4-lock-the-embed-down-for-production)
5. [Give the embed our own TURN relay](#a5-give-the-embed-our-own-turn-relay)
6. [Make a "video call" link instead of push-to-talk](#a6-make-a-video-call-link-instead-of-push-to-talk)

**B — [Running Voxal yourself](#b--running-voxal-yourself)**

1. [Deploy the web app](#b1-deploy-the-web-app)
2. [Stand up anonymous TURN credentials](#b2-stand-up-anonymous-turn-credentials)
3. [Self-host a coturn relay](#b3-self-host-a-coturn-relay)
4. [Enable the optional SFU for video](#b4-enable-the-optional-sfu-for-video)
5. [Self-host signaling and assets](#b5-self-host-signaling-and-assets)

**C — [Accounts and presence](#c--accounts-and-presence)**

1. [Integrate Voxal Connect sign-in](#c1-integrate-voxal-connect-sign-in)

Also on this page: [how to use it](#how-to-use-this-page) ·
[document map](#document-map) · [writing your own prompt](#writing-your-own-prompt).

Working *on* Voxal rather than with it — features, native builds, tests — starts
somewhere else: [`CLAUDE.md`](../CLAUDE.md) and [`CONTRIBUTING.md`](../CONTRIBUTING.md).

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

The whole set is listed, not only what the prompts below fetch — use it when
writing your own.

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

## C — Accounts and presence

### C1. Integrate Voxal Connect sign-in

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
4. **Ask for the plan first** on anything non-trivial, before code is written.
5. **Placeholders in `<angle brackets>`** so it is obvious what you must replace.

Found a prompt that works better? Pull requests to this page are welcome —
see [CONTRIBUTING.md](../CONTRIBUTING.md).
