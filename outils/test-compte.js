#!/usr/bin/env node
/* =============================================================================
   Compte en libre-service, de bout en bout, dans un vrai Chromium.
   -----------------------------------------------------------------------------
   Le serveur Terrariums sert l'application (comme SERVIR_APP=1) et garde les
   e-mails en mémoire au lieu de les envoyer. Chromium reçoit un
   authentificateur virtuel (WebAuthn par CDP) : la clé d'accès est réellement
   créée puis utilisée, signée par le navigateur et vérifiée par le serveur.
   Parcours : adresse du serveur → e-mail → code → connecté ; clé d'accès
   proposée puis créée ; « Mon compte » ; export ; déconnexion ; connexion par
   la clé ; session expirée ; suppression du compte.

     npm install --no-save playwright && npx playwright install chromium
     node test-compte.js
   ============================================================================= */

/* global document, localStorage */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { demarrerServeur } = require('../serveur/serveur');
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { console.error('Playwright est nécessaire : npm install --no-save playwright && npx playwright install chromium'); process.exit(2); }

let reussites = 0, echecs = 0;
const v = (q, c, d = '') => { console.log(`   ${c ? '[ OK ]' : '[ECHEC]'} ${q.padEnd(60)} ${String(d).slice(0, 70)}`); c ? reussites++ : echecs++; };
const titre = t => console.log(`\n== ${t}`);
const EMAIL = 'noe@exemple.fr';

