// Fold a benchmark run's NDJSON into one markdown table plus a CSV for plotting.
//
// Deliberately the same shape as scripts/coverage-report.mjs: every section is
// optional, a scenario that was not run is reported as absent rather than
// failing, so a partial run still produces a readable report.
//
// Usage:
//   node scripts/bench-report.mjs                  # newest run in bench-results/
//   node scripts/bench-report.mjs <file.ndjson>    # a specific run
//   node scripts/bench-report.mjs --csv out.csv    # also write the per-peer CSV
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const RESULTS_DIR = process.env.BENCH_OUT_DIR || 'bench-results';

function newestRunFile() {
  if (!existsSync(RESULTS_DIR)) return null;
  const files = readdirSync(RESULTS_DIR).filter((f) => f.endsWith('.ndjson')).sort();
  return files.length ? join(RESULTS_DIR, files[files.length - 1]) : null;
}

const args = process.argv.slice(2);
const csvIdx = args.indexOf('--csv');
const csvPath = csvIdx !== -1 ? args[csvIdx + 1] : null;
const file = args.find((a) => a.endsWith('.ndjson')) || newestRunFile();

if (!file || !existsSync(file)) {
  console.log(`No benchmark results found in ${RESULTS_DIR}/. Run \`make bench\` first.`);
  process.exit(0);
}

const runs = readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line, i) => {
    try {
      return JSON.parse(line);
    } catch {
      console.error(`! skipping unparseable line ${i + 1} of ${file}`);
      return null;
    }
  })
  .filter(Boolean);

// ── formatting ───────────────────────────────────────────────────────────────

const bits = (bps) => {
  if (bps === null || bps === undefined) return '—';
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(2)} Mb/s`;
  if (bps >= 1000) return `${Math.round(bps / 1000)} kb/s`;
  return `${Math.round(bps)} b/s`;
};
const mib = (b) => (b === null || b === undefined ? '—' : `${(b / 1048576).toFixed(0)} MiB`);
const pct = (n) => (n === null || n === undefined ? '—' : `${n.toFixed(0)}%`);
const ms = (n) => (n === null || n === undefined ? '—' : `${Math.round(n)} ms`);
const num = (n, d = 1) => (n === null || n === undefined ? '—' : n.toFixed(d));

function median(values) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

const linkValues = (run, key) => run.peers.flatMap((p) => p.links.map((l) => l[key]));
const byRole = (run, speaking) => run.peers.filter((p) => p.speaking === speaking);

function table(headers, rows) {
  if (!rows.length) return '';
  return [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

const out = [];
const env = runs[0].env || {};
out.push('# Voxal performance benchmark');
out.push('');
out.push(`Run \`${file}\` — ${runs.length} scenario runs, ${runs[0].at}`);
out.push('');
out.push(
  `**Machine**: ${env.platform}/${env.arch}, ${env.cpus} cores` +
    (env.cpuModel ? ` (${env.cpuModel})` : '') +
    `, ${mib(env.totalMemBytes)} RAM, node ${env.node}`
);
out.push(`**Network**: \`${env.label}\``);
out.push('');
out.push(
  '> Every peer of a room runs in one Chromium on one machine over loopback. ' +
    'Latency is therefore a **floor**, not a field measurement, and the CPU/RSS ' +
    'columns are the cost of the **whole room** on that one machine — they are ' +
    'not per-peer and must not be divided by the peer count. ' +
    'See `docs/benchmarking.md`.'
);
out.push('');

// ── Scenario A: mesh scale ───────────────────────────────────────────────────

