// Report a benchmark run: a markdown table on stdout, a self-contained HTML
// dashboard, and a per-peer CSV for plotting elsewhere.
//
// Deliberately the same shape as scripts/coverage-report.mjs: every section is
// optional, a scenario that was not run is reported as absent rather than
// failing, so a partial run still produces a readable report.
//
// All three renderings read ONE model (scripts/bench-data.mjs) so they cannot
// disagree about a number.
//
// Usage:
//   node scripts/bench-report.mjs                    # newest run in bench-results/
//   node scripts/bench-report.mjs <file.ndjson>      # a specific run
//   node scripts/bench-report.mjs --html out.html    # also write the dashboard
//   node scripts/bench-report.mjs --csv out.csv      # also write the per-peer CSV
//   node scripts/bench-report.mjs --publish          # also update the public docs page
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import {
  RESULTS_DIR, newestRunFile, loadRuns, buildModel,
  median, bits, mib, bytes, count, pct, ms, num, res, fps,
} from './bench-data.mjs';
import { renderHtml } from './bench-html.mjs';
import { HISTORY_FILE, loadHistory, appendRun, trend, delta } from './bench-history.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? null;
};
const csvPath = flag('--csv');
const htmlPath = flag('--html');
const file = args.find((a) => a.endsWith('.ndjson')) || newestRunFile();

if (!file || !existsSync(file)) {
  console.log(`No benchmark results found in ${RESULTS_DIR}/. Run \`make bench\` first.`);
  process.exit(0);
}

const runs = loadRuns(file);
if (!runs.length) {
  console.log(`${file} has no readable runs.`);
  process.exit(0);
}
const m = buildModel(runs, file);

// ── Version history ──────────────────────────────────────────────────────────
//
// Appended BEFORE the report is rendered, so that a publish's own numbers are
// the newest row of the trend table it prints rather than being absent from it.
// The markers in docs/benchmarks.md are validated first: a publish that is
// going to fail must not leave a row behind in the history file.
const PUBLISH_MD = 'docs/benchmarks.md';
const PUBLISH_HTML = 'docs/benchmark.html';
const BLOCK_START = '<!-- bench-results -->';
const BLOCK_END = '<!-- /bench-results -->';
const publishing = args.includes('--publish');

let publishPage = null;
if (publishing) {
  if (!existsSync(PUBLISH_MD)) {
    console.error(`bench-report: ${PUBLISH_MD} does not exist — nothing published.`);
    process.exit(1);
  }
  publishPage = readFileSync(PUBLISH_MD, 'utf8');
  if (
    publishPage.indexOf(BLOCK_START) === -1 ||
    publishPage.indexOf(BLOCK_END) === -1 ||
    publishPage.indexOf(BLOCK_END) < publishPage.indexOf(BLOCK_START)
  ) {
    console.error(
      `bench-report: no ${BLOCK_START} … ${BLOCK_END} markers in ${PUBLISH_MD}, nothing written.`
    );
    process.exit(1);
  }
  const { total } = appendRun(m, basename(file, '.ndjson'));
  console.error(`bench-report: recorded this run in ${HISTORY_FILE} (${total} runs kept).`);
}

// The trend is read whether or not this invocation publishes: a plain
// `make bench-report` should still be able to say "slower than last release".
const history = trend(loadHistory());
const historyDelta = delta(history.rows);

// ── markdown ─────────────────────────────────────────────────────────────────

