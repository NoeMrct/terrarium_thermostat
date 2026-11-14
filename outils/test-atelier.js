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
   l'étiquette, firmware sans « wifi off », mise de côté.

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
      usineOk: true, wifiOk: true, connaitWifiOff: true }, o);
    this.recu = [];
    this.etat = { web: null, wifi: null, mqtt: null, historiqueEfface: false };
    this.sortie = () => {};
  }
  dire(t, apres = 5) { setTimeout(() => this.sortie(t), apres); }
  ligne(l) {
    this.recu.push(l);
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
  const port = { file: [], attente: null, ouvert: false, console: console_ };
  const pousser = t => {
    const o = Uint8.from(Buffer.from(t, 'utf8'));
    if (port.attente) { const r = port.attente; port.attente = null; r({ value: o, done: false }); } else port.file.push(o);
  };
  console_.sortie = t => { if (port.ouvert) pousser(t); };
  port.open = async () => {
    port.ouvert = true;
    port.readable = { getReader: () => ({
      read: () => (port.file.length ? Promise.resolve({ value: port.file.shift(), done: false })
        : !port.ouvert ? Promise.resolve({ done: true }) : new Promise(r => { port.attente = r; })),
      cancel: async () => { port.ouvert = false; if (port.attente) { port.attente({ done: true }); port.attente = null; } },
      releaseLock() {}
    }) };
    let tampon = '';
    port.writable = { getWriter: () => ({
      write: async o => {
        tampon += Buffer.from(o).toString('utf8');
        let i;
        while ((i = tampon.indexOf('\n')) >= 0) { const l = tampon.slice(0, i).trim(); tampon = tampon.slice(i + 1); setTimeout(() => console_.ligne(l), 3); }
      },
      releaseLock() {}
    }) };
  };
  port.close = async () => { port.ouvert = false; };
  port.debrancher = () => { port.ouvert = false; if (port.attente) { port.attente({ done: true }); port.attente = null; } };
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
    Object.assign(this, { prefixe: 'terrarium', uptime: 600, roms: ['28FF0000000000A1', '28FF0000000000B2'], echecIdent: new Set(), echecEssai: new Set() }, o);
    this.b = b; this.ident = null; this.identResultat = ''; this.essai = { zone: 0, resultat: '' };
    this.refus = 0; this.liaisons = [null, null]; this.zones = [{ temp: 24.1, consigne: 32, defaut: '0', defaut_libelle: 'OK' }, { temp: 22.0, consigne: 28, defaut: '0', defaut_libelle: 'OK' }];
    this.base = `${this.prefixe}/${this.id}`;
    this.client = { subs: [`${this.base}/cmd`], recevoir: (s, c) => this.commande(c) };
    b.clients.add(this.client);
  }
  enLigne() {
    this.b.publier(`${this.base}/statut`, 'en ligne', true);
    this.b.publier(`${this.base}/sante`, JSON.stringify({ proto: 4, uptime: this.uptime, reset: 'mise sous tension' }), true);
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
        sondes: this.roms.map(r => ({ rom: r, temp: 23.5, zone: this.liaisons.indexOf(r) })), parasite: false,
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
        }, 1500);
        return this.repondre(d.req, true, { message: `Zone ${z + 1} : serrez sa sonde dans la main` });
      case 'essai':
        if (z === undefined) return this.repondre(d.req, true, { essai: { zone: this.essai.zone, restantS: this.essai.zone ? 590 : 0, resultat: this.essai.resultat } });
        this.essai = { zone: z + 1, resultat: '' };
        setTimeout(() => {
          this.essai = { zone: 0, resultat: this.echecEssai.has(z)
            ? `zone ${z + 1} : ECHEC, +0.1 C en 10 min. Verifier le 12 V, le tapis, son bilame, le MOSFET (D25), et que la sonde est bien sur la plaque.`
            : `zone ${z + 1} OK : sa sonde a pris +0.6 C en 1 min 05 s, l'autre rien. Tapis, MOSFET et sonde de cette zone sont bien associes.` };
        }, 200);
        return this.repondre(d.req, true, { message: `Zone ${z + 1} : chauffe seule a pleine puissance` });
      default: return this.repondre(d.req, false, { erreur: 'action inconnue' });
    }
  }
}

