'use strict';
/* API HTTP du serveur : comptes (libre-service par e-mail et clés d'accès, ou
   identifiant et mot de passe), sessions, rattachement d'un socle à un compte
   (preuve par le code d'appairage, vérifiée auprès du socle), historique,
   abonnements push, rapports de diagnostic, export et effacement du compte,
   administration et état de la flotte. Les fichiers de l'application peuvent
   être servis depuis ici (SERVIR_APP=1) pour un déploiement entièrement
   auto-hébergé. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Comptes } = require('./comptes');
const webauthn = require('./webauthn');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
                '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.map': 'application/json',
                '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const LIMITE_CORPS = 64 * 1024;
const VALIDITE_CODE_MS = 10 * 60000;
const VALIDITE_DEFI_MS = 5 * 60000;
const empreinteCode = (email, code) => crypto.createHash('sha256').update(`${email}:${code}`).digest();
// Dans le journal : « no…@exemple.fr », jamais l'adresse entière.
const masquerEmail = e => String(e).replace(/^(.{0,2})[^@]*/, '$1…');

class Api {
  constructor({ comptes, broker, historique, notifications, options }) {
    this.comptes = comptes; this.broker = broker; this.historique = historique; this.notifications = notifications;
    this.o = options;
    this.tentatives = new Map();    // ip -> [instants] des connexions ratées
    this.dossierRapports = path.join(options.donnees, 'rapports');
    this.courriel = options.courriel || null;           // { envoyer({ a, sujet, texte }) } ou rien
    this.codes = new Map();           // e-mail -> { empreinte, expire, essais } : en mémoire seulement
    this.defis = new Map();           // défi WebAuthn -> { type, login, rpId, origine, expire }
    this.demandesIp = new Map();      // ip -> [instants] des codes demandés
    this.demandesEmail = new Map();   // e-mail -> [instants]
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
  estAdmin(req) {
    const jeton = Api.jetonDe(req);
    if (jeton && this.o.adminJeton && jeton === this.o.adminJeton) return true;
    const u = this.utilisateurDe(req);
    return !!(u && u.admin);
  }

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
      return this.json(res, 200, { serveur: 'terrariums', version: this.o.version, mqtt: { ws: '/mqtt', tcp: this.o.portMqtt }, push: !!this.notifications, prefixe: this.broker.prefixe,
        comptes: { email: !!this.courriel, clesAcces: true } });
    }
    if (chemin === '/api/session') {
      if (methode === 'POST') {
        if (this.tropDEssais(ip)) return this.erreur(res, 429, 'trop de tentatives, réessayer dans un quart d\'heure');
        const d = await this.lireJson(req);
        const u = this.comptes.authentifierUtilisateur(d.login, d.motDePasse);
        if (!u) { this.noterEchec(ip); return this.erreur(res, 401, 'identifiants refusés'); }
        const jeton = this.comptes.ouvrirSession(u.login);
        return this.json(res, 200, { jeton, login: u.login, socles: u.socles, admin: !!u.admin });
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
      if (nouveau) this.o.journal(`compte ouvert : ${masquerEmail(email)}`);
      return this.json(res, 200, { jeton, login: u.login, socles: u.socles, admin: !!u.admin, nouveau, clesAcces: (u.cles || []).length });
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
      return this.json(res, 200, { jeton, login: t.u.login, socles: t.u.socles, admin: !!t.u.admin });
    }

    if (methode === 'GET' && chemin === '/api/push/cle') {
      if (!this.notifications) return this.erreur(res, 404, 'notifications désactivées');
      return this.json(res, 200, { cle: this.notifications.clePublique() });
    }

    // Administration
    if (chemin.startsWith('/api/admin/') || chemin === '/api/flotte') {
      if (!this.estAdmin(req)) return this.erreur(res, 403, 'réservé à l\'administration');
      if (methode === 'GET' && chemin === '/api/flotte') return this.json(res, 200, { socles: this.broker.etatFlotte(), comptes: this.comptes.resume() });
      if (methode === 'GET' && chemin === '/api/admin/comptes') return this.json(res, 200, this.comptes.resume());
      if (methode === 'POST' && chemin === '/api/admin/utilisateurs') {
        const d = await this.lireJson(req);
        const u = this.comptes.ajouterUtilisateur(d.login, d.motDePasse, { admin: !!d.admin });
        return this.json(res, 201, { login: u.login });
      }
      if (methode === 'POST' && chemin === '/api/admin/appareils') {
        const d = await this.lireJson(req);
        return this.json(res, 201, this.comptes.ajouterAppareil(d.id, d.motDePasse));
      }
      const mAppareil = /^\/api\/admin\/appareils\/(terra[0-9A-Za-z]{6})$/.exec(chemin);
      if (methode === 'DELETE' && mAppareil) return this.json(res, 200, { retire: this.comptes.retirerAppareil(mAppareil[1]) });
      const mAttr = /^\/api\/admin\/utilisateurs\/([^/]+)\/socles$/.exec(chemin);
      if (methode === 'POST' && mAttr) {
        const d = await this.lireJson(req);
        this.comptes.attribuerSocle(decodeURIComponent(mAttr[1]), d.id);
        return this.json(res, 200, { ok: true });
      }
      return this.erreur(res, 404, 'route inconnue');
    }

    // Utilisateur connecté
    const u = this.utilisateurDe(req);
    if (!u) return this.erreur(res, 401, 'session requise');
    if (methode === 'GET' && chemin === '/api/moi') {
      return this.json(res, 200, { login: u.login, email: u.email || null, socles: u.socles, admin: !!u.admin, motDePasse: !!u.empreinte, clesAcces: (u.cles || []).length });
    }
    if (methode === 'GET' && chemin === '/api/moi/export') {
      res.setHeader('Content-Disposition', 'attachment; filename="terrariums-compte.json"');
      return this.json(res, 200, this.comptes.exporter(u.login));
    }
    if (methode === 'DELETE' && chemin === '/api/moi') {
      const d = await this.lireJson(req);
      if (String(d.confirmation || '').trim().toLowerCase() !== u.login.toLowerCase()) return this.erreur(res, 400, 'confirmation : recopier l\'identifiant du compte');
      const r = this.comptes.supprimerUtilisateur(u.login);
      for (const id of r.orphelins) this.historique.supprimer(id);
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
        return this.json(res, 201, { id: r.id, nom: String(d.nom || 'Clé d\'accès').slice(0, 60) });
      }
    }
    const mCle = /^\/api\/cles\/([A-Za-z0-9_-]{16,1400})$/.exec(chemin);
    if (methode === 'DELETE' && mCle) return this.json(res, 200, { retiree: this.comptes.retirerCle(u.login, mCle[1]) });

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
      return this.json(res, 200, { ok: true, socles: this.comptes.utilisateur(u.login).socles });
    }
    const mSocle = /^\/api\/socles\/(terra[0-9A-Za-z]{6})(\/historique)?$/.exec(chemin);
    if (mSocle) {
      const id = mSocle[1];
      if (!this.comptes.possede(u, id)) return this.erreur(res, 403, 'socle non rattaché à ce compte');
      if (methode === 'DELETE' && !mSocle[2]) { this.comptes.retirerSocle(u.login, id); return this.json(res, 200, { ok: true }); }
      if (methode === 'GET' && mSocle[2]) {
        const maintenant = Math.floor(Date.now() / 1000);
        const jusqua = Math.min(maintenant, parseInt(url.searchParams.get('jusqua') || maintenant, 10) || maintenant);
        const depuis = Math.max(0, parseInt(url.searchParams.get('depuis') || (jusqua - 86400), 10) || (jusqua - 86400));
        let pas = parseInt(url.searchParams.get('pas') || '60', 10); if (!(pas >= 60)) pas = 60;
        const points = this.historique.lire(id, depuis, jusqua, pas, 5000);
        return this.json(res, 200, { format: ['epoch', 't1', 'consigne1', 't2', 'consigne2'], unite: 'centiemes de degre', pas, depuis, jusqua, n: points.length, points });
      }
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
      const nom = `${new Date().toISOString().replace(/[:.]/g, '-')}-${u.login.replace(/[^a-z0-9]/gi, '_')}.txt`;
      fs.writeFileSync(path.join(this.dossierRapports, nom), texte.slice(0, LIMITE_CORPS));
      return this.json(res, 201, { ok: true, fichier: nom });
    }
    return this.erreur(res, 404, 'route inconnue');
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
