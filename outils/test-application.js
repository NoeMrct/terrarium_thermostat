#!/usr/bin/env node
/* =============================================================================
   Test de bout en bout de l'application.
   -----------------------------------------------------------------------------
   Charge la VRAIE application (index.html + app.js) dans un DOM headless, la
   connecte à un broker, et la fait dialoguer avec un socle simulé. Vérifie ce
   qu'aucun test de syntaxe ne peut voir : le modèle d'état, l'analyse des
   sujets, le rendu, et le comportement quand le socle ne répond pas.

     npm install jsdom mqtt
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
  // jsdom ne charge pas les scripts externes en mode « outside-only » : on
  // retire la balise et on injecte la bibliothèque directement.
  const html = fs.readFileSync(path.join(DOSSIER, 'index.html'), 'utf8')
                 .replace(/<script src="(?:https:|vendor\/)[^"]*"><\/script>/, '');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: adressePage,
    pretendToBeVisual: true
  });
  const w = dom.window;
  w.mqtt = require('mqtt');
  w.confirm = () => true;                 // les confirmations sont acceptées
  // jsdom ne dessine pas : un contexte 2D inerte suffit pour que le code de
  // tracé s'exécute réellement au lieu de renoncer à la première ligne.
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
    get: (_, p) => (p === 'canvas' ? {} : () => {})
  });
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
  const source = fs.readFileSync(path.join(DOSSIER, 'app.js'), 'utf8');
  const App = w.eval(source + '\n;App');
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
  const enLigne = await jusqua(() => $('#socles').innerHTML.includes('en ligne'));
  verifier('sa présence est détectée', enLigne);
  const temperatures = await jusqua(() => /\d+\.\d<small> °C<\/small>/.test($('#socles').innerHTML));
  verifier('les températures des deux zones s\'affichent', temperatures,
           ($('#socles').innerHTML.match(/\d+\.\d<small>/g) || []).join(' '));

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
  verifier('les champs de réglage sont présents', !!$('#j0') && !!$('#n0'));

  // Jour ET nuit a la meme valeur : la consigne affichee par le socle est celle
  // du moment, et ce test tournait donc a l'echec une fois passe 20 h.
  $('#j0').value = '33.5';
  $('#n0').value = '33.5';
  await App.reglerZone(0);
  await attendre(300);
  verifier('réglage accepté par le socle',
           texte('#message').includes('enregistrés'), texte('#message'));
  const applique = await jusqua(() => $('#detail').innerHTML.includes('cible 33.5'));
  verifier('la nouvelle consigne revient du socle', applique);

  titre('7. Un refus du socle est montré à l\'utilisateur');
  $('#j0').value = '99';
  await App.reglerZone(0);
  await attendre(300);
  verifier('le message d\'erreur vient du socle lui-même',
           texte('#message').includes('10-45'), texte('#message'));
  verifier('il est présenté comme une erreur',
           $('#message').className.includes('erreur'));

  titre('8. Entretien');
  await App.action('entretien', { minutes: 5 });
  const enEntretien = await jusqua(() => $('#detail').innerHTML.includes('entretien'));
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
  App.panneau('reglages');
  const formComplet = await jusqua(() => !!$('#H0') && !!$('#m0'));
  verifier('les horaires et le seuil de coupure sont accessibles', formComplet);
  verifier('l\'horaire est présenté en HH:MM', $('#H0') && /^\d{2}:\d{2}$/.test($('#H0').value),
           $('#H0') && $('#H0').value);
  $('#H0').value = '07:30';
  $('#m0').value = '41';
  await App.reglerZoneComplet(0);
  await attendre(400);
  verifier('l\'enregistrement est accepté', texte('#message').includes('enregistrés'), texte('#message'));
  App.panneau('etat'); await attendre(200);
  App.panneau('reglages');
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

  titre('12. Panneau appareil : alimentation, saison, statistiques');
  App.panneau('general');
  const generalPret = await jusqua(() => !!$('#gA') && texte('#detail').includes('Sur 24 heures'), 12000);
  verifier('les réglages généraux et les statistiques arrivent', generalPret);
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

  console.log(`\n=== ${echecs ? 'DES TESTS ONT ECHOUE' : 'TOUS LES TESTS PASSENT'}` +
              ` (${reussites} reussite(s), ${echecs} echec(s)) ===`);
  process.exit(echecs ? 1 : 0);
})().catch(e => { console.error('Test interrompu :', e); process.exit(2); });