(async () => {
  const donnees = fs.mkdtempSync(path.join(os.tmpdir(), 'terrarium-compte-'));
  const boite = [];
  const s = await demarrerServeur({ port: 0, portMqtt: 0, donnees, adminJeton: 'admin-test', journal: () => {}, pushActif: false,
    app: path.resolve(__dirname, '..', 'app'), courriel: { envoyer: async m => { boite.push(m); } } });
  const base = `http://localhost:${s.port}`;
  const dernierCode = () => { const m = boite.filter(x => x.a === EMAIL).pop(); return m ? /(\d{6})/.exec(m.sujet)[1] : ''; };
  const navigateur = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const ctx = await navigateur.newContext({ viewport: { width: 390, height: 844 }, locale: 'fr-FR', acceptDownloads: true });
  const page = await ctx.newPage();
  const erreurs = [];
  page.on('pageerror', e => erreurs.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_FAILED|Failed to load resource/.test(m.text())) erreurs.push(m.text()); });
  // L'authentificateur de la plateforme, simulé : clé résidente, vérification
  // de l'utilisateur acquise, présence simulée (pas de boîte de dialogue).
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const visible = sel => page.isVisible(sel);
  const config = () => page.evaluate(() => JSON.parse(localStorage.getItem('terrarium.config.v1') || '{}'));
  const connecte = () => page.waitForFunction(() => document.querySelector('#lien') && document.querySelector('#lien').textContent === 'connecté', null, { timeout: 10000 }).then(() => true, () => false);

  try {
    titre('Adresse du serveur, puis e-mail et code');
    await page.goto(base + '/');
    await page.click('[data-action="accueil"][data-etape="connexion"]');
    await page.fill('#b-url', base);
    await page.click('#form-broker [type="submit"]');
    await page.waitForSelector('#form-compte:not([hidden])', { timeout: 5000 }).catch(() => {});
    v('une adresse https (ici http local) de serveur mène à la connexion par e-mail', await visible('#form-compte') && !(await visible('#form-broker')));
    v('le serveur est nommé, la clé d\'accès proposée (navigateur compatible)', (await page.textContent('#compte-serveur')).includes(`localhost:${s.port}`) && await visible('#btn-cle-acces'));
    await page.fill('#c-email', 'pas-une-adresse');
    await page.click('[data-etape-compte="email"] [type="submit"]');
    v('adresse invalide signalée', /invalide/.test(await page.textContent('#compte-erreur')));
    await page.fill('#c-email', EMAIL);
    await page.click('[data-etape-compte="email"] [type="submit"]');
    await page.waitForSelector('[data-etape-compte="code"]:not([hidden])', { timeout: 5000 }).catch(() => {});
    v('le code part par e-mail, l\'écran le dit', !!dernierCode() && (await page.textContent('#compte-code-aide')).includes(EMAIL), dernierCode());
    await page.fill('#c-code', '000000' === dernierCode() ? '111111' : '000000');
    await page.click('[data-etape-compte="code"] [type="submit"]');
    await page.waitForFunction(() => /incorrect/.test(document.querySelector('#compte-erreur').textContent), null, { timeout: 5000 }).catch(() => {});
    v('un mauvais code est refusé', /incorrect/.test(await page.textContent('#compte-erreur')));
    await page.fill('#c-code', dernierCode().slice(0, 3) + ' ' + dernierCode().slice(3));
    await page.click('[data-etape-compte="code"] [type="submit"]');
    v('le bon code connecte : liste des socles, broker joint', await connecte() && await visible('#vue-liste'));
    const c1 = await config();
    v('le broker reçoit l\'e-mail et le jeton de session, pas de mot de passe', c1.broker && c1.broker.user === EMAIL && c1.broker.compte === 'email' && c1.broker.pass === c1.serveur.jeton);
    v('la liste nomme le compte, sous « Réglages de l\'application »', (await page.textContent('#reglages-resume')).includes(EMAIL));

    titre('Clé d\'accès créée depuis la proposition');
    await page.waitForSelector('#message.visible button', { timeout: 5000 }).catch(() => {});
    v('une clé d\'accès est proposée après le premier code', /clé d'accès/.test(await page.textContent('#message')));
    await page.click('#message button');
    await page.waitForFunction(() => /créée/.test(document.querySelector('#message').textContent), null, { timeout: 8000 }).catch(() => {});
    const creds = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;
    v('clé créée par l\'authentificateur, liée à ce domaine', creds.length === 1 && creds[0].rpId === 'localhost' && creds[0].isResidentCredential, `${creds.length} clé(s)`);
    v('…et enregistrée par le serveur', (s.comptes.utilisateur(EMAIL).cles || []).length === 1);

    titre('Mon compte : clés, export');
    await page.click('#vue-liste [data-action="reglagesApp"]');
    v('les réglages ouvrent sur la carte du compte', await visible('#btn-mon-compte') && (await page.textContent('#btn-mon-compte')).includes(EMAIL)
      && (await page.textContent('#broker-hote')).includes(EMAIL));
    await page.click('#btn-mon-compte');
    await page.waitForSelector('#dlg-compte[open]', { timeout: 5000 }).catch(() => {});
    v('« Mon compte » liste la clé avec son appareil', (await page.textContent('#dlg-compte')).includes('Clé d\'accès — Linux'));
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }).catch(() => null), page.click('[data-compte="exporter"]')]);
    let export_ = null;
    if (dl) { try { export_ = JSON.parse(fs.readFileSync(await dl.path(), 'utf8')); } catch (e) { export_ = null; } }
    v('export téléchargé : le compte, sans secret', !!export_ && export_.compte.email === EMAIL && !JSON.stringify(export_).includes(c1.serveur.jeton), dl ? dl.suggestedFilename() : 'aucun');

    titre('Déconnexion, puis connexion par la clé d\'accès');
    await page.click('[data-compte="deconnexion"]');
    await page.waitForSelector('#vue-broker', { state: 'visible', timeout: 5000 }).catch(() => {});
    v('déconnecté : retour à l\'accueil, plus de broker', await visible('#bienvenue') && !(await config()).broker);
    v('la session est fermée sur le serveur', (await fetch(base + '/api/moi', { headers: { Authorization: 'Bearer ' + c1.serveur.jeton } })).status === 401);
    await page.click('[data-action="accueil"][data-etape="connexion"]');
    await page.fill('#b-url', base);
    await page.click('#form-broker [type="submit"]');
    await page.waitForSelector('#btn-cle-acces:not([hidden])', { timeout: 5000 }).catch(() => {});
    await page.click('#btn-cle-acces');
    v('connecté par la clé d\'accès, sans code', await connecte() && await visible('#vue-liste'), (await page.textContent('#compte-erreur').catch(() => '')).slice(0, 60));
    v('aucun nouveau code envoyé', boite.filter(x => x.a === EMAIL).length === 1);

    titre('Session expirée');
    s.comptes.donnees.sessions.clear();
    await page.reload();
    await page.waitForSelector('#form-compte:not([hidden])', { timeout: 8000 }).catch(() => {});
    v('session expirée : écran de connexion du serveur, adresse remplie', await visible('#form-compte') && (await page.inputValue('#c-email')) === EMAIL);
    v('…et le message le dit', /expiré/.test(await page.textContent('#message')));
    await page.click('#btn-cle-acces');
    v('reconnecté d\'un geste par la clé', await connecte());

    titre('Suppression du compte');
    await page.click('#vue-liste [data-action="reglagesApp"]');
    await page.click('#btn-mon-compte');
    await page.waitForSelector('#dlg-compte[open]', { timeout: 5000 }).catch(() => {});
    await page.fill('#compte-confirmation', 'autre@exemple.fr');
    await page.click('[data-compte="supprimer"]');
    v('confirmation différente : rien n\'est supprimé', !!s.comptes.utilisateur(EMAIL) && /Recopie/.test(await page.textContent('#message')));
    await page.fill('#compte-confirmation', EMAIL);
    await page.click('[data-compte="supprimer"]');
    await page.waitForFunction(() => /supprimé/.test(document.querySelector('#message').textContent), null, { timeout: 5000 }).catch(() => {});
    v('compte supprimé sur le serveur, application revenue à l\'accueil', !s.comptes.utilisateur(EMAIL) && await visible('#bienvenue'));
    v('aucune erreur dans la page', !erreurs.length, erreurs.slice(0, 2).join(' | '));
  } finally {
    await navigateur.close();
    await s.arreter();
    fs.rmSync(donnees, { recursive: true, force: true });
  }
  console.log(`\n=== ${echecs ? 'COMPTE : DES TESTS ONT ECHOUE' : 'COMPTE OK'} (${reussites} reussite(s), ${echecs} echec(s)) ===`);
  process.exit(echecs ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
