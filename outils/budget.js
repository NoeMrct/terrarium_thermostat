#!/usr/bin/env node
/* =============================================================================
   Poids de l'application, pour information.
   -----------------------------------------------------------------------------
   Affiche ce que pèse chaque fichier tel qu'il est publié (minifié par terser,
   comme le fait preparer-publication.js, puis compressé en gzip). Ce relevé ne
   fait jamais échouer la CI : le garde-fou de performance est Lighthouse
   (.lighthouserc.json, note de performance ≥ 90), qui mesure le chargement
   réel plutôt qu'un nombre d'octets. Le relevé sert à voir d'un coup d'œil ce
   qu'un changement ajoute.

     node budget.js
   ============================================================================= */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const APP = path.join(__dirname, '..', 'app');
let terser = null;
try { terser = require('terser'); } catch (e) { /* mesure sur la source */ }

// Ce que tout le monde télécharge au démarrage.
const DEMARRAGE = ['index.html', 'style.css', 'app.js', 'mqtt.js', 'sw.js', 'manifest.json'];
// Chargés à la demande : l'anglais (C2), l'onglet Service.
const A_LA_DEMANDE = ['textes.en.js', 'service.js'];
// Déjà compressée (woff2) : mesurée telle quelle, téléchargée une fois.
const POLICES = ['polices/inter-latin-wght.woff2'];
const MINIFIES = ['app.js', 'mqtt.js', 'sw.js', 'textes.en.js', 'service.js'];
const MODULES = ['textes.en.js', 'service.js'];   // modules ES : minifiés comme tels

async function poids(fichier) {
  const brut = fs.readFileSync(path.join(APP, fichier));
  if (POLICES.includes(fichier)) return { brut: brut.length, publie: brut.length };
  let publie = brut;
  if (terser && MINIFIES.includes(fichier)) {
    const r = await terser.minify(brut.toString('utf8'), { compress: { passes: 2 }, mangle: true, ecma: 2020, module: MODULES.includes(fichier), format: { comments: false } });
    if (r.error) throw r.error;
    publie = Buffer.from(r.code, 'utf8');
  }
  return { brut: brut.length, publie: zlib.gzipSync(publie, { level: 9 }).length };
}

const ligne = (nom, p, note) =>
  console.log(`   ${nom.padEnd(24)} ${String(p.brut).padStart(7)} octets  →  ${String(p.publie).padStart(6)} publiés  ${note}`);

(async () => {
  console.log(`Poids publié (${terser ? 'minifié, ' : ''}gzip ; woff2 tel quel) :`);
  let total = 0;
  for (const f of DEMARRAGE) { const p = await poids(f); total += p.publie; ligne(f, p, ''); }
  console.log(`   ${'démarrage'.padEnd(24)} ${' '.repeat(16)}  →  ${String(total).padStart(6)} publiés`);
  for (const f of POLICES) { const p = await poids(f); total += p.publie; ligne(f.split('/').pop(), p, '(police, une fois)'); }
  console.log(`   ${'premier chargement'.padEnd(24)} ${' '.repeat(16)}  →  ${String(total).padStart(6)} publiés`);
  for (const f of A_LA_DEMANDE) ligne(f, await poids(f), '(à la demande)');
})().catch(e => { console.error(e); process.exit(1); });
