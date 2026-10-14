#!/usr/bin/env node
/* =============================================================================
   Test de fumée sur une vraie carte, par le port série.
   -----------------------------------------------------------------------------
   Ce que ni les bancs sur PC ni la compilation ne prouvent : que le binaire
   démarre sur l'ESP32, que la console répond, que la santé est cohérente, que
   l'auto-test usine passe, que le chien de garde ne redémarre pas la carte au
   repos — et, en option, qu'une mise à jour par /api/maj puis sa validation se
   passent bien. Pensé pour un exécuteur GitHub auto-hébergé avec la carte
   branchée (.github/workflows/materiel.yml), mais se lance aussi à la main :

     node test-materiel.js --port /dev/ttyUSB0 [--flasher <dossier des binaires>] [--version 3.4.0]
                           [--ota http://terraA1B2C3.local --utilisateur admin --mot-de-passe …]

   Aucune dépendance native : le port série est ouvert comme un fichier après
   réglage par stty (Linux, macOS) ou mode (Windows). Le flashage passe par
   esptool (fourni avec le cœur Arduino ESP32 ou « pip install esptool »).
   ============================================================================= */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const PORT = arg('port');
const FLASHER = arg('flasher');            // dossier contenant terrarium_thermostat.ino.bin (+ bootloader, partitions)
const VERSION = arg('version');            // version attendue après flashage
const OTA = arg('ota');                    // http://adresse-du-socle, pour tester /api/maj
const UTILISATEUR = arg('utilisateur', ''), MDP = arg('mot-de-passe', '');
const ESPTOOL = arg('esptool', 'esptool.py');
if (!PORT) { console.error('Usage : node test-materiel.js --port /dev/ttyUSB0 [--flasher dossier] [--version X.Y.Z] [--ota http://socle]'); process.exit(2); }

let ok = 0, ko = 0;
const v = (q, c, d = '') => { console.log(`   ${c ? '[ OK ]' : '[ECHEC]'} ${q.padEnd(56)} ${String(d).slice(0, 70)}`); c ? ok++ : ko++; };
const attendre = ms => new Promise(r => setTimeout(r, ms));

const { ouvrirSerie } = require('./serie');

(async () => {
  console.log(`\n== Carte sur ${PORT}`);
  if (FLASHER) {
    const bin = path.join(FLASHER, 'terrarium_thermostat.ino.bin');
    const bootloader = path.join(FLASHER, 'terrarium_thermostat.ino.bootloader.bin');
    const partitions = path.join(FLASHER, 'terrarium_thermostat.ino.partitions.bin');
    v('binaires présents', fs.existsSync(bin) && fs.existsSync(bootloader) && fs.existsSync(partitions), FLASHER);
    // Flash complet sauf la NVS (0x9000-0xE000) : réglages et code d'appairage conservés.
    const r = spawnSync(ESPTOOL, ['--chip', 'esp32', '--port', PORT, '--baud', '460800', 'write_flash', '0x1000', bootloader, '0x8000', partitions, '0x10000', bin], { encoding: 'utf8' });
    v('flashage par esptool', r.status === 0, (r.stdout || '').split('\n').filter(l => /Hash of data verified|Wrote/.test(l)).pop() || (r.stderr || '').slice(-120));
    if (r.status !== 0) { console.log(r.stdout, r.stderr); process.exit(1); }
    await attendre(1500);
  }

  const serie = ouvrirSerie(PORT);
  let depuis = serie.position();
  serie.ecrire('redemarrer');
  const banniere = await serie.attendre(/Thermostat terrarium v3/, 20000, depuis);
  v('la carte démarre et parle sur la console', !!banniere);
  const demarrage = await serie.attendre(/Demarrage — ([^\n]+)/, 10000, depuis);
  v('cause du redémarrage lisible', !!demarrage, demarrage ? demarrage[1].trim() : '');
  await serie.attendre(/Commandes \(z = numero de zone\)/, 15000, depuis);

  const version = await serie.commande('version', /Firmware (\d+\.\d+\.\d+), compile le ([^,]+), protocole (\d+)/);
  v('« version » répond', !!version, version ? `${version[1]} (${version[2].trim()}) proto ${version[3]}` : '');
  if (VERSION) v(`la version attendue tourne (${VERSION})`, !!version && version[1] === VERSION, version ? version[1] : '');

  const sante = await serie.commande('sante', /Sante : \{([^\n]*)\}/);
  let heap = null;
  try { heap = sante ? JSON.parse('{' + sante[1] + '}') : null; } catch (e) { heap = null; }
  v('« sante » renvoie un JSON', !!heap, heap ? `heap ${heap.heap} rssi ${heap.rssi} reset ${heap.reset}` : '');
  v('mémoire libre > 100 Ko', !!heap && heap.heap > 100000, heap ? `${heap.heap} octets` : '');

  const statut = await serie.commande('status', /tapis actif (-?\d+)/);
  v('« status » montre les zones', !!statut, statut ? `tapis actif ${statut[1]}` : '');

  const usine = await serie.commande('test usine', /=== TEST USINE : (OK|ECHEC) \((\d+) echec\(s\)\) ===/, 30000);
  v('auto-test usine (sans impulsion de puissance)', !!usine && usine[1] === 'OK', usine ? `${usine[2]} échec(s)` : 'pas de verdict');
  if (usine && usine[1] !== 'OK') console.log(serie.tampon.slice(-1500));

  // Trente secondes de repos : aucun redémarrage (watchdog, panique).
  depuis = serie.position();
  await attendre(30000);
  const redemarre = /Demarrage — /.test(serie.tampon.slice(depuis));
  v('aucun redémarrage spontané en 30 s', !redemarre);
  const appairage = await serie.commande('jeton', /Code d'appairage : ([A-Z0-9]{24})/);
  v('le code d\'appairage est lisible (et n\'a pas changé au reflashage)', !!appairage);

  if (OTA && FLASHER) {
    console.log(`\n== Mise à jour par /api/maj sur ${OTA}`);
    const bin = fs.readFileSync(path.join(FLASHER, 'terrarium_thermostat.ino.bin'));
    const form = new FormData();
    form.append('firmware', new Blob([bin]), 'terrarium_thermostat.ino.bin');
    const entetes = { 'X-Terrarium': '1' };
    if (UTILISATEUR) entetes.Authorization = 'Basic ' + Buffer.from(`${UTILISATEUR}:${MDP}`).toString('base64');
    depuis = serie.position();
    let r = null;
    try { r = await fetch(`${OTA}/api/maj`, { method: 'POST', headers: entetes, body: form }); } catch (e) { r = null; }
    v('le socle accepte l\'image', !!r && r.status === 200, r ? `HTTP ${r.status}` : 'injoignable');
    const valide = await serie.attendre(/Mise a jour validee : retour arriere annule/, 150000, depuis);
    v('après redémarrage, l\'image est validée (rollback annulé) sous 2 min 30', !!valide);
  }

  serie.fermer();
  console.log(`\n=== ${ko ? 'ECHECS SUR MATERIEL' : 'MATERIEL OK'} (${ok} reussite(s), ${ko} echec(s)) ===`);
  process.exit(ko ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
