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

/* global document, navigator, caches, window, localStorage, indexedDB, App, ServiceWorkerRegistration, Notification */
const { servirApp } = require('./servir-app');
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

let ok = 0, ko = 0;
const v = (q, c, d = '') => { console.log(`   ${c ? '[ OK ]' : '[ECHEC]'} ${q.padEnd(54)} ${String(d).slice(0, 60)}`); c ? ok++ : ko++; };

// version.json est produit à la publication : ici, une valeur de test.
const serveur = servirApp({ port: PORT, versionTest: { version: 'test', commit: 'banc', date: '' } });

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
    // Firefox ne connaît pas les Trusted Types et le dit en avertissement CSP :
    // c'est la directive qui est ignorée, pas la politique.
    if (MOTEUR !== 'chromium' && /Content.Security.Policy/i.test(m.text()) && /trusted.types|unknown directive|directive inconnue|ignor/i.test(m.text())) return;
    if (m.type() === 'error' || m.type() === 'warning') erreurs.push(m.type() + ': ' + m.text());
  });
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForTimeout(600);

  console.log('\n== Connexion');
  v('premier lancement : l\'accueil s\'affiche', await page.isVisible('#bienvenue') && !(await page.isVisible('#form-broker')));
  await page.click('[data-action="accueil"][data-etape="connexion"]');
  v('« Se connecter à mon serveur » ouvre le formulaire, le focus sur l\'adresse',
    await page.isVisible('#form-broker') && await page.evaluate(() => document.activeElement && document.activeElement.id === 'b-url'));
  await page.fill('#b-url', BROKER);
  await page.click('[data-action="testerBroker"]');
  await page.waitForFunction(() => /Connexion réussie|impossible/.test(document.querySelector('#message').textContent), null, { timeout: 12000 }).catch(() => {});
  v('« Tester la connexion » répond', (await page.textContent('#message')).includes('Connexion réussie'), await page.textContent('#message'));
  await page.click('#vue-broker button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#lien').textContent === 'connecté', null, { timeout: 8000 }).catch(() => {});
  v('connecté au broker via le client maison', (await page.textContent('#lien')) === 'connecté', await page.textContent('#lien'));

  console.log('\n== Installation du socle');
  await page.click('.titre-page [data-action="ajoutSocle"]');
  await page.waitForTimeout(300);
  if (await page.isVisible('[data-pas="scan"]')) await page.click('[data-pas="scan"] [data-action="instPas"]');
  v('l\'assistant s\'ouvre, étape 1 sur 3', await page.isVisible('#form-socle') && (await page.textContent('#inst-etape')) === 'Étape 1 sur 3');
  await page.fill('#a-id', ID);
  await page.fill('#a-jeton', JETON);
  await page.click('#form-socle button[type=submit]');
  await page.waitForSelector('#inst-wifi-suite', { state: 'visible', timeout: 15000 }).catch(() => {});
  v('étape 2 : le socle est vu en ligne, code vérifié', await page.isVisible('#inst-wifi-suite'),
    await page.evaluate(() => Array.from(document.querySelectorAll('#inst-suivi li')).map(l => l.className).join(' ')));
  await page.click('#inst-wifi-suite');
  await page.waitForSelector('#o-j0', { state: 'visible', timeout: 5000 }).catch(() => {});
  v('étape 3 : réglages de départ, consignes du socle', /^\d+,\d$/.test(await page.inputValue('#o-j0').catch(() => '')));
  await page.fill('#a-nom', 'Banc réel');
  await page.click('form[data-form="instReglages"] button[type=submit]');
  await page.waitForSelector('[data-pas="fin"]', { state: 'visible', timeout: 8000 }).catch(() => {});
  v('« C\'est prêt »', await page.isVisible('[data-pas="fin"]'), await page.textContent('#inst-resume'));
  await page.click('[data-action="instVoir"]');
  await page.waitForTimeout(300);
  await page.evaluate(() => App.montrer('liste'));
  await page.waitForFunction(() => /\d+,\d°/.test(document.querySelector('#socles').innerHTML), null, { timeout: 8000 }).catch(() => {});
  v('températures affichées', /\d+,\d°/.test(await page.innerHTML('#socles')));
  const police = await page.evaluate(() => document.fonts.check('200 60px Inter'));
  v('la police Inter est chargée', police);
  await page.click('#socles .socle');
  await page.waitForTimeout(600);
  v('accueil du socle ouvert', (await page.innerHTML('#detail')).includes('Banc réel') && await page.isVisible('#detail .ill'));
  await page.click('#detail .zone-accueil[data-z="0"]');
  await page.waitForTimeout(400);
  const cibleAvant = await page.textContent('#detail [data-r="zcible"]');
  await page.click('#detail [data-action="cible"][data-pas="0.5"]');
  await page.waitForTimeout(1800);
  v('un chevron envoie la nouvelle cible (commande signée, en QoS 1)', (await page.textContent('#message')).includes('enregistrés'), `${cibleAvant} → ${await page.textContent('#detail [data-r="zcible"]')}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  v('Échap revient à l\'accueil, le focus sur la zone', await page.evaluate(() => document.activeElement && document.activeElement.matches('.zone-accueil[data-z="0"]')));

  console.log('\n== Panneaux');
  await page.click('.rubrique[data-nom=courbes]');
  await page.waitForFunction(() => /point\(s\)/.test(document.querySelector('#legendeCourbe').textContent), null, { timeout: 8000 }).catch(() => {});
  v('courbes chargées', /point\(s\)/.test(await page.textContent('#legendeCourbe')));
  const [telechargement] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }).catch(() => null),
    page.click('[data-action="exporterCsv"]')
  ]);
  v('export CSV téléchargé', !!telechargement && /\.csv$/.test(telechargement.suggestedFilename()), telechargement ? telechargement.suggestedFilename() : 'aucun');
  await page.click('[data-action="panneau"][data-nom="etat"]');
  await page.click('.rubrique[data-nom=general]');
  await page.waitForFunction(() => !!document.querySelector('#gSD') && document.querySelector('#detail').textContent.includes('Sur 24 heures'), null, { timeout: 8000 }).catch(() => {});
  v('feuille Appareil chargée, santé affichée', !!(await page.$('#gSD')) && (await page.innerHTML('#detail')).includes('Santé'));
  // Le nom d'hôte (terraSIM001.local) poussait sa tuile hors de l'écran des
  // téléphones étroits : chaque tuile doit tenir dans sa case et la page dans l'écran.
  for (const largeur of [320, 360, 390]) {
    await page.setViewportSize({ width: largeur, height: 800 });
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => {
      const tuiles = [...document.querySelectorAll('#detail .stat > div')];
      const fautive = tuiles.find(d => d.scrollWidth > d.clientWidth + 1 || d.getBoundingClientRect().right > window.innerWidth + 1);
      const page = document.documentElement.scrollWidth > window.innerWidth + 1;
      // Ce qui dépasse, au plus profond : de quoi corriger sans deviner.
      const depasse = el => el.getBoundingClientRect().right > window.innerWidth + 1;
      const nom = el => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`;
      const coupables = page ? [...document.body.querySelectorAll('*')].filter(el => depasse(el) && ![...el.children].some(depasse))
        .slice(0, 4).map(el => `${nom(el)} (${Math.round(el.getBoundingClientRect().right)} px) « ${el.textContent.trim().slice(0, 30)} »`) : [];
      // Rien ne dépasse par sa boîte : le débordement vient d'un texte ou d'un
      // pseudo-élément. Le conteneur le plus profond dont la largeur défilable
      // dépasse l'écran le situe, et son style dit pourquoi.
      if (page && !coupables.length) {
        // WebKit compte la marge intérieure de fin de <main> dans la largeur
        // défilable : un élément qui empiète sur elle suffit, même s'il reste
        // dans l'écran. On cherche donc ce qui dépasse la boîte de contenu.
        const main = document.querySelector('main');
        const limite = main.getBoundingClientRect().right - parseFloat(window.getComputedStyle(main).paddingRight) + 0.5;
        const empiete = el => el.getBoundingClientRect().right > limite;
        const fautifs = [...main.querySelectorAll('*')].filter(el => empiete(el) && ![...el.children].some(empiete));
        for (const el of fautifs.slice(0, 3)) {
          const st = window.getComputedStyle(el);
          coupables.push(`${nom(el)} ${Math.round(el.getBoundingClientRect().width)} px, fin à ${Math.round(el.getBoundingClientRect().right)} px pour ${Math.round(limite)} (display ${st.display}, white-space ${st.whiteSpace}, min-width ${st.minWidth}) « ${el.textContent.trim().replace(/\s+/g, ' ').slice(0, 40)} »`);
        }
        if (!fautifs.length) coupables.push('aucun élément de <main> ne dépasse sa boîte de contenu');
      }
      return { n: tuiles.length, fautive: fautive ? fautive.textContent.trim().slice(0, 40) : '', page, coupables, largeur: document.documentElement.scrollWidth };
    });
    v(`à ${largeur} px, aucune tuile ne déborde`, r.n > 0 && !r.fautive && !r.page,
      r.fautive || (r.page ? `la page fait ${r.largeur} px (détail ci-dessous)` : `${r.n} tuiles`));
    if (r.page) r.coupables.forEach(c => console.log(`          → ${c}`));
  }
  await page.setViewportSize({ width: 390, height: 844 });

  console.log('\n== Service (module importé à la demande)');
  await page.click('[data-action="panneau"][data-nom="etat"]');
  await page.click('.rubrique[data-nom=service]');
  await page.waitForFunction(() => document.querySelector('#detail').textContent.includes('28FF0000000000A1'), null, { timeout: 8000 }).catch(() => {});
  v('le module Service s\'importe et liste les sondes', (await page.innerHTML('#detail')).includes('28FF0000000000A1'));
  await page.click('[data-action="panneau"][data-nom="etat"]');
  for (const largeur of [320, 390]) {
    await page.setViewportSize({ width: largeur, height: 800 });
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => {
      const el = [...document.querySelectorAll('#detail .rubrique, #detail .rond-lib, #detail .zone-accueil')];
      return { n: el.length, deborde: el.some(x => x.getBoundingClientRect().right > window.innerWidth + 1) || document.documentElement.scrollWidth > window.innerWidth + 1 };
    });
    v(`à ${largeur} px, l'accueil tient dans l'écran`, r.n >= 14 && !r.deborde, `${r.n} éléments`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('.rubrique[data-nom=general]');
  await page.waitForTimeout(300);

  console.log('\n== Dialogues');
  await page.click('[data-action="redemarrer"]');
  await page.waitForTimeout(300);
  v('la confirmation est un dialogue de la page, pas du navigateur', await page.isVisible('#dlg-confirm'));
  await page.click('#dlg-confirm [data-dlg="non"]');
  await page.waitForTimeout(300);
  v('« Annuler » referme le dialogue sans agir', !(await page.isVisible('#dlg-confirm')) && !(await page.textContent('#message')).includes('acceptée'));
  await page.click('[data-action="diagnostic"]').catch(() => {});
  // Le bouton Diagnostic est au pied de la liste : on y revient (d'une
  // feuille, d'abord l'accueil du socle, puis la liste).
  await page.click('[data-action="panneau"][data-nom="etat"]');
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
  await page.click('.rubrique[data-nom=general]');
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
  // Avant les essais qui suivent : le rechargement de « Tout effacer » coupe la
  // liaison WebSocket, ce que Firefox journalise comme une erreur.
  v('aucune erreur ni avertissement console (CSP comprise)', erreurs.length === 0, erreurs.join(' | '));

  if (MOTEUR === 'chromium') {
    // Chrome sur Android refuse « new Notification() » : une alerte doit passer
    // par l'agent de service, sinon elle n'apparaît jamais sur le téléphone.
    console.log('\n== Notifications par l\'agent de service');
    await ctx.grantPermissions(['notifications'], { origin: `http://localhost:${PORT}` });
    const espion = require('mqtt').connect(BROKER, { clientId: 'nav-espion-' + Date.now() });
    await new Promise((ok, ko) => { espion.once('connect', ok); espion.once('error', ko); });
    const zone2 = tropChaud => espion.publish(`terrarium/${ID}/zone2/etat`, JSON.stringify({
      temp: 31, consigne: 26, chauffe: '0', defaut: '0', defaut_libelle: 'OK', derive: '0', trop_chaud: tropChaud, jour: 26, nuit: 22 }));
    // Le Chromium sans interface de la CI refuse les notifications malgré
    // grantPermissions (permission « denied ») et n'en affiche aucune : la
    // permission y est alors simulée, et ce sont les appels eux-mêmes qui
    // sont notés. C'est le chemin pris par l'application qui est vérifié ici.
    await page.evaluate(() => {
      if (Notification.permission !== 'granted') Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
      const proto = ServiceWorkerRegistration.prototype, montrer = proto.showNotification;
      window.__notifsAgent = [];
      proto.showNotification = function (titre, options) { window.__notifsAgent.push(titre); return montrer.call(this, titre, options); };
    });
    zone2('1');
    await page.waitForTimeout(1500);
    const titres = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      const affichees = reg ? (await reg.getNotifications()).map(n => n.title) : [];
      return [...new Set([...window.__notifsAgent, ...affichees])];
    });
    v('« trop chaud » passe par l\'agent de service (showNotification)', titres.some(t => /trop chaud/.test(t)), titres.join(' | ') || 'aucune');
    zone2('0');
    espion.end(true);
  }

  console.log('\n== « Tout effacer » efface aussi l\'historique local');
  const compterPoints = async () => {
    const bases = indexedDB.databases ? await indexedDB.databases() : [{ name: 'terrariums' }];
    if (!bases.some(b => b.name === 'terrariums')) return 0;
    return new Promise(res => {
      const r = indexedDB.open('terrariums');
      r.onsuccess = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('points')) { db.close(); res(0); return; }
        const c = db.transaction('points').objectStore('points').count();
        c.onsuccess = () => { db.close(); res(c.result); };
        c.onerror = () => { db.close(); res(-1); };
      };
      r.onerror = () => res(-1);
    });
  };
  const avant = await page.evaluate(compterPoints);
  v('l\'application a noté des points dans IndexedDB', avant > 0, `${avant} point(s)`);
  await page.evaluate(() => { App.effacerTout(); });
  await page.waitForSelector('#dlg-confirm [data-dlg="oui"]', { state: 'visible', timeout: 3000 }).catch(() => {});
  await Promise.all([page.waitForEvent('load', { timeout: 8000 }).catch(() => {}), page.click('#dlg-confirm [data-dlg="oui"]')]);
  await page.waitForTimeout(800);
  const apres = await page.evaluate(compterPoints);
  v('après « Tout effacer », plus aucun point local', apres === 0, `${apres} point(s)`);
  v('…et l\'application repart de l\'écran du broker', await page.isVisible('#vue-broker'));

  // L'anglais n'est plus dans app.js (C2) : il arrive par import(), ce que la
  // CSP (script-src 'self') et les Trusted Types doivent laisser passer.
  console.log('\n== Anglais chargé à la demande');
  await page.evaluate(() => localStorage.setItem('terrarium.langue', 'en'));
  await page.reload();
  await page.waitForFunction(() => document.documentElement.lang === 'en' && /Connection/.test(document.querySelector('#vue-broker').textContent), null, { timeout: 8000 }).catch(() => {});
  const lien = await page.textContent('#lien');
  v('l\'anglais arrive à la demande (page et textes de l\'application)', /Connection/.test(await page.textContent('#vue-broker')) && /not connected/i.test(lien), lien);
  await page.evaluate(() => localStorage.setItem('terrarium.langue', 'fr'));


  await navigateur.close();
  serveur.close();
  console.log(`\n=== ${ko ? 'ECHECS EN NAVIGATEUR' : 'NAVIGATEUR OK'} (${ok} reussite(s), ${ko} echec(s)) ===`);
  process.exit(ko ? 1 : 0);
})().catch(e => { console.error(e); serveur.close(); process.exit(1); });
