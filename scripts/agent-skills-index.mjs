#!/usr/bin/env node
// Keeps src/.well-known/agent-skills/index.json in step with the SKILL.md files
// beside it. Each entry carries a sha256 digest of its SKILL.md, so an agent can
// tell a cached copy is stale — which means ANY edit to a SKILL.md must refresh
// the index, or agents are told the file they just fetched is corrupt.
//
//   node scripts/agent-skills-index.mjs          check (make lint, CI)
//   node scripts/agent-skills-index.mjs --write  rewrite the index (make agent-skills)
//
// name and description come from the SKILL.md front matter; the index is
// generated, never edited by hand.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'src/.well-known/agent-skills';
const INDEX = join(DIR, 'index.json');
const SCHEMA = 'https://schemas.agentskills.io/discovery/0.2.0/schema.json';

function frontMatter(text, file) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error(`${file}: no front matter`);
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  if (!out.name || !out.description) throw new Error(`${file}: front matter needs name and description`);
  return out;
}

function build() {
  const skills = readdirSync(DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(DIR, d.name, 'SKILL.md')))
    .map((d) => d.name)
    .sort()
    .map((dir) => {
      const file = join(DIR, dir, 'SKILL.md');
      const bytes = readFileSync(file);
      const fm = frontMatter(bytes.toString('utf8'), file);
      if (fm.name !== dir) throw new Error(`${file}: name "${fm.name}" must match its folder "${dir}"`);
      return {
        name: fm.name,
        type: 'skill-md',
        description: fm.description,
        url: `/.well-known/agent-skills/${dir}/SKILL.md`,
        digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
      };
    });
  return JSON.stringify({ $schema: SCHEMA, skills }, null, 2) + '\n';
}

const want = build();
if (process.argv.includes('--write')) {
  writeFileSync(INDEX, want);
  console.log(`✓ wrote ${INDEX}`);
} else if (!existsSync(INDEX) || readFileSync(INDEX, 'utf8') !== want) {
  console.error(`✗ ${INDEX} is out of date with its SKILL.md files — run: make agent-skills`);
  process.exit(1);
} else {
  console.log('✓ agent-skills index up to date');
}
