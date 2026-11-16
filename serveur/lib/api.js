'use strict';
/* API HTTP du serveur : comptes (libre-service par e-mail et clés d'accès, ou
   identifiant et mot de passe), sessions, rattachement d'un socle à un compte
   (preuve par le code d'appairage, vérifiée auprès du socle), historique,
   abonnements push, rapports de diagnostic, export et effacement du compte,
   administration (routes dans admin.js, console web sur /console/), MQTT par
   HTTPS pour les navigateurs privés de WebSocket (tunnel.js). Les fichiers de
   l'application peuvent être servis depuis ici (SERVIR_APP=1) pour un
   déploiement entièrement auto-hébergé. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Comptes } = require('./comptes');
const webauthn = require('./webauthn');
const { Admin } = require('./admin');
const { refCompte } = require('./audit');
const { RoutesSupport } = require('./support');
const { moisCouvert, prochainEnvoi } = require('./carnets');
const { Tunnels } = require('./tunnel');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
                '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.map': 'application/json',
                '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2' };
const LIMITE_CORPS = 64 * 1024;
const VALIDITE_CODE_MS = 10 * 60000;
const VALIDITE_DEFI_MS = 5 * 60000;
const empreinteCode = (email, code) => crypto.createHash('sha256').update(`${email}:${code}`).digest();
// Dans le journal : « no…@exemple.fr », jamais l'adresse entière.
const masquerEmail = e => String(e).replace(/^(.{0,2})[^@]*/, '$1…');
// Comparaison à temps constant de deux secrets de longueurs quelconques.
const memeSecret = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());
// Rapports de diagnostic : « <date>-<compte>.txt », le compte sans caractère
// spécial (donc sans tiret) ; gardés un an, et effacés avec le compte.
const compteDansNom = login => String(login).replace(/[^a-z0-9]/gi, '_');
const RETENTION_RAPPORTS_JOURS = 365;

// Console d'administration : quelques fichiers nommés, rien d'autre (pas de
// chemin construit depuis l'adresse). La feuille de style et la police sont
// celles de l'application.
const DOSSIER_CONSOLE = path.join(__dirname, '..', 'console');
const DOSSIER_APP = path.join(__dirname, '..', '..', 'app');
const CSP_CONSOLE = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "manifest-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'; require-trusted-types-for 'script'; trusted-types 'none'";
function fichierConsole(nom) {
  if (nom === '' || nom === 'index.html') return path.join(DOSSIER_CONSOLE, 'index.html');
  if (nom === 'console.js' || nom === 'console.css') return path.join(DOSSIER_CONSOLE, nom);
  if (nom === 'style.css' || nom === 'icone.svg') return path.join(DOSSIER_APP, nom);
  if (/^polices\/[a-z0-9-]{1,60}\.woff2$/.test(nom)) return path.join(DOSSIER_APP, nom);
  return null;
}

class Api {
  constructor({ comptes, broker, historique, notifications, audit, support, evenements, carnets, atelier, options }) {
    this.comptes = comptes; this.broker = broker; this.historique = historique; this.notifications = notifications;
    this.atelier = atelier || null;          // registre partagé de l'atelier (lib/atelier.js)
    this.carnets = carnets || null;         // carnet du mois par e-mail (F16)
    this.audit = audit || { noter() {}, lire: () => [], verifier: () => ({ ok: true, n: 0 }) };
    this.support = support || null;          // demandes et accès support (V11)
    this.evenements = evenements || null;    // ce que les socles ont vécu (frise, alertes)
    this.o = options;
    this.demarre = Date.now();
    this.admin = new Admin(this);
    this.routesSupport = new RoutesSupport(this);
    this.tentatives = new Map();    // ip -> [instants] des connexions ratées
    this.tentativesAdmin = new Map(); // ip -> [instants] des jetons inconnus présentés à /api/admin
    this.dossierRapports = path.join(options.donnees, 'rapports');
    this.courriel = options.courriel || null;           // { envoyer({ a, sujet, texte }) } ou rien
    this.codes = new Map();           // e-mail -> { empreinte, expire, essais } : en mémoire seulement
    this.defis = new Map();           // défi WebAuthn -> { type, login, rpId, origine, expire }
    this.demandesIp = new Map();      // ip -> [instants] des codes demandés
    this.demandesEmail = new Map();   // e-mail -> [instants]
  }

  // Vrai si la clé a déjà `n` événements sur la fenêtre (sans en ajouter).
  limiteAtteinte(table, cle, n, fenetreMs) {
    const maintenant = Date.now();
    const l = (table.get(cle) || []).filter(t => maintenant - t < fenetreMs);
    if (l.length) table.set(cle, l); else table.delete(cle);
    return l.length >= n;
  }

