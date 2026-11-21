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

// L'atelier ouvre lui-même la fenêtre d'installation : le module qu'il nomme
// doit être celui de cette copie (il change de nom à chaque version).
const atelier = fs.readFileSync(path.join(__dirname, '..', 'app', 'atelier.js'), 'utf8');
const dialogue = /const DIALOGUE_INSTALLATION = '\.\/installateur\/([^']+)'/.exec(atelier);
if (!dialogue || !presents.includes(dialogue[1]) || !fs.readFileSync(path.join(DOSSIER, dialogue[1]), 'utf8').includes('ewt-install-dialog')) {
  echec = true;
  console.log(`   [ECHEC] atelier.js : DIALOGUE_INSTALLATION (${dialogue ? dialogue[1] : 'introuvable'}) ne désigne pas la fenêtre d'installation de cette copie`);
}
// L'atelier installe dans sa fiche, sans la fenêtre : il crée l'élément sans
// l'insérer, lui donne manifeste, port et choix d'effacement, lance son
// installation et suit ses états. Ce dont il se sert doit exister dans cette
// copie : une nouvelle version d'ESP Web Tools qui le changerait doit faire
// échouer la CI, pas l'atelier.
if (dialogue && presents.includes(dialogue[1])) {
  const code = fs.readFileSync(path.join(DOSSIER, dialogue[1]), 'utf8');
  const attendus = [
    ['_confirmInstall', 'async _confirmInstall(){this._installConfirmed=!0,this._installState=void 0'],
    ['port fermé avant l\'installation', 'await this.port.close(),(async('],
    ['manifeste, port et effacement passés à l\'installation', 'this.port,this.manifestPath,this._manifest,this._installErase)'],
    ['états reçus par _installState', '((e=>{this._installState=e,"finished"===e.state?'],
    ['relecture après la fin par _initialize', '.then((()=>this._initialize(!0)))'],
    ['états connexion, préparation, effacement, écriture, fin', 'state:"initializing"|state:"preparing"|state:"erasing"|state:"writing"|state:"finished"'],
    ['avancement de l\'écriture', 'details:{bytesTotal:v,bytesWritten:g+t,percentage:s}'],
    ['erreurs connues', 'error:"failed_initialize"|error:"not_supported"|error:"failed_firmware_download"|error:"write_failed"'],
    ['port : seulement open, close, readable, writable, getInfo, setSignals', null]
  ];
  for (const [quoi, motif] of attendus) {
    let ok;
    if (motif === null) {
      // Ce que le moteur demande au port : le port prêté par l'atelier n'a que cela.
      const utilises = new Set([...code.matchAll(/this\.(?:device|port)\.([A-Za-z_]+)/g)].map(m => m[1]));
      ok = [...utilises].every(x => ['open', 'close', 'readable', 'writable', 'getInfo', 'setSignals'].includes(x));
      if (!ok) console.log(`   [ECHEC] le moteur demande au port : ${[...utilises].join(', ')}`);
    } else ok = motif.split('|').every(m => code.includes(m));
    if (!ok) { echec = true; console.log(`   [ECHEC] installation dans la fiche : ${quoi} introuvable dans ${dialogue[1]}`); }
  }
}
console.log(echec ? '\n=== INSTALLATEUR MODIFIE ===' : `\n=== INSTALLATEUR INTACT (${presents.length} fichiers) ===`);
process.exit(echec ? 1 : 0);
