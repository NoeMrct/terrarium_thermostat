#!/usr/bin/env node
/* =============================================================================
   Régression visuelle : chaque écran de la démonstration comparé, pixel par
   pixel, à une capture de référence versionnée (outils/references-visuelles/).
   -----------------------------------------------------------------------------
   Les tests fonctionnels ne voient pas une marge qui saute, une couleur qui
   change de jeton, un bouton qui déborde. Ici, le rendu est rendu déterministe
   (horloge figée, Math.random amorcé, police imposée : DejaVu Sans, présente
   ici comme sur les exécuteurs GitHub) et la moindre dérive au-delà du seuil
   fait échouer, avec une image de différence dans outils/captures/.

     node construire-demo.js && node test-visuel.js            # compare
     node test-visuel.js --mettre-a-jour                       # refait les références
     node test-visuel.js --seuil 0.8                           # % de pixels différents toléré

   Dépend de Playwright (même version que la CI, voir package.json) et de pngjs.
   ============================================================================= */

/* global App, localStorage */
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { console.error('Playwright est nécessaire : npm install --no-save playwright@1.56.0 && npx playwright install chromium'); process.exit(2); }

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const METTRE_A_JOUR = process.argv.includes('--mettre-a-jour');
const SEUIL = parseFloat(arg('seuil', '0.5'));        // % de pixels différents
const TOLERANCE = 24;                                  // écart par canal ignoré (anticrénelage)
const DEMO = 'file://' + path.resolve(__dirname, '..', 'app', 'demo.html');
const REFERENCES = path.resolve(__dirname, 'references-visuelles');
const SORTIE = path.resolve(__dirname, 'captures');
fs.mkdirSync(REFERENCES, { recursive: true });
fs.mkdirSync(SORTIE, { recursive: true });

const SCENARIOS = [
  { nom: 'mobile-clair',   viewport: { width: 390, height: 844 },  colorScheme: 'light', mobile: true },
  { nom: 'desktop-sombre', viewport: { width: 1280, height: 900 }, colorScheme: 'dark',  mobile: false }
];
const ECRANS = [
  ['liste',    () => { localStorage.setItem('terrarium.langue', 'fr'); App.montrer('liste'); }],
  ['etat',     () => App.ouvrir('terraDEMO002')],
  ['reglages', () => App.panneau('reglages')],
  ['courbes',  () => App.panneau('courbes')],
  ['appareil', () => App.panneau('general')],
  ['verrou',   () => App.montrer('verrou')]
];

// Rendu déterministe : générateur pseudo-aléatoire amorcé (mulberry32) et
// police fixée avant tout script de la page.
const INIT = `
  (function () {
    let a = 0x9E3779B9;
    Math.random = function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
    document.addEventListener('DOMContentLoaded', function () {
      const s = document.createElement('style');
      s.textContent = '*, *::before, *::after { font-family: "DejaVu Sans", sans-serif !important; } code, pre, .mono { font-family: "DejaVu Sans Mono", monospace !important; } * { caret-color: transparent !important; } *, *::before, *::after { transition: none !important; animation: none !important; }';
      document.head.appendChild(s);
    });
  })();`;

function comparer(a, b) {
  if (a.width !== b.width || a.height !== b.height) return { differents: a.width * a.height, total: a.width * a.height, diff: null };
  const diff = new PNG({ width: a.width, height: a.height });
  let differents = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    const diffPixel = d > TOLERANCE;
    if (diffPixel) differents++;
    // Image de différence : la référence en gris pâle, les pixels qui diffèrent en rouge.
    const gris = Math.round((a.data[i] + a.data[i + 1] + a.data[i + 2]) / 3 * 0.25 + 190);
    diff.data[i] = diffPixel ? 220 : gris; diff.data[i + 1] = diffPixel ? 30 : gris; diff.data[i + 2] = diffPixel ? 30 : gris; diff.data[i + 3] = 255;
  }
  return { differents, total: a.width * a.height, diff };
}

(async () => {
  const navigateur = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  let ok = 0, ko = 0, nouvelles = 0;
  for (const sc of SCENARIOS) {
    const ctx = await navigateur.newContext({ viewport: sc.viewport, colorScheme: sc.colorScheme, isMobile: sc.mobile, hasTouch: sc.mobile,
                                              locale: 'fr-FR', timezoneId: 'Europe/Paris', deviceScaleFactor: 1, reducedMotion: 'reduce' });
    await ctx.addInitScript(INIT);
    const page = await ctx.newPage();
    // Horloge figée : la démonstration (12 h d'historique, consignes jour/nuit)
    // se construit toujours au même instant, puis avance d'un pas connu.
    await page.clock.install({ time: new Date('2026-10-13T14:30:00') });
    const erreurs = [];
    page.on('pageerror', e => erreurs.push(e.message));
    await page.goto(DEMO);
    await page.clock.runFor(6000);
    for (const [ecran, action] of ECRANS) {
      await page.evaluate(action);
      await page.clock.runFor(1500);
      await page.waitForTimeout(150);
      const nom = `${sc.nom}-${ecran}.png`;
      const capture = PNG.sync.read(await page.screenshot({ animations: 'disabled' }));
      const ref = path.join(REFERENCES, nom);
      if (METTRE_A_JOUR || !fs.existsSync(ref)) {
        fs.writeFileSync(ref, PNG.sync.write(capture));
        nouvelles++;
        console.log(`   [ REF ] ${nom.padEnd(32)} référence ${METTRE_A_JOUR ? 'mise à jour' : 'créée'}`);
        continue;
      }
      const reference = PNG.sync.read(fs.readFileSync(ref));
      const r = comparer(reference, capture);
      const pct = r.total ? r.differents / r.total * 100 : 100;
      const bon = pct <= SEUIL;
      if (bon) ok++; else ko++;
      console.log(`   ${bon ? '[ OK ]' : '[ECHEC]'} ${nom.padEnd(32)} ${pct.toFixed(2)} % de pixels différents (seuil ${SEUIL} %)`);
      if (!bon) {
        fs.writeFileSync(path.join(SORTIE, 'diff-' + nom), r.diff ? PNG.sync.write(r.diff) : Buffer.alloc(0));
        fs.writeFileSync(path.join(SORTIE, 'actuel-' + nom), PNG.sync.write(capture));
      }
    }
    if (erreurs.length) { ko++; console.log(`   [ECHEC] ${sc.nom} : erreur de page ${erreurs[0]}`); }
    await ctx.close();
  }
  await navigateur.close();
  if (nouvelles) console.log(`\n${nouvelles} référence(s) écrite(s) dans ${path.relative(process.cwd(), REFERENCES)} : à relire à l'œil, puis à valider.`);
  console.log(`\n=== ${ko ? 'REGRESSION VISUELLE' : 'RENDU CONFORME AUX REFERENCES'} (${ok} conforme(s), ${ko} écart(s), ${nouvelles} nouvelle(s)) ===`);
  process.exit(ko ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
