// Network-usage formatting and chart rendering, shared verbatim by the main
// window (index.html's settings modal) and the desktop preferences window
// (settings.html).
//
// settings.html has no module system, which is why it hand-duplicates constants
// and helpers from main.js. That duplication is how those constants drifted
// before, so anything BOTH surfaces need lives here instead — a plain classic
// script both documents load, exactly like version.js. Nothing in this file
// touches RTCPeerConnection, `connections` or the DOM outside the container it
// is handed, so it is safe in either window.
//
// The data it renders is produced by _collectBandwidthSample() in main.js and,
// on desktop, relayed to settings.html over the `net-usage-state` localStorage
// bridge.

const NET_USAGE_KINDS = ['audio', 'camera', 'screen'];
const NET_USAGE_HISTORY_MAX = 120; // 10 minutes at the 5s stats tick
const NET_USAGE_KIND_LABELS = { audio: 'Voice', camera: 'Camera', screen: 'Screen' };

// A floor for the chart's y-axis. Without it an idle call (a few kb/s of audio
// and nothing else) gets amplified to full height and reads as heavy traffic.
const NET_USAGE_MIN_PEAK_BPS = 64000;

function formatBitrate(bitsPerSecond) {
  var bps = Math.max(0, bitsPerSecond || 0);
  if (bps >= 1000000) return (bps / 1000000).toFixed(1) + ' Mb/s';
  if (bps >= 1000)    return Math.round(bps / 1000) + ' kb/s';
  return Math.round(bps) + ' b/s';
}

/** Sum one direction of one sample across every media kind. */
function netUsageDirectionTotal(sample, dir) {
  if (!sample || !sample[dir]) return 0;
  return NET_USAGE_KINDS.reduce(function(sum, kind) {
    return sum + (sample[dir][kind] || 0);
  }, 0);
}

function netUsageTotals(sample) {
  return { in: netUsageDirectionTotal(sample, 'in'), out: netUsageDirectionTotal(sample, 'out') };
}

/**
 * The tallest total in either direction across the window, floored. Both
 * directions share one scale so ↓ and ↑ can be compared by eye — which is the
 * whole point when the question is "did moving video onto the relay actually
 * cut my upload?".
 */
function netUsagePeak(history) {
  var peak = 0;
  (history || []).forEach(function(sample) {
    peak = Math.max(peak, netUsageDirectionTotal(sample, 'in'), netUsageDirectionTotal(sample, 'out'));
  });
  return Math.max(peak, NET_USAGE_MIN_PEAK_BPS);
}

function _svgEl(name) {
  return document.createElementNS('http://www.w3.org/2000/svg', name);
}

/**
 * One direction as a stacked area chart: audio at the bottom, then camera, then
 * screen. Newest sample sits at the RIGHT edge and a short history draws only
 * the right-hand portion, rather than stretching two minutes of data across a
 * ten-minute axis and implying history that does not exist.
 */
function buildNetUsageArea(history, dir, peak) {
  var W = 280, H = 56;
  var svg = _svgEl('svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('class', 'net-usage-area net-usage-area-' + dir);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', (dir === 'in' ? 'Download' : 'Upload') + ' over the last 10 minutes');

  var samples = history || [];
  if (samples.length < 2) return svg; // a single point is not a line

  var step = W / (NET_USAGE_HISTORY_MAX - 1);
  var x0 = W - (samples.length - 1) * step;
  function xAt(i) { return x0 + i * step; }
  function yAt(v) { return H - (Math.min(v, peak) / peak) * (H - 2) - 1; }

  var lower = samples.map(function() { return 0; });
  NET_USAGE_KINDS.forEach(function(kind) {
    var upper = samples.map(function(sample, i) {
      return lower[i] + (((sample && sample[dir]) || {})[kind] || 0);
    });
    var points = [];
    for (var i = 0; i < samples.length; i++) points.push(xAt(i).toFixed(1) + ',' + yAt(upper[i]).toFixed(1));
    for (var j = samples.length - 1; j >= 0; j--) points.push(xAt(j).toFixed(1) + ',' + yAt(lower[j]).toFixed(1));

    var band = _svgEl('polygon');
    band.setAttribute('points', points.join(' '));
    band.setAttribute('class', 'net-usage-band net-usage-band-' + kind);
    svg.appendChild(band);
    lower = upper;
  });
  return svg;
}

function _netUsageRow(label, node) {
  var row = document.createElement('div');
  row.className = 'net-usage-row';
  var head = document.createElement('div');
  head.className = 'net-usage-row-head';
  head.textContent = label;
  row.appendChild(head);
  row.appendChild(node);
  return row;
}

function buildNetUsageLegend() {
  var legend = document.createElement('div');
  legend.className = 'net-usage-legend';
  NET_USAGE_KINDS.forEach(function(kind) {
    var item = document.createElement('span');
    item.className = 'net-usage-legend-item';
    var swatch = document.createElement('span');
    swatch.className = 'net-usage-swatch net-usage-band-' + kind;
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(NET_USAGE_KIND_LABELS[kind]));
    legend.appendChild(item);
  });
  return legend;
}

/**
 * Render the expanded detail (both charts + legend + scale) into `container`.
 * `snapshot` is {inRoom, current, history} — the same shape main.js publishes
 * over the bridge.
 */
function renderNetUsageDetail(container, snapshot) {
  if (!container) return;
  container.innerHTML = '';
  var history = (snapshot && snapshot.history) || [];

  if (!snapshot || !snapshot.inRoom) {
    var idle = document.createElement('p');
    idle.className = 'settings-hint net-usage-empty';
    idle.textContent = 'Nothing to measure — join a call to see usage.';
    container.appendChild(idle);
    return;
  }
  if (history.length < 2) {
    var warming = document.createElement('p');
    warming.className = 'settings-hint net-usage-empty';
    warming.textContent = 'Measuring…';
    container.appendChild(warming);
    return;
  }

  var peak = netUsagePeak(history);
  var scale = document.createElement('div');
  scale.className = 'net-usage-scale';
  scale.textContent = 'peak ' + formatBitrate(peak);
  container.appendChild(scale);

  container.appendChild(_netUsageRow('↓ Download', buildNetUsageArea(history, 'in', peak)));
  container.appendChild(_netUsageRow('↑ Upload', buildNetUsageArea(history, 'out', peak)));

  var axis = document.createElement('div');
  axis.className = 'net-usage-axis';
  var left = document.createElement('span');
  left.textContent = '10 min ago';
  var right = document.createElement('span');
  right.textContent = 'now';
  axis.appendChild(left);
  axis.appendChild(right);
  container.appendChild(axis);

  container.appendChild(buildNetUsageLegend());
}

/** Render the always-visible summary row (the ↓/↑ totals). */
function renderNetUsageSummary(inEl, outEl, snapshot) {
  var totals = netUsageTotals(snapshot && snapshot.current);
  var live = !!(snapshot && snapshot.inRoom && snapshot.current);
  if (inEl)  inEl.textContent  = live ? formatBitrate(totals.in)  : '—';
  if (outEl) outEl.textContent = live ? formatBitrate(totals.out) : '—';
}
