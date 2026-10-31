#!/usr/bin/env node
// The matting evaluation's benchmark (docs/matting-evaluation.md): every
// segmentation engine through Voxal's real camera pipeline, on identical
// footage with a known alpha (scripts/matting-footage.mjs), into the same
// background with the same settings.
//
//   node scripts/matting-bench.mjs                         quality: all engines, all rooms, 640x360 + 1280x720
//   node scripts/matting-bench.mjs --engines mediapipe,rvm --rooms living --res 1280x720 --frames 120
//   node scripts/matting-bench.mjs --realtime              performance: the Processor's own loop at 30 fps
//   node scripts/matting-bench.mjs --variants              compositing switches, A/B (ALL_VARIANTS)
//   node scripts/matting-bench.mjs --variant-names shipped,linear,linear&dilate0   chosen ones; a&b combines
//   node scripts/matting-bench.mjs --swiftshader           software GL (default: the real GPU, ANGLE/Metal on a Mac)
//   node scripts/matting-bench.mjs --headed --label m5
//   node scripts/matting-bench.mjs --render a/results.json[,b/results.json]   the report of saved runs (merged), again
//
// Engines: mediapipe | longpipe | rvm (MobileNetV3, 512 px input) |
// rvm-hi (MobileNetV3, the camera's own size, RVM's recommended downsample) |
// rvm-resnet (ResNet50, 512 px). RVM needs `make rvm-assets` (resnet:
// ARGS=--with-resnet); Longpipe fetches its weights from cdn.longpipe.dev.
//
// Quality mode steps the Processor by hand, one frame at a time: each engine
// is given exactly frame N and its mask for frame N is composited onto frame N
// (no lag, by construction — the lag is real time's business). Longpipe runs
// its own pipeline on a stream and cannot be stepped: it is held on frame N for
// --longpipe-wait-ms before its mask is read, which is generous to it.
//
// Scores (lower is better unless noted), outside the burnt-in caption's box:
//   maskMAE      |mask - truth|, x1000, at the camera's size (mask upsampled as the GL pipeline does)
//   maskBandMAE  the same over the edge band only (8 px each side at 1280 wide, and every partial pixel)
//   iou          intersection over union at 0.5 (higher is better)
//   dtSSD        temporal error: the mask's frame-to-frame change against the truth's (x100) — flicker AND lag
//   flicker     |mask change| where the truth did not change, x1000
//   comp*        |composite - truth composite| in 0-255 over: All / Outer ring (truth 0: halo) /
//                Mixed (partial pixels: hair) / Inner ring (truth 1: eaten edge)
//   compDt       the composite's frame-to-frame change against the truth's, over the edge band, 0-255: flicker and trailing
//   leak         share of the OLD room left in the composite's edge band, % (0 = none; negative = over-corrected)
//
// Output: bench-results/matting/<label>-<date>/ (report.md, results.json, PNG stills).

/* global window, document, self */
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FOOTAGE = join(ROOT, 'bench-results', 'matting', 'footage');

const args = process.argv.slice(2);
const opt = {
  engines: ['mediapipe', 'longpipe', 'rvm', 'rvm-hi', 'rvm-resnet'],
  rooms: ['wall', 'living', 'kitchen'],
  res: [[640, 360], [1280, 720]],
  frames: null, realtime: false, variants: false, swiftshader: false, headed: false,
  label: 'run', longpipeWaitMs: 150, seconds: 10, stills: [60, 150, 225]
};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--engines') opt.engines = args[++i].split(',');
  else if (a === '--rooms') opt.rooms = args[++i].split(',');
  else if (a === '--res') opt.res = args[++i].split(',').map((r) => r.split('x').map(Number));
  else if (a === '--frames') opt.frames = +args[++i];
  else if (a === '--realtime') opt.realtime = true;
  else if (a === '--variants') opt.variants = true;
  else if (a === '--variant-names') { opt.variants = true; opt.variantNames = args[++i].split(','); }
  else if (a === '--swiftshader') opt.swiftshader = true;
  else if (a === '--headed') opt.headed = true;
  else if (a === '--label') opt.label = args[++i];
  else if (a === '--longpipe-wait-ms') opt.longpipeWaitMs = +args[++i];
  else if (a === '--seconds') opt.seconds = +args[++i];
  else if (a === '--stills') opt.stills = args[++i].split(',').map(Number);
  else if (a === '--render') opt.render = args[++i];
  else { console.error('unknown option ' + a); process.exit(2); }
}

