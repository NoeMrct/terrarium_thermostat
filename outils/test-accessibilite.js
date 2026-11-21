#!/usr/bin/env node
/* =============================================================================
   Accessibilité : axe-core sur chaque écran de la démonstration, puis sur les
   pages statiques du site (aide dans les deux langues, pages légales, 404),
   enfin sur l'atelier à chaque étape.
   -----------------------------------------------------------------------------
   Les contrastes, les étiquettes de champs, les rôles et les noms accessibles
   sont vérifiés par un moteur indépendant, en clair et en sombre, sur mobile
   et sur grand écran. Toute violation « serious » ou « critical » fait échouer
   le script ; les autres sont listées pour information.

   Dépend de Playwright et d'axe-core :
     npm install --no-save playwright axe-core && npx playwright install chromium
     node construire-demo.js && node test-accessibilite.js
   ============================================================================= */

/* global App, Atelier, axe, localStorage, document, Event */
const path = require('path');
const fs = require('fs');
const { servirApp } = require('./servir-app');
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { console.error('Playwright est nécessaire : npm install --no-save playwright && npx playwright install chromium'); process.exit(2); }

const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const DEMO = 'file://' + path.resolve(__dirname, '..', 'app', 'demo.html');
const ECRANS = [
  ['liste', () => { localStorage.setItem('terrarium.langue', 'fr'); App.montrer('liste'); }],
  ['etat', () => App.ouvrir('terraDEMO002')],
  ['zone', () => App.zone(1)],
  ['reglages', () => App.panneau('reglages')],
  ['programme', () => App.panneau('programme')],
  ['plages et saisons', () => App.panneau('plages')],
  ['une plage', () => { const b = document.querySelector('[data-action="plEditer"][data-k="0"]'); if (b) b.click(); }],
  ['mode vacances', () => { const d = document.querySelector('#dlg-plage'); if (d && d.open) d.close(); App.panneau('vacances'); }],
  ['securite', () => App.panneau('securite')],
  ['courbes', () => App.panneau('courbes')],
  ['consommation', () => App.panneau('conso')],
  ['journal', () => App.panneau('journal')],
  // Un socle qui ne répondra jamais : carte « hors ligne », rubriques grisées.
  ['hors ligne', () => {
    App.montrer('liste');
    document.querySelector('#a-id').value = 'terraFANTOME';
    document.querySelector('#a-jeton').value = 'FANTOME00000000000000001';
    document.querySelector('#a-nom').value = 'Socle absent';
    App.ajouterSocle();
    App.ouvrir('terraFANTOME');
  }],
  ['réglages de l\'application', () => App.reglagesApp('menu')],
  ['aide', () => App.reglagesApp('aide')],
  ['organiser', () => { App.reglagesApp('organiser'); const c = document.querySelector('#org-compacte'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); }],
  ['liste compacte', () => App.montrer('liste')],
  ['copier des réglages', async () => { App.reglagesApp('transfert'); await new Promise(r => setTimeout(r, 1200)); }],
  ['exports', async () => {
    App.reglagesApp('exports');
    document.querySelector('[data-action="exPdf"]').click();
    for (let i = 0; i < 60 && !document.querySelector('[data-action="exPartager"]'); i++) await new Promise(r => setTimeout(r, 100));
  }],
  ['appareil', () => { App.reglagesApp('organiser'); const c = document.querySelector('#org-compacte'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); App.ouvrir('terraDEMO002'); App.panneau('general'); }],
  ['service (client : assistance seule)', () => App.panneau('service')],
  ['service (équipe)', async () => { App._equipe(true); await new Promise(r => setTimeout(r, 1200)); }],
  ['appareil et sécurité (équipe)', async () => { App.panneau('general'); await new Promise(r => setTimeout(r, 600)); App.panneau('securite'); await new Promise(r => setTimeout(r, 600)); App._equipe(null); }],
  ['mises à jour', async () => { App.panneau('maj'); await new Promise(r => setTimeout(r, 1500)); }],
  // L'assistant d'installation : le socle de démonstration neuf arrive en
  // ligne au bout de six secondes.
  ['installation', () => App.nouveauSocle({ id: 'terra3F8A1C', jeton: 'K7QM2XRP9WTDH4BNZ8LC3FVA' })],
  ['installation-wifi', () => App.ajouterSocle()],
  ['installation-reglages', async () => { await new Promise(r => setTimeout(r, 9000)); App.instPas('reglages'); }],
  ['installation-fin', async () => { await App.instReglages(); await new Promise(r => setTimeout(r, 1500)); }],
  ['installation-echec', () => App.instPas('echec')],
  ['verrou', () => { App.instQuitter(); App.montrer('verrou'); }],
  ['broker', () => { localStorage.clear(); App.montrer('broker'); }],
  ['connexion', () => App.accueil('connexion')],
  ['connexion technique', () => App.accueil('technique')],
  ['compte', () => App.ouvrirCompte('https://terrariums.exemple.fr', { serveur: 'terrariums', prefixe: 'terrarium', mqtt: { ws: '/mqtt' }, comptes: { email: true, clesAcces: true } })],
  ['chez-moi', () => App.accueil('chezMoi')]
];

