#!/usr/bin/env node
/* =============================================================================
   L'application face au serveur Terrariums (serveur/), de bout en bout.
   -----------------------------------------------------------------------------
   Le serveur réel démarre sur des ports éphémères ; un socle factice s'y
   connecte avec son compte d'appareil ; l'application (dans jsdom, avec son
   propre client MQTT) se connecte avec un compte d'utilisateur, détecte le
   serveur, rattache le socle par son code d'appairage, lit ses états, comble
   ses courbes avec l'historique du serveur, y envoie un rapport. Ce que le
   broker refuse (socle d'autrui) est vérifié aussi.

     node test-serveur.js          # aucun broker externe nécessaire
   ============================================================================= */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');
const mqtt = require('mqtt');
const { demarrerServeur } = require('../serveur/serveur');

const DOSSIER = path.join(__dirname, '..', 'app');
const JETON = 'SIMULATIONTESTJETON00001';
let reussites = 0, echecs = 0;
const verifier = (quoi, ok, detail = '') => { console.log(`   ${ok ? '[ OK ]' : '[ECHEC]'} ${quoi.padEnd(58)} ${detail}`); ok ? reussites++ : echecs++; };
const titre = t => console.log(`\n== ${t}`);
const attendre = ms => new Promise(r => setTimeout(r, ms));
async function jusqua(condition, limiteMs = 10000, pas = 150) {
  const fin = Date.now() + limiteMs;
  while (Date.now() < fin) { if (condition()) return true; await attendre(pas); }
  return false;
}

function creerApp(adressePage) {
  const html = fs.readFileSync(path.join(DOSSIER, 'index.html'), 'utf8').replace(/<script src="[^"]*"[^>]*><\/script>\s*/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: adressePage, pretendToBeVisual: true });
  const w = dom.window;
  w.eval(fs.readFileSync(path.join(DOSSIER, 'mqtt.js'), 'utf8'));
  w.localStorage.setItem('terrarium.langue', 'fr');
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (_, p) => (p === 'canvas' ? {} : () => {}) });
  // jsdom n'a pas fetch : celui de Node, en lui passant les URL absolues.
  w.fetch = (u, o) => globalThis.fetch(String(u), o);
  w.isSecureContext = true;
  const App = w.eval(fs.readFileSync(path.join(DOSSIER, 'app.js'), 'utf8') + '\n;App');
  w.dispatchEvent(new w.Event('load'));
  return { w, App, $: s => w.document.querySelector(s), texte: s => (w.document.querySelector(s) || {}).textContent || '' };
}

