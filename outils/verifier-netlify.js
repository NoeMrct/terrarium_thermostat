#!/usr/bin/env node
'use strict';
/* =============================================================================
   Vérifie les en-têtes de netlify.toml au regard des pages de app/.
   -----------------------------------------------------------------------------
   Netlify sert app/x.html à deux adresses, /x.html et /x, mais choisit les
   en-têtes d'après l'adresse demandée. Ouverte à /demo, la démonstration
   recevait ainsi la politique générale, qui refuse scripts et style en ligne :
   page brute, sans mise en forme ni script. Deux contrôles :

   1. une règle propre à une page existe pour ses deux adresses, avec les mêmes
      valeurs (et vise une page qui existe) ;
   2. une page qui contient du script ou du style en ligne reçoit, à chacune de
      ses adresses, une politique (CSP) qui les autorise — celle des en-têtes
      comme celle qu'elle déclare elle-même.

   Les en-têtes sont combinés comme Netlify le fait (constaté en production) :
   de toutes les règles qui visent une adresse, la dernière du fichier
   l'emporte pour un même en-tête.

     node verifier-netlify.js [chemin/vers/netlify.toml]
   ============================================================================= */

const fs = require('fs');
const path = require('path');

const RACINE = path.join(__dirname, '..');
const APP = path.join(RACINE, 'app');
const FICHIER = process.argv[2] ? path.resolve(process.argv[2]) : path.join(RACINE, 'netlify.toml');

