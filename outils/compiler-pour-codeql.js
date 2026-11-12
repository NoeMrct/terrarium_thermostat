#!/usr/bin/env node
/* =============================================================================
   Compile les sources du firmware pour l'analyse CodeQL (workflow codeql.yml).
   -----------------------------------------------------------------------------
   arduino-cli ne compile jamais les fichiers du dépôt : il en copie une version
   (préfixée d'une directive #line) dans son dossier de compilation, et c'est
   elle que voit CodeQL — hors du dépôt, donc hors des résultats. Ce script
   rejoue les commandes de compilation que arduino-cli a préparées
   (compile_commands.json, obtenu avec --only-compilation-database), mais sur
   les fichiers du dépôt eux-mêmes, aux mêmes options : CodeQL rattache alors
   chaque résultat au vrai fichier, à la vraie ligne. Le .ino.cpp engendré (les
   .ino fusionnés avec leurs prototypes) est compilé tel quel.

     node outils/compiler-pour-codeql.js build/codeql/compile_commands.json [dossier des sources]
   ============================================================================= */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const base = process.argv[2];
const sources = path.resolve(process.argv[3] || path.join(__dirname, '..'));
if (!base) { console.error('usage : compiler-pour-codeql.js <compile_commands.json> [dossier des sources]'); process.exit(2); }

const commandes = JSON.parse(fs.readFileSync(base, 'utf8'));
const dossierSketch = path.join(path.dirname(path.resolve(base)), 'sketch') + path.sep;
let n = 0;
for (const c of commandes) {
  const fichier = path.resolve(c.directory, c.file);
  if (!fichier.startsWith(dossierSketch) || !fichier.endsWith('.cpp')) continue;
  const original = path.join(sources, path.basename(fichier));
  // Le .ino.cpp n'existe que dans le dossier de compilation ; les autres ont
  // leur original dans le dépôt.
  const cible = fichier.endsWith('.ino.cpp') || !fs.existsSync(original) ? fichier : original;
  const args = c.arguments.map(a => (path.resolve(c.directory, a) === fichier ? cible : a));
  console.log(`${path.relative(process.cwd(), cible)}`);
  execFileSync(args[0], args.slice(1), { cwd: c.directory, stdio: 'inherit' });
  n++;
}
if (!n) { console.error(`aucun fichier de sketch dans ${base}`); process.exit(1); }
console.log(`${n} fichier(s) compilé(s) depuis ${sources}`);
