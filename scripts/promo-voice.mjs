#!/usr/bin/env node
// Records the voice-over of docs/promo.html (`make promo-voice`).
//
// The lines live in the page itself, in its <script id="narration"> block:
// one cue per line, with when it starts (`t`) and how long it may last (`max`),
// in every language the app speaks. This reads that block, has a speech engine
// say each line, and writes one file per film and language:
//
//   docs/promo-voice/<film>-<lang>.js        engines whose output may be published
//   docs/promo-voice/draft/<film>-<lang>.js  macOS `say` (gitignored, see below)
//
// Each file is a classic script that registers itself on window.VOX_VOICE —
// the one way to hand the page data that works from file:// as well as from a
// server — holding the cue timings as recorded and the whole track as one
// mono MP3 the length of the film, every line already at its place.
//
// Engines:
//   say     macOS, local, free, every language. Apple's licence allows its
//           system voices for personal, non-commercial use only — not for a
//           public promo — so these are drafts: they go to draft/, which git
//           ignores, and the page labels them as such.
//   openai  OpenAI's speech API (OPENAI_API_KEY). The tracks to publish.
//
// A line that comes out longer than its slot is sped up (pitch kept, with
// ffmpeg's atempo) up to --max-tempo; past that the translation is too long
// for its slot and the report says so. Engine output is cached by its inputs
// in node_modules/.cache/promo-voice, so a re-run only pays for what changed.
//
// Usage:
//   node scripts/promo-voice.mjs [--engine say|openai] [--film intro,backgrounds]
//        [--lang fr,de] [--voice NAME] [--model NAME] [--max-tempo 1.25] [--jobs 4]
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = path.join(root, 'docs/promo.html');
const CACHE = path.join(root, 'node_modules/.cache/promo-voice');
const SR = 48000;

const SAY_VOICES = {
  en: 'Samantha', fr: 'Thomas', es: 'Mónica', de: 'Anna', pt: 'Luciana', ro: 'Ioana',
  ru: 'Milena', uk: 'Lesya', id: 'Damayanti', zh: 'Tingting', ja: 'Kyoko', ar: 'Majed',
};
// Words per minute, where a voice's own default is slow for a film (Majed
// reads at about 180, the others nearer 200).
const SAY_RATE = { ar: 210 };
// What the speech API is told it is reading.
const LANGUAGE = {
  en: 'English', fr: 'French', es: 'Spanish (Spain)', de: 'German', pt: 'Brazilian Portuguese', ro: 'Romanian',
  ru: 'Russian', uk: 'Ukrainian', id: 'Indonesian', zh: 'Mandarin Chinese', ja: 'Japanese', ar: 'Modern Standard Arabic',
};

function parseArgs(argv) {
  const o = { engine: 'say', film: null, lang: null, voice: null, model: null, maxTempo: 1.25, jobs: 4 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === '--engine') o.engine = v();
    else if (a === '--film') o.film = v().split(',').filter(Boolean);
    else if (a === '--lang') o.lang = v().split(',').filter(Boolean);
    else if (a === '--voice') o.voice = v();
    else if (a === '--model') o.model = v();
    else if (a === '--max-tempo') o.maxTempo = +v();
    else if (a === '--jobs') o.jobs = Math.max(1, +v() | 0);
    else if (a === '-h' || a === '--help') { console.log(readHelp()); process.exit(0); }
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!['say', 'openai'].includes(o.engine)) throw new Error(`--engine must be say or openai, not ${o.engine}`);
  return o;
}
function readHelp() {
  return 'make promo-voice [ENGINE=say|openai] [FILMS=intro,backgrounds] [LANGS=fr,de]\n'
    + 'node scripts/promo-voice.mjs --engine say|openai --film … --lang … [--voice NAME] [--model NAME] [--max-tempo 1.25] [--jobs 4]';
}