  // Au plus `n` événements par clé sur la fenêtre ; vrai si la limite est atteinte.
  limite(table, cle, n, fenetreMs) {
    const maintenant = Date.now();
    const l = (table.get(cle) || []).filter(t => maintenant - t < fenetreMs);
    if (l.length >= n) { table.set(cle, l); return true; }
    l.push(maintenant);
    table.set(cle, l);
    return false;
  }

  // --- clés d'accès : partie prenante et origine ------------------------------------
  // RP_ID réglé : il vaut pour toutes les cérémonies, depuis les origines de
  // ORIGINES. Sinon (installation sans ORIGINES), la cérémonie se lie à
  // l'origine qui la demande, notée avec le défi et exigée à la réponse.
  contexteWebauthn(req) {
    const origine = String(req.headers.origin || '');
    let hote;
    try { hote = new URL(origine).hostname; } catch (e) { return null; }
    const liste = Array.isArray(this.o.origines) ? this.o.origines : null;
    if (liste && !liste.includes(origine)) return null;
    const rpId = this.o.rpId || hote;
    if (hote !== rpId && !hote.endsWith('.' + rpId)) return null;
    return { rpId, origine };
  }
  nouveauDefi(type, contexte, login = null) {
    const maintenant = Date.now();
    for (const [d, v] of this.defis) if (v.expire < maintenant) this.defis.delete(d);
    if (this.defis.size > 5000) this.defis.clear();
    const defi = crypto.randomBytes(32).toString('base64url');
    this.defis.set(defi, { type, login, rpId: contexte.rpId, origine: contexte.origine, expire: maintenant + VALIDITE_DEFI_MS });
    return defi;
  }
  prendreDefi(defi, type) {
    const v = this.defis.get(String(defi || ''));
    if (!v) return null;
    this.defis.delete(String(defi));
    return v.type === type && v.expire > Date.now() ? v : null;
  }
  origineAcceptee(enregistre) {
    const liste = Array.isArray(this.o.origines) ? this.o.origines : null;
    return o => o === enregistre.origine && (!liste || liste.includes(o));
  }

  // --- utilitaires ------------------------------------------------------------------
  json(res, code, donnees) {
    const corps = JSON.stringify(donnees);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(corps);
  }
  erreur(res, code, message) { this.json(res, code, { erreur: message }); }

  lireCorps(req) {
    return new Promise((res, rej) => {
      let taille = 0; const morceaux = [];
      req.on('data', c => { taille += c.length; if (taille > LIMITE_CORPS) { rej(new Error('corps trop grand')); req.destroy(); return; } morceaux.push(c); });
      req.on('end', () => res(Buffer.concat(morceaux).toString('utf8')));
      req.on('error', rej);
    });
  }
  async lireJson(req) {
    const t = await this.lireCorps(req);
    if (!t) return {};
    try { return JSON.parse(t); } catch (e) { throw new Error('JSON invalide', { cause: e }); }
  }

  // Le jeton d'un en-tête « Authorization: Bearer <jeton> », sans expression
  // régulière : l'en-tête vient du réseau, et un motif à retours arrière y
  // serait une porte à déni de service.
  static jetonDe(req) {
    const entete = String(req.headers.authorization || '');
    if (entete.slice(0, 7).toLowerCase() !== 'bearer ') return null;
    const jeton = entete.slice(7).trim();
    return jeton || null;
  }
  utilisateurDe(req) {
    const jeton = Api.jetonDe(req);
    return jeton ? this.comptes.utilisateurDeSession(jeton) : null;
  }
  // Qui administre : le jeton d'administration, ou un compte de l'équipe
  // (session ouverte) — administrateur, support, ou atelier (montage des
  // socles). Sert de « qui » au journal d'audit ; support et atelier n'ont
  // chacun que leurs routes (admin.js, atelier.js).
  identiteAdmin(req) {
    const jeton = Api.jetonDe(req);
    if (!jeton) return null;
    if (this.o.adminJeton && memeSecret(jeton, this.o.adminJeton)) return { qui: 'jeton d\'administration', login: null, role: 'admin', support: true, atelier: true };
    const u = this.comptes.utilisateurDeSession(jeton);
    if (!u || !(u.admin || u.support || u.atelier)) return null;
    return { qui: u.login, login: u.login, role: u.admin ? 'admin' : u.support ? 'support' : 'atelier',
      support: !!(u.admin || u.support), atelier: !!(u.admin || u.atelier) };
  }
  // Ce que l'application et l'atelier savent des droits d'un compte.
  static droits(u) { return { admin: !!u.admin, equipe: !!(u.admin || u.support), atelier: !!(u.admin || u.atelier) }; }
  estAdmin(req) { return !!this.identiteAdmin(req); }

