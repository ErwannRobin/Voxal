// Render the benchmark model as one self-contained HTML page.
//
// No CDN and no chart library, for the same reason the app vendors PeerJS: the
// report has to open from a file:// URL on a machine with no network, and it
// has to still open in two years. Everything is inline SVG generated here plus
// a few dozen lines of hover/theme script.
//
// The colours are the data-viz reference palette's first two categorical slots,
// validated in both modes (adjacent CVD dE 24.7 light / 26.8 dark, normal-vision
// 33.6 / 31.8, all contrast >= 3:1). Two series is the whole vocabulary — a third
// measure gets its own chart rather than a third hue or a second y-axis.
import { bits, mib, pct, ms, secs, num, res, fps } from './bench-data.mjs';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

/** Tooltip payload for a mark: [{k,v}, …], JSON in an escaped attribute. */
const rowsAttr = (rows) => esc(JSON.stringify(rows));

// ── scales ───────────────────────────────────────────────────────────────────

/** Round a range up to ticks at 1/2/5 x 10^n, so the axis reads in clean numbers. */
function niceTicks(max, count = 5) {
  if (!Number.isFinite(max) || max <= 0) return { max: 1, ticks: [0, 1] };
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { max: top, ticks };
}

// ── line chart ───────────────────────────────────────────────────────────────

const PLOT = { w: 760, h: 300, top: 18, right: 112, bottom: 44, left: 66 };

/**
 * Lines over an ordered numeric x (room size), one or two series.
 *
 * Direct labels ride only the last point of each series. A value beside every
 * marker is the fastest way to make a chart unreadable — the axis, the hover
 * layer and the table twin below carry the rest.
 */
function lineChart({ id, series, xs, xLabel, yLabel, format, xTickLabel }) {
  const { w, h, top, right, bottom, left } = PLOT;
  const innerW = w - left - right;
  const innerH = h - top - bottom;
  const allY = series.flatMap((s) => s.points.map((p) => p.y)).filter(Number.isFinite);
  const { max, ticks } = niceTicks(Math.max(...allY, 0));

  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const sx = (x) => left + (xMax === xMin ? innerW / 2 : ((x - xMin) / (xMax - xMin)) * innerW);
  const sy = (y) => top + innerH - (max === 0 ? 0 : (y / max) * innerH);

  const parts = [];

  // Gridlines: solid hairlines one shade off the surface. Never dashed — a dash
  // reads as "threshold" or "projection" when it is only a grid.
  for (const t of ticks) {
    // The zero tick carries no unit — "0 b/s" spends three words saying nothing,
    // and the ticks above it have already established the scale.
    parts.push(
      `<line x1="${left}" y1="${sy(t).toFixed(1)}" x2="${left + innerW}" y2="${sy(t).toFixed(1)}" class="grid"/>`,
      `<text x="${left - 10}" y="${(sy(t) + 4).toFixed(1)}" class="tick tick-y">${esc(t === 0 ? '0' : format(t))}</text>`
    );
  }
  for (const x of xs) {
    parts.push(
      `<text x="${sx(x).toFixed(1)}" y="${top + innerH + 22}" class="tick tick-x">${esc(xTickLabel(x))}</text>`
    );
  }
  parts.push(
    `<line x1="${left}" y1="${top + innerH}" x2="${left + innerW}" y2="${top + innerH}" class="axis"/>`,
    `<text x="${left + innerW / 2}" y="${h - 6}" class="axis-title">${esc(xLabel)}</text>`
  );

  series.forEach((s, i) => {
    const pts = s.points.filter((p) => Number.isFinite(p.y));
    if (!pts.length) return;
    const d = pts.map((p, j) => `${j ? 'L' : 'M'}${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join(' ');
    parts.push(`<path d="${d}" class="line" stroke="var(--series-${i + 1})"/>`);
    // A 2px ring in the surface colour keeps a marker legible where lines cross.
    for (const p of pts) {
      parts.push(
        `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="4.5" fill="var(--series-${i + 1})" class="dot"/>`
      );
    }
    const last = pts[pts.length - 1];
    parts.push(
      `<text x="${(sx(last.x) + 12).toFixed(1)}" y="${(sy(last.y) + 4).toFixed(1)}" class="end-label">${esc(format(last.y))}</text>`
    );
  });

  // Hover bands: one per x, the full height of the plot, so the hit target is
  // nothing like as small as the 9px marker it reports on.
  const bandW = xs.length > 1 ? innerW / (xs.length - 1) : innerW;
  xs.forEach((x) => {
    const rows = series
      .map((s) => {
        const p = s.points.find((q) => q.x === x);
        return p && Number.isFinite(p.y) ? { k: s.name, v: format(p.y) } : null;
      })
      .filter(Boolean);
    parts.push(
      `<rect x="${(sx(x) - bandW / 2).toFixed(1)}" y="${top}" width="${bandW.toFixed(1)}" height="${innerH}" class="hover-band" data-title="${esc(
        xTickLabel(x) + ' peers'
      )}" data-rows="${rowsAttr(rows)}"/>`
    );
  });

  return `<figure class="chart" id="${esc(id)}">
  <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(yLabel)} by ${esc(xLabel)}" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>
</figure>`;
}

