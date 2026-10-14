#!/usr/bin/env node
/* =============================================================================
   Vérifie que la copie d'ESP Web Tools servie par le site (app/installateur/)
   est exactement celle dont les sommes sont consignées dans son LISEZMOI.md.
   -----------------------------------------------------------------------------
   C'est du code qui écrit dans la flash d'un appareil depuis le navigateur : il
   ne doit pas pouvoir changer sans qu'on l'ait voulu. Toute différence — fichier
   modifié, ajouté, manquant — fait échouer la CI.

     node verifier-installateur.js
   ============================================================================= */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DOSSIER = path.join(__dirname, '..', 'app', 'installateur');
const lisezmoi = fs.readFileSync(path.join(DOSSIER, 'LISEZMOI.md'), 'utf8');
const bloc = /```\n([\s\S]*?)```/.exec(lisezmoi);
if (!bloc) { console.error('LISEZMOI.md : bloc de sommes introuvable'); process.exit(1); }
const attendues = new Map(bloc[1].trim().split('\n').map(l => { const [h, f] = l.trim().split(/\s+/); return [f, h]; }));

let echec = false;
const presents = fs.readdirSync(DOSSIER).filter(f => f.endsWith('.js'));
for (const f of presents) {
  const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(DOSSIER, f))).digest('hex');
  const ok = attendues.get(f) === h;
  if (!ok) { echec = true; console.log(`   [ECHEC] ${f} : ${attendues.has(f) ? 'somme différente' : 'fichier non répertorié'}`); }
  attendues.delete(f);
}
attendues.forEach((h, f) => { echec = true; console.log(`   [ECHEC] ${f} : répertorié mais absent`); });
console.log(echec ? '\n=== INSTALLATEUR MODIFIE ===' : `\n=== INSTALLATEUR INTACT (${presents.length} fichiers) ===`);
process.exit(echec ? 1 : 0);
