'use strict';
/* Comptes du serveur : utilisateurs (l'application), appareils (les socles),
   jetons de session, clés d'accès, droits. Tout vit dans donnees/comptes.json,
   réécrit à chaque changement (atomiquement : fichier temporaire puis
   renommage). Les mots de passe sont hachés par scrypt avec un sel par compte,
   les jetons de session par SHA-256 : rien de réutilisable ailleurs ne dort sur
   le disque, pas même une session en cours.

   Deux sortes de comptes utilisateur : ceux créés par l'administration, avec
   identifiant et mot de passe ; ceux ouverts en libre-service par e-mail (code
   à usage unique, puis clés d'accès), sans mot de passe du tout. Pour les
   seconds, le jeton de session sert aussi de mot de passe au broker : la
   session glisse (30 jours sans usage la ferment).

   En mémoire, chaque registre est une Map : les clés viennent du réseau
   (identifiants, jetons) et une Map n'a ni prototype à polluer ni propriété
   héritée à confondre avec un compte (« constructor », « __proto__ »…). */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const DUREE_SESSION_J = 30;
const cleSession = jeton => 'h:' + crypto.createHash('sha256').update(String(jeton)).digest('hex');
const EMAIL = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}$/i;

function hacher(motDePasse, sel) {
  return crypto.scryptSync(String(motDePasse), sel, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }).toString('hex');
}
function memeEmpreinte(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const REGISTRES = ['utilisateurs', 'appareils', 'sessions', 'abonnementsPush'];

class Comptes {
  constructor(dossier) {
    this.chemin = path.join(dossier, 'comptes.json');
    this.donnees = {};
    for (const k of REGISTRES) this.donnees[k] = new Map();
    this.charger();
  }

  charger() {
    try {
      const lu = JSON.parse(fs.readFileSync(this.chemin, 'utf8'));
      for (const k of REGISTRES) {
        if (lu[k] && typeof lu[k] === 'object') this.donnees[k] = new Map(Object.entries(lu[k]));
      }
    } catch (e) { /* premier démarrage */ }
    // Sessions d'avant le hachage : la clé était le jeton lui-même.
    let migre = false;
    for (const [j, v] of [...this.donnees.sessions]) {
      if (!j.startsWith('h:')) { this.donnees.sessions.delete(j); this.donnees.sessions.set(cleSession(j), v); migre = true; }
    }
    for (const u of this.donnees.utilisateurs.values()) if (!Array.isArray(u.cles)) u.cles = [];
    if (migre) this.sauver();
  }

  sauver() {
    fs.mkdirSync(path.dirname(this.chemin), { recursive: true });
    const tmp = this.chemin + '.tmp';
    const plat = {};
    for (const k of REGISTRES) plat[k] = Object.fromEntries(this.donnees[k]);
    fs.writeFileSync(tmp, JSON.stringify(plat, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.chemin);
  }

  // Écriture différée : prolonger une session à chaque connexion MQTT ne doit
  // pas réécrire le fichier à chaque fois.
  sauverBientot() {
    if (this.minuteurSauvegarde) return;
    this.minuteurSauvegarde = setTimeout(() => { this.minuteurSauvegarde = null; this.sauver(); }, 2000);
    if (this.minuteurSauvegarde.unref) this.minuteurSauvegarde.unref();
  }

  // --- utilisateurs -----------------------------------------------------------
  static loginValide(login) { return /^[a-z0-9._@+-]{3,64}$/i.test(String(login || '')) || Comptes.emailValide(login); }
  static emailValide(email) { const e = String(email || ''); return e.length <= 254 && EMAIL.test(e); }

  ajouterUtilisateur(login, motDePasse, options = {}) {
    if (!Comptes.loginValide(login)) throw new Error('identifiant invalide (3 à 64 caractères : lettres, chiffres, . _ @ + -)');
    if (String(motDePasse || '').length < 8) throw new Error('mot de passe : 8 caractères au minimum');
    const cle = login.toLowerCase();
    if (this.donnees.utilisateurs.has(cle)) throw new Error('identifiant déjà pris');
    const sel = crypto.randomBytes(16).toString('hex');
    const u = { login, sel, empreinte: hacher(motDePasse, sel), socles: [], cles: [], admin: !!options.admin, cree: new Date().toISOString() };
    if (Comptes.emailValide(login)) u.email = login.toLowerCase();
    this.donnees.utilisateurs.set(cle, u);
    this.sauver();
    return u;
  }

  // Compte en libre-service : l'adresse e-mail est l'identifiant, et il n'y a
  // pas de mot de passe (connexion par code envoyé, puis clés d'accès).
  obtenirParEmail(email) {
    const e = String(email || '').trim().toLowerCase();
    if (!Comptes.emailValide(e)) throw new Error('adresse e-mail invalide');
    let u = this.utilisateur(e), nouveau = false;
    if (!u) {
      u = { login: e, email: e, sel: null, empreinte: null, socles: [], cles: [], admin: false, cree: new Date().toISOString() };
      this.donnees.utilisateurs.set(e, u);
      nouveau = true;
      this.sauver();
    }
    return { u, nouveau };
  }

  // Droit à l'effacement (RGPD, art. 17) : le compte, ses sessions, ses
  // abonnements push et ses clés d'accès disparaissent. Renvoie les socles
  // qui n'ont plus aucun propriétaire (leur historique peut alors partir aussi).
  supprimerUtilisateur(login) {
    const u = this.utilisateur(login);
    if (!u) return null;
    const cle = u.login.toLowerCase();
    this.donnees.utilisateurs.delete(cle);
    for (const [j, s_] of this.donnees.sessions) if (s_.login === cle) this.donnees.sessions.delete(j);
    this.donnees.abonnementsPush.delete(cle);
    this.sauver();
    return { orphelins: u.socles.filter(id => !this.proprietaires(id).length) };
  }

  // Droit à la portabilité (RGPD, art. 20) : tout ce que le compte contient,
  // sans aucun secret (ni empreinte, ni jeton, ni clé publique complète).
  exporter(login) {
    const u = this.utilisateur(login);
    if (!u) return null;
    const cle = u.login.toLowerCase();
    return {
      compte: { identifiant: u.login, email: u.email || null, cree: u.cree, administrateur: !!u.admin, motDePasse: !!u.empreinte },
      socles: u.socles.slice(),
      clesAcces: (u.cles || []).map(c => ({ nom: c.nom, cree: c.cree, derniereUtilisation: c.vu || null, synchronisee: !!c.synchronisee })),
      sessions: [...this.donnees.sessions.values()].filter(s_ => s_.login === cle).map(s_ => ({ ouverte: s_.cree || null, expire: s_.expire, appareil: s_.agent || '' })),
      notificationsPush: (this.donnees.abonnementsPush.get(cle) || []).map(a => ({ appareil: a.agent, cree: a.cree })),
      exporte: new Date().toISOString()
    };
  }

  changerMotDePasse(login, motDePasse) {
    const u = this.utilisateur(login);
    if (!u) throw new Error('utilisateur inconnu');
    if (String(motDePasse || '').length < 8) throw new Error('mot de passe : 8 caractères au minimum');
    u.sel = crypto.randomBytes(16).toString('hex');
    u.empreinte = hacher(motDePasse, u.sel);
    // Les sessions ouvertes avec l'ancien mot de passe tombent.
    for (const [j, s] of this.donnees.sessions) if (s.login === u.login.toLowerCase()) this.donnees.sessions.delete(j);
    this.sauver();
  }

  // --- administration (console) -------------------------------------------------
  // Mot de passe tiré au hasard, montré une fois à l'administrateur.
  static motDePasseAleatoire(n = 16) {
    const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < n; i++) s += alphabet[crypto.randomInt(alphabet.length)];
    return s;
  }

  reinitialiserMotDePasse(login) {
    const u = this.utilisateur(login);
    if (!u) throw new Error('utilisateur inconnu');
    if (!u.empreinte) throw new Error('compte par e-mail : il n\'a pas de mot de passe (connexion par code ou clé d\'accès)');
    const mdp = Comptes.motDePasseAleatoire();
    this.changerMotDePasse(u.login, mdp);
    return mdp;
  }

  definirAdmin(login, admin) {
    const u = this.utilisateur(login);
    if (!u) throw new Error('utilisateur inconnu');
    u.admin = !!admin;
    this.sauver();
    return u;
  }

  // Rôle « support » : la console pour les demandes et les accès ouverts par
  // les propriétaires, sans la gestion des comptes ni des comptes d'appareil.
  definirSupport(login, support) {
    const u = this.utilisateur(login);
    if (!u) throw new Error('utilisateur inconnu');
    u.support = !!support;
    this.sauver();
    return u;
  }

  // Sessions en cours d'un compte (sans le jeton, que le disque n'a pas).
  sessionsDe(login) {
    const cle = String(login || '').toLowerCase(), maintenant = Date.now();
    return [...this.donnees.sessions.values()].filter(s_ => s_.login === cle && Date.parse(s_.expire) > maintenant)
      .map(s_ => ({ ouverte: s_.cree || null, expire: s_.expire, appareil: s_.agent || '' }));
  }

  // « Déconnecter partout » : toutes les sessions du compte tombent, et avec
  // elles l'accès au broker (le jeton y servait de mot de passe).
  fermerSessions(login) {
    const cle = String(login || '').toLowerCase();
    let n = 0;
    for (const [j, s_] of this.donnees.sessions) if (s_.login === cle) { this.donnees.sessions.delete(j); n++; }
    if (n) this.sauver();
    return n;
  }

  // Liste détaillée pour la console : type de compte, sessions, dernière connexion.
  utilisateursDetail() {
    const maintenant = Date.now(), parLogin = new Map();
    for (const s_ of this.donnees.sessions.values()) {
      if (Date.parse(s_.expire) <= maintenant) continue;
      const x = parLogin.get(s_.login) || { n: 0, derniere: null };
      x.n++;
      if (s_.cree && (!x.derniere || s_.cree > x.derniere)) x.derniere = s_.cree;
      parLogin.set(s_.login, x);
    }
    return [...this.donnees.utilisateurs.values()].map(u => {
      const x = parLogin.get(u.login.toLowerCase()) || { n: 0, derniere: null };
      return { login: u.login, email: u.email || null, type: u.empreinte ? 'motdepasse' : 'email', admin: !!u.admin, support: !!u.support,
        socles: u.socles.slice(), cles: (u.cles || []).length, sessions: x.n, derniereConnexion: x.derniere, cree: u.cree || null };
    });
  }

  // Fiche d'un compte pour la console : rien de secret (ni empreinte, ni clé publique).
  detailUtilisateur(login) {
    const u = this.utilisateur(login);
    if (!u) return null;
    const ligne = this.utilisateursDetail().find(x => x.login === u.login);
    return { ...ligne,
      clesAcces: (u.cles || []).map(c => ({ id: c.id, nom: c.nom, cree: c.cree, vu: c.vu || null, synchronisee: !!c.synchronisee })),
      sessionsOuvertes: this.sessionsDe(u.login),
      notificationsPush: this.abonnementsPush(u.login).map(a => ({ appareil: a.agent, cree: a.cree })) };
  }

  utilisateur(login) { return this.donnees.utilisateurs.get(String(login || '').toLowerCase()) || null; }

  // Vérifie un couple identifiant / secret, où le secret est le mot de passe ou
  // un jeton de session en cours : c'est ce que présente l'application au
  // broker comme à l'API.
  authentifierUtilisateur(login, secret) {
    const u = this.utilisateur(login);
    if (!u) return null;
    const s = String(secret || '');
    if (s.length >= 8 && u.empreinte && memeEmpreinte(hacher(s, u.sel), u.empreinte)) return u;
    const session = this.session(s);
    if (session && session.login === u.login.toLowerCase()) return u;
    return null;
  }

  ouvrirSession(login, options = {}) {
    const u = this.utilisateur(login);
    if (!u) throw new Error('utilisateur inconnu');
    const dureeJours = options.dureeJours || DUREE_SESSION_J;
    const jeton = crypto.randomBytes(24).toString('hex');
    const maintenant = Date.now();
    this.donnees.sessions.set(cleSession(jeton), { login: u.login.toLowerCase(), cree: new Date(maintenant).toISOString(),
      expire: new Date(maintenant + dureeJours * 86400000).toISOString(), agent: String(options.agent || '').slice(0, 120) });
    this.purgerSessions();
    this.sauver();
    return jeton;
  }

  fermerSession(jeton) { if (this.donnees.sessions.delete(cleSession(jeton || ''))) this.sauver(); }

  // Session en cours pour ce jeton, prolongée au passage (au plus une fois par
  // jour) : on reste connecté tant qu'on se sert de l'application.
  session(jeton) {
    if (!jeton) return null;
    const s_ = this.donnees.sessions.get(cleSession(jeton));
    if (!s_) return null;
    const maintenant = Date.now(), expire = Date.parse(s_.expire);
    if (expire <= maintenant) return null;
    if (expire - maintenant < (DUREE_SESSION_J - 1) * 86400000) {
      s_.expire = new Date(maintenant + DUREE_SESSION_J * 86400000).toISOString();
      this.sauverBientot();
    }
    return s_;
  }

  utilisateurDeSession(jeton) {
    const s_ = this.session(String(jeton || ''));
    return s_ ? this.utilisateur(s_.login) : null;
  }

  // --- clés d'accès (WebAuthn) ---------------------------------------------------
  // L'identifiant WebAuthn de l'utilisateur est aléatoire et stable : jamais
  // son e-mail, que l'authentificateur garderait en clair.
  idWebauthn(u) {
    if (!u.idWebauthn) { u.idWebauthn = crypto.randomBytes(16).toString('base64url'); this.sauver(); }
    return u.idWebauthn;
  }

  ajouterCle(login, cle) {
    const u = this.utilisateur(login);
    if (!u) throw new Error('utilisateur inconnu');
    if (this.cleParId(cle.id)) throw new Error('clé déjà enregistrée');
    u.cles = u.cles || [];
    if (u.cles.length >= 10) throw new Error('dix clés d\'accès au plus par compte');
    u.cles.push({ id: cle.id, jwk: cle.jwk, alg: cle.alg, compteur: cle.compteur || 0, synchronisee: !!cle.synchronisee,
      nom: String(cle.nom || 'Clé d\'accès').slice(0, 60), cree: new Date().toISOString(), vu: null });
    this.sauver();
  }

  cleParId(id) {
    for (const u of this.donnees.utilisateurs.values()) {
      const c = (u.cles || []).find(x => x.id === id);
      if (c) return { u, cle: c };
    }
    return null;
  }

  noterUsageCle(id, compteur) {
    const t = this.cleParId(id);
    if (!t) return;
    t.cle.compteur = compteur;
    t.cle.vu = new Date().toISOString();
    this.sauver();
  }

  retirerCle(login, id) {
    const u = this.utilisateur(login);
    if (!u) return false;
    const avant = (u.cles || []).length;
    u.cles = (u.cles || []).filter(c => c.id !== id);
    if (u.cles.length === avant) return false;
    this.sauver();
    return true;
  }

  purgerSessions() {
    const maintenant = Date.now();
    for (const [j, s] of this.donnees.sessions) if (Date.parse(s.expire) <= maintenant) this.donnees.sessions.delete(j);
  }

  // --- appareils (socles) ---------------------------------------------------------
  static idValide(id) { return /^terra[0-9A-Za-z]{6}$/.test(String(id || '')); }

  ajouterAppareil(id, motDePasse) {
    if (!Comptes.idValide(id)) throw new Error('identifiant de socle invalide (terraXXXXXX)');
    const mdp = motDePasse || crypto.randomBytes(12).toString('base64url');
    if (mdp.length < 8) throw new Error('mot de passe : 8 caractères au minimum');
    const sel = crypto.randomBytes(16).toString('hex');
    this.donnees.appareils.set(id, { id, sel, empreinte: hacher(mdp, sel), cree: new Date().toISOString() });
    this.sauver();
    return { id, motDePasse: mdp };
  }

  retirerAppareil(id) {
    if (!this.donnees.appareils.delete(String(id || ''))) return false;
    for (const u of this.donnees.utilisateurs.values()) u.socles = u.socles.filter(s => s !== id);
    this.sauver();
    return true;
  }

  // Nouveau mot de passe pour un compte d'appareil existant : l'ancien cesse
  // aussitôt de valoir (le socle doit le recevoir par sa console : mqtt …).
  renouvelerAppareil(id) {
    if (!this.appareil(id)) throw new Error('compte d\'appareil inconnu');
    const a = this.appareil(id);
    const r = this.ajouterAppareil(id);
    this.appareil(id).cree = a.cree;
    this.appareil(id).renouvele = new Date().toISOString();
    this.sauver();
    return r;
  }

  appareil(id) { return this.donnees.appareils.get(String(id || '')) || null; }
  appareilsDetail() { return [...this.donnees.appareils.values()].map(a => ({ id: a.id, cree: a.cree || null, renouvele: a.renouvele || null })); }

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
  proprietaires(id) { return [...this.donnees.utilisateurs.values()].filter(u => u.socles.includes(id)); }

  // --- notifications push --------------------------------------------------------
  ajouterAbonnementPush(login, abonnement, agent) {
    const cle = String(login).toLowerCase();
    if (!abonnement || typeof abonnement.endpoint !== 'string' || !/^https:\/\//.test(abonnement.endpoint)) throw new Error('abonnement push invalide');
    if (!this.donnees.abonnementsPush.has(cle)) this.donnees.abonnementsPush.set(cle, []);
    const liste = this.donnees.abonnementsPush.get(cle);
    const existant = liste.findIndex(a => a.endpoint === abonnement.endpoint);
    const entree = { endpoint: abonnement.endpoint, keys: abonnement.keys, agent: String(agent || '').slice(0, 120), cree: new Date().toISOString() };
    if (existant >= 0) liste[existant] = entree; else liste.push(entree);
    if (liste.length > 10) liste.shift();
    this.sauver();
  }

  retirerAbonnementPush(login, endpoint) {
    const cle = String(login).toLowerCase();
    const liste = this.donnees.abonnementsPush.get(cle) || [];
    this.donnees.abonnementsPush.set(cle, liste.filter(a => a.endpoint !== endpoint));
    this.sauver();
  }

  abonnementsPush(login) { return this.donnees.abonnementsPush.get(String(login).toLowerCase()) || []; }

  resume() {
    return {
      utilisateurs: [...this.donnees.utilisateurs.values()].map(u => ({ login: u.login, socles: u.socles, admin: u.admin, cree: u.cree,
        email: !!u.email, motDePasse: !!u.empreinte, cles: (u.cles || []).length })),
      appareils: [...this.donnees.appareils.values()].map(a => ({ id: a.id, cree: a.cree }))
    };
  }
}

module.exports = { Comptes, hacher };
