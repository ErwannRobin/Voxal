// Shared by scripts/integration-footage.mjs and scripts/integration-bench.mjs
// (docs/integration-evaluation.md): the clip list, and the arithmetic of a
// blind paired comparison.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CLIPS_CSV = join(ROOT, 'tests', 'bench', 'integration', 'clips.csv');
export const FOOTAGE = join(ROOT, 'bench-results', 'integration', 'footage');

// RFC 4180 enough for a hand-edited list: quoted fields, doubled quotes, commas.
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== '')) rows.push(row);
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] || '').trim()])));
}

// The clip list, with the file each Pexels page serves (its download endpoint
// redirects to the HD rendition; the page itself refuses scripted requests).
export function readClips(file = CLIPS_CSV) {
  return parseCsv(readFileSync(file, 'utf8')).map((c) => {
    const m = c.link.match(/pexels\.com\/video\/.*?(\d+)\/?$/);
    return {
      ...c,
      use: c.use !== 'no',
      start: Number(c.start) || 0,
      seconds: Number(c.seconds) || 5,
      download: m ? `https://www.pexels.com/download/video/${m[1]}/` : null
    };
  });
}

// --clips accepts ids, or words matched against the situation column
// ("glasses", "low light"); empty = every usable clip.
export function selectClips(clips, filter) {
  const usable = clips.filter((c) => c.use && c.download);
  if (!filter || !filter.length) return usable;
  return usable.filter((c) => filter.some((f) => c.id === f || c.situation.toLowerCase().includes(f.toLowerCase())));
}

// Wilson score interval for k wins out of n (95% by default): what a win rate
// from a few dozen judgements can and cannot claim.
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

// Small deterministic PRNG (mulberry32), so a judging page's order and sides
// are fixed by its seed and two people judging the same run see the same thing.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Every pair of variants for every clip x background, in a shuffled order,
// each with a random side: the judge never knows which one is which.
export function schedule(cells, variants, seed) {
  const r = rng(seed), trials = [];
  for (const cell of cells) {
    for (let i = 0; i < variants.length; i++) for (let j = i + 1; j < variants.length; j++) {
      const swap = r() < 0.5;
      trials.push({ ...cell, left: swap ? variants[j] : variants[i], right: swap ? variants[i] : variants[j] });
    }
  }
  for (let i = trials.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [trials[i], trials[j]] = [trials[j], trials[i]]; }
  return trials;
}
