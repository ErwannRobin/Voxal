// ESLint — correctness only. Formatting is deliberately not enforced here (no
// Prettier, no stylistic rules): the goal is to catch bugs before they reach
// CI, not to restyle the codebase. Run by the pre-commit hook on staged files
// (.githooks/pre-commit) and by `npm run lint` / `make lint` on everything.
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'coverage-api/**',
      'test-results/**',
      'playwright-report/**',
      'bench-results/**',
      'src-tauri/target/**',
      'ios/**',
      'android/**',
      'ds-bundle/**',
      '.design-sync/**',
      // Vendored / generated — not ours to lint.
      'src/assets/peerjs.min.js',
      'src/assets/seg/**',
      'src/emoji-data.js',
      'src/build-info.js',
    ],
  },

  js.configs.recommended,

  // The codebase's own idioms: `catch (_) {}` is how a best-effort call says
  // "failure is fine here", and a leading underscore marks a deliberately
  // unused binding.
  {
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', {
        caughtErrors: 'none',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
    },
  },

  // The frontend: classic scripts, no modules, no bundler. They share ONE
  // global scope (see CLAUDE.md, "Shared classic scripts"), so what one file
  // declares at top level another may use.
  {
    files: ['src/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
        // Declared by one classic script, used by another (or by an HTML
        // page's inline script). Loaded before main.js — see index.html.
        Peer: 'readonly', // src/assets/peerjs.min.js
        VOXAL_VERSION: 'readonly', // src/version.js
        VOXAL_BUILD_DATE: 'readonly', // src/version.js / build-info.js
        VideoEffects: 'readonly', // src/video-effects.js
        EMOJI_GROUPS: 'readonly', // src/emoji-data.js
        NET_USAGE_KINDS: 'readonly', // src/net-usage.js
        NET_USAGE_HISTORY_MAX: 'readonly',
        renderNetUsageSummary: 'readonly',
        renderNetUsageDetail: 'readonly',
        // window.* hooks main.js installs late and calls behind a typeof guard.
        updateConnectVisibility: 'readonly',
        updateDisconnectVisibility: 'readonly',
        updateTurnBadge: 'readonly',
      },
    },
    rules: {
      // The globals above are declared by one of these very files.
      'no-redeclare': ['error', { builtinGlobals: false }],
      // A top-level declaration here is a global the other scripts, the HTML
      // pages and the E2E tests reach — "unused in this file" is not unused.
      'no-unused-vars': ['error', {
        vars: 'local',
        // Event handlers and hooks keep their full signature for the reader.
        args: 'none',
        caughtErrors: 'none',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
    },
  },
  {
    files: ['src/assets/rnnoise-processor.js'],
    languageOptions: {
      globals: { ...globals.audioWorklet },
    },
  },

  // Node: serverless API, scripts, tests, configs (package.json is "type": "module").
  {
    files: ['api/**/*.js', 'scripts/**/*.mjs', 'tests/**/*.js', '*.js', '*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  // Tests hand callbacks to page.evaluate(), which run in the page and reach
  // the app's own globals (hundreds of main.js top-level names), so no-undef
  // cannot tell a typo from a page global there.
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    linterOptions: {
      // Older `eslint-disable no-undef` comments, made moot by the rule below.
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      'no-undef': 'off',
      // Playwright fixtures that use no other fixture are written `async ({}, use)`.
      'no-empty-pattern': 'off',
    },
  },
];
