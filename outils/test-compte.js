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

/* global document, localStorage, App */
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
  const codes = () => boite.filter(x => x.a === EMAIL && /code de connexion/.test(x.sujet));
  const dernierCode = () => { const m = codes().pop(); return m ? /(\d{6})/.exec(m.sujet)[1] : ''; };
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
    titre('« Se connecter » : droit au compte, e-mail et code');
    await page.goto(base + '/');
    await page.waitForTimeout(400);           // le serveur qui sert l'application est reconnu
    await page.click('[data-action="accueil"][data-etape="connexion"]');
    await page.waitForSelector('#form-compte:not([hidden])', { timeout: 5000 }).catch(() => {});
    v('servie par le serveur, l\'application mène droit à la connexion par e-mail, sans adresse à taper', await visible('#form-compte') && !(await visible('#form-broker')));
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

    titre('Carnet par e-mail, depuis les exports');
    s.comptes.attribuerSocle(EMAIL, 'terraCAR001');
    await page.click('#vue-liste [data-action="reglagesApp"]');
    await page.click('#reglages [data-action="reglagesApp"][data-page="exports"]');
    await page.waitForSelector('#ex-mail:not([disabled])', { timeout: 5000 }).catch(() => {});
    v('l\'interrupteur paraît : serveur avec e-mail, compte avec un socle', await visible('#ex-mail') && !(await page.isChecked('#ex-mail')));
    await page.click('label[for="ex-mail"]');
    // Le message passe (il s'efface au bout de quelques secondes) : on le guette
    // au moment où il paraît, au lieu de le relire plus tard.
    const vuEnvoye = await page.waitForFunction(e => document.querySelector('#message').textContent.includes(`envoyé à ${e}`), EMAIL, { timeout: 8000 }).then(() => true, () => false);
    const carnet = boite.filter(x => x.a === EMAIL && /^Carnet /.test(x.sujet)).pop();
    v('activé : le carnet du mois écoulé part tout de suite', !!carnet && s.comptes.utilisateur(EMAIL).carnet.actif === true, carnet ? carnet.sujet : 'aucun');
    v('…le message et la ligne le disent', vuEnvoye && await page.waitForFunction(() => /Prochain carnet : le 1er /.test(document.querySelector('#reglages [data-r="mail-etat"]').textContent), null, { timeout: 3000 }).then(() => true, () => false),
      await page.textContent('#reglages [data-r="mail-etat"]'));
    // L'interrupteur se réactive au rendu qui suit la réponse : on l'attend avant de recliquer.
    await page.waitForSelector('#ex-mail:not([disabled])', { timeout: 5000 }).catch(() => {});
    await page.click('label[for="ex-mail"]');
    await page.waitForFunction(() => /arrêté/.test(document.querySelector('#message').textContent), null, { timeout: 5000 }).catch(() => {});
    let coupe = false;
    for (const fin = Date.now() + 5000; Date.now() < fin && !coupe;) { coupe = s.comptes.utilisateur(EMAIL).carnet.actif === false; if (!coupe) await new Promise(r => setTimeout(r, 50)); }
    v('désactivé : le serveur n\'enverra plus rien', coupe && !(await page.isChecked('#ex-mail')));
    await page.click('#vue-reglages [data-action="remonter"]');
    await page.click('#vue-reglages [data-action="remonter"]');
    await page.waitForSelector('#vue-liste', { state: 'visible', timeout: 5000 }).catch(() => {});

    titre('Partager un socle (F12) : lien d\'invitation, droits, retrait');
    {
      const INVITE = 'lea@exemple.fr';
      s.comptes.attribuerSocle(EMAIL, 'terraPAR001');
      await page.evaluate(() => {
        const c = JSON.parse(localStorage.getItem('terrarium.config.v1'));
        c.socles.push({ id: 'terraPAR001', jeton: 'PARTAGEJETON000000000001', nom: 'Terrarium du salon' });
        localStorage.setItem('terrarium.config.v1', JSON.stringify(c));
      });
      await page.reload();
      await connecte();
      await page.waitForFunction(() => (JSON.parse(localStorage.getItem('terrarium.config.v1')).serveur.socles || []).includes('terraPAR001'), null, { timeout: 8000 }).catch(() => {});
      await page.click('#vue-liste [data-action="reglagesApp"]');
      await page.waitForSelector('#ligne-partage:not([hidden])', { timeout: 5000 }).catch(() => {});
      v('« Partager un socle » paraît avec un compte sur le serveur', await visible('#ligne-partage'));
      await page.click('#ligne-partage');
      await page.waitForFunction(() => /Titulaire/.test((document.querySelector('#reglages [data-r="pa-liste"]') || {}).textContent || ''), null, { timeout: 8000 }).catch(() => {});
      v('qui y a accès : toi, titulaire', /Toi\s*Titulaire/.test(await page.textContent('#reglages [data-r="pa-liste"]')), (await page.textContent('#reglages [data-r="pa-liste"]')).replace(/\s+/g, ' ').slice(0, 50));
      await page.check('input[name="pa-droit"][value="reglage"]');
      await page.click('[data-action="paDuree"][data-j="7"]');
      await page.click('[data-action="paCreer"]');
      await page.waitForSelector('.lien-invitation', { timeout: 8000 }).catch(() => {});
      const lien = await page.inputValue('.lien-invitation').catch(() => '');
      v('lien d\'invitation : à usage unique, le code du socle seulement après #', /#i\/[A-Za-z0-9_-]{24}\/PARTAGEJETON000000000001$/.test(lien), lien.replace(/.*#/, '#').slice(0, 40));
      v('…et l\'avertissement qui va avec', /code du socle/.test(await page.textContent('#reglages [data-r="pa-lien"]')));
      // L'invitée : un autre téléphone, sans compte, ouvre le lien.
      const ctx2 = await navigateur.newContext({ viewport: { width: 390, height: 844 }, locale: 'fr-FR' });
      const p2 = await ctx2.newPage();
      p2.on('pageerror', e => erreurs.push('invitée : ' + e.message));
      await p2.goto(lien);
      await p2.waitForTimeout(800);
      v('l\'adresse oublie aussitôt le lien (code compris)', !p2.url().includes('#i/'), p2.url());
      v('l\'accueil annonce l\'invitation', /Invitation reçue/.test(await p2.textContent('#bienvenue-etiquette').catch(() => '')));
      await p2.click('[data-action="accueil"][data-etape="connexion"]');
      await p2.waitForSelector('#form-compte:not([hidden])', { timeout: 5000 }).catch(() => {});
      await p2.fill('#c-email', INVITE);
      await p2.click('[data-etape-compte="email"] [type="submit"]');
      const codeInvite = () => { const m = boite.filter(x => x.a === INVITE && /code de connexion/.test(x.sujet)).pop(); return m ? /(\d{6})/.exec(m.sujet)[1] : ''; };
      await p2.waitForSelector('[data-etape-compte="code"]:not([hidden])', { timeout: 5000 }).catch(() => {});
      await p2.fill('#c-code', codeInvite());
      await p2.click('[data-etape-compte="code"] [type="submit"]');
      await p2.waitForFunction(() => /Partagé avec toi/.test((document.querySelector('#detail .separe') || {}).textContent || ''), null, { timeout: 12000 }).catch(() => {});
      v('compte créé : l\'invitation est acceptée, le socle s\'ouvre', /Partagé avec toi/.test(await p2.textContent('#detail .separe').catch(() => '')));
      const c2 = await p2.evaluate(() => JSON.parse(localStorage.getItem('terrarium.config.v1')));
      const sp = (c2.socles || []).find(x => x.id === 'terraPAR001') || {};
      v('…avec le code (il peut régler) et la fin de l\'accès', sp.jeton === 'PARTAGEJETON000000000001' && sp.partage && sp.partage.droit === 'reglage' && sp.partage.jusqua > Date.now(), JSON.stringify(sp.partage || {}));
      v('le serveur le sait', (s.comptes.utilisateur(INVITE) || {}).socles.includes('terraPAR001'));
      // Le titulaire voit l'invitée, puis la retire.
      await page.evaluate(() => App.reglagesApp('menu'));
      await page.evaluate(() => App.reglagesApp('partage'));
      await page.waitForFunction(e => (document.querySelector('#reglages [data-r="pa-liste"]') || {}).textContent.includes(e), INVITE, { timeout: 8000 }).catch(() => {});
      v('le titulaire voit l\'invitée et ses droits', /lea@exemple\.fr\s*Peut régler · jusqu'au/.test(await page.textContent('#reglages [data-r="pa-liste"]')));
      await page.click(`[data-action="paRetirer"][data-login="${INVITE}"]`);
      await page.waitForSelector('#dlg-confirm[open]', { timeout: 3000 }).catch(() => {});
      await page.click('#dlg-confirm [data-dlg="oui"]');
      await page.waitForFunction(() => /Accès retiré/.test(document.querySelector('#message').textContent), null, { timeout: 8000 }).catch(() => {});
      v('« Retirer » : l\'invitée perd le socle sur le serveur', !(s.comptes.utilisateur(INVITE).socles || []).includes('terraPAR001'));
      // Une invitation en lecture seule : sur le même téléphone, déjà connecté.
      await page.check('input[name="pa-droit"][value="lecture"]');
      await page.click('[data-action="paCreer"]');
      await page.waitForSelector('.lien-invitation', { timeout: 8000 }).catch(() => {});
      const lienLecture = await page.inputValue('.lien-invitation').catch(() => '');
      v('lien en lecture seule : sans le code du socle', /#i\/[A-Za-z0-9_-]{24}$/.test(lienLecture), lienLecture.replace(/.*#/, '#'));
      await p2.goto(lienLecture);
      await p2.reload();
      await p2.waitForFunction(() => /Lecture seule/.test((document.querySelector('#detail .separe') || {}).textContent || ''), null, { timeout: 12000 }).catch(() => {});
      v('invitée en lecture seule : le badge le dit', /Lecture seule/.test(await p2.textContent('#detail .separe').catch(() => '')));
      v('…et les réglages sont grisés', (await p2.getAttribute('#detail .rubrique[data-nom="reglages"]', 'aria-disabled').catch(() => '')) === 'true'
        && /Lecture seule/.test(await p2.textContent('#detail .rubrique[data-nom="reglages"]').catch(() => '')));
      await ctx2.close();
      await page.click('#vue-reglages [data-action="remonter"]');
      await page.click('#vue-reglages [data-action="remonter"]').catch(() => {});
      await page.waitForSelector('#vue-liste', { state: 'visible', timeout: 5000 }).catch(() => {});
    }

    titre('Mon compte : clés, export');
    await page.click('#vue-liste [data-action="reglagesApp"]');
    v('les réglages ouvrent sur la carte du compte, sans section technique de connexion', await visible('#btn-mon-compte')
      && (await page.textContent('#btn-mon-compte')).includes(EMAIL) && !(await page.$('#broker-hote')));
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
    await page.waitForSelector('#btn-cle-acces:not([hidden])', { timeout: 5000 }).catch(() => {});
    await page.click('#btn-cle-acces');
    v('connecté par la clé d\'accès, sans code', await connecte() && await visible('#vue-liste'), (await page.textContent('#compte-erreur').catch(() => '')).slice(0, 60));
    v('aucun nouveau code envoyé', codes().length === 1);

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
