#!/usr/bin/env node
// Live engine comparison in the REAL app page (docs/p3m-evaluation.md).
//
// Where scripts/matting-bench.mjs steps the Processor frame by frame against a
// known alpha, this drives Voxal's own index.html the way a call does: the
// browser's camera (Chromium's fake device, fed a Y4M clip so every engine sees
// the same picture), getUserMedia, then VideoEffects.wrap() — exactly what
// startVideoShare() → maybeApplyVideoEffects() runs — with each engine and each
// background, for a while, measuring what a user would feel:
//
//   start      wrap() to the first processed frame: the engine's load included.
//              Cold = empty profile (P3M-Net downloads 78 MB from the local
//              server); warm = the same profile again (Cache Storage hit).
//   out fps    frames the published track delivers (requestVideoFrameCallback on
//              a <video> playing it).
//   mattes/s   how often the engine hands over a new mask, and its inference ms.
//   main busy  the renderer main thread's task time per second (CDP TaskDuration).
//   CPU        CPU-seconds per second of every Chromium process (ps cputime), and
//              their resident memory. A whole-browser figure, idle included.
//
// and a still of the published picture per engine and background.
//
//   node scripts/matting-live.mjs --clip living.y4m [--engines mediapipe,longpipe,p3m]
//        [--modes blur,preset:office,custom] [--seconds 12] [--label m5] [--headed]
//
// The clip: any 1280x720 Y4M (ffmpeg -i in.mp4 -pix_fmt yuv420p out.y4m). The
// footage of scripts/matting-footage.mjs works:
//   ffmpeg -framerate 30 -i bench-results/matting/footage/living/%04d.jpg -pix_fmt yuv420p living.y4m
// The stills are not frame-locked across engines (the fake camera runs on its
// own clock); matting-bench.mjs is the frame-exact comparison.

/* global window, document, VideoEffects */
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = { engines: ['mediapipe', 'longpipe', 'p3m'], modes: ['blur', 'preset:office', 'custom'], seconds: 12, label: 'live', headed: false, clip: null, cold: true };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--engines') opt.engines = args[++i].split(',');
  else if (a === '--modes') opt.modes = args[++i].split(',');
  else if (a === '--seconds') opt.seconds = +args[++i];
  else if (a === '--label') opt.label = args[++i];
  else if (a === '--clip') opt.clip = resolve(args[++i]);
  else if (a === '--headed') opt.headed = true;
  else if (a === '--no-cold') opt.cold = false;
  else { console.error('unknown option ' + a); process.exit(2); }
}
if (!opt.clip || !existsSync(opt.clip)) { console.error('--clip <file.y4m> is required (see the header)'); process.exit(2); }

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.svg': 'image/svg+xml' };
function serve() {
  const dir = join(ROOT, 'src');
  const server = createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let path = normalize(join(dir, url));
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
    if (!path.startsWith(dir) || !existsSync(path)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'no-store' });
    createReadStream(path).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

// Every process under the browser whose command line names this profile.
function procs(profile) {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,time=,command='], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const rows = out.split('\n').filter(Boolean).map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) return null;
    const t = m[4].split(':').map(Number);
    const secs = t.length === 3 ? t[0] * 3600 + t[1] * 60 + t[2] : t[0] * 60 + t[1];
    return { pid: +m[1], ppid: +m[2], rss: +m[3] * 1024, cpu: secs, cmd: m[5] };
  }).filter(Boolean);
  const roots = new Set(rows.filter((r) => r.cmd.includes(profile)).map((r) => r.pid));
  let grew = true;
  while (grew) { grew = false; for (const r of rows) if (!roots.has(r.pid) && roots.has(r.ppid)) { roots.add(r.pid); grew = true; } }
  const mine = rows.filter((r) => roots.has(r.pid));
  return { cpu: mine.reduce((s, r) => s + r.cpu, 0), rss: mine.reduce((s, r) => s + r.rss, 0), n: mine.length };
}

