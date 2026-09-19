# Benchmarking Voxal

Two separate jobs live in this document, and confusing them is the usual way a
benchmark ends up lying:

1. **Measuring Voxal against itself** — does this change cost more than the last
   one? That is `make bench`, and it is automated.
2. **Measuring Voxal against Discord, Zoom, Teams or Jitsi** — that cannot be
   automated, because we cannot instrument their code. It is done from outside
   the process, by hand, and §4 is the recipe.

The published figures from the first live in
**[docs/benchmarks.md](benchmarks.md)** — that is the page to read if you only
want the numbers, and §3 is how it is kept current.

## 1. The harness

```sh
make bench           # sweep, then write the dashboard + CSV and print the markdown
make bench-report    # re-render the newest run without re-measuring
```

Each run produces three things beside each other in `bench-results/`:

| File | For |
|---|---|
| `<run>.html` | **The one to open.** A self-contained dashboard — charts, a headline figure, and every chart's table twin. No network needed; it opens from `file://`. |
| `<run>.md` (stdout) | Markdown tables, for pasting into a pull request or an issue. |
| `<run>.csv` | One row per peer per run, for plotting somewhere else. |
| `<run>.ndjson` | The raw measurements. |

The HTML is the shareable artefact: it carries the machine, the network label and
the caveats in the page itself, so a screenshot of it cannot be quoted without
them. That matters more than it sounds — most misleading benchmark numbers are
true numbers that lost their conditions on the way to the reader.

Everything is tunable from the environment:

| Variable | Default | Meaning |
|---|---|---|
| `BENCH_SIZES` | `2,3,4,6` | Room sizes for the voice sweep |
| `BENCH_VIDEO_SIZES` | `2,3,4` | Room sizes for the camera sweep. Smaller on purpose: every peer encodes N−1 copies of 720p inside one browser |
| `BENCH_HOLD_MS` | `30000` | Steady-state window per run |
| `BENCH_REPS` | `3` | Repeats for the two join-latency scenarios |
| `BENCH_LABEL` | `unshaped-loopback` | Recorded with the run — use it to name the network conditions |
| `BENCH_OUT_DIR` | `bench-results` | Where the NDJSON and CSV land |

To run one half only, name the spec instead of using the target:

```sh
npx playwright test --project=bench tests/bench/video-bench.spec.js
```

Results are NDJSON, one line per scenario run, plus a per-peer CSV for plotting.
Both are gitignored: a number without the machine it was measured on is worse
than no number, so the raw file is never committed. What gets published is the
*report*, which carries the machine, the network label and the caveats with it —
into the public page with `make bench-publish` (§3), or pasted into a pull
request for a one-off comparison.

### What it measures

Voice (`tests/bench/mesh-bench.spec.js`):

| Scenario | Question |
|---|---|
| `mesh-scale` | What does a peer upload as the room grows? This is the one that decides how large a Voxal room can get. |
| `noise-suppression` | What does `rnnoise` — the desktop default — cost against `browser` and `off`? |
| `join-latency` | Join a call already in progress: how long until you hear it? |
| `host-migration` | The host vanishes. How long is the room leaderless, and how long is the audio gone? |

Camera and screen (`tests/bench/video-bench.spec.js`), deliberately the same
four questions one layer up:

| Scenario | Question |
|---|---|
| `video-scale` | What does a camera cost as the room grows — and what picture survives it? Also the one-presenter case, which is the shape most meetings have. |
| `video-background` | What does blur cost, against the same room with no background at all? |
| `screen-share` | A screen is not a camera: 1.5 Mb/s rather than 600 kb/s, `maintain-resolution`, and no peer-count downscale. |
| `video-join-latency` | Join a room that is already on camera: how long until you *see* it, as against hear it? |

Nothing asserts a performance threshold. The assertions in the spec are liveness
only — they prove the run measured a *working* call, so a zero in the report
means "this cost nothing", never "this never connected". A threshold would fail
on a busy CI runner for reasons that have nothing to do with the code, and a
benchmark that cries wolf gets muted.

### What the numbers are not

Every peer of a room runs **in one Chromium on one machine over loopback**. So:

- **Latency is a floor.** RTT on loopback is ~1 ms. It tells you the code adds
  nothing silly; it tells you nothing about a real network. Shape the link (§2)
  before quoting a latency number to anybody.
- **CPU and RSS are whole-room totals.** One browser serves every peer, so the
  figure is the cost of running an N-peer room on one machine. It is **not**
  per-peer and must never be divided by N. What it is good for is the *shape* of
  the curve as N grows, and comparing two configurations at the same N.
- **The `peer` broker is excluded** from the CPU figure on purpose. It stands in
  for a remote signaling server, so its cost is not the client's.
- **CPU has real run-to-run variance; bandwidth does not.** The bandwidth
  columns repeat to within a few percent. CPU does not — browser warm-up
  ordering alone has produced a 25-point swing between two runs of the same
  room. Compare CPU only between configurations measured back to back, and only
  across repeats. If a CPU difference matters to a decision, run it three times.
