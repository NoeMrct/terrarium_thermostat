#!/usr/bin/env node
/* =============================================================================
   Imprime la documentation en PDF : la fiche de démarrage rapide (recto
   français, verso anglais) et les deux manuels (aide.html, aide.en.html).
   -----------------------------------------------------------------------------
   Les PDF sont joints à chaque release GitHub (.github/workflows/publication.yml)
   pour qu'un acheteur ait quelque chose à imprimer et à glisser dans la boîte,
   sans passer par le site. Le rendu est celui de Chromium, avec les règles
   @media print de app/style.css : une seule source pour l'écran et le papier.

     node construire-pdf.js                 # écrit outils/pdf/*.pdf
     node construire-pdf.js --sortie dist   # ailleurs

   Dépend de Playwright (même version que la CI, voir package.json).
   ============================================================================= */

const fs = require('fs');
const http = require('http');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { console.error('Playwright est nécessaire : npm install --no-save playwright@1.56.0 && npx playwright install chromium'); process.exit(2); }

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const APP = path.resolve(__dirname, '..', 'app');
const SORTIE = path.resolve(arg('sortie', path.join(__dirname, 'pdf')));
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

// Les pages servies en HTTP plutôt qu'en file:// : la CSP des pages (base-uri,
// style-src 'self') se comporte alors exactement comme sur le site.
const serveur = http.createServer((req, res) => {
  const f = path.join(APP, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(f, (e, d) => {
    if (e) { res.statusCode = 404; res.end('absent'); return; }
    res.setHeader('Content-Type', TYPES[path.extname(f)] || 'application/octet-stream');
    res.end(d);
  });
}).listen(0);

const DOCUMENTS = [
  { page: 'demarrage-rapide.html', pdf: 'demarrage-rapide.pdf', titre: 'Démarrage rapide / Quick start' },
  { page: 'aide.html', pdf: 'manuel.pdf', titre: 'Manuel du socle chauffant', entete: true },
  { page: 'aide.en.html', pdf: 'manual.en.pdf', titre: 'Heating base manual', entete: true }
];

(async () => {
  const port = serveur.address().port;
  fs.mkdirSync(SORTIE, { recursive: true });
  const navigateur = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const ctx = await navigateur.newContext({ colorScheme: 'light', locale: 'fr-FR' });
  const page = await ctx.newPage();
  const erreurs = [];
  page.on('pageerror', e => erreurs.push(e.message));
  page.on('console', m => { if (m.type() === 'error') erreurs.push(m.text()); });
  let echecs = 0;
  for (const d of DOCUMENTS) {
    await page.goto(`http://localhost:${port}/${d.page}`, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    // Les manuels gardent l'en-tête et le pied imprimés (titre, numéro de page) ;
    // la fiche de démarrage rapide, non : elle doit tenir sur une feuille.
    const sortie = path.join(SORTIE, d.pdf);
    await page.pdf({
      path: sortie, format: 'A4', printBackground: true, preferCSSPageSize: true,
      margin: d.entete ? { top: '18mm', bottom: '16mm', left: '14mm', right: '14mm' } : undefined,
      displayHeaderFooter: !!d.entete,
      headerTemplate: `<div style="font-size:8px;color:#666;width:100%;padding:0 14mm;font-family:sans-serif">${d.titre}</div>`,
      footerTemplate: '<div style="font-size:8px;color:#666;width:100%;padding:0 14mm;text-align:right;font-family:sans-serif"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'
    });
    const taille = fs.statSync(sortie).size;
    const ok = taille > 2000;
    if (!ok) echecs++;
    console.log(`   ${ok ? '[ OK ]' : '[ECHEC]'} ${d.pdf.padEnd(24)} ${(taille / 1024).toFixed(0)} Ko`);
  }
  await navigateur.close();
  serveur.close();
  if (erreurs.length) { console.error('Erreurs de page :\n  ' + erreurs.join('\n  ')); echecs++; }
  console.log(echecs ? `\n${echecs} échec(s)` : `\nPDF écrits dans ${SORTIE}`);
  process.exit(echecs ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