function table(headers, rows) {
  if (!rows.length) return '';
  return [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

const out = [];
const env = m.env;
out.push('# Voxal performance benchmark');
out.push('');
out.push(`Run \`${file}\` — ${m.runCount} scenario runs, ${m.at}`);
out.push('');
out.push(
  `**Machine**: ${env.platform}/${env.arch}, ${env.cpus} cores` +
    (env.cpuModel ? ` (${env.cpuModel})` : '') +
    `, ${mib(env.totalMemBytes)} RAM, node ${env.node}`
);
out.push(`**Network**: \`${env.label}\``);
if (m.build.version || m.build.commit) {
  out.push(
    `**Build**: ${m.build.version ? `v${m.build.version}` : 'unknown version'}` +
      (m.build.commit ? ` @ \`${m.build.commit}\`` : '') +
      (m.build.branch && m.build.branch !== 'HEAD' ? ` (${m.build.branch})` : '') +
      // A dirty tree is stated, not hidden: these numbers cannot be reproduced
      // from the commit beside them.
      (m.build.dirty ? ' — **uncommitted changes in the tree**' : '')
  );
}
out.push('');
out.push(
  '> Every peer of a room runs in one Chromium on one machine over loopback. ' +
    'Latency is therefore a **floor**, not a field measurement, and the CPU/RSS ' +
    'columns are the cost of the **whole room** on that one machine — they are ' +
    'not per-peer and must not be divided by the peer count. ' +
    'See `docs/benchmarking.md`.'
);
out.push('');

// ── app-level ────────────────────────────────────────────────────────────────

if (m.startup) {
  const c = m.startup.cold;
  const w = m.startup.warm;
  out.push('## Startup');
  out.push('');
  out.push(
    'Two loads, because they are two different people. **Cold** is a first visit with an ' +
      'empty cache — it pays for every byte of the shell. **Warm** is the same person ' +
      'tomorrow: the bytes are cached, so what is left is parse, execute and boot, which is ' +
      'the half that gets worse without the download getting bigger.'
  );
  out.push('');
  out.push(
    '_Interactive_ is `domContentLoadedEventEnd`, and for this app that genuinely is the ' +
      'moment it works: `main.js` is a classic script at the end of `<body>`, so parsing ' +
      'blocks on it and the bootstrap runs in a `DOMContentLoaded` listener that has to ' +
      'return before the mark is taken.'
  );
  out.push('');
  out.push(
    table(
      ['Load', 'First paint', 'Interactive p50', 'Interactive p95', 'Everything loaded', 'Transferred'],
      [
        [
          `Cold (×${m.startup.reps})`,
          ms(c.fcpMs?.p50),
          ms(c.interactiveMs?.p50),
          ms(c.interactiveMs?.p95),
          ms(c.loadMs?.p50),
          bytes(m.startup.shell?.resources?.transferBytes),
        ],
        [
          `Warm (×${m.startup.reps})`,
          ms(w.fcpMs?.p50),
          ms(w.interactiveMs?.p50),
          ms(w.interactiveMs?.p95),
          ms(w.loadMs?.p50),
          bytes(w.transferBytes),
        ],
      ]
    )
  );
  out.push('');
  if (m.startup.shell?.resources) {
    const sh = m.startup.shell;
    out.push(
      `The shell is **${bytes(sh.resources.decodedBytes)}** over **${sh.resources.count}** requests, ` +
        `of which **${bytes(sh.scripts.decodedBytes)}** is script. ` +
        'The segmentation runtime (~12 MB of MediaPipe WASM) is **not** in that figure — it is ' +
        'fetched lazily, the first time somebody turns a camera background on.'
    );
    out.push('');
    if (sh.byFile?.length) {
      out.push(
        table(
          ['Heaviest files', 'Decoded', 'Transferred'],
          sh.byFile.slice(0, 6).map((f) => [`\`${f.name}\``, bytes(f.decodedBytes), bytes(f.transferBytes)])
        )
      );
      out.push('');
    }
  }
  out.push(
    '> **Loopback, uncompressed, no TLS.** The harness serves `src/` straight off disk, so ' +
      'the transfer half of these numbers is a floor and the *Transferred* column is closer ' +
      'to the raw size than to what a browser pulls from `web.voxal.app`. What the table is ' +
      'honestly good for is the boot cost, the asset budget, and the delta between two ' +
      'versions measured the same way.'
  );
  out.push('');
  out.push(
    '> **The warm row\'s *Transferred* belongs to the server, not to the app.** What a reload ' +
      'can take from the cache is decided by the cache headers the static server sends, and ' +
      'those are the harness\'s, not production\'s. The warm row\'s *timings* are still the ' +
      'app\'s own — parse, compile and boot with the bytes already in hand.'
  );
  out.push('');
}

if (m.connect) {
  out.push('## Cold path to a live call');
  out.push('');
  out.push(
    'The *Join latency* section further down starts its clock at the join, because somebody ' +
      'already in a call has the app open. This one starts it at the open, because somebody ' +
      'who was sent a link does not: load the shell, reach the broker, negotiate, hear the ' +
      'room. It is the number a link recipient actually experiences, and the only one that ' +
      'regresses when the shell gets heavier.'
  );
  out.push('');
  out.push(
    table(
      ['Journey', 'Reps', 'App usable', 'Then…', 'Total'],
      [
        [
          'Open → hosting a room',
          m.connect.reps,
          ms(m.connect.create.loadMs),
          `${ms(m.connect.create.actionMs)} to a room code`,
          `**${ms(m.connect.create.totalMs)}**`,
        ],
        [
          `Open → hearing a live ${m.connect.roomSize}-peer room`,
          m.connect.reps,
          ms(m.connect.join.loadMs),
          `${ms(m.connect.join.signalingMs)} signaling, ${ms(m.connect.join.audibleMs)} to first audio`,
          `**${ms(m.connect.join.totalMs)}**`,
        ],
      ]
    )
  );
  out.push('');
}

if (m.memory) {
  const mem = m.memory;
  out.push('## Memory footprint');
  out.push('');
  out.push(
    'Every figure below is taken after a forced collection (`HeapProfiler.collectGarbage`) ' +
      'and read from the same CDP counters DevTools shows — `performance.memory` is quantized ' +
      'to 100 KB buckets, which is wide enough to hide a room\'s worth of growth.'
  );
  out.push('');
  out.push(
    table(
      ['State', 'JS heap', 'DOM nodes', 'Listeners'],
      [
        ['Idle, home screen', bytes(mem.idle.heapBytes), count(mem.idle.domNodes), count(mem.idle.listeners)],
        [
          `In a ${mem.size}-peer call`,
          bytes(mem.room.heapBytes),
          count(mem.room.domNodes),
          count(mem.room.listeners),
        ],
      ]
    )
  );
  out.push('');
  out.push(
    `### Join / leave churn (${mem.churnCycles} cycles)`
  );
  out.push('');
  out.push(
    'One peer joining and leaving the same live room over and over — the shape of a long ' +
      'day of calls. Growth is measured from the **first** cycle, never from a page that has ' +
      'never joined: the first join allocates structures that are then reused, and counting ' +
      'that one-time cost as growth would report a leak in a page that has none.'
  );
  out.push('');
  out.push(
    table(
      ['Measure', 'After cycle 1', `After cycle ${mem.churnCycles}`, 'Growth', 'Per rejoin'],
      [
        [
          'JS heap',
          bytes(mem.churn.baseline?.heapBytes),
          bytes(mem.churn.cycles[mem.churn.cycles.length - 1]?.heapBytes),
          bytes(mem.churn.heapGrowthBytes),
          bytes(mem.churn.perCycleHeapBytes),
        ],
        [
          'DOM nodes',
          count(mem.churn.baseline?.domNodes),
          count(mem.churn.cycles[mem.churn.cycles.length - 1]?.domNodes),
          count(mem.churn.nodeGrowth),
          '—',
        ],
        [
          'Listeners',
          count(mem.churn.baseline?.listeners),
          count(mem.churn.cycles[mem.churn.cycles.length - 1]?.listeners),
          count(mem.churn.listenerGrowth),
          '—',
        ],
      ]
    )
  );
  out.push('');
  out.push(
    '_A fixed step between cycle 1 and cycle N is a one-off; a **per-rejoin** figure that ' +
      'holds steady is a leak._ Neither is asserted here — this table is evidence to read, ' +
      'not a gate, and a heap figure moves for reasons a benchmark cannot see.'
  );
  out.push('');
}

if (m.scale.length) {
  out.push('## Mesh scaling');
  out.push('');
  out.push(
    'Audio is full mesh, always. A speaker uploads one Opus stream **per other peer**, ' +
      'so the upload column is the number that decides how large a room can get on a ' +
      'domestic uplink. An SFU-based product holds this column flat.'
  );
  out.push('');
  out.push(
    table(
      ['Peers', 'Speakers', 'Speaker ↑', 'Listener ↑', 'Listener ↓', 'RTT p50', 'Loss p50', 'Room CPU', 'Room RSS'],
      m.scale.map((r) => [
        r.size,
        r.speakers,
        bits(r.speakerUp),
        r.allSpeaking ? '—' : bits(r.listenerUp),
        r.allSpeaking ? '—' : bits(r.listenerDown),
        ms(r.rttMs),
        `${num(r.lossPercent)}%`,
        pct(r.cpuPercent),
        mib(r.rssBytes),
      ])
    )
  );
  out.push('');
  if (m.marginalUploadBps !== null) {
    out.push(
      `Every peer added costs a speaker another **${bits(m.marginalUploadBps)}** of upload ` +
        `(least-squares slope across ${m.curve.length} room sizes). A listener's upload is the ` +
        `other column to read: with Opus DTX on, a released talk button should cost next to nothing.`
    );
    out.push('');
  }
}

if (m.ns.length) {
  out.push('## Noise suppression cost');
  out.push('');
  out.push(
    '`rnnoise` is the desktop default, so its cost is one the product pays by default. ' +
      'Same room size and same speakers in every row — only the mode changes.'
  );
  out.push('');
  out.push(
    table(
      ['Mode', 'Peers', 'Speaker ↑', 'Room CPU', 'Room RSS', 'JS heap p50'],
      m.ns.map((r) => [
        `\`${r.mode}\`${r.isDefault ? ' (default)' : ''}`,
        r.size,
        bits(r.speakerUp),
        pct(r.cpuPercent),
        mib(r.rssBytes),
        mib(r.jsHeapBytes),
      ])
    )
  );
  out.push('');
}

if (m.join.length) {
  out.push('## Join latency');
  out.push('');
  out.push('Clock starts at the join, not at browser launch — a real user already has a browser open.');
  out.push('');
  out.push(
    table(
      ['Room size', 'Reps', 'Signaling open', 'First audio heard'],
      m.join.map((r) => [r.size, r.reps, ms(r.signalingMs), ms(r.audibleMs)])
    )
  );
  out.push('');
}

if (m.migration.length) {
  out.push('## Host migration');
  out.push('');
  out.push(
    'The outage a mesh design owns, and one no SFU product has to survive. ' +
      'Host loss is detected by heartbeat timeout (~7 s), so that floor is in both columns.'
  );
  out.push('');
  out.push(
    table(
      ['Room size', 'Survivors', 'New host elected', 'Audio restored'],
      m.migration.map((r) => [r.size, r.survivors, ms(r.hostElectedMs), ms(r.audioRestoredMs)])
    )
  );
  out.push('');
}

// ── video ────────────────────────────────────────────────────────────────────

/** The picture the encoder settled on, and why it settled there. */
function pictureCell(p) {
  if (!p) return '—';
  const shot = `${res(p)} @ ${fps(p.fps)}`;
  return p.limitation && p.limitation !== 'none' ? `${shot} (limited by ${p.limitation})` : shot;
}

if (m.video.length) {
  out.push('## Video mesh scaling');
  out.push('');
  out.push(
    'Camera is a **full mesh** under the `p2p-only` preference this harness pins, so a ' +
      'sharer encodes and uploads one stream per other peer — the same `O(N-1)` shape as ' +
      'audio, at roughly twenty times the bitrate. Above two participants the shipped ' +
      'default (`allow-sfu`) may route this through Cloudflare Realtime instead, which is ' +
      'the topology **not** measured here. See `docs/video-routing.md`.'
  );
  out.push('');
  out.push(
    table(
      ['Peers', 'Cameras', 'Sharer ↑', 'Receiver ↓', 'Picture sent', 'Room CPU', 'Room RSS'],
      m.video.map((r) => [
        r.size,
        r.allCameras ? `all (${r.cameras})` : r.cameras,
        bits(r.sharerUp),
        bits(r.receiverDown),
        pictureCell(r.picture),
        pct(r.cpuPercent),
        mib(r.rssBytes),
      ])
    )
  );
  out.push('');
  if (m.marginalVideoUploadBps !== null) {
    out.push(
      `Every peer added costs a camera sharer another **${bits(m.marginalVideoUploadBps)}** of ` +
        `upload (least-squares slope across ${m.videoCurve.length} room sizes). ` +
        '`videoScaleForPeerCount()` blunts the curve by halving the sent resolution above ' +
        'two peers and quartering it above four — the *Picture sent* column is where that shows.'
    );
    out.push('');
  }
  if (m.video.some((r) => r.picture && r.picture.limitation === 'bandwidth')) {
    out.push(
      '_"Limited by bandwidth" here is the **app\'s own ceiling**, not a congested link:_ ' +
        'there is nothing to congest on loopback. `CAMERA_MAX_BITRATE` is 600 kb/s per ' +
        'listener, and an encoder that cannot fit the picture into its budget spends the ' +
        'budget on motion rather than on pixels. That is the intended trade.'
    );
    out.push('');
  }
  if (m.videoSaturatedMachine) {
    out.push(
      `> **This machine ran out of room.** A video run reached ${pct(
        Math.max(...m.video.map((r) => r.cpuPercent ?? 0))
      )} of one core on a ${env.cpus}-core host — every peer of the room encoding at once. ` +
        'When that happens the frame rate falls first, and the encoder still reports its own ' +
        'bitrate cap as the reason, so read the frame rates above as the ceiling of the ' +
        'harness rather than of the app, and shrink `BENCH_VIDEO_SIZES` before quoting them.'
    );
    out.push('');
  }
  if (m.video.some((r) => r.picture && r.picture.limitation === 'cpu')) {
    out.push(
      '> **The machine, not the app.** At least one run above was `cpu`-limited: the ' +
        'encoder dropped resolution or frame rate because this one machine was running ' +
        'every peer of the room at once. Read those rows as a ceiling of the harness, and ' +
        'shrink `BENCH_VIDEO_SIZES` before quoting them.'
    );
    out.push('');
  }
}

if (m.videoBackground.length) {
  out.push('## Camera background cost');
  out.push('');
  out.push(
    'Segmentation runs locally — MediaPipe in WebAssembly plus a WebGL composite — so the ' +
      'cost lands on **CPU and frame rate**, never on the wire. Same room size and the same ' +
      'cameras in every row; only the background changes.'
  );
  out.push('');
  out.push(
    table(
      ['Background', 'Peers', 'Cameras', 'Still running', 'Sharer ↑', 'Picture sent', 'Room CPU', 'Room RSS'],
      m.videoBackground.map((r) => [
        `\`${r.mode}\`${r.isDefault ? ' (default)' : ''}`,
        r.size,
        r.cameras,
        r.effects ? `${r.effects.engaged}/${r.effects.sharers}` : '—',
        bits(r.sharerUp),
        pictureCell(r.picture),
        pct(r.cpuPercent),
        mib(r.rssBytes),
      ])
    )
  );
  out.push('');
  out.push(
    '_Still running_ is how many of the sharing peers had the effect on at the end of the ' +
      'run. It is recorded rather than assumed because the app drops the effect in two ' +
      'situations, both silent on the wire: `maybeApplyVideoEffects()` falls back to the raw ' +
      'camera when the segmentation runtime cannot start, and `VideoEffects.onOverload` turns ' +
      'the background off on a device that cannot sustain it.'
  );
  out.push('');
  if (m.videoBackground.some((r) => r.effects && r.effects.dropped)) {
    out.push(
      '> **The effect gave up on this machine.** At least one run above ended with the ' +
        'background off after the app decided the device could not keep up — which is real ' +
        'behaviour worth knowing about, but it means that row is **not** the cost of the ' +
        'effect. Measure the background on a machine that is not also running every other ' +
        'peer of the room.'
    );
    out.push('');
  }
}

if (m.screen.length) {
  out.push('## Screen share');
  out.push('');
  out.push(
    'A screen is not a camera: `SCREEN_MAX_BITRATE` is 1.5 Mb/s against the camera’s ' +
      '600 kb/s, the sender is pinned to `maintain-resolution` (drop frames, never letters), ' +
      'and the peer-count downscale never applies to it.'
  );
  out.push('');
  out.push(
    table(
      ['Peers', 'Sharer ↑', 'Watcher ↓', 'Picture sent', 'Room CPU', 'Room RSS'],
      m.screen.map((r) => [
        r.size,
        bits(r.sharerUp),
        bits(r.watcherDown),
        pictureCell(r.picture),
        pct(r.cpuPercent),
        mib(r.rssBytes),
      ])
    )
  );
  out.push('');
}

if (m.videoJoin.length) {
  out.push('## Video join latency');
  out.push('');
  out.push(
    'Walking into a meeting that is already on camera. Hearing the room and *seeing* it are ' +
      'two different numbers: a picture needs its own call per sharer, a keyframe and a decoder.'
  );
  out.push('');
  out.push(
    table(
      ['Room size', 'Reps', 'Signaling open', 'First audio heard', 'Every camera visible'],
      m.videoJoin.map((r) => [r.size, r.reps, ms(r.signalingMs), ms(r.audibleMs), ms(r.visibleMs)])
    )
  );
  out.push('');
}

// ── across versions ──────────────────────────────────────────────────────────
//
// The only section that is not about this run. Everything above says what the
// app costs; this says whether that is more than it used to.

if (history.rows.length) {
  out.push('## Across versions');
  out.push('');
  out.push(
    `The last ${Math.min(history.rows.length, 10)} published runs, newest last, from ` +
      `\`${HISTORY_FILE}\` — a thin summary of each \`make bench-publish\`, committed so the ` +
      'trend survives the raw measurements, which are not.'
  );
  out.push('');
  const shown = history.rows.slice(-10);
  out.push(
    table(
      ['Version', 'Commit', 'Date', 'Startup', 'Cold join', 'Shell', 'Idle heap', 'Room heap', 'Per-peer ↑'],
      shown.map((r) => [
        (r.version ? `v${r.version}` : '—') + (r.dirty ? ' ⚠︎' : ''),
        r.commit ? `\`${r.commit}\`` : '—',
        String(r.at).slice(0, 10),
        ms(r.metrics.startupInteractiveMs),
        ms(r.metrics.coldJoinMs),
        bytes(r.metrics.shellBytes),
        bytes(r.metrics.idleHeapBytes),
        bytes(r.metrics.roomHeapBytes),
        bits(r.metrics.marginalUploadBps),
      ])
    )
  );
  out.push('');
  if (shown.some((r) => r.dirty)) {
    out.push('_⚠︎ measured on a tree with uncommitted changes — not reproducible from the commit beside it._');
    out.push('');
  }

  if (historyDelta) {
    // Only the measures where both runs have a number, and only where the move
    // is bigger than the noise a benchmark of this kind produces run to run.
    const NOISE_PCT = 5;
    const NAMES = {
      startupInteractiveMs: ['Startup (interactive)', ms],
      startupFcpMs: ['First paint', ms],
      warmInteractiveMs: ['Warm startup', ms],
      shellBytes: ['Shell weight', bytes],
      scriptBytes: ['Script weight', bytes],
      coldCreateMs: ['Open → hosting', ms],
      coldJoinMs: ['Open → hearing a room', ms],
      joinAudibleMs: ['Join a live room', ms],
      migrationAudioMs: ['Host migration', ms],
      idleHeapBytes: ['Idle heap', bytes],
      roomHeapBytes: ['In-room heap', bytes],
      churnHeapPerCycleBytes: ['Heap per rejoin', bytes],
      marginalUploadBps: ['Upload per peer added', bits],
      marginalVideoUploadBps: ['Video upload per peer', bits],
    };
    const moved = Object.entries(NAMES)
      .map(([key, [label, fmt]]) => ({ key, label, fmt, d: historyDelta.metrics[key] }))
      .filter((r) => r.d && r.d.pct !== null && Math.abs(r.d.pct) >= NOISE_PCT);

    const fromLabel = historyDelta.from.version ? `v${historyDelta.from.version}` : historyDelta.from.commit || 'the previous run';
    const toLabel = historyDelta.to.version ? `v${historyDelta.to.version}` : historyDelta.to.commit || 'this run';
    out.push(`### ${fromLabel} → ${toLabel}`);
    out.push('');
    if (!moved.length) {
      out.push(`Nothing moved by more than ${NOISE_PCT}%. Every measure above is within the run-to-run noise of this harness.`);
      out.push('');
    } else {
      out.push(
        table(
          ['Measure', fromLabel, toLabel, 'Change'],
          moved.map((r) => [
            r.label,
            r.fmt(r.d.from),
            r.fmt(r.d.to),
            // Lower is better for every measure in this table, so the arrow can
            // be read the same way in every row without a per-metric direction.
            `${r.d.pct > 0 ? '▲' : '▼'} ${Math.abs(r.d.pct).toFixed(0)}%`,
          ])
        )
      );
      out.push('');
      out.push(
        `_Only moves of ${NOISE_PCT}% or more are listed, and ▲ is worse in every row — lower ` +
          'is better for all of them. A move here is a lead to investigate, not a verdict: ' +
          'two runs on the same machine days apart still differ by what else that machine was doing.'
      );
      out.push('');
    }
  }

  if (history.incomparable.length) {
    out.push(
      `> **${history.incomparable.length} earlier run(s) are not in the table above**, because ` +
        'they were measured on a different machine or under a different network label. ' +
        'They are still in the history file. A trend line drawn through two different ' +
        'laptops shows the laptops, not the app.'
    );
    out.push('');
  }
} else if (m.startup || m.connect || m.memory) {
  out.push('## Across versions');
  out.push('');
  out.push(
    `No history yet — \`${HISTORY_FILE}\` is written by \`make bench-publish\`, one line per ` +
      'published run. After two publishes this section becomes a trend.'
  );
  out.push('');
}

if (m.missing.length) {
  out.push(`_Not measured in this run: ${m.missing.map((s) => `\`${s}\``).join(', ')}._`);
  out.push('');
}

console.log(out.join('\n'));

// ── Publish into the public docs ─────────────────────────────────────────────
//
// `--publish` (`make bench-publish`) writes this run into the two files the
// documentation site serves: the tables go into docs/benchmarks.md between its
// markers, and the dashboard is written to docs/benchmark.html.
//
// Deliberately a MANUAL step, like `make coverage-badge` and for the same
// reason: CI cannot commit back to `main`, and a benchmark measured on a shared
// CI runner would publish the runner's noise as the product's numbers. So the
// published figures are as fresh as the last person who ran this — which is why
// the block carries the run's date, machine and network label, and why the page
// says in its own words how to tell whether it has gone stale.
//
// The third thing a publish writes is one line in docs/bench-history.ndjson.
// That happened at the top of this file, before the report was rendered, so
// this run's own numbers are the newest row of the trend table it prints. The
// markers below were validated there too — a publish that is going to fail must
// not leave a row behind in the history.

if (publishing) {
  const page = publishPage;
  const from = page.indexOf(BLOCK_START);
  const to = page.indexOf(BLOCK_END);

  // The stdout report minus its own H1: the page already has a title, and two
  // of them would render as a document with no body above the fold. And the
  // NDJSON's path is replaced by its id — the raw file is gitignored, so a path
  // on the publisher's disk means nothing to a reader of the site.
  const body = out
    .slice(out.indexOf('# Voxal performance benchmark') + 1)
    .map((line) =>
      line.startsWith(`Run \`${file}\``)
        ? `Run \`${basename(file, '.ndjson')}\` — ${m.runCount} scenario runs, ${m.at} ` +
          '(the raw measurements are not committed; see `docs/benchmarking.md`)'
        : line
    )
    .join('\n')
    .trimStart();
  const block = [
    BLOCK_START,
    '<!-- Generated by `make bench-publish` from a real run. Do not edit by hand:',
    '     the next publish overwrites everything between these markers. -->',
    '',
    body.trimEnd(),
    '',
    BLOCK_END,
  ].join('\n');

  writeFileSync(PUBLISH_MD, page.slice(0, from) + block + page.slice(to + BLOCK_END.length));
  writeFileSync(PUBLISH_HTML, renderHtml(m, history, historyDelta));
  console.error(
    `bench-report: published ${m.runCount} runs (${m.at}, \`${m.env.label}\`) ` +
      `to ${PUBLISH_MD} and ${PUBLISH_HTML}.`
  );
  if (m.missing.length) {
    console.error(
      `bench-report: WARNING — this run is missing ${m.missing.join(', ')}. ` +
        'The page will say so, but a full `make bench` publishes a fuller picture.'
    );
  }
}

