const js = require('@eslint/js');

const nodeGlobals = {
  require: 'readonly', module: 'writable', exports: 'writable', process: 'readonly', console: 'readonly',
  __dirname: 'readonly', Buffer: 'readonly', URL: 'readonly', AbortSignal: 'readonly', fetch: 'readonly', URLSearchParams: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', setImmediate: 'readonly'
};
const browserGlobals = {
  window: 'readonly', document: 'readonly', location: 'readonly', history: 'readonly', navigator: 'readonly',
  fetch: 'readonly', sessionStorage: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', Blob: 'readonly',
  console: 'readonly', io: 'readonly', Chart: 'readonly', getComputedStyle: 'readonly', requestAnimationFrame: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly'
};
// extension/: plain scripts for the Chrome service worker, the popup and the content script (extension/lib/ is vendored and not linted).
const extensionGlobals = {
  chrome: 'readonly', importScripts: 'readonly', self: 'readonly', io: 'readonly', module: 'writable', window: 'readonly', document: 'readonly',
  Element: 'readonly', URL: 'readonly', fetch: 'readonly', AbortSignal: 'readonly', console: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly'
};
const jestGlobals = { describe: 'readonly', test: 'readonly', it: 'readonly', expect: 'readonly', jest: 'readonly', beforeAll: 'readonly', afterAll: 'readonly', beforeEach: 'readonly', afterEach: 'readonly' };

module.exports = [
  js.configs.recommended,
  { files: ['src/**/*.js', 'eslint.config.js'], languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: nodeGlobals } },
  { files: ['tests/**/*.js'], languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...nodeGlobals, ...jestGlobals, TextEncoder: 'readonly', TextDecoder: 'readonly' } } },
  { files: ['public/js/**/*.js'], languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: browserGlobals } },
  { files: ['extension/*.js'], languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: extensionGlobals } },
  {
    rules: {
      'no-unused-vars': ['warn', { args: 'after-used', argsIgnorePattern: '^_', ignoreRestSiblings: true, caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  }
];
