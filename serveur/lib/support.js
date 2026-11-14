'use strict';
/* Back-office support (V11) : accès ouverts par les propriétaires, demandes
   (messages avec le client, notes internes jamais montrées au client),
   copie des réglages à l'ouverture, frise d'un socle, transfert des réglages
   vers un socle de remplacement.

   L'accès : l'application du propriétaire tire une clé de session, l'envoie
   au socle (commande « service ouvrir » signée avec le code d'appairage, que
   le serveur ne voit jamais), puis la remet ici. Le serveur vérifie qu'elle
   signe (« service etat ») et la garde le temps de l'accès — 24 h par défaut,
   7 jours au plus après l'ouverture, borne tenue par le socle lui-même. Les
   commandes du support partent signées avec elle ; chacune entre au journal
   d'audit avec ses valeurs. À l'échéance ou à la fermeture, la clé est
   effacée du disque.

   Données : donnees/support/acces.json (clés, 0600) et demandes.json. */

const fs = require('fs');
const path = require('path');
const { refCompte } = require('./audit');

const STATUTS = ['nouvelle', 'en cours', 'attente client', 'résolue'];
const GRAVITES = ['urgente', 'normale', 'faible'];
const MAX_TEXTE = 4000;
const R_ID = /^terra[0-9A-Za-z]{6}$/;
// Ce que le support ne demande pas par la route générique : l'accès lui-même
// (routes dédiées) et la mise à jour (déploiement : phase suivante).
const ACTIONS_REFUSEES = new Set(['service']);

function lire(f, defaut) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return defaut; } }
function ecrire(f, donnees) {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(donnees, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, f);
}
const texteBorne = t => String(t || '').replace(/\r\n?/g, '\n').trim().slice(0, MAX_TEXTE);
// Les valeurs d'une commande, pour le journal : une sauvegarde à restaurer est
// résumée, pas recopiée.
function valeursPourJournal(params) {
  const v = {};
  for (const [k, x] of Object.entries(params || {})) {
    if (k === 'sauvegarde') v[k] = x && typeof x === 'object' ? `sauvegarde de ${x.appareil || '?'} (${x.date || '?'})` : '?';
    else if (typeof x === 'string') v[k] = x.slice(0, 120);
    else v[k] = x;
  }
  return v;
}

class Support {
  constructor(dossier, { maintenant = () => Date.now() } = {}) {
    this.dossier = path.join(dossier, 'support');
    fs.mkdirSync(this.dossier, { recursive: true, mode: 0o700 });
    this.maintenant = maintenant;
    this.fAcces = path.join(this.dossier, 'acces.json');
    this.fDemandes = path.join(this.dossier, 'demandes.json');
    this.acces = new Map(Object.entries(lire(this.fAcces, {})));
    const d = lire(this.fDemandes, { suivante: 1, demandes: [] });
    this.suivante = d.suivante || 1;
    this.demandes = new Map((d.demandes || []).map(x => [x.n, x]));
  }

  sauverAcces() { ecrire(this.fAcces, Object.fromEntries(this.acces)); }
  sauverDemandes() { ecrire(this.fDemandes, { suivante: this.suivante, demandes: [...this.demandes.values()] }); }

  // --- accès -------------------------------------------------------------------
  accesActif(id) {
    const a = this.acces.get(id);
    return a && Date.parse(a.jusqua) > this.maintenant() ? a : null;
  }
  // Vue sans la clé (console, application).
  vueAcces(id) {
    const a = this.accesActif(id);
    return a ? { actif: true, ouvert: a.ouvert, jusqua: a.jusqua, prolonge: (a.prolongations || []).length > 0,
      copie: a.copie ? a.copie.t : null } : { actif: false };
  }
  ouvrirAcces(id, { cle, ouvert, jusqua, par }) {
    this.acces.set(id, { cle, ouvert, jusqua, par, prolongations: [], copie: null });
    this.sauverAcces();
  }
  fermerAcces(id) {
    const a = this.acces.get(id);
    if (!a) return null;
    this.acces.delete(id);
    this.sauverAcces();
    return a;
  }
  // Les accès échus : retirés (la clé quitte le disque), rendus pour le journal.
  purgerAcces() {
    const echus = [];
    for (const [id, a] of this.acces) if (Date.parse(a.jusqua) <= this.maintenant()) { echus.push(id); this.acces.delete(id); }
    if (echus.length) this.sauverAcces();
    return echus;
  }

