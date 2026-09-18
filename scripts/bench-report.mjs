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
import { writeFileSync, existsSync } from 'node:fs';
import {
  RESULTS_DIR, newestRunFile, loadRuns, buildModel,
  median, bits, mib, pct, ms, num,
} from './bench-data.mjs';
import { renderHtml } from './bench-html.mjs';

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
out.push('');
out.push(
  '> Every peer of a room runs in one Chromium on one machine over loopback. ' +
    'Latency is therefore a **floor**, not a field measurement, and the CPU/RSS ' +
    'columns are the cost of the **whole room** on that one machine — they are ' +
    'not per-peer and must not be divided by the peer count. ' +
    'See `docs/benchmarking.md`.'
);
out.push('');

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
        `(least-squares slope across ${m.curve.length} room sizes). A listener pays it too — ` +
        `\`usedtx=0\` keeps packets flowing while muted.`
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

if (m.missing.length) {
  out.push(`_Not measured in this run: ${m.missing.map((s) => `\`${s}\``).join(', ')}._`);
  out.push('');
}

console.log(out.join('\n'));

// ── HTML ─────────────────────────────────────────────────────────────────────

if (htmlPath) {
  writeFileSync(htmlPath, renderHtml(m));
  console.error(`→ visual report: ${htmlPath}`);
}

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
