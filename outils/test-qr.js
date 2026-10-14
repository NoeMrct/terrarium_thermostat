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

console.log(`\n=== ${ko ? 'ECHECS' : 'QR RELU'} (${ok} reussite(s), ${ko} echec(s)) ===`);
process.exit(ko ? 1 : 0);