  // --- demandes ------------------------------------------------------------------
  creerDemande({ socle, compte, texte, de, qui, gravite = 'normale' }) {
    const t = new Date(this.maintenant()).toISOString();
    const d = { n: this.suivante++, socle: socle || null, compte: compte || null, statut: 'nouvelle',
      gravite: GRAVITES.includes(gravite) ? gravite : 'normale', responsable: null, cree: t, maj: t,
      messages: [], notes: [], demandeAcces: null };
    if (texte) d.messages.push({ t, de, qui: de === 'support' ? qui : null, texte: texteBorne(texte) });
    this.demandes.set(d.n, d);
    this.sauverDemandes();
    return d;
  }
  demande(n) { return this.demandes.get(+n) || null; }
  // Ce que voit le client : jamais les notes, ni qui de l'équipe a répondu.
  vueClient(d) {
    return { n: d.n, socle: d.socle, statut: d.statut, cree: d.cree, maj: d.maj, demandeAcces: d.demandeAcces,
      messages: d.messages.map(m => ({ t: m.t, de: m.de, texte: m.texte })) };
  }
  ajouterMessage(d, { de, qui, texte }) {
    const t = new Date(this.maintenant()).toISOString();
    d.messages.push({ t, de, qui: de === 'support' ? qui : null, texte: texteBorne(texte) });
    if (de === 'client' && ['attente client', 'résolue'].includes(d.statut)) d.statut = 'en cours';
    if (de === 'support' && d.statut !== 'résolue') d.statut = 'attente client';
    d.maj = t;
    this.sauverDemandes();
  }
  ajouterNote(d, { qui, texte }) {
    d.notes.push({ t: new Date(this.maintenant()).toISOString(), qui, texte: texteBorne(texte) });
    d.maj = new Date(this.maintenant()).toISOString();
    this.sauverDemandes();
  }
  // Droit à l'effacement : les demandes d'un compte effacé partent avec lui.
  oublierCompte(login) {
    const cle = String(login).toLowerCase();
    let n = 0;
    for (const [k, d] of this.demandes) if (d.compte && d.compte.toLowerCase() === cle) { this.demandes.delete(k); n++; }
    if (n) this.sauverDemandes();
    return n;
  }
  // File de la console : ouvertes d'abord, les plus graves, puis les plus anciennes.
  file() {
    const ordre = d => [d.statut === 'résolue' ? 1 : 0, GRAVITES.indexOf(d.gravite), d.cree];
    return [...this.demandes.values()].sort((a, b) => {
      const x = ordre(a), y = ordre(b);
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
      return 0;
    });
  }
}

// =============================================================================
// Routes : celles du propriétaire (/api/support/…, session) et celles de
// l'équipe (/api/admin/support/…, appelées par la console).
// =============================================================================
class RoutesSupport {
  constructor(api) { this.api = api; }
  get s() { return this.api.support; }

  noter(qui, action, cible, details) { this.api.audit.noter({ qui, action, cible, details }); }
  notifier(id, n) {
    const a = this.api;
    if (a.notifications) a.notifications.notifierProprietaires(a.comptes, id, { ...n, socle: id }, `support:${id}:${n.tag || n.titre}`).catch(() => {});
  }

  // Fermer pour de bon : le socle d'abord (avec la clé, au mieux), puis le disque.
  async fermer(id, qui, raison) {
    const a = this.s.fermerAcces(id);
    if (!a) return false;
    try { await this.api.broker.commander(id, 'service', { op: 'fermer' }, 5000, { cle: a.cle }); } catch (e) { /* hors ligne : il expirera de lui-même */ }
    this.noter(qui, 'support.acces.fermer', id, raison ? { raison } : null);
    return true;
  }