  // Dix échecs par adresse et par quart d'heure sur l'ouverture de session.
  tropDEssais(ip) {
    const maintenant = Date.now();
    const l = (this.tentatives.get(ip) || []).filter(t => maintenant - t < 900000);
    if (l.length) this.tentatives.set(ip, l); else this.tentatives.delete(ip);
    return l.length >= 10;
  }
  noterEchec(ip) {
    if (!this.tentatives.has(ip)) this.tentatives.set(ip, []);
    this.tentatives.get(ip).push(Date.now());
  }

  // Un compte effacé (par lui-même ou par l'administration) : l'historique et
  // les événements des socles qui n'ont plus de propriétaire partent, ses
  // demandes au support et ses rapports de diagnostic aussi, et un accès
  // support ouvert sur ces socles se ferme.
  async apresEffacement(login, orphelins) {
    for (const id of orphelins) {
      this.historique.supprimer(id);
      if (this.evenements) this.evenements.supprimer(id);
      if (this.support && this.support.acces.has(id)) await this.routesSupport.fermer(id, 'serveur', 'compte du propriétaire effacé');
    }
    if (this.support) this.support.oublierCompte(login);
    const suffixe = `-${compteDansNom(login)}.txt`;
    this.effacerRapports(nom => nom.endsWith(suffixe));
  }

  // Rapports de plus d'un an : effacés (appelé avec les autres purges).
  purgerRapports(maintenant = Date.now()) {
    const limite = maintenant - RETENTION_RAPPORTS_JOURS * 86400000;
    return this.effacerRapports((nom, f) => fs.statSync(f).mtimeMs < limite);
  }

  effacerRapports(choisir) {
    let noms;
    try { noms = fs.readdirSync(this.dossierRapports); } catch (e) { return 0; }
    let n = 0;
    for (const nom of noms) {
      const f = path.join(this.dossierRapports, nom);
      try { if (choisir(nom, f)) { fs.unlinkSync(f); n++; } } catch (e) { /* déjà parti */ }
    }
    return n;
  }

  // Une ligne au journal d'audit pour ce que fait le titulaire lui-même : la
  // frise d'un compte ou d'un socle montre aussi ses propres gestes.
  noterTitulaire(action, cible, details = null) { this.audit.noter({ qui: 'titulaire', action, cible, details }); }

  // Export d'un compte (RGPD, art. 15 et 20) : le compte, et ses demandes au
  // support telles que le client les voit.
  exportCompte(login) {
    const e = this.comptes.exporter(login);
    if (e && this.support) {
      e.demandesSupport = [...this.support.demandes.values()].filter(d => d.compte && d.compte.toLowerCase() === String(login).toLowerCase())
        .map(d => this.support.vueClient(d));
    }
    return e;
  }

  // État du carnet par e-mail tel que l'application le montre.
  etatCarnet(u, suite = {}) {
    const c = u.carnet || {};
    return { disponible: !!(this.courriel && this.carnets), email: u.email || null, actif: !!c.actif, socles: u.socles.slice(),
      noms: { ...(c.noms || {}) }, dernier: c.dernier || null, prochain: prochainEnvoi(), ...suite };
  }

  // Historique d'un socle (application du propriétaire, ou console).
  repondreHistorique(res, id, url) {
    const maintenant = Math.floor(Date.now() / 1000);
    const jusqua = Math.min(maintenant, parseInt(url.searchParams.get('jusqua') || maintenant, 10) || maintenant);
    const depuis = Math.max(0, parseInt(url.searchParams.get('depuis') || (jusqua - 86400), 10) || (jusqua - 86400));
    let pas = parseInt(url.searchParams.get('pas') || '60', 10); if (!(pas >= 60)) pas = 60;
    const points = this.historique.lire(id, depuis, jusqua, pas, 5000);
    return this.json(res, 200, { format: ['epoch', 't1', 'consigne1', 't2', 'consigne2'], unite: 'centiemes de degre', pas, depuis, jusqua, n: points.length, points });
  }

