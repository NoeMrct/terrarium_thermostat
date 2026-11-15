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
function creerApp(adressePage, avantChargement) {
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
  if (avantChargement) avantChargement(w);
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
  w.Notification = function (titre, opts) { w.notifications.push({ titre, corps: (opts || {}).body, data: (opts || {}).data }); };
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

  titre('8 bis. Adresse de la page : retour du téléphone, rechargement');
  {
    // L'adresse suit l'écran ; la flèche de l'application remonte par
    // history.back(), asynchrone : on attend l'adresse plutôt que de la lire.
    const adresse = (h, ms = 3000) => jusqua(() => w.location.hash === h, ms, 30);
    App.montrer('liste');
    await adresse('#/');
    App.ouvrir(ID);
    verifier('ouvrir un socle met son identifiant dans l\'adresse', await adresse('#/' + ID), w.location.hash);
    App.panneau('securite');
    verifier('une rubrique ouverte s\'y ajoute', await adresse(`#/${ID}/securite`), w.location.hash);
    w.history.back();
    const fermee = await jusqua(() => w.location.hash === '#/' + ID && $('#detail [data-r="feuille"]').hidden, 3000, 50);
    verifier('le retour du téléphone ferme la feuille', fermee, w.location.hash);
    App.zone(0);
    verifier('l\'écran d\'une zone a son adresse', await adresse(`#/${ID}/zone/1`), w.location.hash);
    const longueur = w.history.length;
    $('#detail [data-action="remonter"]').click();     // la flèche de la feuille
    const remonte = await adresse('#/' + ID) && await jusqua(() => $('#detail [data-r="feuille"]').hidden, 2000, 30);
    verifier('la flèche de l\'appli remonte par l\'historique, sans empiler d\'écran', remonte && w.history.length === longueur,
             `${w.history.length} entrées pour ${longueur}`);
    App.panneau('courbes');
    App.panneau('etat');                 // remontée décidée par l'application elle-même
    verifier('…une remontée programmée réécrit l\'entrée courante', w.location.hash === '#/' + ID && w.history.length === longueur,
             `${w.location.hash}, ${w.history.length} entrées pour ${longueur}`);
    // Rechargement sur une rubrique : même écran ; le retour passe par
    // l'accueil du socle, puis par la liste.
    // Broker injoignable pour cette copie : l'adresse suffit, et le socle
    // simulé ne voit pas d'autre application que celle des essais suivants.
    const cfg = JSON.stringify(Object.assign(JSON.parse(w.localStorage.getItem('terrarium.config.v1')),
      { broker: Object.assign(JSON.parse(w.localStorage.getItem('terrarium.config.v1')).broker, { url: 'ws://localhost:9/mqtt' }) }));
    const r = creerApp(`http://localhost:8080/#/${ID}/courbes`, x => x.localStorage.setItem('terrarium.config.v1', cfg));
    const rouvert = await jusqua(() => r.$('#vue-socle').style.display !== 'none' && !r.$('#detail [data-r="feuille"]').hidden
      && /Courbes/.test(r.texte('#titre-feuille')), 4000, 50);
    verifier('un rechargement rouvre le socle sur la même rubrique', rouvert, r.w.location.hash + ' ' + r.texte('#titre-feuille'));
    r.w.history.back();
    verifier('…le retour mène à l\'accueil du socle',
             await jusqua(() => r.w.location.hash === '#/' + ID && r.$('#detail [data-r="feuille"]').hidden, 3000, 50), r.w.location.hash);
    r.w.history.back();
    verifier('…puis à la liste', await jusqua(() => r.$('#vue-liste').style.display !== 'none', 3000, 50), r.w.location.hash);
    r.w.close();
    // WebKit : l'adresse suit l'écran sans rien empiler (bug WebKit 300402 :
    // recharger après un retour dans des entrées empilées fait planter la page).
    const k = creerApp(`http://localhost:8080/#/${ID}/courbes`, x => {
      x.localStorage.setItem('terrarium.config.v1', cfg);
      Object.defineProperty(x.navigator, 'userAgent', { value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1' });
    });
    const longueurK = k.w.history.length;
    const rouvertK = await jusqua(() => !k.$('#detail [data-r="feuille"]').hidden && /Courbes/.test(k.texte('#titre-feuille')), 4000, 50);
    k.App.panneau('securite');
    verifier('WebKit : lien profond rouvert, l\'adresse suit sans empiler d\'entrée',
             rouvertK && k.w.location.hash === `#/${ID}/securite` && k.w.history.length === longueurK, `${k.w.location.hash}, ${k.w.history.length} entrée(s)`);
    k.$('#detail [data-action="remonter"]').click();
    verifier('…la flèche remonte tout de suite, sans retour dans l\'historique',
             k.$('#detail [data-r="feuille"]').hidden && k.w.location.hash === '#/' + ID && k.w.history.length === longueurK, k.w.location.hash);
    k.w.close();
    App.ouvrir(ID);
  }

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
  {
    // La carte « hors ligne » (U26) : quoi vérifier, réessayer, la page locale.
    const carte = $('#detail [data-r="horsligne"]');
    verifier('la carte hors ligne dit quoi vérifier, en trois étapes',
             !carte.hidden && carte.textContent.includes('Le socle ne répond plus') && carte.querySelectorAll('.etapes-hl li').length === 3);
    verifier('…avec un lien vers la page locale du socle',
             /^http:\/\/terrafantome\.local\/$/.test((carte.querySelector('a.btn') || {}).href || ''), (carte.querySelector('a.btn') || {}).href);
    const reglages = $('#detail .rubrique[data-nom="reglages"]');
    verifier('les rubriques qui parlent au socle sont grisées',
             reglages.getAttribute('aria-disabled') === 'true' && reglages.classList.contains('inactive') &&
             reglages.textContent.includes('Réglable au retour du socle'));
    verifier('…pas les courbes ni les alertes, qui vivent dans l\'application',
             $('#detail .rubrique[data-nom="courbes"]').getAttribute('aria-disabled') === 'false' &&
             $('#detail .rubrique[data-nom="alertes"]').getAttribute('aria-disabled') === 'false');
    reglages.click();
    verifier('…un appui dit pourquoi, sans ouvrir de feuille vide',
             texte('#message').includes('Réglable au retour') && $('#detail [data-r="feuille"]').hidden, texte('#message'));
    verifier('les commandes rapides vers le socle aussi',
             $('#detail [data-cmd="reset"]').getAttribute('aria-disabled') === 'true');
    carte.querySelector('[data-action="reessayerSocle"]').click();
    verifier('« Réessayer » montre la recherche en cours',
             await jusqua(() => /Recherche du socle/.test($('#detail [data-r="horsligne"]').textContent), 2000) &&
             $('#detail [data-action="reessayerSocle"]').disabled);
    verifier('…puis dit que rien n\'a répondu, et à quelle heure',
             await jusqua(() => /Toujours rien à \d\d:\d\d/.test($('#detail [data-r="horsligne"]').textContent), 12000),
             ($('#detail [data-r="horsligne"] [role="status"]') || {}).textContent);
  }

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

  titre('13 bis. Dernier état connu, envois sans réseau (U26, U10, U40)');
  {
    const gardes = JSON.parse(w.localStorage.getItem('terrarium.dernier.v1') || '{}');
    verifier('le dernier état de chaque socle est gardé, daté',
             gardes[ID] && typeof gardes[ID].t === 'number' && (gardes[ID].zones || []).length === 2 && !gardes.terraFANTOME,
             Object.keys(gardes).join(','));
    // Une copie sans broker joignable : la liste montre le socle tel qu'on l'a
    // vu en dernier, sans tirets ni squelettes.
    const cfg = JSON.parse(w.localStorage.getItem('terrarium.config.v1'));
    cfg.broker = Object.assign({}, cfg.broker, { url: 'ws://localhost:9/mqtt' });
    const r = creerApp('http://localhost:8080/', x => {
      x.localStorage.setItem('terrarium.config.v1', JSON.stringify(cfg));
      x.localStorage.setItem('terrarium.dernier.v1', JSON.stringify(gardes));
    });
    const liste = () => r.texte('#socles');
    verifier('sans réseau, la liste montre le dernier état connu',
             await jusqua(() => (liste().match(/\d+,\d°/g) || []).length >= 2 && /hors ligne depuis/.test(liste()), 4000), liste().slice(0, 90));
    r.App.ouvrir(ID);
    verifier('…l\'accueil du socle aussi, zones grisées et datées',
             await jusqua(() => r.$('#detail .zone-accueil.eteinte') && /Relevé à/.test(r.texte('#detail')), 3000) &&
             r.$('#detail [data-r="accueil"]').classList.contains('eteint'));
    await r.App.action('reset');
    verifier('une commande sans réseau attend, annulable',
             r.texte('#message').includes('envoi en attente') && !!r.$('#message button'), r.texte('#message'));
    r.$('#message button').click();
    verifier('…et s\'annule', r.texte('#message').includes('Envoi annulé'), r.texte('#message'));
    r.w.close();
  }

  titre('13 ter. Réglages de l\'application et Organiser (U9)');
  {
    App.montrer('liste');
    $('#vue-liste [data-action="reglagesApp"]').click();
    verifier('les réglages s\'ouvrent à leur adresse, compte et connexion compris',
             $('#vue-reglages').style.display !== 'none' && w.location.hash === '#/reglages' && /Broker/.test(texte('#broker-hote')), w.location.hash);
    $('#reglages [data-action="theme"][data-theme="sombre"]').click();
    verifier('le thème choisi s\'applique et se garde', w.document.documentElement.dataset.theme === 'sombre'
             && w.localStorage.getItem('terrarium.theme') === 'sombre' && $('#reglages [data-theme="sombre"]').getAttribute('aria-pressed') === 'true');
    $('#reglages [data-action="theme"][data-theme="auto"]').click();
    verifier('…« Auto » rend la main au téléphone', !w.document.documentElement.dataset.theme && !w.localStorage.getItem('terrarium.theme'));
    $('#reglages [data-page="organiser"]').click();
    verifier('Organiser a sa propre adresse', w.location.hash === '#/reglages/organiser' && /Organiser/.test(texte('#titre-reglages')), w.location.hash);
    const noms = () => Array.from(w.document.querySelectorAll('#reglages .champ-nom')).map(i => i.value);
    const avant = noms();
    $(`#reglages [data-action="orgDescendre"][data-id="${ID}"]`).click();
    verifier('un socle descend d\'un rang, et la liste suit', noms()[1] === avant[0] && JSON.parse(w.localStorage.getItem('terrarium.config.v1')).socles[1].id === ID,
             noms().join(' / '));
    verifier('…le focus reste sur le socle déplacé', w.document.activeElement && w.document.activeElement.dataset.id === ID);
    $(`#reglages [data-action="orgMonter"][data-id="${ID}"]`).click();
    const champ = $(`#reglages .champ-nom[data-id="${ID}"]`);
    champ.value = 'Terrarium renommé';
    champ.dispatchEvent(new w.Event('change', { bubbles: true }));
    verifier('un socle se renomme sur place', JSON.parse(w.localStorage.getItem('terrarium.config.v1')).socles[0].nom === 'Terrarium renommé');
    $('#reglages [data-action="orgNouveauGroupe"]').click();
    const g = $('#reglages .champ-groupe');
    verifier('« Nouveau groupe » ajoute un groupe vide, à nommer', !!g && w.document.activeElement === g && $('#reglages [data-action="orgSupprimerGroupe"]'));
    g.value = 'Maison';
    g.dispatchEvent(new w.Event('change', { bubbles: true }));
    $(`#reglages [data-action="orgDescendre"][data-id="terraFANTOME"]`).click();
    const cfgG = JSON.parse(w.localStorage.getItem('terrarium.config.v1'));
    verifier('descendre le dernier socle le fait entrer dans le groupe',
             JSON.stringify(cfgG.groupes) === '["Maison"]' && cfgG.socles.find(x => x.id === 'terraFANTOME').groupe === 'Maison', JSON.stringify(cfgG.groupes));
    App.montrer('liste');
    verifier('la liste montre le groupe et son socle, après les autres',
             (texte('#socles').match(/Terrarium renommé[\s\S]*Maison[\s\S]*Socle absent/) || []).length === 1, texte('#socles').replace(/\s+/g, ' ').slice(0, 80));
    App.reglagesApp('organiser');
    const compacte = $('#org-compacte');
    compacte.checked = true;
    compacte.dispatchEvent(new w.Event('change', { bubbles: true }));
    App.montrer('liste');
    verifier('vue compacte : une ligne par socle, la température de chaque zone',
             $('#socles').classList.contains('compacte') && $('#socles .socle.compacte .nom-compact') && /\d+,\d°/.test(texte('#socles .socle.compacte')));
    App.reglagesApp('organiser');
    compacte.checked = false;
    $('#org-compacte').checked = false;
    $('#org-compacte').dispatchEvent(new w.Event('change', { bubbles: true }));
    const cases = Array.from(w.document.querySelectorAll('#reglages [data-org-case]'));
    verifier('actions groupées : le socle hors ligne n\'est pas proposé', cases.length === 2 && cases.find(c => c.dataset.orgCase === 'terraFANTOME').disabled
             && cases.find(c => c.dataset.orgCase === ID).checked);
    $('#reglages [data-action="orgGroupe"][data-cmd="entretien"]').click();
    verifier('« Entretien 30 min » part vers les socles cochés, et le dit',
             await jusqua(() => /confirmé/.test(texte('#reglages [data-r="resultat"]')), 10000), texte('#reglages [data-r="resultat"]'));
    await App.action('entretien', { minutes: 0 });
    App.reglagesApp('menu');
    verifier('retour au menu : le focus revient sur « Organiser »', w.document.activeElement && w.document.activeElement.dataset.page === 'organiser');
    // Le groupe vidé se supprime ; le nom d'origine revient.
    App.reglagesApp('organiser');
    $(`#reglages [data-action="orgMonter"][data-id="terraFANTOME"]`).click();
    $('#reglages [data-action="orgSupprimerGroupe"]').click();
    const champ2 = $(`#reglages .champ-nom[data-id="${ID}"]`);
    champ2.value = 'Terrarium de test';
    champ2.dispatchEvent(new w.Event('change', { bubbles: true }));
    const cfgFin = JSON.parse(w.localStorage.getItem('terrarium.config.v1'));
    verifier('un groupe vide se supprime', !(cfgFin.groupes || []).length && !cfgFin.socles.some(x => x.groupe), JSON.stringify(cfgFin.groupes));
    App.montrer('liste');
  }

  titre('13 quater. Copier des réglages depuis un fichier (U18, U19)');
  {
    App.reglagesApp('transfert');
    verifier('« Copier des réglages » a son adresse', w.location.hash === '#/reglages/transfert' && /Copier des réglages/.test(texte('#titre-reglages')));
    // Une sauvegarde de la page locale : la zone 1 à 30,5° jour et nuit.
    const champ = $('#fichier-reglages');
    const fichier = new w.File([JSON.stringify({ format: 'terrarium-sauvegarde', zones: [{ nom: 'Zone 1', consigneJour: 30.5, consigneNuit: 30.5 }], globaux: {} })],
      'sauvegarde.json', { type: 'application/json' });
    Object.defineProperty(champ, 'files', { value: [fichier], configurable: true });
    champ.dispatchEvent(new w.Event('change', { bubbles: true }));
    const vers = $('#tr-vers');
    await jusqua(() => $('#tr-de') && $('#tr-de').value === 'fichier', 4000, 50);
    vers.value = ID;
    vers.dispatchEvent(new w.Event('change', { bubbles: true }));
    const apercu = () => texte('#reglages [data-r="apercu"]');
    verifier('le fichier devient la source ; l\'aperçu montre l\'avant et l\'après',
             await jusqua(() => /jour33,5°30,5°/.test(apercu().replace(/\s+/g, '')), 8000), apercu().replace(/\s+/g, ' ').slice(0, 90));
    $('#reglages [data-action="trAppliquer"]').click();
    verifier('« Appliquer » envoie au socle, qui confirme',
             await jusqua(() => /Appliqué à « Terrarium de test »/.test(texte('#reglages [data-r="action"]')), 8000), texte('#reglages [data-r="action"]').trim());
    App.ouvrir(ID);
    verifier('…la nouvelle consigne revient du socle', await jusqua(() => $('#detail').innerHTML.includes('Cible 30,5°'), 6000));
    App.reglagesApp('transfert');
    $('#reglages [data-action="trAnnuler"]').click();
    verifier('« Annuler » remet les réglages d\'avant', await jusqua(() => /remis sur/.test(texte('#reglages [data-r="action"]')), 8000));
    App.ouvrir(ID);
    verifier('…et le socle les confirme', await jusqua(() => $('#detail').innerHTML.includes('Cible 33,5°'), 6000));
    // Depuis la rubrique Appareil d'un socle : la page s'ouvre avec lui en
    // source ; la flèche remonte ensuite les réglages, puis la liste.
    App.panneau('general');
    await jusqua(() => !!$('#detail [data-page="transfert"]'), 4000, 50);
    $('#detail [data-page="transfert"]').click();
    verifier('Appareil → « Copier, exporter ou importer… » : ce socle en source', w.location.hash === '#/reglages/transfert' && $('#tr-de').value === ID, w.location.hash);
    $('#vue-reglages [data-action="remonter"]').click();
    $('#vue-reglages [data-action="remonter"]').click();
    verifier('…la flèche remonte aux réglages, puis à la liste (pas au socle d\'où l\'on vient)',
             await jusqua(() => $('#vue-liste').style.display !== 'none' && w.location.hash === '#/', 2000, 30), w.location.hash);
  }

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

  titre('16 bis. Mises à jour automatiques (F15)');
  {
    App.panneau('etat');
    App.panneau('maj');
    const formulaire = () => w.document.querySelector('#detail form[data-form="majauto"]');
    verifier('la carte « Mises à jour automatiques » se remplit à l\'ouverture',
             await jusqua(() => !!formulaire() && !!w.document.getElementById('mjD'), 4000));
    verifier('…version disponible, prévue la nuit entre 03:00 et 05:00, notes de version',
             texte('#detail').includes('3.6.0') && texte('#detail').includes('entre 03:00 et 05:00') && texte('#detail').includes('images signées'));
    verifier('…activées par défaut', w.document.getElementById('mjA').checked === true);
    w.document.getElementById('mjA').checked = false;
    w.document.getElementById('mjD').value = '22:30';
    w.document.getElementById('mjF').value = '01:00';
    formulaire().dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    verifier('« Enregistrer » coupe et règle la plage (relue sur le socle)',
             await jusqua(() => texte('#detail').includes('Désactivées') && w.document.getElementById('mjD') && w.document.getElementById('mjD').value === '22:30', 4000),
             texte('#message').slice(0, 50));
    w.document.getElementById('mjA').checked = true;
    w.document.getElementById('mjD').value = '3:00';
    w.document.getElementById('mjF').value = '05:00';
    formulaire().dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await jusqua(() => texte('#detail').includes('entre 03:00 et 05:00'), 4000);
    const reporter = $('[data-action="majAutoOp"][data-op="reporter"]');
    verifier('« Reporter de 7 jours » proposé', !!reporter && reporter.textContent.includes('7 jours'));
    reporter.click();
    verifier('…reportées jusqu\'à une date, puis « Annuler le report »',
             await jusqua(() => texte('#detail').includes('Reportées jusqu') && ($('[data-action="majAutoOp"][data-op="reporter"]') || {}).textContent === 'Annuler le report', 4000));
    $('[data-action="majAutoOp"][data-op="reporter"]').click();
    verifier('…report annulé', await jusqua(() => !texte('#detail').includes('Reportées jusqu'), 4000));
    w.document.getElementById('mjF').value = '03:00';
    formulaire().dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await attendre(300);
    verifier('une plage vide est refusée dans l\'application', texte('#message').includes('deux heures différentes'));
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
    verifier('elle désigne son socle (un appui l\'ouvre)', w.notifications.some(n => n.data && n.data.socle === ID),
             JSON.stringify((w.notifications[0] || {}).data || null));
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

  titre('23. Assistant d\'installation : étiquette, Wi-Fi suivi en direct, réglages de départ');
  {
    App.ouvrir(ID); App.retirerSocle(); await attendre(300);
    App.nouveauSocle();
    verifier('l\'assistant s\'ouvre sur la saisie (pas de lecteur de QR ici)',
             $('#vue-installation').style.display !== 'none' && !$('[data-pas="reference"]').hidden, texte('#inst-etape'));
    $('#a-id').value = ID; $('#a-jeton').value = 'MAUVAISCODEMAUVAISCODE00';
    App.ajouterSocle();
    verifier('étape 2 : le Wi-Fi du socle est nommé comme le firmware le nomme',
             !$('[data-pas="reseau"]').hidden && texte('#inst-ap') === 'terrarium-config-' + ID.slice(5), texte('#inst-ap'));
    verifier('…et la reprise après relance est notée (sans le code)',
             /"pas":"reseau"/.test(w.localStorage.getItem('terrarium.installation') || '') && !/MAUVAIS/.test(w.localStorage.getItem('terrarium.installation') || ''));
    verifier('un mauvais code, prouvé faux par le socle, ramène à la saisie',
             await jusqua(() => !$('[data-pas="reference"]').hidden && texte('#message').includes('Code refusé'), 12000), texte('#message').slice(0, 40));
    verifier('…le socle n\'est pas gardé, la référence reste remplie',
             !JSON.parse(w.localStorage.getItem('terrarium.config.v1')).socles.some(s => s.id === ID) && $('#a-id').value === ID);
    $('#a-jeton').value = JETON;
    App.ajouterSocle();
    verifier('le socle est vu en ligne, son code vérifié', await jusqua(() => !$('#inst-wifi-suite').hidden, 12000),
             Array.from(w.document.querySelectorAll('#inst-suivi li')).map(l => l.className).join(' '));
    verifier('les quatre lignes du suivi finissent cochées (heure comprise)',
             await jusqua(() => w.document.querySelectorAll('#inst-suivi li.fait').length === 4, 12000),
             Array.from(w.document.querySelectorAll('#inst-suivi li')).map(l => l.className).join(' '));
    App.instPas('reglages');
    verifier('étape 3 : les consignes du socle sont proposées', !!$('#o-j0') && /^\d+,\d$/.test($('#o-j0').value), $('#o-j0') && $('#o-j0').value);
    $('#a-nom').value = 'Terrarium du salon';
    $('#o-j0').value = '31,5';
    $('#o-j1').value = 'trente';
    await App.instReglages();
    verifier('une consigne illisible est refusée avant tout envoi', texte('#message').includes('trente') && !$('[data-pas="reglages"]').hidden, texte('#message').slice(0, 40));
    $('#o-j1').value = '';
    await App.instReglages();
    verifier('les réglages partent, puis l\'écran de fin', await jusqua(() => !$('[data-pas="fin"]').hidden, 6000), texte('#inst-etape'));
    verifier('le nom choisi est gardé', JSON.parse(w.localStorage.getItem('terrarium.config.v1')).socles.some(s => s.id === ID && s.nom === 'Terrarium du salon'));
    verifier('l\'installation terminée n\'est plus à reprendre', !w.localStorage.getItem('terrarium.installation'));
    App.instVoir();
    // Une feuille garde ses champs tant que sa structure ne change pas : on
    // rouvre le socle, ce qui la reconstruit d'après le dernier état reçu.
    verifier('le socle a pris la consigne de jour', await jusqua(() => {
      App.ouvrir(ID); App.panneau('reglages');
      return !!$('#j0') && /^31[.,]5$/.test($('#j0').value);
    }, 8000, 500), $('#j0') && $('#j0').value);
    App.panneau('etat');
  }

  titre('23 bis. Journal du socle et consommation (F4, F3)');
  {
    App.ouvrir(ID);
    App.panneau('journal');
    const det = () => texte('#detail');
    verifier('le journal du socle se lit en phrases, par jour',
             await jusqua(() => det().includes('Trop chaud') && det().includes('Hier') && det().includes('Passage en nuit'), 6000), det().slice(0, 80));
    verifier('…les passages des deux zones à la même minute font une seule entrée',
             /Vers 26,0° et 24,0°/.test(det()), (det().match(/Vers [^A-Z]{0,30}/) || [''])[0]);
    verifier('…une coupure de courant y est expliquée', det().includes('Coupure de courant') && det().includes('retour à 13:05'));
    $('[data-action="filtreJournal"][data-filtre="alertes"]').click();
    verifier('le filtre « Alertes » ne garde que les alertes',
             await jusqua(() => det().includes('Trop chaud') && !det().includes('Passage en jour'), 2000) &&
             $('[data-filtre="alertes"]').getAttribute('aria-pressed') === 'true');
    $('[data-action="filtreJournal"][data-filtre="tout"]').click();
    App.panneau('conso');
    verifier('la consommation du mois et sa projection s\'affichent',
             await jusqua(() => /Depuis le 1er/.test(det()) && det().includes('kWh') && /Environ .* sur un an/.test(det()), 6000), det().slice(0, 90));
    verifier('…le détail par tapis et le socle lui-même', det().includes('Tapis 1') && det().includes('Le socle lui-même'));
    verifier('…le rapport d\'hier, tiré du dernier résumé', det().includes('Rapport d\'hier') && /Chauffe 5 h 12/.test(det()), det().match(/Chauffe[^.]*/) && det().match(/Chauffe[^.]*/)[0]);
    $('#co-prix').value = '0,30';
    $('#co-prix').closest('form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    verifier('le prix du kWh s\'enregistre sur le socle',
             await jusqua(() => texte('#message').includes('Prix du kWh enregistré'), 4000), texte('#message'));
    $('#co-prix').value = '9';
    $('#co-prix').closest('form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await attendre(100);
    verifier('…un prix aberrant est refusé dans l\'application', texte('#message').includes('Prix invalide'), texte('#message'));
    App.panneau('etat');
  }

  titre('24. Lien de l\'étiquette : l\'installation part de l\'adresse, sans rien recopier');
  {
    const b = creerApp('http://localhost:8080/#a/terra3f8a1c/K7QM2X-RP9WTD-H4BNZ8-LC3FVA');
    verifier('le fragment (code compris) est retiré de l\'adresse aussitôt', b.w.location.hash === '', b.w.location.href);
    verifier('l\'accueil annonce l\'étiquette lue', !b.$('#bienvenue-etiquette').hidden && b.texte('#bienvenue-etiquette').includes('terra3F8A1C'));
    b.$('#b-url').value = BROKER;
    b.App.enregistrerBroker();
    verifier('une fois connecté, l\'installation s\'ouvre avec l\'étiquette',
             !b.$('[data-pas="reference"]').hidden && b.$('#a-id').value === 'terra3F8A1C' && b.$('#a-jeton').value === 'K7QM2XRP9WTDH4BNZ8LC3FVA',
             `${b.$('#a-id').value} ${b.$('#a-jeton').value}`);
    b.App.instQuitter();
    const c = creerApp('http://localhost:8080/#a/terra3f8a1c/TROPCOURT');
    verifier('une étiquette illisible est ignorée', c.$('#bienvenue-etiquette').hidden);
  }

  console.log(`\n=== ${echecs ? 'DES TESTS ONT ECHOUE' : 'TOUS LES TESTS PASSENT'}` +
              ` (${reussites} reussite(s), ${echecs} echec(s)) ===`);
  process.exit(echecs ? 1 : 0);
})().catch(e => { console.error('Test interrompu :', e); process.exit(2); });
