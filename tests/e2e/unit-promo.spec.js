// docs/promo.html — the films (the 30-second introduction and "Virtual
// backgrounds") and their exporter. The page is standalone (no server, no
// module system), so it is opened straight from disk.
//
// What is pinned here is what the exporter depends on: renderFrame(t) is a
// pure function of t (the exporter renders frames in any order, and motion
// blur samples between them), it works in all three frame shapes, and the
// hand-written MP4/WebM writers produce containers laid out the way players
// expect. A full export is too slow for this suite; see KNOWLEDGE/learning.md
// for how the real exports were checked with ffmpeg.
//
// The narration is pinned too: every line in every language the app speaks,
// slots that never overlap, a mix that ducks the music, subtitles that wrap,
// and the generator's fingerprint of the lines matching the page's. The voice
// recordings themselves are not in the repository's tests (drafts are
// gitignored), so the voice path is exercised with a recording made here.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect } from './fixtures.js';
import { narrationHash as generatorHash, readNarration } from '../../scripts/promo-voice.mjs';

const PAGE = pathToFileURL(path.resolve('docs/promo.html')).href;
const ready = page => page.waitForFunction(() => typeof ICON_IMG !== 'undefined' && ICON_IMG !== null);

test.describe('promo film page', () => {
  test('loads without errors and renders the film deterministically in every frame shape', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(PAGE + '?t=13.2');
    await page.waitForFunction(() => typeof ICON_IMG !== 'undefined' && ICON_IMG !== null);

    const result = await page.evaluate(() => {
      const hash = (w, h, t) => {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d', { alpha: false, willReadFrequently: true });
        renderFrame(g, w, h, t);
        const d = g.getImageData(0, 0, w, h).data;
        let x = 2166136261, lit = 0;
        for (let i = 0; i < d.length; i += 4) {
          x = Math.imul(x ^ d[i] ^ (d[i + 1] << 8) ^ (d[i + 2] << 16), 16777619) >>> 0;
          if (d[i] + d[i + 1] + d[i + 2] > 240) lit++;
        }
        return { x, lit };
      };
      const out = {};
      for (const [name, w, h] of [['land', 320, 180], ['sq', 240, 240], ['port', 180, 320]]) {
        const a = hash(w, h, 13.2), b = hash(w, h, 13.2), c = hash(w, h, 27.9);
        out[name] = { same: a.x === b.x, differs: a.x !== c.x, lit: a.lit };
      }
      return out;
    });
    for (const k of ['land', 'sq', 'port']) {
      expect(result[k].same, `${k}: same t, same pixels`).toBe(true);
      expect(result[k].differs, `${k}: different t, different pixels`).toBe(true);
      expect(result[k].lit, `${k}: the frame is not blank`).toBeGreaterThan(20);
    }
    expect(errors).toEqual([]);
  });

  test('the MP4 and WebM writers lay out real encoder output correctly', async ({ page }) => {
    await page.goto(PAGE + '?t=0');
    await page.waitForFunction(() => typeof ICON_IMG !== 'undefined' && ICON_IMG !== null);
    const supported = await page.evaluate(async () => 'VideoEncoder' in window
      && (await VideoEncoder.isConfigSupported({ codec: 'vp09.00.10.08', width: 320, height: 180, bitrate: 5e5, framerate: 30 })).supported);
    test.skip(!supported, 'no VP9 WebCodecs encoder in this browser');

    const r = await page.evaluate(async () => {
      const samples = [];
      const enc = new VideoEncoder({
        output: chunk => { const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d); samples.push({ data: d, ts: chunk.timestamp, dur: chunk.duration, key: chunk.type === 'key' }); },
        error: () => {},
      });
      enc.configure({ codec: 'vp09.00.10.08', width: 320, height: 180, bitrate: 5e5, framerate: 30 });
      const c = document.createElement('canvas');
      c.width = 320; c.height = 180;
      const g = c.getContext('2d', { alpha: false });
      for (let i = 0; i < 12; i++) {
        renderFrame(g, 320, 180, i / 30);
        const f = new VideoFrame(c, { timestamp: Math.round(i * 1e6 / 30), duration: Math.round(1e6 / 30) });
        enc.encode(f, { keyFrame: i === 0 });
        f.close();
      }
      await enc.flush();
      const video = { codec: 'vp09.00.10.08', width: 320, height: 180, fps: 30, samples };
      const mp4 = new Uint8Array(await new Blob(MUX.muxMP4({ video })).arrayBuffer());
      const webm = new Uint8Array(await new Blob(MUX.muxWebM({ video })).arrayBuffer());

      // Top-level MP4 boxes, and the first chunk offset from stco.
      const dv = new DataView(mp4.buffer);
      const boxes = [];
      let o = 0, stco = -1;
      while (o < mp4.length) {
        const size = dv.getUint32(o), type = String.fromCharCode(...mp4.subarray(o + 4, o + 8));
        boxes.push(type);
        if (type === 'moov') {
          for (let i = o; i < o + size - 4; i++) {
            if (mp4[i] === 0x73 && mp4[i + 1] === 0x74 && mp4[i + 2] === 0x63 && mp4[i + 3] === 0x6f) { stco = dv.getUint32(i + 12); break; }
          }
        }
        o += size;
      }
      const first = samples[0].data;
      const atOffset = Array.from(mp4.subarray(stco, stco + 16));
      return {
        frames: samples.length, boxes, end: o === mp4.length,
        stcoPointsAtFirstFrame: JSON.stringify(atOffset) === JSON.stringify(Array.from(first.subarray(0, 16))),
        webmMagic: Array.from(webm.subarray(0, 4)),
        webmHasSegment: webm.findIndex((v, i) => v === 0x18 && webm[i + 1] === 0x53 && webm[i + 2] === 0x80 && webm[i + 3] === 0x67) > 0,
        webmHasCues: webm.findIndex((v, i) => v === 0x1c && webm[i + 1] === 0x53 && webm[i + 2] === 0xbb && webm[i + 3] === 0x6b) > 0,
      };
    });
    expect(r.frames).toBe(12);
    expect(r.boxes).toEqual(['ftyp', 'moov', 'mdat']); // "fast start": the index before the data
    expect(r.end).toBe(true);
    expect(r.stcoPointsAtFirstFrame).toBe(true);
    expect(r.webmMagic).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    expect(r.webmHasSegment).toBe(true);
    expect(r.webmHasCues).toBe(true);
  });

  test('the virtual-backgrounds film renders deterministically in every frame shape, every chapter', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(PAGE + '?t=0');
    await ready(page);
    const result = await page.evaluate(() => {
      const hash = (w, h, t) => {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d', { alpha: false, willReadFrequently: true });
        renderFrame(g, w, h, t, { film: 'backgrounds' });
        const d = g.getImageData(0, 0, w, h).data;
        let x = 2166136261, lit = 0;
        for (let i = 0; i < d.length; i += 4) {
          x = Math.imul(x ^ d[i] ^ (d[i + 1] << 8) ^ (d[i + 2] << 16), 16777619) >>> 0;
          if (d[i] + d[i + 1] + d[i + 2] > 240) lit++;
        }
        return { x, lit };
      };
      const out = {};
      // One moment inside each chapter, and the transitions between them.
      const times = [2, 3.6, 8, 9, 14.8, 16.4, 20, 22.6, 28.6, 31.8, 35.3, 41.3, 44.3, 47];
      for (const [name, w, h] of [['land', 320, 180], ['sq', 240, 240], ['port', 180, 320]]) {
        out[name] = times.map(t => { const a = hash(w, h, t), b = hash(w, h, t); return { t, same: a.x === b.x, x: a.x, lit: a.lit }; });
      }
      return { out, dur: FILMS.backgrounds.dur, chapters: FILMS.backgrounds.chapters.length };
    });
    expect(result.dur).toBe(48);
    for (const k of ['land', 'sq', 'port']) {
      for (const f of result.out[k]) {
        expect(f.same, `${k} @${f.t}: same t, same pixels`).toBe(true);
        expect(f.lit, `${k} @${f.t}: the frame is not blank`).toBeGreaterThan(20);
      }
      expect(new Set(result.out[k].map(f => f.x)).size, `${k}: the film moves`).toBe(result.out[k].length);
    }
    expect(errors).toEqual([]);
  });

  test('the narration has every line in every language the app speaks, each in a slot of its own', async ({ page }) => {
    // The app's languages, from src/i18n.js — the film must speak all of them.
    const appLangs = [...fs.readFileSync('src/i18n.js', 'utf8').matchAll(/\{ code: '([a-z]+)', native:/g)].map(m => m[1]);
    expect(appLangs.length).toBeGreaterThanOrEqual(12);
    await page.goto(PAGE + '?t=0');
    await ready(page);
    const N = await page.evaluate(() => ({ narration: NARRATION, durs: Object.fromEntries(Object.entries(FILMS).map(([k, f]) => [k, f.dur])) }));
    expect(N.narration.languages.map(l => l.code)).toEqual(appLangs);
    for (const [film, F] of Object.entries(N.narration.films)) {
      expect(F.dur, `${film}: the narration's length is the film's`).toBe(N.durs[film]);
      F.cues.forEach((c, i) => {
        const next = i + 1 < F.cues.length ? F.cues[i + 1].t : F.dur;
        expect(c.t + c.max, `${film}/${c.id} ends before the next line starts`).toBeLessThanOrEqual(next + 1e-9);
        for (const l of appLangs) expect((c.text[l] || '').trim(), `${film}/${c.id} in ${l}`).not.toBe('');
      });
    }
    // The generator fingerprints the lines exactly as the page does, or every
    // recording would read as stale (or a stale one as fresh).
    const fromFile = readNarration(fs.readFileSync('docs/promo.html', 'utf8'));
    const langs = Object.fromEntries(fromFile.languages.map(l => [l.code, l]));
    const pageHashes = await page.evaluate(() => Object.keys(NARRATION.films).flatMap(f => NARRATION.languages.map(l => narrationHash(f, l.code))));
    const fileHashes = Object.keys(fromFile.films).flatMap(f => fromFile.languages.map(l => generatorHash(fromFile, f, l.code, langs)));
    expect(fileHashes).toEqual(pageHashes);
    expect(new Set(pageHashes).size).toBe(pageHashes.length);
  });

  test('a voice track is mixed under the music: the music ducks for each line, the peak stays at −1 dBFS', async ({ page }) => {
    await page.goto(PAGE + '?t=0');
    await ready(page);
    const r = await page.evaluate(async () => {
      const sr = AUDIO_SR, n = sr * 10;
      const music = new AudioBuffer({ numberOfChannels: 2, length: n, sampleRate: sr });
      for (let c = 0; c < 2; c++) { const d = music.getChannelData(c); for (let i = 0; i < n; i++) d[i] = 0.5 * Math.sin(i * 0.05); }
      const silent = new AudioBuffer({ numberOfChannels: 1, length: n, sampleRate: sr });
      const rms = (buf, a, b) => { const d = buf.getChannelData(0); let s = 0; for (let i = a * sr; i < b * sr; i++) s += d[i] * d[i]; return Math.sqrt(s / ((b - a) * sr)); };
      const peak = buf => { let p = 0; for (let c = 0; c < buf.numberOfChannels; c++) for (const v of buf.getChannelData(c)) p = Math.max(p, Math.abs(v)); return p; };
      const cues = [{ id: 'x', t: 4, dur: 1 }];
      const ducked = mixNarration(music, { buffer: silent, cues });
      // A loud voice line: the mix is brought back down to the score's peak.
      const loud = new AudioBuffer({ numberOfChannels: 1, length: n, sampleRate: sr });
      { const d = loud.getChannelData(0); for (let i = 4 * sr; i < 5 * sr; i++) d[i] = 0.95 * Math.sin(i * 0.11); }
      const mixed = mixNarration(music, { buffer: loud, cues });
      return {
        outside: rms(ducked, 1, 2), under: rms(ducked, 4.2, 4.8), before: rms(ducked, 3.0, 3.6), after: rms(ducked, 6, 7),
        peak: peak(mixed), quietPeak: peak(ducked), voiceThere: rms(mixed, 4.2, 4.8) > rms(ducked, 4.2, 4.8) * 2,
      };
    });
    expect(r.under / r.outside).toBeCloseTo(0.3 / 0.85, 2);
    expect(r.before).toBeCloseTo(r.outside, 3);
    expect(r.after).toBeCloseTo(r.outside, 3);
    expect(r.peak).toBeLessThanOrEqual(0.8901);
    expect(r.peak).toBeGreaterThan(0.88);
    expect(r.quietPeak).toBeLessThan(0.45); // nothing loud: nothing normalised up
    expect(r.voiceThere).toBe(true);
  });

  test('a recording registers itself, decodes, and is recognised as stale once its lines change', async ({ page }) => {
    await page.goto(PAGE + '?t=0');
    await ready(page);
    const r = await page.evaluate(async () => {
      // A one-second recording, written the way the generator writes one.
      const buf = new AudioBuffer({ numberOfChannels: 1, length: AUDIO_SR, sampleRate: AUDIO_SR });
      const d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = 0.3 * Math.sin(i * 0.06);
      const bytes = new Uint8Array(await audioBufferToWav(buf).arrayBuffer());
      let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
      const audio = 'data:audio/wav;base64,' + btoa(bin);
      const cues = NARRATION.films.intro.cues.map(c => ({ id: c.id, t: c.t, dur: 0.5, tempo: 1 }));
      window.VOX_VOICE = { 'intro/fr': { film: 'intro', lang: 'fr', engine: 'say', voice: 'Thomas', publishable: false, text: narrationHash('intro', 'fr'), cues, audio } };
      const fresh = await loadVoice('intro', 'fr');
      const stale = await decodeVoice({ ...window.VOX_VOICE['intro/fr'], text: '00000000' }, 'intro', 'fr');
      const subsFresh = subtitlesFor('intro', 'fr', fresh), subsStale = subtitlesFor('intro', 'fr', stale);
      return {
        stale: [fresh.stale, stale.stale], len: fresh.buffer.length, sr: fresh.buffer.sampleRate,
        // Subtitles follow a fresh recording's real durations, a stale one's slots.
        durs: [subsFresh.cues[0].dur, subsStale.cues[0].dur, NARRATION.films.intro.cues[0].max],
      };
    });
    expect(r.stale).toEqual([false, true]);
    expect(r.sr).toBe(48000);
    expect(Math.abs(r.len - 48000)).toBeLessThan(200);
    expect(r.durs[0]).toBe(0.5);
    expect(r.durs[1]).toBe(r.durs[2]);
  });

  test('subtitles burn in deterministically, and wrap inside the frame in every language', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(PAGE + '?t=0');
    await ready(page);
    const r = await page.evaluate(() => {
      const frame = (lang, t) => {
        const c = document.createElement('canvas');
        c.width = 320; c.height = 180;
        const g = c.getContext('2d', { alpha: false, willReadFrequently: true });
        renderFrame(g, 320, 180, t, { film: 'backgrounds', subs: lang ? subtitlesFor('backgrounds', lang, null) : null });
        const d = g.getImageData(0, 0, 320, 180).data;
        let x = 2166136261;
        for (let i = 0; i < d.length; i += 4) x = Math.imul(x ^ d[i] ^ (d[i + 1] << 8) ^ (d[i + 2] << 16), 16777619) >>> 0;
        return x;
      };
      const cues = NARRATION.films.backgrounds.cues, t = cues[2].t + 1;
      // The middle of the longest silence between two lines.
      let quiet = 0, gap = 0;
      cues.forEach((c, i) => { if (i + 1 < cues.length && cues[i + 1].t - (c.t + c.max) > gap) { gap = cues[i + 1].t - (c.t + c.max); quiet = c.t + c.max + gap / 2; } });
      const g = document.createElement('canvas').getContext('2d');
      const widest = {};
      for (const l of NARRATION.languages) {
        g.font = FT(40, 600);
        g.direction = l.rtl ? 'rtl' : 'ltr';
        let w = 0, lines = 0;
        for (const F of Object.values(NARRATION.films)) for (const c of F.cues) {
          const ls = subLines(g, c.text[l.code], 1240, l.code);
          lines = Math.max(lines, ls.length);
          for (const s of ls) w = Math.max(w, g.measureText(s).width);
        }
        widest[l.code] = { w, lines };
      }
      return {
        plain: frame(null, t), en: [frame('en', t), frame('en', t)], ar: frame('ar', t), ja: frame('ja', t),
        between: [frame(null, quiet), frame('en', quiet)], gap, widest,
      };
    });
    expect(r.en[0]).toBe(r.en[1]);
    expect(r.en[0]).not.toBe(r.plain);
    expect(new Set([r.plain, r.en[0], r.ar, r.ja]).size).toBe(4);
    expect(r.gap).toBeGreaterThan(0.8);
    expect(r.between[0], 'between two lines: no subtitle').toBe(r.between[1]);
    for (const [l, { w, lines }] of Object.entries(r.widest)) {
      expect(w, `${l}: lines fit the 16:9 width`).toBeLessThanOrEqual(1241);
      expect(lines, `${l}: at most two lines`).toBeLessThanOrEqual(2);
    }
    expect(errors).toEqual([]);
  });

  test('with no narration the page still makes the original film, under its original name', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(PAGE + '?t=3');
    await ready(page);
    const r = await page.evaluate(() => {
      const base = () => { const s = settings(); return `${exportBase(s)}-${s.w}x${s.h}-${s.fps}fps · ${s.frames}`; };
      const original = base();
      const opts = settings().opts;
      setFilm('backgrounds');
      const second = base();
      player.lang = 'fr'; player.subsOn = true;
      const subs = base();
      setFilm('intro'); player.lang = ''; player.subsOn = false;
      return { original, second, subs, opts, chapters: document.querySelectorAll('#chapters button').length, dur: document.getElementById('tc-dur').textContent };
    });
    expect(r.original).toBe('voxal-30s-1920x1080-30fps · 900');
    expect(r.opts).toEqual({ film: 'intro', subs: null });
    expect(r.second).toBe('voxal-backgrounds-1920x1080-30fps · 1440');
    expect(r.subs).toBe('voxal-backgrounds-fr-subs-1920x1080-30fps · 1440');
    expect(r.chapters).toBe(7);
    expect(r.dur).toBe('00:30.00');
    expect(errors).toEqual([]);
  });

  test('the narrated film opens from its URL without errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(PAGE + '?film=backgrounds&lang=ja&subs=1&t=20');
    await ready(page);
    await expect(page.locator('#voice-status')).not.toHaveText('');
    await expect(page.locator('#voice-status')).not.toHaveText('Loading the voice…', { timeout: 15000 });
    const r = await page.evaluate(() => ({ film: player.film, lang: player.lang, subs: player.subsOn, title: document.title, dur: document.getElementById('tc-dur').textContent, lang2: document.getElementById('lang').value }));
    expect(r).toEqual({ film: 'backgrounds', lang: 'ja', subs: true, title: 'Voxal: Virtual Backgrounds', dur: '00:48.00', lang2: 'ja' });
    expect(errors).toEqual([]);
  });
});
