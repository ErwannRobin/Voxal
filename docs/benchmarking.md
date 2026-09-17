# Benchmarking Voxal

Two separate jobs live in this document, and confusing them is the usual way a
benchmark ends up lying:

1. **Measuring Voxal against itself** — does this change cost more than the last
   one? That is `make bench`, and it is automated.
2. **Measuring Voxal against Discord, Zoom, Teams or Jitsi** — that cannot be
   automated, because we cannot instrument their code. It is done from outside
   the process, by hand, and §3 is the recipe.

## 1. The harness

```sh
make bench           # sweep, then print the report and write a CSV
make bench-report    # re-print the newest run without re-measuring
```

Everything is tunable from the environment:

| Variable | Default | Meaning |
|---|---|---|
| `BENCH_SIZES` | `2,3,4,6` | Room sizes to sweep |
| `BENCH_HOLD_MS` | `30000` | Steady-state window per run |
| `BENCH_REPS` | `3` | Repeats for the join-latency scenario |
| `BENCH_LABEL` | `unshaped-loopback` | Recorded with the run — use it to name the network conditions |
| `BENCH_OUT_DIR` | `bench-results` | Where the NDJSON and CSV land |

Results are NDJSON, one line per scenario run, plus a per-peer CSV for plotting.
Both are gitignored: a number without the machine it was measured on is worse
than no number, so a run is published by pasting the report (which carries the
machine) into a pull request, never by committing the raw file.

### What it measures

| Scenario | Question |
|---|---|
| `mesh-scale` | What does a peer upload as the room grows? This is the one that decides how large a Voxal room can get. |
| `noise-suppression` | What does `rnnoise` — the desktop default — cost against `browser` and `off`? |
| `join-latency` | Join a call already in progress: how long until you hear it? |
| `host-migration` | The host vanishes. How long is the room leaderless, and how long is the audio gone? |

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

## 3. Comparing against other products

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

## 4. Reading the mesh honestly

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

Note that `selectVideoTopology()` already lets *camera and screen* take an SFU
while audio stays peer-to-peer. That asymmetry is worth measuring on its own,
and the harness does not cover it yet — see `KNOWLEDGE/todos.md`.
