#!/usr/bin/env node
/* =============================================================================
   Budget de poids de l'application.
   -----------------------------------------------------------------------------
   Échoue si un fichier dépasse sa taille compressée (gzip) autorisée : c'est
   le garde-fou contre une dépendance ou une bibliothèque ajoutée sans y
   penser — l'application entière doit rester plus légère qu'une seule photo.

   Les scripts sont mesurés tels qu'ils sont publiés : minifiés par terser,
   comme le fait preparer-publication.js au déploiement (les sources du dépôt
   restent lisibles). Sans terser installé, la mesure porte sur la source et
   le budget est relevé d'autant.

     node budget.js
   ============================================================================= */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const APP = path.join(__dirname, '..', 'app');
let terser = null;
try { terser = require('terser'); } catch (e) { /* mesure sur la source */ }

// Budgets avec une marge d'environ 20 % sur l'état actuel : ils se relèvent
// quand une fonctionnalité le justifie (et le dit dans le commit), jamais parce
// qu'un fichier a grossi sans qu'on sache pourquoi. Le dictionnaire bilingue
// de app.js pèse à lui seul un quart du fichier minifié.
const BUDGETS = {                      // octets gzip, [minifié, source]
  'index.html': [4000, 4000],
  'style.css': [8000, 8000],
  'app.js': [30000, 42000],
  'mqtt.js': [4000, 5000],
  'sw.js': [1000, 1500],
  'manifest.json': [800, 800]
};
const TOTAL = terser ? 44000 : 58000;
const MINIFIES = ['app.js', 'mqtt.js', 'sw.js'];

(async () => {
  let total = 0, echec = false;
  for (const [fichier, [limiteMin, limiteSrc]] of Object.entries(BUDGETS)) {
    const brut = fs.readFileSync(path.join(APP, fichier));
    let publie = brut, note = '';
    if (terser && MINIFIES.includes(fichier)) {
      const r = await terser.minify(brut.toString('utf8'), { compress: { passes: 2 }, mangle: true, ecma: 2020, format: { comments: false } });
      if (r.error) throw r.error;
      publie = Buffer.from(r.code, 'utf8');
      note = '  (minifié)';
    }
    const limite = terser ? limiteMin : limiteSrc;
    const gz = zlib.gzipSync(publie, { level: 9 }).length;
    total += gz;
    const ok = gz <= limite;
    if (!ok) echec = true;
    console.log(`   ${ok ? '[ OK ]' : '[TROP]'} ${fichier.padEnd(14)} ${String(brut.length).padStart(7)} octets  gzip ${String(gz).padStart(6)} / ${limite}${note}`);
  }
  const ok = total <= TOTAL;
  console.log(`   ${ok ? '[ OK ]' : '[TROP]'} ${'total'.padEnd(14)} ${' '.repeat(14)} gzip ${String(total).padStart(6)} / ${TOTAL}`);
  if (!ok) echec = true;
  console.log(echec ? '\n=== BUDGET DEPASSE ===' : '\n=== BUDGET RESPECTE ===');
  process.exit(echec ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