// ── bar chart ────────────────────────────────────────────────────────────────

/**
 * Horizontal bars for a handful of named categories, one measure.
 *
 * One series means one colour for every bar. Shading each bar by its own value
 * would double-encode length as hue and spend the only free channel restating
 * what the bar already says.
 */
function barChart({ id, rows, format, label }) {
  const rowH = 50;
  const barH = 22; // <= 24px: the band's leftover is air, not mark
  const w = 760;
  const left = 136;
  const right = 100;
  const h = rows.length * rowH + 12;
  const innerW = w - left - right;
  const { max } = niceTicks(Math.max(...rows.map((r) => r.value).filter(Number.isFinite), 0));

  const parts = [];
  rows.forEach((r, i) => {
    const y = i * rowH + 10;
    const len = Number.isFinite(r.value) && max > 0 ? (r.value / max) * innerW : 0;
    parts.push(`<text x="${left - 14}" y="${y + barH / 2 + 4}" class="cat-label">${esc(r.label)}</text>`);
    if (r.note) {
      parts.push(`<text x="${left - 14}" y="${y + barH / 2 + 20}" class="cat-note">${esc(r.note)}</text>`);
    }
    // 4px rounded data-end, square at the baseline — a path so only the growing
    // end is rounded, and so a bar shorter than the radius still draws.
    if (len > 0) {
      const r4 = Math.min(4, len / 2);
      const d = `M${left} ${y} H${left + len - r4} a${r4} ${r4} 0 0 1 ${r4} ${r4} V${y + barH - r4} a${r4} ${r4} 0 0 1 ${-r4} ${r4} H${left} Z`;
      parts.push(
        `<path d="${d}" fill="var(--series-1)" class="bar" data-title="${esc(r.label)}" data-rows="${rowsAttr([
          { k: label, v: format(r.value) },
        ])}"/>`
      );
    }
    parts.push(
      `<text x="${left + len + 10}" y="${y + barH / 2 + 4}" class="bar-value">${esc(format(r.value))}</text>`
    );
  });

  return `<figure class="chart" id="${esc(id)}">
  <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)} by mode" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>
</figure>`;
}

// ── pieces ───────────────────────────────────────────────────────────────────

// A legend is always present for two or more series, and never for one — a box
// with a single swatch only restates the title.
const legend = (names) =>
  names.length < 2
    ? ''
    : `<div class="legend">${names
        .map(
          (n, i) =>
            `<span class="legend-item"><span class="swatch" style="background:var(--series-${i + 1})"></span>${esc(n)}</span>`
        )
        .join('')}</div>`;

// Every chart's table twin: the WCAG-clean equivalent, so no value is reachable
// only by hovering.
const table = (headers, rows) =>
  `<details class="table-view"><summary>Show the numbers</summary><div class="table-scroll"><table><thead><tr>${headers
    .map((hd) => `<th>${esc(hd)}</th>`)
    .join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div></details>`;