// L'atelier (atelier.html) : un registre d'exemple, posé avant le chargement,
// avec un socle à chaque étape — prêt (étiquette), en rodage, en échec aux
// sondes, mis de côté.
const maintenant = Date.now();
const socleAtelier = (id, o) => ({ id, lot: 'lot-a', cree: maintenant - 3600000, maj: maintenant, etat: 'actif', echec: null, firmware: '3.6.0', proto: 4,
  liaison: 'broker', sondes: [], chauffe: [], rodage: null, journal: [{ t: maintenant, texte: 'Socle enregistré' }], ...o });
const REGISTRE_ATELIER = JSON.stringify({
  v: 1, lotCourant: 'lot-a', lots: [{ id: 'lot-a', nom: 'Lot du 14/11/2026', cree: maintenant }],
  reglages: { urlApp: 'https://app.exemple.fr/', ssid: 'AtelierBanc', liaison: 'broker', rodageH: 24, serveur: { url: '', hote: '', port: 8883, ws: '' },
    broker: { ws: 'wss://broker.exemple.fr:8884/mqtt', hote: 'broker.exemple.fr', port: 8883, prefixe: 'terrarium', utilisateur: 'atelier', oublier: true } },
  socles: {
    terraA1B2C3: socleAtelier('terraA1B2C3', { etape: 5, etat: 'pret', code: 'K7M2QXABCDEFGH2345678JKL', web: { utilisateur: 'admin', motDePasse: 'k4pz7m2qxr9t' },
      usine: { ok: true, t: maintenant, lignes: [{ ok: true, organe: 'ecran', detail: 'mire affichee' }, { ok: null, organe: 'MOSFET', detail: 'non actionnes' }] },
      sondes: [{ zone: 1, rom: '28FF0000000000A1' }, { zone: 2, rom: '28FF0000000000B2' }], chauffe: [{ zone: 1, ok: true, texte: 'zone 1 OK' }, { zone: 2, ok: true, texte: 'zone 2 OK' }],
      rodage: { debut: maintenant - 26 * 3600000, fin: maintenant - 2 * 3600000, incidents: [{ t: maintenant, texte: 'hors ligne', grave: false }], verdict: { ok: true, texte: 'En marche depuis 26 h', t: maintenant } },
      expedition: { verifie: maintenant, wifiOublie: true, brokerOublie: true } }),
    terraB2C3D4: socleAtelier('terraB2C3D4', { etape: 4, code: 'QQQQQQWWWWWWEEEEEERRRRRR', sondes: [{ zone: 1, rom: '28FF0000000000C3' }, { zone: 2, rom: '28FF0000000000D4' }],
      rodage: { debut: maintenant - 5 * 3600000, fin: maintenant + 19 * 3600000, incidents: [{ t: maintenant, texte: 'zone 2 : SONDE ABSENTE', grave: true }], verdict: null } }),
    terraC3D4E5: socleAtelier('terraC3D4E5', { etape: 2, code: 'AAAAAABBBBBBCCCCCCDDDDDD', sondes: [{ zone: 1, rom: '28FF0000000000E5' }],
      echec: { etape: 2, texte: 'Zone 2 : aucune sonde n\'a pris 1 °C.', t: maintenant } }),
    terraD4E5F6: socleAtelier('terraD4E5F6', { etape: 1, etat: 'cote', cote: { raison: 'sonde 2 HS', t: maintenant, etatAvant: 'actif' }, echec: { etape: 1, texte: 'Auto-test usine : 1 échec(s).' } })
  }
});
const ECRANS_ATELIER = [
  ['accueil', () => {}],
  ['nouveau socle', () => document.querySelector('[data-action="nouveau"]').click()],
  ['rodage', () => Atelier.choisir('terraB2C3D4')],
  ['sondes en échec', () => Atelier.choisir('terraC3D4E5')],
  ['étiquette', () => Atelier.choisir('terraA1B2C3')],
  ['réglages', () => document.querySelector('[data-action="reglages"]').click()],
  ['de côté', () => { document.querySelector('[data-filtre="cote"]').click(); Atelier.choisir('terraD4E5F6'); }],
  ['réglages, registre partagé', () => {
    const p = Atelier._partage(); p.actif = true; p.vu = Date.now(); p.moi = { alertes: { email: true } };
    document.querySelector('[data-liaison="serveur"]').click(); Atelier._montrerPartage();
  }],
  ['Wi-Fi du banc', () => { Atelier._choixWifi([{ ssid: 'AtelierBanc', rssi: -48, securise: true }, { ssid: 'Voisin', rssi: -81, securise: false }]); }]
];

