#!/usr/bin/env node
// The integration bench (docs/integration-evaluation.md): real footage
// (scripts/integration-footage.mjs) through Voxal's real camera pipeline, into
// the animated scenes, under compositing variants — and a blind judging page
// that compares the variants two by two.
//
//   node scripts/integration-bench.mjs                                  every clip, office + cybercafe, shipped vs plain
//   node scripts/integration-bench.mjs --clips glasses,"low light" --scenes office,island,mountain
//   node scripts/integration-bench.mjs --variants shipped,no-wrap,no-shadow
//   node scripts/integration-bench.mjs --engine mediapipe --frames 60 --label quick
//   node scripts/integration-bench.mjs --no-video                       measurements only (no judging page)
//   node scripts/integration-bench.mjs --tally judgments.json           the judging page's export, as markdown
//
// Options: --engine longpipe (the shipped default) | mediapipe | rvm | p3m;
// --cadence app (segment at the app's own rate, as a call does: default) |
// every (every frame); --warm N frames of settling on the first frame (30);
// --seed N for the judging page's order; --swiftshader (software GL; default is
// the real GPU, ANGLE/Metal on a Mac); --headed; --label.
//
// The clock is virtual: one camera frame of pipeline time per step, at the
// clip's own frame rate, so the scene's animation, the look's easing and the
// segmentation cadence behave as in a call however long a step takes. What is
// NOT reproduced: inference latency (the mask is for the frame it is drawn
// with, or the last one segmented) and the load governor (nothing steps down).
//
// Output: bench-results/integration/<label>-<date>/ — report.md, results.json,
// stills/ (camera | composite), videos/ and judge.html (open it from disk).

/* global window, document */
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import os from 'node:os';
import { FOOTAGE, ROOT, rng, schedule, selectClips, wilson } from './integration-lib.mjs';

// Compositing variants: window flags the GL pipeline reads (video-effects.js)
// and/or localStorage preferences. 'shipped' is the app as it is.
export const VARIANTS = {
  shipped: {},
  // A cut-out over the scene and nothing else: none of the scene's light on
  // you, no shadow, no grain. The sanity baseline — if judges do not prefer
  // shipped over this, the integration terms are not earning their place.
  plain: { flags: { __voxalWrapScale: 0, __voxalShadowScale: 0, __voxalSceneFilmOff: true } },
  'no-wrap': { flags: { __voxalWrapScale: 0 } },
  'wrap-x2': { flags: { __voxalWrapScale: 2 } },
  'no-shadow': { flags: { __voxalShadowScale: 0 } },
  'shadow-x2': { flags: { __voxalShadowScale: 2 } },
  'no-film': { flags: { __voxalSceneFilmOff: true } },
  'no-decon': { flags: { __voxalDecon: 0 } },
  'no-edge-motion': { flags: { __voxalNoEdgeMotion: true } },
  'no-hair': { flags: { __voxalNoHairRefine: true } },
  // The light chosen instead of measured: does matching the room beat a
  // fixed, flattering light?
  'light-midday': { storage: { 'scene-light': 'midday' } },
  'light-evening': { storage: { 'scene-light': 'evening' } }
};

const args = process.argv.slice(2);
const opt = {
  clips: [], scenes: ['office', 'cybercafe'], variants: ['shipped', 'plain'], engine: 'longpipe',
  frames: null, warm: 30, cadence: 'app', video: true, swiftshader: false, headed: false,
  label: 'run', seed: 1, longpipeWaitMs: 150, tally: null
};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--clips') opt.clips = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--scenes') opt.scenes = args[++i].split(',');
  else if (a === '--variants') opt.variants = args[++i].split(',');
  else if (a === '--engine') opt.engine = args[++i];
  else if (a === '--frames') opt.frames = +args[++i];
  else if (a === '--warm') opt.warm = +args[++i];
  else if (a === '--cadence') opt.cadence = args[++i];
  else if (a === '--no-video') opt.video = false;
  else if (a === '--swiftshader') opt.swiftshader = true;
  else if (a === '--headed') opt.headed = true;
  else if (a === '--label') opt.label = args[++i];
  else if (a === '--seed') opt.seed = +args[++i];
  else if (a === '--longpipe-wait-ms') opt.longpipeWaitMs = +args[++i];
  else if (a === '--tally') opt.tally = args[++i];
  else { console.error('unknown option ' + a); process.exit(2); }
}
for (const v of opt.variants) if (!VARIANTS[v]) { console.error(`unknown variant ${v} (${Object.keys(VARIANTS).join(', ')})`); process.exit(2); }