  async commande(id, action, params, qui) {
    const a = this.s.accesActif(id);
    if (!a) throw Object.assign(new Error('aucun accès support ouvert sur ce socle'), { statut: 409 });
    let r;
    try { r = await this.api.broker.commander(id, action, params, 10000, { cle: a.cle }); }
    catch (e) {
      this.noter(qui, 'support.commande', id, { action, valeurs: valeursPourJournal(params), ok: false, erreur: 'pas de réponse' });
      throw Object.assign(new Error('le socle ne répond pas'), { statut: 504 });
    }
    this.noter(qui, 'support.commande', id, { action, valeurs: valeursPourJournal(params), ok: !!r.ok, ...(r.ok ? {} : { erreur: String(r.erreur || '').slice(0, 120) }) });
    return r;
  }

  async copier(id, qui) {
    const r = await this.commande(id, 'sauvegarde', {}, qui);
    if (!r.ok || !r.sauvegarde) throw Object.assign(new Error(r.erreur || 'sauvegarde refusée par le socle'), { statut: 502 });
    const a = this.s.accesActif(id);
    a.copie = { t: new Date().toISOString(), sauvegarde: r.sauvegarde };
    this.s.sauverAcces();
    this.noter(qui, 'support.copie', id, null);
    return a.copie;
  }

