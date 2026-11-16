#!/usr/bin/env node
'use strict';
/* =============================================================================
   Adresse du serveur Terrariums, écrite dans l'application au déploiement.
   -----------------------------------------------------------------------------
   L'hébergeur de l'application (Netlify) fournit la variable d'environnement
   TERRARIUM_SERVEUR : https://hôte[:port], sans chemin. preparer-publication.js
   la recopie dans la balise <meta name="terrarium-serveur"> de app/index.html
   et de app/atelier.html publiées : « Se connecter » mène alors droit au
   compte, et l'atelier vise ce serveur, sans adresse à saisir.

   Le dépôt garde la balise vide : elle passe avant la détection du serveur qui
   sert l'application (SERVIR_APP=1), et les tests locaux viseraient sinon la
   production. La vérification ci-dessous (CI) le contrôle aussi.

     node adresse-serveur.js --verifier
   ============================================================================= */

const fs = require('fs');
const path = require('path');

const BALISE = /<meta name="terrarium-serveur" content="[^"]*">/;

/** L'origine https:// de la valeur donnée, ou une erreur qui dit ce qui ne va pas. */
function adresseServeur(valeur) {
  const texte = String(valeur == null ? '' : valeur).trim();
  let u;
  try { u = new URL(texte); } catch (e) { throw new Error(`TERRARIUM_SERVEUR « ${texte} » : adresse illisible (https://hôte attendu)`, { cause: e }); }
  if (u.protocol !== 'https:') throw new Error(`TERRARIUM_SERVEUR « ${texte} » : https:// exigé`);
  if (u.username || u.password) throw new Error('TERRARIUM_SERVEUR : pas d\'identifiants dans l\'adresse');
  if (u.pathname !== '/' || u.search || u.hash) throw new Error(`TERRARIUM_SERVEUR « ${texte} » : l'adresse du serveur seule, sans chemin`);
  return u.origin;
}

/** La page avec la balise remplie ; erreur si la balise a disparu de la page. */
function ecrireBalise(html, adresse, page = 'app/index.html') {
  if (!BALISE.test(html)) throw new Error(`${page} : balise <meta name="terrarium-serveur"> introuvable`);
  return html.replace(BALISE, `<meta name="terrarium-serveur" content="${adresse}">`);
}

// Les pages qui reçoivent l'adresse au déploiement.
const PAGES = ['index.html', 'atelier.html'];

module.exports = { adresseServeur, ecrireBalise, PAGES };

if (require.main === module && process.argv.includes('--verifier')) {
  const assert = require('assert');
  const erreur = (v) => assert.throws(() => adresseServeur(v), Error, `« ${v} » aurait dû être refusée`);

  assert.strictEqual(adresseServeur('https://socle-chauffant.duckdns.org'), 'https://socle-chauffant.duckdns.org');
  assert.strictEqual(adresseServeur('  https://Socle-Chauffant.duckdns.org/  '), 'https://socle-chauffant.duckdns.org');
  assert.strictEqual(adresseServeur('https://api.exemple.fr:8443'), 'https://api.exemple.fr:8443');
  for (const v of ['', 'socle.duckdns.org', 'http://socle.duckdns.org', 'https://socle.duckdns.org/api',
                   'https://socle.duckdns.org/?x=1', 'https://socle.duckdns.org/#a', 'https://u:p@socle.duckdns.org',
                   'wss://socle.duckdns.org', 'https://"><script>']) erreur(v);

  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'app', page), 'utf8');
    const balise = BALISE.exec(html);
    assert.ok(balise, `app/${page} : balise <meta name="terrarium-serveur"> absente`);
    assert.strictEqual(balise[0], '<meta name="terrarium-serveur" content="">',
      `app/${page} : la balise doit rester vide dans le dépôt (adresse fixée au déploiement par TERRARIUM_SERVEUR)`);
    const publiee = ecrireBalise(html, 'https://socle-chauffant.duckdns.org', `app/${page}`);
    assert.ok(publiee.includes('<meta name="terrarium-serveur" content="https://socle-chauffant.duckdns.org">'));
    assert.strictEqual(publiee.replace(BALISE, '<meta name="terrarium-serveur" content="">'), html, 'seule la balise change');
  }
  assert.throws(() => ecrireBalise('<html></html>', 'https://x.fr'), /introuvable/);

  console.log('=== ADRESSE DU SERVEUR : balise vide dans le dépôt, TERRARIUM_SERVEUR contrôlée ===');
}
