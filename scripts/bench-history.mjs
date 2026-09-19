// The one thing a benchmark run cannot tell you: whether it got worse.
//
// `bench-results/` is gitignored — a run is a measurement of one machine at one
// moment, not source. But the QUESTION "is the app slower than it was three
// releases ago" needs exactly those measurements kept, so this module keeps a
// deliberately thin summary of each PUBLISHED run in a file that IS committed:
//
//     docs/bench-history.ndjson
//
// One line per publish, append-only, with the version, the commit, the machine
// and a dozen headline figures. Not the whole run: a full NDJSON is hundreds of
// kilobytes and most of it is per-peer detail that means nothing a month later.
// What survives here is what a release note would quote.
//
// Written by `make bench-publish` only, never by `make bench` and never by CI —
// same rule as docs/benchmarks.md itself, and for the same reason. A history
// whose rows came from whatever runner CI happened to allocate would record the
// runners' variance as the product's trend.
//
// COMPARABILITY IS THE WHOLE PROBLEM HERE, and it is not solved by storing more
// columns. Two rows are only comparable if they were measured on the same kind
// of machine under the same network label, so every row carries both, and every
// renderer of this file marks the rows that do not match the newest one rather
// than quietly drawing a trend line through them.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const HISTORY_FILE = process.env.BENCH_HISTORY_FILE || 'docs/bench-history.ndjson';

export function loadHistory(file = HISTORY_FILE) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
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
}

/**
 * The headline figures of one run, flattened.
 *
 * Every one of these is null-safe: a partial run (say, `make bench-app` alone)
 * publishes the half it measured and leaves the rest absent, which reads as a
 * gap in the trend rather than as a zero — a fabricated zero in a history file
 * is a regression that never happened, and someone will chase it.
 */
export function summarize(m) {
  const cold = m.startup?.cold;
  const warm = m.startup?.warm;
  const join = m.join?.[0];
  const migration = m.migration?.[0];
  const videoJoin = m.videoJoin?.[0];

  return {
    // ── startup ──
    startupInteractiveMs: cold?.interactiveMs?.p50 ?? null,
    startupFcpMs: cold?.fcpMs?.p50 ?? null,
    startupLoadMs: cold?.loadMs?.p50 ?? null,
    warmInteractiveMs: warm?.interactiveMs?.p50 ?? null,
    // The asset budget. Decoded rather than transferred: the harness's static
    // server sends everything uncompressed, so `transferSize` here measures the
    // server's configuration and `decodedBodySize` measures the app's.
    shellBytes: m.startup?.shell?.resources?.decodedBytes ?? null,
    shellRequests: m.startup?.shell?.resources?.count ?? null,
    scriptBytes: m.startup?.shell?.scripts?.decodedBytes ?? null,
    // ── time to connect ──
    coldCreateMs: m.connect?.create?.totalMs ?? null,
    coldJoinMs: m.connect?.join?.totalMs ?? null,
    joinAudibleMs: join?.audibleMs ?? null,
    videoVisibleMs: videoJoin?.visibleMs ?? null,
    migrationAudioMs: migration?.audioRestoredMs ?? null,
    // ── memory ──
    idleHeapBytes: m.memory?.idle?.heapBytes ?? null,
    roomHeapBytes: m.memory?.room?.heapBytes ?? null,
    idleDomNodes: m.memory?.idle?.domNodes ?? null,
    churnHeapPerCycleBytes: m.memory?.churn?.perCycleHeapBytes ?? null,
    churnListenerGrowth: m.memory?.churn?.listenerGrowth ?? null,
    // ── the call itself ──
    marginalUploadBps: m.marginalUploadBps ?? null,
    marginalVideoUploadBps: m.marginalVideoUploadBps ?? null,
    peakRoomCpuPercent: m.scale?.length
      ? Math.max(...m.scale.map((r) => r.cpuPercent ?? 0)) || null
      : null,
  };
}

/** The fields that decide whether two rows may be compared at all. */
export function conditionsOf(entry) {
  const e = entry.machine || {};
  return {
    platform: e.platform ?? null,
    arch: e.arch ?? null,
    cpus: e.cpus ?? null,
    cpuModel: e.cpuModel ?? null,
    label: entry.label ?? null,
  };
}

/**
 * Whether `entry` was measured under the same conditions as `reference`.
 *
 * The CPU model is part of it, not just the core count: two eight-core machines
 * five years apart do not produce comparable startup figures, and a trend line
 * drawn through both would show a regression that is really a different laptop.
 */
export function comparable(entry, reference) {
  if (!reference) return true;
  const a = conditionsOf(entry);
  const b = conditionsOf(reference);
  return a.platform === b.platform && a.arch === b.arch && a.cpuModel === b.cpuModel && a.label === b.label;
}

/**
 * Append one published run, replacing any earlier entry for the same run id.
 *
 * Replacing rather than appending twice is what makes `make bench-publish`
 * safe to re-run: republishing the same measurements is a correction, not a
 * second data point, and two identical rows in a trend would flatten the line
 * they sit on.
 *
 * Entries are kept sorted by time, so the file reads as a history even if a run
 * from last week is published after one from today.
 */