const scale = runs.filter((r) => r.scenario === 'mesh-scale');
if (scale.length) {
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
      scale
        .sort((a, b) => a.size - b.size || a.speakers - b.speakers)
        .map((run) => [
          run.size,
          run.speakers,
          bits(median(byRole(run, true).map((p) => p.usage.outTotal))),
          bits(median(byRole(run, false).map((p) => p.usage.outTotal))),
          bits(median(byRole(run, false).map((p) => p.usage.inTotal))),
          ms(median(linkValues(run, 'rttMs'))),
          `${num(median(linkValues(run, 'lossPercent')))}%`,
          run.process.measured ? pct(run.process.cpuPercentOfOneCore) : '—',
          run.process.measured ? mib(run.process.rssBytes) : '—',
        ])
    )
  );
  out.push('');

  // The per-peer cost of one extra peer, which is the claim worth checking.
  const single = scale.filter((r) => r.speakers === 1).sort((a, b) => a.size - b.size);
  if (single.length >= 2) {
    const first = single[0];
    const last = single[single.length - 1];
    const upFirst = median(byRole(first, true).map((p) => p.usage.outTotal));
    const upLast = median(byRole(last, true).map((p) => p.usage.outTotal));
    if (upFirst && upLast) {
      out.push(
        `A speaker's upload went from **${bits(upFirst)}** at ${first.size} peers to ` +
          `**${bits(upLast)}** at ${last.size} — ×${num(upLast / upFirst, 2)} for ` +
          `×${num((last.size - 1) / (first.size - 1), 2)} the links.`
      );
      out.push('');
    }
  }
}

// ── Scenario B: noise suppression ────────────────────────────────────────────

const ns = runs.filter((r) => r.scenario === 'noise-suppression');
if (ns.length) {
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
      ns.map((run) => [
        `\`${run.storage['noise-suppression']}\``,
        run.size,
        bits(median(byRole(run, true).map((p) => p.usage.outTotal))),
        run.process.measured ? pct(run.process.cpuPercentOfOneCore) : '—',
        run.process.measured ? mib(run.process.rssBytes) : '—',
        mib(median(run.peers.map((p) => p.jsHeapBytes))),
      ])
    )
  );
  out.push('');
}

// ── Scenario C: join latency ─────────────────────────────────────────────────

const joinRuns = runs.filter((r) => r.scenario === 'join-latency');
if (joinRuns.length) {
  out.push('## Join latency');
  out.push('');
  out.push('Clock starts at the join, not at browser launch — a real user already has a browser open.');
  out.push('');
  out.push(
    table(
      ['Room size', 'Reps', 'Signaling open', 'First audio heard'],
      joinRuns.map((run) => [run.size, run.samples.length, ms(run.medianSignalingMs), ms(run.medianAudibleMs)])
    )
  );
  out.push('');
}

// ── Scenario D: host migration ───────────────────────────────────────────────

const migration = runs.filter((r) => r.scenario === 'host-migration');
if (migration.length) {
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
      migration.map((run) => [run.size, run.survivors, ms(run.hostElectedMs), ms(run.audioRestoredMs)])
    )
  );
  out.push('');
}

const missing = ['mesh-scale', 'noise-suppression', 'join-latency', 'host-migration'].filter(
  (s) => !runs.some((r) => r.scenario === s)
);
if (missing.length) {
  out.push(`_Not measured in this run: ${missing.map((m) => `\`${m}\``).join(', ')}._`);
  out.push('');
}

console.log(out.join('\n'));

// ── CSV ──────────────────────────────────────────────────────────────────────

if (csvPath) {
  const rows = [
    ['scenario', 'label', 'size', 'speakers', 'peer_index', 'role', 'speaking',
     'out_bps', 'in_bps', 'out_audio_bps', 'in_audio_bps',
     'rtt_ms_p50', 'jitter_ms_p50', 'loss_pct_p50', 'js_heap_bytes',
     'room_cpu_pct', 'room_rss_bytes', 'net_label'].join(','),
  ];
  for (const run of runs) {
    if (!Array.isArray(run.peers)) continue;
    for (const p of run.peers) {
      rows.push([
        run.scenario, run.label ?? '', run.size, run.speakers, p.index, p.role, p.speaking,
        Math.round(p.usage.outTotal), Math.round(p.usage.inTotal),
        Math.round(p.usage.out.audio), Math.round(p.usage.in.audio),
        median(p.links.map((l) => l.rttMs)) ?? '',
        median(p.links.map((l) => l.jitterMs)) ?? '',
        median(p.links.map((l) => l.lossPercent)) ?? '',
        p.jsHeapBytes ?? '',
        run.process?.cpuPercentOfOneCore?.toFixed(1) ?? '',
        run.process?.rssBytes ?? '',
        run.env?.label ?? '',
      ].join(','));
    }
  }
  writeFileSync(csvPath, rows.join('\n') + '\n');
  console.error(`→ per-peer CSV: ${csvPath} (${rows.length - 1} rows)`);
}
