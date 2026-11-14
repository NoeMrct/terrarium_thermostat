#!/usr/bin/env node
/* =============================================================================
   Signature des images de firmware (ECDSA P-256, SHA-256).
   -----------------------------------------------------------------------------
   Quand config.h contient une clé publique (OTA_CLE_PUBLIQUE), le socle refuse
   toute image qui n'est pas signée par la clé privée correspondante : envoyée
   par le navigateur (/api/maj), téléchargée par le socle (action « maj ») ou
   installée seule la nuit (mises à jour automatiques, qui n'existent qu'avec
   une clé). ArduinoOTA, qui ne sait rien vérifier, est alors coupée. Ni le mot
   de passe de l'interface web, ni un accès au réseau local, ni le code
   d'appairage ne suffisent à installer un firmware étranger.

   Format du fichier signé :  <image.bin><signature DER><2 octets : longueur,
   petit-boutiste><"TERRASIG">. Le socle lit la remorque, vérifie, puis valide.

   UNE FOIS, chez le mainteneur, hors du dépôt :
     node outils/signer-firmware.js --generer-cles ~/cles/terrarium-privee.pem --config config.h
       écrit la clé privée (refusée dans le dépôt, jamais écrasée), et la clé
       publique dans config.h ; la clé privée va ensuite dans le secret GitHub
       CLE_SIGNATURE_FIRMWARE (docs/publication.md), puis hors ligne.
   À chaque publication (le workflow le fait) :
     node outils/signer-firmware.js --cle cle-privee.pem --entree firmware.bin --sortie firmware.signe.bin
     node outils/signer-firmware.js --verifier --config config.h --entree firmware.signe.bin
   Et pour savoir où en est config.h :
     node outils/signer-firmware.js --etat --config config.h     (0 : clé compilée, 3 : aucune)

   La clé privée ne va NI dans le dépôt NI sur le socle NI dans une
   conversation. Perdue, elle oblige à reflasher chaque socle par câble pour
   changer la clé publique compilée ; volée, à la changer aussi.
   ============================================================================= */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const option = n => process.argv.includes('--' + n);
const MAGIE = Buffer.from('TERRASIG', 'ascii');
const DEPOT = path.resolve(__dirname, '..');
const echec = (m, code = 1) => { console.error(m); process.exit(code); };

// --- clé publique dans config.h ----------------------------------------------
// La définition est une suite de littéraux C (une ligne par ligne du PEM),
// continuée par des barres obliques inverses, alignées comme clang-format les
// aligne : le fichier généré passe tel quel la vérification de la CI.
const RE_DEFINE = /#define OTA_CLE_PUBLIQUE[ \t]*(?:\\\r?\n[ \t]*)?((?:"(?:[^"\\\n]|\\.)*"[ \t]*(?:\\\r?\n[ \t]*)?)+)/;

function clePubliqueDe(configH) {
  const m = RE_DEFINE.exec(configH);
  if (!m) throw new Error('#define OTA_CLE_PUBLIQUE introuvable');
  const litteraux = m[1].match(/"(?:[^"\\\n]|\\.)*"/g) || [];
  return litteraux.map(l => l.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')).join('');
}

function definitionC(pem) {
  const lignes = ['#define OTA_CLE_PUBLIQUE', ...pem.trim().split('\n').map(l => `  "${l}\\n"`)];
  const largeur = Math.max(...lignes.slice(0, -1).map(l => l.length)) + 1;
  return lignes.map((l, i) => (i < lignes.length - 1 ? l.padEnd(largeur) + '\\' : l)).join('\n');
}

function ecrireCleDansConfig(chemin, pem) {
  const texte = fs.readFileSync(chemin, 'utf8');
  if (clePubliqueDe(texte).trim()) echec(`${chemin} contient déjà une clé publique : changer de clé est une décision (socles à reflasher), à faire à la main.`);
  const m = RE_DEFINE.exec(texte);
  fs.writeFileSync(chemin, texte.slice(0, m.index) + definitionC(pem) + texte.slice(m.index + m[0].replace(/\s+$/, '').length));
}

function clePubliqueDepuis(options) {
  if (arg('publique')) return fs.readFileSync(arg('publique'), 'utf8');
  if (arg('config')) {
    const pem = clePubliqueDe(fs.readFileSync(arg('config'), 'utf8'));
    if (!pem.trim()) echec(`${arg('config')} : aucune clé publique compilée (OTA_CLE_PUBLIQUE vide)`, 3);
    return pem;
  }
  return echec(options);
}

// Version et projet que l'image dit d'elle-même (descripteur d'application,
// version_image.cpp) : en-tête de 24 octets, segment de 8, version en 0x30.
function descripteur(image) {
  if (image.length < 0x70 || image[0] !== 0xE9 || image.readUInt32LE(0x20) !== 0xABCD5432) return null;
  const chaine = (debut) => image.subarray(debut, debut + 32).toString('latin1').split('\0')[0];
  return { version: chaine(0x30), projet: chaine(0x50) };
}