async function runEngine(engine, base, outDir, cold) {
  const profile = mkdtempSync(join(os.tmpdir(), 'voxal-live-'));
  const gpu = ['--enable-gpu', '--use-angle=metal', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'];
  const cam = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${opt.clip}`];
  const results = [];
  const passes = engine === 'p3m' && cold ? ['cold', 'warm'] : ['warm'];
  const ctx = await chromium.launchPersistentContext(profile, { headless: !opt.headed, args: [...gpu, ...cam, '--autoplay-policy=no-user-gesture-required'],
    viewport: { width: 1280, height: 720 }, permissions: ['camera'] });
  try {
    for (const pass of passes) {
      const page = ctx.pages()[0] || await ctx.newPage();
      const logs = [];
      page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') logs.push(m.text()); });
      await page.goto(base + '/');
      await page.evaluate((e) => {
        localStorage.setItem('segmentation-engine', e);
        localStorage.setItem('longpipe-blur', '0');   // the composite, not Longpipe's own picture, in every mode
        localStorage.setItem('bg-reference', 'off');
      }, engine);
      await page.reload();
      await page.waitForFunction(() => typeof VideoEffects !== 'undefined');
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Performance.enable');
      const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
      for (const mode of opt.modes) {
        const label = `${engine} ${mode}${passes.length > 1 ? ' ' + pass : ''}`;
        process.stdout.write('· ' + label + ' … ');
        const start = await page.evaluate(async (m) => {
          if (window.__liveOut) { VideoEffects.stop(window.__liveOut); window.__liveOut = null; }
          if (m === 'custom') await VideoEffects.setCustomImage(await (await fetch('/assets/social-card.png')).blob());
          const t0 = performance.now();
          const raw = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: 30 } });
          const out = await VideoEffects.wrap(raw, m);
          window.__liveOut = out;
          let v = document.getElementById('__live');
          if (!v) {
            v = document.createElement('video');
            v.id = '__live'; v.muted = true; v.playsInline = true; v.autoplay = true;
            v.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;object-fit:contain;background:#000;z-index:2147483647';
            document.body.appendChild(v);
          }
          v.srcObject = out;
          await v.play().catch(() => {});
          await new Promise((r) => (v.requestVideoFrameCallback ? v.requestVideoFrameCallback(() => r()) : setTimeout(r, 100)));
          const firstFrame = performance.now() - t0;
          window.__frames = 0;
          // One counting chain per run: an older run's chain stops at its next frame.
          const gen = window.__tickGen = (window.__tickGen || 0) + 1;
          const tick = () => { if (gen !== window.__tickGen) return; window.__frames++; v.requestVideoFrameCallback(tick); };
          v.requestVideoFrameCallback(tick);
          window.__long = 0;
          if (!window.__po) {
            window.__po = new PerformanceObserver((l) => l.getEntries().forEach((e) => { window.__long += e.duration; }));
            try { window.__po.observe({ entryTypes: ['longtask'] }); } catch (e) { /* none */ }
          }
          return { firstFrame, engine: VideoEffects.engine() };
        }, mode);
        // Warm up (P3M-Net's first runs compile shaders), then measure.
        await page.waitForTimeout(3000);
        await page.evaluate(() => { window.__frames = 0; window.__long = 0; });
        const m0 = await metric(), p0 = procs(profile), t0 = Date.now();
        await page.waitForTimeout(opt.seconds * 1000 / 2);
        await page.screenshot({ path: join(outDir, `${engine}-${mode.replace(/[:/]/g, '_')}${pass === 'cold' ? '-cold' : ''}.png`) });
        await page.waitForTimeout(opt.seconds * 1000 / 2);
        const span = (Date.now() - t0) / 1000;
        const m1 = await metric(), p1 = procs(profile);
        const inPage = await page.evaluate(async () => ({ frames: window.__frames, long: window.__long, stats: await VideoEffects.engineStats(),
          heap: performance.memory ? performance.memory.usedJSHeapSize : null }));
        const r = {
          engine, mode, pass, ran: start.engine, startMs: start.firstFrame,
          outFps: inPage.frames / span,
          maskHz: inPage.stats.maskHz || null, inferMsP50: inPage.stats.inferMsP50 || null, inferMsP95: inPage.stats.inferMsP95 || null,
          mainBusyPct: 100 * (m1.TaskDuration - m0.TaskDuration) / span,
          longTaskMsPerS: inPage.long / span,
          cpuPct: 100 * (p1.cpu - p0.cpu) / span,
          rssMB: p1.rss / 1048576, procs: p1.n,
          jsHeapMB: m1.JSHeapUsedSize / 1048576,
          stats: inPage.stats, logs: logs.slice(-5)
        };
        results.push(r);
        console.log(`ran ${r.ran}, start ${r.startMs.toFixed(0)} ms, out ${r.outFps.toFixed(1)} fps, mattes ${r.maskHz ?? '–'}/s, infer ${r.inferMsP50 ? r.inferMsP50.toFixed(0) : '–'} ms, main ${r.mainBusyPct.toFixed(0)}%, CPU ${r.cpuPct.toFixed(0)}%, RSS ${r.rssMB.toFixed(0)} MB`);
      }
      await page.evaluate(() => { if (window.__liveOut) VideoEffects.stop(window.__liveOut); window.__liveOut = null; });
    }
  } finally {
    await ctx.close();
    rmSync(profile, { recursive: true, force: true });
  }
  return results;
}

function fmt(v, d = 0) { return v === null || v === undefined ? '–' : v.toFixed(d); }

async function main() {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const outDir = join(ROOT, 'bench-results', 'matting', `${opt.label}-${stamp}`);
  mkdirSync(outDir, { recursive: true });
  const all = { options: opt, host: { cpu: os.cpus()[0].model, cores: os.cpus().length, mem: os.totalmem(), platform: os.platform() + ' ' + os.release() }, runs: [] };
  for (const e of opt.engines) {
    all.runs.push(...await runEngine(e, base, outDir, opt.cold));
    writeFileSync(join(outDir, 'results.json'), JSON.stringify(all, null, 2));
  }
  server.close();
  const L = [`# Live comparison — ${opt.label}`, '', `Clip: ${opt.clip}; ${all.host.cpu}, ${all.host.cores} cores; ${opt.seconds} s per run after 3 s of warm-up.`, '',
    '| engine | background | pass | ran | start ms | out fps | mattes/s | infer ms p50/p95 | main thread % | long tasks ms/s | CPU % (all procs) | RSS MB | JS heap MB |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of all.runs) {
    L.push(`| ${r.engine} | ${r.mode} | ${r.pass} | ${r.ran} | ${fmt(r.startMs)} | ${fmt(r.outFps, 1)} | ${fmt(r.maskHz, 1)} | ${fmt(r.inferMsP50)}/${fmt(r.inferMsP95)} | ${fmt(r.mainBusyPct)} | ${fmt(r.longTaskMsPerS)} | ${fmt(r.cpuPct)} | ${fmt(r.rssMB)} | ${fmt(r.jsHeapMB)} |`);
  }
  writeFileSync(join(outDir, 'report.md'), L.join('\n') + '\n');
  console.log(L.join('\n'));
  console.log('→ ' + outDir);
}

main().catch((e) => { console.error(e); process.exit(1); });