  // --- propriétaire ------------------------------------------------------------
  async proprietaire(req, res, methode, chemin, url, u) {
    const a = this.api, c = a.comptes;
    const ref = refCompte(u.login);
    if (chemin === '/api/support/acces') {
      if (methode === 'GET') {
        return a.json(res, 200, { acces: u.socles.map(id => {
          const attente = [...this.s.demandes.values()].find(d => d.socle === id && d.demandeAcces && d.statut !== 'résolue');
          return { id, ...this.s.vueAcces(id), demandeAcces: attente ? { n: attente.n, t: attente.demandeAcces } : null };
        }) });
      }
      if (methode === 'POST') {
        const d = await a.lireJson(req);
        if (!R_ID.test(String(d.socle || '')) || !c.possede(u, d.socle)) return a.erreur(res, 403, 'socle non rattaché à ce compte');
        if (!/^[0-9a-f]{64}$/.test(String(d.cle || ''))) return a.erreur(res, 400, 'clé de session : 64 caractères hexadécimaux');
        // La preuve que le socle a bien ouvert l'accès avec cette clé.
        let r;
        try { r = await a.broker.commander(d.socle, 'service', { op: 'etat' }, 8000, { cle: d.cle }); }
        catch (e) { return a.erreur(res, 504, 'le socle ne répond pas'); }
        if (!r.ok || !r.service || !r.service.actif) return a.erreur(res, 409, 'le socle n\'a pas ouvert l\'accès avec cette clé');
        const ouvert = new Date(r.service.ouvert * 1000).toISOString(), jusqua = new Date(r.service.jusqua * 1000).toISOString();
        this.s.ouvrirAcces(d.socle, { cle: d.cle, ouvert, jusqua, par: ref });
        for (const dm of this.s.demandes.values()) if (dm.socle === d.socle && dm.demandeAcces) { dm.demandeAcces = null; }
        this.s.sauverDemandes();
        this.noter('titulaire', 'support.acces.ouvrir', d.socle, { compte: ref, jusqua });
        // La copie des réglages à l'ouverture : « tout remettre » repartira d'elle.
        this.copier(d.socle, 'serveur').catch(() => {});
        return a.json(res, 201, { id: d.socle, ...this.s.vueAcces(d.socle) });
      }
    }
    const mA = /^\/api\/support\/acces\/(terra[0-9A-Za-z]{6})(\/refuser)?$/.exec(chemin);
    if (mA) {
      const id = mA[1];
      if (!c.possede(u, id)) return a.erreur(res, 403, 'socle non rattaché à ce compte');
      if (methode === 'DELETE' && !mA[2]) {
        const ferme = await this.fermer(id, 'titulaire', 'fermé par le propriétaire');
        return a.json(res, 200, { ferme });
      }
      if (methode === 'POST' && mA[2]) {
        let n = 0;
        for (const dm of this.s.demandes.values()) {
          if (dm.socle === id && dm.demandeAcces) { dm.demandeAcces = null; this.s.ajouterMessage(dm, { de: 'client', texte: 'Accès au socle refusé pour l\'instant.' }); n++; }
        }
        this.s.sauverDemandes();
        this.noter('titulaire', 'support.acces.refuser', id, { compte: ref });
        return a.json(res, 200, { refuse: n });
      }
    }
    if (chemin === '/api/support/demandes') {
      if (methode === 'GET') {
        const miennes = [...this.s.demandes.values()].filter(d => d.compte && d.compte.toLowerCase() === u.login.toLowerCase());
        return a.json(res, 200, { demandes: miennes.sort((x, y) => (x.maj < y.maj ? 1 : -1)).map(d => this.s.vueClient(d)) });
      }
      if (methode === 'POST') {
        const d = await a.lireJson(req);
        if (d.socle && !c.possede(u, d.socle)) return a.erreur(res, 403, 'socle non rattaché à ce compte');
        if (!texteBorne(d.texte)) return a.erreur(res, 400, 'message vide');
        // Un socle en défaut : la demande arrive en tête de file.
        const r = d.socle ? a.broker.resumeSocle(d.socle) : null;
        const urgente = !!(r && r.zones.some(z => z.defaut));
        const dm = this.s.creerDemande({ socle: d.socle || null, compte: u.login, texte: d.texte, de: 'client', gravite: urgente ? 'urgente' : 'normale' });
        this.noter('titulaire', 'support.demande.creer', d.socle || ref, { demande: dm.n, compte: ref, gravite: dm.gravite });
        return a.json(res, 201, this.s.vueClient(dm));
      }
    }
    const mD = /^\/api\/support\/demandes\/(\d{1,9})\/messages$/.exec(chemin);
    if (mD && methode === 'POST') {
      const dm = this.s.demande(mD[1]);
      if (!dm || !dm.compte || dm.compte.toLowerCase() !== u.login.toLowerCase()) return a.erreur(res, 404, 'demande inconnue');
      const d = await a.lireJson(req);
      if (!texteBorne(d.texte)) return a.erreur(res, 400, 'message vide');
      this.s.ajouterMessage(dm, { de: 'client', texte: d.texte });
      this.noter('titulaire', 'support.demande.message', dm.socle || ref, { demande: dm.n, de: 'client', compte: ref });
      return a.json(res, 200, this.s.vueClient(dm));
    }
    return a.erreur(res, 404, 'route inconnue');
  }

