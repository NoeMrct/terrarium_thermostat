// Configuration ESLint (format « flat »). Règles recommandées, deux
// environnements : le navigateur pour app/, Node pour outils/. Rien
// d'esthétique : le but est d'attraper ce qui est faux, pas ce qui est moche.
'use strict';

const js = require('./outils/node_modules/@eslint/js');

const navigateur = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly', history: 'readonly',
  localStorage: 'readonly', sessionStorage: 'readonly', indexedDB: 'readonly', IDBKeyRange: 'readonly',
  fetch: 'readonly', Blob: 'readonly', URL: 'readonly', FileReader: 'readonly', WebSocket: 'readonly',
  TextEncoder: 'readonly', TextDecoder: 'readonly', Notification: 'readonly', ResizeObserver: 'readonly',
  requestAnimationFrame: 'readonly', getComputedStyle: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly', console: 'readonly', caches: 'readonly', self: 'readonly',
  Event: 'readonly', Uint8Array: 'readonly', ArrayBuffer: 'readonly', Promise: 'readonly', Map: 'readonly',
  Set: 'readonly', WeakMap: 'readonly', Infinity: 'readonly', NaN: 'readonly', isNaN: 'readonly',
  isFinite: 'readonly', parseInt: 'readonly', parseFloat: 'readonly', JSON: 'readonly', Math: 'readonly',
  Date: 'readonly', Number: 'readonly', String: 'readonly', Object: 'readonly', Array: 'readonly',
  Error: 'readonly', Symbol: 'readonly', encodeURIComponent: 'readonly', decodeURIComponent: 'readonly',
  escape: 'readonly', unescape: 'readonly', mqtt: 'readonly', alert: 'readonly',
  crypto: 'readonly', btoa: 'readonly', atob: 'readonly', URLSearchParams: 'readonly', trustedTypes: 'readonly'
};

module.exports = [
  js.configs.recommended,
  { ignores: ['app/installateur/**', 'app/demo.html', '**/node_modules/**', 'outils/couverture/**', 'serveur/donnees/**'] },
  {
    files: ['app/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: navigateur },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'eqeqeq': ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error'
    }
  },
  {
    files: ['app/installer.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: navigateur }
  },
  {
    files: ['outils/*.js', 'eslint.config.js', 'serveur/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', process: 'readonly', __dirname: 'readonly', Buffer: 'readonly',
                 console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
                 clearInterval: 'readonly', fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
                 Uint8Array: 'readonly', Uint8ClampedArray: 'readonly', crypto: 'readonly', __filename: 'readonly', FormData: 'readonly', Blob: 'readonly' } },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'eqeqeq': ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error'
    }
  }
];
