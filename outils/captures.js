#!/usr/bin/env node
/* =============================================================================
   Captures d'écran de la démonstration, pour contrôler le rendu à l'œil.
   -----------------------------------------------------------------------------
   Ouvre app/demo.html (socle simulé embarqué, aucun broker) dans un Chromium
   headless et photographie chaque écran en 390 px et 1280 px, en clair et en
   sombre. Les fichiers vont dans outils/captures/ (ignoré par git). Toute
   erreur console fait échouer le script : une régression JavaScript qui ne
   casserait pas les tests fonctionnels se voit quand même ici.

   Dépend de Playwright :
     npm install playwright && npx playwright install chromium
     node construire-demo.js && node captures.js

   Avec --manifest, écrit aussi les deux captures que le manifeste de
   l'application déclare (app/icones/capture-mobile.png, capture-large.png) :
   c'est ce qu'Android montre dans sa fiche d'installation.
   ============================================================================= */

/* global App, localStorage */
const fs = require('fs');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  console.error('Playwright est nécessaire : npm install --no-save playwright && npx playwright install chromium');
  process.exit(2);
}

const DEMO = 'file://' + path.resolve(__dirname, '..', 'app', 'demo.html');
const SORTIE = path.resolve(__dirname, 'captures');
fs.mkdirSync(SORTIE, { recursive: true });

const SCENARIOS = [
  { nom: 'mobile-clair',   viewport: { width: 390, height: 844 },  colorScheme: 'light', mobile: true },
  { nom: 'mobile-sombre',  viewport: { width: 390, height: 844 },  colorScheme: 'dark',  mobile: true },
  { nom: 'desktop-clair',  viewport: { width: 1280, height: 900 }, colorScheme: 'light', mobile: false },
  { nom: 'desktop-sombre', viewport: { width: 1280, height: 900 }, colorScheme: 'dark',  mobile: false }
];

// Captures du manifeste : sans le bandeau de démonstration, cadrées écran.
async function manifeste(navigateur) {
  const ICONES = path.resolve(__dirname, '..', 'app', 'icones');
  for (const [nom, viewport, mobile, action] of [
    ['capture-mobile.png', { width: 390, height: 844 }, true, null],
    ['capture-large.png', { width: 1280, height: 900 }, false, 'terraDEMO001']
  ]) {
    const ctx = await navigateur.newContext({ viewport, colorScheme: 'light', isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 2, locale: 'fr-FR' });
    const page = await ctx.newPage();
    await page.goto(DEMO);
    await page.addStyleTag({ content: '#bandeau-demo{display:none}' });
    await page.waitForTimeout(1500);
    if (action) { await page.evaluate(id => App.ouvrir(id), action); await page.waitForTimeout(900); }
    await page.screenshot({ path: path.join(ICONES, nom), fullPage: false });
    console.log(`   [ OK ] manifeste : ${nom} (${viewport.width * 2}×${viewport.height * 2})`);
    await ctx.close();
  }
}

(async () => {
  const navigateur = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  if (process.argv.includes('--manifest')) await manifeste(navigateur);
  let erreursTotal = 0;
  for (const sc of SCENARIOS) {
    const ctx = await navigateur.newContext({
      viewport: sc.viewport, colorScheme: sc.colorScheme, isMobile: sc.mobile,
      hasTouch: sc.mobile, deviceScaleFactor: 2, locale: 'fr-FR'
    });
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', e => erreurs.push(e.message));
    page.on('console', m => { if (m.type() === 'error') erreurs.push(m.text()); });
    await page.goto(DEMO);
    await page.waitForTimeout(1500);
    const cap = async (suffixe, pleine = true) =>
      page.screenshot({ path: path.join(SORTIE, `${sc.nom}-${suffixe}.png`), fullPage: pleine });

    await cap('1-liste');
    await page.evaluate(() => App.ouvrir('terraDEMO002'));
    await page.waitForTimeout(900);
    await cap('2-etat');
    await page.evaluate(() => App.panneau('reglages'));
    await page.waitForTimeout(400);
    await cap('3-reglages');
    await page.evaluate(() => App.panneau('courbes'));
    await page.waitForTimeout(1200);
    await cap('4-courbes', false);
    await page.evaluate(() => App.panneau('general'));
    await page.waitForTimeout(1200);
    await cap('5-appareil');
    await page.evaluate(() => { localStorage.clear(); App.montrer('broker'); });
    await page.waitForTimeout(200);
    await cap('6-broker', false);

    console.log(`   ${erreurs.length ? '[ECHEC]' : '[ OK ]'} ${sc.nom.padEnd(16)} ${erreurs.length ? erreurs.join(' | ').slice(0, 80) : '6 captures, aucune erreur console'}`);
    erreursTotal += erreurs.length;
    await ctx.close();
  }
  await navigateur.close();
  console.log(`\n=== ${erreursTotal ? 'ERREURS CONSOLE' : 'CAPTURES OK'} (dossier ${path.relative(process.cwd(), SORTIE)}) ===`);
  process.exit(erreursTotal ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
