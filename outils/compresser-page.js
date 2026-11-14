#!/usr/bin/env node
/* =============================================================================
   Compresse les pages web embarquées du socle.
   -----------------------------------------------------------------------------
   page_web.h (l'interface) et page_wifi.h (le portail captif) restent les
   sources, lisibles et testées (test-page-web.js). Ce script en extrait le
   HTML, le compresse en gzip et écrit page_web_gz.h et page_wifi_gz.h : des
   tableaux d'octets en flash programme, que le firmware sert tels quels avec
   « Content-Encoding: gzip ». Trois fois moins de flash qu'en clair, et des
   pages qui arrivent trois fois plus vite sur le WiFi domestique.

     node compresser-page.js             # régénère page_web_gz.h
     node compresser-page.js --verifier  # échoue si page_web_gz.h n'est plus à jour

   Le conteneur gzip est écrit à la main (en-tête fixe, sans date ni système)
   pour que le fichier généré soit identique d'une machine à l'autre.
   ============================================================================= */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// [source, fichier généré, nom du tableau, garde d'inclusion]
const PAGES = [
  ['page_web.h', 'page_web_gz.h', 'PAGE_HTML_GZ', 'PAGE_WEB_GZ_H'],
  ['page_wifi.h', 'page_wifi_gz.h', 'PAGE_WIFI_GZ', 'PAGE_WIFI_GZ_H']
];
const chemin = f => path.join(__dirname, '..', f);

function html(source) {
  const src = fs.readFileSync(chemin(source), 'utf8');
  const m = src.split('R"HTML(');
  if (m.length < 2) throw new Error(`${source} : littéral R"HTML( introuvable`);
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

function generer([source, cible, tableau, garde]) {
  const page = html(source);
  const gz = gzip(page);
  const lignes = [];
  for (let i = 0; i < gz.length; i += 24)
    lignes.push('  ' + Array.from(gz.subarray(i, i + 24), o => '0x' + o.toString(16).padStart(2, '0')).join(','));
  const sortie = `/* ${cible} — GÉNÉRÉ par \`node outils/compresser-page.js\` à partir de ${source}.
   Ne pas éditer à la main : modifier ${source}, puis relancer le script.

   La page est stockée compressée (gzip) et servie telle quelle avec
   « Content-Encoding: gzip » : tous les navigateurs la décompressent.
   ${page.length} octets en clair, ${gz.length} compressés. */
#ifndef ${garde}
#define ${garde}

#include <Arduino.h>

#define ${tableau}_LEN ${gz.length}
static const uint8_t ${tableau}[${tableau}_LEN] PROGMEM = {
${lignes.join(',\n')}
};

#endif // ${garde}
`;
  fs.writeFileSync(chemin(cible), sortie);
  console.log(`${cible} écrit : ${page.length} octets en clair -> ${gz.length} compressés`);
}

// Relit les octets du fichier généré, les décompresse et compare au HTML
// courant : un simple diff d'octets dépendrait de la version de zlib.
function verifier([source, cible]) {
  if (!fs.existsSync(chemin(cible))) { console.error(`${cible} absent : lance node outils/compresser-page.js`); process.exit(1); }
  const src = fs.readFileSync(chemin(cible), 'utf8');
  const octets = (src.split('= {')[1] || '').split('};')[0].match(/0x[0-9a-f]{2}/gi) || [];
  let page;
  try { page = zlib.gunzipSync(Buffer.from(octets.map(h => parseInt(h, 16)))).toString('utf8'); }
  catch (e) { console.error(`${cible} illisible : ` + e.message); process.exit(1); }
  if (page !== html(source)) {
    console.error(`${cible} n'est plus à jour par rapport à ${source} : lance node outils/compresser-page.js`);
    process.exit(1);
  }
  console.log(`${cible} à jour (${octets.length} octets compressés)`);
}

PAGES.forEach(process.argv.includes('--verifier') ? verifier : generer);
