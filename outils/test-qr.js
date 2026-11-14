#!/usr/bin/env node
/* =============================================================================
   L'encodeur QR du firmware (qr.cpp) relu par un décodeur indépendant.
   -----------------------------------------------------------------------------
   sim/test-qr vérifie la structure du code ; ici, jsQR — qui ne partage pas une
   ligne avec l'encodeur — doit relire exactement le texte encodé, comme le
   ferait l'appareil photo d'un téléphone devant l'écran du socle.

     make -C sim test-qr && node test-qr.js
   ============================================================================= */

const { execFileSync } = require('child_process');
const path = require('path');
const jsQR = require('jsqr');

const BANC = path.join(__dirname, '..', 'sim', 'test-qr');
const ECHELLE = 6;                     // pixels par module, comme un écran vu de près

let ok = 0, ko = 0;
const v = (q, c, d = '') => { console.log(`   ${c ? '[ OK ]' : '[ECHEC]'} ${q.padEnd(56)} ${d}`); c ? ok++ : ko++; };

function decoder(texte) {
  const pbm = execFileSync(BANC, ['--pbm', texte], { encoding: 'utf8' }).split('\n');
  const [l, h] = pbm[1].split(' ').map(Number);
  const L = l * ECHELLE, H = h * ECHELLE;
  const rgba = new Uint8ClampedArray(L * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < L; x++) {
      const sombre = pbm[2 + Math.floor(y / ECHELLE)][Math.floor(x / ECHELLE)] === '1';
      const i = (y * L + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = sombre ? 0 : 255; rgba[i + 3] = 255;
    }
  const r = jsQR(rgba, L, H);
  return r ? r.data : null;
}

console.log('\n== QR de l\'écran d\'appairage, relu par jsQR');
[
  'TERRARIUM:TERRAA1B2C3:K7M2QX9PL4ZB8CN3VD6HT5WR',
  'TERRARIUM:TERRAFFFFFF:ZZZZZZZZZZZZZZZZZZZZZZZZ',
  'TERRARIUM:TERRA000000:000000000000000000000000',
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 $%*+-./:AB',
  'HELLO WORLD'
].forEach(t => { const lu = decoder(t); v(t.slice(0, 44), lu === t, lu === t ? '' : `lu : ${lu}`); });

// Le format d'appairage est exactement ce que l'application attend.
const charge = 'TERRARIUM:TERRAA1B2C3:K7M2QX9PL4ZB8CN3VD6HT5WR';
const m = /^terrarium:([^:]+):([A-Z0-9]{24})$/i.exec(decoder(charge) || '');
v('la charge correspond au format lu par l\'application', !!m && m[1] === 'TERRAA1B2C3' && m[2].length === 24);

// L'étiquette imprimée (qr-appairage.js) : avec --url, un lien que l'appareil
// photo ouvre ; le fragment porte l'identifiant et le code, lus comme par
// lireEtiquette() dans app.js.
console.log('\n== Étiquette imprimée, relue par jsQR');
const QRCode = require('qrcode');
function decoderMatrice(texte) {
  const q = QRCode.create(texte, { errorCorrectionLevel: 'M' });
  const n = q.modules.size, marge = 4, L = (n + 2 * marge) * ECHELLE;
  const rgba = new Uint8ClampedArray(L * L * 4).fill(255);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      if (q.modules.get(x, y))
        for (let dy = 0; dy < ECHELLE; dy++)
          for (let dx = 0; dx < ECHELLE; dx++) {
            const i = (((y + marge) * ECHELLE + dy) * L + (x + marge) * ECHELLE + dx) * 4;
            rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
          }
  const r = jsQR(rgba, L, L);
  return { lu: r ? r.data : null, version: q.version };
}
const svg = execFileSync(process.execPath, [path.join(__dirname, 'qr-appairage.js'), '--id', 'terraA1B2C3', '--jeton', 'K7M2QX9PL4ZB8CN3VD6HT5WR', '--url', 'https://app.exemple.fr'], { encoding: 'utf8' });
v('qr-appairage --url produit une étiquette', svg.startsWith('<svg') && svg.includes('terraA1B2C3'));
const lien = 'https://app.exemple.fr/#a/terraA1B2C3/K7M2QX9PL4ZB8CN3VD6HT5WR';
const { lu, version } = decoderMatrice(lien);
v('le lien est relu tel quel', lu === lien, `version ${version} (${17 + 4 * version} modules)`);
const e = /#a\/([^/?#]+)\/([A-Z0-9-]{24,29})$/i.exec(lu || '');
v('…identifiant et code se lisent dans le fragment', !!e && e[1] === 'terraA1B2C3' && e[2] === 'K7M2QX9PL4ZB8CN3VD6HT5WR');
let refuse = false;
try { execFileSync(process.execPath, [path.join(__dirname, 'qr-appairage.js'), '--id', 'terraA1B2C3', '--jeton', 'K7M2QX9PL4ZB8CN3VD6HT5WR', '--url', 'http://app.exemple.fr'], { stdio: 'pipe' }); }
catch (err) { refuse = err.status === 2; }
v('une adresse sans HTTPS est refusée', refuse);

// L'encodeur du navigateur (app/qr.js), qui imprime les étiquettes depuis
// l'atelier : toutes les tailles de version 1 à 10, version 7 et plus avec
// leur bloc d'information de version, relues par jsQR.
console.log('\n== Encodeur du navigateur (app/qr.js), relu par jsQR');
const QRN = require('../app/qr.js');
function lireMatrice(q) {
  const marge = 4, L = (q.taille + 2 * marge) * ECHELLE;
  const rgba = new Uint8ClampedArray(L * L * 4).fill(255);
  for (let y = 0; y < q.taille; y++)
    for (let x = 0; x < q.taille; x++)
      if (q.sombre(x, y))
        for (let dy = 0; dy < ECHELLE; dy++)
          for (let dx = 0; dx < ECHELLE; dx++) {
            const i = (((y + marge) * ECHELLE + dy) * L + (x + marge) * ECHELLE + dx) * 4;
            rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
          }
  const r = jsQR(rgba, L, L);
  return r ? r.data : null;
}
[
  'terrarium:terraA1B2C3:K7M2QX9PL4ZB8CN3VD6HT5WR',
  'https://app.exemple.fr/#a/terraA1B2C3/K7M2QX9PL4ZB8CN3VD6HT5WR',
  'https://terrariums.une-adresse-plutot-longue.exemple.fr/application/#a/terraA1B2C3/K7M2QX9PL4ZB8CN3VD6HT5WR',
  'Socle chauffant — étiquette d\'essai, accents et symboles : é è ê à ç ° € ✓',
  'x'.repeat(150),
  'y'.repeat(210)
].forEach(t => {
  const q = QRN.matrice(t);
  const lu = lireMatrice(q);
  v(`version ${q.version} (${t.length} car.) : ${t.slice(0, 30)}`, lu === t, lu === t ? '' : `lu : ${String(lu).slice(0, 40)}`);
});
// Chaque version, à sa capacité exacte en correction M (mode octet).
const versions = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213].map((n, i) => {
  const t = Array.from({ length: n }, (_, k) => 'abcdefghij0123456789'[(k * 7 + i) % 20]).join('');
  const q = QRN.matrice(t);
  return q.version === i + 1 && lireMatrice(q) === t;
});
v('les dix versions, chacune pleine, se relisent', versions.every(Boolean), versions.map((ok, i) => (ok ? '' : 'v' + (i + 1))).join(' '));
let trop = false;
try { QRN.matrice('z'.repeat(300)); } catch (e) { trop = /trop long/.test(e.message); }
v('au-delà de la version 10, une erreur claire', trop);
v('le SVG est un chemin unique, net à l\'impression', /^<svg[^>]+viewBox="0 0 \d+ \d+"[^>]*crispEdges/.test(QRN.svg('abc')) && (QRN.svg('abc').match(/<path/g) || []).length === 1);

console.log(`\n=== ${ko ? 'ECHECS' : 'QR RELU'} (${ok} reussite(s), ${ko} echec(s)) ===`);
process.exit(ko ? 1 : 0);
