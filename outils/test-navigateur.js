#!/usr/bin/env node
/* =============================================================================
   L'application réelle dans un vrai Chromium, face à un vrai broker.
   -----------------------------------------------------------------------------
   jsdom ne sait ni rendre, ni enregistrer un agent de service, ni appliquer une
   politique de sécurité du contenu. Ici, index.html est servi en HTTP local
   (CSP active), l'application se connecte au broker avec son propre client
   MQTT, pilote le socle simulé, ouvre ses dialogues, exporte un fichier, et le
   tout ne doit produire ni erreur ni avertissement console.

   Dépend de Playwright, d'un broker WebSocket et du socle simulé :
     node socle-simule.js --broker mqtt://localhost:1883 --id terraSIM001 &
     node test-navigateur.js --broker ws://localhost:9001/mqtt --id terraSIM001

   Le moteur se choisit avec --navigateur chromium | webkit | firefox (après
   « npx playwright install webkit firefox ») : Safari sur iPhone est le
   téléphone cible, et WebKit est le moteur qui diverge le plus (dialogues,
   IndexedDB, WebCrypto, Pointer Events).
   ============================================================================= */

/* global document, navigator, caches, window, localStorage */
const path = require('path');
const http = require('http');
const fs = require('fs');
let playwright;
try { playwright = require('playwright'); }
catch (e) { console.error('Playwright est nécessaire : npm install --no-save playwright && npx playwright install chromium'); process.exit(2); }

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const BROKER = arg('broker', 'ws://localhost:9001/mqtt');
const ID = arg('id', 'terraSIM001');
const JETON = arg('jeton', 'SIMULATIONTESTJETON00001');
const PORT = +arg('port', 8081);
const MOTEUR = arg('navigateur', 'chromium');
if (!playwright[MOTEUR]) { console.error(`Moteur inconnu : ${MOTEUR} (chromium, webkit ou firefox)`); process.exit(2); }
const APP = path.resolve(__dirname, '..', 'app');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
                '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

let ok = 0, ko = 0;
const v = (q, c, d = '') => { console.log(`   ${c ? '[ OK ]' : '[ECHEC]'} ${q.padEnd(54)} ${String(d).slice(0, 60)}`); c ? ok++ : ko++; };

const serveur = http.createServer((req, res) => {
  let f = path.join(APP, decodeURIComponent(req.url.split('?')[0]));
  if (f.endsWith('/')) f += 'index.html';
  // version.json est produit à la publication : ici, une valeur de test.
  if (req.url.split('?')[0] === '/version.json' && !fs.existsSync(f)) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ version: 'test', commit: 'banc', date: '' })); return;
  }
  fs.readFile(f, (e, d) => {
    if (e) { res.statusCode = 404; res.end('absent'); return; }
    res.setHeader('Content-Type', TYPES[path.extname(f)] || 'application/octet-stream');
    res.end(d);
  });
}).listen(PORT);

