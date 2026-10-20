import { test, expect } from './fixtures.js';
import fs from 'node:fs';

// The segmentation loader .js and .wasm are a matched pair under unchanging
// filenames; video-effects.js keys its URLs and CacheStorage on
// SEG_RUNTIME_VERSION so a bump never pairs a stale binary with a new loader.
// A dependabot bump of @mediapipe/tasks-vision must therefore update it too.
test('SEG_RUNTIME_VERSION matches the pinned @mediapipe/tasks-vision', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const pinned = pkg.devDependencies['@mediapipe/tasks-vision'] || pkg.dependencies['@mediapipe/tasks-vision'];
  const src = fs.readFileSync('src/video-effects.js', 'utf8');
  const m = src.match(/var SEG_RUNTIME_VERSION = '([^']+)'/);
  expect(m).not.toBeNull();
  expect(m[1]).toBe(pinned);
});
