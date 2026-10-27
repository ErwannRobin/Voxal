/* eslint-disable no-undef -- page.evaluate callbacks run in the app, where window/main.js globals exist */
// Regenerates the README screenshots (docs/voxal-shot-*.png).
//
// Drives the real app in Chromium against a local PeerServer, with the
// benchmark's synthetic camera scene as the "person" (make bench-video), then
// wraps each capture in a macOS-style window. Usage:
//   make bench-video && npx serve src -l 8080 &
//   node scripts/readme-screenshots.mjs [outDir]
import { chromium } from '@playwright/test';
import { PeerServer } from 'peer';
import { randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(process.argv[2] || resolve(ROOT, 'docs'));
const BASE = process.env.SHOT_BASE || 'http://127.0.0.1:8080';
const PORT = 9300;
mkdirSync(OUT, { recursive: true });

const broker = { host: '127.0.0.1', port: PORT, path: '/', key: 'peerjs', secure: false };
const server = await new Promise((res) => {
  const s = PeerServer({ host: '127.0.0.1', port: PORT, path: '/', generateClientId: () => randomUUID() }, () => res(s));
});

const browser = await chromium.launch({
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    `--use-file-for-fake-audio-capture=${resolve(ROOT, 'tests/bench/assets/bench-speech.wav')}`,
    `--use-file-for-fake-video-capture=${resolve(ROOT, 'tests/bench/assets/bench-scene.y4m')}`,
  ],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function peerPage(pseudo, theme, size, storage = {}) {
  const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: 2, colorScheme: theme });
  const page = await ctx.newPage();
  await ctx.addInitScript((cfg) => {
    localStorage.setItem('peerjs-server', JSON.stringify(cfg.broker));
    localStorage.setItem('pseudo', cfg.pseudo);
    sessionStorage.setItem('pseudo', cfg.pseudo);
    localStorage.setItem('theme', cfg.theme);
    localStorage.setItem('noise-suppression', 'off');
    localStorage.setItem('video-routing-mode', 'p2p-only');
    localStorage.setItem('video-mode-enabled', 'true');
    Object.entries(cfg.storage).forEach(([k, v]) => localStorage.setItem(k, v));
  }, { broker, pseudo, theme, storage });
  await page.goto(BASE);
  // A scene compile freezes a software-GPU page for seconds; do not let the room read that as a dead host.
  await page.evaluate(() => { HOST_HEARTBEAT_TIMEOUT_MS = 90000; });
  return page;
}

const createRoom = (p) => p.evaluate(() => new Promise((res, rej) => window.createRoom((id) => res(id)).catch(rej)));
const joinRoom = (p, code) => p.evaluate((c) => new Promise((res, rej) => window.joinRoom(c, () => res()).catch(rej)), code);

/** A frame around a capture: title bar, traffic lights, rounded corners, shadow. */
async function frame(shotPath, outPath, title, theme) {
  const ctx = await browser.newContext({ viewport: { width: 100, height: 100 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const { readFileSync } = await import('node:fs');
  const b64 = readFileSync(shotPath).toString('base64');
  const dark = theme === 'dark';
  await page.setContent(`<style>
    html,body{margin:0;background:transparent}
    .pad{display:inline-block;padding:40px 60px 70px}
    .win{border-radius:14px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.55),0 30px 60px rgba(0,0,0,.45);
      background:${dark ? '#17171f' : '#f4f4f8'}}
    .bar{height:38px;display:flex;align-items:center;gap:8px;padding:0 14px;
      font:600 13px -apple-system,Helvetica,sans-serif;color:${dark ? '#9a9aa8' : '#6b6b78'};background:${dark ? '#17171f' : '#ececf2'}}
    .bar i{width:12px;height:12px;border-radius:50%;display:block}
    .bar span{margin-left:12px}
    img{display:block}
  </style><div class="pad"><div class="win"><div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span>${title}</span></div><img id="i" src="data:image/png;base64,${b64}"></div></div>`);
  await page.waitForFunction(() => document.getElementById('i').complete);
  const box = await page.locator('.pad').boundingBox();
  await page.setViewportSize({ width: Math.ceil(box.width), height: Math.ceil(box.height) });
  await page.screenshot({ path: outPath, omitBackground: true });
  await ctx.close();
}

const results = [];
for (const theme of ['dark', 'light']) {
  const tmp = (n) => resolve(OUT, `.tmp-${n}-${theme}.png`);

  // ── Audio call: three people, one of them talking ──
  {
    const size = { width: 340, height: 620 };
    const me = await peerPage('Erwann', theme, size);
    const code = await createRoom(me);
    const a = await peerPage('Maya', theme, size);
    const b = await peerPage('Leo', theme, size);
    await joinRoom(a, code);
    await joinRoom(b, code);
    await sleep(1500);
    // Open the audio mesh, then leave Maya mid-sentence.
    for (const p of [me, b]) await p.evaluate(() => new Promise((r) => { window.setTalking(true); setTimeout(() => { window.setTalking(false); r(); }, 400); }));
    await a.evaluate(() => window.setTalking(true));
    await sleep(2500);
    await me.screenshot({ path: tmp('audio') });
    await frame(tmp('audio'), resolve(OUT, `voxal-shot-audio-${theme}.png`), 'Voxal', theme);
    for (const p of [me, a, b]) await p.context().close();
    results.push(`audio-${theme}`);
  }

  // ── Video call with a virtual background ──
  {
    const size = { width: 1100, height: 680 };
    const bg = { 'video-background': 'preset:office' };
    const me = await peerPage('Erwann', theme, size, bg);
    const code = await createRoom(me);
    const a = await peerPage('Maya', theme, size, {});
    const b = await peerPage('Leo', theme, size, {});
    await joinRoom(a, code);
    await joinRoom(b, code);
    await sleep(1500);
    await me.evaluate(() => window.startVideoShare());
    // Scene compiles are slow on a software GPU; give the picture time to settle.
    for (let i = 0; i < 60; i++) {
      const ok = await me.evaluate(() => { const p = localVideoStream && localVideoStream._effectsProcessor; return !!(p && p.sceneId); });
      if (ok) break;
      await sleep(1000);
    }
    await sleep(6000);
    console.log(theme, 'peers seen:', await me.evaluate(() => connections.size), 'scene:', await me.evaluate(() => (localVideoStream._effectsProcessor || {}).sceneId));
    await me.screenshot({ path: tmp('video') });
    await frame(tmp('video'), resolve(OUT, `voxal-shot-video-${theme}.png`), 'Voxal', theme);
    for (const p of [me, a, b]) await p.context().close();
    results.push(`video-${theme}`);
  }
}

await browser.close();
server.close?.();
console.log('wrote', results.join(', '), 'to', OUT);
process.exit(0);
