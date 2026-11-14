#!/usr/bin/env node
/* =============================================================================
   Console d'administration du serveur, de bout en bout, dans un vrai Chromium.
   -----------------------------------------------------------------------------
   Le serveur Terrariums tourne avec un socle factice (compte d'appareil, MQTT :
   statut, santé, deux zones dont une en défaut, quelques mesures), deux
   comptes, un rapport de diagnostic. La console est ouverte sous sa vraie
   politique de sécurité (aucune violation tolérée) : connexion par jeton,
   tableau de bord, socles (filtres, fiche, courbe, rattachement), données
   personnelles masquées puis montrées, comptes (création avec mot de passe
   tiré, droits, réinitialisation, export, effacement avec confirmation
   tapée), comptes d'appareil, rapports, journal (chaîne, filtre, export),
   déconnexion ; puis connexion par compte administrateur (mot de passe, code
   par e-mail) et refus d'un compte ordinaire. Enfin axe-core sur chaque écran
   et dialogue, en clair et en sombre, et la largeur d'un téléphone.

     npm install --no-save playwright axe-core && npx playwright install chromium
     node test-console.js
   ============================================================================= */

/* global document, window, sessionStorage, axe */
const fs = require('fs');
const os = require('os');
const path = require('path');
const mqtt = require('mqtt');
const { demarrerServeur } = require('../serveur/serveur');
let chromium, AXE = null;
try { ({ chromium } = require('playwright')); }
catch (e) { console.error('Playwright est nécessaire : npm install --no-save playwright && npx playwright install chromium'); process.exit(2); }
try { AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch (e) { /* axe absent : l'accessibilité est sautée, signalé plus bas */ }

let reussites = 0, echecs = 0;
const v = (q, c, d = '') => { console.log(`   ${c ? '[ OK ]' : '[ECHEC]'} ${q.padEnd(62)} ${String(d).slice(0, 70)}`); c ? reussites++ : echecs++; };
const titre = t => console.log(`\n== ${t}`);
const attendre = ms => new Promise(r => setTimeout(r, ms));
const JETON = 'admin-console-test';

(async () => {
  const donnees = fs.mkdtempSync(path.join(os.tmpdir(), 'terrarium-console-'));
  const boite = [];
  const s = await demarrerServeur({ port: 0, portMqtt: 0, donnees, adminJeton: JETON, journal: () => {}, pushActif: false,
    courriel: { envoyer: async m => { boite.push(m); } } });
  const base = `http://localhost:${s.port}`;
  const api = async (methode, chemin, corps, jeton = JETON) => {
    const r = await fetch(base + chemin, { method: methode, headers: { 'Content-Type': 'application/json', ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}) }, body: corps === undefined ? undefined : (typeof corps === 'string' ? corps : JSON.stringify(corps)) });
    return r.json().catch(() => null);
  };

  // --- le décor : un socle qui publie, des comptes, un rapport ---
  const app = await api('POST', '/api/admin/appareils', { id: 'terraA1B2C3' });
  await api('POST', '/api/admin/utilisateurs', { login: 'noe@exemple.fr', motDePasse: 'mot-de-passe-noe' });
  await api('POST', '/api/admin/utilisateurs', { login: 'chef', motDePasse: 'mot-de-passe-chef', admin: true });
  await api('POST', '/api/admin/socles/terraA1B2C3/proprietaires', { login: 'noe@exemple.fr' });
  s.comptes.obtenirParEmail('equipe@exemple.fr');
  s.comptes.definirAdmin('equipe@exemple.fr', true);
  // Deux heures d'historique, un point toutes les cinq minutes, écrites comme
  // le serveur les écrit (centièmes de degré) : la fiche doit tracer la courbe.
  const maintenant = Math.floor(Date.now() / 1000);
  fs.mkdirSync(path.join(s.historique.dossier, 'terraA1B2C3'), { recursive: true });
  for (let i = 24; i >= 1; i--) {
    const e = maintenant - i * 300;
    fs.appendFileSync(path.join(s.historique.dossier, 'terraA1B2C3', new Date(e * 1000).toISOString().slice(0, 10) + '.ndjson'),
      JSON.stringify([e, Math.round(3000 + 60 * Math.sin(i / 3)), 3100, Math.round(2500 + 40 * Math.cos(i / 3)), 2600]) + '\n');
  }
  const socle = mqtt.connect(`mqtt://127.0.0.1:${s.portMqtt}`, { username: 'terraA1B2C3', password: app.motDePasse, clientId: 'socle-console' });
  await new Promise((res, rej) => { socle.on('connect', res); socle.on('error', rej); });
  socle.publish('terrarium/terraA1B2C3/statut', 'en ligne', { retain: true });
  socle.publish('terrarium/terraA1B2C3/sante', JSON.stringify({ proto: 4, version: '3.5.0', uptime: 93784, rssi: -61, heap: 171000, heapMin: 142000,
    reset: 'mise sous tension', ip: '192.168.1.42', hote: 'terraA1B2C3.local', webProtege: true, signatureOta: false }), { retain: true });
  for (let i = 0; i < 6; i++) {
    socle.publish('terrarium/terraA1B2C3/zone1/etat', JSON.stringify({ temp: 30 + i / 10, consigne: 31, defaut: '0', defaut_libelle: 'OK', demande: 40, chauffe: '1' }));
    socle.publish('terrarium/terraA1B2C3/zone2/etat', JSON.stringify({ temp: 25 + i / 5, consigne: 26, defaut: i === 5 ? '1' : '0', defaut_libelle: i === 5 ? 'sonde absente' : 'OK', demande: 0, chauffe: '0' }));
    await attendre(80);
  }
  const sessionNoe = await api('POST', '/api/session', { login: 'noe@exemple.fr', motDePasse: 'mot-de-passe-noe' }, null);
  await api('POST', '/api/rapports', 'Rapport de diagnostic\nSocle terraA1B2C3 : sonde de la zone 2 absente\n', sessionNoe.jeton);

  const navigateur = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const ctx = await navigateur.newContext({ viewport: { width: 1280, height: 900 }, locale: 'fr-FR', acceptDownloads: true });
  await ctx.addInitScript(() => {
    window.__violations = [];
    document.addEventListener('securitypolicyviolation', e => window.__violations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const page = await ctx.newPage();
  const erreurs = [];
  page.on('pageerror', e => erreurs.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) erreurs.push(m.text()); });
  const visible = sel => page.isVisible(sel);
  const texte = sel => page.textContent(sel);
  const attendreTexte = (sel, re, delai = 5000) => page.waitForFunction(([x, src]) => { const el = document.querySelector(x); return el && new RegExp(src).test(el.textContent); }, [sel, re.source], { timeout: delai }).then(() => true, () => false);
  const confirmerDialogue = async (reference) => {
    await page.waitForSelector('#confirmer[open]', { timeout: 3000 });
    if (reference) await page.fill('#confirmer-saisie', reference);
    await page.click('#confirmer-ok');
    await page.waitForSelector('#confirmer:not([open])', { timeout: 3000 }).catch(() => {});
  };
  const lireSecret = async () => {
    await page.waitForSelector('#secret[open]', { timeout: 4000 });
    const t = await texte('#secret-valeur');
    await page.click('[data-action="fermer-secret"]');
    await page.waitForSelector('#secret:not([open])', { timeout: 3000 }).catch(() => {});
    return t;
  };

  try {
    titre('Connexion par jeton');
    await page.goto(base + '/console/');
    v('la page s\'ouvre sur la connexion, mode compte', await visible('#form-compte') && !(await visible('#espace')));
    v('la clé d\'accès est proposée (navigateur compatible)', await visible('#btn-cle'));
    await page.click('[data-mode="jeton"]');
    await page.fill('#c-jeton', 'pas-le-bon');
    await page.click('#form-jeton [type="submit"]');
    v('un jeton faux est refusé', await attendreTexte('#connexion-erreur', /Jeton refusé/));
    await page.fill('#c-jeton', JETON);
    await page.click('#form-jeton [type="submit"]');
    await page.waitForSelector('#espace:not([hidden])', { timeout: 5000 }).catch(() => {});
    v('le bon jeton ouvre la console', await visible('#espace') && !(await visible('#connexion')));
    v('l\'en-tête nomme l\'identité', (await texte('#etat-serveur')).includes('Jeton d\'administration'));
    const stockage = await page.evaluate(() => [sessionStorage.getItem('terrarium.console.session'), window.localStorage.length]);
    v('le jeton vit dans sessionStorage, rien dans localStorage', !!stockage[0] && stockage[0].includes(JETON) && stockage[1] === 0);

    titre('Tableau de bord');
    await attendreTexte('#tuiles', /socles en ligne/);
    const tuiles = await texte('#tuiles');
    v('socles en ligne : 1 / 1', /1 \/ 1\s*socles en ligne/.test(tuiles), tuiles.slice(0, 60));
    v('un socle en défaut, compté', /1\s*en défaut/.test(tuiles));
    v('« À regarder » cite le défaut de la zone 2', /terraA1B2C3.*sonde absente/.test(await texte('#a-regarder')));
    v('le serveur : version, clients MQTT, e-mail', /Version/.test(await texte('#infos-serveur')) && /Connexion par e-mail\s*active/.test(await texte('#infos-serveur')));
    v('le firmware de la flotte', /3\.5\.0\s*1 socle/.test(await texte('#versions')));
    await page.reload();
    await page.waitForSelector('#espace:not([hidden])', { timeout: 5000 }).catch(() => {});
    v('rechargée, la page garde la session (même onglet)', await visible('#espace'));

    titre('Socles');
    await page.click('[data-onglet="socles"]');
    await page.waitForSelector('#corps-socles tr', { timeout: 5000 }).catch(() => {});
    const ligne = await texte('#corps-socles');
    v('la ligne du socle : en ligne, défaut, firmware, signal', /terraA1B2C3/.test(ligne) && /en ligne/.test(ligne) && /défaut/.test(ligne) && /3\.5\.0 · p4/.test(ligne) && /-61 dBm/.test(ligne));
    v('les zones : température et consigne, défaut en clair', /30,5° \/ 31,0°/.test(ligne) && /sonde absente/.test(ligne), ligne.replace(/\s+/g, ' ').slice(0, 70));
    v('le propriétaire est masqué par défaut', ligne.includes('no…@exemple.fr') && !ligne.includes('noe@exemple.fr'));
    await page.click('#btn-donnees');
    v('« Afficher les données personnelles » : l\'adresse entière', (await texte('#corps-socles')).includes('noe@exemple.fr') && await page.getAttribute('#btn-donnees', 'aria-pressed') === 'true');
    await page.click('#btn-donnees');
    v('et masquées de nouveau', !(await texte('#corps-socles')).includes('noe@exemple.fr'));
    await page.click('[data-filtres="socles"] [data-filtre="orphelin"]');
    v('filtre « Sans propriétaire » : aucun, message', (await page.$$('#corps-socles tr')).length === 0 && await visible('#socles-vide'));
    await page.click('[data-filtres="socles"] [data-filtre="defaut"]');
    v('filtre « En défaut » : le socle', (await page.$$('#corps-socles tr')).length === 1);
    await page.click('[data-filtres="socles"] [data-filtre="tous"]');
    await page.fill('#f-socles', 'noe@');
    v('la recherche trouve aussi par propriétaire', (await page.$$('#corps-socles tr')).length === 1);
    await page.fill('#f-socles', 'zzz');
    v('et ne garde rien d\'étranger', (await page.$$('#corps-socles tr')).length === 0);
    await page.fill('#f-socles', '');

    titre('Fiche d\'un socle');
    await page.click('#corps-socles button[data-socle="terraA1B2C3"]');
    await page.waitForSelector('#fiche[open]', { timeout: 4000 }).catch(() => {});
    await attendreTexte('#fiche-corps', /Propriétaires/);
    const fiche = await texte('#fiche-corps');
    v('la fiche s\'ouvre : santé publiée', /3\.5\.0/.test(fiche) && /1 j 2 h/.test(fiche) && /192\.168\.1\.42/.test(fiche) && /protégée/.test(fiche), fiche.replace(/\s+/g, ' ').slice(0, 70));
    v('les zones, la seconde en défaut', /Zone 1.*30,5° pour 31,0°/.test(fiche) && /sonde absente/.test(fiche));
    v('la courbe des 24 heures est tracée', (await page.$$('#fiche-corps svg.courbe-24h polyline')).length === 2);
    v('le compte d\'appareil est décrit', /Créé le/.test(fiche));
    await page.click('#fiche-corps [data-action="detacher"]');
    await confirmerDialogue();
    await attendreTexte('#fiche-corps', /Aucun : le socle n'est rattaché/);
    v('« Détacher » après confirmation', s.comptes.utilisateur('noe@exemple.fr').socles.length === 0);
    await page.fill('#rattacher-login', 'noe@exemple.fr');
    await page.click('[data-form="rattacher"] [type="submit"]');
    await attendreTexte('#fiche-corps', /compte à mot de passe/);
    v('« Rattacher » à un compte', s.comptes.utilisateur('noe@exemple.fr').socles.includes('terraA1B2C3'));
    v('le journal du socle montre les deux gestes', /Socle détaché.*Socle rattaché|Socle rattaché[\s\S]*Socle détaché/.test(await texte('#fiche-corps')));
    await page.click('[data-action="fermer-fiche"]');
    v('la fiche se ferme', !(await page.isVisible('#fiche')));

    titre('Comptes');
    await page.click('[data-onglet="comptes"]');
    await page.waitForSelector('#corps-comptes tr', { timeout: 5000 }).catch(() => {});
    const comptes = await texte('#corps-comptes');
    v('les comptes, masqués, avec leur type', comptes.includes('no…@exemple.fr') && comptes.includes('ch…') && /mot de passe/.test(comptes) && /e-mail/.test(comptes));
    await page.click('[data-filtres="comptes"] [data-filtre="admins"]');
    v('filtre « Administrateurs » : chef et l\'équipe', (await page.$$('#corps-comptes tr')).length === 2);
    await page.click('[data-filtres="comptes"] [data-filtre="tous"]');
    await page.click('#v-comptes .barre [data-action="nouveau-compte"]');
    v('« Créer un compte » ouvre le formulaire', await visible('#form-nouveau-compte') && await page.getAttribute('#v-comptes .barre [data-action="nouveau-compte"]', 'aria-expanded') === 'true');
    await page.fill('#n-login', 'client@exemple.fr');
    await page.click('#form-nouveau-compte [type="submit"]');
    const mdp = await lireSecret();
    v('mot de passe tiré, montré une fois', /^[A-Za-z0-9]{16}$/.test(mdp.trim()), mdp.trim().length + ' caractères');
    v('puis effacé de la page', (await texte('#secret-valeur')) === '');
    await page.waitForFunction(() => document.querySelector('#corps-comptes').textContent.includes('cl…@exemple.fr'), null, { timeout: 4000 }).catch(() => {});
    v('le compte apparaît', (await texte('#corps-comptes')).includes('cl…@exemple.fr'));
    v('il se connecte avec ce mot de passe', !!(await api('POST', '/api/session', { login: 'client@exemple.fr', motDePasse: mdp.trim() }, null)).jeton);

    await page.click('#corps-comptes button[data-compte="client@exemple.fr"]');
    await page.waitForSelector('#fiche[open]', { timeout: 4000 }).catch(() => {});
    await attendreTexte('#fiche-corps', /Actions/);
    v('la fiche du compte : sessions, référence au journal', /sessions ouvertes/.test(await texte('#fiche-corps')) && /#[0-9a-f]{10}/.test(await texte('#fiche-corps')));
    await page.click('#fiche-corps [data-action="basculer-admin"]');
    await confirmerDialogue();
    await attendreTexte('#fiche-corps', /administrateur/);
    v('« Donner les droits d\'administration »', s.comptes.utilisateur('client@exemple.fr').admin === true);
    await page.click('#fiche-corps [data-action="reinitialiser"]');
    await confirmerDialogue();
    const mdp2 = await lireSecret();
    v('« Réinitialiser le mot de passe » : un nouveau, l\'ancien tombe', /^[A-Za-z0-9]{16}$/.test(mdp2.trim()) && mdp2.trim() !== mdp.trim()
      && !(await api('POST', '/api/session', { login: 'client@exemple.fr', motDePasse: mdp.trim() }, null)).jeton);
    const [telechargement] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }).catch(() => null), page.click('#fiche-corps [data-action="exporter-compte"]')]);
    let exportOk = false;
    if (telechargement) { try { const d = JSON.parse(fs.readFileSync(await telechargement.path(), 'utf8')); exportOk = d.compte.identifiant === 'client@exemple.fr' && Array.isArray(d.journal); } catch (e) { /* faux */ } }
    v('« Exporter ses données » : un fichier JSON', exportOk);
    await page.click('#fiche-corps [data-action="supprimer-compte"]');
    await page.waitForSelector('#confirmer[open]', { timeout: 3000 });
    const desactive1 = await page.isDisabled('#confirmer-ok');
    await page.fill('#confirmer-saisie', 'client');
    const desactive2 = await page.isDisabled('#confirmer-ok');
    await page.fill('#confirmer-saisie', 'client@exemple.fr');
    const active = !(await page.isDisabled('#confirmer-ok'));
    v('effacer : la référence est à taper en entier', desactive1 && desactive2 && active);
    await page.click('#confirmer-ok');
    await page.waitForSelector('#fiche:not([open])', { timeout: 4000 }).catch(() => {});
    await page.waitForFunction(() => !document.querySelector('#corps-comptes').textContent.includes('cl…@exemple.fr'), null, { timeout: 4000 }).catch(() => {});
    v('le compte est effacé, la fiche fermée', s.comptes.utilisateur('client@exemple.fr') === null && !(await page.isVisible('#fiche')));

    titre('Comptes d\'appareil');
    await page.click('[data-onglet="appareils"]');
    await page.waitForSelector('#corps-appareils tr', { timeout: 5000 }).catch(() => {});
    v('le compte d\'appareil du socle', /terraA1B2C3/.test(await texte('#corps-appareils')) && /en ligne/.test(await texte('#corps-appareils')));
    await page.click('#v-appareils .barre [data-action="nouvel-appareil"]');
    await page.fill('#n-appareil', 'pas-un-id');
    await page.click('#form-nouvel-appareil [type="submit"]');
    v('un identifiant mal formé est refusé', await attendreTexte('#message', /terra suivi de 6/));
    await page.fill('#n-appareil', 'terraD4E5F6');
    await page.click('#form-nouvel-appareil [type="submit"]');
    const secretApp = await lireSecret();
    v('le mot de passe et la commande de la console du socle', new RegExp(`mqtt localhost ${s.portMqtt} terraD4E5F6 \\S{8,}`).test(secretApp), secretApp.split('\n').pop());
    await page.waitForSelector('#corps-appareils [data-id="terraD4E5F6"]', { timeout: 4000 }).catch(() => {});
    await page.click('#corps-appareils [data-action="retirer-appareil"][data-id="terraD4E5F6"]');
    await confirmerDialogue('terraD4E5F6');
    await page.waitForFunction(() => !document.querySelector('#corps-appareils').textContent.includes('terraD4E5F6'), null, { timeout: 4000 }).catch(() => {});
    v('« Retirer », référence tapée', s.comptes.appareil('terraD4E5F6') === null);

    titre('Rapports');
    await page.click('[data-onglet="rapports"]');
    await page.waitForSelector('#corps-rapports tr', { timeout: 5000 }).catch(() => {});
    v('le rapport reçu, son compte masqué', (await page.$$('#corps-rapports tr')).length === 1 && (await texte('#corps-rapports')).includes('no…'));
    await page.click('#corps-rapports [data-action="lire-rapport"]');
    await page.waitForSelector('#lecture[open]', { timeout: 4000 }).catch(() => {});
    v('« Lire » : le texte, tel quel', /sonde de la zone 2 absente/.test(await texte('#lecture-texte')));
    await page.click('[data-action="supprimer-lecture"]');
    await confirmerDialogue();
    await page.waitForFunction(() => document.querySelectorAll('#corps-rapports tr').length === 0, null, { timeout: 4000 }).catch(() => {});
    v('« Supprimer »', (await page.$$('#corps-rapports tr')).length === 0 && await visible('#rapports-vide'));

    titre('Journal');
    await page.click('[data-onglet="journal"]');
    await attendreTexte('#etat-chaine', /Chaîne intègre/);
    v('la chaîne est vérifiée', /Chaîne intègre : \d+ lignes/.test(await texte('#etat-chaine')), await texte('#etat-chaine'));
    const journal = await texte('#liste-journal');
    v('chaque geste y est', ['Compte créé', 'Droits d\'administration', 'Mot de passe réinitialisé', 'Données du compte exportées', 'Compte effacé',
      'Compte d\'appareil créé', 'Compte d\'appareil retiré', 'Rapport lu', 'Rapport supprimé', 'Socle détaché'].every(x => journal.includes(x)));
    v('le titulaire et l\'exploitant sont distingués', /par titulaire/.test(journal) && /par jeton d'administration/.test(journal));
    await page.fill('#f-journal', 'terraA1B2C3');
    await page.waitForFunction(() => [...document.querySelectorAll('#liste-journal li')].every(li => li.textContent.includes('terraA1B2C3')), null, { timeout: 4000 }).catch(() => {});
    v('filtré par socle', (await page.$$('#liste-journal li')).length > 0 && (await page.$$eval('#liste-journal li', l => l.every(li => li.textContent.includes('terraA1B2C3')))));
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }).catch(() => null), page.click('[data-action="exporter-journal"]')]);
    let lignesExport = 0;
    if (dl) lignesExport = fs.readFileSync(await dl.path(), 'utf8').trim().split('\n').filter(Boolean).length;
    v('« Exporter » : le journal filtré en NDJSON', lignesExport > 0, `${lignesExport} ligne(s)`);
    await page.fill('#f-journal', '');

    titre('Déconnexion, puis comptes administrateurs');
    await page.click('#btn-sortir');
    v('« Se déconnecter » : retour à la connexion, session oubliée', await visible('#connexion') && !(await visible('#espace'))
      && await page.evaluate(() => sessionStorage.getItem('terrarium.console.session')) === null && (await texte('#corps-socles')) === '');
    await page.fill('#c-login', 'noe@exemple.fr');
    await page.fill('#c-mdp', 'mot-de-passe-noe');
    await page.click('#form-compte [type="submit"]');
    v('un compte ordinaire est refusé', await attendreTexte('#connexion-erreur', /n'a pas accès à la console/));
    await page.fill('#c-login', 'chef');
    await page.fill('#c-mdp', 'mot-de-passe-chef');
    await page.click('#form-compte [type="submit"]');
    await page.waitForSelector('#espace:not([hidden])', { timeout: 5000 }).catch(() => {});
    v('un compte administrateur (mot de passe) entre', await visible('#espace') && (await texte('#etat-serveur')).includes('ch…'));
    await page.click('#btn-sortir');
    await page.fill('#c-login', 'equipe@exemple.fr');
    await page.fill('#c-mdp', '');
    await page.click('#form-compte [type="submit"]');
    await page.waitForSelector('#form-code:not([hidden])', { timeout: 5000 }).catch(() => {});
    const code = (() => { const m = boite.filter(x => x.a === 'equipe@exemple.fr').pop(); return m ? /(\d{6})/.exec(m.sujet)[1] : ''; })();
    v('compte par e-mail : un code part', await visible('#form-code') && /^\d{6}$/.test(code));
    await page.fill('#c-code', code);
    await page.click('#form-code [type="submit"]');
    await page.waitForSelector('#espace:not([hidden])', { timeout: 5000 }).catch(() => {});
    v('et le code ouvre la console', await visible('#espace'));
    await page.click('#btn-sortir');

    titre('Rôle support');
    await api('POST', '/api/admin/utilisateurs', { login: 'agent', motDePasse: 'mot-de-passe-agent' });
    await api('POST', '/api/admin/utilisateurs/agent/support', { support: true });
    await page.fill('#c-login', 'agent');
    await page.fill('#c-mdp', 'mot-de-passe-agent');
    await page.click('#form-compte [type="submit"]');
    await page.waitForSelector('#espace:not([hidden])', { timeout: 5000 }).catch(() => {});
    v('un compte « support » entre', await visible('#espace'));
    v('sans les rubriques Comptes ni Appareils', await visible('[data-onglet="support"]') && !(await visible('[data-onglet="comptes"]')) && !(await visible('[data-onglet="appareils"]')));
    await attendreTexte('#tuiles', /demandes ouvertes/);
    v('ni la tuile des comptes', !/comptes \(/.test(await texte('#tuiles')));
    await page.click('[data-onglet="socles"]');
    await page.waitForSelector('#corps-socles button[data-socle="terraA1B2C3"]', { timeout: 5000 }).catch(() => {});
    await page.click('#corps-socles button[data-socle="terraA1B2C3"]');
    await attendreTexte('#fiche-corps', /Frise/);
    const ficheSupport = await texte('#fiche-corps');
    v('la fiche d\'un socle, sans rattacher ni compte d\'appareil', !(await page.$('#fiche-corps [data-form="rattacher"]')) && !/Compte d'appareil \(MQTT\)/.test(ficheSupport) && /Accès support/.test(ficheSupport),
      `${!!(await page.$('#fiche-corps [data-form="rattacher"]'))} ${/Compte d'appareil/.test(ficheSupport)} ${/Accès support/.test(ficheSupport)}`);
    await page.click('[data-action="fermer-fiche"]');
    const refus = await page.evaluate(async () => (await fetch('/api/admin/utilisateurs', { headers: { Authorization: 'Bearer ' + JSON.parse(sessionStorage.getItem('terrarium.console.session')).jeton } })).status);
    v('l\'API refuse aussi (403), la session reste', refus === 403 && await visible('#espace'));
    await page.click('#btn-sortir');

    const violations = await page.evaluate(() => window.__violations);
    v('aucune violation de la politique de sécurité', violations.length === 0, violations.join(' ; '));
    v('aucune erreur dans la page', erreurs.length === 0, erreurs.join(' | '));

    titre('Accessibilité (axe-core) et petite largeur');
    if (!AXE) v('axe-core installé (npm install --no-save axe-core)', false);
    else {
      for (const [nom, viewport, colorScheme] of [['bureau-clair', { width: 1280, height: 900 }, 'light'], ['telephone-sombre', { width: 390, height: 844 }, 'dark']]) {
        const c2 = await navigateur.newContext({ viewport, colorScheme, locale: 'fr-FR', bypassCSP: true });
        const p2 = await c2.newPage();
        const analyser = async ecran => {
          await p2.addScriptTag({ content: AXE }).catch(() => {});
          const r = await p2.evaluate(async () => {
            const res = await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] });
            return res.violations.map(x => ({ id: x.id, impact: x.impact, nb: x.nodes.length, cible: x.nodes[0] && x.nodes[0].target.join(' ') }));
          });
          const graves = r.filter(x => x.impact === 'serious' || x.impact === 'critical');
          v(`axe ${nom} / ${ecran}`, graves.length === 0, r.length ? r.map(x => `${x.id} (${x.impact}, ${x.nb}×, ${x.cible})`).join(' ; ') : 'aucune violation');
        };
        await p2.goto(base + '/console/');
        await p2.waitForSelector('#form-compte:not([hidden])');
        await analyser('connexion');
        await p2.click('[data-mode="jeton"]');
        await p2.fill('#c-jeton', JETON);
        await p2.click('#form-jeton [type="submit"]');
        await p2.waitForSelector('#espace:not([hidden])');
        await p2.waitForFunction(() => /socles en ligne/.test(document.querySelector('#tuiles').textContent));
        await analyser('tableau de bord');
        if (viewport.width < 500) {
          const debord = await p2.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
          v('390 px : la page ne déborde pas (les tableaux défilent seuls)', debord <= 0, `${debord} px`);
        }
        for (const o of ['socles', 'comptes', 'appareils', 'rapports', 'journal']) {
          await p2.click(`[data-onglet="${o}"]`);
          await p2.waitForTimeout(400);
          await analyser(o);
        }
        await p2.click('[data-onglet="socles"]');
        await p2.waitForSelector('#corps-socles button[data-socle]');
        await p2.click('#corps-socles button[data-socle="terraA1B2C3"]');
        await p2.waitForSelector('#fiche[open] .courbe-24h');
        await p2.waitForTimeout(250);
        await analyser('fiche du socle');
        await p2.click('#fiche-corps [data-action="detacher"]');
        await p2.waitForSelector('#confirmer[open]');
        await p2.waitForTimeout(250);
        await analyser('confirmation');
        await p2.click('[data-action="annuler-confirmation"]');
        await p2.click('[data-action="fermer-fiche"]');
        await p2.click('[data-onglet="comptes"]');
        await p2.waitForSelector('#corps-comptes button[data-compte="noe@exemple.fr"]');
        await p2.click('#corps-comptes button[data-compte="noe@exemple.fr"]');
        await p2.waitForSelector('#fiche[open] [data-action="supprimer-compte"]');
        await p2.waitForTimeout(250);
        await analyser('fiche du compte');
        await p2.click('[data-action="fermer-fiche"]');
        await p2.click('[data-onglet="appareils"]');
        await p2.click('#v-appareils .barre [data-action="nouvel-appareil"]');
        await p2.fill('#n-appareil', nom === 'bureau-clair' ? 'terraAAAAA1' : 'terraAAAAA2');
        await p2.click('#form-nouvel-appareil [type="submit"]');
        await p2.waitForSelector('#secret[open]');
        await p2.waitForTimeout(250);
        await analyser('mot de passe montré une fois');
        await p2.click('[data-action="fermer-secret"]');
        await c2.close();
      }
    }
  } catch (e) {
    v('déroulé sans exception', false, e.message);
  } finally {
    socle.end(true);
    await navigateur.close();
    await s.arreter();
  }

  console.log(`\n=== CONSOLE D'ADMINISTRATION ${echecs ? 'EN ÉCHEC' : 'OK'} (${reussites} reussite(s), ${echecs} echec(s)) ===`);
  process.exit(echecs ? 1 : 0);
})();