  cors(req, res) {
    const origine = req.headers.origin;
    const autorisees = this.o.origines;
    if (origine && (autorisees === '*' || (Array.isArray(autorisees) && autorisees.includes(origine)))) {
      res.setHeader('Access-Control-Allow-Origin', origine);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
  }

  // --- aiguillage ------------------------------------------------------------------------
  async traiter(req, res) {
    this.cors(req, res);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    const url = new URL(req.url, 'http://x');
    const chemin = url.pathname, methode = req.method;
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (methode === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    try {
      if (chemin.startsWith('/api/')) return await this.api(req, res, methode, chemin, url, ip);
      if (this.tunnels && Tunnels.concerne(chemin)) return this.tunnels.traiter(req, res, methode, chemin, ip);
      if (chemin === '/console') { res.writeHead(301, { Location: '/console/' }); res.end(); return; }
      if (chemin.startsWith('/console/')) return this.console(res, chemin.slice('/console/'.length));
      if (this.o.app) return this.statique(req, res, chemin);
      if (chemin === '/') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Serveur Terrariums ' + this.o.version + ' — API sur /api/, MQTT sur /mqtt\n'); return; }
      this.erreur(res, 404, 'page inconnue');
    } catch (e) {
      this.erreur(res, e.message === 'corps trop grand' ? 413 : 400, e.message);
    }
  }

  async api(req, res, methode, chemin, url, ip) {
    // Public
    if (methode === 'GET' && chemin === '/api/infos') {
      return this.json(res, 200, { serveur: 'terrariums', version: this.o.version, mqtt: { ws: '/mqtt', tunnel: '/mqtt/tunnel', tcp: this.o.portMqttEcoute !== undefined ? this.o.portMqttEcoute : this.o.portMqtt }, push: !!this.notifications, prefixe: this.broker.prefixe,
        comptes: { email: !!this.courriel, clesAcces: true, carnet: !!(this.courriel && this.carnets) } });
    }
    if (chemin === '/api/session') {
      if (methode === 'POST') {
        if (this.tropDEssais(ip)) return this.erreur(res, 429, 'trop de tentatives, réessayer dans un quart d\'heure');
        const d = await this.lireJson(req);
        const u = this.comptes.authentifierUtilisateur(d.login, d.motDePasse);
        if (!u) { this.noterEchec(ip); return this.erreur(res, 401, 'identifiants refusés'); }
        const jeton = this.comptes.ouvrirSession(u.login);
        return this.json(res, 200, { jeton, login: u.login, socles: u.socles, ...Api.droits(u) });
      }
      if (methode === 'DELETE') {
        const jeton = Api.jetonDe(req);
        if (jeton) this.comptes.fermerSession(jeton);
        return this.json(res, 200, { ok: true });
      }
    }
    // Connexion par e-mail : un code à six chiffres, dix minutes, cinq essais.
    // La réponse est la même que l'adresse ait un compte ou non.
    if (methode === 'POST' && chemin === '/api/compte/code') {
      if (!this.courriel) return this.erreur(res, 503, 'connexion par e-mail non configurée sur ce serveur');
      const d = await this.lireJson(req);
      const email = String(d.email || '').trim().toLowerCase();
      if (!Comptes.emailValide(email)) return this.erreur(res, 400, 'adresse e-mail invalide');
      if (this.limite(this.demandesIp, ip, 10, 900000) || this.limite(this.demandesEmail, email, 3, 900000)) {
        return this.erreur(res, 429, 'trop de demandes, réessayer dans un quart d\'heure');
      }
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      this.codes.set(email, { empreinte: empreinteCode(email, code), expire: Date.now() + VALIDITE_CODE_MS, essais: 0 });
      try {
        await this.courriel.envoyer({ a: email, sujet: `Votre code de connexion : ${code}`, texte:
          `Bonjour,\n\nVoici votre code pour vous connecter à Terrariums : ${code}\n\n` +
          'Il est valable 10 minutes. Si vous n\'avez rien demandé, ignorez ce message : sans ce code, personne ne peut entrer dans votre compte.\n\n— Terrariums\n' });
      } catch (e) {
        this.codes.delete(email);
        this.o.journal(`e-mail vers ${masquerEmail(email)} non envoyé : ${e.message}`);
        return this.erreur(res, 502, 'e-mail non envoyé, réessayer dans un moment');
      }
      return this.json(res, 200, { ok: true, valideMinutes: VALIDITE_CODE_MS / 60000 });
    }
    if (methode === 'POST' && chemin === '/api/compte/verifier') {
      if (this.tropDEssais(ip)) return this.erreur(res, 429, 'trop de tentatives, réessayer dans un quart d\'heure');
      const d = await this.lireJson(req);
      const email = String(d.email || '').trim().toLowerCase(), code = String(d.code || '').replace(/\s/g, '');
      const c = this.codes.get(email);
      if (!c || c.expire < Date.now() || !/^\d{6}$/.test(code)) { this.noterEchec(ip); return this.erreur(res, 401, 'code invalide ou expiré'); }
      if (!crypto.timingSafeEqual(empreinteCode(email, code), c.empreinte)) {
        if (++c.essais >= 5) this.codes.delete(email);
        this.noterEchec(ip);
        return this.erreur(res, 401, 'code invalide ou expiré');
      }
      this.codes.delete(email);
      const { u, nouveau } = this.comptes.obtenirParEmail(email);
      const jeton = this.comptes.ouvrirSession(u.login, { agent: req.headers['user-agent'] });
      if (nouveau) { this.o.journal(`compte ouvert : ${masquerEmail(email)}`); this.noterTitulaire('compte.ouvrir', refCompte(email)); }
      return this.json(res, 200, { jeton, login: u.login, socles: u.socles, ...Api.droits(u), nouveau, clesAcces: (u.cles || []).length });
    }
    // Connexion par clé d'accès : clés découvrables, aucune liste de clés
    // envoyée (elle dirait quelles adresses ont un compte).
    if (methode === 'POST' && chemin === '/api/cles/options-connexion') {
      const ctx = this.contexteWebauthn(req);
      if (!ctx) return this.erreur(res, 400, 'origine non acceptée pour les clés d\'accès');
      return this.json(res, 200, { challenge: this.nouveauDefi('connexion', ctx), rpId: ctx.rpId, timeout: 120000, userVerification: 'preferred', allowCredentials: [] });
    }
    if (methode === 'POST' && chemin === '/api/cles/connexion') {
      if (this.tropDEssais(ip)) return this.erreur(res, 429, 'trop de tentatives, réessayer dans un quart d\'heure');
      const d = await this.lireJson(req);
      const defi = this.prendreDefi(d.defi, 'connexion');
      const t = typeof d.id === 'string' ? this.comptes.cleParId(d.id) : null;
      if (!defi || !t) { this.noterEchec(ip); return this.erreur(res, 401, defi ? 'clé d\'accès inconnue de ce serveur' : 'défi expiré, recommencer'); }
      if (d.userHandle && d.userHandle !== t.u.idWebauthn) { this.noterEchec(ip); return this.erreur(res, 401, 'clé d\'accès d\'un autre compte'); }
      let r;
      try { r = webauthn.verifierConnexion(d, t.cle, { defi: d.defi, rpId: defi.rpId, origineAcceptee: this.origineAcceptee(defi) }); }
      catch (e) { this.noterEchec(ip); return this.erreur(res, 401, e.message); }
      this.comptes.noterUsageCle(d.id, r.compteur);
      const jeton = this.comptes.ouvrirSession(t.u.login, { agent: req.headers['user-agent'] });
      return this.json(res, 200, { jeton, login: t.u.login, socles: t.u.socles, ...Api.droits(t.u) });
    }

    if (methode === 'GET' && chemin === '/api/push/cle') {
      if (!this.notifications) return this.erreur(res, 404, 'notifications désactivées');
      return this.json(res, 200, { cle: this.notifications.clePublique() });
    }

    // Administration (console, scripts, atelier). Un jeton inconnu de tous
    // compte comme un essai raté : vingt par quart d'heure et par adresse.
    if (chemin.startsWith('/api/admin/') || chemin === '/api/flotte') {
      if (this.limiteAtteinte(this.tentativesAdmin, ip, 20, 900000)) return this.erreur(res, 429, 'trop de tentatives, réessayer dans un quart d\'heure');
      const qui = this.identiteAdmin(req);
      if (!qui) {
        const jeton = Api.jetonDe(req);
        if (jeton && !this.comptes.session(jeton)) this.limite(this.tentativesAdmin, ip, Infinity, 900000);
        return this.erreur(res, 403, 'réservé à l\'administration');
      }
      return await this.admin.traiter(req, res, methode, chemin, url, qui);
    }
    // Atelier : registre partagé, Wi-Fi du banc, alertes (administrateurs et
    // rôle atelier). Même limitation des jetons inconnus que l'administration.
    if (chemin.startsWith('/api/atelier/')) {
      if (!this.atelier) return this.erreur(res, 404, 'atelier indisponible sur ce serveur');
      if (this.limiteAtteinte(this.tentativesAdmin, ip, 20, 900000)) return this.erreur(res, 429, 'trop de tentatives, réessayer dans un quart d\'heure');
      const qui = this.identiteAdmin(req);
      if (!qui || !(qui.role === 'admin' || qui.atelier)) {
        const jeton = Api.jetonDe(req);
        if (jeton && !qui && !this.comptes.session(jeton)) this.limite(this.tentativesAdmin, ip, Infinity, 900000);
        return this.json(res, 403, { erreur: 'réservé à l\'atelier (administrateurs et rôle atelier)', droits: 'atelier' });
      }
      return await this.atelier.traiter(this, req, res, methode, chemin, url, qui);
    }

    // Utilisateur connecté
    const u = this.utilisateurDe(req);
    if (!u) return this.erreur(res, 401, 'session requise');
    if (methode === 'GET' && chemin === '/api/moi') {
      return this.json(res, 200, { login: u.login, email: u.email || null, socles: u.socles, ...Api.droits(u), motDePasse: !!u.empreinte, clesAcces: (u.cles || []).length,
        partages: Object.fromEntries(Object.entries(u.partages || {}).map(([id, p]) => [id, { droit: p.droit, jusqua: p.jusqua || null }])) });
    }
    // Partage (F12) : accepter une invitation reçue.
    if (methode === 'POST' && chemin === '/api/invitations/accepter') {
      const d = await this.lireJson(req);
      let r;
      try { r = this.comptes.accepterInvitation(u.login, d.code); }
      catch (e) { return this.erreur(res, 400, e.message); }
      this.noterTitulaire('socle.partage.accepter', r.socle, { compte: refCompte(u.login), droit: r.droit, jusqua: r.jusqua ? new Date(r.jusqua).toISOString() : null });
      return this.json(res, 200, { ok: true, socle: r.socle, droit: r.droit, jusqua: r.jusqua, socles: this.comptes.utilisateur(u.login).socles });
    }
    // Carnet du mois par e-mail : la préférence du titulaire, et les noms de
    // ses socles tels que l'application les montre.
    if (chemin === '/api/moi/carnet' && methode === 'GET') return this.json(res, 200, this.etatCarnet(u));
    if (chemin === '/api/moi/carnet' && methode === 'POST') {
      if (!this.courriel || !this.carnets) return this.erreur(res, 503, 'e-mail non configuré sur ce serveur');
      const d = await this.lireJson(req);
      if (d.actif !== undefined && typeof d.actif !== 'boolean') return this.erreur(res, 400, 'actif : true ou false');
      if (d.actif && !u.email) return this.erreur(res, 400, 'ce compte n\'a pas d\'adresse e-mail');
      const avant = !!(u.carnet && u.carnet.actif), m = moisCouvert();
      const c = this.comptes.definirCarnet(u.login, { actif: d.actif, noms: d.noms });
      const suite = {};
      if (c.actif && !avant) {
        // À l'activation, le carnet du mois écoulé part tout de suite : le
        // titulaire voit ce qu'il recevra. Une fois par mois au plus.
        if (!(c.dernier && c.dernier >= m.cle) && u.socles.length) {
          try { await this.carnets.envoyer(u, m); suite.envoye = m.cle; }
          catch (e) {
            suite.nonEnvoye = 'premier carnet non envoyé ; le suivant partira à la date prévue';
            this.o.journal(`carnet ${m.cle} non envoyé à ${masquerEmail(u.email)} : ${e.message}`);
          }
        }
        this.comptes.definirCarnet(u.login, { dernier: m.cle });
      }
      if (c.actif !== avant) this.noterTitulaire('compte.carnet', refCompte(u.login), { actif: c.actif });
      return this.json(res, 200, this.etatCarnet(u, suite));
    }
    // Noms des socles dans l'application : titres des notifications (U35).
    if (chemin === '/api/moi/noms' && methode === 'POST') {
      const d = await this.lireJson(req);
      try { return this.json(res, 200, { noms: this.comptes.definirNoms(u.login, d.noms) }); }
      catch (e) { return this.erreur(res, 400, e.message); }
    }
    if (methode === 'GET' && chemin === '/api/moi/export') {
      res.setHeader('Content-Disposition', 'attachment; filename="terrariums-compte.json"');
      return this.json(res, 200, this.exportCompte(u.login));
    }
    // Support : accès ouverts par le titulaire, demandes et messages.
    if (chemin.startsWith('/api/support/')) {
      if (!this.support) return this.erreur(res, 404, 'support indisponible sur ce serveur');
      return await this.routesSupport.proprietaire(req, res, methode, chemin, url, u);
    }
    if (methode === 'DELETE' && chemin === '/api/moi') {
      const d = await this.lireJson(req);
      if (String(d.confirmation || '').trim().toLowerCase() !== u.login.toLowerCase()) return this.erreur(res, 400, 'confirmation : recopier l\'identifiant du compte');
      const nbSocles = u.socles.length;
      const r = this.comptes.supprimerUtilisateur(u.login);
      await this.apresEffacement(u.login, r.orphelins);
      this.noterTitulaire('compte.supprimer', refCompte(u.login), { socles: nbSocles, historiquesEffaces: r.orphelins.length });
      this.o.journal(`compte effacé à la demande de son titulaire${r.orphelins.length ? ` (${r.orphelins.length} historique(s) de socle effacé(s))` : ''}`);
      return this.json(res, 200, { ok: true, historiquesEffaces: r.orphelins.length });
    }
    // Clés d'accès du compte : inscription (session ouverte requise), liste, retrait.
    if (methode === 'POST' && chemin === '/api/cles/options-creation') {
      const ctx = this.contexteWebauthn(req);
      if (!ctx) return this.erreur(res, 400, 'origine non acceptée pour les clés d\'accès');
      return this.json(res, 200, {
        challenge: this.nouveauDefi('creation', ctx, u.login),
        rp: { id: ctx.rpId, name: this.o.rpNom || 'Terrariums' },
        user: { id: this.comptes.idWebauthn(u), name: u.email || u.login, displayName: u.email || u.login },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }],
        timeout: 120000, attestation: 'none',
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'preferred' },
        excludeCredentials: (u.cles || []).map(c => ({ type: 'public-key', id: c.id }))
      });
    }
    if (chemin === '/api/cles') {
      if (methode === 'GET') return this.json(res, 200, { cles: (u.cles || []).map(c => ({ id: c.id, nom: c.nom, cree: c.cree, vu: c.vu, synchronisee: !!c.synchronisee })) });
      if (methode === 'POST') {
        const d = await this.lireJson(req);
        const defi = this.prendreDefi(d.defi, 'creation');
        if (!defi || defi.login !== u.login) return this.erreur(res, 400, 'défi expiré, recommencer');
        let r;
        try { r = webauthn.verifierInscription(d, { defi: d.defi, rpId: defi.rpId, origineAcceptee: this.origineAcceptee(defi) }); }
        catch (e) { return this.erreur(res, 400, e.message); }
        if (d.id && d.id !== r.id) return this.erreur(res, 400, 'identifiant de clé incohérent');
        this.comptes.ajouterCle(u.login, { ...r, nom: d.nom });
        this.noterTitulaire('compte.cle.ajouter', refCompte(u.login), { nom: String(d.nom || 'Clé d\'accès').slice(0, 60) });
        return this.json(res, 201, { id: r.id, nom: String(d.nom || 'Clé d\'accès').slice(0, 60) });
      }
    }
    const mCle = /^\/api\/cles\/([A-Za-z0-9_-]{16,1400})$/.exec(chemin);
    if (methode === 'DELETE' && mCle) {
      const cle = (u.cles || []).find(x => x.id === mCle[1]);
      const retiree = this.comptes.retirerCle(u.login, mCle[1]);
      if (retiree) this.noterTitulaire('compte.cle.retirer', refCompte(u.login), { nom: cle.nom });
      return this.json(res, 200, { retiree });
    }