- **Bandwidth is transport level**, not payload: it includes RTP, RTCP, STUN and
  DTLS, because that is what "network usage" means to someone watching a data
  plan. Expect it to sit meaningfully above the 32 kb/s `OPUS_MAX_BITRATE`.

Video adds four of its own, and the report prints the evidence for each rather
than asking you to remember them:

- **The picture is part of the measurement.** A camera figure means nothing
  without the resolution and frame rate it was encoded at, so every video table
  carries a *Picture sent* column taken from the encoder's own `getStats()`.
  A room that fell to 320×180 at 6 fps did not "use less bandwidth"; it gave up.
- **`limited by cpu` is the harness, not the app.** One machine encodes every
  peer's camera N−1 times over. When that column says `cpu`, shrink
  `BENCH_VIDEO_SIZES` before quoting the row.
- **`limited by bandwidth` is the app's own ceiling.** There is nothing to
  congest on loopback: it means the encoder could not fit the picture into
  `CAMERA_MAX_BITRATE` (600 kb/s per listener) and spent the budget on motion
  instead of pixels. That is the intended trade, not a network event.
- **A background effect can switch itself off mid-run.** `VideoEffects` steps
  segmentation down and then gives up on a device that cannot keep up, and the
  app quietly falls back to the plain camera. The *Still running* column counts
  the peers that still had it on at the end — a `0` there means the row is not
  the cost of the effect, whatever its CPU figure says.

### Why the microphone is a file

Chromium's built-in fake mic emits a 440 Hz sine, which Opus encodes at a small
fraction of its ceiling. Measured against it, every bandwidth number would
flatter the app. `make bench-audio` generates a seeded, speech-shaped WAV
instead — noise through three formant resonators, driven by a 4 Hz syllabic
envelope with real pauses — so the encoder sits in its normal operating range
and two runs on two machines remain comparable.

For the same reason the harness pins `noise-suppression: off` by default:
`rnnoise` would gate a synthetic source as non-speech and leave the benchmark
timing silence. Its cost is measured, but in its own scenario, with everything
else held still.

### Why the camera is a file too

Exactly the same argument, one layer up. Chromium's built-in fake camera is a
rolling gradient with a bouncing ball: flat colour, no texture, and a motion
field the encoder predicts almost perfectly. Against it a camera looks like it
costs a fraction of `CAMERA_MAX_BITRATE`, and every video row would flatter the
app.

`make bench-video` generates a seeded Y4M scene instead
(`scripts/gen-bench-video.mjs`): a head-and-shoulders subject that drifts the way
somebody in front of a laptop drifts, over a textured room that stays put, plus
fresh sensor grain every frame — a moving subject, a background the encoder can
learn, and noise it cannot. The subject shape matters twice, because the
background-effects scenario needs MediaPipe's selfie segmenter to have a person
to find.

Raw frames are the only format Chromium's file-backed fake capture reads, so the
file is ~80 MB at 720p for a two-second loop. It is gitignored and regenerated
on demand, like the WAV.

Screen share needs one more thing the browser will not give automation on its
own: `--auto-select-desktop-capture-source`, set for the `bench` project in
`playwright.config.js`. Without it `getDisplayMedia()` waits forever on a picker
nobody is there to click. What gets captured is the headless browser's own
virtual screen, which is a fair *encode* — a real desktop with text and a moving
window is not identical, and a screen-share number is the one most worth
re-measuring on a real machine.

## 2. Shaping the network

The harness does **not** shape the link. Shaping needs root and is
platform-specific, so it stays a deliberate step outside the run — and
`BENCH_LABEL` exists to record that you took it.

**Linux**

```sh
sudo tc qdisc add dev lo root netem delay 40ms 10ms loss 2%
BENCH_LABEL="netem-40ms-2pct" make bench
sudo tc qdisc del dev lo root netem
```