// Les règles [[headers]], dans l'ordre du fichier : { pour, valeurs, ligne }.
// Lecteur restreint à ce que le fichier emploie (sections, « clé = "valeur" »
// sur une ligne, commentaires #) : dans une règle d'en-têtes, une forme
// inconnue fait échouer la vérification au lieu d'être ignorée.
function lireRegles(texte) {
  const regles = [];
  let regle = null, dansValeurs = false;
  texte.split(/\r?\n/).forEach((brute, i) => {
    const l = brute.trim();
    if (!l || l.startsWith('#')) return;
    if (l.startsWith('[')) {
      if (l === '[[headers]]') { regle = { pour: null, valeurs: {}, ligne: i + 1 }; regles.push(regle); dansValeurs = false; }
      else if (l === '[headers.values]' && regle) dansValeurs = true;
      else { regle = null; dansValeurs = false; }   // [build], [[redirects]]…
      return;
    }
    if (!regle) return;
    const m = /^([A-Za-z0-9-]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(l);
    if (!m) throw new Error(`ligne ${i + 1} : forme non comprise dans une règle d'en-têtes : ${l}`);
    if (dansValeurs) regle.valeurs[m[1]] = m[2];
    else if (m[1] === 'for') regle.pour = m[2];
    else throw new Error(`ligne ${i + 1} : clé « ${m[1]} » inattendue avant [headers.values]`);
  });
  return regles;
}

const exact = motif => !/[*:]/.test(motif);

// Le motif d'une règle vise-t-il l'adresse ? « * » : n'importe quelle suite,
// « :nom » : un segment.
function vise(motif, adresse) {
  const re = motif.split(/(\*|:[A-Za-z]+)/).map(p => p === '*' ? '.*' : /^:[A-Za-z]+$/.test(p) ? '[^/]+'
    : p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp('^' + re + '$').test(adresse);
}

// Les en-têtes envoyés à une adresse : la dernière règle qui la vise l'emporte.
function enTetes(regles, adresse) {
  const r = {};
  for (const regle of regles) if (regle.pour && vise(regle.pour, adresse)) Object.assign(r, regle.valeurs);
  return r;
}

// Les adresses auxquelles Netlify sert une page de app/.
function adresses(page) {
  const nom = page.replace(/\.html$/, '');
  return nom === 'index' ? ['/', '/index.html', '/index'] : ['/' + page, '/' + nom];
}

// Une politique autorise-t-elle le contenu en ligne, d'après la première
// directive présente de la liste de repli ? Un nonce, une empreinte ou
// 'strict-dynamic' font ignorer 'unsafe-inline' par le navigateur.
function autoriseEnLigne(politique, repli) {
  const directives = new Map(politique.split(';').map(d => d.trim().split(/\s+/)).filter(d => d[0])
    .map(([nom, ...valeurs]) => [nom.toLowerCase(), valeurs]));
  const nom = repli.find(n => directives.has(n));
  if (!nom) return true;
  const v = directives.get(nom);
  return v.includes("'unsafe-inline'") && !v.some(s => /^'(nonce-|sha(256|384|512)-|strict-dynamic')/.test(s));
}

const REPLIS = {
  'un script en ligne': ['script-src-elem', 'script-src', 'default-src'],
  'une balise <style>': ['style-src-elem', 'style-src', 'default-src'],
  'un attribut style': ['style-src-attr', 'style-src', 'default-src']
};

// Ce que la page contient en ligne, et les politiques qu'elle déclare elle-même.
function analyser(html) {
  const contenus = [];
  const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)].map(m => m[1])
    .filter(a => !/\bsrc\s*=/i.test(a) && !/\btype\s*=\s*["']?(application\/(ld\+)?json|importmap)/i.test(a));
  if (scripts.length) contenus.push('un script en ligne');
  if (/<style\b/i.test(html)) contenus.push('une balise <style>');
  if (/<[a-z][^>]*\sstyle\s*=/i.test(html)) contenus.push('un attribut style');
  const metas = [...html.matchAll(/<meta\b[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi)]
    .map(m => (/\bcontent\s*=\s*"([^"]*)"/i.exec(m[0]) || /\bcontent\s*=\s*'([^']*)'/i.exec(m[0]) || [])[1])
    .filter(Boolean);
  return { contenus, metas };
}

let regles;
try {
  regles = lireRegles(fs.readFileSync(FICHIER, 'utf8'));
} catch (e) {
  console.error(`${path.relative(RACINE, FICHIER) || FICHIER} : ${e.message}`);
  process.exit(1);
}
const pages = fs.readdirSync(APP).filter(f => f.endsWith('.html')).sort();
const erreurs = new Set();   // un même écart vu des deux règles n'est dit qu'une fois

// 1. Règles propres à une page : présentes aux deux adresses, identiques.
const parAdresse = new Map();
for (const r of regles) {
  if (!r.pour) { erreurs.add(`règle de la ligne ${r.ligne} sans « for »`); continue; }
  if (parAdresse.has(r.pour)) erreurs.add(`deux règles pour ${r.pour} (lignes ${parAdresse.get(r.pour).ligne} et ${r.ligne})`);
  else parAdresse.set(r.pour, r);
}
const memes = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
for (const r of parAdresse.values()) {
  if (!exact(r.pour) || /\.(?!html$)[a-z0-9]+$/i.test(r.pour)) continue;   // motif, ou fichier qui n'est pas une page
  const page = r.pour.endsWith('/') ? r.pour.slice(1) + 'index.html' : r.pour.slice(1).replace(/\.html$/, '') + '.html';
  if (!pages.includes(page)) { erreurs.add(`la règle ${r.pour} (ligne ${r.ligne}) vise une page absente : app/${page}`); continue; }
  for (const autre of adresses(page).filter(a => a !== r.pour)) {
    const jumelle = parAdresse.get(autre);
    if (!jumelle) erreurs.add(`${r.pour} a sa règle (ligne ${r.ligne}), pas ${autre} : Netlify y sert la même page avec les en-têtes généraux`);
    else if (!memes(jumelle.valeurs, r.valeurs)) {
      const [a, b] = [r, jumelle].sort((x, y) => x.ligne - y.ligne);
      erreurs.add(`les règles ${a.pour} (ligne ${a.ligne}) et ${b.pour} (ligne ${b.ligne}) diffèrent`);
    }
  }
}

// 2. Contenu en ligne autorisé à chaque adresse de la page.
let enLigne = 0;
for (const page of pages) {
  const { contenus, metas } = analyser(fs.readFileSync(path.join(APP, page), 'utf8'));
  if (!contenus.length) continue;
  enLigne++;
  for (const adresse of adresses(page)) {
    const csp = enTetes(regles, adresse)['Content-Security-Policy'];
    const politiques = [...(csp ? csp.split(',').map(p => ['en-tête', p]) : []), ...metas.map(p => ['balise meta', p])];
    for (const contenu of contenus)
      for (const [origine, p] of politiques)
        if (!autoriseEnLigne(p, REPLIS[contenu]))
          erreurs.add(`app/${page} contient ${contenu} ; à ${adresse}, la politique (${origine}) l'interdit`);
  }
}

for (const e of erreurs) console.log(`   [ECHEC] ${e}`);
console.log(erreurs.size ? `\n=== EN-TETES NETLIFY INCOHERENTS (${erreurs.size}) ===`
  : `\n=== EN-TETES NETLIFY COHERENTS (${regles.length} règles, ${pages.length} pages dont ${enLigne} avec du contenu en ligne) ===`);
process.exit(erreurs.size ? 1 : 0);