// ------------------------------------------------------------------- l'atelier
function creerAtelier({ broker, stockage = null, fetch = null } = {}) {
  const html = fs.readFileSync(path.join(DOSSIER, 'atelier.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://atelier.exemple.fr/atelier.html', pretendToBeVisual: true });
  const w = dom.window;
  for (const s of w.document.querySelectorAll('script[src]')) s.remove();
  if (stockage) for (const [k, v] of Object.entries(stockage)) w.localStorage.setItem(k, v);
  Object.defineProperty(w, 'crypto', { value: crypto.webcrypto, configurable: true });
  w.TextEncoder = TextEncoder;
  w.TextDecoder = TextDecoder;
  w.isSecureContext = true;
  const etat = { port: null, ports: [], impressions: 0, telechargements: [] };
  Object.defineProperty(w.navigator, 'serial', { configurable: true, value: {
    requestPort: async () => { if (!etat.port) { const e = new Error('aucun port'); e.name = 'NotFoundError'; throw e; } etat.ports.push(etat.port); return etat.port; },
    addEventListener() {}
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
  A._delais({ reponse: 3000, sondage: 60, essai: 60 });
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
  const brancher = c => { etat.port = creerPort(c, w.Uint8Array); return etat.port; };
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
  await a.cliquer('#fiche [data-action="identifier"][data-zone="2"]');
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
  const lien = a.A.lienEtiquette(c1.id);
  verifier('lien d\'installation de l\'étiquette', lien === `https://app.exemple.fr/#a/${c1.id}/${c1.code}`, lien);
  const svg = a.A.etiquette(c1.id);
  verifier('étiquette : code groupé et mot de passe imprimés', svg.includes('K7M2QX-ABCDEF-GH2345-678JKL') && svg.includes(`admin / ${rec().web.motDePasse}`));
  const QR = require(path.join(DOSSIER, 'qr.js'));
  const q = QR.chemin(lien, { marge: 1 });
  verifier('étiquette : le QR est celui du lien', svg.includes(q.d.slice(0, 200)) && svg.includes(`width="${q.cote}"`), `version ${q.version}`);
  verifier('aperçu affiché dans la fiche', !!a.$('#fiche .etiquette-apercu svg'));
  await a.cliquer('#fiche [data-action="imprimer"]');
  verifier('impression : seule l\'étiquette est dans la zone imprimée', a.etat.impressions === 1 && !!a.$('#etiquette-impression svg'));
  const btnExp = a.$('#fiche [data-action="expedier"]');
  verifier('« expédié » attend l\'étiquette collée', btnExp && btnExp.disabled);
  const coche = a.$('#fiche [data-colle]');
  coche.checked = true; coche.dispatchEvent(new a.w.Event('change', { bubbles: true }));
  verifier('étiquette collée : « expédié » possible', !a.$('#fiche [data-action="expedier"]').disabled);
  await a.cliquer('#fiche [data-action="expedier"]');
  const brut1 = a.w.localStorage.getItem('terrarium.atelier.v1');
  verifier('expédié : code et mot de passe effacés de l\'atelier', rec().etat === 'expedie' && !rec().code && !rec().web && !brut1.includes(c1.code) && !brut1.includes(c1.etat.web.mdp));
  verifier('le socle quitte le banc', await jusqua(() => !a.texte('#banc-grille').includes(c1.id)));

  titre('7. Auto-test raté, mise de côté, reprise');
  const c2 = new ConsoleSocle({ id: 'terraB2C3D4', code: 'QQQQQQWWWWWWEEEEEERRRRRR', usineOk: false });
  await a.cliquer('[data-action="nouveau"]');
  a.brancher(c2);
  await a.cliquer('#fiche [data-action="console"]');
  const rec2 = () => a.A.registre().socles[c2.id];
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

  console.log(`\n=== ATELIER (${reussites} reussite(s), ${echecs} echec(s)) ===`);
  process.exit(echecs ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
