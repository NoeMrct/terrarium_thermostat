#!/usr/bin/env node
/* =============================================================================
   Signature des images de firmware (ECDSA P-256, SHA-256).
   -----------------------------------------------------------------------------
   Quand config.h contient une clé publique (OTA_CLE_PUBLIQUE), le socle refuse
   toute image envoyée par /api/maj qui n'est pas signée par la clé privée
   correspondante. Ni le mot de passe de l'interface web, ni un accès au réseau
   local ne suffisent alors à y installer un firmware étranger.

   Format du fichier signé :  <image.bin><signature DER><2 octets : longueur,
   petit-boutiste><"TERRASIG">. Le socle lit la remorque, vérifie, puis écrit.

     node signer-firmware.js --generer-cles cle-privee.pem     # une fois ; copier
                                                               # la clé publique affichée dans config.h
     node signer-firmware.js --cle cle-privee.pem --entree firmware.bin --sortie firmware.signe.bin
     node signer-firmware.js --verifier --publique cle-publique.pem --entree firmware.signe.bin

   La clé privée ne va NI dans le dépôt NI sur le socle : dans un gestionnaire
   de secrets (GitHub : secret CLE_SIGNATURE_FIRMWARE, lu par le workflow de
   publication). Perdre la clé privée oblige à reflasher par USB pour changer
   la clé publique compilée.
   ============================================================================= */

const fs = require('fs');
const crypto = require('crypto');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const MAGIE = Buffer.from('TERRASIG', 'ascii');

if (process.argv.includes('--generer-cles')) {
  const destination = arg('generer-cles', 'cle-privee.pem');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  fs.writeFileSync(destination, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  fs.writeFileSync(destination.replace(/privee/, 'publique').replace(/\.pem$/, '') + (destination.includes('privee') ? '.pem' : '-publique.pem'), pub);
  console.log(`Clé privée écrite dans ${destination} (à mettre à l'abri, jamais dans le dépôt).\n`);
  console.log('À coller dans config.h :\n');
  console.log('#define OTA_CLE_PUBLIQUE \\');
  pub.trim().split('\n').forEach((l, i, a) => console.log(`  "${l}\\n"${i === a.length - 1 ? '' : ' \\'}`));
  process.exit(0);
}

const entree = arg('entree');
if (!entree) { console.error('Usage : --generer-cles | --cle <privée.pem> --entree <bin> --sortie <bin> | --verifier --publique <pem> --entree <bin>'); process.exit(2); }
const image = fs.readFileSync(entree);

if (process.argv.includes('--verifier')) {
  const publique = fs.readFileSync(arg('publique'), 'utf8');
  if (image.length < 10 || !image.subarray(image.length - 8).equals(MAGIE)) { console.error('Image non signée'); process.exit(1); }
  const taille = image.readUInt16LE(image.length - 10);
  const corps = image.subarray(0, image.length - 10 - taille);
  const signature = image.subarray(image.length - 10 - taille, image.length - 10);
  const ok = crypto.verify('sha256', corps, { key: publique, dsaEncoding: 'der' }, signature);
  console.log(ok ? `Signature valide (${corps.length} octets d'image, signature de ${taille} octets)` : 'SIGNATURE INVALIDE');
  process.exit(ok ? 0 : 1);
}

const cle = fs.readFileSync(arg('cle'), 'utf8');
const sortie = arg('sortie', entree.replace(/\.bin$/, '') + '.signe.bin');
const signature = crypto.sign('sha256', image, { key: cle, dsaEncoding: 'der' });
const longueur = Buffer.alloc(2); longueur.writeUInt16LE(signature.length);
fs.writeFileSync(sortie, Buffer.concat([image, signature, longueur, MAGIE]));
console.log(`${sortie} : ${image.length} octets + signature de ${signature.length} octets`);
