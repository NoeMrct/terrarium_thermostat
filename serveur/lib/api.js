'use strict';
/* API HTTP du serveur : sessions, rattachement d'un socle à un compte (preuve
   par le code d'appairage, vérifiée auprès du socle), historique, abonnements
   push, rapports de diagnostic, administration et état de la flotte. Les
   fichiers de l'application peuvent être servis depuis ici (SERVIR_APP=1) pour
   un déploiement entièrement auto-hébergé. */

const fs = require('fs');
const path = require('path');
const { Comptes } = require('./comptes');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
                '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.map': 'application/json',
                '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const LIMITE_CORPS = 64 * 1024;

class Api {
  constructor({ comptes, broker, historique, notifications, options }) {
    this.comptes = comptes; this.broker = broker; this.historique = historique; this.notifications = notifications;
    this.o = options;
    this.tentatives = {};           // ip -> [instants] des connexions ratées
    this.dossierRapports = path.join(options.donnees, 'rapports');
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

  utilisateurDe(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (!m) return null;
    return this.comptes.utilisateurDeSession(m[1].trim());
  }
  estAdmin(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (m && this.o.adminJeton && m[1].trim() === this.o.adminJeton) return true;
    const u = this.utilisateurDe(req);
    return !!(u && u.admin);
  }

  // Dix échecs par adresse et par quart d'heure sur l'ouverture de session.
  tropDEssais(ip) {
    const maintenant = Date.now();
    const l = (this.tentatives[ip] || []).filter(t => maintenant - t < 900000);
    this.tentatives[ip] = l;
    return l.length >= 10;
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
      return this.json(res, 200, { serveur: 'terrariums', version: this.o.version, mqtt: { ws: '/mqtt', tcp: this.o.portMqtt }, push: !!this.notifications, prefixe: this.broker.prefixe });
    }
    if (chemin === '/api/session') {
      if (methode === 'POST') {
        if (this.tropDEssais(ip)) return this.erreur(res, 429, 'trop de tentatives, réessayer dans un quart d\'heure');
        const d = await this.lireJson(req);
        const u = this.comptes.authentifierUtilisateur(d.login, d.motDePasse);
        if (!u) { (this.tentatives[ip] = this.tentatives[ip] || []).push(Date.now()); return this.erreur(res, 401, 'identifiants refusés'); }
        const jeton = this.comptes.ouvrirSession(u.login);
        return this.json(res, 200, { jeton, login: u.login, socles: u.socles, admin: !!u.admin });
      }
      if (methode === 'DELETE') {
        const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
        if (m) this.comptes.fermerSession(m[1].trim());
        return this.json(res, 200, { ok: true });
      }
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
    if (methode === 'GET' && chemin === '/api/moi') return this.json(res, 200, { login: u.login, socles: u.socles, admin: !!u.admin });

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