    if (methode === 'POST' && chemin === '/api/socles/revendiquer') {
      const d = await this.lireJson(req);
      if (!Comptes.idValide(d.id)) return this.erreur(res, 400, 'identifiant de socle invalide');
      if (!/^[A-Z0-9]{24}$/.test(String(d.jeton || ''))) return this.erreur(res, 400, 'code d\'appairage : 24 caractères');
      // La preuve : le socle lui-même accepte le code sur une action protégée
      // mais sans effet (lecture des réglages globaux).
      let r;
      try { r = await this.broker.commander(d.id, 'globaux', { jeton: d.jeton }); }
      catch (e) { return this.erreur(res, 504, 'le socle ne répond pas (hors ligne, ou pas encore relié à ce serveur)'); }
      if (!r.ok) return this.erreur(res, 403, 'code d\'appairage refusé par le socle');
      this.comptes.attribuerSocle(u.login, d.id);
      this.noterTitulaire('socle.rattacher', d.id, { compte: refCompte(u.login) });
      return this.json(res, 200, { ok: true, socles: this.comptes.utilisateur(u.login).socles });
    }
    // Partage (F12) : qui a accès, inviter, annuler, retirer — le titulaire seul.
    const mPartage = /^\/api\/socles\/(terra[0-9A-Za-z]{6})\/(partages|invitations)(?:\/([A-Za-z0-9._@%+-]{1,120}))?$/.exec(chemin);
    if (mPartage) {
      const id = mPartage[1], quoi = mPartage[2], qui = mPartage[3] ? decodeURIComponent(mPartage[3]) : null;
      if (!this.comptes.estProprietaire(u, id)) return this.erreur(res, 403, 'seul le titulaire du socle gère son partage');
      if (methode === 'GET' && quoi === 'partages' && !qui) {
        return this.json(res, 200, { acces: this.comptes.accesDe(id).map(a => ({ ...a, moi: a.login === u.login })), invitations: this.comptes.invitationsDe(id) });
      }
      if (methode === 'POST' && quoi === 'invitations' && !qui) {
        const d = await this.lireJson(req);
        let inv;
        try { inv = this.comptes.creerInvitation(u.login, id, { droit: d.droit, jours: d.jours }); }
        catch (e) { return this.erreur(res, 400, e.message); }
        this.noterTitulaire('socle.partage.inviter', id, { compte: refCompte(u.login), droit: inv.droit, jusqua: inv.jusqua ? new Date(inv.jusqua).toISOString() : null });
        return this.json(res, 201, { code: inv.code, droit: inv.droit, jusqua: inv.jusqua, expire: inv.expire });
      }
      if (methode === 'DELETE' && quoi === 'invitations' && qui) return this.json(res, 200, { annulee: this.comptes.annulerInvitation(id, qui) });
      if (methode === 'DELETE' && quoi === 'partages' && qui) {
        const retire = this.comptes.retirerPartage(id, qui);
        if (retire) this.noterTitulaire('socle.partage.retirer', id, { compte: refCompte(u.login), invite: refCompte(qui) });
        return this.json(res, 200, { retire });
      }
      return this.erreur(res, 405, 'méthode non prise en charge');
    }
    const mSocle = /^\/api\/socles\/(terra[0-9A-Za-z]{6})(\/historique)?$/.exec(chemin);
    if (mSocle) {
      const id = mSocle[1];
      if (!this.comptes.possede(u, id)) return this.erreur(res, 403, 'socle non rattaché à ce compte');
      if (methode === 'DELETE' && !mSocle[2]) {
        this.comptes.retirerSocle(u.login, id);
        // Le dernier titulaire parti, ceux avec qui il partageait le socle le perdent aussi.
        const invites = this.comptes.sansTitulaire(id);
        this.noterTitulaire('socle.detacher', id, { compte: refCompte(u.login), ...(invites ? { invitesRetires: invites } : {}) });
        return this.json(res, 200, { ok: true });
      }
      if (methode === 'GET' && mSocle[2]) return this.repondreHistorique(res, id, url);
    }

