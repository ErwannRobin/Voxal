#!/usr/bin/env node
// Regenerates src/emoji-data.js from Unicode's own emoji-test.txt (UTS #51).
//
//   node scripts/gen-emoji-data.mjs [path-or-url]
//
// Keeps fully-qualified sequences only and drops the skin-tone variants: they
// are five near-duplicates of every human emoji, which triples the file for a
// choice the picker does not offer. Emits one "<emoji> <name>" line per entry,
// grouped, as a plain string per group — the parse is one split() on first use
// and the source is a third of the size of the equivalent JSON literal.

import { writeFileSync, readFileSync } from 'node:fs';

const SOURCE = process.argv[2] || 'https://unicode.org/Public/emoji/latest/emoji-test.txt';
const OUT = new URL('../src/emoji-data.js', import.meta.url);

const ICONS = {
  'Smileys & Emotion': '\u{1F600}',
  'People & Body': '\u{1F44B}',
  'Animals & Nature': '\u{1F43B}',
  'Food & Drink': '\u{1F355}',
  'Travel & Places': '✈️',
  'Activities': '⚽',
  'Objects': '\u{1F4A1}',
  'Symbols': '❤️',
  'Flags': '\u{1F3C1}',
};
const SKIN = new Set([0x1f3fb, 0x1f3fc, 0x1f3fd, 0x1f3fe, 0x1f3ff]);

const raw = /^https?:/.test(SOURCE)
  ? await fetch(SOURCE).then((r) => r.text())
  : readFileSync(SOURCE, 'utf8');

const groups = [];
for (const line of raw.split('\n')) {
  const group = /^# group:\s*(.+)$/.exec(line);
  if (group) { groups.push({ name: group[1].trim(), items: [] }); continue; }
  if (!line || line.startsWith('#')) continue;
  const m = /^([0-9A-F ]+);\s*(\S+)\s*#\s*(\S+)\s+E[\d.]+\s+(.*)$/.exec(line);
  if (!m || m[2] !== 'fully-qualified' || !groups.length) continue;
  if (m[1].trim().split(' ').some((cp) => SKIN.has(parseInt(cp, 16)))) continue;
  groups[groups.length - 1].items.push([m[3], m[4].trim()]);
}

const kept = groups.filter((g) => g.items.length && ICONS[g.name]);
const total = kept.reduce((n, g) => n + g.items.length, 0);

const body = kept
  .map((g) => {
    const data = g.items.map(([ch, name]) => `${ch} ${name}`).join('\\n');
    return `  { name: ${JSON.stringify(g.name)}, icon: ${JSON.stringify(ICONS[g.name])}, data: "${data}" },`;
  })
  .join('\n');

writeFileSync(OUT, `/* voxal – emoji-data.js
 *
 * GENERATED — do not edit. Run \`node scripts/gen-emoji-data.mjs\` to refresh.
 *
 * The emoji picker's dataset, taken from Unicode's own emoji-test.txt (UTS
 * #51): fully-qualified sequences only, skin-tone variants dropped. ${total} emoji.
 *
 * Vendored for the same reason PeerJS is — nothing here is fetched from a CDN
 * at runtime. Loaded as a classic script, so the single global it declares
 * shares one lexical scope with main.js (see "Shared classic scripts" in
 * CLAUDE.md); everything else the picker needs lives in main.js.
 *
 * Each group's \`data\` is one string of "<emoji> <name>" lines rather than an
 * array of objects: one split() on first use, and a third of the source size.
 */

window.EMOJI_GROUPS = [
${body}
];
`);
console.log(`${kept.length} groups, ${total} emoji -> src/emoji-data.js`);
