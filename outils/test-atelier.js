#!/usr/bin/env node
/* =============================================================================
   Test de l'atelier (app/atelier.html + atelier.js) dans jsdom.
   -----------------------------------------------------------------------------
   Sans matériel ni broker : le port série est simulé par une console qui
   répond comme le firmware (mêmes textes que console.cpp), et le banc par un
   petit broker en mémoire avec un socle qui vérifie la signature de chaque
   commande (protocole 4, HMAC du code d'appairage lu à l'étape 1). On monte
   des socles du début à la fin : console, sondes, chauffe, rodage, étiquette,
   expédition ; et les chemins d'échec : auto-test raté, mauvais socle à
   l'étiquette, firmware sans « wifi off », mise de côté. Puis ce qui marche
   seul : Wi-Fi proposé par le socle (Improv), sondes enchaînées, étiquette
   imprimée d'office, carte branchée qui lance son étape, registre partagé
   entre deux postes par un faux serveur (révisions, conflits, Wi-Fi commun,
   rodage conclu par le serveur), rôle atelier.

     node test-atelier.js
   ============================================================================= */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { JSDOM } = require('jsdom');

const DOSSIER = path.join(__dirname, '..', 'app');
let reussites = 0, echecs = 0;
const verifier = (quoi, ok, detail = '') => {
  console.log(`   ${ok ? '[ OK ]' : '[ECHEC]'} ${quoi.padEnd(62)} ${detail}`);
  ok ? reussites++ : echecs++;
};
const titre = t => console.log(`\n== ${t}`);
const attendre = ms => new Promise(r => setTimeout(r, ms));
async function jusqua(condition, limiteMs = 8000, pas = 40) {
  const fin = Date.now() + limiteMs;
  while (Date.now() < fin) { if (condition()) return true; await attendre(pas); }
  return false;
}

// ---------------------------------------------------------------- console USB
// Répond aux lignes comme console.cpp ; « journal » garde ce qui a été reçu.
class ConsoleSocle {
  constructor(o = {}) {
    Object.assign(this, { id: 'terraA1B2C3', code: 'K7M2QXABCDEFGH2345678JKL', firmware: '3.6.0', proto: 4,
      usineOk: true, wifiOk: true, connaitWifiOff: true, vierge: false, improv: true,
      reseaux: [{ ssid: 'AtelierBanc', rssi: -48, securise: true }, { ssid: 'Voisin', rssi: -81, securise: true }] }, o);
    this.recu = [];
    this.scans = 0;
    this.etat = { web: null, wifi: null, mqtt: null, historiqueEfface: false };
    this.sortie = () => {};
    this.sortieOctets = () => {};
  }
  dire(t, apres = 5) { setTimeout(() => this.sortie(t), apres); }
  // Improv série, comme console.cpp : le scan répond un paquet par réseau, puis un vide.
  static paquetImprov(type, donnees) {
    const p = [73, 77, 80, 82, 79, 86, 1, type, donnees.length, ...donnees];
    p.push(p.reduce((x, y) => (x + y) & 255, 0), 10);
    return Uint8Array.from(p);
  }
  improvCommande(type, d) {
    if (this.vierge || !this.improv || type !== 3 || d[0] !== 4) return;
    this.scans++;
    const chaines = c => { const o = []; for (const x of c) { const b = [...Buffer.from(x, 'utf8')]; o.push(b.length, ...b); } return [4, o.length, ...o]; };
    let delai = 30;
    for (const r of this.reseaux) { const pq = ConsoleSocle.paquetImprov(4, chaines([r.ssid, String(r.rssi), r.securise ? 'YES' : 'NO'])); setTimeout(() => this.sortieOctets(pq), delai += 5); }
    setTimeout(() => this.sortieOctets(ConsoleSocle.paquetImprov(4, [4, 0])), delai + 5);
  }
  ligne(l) {
    this.recu.push(l);
    if (this.vierge) return;                       // carte sans firmware : rien ne répond
    const j = l.split(' ').filter(Boolean);
    if (l === 'jeton') return this.dire(`Appareil ${this.id}\nCode d'appairage : ${this.code}\n`);
    if (l === 'version') return this.dire(`Firmware ${this.firmware}, compile le Nov 14 2026 09:12:00, protocole ${this.proto}\n`);
    if (l === 'test usine') {
      const v = (ok, organe, detail) => `  [${ok ? ' OK ' : 'ECHEC'}] ${organe.padEnd(14)} ${detail}\n`;
      this.dire(`\n=== TEST USINE  ${this.id}  firmware ${this.firmware} ===\n` + v(true, 'ecran', 'mire affichee 1,5 s (plein puis damier)')
        + v(this.usineOk, 'sondes', this.usineOk ? '2 detectee(s) sur 2 attendue(s)' : '1 detectee(s) sur 2 attendue(s)'), 20);
      this.dire(v(true, 'memoire NVS', 'ecriture et relecture') + v(true, 'partitions', 'deux emplacements OTA de 1920 Ko')
        + v(true, 'wifi', '6 reseau(x), meilleur signal -48 dBm')
        + '  [ -- ] MOSFET         non actionnes (`test usine oui` pour une impulsion de 300 ms par tapis)\n'
        + `=== TEST USINE : ${this.usineOk ? 'OK (0' : 'ECHEC (1'} echec(s)) ===\n\n`, 80);
      return;
    }
    if (j[0] === 'motdepasse' && j[1] === 'web') { this.etat.web = { mdp: j[2], utilisateur: j[3] }; return this.dire('Enregistre.\n'); }
    if (l === 'wifi off') {
      if (this.connaitWifiOff) { this.etat.wifi = null; return this.dire('WiFi oublie : point d\'acces de configuration au prochain demarrage.\n'); }
      this.dire("Connexion a 'off'...\n");
      return this.dire('Echec de connexion : SSID ou mot de passe refuse, rien n\'est enregistre.\n', 150);
    }
    if (j[0] === 'wifi') {
      this.dire(`Connexion a '${j[1]}'...\n`);
      if (this.wifiOk) { this.etat.wifi = { ssid: j[1], mdp: j[2] }; return this.dire('Connecte, adresse 192.168.4.57. WiFi enregistre : `redemarrer` pour passer en mode station.\n', 120); }
      return this.dire('Echec de connexion : SSID ou mot de passe refuse, rien n\'est enregistre.\n', 120);
    }
    if (l === 'mqtt off') { this.etat.mqtt = null; return this.dire('MQTT enregistre. `redemarrer` pour appliquer.\n'); }
    if (j[0] === 'mqtt' && j[1] === 'tls') return this.dire(`MQTT chiffre : oui (port 8883). \`redemarrer\` pour appliquer.\n`);
    if (j[0] === 'mqtt') { this.etat.mqtt = { hote: j[1], port: +j[2], utilisateur: j[3], mdp: j[4], tls: j[5] === 'tls' }; return this.dire('MQTT enregistre. `redemarrer` pour appliquer.\n'); }
    if (l === 'effacer-historique') { this.etat.historiqueEfface = true; return this.dire('Historique efface.\n'); }
    return this.dire('Commande inconnue. `help`.\n');
  }
}

// Port Web Serial minimal : lecteur et écrivain sans flux, ce que l'atelier utilise.
function creerPort(console_, Uint8) {
  const port = { file: [], attente: null, ouvert: false, console: console_, branche: true };
  const pousserOctets = octets => {
    const o = Uint8.from(octets);
    if (port.attente) { const r = port.attente; port.attente = null; r({ value: o, done: false }); } else port.file.push(o);
  };
  const pousser = t => pousserOctets(Buffer.from(t, 'utf8'));
  console_.sortie = t => { if (port.ouvert) pousser(t); };
  console_.sortieOctets = o => { if (port.ouvert) pousserOctets(o); };
  port.open = async () => {
    port.ouvert = true;
    port.readable = { getReader: () => ({
      read: () => (port.file.length ? Promise.resolve({ value: port.file.shift(), done: false })
        : !port.ouvert ? Promise.resolve({ done: true }) : new Promise(r => { port.attente = r; })),
      cancel: async () => { port.ouvert = false; if (port.attente) { port.attente({ done: true }); port.attente = null; } },
      releaseLock() {}
    }) };
    let tampon = '';
    const imp = [];
    port.writable = { getWriter: () => ({
      write: async o => {
        const texte = [];
        for (const b of Buffer.from(o)) {
          if (imp.length < 6) {
            if (b === [73, 77, 80, 82, 79, 86][imp.length]) { imp.push(b); continue; }
            texte.push(...imp, b); imp.length = 0; continue;
          }
          imp.push(b);
          if (imp.length >= 9 && imp.length === 9 + imp[8] + 1) {
            const type = imp[7], d = imp.slice(9, imp.length - 1);
            imp.length = 0;
            setTimeout(() => console_.improvCommande(type, d), 3);
          }
        }
        tampon += Buffer.from(texte).toString('utf8');
        let i;
        while ((i = tampon.indexOf('\n')) >= 0) { const l = tampon.slice(0, i).trim(); tampon = tampon.slice(i + 1); setTimeout(() => console_.ligne(l), 3); }
      },
      releaseLock() {}
    }) };
  };
  port.close = async () => { port.ouvert = false; };
  port.debrancher = () => { port.ouvert = false; port.branche = false; if (port.attente) { port.attente({ done: true }); port.attente = null; } };
  return port;
}

// ------------------------------------------------------------ broker et banc
function correspond(filtre, sujet) {
  const f = filtre.split('/'), s = sujet.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (f[i] !== '+' && f[i] !== s[i]) return false;
  }
  return f.length === s.length;
}
class Broker {
  constructor() { this.clients = new Set(); this.retenus = new Map(); this.connexions = []; }
  publier(sujet, charge, retain) {
    if (retain) this.retenus.set(sujet, charge);
    for (const c of this.clients) if (c.subs.some(f => correspond(f, sujet))) setTimeout(() => c.recevoir(sujet, charge, false), 1);
  }
  connect(url, opts) { const c = new Client(this, url, opts); this.connexions.push({ url, opts }); return c; }
}
class Client extends EventEmitter {
  constructor(b, url, opts) {
    super(); this.b = b; this.subs = []; this.connected = false;
    setTimeout(() => { this.connected = true; b.clients.add(this); this.emit('connect'); }, 5);
  }
  recevoir(sujet, charge, retain) { if (this.connected) this.emit('message', sujet, { toString: () => charge }, { retain }); }
  subscribe(l) {
    for (const f of [].concat(l)) {
      this.subs.push(f);
      for (const [s, c] of this.b.retenus) if (correspond(f, s)) setTimeout(() => this.recevoir(s, c, true), 1);
    }
  }
  unsubscribe(l) { const x = [].concat(l); this.subs = this.subs.filter(f => !x.includes(f)); }
  publish(sujet, charge, opts, cb) { this.b.publier(sujet, String(charge), !!(opts && opts.retain)); if (typeof cb === 'function') cb(); }
  end() { this.connected = false; this.b.clients.delete(this); this.emit('close'); }
}