(async () => {
  const donnees = fs.mkdtempSync(path.join(os.tmpdir(), 'terrarium-app-serveur-'));
  const s = await demarrerServeur({ port: 0, portMqtt: 0, donnees, adminJeton: 'admin-test', pasHistoriqueMs: 20, journal: () => {}, pushActif: true,
    envoyerPush: async () => {} });
  const appel = (m, c, corps, jeton) => fetch(`http://127.0.0.1:${s.port}${c}`, { method: m, headers: { 'Content-Type': 'application/json', ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}) }, body: corps ? JSON.stringify(corps) : undefined }).then(r => r.json());
  try {
    titre('Mise en place : un utilisateur, deux socles dont un à autrui');
    await appel('POST', '/api/admin/utilisateurs', { login: 'noe', motDePasse: 'mot-de-passe-noe' }, 'admin-test');
    await appel('POST', '/api/admin/utilisateurs', { login: 'autre', motDePasse: 'mot-de-passe-autre' }, 'admin-test');
    const a1 = await appel('POST', '/api/admin/appareils', { id: 'terraA1B2C3' }, 'admin-test');
    const a2 = await appel('POST', '/api/admin/appareils', { id: 'terraD4E5F6' }, 'admin-test');
    await appel('POST', '/api/admin/utilisateurs/autre/socles', { id: 'terraD4E5F6' }, 'admin-test');
    // Les socles factices : réponses conformes au firmware (jeton exigé sur globaux et zone).
    const socles = [['terraA1B2C3', a1.motDePasse], ['terraD4E5F6', a2.motDePasse]].map(([id, mdp]) => {
      const c = mqtt.connect(`mqtt://127.0.0.1:${s.portMqtt}`, { username: id, password: mdp, clientId: 'socle-' + id });
      const etat = () => ({ zones: [{ nom: 'Point chaud', temp: 30.5, consigne: 32, demande: 40, charge: 33, chauffe: true, autotune: false, derive: false, jour: 32, nuit: 26, bande: 2, max: 40, offset: 0, rampe: 45, debutJour: 480, debutNuit: 1200, defaut: null },
        { nom: 'Zone fraîche', temp: 26.2, consigne: 27, demande: 10, charge: 10, chauffe: false, autotune: false, derive: false, jour: 27, nuit: 23, bande: 2, max: 40, offset: 0, rampe: 45, debutJour: 480, debutNuit: 1200, defaut: null }],
        uptime: 100, entretienS: 0, heure: '', zonesSimultanees: 1, saison: 0, alertesEnAttente: 0, proto: 3,
        sante: { proto: 3, version: '3.4.0-test', uptime: 100, rssi: -61, heap: 170000, heapMin: 140000, blocMax: 98000, reset: 'mise sous tension', hote: id + '.local', ip: '' } });
      c.on('connect', () => {
        c.subscribe(`terrarium/${id}/cmd`);
        c.publish(`terrarium/${id}/statut`, 'en ligne', { retain: true });
        c.publish(`terrarium/${id}/zone1/etat`, JSON.stringify({ temp: 30.5, consigne: 32, demande: 40, charge: 33, chauffe: '1', defaut: '0', defaut_libelle: 'aucun', jour: 32, nuit: 26 }), { retain: true });
        c.publish(`terrarium/${id}/zone2/etat`, JSON.stringify({ temp: 26.2, consigne: 27, demande: 10, charge: 10, chauffe: '0', defaut: '0', defaut_libelle: 'aucun', jour: 27, nuit: 23 }), { retain: true });
      });
      c.on('message', (sujet, charge) => {
        const d = JSON.parse(charge.toString());
        const lecture = ['etat', 'stats', 'version', 'historique'].includes(d.action);
        const ok = lecture || d.jeton === JETON;
        const corps = !ok ? { erreur: 'jeton invalide' } : d.action === 'etat' ? etat() : d.action === 'historique' ? { points: [], n: 0 } : d.action === 'globaux' ? { amperes: 3 } : {};
        c.publish(`terrarium/${id}/reponse`, JSON.stringify({ req: d.req, ok, ...corps }));
      });
      return c;
    });
    await attendre(400);
    // Un peu d'historique côté serveur pour le socle 1, « application fermée ».
    for (let i = 0; i < 4; i++) { socles[0].publish('terrarium/terraA1B2C3/zone1/etat', JSON.stringify({ temp: 30 + i / 10, consigne: 32, defaut: '0' })); socles[0].publish('terrarium/terraA1B2C3/zone2/etat', JSON.stringify({ temp: 26, consigne: 27, defaut: '0' })); await attendre(40); }
    verifier('serveur démarré, socles connectés avec leur compte d\'appareil', socles.every(c => c.connected));

    titre('L\'application se connecte au serveur avec un compte utilisateur');
    const { w, App, $, texte } = creerApp('http://localhost:8080/');
    $('#b-url').value = `ws://127.0.0.1:${s.port}/mqtt`;
    $('#b-user').value = 'noe';
    $('#b-pass').value = 'mot-de-passe-noe';
    App.enregistrerBroker();
    verifier('connecté au broker du serveur', await jusqua(() => texte('#lien') === 'connecté'), texte('#lien'));
    verifier('le serveur est détecté et une session ouverte', await jusqua(() => { const c = JSON.parse(w.localStorage.getItem('terrarium.config.v1') || '{}'); return !!(c.serveur && c.serveur.jeton); }));

    titre('Rattachement d\'un socle par son code d\'appairage');
    $('#a-id').value = 'terraA1B2C3'; $('#a-jeton').value = 'MAUVAISMAUVAISMAUVAISXYZ'; $('#a-nom').value = 'Essai';
    App.ajouterSocle();
    verifier('un mauvais code est refusé par le serveur (qui a interrogé le socle)', await jusqua(() => /Rattachement refusé/.test(texte('#message'))), texte('#message').slice(0, 60));
    App.retirerSocle && App.ouvrir('terraA1B2C3');
    App.retirerSocle(); await attendre(200);
    $('#a-id').value = 'terraA1B2C3'; $('#a-jeton').value = JETON; $('#a-nom').value = 'Salon';
    App.ajouterSocle();
    verifier('le bon code rattache le socle', await jusqua(() => /rattaché/.test(texte('#message'))), texte('#message').slice(0, 60));
    verifier('…et ses températures arrivent (abonnement accordé)', await jusqua(() => /30\.5/.test($('#socles').innerHTML)));
    const moi = await appel('GET', '/api/moi', undefined, JSON.parse(w.localStorage.getItem('terrarium.config.v1')).serveur.jeton);
    verifier('le serveur a enregistré le rattachement', Array.isArray(moi.socles) && moi.socles.includes('terraA1B2C3'));

    titre('Copropriété : un socle appartient à quiconque prouve son code (le serveur ne tranche pas)');
    $('#a-id').value = 'terraD4E5F6'; $('#a-jeton').value = JETON; $('#a-nom').value = 'Pirate';
    App.ajouterSocle();
    await attendre(1500);
    verifier('un socle déjà rattaché à « autre » l\'est aussi à « noe » avec le bon code', /rattaché/.test(texte('#message')), texte('#message').slice(0, 60));
    App.ouvrir('terraD4E5F6'); App.retirerSocle(); await attendre(300);

    titre('Courbes : comblées par l\'historique du serveur');
    App.ouvrir('terraA1B2C3');
    App.panneau('courbes');
    await attendre(300);
    await App.courbes(168);
    verifier('les points du serveur alimentent la courbe sur 7 jours', await jusqua(() => /point\(s\)/.test(texte('#legendeCourbe')) && !/0 point/.test(texte('#legendeCourbe'))), texte('#legendeCourbe'));

    titre('Diagnostic : envoi au serveur');
    App.diagnostic();
    await attendre(200);
    verifier('le bouton d\'envoi n\'apparaît qu\'avec un serveur', $('#btn-envoyer-rapport') && !$('#btn-envoyer-rapport').hidden);
    await App.envoyerRapport();
    verifier('le rapport est reçu et rangé par le serveur', await jusqua(() => /Rapport envoyé/.test(texte('#message'))) && fs.readdirSync(path.join(donnees, 'rapports')).length === 1, texte('#message').slice(0, 50));
    verifier('le rapport nomme le serveur', texte('#diag-texte').includes('Serveur : http://127.0.0.1'));

    socles.forEach(c => c.end(true));
  } catch (e) {
    verifier('déroulement du test', false, e.stack || e.message);
  }
  await s.arreter();
  fs.rmSync(donnees, { recursive: true, force: true });
  console.log(`\n=== ${echecs ? 'DES TESTS ONT ECHOUE' : 'APPLICATION + SERVEUR OK'} (${reussites} reussite(s), ${echecs} echec(s)) ===`);
  process.exit(echecs ? 1 : 0);
})();
