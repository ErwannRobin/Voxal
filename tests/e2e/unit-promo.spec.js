// docs/promo.html — the 30-second film and its exporter. The page is standalone
// (no server, no module system), so it is opened straight from disk.
//
// What is pinned here is what the exporter depends on: renderFrame(t) is a
// pure function of t (the exporter renders frames in any order, and motion
// blur samples between them), it works in all three frame shapes, and the
// hand-written MP4/WebM writers produce containers laid out the way players
// expect. A full 30 s export is too slow for this suite; see
// KNOWLEDGE/learning.md for how the real exports were checked with ffmpeg.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect } from './fixtures.js';

const PAGE = pathToFileURL(path.resolve('docs/promo.html')).href;

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
});