(async () => {
  console.log(`Moteur : ${MOTEUR}`);
  const navigateur = await playwright[MOTEUR].launch(MOTEUR === 'chromium' && process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  // Firefox ne sait pas émuler un mobile (isMobile) : fenêtre étroite seulement.
  const ctx = await navigateur.newContext({ viewport: { width: 390, height: 844 }, isMobile: MOTEUR !== 'firefox', hasTouch: MOTEUR !== 'firefox', locale: 'fr-FR', acceptDownloads: true });
  const page = await ctx.newPage();
  const erreurs = [];
  page.on('pageerror', e => erreurs.push('pageerror: ' + e.message));
  page.on('console', m => {
    // Un broker qui n'est pas le serveur Terrariums répond 404 à /api/infos :
    // c'est la détection normale du serveur, pas une erreur de l'application.
    if (/Failed to load resource/.test(m.text()) && /api\/infos/.test(m.location().url || '')) return;
    if (m.type() === 'error' || m.type() === 'warning') erreurs.push(m.type() + ': ' + m.text());
  });
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForTimeout(600);

  console.log('\n== Connexion');
  v('écran broker affiché', await page.isVisible('#vue-broker'));
  await page.fill('#b-url', BROKER);
  await page.click('[data-action="testerBroker"]');
  await page.waitForFunction(() => /Connexion réussie|impossible/.test(document.querySelector('#message').textContent), null, { timeout: 12000 }).catch(() => {});
  v('« Tester la connexion » répond', (await page.textContent('#message')).includes('Connexion réussie'), await page.textContent('#message'));
  await page.click('#vue-broker button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#lien').textContent === 'connecté', null, { timeout: 8000 }).catch(() => {});
  v('connecté au broker via le client maison', (await page.textContent('#lien')) === 'connecté', await page.textContent('#lien'));

  console.log('\n== Socle');
  await page.fill('#a-id', ID);
  await page.fill('#a-jeton', JETON);
  await page.fill('#a-nom', 'Banc réel');
  await page.click('#vue-liste form[data-form=socle] button[type=submit]');
  await page.waitForFunction(() => /\d+\.\d<small>/.test(document.querySelector('#socles').innerHTML), null, { timeout: 8000 }).catch(() => {});
  v('températures affichées', /\d+\.\d<small>/.test(await page.innerHTML('#socles')));
  await page.click('#socles .socle');
  await page.waitForTimeout(600);
  v('vue détaillée ouverte', (await page.innerHTML('#detail')).includes('Banc réel'));
  await page.fill('#j0', '31,5');
  await page.click('#detail form[data-form=zone][data-z="0"] button[type=submit]');
  await page.waitForTimeout(900);
  v('consigne avec virgule acceptée (commande en QoS 1)', (await page.textContent('#message')).includes('enregistrés'), await page.textContent('#message'));

  console.log('\n== Panneaux');
  await page.click('.onglets button[data-nom=courbes]');
  await page.waitForFunction(() => /point\(s\)/.test(document.querySelector('#legendeCourbe').textContent), null, { timeout: 8000 }).catch(() => {});
  v('courbes chargées', /point\(s\)/.test(await page.textContent('#legendeCourbe')));
  const [telechargement] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }).catch(() => null),
    page.click('[data-action="exporterCsv"]')
  ]);
  v('export CSV téléchargé', !!telechargement && /\.csv$/.test(telechargement.suggestedFilename()), telechargement ? telechargement.suggestedFilename() : 'aucun');
  await page.click('.onglets button[data-nom=general]');
  await page.waitForFunction(() => !!document.querySelector('#gA') && document.querySelector('#detail').textContent.includes('Sur 24 heures'), null, { timeout: 8000 }).catch(() => {});
  v('panneau appareil chargé, santé affichée', !!(await page.$('#gA')) && (await page.innerHTML('#detail')).includes('Santé'));

  console.log('\n== Dialogues');
  await page.click('[data-action="redemarrer"]');
  await page.waitForTimeout(300);
  v('la confirmation est un dialogue de la page, pas du navigateur', await page.isVisible('#dlg-confirm'));
  await page.click('#dlg-confirm [data-dlg="non"]');
  await page.waitForTimeout(300);
  v('« Annuler » referme le dialogue sans agir', !(await page.isVisible('#dlg-confirm')) && !(await page.textContent('#message')).includes('acceptée'));
  await page.click('[data-action="diagnostic"]').catch(() => {});
  // Le bouton Diagnostic est au pied de la liste : on y revient.
  await page.click('[data-action="montrer"][data-vue="liste"]');
  await page.click('#vue-liste [data-action="diagnostic"]');
  await page.waitForTimeout(300);
  const rapport = await page.textContent('#diag-texte');
  v('le rapport de diagnostic nomme le socle et sa santé', rapport.includes(ID) && /rssi -?\d+ dBm/.test(rapport), rapport.split('\n')[0]);
  v('le rapport ne contient pas le code d\'appairage', !rapport.includes(JETON));
  await page.click('[data-action="fermerDiag"]');

  console.log('\n== Retrait annulable');
  await page.click('#socles .socle');
  await page.waitForTimeout(400);
  await page.click('.onglets button[data-nom=general]');
  await page.waitForTimeout(400);
  await page.click('[data-action="retirerSocle"]');
  await page.waitForTimeout(300);
  v('le socle est retiré tout de suite', !(await page.innerHTML('#socles')).includes('Banc réel'));
  await page.click('#message button');
  await page.waitForTimeout(400);
  v('« Annuler » le remet en place', (await page.innerHTML('#socles')).includes('Banc réel'));

  console.log('\n== Trusted Types');
  const tt = await page.evaluate(() => {
    const r = { politique: typeof window.trustedTypes === 'object', refus: false, message: '' };
    try { const d = document.createElement('div'); d.innerHTML = '<b>x</b>'; } catch (e) { r.refus = true; r.message = e.message; }
    return r;
  });
  if (tt.politique) {
    v('la CSP exige des Trusted Types : une écriture innerHTML hors politique est refusée', tt.refus, tt.message.slice(0, 50));
    // Le refus provoqué ci-dessus est journalisé par le navigateur : il est attendu.
    const provoque = erreurs.findIndex(e => /TrustedHTML/.test(e));
    if (tt.refus && provoque >= 0) erreurs.splice(provoque, 1);
  } else {
    v('Trusted Types : non pris en charge par ce moteur, directive ignorée sans erreur', true, MOTEUR);
  }
  v('…alors que l\'application, elle, a bien rendu la page', (await page.innerHTML('#socles')).includes('Banc réel'));

  console.log('\n== Code de verrouillage (configuration chiffrée)');
  await page.click('#btn-definir-code');
  await page.waitForTimeout(300);
  v('le dialogue de code s\'ouvre', await page.isVisible('#dlg-code'));
  await page.fill('#code-1', '2468');
  await page.fill('#code-2', '2469');
  await page.click('#dlg-code button[type=submit]');
  await page.waitForTimeout(200);
  v('deux codes différents sont refusés', (await page.textContent('#code-erreur')).includes('identiques'));
  await page.fill('#code-2', '2468');
  await page.click('#dlg-code button[type=submit]');
  await page.waitForFunction(() => /Code défini/.test(document.querySelector('#message').textContent), null, { timeout: 8000 }).catch(() => {});
  v('le code est défini', (await page.textContent('#message')).includes('Code défini'), await page.textContent('#message'));
  const stocke = await page.evaluate(() => localStorage.getItem('terrarium.config.v1'));
  v('la configuration stockée est chiffrée (ni code d\'appairage ni adresse en clair)', stocke.includes('"chiffre":true') && !stocke.includes(JETON) && !stocke.includes('localhost'));
  await page.reload();
  await page.waitForTimeout(800);
  v('au relancement, l\'écran de code s\'affiche et rien d\'autre', await page.isVisible('#vue-verrou') && !(await page.isVisible('#vue-liste')));
  await page.fill('#code-verrou', '0000');
  await page.click('#vue-verrou button[type=submit]');
  await page.waitForFunction(() => /incorrect/.test(document.querySelector('#verrou-erreur').textContent), null, { timeout: 8000 }).catch(() => {});
  v('un mauvais code est refusé', (await page.textContent('#verrou-erreur')).includes('incorrect'));
  await page.fill('#code-verrou', '2468');
  await page.click('#vue-verrou button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#vue-liste').style.display === 'block', null, { timeout: 8000 }).catch(() => {});
  v('le bon code déverrouille et reconnecte', await page.isVisible('#vue-liste'));
  await page.waitForFunction(() => /Banc réel/.test(document.querySelector('#socles').innerHTML), null, { timeout: 8000 }).catch(() => {});
  v('les socles sont de retour, déchiffrés', (await page.innerHTML('#socles')).includes('Banc réel'));
  await page.click('#btn-verrouiller');
  await page.waitForTimeout(300);
  v('« Verrouiller » cache tout immédiatement', await page.isVisible('#vue-verrou'));
  await page.fill('#code-verrou', '2468');
  await page.click('#vue-verrou button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#vue-liste').style.display === 'block', null, { timeout: 8000 }).catch(() => {});
  await page.click('#btn-retirer-code');
  await page.waitForTimeout(300);
  await page.click('#dlg-confirm [data-dlg="oui"]');
  await page.waitForTimeout(400);
  const enClair = await page.evaluate(() => localStorage.getItem('terrarium.config.v1'));
  v('« Retirer le code » remet la configuration en clair', !enClair.includes('"chiffre":true') && enClair.includes(JETON));

  console.log('\n== Agent de service');
  await page.waitForTimeout(1000);
  const sw = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    const cles = await caches.keys();
    const c = cles.length ? await caches.open(cles[0]) : null;
    const entrees = c ? (await c.keys()).map(k => new URL(k.url).pathname) : [];
    return { actif: !!(r && (r.active || r.installing || r.waiting)), cache: cles, entrees };
  });
  v('agent de service enregistré', sw.actif, sw.cache.join(','));
  v('coque mise en cache (mqtt.js, aide, icônes)', sw.entrees.includes('/mqtt.js') && sw.entrees.includes('/aide.html') && sw.entrees.includes('/icones/icone-192.png'), sw.entrees.length + ' entrées');
  v('aucune erreur ni avertissement console (CSP comprise)', erreurs.length === 0, erreurs.join(' | '));

  await navigateur.close();
  serveur.close();
  console.log(`\n=== ${ko ? 'ECHECS EN NAVIGATEUR' : 'NAVIGATEUR OK'} (${ok} reussite(s), ${ko} echec(s)) ===`);
  process.exit(ko ? 1 : 0);
})().catch(e => { console.error(e); serveur.close(); process.exit(1); });