const ENGINES = {
  mediapipe: { engine: 'mediapipe' },
  longpipe: { engine: 'longpipe' },
  rvm: { engine: 'rvm', rvm: { model: 'mobilenetv3_fp32', size: 512 } },
  'rvm-fp16': { engine: 'rvm', rvm: { model: 'mobilenetv3_fp16', size: 512 } },
  'rvm-hi': { engine: 'rvm', rvm: { model: 'mobilenetv3_fp32', size: 'camera' } },
  'rvm-resnet': { engine: 'rvm', rvm: { model: 'resnet50_fp32', size: 512 } },
  'rvm-wasm': { engine: 'rvm', rvm: { model: 'mobilenetv3_fp32', size: 512, ep: 'wasm' } },
  // The ground truth through the pipeline: no model error, only the
  // pipeline's own. -mp keeps MediaPipe's settings (cut, dilate 3), -matte
  // a matte engine's (no cut, dilate ~1), at the mask sizes the engines use.
  'oracle-mp': { engine: 'mediapipe', oracle: [256, 144] },
  'oracle-matte': { engine: 'mediapipe', oracle: [256, 144], maskCut: 0, flags: { __voxalDilate: 1.0 } },
  'oracle-matte512': { engine: 'mediapipe', oracle: [512, 288], maskCut: 0, flags: { __voxalDilate: 1.0 } }
};

// --- a static server with the app's isolation headers ------------------------

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.onnx': 'application/octet-stream',
  '.tflite': 'application/octet-stream', '.css': 'text/css', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream' };

