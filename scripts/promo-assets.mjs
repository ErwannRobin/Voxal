#!/usr/bin/env node
// Refreshes the assets embedded at the end of docs/promo.html (`make promo-assets`).
//
// The film page is one self-contained file so it works offline, from file://,
// and exports look the same everywhere — which means its fonts and the app
// icon live inside it as base64. This rewrites that one block
// (`window.VOX_ASSETS = { … };`) from:
//   - src/assets/icon-512.png (run this after the app icon changes)
//   - Archivo (latin, variable wdth 62–125 / wght 100–900) and IBM Plex Mono
//     500 (latin), both SIL OFL, fetched from Google Fonts' static host.
// Everything else in the page is hand-written; edit it in place.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = path.join(root, 'docs/promo.html');
const ICON = path.join(root, 'src/assets/icon-512.png');
const FONTS = {
  archivo: 'https://fonts.gstatic.com/s/archivo/v25/k3kQo8UDI-1M0wlSfdnoLg.woff2',
  mono: 'https://fonts.gstatic.com/s/ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3twJwlBFgg.woff2',
};

async function b64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer()).toString('base64');
}

const html = await readFile(PAGE, 'utf8');
const block = /window\.VOX_ASSETS = \{[\s\S]*?\n\};/;
if (!block.test(html)) throw new Error('docs/promo.html: no `window.VOX_ASSETS = { … };` block found');

const assets = {
  archivo: await b64(FONTS.archivo),
  mono: await b64(FONTS.mono),
  icon: 'data:image/png;base64,' + (await readFile(ICON)).toString('base64'),
};
const next = 'window.VOX_ASSETS = {\n'
  + `  archivo: "${assets.archivo}",\n`
  + `  mono: "${assets.mono}",\n`
  + `  icon: "${assets.icon}"\n`
  + '};';
await writeFile(PAGE, html.replace(block, () => next));
const kb = n => Math.round(n / 1024) + ' KB';
console.log(`docs/promo.html: fonts ${kb(assets.archivo.length + assets.mono.length)}, icon ${kb(assets.icon.length)} (base64)`);
