// Keeps src/locales/ honest. English lives in the markup (data-i18n*) and at the
// call sites (tr('key', 'English default', vars)); src/locales/en.json is the
// translators' copy of it, and every other locale file must carry the same keys.
//
//   node scripts/i18n-check.mjs          verify (exit 1 on any problem)
//   node scripts/i18n-check.mjs --write  refresh en.json from the tr() calls
//
// --write only owns the `js.*` keys read out of the code; the markup's keys
// (`ui.*`, `html.*`) are English text in the HTML, so a changed sentence there is
// edited in en.json by hand.
import fs from 'node:fs';
import path from 'node:path';
import * as espree from 'espree';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = path.join(root, 'src/locales');
const write = process.argv.includes('--write');
const LANGS = ['fr', 'es', 'de', 'pt', 'ro', 'ru', 'uk', 'id', 'zh', 'ja', 'ar'];

const errors = [];
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const en = read(path.join(dir, 'en.json'));

// --- what the code asks for ---------------------------------------------------
const htmlKeys = new Set();
for (const f of ['src/index.html', 'src/settings.html']) {
  const text = fs.readFileSync(path.join(root, f), 'utf8');
  for (const m of text.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) htmlKeys.add(m[1]);
}

// The language picker builds its own first option.
for (const m of fs.readFileSync(path.join(root, 'src/i18n.js'), 'utf8').matchAll(/'data-i18n',\s*'([^']+)'/g)) htmlKeys.add(m[1]);

const jsDefaults = new Map(); // key -> default (string | {one, other})
function literalOf(n) {
  if (!n) return undefined;
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis[0].value.cooked;
  if (n.type === 'BinaryExpression' && n.operator === '+') {
    const a = literalOf(n.left), b = literalOf(n.right);
    return a !== undefined && b !== undefined ? a + b : undefined;
  }
  if (n.type === 'ObjectExpression') {
    const o = {};
    for (const p of n.properties) {
      const v = literalOf(p.value);
      if (p.type !== 'Property' || v === undefined) return undefined;
      o[p.key.name ?? p.key.value] = v;
    }
    return o;
  }
  return undefined;
}
function walk(n, file) {
  if (!n || typeof n.type !== 'string') return;
  if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'tr') {
    const key = literalOf(n.arguments[0]);
    const def = literalOf(n.arguments[1]);
    const where = `${file}:${n.loc.start.line}`;
    if (typeof key !== 'string' || def === undefined) errors.push(`${where}: tr() needs a literal key and a literal English default`);
    else if (jsDefaults.has(key) && JSON.stringify(jsDefaults.get(key)) !== JSON.stringify(def)) errors.push(`${where}: key "${key}" is used with two different English texts`);
    else jsDefaults.set(key, def);
  }
  for (const k of Object.keys(n)) {
    if (k === 'loc') continue;
    const v = n[k];
    if (Array.isArray(v)) v.forEach((c) => walk(c, file));
    else if (v && typeof v.type === 'string') walk(v, file);
  }
}
for (const f of ['src/main.js', 'src/video-effects.js', 'src/net-usage.js']) {
  const code = fs.readFileSync(path.join(root, f), 'utf8');
  walk(espree.parse(code, { ecmaVersion: 2024, loc: true }), f);
}

if (write) {
  for (const k of Object.keys(en)) if (k.startsWith('js.') && !jsDefaults.has(k)) delete en[k];
  for (const [k, v] of jsDefaults) en[k] = v;
  const sorted = Object.fromEntries(Object.keys(en).sort().map((k) => [k, en[k]]));
  fs.writeFileSync(path.join(dir, 'en.json'), JSON.stringify(sorted, null, 2) + '\n');
  console.log(`en.json: ${Object.keys(sorted).length} keys`);
  process.exit(0);
}

// --- en.json against the code ---------------------------------------------------
for (const k of htmlKeys) if (!(k in en)) errors.push(`en.json: markup key "${k}" is missing`);
for (const [k, v] of jsDefaults) {
  if (!(k in en)) errors.push(`en.json: code key "${k}" is missing (run with --write)`);
  else if (JSON.stringify(en[k]) !== JSON.stringify(v)) errors.push(`en.json: "${k}" differs from the default in the code (run with --write)`);
}
for (const k of Object.keys(en)) if (!htmlKeys.has(k) && !jsDefaults.has(k)) errors.push(`en.json: "${k}" is not used anywhere`);

// --- every locale against en.json -----------------------------------------------
const vars = (v) => [...new Set(Object.values(typeof v === 'object' ? v : { v }).join(' ').match(/\{\w+\}/g) || [])].sort().join(',');
for (const code of LANGS) {
  const f = path.join(dir, code + '.json');
  if (!fs.existsSync(f)) { errors.push(`${code}.json: missing file`); continue; }
  const loc = read(f);
  for (const k of Object.keys(en)) {
    if (!(k in loc)) { errors.push(`${code}.json: missing "${k}"`); continue; }
    const a = en[k], b = loc[k];
    if ((typeof a === 'object') !== (typeof b === 'object')) errors.push(`${code}.json: "${k}" must${typeof a === 'object' ? '' : ' not'} be a plural object`);
    else if (typeof b === 'object' && !('other' in b)) errors.push(`${code}.json: "${k}" needs an "other" form`);
    else if (vars(a) !== vars(b)) errors.push(`${code}.json: "${k}" placeholders differ (${vars(a) || 'none'} vs ${vars(b) || 'none'})`);
    else if (typeof b === 'string' && !b.trim()) errors.push(`${code}.json: "${k}" is empty`);
  }
  for (const k of Object.keys(loc)) if (!(k in en)) errors.push(`${code}.json: extra key "${k}"`);
}

if (errors.length) {
  console.error(errors.slice(0, 60).join('\n') + (errors.length > 60 ? `\n… and ${errors.length - 60} more` : ''));
  process.exit(1);
}
console.log(`i18n ok: ${Object.keys(en).length} strings × ${LANGS.length + 1} languages`);