function serve() {
  const roots = [['/__footage/', FOOTAGE], ['/__matting/', join(ROOT, 'tests', 'bench', 'matting')], ['/', join(ROOT, 'src')]];
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

// --- runs --------------------------------------------------------------------

function rvmFor(e, w) {
  if (!e.rvm) return undefined;
  const r = { ...e.rvm };
  if (r.size === 'camera') { r.size = w; r.ratio = Math.min(1, 512 / w); }
  return r;
}

async function machine(page) {
  return page.evaluate(async () => {
    const c = document.createElement('canvas'), gl = c.getContext('webgl2');
    const x = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = gl ? gl.getParameter(x ? x.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : null;
    let webgpu = false;
    try { webgpu = !!(navigator.gpu && await navigator.gpu.requestAdapter()); } catch (e) { /* none */ }
    return { renderer, webgpu, ua: navigator.userAgent, isolated: self.crossOriginIsolated, cores: navigator.hardwareConcurrency };
  });
}

async function main() {
  if (!existsSync(join(FOOTAGE, 'manifest.json'))) {
    console.error('No footage: run `make matting-footage` first.');
    process.exit(1);
  }
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const gpuArgs = opt.swiftshader ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    : ['--enable-gpu', '--use-angle=metal', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'];
  const browser = await chromium.launch({ headless: !opt.headed, args: [...gpuArgs, '--autoplay-policy=no-user-gesture-required'] });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const outDir = join(ROOT, 'bench-results', 'matting', `${opt.label}-${stamp}`);
  mkdirSync(outDir, { recursive: true });
  const results = { options: opt, host: { cpu: os.cpus()[0].model, cores: os.cpus().length, mem: os.totalmem(), platform: os.platform() + ' ' + os.release() }, runs: [] };
  const manifest = JSON.parse((await import('node:fs')).readFileSync(join(FOOTAGE, 'manifest.json'), 'utf8'));
  const nFrames = Math.min(opt.frames || manifest.frames, manifest.frames);

  const runs = [];
  if (opt.realtime) {
    for (const e of opt.engines) for (const [w, h] of opt.res) runs.push({ kind: 'realtime', name: e, w, h });
  } else if (opt.variants) {
    for (const v of VARIANTS) for (const e of opt.engines) for (const room of opt.rooms) for (const [w, h] of opt.res) runs.push({ kind: 'quality', name: e, variant: v.name, flags: v.flags, room, w, h });
  } else {
    for (const e of opt.engines) for (const room of opt.rooms) for (const [w, h] of opt.res) runs.push({ kind: 'quality', name: e, variant: 'shipped', flags: {}, room, w, h });
  }

  for (const r of runs) {
    const e = ENGINES[r.name];
    if (!e) { console.error('unknown engine ' + r.name); continue; }
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 800 } });
    const page = await ctx.newPage();
    const logs = [];
    page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') logs.push(m.text()); });
    page.on('pageerror', (err) => logs.push('pageerror: ' + err.message));
    await page.goto(base + '/__matting/harness.html');
    if (!results.machine) results.machine = await machine(page);
    const label = `${r.name}${r.variant && r.variant !== 'shipped' ? '+' + r.variant : ''} ${r.kind === 'quality' ? r.room + ' ' : ''}${r.w}x${r.h}`;
    process.stdout.write('· ' + label + ' … ');
    const t0 = Date.now();
    try {
      if (r.kind === 'realtime') {
        const res = await page.evaluate((o) => window.H.realtime(o),
          { engine: e.engine, rvm: rvmFor(e, r.w), w: r.w, h: r.h, seconds: opt.seconds });
        const cdp = await ctx.newCDPSession(page);
        await cdp.send('Performance.enable');
        const pm = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
        res.jsHeapMB = pm.JSHeapUsedSize / 1048576;
        results.runs.push({ ...r, result: res, logs: logs.slice(-6) });
        console.log(`${res.engine} out ${res.outFps.toFixed(1)} fps, mask age p50 ${res.maskAgeMsP50 === null ? '–' : res.maskAgeMsP50.toFixed(0)} ms (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
      } else {
        const setup = await page.evaluate((o) => window.H.setup(o), {
          engine: e.engine, rvm: rvmFor(e, r.w), room: r.room, w: r.w, h: r.h,
          flags: { ...(e.flags || {}), ...(r.flags || {}) }, longpipeWaitMs: opt.longpipeWaitMs,
          oracle: e.oracle, maskCut: e.maskCut
        });
        const stills = {};
        for (let f = 0; f < nFrames; f++) {
          await page.evaluate((i) => window.H.step(i), f);
          if (opt.stills.includes(f)) stills[f] = await page.evaluate(() => [window.H.snapshot(), window.H.maskSnapshot()]);
        }
        const res = await page.evaluate(() => window.H.result());
        res.setup = setup;
        const tag = `${r.name}${r.variant !== 'shipped' ? '+' + r.variant : ''}-${r.room}-${r.w}`;
        for (const [f, [comp, mask]] of Object.entries(stills)) {
          writeFileSync(join(outDir, `${tag}-f${f}-comp.png`), Buffer.from(comp.split(',')[1], 'base64'));
          writeFileSync(join(outDir, `${tag}-f${f}-mask.png`), Buffer.from(mask.split(',')[1], 'base64'));
        }
        results.runs.push({ ...r, result: res, logs: logs.slice(-6) });
        const s = res.scores;
        console.log(`${res.engine} mask ${res.maskSize}: maskMAE ${s.maskMAE.mean.toFixed(1)} band ${s.maskBandMAE.mean.toFixed(0)} dtSSD ${s.dtSSD ? s.dtSSD.mean.toFixed(2) : '–'} comp ${s.compMAE.mean.toFixed(2)} cdt ${s.compDt ? s.compDt.mean.toFixed(2) : '–'} leak ${s.leak ? s.leak.mean.toFixed(1) : '–'}% (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
        if (setup.fallback) console.log('   fallback: ' + setup.fallback);
      }
    } catch (err) {
      console.log('FAILED: ' + err.message.split('\n')[0]);
      results.runs.push({ ...r, error: err.message, logs: logs.slice(-10) });
    }
    await ctx.close();
    writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  }
  await browser.close();
  server.close();
  writeFileSync(join(outDir, 'report.md'), report(results));
  console.log('→ ' + outDir);
}

// Compositing variants for --variants: each a set of window flags the GL
// pipeline reads (video-effects.js). 'shipped' is the baseline.
const ALL_VARIANTS = [
  { name: 'shipped', flags: {} },
  { name: 'linear', flags: { __voxalLinearComposite: true } },
  { name: 'nohair', flags: { __voxalNoHairRefine: true } },
  { name: 'nodecon', flags: { __voxalDecon: 0 } },
  { name: 'decon1', flags: { __voxalDecon: 1 } },
  { name: 'dilate0', flags: { __voxalDilate: 0 } },
  { name: 'dilate0.5', flags: { __voxalDilate: 0.5 } },
  { name: 'dilate1', flags: { __voxalDilate: 1 } },
  { name: 'dilate1.5', flags: { __voxalDilate: 1.5 } },
  { name: 'dilate2', flags: { __voxalDilate: 2 } },
  { name: 'noblend', flags: { __voxalMaskBlend: [1, 1] } },
  { name: 'blend-sym', flags: { __voxalMaskBlend: [0.6, 0.6] } },
  { name: 'rvmfg', flags: { __voxalRvmFg: true } },
  // A true matte needs no re-ramp: the composite's smoothstep(lo, hi) and the
  // feather were made for MediaPipe's confidence, not for an alpha.
  { name: 'edgeid', flags: { __voxalEdgeOverride: { lo: 0.0, hi: 1.0 } } },
  { name: 'nofeather', flags: { __voxalEdgeOverride: { feather: 0 } } },
  { name: 'feather0.35', flags: { __voxalEdgeOverride: { feather: 0.35 } } },
  { name: 'feather0.7', flags: { __voxalEdgeOverride: { feather: 0.7 } } }
];
const VARIANTS = opt.variantNames ? ALL_VARIANTS.filter((v) => opt.variantNames.includes(v.name)).concat(
  opt.variantNames.filter((n) => n.includes('&')).map((n) => ({ name: n,
    flags: n.split('&').map((p) => ALL_VARIANTS.find((v) => v.name === p).flags).reduce((a, f) => {
      const o = { ...a, ...f };
      if (a.__voxalEdgeOverride && f.__voxalEdgeOverride) o.__voxalEdgeOverride = { ...a.__voxalEdgeOverride, ...f.__voxalEdgeOverride };
      return o;
    }, {}) }))) : ALL_VARIANTS;

function fmt(v, d = 1) { return v === null || v === undefined ? '–' : v.toFixed(d); }

function report(results) {
  const L = [];
  const m = results.machine || {};
  L.push(`# Matting bench — ${results.options.label}`, '');
  L.push(`Host: ${results.host.cpu}, ${results.host.cores} cores, ${(results.host.mem / 2 ** 30).toFixed(0)} GB, ${results.host.platform}`);
  L.push(`Browser: ${m.ua || '?'}; WebGL: ${m.renderer || '?'}; WebGPU: ${m.webgpu ? 'yes' : 'no'}; cross-origin isolated: ${m.isolated}`, '');
  const q = results.runs.filter((r) => r.kind === 'quality' && r.result);
  if (q.length) {
    L.push('## Quality (lower is better, except IoU)', '');
    L.push('| engine | variant | room | size | mask | maskMAE | band | IoU | dtSSD | flicker | comp | outer | mixed | inner | compDt | leak % | infer ms p50 |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of q) {
      const s = r.result.scores, g = (k, d) => fmt(s[k] && s[k].mean, d);
      L.push(`| ${r.name}${r.result.engine !== ENGINES[r.name].engine ? ' (ran ' + r.result.engine + ')' : ''} | ${r.variant} | ${r.room} | ${r.w}x${r.h} | ${r.result.maskSize} | ${g('maskMAE')} | ${g('maskBandMAE', 0)} | ${fmt(s.iou && s.iou.mean, 4)} | ${g('dtSSD', 2)} | ${g('flicker', 2)} | ${g('compMAE', 2)} | ${g('compOuter', 1)} | ${g('compMixed', 1)} | ${g('compInner', 1)} | ${g('compDt', 2)} | ${g('leak', 1)} | ${fmt(r.result.inferMsP50, 1)} |`);
    }
    L.push('');
  }
  const rt = results.runs.filter((r) => r.kind === 'realtime' && r.result);
  if (rt.length) {
    L.push('## Real time (the Processor\'s own loop, camera fed at 30 fps)', '');
    L.push('| engine | size | ran | start ms | out fps | mask Hz | infer ms p50/p95 | runSegment ms p50/p95 | draw ms p50/p95 | mask age ms p50/p95 | long tasks ms/s | JS heap MB |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of rt) {
      const x = r.result, st = x.stats || {};
      const inf = st.engine === 'rvm' ? `${fmt(st.inferMsP50)}/${fmt(st.inferMsP95)}` : (st.engine === 'longpipe' && st.pipeline ? `its model ${fmt(st.pipeline.modelMs)}` : '–');
      const hz = st.maskHz || (st.engine === 'mediapipe' ? x.segHz : null);
      L.push(`| ${r.name} | ${r.w}x${r.h} | ${x.engine} | ${fmt(x.startMs, 0)} | ${fmt(x.outFps)} | ${fmt(hz)} | ${inf} | ${fmt(x.runSegmentMsP50, 2)}/${fmt(x.runSegmentMsP95, 2)} | ${fmt(x.drawMsP50, 2)}/${fmt(x.drawMsP95, 2)} | ${fmt(x.maskAgeMsP50, 0)}/${fmt(x.maskAgeMsP95, 0)} | ${fmt(x.longTaskMsPerS, 0)} | ${fmt(x.jsHeapMB, 0)} |`);
    }
    L.push('');
  }
  const bad = results.runs.filter((r) => r.error);
  if (bad.length) {
    L.push('## Failed runs', '');
    for (const r of bad) L.push(`- ${r.name} ${r.room || ''} ${r.w}x${r.h}: ${r.error.split('\n')[0]}`);
    L.push('');
  }
  return L.join('\n');
}

if (opt.render) {
  const { readFileSync } = await import('node:fs');
  const parts = opt.render.split(',').map((f) => JSON.parse(readFileSync(f, 'utf8')));
  const merged = { ...parts[0], runs: parts.flatMap((p) => p.runs) };
  console.log(report(merged));
} else {
  main().catch((e) => { console.error(e); process.exit(1); });
}
