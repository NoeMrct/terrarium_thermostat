#!/usr/bin/env node
/* =============================================================================
   Accessibilité : axe-core sur chaque écran de la démonstration, puis sur les
   pages statiques du site (aide dans les deux langues, pages légales, fiche de
   démarrage rapide, installateur, 404).
   -----------------------------------------------------------------------------
   Les contrastes, les étiquettes de champs, les rôles et les noms accessibles
   sont vérifiés par un moteur indépendant, en clair et en sombre, sur mobile
   et sur grand écran. Toute violation « serious » ou « critical » fait échouer
   le script ; les autres sont listées pour information.

   Dépend de Playwright et d'axe-core :
     npm install --no-save playwright axe-core && npx playwright install chromium
     node construire-demo.js && node test-accessibilite.js
   ============================================================================= */

/* global App, axe, localStorage, document */
const path = require('path');
const fs = require('fs');
const http = require('http');
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { console.error('Playwright est nécessaire : npm install --no-save playwright && npx playwright install chromium'); process.exit(2); }

const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const DEMO = 'file://' + path.resolve(__dirname, '..', 'app', 'demo.html');
const ECRANS = [
  ['liste', () => { localStorage.setItem('terrarium.langue', 'fr'); App.montrer('liste'); }],
  ['etat', () => App.ouvrir('terraDEMO002')],
  ['reglages', () => App.panneau('reglages')],
  ['courbes', () => App.panneau('courbes')],
  ['appareil', () => App.panneau('general')],
  ['diagnostic', () => App.diagnostic()],
  ['verrou', () => App.montrer('verrou')],
  ['broker', () => { localStorage.clear(); App.montrer('broker'); }]
];

const STATIQUES = ['aide.html', 'aide.en.html', 'mentions-legales.html', 'mentions-legales.en.html',
  'confidentialite.html', 'confidentialite.en.html', 'demarrage-rapide.html', 'installer.html', '404.html'];
// Les pages statiques sont servies en HTTP : 404.html référence /style.css en
// absolu (elle peut être servie à n'importe quelle adresse), ce que file:// ne
// résoudrait pas.
const APP = path.resolve(__dirname, '..', 'app');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const serveur = http.createServer((req, res) => {
  fs.readFile(path.join(APP, decodeURIComponent(req.url.split('?')[0])), (e, d) => {
    if (e) { res.statusCode = 404; res.end('absent'); return; }
    res.setHeader('Content-Type', TYPES[path.extname(req.url.split('?')[0])] || 'application/octet-stream');
    res.end(d);
  });
}).listen(0);

let violationsGraves = 0, total = 0;
(async () => {
  const navigateur = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const analyser = async (page, nom) => {
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
      await page.waitForTimeout(ecran === 'courbes' || ecran === 'appareil' ? 1200 : 500);
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
  }
  await navigateur.close();
  serveur.close();
  console.log(`\n=== ${violationsGraves ? 'ACCESSIBILITE : VIOLATIONS GRAVES' : 'ACCESSIBILITE OK'} (${violationsGraves} grave(s), ${total} au total) ===`);
  process.exit(violationsGraves ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
