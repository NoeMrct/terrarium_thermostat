'use strict';
/* Comptes du serveur : utilisateurs (l'application), appareils (les socles),
   jetons de session, droits. Tout vit dans donnees/comptes.json, réécrit à
   chaque changement (atomiquement : fichier temporaire puis renommage). Les
   mots de passe sont hachés par scrypt avec un sel par compte ; rien de
   réutilisable ailleurs ne dort sur le disque. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function hacher(motDePasse, sel) {
  return crypto.scryptSync(String(motDePasse), sel, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }).toString('hex');
}
function memeEmpreinte(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

class Comptes {
  constructor(dossier) {
    this.chemin = path.join(dossier, 'comptes.json');
    this.donnees = { utilisateurs: {}, appareils: {}, sessions: {}, abonnementsPush: {} };
    this.charger();
  }

  charger() {
    try {
      const lu = JSON.parse(fs.readFileSync(this.chemin, 'utf8'));
      for (const k of Object.keys(this.donnees)) if (lu[k] && typeof lu[k] === 'object') this.donnees[k] = lu[k];
    } catch (e) { /* premier démarrage */ }
  }

  sauver() {
    fs.mkdirSync(path.dirname(this.chemin), { recursive: true });
    const tmp = this.chemin + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.donnees, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.chemin);
  }

  // --- utilisateurs -----------------------------------------------------------
  static loginValide(login) { return /^[a-z0-9._@+-]{3,64}$/i.test(String(login || '')); }

  ajouterUtilisateur(login, motDePasse, options = {}) {
    if (!Comptes.loginValide(login)) throw new Error('identifiant invalide (3 à 64 caractères : lettres, chiffres, . _ @ + -)');
    if (String(motDePasse || '').length < 8) throw new Error('mot de passe : 8 caractères au minimum');
    const cle = login.toLowerCase();
    if (this.donnees.utilisateurs[cle]) throw new Error('identifiant déjà pris');
    const sel = crypto.randomBytes(16).toString('hex');
    this.donnees.utilisateurs[cle] = { login, sel, empreinte: hacher(motDePasse, sel), socles: [], admin: !!options.admin, cree: new Date().toISOString() };
    this.sauver();
    return this.donnees.utilisateurs[cle];
  }

  changerMotDePasse(login, motDePasse) {
    const u = this.utilisateur(login);
    if (!u) throw new Error('utilisateur inconnu');
    if (String(motDePasse || '').length < 8) throw new Error('mot de passe : 8 caractères au minimum');
    u.sel = crypto.randomBytes(16).toString('hex');
    u.empreinte = hacher(motDePasse, u.sel);
    // Les sessions ouvertes avec l'ancien mot de passe tombent.
    for (const [j, s] of Object.entries(this.donnees.sessions)) if (s.login === u.login.toLowerCase()) delete this.donnees.sessions[j];
    this.sauver();
  }

  utilisateur(login) { return this.donnees.utilisateurs[String(login || '').toLowerCase()] || null; }

  // Vérifie un couple identifiant / secret, où le secret est le mot de passe ou
  // un jeton de session en cours : c'est ce que présente l'application au
  // broker comme à l'API.
  authentifierUtilisateur(login, secret) {
    const u = this.utilisateur(login);
    if (!u) return null;
    const s = String(secret || '');
    if (s.length >= 8 && memeEmpreinte(hacher(s, u.sel), u.empreinte)) return u;
    const session = this.donnees.sessions[s];
    if (session && session.login === u.login.toLowerCase() && Date.parse(session.expire) > Date.now()) return u;
    return null;
  }

  ouvrirSession(login, dureeJours = 30) {
    const u = this.utilisateur(login);
    if (!u) throw new Error('utilisateur inconnu');
    const jeton = crypto.randomBytes(24).toString('hex');
    this.donnees.sessions[jeton] = { login: u.login.toLowerCase(), expire: new Date(Date.now() + dureeJours * 86400000).toISOString() };
    this.purgerSessions();
    this.sauver();
    return jeton;
  }

  fermerSession(jeton) { if (this.donnees.sessions[jeton]) { delete this.donnees.sessions[jeton]; this.sauver(); } }

  utilisateurDeSession(jeton) {
    const s = this.donnees.sessions[String(jeton || '')];
    if (!s || Date.parse(s.expire) <= Date.now()) return null;
    return this.utilisateur(s.login);
  }

  purgerSessions() {
    const maintenant = Date.now();
    for (const [j, s] of Object.entries(this.donnees.sessions)) if (Date.parse(s.expire) <= maintenant) delete this.donnees.sessions[j];
  }

  // --- appareils (socles) ---------------------------------------------------------
  static idValide(id) { return /^terra[0-9A-Za-z]{6}$/.test(String(id || '')); }

  ajouterAppareil(id, motDePasse) {
    if (!Comptes.idValide(id)) throw new Error('identifiant de socle invalide (terraXXXXXX)');
    const mdp = motDePasse || crypto.randomBytes(12).toString('base64url');
    if (mdp.length < 8) throw new Error('mot de passe : 8 caractères au minimum');
    const sel = crypto.randomBytes(16).toString('hex');
    this.donnees.appareils[id] = { id, sel, empreinte: hacher(mdp, sel), cree: new Date().toISOString() };
    this.sauver();
    return { id, motDePasse: mdp };
  }

  retirerAppareil(id) {
    if (!this.donnees.appareils[id]) return false;
    delete this.donnees.appareils[id];
    for (const u of Object.values(this.donnees.utilisateurs)) u.socles = u.socles.filter(s => s !== id);
    this.sauver();
    return true;
  }

  appareil(id) { return this.donnees.appareils[id] || null; }

  authentifierAppareil(id, motDePasse) {
    const a = this.appareil(id);
    if (!a) return null;
    return memeEmpreinte(hacher(motDePasse || '', a.sel), a.empreinte) ? a : null;
  }

  // --- droits ----------------------------------------------------------------------
  attribuerSocle(login, id) {
    const u = this.utilisateur(login);
    if (!u) throw new Error('utilisateur inconnu');
    if (!Comptes.idValide(id)) throw new Error('identifiant de socle invalide');
    if (!u.socles.includes(id)) { u.socles.push(id); this.sauver(); }
  }

  retirerSocle(login, id) {
    const u = this.utilisateur(login);
    if (!u) return;
    u.socles = u.socles.filter(s => s !== id);
    this.sauver();
  }

  possede(u, id) { return !!u && (u.admin || u.socles.includes(id)); }

  // Tous les utilisateurs qui ont un socle donné : destinataires des notifications.
  proprietaires(id) { return Object.values(this.donnees.utilisateurs).filter(u => u.socles.includes(id)); }

  // --- notifications push --------------------------------------------------------
  ajouterAbonnementPush(login, abonnement, agent) {
    const cle = String(login).toLowerCase();
    if (!abonnement || typeof abonnement.endpoint !== 'string' || !/^https:\/\//.test(abonnement.endpoint)) throw new Error('abonnement push invalide');
    const liste = this.donnees.abonnementsPush[cle] || (this.donnees.abonnementsPush[cle] = []);
    const existant = liste.findIndex(a => a.endpoint === abonnement.endpoint);
    const entree = { endpoint: abonnement.endpoint, keys: abonnement.keys, agent: String(agent || '').slice(0, 120), cree: new Date().toISOString() };
    if (existant >= 0) liste[existant] = entree; else liste.push(entree);
    if (liste.length > 10) liste.shift();
    this.sauver();
  }

  retirerAbonnementPush(login, endpoint) {
    const cle = String(login).toLowerCase();
    const liste = this.donnees.abonnementsPush[cle] || [];
    this.donnees.abonnementsPush[cle] = liste.filter(a => a.endpoint !== endpoint);
    this.sauver();
  }

  abonnementsPush(login) { return this.donnees.abonnementsPush[String(login).toLowerCase()] || []; }

  resume() {
    return {
      utilisateurs: Object.values(this.donnees.utilisateurs).map(u => ({ login: u.login, socles: u.socles, admin: u.admin, cree: u.cree })),
      appareils: Object.values(this.donnees.appareils).map(a => ({ id: a.id, cree: a.cree }))
    };
  }
}

module.exports = { Comptes, hacher };
