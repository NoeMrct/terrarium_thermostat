#!/usr/bin/env node
/* =============================================================================
   Génère l'étiquette d'appairage à coller sous un socle.
   -----------------------------------------------------------------------------
   Le QR code évite à l'acheteur de recopier 24 caractères à la main, ce qui est
   la principale source d'échec à la mise en service.

     node qr-appairage.js --id terraA1B2C3 --jeton K7M2QX... > etiquette.svg
   ============================================================================= */

const QRCode = require('qrcode');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const ID    = arg('id');
const JETON = (arg('jeton') || '').toUpperCase();

if (!ID || JETON.length !== 24) {
  console.error('Usage : node qr-appairage.js --id terraA1B2C3 --jeton <24 caracteres>');
  process.exit(2);
}

// Format lu par l'application. Volontairement court : plus la charge est
// longue, plus le QR est dense, et plus il faut de place pour l'imprimer.
const charge = `terrarium:${ID}:${JETON}`;
const groupes = JETON.match(/.{1,6}/g).join('-');

const COTE = 260;   // taille voulue du QR sur l'etiquette, en points

QRCode.toString(charge, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', width: COTE })
  .then(qr => {
    // Le SVG produit par la bibliotheque dessine en MODULES : son viewBox vaut
    // « 0 0 31 31 » (le nombre varie avec la longueur du contenu), et c'est
    // l'enveloppe <svg> qui portait la mise a l'echelle. En la retirant sans
    // rien remettre, le QR se retrouvait dessine a 31 points de cote, illisible.
    const vb = /viewBox="0 0 (\d+(?:\.\d+)?) /.exec(qr);
    const modules = vb ? parseFloat(vb[1]) : COTE;
    const echelle = COTE / modules;
    const interieur = qr.replace(/<\?xml[^>]*\?>/, '').replace(/<svg[^>]*>/, '').replace('</svg>', '');
    process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400" viewBox="0 0 300 400">
  <rect width="300" height="400" fill="#fff"/>
  <text x="150" y="26" text-anchor="middle" font-family="sans-serif" font-size="15" font-weight="600">Socle chauffant</text>
  <text x="150" y="45" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#555">${ID}</text>
  <g transform="translate(20 58) scale(${echelle})">${interieur}</g>
  <text x="150" y="348" text-anchor="middle" font-family="monospace" font-size="13" letter-spacing="1">${groupes}</text>
  <text x="150" y="372" text-anchor="middle" font-family="sans-serif" font-size="9.5" fill="#555">Code d'appairage — ne pas divulguer</text>
  <text x="150" y="388" text-anchor="middle" font-family="sans-serif" font-size="9.5" fill="#555">Regenerable par la commande « jeton nouveau »</text>
</svg>\n`);
  })
  .catch(e => { console.error(e.message); process.exit(1); });