  // --- équipe (console) ------------------------------------------------------------
  async equipe(req, res, methode, chemin, url, qui) {
    const a = this.api, c = a.comptes, b = a.broker;
    const quiNom = qui.qui;
    const ligneDemande = d => ({ n: d.n, socle: d.socle, compte: d.compte, statut: d.statut, gravite: d.gravite, responsable: d.responsable,
      cree: d.cree, maj: d.maj, demandeAcces: d.demandeAcces, messages: d.messages.length, notes: d.notes.length,
      dernier: d.messages.length ? { t: d.messages[d.messages.length - 1].t, de: d.messages[d.messages.length - 1].de, extrait: d.messages[d.messages.length - 1].texte.slice(0, 140) } : null,
      acces: d.socle ? this.s.vueAcces(d.socle) : null });

    if (chemin === '/api/admin/support/demandes') {
      if (methode === 'GET') {
        const statut = url.searchParams.get('statut');
        return a.json(res, 200, { demandes: this.s.file().filter(d => !statut || (statut === 'ouvertes' ? d.statut !== 'résolue' : d.statut === statut)).map(ligneDemande) });
      }
      if (methode === 'POST') {
        // Demande ouverte par l'équipe (alerte proactive, appel) : le client la
        // voit dans son application, avec le premier message.
        const d = await a.lireJson(req);
        if (d.socle && !R_ID.test(d.socle)) return a.erreur(res, 400, 'identifiant de socle invalide');
        let compte = d.compte ? c.utilisateur(d.compte) : null;
        if (!compte && d.socle) compte = c.proprietaires(d.socle)[0] || null;
        if (!compte) return a.erreur(res, 400, 'compte du client introuvable (socle sans propriétaire ?)');
        const dm = this.s.creerDemande({ socle: d.socle || null, compte: compte.login, texte: d.texte, de: 'support', qui: quiNom, gravite: d.gravite });
        if (dm.messages.length) dm.statut = 'attente client';
        dm.responsable = qui.login || null;
        this.s.sauverDemandes();
        this.noter(quiNom, 'support.demande.creer', d.socle || refCompte(compte.login), { demande: dm.n, compte: refCompte(compte.login), gravite: dm.gravite, par: 'équipe' });
        if (dm.messages.length && d.socle) this.notifier(d.socle, { titre: 'Message du support', corps: `À propos de ${d.socle} : ouvrez l'application pour lire et répondre.`, tag: 'message' });
        return a.json(res, 201, ligneDemande(dm));
      }
    }
    const mD = /^\/api\/admin\/support\/demandes\/(\d{1,9})(\/messages|\/notes|\/demander-acces)?$/.exec(chemin);
    if (mD) {
      const dm = this.s.demande(mD[1]);
      if (!dm) return a.erreur(res, 404, 'demande inconnue');
      const cible = dm.socle || (dm.compte ? refCompte(dm.compte) : null);
      if (!mD[2] && methode === 'GET') {
        const r = dm.socle ? b.resumeSocle(dm.socle) : null;
        return a.json(res, 200, { ...ligneDemande(dm), messages: dm.messages, notes: dm.notes, socleEtat: r,
          proprietaires: dm.socle ? c.proprietaires(dm.socle).map(u => u.login) : [] });
      }
      if (!mD[2] && methode === 'POST') {
        const d = await a.lireJson(req);
        const avant = { statut: dm.statut, gravite: dm.gravite, responsable: dm.responsable };
        if (d.statut !== undefined) { if (!STATUTS.includes(d.statut)) return a.erreur(res, 400, 'statut inconnu'); dm.statut = d.statut; }
        if (d.gravite !== undefined) { if (!GRAVITES.includes(d.gravite)) return a.erreur(res, 400, 'gravité inconnue'); dm.gravite = d.gravite; }
        if (d.responsable !== undefined) {
          const r = d.responsable === null ? null : c.utilisateur(d.responsable);
          if (d.responsable !== null && !(r && (r.admin || r.support))) return a.erreur(res, 400, 'responsable : un membre de l\'équipe (administrateur ou support)');
          dm.responsable = r ? r.login : null;
        }
        dm.maj = new Date().toISOString();
        this.s.sauverDemandes();
        const apres = { statut: dm.statut, gravite: dm.gravite, responsable: dm.responsable };
        const change = {};
        for (const k of Object.keys(apres)) if (apres[k] !== avant[k]) change[k] = k === 'responsable' && apres[k] ? apres[k] : apres[k];
        this.noter(quiNom, 'support.demande.maj', cible, { demande: dm.n, ...change });
        return a.json(res, 200, ligneDemande(dm));
      }
      if (mD[2] === '/messages' && methode === 'POST') {
        const d = await a.lireJson(req);
        if (!texteBorne(d.texte)) return a.erreur(res, 400, 'message vide');
        this.s.ajouterMessage(dm, { de: 'support', qui: quiNom, texte: d.texte });
        this.noter(quiNom, 'support.demande.message', cible, { demande: dm.n, de: 'support', longueur: texteBorne(d.texte).length });
        if (dm.socle) this.notifier(dm.socle, { titre: 'Réponse du support', corps: `À propos de ${dm.socle} : ouvrez l'application pour lire la réponse.`, tag: 'message' });
        return a.json(res, 200, ligneDemande(dm));
      }
      if (mD[2] === '/notes' && methode === 'POST') {
        const d = await a.lireJson(req);
        if (!texteBorne(d.texte)) return a.erreur(res, 400, 'note vide');
        this.s.ajouterNote(dm, { qui: quiNom, texte: d.texte });
        this.noter(quiNom, 'support.demande.note', cible, { demande: dm.n, longueur: texteBorne(d.texte).length });
        return a.json(res, 200, ligneDemande(dm));
      }
      if (mD[2] === '/demander-acces' && methode === 'POST') {
        if (!dm.socle) return a.erreur(res, 400, 'demande sans socle');
        if (this.s.accesActif(dm.socle)) return a.erreur(res, 409, 'l\'accès est déjà ouvert');
        dm.demandeAcces = new Date().toISOString();
        this.s.sauverDemandes();
        this.noter(quiNom, 'support.acces.demander', dm.socle, { demande: dm.n });
        this.notifier(dm.socle, { titre: 'Le support demande l\'accès', corps: `${dm.socle} : ouvrez l'application pour l'autoriser (24 h) ou refuser.`, tag: 'acces-demande', urgent: true });
        return a.json(res, 200, ligneDemande(dm));
      }
      return a.erreur(res, 404, 'route inconnue');
    }

    if (methode === 'GET' && chemin === '/api/admin/support/equipe') {
      return a.json(res, 200, { equipe: c.utilisateursDetail().filter(u => u.admin || u.support).map(u => ({ login: u.login, role: u.admin ? 'admin' : 'support' })) });
    }
    if (methode === 'GET' && chemin === '/api/admin/support/acces') {
      return a.json(res, 200, { acces: [...this.s.acces.keys()].filter(id => this.s.accesActif(id)).map(id => ({ id, ...this.s.vueAcces(id),
        proprietaires: c.proprietaires(id).map(u => u.login), enLigne: !!(b.resumeSocle(id) || {}).enLigne })) });
    }
    const mS = /^\/api\/admin\/support\/acces\/(terra[0-9A-Za-z]{6})(\/commande|\/prolonger|\/fermer|\/copie|\/remettre)?$/.exec(chemin);
    if (mS) {
      const id = mS[1];
      if (!mS[2] && methode === 'GET') {
        const acc = this.s.accesActif(id);
        return a.json(res, 200, { id, ...this.s.vueAcces(id), copieSauvegarde: acc && acc.copie ? acc.copie.sauvegarde : null });
      }
      if (methode !== 'POST') return a.erreur(res, 404, 'route inconnue');
      if (!this.s.accesActif(id)) return a.erreur(res, 409, 'aucun accès support ouvert sur ce socle');
      if (mS[2] === '/commande') {
        const d = await a.lireJson(req);
        const action = String(d.action || '');
        if (!/^[a-z-]{2,30}$/.test(action) || ACTIONS_REFUSEES.has(action)) return a.erreur(res, 400, 'action refusée ici');
        const params = { ...d };
        delete params.action;
        const r = await this.commande(id, action, params, quiNom);
        return a.json(res, 200, r);
      }
      if (mS[2] === '/prolonger') {
        const d = await a.lireJson(req);
        const heures = parseInt(d.heures, 10);
        if (!(heures >= 1 && heures <= 168)) return a.erreur(res, 400, 'durée : 1 à 168 h');
        const acc = this.s.accesActif(id);
        let r;
        try { r = await b.commander(id, 'service', { op: 'prolonger', heures }, 8000, { cle: acc.cle }); }
        catch (e) { return a.erreur(res, 504, 'le socle ne répond pas'); }
        if (!r.ok || !r.service) return a.erreur(res, 502, r.erreur || 'prolongation refusée par le socle');
        acc.jusqua = new Date(r.service.jusqua * 1000).toISOString();
        acc.prolongations = (acc.prolongations || []).concat({ t: new Date().toISOString(), jusqua: acc.jusqua, par: quiNom });
        this.s.sauverAcces();
        this.noter(quiNom, 'support.acces.prolonger', id, { jusqua: acc.jusqua, heures });
        this.notifier(id, { titre: 'Accès support prolongé', corps: `${id} : jusqu'au ${new Date(acc.jusqua).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}. Vous pouvez le fermer depuis l'application.`, tag: 'acces-prolonge' });
        return a.json(res, 200, { id, ...this.s.vueAcces(id) });
      }
      if (mS[2] === '/fermer') {
        await this.fermer(id, quiNom, 'fermé par le support');
        this.notifier(id, { titre: 'Accès support fermé', corps: `${id} : le support a terminé.`, tag: 'acces-ferme' });
        return a.json(res, 200, { id, actif: false });
      }
      if (mS[2] === '/copie') {
        const copie = await this.copier(id, quiNom);
        return a.json(res, 200, { id, copie: copie.t });
      }
      if (mS[2] === '/remettre') {
        const d = await a.lireJson(req);
        if (String(d.confirmation || '').trim() !== id) return a.erreur(res, 400, `confirmation : taper « ${id} »`);
        const acc = this.s.accesActif(id);
        if (!acc.copie) return a.erreur(res, 409, 'aucune copie des réglages pour ce socle');
        const r = await this.commande(id, 'restaurer', { sauvegarde: acc.copie.sauvegarde }, quiNom);
        if (!r.ok) return a.erreur(res, 502, r.erreur || 'restauration refusée par le socle');
        this.noter(quiNom, 'support.remettre', id, { copie: acc.copie.t });
        return a.json(res, 200, { ok: true, message: r.message || null });
      }
    }

    // Transfert vers un socle de remplacement : les réglages de l'ancien (sa
    // copie, ou une sauvegarde fraîche), restaurés sur le neuf ; les
    // propriétaires de l'ancien rattachés au neuf. Accès ouvert sur le neuf.
    if (methode === 'POST' && chemin === '/api/admin/support/transferer') {
      const d = await a.lireJson(req);
      const de = String(d.de || ''), vers = String(d.vers || '');
      if (!R_ID.test(de) || !R_ID.test(vers) || de === vers) return a.erreur(res, 400, 'deux socles différents attendus');
      if (String(d.confirmation || '').trim() !== vers) return a.erreur(res, 400, `confirmation : taper « ${vers} »`);
      if (!this.s.accesActif(vers)) return a.erreur(res, 409, `aucun accès support ouvert sur ${vers}`);
      let sauvegarde;
      const accDe = this.s.accesActif(de);
      if (accDe) {
        const r = await this.commande(de, 'sauvegarde', {}, quiNom).catch(() => null);
        sauvegarde = r && r.ok ? r.sauvegarde : (accDe.copie ? accDe.copie.sauvegarde : null);
      } else {
        const ancien = this.s.acces.get(de);
        sauvegarde = ancien && ancien.copie ? ancien.copie.sauvegarde : null;
      }
      if (!sauvegarde) return a.erreur(res, 409, `aucune sauvegarde de ${de} : ouvrir l'accès sur l'ancien socle, ou en avoir fait une copie`);
      const r = await this.commande(vers, 'restaurer', { sauvegarde }, quiNom);
      if (!r.ok) return a.erreur(res, 502, r.erreur || 'restauration refusée par le nouveau socle');
      const proprietaires = c.proprietaires(de).map(u => u.login);
      for (const login of proprietaires) c.attribuerSocle(login, vers);
      this.noter(quiNom, 'support.transfert', vers, { de, proprietaires: proprietaires.length });
      return a.json(res, 200, { ok: true, message: r.message || null, proprietaires: proprietaires.length });
    }
    return a.erreur(res, 404, 'route inconnue');
  }
}

module.exports = { Support, RoutesSupport, STATUTS, GRAVITES };
