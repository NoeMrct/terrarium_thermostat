#!/usr/bin/env node
/* =============================================================================
   Vérifie que app/demo.html fonctionne réellement.
   -----------------------------------------------------------------------------
   Le fichier de démonstration est destiné à être ouvert d'un double-clic, sans
   serveur ni broker : c'est souvent la première chose qu'on montre à quelqu'un.
   Il mérite donc d'être testé comme le reste.

     node construire-demo.js && node test-demo.js
   ============================================================================= */

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const FICHIER = path.join(__dirname, '..', 'app', 'demo.html');
let ok = 0, ko = 0;
const v = (q, c, d = '') => {
  console.log(`   ${c ? '[ OK ]' : '[ECHEC]'} ${q.padEnd(50)} ${d}`);
  c ? ok++ : ko++;
};
const attendre = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const erreurs = [];
  const console_ = new VirtualConsole().on('jsdomError', e => erreurs.push(e.message));
  const dom = new JSDOM(fs.readFileSync(FICHIER, 'utf8'), {
    runScripts: 'dangerously', url: 'http://localhost/',
    pretendToBeVisual: true, virtualConsole: console_
  });
  const w = dom.window;
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
    get: (p2, p) => (p === 'canvas' ? {} : () => {})
  });
  w.notifications = [];
  w.isSecureContext = true;
  w.Notification = function (titre, opts) { w.notifications.push({ titre, corps: (opts || {}).body }); };
  w.Notification.permission = 'granted';
  w.Notification.requestPermission = async () => 'granted';
  const $ = s => w.document.querySelector(s);
  const socles = () => $('#socles').innerHTML;

  await attendre(2500);

  console.log('\n== Rendu initial');
  v('bandeau de démonstration présent', !!$('#bandeau-demo'));
  v('la liste s\'affiche directement', $('#vue-liste').style.display !== 'none');
  v('les deux socles sont listés', socles().includes('salon') && socles().includes('bureau'));
  v('connexion établie', $('#lien').textContent === 'connecté', $('#lien').textContent);
  v('présence détectée', socles().includes('tout va bien'));

  console.log('\n== Données');
  const temps = socles().match(/(\d+,\d)°/g) || [];
  v('les températures s\'affichent', temps.length >= 3, temps.join(' '));
  v('les noms de zones apparaissent', socles().includes('Point chaud'));
  // Piège classique : le socle publie « defaut: "0" » pour Home Assistant, et
  // la chaîne "0" est vraie en JavaScript. Sans normalisation, toutes les zones
  // saines s'afficheraient en panne.
  const enPanne = (socles().match(/DÉFAUT :/g) || []).length;
  v('une zone saine n\'est pas marquée en défaut', enPanne === 1, `${enPanne} zone(s) en défaut`);
  v('le défaut simulé porte son vrai libellé', socles().includes('SONDE'));
  v('un conseil accompagne le défaut', socles().includes('class="conseil"') && socles().includes('4,7 kΩ'));

  const t1 = (socles().match(/(\d+,\d)°/) || [])[1];
  await attendre(5000);
  const t2 = (socles().match(/(\d+,\d)°/) || [])[1];
  v('les températures évoluent dans le temps', t1 !== t2, `${t1} → ${t2}`);

  console.log('\n== Interaction');
  const App = w.eval('App');
  App.ouvrir('terraDEMO001');
  await attendre(700);
  v('l\'accueil du socle se remplit', $('#detail').innerHTML.includes('Point chaud') && !!$('#detail .ill'));
  v('huit rubriques sous les commandes rapides', $('#detail').querySelectorAll('.rubrique').length === 8 && $('#detail').querySelectorAll('.rond-lib').length === 4);
  App.zone(0);
  await attendre(500);
  v('l\'écran de la zone affiche la cible en grand', /32,0/.test(($('#detail [data-r="zcible"]') || {}).textContent || ''));
  v('les champs de réglage sont présents', !!$('#j0'));

  $('#j0').value = '33.5';
  await App.reglerZone(0);
  await attendre(900);
  v('commande acceptée', $('#message').textContent.includes('enregistr'), $('#message').textContent);

  $('#j0').value = '99';
  await App.reglerZone(0);
  await attendre(900);
  v('réglage dangereux refusé', $('#message').textContent.includes('10-45'), $('#message').textContent);

  $('#j0').value = '';              // le 99 refusé plus haut ne compte plus
  $('[data-action="cible"][data-pas="0.5"]').click();
  $('[data-action="cible"][data-pas="0.5"]').click();
  await attendre(400);
  v('les chevrons montent la cible par 0,5 °C', /34,5/.test($('#detail [data-r="zcible"]').textContent), $('#detail [data-r="zcible"]').textContent);
  await attendre(1800);
  v('…et l\'envoient une seconde après le dernier appui', $('#message').textContent.includes('enregistr'), $('#message').textContent);

  App.panneau('etat');
  await App.action('entretien', { minutes: 5 });
  await attendre(1600);
  v('entretien visible sur l\'accueil', $('#detail').innerHTML.includes('entretien : 5 min'));

  console.log('\n== Panneaux');
  App.panneau('reglages');
  await attendre(500);
  v('les températures de chaque zone sont là', !!$('#j0') && !!$('#n1') && !!$('#N0'));
  App.panneau('programme');
  await attendre(500);
  v('l\'horaire est présenté en HH:MM', $('#H0') && /^\d{2}:\d{2}$/.test($('#H0').value),
    $('#H0') && $('#H0').value);

  App.panneau('courbes');
  await attendre(1200);
  v('le canevas de courbes est présent', !!$('#courbe'));
  v('le socle a renvoyé des points', /point\(s\)/.test($('#legendeCourbe').textContent),
    $('#legendeCourbe').textContent.slice(0, 40));

  App.panneau('securite');
  await attendre(1200);
  v('coupure et alimentation dans Sécurité', !!$('#m0') && !!$('#gA'), $('#gA') && $('#gA').value);
  $('#gA').value = '5';
  await App.reglerGeneraux();
  await attendre(600);
  v('5 A débloquent deux zones', $('#message').textContent.includes('2 zone'),
    $('#message').textContent);
  App.panneau('general');
  await attendre(1200);
  v('les statistiques 24 h arrivent', $('#detail').innerHTML.includes('kWh'));

  console.log('\n== Service (protocole 4)');
  App.ouvrir('terraDEMO001');
  App.panneau('service');
  await attendre(1600);
  const det = () => $('#detail').innerHTML;
  v('l\'onglet Service se charge avec les sondes', det().includes('Sondes') && det().includes('28FF4C1D61160301'));
  v('la surveillance montre le serveur, pas l\'adresse', det().includes('ntfy.sh') && !det().includes('exemple-demo'));
  $('[data-sv="identifier"][data-z="0"]').click();
  await attendre(1200);
  v('identification lancée et suivie', /serre sa sonde/.test(det()), ($('#message').textContent || '').slice(0, 50));
  $('[data-sv="stop-identifier"]').click();
  await attendre(1000);
  v('identification annulée', !/serre sa sonde/.test(det()));
  $('[data-sv="essai"][data-z="1"]').click();
  await attendre(300);
  const oui = $('#dlg-confirm [data-dlg="oui"]');
  v('un essai de chauffe demande confirmation', !!oui);
  if (oui) oui.click();
  await attendre(1500);
  v('essai lancé et suivi', /Zone 2 en essai/.test(det()));
  $('[data-sv="stop-essai"]').click();
  await attendre(1000);
  $('[data-sv="jours"]').click();
  await attendre(1000);
  v('résumés journaliers en tableau, avec le coût', !!$('#detail table.tableau') && det().includes('kWh') && det().includes('<th scope="col">€</th>'));
  $('[data-sv="journal"]').click();
  await attendre(1000);
  v('le journal s\'affiche', det().includes('Demarrage') && det().includes('Essai de chauffe'));
  $('#sv-ua').value = 'https://ntfy.sh/autre-sujet-secret';
  $('[data-form="sv-surveillance"]').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await attendre(1000);
  v('nouvelle adresse d\'alerte enregistrée', $('#message').textContent.includes('Enregistré'), $('#message').textContent);
  v('…et effacée du champ : elle ne se relit plus', $('#sv-ua').value === '' && !det().includes('autre-sujet-secret'));

  console.log('\n== Notifications');
  // Le socle 2 démarre avec une zone en défaut : la lever doit produire une
  // notification de rétablissement, et une seule.
  const avant = w.notifications.length;
  App.ouvrir('terraDEMO002');
  await attendre(900);
  await App.action('reset');
  await attendre(1500);
  const nouvelles = w.notifications.slice(avant);
  v('un rétablissement est notifié', nouvelles.length >= 1,
    nouvelles.map(n => n.titre).join(' | ').slice(0, 56));
  v('le message nomme la zone concernée',
    nouvelles.some(n => /Zone fraîche|rétabli/i.test(n.titre + ' ' + n.corps)));
  const stable = w.notifications.length;
  await attendre(2500);
  v('rien n\'est renotifié tant que l\'état ne change pas',
    w.notifications.length === stable, `${w.notifications.length - stable} de plus`);

  v('aucune erreur JavaScript', erreurs.length === 0, erreurs.slice(0, 1).join('').slice(0, 70));

  console.log(`\n=== ${ko ? 'DES TESTS ONT ECHOUE' : 'DEMONSTRATION FONCTIONNELLE'}` +
              ` (${ok} reussite(s), ${ko} echec(s)) ===`);
  process.exit(ko ? 1 : 0);
})().catch(e => { console.error('Test interrompu :', e); process.exit(2); });