**macOS** — use Network Link Conditioner (Xcode's Additional Tools), or `dnctl`
with `pfctl` directly. Note that macOS does not shape loopback the way `tc`
does; if the numbers do not move when you enable a profile, it is not shaping
`lo0`, and you need two machines for that measurement.

> Untested here: `netem` on loopback with the in-process PeerServer has not been
> verified end to end in CI. It may need a `veth` pair rather than `lo`. Treat
> the recipe above as a starting point, and check that the RTT in the report
> actually moved before trusting a shaped run.

## 3. Publishing the results

The public page is **[docs/benchmarks.md](benchmarks.md)**, with the dashboard
beside it at `docs/benchmark.html` (GitHub Pages serves both). Refresh them from
a real run:

```sh
make bench            # measure
make bench-publish    # write the tables into the page and the dashboard beside it
```

`make bench-publish` replaces everything between the page's
`<!-- bench-results -->` markers and rewrites `docs/benchmark.html`; commit both.
`RUN=bench-results/<id>.ndjson make bench-publish` publishes a particular run
instead of the newest.

It is deliberately manual, exactly like `make coverage-badge`, for two reasons
that will not change:

- `main` takes no direct push, and a workflow's own `GITHUB_TOKEN` can neither
  open a pull request for the change nor produce one that is mergeable — see
  `KNOWLEDGE/learning.md`.
- More importantly, a benchmark measured on a shared CI runner would publish the
  runner's noise as the product's performance. CI runners are contended,
  virtualised and GPU-less, which is exactly the machine these numbers must not
  come from.

So the page is only ever as fresh as the last person who ran it, and it says so
in its own words: the block carries the run's date, machine and network label.
Refresh it before a release, or whenever a change moves the media path.

## 4. Comparing against other products

You cannot instrument Discord or Zoom, so measure all of them the same way —
from outside the process. **Hold everything else still**: same machine, same
network, same room size, same speaker behaviour, same wall-clock duration.

### Bandwidth

```sh
nettop -P -p <pid>            # macOS, per process
nethogs  /  iftop -P          # Linux
```

**Sum all of Voxal's processes.** On macOS a Tauri app is four of them — the app
itself, `tauri://localhost` (WebContent), *Voxal Graphics and Media* (GPU) and
*Voxal Networking* — because WKWebView is multi-process. Reading only the one
called "Voxal" undercounts it against a single-process rival. The same applies
to Chrome and Electron apps on the other side of the comparison.

### CPU and memory

`ps -o %cpu,rss -p <pids>` is an average since process *start*, which is useless
for a windowed measurement. Sample cumulative CPU time twice and difference it
over the wall window instead — that is exactly what `sampleProcessTree()` in
`tests/bench/bench-metrics.js` does, and the same trick works on any process:

```sh
ps -o time= -p <pid>   # ...wait N seconds...
ps -o time= -p <pid>   # (t2 - t1) / N * 100 = % of one core
```

### Mouth-to-ear latency

The number users actually feel, and the one `getStats()` cannot give you: RTT
omits capture, encode, the jitter buffer and playout. Voxal deliberately adds
`AUDIO_PLAYOUT_DELAY_BASE` (80 ms) on every link and 200 ms on a poor or relayed
one — that is a real, chosen cost and it must appear in the number.

Measure it acoustically, which works on any product:

1. Two machines, or one machine and a loopback audio device.
2. Play a short click into A's microphone input and record B's speaker output,
   both into one file, on one clock.
3. Cross-correlate the two channels; the lag is mouth-to-ear.

Repeat 20 times and report the median and the p95 — a single sample is noise.

### Audio quality under loss

Shape the link to a known loss rate, record what arrives at B, and score it
against the source with an objective metric (**ViSQOL** or **PESQ**). This is
the only fair way to compare codecs and concealment across products: a bitrate
number alone says nothing about what it sounds like when 5% of it is missing.

### A fair baseline

**Jitsi** is the right open comparison, because it is self-hostable and runs
either mode: P2P for two participants, SFU above that. It brackets both of
Voxal's topologies with one product, on your own hardware, with no account and
no rate limit in the way.

### Fixing the variables

- Same room size, and state it. "Voxal is lighter" means nothing without an N.
- Video on and video off are separate measurements, never averaged together.
- 5 minutes per run, 3 runs, report the median.
- Same speaker pattern: one talker is a meeting, everybody talking is a worst
  case, and they are different benchmarks.
- Record the machine, the OS version and the network conditions next to every
  number.

## 5. Reading the mesh honestly

Audio is full mesh, always — see `docs/video-routing.md`. A speaker uploads one
Opus stream **per other peer**, so upload grows as `O(N-1)` while an SFU-based
product's stays flat. At 8 peers that is roughly 8× the upload of Discord or
Zoom for the same call. The harness measures exactly that: 48 → 97 → 145 kb/s
across 2, 3 and 4 peers — ×3 for ×3 the links, with no inflection to hope for.

And the cost is not only the speaker's. Because `OPUS_FMTP_PARAMS` forces
`usedtx=0` — keeping the receiver's jitter buffer warm so the first word after
a PTT press is not clipped — a *listener* in that 4-peer room still uploads
135 kb/s against the speaker's 145. Everyone in a Voxal room pays the mesh, not
just whoever is talking. Quote both columns; a comparison that cites only the
speaker's upload understates the design by a factor of N.

That is a real cost and the report prints it plainly. The trade it buys is also
real: no server hop in the audio path, and audio that never touches a server at
all. So the honest framing of a Voxal benchmark is not "we use less bandwidth" —
we do not. It is:

- **Wins**: latency, privacy, join time, small-room CPU, and surviving the loss
  of the host at all.
- **Loses**: upload at high N, and any uplink-constrained network.

Pick the room size the product is actually for, and publish that one.

Camera and screen are the same shape and a great deal more expensive: under
`p2p-only` a sharer uploads one encode per other peer at up to 600 kb/s each,
against an Opus stream's 32. That is precisely why `selectVideoTopology()` lets
*camera and screen* take an SFU above two participants while audio never does —
and the video half of the harness measures the **mesh** side of that choice, so
the tables show what the SFU is there to avoid.

The relayed side is still not measured: there is no Cloudflare Realtime in the
harness, so the honest comparison "mesh vs. SFU, same room, same machine" cannot
be made from this data yet. See `KNOWLEDGE/todos.md`.