function run(cmd, args, input, timeout = 0) {
  return new Promise((resolve, reject) => {
    const p = execFile(cmd, args, { encoding: 'buffer', maxBuffer: 1 << 30, timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.slice(0, 3).join(' ')}…: ${stderr.toString().trim() || err.message}`));
      else resolve(stdout);
    });
    if (input) p.stdin.end(input); else p.stdin.end();
  });
}

// The page's own copy of these two functions is in docs/promo.html; the hash
// must match it exactly, or every recording reads as stale.
export function spokenText(cue, lang, langs) {
  let s = cue.text[lang] || '';
  for (const [from, to] of Object.entries((langs[lang] && langs[lang].spoken) || {})) s = s.split(from).join(to);
  return s;
}
export function narrationHash(N, film, lang, langs) {
  const cues = N.films[film].cues.map(c => [c.id, c.t, c.max, spokenText(c, lang, langs)]);
  let h = 2166136261;
  for (const ch of JSON.stringify(cues)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/* ── Engines: text in, an audio file (any format ffmpeg reads) out ── */
const engines = {
  say: {
    publishable: false,
    voice: (lang, o) => o.voice || SAY_VOICES[lang],
    model: () => null,
    async speak(text, lang, o, out) {
      const txt = out + '.txt';
      await writeFile(txt, text);
      // `say` now and then never returns when several run at once (seen with
      // the Chinese voice): give each line 30 s and try again before failing.
      for (let attempt = 1; ; attempt++) {
        const rate = !o.voice && SAY_RATE[lang] ? ['-r', String(SAY_RATE[lang])] : [];
        try { await run('say', ['-v', engines.say.voice(lang, o), ...rate, '-o', out, '-f', txt], null, 30000); break; }
        catch (e) { if (attempt >= 3) throw e; await rm(out, { force: true }); }
      }
      await rm(txt, { force: true });
    },
    ext: 'aiff',
  },
  openai: {
    publishable: true,
    voice: (lang, o) => o.voice || 'coral',
    model: o => o.model || 'gpt-4o-mini-tts',
    instructions: lang => `Voice-over for a short product film about Voxal, a push-to-talk voice app. Read it in ${LANGUAGE[lang]}: warm, clear and confident, at a brisk, natural pace. Pronounce Voxal as "VOX-al".`,
    async speak(text, lang, o, out) {
      const key = process.env.OPENAI_API_KEY;
      if (!key) throw new Error('OPENAI_API_KEY is not set');
      const body = { model: engines.openai.model(o), voice: engines.openai.voice(lang, o), input: text, instructions: engines.openai.instructions(lang), response_format: 'wav' };
      for (let attempt = 1; ; attempt++) {
        const res = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) { await writeFile(out, Buffer.from(await res.arrayBuffer())); return; }
        const msg = await res.text();
        if ((res.status === 429 || res.status >= 500) && attempt < 4) { await new Promise(r => setTimeout(r, 1500 * attempt)); continue; }
        throw new Error(`OpenAI speech API: HTTP ${res.status} ${msg.slice(0, 300)}`);
      }
    },
    ext: 'wav',
  },
};

// Engine output, cached by everything that shapes it.
async function synth(engine, text, lang, o) {
  const E = engines[engine];
  const rate = engine === 'say' && !o.voice ? SAY_RATE[lang] || 0 : 0;
  const id = createHash('sha1').update(JSON.stringify([engine, E.voice(lang, o), E.model(o), E.instructions ? E.instructions(lang) : '', rate, text])).digest('hex');
  const file = path.join(CACHE, `${id}.${E.ext}`);
  if (!existsSync(file)) {
    const part = file + '.part.' + E.ext;
    await E.speak(text, lang, o, part);
    await run('mv', [part, file]);
  }
  return file;
}

// Any audio file → mono float samples at SR.
async function decode(file) {
  const raw = await run('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-']);
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4).slice();
}
async function tempo(samples, k) {
  const raw = await run('ffmpeg', ['-v', 'error', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', '-', '-filter:a', `atempo=${k.toFixed(4)}`, '-f', 'f32le', '-'],
    Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4).slice();
}
// Leading and trailing silence off, with a breath either side.
function trim(x) {
  const thr = 0.006, pad = Math.round(0.04 * SR);
  let a = 0, b = x.length - 1;
  while (a < x.length && Math.abs(x[a]) < thr) a++;
  while (b > a && Math.abs(x[b]) < thr) b--;
  if (a >= b) return new Float32Array(0);
  return x.slice(Math.max(0, a - pad), Math.min(x.length, b + pad));
}
// Every line at the same loudness: RMS of the voiced part to −18 dBFS, peak ≤ −1.
function level(x) {
  let s = 0, n = 0, peak = 0;
  for (const v of x) { const a = Math.abs(v); if (a > peak) peak = a; if (a > 0.01) { s += v * v; n++; } }
  if (!n) return x;
  const g = Math.min(0.126 / Math.sqrt(s / n), 0.89 / peak);
  return x.map(v => v * g);
}

async function encodeMp3(samples, out) {
  const raw = out + '.f32';
  await writeFile(raw, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  // To a file, not a pipe: only then does LAME write the header that tells a
  // decoder how much encoder delay to drop, which keeps the voice in sync.
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', raw, '-ar', '24000', '-ac', '1', '-c:a', 'libmp3lame', '-q:a', '4', out]);
  await rm(raw, { force: true });
  return readFile(out);
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

async function recordTrack(N, langs, film, lang, o, work) {
  const F = N.films[film], E = engines[o.engine];
  const cues = F.cues;
  const track = new Float32Array(Math.ceil(F.dur * SR));
  const report = [];
  // A line must end in its slot, a breath (0.1 s) before the next line and
  // before the end of the film — whichever comes first.
  const room = i => Math.min(cues[i].max, (i + 1 < cues.length ? cues[i + 1].t - 0.1 : F.dur) - cues[i].t);
  const rendered = await pool(cues, o.jobs, async (c, i) => {
    const text = spokenText(c, lang, langs);
    if (!text) throw new Error(`${film}/${c.id}: no ${lang} text`);
    let x = trim(await decode(await synth(o.engine, text, lang, o)));
    const said = x.length / SR, fit = room(i) - 0.03;
    let k = 1;
    if (said > fit) { k = Math.min(o.maxTempo, said / fit); x = trim(await tempo(x, k)); }
    return { c, x: level(x), said, k };
  });
  rendered.forEach(({ c, x, said, k }, i) => {
    const dur = x.length / SR;
    const over = dur > room(i) + 0.03;
    const at = Math.round(c.t * SR);
    for (let j = 0; j < x.length && at + j < track.length; j++) track[at + j] += x[j];
    report.push({ id: c.id, said, dur, max: c.max, k, status: over ? 'TOO LONG' : dur > c.max + 0.05 ? 'over slot' : 'ok' });
  });
  const mp3 = await encodeMp3(track, path.join(work, `${film}-${lang}.mp3`));
  const meta = {
    film, lang, engine: o.engine, voice: E.voice(lang, o), model: E.model(o), publishable: E.publishable,
    generated: new Date().toISOString().slice(0, 10), text: narrationHash(N, film, lang, langs),
    cues: report.map(r => ({ id: r.id, t: cues.find(c => c.id === r.id).t, dur: +r.dur.toFixed(3), tempo: +r.k.toFixed(3) })),
    audio: 'data:audio/mpeg;base64,' + mp3.toString('base64'),
  };
  const dir = path.join(root, 'docs/promo-voice', E.publishable ? '' : 'draft');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${film}-${lang}.js`);
  await writeFile(file, '// Generated by scripts/promo-voice.mjs (make promo-voice). Do not edit: change the\n'
    + '// narration in docs/promo.html and record it again.\n'
    + `(window.VOX_VOICE = window.VOX_VOICE || {})[${JSON.stringify(film + '/' + lang)}] = ${JSON.stringify(meta)};\n`);
  return { file, report, bytes: mp3.length };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  await run('ffmpeg', ['-version']).catch(() => { throw new Error('ffmpeg is required (brew install ffmpeg)'); });
  if (o.engine === 'say' && process.platform !== 'darwin') throw new Error('--engine say needs macOS');
  if (o.engine === 'openai' && !process.env.OPENAI_API_KEY) throw new Error('--engine openai needs OPENAI_API_KEY in the environment');
  const N = readNarration(await readFile(PAGE, 'utf8'));
  const langs = Object.fromEntries(N.languages.map(l => [l.code, l]));
  const films = o.film || Object.keys(N.films), codes = o.lang || N.languages.map(l => l.code);
  for (const f of films) if (!N.films[f]) throw new Error(`unknown film: ${f} (have ${Object.keys(N.films).join(', ')})`);
  for (const l of codes) if (!langs[l]) throw new Error(`unknown language: ${l} (have ${Object.keys(langs).join(', ')})`);
  await mkdir(CACHE, { recursive: true });
  const work = path.join(tmpdir(), `promo-voice-${process.pid}`);
  await mkdir(work, { recursive: true });
  if (!engines[o.engine].publishable) console.log('Engine: macOS say — drafts only (Apple\'s licence does not allow publishing them).\n');
  let problems = 0;
  try {
    for (const film of films) for (const lang of codes) {
      const { file, report, bytes } = await recordTrack(N, langs, film, lang, o, work);
      console.log(`${film}/${lang} → ${path.relative(root, file)} (${Math.round(bytes / 1024)} KB)`);
      for (const r of report) {
        const flag = r.status === 'ok' ? '' : `  ← ${r.status}`;
        if (r.status === 'TOO LONG') problems++;
        console.log(`  ${r.id.padEnd(4)} ${r.said.toFixed(2)} s said, ${r.dur.toFixed(2)} s placed in a ${r.max.toFixed(2)} s slot${r.k > 1 ? ` (×${r.k.toFixed(2)})` : ''}${flag}`);
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  if (problems) {
    console.log(`\n${problems} line(s) run into the next one even at ×${o.maxTempo}: shorten those translations in docs/promo.html.`);
    process.exitCode = 1;
  }
}

export function readNarration(html) {
  const m = html.match(/<script type="application\/json" id="narration">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('docs/promo.html: no <script type="application/json" id="narration"> block');
  return JSON.parse(m[1]);
}

// Run as a script, not when a test imports the helpers above.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(e => { console.error(e.message || e); process.exit(1); });
}