// --- a static server with the app's isolation headers ------------------------

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.onnx': 'application/octet-stream',
  '.tflite': 'application/octet-stream', '.css': 'text/css', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream',
  '.glb': 'model/gltf-binary' };

function serve() {
  const roots = [['/__footage/', FOOTAGE], ['/__integration/', join(ROOT, 'tests', 'bench', 'integration')], ['/', join(ROOT, 'src')]];
  const server = createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const [prefix, dir] = roots.find(([p]) => url.startsWith(p));
    const path = normalize(join(dir, url.slice(prefix.length)));
    if (!path.startsWith(dir) || !existsSync(path) || statSync(path).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[extname(path)] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'no-store'
    });
    createReadStream(path).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

function dataUrlBytes(u) { return Buffer.from(u.slice(u.indexOf(',') + 1), 'base64'); }

function encode(frameDir, fps, file) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(fps), '-i', join(frameDir, '%04d.jpg'),
    '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file]);
}

async function machine(page) {
  return page.evaluate(() => {
    const c = document.createElement('canvas'), gl = c.getContext('webgl2');
    const x = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return { renderer: gl ? gl.getParameter(x ? x.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : null, ua: navigator.userAgent };
  });
}

async function main() {
  const manifestFile = join(FOOTAGE, 'manifest.json');
  if (!existsSync(manifestFile)) { console.error('No footage: run `make integration-footage` first.'); process.exit(1); }
  const have = JSON.parse(readFileSync(manifestFile, 'utf8')).clips;
  const wanted = new Set(selectClips(have.map((c) => ({ ...c, use: true, download: c.link })), opt.clips).map((c) => c.id));
  const clips = have.filter((c) => wanted.has(c.id));
  if (!clips.length) { console.error('no fetched clip matches; fetch with `make integration-footage ARGS="--clips …"`'); process.exit(2); }
  if (opt.video) execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });

  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const gpuArgs = opt.swiftshader ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    : ['--enable-gpu', '--use-angle=metal', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'];
  const browser = await chromium.launch({ headless: !opt.headed, args: [...gpuArgs, '--autoplay-policy=no-user-gesture-required'] });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const runId = `${opt.label}-${stamp}`;
  const outDir = join(ROOT, 'bench-results', 'integration', runId);
  for (const d of ['stills', 'videos']) mkdirSync(join(outDir, d), { recursive: true });
  const results = { runId, options: opt, host: { cpu: os.cpus()[0].model, cores: os.cpus().length, platform: os.platform() + ' ' + os.release() }, runs: [] };

  for (const clip of clips) for (const scene of opt.scenes) for (const variant of opt.variants) {
    const v = VARIANTS[variant];
    const tag = `${clip.id}__${scene}__${variant}`;
    const nFrames = Math.min(opt.frames || clip.frames, clip.frames);
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    const page = await ctx.newPage();
    const logs = [];
    page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') logs.push(m.text()); });
    page.on('pageerror', (err) => logs.push('pageerror: ' + err.message));
    process.stdout.write(`· ${clip.id} ${scene} ${variant} … `);
    const t0 = Date.now();
    const frameDir = opt.video ? mkdtempSync(join(os.tmpdir(), 'voxal-int-')) : null;
    try {
      await page.goto(base + '/__integration/harness.html');
      if (!results.machine) results.machine = await machine(page);
      const setup = await page.evaluate((o) => window.H.setup(o), {
        clip: clip.id, w: clip.width, h: clip.height, fps: clip.fps, mode: 'preset:' + scene, engine: opt.engine,
        flags: v.flags || {}, storage: v.storage || {}, cadence: opt.cadence, warm: opt.warm, longpipeWaitMs: opt.longpipeWaitMs
      });
      const mid = Math.floor(nFrames / 2);
      for (let f = 0; f < nFrames; f++) {
        const r = await page.evaluate(([i, w]) => window.H.step(i, w), [f, { jpeg: opt.video, still: f === mid }]);
        if (r.jpeg) writeFileSync(join(frameDir, String(f).padStart(4, '0') + '.jpg'), dataUrlBytes(r.jpeg));
        if (r.still) writeFileSync(join(outDir, 'stills', tag + '.jpg'), dataUrlBytes(r.still));
      }
      const res = await page.evaluate(() => window.H.result());
      if (opt.video) encode(frameDir, clip.fps, join(outDir, 'videos', tag + '.mp4'));
      results.runs.push({ clip: clip.id, situation: clip.situation, scene, variant, setup, result: res, logs: logs.slice(-6) });
      const s = res.scores, g = (k, d = 1) => (s[k] ? s[k].mean.toFixed(d) : '–');
      console.log(`${res.engine}: black ${g('dBlack', 0)} white ${g('dWhite', 0)} sat× ${g('satRatio', 2)} noise× ${g('noiseRatio', 2)} edge ${g('edgeFlickerNet', 2)} exp ${res.look.exposure ? res.look.exposure.toFixed(2) : '–'} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
      if (setup.engine !== opt.engine) console.log(`   engine fell back to ${setup.engine}`);
      if (res.framesWithoutMask) console.log(`   no mask on ${res.framesWithoutMask} of ${nFrames} frames (${res.engine})`);
    } catch (err) {
      console.log('FAILED: ' + err.message.split('\n')[0]);
      results.runs.push({ clip: clip.id, situation: clip.situation, scene, variant, error: err.message, logs: logs.slice(-10) });
    }
    if (frameDir) rmSync(frameDir, { recursive: true, force: true });
    await ctx.close();
    writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  }
  await browser.close();
  server.close();
  writeFileSync(join(outDir, 'report.md'), report(results));
  if (opt.video && opt.variants.length > 1) writeJudge(outDir, results);
  console.log('→ ' + outDir);
}

// --- report ------------------------------------------------------------------

const METRICS = [
  ['dBlack', 'Δ black', 0], ['dWhite', 'Δ white', 0], ['dMid', 'Δ mid', 0], ['satRatio', 'sat ×', 2],
  ['noiseRatio', 'noise ×', 2], ['sharpRatio', 'sharp ×', 2], ['dBgVsSubject', 'Δ bg vs you', 0],
  ['edgeFlickerNet', 'edge flicker', 2], ['sceneChurn', 'scene churn', 2]
];
const fmt = (v, d) => (v === null || v === undefined || !isFinite(v) ? '–' : v.toFixed(d));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

export function report(results) {
  const L = [], m = results.machine || {}, ok = results.runs.filter((r) => r.result);
  L.push(`# Integration bench — ${results.runId}`, '');
  L.push(`Host: ${results.host.cpu}, ${results.host.cores} cores, ${results.host.platform}. WebGL: ${m.renderer || '?'}.`);
  L.push(`Engine ${results.options.engine}, cadence ${results.options.cadence}, warm-up ${results.options.warm} frames.`, '');
  L.push('Background region of the composite against the same region of the camera frame. Δ in 8-bit levels (0 = the scene sits where this camera put the real room), ratios ×1 = the same. Black, white and noise are the most content-independent; mid, saturation and sharpness also depend on what the scene shows. Edge flicker: the composite\'s change at your edge where the camera held still, minus the scene\'s own churn. None of these says a picture is right — the judging page does.', '');
  const variants = [...new Set(ok.map((r) => r.variant))];
  L.push('## By variant (mean over clips and scenes)', '');
  L.push('| variant | runs | ' + METRICS.map((x) => x[1]).join(' | ') + ' |');
  L.push('|---|---|' + METRICS.map(() => '---').join('|') + '|');
  for (const v of variants) {
    const rs = ok.filter((r) => r.variant === v);
    L.push(`| ${v} | ${rs.length} | ` + METRICS.map(([k, , d]) => fmt(mean(rs.map((r) => r.result.scores[k] && r.result.scores[k].mean).filter((x) => x != null)), d)).join(' | ') + ' |');
  }
  L.push('', '## What the pipeline measured about the light (per clip)', '');
  L.push('| clip | situation | exposure | side | dirX | hard | motion | tint |', '|---|---|---|---|---|---|---|---|');
  const seen = new Set();
  for (const r of ok) {
    if (seen.has(r.clip) || r.variant !== variants[0]) continue;
    seen.add(r.clip);
    const l = r.result.look;
    L.push(`| ${r.clip} | ${r.situation} | ${fmt(l.exposure, 2)} | ${fmt(l.side, 2)} | ${fmt(l.dirX, 2)} | ${fmt(l.hard, 2)} | ${fmt(l.motion, 2)} | ${l.tint ? l.tint.map((x) => x.toFixed(2)).join(' ') : '–'} |`);
  }
  L.push('', '## Every run', '');
  L.push('| clip | situation | scene | variant | ' + METRICS.map((x) => x[1]).join(' | ') + ' |');
  L.push('|---|---|---|---|' + METRICS.map(() => '---').join('|') + '|');
  for (const r of ok) {
    L.push(`| ${r.clip} | ${r.situation} | ${r.scene} | ${r.variant} | ` + METRICS.map(([k, , d]) => fmt(r.result.scores[k] && r.result.scores[k].mean, d)).join(' | ') + ' |');
  }
  const blind = ok.filter((r) => r.result.framesWithoutMask);
  if (blind.length) {
    L.push('', '## Runs with frames the engine gave no mask for (left out of the judging page)', '');
    for (const r of blind) L.push(`- ${r.clip} ${r.scene} ${r.variant}: ${r.result.framesWithoutMask} frames (${r.result.engine})`);
  }
  const bad = results.runs.filter((r) => r.error);
  if (bad.length) {
    L.push('', '## Failed runs', '');
    for (const r of bad) L.push(`- ${r.clip} ${r.scene} ${r.variant}: ${r.error.split('\n')[0]}`);
  }
  return L.join('\n') + '\n';
}

// --- the blind judging page ---------------------------------------------------

function writeJudge(outDir, results) {
  const ok = results.runs.filter((r) => r.result && !(r.result.framesWithoutMask > 0));
  const cells = [];
  for (const r of ok) {
    if (cells.some((c) => c.clip === r.clip && c.scene === r.scene)) continue;
    const vs = results.options.variants.filter((v) => ok.some((x) => x.clip === r.clip && x.scene === r.scene && x.variant === v));
    if (vs.length > 1) cells.push({ clip: r.clip, situation: r.situation, scene: r.scene, variants: vs });
  }
  const trials = cells.flatMap((c) => schedule([{ clip: c.clip, situation: c.situation, scene: c.scene }], c.variants, results.options.seed + hash(c.clip + c.scene)));
  const r = rng(results.options.seed), shuffled = trials.slice();
  for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
  const data = { runId: results.runId, variants: results.options.variants, trials: shuffled.map((t) => ({
    clip: t.clip, situation: t.situation, scene: t.scene, left: t.left, right: t.right,
    a: `videos/${t.clip}__${t.scene}__${t.left}.mp4`, b: `videos/${t.clip}__${t.scene}__${t.right}.mp4` })) };
  const tpl = readFileSync(join(ROOT, 'tests', 'bench', 'integration', 'judge.html'), 'utf8');
  writeFileSync(join(outDir, 'judge.html'), tpl.replace('/*JUDGE_DATA*/null', JSON.stringify(data).replace(/</g, '\\u003c')));
}

function hash(s) { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; return h; }

// --tally: the judging page's export, as markdown.
export function tally(j) {
  const L = [`# Judgements — ${j.runId}${j.judge ? ' (' + j.judge + ')' : ''}`, ''];
  const pairs = {};
  for (const t of j.trials) {
    if (!t.choice) continue;
    const [x, y] = [t.left, t.right].sort();
    const p = pairs[x + ' vs ' + y] || (pairs[x + ' vs ' + y] = { x, y, wx: 0, wy: 0, tie: 0, by: {} });
    const win = t.choice === 'tie' ? null : (t.choice === 'left' ? t.left : t.right);
    if (win === null) p.tie++; else if (win === x) p.wx++; else p.wy++;
    for (const key of ['scene:' + t.scene, 'situation:' + t.situation]) {
      const b = p.by[key] || (p.by[key] = { wx: 0, wy: 0, tie: 0 });
      if (win === null) b.tie++; else if (win === x) b.wx++; else b.wy++;
    }
  }
  for (const [name, p] of Object.entries(pairs)) {
    const n = p.wx + p.wy, [lo, hi] = wilson(p.wx, n);
    L.push(`## ${name}`, '', `${p.x} preferred ${p.wx} times, ${p.y} ${p.wy}, no difference ${p.tie}. ${p.x} win rate ${n ? (100 * p.wx / n).toFixed(0) : '–'}% (95% CI ${(100 * lo).toFixed(0)}–${(100 * hi).toFixed(0)}%, ties excluded).`, '');
    L.push(`| subset | ${p.x} | ${p.y} | no diff |`, '|---|---|---|---|');
    for (const [k, b] of Object.entries(p.by).sort()) L.push(`| ${k} | ${b.wx} | ${b.wy} | ${b.tie} |`);
    L.push('');
  }
  return L.join('\n');
}

if (opt.tally) console.log(tally(JSON.parse(readFileSync(opt.tally, 'utf8'))));
else main().catch((e) => { console.error(e); process.exit(1); });
