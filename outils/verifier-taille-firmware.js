#!/usr/bin/env node
/* =============================================================================
   Garde-fou de taille du firmware.
   -----------------------------------------------------------------------------
   Au-delà de 95 % de l'emplacement d'application, la prochaine fonctionnalité
   ne rentre plus — et une mise à jour OTA non plus. Mieux vaut le savoir à la
   revue qu'au flashage.

   Deux emplacements comptent : celui de partitions.csv (socles flashés par USB
   avec la table courante) et celui des socles flashés avant 3.4.0, qui gardent
   leur table de 1,5 Mo tant qu'ils ne sont pas reflashés par câble — une mise
   à jour OTA doit rentrer chez eux aussi. Quand plus aucun socle n'a l'ancienne
   table, passer --sans-anciens-socles (ou retirer EMPLACEMENT_ANCIEN).

     node verifier-taille-firmware.js <chemin du .bin compilé> [--sans-anciens-socles]
   ============================================================================= */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const bin = args.find(a => !a.startsWith('--'));
if (!bin || !fs.existsSync(bin)) { console.error('Usage : node verifier-taille-firmware.js <firmware.bin> [--sans-anciens-socles]'); process.exit(2); }

// La taille de l'emplacement courant est lue dans partitions.csv : si elle
// change, le seuil suit.
const csv = fs.readFileSync(path.join(__dirname, '..', 'partitions.csv'), 'utf8');
const app0 = csv.split('\n').map(l => l.split(',').map(c => c.trim())).find(c => c[0] === 'app0');
const EMPLACEMENT_COURANT = app0 ? parseInt(app0[4], 16) : 0x1B0000;
const EMPLACEMENT_ANCIEN = 0x180000;        // table des socles 3.0 à 3.3
const SEUIL = 0.95;

const taille = fs.statSync(bin).size;
const cibles = [['emplacement courant (partitions.csv)', EMPLACEMENT_COURANT]];
if (!args.includes('--sans-anciens-socles')) cibles.push(['socles flashés avant 3.4.0', EMPLACEMENT_ANCIEN]);

let echec = false;
for (const [nom, capacite] of cibles) {
  const part = taille / capacite;
  const ok = part <= SEUIL;
  if (!ok) echec = true;
  console.log(`   ${ok ? '[ OK ]' : '[ECHEC]'} firmware ${taille} octets sur ${capacite} (${(part * 100).toFixed(1)} %, seuil ${SEUIL * 100} %) — ${nom}`);
}
if (echec) { console.log('\n=== FIRMWARE TROP GROS : trouver des octets avant d\'ajouter quoi que ce soit ==='); process.exit(1); }
console.log('\n=== TAILLE OK ===');