// --- génération (une fois) ----------------------------------------------------
if (option('generer-cles')) {
  const destination = path.resolve(arg('generer-cles', ''));
  if (!arg('generer-cles')) echec('Usage : --generer-cles <chemin hors du dépôt>/cle-privee.pem [--config config.h]', 2);
  if (destination === DEPOT || destination.startsWith(DEPOT + path.sep))
    echec(`Refusé : ${destination} est dans le dépôt. La clé privée se garde ailleurs (gestionnaire de mots de passe, clé USB chiffrée), jamais à côté du code.`);
  if (fs.existsSync(destination)) echec(`Refusé : ${destination} existe déjà (une clé n'est jamais écrasée).`);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  fs.writeFileSync(destination, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  console.log(`Clé privée écrite dans ${destination} (lecture par vous seul).`);
  if (arg('config')) {
    ecrireCleDansConfig(arg('config'), pub);
    console.log(`Clé publique écrite dans ${arg('config')} (OTA_CLE_PUBLIQUE).`);
  } else {
    console.log('\nÀ coller dans config.h à la place de #define OTA_CLE_PUBLIQUE "" :\n');
    console.log(definitionC(pub));
  }
  console.log(`
Ensuite :
  1. GitHub, dépôt → Settings → Secrets and variables → Actions → New repository secret :
     nom CLE_SIGNATURE_FIRMWARE, valeur = tout le contenu de ${path.basename(destination)}.
  2. Mettre ${path.basename(destination)} à l'abri hors ligne (deux copies), puis l'effacer du disque de travail.
  3. Commiter config.h (la clé publique n'a rien de secret), flasher les socles par câble une fois :
     dès lors ils n'acceptent plus que des images signées, et s'installent seuls les mises à jour.`);
  process.exit(0);
}

// --- état de config.h ------------------------------------------------------------
if (option('etat')) {
  const chemin = arg('config', path.join(DEPOT, 'config.h'));
  const pem = clePubliqueDe(fs.readFileSync(chemin, 'utf8')).trim();
  if (!pem) { console.log(`${chemin} : aucune clé compilée — images non signées acceptées, pas de mise à jour automatique.`); process.exit(3); }
  try { crypto.createPublicKey(pem); } catch (e) { echec(`${chemin} : clé publique illisible (${e.message})`); }
  const empreinte = crypto.createHash('sha256').update(crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' })).digest('hex');
  console.log(`${chemin} : clé publique compilée (SHA-256 ${empreinte.slice(0, 16)}…) — images signées exigées.`);
  process.exit(0);
}

const entree = arg('entree');
if (!entree) echec('Usage : --generer-cles <chemin> [--config config.h] | --etat [--config config.h] | --cle <privée.pem> --entree <bin> [--sortie <bin>] | --verifier (--publique <pem> | --config config.h) --entree <bin>', 2);
const image = fs.readFileSync(entree);
const signee = image.length >= 10 && image.subarray(image.length - 8).equals(MAGIE);

// --- vérification ---------------------------------------------------------------
if (option('verifier')) {
  const publique = clePubliqueDepuis('Usage : --verifier (--publique <pem> | --config config.h) --entree <bin>');
  if (!signee) echec('Image non signée');
  const taille = image.readUInt16LE(image.length - 10);
  if (taille < 8 || taille > 80 || taille + 10 > image.length) echec('Signature malformée');
  const corps = image.subarray(0, image.length - 10 - taille);
  const signature = image.subarray(image.length - 10 - taille, image.length - 10);
  const ok = crypto.verify('sha256', corps, { key: publique, dsaEncoding: 'der' }, signature);
  const d = descripteur(corps);
  console.log(ok ? `Signature valide (${corps.length} octets d'image${d ? `, ${d.projet} ${d.version}` : ''}, signature de ${taille} octets)` : 'SIGNATURE INVALIDE');
  process.exit(ok ? 0 : 1);
}

// --- signature ------------------------------------------------------------------
if (!arg('cle')) echec('Usage : --cle <privée.pem> --entree <bin> [--sortie <bin>]', 2);
if (signee) echec(`${entree} est déjà signée : on signe l'image brute (terrarium-X.Y.Z-firmware.bin).`);
const d = descripteur(image);
if (!d) echec(`${entree} n'est pas une image ESP32 avec descripteur d'application.`);
const cle = fs.readFileSync(arg('cle'), 'utf8');
const sortie = arg('sortie', entree.replace(/\.bin$/, '') + '.signe.bin');
const signature = crypto.sign('sha256', image, { key: cle, dsaEncoding: 'der' });
const longueur = Buffer.alloc(2); longueur.writeUInt16LE(signature.length);
fs.writeFileSync(sortie, Buffer.concat([image, signature, longueur, MAGIE]));
console.log(`${sortie} : ${d.projet} ${d.version}, ${image.length} octets + signature de ${signature.length} octets`);