const STATIQUES = ['aide.html', 'aide.en.html', 'mentions-legales.html', 'mentions-legales.en.html',
  'confidentialite.html', 'confidentialite.en.html', '404.html'];
// Les pages statiques sont servies en HTTP : 404.html référence /style.css en
// absolu (elle peut être servie à n'importe quelle adresse), ce que file:// ne
// résoudrait pas.
const serveur = servirApp();

let violationsGraves = 0, total = 0;
(async () => {
  const navigateur = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const analyser = async (page, nom) => {
    // Un message qui apparaît (fondu en cours) aurait un contraste faussé :
    // on attend la fin de sa transition.
    await page.waitForFunction(() => !(document.getAnimations ? document.getAnimations() : [])
      .some(a => a.playState === 'running' && a.effect && /** @type {any} */ (a.effect).target && /** @type {any} */ (a.effect).target.id === 'message'),
    null, { timeout: 2000 }).catch(() => {});
    const r = await page.evaluate(async () => {
      const res = await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] });
      return res.violations.map(v => ({ id: v.id, impact: v.impact, aide: v.help, nb: v.nodes.length,
        cible: v.nodes[0] && v.nodes[0].target.join(' ') }));
    });
    const graves = r.filter(v => v.impact === 'serious' || v.impact === 'critical');
    violationsGraves += graves.length; total += r.length;
    console.log(`   ${graves.length ? '[ECHEC]' : '[ OK ]'} ${nom.padEnd(40)} ${r.length ? r.map(v => `${v.id} (${v.impact}, ${v.nb}×, ${v.cible})`).join(' ; ') : 'aucune violation'}`);
  };
  for (const [nom, viewport, colorScheme, mobile] of [
    ['mobile-clair', { width: 390, height: 844 }, 'light', true],
    ['desktop-sombre', { width: 1280, height: 900 }, 'dark', false]
  ]) {
    const ctx = await navigateur.newContext({ viewport, colorScheme, isMobile: mobile, hasTouch: mobile, locale: 'fr-FR' });
    const page = await ctx.newPage();
    await page.goto(DEMO);
    await page.waitForTimeout(1500);
    await page.addScriptTag({ content: AXE });
    for (const [ecran, action] of ECRANS) {
      await page.evaluate(action);
      await page.waitForTimeout(['courbes', 'appareil', 'service', 'programme', 'plages et saisons', 'mode vacances', 'securite', 'consommation', 'journal'].includes(ecran) ? 1500 : 500);
      await analyser(page, nom + ' / ' + ecran);
    }
    await ctx.close();
    // Les pages statiques déclarent script-src 'none' : axe ne pourrait pas y
    // être injecté. Un contexte qui ignore la CSP (bypassCSP) sert à les
    // analyser ; la CSP elle-même est vérifiée par test-navigateur.js.
    const ctxStatique = await navigateur.newContext({ viewport, colorScheme, isMobile: mobile, hasTouch: mobile, locale: 'fr-FR', bypassCSP: true });
    const statique = await ctxStatique.newPage();
    for (const fichier of STATIQUES) {
      await statique.goto(`http://localhost:${serveur.address().port}/${fichier}`);
      await statique.waitForTimeout(300);
      await statique.addScriptTag({ content: AXE });
      await analyser(statique, nom + ' / ' + fichier);
    }
    await ctxStatique.close();
    const ctxAtelier = await navigateur.newContext({ viewport, colorScheme, isMobile: mobile, hasTouch: mobile, locale: 'fr-FR', bypassCSP: true });
    await ctxAtelier.addInitScript(r => { localStorage.setItem('terrarium.atelier.v1', r); }, REGISTRE_ATELIER);
    const atelier = await ctxAtelier.newPage();
    await atelier.goto(`http://localhost:${serveur.address().port}/atelier.html`);
    await atelier.waitForTimeout(400);
    await atelier.addScriptTag({ content: AXE });
    for (const [ecran, action] of ECRANS_ATELIER) {
      await atelier.evaluate(action);
      await atelier.waitForTimeout(250);
      await analyser(atelier, nom + ' / atelier, ' + ecran);
    }
    await ctxAtelier.close();
  }
  await navigateur.close();
  serveur.close();
  console.log(`\n=== ${violationsGraves ? 'ACCESSIBILITE : VIOLATIONS GRAVES' : 'ACCESSIBILITE OK'} (${violationsGraves} grave(s), ${total} au total) ===`);
  process.exit(violationsGraves ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