const card = (title, subtitle, body) =>
  `<section class="card"><h2>${esc(title)}</h2>${subtitle ? `<p class="sub">${subtitle}</p>` : ''}${body}</section>`;

const tile = (label, value, note) =>
  `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${esc(value)}</div>${
    note ? `<div class="tile-note">${esc(note)}</div>` : ''
  }</div>`;

// ── page ─────────────────────────────────────────────────────────────────────

export function renderHtml(m) {
  const env = m.env || {};
  const sections = [];

  const join = m.join[0];
  const migration = m.migration[0];
  const videoJoin = m.videoJoin[0];
  const peakCpu = Math.max(...m.scale.map((r) => r.cpuPercent ?? 0), 0) || null;
  // The video twin of the hero figure, and the reason the page has two: an
  // audio room and a video room are two different products to a domestic
  // uplink, and averaging them into one number would hide which one you are in.
  const videoHero = m.marginalVideoUploadBps;

  // Exactly one hero figure on the page: the marginal cost of one more peer,
  // which is the number a room-size decision actually turns on — and a slope
  // over the whole sweep is harder to cherry-pick than a ratio between two
  // chosen sizes.
  const tiles = [];
  if (join) tiles.push(tile('Join a live room', ms(join.audibleMs), `until the first audio, over ${join.reps} reps`));
  if (migration)
    tiles.push(
      tile('Host vanishes', secs(migration.audioRestoredMs), `until audio is back, ${migration.survivors} survivors`)
    );
  if (videoHero !== null && videoHero !== undefined)
    tiles.push(
      tile('Each peer, on camera', bits(videoHero), 'extra upload per peer added, cameras on')
    );
  if (videoJoin)
    tiles.push(
      tile('See a live room', ms(videoJoin.visibleMs), `until every camera is on screen, over ${videoJoin.reps} reps`)
    );
  if (peakCpu) tiles.push(tile('Peak room CPU', pct(peakCpu), `the whole room on ${env.cpus ?? '?'} cores`));

  sections.push(`<section class="hero-row">
  <div class="hero">
    <div class="hero-label">Extra upload per peer added</div>
    <div class="hero-value">${esc(m.marginalUploadBps === null ? '—' : bits(m.marginalUploadBps))}</div>
    <div class="hero-note">${
      m.marginalUploadBps === null
        ? 'Needs a sweep of at least two room sizes.'
        : 'Audio is a full mesh, so a speaker sends one stream to every other peer. A product built on an SFU pays this once, not once per peer.'
    }</div>
  </div>
  <div class="tiles">${tiles.join('')}</div>
</section>`);

  // ── mesh scaling ───────────────────────────────────────────────────────────
  if (m.curve.length) {
    const xs = m.curve.map((r) => r.size);
    const body =
      m.curve.length >= 2
        ? legend(['Speaker upload', 'Listener upload']) +
          lineChart({
            id: 'chart-upload',
            xs,
            xLabel: 'Peers in the room',
            yLabel: 'Upload',
            format: bits,
            xTickLabel: (x) => String(x),
            series: [
              { name: 'Speaker upload', points: m.curve.map((r) => ({ x: r.size, y: r.speakerUp })) },
              { name: 'Listener upload', points: m.curve.map((r) => ({ x: r.size, y: r.listenerUp })) },
            ],
          })
        : '<p class="empty">Only one room size was measured — sweep at least two (<code>BENCH_SIZES</code>) to draw the curve.</p>';

    sections.push(
      card(
        'Upload grows with the room',
        'Both lines climb because audio is a full mesh. The listener line climbs too: <code>usedtx=0</code> keeps packets flowing while muted, so <strong>everyone</strong> in the room pays for the mesh, not only whoever is talking.',
        body +
          table(
            ['Peers', 'Speakers', 'Speaker up', 'Listener up', 'Listener down', 'RTT', 'Loss', 'Room CPU', 'Room RSS'],
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
      )
    );

    // CPU is a different unit, so it is a different chart. Never a second
    // y-scale on the plot above — the alignment between two scales is arbitrary
    // and invents a correlation that is not in the data.
    if (m.curve.length >= 2 && m.curve.some((r) => Number.isFinite(r.cpuPercent))) {
      sections.push(
        card(
          'What the room costs the machine',
          'Every peer runs in one browser here, so this is the <strong>whole room</strong> on one machine — never divide it by the peer count. CPU also carries real run-to-run variance; compare it only across repeats, and only between configurations measured back to back.',
          lineChart({
            id: 'chart-cpu',
            xs,
            xLabel: 'Peers in the room',
            yLabel: 'Room CPU',
            format: (v) => `${Math.round(v)}%`,
            xTickLabel: (x) => String(x),
            series: [{ name: 'Room CPU', points: m.curve.map((r) => ({ x: r.size, y: r.cpuPercent })) }],
          }) +
            table(
              ['Peers', 'Room CPU', 'Room RSS'],
              m.curve.map((r) => [r.size, pct(r.cpuPercent), mib(r.rssBytes)])
            )
        )
      );
    }
  }

  // ── noise suppression ──────────────────────────────────────────────────────
  if (m.ns.length) {
    sections.push(
      card(
        'What noise suppression costs',
        '<code>rnnoise</code> is the desktop default, so this is a cost the product pays unless someone changes it. Same room size and the same speakers in every row — only the mode changes.',
        barChart({
          id: 'chart-ns',
          label: 'Room CPU',
          format: pct,
          rows: m.ns.map((r) => ({
            label: r.mode,
            value: r.cpuPercent,
            note: r.isDefault ? 'desktop default' : null,
          })),
        }) +
          table(
            ['Mode', 'Peers', 'Speaker up', 'Room CPU', 'Room RSS', 'JS heap'],
            m.ns.map((r) => [
              r.mode + (r.isDefault ? ' (default)' : ''),
              r.size,
              bits(r.speakerUp),
              pct(r.cpuPercent),
              mib(r.rssBytes),
              mib(r.jsHeapBytes),
            ])
          )
      )
    );
  }

  // ── video ──────────────────────────────────────────────────────────────────
  //
  // The camera's own mesh, kept apart from audio's throughout: every figure
  // here is the `camera`/`screen` column of the bandwidth sampler, never the
  // total, which would fold the voice call back in.
  if (m.video.length) {
    const xs = m.videoCurve.map((r) => r.size);
    const body =
      m.videoCurve.length >= 2
        ? legend(['Sharer upload', 'Receiver download']) +
          lineChart({
            id: 'chart-video-upload',
            xs,
            xLabel: 'Peers in the room, all on camera',
            yLabel: 'Camera bandwidth',
            format: bits,
            xTickLabel: (x) => String(x),
            series: [
              { name: 'Sharer upload', points: m.videoCurve.map((r) => ({ x: r.size, y: r.sharerUp })) },
              { name: 'Receiver download', points: m.videoCurve.map((r) => ({ x: r.size, y: r.receiverDown })) },
            ],
          })
        : '<p class="empty">Only one room size was measured — sweep at least two (<code>BENCH_VIDEO_SIZES</code>) to draw the curve.</p>';

    const cpuLimited = m.video.some((r) => r.picture && r.picture.limitation === 'cpu');
    sections.push(
      card(
        'Camera: one encode per peer',
        'Under the <code>p2p-only</code> preference this harness pins, camera is a full mesh too — so a sharer encodes and uploads one stream <strong>per other peer</strong>, at roughly twenty times an Opus stream. The shipped default may route this through an SFU above two participants instead, and that topology is <strong>not</strong> measured here.' +
          (cpuLimited || m.videoSaturatedMachine
            ? ' <strong>This machine ran out of room.</strong> One browser was encoding every peer\'s camera at once, and when that happens the frame rate falls first — while the encoder still blames its own bitrate cap. Read the rows below as a ceiling of the harness, not of the app.'
            : ''),
        body +
          table(
            ['Peers', 'Cameras', 'Sharer up', 'Receiver down', 'Picture sent', 'Room CPU', 'Room RSS'],
            m.video.map((r) => [
              r.size,
              r.allCameras ? `all (${r.cameras})` : r.cameras,
              bits(r.sharerUp),
              bits(r.receiverDown),
              r.picture
                ? `${res(r.picture)} @ ${fps(r.picture.fps)}` +
                  (r.picture.limitation && r.picture.limitation !== 'none' ? ` (${r.picture.limitation})` : '')
                : '—',
              pct(r.cpuPercent),
              mib(r.rssBytes),
            ])
          )
      )
    );
  }

  if (m.videoBackground.length) {
    sections.push(
      card(
        'What a camera background costs',
        'Segmentation runs locally — MediaPipe in WebAssembly plus a WebGL composite — so it is paid in <strong>CPU and frame rate</strong>, never on the wire. <em>Still running</em> counts the sharing peers that still had the effect on at the end: the app turns a background off in silence both when the runtime cannot start and when the device cannot sustain it, so a <code>0</code> there means the row is not the cost of the effect.',
        barChart({
          id: 'chart-video-bg',
          label: 'Room CPU',
          format: pct,
          rows: m.videoBackground.map((r) => ({
            label: r.mode,
            value: r.cpuPercent,
            note: r.isDefault
              ? 'default'
              : r.effects && r.effects.engaged === 0
                ? (r.effects.dropped ? 'the app gave up here' : 'never started')
                : null,
          })),
        }) +
          table(
            ['Background', 'Peers', 'Cameras', 'Still running', 'Sharer up', 'Picture sent', 'Room CPU'],
            m.videoBackground.map((r) => [
              r.mode + (r.isDefault ? ' (default)' : ''),
              r.size,
              r.cameras,
              r.effects ? `${r.effects.engaged}/${r.effects.sharers}` : '—',
              bits(r.sharerUp),
              r.picture ? `${res(r.picture)} @ ${fps(r.picture.fps)}` : '—',
              pct(r.cpuPercent),
            ])
          )
      )
    );
  }

  if (m.screen.length) {
    sections.push(
      card(
        'Screen share',
        'A screen is not a camera: its ceiling is 1.5 Mb/s rather than 600 kb/s, it is pinned to <code>maintain-resolution</code> so it drops frames rather than letters, and the peer-count downscale never touches it.',
        table(
          ['Peers', 'Sharer up', 'Watcher down', 'Picture sent', 'Room CPU', 'Room RSS'],
          m.screen.map((r) => [
            r.size,
            bits(r.sharerUp),
            bits(r.watcherDown),
            r.picture ? `${res(r.picture)} @ ${fps(r.picture.fps)}` : '—',
            pct(r.cpuPercent),
            mib(r.rssBytes),
          ])
        )
      )
    );
  }

  // ── timings ────────────────────────────────────────────────────────────────
  //
  // Two numbers each, and the point of both is a sentence, not a plot. A chart
  // of two near-identical values would say less than the line explaining why
  // they are near-identical.
  if (join || migration || videoJoin) {
    const rows = [];
    if (join)
      rows.push(
        `<div class="timing"><div class="timing-head">Joining a call already in progress</div>
      <div class="timing-body">Signaling opens in <strong>${esc(
        ms(join.signalingMs)
      )}</strong>, and the first audio arrives at <strong>${esc(
          ms(join.audibleMs)
        )}</strong>. The clock starts at the join, not at browser launch — a real user already has a browser open.</div></div>`
      );
    if (migration)
      rows.push(
        `<div class="timing"><div class="timing-head">Losing the host</div>
      <div class="timing-body">A new host is elected at <strong>${esc(
        ms(migration.hostElectedMs)
      )}</strong> and audio is back at <strong>${esc(
          ms(migration.audioRestoredMs)
        )}</strong> — the same moment, give or take, and both are simply the ~7 s heartbeat timeout. The room is leaderless for seven seconds; it is never <em>silent</em>, because audio connections to non-host peers are never torn down during a migration.</div></div>`
      );
    if (videoJoin)
      rows.push(
        `<div class="timing"><div class="timing-head">Joining a room that is already on camera</div>
      <div class="timing-body">The room is audible at <strong>${esc(
        ms(videoJoin.audibleMs)
      )}</strong> and every camera in it is on screen at <strong>${esc(
          ms(videoJoin.visibleMs)
        )}</strong>. Hearing and seeing are separate numbers: a picture needs its own call per sharer, a keyframe and a decoder, and the mesh builds them one at a time.</div></div>`
      );
    sections.push(card('Timings', '', `<div class="timings">${rows.join('')}</div>`));
  }

  if (m.missing.length) {
    sections.push(
      `<p class="missing">Not measured in this run: ${m.missing.map((s) => `<code>${esc(s)}</code>`).join(', ')}.</p>`
    );
  }

  return page(m, env, sections.join('\n'));
}

function page(m, env, body) {
  return `<!doctype html>
<html lang="en" data-theme="system">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Voxal performance benchmark</title>
<style>
:root {
  color-scheme: light dark;
  --page:#f9f9f7; --surface-1:#fcfcfb;
  --text-primary:#0b0b0b; --text-secondary:#52514e; --muted:#898781;
  --grid:#e1e0d9; --axis:#c3c2b7; --border:rgba(11,11,11,.10);
  --series-1:#2a78d6; --series-2:#eb6834;
  --callout:#f0efec;
}
/* Dark is selected, not an automatic flip: its own steps from the same ramps,
   validated against the dark surface. Declared under both scopes so the OS
   setting and the toggle each win where they should. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --page:#0d0d0d; --surface-1:#1a1a19;
    --text-primary:#fff; --text-secondary:#c3c2b7; --muted:#898781;
    --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,.10);
    --series-1:#3987e5; --series-2:#d95926;
    --callout:#232321;
  }
}
:root[data-theme="dark"] {
  --page:#0d0d0d; --surface-1:#1a1a19;
  --text-primary:#fff; --text-secondary:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,.10);
  --series-1:#3987e5; --series-2:#d95926;
  --callout:#232321;
}
* { box-sizing: border-box; }
body {
  margin:0; background:var(--page); color:var(--text-primary);
  font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;
  padding:32px 16px 64px;
}
.wrap { max-width:940px; margin:0 auto; }
header { display:flex; flex-wrap:wrap; gap:16px; align-items:flex-start; justify-content:space-between; margin-bottom:8px; }
h1 { font-size:26px; font-weight:650; margin:0 0 6px; letter-spacing:-.01em; }
.meta { color:var(--text-secondary); font-size:13px; margin:0; }
code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.92em;
  background:var(--callout); padding:1px 5px; border-radius:4px; }
.theme-toggle { background:var(--surface-1); color:var(--text-secondary); border:1px solid var(--border);
  border-radius:8px; padding:7px 12px; font:inherit; font-size:13px; cursor:pointer; }
.theme-toggle:hover { color:var(--text-primary); }

.callout { background:var(--callout); border-radius:10px; padding:14px 16px; margin:20px 0 28px;
  color:var(--text-secondary); font-size:13.5px; }
.callout strong { color:var(--text-primary); }

.hero-row { display:grid; grid-template-columns:minmax(250px,1fr) 1.6fr; gap:16px; margin-bottom:22px; }
.hero, .tile { background:var(--surface-1); border:1px solid var(--border); border-radius:12px; padding:18px 20px; }
.hero-label, .tile-label { color:var(--text-secondary); font-size:13px; }
/* Proportional figures on the hero and the tiles: tabular-nums gives every
   digit the width of a zero, which reads loose at display sizes. */
.hero-value { font-size:52px; font-weight:650; line-height:1.1; margin:6px 0 8px; letter-spacing:-.02em; }
.hero-note, .tile-note { color:var(--muted); font-size:12.5px; line-height:1.45; }
.tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(158px,1fr)); gap:16px; }
.tile-value { font-size:30px; font-weight:650; margin:4px 0 6px; letter-spacing:-.01em; }

.card { background:var(--surface-1); border:1px solid var(--border); border-radius:12px;
  padding:20px 22px 18px; margin-bottom:22px; }
.card h2 { font-size:17px; font-weight:620; margin:0 0 6px; }
.sub { color:var(--text-secondary); font-size:13.5px; margin:0 0 18px; max-width:74ch; }
.sub strong { color:var(--text-primary); }
.empty { color:var(--muted); font-size:13.5px; }

.legend { display:flex; gap:18px; flex-wrap:wrap; margin-bottom:8px; color:var(--text-secondary); font-size:13px; }
.legend-item { display:inline-flex; align-items:center; gap:7px; }
.swatch { width:11px; height:11px; border-radius:3px; display:inline-block; flex:none; }

/* The SVG scales with its viewBox, so at phone width a 12px label would render
   at about 4px. Below the breakpoint the chart keeps a legible minimum width and
   the card scrolls it sideways instead — a swipe beats a magnifying glass. */
.chart { margin:0; overflow-x:auto; overscroll-behavior-x:contain; }
.chart svg { width:100%; height:auto; display:block; overflow:visible; }
.grid { stroke:var(--grid); stroke-width:1; }
.axis { stroke:var(--axis); stroke-width:1; }
.line { fill:none; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
.dot { stroke:var(--surface-1); stroke-width:2; }
/* Text wears text tokens, never the series colour — identity comes from the
   coloured mark beside it. */
.tick { fill:var(--muted); font-size:12px; font-variant-numeric:tabular-nums; }
.tick-y { text-anchor:end; }
.tick-x { text-anchor:middle; }
.axis-title { fill:var(--text-secondary); font-size:12.5px; text-anchor:middle; }
.end-label { fill:var(--text-secondary); font-size:12.5px; font-weight:600; }
.cat-label { fill:var(--text-primary); font-size:13px; text-anchor:end; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
.cat-note { fill:var(--muted); font-size:11px; text-anchor:end; }
.bar-value { fill:var(--text-secondary); font-size:12.5px; font-weight:600; }
.hover-band { fill:transparent; }
.hover-band:hover { fill:var(--text-primary); fill-opacity:.04; }
.bar:hover { fill-opacity:.85; }

.tooltip { position:fixed; pointer-events:none; z-index:10; opacity:0; transition:opacity .08s;
  background:var(--surface-1); border:1px solid var(--border); border-radius:8px;
  padding:9px 11px; font-size:12.5px; color:var(--text-primary);
  box-shadow:0 6px 24px rgba(0,0,0,.18); min-width:168px; }
.tooltip.on { opacity:1; }
.tt-title { color:var(--text-secondary); font-size:11.5px; margin-bottom:5px; }
.tt-row { display:flex; justify-content:space-between; gap:18px; }
.tt-row + .tt-row { margin-top:3px; }
.tt-key { display:inline-flex; align-items:center; gap:6px; color:var(--text-secondary); }
.tt-val { font-variant-numeric:tabular-nums; font-weight:600; }

.table-view { margin-top:16px; border-top:1px solid var(--border); padding-top:12px; }
.table-view summary { cursor:pointer; color:var(--text-secondary); font-size:13px; }
.table-view summary:hover { color:var(--text-primary); }
.table-scroll { overflow-x:auto; margin-top:12px; }
table { border-collapse:collapse; font-size:13px; width:100%; }
th, td { text-align:right; padding:6px 12px; white-space:nowrap; font-variant-numeric:tabular-nums; }
th:first-child, td:first-child { text-align:left; font-variant-numeric:normal; }
thead th { color:var(--text-secondary); font-weight:600; border-bottom:1px solid var(--border); }
tbody tr + tr td { border-top:1px solid var(--grid); }

.timings { display:grid; gap:18px; }
.timing-head { font-weight:620; margin-bottom:4px; }
.timing-body { color:var(--text-secondary); font-size:13.5px; max-width:80ch; }
.timing-body strong { color:var(--text-primary); font-variant-numeric:tabular-nums; }

.missing { color:var(--muted); font-size:13px; }
footer { color:var(--muted); font-size:12.5px; margin-top:28px; line-height:1.6; }

@media (max-width:760px) {
  .hero-row { grid-template-columns:1fr; }
  .hero-value { font-size:42px; }
  .chart svg { min-width:620px; }
}
</style>
</head>
<body>
<div class="wrap">
<header>
  <div>
    <h1>Voxal performance benchmark</h1>
    <p class="meta">${esc(env.platform ?? '?')}/${esc(env.arch ?? '?')} &middot; ${esc(env.cpus ?? '?')} cores${
    env.cpuModel ? ` (${esc(env.cpuModel)})` : ''
  } &middot; network <code>${esc(env.label ?? 'unknown')}</code><br>${esc(m.runCount)} runs &middot; ${esc(
    m.at ?? ''
  )} &middot; run <code>${esc(String(m.file).split('/').pop().replace(/\.ndjson$/, ''))}</code></p>
  </div>
  <button class="theme-toggle" id="theme-toggle" type="button">Theme</button>
</header>

<div class="callout">
  <strong>Read these numbers with their limits.</strong> Every peer of a room runs in one
  browser on one machine over loopback, so latency is a <strong>floor</strong>, not a field
  measurement, and CPU and memory are <strong>whole-room</strong> totals that must not be divided
  by the peer count. Nothing here asserts a threshold — the suite only checks that the call was
  working, so a zero means &ldquo;this cost nothing&rdquo;, never &ldquo;this never connected&rdquo;.
  See <code>docs/benchmarking.md</code>.
</div>

${body}

<footer>
  Generated by <code>make bench</code> &middot; the raw run sits beside this file as
  <code>.ndjson</code>, with a per-peer <code>.csv</code> for plotting elsewhere.<br>
  To compare against Discord, Zoom, Teams or Jitsi, follow the external method in
  <code>docs/benchmarking.md</code> — measuring them from outside the process is the only fair
  way, and on macOS that means summing all four of a Tauri app's processes.
</footer>
</div>

<div class="tooltip" id="tooltip" role="status" aria-live="polite"></div>

<script>
(function () {
  // Theme: system by default, with a toggle that beats it in both directions.
  var root = document.documentElement;
  var btn = document.getElementById('theme-toggle');
  var stored = null;
  try { stored = localStorage.getItem('bench-theme'); } catch (e) {}
  if (stored) { root.setAttribute('data-theme', stored); }
  function labelFor(t) { return t === 'system' ? 'Theme' : 'Theme: ' + t; }
  btn.textContent = labelFor(root.getAttribute('data-theme') || 'system');
  btn.addEventListener('click', function () {
    var order = ['system', 'light', 'dark'];
    var next = order[(order.indexOf(root.getAttribute('data-theme') || 'system') + 1) % 3];
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('bench-theme', next); } catch (e) {}
    btn.textContent = labelFor(next);
  });

  // Hover layer. Every value it shows is also in the table twin under its
  // chart, so the tooltip enhances and never gates.
  var tip = document.getElementById('tooltip');
  function show(el, ev) {
    var rows;
    try { rows = JSON.parse(el.getAttribute('data-rows') || '[]'); } catch (e) { rows = []; }
    tip.innerHTML =
      '<div class="tt-title">' + (el.getAttribute('data-title') || '') + '</div>' +
      rows.map(function (r, i) {
        return '<div class="tt-row"><span class="tt-key">' +
          '<span class="swatch" style="background:var(--series-' + (i + 1) + ')"></span>' +
          r.k + '</span><span class="tt-val">' + r.v + '</span></div>';
      }).join('');
    tip.classList.add('on');
    var w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(window.innerWidth - w - 12, ev.clientX + 14)) + 'px';
    tip.style.top = Math.max(8, ev.clientY - h - 12) + 'px';
  }
  function hide() { tip.classList.remove('on'); }
  document.querySelectorAll('.hover-band,.bar').forEach(function (el) {
    el.addEventListener('mousemove', function (ev) { show(el, ev); });
    el.addEventListener('mouseleave', hide);
  });
  document.addEventListener('scroll', hide, true);
})();
</script>
</body>
</html>
`;
}
