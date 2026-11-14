#!/usr/bin/env node
/* =============================================================================
   Test de bout en bout de l'application.
   -----------------------------------------------------------------------------
   Charge la VRAIE application (index.html + app.js) dans un DOM headless, la
   connecte à un broker, et la fait dialoguer avec un socle simulé. Vérifie ce
   qu'aucun test de syntaxe ne peut voir : le modèle d'état, l'analyse des
   sujets, le rendu, et le comportement quand le socle ne répond pas.

     npm install jsdom
     node test-application.js --broker ws://localhost:9001/mqtt --id terraSIM001
   ============================================================================= */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const BROKER = arg('broker', 'ws://localhost:9001/mqtt');
const ID     = arg('id', 'terraSIM001');
const JETON  = arg('jeton', 'SIMULATIONTESTJETON00001');
const DOSSIER = path.join(__dirname, '..', 'app');

let reussites = 0, echecs = 0;
const verifier = (quoi, ok, detail = '') => {
  console.log(`   ${ok ? '[ OK ]' : '[ECHEC]'} ${quoi.padEnd(56)} ${detail}`);
  ok ? reussites++ : echecs++;
};
const titre = t => console.log(`\n== ${t}`);
const attendre = ms => new Promise(r => setTimeout(r, ms));

// Attend qu'une condition devienne vraie, plutôt que de dormir au hasard :
// un test qui dort trop peu devient instable, un test qui dort trop est lent.
async function jusqua(condition, limiteMs = 12000, pas = 150) {
  const fin = Date.now() + limiteMs;
  while (Date.now() < fin) {
    if (condition()) return true;
    await attendre(pas);
  }
  return false;
}

// Construit une instance de l'application dans un DOM neuf. L'adresse de la
// page compte : l'application n'accepte une liaison non chiffrée que sur
// localhost, il faut donc pouvoir simuler une publication ailleurs.
function creerApp(adressePage) {
  const html = fs.readFileSync(path.join(DOSSIER, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: adressePage,
    pretendToBeVisual: true
  });
  const w = dom.window;
  // jsdom ne charge pas les scripts externes en mode « outside-only » : on
  // retire les balises et on injecte les scripts directement.
  for (const s of w.document.querySelectorAll('script[src]')) s.remove();
  // Le client MQTT de l'application lui-même, sur le WebSocket de jsdom : c'est
  // lui qui est éprouvé ici, pas une bibliothèque de substitution.
  // sourceURL : c8 (couverture V8) attribue alors le code évalué au fichier.
  w.eval(fs.readFileSync(path.join(DOSSIER, 'mqtt.js'), 'utf8') + '\n//# sourceURL=file://' + path.join(DOSSIER, 'mqtt.js'));
  if (typeof w.mqtt !== 'object') throw new Error('app/mqtt.js ne définit pas window.mqtt');
  // L'application suit la langue du navigateur ; jsdom se déclare anglophone,
  // et ces tests lisent les textes français.
  w.localStorage.setItem('terrarium.langue', 'fr');
  // jsdom ne dessine pas : un contexte 2D inerte suffit pour que le code de
  // tracé s'exécute réellement au lieu de renoncer à la première ligne.
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
    get: (_, p) => (p === 'canvas' ? {} : () => {})
  });
  // WebCrypto de Node : jsdom n'a pas crypto.subtle, dont l'application se
  // sert pour signer ses commandes (protocole 4).
  Object.defineProperty(w, 'crypto', { value: require('crypto').webcrypto, configurable: true });
  w.TextEncoder = TextEncoder;
  // Notifications : on les capture au lieu de les afficher.
  w.notifications = [];
  w.isSecureContext = true;
  w.Notification = function (titre, opts) { w.notifications.push({ titre, corps: (opts || {}).body }); };
  w.Notification.permission = 'granted';
  w.Notification.requestPermission = async () => 'granted';
  // `const App = …` au sommet d'un script crée une liaison lexicale globale
  // dans un navigateur — les gestionnaires onclick de la page la voient. Dans
  // un eval, cette liaison reste locale : on récupère donc la valeur depuis la
  // même évaluation plutôt qu'en la relisant après coup.
  // L'onglet Service est un module importé à la demande ; jsdom n'importe pas
  // de module : il est fourni d'avance, comme dans la démonstration.
  const service = fs.readFileSync(path.join(DOSSIER, 'service.js'), 'utf8')
    .replace('export default function service(app) {', 'window.SERVICE = function service(app) {');
  w.eval('(function () {\n' + service + '\n})();\n//# sourceURL=file://' + path.join(DOSSIER, 'service.js'));
  const source = fs.readFileSync(path.join(DOSSIER, 'app.js'), 'utf8');
  const App = w.eval(source + '\n;App\n//# sourceURL=file://' + path.join(DOSSIER, 'app.js'));
  w.dispatchEvent(new w.Event('load'));
  return { w, App, $: sel => w.document.querySelector(sel),
           texte: sel => (w.document.querySelector(sel) || {}).textContent || '' };
}

