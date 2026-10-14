#!/usr/bin/env node
/* =============================================================================
   Génère les icônes PNG de l'application à partir de app/icone.svg.
   -----------------------------------------------------------------------------
   iOS ignore les icônes SVG du manifest et Android préfère des PNG : sans eux,
   l'installation sur l'écran d'accueil montre une capture floue de la page.

     - icones/icone-192.png, icone-512.png : icône telle quelle (coins arrondis,
       fond transparent autour) ;
     - icones/icone-maskable-512.png : fond plein, dessin réduit dans la zone
       sûre, pour les masques Android ;
     - icones/apple-touch-icon.png : 180 px, fond plein (iOS arrondit lui-même).

   Dépend de Playwright (npm install playwright) et d'un Chromium :
     npx playwright install chromium
     node generer-icones.js
   ============================================================================= */

const fs = require('fs');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  console.error('Playwright est nécessaire : npm install --no-save playwright && npx playwright install chromium');
  process.exit(2);
}

const APP = path.join(__dirname, '..', 'app');
const SORTIE = path.join(APP, 'icones');
const svg = fs.readFileSync(path.join(APP, 'icone.svg'), 'utf8');
const FOND = (/<rect[^>]*fill="(#[0-9a-f]{3,6})"/i.exec(svg) || [])[1] || '#15803d';
const donnees = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');

async function rendre(page, taille, { plein, echelle }) {
  await page.setViewportSize({ width: taille, height: taille });
  await page.setContent(`<!doctype html><style>
    html,body{margin:0;width:${taille}px;height:${taille}px;overflow:hidden;background:${plein ? FOND : 'transparent'}}
    img{position:absolute;left:50%;top:50%;width:${Math.round(taille * echelle)}px;height:${Math.round(taille * echelle)}px;transform:translate(-50%,-50%)}
    </style><img src="${donnees}">`);
  await page.waitForTimeout(100);
  return page.screenshot({ omitBackground: !plein, type: 'png' });
}

(async () => {
  fs.mkdirSync(SORTIE, { recursive: true });
  const navigateur = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await navigateur.newPage({ deviceScaleFactor: 1 });
  const fichiers = [
    ['icone-192.png', 192, { plein: false, echelle: 1 }],
    ['icone-512.png', 512, { plein: false, echelle: 1 }],
    // Zone sûre des icônes masquables : un cercle de 80 % ; à 72 % le dessin y tient.
    ['icone-maskable-512.png', 512, { plein: true, echelle: 0.72 }],
    ['apple-touch-icon.png', 180, { plein: true, echelle: 0.9 }]
  ];
  for (const [nom, taille, opts] of fichiers) {
    const png = await rendre(page, taille, opts);
    fs.writeFileSync(path.join(SORTIE, nom), png);
    console.log(`${nom.padEnd(26)} ${taille}×${taille}  ${(png.length / 1024).toFixed(1)} Ko`);
  }
  await navigateur.close();
})().catch(e => { console.error(e); process.exit(1); });
