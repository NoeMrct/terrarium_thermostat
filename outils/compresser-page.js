#!/usr/bin/env node
/* =============================================================================
   Compresse la page web embarquée du socle.
   -----------------------------------------------------------------------------
   page_web.h reste la source, lisible et testée (test-page-web.js). Ce script
   en extrait le HTML, le compresse en gzip et écrit page_web_gz.h : un tableau
   d'octets en flash programme, que le firmware sert tel quel avec
   « Content-Encoding: gzip ». Trois fois moins de flash qu'en clair, et une
   page qui arrive trois fois plus vite sur le WiFi domestique.

     node compresser-page.js             # régénère page_web_gz.h
     node compresser-page.js --verifier  # échoue si page_web_gz.h n'est plus à jour

   Le conteneur gzip est écrit à la main (en-tête fixe, sans date ni système)
   pour que le fichier généré soit identique d'une machine à l'autre.
   ============================================================================= */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SOURCE = path.join(__dirname, '..', 'page_web.h');
const CIBLE = path.join(__dirname, '..', 'page_web_gz.h');

function html() {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const m = src.split('R"HTML(');
  if (m.length < 2) throw new Error('page_web.h : littéral R"HTML( introuvable');
  return m[1].split(')HTML"')[0];
}

// CRC-32 (IEEE), tel qu'attendu dans le pied du conteneur gzip.
function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function gzip(texte) {
  const donnees = Buffer.from(texte, 'utf8');
  const corps = zlib.deflateRawSync(donnees, { level: 9 });
  const entete = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x02, 0x03]); // sans date, « Unix »
  const pied = Buffer.alloc(8);
  pied.writeUInt32LE(crc32(donnees), 0);
  pied.writeUInt32LE(donnees.length >>> 0, 4);
  return Buffer.concat([entete, corps, pied]);
}

function generer() {
  const page = html();
  const gz = gzip(page);
  const lignes = [];
  for (let i = 0; i < gz.length; i += 24)
    lignes.push('  ' + Array.from(gz.subarray(i, i + 24), o => '0x' + o.toString(16).padStart(2, '0')).join(','));
  const sortie = `/* page_web_gz.h — GÉNÉRÉ par \`node outils/compresser-page.js\` à partir de page_web.h.
   Ne pas éditer à la main : modifier page_web.h, puis relancer le script.

   La page est stockée compressée (gzip) et servie telle quelle avec
   « Content-Encoding: gzip » : tous les navigateurs la décompressent.
   ${page.length} octets en clair, ${gz.length} compressés. */
#ifndef PAGE_WEB_GZ_H
#define PAGE_WEB_GZ_H

#include <Arduino.h>

#define PAGE_HTML_GZ_LEN ${gz.length}
static const uint8_t PAGE_HTML_GZ[PAGE_HTML_GZ_LEN] PROGMEM = {
${lignes.join(',\n')}
};

#endif // PAGE_WEB_GZ_H
`;
  fs.writeFileSync(CIBLE, sortie);
  console.log(`page_web_gz.h écrit : ${page.length} octets en clair -> ${gz.length} compressés`);
}

// Relit les octets du fichier généré, les décompresse et compare au HTML
// courant : un simple diff d'octets dépendrait de la version de zlib.
function verifier() {
  if (!fs.existsSync(CIBLE)) { console.error('page_web_gz.h absent : lance node outils/compresser-page.js'); process.exit(1); }
  const src = fs.readFileSync(CIBLE, 'utf8');
  const octets = (src.split('= {')[1] || '').split('};')[0].match(/0x[0-9a-f]{2}/gi) || [];
  let page;
  try { page = zlib.gunzipSync(Buffer.from(octets.map(h => parseInt(h, 16)))).toString('utf8'); }
  catch (e) { console.error('page_web_gz.h illisible : ' + e.message); process.exit(1); }
  if (page !== html()) {
    console.error('page_web_gz.h n\'est plus à jour par rapport à page_web.h : lance node outils/compresser-page.js');
    process.exit(1);
  }
  console.log(`page_web_gz.h à jour (${octets.length} octets compressés)`);
}

process.argv.includes('--verifier') ? verifier() : generer();