// Le socle sur le banc : il répond à « cmd » et refuse une signature fausse.
class SocleBanc {
  constructor(b, o) {
    Object.assign(this, { prefixe: 'terrarium', uptime: 600, roms: ['28FF0000000000A1', '28FF0000000000B2'], echecIdent: new Set(), echecEssai: new Set(),
      version: null, connaitExpedier: true, dureeIdent: 1500, dureeEssai: 200 }, o);
    // Température de chaque sonde du bus, que les bancs font varier.
    this.tempsSondes = Object.fromEntries(this.roms.map(r => [r, 23.5]));
    this.expedition = null;
    this.b = b; this.ident = null; this.identResultat = ''; this.essai = { zone: 0, resultat: '' };
    this.refus = 0; this.liaisons = [null, null]; this.zones = [{ temp: 24.1, consigne: 32, defaut: '0', defaut_libelle: 'OK' }, { temp: 22.0, consigne: 28, defaut: '0', defaut_libelle: 'OK' }];
    this.base = `${this.prefixe}/${this.id}`;
    this.client = { subs: [`${this.base}/cmd`], recevoir: (s, c) => this.commande(c) };
    b.clients.add(this.client);
  }
  enLigne() {
    this.b.publier(`${this.base}/statut`, 'en ligne', true);
    this.b.publier(`${this.base}/sante`, JSON.stringify({ proto: 4, uptime: this.uptime, reset: 'mise sous tension', ...(this.version ? { version: this.version } : {}) }), true);
    this.zones.forEach((z, i) => this.b.publier(`${this.base}/zone${i + 1}/etat`, JSON.stringify(z), true));
  }
  repondre(req, ok, corps) { this.b.publier(`${this.base}/reponse`, JSON.stringify({ req, ok, ...corps }), false); }
  commande(charge) {
    let d = JSON.parse(charge);
    if (d.c) {
      const attendu = crypto.createHmac('sha256', this.code).update(d.c).digest('hex');
      const interieur = JSON.parse(d.c);
      if (attendu !== d.sig) { this.refus++; return this.repondre(interieur.req, false, { erreur: 'signature invalide' }); }
      d = interieur;
    } else if (!['etat', 'stats', 'version', 'historique'].includes(d.action) && d.jeton !== this.code) {
      this.refus++; return this.repondre(d.req, false, { erreur: 'jeton invalide' });
    }
    const z = d.z;
    switch (d.action) {
      case 'etat': return this.repondre(d.req, true, { uptime: this.uptime, zones: this.zones.map(x => ({ temp: x.temp, consigne: x.consigne, defaut: x.defaut === '1' ? x.defaut_libelle : null })) });
      case 'sondes': return this.repondre(d.req, true, { sondes: {
        sondes: this.roms.map(r => ({ rom: r, temp: this.tempsSondes[r], zone: this.liaisons.indexOf(r) })), parasite: false,
        liaisons: this.liaisons.map(r => (r ? { rom: r, presente: true } : null)),
        identification: this.ident !== null ? { zone: this.ident + 1, restantS: 117 } : null, resultat: this.identResultat } });
      case 'identifier':
        this.ident = z;
        setTimeout(() => {
          this.ident = null;
          if (this.echecIdent.has(z)) { this.echecIdent.delete(z); this.identResultat = `Zone ${z + 1} : identification abandonnee, aucune sonde n'a varie d'1 C a elle seule`; return; }
          const rom = this.roms[z];
          this.liaisons[z] = rom;
          this.identResultat = `Zone ${z + 1} : sonde ${rom} identifiee (+1.4 C). Sonde ${rom} liee a la zone ${z + 1}`;
        }, this.dureeIdent);
        return this.repondre(d.req, true, { message: `Zone ${z + 1} : serrez sa sonde dans la main` });
      case 'essai':
        if (z === undefined) return this.repondre(d.req, true, { essai: { zone: this.essai.zone, restantS: this.essai.zone ? 590 : 0, resultat: this.essai.resultat } });
        this.essai = { zone: z + 1, resultat: '' };
        setTimeout(() => {
          this.essai = { zone: 0, resultat: this.echecEssai.has(z)
            ? `zone ${z + 1} : ECHEC, +0.1 C en 10 min. Verifier le 12 V, le tapis, son bilame, le MOSFET (D25), et que la sonde est bien sur la plaque.`
            : `zone ${z + 1} OK : sa sonde a pris +0.6 C en 1 min 05 s, l'autre rien. Tapis, MOSFET et sonde de cette zone sont bien associes.` };
        }, this.dureeEssai);
        // Le texte d'essai.cpp : l'atelier y lit la hausse attendue.
        return this.repondre(d.req, true, { message: `Zone ${z + 1} : chauffe seule a pleine puissance, verdict des que sa sonde gagne 0.5 C (10 min au plus). Ne pas laisser sans surveillance.` });
      // Lever les défauts (comme protocole.cpp) : les zones repartent, et le disent.
      case 'reset':
        this.reset = (this.reset || 0) + 1;
        this.zones.forEach((x, i) => { Object.assign(x, { defaut: '0', defaut_libelle: 'OK' }); this.b.publier(`${this.base}/zone${i + 1}/etat`, JSON.stringify(x), false); });
        return this.repondre(d.req, true, {});
      // Firmware 3.5.1 : fin d'atelier par le réseau (comme protocole.cpp).
      case 'expedier':
        if (!this.connaitExpedier) return this.repondre(d.req, false, { erreur: 'action inconnue' });
        if (d.id !== this.id) return this.repondre(d.req, false, { erreur: 'expedier : identifiant de ce socle attendu (id)' });
        this.expedition = { broker: d.broker === false };
        return this.repondre(d.req, true, { expedition: { wifiOublie: true, brokerOublie: d.broker === false, ecran: true } });
      default: return this.repondre(d.req, false, { erreur: 'action inconnue' });
    }
  }
}

// ------------------------------------------------------------------- l'atelier
function creerAtelier({ broker, stockage = null, fetch = null, serveur = '' } = {}) {
  // « serveur » : l'adresse que le déploiement écrit dans la balise de la page.
  const html = fs.readFileSync(path.join(DOSSIER, 'atelier.html'), 'utf8')
    .replace('<meta name="terrarium-serveur" content="">', `<meta name="terrarium-serveur" content="${serveur}">`);
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://atelier.exemple.fr/atelier.html', pretendToBeVisual: true });
  const w = dom.window;
  for (const s of w.document.querySelectorAll('script[src]')) s.remove();
  if (stockage) for (const [k, v] of Object.entries(stockage)) w.localStorage.setItem(k, v);
  Object.defineProperty(w, 'crypto', { value: crypto.webcrypto, configurable: true });
  w.TextEncoder = TextEncoder;
  w.TextDecoder = TextDecoder;
  w.isSecureContext = true;
  const etat = { port: null, ports: [], autorises: [], impressions: 0, telechargements: [], choixPort: 0 };
  const ecouteurs = {};
  Object.defineProperty(w.navigator, 'serial', { configurable: true, value: {
    requestPort: async () => {
      if (!etat.port) { const e = new Error('aucun port'); e.name = 'NotFoundError'; throw e; }
      etat.choixPort++;
      etat.ports.push(etat.port);
      if (!etat.autorises.includes(etat.port)) etat.autorises.push(etat.port);
      return etat.port;
    },
    // Chrome retient un port choisi : il le redonne tant qu'il est branché.
    getPorts: async () => etat.autorises.filter(p => p.branche),
    addEventListener(type, f) { (ecouteurs[type] = ecouteurs[type] || []).push(f); }
  } });
  w.print = () => { etat.impressions++; };
  w.URL.createObjectURL = blob => { etat.telechargements.push(blob); return 'blob:essai'; };
  // jsdom ne télécharge pas : le clic sur le lien « download » est noté, sans navigation.
  const clicLien = w.HTMLAnchorElement.prototype.click;
  w.HTMLAnchorElement.prototype.click = function () { if (this.hasAttribute('download')) etat.noms = [...(etat.noms || []), this.getAttribute('download')]; else clicLien.call(this); };
  w.URL.revokeObjectURL = () => {};
  if (fetch) w.fetch = fetch;
  w.mqtt = { connect: (url, opts) => broker.connect(url, opts) };
  w.eval(fs.readFileSync(path.join(DOSSIER, 'qr.js'), 'utf8') + '\n//# sourceURL=file://' + path.join(DOSSIER, 'qr.js'));
  w.eval(fs.readFileSync(path.join(DOSSIER, 'atelier.js'), 'utf8') + '\n//# sourceURL=file://' + path.join(DOSSIER, 'atelier.js'));
  const $ = s => w.document.querySelector(s);
  const A = w.Atelier;
  A._delais({ reponse: 3000, sondage: 60, essai: 60, identite: 300, essaisIdentite: 3, scan: 600, enchainement: 50, branchement: 30, envoi: 30 });
  // Le rendu suit chaque action après un court délai : on attend l'élément,
  // on clique, puis on laisse le rendu se faire.
  const cliquer = async sel => {
    let el = null;
    await jusqua(() => (el = typeof sel === 'string' ? $(sel) : sel), 3000);
    if (!el) throw new Error('introuvable : ' + sel);
    el.click();
    await attendre(50);
  };
  const soumettre = async f => { f.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await attendre(50); };
  const texte = sel => ($(sel) || {}).textContent || '';
  // Une carte branchée remplace la précédente (débranchée) ; « autorise » : Chrome
  // la reconnaît sans fenêtre de choix, et l'annonce par l'événement « connect ».
  const brancher = (c, { autorise = false } = {}) => {
    if (etat.port) etat.port.branche = false;
    etat.port = creerPort(c, w.Uint8Array);
    if (autorise) {
      etat.autorises.push(etat.port);
      for (const f of ecouteurs.connect || []) f({ target: etat.port });
    }
    return etat.port;
  };
  const lireBlob = b => new Promise(r => { const f = new w.FileReader(); f.onload = () => r(f.result); f.readAsText(b); });
  return { w, $, A, etat, cliquer, soumettre, texte, brancher, lireBlob };
}

async function regler(a, r) {
  await a.cliquer('[data-action="reglages"]');
  const champ = (id, v) => { if (v !== undefined) a.$(id).value = v; };
  champ('#r-url', r.url); champ('#r-ssid', r.ssid); champ('#r-wifi-mdp', r.wifiMdp);
  await a.cliquer(`[data-liaison="${r.liaison}"]`);
  champ('#r-serveur', r.serveur); champ('#r-admin', r.admin); champ('#r-s-hote', r.sHote); champ('#r-s-port', r.sPort);
  champ('#r-b-ws', r.ws); champ('#r-b-hote', r.hote); champ('#r-b-port', r.port); champ('#r-b-user', r.user); champ('#r-b-mdp', r.mdp);
  champ('#r-rodage', r.rodage);
  await a.soumettre(a.$('#form-reglages'));
}