export function appendRun(m, runId, file = HISTORY_FILE) {
  const entry = {
    runId,
    at: m.at || new Date().toISOString(),
    version: m.build?.version ?? null,
    buildDate: m.build?.buildDate ?? null,
    commit: m.build?.commit ?? null,
    branch: m.build?.branch ?? null,
    // A run measured on a modified tree cannot be reproduced from the commit
    // beside it. Recorded rather than refused: the number is still real, and a
    // reader who knows it was dirty can weigh it.
    dirty: m.build?.dirty ?? null,
    label: m.env?.label ?? null,
    machine: {
      platform: m.env?.platform ?? null,
      arch: m.env?.arch ?? null,
      cpus: m.env?.cpus ?? null,
      cpuModel: m.env?.cpuModel ?? null,
      totalMemBytes: m.env?.totalMemBytes ?? null,
    },
    scenarios: m.runCount ?? null,
    missing: m.missing || [],
    metrics: summarize(m),
  };

  const rows = loadHistory(file).filter((r) => r.runId !== runId);
  rows.push(entry);
  rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { entry, total: rows.length };
}

/**
 * The trend, newest last, limited to the rows that may be compared with the
 * newest one — plus the ones that may not, flagged rather than dropped.
 *
 * Dropping them would hide that the history contains measurements from
 * somewhere else; including them silently would be worse.
 */
export function trend(rows) {
  if (!rows.length) return { rows: [], reference: null, incomparable: [] };
  const reference = rows[rows.length - 1];
  const ok = rows.filter((r) => comparable(r, reference));
  return {
    rows: ok,
    reference,
    incomparable: rows.filter((r) => !comparable(r, reference)),
  };
}

/** Per-metric change between the newest comparable row and the one before it. */
export function delta(rows) {
  if (rows.length < 2) return null;
  const now = rows[rows.length - 1];
  const before = rows[rows.length - 2];
  const out = {};
  for (const key of Object.keys(now.metrics)) {
    const a = before.metrics[key];
    const b = now.metrics[key];
    out[key] =
      typeof a === 'number' && typeof b === 'number' && a !== 0
        ? { from: a, to: b, abs: b - a, pct: ((b - a) / Math.abs(a)) * 100 }
        : { from: a ?? null, to: b ?? null, abs: null, pct: null };
  }
  return { from: before, to: now, metrics: out };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
//
// `make bench-history` — the trend on its own, with no run to report on. Useful
// before a release ("has anything got worse since the last one?") and after a
// publish, to read back what was recorded.
//
// Reading only. Nothing here writes to the history: a row is added by
// `make bench-publish`, from real measurements, and by nothing else.
if (process.argv[1] && process.argv[1].endsWith('bench-history.mjs')) {
  const { bytes, ms, bits } = await import('./bench-data.mjs');
  const rows = loadHistory();

  if (!rows.length) {
    console.log(
      `No benchmark history yet.\n\n` +
        `${HISTORY_FILE} gets one line per \`make bench-publish\`. Run:\n\n` +
        '    make bench            # measure\n' +
        '    make bench-publish    # publish, and record the run here\n'
    );
    process.exit(0);
  }

  const t = trend(rows);
  const d = delta(t.rows);
  const cell = (v) => String(v ?? '—');
  const table = (headers, body) =>
    [
      `| ${headers.join(' | ')} |`,
      `|${headers.map(() => '---').join('|')}|`,
      ...body.map((r) => `| ${r.map(cell).join(' | ')} |`),
    ].join('\n');

  console.log(`# Voxal benchmark history\n`);
  console.log(`${rows.length} published run(s) in \`${HISTORY_FILE}\`.\n`);
  console.log(
    table(
      ['Version', 'Commit', 'Date', 'Startup', 'Cold join', 'Shell', 'Idle heap', 'Room heap', 'Per-peer ↑'],
      t.rows.slice(-12).map((r) => [
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
  console.log('');
  if (d) {
    const moved = Object.entries(d.metrics).filter(([, v]) => v.pct !== null && Math.abs(v.pct) >= 5);
    const from = d.from.version ? `v${d.from.version}` : d.from.commit || 'previous';
    const to = d.to.version ? `v${d.to.version}` : d.to.commit || 'latest';
    console.log(
      moved.length
        ? `${from} → ${to}: ${moved
            .map(([k, v]) => `${k} ${v.pct > 0 ? '▲' : '▼'}${Math.abs(v.pct).toFixed(0)}%`)
            .join(', ')}\n`
        : `${from} → ${to}: nothing moved by more than 5%.\n`
    );
  }
  if (t.incomparable.length) {
    console.log(
      `${t.incomparable.length} run(s) hidden: measured on a different machine or network label ` +
        'than the newest one. A trend through two different machines shows the machines.\n'
    );
  }
}
