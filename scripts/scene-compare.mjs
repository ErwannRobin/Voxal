#!/usr/bin/env node
// Put two runs of the scene validation matrix side by side, BEFORE | AFTER, so a
// change to the scene engine can be judged by looking at both with the same
// framing, light and moment.
//
//   node scripts/scene-preview.mjs --matrix --gpu --out scene-previews/baseline/matrix
//   ... change the engine ...
//   node scripts/scene-preview.mjs --matrix --gpu --out scene-previews/new/matrix
//   node scripts/scene-compare.mjs scene-previews/baseline/matrix scene-previews/new/matrix
//   node scripts/scene-compare.mjs <before> <after> --out scene-previews/compare --labels "OLD,NEW" --tile 400 --jpeg
//   node scripts/scene-compare.mjs <before> <after> office penthouse     just those scenes
//
// Writes, to --out (default scene-previews/compare):
//   <scene>/compare.png            every landscape-shaped case, BEFORE | AFTER, in pairs
//   <scene>/compare-portrait.png   the portrait cases, the same way
//   <scene>/compare-small.png      the 640x360 cases, the same way
//   <scene>/compare-live.png       the motion strips, BEFORE over AFTER
//   overview.png / overview-night.png / overview-mirror.png
//                                  one row per scene: landscape + portrait, BEFORE | AFTER
//   stability-compare.json         both runs' stability.json numbers, side by side
// and prints the stability table (mean |change| in 1/255 levels between frames one
// second apart, and the share of pixels moving by more than 4/255; outside and inside
// the calm zone) with the change.
//
// Composition is done on a canvas in Playwright's page: no image library is needed.

/* global document, Image */

import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL = ['office', 'island', 'cybercafe', 'mountain', 'countryside', 'penthouse'];
// The matrix's own order (scene-preview.mjs CASES); anything else found is appended.
const CASE_ORDER = [
  'landscape-day', 'landscape-night', 'landscape-mirror', 'landscape-night-mirror', 'landscape-subject-left',
  'landscape-mirror-subject-right', 'landscape-t95', 'landscape-nobloom', 'small-day', 'small-night',
  'portrait-day', 'portrait-night', 'portrait-mirror', 'portrait-subject-left', 'portrait-t95',
];

const args = process.argv.slice(2);
const opt = { out: path.join(ROOT, 'scene-previews', 'compare'), labels: ['BEFORE', 'AFTER'], tile: 400, jpeg: false };
const pos = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--out') opt.out = path.resolve(args[++i]);
  else if (a === '--labels') opt.labels = String(args[++i]).split(',').map((s) => s.trim());
  else if (a === '--tile') opt.tile = Math.max(120, +args[++i]);
  else if (a === '--jpeg') opt.jpeg = true;
  else if (a.startsWith('-')) throw new Error('unknown option ' + a);
  else pos.push(a);
}
if (pos.length < 2) {
  console.error('usage: scene-compare.mjs <before-matrix-dir> <after-matrix-dir> [scene ...] [--out dir] [--labels BEFORE,AFTER] [--tile 400] [--jpeg]');
  process.exit(2);
}
const dirs = [path.resolve(pos[0]), path.resolve(pos[1])];
const wanted = pos.slice(2);
for (const d of dirs) if (!fs.existsSync(d)) throw new Error(`no such directory: ${d}`);
const [LB, LA] = [opt.labels[0] || 'BEFORE', opt.labels[1] || 'AFTER'];
const ext = opt.jpeg ? 'jpg' : 'png';
fs.mkdirSync(opt.out, { recursive: true });

const readJson = (d) => { try { return JSON.parse(fs.readFileSync(path.join(d, 'stability.json'), 'utf8')); } catch { return null; } };
const docs = dirs.map(readJson);
const find = (d, scene, name) => {
  for (const e of ['png', 'jpg']) {
    const f = path.join(d, scene, `${name}.${e}`);
    if (fs.existsSync(f)) return 'data:image/' + (e === 'jpg' ? 'jpeg' : 'png') + ';base64,' + fs.readFileSync(f).toString('base64');
  }
  return null;
};
const scenesIn = (d) => fs.readdirSync(d).filter((x) => fs.statSync(path.join(d, x)).isDirectory());
const scenes = [...new Set([...scenesIn(dirs[0]), ...scenesIn(dirs[1])])]
  .filter((s) => !wanted.length || wanted.includes(s))
  .sort((a, b) => (ALL.indexOf(a) + 1 || 99) - (ALL.indexOf(b) + 1 || 99));
if (!scenes.length) throw new Error('no scene directories found in either matrix');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
await page.setContent('<!doctype html><title>compare</title>');

