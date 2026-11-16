'use strict';
/* Routes de la console d'administration : /api/admin/… (et /api/flotte, gardé
   pour les scripts d'avant la console).

   Réservées au jeton d'administration (ADMIN_JETON) et aux comptes marqués
   administrateurs ; l'identité est vérifiée par l'API avant d'arriver ici.
   Le rôle « support » lit la flotte et traite les demandes ; le rôle
   « atelier » ne fait qu'une chose ici : créer le compte d'appareil d'un
   socle qui n'a pas encore de propriétaire (étape 1 de la page Atelier).
   Chaque action qui change quelque chose, et chaque lecture d'un rapport de
   diagnostic (il peut contenir des données personnelles), entre au journal
   d'audit. Les mots de passe tirés ici (compte, appareil) ne sont rendus
   qu'une fois, dans la réponse, et n'entrent jamais au journal.

   Ce que la console voit d'un socle, c'est ce qu'il publie (statut, santé,
   état des zones) : sans son code d'appairage, le serveur ne peut rien lui
   commander — c'est l'accès support, ouvert par le propriétaire, qui le
   permettra. */

const fs = require('fs');
const path = require('path');
const { Comptes } = require('./comptes');
const { refCompte, empreinteCompte } = require('./audit');

const NOM_RAPPORT = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-([A-Za-z0-9_]{1,80})\.txt$/;
const R_SOCLE = /^\/api\/admin\/socles\/(terra[0-9A-Za-z]{6})(\/historique|\/frise|\/proprietaires(?:\/([^/]+))?)?$/;
// Ce qu'un compte « support » peut faire : lire la flotte, les rapports et le
// journal, et tout ce qui touche aux demandes et aux accès ouverts.
const PERMIS_SUPPORT = [
  ['GET', /^\/api\/admin\/(moi|tableau|socles|rapports|audit)$/],
  ['GET', /^\/api\/admin\/socles\/terra[0-9A-Za-z]{6}(\/historique|\/frise)?$/],
  ['GET', /^\/api\/admin\/rapports\/[^/]+$/],
  ['*', /^\/api\/admin\/support\//]
];
// Ce qu'un compte « atelier » peut faire : le compte d'appareil d'un socle
// qu'il monte (vérifié plus bas : sans propriétaire).
const PERMIS_ATELIER = [['POST', /^\/api\/admin\/appareils$/]];
const permis = (liste, methode, chemin) => liste.some(([m, r]) => (m === '*' || m === methode) && r.test(chemin));
const R_APPAREIL = /^\/api\/admin\/appareils\/(terra[0-9A-Za-z]{6})(\/renouveler)?$/;
const R_UTILISATEUR = /^\/api\/admin\/utilisateurs\/([^/]+)(\/admin|\/support|\/atelier|\/sessions\/fermer|\/mot-de-passe|\/export|\/socles(?:\/(terra[0-9A-Za-z]{6}))?|\/cles\/([A-Za-z0-9_-]{16,1400}))?$/;
const R_RAPPORT = /^\/api\/admin\/rapports\/([^/]+)$/;

// Une route reçoit un identifiant venu de l'adresse : décodé une fois, et
// refusé s'il est mal encodé plutôt que de lever une exception.
function decoder(x) { try { return decodeURIComponent(x); } catch (e) { return null; } }

class Admin {
  constructor(api) { this.api = api; }

  noter(qui, action, cible, details) { this.api.audit.noter({ qui: qui.qui, action, cible, details }); }

  // Les lignes du journal qui parlent d'un compte : sa référence pseudonyme,
  // en cible ou dans le détail (socle rattaché à ce compte…).
  filtreCompte(login) {
    const h = '#' + empreinteCompte(login);
    return e => (e.cible && e.cible.endsWith(h)) || (e.details && typeof e.details.compte === 'string' && e.details.compte.endsWith(h));
  }

  // --- vues ----------------------------------------------------------------------------
  ligneSocle(id) {
    const c = this.api.comptes, b = this.api.broker;
    const r = b.resumeSocle(id) || { id, statut: null, enLigne: false, vu: null, zones: [] };
    const a = c.appareil(id);
    return { ...r, jamaisVu: !b.flotte[id], appareil: a ? { cree: a.cree || null, renouvele: a.renouvele || null } : null,
      proprietaires: c.proprietaires(id).map(u => u.login) };
  }

  socles() {
    const c = this.api.comptes, b = this.api.broker;
    const ids = new Set([...Object.keys(b.flotte), ...c.appareilsDetail().map(a => a.id)]);
    for (const u of c.utilisateursDetail()) for (const id of u.socles) ids.add(id);
    return [...ids].sort().map(id => this.ligneSocle(id));
  }

  rapports() {
    let noms;
    try { noms = fs.readdirSync(this.api.dossierRapports); } catch (e) { return []; }
    return noms.map(nom => {
      const m = NOM_RAPPORT.exec(nom);
      if (!m) return null;
      let octets;
      try { octets = fs.statSync(path.join(this.api.dossierRapports, nom)).size; } catch (e) { return null; }
      return { nom, date: `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`, compte: m[6], octets };
    }).filter(Boolean).sort((x, y) => (x.nom < y.nom ? 1 : -1));
  }

  tableau() {
    const a = this.api, o = a.o, c = a.comptes, b = a.broker;
    const socles = this.socles(), utilisateurs = c.utilisateursDetail(), rapports = this.rapports();
    const versions = {};
    for (const s of socles) if (s.version) versions[s.version] = (versions[s.version] || 0) + 1;
    const semaine = new Date(Date.now() - 7 * 86400000).toISOString();
    const v = a.audit.verifier();
    let amont = null;
    if (o.amont && o.amont.url) { try { amont = { hote: new URL(o.amont.url).host, connecte: b.amontConnecte() }; } catch (e) { amont = { hote: '?', connecte: false }; } }
    return {
      serveur: { version: o.version, demarre: new Date(a.demarre).toISOString(), push: !!a.notifications, email: !!a.courriel,
        rpId: o.rpId || null, origines: o.origines, amont, mqtt: { clients: b.clientsConnectes(), tcp: o.portMqttEcoute !== undefined ? o.portMqttEcoute : o.portMqtt } },
      socles: {
        total: socles.length, enLigne: socles.filter(s => s.enLigne).length,
        horsLigne: socles.filter(s => !s.enLigne && !s.jamaisVu).length, jamaisVus: socles.filter(s => s.jamaisVu).length,
        enDefaut: socles.filter(s => s.zones.some(z => z.defaut)).length, plantages: socles.filter(s => s.plantage).length,
        majEchec: socles.filter(s => s.maj && /echec|retour/.test(s.maj.etape || '')).length,
        sansProprietaire: socles.filter(s => !s.proprietaires.length).length, sansCompteAppareil: socles.filter(s => !s.appareil).length, versions
      },
      comptes: { total: utilisateurs.length, email: utilisateurs.filter(u => u.type === 'email').length, motDePasse: utilisateurs.filter(u => u.type === 'motdepasse').length,
        admins: utilisateurs.filter(u => u.admin).length, atelier: utilisateurs.filter(u => u.atelier && !u.admin).length, sansSocle: utilisateurs.filter(u => !u.socles.length).length,
        clesAcces: utilisateurs.reduce((n, u) => n + u.cles, 0), sessions: utilisateurs.reduce((n, u) => n + u.sessions, 0) },
      rapports: { total: rapports.length, semaine: rapports.filter(r => r.date >= semaine).length },
      audit: { ok: v.ok, n: v.n, tete: v.tete || null, rupture: v.rupture || null },
      support: a.support ? { ouvertes: [...a.support.demandes.values()].filter(d => d.statut !== 'résolue').length,
        nouvelles: [...a.support.demandes.values()].filter(d => d.statut === 'nouvelle').length,
        acces: [...a.support.acces.keys()].filter(id => a.support.accesActif(id)).length,
        relancesDues: [...a.support.demandes.values()].filter(d => d.relance && Date.parse(d.relance.quand) <= a.support.maintenant()).length } : null,
      alertes: this.alertes(socles)
    };
  }

  // Alertes proactives : ce que l'état général dit, sans ouvrir d'accès. Du
  // plus grave au plus doux ; la demande ouverte sur le socle, s'il y en a une.
  alertes(socles) {
    const a = this.api, maintenant = Date.now(), alertes = [];
    const veille = new Date(maintenant - 86400000).toISOString();
    const demandeOuverte = id => {
      if (!a.support) return null;
      const d = [...a.support.demandes.values()].find(x => x.socle === id && x.statut !== 'résolue');
      return d ? d.n : null;
    };
    for (const s of socles) {
      const pousser = (type, gravite, texte, depuis = null) => alertes.push({ socle: s.id, type, gravite, texte, depuis, demande: demandeOuverte(s.id), proprietaires: s.proprietaires.length });
      for (const [i, z] of s.zones.entries()) if (z.defaut) pousser('defaut', 'urgente', `zone ${i + 1} en défaut : ${typeof z.defaut === 'string' ? z.defaut : 'défaut'}`);
      if (s.maj && /echec|retour/.test(s.maj.etape || '')) pousser('maj', 'urgente', `mise à jour ${s.maj.etape} (${s.maj.version || '?'})`);
      if (!s.enLigne && !s.jamaisVu && s.proprietaires.length && s.vu && maintenant - Date.parse(s.vu) > 3600000) pousser('horsligne', 'normale', 'hors ligne depuis plus d\'une heure', s.vu);
      if (a.evenements) {
        const reboots = a.evenements.lire(s.id, { depuis: veille, limite: 50 }).filter(e => e.type === 'redemarrage').length;
        if (reboots >= 3) pousser('redemarrages', 'normale', `${reboots} redémarrages en 24 h`);
      }
      if (s.plantage) pousser('plantage', 'normale', 'un plantage attend d\'être lu (coredump)');
      if (s.enLigne && typeof s.rssi === 'number' && s.rssi && s.rssi < -80) pousser('signal', 'faible', `signal Wi-Fi faible (${s.rssi} dBm)`);
      const sante = (a.broker.flotte[s.id] || {}).sante || {};
      if (s.enLigne && typeof sante.heapMin === 'number' && sante.heapMin < 30000) pousser('memoire', 'faible', `mémoire au plus bas : ${Math.round(sante.heapMin / 1024)} Ko`);
    }
    const ordre = { urgente: 0, normale: 1, faible: 2 };
    return alertes.sort((x, y) => ordre[x.gravite] - ordre[y.gravite]);
  }

  // La frise d'un socle : ce qu'il a vécu (vu par le serveur), ce que son
  // propriétaire et l'équipe ont fait, et les messages des demandes.
  frise(id) {
    const a = this.api, elements = [];
    if (a.evenements) for (const e of a.evenements.lire(id, { limite: 300 })) elements.push({ t: e.t, source: 'socle', type: e.type, details: e });
    for (const e of a.audit.lire({ limite: 300, filtre: x => x.cible === id })) {
      elements.push({ t: e.t, source: e.qui === 'titulaire' ? 'client' : (e.qui === 'serveur' ? 'serveur' : 'support'), type: e.action, qui: e.qui, details: e.details });
    }
    if (a.support) {
      for (const d of a.support.demandes.values()) {
        if (d.socle !== id) continue;
        for (const m of d.messages) elements.push({ t: m.t, source: m.de === 'client' ? 'client' : 'support', type: 'message', qui: m.qui, details: { demande: d.n, extrait: m.texte.slice(0, 200) } });
      }
    }
    return elements.sort((x, y) => (x.t < y.t ? 1 : x.t > y.t ? -1 : 0)).slice(0, 400);
  }

  // --- aiguillage -----------------------------------------------------------------------
  async traiter(req, res, methode, chemin, url, qui) {
    const a = this.api, c = a.comptes, b = a.broker;
    const autorise = qui.role === 'admin' || (qui.support && permis(PERMIS_SUPPORT, methode, chemin)) || (qui.atelier && permis(PERMIS_ATELIER, methode, chemin));
    if (!autorise) return a.json(res, 403, { erreur: 'réservé aux administrateurs', droits: 'admin' });
    if (chemin.startsWith('/api/admin/support/')) return a.routesSupport.equipe(req, res, methode, chemin, url, qui);

    if (methode === 'GET' && chemin === '/api/flotte') return a.json(res, 200, { socles: b.etatFlotte(), comptes: c.resume() });
    if (methode === 'GET' && chemin === '/api/admin/comptes') return a.json(res, 200, c.resume());
    if (methode === 'GET' && chemin === '/api/admin/moi') return a.json(res, 200, { qui: qui.qui, compte: qui.login, role: qui.role, version: a.o.version, email: !!a.courriel });
    if (methode === 'GET' && chemin === '/api/admin/tableau') return a.json(res, 200, this.tableau());

    // --- socles ---
    if (methode === 'GET' && chemin === '/api/admin/socles') return a.json(res, 200, { socles: this.socles() });
    const mS = R_SOCLE.exec(chemin);
    if (mS) {
      const id = mS[1];
      if (!mS[2] && methode === 'GET') {
        const ligne = this.ligneSocle(id);
        if (ligne.jamaisVu && !ligne.appareil && !ligne.proprietaires.length) return a.erreur(res, 404, 'socle inconnu de ce serveur');
        const detail = b.detailSocle(id);
        return a.json(res, 200, { ...ligne, sante: detail ? detail.sante : null, etatsZones: detail ? detail.etatsZones : [],
          proprietairesDetail: c.proprietaires(id).map(u => ({ login: u.login, type: u.empreinte ? 'motdepasse' : 'email', admin: !!u.admin })),
          dernierPoint: a.historique.dernierPoint(id), journal: a.audit.lire({ limite: 50, filtre: e => e.cible === id }),
          acces: a.support ? a.support.vueAcces(id) : null,
          demandes: a.support ? [...a.support.demandes.values()].filter(d => d.socle === id).map(d => ({ n: d.n, statut: d.statut, gravite: d.gravite, cree: d.cree })) : [] });
      }
      if (mS[2] === '/historique' && methode === 'GET') return a.repondreHistorique(res, id, url);
      if (mS[2] === '/frise' && methode === 'GET') return a.json(res, 200, { id, frise: this.frise(id), acces: a.support ? a.support.vueAcces(id) : null });
      if (mS[2] && mS[2].startsWith('/proprietaires')) {
        if (methode === 'POST' && !mS[3]) {
          const d = await a.lireJson(req);
          if (!c.utilisateur(d.login)) return a.erreur(res, 404, 'compte inconnu');
          c.attribuerSocle(d.login, id);
          this.noter(qui, 'socle.rattacher', id, { compte: refCompte(d.login) });
          return a.json(res, 200, { ok: true, proprietaires: c.proprietaires(id).map(u => u.login) });
        }
        if (methode === 'DELETE' && mS[3]) {
          const login = decoder(mS[3]);
          if (!login || !c.utilisateur(login)) return a.erreur(res, 404, 'compte inconnu');
          c.retirerSocle(login, id);
          this.noter(qui, 'socle.detacher', id, { compte: refCompte(login) });
          return a.json(res, 200, { ok: true, proprietaires: c.proprietaires(id).map(u => u.login) });
        }
      }
      return a.erreur(res, 404, 'route inconnue');
    }

    // --- comptes d'appareil ---
    if (chemin === '/api/admin/appareils') {
      if (methode === 'GET') {
        return a.json(res, 200, { appareils: c.appareilsDetail().map(x => {
          const r = b.resumeSocle(x.id);
          return { ...x, vu: r ? r.vu : null, enLigne: r ? r.enLigne : false, version: r ? r.version : null, proprietaires: c.proprietaires(x.id).map(u => u.login) };
        }) });
      }
      if (methode === 'POST') {
        const d = await a.lireJson(req);
        // L'atelier crée (ou recrée) le compte d'un socle qu'il monte ; celui
        // d'un socle déjà chez un client ne se renouvelle que par un administrateur.
        if (qui.role !== 'admin' && c.proprietaires(String(d.id || '')).length) {
          return a.json(res, 403, { erreur: 'socle déjà rattaché à un client : son compte d\'appareil ne se renouvelle que par un administrateur', droits: 'admin' });
        }
        const existait = !!c.appareil(d.id);
        const r = c.ajouterAppareil(d.id, d.motDePasse);
        this.noter(qui, existait ? 'appareil.renouveler' : 'appareil.creer', r.id, d.motDePasse ? { motDePasse: 'fourni' } : null);
        return a.json(res, 201, r);
      }
    }
    const mA = R_APPAREIL.exec(chemin);
    if (mA) {
      const id = mA[1];
      if (!c.appareil(id)) return a.erreur(res, 404, 'compte d\'appareil inconnu');
      if (methode === 'POST' && mA[2]) {
        const r = c.renouvelerAppareil(id);
        this.noter(qui, 'appareil.renouveler', id, null);
        return a.json(res, 200, r);
      }
      if (methode === 'DELETE' && !mA[2]) {
        const d = await a.lireJson(req);
        if (String(d.confirmation || '').trim() !== id) return a.erreur(res, 400, `confirmation : taper « ${id} »`);
        const proprietaires = c.proprietaires(id).length;
        c.retirerAppareil(id);
        this.noter(qui, 'appareil.retirer', id, { proprietairesDetaches: proprietaires });
        return a.json(res, 200, { retire: true });
      }
      return a.erreur(res, 404, 'route inconnue');
    }

    // --- comptes utilisateur ---
    if (chemin === '/api/admin/utilisateurs') {
      if (methode === 'GET') return a.json(res, 200, { utilisateurs: c.utilisateursDetail() });
      if (methode === 'POST') {
        const d = await a.lireJson(req);
        const genere = !d.motDePasse;
        const mdp = genere ? Comptes.motDePasseAleatoire() : d.motDePasse;
        const u = c.ajouterUtilisateur(d.login, mdp, { admin: !!d.admin });
        this.noter(qui, 'compte.creer', refCompte(u.login), { admin: !!d.admin, motDePasse: genere ? 'tiré par la console' : 'fourni' });
        return a.json(res, 201, genere ? { login: u.login, motDePasse: mdp } : { login: u.login });
      }
    }
    const mU = R_UTILISATEUR.exec(chemin);
    if (mU) {
      const login = decoder(mU[1]);
      const u = login ? c.utilisateur(login) : null;
      if (!u) return a.erreur(res, 404, 'compte inconnu');
      const ref = refCompte(u.login), moiMeme = !!qui.login && qui.login.toLowerCase() === u.login.toLowerCase();
      const quoi = mU[2] || '';
      if (!quoi && methode === 'GET') {
        return a.json(res, 200, { ...c.detailUtilisateur(u.login), reference: ref,
          soclesDetail: u.socles.map(id => this.ligneSocle(id)), journal: a.audit.lire({ limite: 50, filtre: this.filtreCompte(u.login) }) });
      }
      if (!quoi && methode === 'DELETE') {
        const d = await a.lireJson(req);
        if (moiMeme) return a.erreur(res, 400, 'on n\'efface pas son propre compte depuis la console');
        if (String(d.confirmation || '').trim().toLowerCase() !== u.login.toLowerCase()) return a.erreur(res, 400, `confirmation : taper « ${u.login} »`);
        const nbSocles = u.socles.length;
        const r = c.supprimerUtilisateur(u.login);
        await a.apresEffacement(u.login, r.orphelins);
        this.noter(qui, 'compte.supprimer', ref, { socles: nbSocles, historiquesEffaces: r.orphelins.length });
        return a.json(res, 200, { ok: true, historiquesEffaces: r.orphelins.length });
      }
      if (quoi === '/admin' && methode === 'POST') {
        const d = await a.lireJson(req);
        if (moiMeme && !d.admin) return a.erreur(res, 400, 'on ne retire pas ses propres droits : demander à un autre administrateur');
        c.definirAdmin(u.login, !!d.admin);
        this.noter(qui, 'compte.admin', ref, { admin: !!d.admin });
        return a.json(res, 200, { ok: true, admin: !!d.admin });
      }
      if (quoi === '/support' && methode === 'POST') {
        const d = await a.lireJson(req);
        c.definirSupport(u.login, !!d.support);
        this.noter(qui, 'compte.support', ref, { support: !!d.support });
        return a.json(res, 200, { ok: true, support: !!d.support });
      }
      if (quoi === '/atelier' && methode === 'POST') {
        const d = await a.lireJson(req);
        c.definirAtelier(u.login, !!d.atelier);
        this.noter(qui, 'compte.atelier', ref, { atelier: !!d.atelier });
        return a.json(res, 200, { ok: true, atelier: !!d.atelier });
      }
      if (quoi === '/sessions/fermer' && methode === 'POST') {
        const n = c.fermerSessions(u.login);
        this.noter(qui, 'compte.sessions.fermer', ref, { sessions: n });
        return a.json(res, 200, { ok: true, fermees: n });
      }
      if (quoi === '/mot-de-passe' && methode === 'POST') {
        const mdp = c.reinitialiserMotDePasse(u.login);
        this.noter(qui, 'compte.motdepasse', ref, null);
        return a.json(res, 200, { motDePasse: mdp });
      }
      if (quoi === '/export' && methode === 'GET') {
        // Droit d'accès (RGPD, art. 15) exercé auprès de l'exploitant : le compte,
        // et ce que le journal dit de lui — sans nommer les membres de l'équipe.
        const journal = a.audit.lire({ limite: 5000, filtre: this.filtreCompte(u.login) })
          .map(e => ({ quand: e.t, par: e.qui === 'titulaire' ? 'titulaire' : 'exploitant', action: e.action, cible: e.cible, details: e.details }));
        this.noter(qui, 'compte.export', ref, null);
        res.setHeader('Content-Disposition', 'attachment; filename="terrariums-compte.json"');
        return a.json(res, 200, { ...a.exportCompte(u.login), journal });
      }
      if (quoi.startsWith('/socles')) {
        if (methode === 'POST' && !mU[3]) {
          const d = await a.lireJson(req);
          c.attribuerSocle(u.login, d.id);
          this.noter(qui, 'socle.rattacher', String(d.id), { compte: ref });
          return a.json(res, 200, { ok: true });
        }
        if (methode === 'DELETE' && mU[3]) {
          c.retirerSocle(u.login, mU[3]);
          this.noter(qui, 'socle.detacher', mU[3], { compte: ref });
          return a.json(res, 200, { ok: true });
        }
      }
      if (quoi.startsWith('/cles/') && methode === 'DELETE') {
        const cle = (u.cles || []).find(x => x.id === mU[4]);
        if (!cle) return a.erreur(res, 404, 'clé d\'accès inconnue');
        c.retirerCle(u.login, cle.id);
        this.noter(qui, 'compte.cle.retirer', ref, { nom: cle.nom });
        return a.json(res, 200, { retiree: true });
      }
      return a.erreur(res, 404, 'route inconnue');
    }

    // --- rapports de diagnostic ---
    if (methode === 'GET' && chemin === '/api/admin/rapports') return a.json(res, 200, { rapports: this.rapports() });
    const mR = R_RAPPORT.exec(chemin);
    if (mR) {
      const nom = decoder(mR[1]);
      if (!nom || !NOM_RAPPORT.test(nom)) return a.erreur(res, 400, 'nom de rapport invalide');
      const fichier = path.join(a.dossierRapports, nom);
      if (!fs.existsSync(fichier)) return a.erreur(res, 404, 'rapport inconnu');
      if (methode === 'GET') {
        const texte = fs.readFileSync(fichier, 'utf8');
        this.noter(qui, 'rapport.lire', nom, null);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': 'default-src \'none\'; sandbox',
          'Content-Disposition': `inline; filename="${nom}"` });
        return res.end(texte);
      }
      if (methode === 'DELETE') {
        fs.unlinkSync(fichier);
        this.noter(qui, 'rapport.supprimer', nom, null);
        return a.json(res, 200, { supprime: true });
      }
    }

    // --- journal d'audit ---
    if (methode === 'GET' && (chemin === '/api/admin/audit' || chemin === '/api/admin/audit/export')) {
      const cible = url.searchParams.get('cible'), compte = url.searchParams.get('compte');
      const fc = compte ? this.filtreCompte(compte) : null;
      const filtre = cible || fc ? (e => (!cible || e.cible === cible) && (!fc || fc(e))) : null;
      if (chemin === '/api/admin/audit/export') {
        const lignes = a.audit.lire({ limite: 100000, filtre }).reverse();
        this.noter(qui, 'audit.export', cible || (compte ? refCompte(compte) : null), { lignes: lignes.length });
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Disposition': 'attachment; filename="terrariums-audit.ndjson"' });
        return res.end(lignes.map(l => JSON.stringify(l)).join('\n') + (lignes.length ? '\n' : ''));
      }
      const limite = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('limite') || '200', 10) || 200));
      return a.json(res, 200, { entrees: a.audit.lire({ limite, filtre }), verification: a.audit.verifier() });
    }

    return a.erreur(res, 404, 'route inconnue');
  }
}

module.exports = { Admin, NOM_RAPPORT };