// Un faux serveur Terrariums pour le registre partagé : comptes (Noé
// administrateur, Jean au rôle atelier), registre à révisions comme
// serveur/lib/atelier.js (conflits, secrets retirés), Wi-Fi commun, alertes.
function fauxServeurAtelier(SERVEUR) {
  const comptes = { 'noe@exemple.fr': { admin: true, atelier: false }, 'jean@exemple.fr': { admin: false, atelier: true }, 'client@exemple.fr': { admin: false, atelier: false } };
  const sessions = new Map(), d = { rev: 0, socles: {}, lots: {}, wifi: null }, requetes = [];
  let code = null;
  const fetch = async (url, o = {}) => {
    const u = new URL(url, 'https://atelier.exemple.fr/');
    const corps = o.body ? JSON.parse(o.body) : {};
    const jeton = ((o.headers || {}).Authorization || '').replace(/^Bearer /, '');
    const methode = o.method || 'GET';
    requetes.push({ chemin: u.pathname, methode, jeton, corps });
    const rep = (status, x) => ({ ok: status < 300, status, json: async () => JSON.parse(JSON.stringify(x)) });
    if (u.pathname === '/firmware/manifest.json') return rep(404, null);
    if (u.origin !== SERVEUR) return rep(404, {});
    if (u.pathname === '/api/compte/code') { code = { email: corps.email, code: '424242' }; return rep(200, { ok: true }); }
    if (u.pathname === '/api/compte/verifier') {
      if (!code || corps.code !== code.code || corps.email !== code.email) return rep(401, { erreur: 'code invalide ou expiré' });
      const j = `session-${corps.email}-${sessions.size}`;
      sessions.set(j, corps.email);
      const c = comptes[corps.email];
      return rep(200, { jeton: j, login: corps.email, admin: c.admin, atelier: c.admin || c.atelier });
    }
    if (u.pathname === '/api/session' && methode === 'DELETE') { sessions.delete(jeton); return rep(200, { ok: true }); }
    const qui = sessions.get(jeton);
    if (!qui) return rep(401, { erreur: 'session requise' });
    const c = comptes[qui];
    if (u.pathname === '/api/moi') return rep(200, { login: qui, admin: c.admin, atelier: c.admin || c.atelier });
    if (!(c.admin || c.atelier)) return rep(403, { erreur: 'réservé à l\'atelier' });
    if (u.pathname === '/api/admin/appareils') return rep(201, { id: corps.id, motDePasse: 'mdpAppareil88' });
    if (u.pathname === '/api/atelier/registre') {
      const depuis = +u.searchParams.get('depuis') || 0;
      return rep(200, { rev: d.rev, socles: Object.values(d.socles).filter(x => x.rev > depuis), lots: Object.values(d.lots).filter(x => x.rev > depuis),
        ...(d.wifi && d.wifi.rev > depuis ? { wifi: d.wifi } : depuis === 0 && !d.wifi ? { wifi: null } : {}),
        moi: { login: qui, role: c.admin ? 'admin' : 'atelier', alertes: { email: c.email !== false } } });
    }
    let m = /^\/api\/atelier\/socles\/(terra\w{6})$/.exec(u.pathname);
    if (m && methode === 'PUT') {
      const cur = d.socles[m[1]], f = { ...corps.socle };
      delete f.code; delete f.web;
      if (cur && (corps.base || 0) !== cur.rev && !(!corps.base && (f.maj || 0) > (cur.maj || 0))) return rep(409, { erreur: 'fiche changée', socle: cur });
      d.socles[m[1]] = { ...f, id: m[1], rev: ++d.rev, par: qui };
      return rep(200, { socle: d.socles[m[1]], rev: d.rev });
    }
    m = /^\/api\/atelier\/lots\/(lot-[0-9a-z]+)$/.exec(u.pathname);
    if (m && methode === 'PUT') { d.lots[m[1]] = { id: m[1], nom: corps.nom, cree: corps.cree, rev: ++d.rev }; return rep(200, { lot: d.lots[m[1]], rev: d.rev }); }
    if (u.pathname === '/api/atelier/wifi' && methode === 'PUT') { d.wifi = { ssid: corps.ssid, motDePasse: corps.motDePasse, rev: ++d.rev, par: qui }; return rep(200, { wifi: { ssid: corps.ssid, rev: d.wifi.rev }, rev: d.rev }); }
    if (u.pathname === '/api/atelier/alertes') { c.email = corps.email; return rep(200, { alertes: { email: corps.email } }); }
    return rep(404, { erreur: 'route inconnue' });
  };
  // Le serveur écrit lui-même une fiche (rodage conclu) : révision nouvelle.
  const ecrire = (id, f) => { d.socles[id] = { ...d.socles[id], ...f, rev: ++d.rev, par: 'serveur' }; };
  return { fetch, d, requetes, sessions, comptes, ecrire };
}
// Connexion d'un poste par le code reçu « par e-mail ».
async function connecter(a, email) {
  if (a.$('#reglages').hidden) await a.cliquer('[data-action="reglages"]');
  a.$('#r-email').value = email;
  await a.cliquer('[data-action="code"]');
  await jusqua(() => !a.$('#bloc-code').hidden);
  a.$('#r-code').value = '424242';
  await a.cliquer('[data-action="connecter"]');
  await jusqua(() => !!a.A._session());
}

