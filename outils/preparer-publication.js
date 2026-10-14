#!/usr/bin/env node
/* =============================================================================
   Prépare app/ pour la publication (commande de build Netlify, voir netlify.toml).
   -----------------------------------------------------------------------------
   L'application reste des fichiers lisibles dans le dépôt. Quatre choses sont
   faites au moment du déploiement, parce qu'elles dépendent de lui :

     1. app/version.json — version, commit et date, lus par l'application pour
        s'afficher et pour le rapport de diagnostic ; et la version du firmware
        de la dernière release, pour proposer la mise à jour des socles.
     2. Le nom du cache de l'agent de service (sw.js) devient
        « terrariums-<commit> » : chaque publication installe son propre cache,
        plus de constante à incrémenter à la main.
     3. app/firmware/ — les binaires de la dernière release GitHub et le
        manifeste lu par la page « Flasher un socle » (ESP Web Tools). Sans
        release, le dossier reste vide et la page le dit.
     4. app.js, mqtt.js et sw.js sont minifiés (terser) avec leur source map :
        un tiers de moins à télécharger, et les erreurs restent lisibles dans
        le diagnostic grâce aux .map. Les sources du dépôt ne bougent pas.

   Hors Netlify (en local) : node preparer-publication.js --sans-firmware [--sans-minifier]
   Le dépôt ne doit PAS contenir version.json, firmware/ ni *.map : ils sont
   produits ici, à chaque déploiement.
   ============================================================================= */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const APP = path.join(__dirname, '..', 'app');
const DEPOT = 'NoeMrct/terrarium_thermostat';
const sansFirmware = process.argv.includes('--sans-firmware');
const sansMinifier = process.argv.includes('--sans-minifier');

// --- 1. version.json ----------------------------------------------------------
function commit() {
  const env = process.env.COMMIT_REF || process.env.GITHUB_SHA || '';
  if (env) return env;
  try { return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch (e) { return ''; }
}
function versionDepuisChangelog() {
  try {
    const m = /^## \[(\d+\.\d+\.\d+)\]/m.exec(fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8'));
    if (m) return m[1];
  } catch (e) { /* pas de changelog */ }
  return '0.0.0';
}
const sha = commit();
const version = { version: versionDepuisChangelog(), commit: sha.slice(0, 12), date: new Date().toISOString().slice(0, 10),
                  contexte: process.env.CONTEXT || 'local' };
function ecrireVersion() { fs.writeFileSync(path.join(APP, 'version.json'), JSON.stringify(version) + '\n'); }
ecrireVersion();
console.log(`version.json : ${version.version} (${version.commit || 'sans commit'})`);

// --- 2. nom du cache de l'agent de service -------------------------------------
const swChemin = path.join(APP, 'sw.js');
const sw = fs.readFileSync(swChemin, 'utf8');
const nomCache = `terrariums-${(sha || Date.now().toString(36)).slice(0, 10)}`;
const swNouveau = sw.replace(/const CACHE = '[^']+';/, `const CACHE = '${nomCache}';`);
if (!swNouveau.includes(`'${nomCache}'`)) { console.error('sw.js : constante CACHE introuvable'); process.exit(1); }
fs.writeFileSync(swChemin, swNouveau);
console.log(`sw.js : cache ${nomCache}`);

// --- 3. firmware publié -------------------------------------------------------
const dossierFw = path.join(APP, 'firmware');
fs.mkdirSync(dossierFw, { recursive: true });

async function telecharger(url, destination) {
  const r = await fetch(url, { headers: { 'User-Agent': 'terrariums-netlify' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`${url} : HTTP ${r.status}`);
  fs.writeFileSync(destination, Buffer.from(await r.arrayBuffer()));
  return fs.statSync(destination).size;
}

module.exports = { version };

// --- 4. minification ------------------------------------------------------------
async function minifier() {
  if (sansMinifier) { console.log('minification : ignorée (--sans-minifier)'); return; }
  let terser;
  try { terser = require('terser'); }
  catch (e) { console.log('minification : terser absent (npm ci dans outils/), fichiers laissés tels quels'); return; }
  for (const nom of ['app.js', 'mqtt.js', 'sw.js']) {
    const chemin = path.join(APP, nom);
    const source = fs.readFileSync(chemin, 'utf8');
    const r = await terser.minify({ [nom]: source }, {
      compress: { passes: 2, drop_debugger: true }, mangle: true, ecma: 2020,
      format: { comments: false, preamble: `/* ${nom} — minifié au déploiement, source : ${nom}.map */` },
      sourceMap: { filename: nom, url: nom + '.map', includeSources: true }
    });
    if (r.error) throw r.error;
    fs.writeFileSync(chemin, r.code);
    fs.writeFileSync(chemin + '.map', r.map);
    console.log(`minification : ${nom} ${source.length} -> ${r.code.length} octets`);
  }
}

(async () => {
  await minifier();
  if (sansFirmware) { console.log('firmware : ignoré (--sans-firmware)'); return; }
  let release;
  try {
    const r = await fetch(`https://api.github.com/repos/${DEPOT}/releases/latest`, {
      headers: { 'User-Agent': 'terrariums-netlify', Accept: 'application/vnd.github+json' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    release = await r.json();
  } catch (e) {
    console.log(`firmware : aucune release lisible (${e.message}) — la page de flashage le dira`);
    return;
  }
  const versionFw = String(release.tag_name || '').replace(/^v/, '');
  // L'application compare cette version à celle de chaque socle et propose la
  // mise à jour tirée (action « maj ») quand elle est plus récente.
  if (/^\d+\.\d+\.\d+$/.test(versionFw)) {
    version.firmware = { version: versionFw, date: String(release.published_at || '').slice(0, 10) };
    ecrireVersion();
    console.log(`version.json : firmware publié ${versionFw}`);
  }
  // Les quatre morceaux flashés à leur adresse : la NVS (réglages, code
  // d'appairage) entre 0x9000 et 0xE000 n'est pas touchée, contrairement à une
  // image fusionnée qui l'écraserait.
  const parts = [
    ['bootloader.bin', 0x1000], ['partitions.bin', 0x8000], ['boot_app0.bin', 0xe000], ['firmware.bin', 0x10000]
  ];
  const actifs = [];
  for (const [nom, offset] of parts) {
    const asset = (release.assets || []).find(a => a.name === `terrarium-${versionFw}-${nom}` || a.name === nom);
    if (!asset) { console.log(`firmware : ${nom} absent de la release ${versionFw}`); return; }
    const chemin = path.join(dossierFw, nom);
    const taille = await telecharger(asset.browser_download_url, chemin);
    actifs.push({ path: nom, offset, size: taille });
    console.log(`firmware : ${nom} (${(taille / 1024).toFixed(0)} Ko)`);
  }
  const manifeste = {
    name: 'Socle chauffant', version: versionFw, date: String(release.published_at || '').slice(0, 10),
    new_install_prompt_erase: true,
    builds: [{ chipFamily: 'ESP32', parts: actifs.map(p => ({ path: p.path, offset: p.offset, size: p.size })) }]
  };
  fs.writeFileSync(path.join(dossierFw, 'manifest.json'), JSON.stringify(manifeste, null, 2) + '\n');
  console.log(`firmware : manifeste écrit pour la version ${versionFw}`);
})().catch(e => { console.error(e); process.exit(1); });