    if (chemin === '/api/push/abonnement') {
      if (!this.notifications) return this.erreur(res, 404, 'notifications désactivées');
      const d = await this.lireJson(req);
      if (methode === 'POST') { this.comptes.ajouterAbonnementPush(u.login, d.abonnement, req.headers['user-agent']); return this.json(res, 200, { ok: true, abonnements: this.comptes.abonnementsPush(u.login).length }); }
      if (methode === 'DELETE') { this.comptes.retirerAbonnementPush(u.login, d.endpoint); return this.json(res, 200, { ok: true }); }
    }
    if (methode === 'POST' && chemin === '/api/push/essai') {
      if (!this.notifications) return this.erreur(res, 404, 'notifications désactivées');
      const n = await this.notifications.notifier(this.comptes, u.login, { titre: 'Terrariums', corps: 'Les notifications push fonctionnent sur cet appareil.', tag: 'essai' });
      return this.json(res, 200, { envoyes: n });
    }
    if (methode === 'POST' && chemin === '/api/rapports') {
      const texte = await this.lireCorps(req);
      fs.mkdirSync(this.dossierRapports, { recursive: true });
      const nom = `${new Date().toISOString().replace(/[:.]/g, '-')}-${compteDansNom(u.login)}.txt`;
      fs.writeFileSync(path.join(this.dossierRapports, nom), texte.slice(0, LIMITE_CORPS));
      this.noterTitulaire('rapport.envoyer', refCompte(u.login), { fichier: nom });
      return this.json(res, 201, { ok: true, fichier: nom });
    }
    return this.erreur(res, 404, 'route inconnue');
  }

  console(res, nom) {
    const f = fichierConsole(nom);
    if (!f) { this.erreur(res, 404, 'fichier inconnu'); return; }
    fs.readFile(f, (e, d) => {
      if (e) { this.erreur(res, 404, 'fichier inconnu'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache',
        'Content-Security-Policy': CSP_CONSOLE, 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
        'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), serial=(), usb=()' });
      res.end(d);
    });
  }

  statique(req, res, chemin) {
    let f = path.normalize(path.join(this.o.app, decodeURIComponent(chemin)));
    if (!f.startsWith(path.normalize(this.o.app))) { this.erreur(res, 403, 'refusé'); return; }
    if (chemin.endsWith('/')) f = path.join(f, 'index.html');
    fs.readFile(f, (e, d) => {
      if (e) { this.erreur(res, 404, 'fichier inconnu'); return; }
      const ext = path.extname(f);
      res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' || f.endsWith('sw.js') || f.endsWith('version.json') ? 'no-cache' : 'public, max-age=3600' });
      res.end(d);
    });
  }
}

module.exports = { Api };