// ── HTML ─────────────────────────────────────────────────────────────────────

if (htmlPath) {
  writeFileSync(htmlPath, renderHtml(m, history, historyDelta));
  console.error(`→ visual report: ${htmlPath}`);
}

// ── CSV ──────────────────────────────────────────────────────────────────────

if (csvPath) {
  const rows = [
    ['scenario', 'label', 'size', 'speakers', 'cameras', 'peer_index', 'role', 'speaking',
     'sharing_camera', 'sharing_screen',
     'out_bps', 'in_bps', 'out_audio_bps', 'in_audio_bps',
     'out_camera_bps', 'in_camera_bps', 'out_screen_bps', 'in_screen_bps',
     'sent_width', 'sent_height', 'sent_fps', 'quality_limitation', 'effects_engaged',
     'rtt_ms_p50', 'jitter_ms_p50', 'loss_pct_p50', 'js_heap_bytes',
     'room_cpu_pct', 'room_rss_bytes', 'net_label', 'app_version', 'commit'].join(','),
  ];
  for (const run of runs) {
    if (!Array.isArray(run.peers)) continue;
    for (const p of run.peers) {
      // The outgoing picture, per peer: camera where there is one, otherwise
      // the screen, so the column means "what this peer sent" in every row.
      const sent = (p.video?.send || []).length ? p.video.send : p.screen?.send || [];
      rows.push([
        run.scenario, run.label ?? '', run.size, run.speakers, run.cameras ?? 0,
        p.index, p.role, p.speaking, !!p.sharingCamera, !!p.sharingScreen,
        Math.round(p.usage.outTotal), Math.round(p.usage.inTotal),
        Math.round(p.usage.out.audio), Math.round(p.usage.in.audio),
        Math.round(p.usage.out.camera), Math.round(p.usage.in.camera),
        Math.round(p.usage.out.screen), Math.round(p.usage.in.screen),
        median(sent.map((s) => s.width)) ?? '',
        median(sent.map((s) => s.height)) ?? '',
        median(sent.map((s) => s.fps)) ?? '',
        sent.find((s) => s.limitation && s.limitation !== 'none')?.limitation ?? '',
        p.effects ? p.effects.engaged : '',
        median(p.links.map((l) => l.rttMs)) ?? '',
        median(p.links.map((l) => l.jitterMs)) ?? '',
        median(p.links.map((l) => l.lossPercent)) ?? '',
        p.jsHeapBytes ?? '',
        run.process?.cpuPercentOfOneCore?.toFixed(1) ?? '',
        run.process?.rssBytes ?? '',
        run.env?.label ?? '',
        run.env?.build?.version ?? '',
        run.env?.build?.commit ?? '',
      ].join(','));
    }
  }
  writeFileSync(csvPath, rows.join('\n') + '\n');
  console.error(`→ per-peer CSV: ${csvPath} (${rows.length - 1} rows)`);
}