// items: { url, x, y, w, h, label, band } | { text, x, y, size, color } ; `url: null` draws "missing".
async function composeInPage(items, W, H, jpeg) {
  return page.evaluate(async ({ items, W, H, jpeg }) => {
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#14161b'; ctx.fillRect(0, 0, W, H);
    const imgs = await Promise.all(items.map((it) => it.url ? new Promise((done, fail) => {
      const im = new Image();
      im.onload = () => done(im);
      im.onerror = () => fail(new Error('bad image for ' + (it.label || it.text)));
      im.src = it.url;
    }) : null));
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    const mono = 'ui-monospace, Menlo, Consolas, monospace';
    items.forEach((it, i) => {
      if (it.text !== undefined) {
        ctx.font = 'bold ' + (it.size || 16) + 'px ' + mono; ctx.textBaseline = 'top';
        ctx.fillStyle = it.color || '#9fb4ff'; ctx.fillText(it.text, it.x, it.y);
        return;
      }
      if (it.label) {
        ctx.fillStyle = it.band || '#232734'; ctx.fillRect(it.x, it.y - 22, it.w, 22);
        ctx.font = '12px ' + mono; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#f2f4fa'; ctx.fillText(it.label, it.x + 6, it.y - 10, it.w - 12);
      }
      if (imgs[i]) ctx.drawImage(imgs[i], it.x, it.y, it.w, it.h);
      else {
        ctx.fillStyle = '#2a1b1b'; ctx.fillRect(it.x, it.y, it.w, it.h);
        ctx.fillStyle = '#e07070'; ctx.font = '14px ' + mono; ctx.textBaseline = 'middle';
        ctx.fillText('missing', it.x + 10, it.y + it.h / 2);
      }
    });
    return jpeg ? cv.toDataURL('image/jpeg', 0.9) : cv.toDataURL('image/png');
  }, { items, W, H, jpeg });
}
const write = (file, url) => fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));

const BAND_BEFORE = '#4a2a35', BAND_AFTER = '#1f4a34';
const metric = (doc, scene, name) => doc?.scenes?.[scene]?.cases?.[name];
const tag = (m) => (m ? `  luma ${Math.round(m.mean)} crushed ${Math.round(m.crushed)}%` : '');
const fmt = (v, d = 2) => (v === undefined || v === null ? '-' : v.toFixed(d));

// Pairs, in rows: as many fit in `maxW` as can.
async function pairSheet(scene, names, tw, th, file, title) {
  const G = 10, GG = 22, M = 10, BAND = 22, maxW = 1720;
  const pair = 2 * tw + G;
  const per = Math.max(1, Math.floor((maxW - 2 * M + GG) / (pair + GG)));
  const items = [{ text: title, x: M, y: M, size: 14 }];
  const top = M + 30 + BAND;
  names.forEach((name, i) => {
    const r = Math.floor(i / per), q = i % per;
    const x = M + q * (pair + GG), y = top + r * (BAND + th + G + 6);
    const m = [metric(docs[0], scene, name), metric(docs[1], scene, name)];
    items.push({ url: find(dirs[0], scene, name), x, y, w: tw, h: th, label: `${LB}  ${name}${tag(m[0])}`, band: BAND_BEFORE });
    items.push({ url: find(dirs[1], scene, name), x: x + tw + G, y, w: tw, h: th, label: `${LA}  ${name}${tag(m[1])}`, band: BAND_AFTER });
  });
  const rows = Math.ceil(names.length / per);
  const W = Math.min(maxW, 2 * M + per * pair + (per - 1) * GG), H = top + rows * (BAND + th + G + 6) + M;
  write(file, await composeInPage(items, W, H, opt.jpeg));
}

const stabilityRows = [];
for (const scene of scenes) {
  const dir = path.join(opt.out, scene);
  fs.mkdirSync(dir, { recursive: true });
  const names = [...new Set([...CASE_ORDER, ...[0, 1].flatMap((k) => fs.existsSync(path.join(dirs[k], scene))
    ? fs.readdirSync(path.join(dirs[k], scene)).filter((f) => /\.(png|jpg)$/.test(f)).map((f) => f.replace(/\.(png|jpg)$/, '')) : [])])]
    .filter((n) => !/^(sheet|live-|compare)/.test(n))
    .filter((n) => find(dirs[0], scene, n) || find(dirs[1], scene, n));
  const wide = names.filter((n) => /^landscape-/.test(n));
  const rest = names.filter((n) => !/^landscape-/.test(n));
  const TW = opt.tile, TH = Math.round(opt.tile * 9 / 16);
  const st = [docs[0]?.scenes?.[scene], docs[1]?.scenes?.[scene]];
  const stLine = (k) => {
    const s = st[k]?.day, n = st[k]?.night;
    return s ? `${k ? LA : LB} shimmer day out ${fmt(s.outside.mean)} in ${fmt(s.inside.mean)}` + (n ? ` night out ${fmt(n.outside.mean)} in ${fmt(n.inside.mean)}` : '') : '';
  };
  const title = `${scene}   ${LB} | ${LA}   ${stLine(0)}   ${stLine(1)}`;
  if (wide.length) await pairSheet(scene, wide, TW, TH, path.join(dir, `compare.${ext}`), title);
  const PW = Math.round(TW * 9 / 16 * 0.9), PH = Math.round(PW * 16 / 9);
  const portrait = rest.filter((n) => /^portrait-/.test(n));
  const small = rest.filter((n) => !/^portrait-/.test(n));
  if (portrait.length) await pairSheet(scene, portrait, PW, PH, path.join(dir, `compare-portrait.${ext}`), `${scene}   portrait   ${LB} | ${LA}`);
  if (small.length) await pairSheet(scene, small, Math.round(TW * 0.75), Math.round(TH * 0.75), path.join(dir, `compare-small.${ext}`), `${scene}   640x360   ${LB} | ${LA}`);

  // The motion strips, one above the other: they carry their own titles and numbers.
  const strips = ['live-strip', 'live-strip-night'].flatMap((n) => [[0, n], [1, n]]).filter(([k, n]) => find(dirs[k], scene, n));
  if (strips.length) {
    const SW = 1650, SH = 298, M = 10, BAND = 22;
    const items = strips.map(([k, n], i) => ({ url: find(dirs[k], scene, n), x: M, y: M + BAND + i * (SH + BAND + 8), w: SW, h: SH,
      label: `${k ? LA : LB}  ${n}`, band: k ? BAND_AFTER : BAND_BEFORE }));
    write(path.join(dir, `compare-live.${ext}`), await composeInPage(items, SW + 2 * M, M + strips.length * (SH + BAND + 8) + M, opt.jpeg));
  }
  stabilityRows.push({ scene, before: st[0] || null, after: st[1] || null });
}

