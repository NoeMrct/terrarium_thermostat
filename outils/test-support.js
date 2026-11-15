#!/usr/bin/env node
/* =============================================================================
   Assistance (V11), de bout en bout : l'application du propriétaire, la
   console du support et le socle simulé, autour d'un vrai serveur Terrariums.
   -----------------------------------------------------------------------------
   Le socle simulé (socle-simule.js, mêmes règles que le firmware 3.5) se
   connecte avec son compte d'appareil. Le propriétaire écrit au support depuis
   l'onglet Service ; l'équipe répond et demande l'accès ; le propriétaire
   l'autorise (clé de session tirée dans le navigateur, donnée au socle signée
   avec le code, puis au serveur) ; le support relit le bus, lit le journal du
   socle (son geste y est noté), prolonge, remet les réglages ; le propriétaire
   voit la prolongation et ferme ; la demande est close. Politique de sécurité
   des deux pages sans violation ; axe-core sur la carte Assistance, l'onglet
   Support et la fiche d'une demande.

     npm install --no-save playwright axe-core && npx playwright install chromium
     node test-support.js
   ============================================================================= */

/* global document, window, axe, App */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { demarrerServeur } = require('../serveur/serveur');
let chromium, AXE = null;
try { ({ chromium } = require('playwright')); }
catch (e) { console.error('Playwright est nécessaire : npm install --no-save playwright && npx playwright install chromium'); process.exit(2); }
try { AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch (e) { /* signalé plus bas */ }

let reussites = 0, echecs = 0;
const v = (q, c, d = '') => { console.log(`   ${c ? '[ OK ]' : '[ECHEC]'} ${q.padEnd(64)} ${String(d).slice(0, 70)}`); c ? reussites++ : echecs++; };
const titre = t => console.log(`\n== ${t}`);
const attendre = ms => new Promise(r => setTimeout(r, ms));
const JETON_ADMIN = 'admin-support-test';
const ID = 'terraSUP001', CODE = 'SIMULATIONTESTJETON00001';

(async () => {
  const donnees = fs.mkdtempSync(path.join(os.tmpdir(), 'terrarium-assistance-'));
  const s = await demarrerServeur({ port: 0, portMqtt: 0, donnees, adminJeton: JETON_ADMIN, journal: () => {}, pushActif: false,
    app: path.resolve(__dirname, '..', 'app'), courriel: { envoyer: async () => {} } });
  const base = `http://localhost:${s.port}`;
  const api = async (methode, chemin, corps, jeton = JETON_ADMIN) => {
    const r = await fetch(base + chemin, { method: methode, headers: { 'Content-Type': 'application/json', ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}) }, body: corps === undefined ? undefined : JSON.stringify(corps) });
    return r.json().catch(() => null);
  };
  const app = await api('POST', '/api/admin/appareils', { id: ID });
  const simule = spawn(process.execPath, [path.join(__dirname, 'socle-simule.js'), '--broker', `mqtt://127.0.0.1:${s.portMqtt}`, '--id', ID, '--jeton', CODE, '--user', ID, '--pass', app.motDePasse], { stdio: 'ignore' });
  for (let i = 0; i < 100 && !(s.broker.flotte[ID] && s.broker.flotte[ID].sante); i++) await attendre(100);
  await api('POST', '/api/admin/utilisateurs', { login: 'noe@exemple.fr', motDePasse: 'mot-de-passe-noe' });
  await api('POST', `/api/admin/socles/${ID}/proprietaires`, { login: 'noe@exemple.fr' });
  const session = await api('POST', '/api/session', { login: 'noe@exemple.fr', motDePasse: 'mot-de-passe-noe' }, null);

  const navigateur = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const surveiller = async (contexte, nom, erreurs) => {
    await contexte.addInitScript(() => {
      window.__violations = [];
      document.addEventListener('securitypolicyviolation', e => window.__violations.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    const p = await contexte.newPage();
    p.on('pageerror', e => erreurs.push(`${nom} : ${e.message}`));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) erreurs.push(`${nom} : ${m.text()}`); });
    return p;
  };
  const erreurs = [];
  // Le propriétaire : l'application, déjà reliée au serveur et au socle.
  const ctxAppli = await navigateur.newContext({ viewport: { width: 390, height: 844 }, locale: 'fr-FR' });
  await ctxAppli.addInitScript(([cfg]) => { if (!window.localStorage.getItem('terrarium.config.v1')) window.localStorage.setItem('terrarium.config.v1', cfg); },
    [JSON.stringify({ broker: { url: `ws://localhost:${s.port}/mqtt`, user: 'noe@exemple.fr', pass: session.jeton, prefixe: 'terrarium', compte: 'email' },
      serveur: { push: false, jeton: session.jeton, login: 'noe@exemple.fr', socles: [ID] }, socles: [{ id: ID, jeton: CODE, nom: 'Pogona' }] })]);
  const appli = await surveiller(ctxAppli, 'application', erreurs);
  // L'équipe : la console.
  const ctxConsole = await navigateur.newContext({ viewport: { width: 1280, height: 900 }, locale: 'fr-FR' });
  const cons = await surveiller(ctxConsole, 'console', erreurs);
  const texteDe = (p, sel) => p.textContent(sel).then(t => t || '', () => '');
  const attendreTexte = (p, sel, re, delai = 8000) => p.waitForFunction(([x, src]) => { const el = document.querySelector(x); return !!el && new RegExp(src).test(el.textContent); }, [sel, re.source], { timeout: delai }).then(() => true, () => false);
  const confirmerAppli = async () => { await appli.waitForSelector('#dlg-confirm[open]', { timeout: 4000 }); await appli.click('#dlg-confirm [data-dlg="oui"]'); };
  const confirmerConsole = async reference => {
    await cons.waitForSelector('#confirmer[open]', { timeout: 4000 });
    if (reference) await cons.fill('#confirmer-saisie', reference);
    await cons.click('#confirmer-ok');
  };
  const ouvrirAssistance = async () => {
    await appli.evaluate(id => { App.ouvrir(id); App.panneau('service'); }, ID);
    await attendreTexte(appli, '[data-sv-carte="support"]', /Assistance/);
  };

  try {
    titre('Le propriétaire écrit au support');
    await appli.goto(base + '/');
    await appli.waitForFunction(id => !!document.querySelector(`#socles [data-id="${id}"], #socles .socle`), ID, { timeout: 10000 }).catch(() => {});
    await appli.waitForFunction(() => document.querySelector('#lien') && document.querySelector('#lien').textContent === 'connecté', null, { timeout: 10000 }).catch(() => {});
    await appli.waitForFunction(() => /\d+,\d°/.test(document.querySelector('#socles').textContent), null, { timeout: 10000 }).catch(() => {});
    await ouvrirAssistance();
    await attendreTexte(appli, '[data-sv-carte="support"]', /n'a pas accès/);
    v('la carte Assistance : accès fermé, de quoi l\'ouvrir', /n'a pas accès/.test(await texteDe(appli, '[data-sv-carte="support"]')) && await appli.isVisible('[data-sv="autoriserSupport"]'));
    await appli.fill('#sv-nouvelle', 'La zone 2 ne chauffe plus depuis ce matin.');
    await appli.click('[data-form="sv-nouvelle"] [type="submit"]');
    await attendreTexte(appli, '[data-sv-carte="support"]', /Demande n°1/);
    v('le message part : la demande n°1 apparaît, avec son fil', /Demande n°1/.test(await texteDe(appli, '[data-sv-carte="support"]')) && /ne chauffe plus/.test(await texteDe(appli, '.fil-support')));

    titre('L\'équipe répond et demande l\'accès');
    await cons.goto(base + '/console/');
    await cons.click('[data-mode="jeton"]');
    await cons.fill('#c-jeton', JETON_ADMIN);
    await cons.click('#form-jeton [type="submit"]');
    await cons.waitForSelector('#espace:not([hidden])', { timeout: 5000 });
    await attendreTexte(cons, '#tuiles', /demandes ouvertes/);
    v('tableau de bord : une demande ouverte, nouvelle', /1\s*demandes ouvertes \(1 nouvelle\)/.test(await texteDe(cons, '#tuiles')));
    await cons.click('[data-onglet="support"]');
    await cons.waitForSelector('#corps-demandes tr', { timeout: 5000 }).catch(() => {});
    const file = await texteDe(cons, '#corps-demandes');
    v('la file : n°1, nouvelle, le socle, le client masqué, l\'extrait', /n°1/.test(file) && /nouvelle/.test(file) && file.includes(ID) && file.includes('no…@exemple.fr') && /ne chauffe plus/.test(file));
    await cons.click('#corps-demandes [data-demande="1"]');
    await cons.waitForSelector('#fiche[open] #dm-reponse', { timeout: 5000 });
    v('la fiche de la demande : fil, notes, accès fermé', /Échanges avec le client/.test(await texteDe(cons, '#fiche-corps')) && /Fermé/.test(await texteDe(cons, '#fiche-corps')));
    await cons.fill('#dm-reponse', 'Bonjour, nous allons regarder votre socle avec vous.');
    await cons.click('[data-form="repondre"] [type="submit"]');
    await attendreTexte(cons, '#fiche-corps .fil', /allons regarder/);
    await cons.fill('#dm-note', 'Sonde 2 à vérifier en premier.');
    await cons.click('[data-form="note"] [type="submit"]');
    await attendreTexte(cons, '#fiche-corps', /Sonde 2 à vérifier/);
    v('réponse au client et note interne', /allons regarder/.test(await texteDe(cons, '#fiche-corps .fil')) && /Sonde 2 à vérifier/.test(await texteDe(cons, '#fiche-corps')));
    // Réponse type : insérée dans le champ, variables remplies avec la demande.
    const modele = await cons.$eval('#dm-modele', el => [...el.options].find(o => /Demander l.accès/.test(o.textContent)).value);
    await cons.selectOption('#dm-modele', modele);
    const insere = await cons.inputValue('#dm-reponse');
    v('une réponse type s\'insère, référence du socle remplie', insere.includes(ID) && !insere.includes('{référence}') && /onglet Service/.test(insere), insere.slice(0, 60));
    await cons.fill('#dm-reponse', '');
    // Relance : demain 10:00, rappel pour l'équipe ; visible dans la fiche et la file, puis retirée.
    await cons.click('[data-action="relance-raccourci"][data-quand="demain"]');
    await cons.fill('#dm-rel-texte', 'Rappeler si la sonde 2 ne revient pas.');
    await cons.click('[data-form="relance"] [type="submit"]');
    await attendreTexte(cons, '#fiche-corps .relance-actuelle', /rappel pour l'équipe/);
    v('une relance se programme (rappel pour l\'équipe)', /prévue/.test(await texteDe(cons, '#fiche-corps .relance-actuelle')) && !!(await api('GET', '/api/admin/support/demandes/1')).relance);
    await cons.click('[data-action="annuler-relance"]');
    for (let i = 0; i < 50 && (await api('GET', '/api/admin/support/demandes/1')).relance; i++) await new Promise(r => setTimeout(r, 100));
    await attendreTexte(cons, '#fiche-corps', /Relancer le/);
    v('…et s\'annule', !(await cons.isVisible('#fiche-corps .relance-actuelle')));
    await cons.click('[data-action="demander-acces"]');
    await attendreTexte(cons, '#fiche-corps', /Accès demandé au propriétaire le/);
    v('« Demander l\'accès au propriétaire »', /Accès demandé au propriétaire le/.test(await texteDe(cons, '#fiche-corps')));

    titre('Le propriétaire autorise l\'accès');
    await appli.evaluate(() => App.verifierSupport());
    await attendreTexte(appli, '#message', /Le support demande l'accès à Pogona/);
    v('l\'application prévient : « Le support demande l\'accès »', /Le support demande l'accès à Pogona/.test(await texteDe(appli, '#message')));
    await appli.click('#message .btn');
    await attendreTexte(appli, '[data-sv-carte="support"]', /demande l'accès à ce socle \(demande n°1\)/);
    const carte = await texteDe(appli, '[data-sv-carte="support"]');
    v('« Voir » mène à la carte : la demande d\'accès, la réponse du support', /demande n°1/.test(carte) && /allons regarder/.test(carte) && !/Sonde 2 à vérifier/.test(carte));
    await appli.click('[data-sv="autoriserSupport"]');
    await confirmerAppli();
    await attendreTexte(appli, '[data-sv-carte="support"]', /a accès à ce socle jusqu'au/, 10000);
    v('autorisé : « Le support a accès à ce socle jusqu\'au … »', /a accès à ce socle jusqu'au/.test(await texteDe(appli, '[data-sv-carte="support"]')));
    const acces = s.support.accesActif(ID);
    v('le serveur garde la clé, prouvée auprès du socle', !!acces && /^[0-9a-f]{64}$/.test(acces.cle));
    const etat = await api('GET', `/api/admin/socles/${ID}`);
    v('le socle publie l\'accès ouvert dans sa santé', !!(etat.sante && etat.sante.service && etat.sante.service.actif));
    v('le code d\'appairage n\'a jamais touché le serveur', !fs.readdirSync(donnees, { recursive: true }).some(f => {
      const p = path.join(donnees, String(f));
      return fs.statSync(p).isFile() && fs.readFileSync(p, 'utf8').includes(CODE);
    }));

    titre('Le support agit pendant l\'accès');
    await cons.click('[data-action="actualiser-fiche"]');
    await attendreTexte(cons, '#fiche-corps', /Ouvert par le propriétaire jusqu'au/);
    v('la console voit l\'accès ouvert, les diagnostics proposés', await cons.isVisible('#fiche-corps [data-action="acces-cmd"]'));
    await cons.click('#fiche-corps [data-action="acces-cmd"][data-i="0"]');
    await attendreTexte(cons, '#fiche-corps', /Dernier résultat : Relire le bus/);
    v('« Relire le bus » : l\'inventaire des sondes revient', /"sondes"/.test(await texteDe(cons, '.sortie-support')));
    await cons.click('#fiche-corps [data-action="acces-cmd"][data-i="2"]');
    await attendreTexte(cons, '#fiche-corps', /Dernier résultat : Journal du socle/);
    v('le journal du socle note le geste du support', /Support : sondes/.test(await texteDe(cons, '.sortie-support')) && /Acces support ouvert par le proprietaire/.test(await texteDe(cons, '.sortie-support')));
    await cons.click('#fiche-corps [data-action="prolonger"]');
    await attendreTexte(cons, '#fiche-corps', /\(prolongé\)/);
    v('« Prolonger de 24 h »', /\(prolongé\)/.test(await texteDe(cons, '#fiche-corps')));
    await cons.waitForFunction(() => !document.querySelector('[data-action="remettre"]').disabled, null, { timeout: 5000 }).catch(() => {});
    await cons.click('#fiche-corps [data-action="remettre"]');
    await confirmerConsole(ID);
    await attendreTexte(cons, '#fiche-corps', /Dernier résultat : Tout remettre/);
    v('« Tout remettre » depuis la copie prise à l\'ouverture', /restauree/i.test(await texteDe(cons, '.sortie-support')));
    const frise = await texteDe(cons, '#fiche-corps .frise');
    v('la frise : ouverture par le propriétaire, commandes, prolongation', /Accès support ouvert par le propriétaire/.test(frise) && /Commande du support/.test(frise) && /Accès support prolongé/.test(frise));

    titre('Le propriétaire voit et referme');
    await appli.click('[data-sv="actualiserSupport"]');
    await attendreTexte(appli, '[data-sv-carte="support"]', /\(prolongé\)/);
    v('l\'application dit la prolongation', /\(prolongé\)/.test(await texteDe(appli, '[data-sv-carte="support"]')));
    await appli.click('[data-sv="fermerSupport"]');
    await confirmerAppli();
    await attendreTexte(appli, '[data-sv-carte="support"]', /n'a pas accès/);
    v('« Fermer l\'accès » : fermé côté serveur et côté socle', !s.support.accesActif(ID) && !((s.broker.flotte[ID].sante || {}).service));
    await cons.click('[data-action="actualiser-fiche"]');
    await attendreTexte(cons, '#fiche-corps', /Fermé/);
    v('la console le voit fermé, plus de diagnostics', !(await cons.isVisible('#fiche-corps [data-action="acces-cmd"]')));
    await cons.selectOption('#dm-statut', 'résolue');
    await attendreTexte(cons, '#message', /Demande mise à jour/);
    v('la demande est close', (await api('GET', '/api/admin/support/demandes/1')).statut === 'résolue');

    const violations = [...await appli.evaluate(() => window.__violations), ...await cons.evaluate(() => window.__violations)];
    v('aucune violation de la politique de sécurité (application, console)', violations.length === 0, violations.join(' ; '));
    v('aucune erreur dans les pages', erreurs.length === 0, erreurs.join(' | '));

    titre('Accessibilité (axe-core)');
    if (!AXE) v('axe-core installé (npm install --no-save axe-core)', false);
    else {
      const analyser = async (p, nom) => {
        await p.addScriptTag({ content: AXE }).catch(() => {});
        const r = await p.evaluate(async () => (await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] }))
          .violations.map(x => ({ id: x.id, impact: x.impact, nb: x.nodes.length, cible: x.nodes[0] && x.nodes[0].target.join(' ') })));
        const graves = r.filter(x => x.impact === 'serious' || x.impact === 'critical');
        v(`axe : ${nom}`, graves.length === 0, r.length ? r.map(x => `${x.id} (${x.impact}, ${x.nb}×, ${x.cible})`).join(' ; ') : 'aucune violation');
      };
      for (const sombre of [false, true]) {
        const c1 = await navigateur.newContext({ viewport: { width: 390, height: 844 }, locale: 'fr-FR', bypassCSP: true, colorScheme: sombre ? 'dark' : 'light' });
        await c1.addInitScript(([cfg]) => window.localStorage.setItem('terrarium.config.v1', cfg),
          [JSON.stringify({ broker: { url: `ws://localhost:${s.port}/mqtt`, user: 'noe@exemple.fr', pass: session.jeton, prefixe: 'terrarium', compte: 'email' },
            serveur: { push: false, jeton: session.jeton, login: 'noe@exemple.fr', socles: [ID] }, socles: [{ id: ID, jeton: CODE, nom: 'Pogona' }] })]);
        const p1 = await c1.newPage();
        await p1.goto(base + '/');
        await p1.waitForFunction(() => /\d+,\d°/.test(document.querySelector('#socles').textContent), null, { timeout: 10000 }).catch(() => {});
        await p1.evaluate(id => { App.ouvrir(id); App.panneau('service'); }, ID);
        await p1.waitForFunction(() => /Demande n°1/.test((document.querySelector('[data-sv-carte="support"]') || {}).textContent || ''), null, { timeout: 8000 }).catch(() => {});
        await p1.evaluate(() => { const d = document.querySelector('.demande-support'); if (d) d.open = true; });
        // La feuille glisse et les cartes apparaissent en fondu : mesurer après.
        await p1.waitForFunction(() => document.getAnimations().every(x => x.playState !== 'running'), null, { timeout: 5000 }).catch(() => {});
        await analyser(p1, `carte Assistance (${sombre ? 'sombre' : 'clair'})`);
        await c1.close();
        const c2 = await navigateur.newContext({ viewport: { width: 1280, height: 900 }, locale: 'fr-FR', bypassCSP: true, colorScheme: sombre ? 'dark' : 'light' });
        const p2 = await c2.newPage();
        await p2.goto(base + '/console/');
        await p2.click('[data-mode="jeton"]');
        await p2.fill('#c-jeton', JETON_ADMIN);
        await p2.click('#form-jeton [type="submit"]');
        await p2.waitForSelector('#espace:not([hidden])');
        await p2.click('[data-onglet="support"]');
        await p2.click('[data-filtres="demandes"] [data-filtre="toutes"]');
        await p2.waitForSelector('#corps-demandes [data-demande="1"]');
        await p2.click('#v-support .barre [data-action="nouvelle-demande"]');
        await analyser(p2, `onglet Support (${sombre ? 'sombre' : 'clair'})`);
        await p2.click('#corps-demandes [data-demande="1"]');
        await p2.waitForSelector('#fiche[open] #dm-reponse');
        await p2.waitForTimeout(250);
        await analyser(p2, `fiche d'une demande (${sombre ? 'sombre' : 'clair'})`);
        await c2.close();
      }
    }
  } catch (e) {
    v('déroulé sans exception', false, e.message);
  } finally {
    simule.kill();
    await navigateur.close();
    await s.arreter();
  }
  console.log(`\n=== ASSISTANCE ${echecs ? 'EN ÉCHEC' : 'OK'} (${reussites} reussite(s), ${echecs} echec(s)) ===`);
  process.exit(echecs ? 1 : 0);
})();
