#!/usr/bin/env node
/* =============================================================================
   L'installation du firmware dans la fiche de l'atelier, dans un vrai Chromium.
   -----------------------------------------------------------------------------
   L'atelier se sert du moteur d'ESP Web Tools (app/installateur/) sans ouvrir
   sa fenêtre : il crée l'élément sans l'insérer, branche son propre suivi sur
   les états de l'installation et lui prête un port qu'il ne rouvre pas après.
   Ce banc charge la vraie copie servie par le site, sous la politique de
   sécurité de la page (Trusted Types compris), avec un port série simulé qui
   ne répond pas, comme une carte qu'on n'arrive pas à réveiller :

     - les états arrivent (connexion, puis erreur « failed_initialize ») ;
     - l'erreur revient à l'atelier au lieu de rester dans une fenêtre ;
     - le port est refermé à la fin (la console de l'atelier pourra le rouvrir) ;
     - rien n'est inséré dans la page, et aucune violation de la politique.

   Une écriture réelle demande une carte : c'est le rôle de l'atelier lui-même.

     CHROMIUM=/chemin/vers/chrome node test-installation.js
   ============================================================================= */

/* global window, document, ReadableStream, WritableStream, DOMException */
const { servirApp } = require('./servir-app');
let playwright;
try { playwright = require('playwright'); }
catch (e) { console.error('Playwright est nécessaire : npm install --no-save playwright && npx playwright install chromium'); process.exit(2); }

let ok = 0, ko = 0;
const v = (q, c, d = '') => { console.log(`   ${c ? '[ OK ]' : '[ECHEC]'} ${q.padEnd(62)} ${String(d).slice(0, 80)}`); c ? ok++ : ko++; };

(async () => {
  const serveur = servirApp({ port: 0 });
  const port = serveur.address().port;
  const nav = await playwright.chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await nav.newPage();
  const erreurs = [];
  // Le moteur journalise lui-même l'échec attendu (« Failed to connect with the device ») : tout le reste compte.
  page.on('console', m => { if (m.type() === 'error' && !/Failed to connect with the device/.test(m.text())) erreurs.push(m.text()); });
  page.on('pageerror', e => erreurs.push(String(e)));
  // Le manifeste qu'écrit la publication : une partie, jamais téléchargée ici (la carte ne répond pas avant).
  await page.route('**/firmware/manifest.json', r => r.fulfill({ contentType: 'application/json',
    body: JSON.stringify({ name: 'Socle chauffant', version: '9.9.9', new_install_prompt_erase: true, builds: [{ chipFamily: 'ESP32', parts: [{ path: 'terrarium.bin', offset: 0 }] }] }) }));
  await page.goto(`http://localhost:${port}/atelier.html`);
  await page.evaluate(() => {
    window.violations = [];
    document.addEventListener('securitypolicyviolation', e => window.violations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });

  const r = await page.evaluate(async () => {
    // Un port série qui s'ouvre et se ferme, mais où la carte ne répond jamais.
    class PortMuet {
      constructor() { this.readable = null; this.writable = null; this.ouvertures = 0; this.fermetures = 0; this.signaux = 0; this.ecrits = 0; }
      getInfo() { return { usbVendorId: 0x10c4, usbProductId: 0xea60 }; }
      async open() {
        if (this.readable) throw new DOMException('The port is already open.', 'InvalidStateError');
        this.ouvertures++;
        this.readable = new ReadableStream({ start() {} });
        this.writable = new WritableStream({ write: () => { this.ecrits++; } });
      }
      async close() {
        if (!this.readable) throw new DOMException('The port is already closed.', 'InvalidStateError');
        this.fermetures++;
        this.readable = null; this.writable = null;
      }
      async setSignals() { this.signaux++; }
    }
    const p = new PortMuet();
    const etats = [];
    const debut = Date.now();
    let fin, erreur = '';
    try { fin = await window.Atelier._installerPage(p, { effacer: false, suivre: e => etats.push(e.state) }); }
    catch (e) { erreur = String(e && e.message || e); }
    return { etats, fin: fin ? { state: fin.state, erreur: fin.details && fin.details.error } : null, erreur, duree: Date.now() - debut,
      ouvert: !!p.readable, ouvertures: p.ouvertures, fermetures: p.fermetures, signaux: p.signaux, ecrits: p.ecrits,
      dialogue: !!document.querySelector('ewt-install-dialog'), defini: !!window.customElements.get('ewt-install-dialog') };
  });
  v('le moteur d\'ESP Web Tools est chargé (élément défini)', r.defini);
  v('l\'installation passe par la connexion à la carte', r.etats[0] === 'initializing', r.etats.join(' → '));
  v('carte muette : erreur « failed_initialize » rendue à l\'atelier', r.fin && r.fin.state === 'error' && r.fin.erreur === 'failed_initialize', JSON.stringify(r.fin) + ' ' + r.erreur);
  v('le moteur a parlé à la carte (signaux de réinitialisation, octets)', r.signaux > 0 && r.ecrits > 0, `${r.signaux} signaux, ${r.ecrits} écritures`);
  v('le port est refermé à la fin (la console pourra le rouvrir)', !r.ouvert && r.ouvertures === r.fermetures && r.ouvertures >= 1, `${r.ouvertures} ouverture(s), ${r.fermetures} fermeture(s)`);
  v('aucune fenêtre : rien n\'est inséré dans la page', !r.dialogue);
  const violations = await page.evaluate(() => window.violations);
  v('aucune violation de la politique de sécurité (Trusted Types compris)', violations.length === 0, violations.join(' | '));
  v('aucune erreur dans la console', erreurs.length === 0, erreurs.join(' | '));
  console.log(`   (abandon de la carte muette en ${(r.duree / 1000).toFixed(1)} s)`);

  await nav.close();
  serveur.close();
  console.log(`\n=== INSTALLATION (${ok} reussite(s), ${ko} echec(s)) ===`);
  process.exit(ko ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