(async () => {
  titre('1. Premier lancement');
  {
    const a = creerApp('http://localhost:8080/');
    verifier('l\'écran de configuration du broker s\'affiche',
             a.$('#vue-broker').style.display !== 'none');
    verifier('la liste des socles est masquée', a.$('#vue-liste').style.display === 'none');
  }

  titre('2. Refus d\'une liaison non chiffrée hors développement');
  {
    const a = creerApp('http://terrariums.exemple.fr/');   // application publiée
    a.$('#b-url').value = 'ws://broker.exemple.fr:9001/mqtt';
    a.App.enregistrerBroker();
    verifier('adresse ws:// refusée en production',
             a.$('#vue-broker').style.display !== 'none', a.texte('#message').slice(0, 48));
    verifier('le refus est expliqué', a.texte('#message').includes('chiffrement'));
  }

  const { w, App, $, texte } = creerApp('http://localhost:8080/');

  titre('3. Connexion au broker');
  $('#b-url').value = BROKER;
  $('#b-user').value = '';
  $('#b-pass').value = '';
  $('#b-prefixe').value = 'terrarium';
  App.enregistrerBroker();
  const connecte = await jusqua(() => texte('#lien') === 'connecté');
  verifier('connexion établie', connecte, texte('#lien'));
  verifier('la liste des socles est affichée', $('#vue-liste').style.display !== 'none');
  verifier('la configuration est conservée localement',
           !!w.localStorage.getItem('terrarium.config.v1'));

  titre('4. Ajout d\'un socle');
  $('#a-id').value = ID;
  $('#a-jeton').value = JETON;
  $('#a-nom').value = 'Terrarium de test';
  App.ajouterSocle();
  const affiche = await jusqua(() => $('#socles').innerHTML.includes('Terrarium de test'));
  verifier('le socle apparaît dans la liste', affiche);
  const enLigne = await jusqua(() => $('#socles').innerHTML.includes('tout va bien'));
  verifier('sa présence est détectée', enLigne);
  const temperatures = await jusqua(() => ($('#socles').innerHTML.match(/\d+,\d°/g) || []).length >= 2);
  verifier('les températures des deux zones s\'affichent', temperatures,
           ($('#socles').innerHTML.match(/\d+,\d°/g) || []).join(' '));

  titre('5. Rejet des saisies incorrectes');
  $('#a-id').value = 'terraAUTRE';
  $('#a-jeton').value = 'TROPCOURT';
  App.ajouterSocle();
  verifier('code d\'appairage trop court refusé',
           !$('#socles').innerHTML.includes('terraAUTRE'), texte('#message').slice(0, 45));
  $('#a-id').value = ID;
  $('#a-jeton').value = JETON;
  App.ajouterSocle();
  verifier('socle déjà enregistré refusé',
           ($('#socles').innerHTML.match(/Terrarium de test/g) || []).length === 1);

  titre('6. Vue détaillée et commande acceptée');
  App.ouvrir(ID);
  const detail = await jusqua(() => $('#detail').innerHTML.includes('Terrarium de test'));
  verifier('le détail du socle s\'affiche', detail);
  App.zone(0);
  verifier('l\'écran de la zone a ses champs de réglage', await jusqua(() => !!$('#j0') && !!$('#n0'), 4000));

  // Jour ET nuit a la meme valeur : la consigne affichee par le socle est celle
  // du moment, et ce test tournait donc a l'echec une fois passe 20 h.
  $('#j0').value = '33.5';
  $('#n0').value = '33.5';
  await App.reglerZone(0);
  await attendre(300);
  verifier('réglage accepté par le socle',
           texte('#message').includes('enregistrés'), texte('#message'));
  App.panneau('etat');
  const applique = await jusqua(() => $('#detail').innerHTML.includes('Cible 33,5°'));
  verifier('la nouvelle consigne revient du socle', applique);
  App.zone(0);
  await attendre(200);

  titre('7. Un refus du socle est montré à l\'utilisateur');
  $('#j0').value = '99';
  await App.reglerZone(0);
  await attendre(300);
  verifier('le message d\'erreur vient du socle lui-même',
           texte('#message').includes('10-45'), texte('#message'));
  verifier('il est présenté comme une erreur',
           $('#message').className.includes('erreur'));

  titre('8. Entretien');
  App.panneau('etat');
  await App.action('entretien', { minutes: 5 });
  const enEntretien = await jusqua(() => $('#detail').innerHTML.includes('entretien : 5 min'));
  verifier('l\'entretien en cours est visible', enEntretien);
  await App.action('entretien', { minutes: 0 });
  await attendre(1200);
  verifier('annulation prise en compte', !$('#detail').innerHTML.includes('entretien :'));

  titre('9. Socle injoignable');
  // Un identifiant inconnu du broker : personne ne répondra jamais.
  App.montrer('liste');
  $('#a-id').value = 'terraFANTOME';
  $('#a-jeton').value = 'FANTOME00000000000000001';
  $('#a-nom').value = 'Socle absent';
  App.ajouterSocle();
  App.ouvrir('terraFANTOME');
  const t0 = Date.now();
  await App.action('reset').catch(() => {});
  const duree = Date.now() - t0;
  verifier('l\'échec est signalé sans blocage', texte('#message').length > 0, texte('#message'));
  verifier('le délai maximal est respecté', duree < 10000, `${duree} ms`);
  verifier('le socle absent est présenté comme hors ligne',
           $('#detail').innerHTML.includes('hors ligne'));
  verifier('l\'application rappelle qu\'il régule quand même tout seul',
           $('#detail').innerHTML.includes('continue de réguler'));

  titre('10. Panneau des réglages complets');
  // On revient sur le socle réel : le précédent test a laissé ouvert le socle
  // fantôme, qui par définition n'a jamais envoyé le moindre réglage.
  App.ouvrir(ID);
  await jusqua(() => $('#detail').innerHTML.includes('Terrarium de test'));
  App.panneau('securite');
  verifier('le seuil de coupure est dans Sécurité', await jusqua(() => !!$('#m0')));
  $('#m0').value = '41';
  await App.reglerZoneComplet(0);
  await attendre(400);
  verifier('la coupure est enregistrée', texte('#message').includes('enregistrés'), texte('#message'));
  App.panneau('programme');
  const formComplet = await jusqua(() => !!$('#H0') && !!$('#R0'));
  verifier('les horaires et la rampe sont dans Programmation', formComplet);
  verifier('l\'horaire est présenté en HH:MM', $('#H0') && /^\d{2}:\d{2}$/.test($('#H0').value),
           $('#H0') && $('#H0').value);
  $('#H0').value = '07:30';
  await App.reglerZoneComplet(0);
  await attendre(400);
  verifier('l\'enregistrement est accepté', texte('#message').includes('enregistrés'), texte('#message'));
  App.panneau('etat'); await attendre(200);
  App.panneau('programme');
  const relu = await jusqua(() => $('#H0') && $('#H0').value === '07:30', 8000);
  verifier('le socle a bien pris le nouvel horaire', relu, $('#H0') && $('#H0').value);
  $('#H0').value = '25:00';
  await App.reglerZoneComplet(0);
  await attendre(200);
  verifier('un horaire impossible est refusé côté application',
           texte('#message').includes('HH:MM'), texte('#message'));

  titre('11. Courbes');
  App.panneau('courbes');
  const canevas = await jusqua(() => !!$('#courbe'));
  verifier('le canevas est présent', canevas);
  const points = await jusqua(() => /point\(s\)/.test(texte('#legendeCourbe')), 12000);
  verifier('le socle renvoie son historique', points, texte('#legendeCourbe').slice(0, 48));

  titre('12. Alimentation (Sécurité), saison et statistiques (Appareil)');
  App.panneau('general');
  const generalPret = await jusqua(() => !!$('#gSD') && texte('#detail').includes('Sur 24 heures'), 12000);
  verifier('la saison et les statistiques arrivent dans Appareil', generalPret);
  App.panneau('securite');
  await jusqua(() => !!$('#gA'), 6000);
  verifier('l\'ampérage est pré-rempli', $('#gA') && parseFloat($('#gA').value) > 0, $('#gA') && $('#gA').value);
  $('#gA').value = '5';
  await App.reglerGeneraux();
  await attendre(400);
  verifier('5 A débloquent deux zones simultanées',
           texte('#message').includes('2 zone'), texte('#message'));
  $('#gA').value = '99';
  await App.reglerGeneraux();
  await attendre(400);
  verifier('un ampérage aberrant est refusé par le socle',
           texte('#message').toLowerCase().includes('amperage') ||
           texte('#message').toLowerCase().includes('ampérage'), texte('#message'));

  titre('12 bis. Une réponse « stats » ne passe pas pour un état');
  {
    // Les statistiques portent aussi un tableau « zones ». Prises pour un état,
    // elles effaçaient le défaut, la chauffe et le temps de service affichés
    // jusqu'à la publication suivante. Une réponse étrangère (requête d'un autre
    // client) le montre sans dépendre des minuteries du socle simulé.
    const mqtt = require('mqtt');
    const espion = mqtt.connect(BROKER, { clientId: 'test-stats-' + Date.now() });
    await new Promise((ok, ko) => { espion.once('connect', ok); espion.once('error', ko); });
    App.ouvrir(ID);
    App.zone(0);
    // La réponse à l'« etat » demandé à l'ouverture d'abord : elle remettrait
    // les noms en place et masquerait l'erreur.
    await attendre(1500);
    espion.publish(`terrarium/${ID}/reponse`, JSON.stringify({
      req: 'requete-d-un-autre-client', ok: true, version: '3.5.0',
      zones: [{ nom: 'STATISTIQUES', min: 20, max: 30, moyenne: 25, points: 10, heuresChauffe: 1, kWh: 0.02,
                defauts: { sonde: 0, surchauffe: 0, figee: 0, inefficace: 0 } }]
    }));
    await attendre(800);
    verifier('l\'état des zones n\'est pas remplacé par des statistiques', !texte('#detail').includes('STATISTIQUES'));
    // Un sujet « etat » au format d'avant la 3.5, sans autotune, ne doit pas
    // effacer l'autotune appris par la réponse « etat ».
    await App.action('autotune', { z: 0 });
    const enCours = await jusqua(() => texte('#detail').includes('Arrêter l\'autotune'), 8000);
    espion.publish(`terrarium/${ID}/zone1/etat`, JSON.stringify({
      temp: 25, consigne: 32, demande: 50, charge: 50, chauffe: '1', defaut: '0', defaut_libelle: 'OK', jour: 32, nuit: 26
    }));
    await attendre(600);
    verifier('un sujet « etat » sans autotune ne l\'efface pas', enCours && texte('#detail').includes('Arrêter l\'autotune'));
    await App.action('stop-autotune', { z: 0 });
    await jusqua(() => !texte('#detail').includes('Arrêter l\'autotune'), 8000);
    espion.end(true);
  }

  titre('13. Persistance');
  const config = JSON.parse(w.localStorage.getItem('terrarium.config.v1'));
  verifier('les socles sont enregistrés', config.socles.length === 2);
  verifier('le broker est enregistré', config.broker && config.broker.url === BROKER);
  verifier('le code d\'appairage est conservé pour les commandes futures',
           config.socles[0].jeton === JETON);

  titre('14. Retrait d\'un socle');
  App.ouvrir('terraFANTOME');
  App.retirerSocle();
  await attendre(300);
  const apres = JSON.parse(w.localStorage.getItem('terrarium.config.v1'));
  verifier('le socle disparaît de la configuration', apres.socles.length === 1);
  verifier('la liste ne l\'affiche plus', !$('#socles').innerHTML.includes('Socle absent'));

  titre('15. Injection : un nom de zone hostile venu du socle reste du texte');
  {
    App.ouvrir(ID);
    await attendre(300);
    const hostile = '<img src=x onerror="window.__xss=1"><b>gras</b>';
    await App.action('zone', { z: 1, nom: hostile });
    await attendre(1500);
    const d = w.document;
    verifier('aucun élément injecté dans la page', !d.querySelector('img[src="x"]') && !d.querySelector('#detail b'));
    verifier('le nom s\'affiche tel quel, échappé', (d.querySelector('#detail') || {}).textContent.includes('<img src=x'));
    verifier('aucun script n\'a tourné', w.__xss === undefined);
    await App.action('zone', { z: 1, nom: 'Zone fraîche' });
    await attendre(500);
  }

  titre('16. Mise à jour du firmware depuis l\'application');
  {
    App.ouvrir(ID);
    App.panneau('maj');
    await attendre(600);
    verifier('sans version publiée connue, la carte le dit', texte('#detail').includes('Mise à jour du firmware') && texte('#detail').includes('publiée'));
    // Une version publiée plus récente que celle du socle : le bouton apparaît.
    App._versionPubliee({ version: '9.9.9', firmware: { version: '9.9.9', date: '2026-10-13' } });
    await attendre(600);
    const bouton = $('[data-action="mettreAJour"]');
    verifier('une version plus récente fait apparaître « Mettre à jour vers 9.9.9 »', !!bouton && bouton.textContent.includes('9.9.9'));
    bouton.click();
    await attendre(300);
    const oui = $('#dlg-confirm [data-dlg="oui"]');
    verifier('la mise à jour demande confirmation', !!oui && oui.textContent.includes('Mettre à jour'));
    oui.click();
    await attendre(350);
    verifier('la commande est acceptée et la progression s\'affiche',
             texte('#detail').includes('Téléchargement en cours') || texte('#detail').includes('redémarre') || texte('#message').includes('Téléchargement'),
             texte('#message').slice(0, 40));
    await attendre(6000);
    verifier('le socle redémarre et sa santé annonce l\'image en validation ou validée',
             texte('#detail').includes('validation') || texte('#detail').includes('validée'));
  }

  titre('17. Présence : un état retenu ne fait pas passer un socle éteint pour en ligne');
  {
    // Le broker rejoue les messages retenus à l'abonnement : l'état publié
    // avant l'extinction arrive avec le testament « hors ligne ». L'état seul
    // faisait croire le socle en ligne, selon l'ordre d'arrivée.
    const mqtt = require('mqtt');
    const espion = mqtt.connect(BROKER, { clientId: 'test-retenu-' + Date.now() });
    await new Promise((ok, ko) => { espion.once('connect', ok); espion.once('error', ko); });
    const R = 'terraRETENU';
    const retenir = (s, m) => new Promise(ok => espion.publish(`terrarium/${R}/${s}`, m, { retain: true, qos: 1 }, ok));
    await retenir('statut', 'hors ligne');
    await retenir('zone1/etat', JSON.stringify({ temp: 27.4, consigne: 30, chauffe: '0', defaut: '0', defaut_libelle: 'OK', jour: 30, nuit: 24 }));
    await retenir('zone2/etat', JSON.stringify({ temp: 24.1, consigne: 26, chauffe: '0', defaut: '0', defaut_libelle: 'OK', jour: 26, nuit: 22 }));
    App.montrer('liste');
    $('#a-id').value = R; $('#a-jeton').value = 'RETENU000000000000000001'; $('#a-nom').value = 'Socle éteint';
    App.ajouterSocle();
    const carte = () => (w.document.querySelector(`#socles .socle[data-id="${R}"]`) || {}).innerHTML || '';
    verifier('les dernières valeurs connues sont affichées', await jusqua(() => carte().includes('27,4°'), 6000));
    await attendre(300);
    verifier('…mais le socle reste hors ligne', carte().includes('hors ligne') && !carte().includes('en ligne'),
             carte().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50));
    // Une charge vide efface un message retenu.
    await retenir('statut', ''); await retenir('zone1/etat', ''); await retenir('zone2/etat', '');
    espion.end(true);
    App.ouvrir(R); App.retirerSocle(); await attendre(200);
  }

  titre('18. Une zone trop chaude est notifiée');
  {
    const mqtt = require('mqtt');
    const espion = mqtt.connect(BROKER, { clientId: 'test-chaud-' + Date.now() });
    await new Promise((ok, ko) => { espion.once('connect', ok); espion.once('error', ko); });
    w.notifications.length = 0;
    const zone2 = champs => espion.publish(`terrarium/${ID}/zone2/etat`, JSON.stringify({
      temp: 31, consigne: 26, chauffe: '0', defaut: '0', defaut_libelle: 'OK', derive: '0', jour: 26, nuit: 22, ...champs }));
    zone2({ trop_chaud: '1' });
    const notifiee = await jusqua(() => w.notifications.some(n => /trop chaud/.test(n.titre)), 5000);
    verifier('« trop chaud » fait apparaître une notification', notifiee, (w.notifications[0] || {}).titre || 'aucune');
    verifier('elle dit quoi faire', w.notifications.some(n => /ombre/.test(n.corps || '')));
    zone2({ trop_chaud: '0' });
    verifier('le retour à la normale est notifié', await jusqua(() => w.notifications.some(n => /rétabli/.test(n.titre)), 5000));
    espion.end(true);
  }

  titre('19. Ajout d\'un socle : identifiant normalisé, code vérifié auprès du socle');
  {
    App.montrer('liste');
    $('#a-id').value = 'terra/1'; $('#a-jeton').value = JETON; $('#a-nom').value = '';
    App.ajouterSocle();
    verifier('un identifiant qui casserait les sujets MQTT est refusé', texte('#message').includes('Identifiant invalide'), texte('#message').slice(0, 40));
    $('#a-id').value = ' terrarium-config-a1b2c3 '; $('#a-jeton').value = 'ABCD-EFGH-JKLM-NPQR-STUV-WXYZ';
    App.ajouterSocle();
    const lu = JSON.parse(w.localStorage.getItem('terrarium.config.v1'));
    verifier('« terrarium-config-a1b2c3 » est enregistré comme terraA1B2C3', lu.socles.some(s => s.id === 'terraA1B2C3'),
             lu.socles.map(s => s.id).join(', '));
    App.ouvrir('terraA1B2C3'); App.retirerSocle(); await attendre(200);

    // Mauvais code pour le socle simulé : refusé dès l'ajout, pas des jours plus tard.
    App.ouvrir(ID); App.retirerSocle(); await attendre(300);
    $('#a-id').value = ID; $('#a-jeton').value = 'MAUVAISCODEMAUVAISCODE00'; $('#a-nom').value = 'Terrarium de test';
    App.ajouterSocle();
    verifier('un mauvais code est refusé par le socle dès l\'ajout', await jusqua(() => texte('#message').includes('Code refusé'), 6000),
             texte('#message').slice(0, 50));
    const apres = JSON.parse(w.localStorage.getItem('terrarium.config.v1'));
    verifier('…le socle n\'est pas gardé et le formulaire est rendu',
             !apres.socles.some(s => s.id === ID) && $('#a-id').value === ID && $('#a-nom').value === 'Terrarium de test');
    $('#a-jeton').value = JETON;
    App.ajouterSocle();
    verifier('le bon code est vérifié et confirmé', await jusqua(() => texte('#message').includes('code vérifié'), 6000),
             texte('#message').slice(0, 50));
  }

  titre('20. Protocole 4 : le code d\'appairage ne circule plus');
  {
    const mqtt = require('mqtt');
    const espion = mqtt.connect(BROKER, { clientId: 'test-cmd-' + Date.now() });
    await new Promise((ok, ko) => { espion.once('connect', ok); espion.once('error', ko); });
    const vues = [];
    espion.on('message', (su, ch) => { if (su.endsWith('/cmd')) vues.push(ch.toString()); });
    await new Promise(ok => espion.subscribe(`terrarium/${ID}/cmd`, ok));
    App.ouvrir(ID);
    await attendre(800);
    await App.action('entretien', { minutes: 0 });
    await attendre(500);
    const modif = vues.map(v => JSON.parse(v)).find(d => typeof d.c === 'string' && JSON.parse(d.c).action === 'entretien');
    verifier('une commande modifiante part signée (c + sig, horodatée)', !!modif && /^[0-9a-f]{64}$/.test(modif.sig) && JSON.parse(modif.c).ts > 0);
    verifier('aucune commande ne porte le code en clair', vues.length > 0 && !vues.some(v => v.includes(JETON)), `${vues.length} commande(s)`);
    verifier('…et le socle l\'a acceptée', texte('#message').includes('acceptée') || texte('#message').length > 0, texte('#message').slice(0, 40));
    espion.end(true);
  }

  titre('21. Onglet Service (protocole 4) : sondes, surveillance, sauvegarde');
  {
    App.ouvrir(ID);
    App.panneau('service');
    const det = () => $('#detail').innerHTML;
    verifier('l\'onglet Service liste les sondes du socle', await jusqua(() => det().includes('28FF0000000000A1'), 6000));
    verifier('la surveillance est lue, sans adresse en clair', await jusqua(() => det().includes('Alertes et surveillance') && /Wi-Fi : Maison/.test(det()), 6000));
    $('[data-sv="relire"]').click();
    verifier('relire le bus répond', await jusqua(() => det().includes('28FF0000000000B2'), 6000));
    $('#sv-z1').value = '0';
    $('[data-sv="lier"][data-i="1"]').click();
    verifier('lier une sonde à une zone', await jusqua(() => texte('#message').includes('liee a la zone 1'), 6000), texte('#message').slice(0, 50));
    $('[data-sv="rapport"]').click();
    verifier('le rapport du jour se lit', await jusqua(() => det().includes('Rapport du'), 6000));
    $('#sv-ua').value = 'https://ntfy.sh/sujet-tres-secret';
    $('#sv-hm').value = '12';
    $('[data-form="sv-surveillance"]').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    verifier('nouvelle adresse d\'alerte : enregistrée, seul le serveur revient',
             await jusqua(() => texte('#message').includes('Enregistré') && det().includes('Alertes envoyées à ntfy.sh'), 6000) &&
             !det().includes('sujet-tres-secret') && $('#sv-ua').value === '');
    $('[data-sv="jours"]').click();
    verifier('les résumés journaliers forment un tableau', await jusqua(() => !!$('#detail table.tableau'), 6000));
    App.panneau('etat');
  }

  titre('22. Réglages du firmware 3.5 (protocole 4), là où on les cherche');
  {
    App.ouvrir(ID);
    App.panneau('programme');
    verifier('le soleil est dans Programmation', await jusqua(() => !!$('#gSO') && !!$('#gLat'), 6000));
    $('#gSO').checked = true;
    $('#gLat').value = '';
    $('#gLon').value = '';
    await App.reglerGeneraux();
    verifier('le soleil sans position est refusé par le socle', await jusqua(() => /Position inconnue/.test(texte('#message')), 4000), texte('#message').slice(0, 50));
    App.panneau('general');
    verifier('prix, écran, LED et rapport sont dans Appareil', await jusqua(() => !!$('#gPK') && !!$('#gEN') && !!$('#gRH'), 6000));
    $('#gPK').value = '0,2516';
    $('#gEN').value = '2';
    $('#gRH').value = '21:30';
    await App.reglerGeneraux();
    await jusqua(() => /enregistr/i.test(texte('#message')), 4000);
    App.panneau('securite');
    await jusqua(() => !!$('#gZP'), 6000);
    verifier('la zone prioritaire est dans Sécurité', !!$('#gZP'));
    $('#gZP').value = '1';
    await App.reglerGeneraux();
    await jusqua(() => /enregistr/i.test(texte('#message')), 4000);
    App.panneau('etat');          // les feuilles se reconstruisent d'après la réponse du socle
    App.panneau('general');
    verifier('prix, écran et heure du rapport enregistrés',
             await jusqua(() => !!$('#gPK') && $('#gPK').value === '0.2516' && $('#gEN').value === '2' && $('#gRH').value === '21:30', 6000),
             $('#gPK') ? `${$('#gPK').value} ${$('#gEN').value} ${$('#gRH').value}` : '');
    App.panneau('securite');
    verifier('zone prioritaire enregistrée', await jusqua(() => !!$('#gZP') && $('#gZP').value === '1', 6000));
    App.panneau('etat');
  }

  console.log(`\n=== ${echecs ? 'DES TESTS ONT ECHOUE' : 'TOUS LES TESTS PASSENT'}` +
              ` (${reussites} reussite(s), ${echecs} echec(s)) ===`);
  process.exit(echecs ? 1 : 0);
})().catch(e => { console.error('Test interrompu :', e); process.exit(2); });
