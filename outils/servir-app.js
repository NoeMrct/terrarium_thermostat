'use strict';
/* Petit serveur HTTP pour les bancs qui ouvrent l'application dans un vrai
   navigateur (tests, accessibilité, PDF) : les pages servies en HTTP plutôt
   qu'en file:// voient leur CSP (base-uri, style-src 'self') se comporter
   exactement comme sur le site.

   Il ne sert que ce qui est sous app/ : un chemin qui tenterait d'en sortir
   (« /../ ») répond 404, même si ces serveurs n'écoutent que le temps d'un
   banc. */

const fs = require('fs');
const http = require('http');
const path = require('path');

const APP = path.resolve(__dirname, '..', 'app');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
                '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
                '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };

// Le fichier de app/ qui correspond à une URL, ou null s'il sort du dossier.
function fichierDe(url) {
  let chemin;
  try { chemin = decodeURIComponent(String(url || '/').split('?')[0]); } catch (e) { return null; }
  if (chemin.endsWith('/')) chemin += 'index.html';
  const f = path.resolve(APP, '.' + path.posix.normalize('/' + chemin));
  return f === APP || f.startsWith(APP + path.sep) ? f : null;
}

// Démarre le serveur ; `port` 0 (défaut) en choisit un libre, `versionTest`
// répond à /version.json quand le fichier (produit à la publication) manque.
function servirApp({ port = 0, versionTest = null } = {}) {
  return http.createServer((req, res) => {
    const f = fichierDe(req.url);
    if (!f) { res.statusCode = 404; res.end('absent'); return; }
    if (versionTest && path.basename(f) === 'version.json' && !fs.existsSync(f)) {
      res.setHeader('Content-Type', TYPES['.json']);
      res.end(JSON.stringify(versionTest)); return;
    }
    fs.readFile(f, (e, d) => {
      if (e) { res.statusCode = 404; res.end('absent'); return; }
      res.setHeader('Content-Type', TYPES[path.extname(f)] || 'application/octet-stream');
      res.end(d);
    });
  }).listen(port);
}

module.exports = { servirApp, fichierDe, APP };
