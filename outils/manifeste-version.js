#!/usr/bin/env node
/* =============================================================================
   Manifeste des mises à jour automatiques : terrarium-version.json.
   -----------------------------------------------------------------------------
   Joint à chaque release par le workflow de publication. Chaque socle le lit
   une fois par jour à l'adresse stable de la dernière release
   (…/releases/latest/download/terrarium-version.json, MAJ_MANIFESTE dans
   config.h) et décide seul s'il installe la nuit (majauto.cpp) :

     {"version":"3.6.0","date":"2026-11-20","notes":"…","securite":false,
      "image":{"taille":…,"sha256":"…"},"signee":{"taille":…,"sha256":"…"},
      "deploiement":{"debut":1763596800,"jours":7,"pause":false}}

   Déploiement progressif (V9) : chaque socle tire de son identifiant un rang
   stable de 0 à 99 ; le jour d de la montée en charge, la version est ouverte
   aux rangs inférieurs à 100 × (d + 1) / (jours + 1). 7 jours par défaut, 2
   pour un correctif de sécurité (section « ### Sécurité » du CHANGELOG).
   « pause » arrête toute installation automatique de cette version.

   Résumé (notes) : la ligne « Résumé : … » de la section du CHANGELOG si elle
   existe, sinon les titres en gras de ses entrées, 180 caractères au plus.

     node manifeste-version.js --version 3.6.0 --changelog CHANGELOG.md \
       --firmware terrarium-3.6.0-firmware.bin [--signee terrarium-3.6.0-firmware.signe.bin] \
       [--jours 7] [--debut <epoch>] --sortie terrarium-version.json
     node manifeste-version.js --modifier terrarium-version.json --action pause|reprendre|tous|etaler [--jours 7]
   ============================================================================= */

const fs = require('fs');
const crypto = require('crypto');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d; };
const echec = (m, code = 1) => { console.error(m); process.exit(code); };
const maintenant = () => Math.floor(Date.now() / 1000);
const VERSION_RE = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/;
const NOTES_MAX = 180;

function joursValides(v, defaut) {
  const j = v === undefined || v === '' ? defaut : Number(v);
  if (!Number.isInteger(j) || j < 0 || j > 60) echec(`jours : entier de 0 à 60 (reçu ${v})`, 2);
  return j;
}

// Section « ## [X.Y.Z] » du CHANGELOG, jusqu'à la suivante.
function section(changelog, version) {
  const lignes = changelog.split(/\r?\n/);
  const debut = lignes.findIndex(l => l.startsWith(`## [${version}]`));
  if (debut < 0) return null;
  const fin = lignes.findIndex((l, i) => i > debut && l.startsWith('## ['));
  return lignes.slice(debut + 1, fin < 0 ? undefined : fin).join('\n');
}

function couper(texte, max) {
  const t = texte.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const coupe = t.slice(0, max - 1);
  return coupe.slice(0, Math.max(coupe.lastIndexOf(' '), max / 2)).replace(/[\s,;:·—-]+$/, '') + '…';
}

function resume(texte) {
  const explicite = /^Résumé\s*:\s*(.+)$/m.exec(texte);
  if (explicite) return couper(explicite[1], NOTES_MAX);
  const titres = [...texte.matchAll(/^- \*\*(.+?)\*\*/gm)].map(m => m[1].replace(/[.:]+$/, '').trim());
  return couper(titres.join(' · '), NOTES_MAX);
}

function fichier(chemin) {
  const b = fs.readFileSync(chemin);
  return { taille: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') };
}

// --- modifier un manifeste publié (workflow « Déploiement du firmware ») ------
if (arg('modifier')) {
  const chemin = arg('modifier');
  const m = JSON.parse(fs.readFileSync(chemin, 'utf8'));
  if (!VERSION_RE.test(m.version || '')) echec(`${chemin} : version absente ou invalide`);
  const d = m.deploiement || (m.deploiement = { debut: 0, jours: 0, pause: false });
  const action = arg('action');
  if (action === 'pause') d.pause = true;
  else if (action === 'reprendre') d.pause = false;
  else if (action === 'tous') Object.assign(d, { jours: 0, pause: false });
  else if (action === 'etaler') Object.assign(d, { debut: maintenant(), jours: joursValides(arg('jours'), 7), pause: false });
  else echec('--action pause | reprendre | tous | etaler', 2);
  fs.writeFileSync(chemin, JSON.stringify(m) + '\n');
  console.log(`${chemin} : ${m.version}, ${action} → ${JSON.stringify(d)}`);
  process.exit(0);
}

// --- créer le manifeste d'une release ----------------------------------------------
const version = arg('version', '');
if (!VERSION_RE.test(version)) echec('--version X.Y.Z attendue', 2);
const changelog = fs.readFileSync(arg('changelog', 'CHANGELOG.md'), 'utf8');
const texte = section(changelog, version);
if (texte === null) echec(`CHANGELOG : aucune section [${version}]`);
const securite = /^###\s+Sécurité\s*$/m.test(texte);
const manifeste = {
  version,
  date: new Date(maintenant() * 1000).toISOString().slice(0, 10),
  notes: resume(texte),
  securite,
  image: fichier(arg('firmware') || echec('--firmware <bin> attendu', 2)),
  ...(arg('signee') ? { signee: fichier(arg('signee')) } : {}),
  deploiement: { debut: Number(arg('debut', maintenant())), jours: joursValides(arg('jours'), securite ? 2 : 7), pause: false }
};
const json = JSON.stringify(manifeste) + '\n';
if (Buffer.byteLength(json) > 4096) echec('manifeste de plus de 4 Ko : le socle le refuserait');
fs.writeFileSync(arg('sortie', 'terrarium-version.json'), json);
console.log(json.trim());
