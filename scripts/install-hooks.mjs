// Points git at the repository's own hooks (.githooks/). Run by npm's
// `prepare` lifecycle, i.e. on every `npm install` / `npm ci`.
//
// Must never fail an install: Vercel's build, a tarball checkout and CI all
// run `npm ci` where there may be no .git or no git at all — those are silent
// no-ops. A hooksPath someone set on purpose (another hook manager) is left
// alone, with a note.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const HOOKS_PATH = '.githooks';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

try {
  if (process.env.CI || !existsSync('.git')) process.exit(0);

  let current = '';
  try { current = git('config', '--local', '--get', 'core.hooksPath'); } catch { /* unset */ }

  if (current === HOOKS_PATH) process.exit(0);
  if (current) {
    console.log(`[hooks] core.hooksPath is already "${current}" — leaving it. ` +
      `To use Voxal's hooks: git config core.hooksPath ${HOOKS_PATH}`);
    process.exit(0);
  }

  git('config', '--local', 'core.hooksPath', HOOKS_PATH);
  console.log(`[hooks] Git hooks installed (core.hooksPath=${HOOKS_PATH}). Bypass once with --no-verify.`);
} catch {
  // No git binary, not a work tree, read-only config… never block an install.
}