(async () => {
  const broker = new Broker();
  const REGLAGES = { url: 'https://app.exemple.fr/', ssid: 'AtelierBanc', wifiMdp: 'motdepasse8', liaison: 'broker',
    ws: 'wss://broker.exemple.fr:8884/mqtt', hote: 'broker.exemple.fr', port: '8883', user: 'atelier', mdp: 'secretbroker', rodage: '1' };

  titre('1. Premier lancement et réglages');
  const a = creerAtelier({ broker });
  verifier('la page charge, un lot est créé', a.A.registre().lots.length === 1 && /^Lot du /.test(a.A.registre().lots[0].nom));
  verifier('le port série est disponible : pas de bandeau', a.$('#sans-serie').hidden);
  verifier('sans liaison réglée, le banc le dit', /Sans liaison/.test(a.texte('#etat-banc')));
  verifier('la fiche présente les cinq étapes', a.$('#fiche ol.etapes') && a.$('#fiche ol.etapes').children.length === 5);
  await regler(a, { ...REGLAGES, ssid: 'Atelier Banc' });
  verifier('un Wi-Fi avec une espace est refusé (la console coupe aux espaces)', !a.$('#reglages-erreur').hidden && /espace/.test(a.texte('#reglages-erreur')));
  a.$('#r-ssid').value = REGLAGES.ssid;
  await a.soumettre(a.$('#form-reglages'));
  const r0 = a.A.registre().reglages;
  verifier('réglages enregistrés', r0.liaison === 'broker' && r0.ssid === 'AtelierBanc' && r0.rodageH === 1 && a.$('#reglages').hidden);
  const brut0 = a.w.localStorage.getItem('terrarium.atelier.v1');
  verifier('aucun mot de passe dans le registre (localStorage)', !brut0.includes('motdepasse8') && !brut0.includes('secretbroker'));
  verifier('les mots de passe restent dans la séance (sessionStorage)', a.w.sessionStorage.getItem('terrarium.atelier.secrets').includes('secretbroker'));
  verifier('le banc se relie au broker avec les identifiants', await jusqua(() => a.A._connecte()) && /Banc relié/.test(a.texte('#etat-banc')),
    broker.connexions.length ? broker.connexions[broker.connexions.length - 1].opts.username : '');

  titre('2. Étape 1 : console (USB)');
  const c1 = new ConsoleSocle();
  await a.cliquer('[data-action="nouveau"]');
  verifier('nouveau socle : la fiche propose la console', await jusqua(() => /Connecter la console/.test(a.texte('#fiche')), 2000));
  a.brancher(c1);
  await a.cliquer('#fiche [data-action="console"]');
  const rec = () => a.A.registre().socles[c1.id];
  verifier('étape 1 terminée (identité, auto-test, mot de passe, Wi-Fi, liaison)', await jusqua(() => rec() && rec().etape === 2, 8000),
    rec() && rec().echec ? rec().echec.texte : '');
  verifier('commandes envoyées dans l\'ordre', JSON.stringify(c1.recu.map(l => l.split(' ')[0])) === JSON.stringify(['jeton', 'version', 'test', 'motdepasse', 'wifi', 'mqtt']), c1.recu.map(l => l.split(' ')[0]).join(','));
  verifier('identité, firmware et protocole relevés', rec().code === c1.code && rec().firmware === '3.6.0' && rec().proto === 4);
  verifier('auto-test : lignes relevées, MOSFET non actionnés notés à part', rec().usine.ok && rec().usine.lignes.length === 6 && rec().usine.lignes[5].ok === null, rec().usine.lignes.map(l => l.organe).join(','));
  verifier('mot de passe de la page locale : 12 caractères lisibles, donné au socle', /^[abcdefghjkmnpqrstuvwxyz23456789]{12}$/.test(rec().web.motDePasse) && c1.etat.web.mdp === rec().web.motDePasse && c1.etat.web.utilisateur === 'admin');
  verifier('Wi-Fi du banc donné au socle', c1.etat.wifi && c1.etat.wifi.ssid === 'AtelierBanc' && c1.etat.wifi.mdp === 'motdepasse8' && rec().wifiBanc === '192.168.4.57');
  verifier('broker de l\'atelier donné au socle (TLS sur 8883)', c1.etat.mqtt && c1.etat.mqtt.hote === 'broker.exemple.fr' && c1.etat.mqtt.port === 8883 && c1.etat.mqtt.utilisateur === 'atelier' && c1.etat.mqtt.tls);
  const journal = a.texte('#console-journal');
  verifier('la console masque les mots de passe envoyés', !journal.includes('motdepasse8') && !journal.includes('secretbroker') && !journal.includes(rec().web.motDePasse) && journal.includes('••••••'));
  verifier('la console est refermée (USB à débrancher)', /Fermée/.test(a.texte('#etat-console')));

  titre('3. Étape 2 : sondes, par le banc');
  verifier('en attente du socle sur le banc', await jusqua(() => /En attente du socle/.test(a.texte('#fiche')), 2000));
  const banc1 = new SocleBanc(broker, { id: c1.id, code: c1.code, echecIdent: new Set([1]) });
  banc1.enLigne();
  verifier('socle en ligne : inventaire du bus lu (commande signée)', await jusqua(() => a.A.vif(c1.id).inventaire && a.A.vif(c1.id).inventaire.sondes.length === 2) && banc1.refus === 0);
  verifier('le banc affiche le socle', await jusqua(() => !a.$('#banc').hidden && a.texte('#banc-grille').includes(c1.id), 2000));
  await a.cliquer('#fiche [data-action="identifier"][data-zone="1"]');
  verifier('compte à rebours pendant l\'identification', await jusqua(() => /Serre la sonde de la zone 1/.test(a.texte('#fiche')), 3000));
  verifier('zone 1 identifiée', await jusqua(() => (rec().sondes || []).some(x => x.zone === 1 && x.rom === '28FF0000000000A1'), 8000));
  verifier('sondes enchaînées : la zone 2 s\'identifie d\'elle-même', await jusqua(() => banc1.ident === 1 || (a.A.vif(c1.id).tache && a.A.vif(c1.id).tache.zone === 2), 4000));
  verifier('zone 2 : identification abandonnée, expliquée', await jusqua(() => rec().echec && rec().echec.etape === 2, 8000) && await jusqua(() => /aucune sonde n'a pris 1 °C/.test(a.texte('#fiche')), 2000));
  await a.cliquer('#fiche [data-action="identifier"][data-zone="2"]');
  verifier('zone 2 identifiée au second essai : étape 3', await jusqua(() => rec().etape === 3, 8000) && !rec().echec);

  titre('4. Étape 3 : essais de chauffe');
  await a.cliquer('#fiche [data-action="essais"]');
  verifier('deux essais réussis, rodage lancé', await jusqua(() => rec().etape === 4 && rec().rodage, 8000),
    (rec().chauffe || []).map(c => c.texte).join(' | '));
  verifier('verdicts du socle gardés', rec().chauffe.length === 2 && rec().chauffe.every(c => c.ok && /OK : sa sonde a pris/.test(c.texte)));
  verifier('rodage d\'une heure (réglage)', rec().rodage.fin - rec().rodage.debut === 3600000);

  titre('5. Étape 4 : rodage');
  banc1.b.publier(`${banc1.base}/zone1/etat`, JSON.stringify({ temp: 31.8, consigne: 32, defaut: '1', defaut_libelle: 'SONDE ABSENTE' }), true);
  verifier('un défaut pendant le rodage est noté', await jusqua(() => rec().rodage.incidents.some(i => i.grave && /SONDE ABSENTE/.test(i.texte))));
  banc1.b.publier(`${banc1.base}/sante`, JSON.stringify({ proto: 4, uptime: 12, reset: 'chien de garde' }), true);
  verifier('un redémarrage pendant le rodage est noté', await jusqua(() => rec().rodage.incidents.some(i => /redémarrage \(chien de garde\)/.test(i.texte))));
  banc1.zones[0] = { temp: 31.8, consigne: 32, defaut: '1', defaut_libelle: 'SONDE ABSENTE' };
  banc1.uptime = 20;
  rec().rodage.fin = Date.now() - 1000;
  await a.A._surveiller();
  const verdict = rec().rodage.verdict;
  verifier('rodage échoué : redémarrage et défaut cités, sans doublon', verdict && !verdict.ok && /redémarrage \(chien de garde\)/.test(verdict.texte)
    && verdict.texte.split('SONDE ABSENTE').length === 2, verdict && verdict.texte);
  // Socle redémarré sans que la page l'ait vu (fermée) : sa durée de marche le trahit.
  await attendre(60);
  await a.cliquer('#fiche [data-action="recommencer"]');
  banc1.zones[0] = { temp: 32.0, consigne: 32, defaut: '0', defaut_libelle: 'OK' };
  banc1.uptime = 1800;
  rec().rodage.debut = Date.now() - 2 * 3600000; rec().rodage.fin = Date.now() - 3600000;
  await a.A._surveiller();
  verifier('redémarrage vu à la durée de marche, page fermée ou pas', rec().rodage.verdict && !rec().rodage.verdict.ok && /a redémarré pendant le rodage/.test(rec().rodage.verdict.texte), rec().rodage.verdict && rec().rodage.verdict.texte);
  await attendre(60);
  await a.cliquer('#fiche [data-action="recommencer"]');
  verifier('rodage recommencé, incidents remis à zéro', rec().rodage && !rec().rodage.verdict && rec().rodage.incidents.length === 0);
  banc1.zones[0] = { temp: 32.0, consigne: 32, defaut: '0', defaut_libelle: 'OK' };
  banc1.uptime = 3 * 3600;
  rec().rodage.debut = Date.now() - 2 * 3600000; rec().rodage.fin = Date.now() - 3600000;
  await a.A._surveiller();
  verifier('rodage réussi : socle prêt', rec().etat === 'pret' && rec().etape === 5 && rec().rodage.verdict.ok, rec().rodage.verdict && rec().rodage.verdict.texte);
  verifier('aucune commande refusée par le socle (signatures justes)', banc1.refus === 0);

  titre('6. Étape 5 : étiquette et expédition');
  a.A.choisir(c1.id);
  await attendre(60);
  const intrus = new ConsoleSocle({ id: 'terraFFFFFF', code: 'ZZZZZZZZZZZZZZZZZZZZZZZZ' });
  a.brancher(intrus);
  await a.cliquer('#fiche [data-action="preparer"]');
  verifier('un autre socle sur la console est refusé', await jusqua(() => rec().echec && rec().echec.etape === 5) && /terraFFFFFF, pas terraA1B2C3/.test(rec().echec.texte));
  verifier('rien n\'a été envoyé d\'autre à l\'intrus', !intrus.recu.includes('wifi off'));
  a.etat.port.debrancher();
  await jusqua(() => /Fermée/.test(a.texte('#etat-console')));
  a.brancher(c1);
  await a.cliquer('#fiche [data-action="preparer"]');
  verifier('le bon socle : Wi-Fi et broker oubliés, historique vidé', await jusqua(() => c1.etat.historiqueEfface && rec().expedition && rec().expedition.verifie && !a.A.procedure(), 6000)
    && c1.etat.wifi === null && c1.etat.mqtt === null && rec().expedition.wifiOublie && rec().expedition.brokerOublie);
  await attendre(60);
  verifier('l\'étiquette part à l\'imprimante d\'elle-même', a.etat.impressions === 1 && !!a.$('#etiquette-impression svg') && (rec().journal || []).some(j => /Étiquette imprimée/.test(j.texte)));
  const lien = a.A.lienEtiquette(c1.id);
  verifier('lien d\'installation de l\'étiquette', lien === `https://app.exemple.fr/#a/${c1.id}/${c1.code}`, lien);
  const svg = a.A.etiquette(c1.id);
  verifier('étiquette : code groupé et mot de passe imprimés', svg.includes('K7M2QX-ABCDEF-GH2345-678JKL') && svg.includes(`admin / ${rec().web.motDePasse}`));
  const QR = require(path.join(DOSSIER, 'qr.js'));
  const q = QR.chemin(lien, { marge: 1 });
  verifier('étiquette : le QR est celui du lien', svg.includes(q.d.slice(0, 200)) && svg.includes(`width="${q.cote}"`), `version ${q.version}`);
  verifier('aperçu affiché dans la fiche', !!a.$('#fiche .etiquette-apercu svg'));
  verifier('« Réimprimer l\'étiquette » au besoin', /Réimprimer l'étiquette/.test(a.texte('#fiche [data-action="imprimer"]')));
  await a.cliquer('#fiche [data-action="imprimer"]');
  verifier('impression : seule l\'étiquette est dans la zone imprimée', a.etat.impressions === 2 && !!a.$('#etiquette-impression svg'));
  const btnExp = a.$('#fiche [data-action="expedier"]');
  verifier('un seul bouton : « Étiquette collée : marquer comme expédié »', btnExp && !btnExp.disabled
    && /Étiquette collée : marquer comme expédié/.test(btnExp.textContent) && !a.$('#fiche [type="checkbox"]'));
  await a.cliquer('#fiche [data-action="expedier"]');
  const brut1 = a.w.localStorage.getItem('terrarium.atelier.v1');
  verifier('expédié : code et mot de passe effacés de l\'atelier', rec().etat === 'expedie' && !rec().code && !rec().web && !brut1.includes(c1.code) && !brut1.includes(c1.etat.web.mdp));
  verifier('le socle quitte le banc', await jusqua(() => !a.texte('#banc-grille').includes(c1.id)));

  titre('7. Auto-test raté, mise de côté, reprise');
  const c2 = new ConsoleSocle({ id: 'terraB2C3D4', code: 'QQQQQQWWWWWWEEEEEERRRRRR', usineOk: false });
  // La carte est branchée d'abord : « Nouveau socle » ouvre aussitôt la console.
  a.brancher(c2);
  await a.cliquer('[data-action="nouveau"]');
  const rec2 = () => a.A.registre().socles[c2.id];
  verifier('« Nouveau socle » ouvre la console sans autre clic', await jusqua(() => c2.recu.includes('jeton'), 3000));
  verifier('auto-test raté : étape 1 en échec, organe cité', await jusqua(() => rec2() && rec2().echec, 6000) && /sondes \(1 detectee\(s\) sur 2/.test(rec2().echec.texte), rec2() && rec2().echec && rec2().echec.texte);
  verifier('rien d\'autre n\'est envoyé après l\'échec', !c2.recu.some(l => l.startsWith('motdepasse') || l.startsWith('wifi')));
  const f = a.$('#fiche form[data-form="cote"]');
  f.elements.raison.value = 'sonde 2 HS';
  await a.soumettre(f);
  verifier('mis de côté avec sa raison', rec2().etat === 'cote' && rec2().cote.raison === 'sonde 2 HS');
  await a.cliquer('[data-filtre="cote"]');
  await attendre(60);
  verifier('le filtre « De côté » le montre', a.texte('#liste-socles').includes(c2.id) && !a.texte('#liste-socles').includes(c1.id));
  await a.cliquer('#fiche [data-action="reprendre"]');
  verifier('repris : de nouveau en cours', rec2().etat === 'actif' && !rec2().cote);
  c2.usineOk = true;
  await attendre(60);
  await a.cliquer('#fiche [data-action="console"]');
  verifier('console reprise sur la même session : étape 1 réussie', await jusqua(() => rec2().etape === 2, 8000), rec2().echec ? rec2().echec.texte : '');

  titre('8. Registre CSV');
  await a.cliquer('[data-action="exporter"]');
  const csv = await a.lireBlob(a.etat.telechargements[a.etat.telechargements.length - 1]);
  verifier('le registre liste les socles et leurs résultats', csv.replace(/^\uFEFF/, '').startsWith('"socle";"lot"') && csv.includes(c1.id) && csv.includes(c2.id) && csv.includes('28FF0000000000A1'), csv.slice(0, 40));
  verifier('nom du fichier daté', /^registre-atelier-\d{4}-\d{2}-\d{2}\.csv$/.test((a.etat.noms || []).slice(-1)[0] || ''));
  verifier('aucun secret dans le registre exporté', !csv.includes(c2.code) && !csv.includes(rec2().web.motDePasse) && !csv.includes('motdepasse8'));

  titre('9. Rechargement de la page');
  const stockage = { 'terrarium.atelier.v1': a.w.localStorage.getItem('terrarium.atelier.v1') };
  const b = creerAtelier({ broker, stockage });
  verifier('le registre survit au rechargement', b.A.registre().socles[c1.id] && b.A.registre().socles[c2.id] && b.A.registre().socles[c2.id].code === c2.code);
  verifier('les mots de passe, eux, sont redemandés', /identifiants à saisir/.test(b.texte('#etat-banc')));

  titre('10. Serveur Terrariums, firmware sans « wifi off »');
  const appels = [];
  const fauxFetch = async (url, o) => {
    if (/firmware\/manifest\.json$/.test(url)) return { ok: false, status: 404, json: async () => null };
    // Un serveur d'avant le registre partagé : l'atelier garde son registre à lui.
    if (/\/api\/atelier\//.test(url)) return { ok: false, status: 404, json: async () => ({ erreur: 'route inconnue' }) };
    appels.push({ url, o });
    const ok = o.headers.Authorization === 'Bearer jeton-admin-essai';
    return { ok, status: ok ? 201 : 403, json: async () => (ok ? { id: JSON.parse(o.body).id, motDePasse: 'mdpAppareil42' } : { erreur: 'réservé à l\'administration' }) };
  };
  const brokerS = new Broker();
  const s = creerAtelier({ broker: brokerS, fetch: fauxFetch });
  await regler(s, { url: 'https://app.exemple.fr/', ssid: 'AtelierBanc', wifiMdp: 'motdepasse8', liaison: 'serveur', serveur: 'https://terrariums.exemple.fr', admin: 'jeton-admin-essai', rodage: '24' });
  verifier('le banc suit le serveur avec l\'utilisateur « admin »', await jusqua(() => s.A._connecte()) && brokerS.connexions[0].url === 'wss://terrariums.exemple.fr/mqtt' && brokerS.connexions[0].opts.username === 'admin');
  const c3 = new ConsoleSocle({ id: 'terraC3D4E5', code: 'AAAAAABBBBBBCCCCCCDDDDDD', connaitWifiOff: false });
  await s.cliquer('[data-action="nouveau"]');
  s.brancher(c3);
  await s.cliquer('#fiche [data-action="console"]');
  const rec3 = () => s.A.registre().socles[c3.id];
  verifier('compte d\'appareil créé, socle réglé pour le serveur', await jusqua(() => rec3() && rec3().etape === 2, 8000)
    && appels.length === 1 && appels[0].url === 'https://terrariums.exemple.fr/api/admin/appareils' && JSON.parse(appels[0].o.body).id === c3.id
    && c3.etat.mqtt && c3.etat.mqtt.hote === 'terrariums.exemple.fr' && c3.etat.mqtt.utilisateur === c3.id && c3.etat.mqtt.mdp === 'mdpAppareil42' && c3.etat.mqtt.tls,
    rec3() && rec3().echec ? rec3().echec.texte : '');
  // Rodage écourté : on va droit à l'étiquette.
  Object.assign(rec3(), { etape: 5, etat: 'pret', rodage: { debut: Date.now() - 1, fin: Date.now(), incidents: [], verdict: { ok: true, texte: 'essai', t: Date.now() } } });
  s.A.choisir(c3.id);
  await attendre(60);
  s.brancher(c3);
  await s.cliquer('#fiche [data-action="preparer"]');
  verifier('firmware ancien : Wi-Fi non oublié, signalé sans bloquer', await jusqua(() => c3.etat.historiqueEfface && !s.A.procedure(), 6000)
    && rec3().expedition.wifiOublie === false && /trop ancien/.test(JSON.stringify(rec3().journal)) && /trop ancien/.test(s.texte('#fiche')));
  verifier('sur le serveur, la liaison MQTT est gardée', c3.etat.mqtt && c3.etat.mqtt.hote === 'terrariums.exemple.fr' && !c3.recu.includes('mqtt off'));

  titre('11. Sans liaison : étapes 2 à 4 validées à la main');
  const m = creerAtelier({ broker: new Broker() });
  await regler(m, { url: 'https://app.exemple.fr/', ssid: '', wifiMdp: '', liaison: 'aucune', rodage: '1' });
  const c4 = new ConsoleSocle({ id: 'terraD4E5F6', code: 'MMMMMMNNNNNNPPPPPPRRRRRR' });
  await m.cliquer('[data-action="nouveau"]');
  m.brancher(c4);
  await m.cliquer('#fiche [data-action="console"]');
  const rec4 = () => m.A.registre().socles[c4.id];
  verifier('sans Wi-Fi ni liaison : la console ne règle ni l\'un ni l\'autre', await jusqua(() => rec4() && rec4().etape === 2, 6000) && !c4.recu.some(l => /^(wifi|mqtt)/.test(l)));
  await m.cliquer('#fiche [data-action="manuel-sondes"]');
  await attendre(60);
  await m.cliquer('#fiche [data-action="manuel-chauffe"]');
  await attendre(60);
  verifier('rodage lancé ; sa validation attend la fin', rec4().etape === 4 && m.$('#fiche [data-action="manuel-rodage-ok"]').disabled);
  rec4().rodage.fin = Date.now() - 1;
  m.A.choisir(c4.id);
  await attendre(60);
  await m.cliquer('#fiche [data-action="manuel-rodage-ok"]');
  verifier('rodage validé : prêt pour l\'étiquette', rec4().etat === 'pret' && rec4().rodage.verdict.ok);
  verifier('pas de banc sans liaison', m.$('#banc').hidden);

  titre('12. Serveur du déploiement, connexion par compte administrateur');
  // Un faux serveur : code par e-mail, session d'un compte, API d'administration.
  const SERVEUR = 'https://exotic.exemple.fr';
  const comptes = { 'noe@exemple.fr': { admin: true }, 'client@exemple.fr': { admin: false } };
  const sessions = new Map();
  const requetes = [];
  let codeEnvoye = null;
  const serveurFetch = async (url, o = {}) => {
    const u = new URL(url, 'https://atelier.exemple.fr/');
    const corps = o.body ? JSON.parse(o.body) : {};
    const jeton = ((o.headers || {}).Authorization || '').replace(/^Bearer /, '');
    requetes.push({ chemin: u.pathname, methode: o.method || 'GET', jeton });
    const rep = (status, d) => ({ ok: status < 300, status, json: async () => d });
    if (u.pathname === '/firmware/manifest.json') return rep(404, null);
    if (u.origin !== SERVEUR) return rep(404, {});
    if (u.pathname === '/api/compte/code') { codeEnvoye = { email: corps.email, code: '424242' }; return rep(200, { ok: true }); }
    if (u.pathname === '/api/compte/verifier') {
      if (!codeEnvoye || corps.code !== codeEnvoye.code || corps.email !== codeEnvoye.email) return rep(401, { erreur: 'code invalide ou expiré' });
      const j = 'session-' + corps.email.split('@')[0] + '-' + sessions.size;
      sessions.set(j, corps.email);
      return rep(200, { jeton: j, login: corps.email, admin: !!(comptes[corps.email] || {}).admin });
    }
    if (u.pathname === '/api/session' && o.method === 'DELETE') { sessions.delete(jeton); return rep(200, { ok: true }); }
    const qui = sessions.get(jeton);
    if (!qui) return rep(401, { erreur: 'session requise' });
    if (u.pathname === '/api/moi') return rep(200, { login: qui, admin: comptes[qui].admin });
    if (u.pathname === '/api/admin/appareils' && comptes[qui].admin) return rep(201, { id: corps.id, motDePasse: 'mdpAppareil77' });
    return rep(403, { erreur: 'réservé à l\'administration' });
  };
  // Un atelier ouvert avant que le serveur soit fixé, jamais servi : il le prend ;
  // un atelier qui a déjà servi sans liaison la garde.
  const vide = { v: 1, reglages: { liaison: 'aucune', ssid: '', serveur: { url: '' } }, lots: [{ id: 'lot-a', nom: 'Lot A', cree: 1 }], lotCourant: 'lot-a', socles: {} };
  const ancien = creerAtelier({ broker: new Broker(), serveur: SERVEUR, stockage: { 'terrarium.atelier.v1': JSON.stringify(vide) } });
  verifier('registre jamais servi : le serveur du déploiement est adopté', ancien.A.registre().reglages.liaison === 'serveur' && ancien.A.registre().reglages.serveur.url === SERVEUR);
  const servi = creerAtelier({ broker: new Broker(), serveur: SERVEUR, stockage: { 'terrarium.atelier.v1': JSON.stringify({ ...vide, socles: { terraD4E5F6: { id: 'terraD4E5F6', etape: 4, etat: 'actif', journal: [] } } }) } });
  verifier('atelier déjà servi sans liaison : son choix est gardé', servi.A.registre().reglages.liaison === 'aucune');
  const brokerD = new Broker();
  const d = creerAtelier({ broker: brokerD, fetch: serveurFetch, serveur: SERVEUR });
  verifier('serveur du déploiement : liaison et adresse déjà réglées', d.A.registre().reglages.liaison === 'serveur' && d.A.registre().reglages.serveur.url === SERVEUR);
  verifier('le banc demande le compte, pas un jeton', /compte à connecter/.test(d.texte('#etat-banc')));
  await d.cliquer('[data-action="reglages"]');
  verifier('réglages : l\'adresse du serveur est remplie, le compte à connecter', d.$('#r-serveur').value === SERVEUR && !d.$('#compte-connexion').hidden && d.$('#compte-connecte').hidden);
  d.$('#r-email').value = 'Client@Exemple.fr';
  await d.cliquer('[data-action="code"]');
  verifier('« Recevoir un code » : le serveur envoie le code, le champ du code apparaît', await jusqua(() => codeEnvoye && codeEnvoye.email === 'client@exemple.fr' && !d.$('#bloc-code').hidden));
  d.$('#r-code').value = '424 242';
  await d.cliquer('[data-action="connecter"]');
  verifier('un compte sans le rôle atelier est refusé, sa session refermée', await jusqua(() => /pas le rôle atelier/.test(d.texte('#reglages-erreur')))
    && !d.A._session() && await jusqua(() => requetes.some(r => r.chemin === '/api/session' && r.methode === 'DELETE')) && sessions.size === 0);
  d.$('#r-email').value = 'noe@exemple.fr';
  await d.cliquer('[data-action="code"]');
  await jusqua(() => codeEnvoye.email === 'noe@exemple.fr');
  d.$('#r-code').value = '000000';
  await d.cliquer('[data-action="connecter"]');
  verifier('un code faux est refusé', await jusqua(() => /code invalide/.test(d.texte('#reglages-erreur'))) && !d.A._session());
  d.$('#r-code').value = '424242';
  await d.cliquer('[data-action="connecter"]');
  verifier('compte administrateur connecté, montré dans les réglages', await jusqua(() => d.A._session() && !d.$('#compte-connecte').hidden)
    && d.texte('#compte-login') === 'noe@exemple.fr' && d.$('#reglages-erreur').hidden);
  verifier('le banc se relie avec le compte (identifiant e-mail, session)', await jusqua(() => d.A._connecte())
    && brokerD.connexions.slice(-1)[0].url === 'wss://exotic.exemple.fr/mqtt' && brokerD.connexions.slice(-1)[0].opts.username === 'noe@exemple.fr'
    && sessions.get(brokerD.connexions.slice(-1)[0].opts.password) === 'noe@exemple.fr');
  verifier('la session est gardée par le navigateur, pas dans le registre', /session-noe/.test(d.w.localStorage.getItem('terrarium.atelier.session'))
    && !/session-noe/.test(d.w.localStorage.getItem('terrarium.atelier.v1')));
  d.$('#r-ssid').value = 'AtelierBanc'; d.$('#r-wifi-mdp').value = 'motdepasse8'; d.$('#r-rodage').value = '24';
  await d.soumettre(d.$('#form-reglages'));
  verifier('réglages enregistrés, Wi-Fi retenu sur cet ordinateur', d.$('#reglages').hidden && /motdepasse8/.test(d.w.localStorage.getItem('terrarium.atelier.memo') || ''));
  const c5 = new ConsoleSocle({ id: 'terraE5F6A7', code: 'SSSSSSTTTTTTUUUUUUVVVVVV' });
  d.brancher(c5);
  await d.cliquer('[data-action="nouveau"]');
  const rec5 = () => d.A.registre().socles[c5.id];
  verifier('étape 1 avec le compte : compte d\'appareil créé avec la session', await jusqua(() => rec5() && rec5().etape === 2, 8000)
    && requetes.some(r => r.chemin === '/api/admin/appareils' && sessions.get(r.jeton) === 'noe@exemple.fr')
    && c5.etat.mqtt && c5.etat.mqtt.hote === 'exotic.exemple.fr' && c5.etat.mqtt.mdp === 'mdpAppareil77' && c5.etat.mqtt.tls,
  rec5() && rec5().echec ? rec5().echec.texte : '');

  titre('13. Rechargement : compte et Wi-Fi retenus ; session expirée');
  const garde = k => d.w.localStorage.getItem(k);
  const e2 = creerAtelier({ broker: new Broker(), fetch: serveurFetch, serveur: SERVEUR, stockage: {
    'terrarium.atelier.v1': garde('terrarium.atelier.v1'), 'terrarium.atelier.session': garde('terrarium.atelier.session'), 'terrarium.atelier.memo': garde('terrarium.atelier.memo') } });
  verifier('rien à ressaisir : le banc se relie seul', await jusqua(() => e2.A._connecte()) && /Banc relié/.test(e2.texte('#etat-banc')));
  await e2.cliquer('[data-action="reglages"]');
  verifier('le mot de passe du Wi-Fi est rempli', e2.$('#r-wifi-mdp').value === 'motdepasse8' && e2.$('#r-wifi-retenir').checked);
  sessions.clear();          // le serveur a fermé la session (30 jours sans usage)
  const e3 = creerAtelier({ broker: new Broker(), fetch: serveurFetch, serveur: SERVEUR, stockage: {
    'terrarium.atelier.v1': garde('terrarium.atelier.v1'), 'terrarium.atelier.session': garde('terrarium.atelier.session') } });
  verifier('session expirée : oubliée, le banc redemande le compte', await jusqua(() => !e3.A._session() && /compte à connecter/.test(e3.texte('#etat-banc')))
    && !e3.w.localStorage.getItem('terrarium.atelier.session'));
  await d.cliquer('[data-action="reglages"]');
  await d.cliquer('[data-action="deconnecter"]');
  verifier('« Se déconnecter » oublie la session', !d.A._session() && !d.w.localStorage.getItem('terrarium.atelier.session') && /compte à connecter/.test(d.texte('#etat-banc')));

  titre('14. Firmware : carte vierge, puis firmware en retard');
  const manifestes = [];
  const fetchFirmware = async (url) => {
    if (/firmware\/manifest\.json$/.test(url)) { manifestes.push(url); return { ok: true, status: 200, json: async () => ({ name: 'Socle chauffant', version: '3.5.0', builds: [{ chipFamily: 'ESP32', parts: [] }] }) }; }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const f1 = creerAtelier({ broker: new Broker(), fetch: fetchFirmware });
  await regler(f1, { url: 'https://app.exemple.fr/', ssid: '', wifiMdp: '', liaison: 'aucune', rodage: '1' });
  const installations = [];
  const c6 = new ConsoleSocle({ id: 'terraF6A7B8', code: 'WWWWWWXXXXXXYYYYYYZZZZZZ', vierge: true, firmware: null });
  f1.A._installateur(async (port, o) => {
    installations.push({ ouvertPendant: port.ouvert, effacer: o && o.effacer });
    Object.assign(c6, { vierge: false, firmware: '3.5.0' });
  });
  f1.brancher(c6);
  await f1.cliquer('[data-action="nouveau"]');
  const rec6 = () => f1.A.registre().socles[c6.id];
  verifier('carte vierge : la fenêtre d\'installation s\'ouvre sur le port, puis l\'étape continue', await jusqua(() => rec6() && rec6().etape === 2, 8000)
    && installations.length === 1 && installations[0].ouvertPendant === false && rec6().firmware === '3.5.0', rec6() && rec6().echec ? rec6().echec.texte : '');
  verifier('carte vierge : mémoire effacée avant l\'écriture', installations[0].effacer === true);
  verifier('l\'installation est notée au journal du socle', (rec6().journal || []).some(j => /Firmware 3\.5\.0 installé par l'atelier/.test(j.texte)));
  const c7 = new ConsoleSocle({ id: 'terraA7B8C9', code: 'GGGGGGHHHHHHJJJJJJKKKKKK', firmware: '3.4.0' });
  f1.A._installateur(async (port, o) => { installations.push({ effacer: o && o.effacer }); c7.firmware = '3.5.0'; });
  f1.brancher(c7);
  await f1.cliquer('[data-action="nouveau"]');
  const rec7 = () => f1.A.registre().socles[c7.id];
  verifier('firmware en retard (3.4.0) : mis à jour en 3.5.0', await jusqua(() => rec7() && rec7().etape === 2, 8000) && installations.length === 2 && rec7().firmware === '3.5.0');
  verifier('socle identifié : mis à jour sans effacement (réglages et code gardés)', installations[1].effacer === false);
  const c8 = new ConsoleSocle({ id: 'terraB8C9D0', code: 'LLLLLLMMMMMMNNNNNNPPPPPP', firmware: '3.5.0' });
  f1.brancher(c8);
  await f1.cliquer('[data-action="nouveau"]');
  verifier('firmware à jour : pas d\'installation', await jusqua(() => f1.A.registre().socles[c8.id] && f1.A.registre().socles[c8.id].etape === 2, 8000) && installations.length === 2);
  const c9 = new ConsoleSocle({ id: 'terraC9D0E1', code: 'QQQQQQRRRRRRSSSSSSTTTTTT', vierge: true, firmware: null });
  f1.A._installateur(async () => { installations.push({}); });     // fenêtre fermée sans rien installer
  f1.brancher(c9);
  await f1.cliquer('[data-action="nouveau"]');
  verifier('installation abandonnée : l\'étape le dit, sans socle fantôme', await jusqua(() => /ne répond pas/.test(f1.texte('#fiche')), 8000)
    && !f1.A.registre().socles[c9.id] && installations.length === 3, f1.texte('#fiche').slice(0, 160));
  verifier('le manifeste n\'est lu qu\'une fois', manifestes.length === 1);

  titre('15. Wi-Fi du banc proposé par le socle (Improv)');
  const brokerW = new Broker();
  const wa = creerAtelier({ broker: brokerW });
  await regler(wa, { ...REGLAGES, ssid: '', wifiMdp: '' });
  verifier('broker sans Wi-Fi du banc : les réglages passent (le Wi-Fi se choisit au premier socle)', wa.$('#reglages').hidden && wa.A.registre().reglages.ssid === '');
  const c10 = new ConsoleSocle({ id: 'terraF1F2F3', code: 'AAAAAABBBBBBCCCCCCDDDDDE', reseaux: [{ ssid: 'BancAtelier', rssi: -52, securise: true }, { ssid: 'Voisin', rssi: -83, securise: true }] });
  wa.brancher(c10);
  await wa.cliquer('[data-action="nouveau"]');
  verifier('le socle liste les réseaux qu\'il capte, du plus fort au plus faible', await jusqua(() => !wa.$('#choix-wifi').hidden, 5000)
    && [...wa.w.document.querySelectorAll('#choix-wifi-liste [data-action="wifi-reseau"]')].map(b => b.dataset.ssid).join(',') === 'BancAtelier,Voisin' && c10.scans === 1);
  verifier('rien n\'est envoyé au socle tant que le Wi-Fi n\'est pas choisi', !c10.recu.some(l => /^(test|wifi|motdepasse)/.test(l)));
  await wa.cliquer('#choix-wifi-liste [data-ssid="BancAtelier"]');
  wa.$('#cw-mdp').value = 'court';
  await wa.soumettre(wa.$('#form-choix-wifi'));
  verifier('un mot de passe Wi-Fi trop court est refusé', !wa.$('#cw-erreur').hidden && /8 caractères/.test(wa.texte('#cw-erreur')));
  wa.$('#cw-mdp').value = 'motdepasse9';
  await wa.soumettre(wa.$('#form-choix-wifi'));
  const recW = () => wa.A.registre().socles[c10.id];
  verifier('réseau choisi : l\'étape 1 continue seule', await jusqua(() => recW() && recW().etape === 2, 8000) && wa.$('#choix-wifi').hidden
    && c10.etat.wifi && c10.etat.wifi.ssid === 'BancAtelier' && c10.etat.wifi.mdp === 'motdepasse9', recW() && recW().echec ? recW().echec.texte : '');
  verifier('le réseau est gardé pour les socles suivants (et retenu sur cet ordinateur)', wa.A.registre().reglages.ssid === 'BancAtelier'
    && /motdepasse9/.test(wa.w.localStorage.getItem('terrarium.atelier.memo') || ''));
  const c11 = new ConsoleSocle({ id: 'terraF2F3F4', code: 'EEEEEEFFFFFFGGGGGGHHHHHH', reseaux: [{ ssid: 'BancAtelier', rssi: -47, securise: true }] });
  wa.brancher(c11);
  await wa.cliquer('[data-action="nouveau"]');
  verifier('socle suivant : réseau capté, aucune question', await jusqua(() => wa.A.registre().socles[c11.id] && wa.A.registre().socles[c11.id].etape === 2, 8000)
    && wa.$('#choix-wifi').hidden && c11.etat.wifi.ssid === 'BancAtelier');
  const c12 = new ConsoleSocle({ id: 'terraF3F4F5', code: 'JJJJJJKKKKKKLLLLLLMMMMMM', reseaux: [{ ssid: 'Voisin', rssi: -70, securise: true }] });
  wa.brancher(c12);
  await wa.cliquer('[data-action="nouveau"]');
  verifier('réseau du banc pas capté : la page parle du 5 GHz', await jusqua(() => !wa.$('#choix-wifi').hidden, 5000) && /5 GHz/.test(wa.texte('#choix-wifi-message'))
    && !wa.$('[data-action="wifi-forcer"]').hidden);
  await wa.cliquer('[data-action="wifi-forcer"]');
  verifier('« Essayer quand même » : l\'étape continue avec le réseau des réglages', await jusqua(() => wa.A.registre().socles[c12.id] && wa.A.registre().socles[c12.id].etape === 2, 8000)
    && c12.etat.wifi.ssid === 'BancAtelier');
  const c13 = new ConsoleSocle({ id: 'terraF4F5F6', code: 'NNNNNNPPPPPPQQQQQQRRRRRR', improv: false });
  wa.brancher(c13);
  await wa.cliquer('[data-action="nouveau"]');
  verifier('firmware qui ne répond pas au scan : on fait sans', await jusqua(() => wa.A.registre().socles[c13.id] && wa.A.registre().socles[c13.id].etape === 2, 8000)
    && wa.$('#choix-wifi').hidden);
  verifier('le scan ne trouble pas la console (pas de commande parasite)', !c10.recu.concat(c11.recu, c12.recu).some(l => /IMPROV|Commande inconnue/.test(l)));

  titre('16. Carte branchée : l\'étape démarre seule');
  const ba = creerAtelier({ broker: new Broker() });
  await regler(ba, { url: 'https://app.exemple.fr/', ssid: '', wifiMdp: '', liaison: 'aucune', rodage: '1' });
  verifier('« Démarrer seul » est coché d\'office', ba.A.registre().reglages.auto === true);
  const c14 = new ConsoleSocle({ id: 'terraA9A8A7', code: 'SSSSSSTTTTTTVVVVVVWWWWWW' });
  ba.brancher(c14);
  await ba.cliquer('[data-action="nouveau"]');
  verifier('première carte : Chrome demande le port, une fois', await jusqua(() => ba.A.registre().socles[c14.id] && ba.A.registre().socles[c14.id].etape === 2, 8000) && ba.etat.choixPort === 1);
  const c15 = new ConsoleSocle({ id: 'terraA8A7A6', code: 'XXXXXXYYYYYYZZZZZZ234567' });
  ba.brancher(c15, { autorise: true });
  verifier('carte suivante reconnue par Chrome : l\'étape 1 démarre sans un clic', await jusqua(() => ba.A.registre().socles[c15.id] && ba.A.registre().socles[c15.id].etape === 2, 8000)
    && ba.etat.choixPort === 1, ba.A.registre().socles[c15.id] && ba.A.registre().socles[c15.id].echec ? ba.A.registre().socles[c15.id].echec.texte : '');
  const r14 = ba.A.registre().socles[c14.id];
  Object.assign(r14, { etape: 5, etat: 'pret', rodage: { debut: Date.now() - 2, fin: Date.now() - 1, incidents: [], verdict: { ok: true, texte: 'essai', t: Date.now() } } });
  const avantImpr = ba.etat.impressions;
  ba.brancher(c14, { autorise: true });
  verifier('socle prêt rebranché : étape 5 seule, étiquette imprimée d\'office', await jusqua(() => c14.etat.historiqueEfface && ba.etat.impressions === avantImpr + 1, 8000)
    && r14.expedition && r14.expedition.wifiOublie);
  ba.etat.port.debrancher();
  const c16 = new ConsoleSocle({ id: 'terraA7A6A5', code: '222222333333444444555555' });
  ba.brancher(c16, { autorise: false });
  ba.etat.autorises.push(ba.etat.port);
  await ba.cliquer('[data-action="nouveau"]');
  verifier('« Nouveau socle » avec un seul port autorisé : pas de fenêtre de choix', await jusqua(() => ba.A.registre().socles[c16.id] && ba.A.registre().socles[c16.id].etape === 2, 8000) && ba.etat.choixPort === 1);
  ba.A.registre().reglages.auto = false;
  const c17 = new ConsoleSocle({ id: 'terraA6A5A4', code: '666666777777888888999999' });
  ba.brancher(c17, { autorise: true });
  await attendre(400);
  verifier('« Démarrer seul » décoché : rien ne part', !c17.recu.length && !ba.A.registre().socles[c17.id]);

  titre('17. Registre partagé entre deux postes, rôle atelier');
  const SRV = 'https://exotic.exemple.fr';
  const srv = fauxServeurAtelier(SRV);
  const brokerP = new Broker();
  const pa = creerAtelier({ broker: brokerP, fetch: srv.fetch, serveur: SRV });
  const pb = creerAtelier({ broker: new Broker(), fetch: srv.fetch, serveur: SRV });
  await connecter(pa, 'jean@exemple.fr');
  verifier('rôle atelier (sans être administrateur) : connecté', !!pa.A._session() && pa.A._session().admin === false);
  verifier('le registre se partage dès la connexion', await jusqua(() => pa.A._partage().actif) && !pa.$('#etat-partage').hidden);
  verifier('alertes : la case e-mail est proposée', await jusqua(() => !pa.$('#alertes-atelier').hidden) && pa.$('#r-alertes-email').checked);
  pa.$('#r-alertes-email').checked = false;
  pa.$('#r-alertes-email').dispatchEvent(new pa.w.Event('change', { bubbles: true }));
  verifier('couper les e-mails d\'alerte : dit au serveur', await jusqua(() => srv.comptes['jean@exemple.fr'].email === false));
  pa.$('#r-ssid').value = 'AtelierBanc'; pa.$('#r-wifi-mdp').value = 'motdepasse8';
  await pa.soumettre(pa.$('#form-reglages'));
  verifier('Wi-Fi du banc saisi sur un poste : donné au serveur', await jusqua(() => srv.d.wifi && srv.d.wifi.ssid === 'AtelierBanc' && srv.d.wifi.motDePasse === 'motdepasse8'));
  verifier('le lot que le poste neuf s\'était créé passe au serveur', await jusqua(() => Object.keys(srv.d.lots).length === 1));
  await connecter(pb, 'noe@exemple.fr');
  verifier('autre poste : le Wi-Fi du banc arrive sans rien taper', await jusqua(() => pb.A.registre().reglages.ssid === 'AtelierBanc')
    && /motdepasse8/.test(pb.w.localStorage.getItem('terrarium.atelier.memo') || ''));
  verifier('autre poste : un seul lot, celui de l\'atelier', await jusqua(() => pb.A.registre().lots.length === 1 && pb.A.registre().lots[0].id === Object.keys(srv.d.lots)[0]));
  const c20 = new ConsoleSocle({ id: 'terraB1B2B3', code: 'KKKKKKMMMMMMNNNNNNPPPPPP', reseaux: [{ ssid: 'AtelierBanc', rssi: -45, securise: true }] });
  pa.brancher(c20);
  await pa.cliquer('[data-action="nouveau"]');
  const ra = () => pa.A.registre().socles[c20.id];
  verifier('étape 1 sur le poste A (rôle atelier) : compte d\'appareil créé', await jusqua(() => ra() && ra().etape === 2, 8000) && c20.etat.mqtt && c20.etat.mqtt.mdp === 'mdpAppareil88',
    ra() && ra().echec ? ra().echec.texte : '');
  verifier('la fiche est au serveur, sans code d\'appairage ni mot de passe', await jusqua(() => srv.d.socles[c20.id] && srv.d.socles[c20.id].etape === 2)
    && srv.requetes.filter(r => r.chemin.startsWith('/api/atelier/socles/')).every(r => !('code' in r.corps.socle) && !('web' in r.corps.socle)));
  const rb = () => pb.A.registre().socles[c20.id];
  verifier('le poste B voit le socle', await jusqua(() => rb() && rb().etape === 2, 20000) || (await pb.A._synchro(), !!rb()));
  pb.A.choisir(c20.id);
  await attendre(60);
  verifier('poste B, sans le code : « Reprendre sur ce poste (USB) » au lieu des commandes', !rb().code && !!pb.$('#fiche [data-action="reprendre-ici"]') && !pb.$('#fiche [data-action="identifier"]'));
  // Banc : le socle répond au poste A, qui a le code.
  const banc20 = new SocleBanc(brokerP, { id: c20.id, code: c20.code });
  banc20.enLigne();
  pa.A.choisir(c20.id);
  verifier('poste A : inventaire du bus lu', await jusqua(() => pa.A.vif(c20.id).inventaire && pa.A.vif(c20.id).inventaire.sondes.length === 2));
  await pa.cliquer('#fiche [data-action="identifier"][data-zone="1"]');
  verifier('poste A : zone 1 puis zone 2 d\'elle-même, étape 3', await jusqua(() => ra().etape === 3, 10000) && ra().sondes.length === 2 && banc20.refus === 0);
  await pa.cliquer('#fiche [data-action="essais"]');
  verifier('poste A : essais réussis, rodage lancé', await jusqua(() => ra().etape === 4 && ra().rodage, 8000));
  banc20.b.publier(`${banc20.base}/zone1/etat`, JSON.stringify({ temp: 31.8, consigne: 32, defaut: '1', defaut_libelle: 'SONDE ABSENTE' }), true);
  await attendre(200);
  verifier('socle relié au serveur : la page ne note pas le rodage (le serveur le fait)', ra().rodage.incidents.length === 0 && /Le serveur surveille ce rodage/.test(pa.texte('#fiche')));
  verifier('la fiche du rodage est au serveur', await jusqua(() => srv.d.socles[c20.id] && srv.d.socles[c20.id].etape === 4));
  // Le serveur conclut le rodage (comme lib/atelier.js) : les postes reprennent sa fiche.
  srv.ecrire(c20.id, { etat: 'pret', etape: 5, echec: null, rodage: { ...srv.d.socles[c20.id].rodage, verdict: { ok: true, texte: 'En marche depuis 24 h, sans redémarrage ni défaut', t: Date.now(), par: 'serveur' } } });
  await pa.A._synchro();
  verifier('poste A : verdict du serveur repris, code d\'appairage gardé', await jusqua(() => ra().etat === 'pret') && ra().code === c20.code && ra().rodage.verdict.par === 'serveur');
  // Deux postes changent la même fiche : le second reprend celle du serveur.
  await pb.A._synchro();
  pb.A.choisir(c20.id);
  await attendre(60);
  const fb = pb.$('#fiche form[data-form="cote"]');
  fb.elements.raison.value = 'banc 2 occupé';
  await pb.soumettre(fb);
  verifier('poste B : mis de côté, envoyé au serveur', await jusqua(() => srv.d.socles[c20.id].etat === 'cote'));
  pa.A.choisir(c20.id);
  await attendre(60);
  const fa = pa.$('#fiche form[data-form="cote"]');
  fa.elements.raison.value = 'autre raison';
  await pa.soumettre(fa);
  verifier('poste A, en retard d\'une révision : la fiche du serveur est reprise, le code reste', await jusqua(() => ra().cote && ra().cote.raison === 'banc 2 occupé') && ra().code === c20.code
    && /changée entre-temps/.test(pa.texte('#message')));
  // Un lot créé ici paraît là-bas.
  await pa.cliquer('[data-action="nouveau-lot"]');
  verifier('nouveau lot : vu par l\'autre poste', await jusqua(() => Object.keys(srv.d.lots).length === 2) && (await pb.A._synchro(), pb.A.registre().lots.length === 2));
  // Un poste qui avait son registre à lui, d'avant le partage : versé au serveur.
  const vieux = { v: 1, reglages: { liaison: 'serveur', ssid: 'AtelierBanc', serveur: { url: SRV } }, lots: [{ id: 'lot-ancien', nom: 'Lot ancien', cree: 1 }], lotCourant: 'lot-ancien',
    socles: { terraC1C2C3: { id: 'terraC1C2C3', lot: 'lot-ancien', etape: 4, etat: 'actif', liaison: 'serveur', code: 'ZZZZZZYYYYYYXXXXXXWWWWWW', maj: 5, journal: [], sondes: [], chauffe: [], rodage: null } } };
  const pc = creerAtelier({ broker: new Broker(), fetch: srv.fetch, serveur: SRV, stockage: { 'terrarium.atelier.v1': JSON.stringify(vieux) } });
  await connecter(pc, 'noe@exemple.fr');
  verifier('registre d\'avant le partage : ses socles et son lot vont au serveur, sans secret', await jusqua(() => srv.d.socles.terraC1C2C3 && srv.d.lots['lot-ancien'])
    && !('code' in srv.d.socles.terraC1C2C3) && pc.A.registre().socles.terraC1C2C3.code === 'ZZZZZZYYYYYYXXXXXXWWWWWW');

  titre('18. Étiquette sans USB (firmware 3.5.1)');
  const brokerR = new Broker();
  const xa = creerAtelier({ broker: brokerR });
  await regler(xa, REGLAGES);
  const c30 = new ConsoleSocle({ id: 'terraD1D2D3', code: 'CCCCCCDDDDDDEEEEEEFFFFFF', firmware: '3.5.1' });
  xa.brancher(c30);
  await xa.cliquer('[data-action="nouveau"]');
  const r30 = () => xa.A.registre().socles[c30.id];
  verifier('étape 1 (firmware 3.5.1)', await jusqua(() => r30() && r30().etape === 2, 8000));
  xa.etat.port.debrancher();
  const banc30 = new SocleBanc(brokerR, { id: c30.id, code: c30.code, version: '3.5.1' });
  banc30.enLigne();
  Object.assign(r30(), { etape: 5, etat: 'pret', rodage: { debut: Date.now() - 2, fin: Date.now() - 1, incidents: [], verdict: { ok: true, texte: 'essai', t: Date.now() } } });
  xa.A.choisir(c30.id);
  verifier('resté sur le banc : « Préparer et imprimer, sans USB » est proposé (l\'USB aussi)', await jusqua(() => xa.A.vif(c30.id).enLigne && !!xa.$('#fiche [data-action="preparer-reseau"]'), 4000)
    && !!xa.$('#fiche [data-action="preparer"]'));
  const impr30 = xa.etat.impressions;
  await xa.cliquer('#fiche [data-action="preparer-reseau"]');
  verifier('commande signée « expedier » (identifiant redit, broker de l\'atelier à oublier)', await jusqua(() => banc30.expedition, 4000) && banc30.expedition.broker === true && banc30.refus === 0);
  verifier('prêt sans USB : étiquette imprimée d\'office, la fiche dit où la coller', await jusqua(() => r30().expedition && r30().expedition.parReseau) && xa.etat.impressions === impr30 + 1
    && /Pret a expedier/.test(xa.texte('#fiche')) && !c30.recu.includes('wifi off'));
  await xa.cliquer('#fiche [data-action="expedier"]');
  verifier('expédié : code et mot de passe effacés', r30().etat === 'expedie' && !r30().code && !r30().web);
  const c31 = new ConsoleSocle({ id: 'terraD2D3D4', code: 'GGGGGGHHHHHHJJJJJJKKKKKK', firmware: '3.5.0' });
  xa.brancher(c31);
  await xa.cliquer('[data-action="nouveau"]');
  await jusqua(() => xa.A.registre().socles[c31.id] && xa.A.registre().socles[c31.id].etape === 2, 8000);
  xa.etat.port.debrancher();
  const banc31 = new SocleBanc(brokerR, { id: c31.id, code: c31.code, version: '3.5.0', connaitExpedier: false });
  banc31.enLigne();
  Object.assign(xa.A.registre().socles[c31.id], { etape: 5, etat: 'pret', rodage: { debut: 1, fin: 2, incidents: [], verdict: { ok: true, texte: 'essai', t: Date.now() } } });
  xa.A.choisir(c31.id);
  await jusqua(() => xa.A.vif(c31.id).enLigne, 3000);
  await attendre(80);
  verifier('firmware 3.5.0 : l\'USB seulement', !xa.$('#fiche [data-action="preparer-reseau"]') && !!xa.$('#fiche [data-action="preparer"]'));
  // Un firmware qui se dit 3.5.1 sans connaître l'action : l'atelier renvoie vers l'USB.
  banc31.version = '3.5.1';
  banc31.enLigne();
  await attendre(80);
  xa.A.choisir(c31.id);
  await jusqua(() => !!xa.$('#fiche [data-action="preparer-reseau"]'), 3000);
  await xa.cliquer('#fiche [data-action="preparer-reseau"]');
  verifier('action inconnue : le message renvoie vers l\'USB, les deux chemins restent', await jusqua(() => xa.A.registre().socles[c31.id].echec && /USB/.test(xa.A.registre().socles[c31.id].echec.texte), 4000)
    && await jusqua(() => !!xa.$('#fiche [data-action="preparer"]')));

  titre('19. Barres de progression ; fiche stable pendant les mesures');
  // Les seuils dont l'atelier mesure l'avancement sont ceux du firmware.
  const sourceAtelier = fs.readFileSync(path.join(DOSSIER, 'atelier.js'), 'utf8');
  const constante = (texte, nom) => { const m = new RegExp(`\\b${nom}\\s*=\\s*(\\d+(?:\\.\\d+)?)`).exec(texte); return m ? parseFloat(m[1]) : NaN; };
  const enTete = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  verifier('seuils de l\'atelier = ceux du firmware (identification, essai)',
    constante(sourceAtelier, 'IDENT_ECART') === constante(enTete('liaisons.h'), 'IDENT_ECART')
    && constante(sourceAtelier, 'ESSAI_HAUSSE') === constante(enTete('essai.h'), 'ESSAI_HAUSSE')
    && constante(sourceAtelier, 'IDENTIFICATION_MS') === constante(enTete('sondes.h'), 'IDENTIFICATION_S') * 1000
    && constante(sourceAtelier, 'ESSAI_MAX_MS') === constante(enTete('essai.h'), 'ESSAI_MS'));

  const manifesteB = async (url) => (/firmware\/manifest\.json$/.test(url)
    ? { ok: true, status: 200, json: async () => ({ name: 'Socle chauffant', version: '3.5.0', builds: [{ chipFamily: 'ESP32', parts: [] }] }) }
    : { ok: false, status: 404, json: async () => ({}) });
  const brokerB = new Broker();
  const pb19 = creerAtelier({ broker: brokerB, fetch: manifesteB });
  await regler(pb19, REGLAGES);
  const barre19 = () => pb19.$('#fiche .barre');
  const valeur19 = () => { const p = pb19.$('#fiche .barre progress'); return p && p.hasAttribute('value') ? p.value : null; };

  // Une installation qui échoue : le message dit quoi faire, la fenêtre reste en secours.
  const c40 = new ConsoleSocle({ id: 'terraE4E4E4', code: 'EEEEEEFFFFFFGGGGGGHHHHHH', firmware: '3.4.0' });
  pb19.A._installateur(async () => ({ state: 'error', message: 'Failed to initialize. Try resetting your device.', details: { error: 'failed_initialize' } }));
  pb19.brancher(c40);
  await pb19.cliquer('[data-action="nouveau"]');
  await pb19.cliquer('#fiche [data-action="console"]');
  verifier('échec de l\'installation : expliqué en français', await jusqua(() => /ne répond pas à son chargeur/.test(pb19.texte('#fiche')), 8000), pb19.texte('#fiche').slice(0, 200));
  verifier('… et la fenêtre d\'ESP Web Tools proposée en secours', !!pb19.$('#fiche [data-action="console-fenetre"]'));

  // Une installation qui ne donne plus de nouvelles : la barre le dit, et l'on peut abandonner.
  pb19.A._silences({ connexion: 150 });
  pb19.A._installateur(async (port, o) => { o.suivre({ state: 'initializing', message: 'Initializing...', details: { done: false } }); return new Promise(() => {}); });
  await pb19.cliquer('#fiche [data-action="console"]');
  verifier('installation muette : la barre le dit et propose d\'abandonner', await jusqua(() => /Rien de neuf depuis/.test(pb19.texte('#fiche .barre'))
    && pb19.$('#fiche .barre [data-action="abandonner-installation"]') && !pb19.$('#fiche .barre .boutons').hidden, 4000), pb19.texte('#fiche .barre'));
  await pb19.cliquer('#fiche .barre [data-action="abandonner-installation"]');
  verifier('… abandonnée : l\'atelier rend la main', await jusqua(() => /Installation abandonnée/.test(pb19.texte('#fiche')) && !!pb19.$('#fiche [data-action="console"]'), 4000), pb19.texte('#fiche').slice(0, 200));
  pb19.A._silences({ connexion: 30000 });

  // L'installation suivie dans la fiche : phase, part écrite, octets, puis la suite.
  let relacher = null;
  const options40 = [];
  pb19.A._installateur(async (port, o) => {
    options40.push(o);
    o.suivre({ state: 'initializing', message: 'Initializing...', details: { done: false } });
    o.suivre({ state: 'initializing', message: 'Initialized. Found ESP32', details: { done: true } });
    o.suivre({ state: 'preparing', message: 'Preparing installation...', details: { done: false } });
    o.suivre({ state: 'writing', message: 'Writing progress: 42%', details: { bytesTotal: 1000000, bytesWritten: 420000, percentage: 42 } });
    await new Promise(r => { relacher = r; });
    c40.firmware = '3.5.0';
    return { state: 'finished', message: 'All done!' };
  });
  await pb19.cliquer('#fiche [data-action="console"]');
  verifier('installation : barre en français, part écrite et taille', await jusqua(() => barre19() && /Firmware 3\.5\.0 : écriture 42 %/.test(pb19.texte('#fiche .barre'))
    && /410 Ko sur 977 Ko/.test(pb19.texte('#fiche .barre')) && /ne débranche pas la carte/.test(pb19.texte('#fiche .barre')), 6000), pb19.texte('#fiche .barre'));
  verifier('… la barre avance (part de toute l\'étape, en %)', valeur19() > 10 && valeur19() < 60 && /^\d+ %$/.test(pb19.texte('#fiche .barre-valeur')), `${valeur19()} ${pb19.texte('#fiche .barre-valeur')}`);
  verifier('… sans fenêtre : rien n\'est ajouté à la page', !pb19.$('ewt-install-dialog') && options40[0] && options40[0].effacer === false);
  relacher();
  const rec40 = () => pb19.A.registre().socles[c40.id];
  verifier('… puis l\'étape continue jusqu\'au banc', await jusqua(() => rec40() && rec40().etape === 2, 8000), rec40() && rec40().echec ? rec40().echec.texte : '');

  // Arrivée sur le banc : la barre compte le temps.
  pb19.A.choisir(c40.id);
  verifier('en attente du banc : une barre et le temps écoulé', await jusqua(() => /En attente du socle sur le banc/.test(pb19.texte('#fiche .barre')) && /\d+ s/.test(pb19.texte('#fiche .barre-valeur')), 3000));

  // Identification : ce que la sonde serrée a pris, sur 1 °C.
  const banc40 = new SocleBanc(brokerB, { id: c40.id, code: c40.code, dureeIdent: 4000 });
  banc40.enLigne();
  await jusqua(() => pb19.A.vif(c40.id).inventaire, 4000);
  await pb19.cliquer('#fiche [data-action="identifier"][data-zone="1"]');
  await jusqua(() => banc40.ident === 0, 3000);
  banc40.tempsSondes['28FF0000000000A1'] = 24.3;
  verifier('identification : la barre montre ce que la sonde a pris', await jusqua(() => /0\.8 °C sur 1\.0 °C/.test(pb19.texte('#fiche .barre')) && Math.round(valeur19()) === 80, 4000),
    `${pb19.texte('#fiche .barre')} ${valeur19()}`);
  banc40.dureeIdent = 100;
  banc40.tempsSondes['28FF0000000000A1'] = 23.5;
  verifier('les deux zones liées : étape 3', await jusqua(() => rec40().etape === 3, 12000), rec40().echec ? rec40().echec.texte : '');

  // Sonde muette : le socle publie 0 °C avec un défaut SONDE ; l'atelier affiche « — » et la piste.
  await jusqua(() => !!pb19.$('#fiche [data-action="essais"]'), 3000);
  brokerB.publier(`${banc40.base}/zone1/etat`, JSON.stringify({ temp: 0, consigne: 32, defaut: '1', defaut_libelle: 'SONDE' }), false);
  verifier('sonde muette : « — » au lieu de 0 °C, et la piste du câblage', await jusqua(() => /Zone 1 sans mesure : sonde muette/.test(pb19.texte('#fiche'))
    && /—/.test(pb19.texte('#fiche .mesures')) && !/0\.0 °C/.test(pb19.texte('#fiche .mesures')) && /—/.test(pb19.texte('#banc-grille')), 3000), pb19.texte('#fiche .mesures'));
  verifier('… et l\'on peut lever les défauts d\'ici (ils survivent au redémarrage)', /lever les défauts/.test(pb19.texte('#fiche [data-action="lever-defauts"]')) && /garde/.test(pb19.texte('#fiche .erreur-code')));
  await pb19.cliquer('#fiche [data-action="lever-defauts"]');
  verifier('défauts levés : commande signée, la zone repart', await jusqua(() => banc40.reset === 1 && !/sans mesure/.test(pb19.texte('#fiche')) && !pb19.$('#fiche [data-action="lever-defauts"]'), 4000)
    && banc40.refus === 0 && (rec40().journal || []).some(j => /Défauts levés depuis l'atelier/.test(j.texte)));

  // Essai de chauffe : ce que la sonde de la zone a gagné, sur la hausse annoncée par le socle.
  banc40.dureeEssai = 4000;
  await jusqua(() => !!pb19.$('#fiche [data-action="essais"]'), 3000);
  await pb19.cliquer('#fiche [data-action="essais"]');
  await jusqua(() => banc40.essai.zone === 1, 3000);
  brokerB.publier(`${banc40.base}/zone1/etat`, JSON.stringify({ ...banc40.zones[0], temp: 24.4 }), false);
  verifier('essai : la barre montre ce que la zone a gagné', await jusqua(() => /\+0\.3 °C sur \+0\.5 °C/.test(pb19.texte('#fiche .barre')) && Math.round(valeur19()) === 60, 4000),
    `${pb19.texte('#fiche .barre')} ${valeur19()}`);
  verifier('… et dit le verdict attendu', /Verdict dès que sa sonde gagne 0\.5 °C/.test(pb19.texte('#fiche .barre')));

  // Fiche stable : un volet ouvert reste ouvert, le focus reste en place, à chaque mesure.
  const journal19 = () => [...pb19.w.document.querySelectorAll('#fiche details')].find(d => /Journal du socle/.test(d.querySelector('summary').textContent));
  journal19().open = true;
  journal19().querySelector('summary').focus();
  brokerB.publier(`${banc40.base}/zone2/etat`, JSON.stringify({ ...banc40.zones[1], temp: 22.3 }), false);
  await attendre(120);
  verifier('nouvelle mesure : le journal reste ouvert', journal19() && journal19().open);
  verifier('… et le focus reste sur lui', pb19.w.document.activeElement && pb19.w.document.activeElement.tagName === 'SUMMARY' && /Journal du socle/.test(pb19.w.document.activeElement.textContent));
  banc40.dureeEssai = 100;
  verifier('essais réussis : rodage, avec sa barre', await jusqua(() => rec40().etape === 4 && /Rodage en cours/.test(pb19.texte('#fiche .barre')), 12000) && valeur19() !== null);

  // Passer le rodage : d'un bouton, noté au journal et au registre ; ou d'office, par réglage.
  await pb19.cliquer('#fiche [data-action="passer-rodage"]');
  verifier('rodage passé : le socle va à l\'étiquette, c\'est noté', await jusqua(() => rec40().etape === 5 && rec40().etat === 'pret', 3000)
    && rec40().rodage.verdict.passe === true && (rec40().journal || []).some(j => /Rodage passé : passé par l'opérateur/.test(j.texte)));
  await pb19.cliquer('[data-action="reglages"]');
  pb19.$('#r-sans-rodage').checked = true;
  await pb19.soumettre(pb19.$('#form-reglages'));
  verifier('réglage « sans rodage » enregistré', pb19.A.registre().reglages.sansRodage === true && pb19.$('#reglages').hidden);

  console.log(`\n=== ATELIER (${reussites} reussite(s), ${echecs} echec(s)) ===`);
  process.exit(echecs ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