// Overviews: one row per scene, landscape + portrait of a case, BEFORE | AFTER.
async function overview(file, land, port, label) {
  const rows = scenes.filter((s) => [0, 1].some((k) => find(dirs[k], s, land) || find(dirs[k], s, port)));
  if (!rows.length) return;
  const TW = Math.round(opt.tile * 1.2), TH = Math.round(TW * 9 / 16), PH = TH, PW = Math.round(PH * 9 / 16);
  const G = 10, M = 10, BAND = 22, HEAD = 30, GAP = 28;
  const items = [{ text: `Scene catalogue - ${label}   ${LB} (left) | ${LA} (right)   ${path.relative(ROOT, dirs[0])}  vs  ${path.relative(ROOT, dirs[1])}`, x: M, y: M, size: 14 }];
  rows.forEach((s, i) => {
    const y = M + HEAD + BAND + i * (BAND + TH + 10);
    [0, 1].forEach((k) => {
      const x = M + k * (TW + G + PW + GAP);
      const band = k ? BAND_AFTER : BAND_BEFORE;
      const m = metric(docs[k], s, land);
      items.push({ url: find(dirs[k], s, land), x, y, w: TW, h: TH, label: `${k ? LA : LB}  ${s}  ${land}${tag(m)}`, band });
      items.push({ url: find(dirs[k], s, port), x: x + TW + G, y, w: PW, h: PH, label: 'portrait', band });
    });
  });
  const W = 2 * M + 2 * (TW + G + PW) + GAP, H = M + HEAD + rows.length * (BAND + TH + 10) + M;
  write(file, await composeInPage(items, W, H, opt.jpeg));
}
await overview(path.join(opt.out, `overview.${ext}`), 'landscape-day', 'portrait-day', 'day');
await overview(path.join(opt.out, `overview-night.${ext}`), 'landscape-night', 'portrait-night', 'night (exposure 0.22)');
await overview(path.join(opt.out, `overview-mirror.${ext}`), 'landscape-mirror', 'portrait-mirror', 'mirrored (key light on the left)');

// The stability table, with the change.
fs.writeFileSync(path.join(opt.out, 'stability-compare.json'), JSON.stringify({ before: path.relative(ROOT, dirs[0]), after: path.relative(ROOT, dirs[1]), scenes: stabilityRows }, null, 2) + '\n');
console.log(`stability: mean |dY|/255 between frames 1 s apart (% of pixels > 4/255)   ${LB} -> ${LA}`);
console.log('scene'.padEnd(13) + ['day out', 'day in', 'night out', 'night in'].map((x) => x.padStart(30)).join(''));
const cell = (r, when, zone) => {
  const a = r.before?.[when]?.[zone], b = r.after?.[when]?.[zone];
  if (!a && !b) return '-'.padStart(30);
  const d = a && b ? (b.mean - a.mean) : null;
  return `${fmt(a?.mean)}/${fmt(a?.pct, 1)}% -> ${fmt(b?.mean)}/${fmt(b?.pct, 1)}%${d === null ? '' : d > 0.05 ? ' worse' : d < -0.05 ? ' better' : ' same'}`.padStart(30);
};
for (const r of stabilityRows) console.log(r.scene.padEnd(13) + cell(r, 'day', 'outside') + cell(r, 'day', 'inside') + cell(r, 'night', 'outside') + cell(r, 'night', 'inside'));
console.log(`wrote ${scenes.length} scene${scenes.length === 1 ? '' : 's'} to ${path.relative(ROOT, opt.out) || '.'}`);
await browser.close();
