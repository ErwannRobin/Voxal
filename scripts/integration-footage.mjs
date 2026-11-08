#!/usr/bin/env node
// Real webcam-style footage for the integration bench
// (docs/integration-evaluation.md): every usable clip of
// tests/bench/integration/clips.csv, cut to its `start`/`seconds` and written
// as JPEG frames the bench steps through one by one.
//
//   node scripts/integration-footage.mjs                       every usable clip
//   node scripts/integration-footage.mjs --clips glasses,pexels-7231260   by situation word or id
//   node scripts/integration-footage.mjs --force               fetch again even if present
//
// Output: bench-results/integration/footage/<id>/NNNN.jpg + clip.json, and
// footage/manifest.json listing what is there. Gitignored: the clips are
// Pexels footage (free to use, but not ours to redistribute as a dataset), so
// they are fetched, never committed.
//
// ffmpeg reads the Pexels file over HTTP and seeks with range requests, so a
// 4K source costs the seconds that are cut from it, not the whole download.
// A landscape clip becomes 1280x720 (a desktop camera), an upright one
// 720x1280 (a phone held upright), each scaled to cover and centre-cropped.
// The source's own frame rate is kept: the bench's clock runs on it.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FOOTAGE, readClips, selectClips } from './integration-lib.mjs';

const args = process.argv.slice(2);
const opt = { clips: [], force: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--clips') opt.clips = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--force') opt.force = true;
  else { console.error('unknown option ' + a); process.exit(2); }
}

for (const bin of ['ffmpeg', 'ffprobe']) {
  try { execFileSync(bin, ['-version'], { stdio: 'ignore' }); } catch (e) {
    console.error(`${bin} is required (brew install ffmpeg)`); process.exit(1);
  }
}

const UA = 'voxal-integration-bench';
const clips = selectClips(readClips(), opt.clips);
if (!clips.length) { console.error('no clip matches ' + opt.clips.join(',')); process.exit(2); }
mkdirSync(FOOTAGE, { recursive: true });

function probe(url) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-user_agent', UA, '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate:stream_side_data=rotation', '-of', 'json', url], { encoding: 'utf8' });
  const s = JSON.parse(out).streams[0];
  const [n, d] = s.r_frame_rate.split('/').map(Number);
  const rot = Math.abs(((s.side_data_list || []).find((x) => 'rotation' in x) || {}).rotation || 0);
  const turned = rot === 90 || rot === 270;
  return { width: turned ? s.height : s.width, height: turned ? s.width : s.height, fps: d ? n / d : n };
}

let failed = 0;
for (const c of clips) {
  const dir = join(FOOTAGE, c.id);
  if (!opt.force && existsSync(join(dir, 'clip.json'))) { console.log(`· ${c.id} present`); continue; }
  process.stdout.write(`· ${c.id} (${c.situation}) … `);
  try {
    const src = probe(c.download);
    const upright = src.height > src.width;
    const [w, h] = upright ? [720, 1280] : [1280, 720];
    const fps = Math.round(src.fps) || 25;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    execFileSync('ffmpeg', ['-v', 'error', '-user_agent', UA, '-ss', String(c.start), '-t', String(c.seconds),
      '-i', c.download, '-an',
      '-vf', `fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h}`,
      '-q:v', '3', '-start_number', '0', join(dir, '%04d.jpg')], { stdio: ['ignore', 'ignore', 'inherit'] });
    const frames = readdirSync(dir).filter((f) => /^\d{4}\.jpg$/.test(f)).length;
    if (!frames) throw new Error('ffmpeg wrote no frames');
    writeFileSync(join(dir, 'clip.json'), JSON.stringify({
      id: c.id, situation: c.situation, description: c.description, interest: c.interest, link: c.link,
      width: w, height: h, fps, frames, start: c.start, source: src, license: 'Pexels License (https://www.pexels.com/license/)'
    }, null, 2));
    console.log(`${w}x${h} ${fps} fps, ${frames} frames (source ${src.width}x${src.height})`);
  } catch (e) {
    failed++;
    console.log('FAILED: ' + String(e.message).split('\n')[0]);
  }
}

const present = readdirSync(FOOTAGE, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(FOOTAGE, d.name, 'clip.json')))
  .map((d) => JSON.parse(readFileSync(join(FOOTAGE, d.name, 'clip.json'), 'utf8')));
writeFileSync(join(FOOTAGE, 'manifest.json'), JSON.stringify({ clips: present }, null, 2));
console.log(`→ ${FOOTAGE} (${present.length} clips${failed ? `, ${failed} failed` : ''})`);
if (failed) process.exit(1);
