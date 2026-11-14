#!/usr/bin/env node
/* =============================================================================
   Provisionnement d'un socle en fin de ligne (ou au SAV), en une commande.
   -----------------------------------------------------------------------------
   1. Lit l'identifiant et le code d'appairage sur la console série du socle
      (commande « jeton »), ou les prend en arguments.
   2. Lance l'auto-test usine (« test usine ») et refuse de continuer s'il échoue.
   3. Crée le compte d'appareil sur le serveur Terrariums (API d'administration)
      et configure le socle pour s'y connecter (commande « mqtt »), si --serveur.
   4. Avec le port série, tire le mot de passe de l'interface locale (S2 :
      plus d'accès libre) et le donne au socle (« motdepasse web »).
   5. Écrit l'étiquette QR à coller sous le socle (SVG, même contenu que
      qr-appairage.js, mot de passe de l'interface compris) et une fiche JSON
      dans provisionnement/ (ignorée par git : elle contient les secrets).

     node provisionner.js --port /dev/ttyUSB0 [--serveur https://… --admin <jeton>] [--hote mqtt.exemple.fr] [--url https://app…]
     node provisionner.js --id terraA1B2C3 --jeton K7M2QX… [--serveur … --admin …]

   Sans --serveur : seulement l'auto-test et l'étiquette (socle destiné à un
   broker que l'acheteur configure lui-même).
   ============================================================================= */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const PORT = arg('port');
let ID = arg('id'), JETON = (arg('jeton') || '').toUpperCase();
const SERVEUR = (arg('serveur') || '').replace(/\/$/, '');
const ADMIN = arg('admin') || process.env.ADMIN_JETON;
const HOTE = arg('hote');                                  // hôte MQTT à donner au socle (défaut : celui de --serveur)
const PORT_MQTT = +arg('port-mqtt', 1883);
const URL_APP = arg('url', process.env.TERRARIUM_URL_APP || '');   // étiquette : lien vers l'application (voir qr-appairage.js)
const SORTIE = path.resolve(__dirname, 'provisionnement');
const attendre = ms => new Promise(r => setTimeout(r, ms));
// Mot de passe de l'interface locale : 12 caractères sans ambiguïté à la
// lecture (ni i, l, o, 0, 1), tirés par le générateur cryptographique.
const motDePasseWeb = () => Array.from({ length: 12 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[require('crypto').randomInt(31)]).join('');

(async () => {
  let serie = null;
  if (PORT) {
    const { ouvrirSerie } = require('./serie');
    serie = ouvrirSerie(PORT);
    const m = await serie.commande('jeton', /Appareil (terra[0-9A-Za-z]{6})\s*\nCode d'appairage : ([A-Z0-9]{24})/, 8000);
    if (!m) { console.error('Le socle ne répond pas à « jeton » : vérifier le port, le câble, et que le firmware tourne.'); process.exit(1); }
    ID = m[1]; JETON = m[2];
    console.log(`Socle ${ID}, code d'appairage lu sur la console.`);
    const usine = await serie.commande('test usine', /=== TEST USINE : (OK|ECHEC) \((\d+) echec\(s\)\) ===/, 30000);
    if (!usine || usine[1] !== 'OK') { console.error(`Auto-test usine : ${usine ? usine[2] + ' échec(s)' : 'pas de verdict'} — socle refusé.\n` + serie.tampon.slice(-1200)); serie.fermer(); process.exit(1); }
    console.log('Auto-test usine : OK.');
  }
  if (!/^terra[0-9A-Za-z]{6}$/.test(ID || '') || !/^[A-Z0-9]{24}$/.test(JETON)) {
    console.error('Usage : node provisionner.js --port <port série> | --id terraXXXXXX --jeton <24 caractères>  [--serveur URL --admin JETON] [--hote …]');
    process.exit(2);
  }

  const fiche = { id: ID, date: new Date().toISOString(), jeton: JETON };
  if (serie) {
    const mdp = motDePasseWeb();
    const ok = await serie.commande(`motdepasse web ${mdp} admin`, /Enregistre/, 5000);
    if (!ok) { console.error('Le socle n\'a pas confirmé « motdepasse web » — socle refusé.'); serie.fermer(); process.exit(1); }
    fiche.web = { utilisateur: 'admin', motDePasse: mdp };
    console.log('Mot de passe de l\'interface locale tiré et donné au socle.');
  } else {
    console.log('Sans port série : le mot de passe de l\'interface locale sera créé au premier accès à la page du socle.');
  }
  if (SERVEUR) {
    if (!ADMIN) { console.error('--admin <jeton d\'administration> (ou ADMIN_JETON) est requis avec --serveur'); process.exit(2); }
    const r = await fetch(`${SERVEUR}/api/admin/appareils`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ id: ID }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { console.error(`Serveur : ${d.erreur || 'HTTP ' + r.status}`); if (serie) serie.fermer(); process.exit(1); }
    const hote = HOTE || new URL(SERVEUR).hostname;
    fiche.serveur = SERVEUR; fiche.mqtt = { hote, port: PORT_MQTT, utilisateur: ID };
    console.log(`Compte d'appareil créé sur ${SERVEUR}.`);
    if (serie) {
      const tls = PORT_MQTT === 8883 ? ' tls' : '';
      const ok = await serie.commande(`mqtt ${hote} ${PORT_MQTT} ${ID} ${d.motDePasse}${tls}`, /MQTT enregistre/, 5000);
      console.log(ok ? `Socle configuré pour ${hote}:${PORT_MQTT} (redémarrage au prochain cycle).` : 'Le socle n\'a pas confirmé la commande mqtt — à refaire à la main :');
      if (!ok) console.log(`  mqtt ${hote} ${PORT_MQTT} ${ID} ${d.motDePasse}${tls}`);
      if (ok) { serie.ecrire('redemarrer'); await attendre(300); }
    } else {
      console.log(`Sur la console du socle :\n  mqtt ${hote} ${PORT_MQTT} ${ID} ${d.motDePasse}`);
    }
  }
  if (serie) serie.fermer();

  fs.mkdirSync(SORTIE, { recursive: true });
  const etiquette = path.join(SORTIE, `${ID}-etiquette.svg`);
  const svg = execFileSync(process.execPath, [path.join(__dirname, 'qr-appairage.js'), '--id', ID, '--jeton', JETON,
    ...(fiche.web ? ['--web', `${fiche.web.utilisateur}:${fiche.web.motDePasse}`] : []), ...(URL_APP ? ['--url', URL_APP] : [])], { encoding: 'utf8' });
  fs.writeFileSync(etiquette, svg);
  fiche.etiquette = etiquette;
  fs.writeFileSync(path.join(SORTIE, `${ID}.json`), JSON.stringify(fiche, null, 1) + '\n', { mode: 0o600 });
  console.log(`Étiquette : ${etiquette}\nFiche : ${path.join(SORTIE, ID + '.json')} (contient le code d'appairage${fiche.web ? ' et le mot de passe de l\'interface' : ''} : à garder hors du dépôt)`);
})().catch(e => { console.error(e.message); process.exit(1); });
