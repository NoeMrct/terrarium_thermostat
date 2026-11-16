'use strict';
/* Atelier : le registre du montage des socles, partagé par les postes.
   -----------------------------------------------------------------------------
   La page Atelier (app/atelier.html) suit chaque socle de la console USB à
   l'expédition. Connectée au serveur avec un compte administrateur ou au rôle
   « atelier », elle range ici ce qu'elle sait de chaque socle : tous les postes
   voient le même registre, et le serveur prend le relais pendant le rodage.

   - Registre (donnees/atelier.json, réécrit atomiquement) : une fiche par
     socle, des lots, une révision qui croît à chaque écriture. Un poste ne
     relit que ce qui a changé depuis sa dernière révision ; il écrit une fiche
     en disant de quelle révision il part, et une fiche changée entre-temps par
     un autre poste (ou par le serveur pendant le rodage) lui est rendue au lieu
     d'être écrasée.
   - Aucun secret du socle ici : ni code d'appairage, ni mot de passe de la page
     locale. Ils restent dans le navigateur du poste qui a monté le socle, puis
     sur l'étiquette — le serveur ne peut rien commander à un socle sans eux.
   - Wi-Fi du banc : saisi une fois pour tout l'atelier, rendu aux postes
     connectés. Son mot de passe est chiffré (AES-256-GCM) par une clé tirée du
     jeton d'administration, qui ne vit pas avec les données : les sauvegardes
     ne le contiennent pas en clair.
   - Rodage : pour un socle relié à ce serveur, le serveur note lui-même
     redémarrages, défauts et coupures, et conclut à la fin, page fermée ou
     non. L'équipe de l'atelier (administrateurs, rôle atelier) est prévenue par
     e-mail et sur ses navigateurs abonnés : fin de rodage, incident, socle
     disparu. Les alertes proches sont groupées en un seul message. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID = /^terra[0-9A-Za-z]{6}$/;
const LOT = /^lot-[0-9a-z]{1,24}$/;
const TAILLE_MAX_FICHE = 48 * 1024;
// Champs que le serveur écrit lui-même, et secrets qui ne doivent pas venir.
const CHAMPS_SERVEUR = ['rev', 'par', 'recu'];
const CHAMPS_SECRETS = ['code', 'web', 'jeton', 'motDePasse'];
const ETATS = ['actif', 'pret', 'expedie', 'cote'];
// Un socle hors ligne à la fin du rodage : attendu un moment, puis rodage échoué.
const ATTENTE_FIN_MS = 30 * 60000;
// Santé publiée chaque minute : plus vieille que cela, le socle n'est plus là.
const SANTE_FRAICHE_MS = 5 * 60000;

const deux = n => String(n).padStart(2, '0');
function duree(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const hh = Math.floor(m / 60), mm = m % 60;
  return mm ? `${hh} h ${deux(mm)}` : `${hh} h`;
}
// Défaut d'une zone tel que le socle le publie, en mots (ou null).
function defautDe(z) {
  if (!z) return null;
  const d = z.defaut;
  if (d === true || d === 1 || d === '1') return z.defaut_libelle && z.defaut_libelle !== 'OK' ? String(z.defaut_libelle) : 'DÉFAUT';
  if (typeof d === 'string' && d.length > 1 && d.toUpperCase() !== 'OK') return d;
  return null;
}
const texteCourt = (x, n = 200) => String(x === undefined || x === null ? '' : x).replace(/\p{Cc}/gu, ' ').trim().slice(0, n);

class Atelier {
  constructor(dossier, { cleSecrete = null, comptes = null, broker = null, audit = null, notifications = null, courriel = null,
    journal = () => {}, lien = null, delaiAlertesMs = 120000, delaiHorsLigneMs = 5 * 60000, maintenant = () => Date.now() } = {}) {
    this.chemin = path.join(dossier, 'atelier.json');
    this.comptes = comptes; this.broker = broker; this.audit = audit;
    this.journal = journal;
    this.maintenant = maintenant;
    this.cle = Atelier.cleChiffrement(dossier, cleSecrete);
    this.d = { v: 1, rev: 0, lots: {}, socles: {}, wifi: null };
    this.charger();
    this.alertes = new AlertesAtelier({ comptes, notifications, courriel, journal, lien, delaiMs: delaiAlertesMs });
    this.delaiHorsLigneMs = delaiHorsLigneMs;
    this.absences = new Map();       // id -> minuteur de l'alerte « hors ligne »
  }

  // La clé du Wi-Fi partagé : tirée du jeton d'administration (hors des
  // données sauvegardées) ; à défaut, d'un secret aléatoire gardé à part.
  static cleChiffrement(dossier, secret) {
    let ikm = secret ? String(secret) : null;
    if (!ikm) {
      const f = path.join(dossier, 'atelier.cle');
      try { ikm = fs.readFileSync(f, 'utf8').trim(); } catch (e) { ikm = ''; }
      if (!ikm) {
        ikm = crypto.randomBytes(32).toString('hex');
        fs.mkdirSync(dossier, { recursive: true });
        fs.writeFileSync(f, ikm + '\n', { mode: 0o600 });
      }
    }
    return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(ikm), Buffer.from('terrariums'), Buffer.from('atelier/wifi'), 32));
  }
  chiffrer(texte) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.cle, iv);
    const ct = Buffer.concat([c.update(String(texte), 'utf8'), c.final()]);
    return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') };
  }
  dechiffrer(x) {
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', this.cle, Buffer.from(x.iv, 'base64'));
      d.setAuthTag(Buffer.from(x.tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(x.ct, 'base64')), d.final()]).toString('utf8');
    } catch (e) { return null; }      // clé changée (nouveau jeton d'administration) : à ressaisir
  }

  // --- registre ----------------------------------------------------------------------
  charger() {
    try {
      const lu = JSON.parse(fs.readFileSync(this.chemin, 'utf8'));
      if (lu && lu.v === 1) {
        const socles = {}, lots = {};
        for (const [id, s] of Object.entries(lu.socles || {})) if (ID.test(id) && s && typeof s === 'object') socles[id] = s;
        for (const [id, l] of Object.entries(lu.lots || {})) if (LOT.test(id) && l && typeof l === 'object') lots[id] = l;
        this.d = { v: 1, rev: Number(lu.rev) || 0, lots, socles, wifi: lu.wifi && typeof lu.wifi === 'object' ? lu.wifi : null };
      }
    } catch (e) { /* premier démarrage */ }
  }
  sauver() {
    const tmp = `${this.chemin}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.d));
    fs.renameSync(tmp, this.chemin);
  }
  socle(id) { return ID.test(String(id)) ? this.d.socles[id] || null : null; }
  // Un socle « en atelier » : au registre et pas encore expédié. C'est ce que le
  // rôle atelier peut piloter sur le broker.
  enAtelier(id) { const s = this.socle(id); return !!s && s.etat !== 'expedie'; }
  static enRodage(s) {
    return !!s && s.etat === 'actif' && s.etape === 4 && !!s.rodage && typeof s.rodage === 'object' && !s.rodage.verdict
      && Number.isFinite(s.rodage.debut) && Number.isFinite(s.rodage.fin);
  }
  // Le serveur surveille les rodages qu'il voit passer : socles reliés à lui.
  surveille(s) { return Atelier.enRodage(s) && s.liaison === 'serveur'; }

  vueWifi() {
    const w = this.d.wifi;
    if (!w) return null;
    const mdp = w.mdp ? this.dechiffrer(w.mdp) : '';
    return { ssid: w.ssid, motDePasse: mdp === null ? null : mdp, rev: w.rev, par: w.par, maj: w.maj };
  }
  // Ce qu'un poste n'a pas encore vu (tout, depuis 0).
  vue(depuis = 0) {
    const d = Number(depuis) || 0;
    const w = this.d.wifi && this.d.wifi.rev > d ? this.vueWifi() : undefined;
    return {
      rev: this.d.rev,
      socles: Object.values(this.d.socles).filter(s => s.rev > d),
      lots: Object.values(this.d.lots).filter(l => l.rev > d),
      ...(w !== undefined ? { wifi: w } : {}),
      ...(d === 0 && !this.d.wifi ? { wifi: null } : {})
    };
  }

  // Une fiche venue d'un poste : ce qui ressemble à un secret est retiré, la
  // taille bornée. Le reste est l'affaire de la page (son format évolue).
  static nettoyer(id, rec) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) throw new Error('fiche attendue');
    const f = JSON.parse(JSON.stringify(rec));
    for (const k of [...CHAMPS_SERVEUR, ...CHAMPS_SECRETS]) delete f[k];
    f.id = id;
    if (f.etat !== undefined && !ETATS.includes(f.etat)) throw new Error('état inconnu');
    if (f.etape !== undefined && !(Number.isInteger(f.etape) && f.etape >= 1 && f.etape <= 5)) throw new Error('étape : 1 à 5');
    if (f.lot !== undefined && f.lot !== null && !LOT.test(String(f.lot))) throw new Error('lot invalide');
    if (JSON.stringify(f).length > TAILLE_MAX_FICHE) throw new Error('fiche trop grande');
    return f;
  }

  // base : la révision de la fiche d'où part le poste (0 : il ne l'a jamais vue).
  ecrireSocle(id, rec, base, qui) {
    if (!ID.test(String(id))) throw new Error('identifiant de socle invalide');
    const f = Atelier.nettoyer(id, rec);
    const cur = this.d.socles[id];
    const b = Number(base) || 0;
    if (cur && b !== cur.rev) {
      // Un registre d'avant le partage, versé pour la première fois : la fiche
      // la plus récente l'emporte. Sinon, l'autre poste a écrit entre-temps.
      if (b !== 0 || !((Number(f.maj) || 0) > (Number(cur.maj) || 0))) return { conflit: true, socle: cur };
    }
    const fiche = { ...f, rev: ++this.d.rev, par: qui, recu: this.maintenant() };
    this.d.socles[id] = fiche;
    this.sauver();
    if (fiche.etat === 'expedie' && (!cur || cur.etat !== 'expedie') && this.audit) {
      this.audit.noter({ qui, action: 'atelier.expedier', cible: id, details: fiche.lot ? { lot: fiche.lot } : null });
    }
    // Un socle sorti du rodage n'a plus d'alerte « hors ligne » en attente.
    if (!Atelier.enRodage(fiche)) this.oublierAbsence(id);
    return { socle: fiche };
  }

  ecrireLot(id, lot, qui) {
    if (!LOT.test(String(id))) throw new Error('identifiant de lot invalide');
    const nom = texteCourt(lot && lot.nom, 80);
    if (!nom) throw new Error('nom du lot attendu');
    const cur = this.d.lots[id];
    const cree = Number(lot.cree) || (cur && cur.cree) || this.maintenant();
    const l = { id, nom, cree, rev: ++this.d.rev, par: qui };
    this.d.lots[id] = l;
    this.sauver();
    return l;
  }

  ecrireWifi({ ssid, motDePasse }, qui) {
    const s = String(ssid || ''), m = String(motDePasse || '');
    if (!s || Buffer.byteLength(s) > 32 || /\s/.test(s)) throw new Error('nom du Wi-Fi : 1 à 32 caractères, sans espace');
    if (m.length > 64 || /\s/.test(m) || (m && m.length < 8)) throw new Error('mot de passe du Wi-Fi : 8 à 64 caractères, sans espace (ou aucun)');
    const avant = this.d.wifi;
    this.d.wifi = { ssid: s, mdp: m ? this.chiffrer(m) : null, rev: ++this.d.rev, par: qui, maj: this.maintenant() };
    this.sauver();
    if (this.audit && (!avant || avant.ssid !== s || !!avant.mdp !== !!m || (avant.mdp && this.dechiffrer(avant.mdp) !== m))) {
      this.audit.noter({ qui, action: 'atelier.wifi', cible: s, details: { motDePasse: m ? 'chiffré' : 'aucun' } });
    }
    return { ssid: s, rev: this.d.wifi.rev, par: qui, maj: this.d.wifi.maj };
  }
  oublierWifi(qui) {
    if (!this.d.wifi) return false;
    const ssid = this.d.wifi.ssid;
    // Une révision nouvelle : les postes apprennent l'oubli à leur prochaine lecture.
    this.d.wifi = { ssid: '', mdp: null, rev: ++this.d.rev, par: qui, maj: this.maintenant(), oublie: true };
    this.sauver();
    if (this.audit) this.audit.noter({ qui, action: 'atelier.wifi.oublier', cible: ssid });
    return true;
  }

  // --- surveillance du rodage ----------------------------------------------------------
  brancher(broker) {
    this.broker = broker;
    broker.on('redemarrage', (id, sante) => {
      const s = this.socle(id);
      if (this.surveille(s)) this.incident(s, `redémarrage${sante && sante.reset ? ` (${texteCourt(sante.reset, 60)})` : ''}`, true);
    });
    broker.on('etat', (id, zone, etat, avant) => {
      const s = this.socle(id);
      if (!this.surveille(s) || avant === undefined) return;     // l'état retenu rejoué n'est pas un événement
      const d = defautDe(etat);
      if (d && d !== defautDe(avant)) this.incident(s, `zone ${zone + 1} : ${texteCourt(d, 60)}`, true);
    });
    broker.on('horsLigne', id => {
      const s = this.socle(id);
      if (!this.surveille(s)) return;
      this.incident(s, 'hors ligne', false);
      this.oublierAbsence(id);
      const m = setTimeout(() => {
        this.absences.delete(id);
        const x = this.socle(id);
        if (!this.surveille(x)) return;
        this.alertes.signaler({ socle: id, type: 'horsligne', grave: true,
          texte: `hors ligne depuis ${duree(this.delaiHorsLigneMs)} pendant le rodage : alimentation, Wi-Fi du banc ?` });
      }, this.delaiHorsLigneMs);
      if (m.unref) m.unref();
      this.absences.set(id, m);
    });
    broker.on('enLigne', id => {
      const s = this.socle(id);
      this.oublierAbsence(id);
      if (this.surveille(s)) this.incident(s, 'de retour en ligne', false);
    });
  }
  oublierAbsence(id) {
    const m = this.absences.get(id);
    if (m) { clearTimeout(m); this.absences.delete(id); }
  }
  arreter() {
    for (const m of this.absences.values()) clearTimeout(m);
    this.absences.clear();
    this.alertes.arreter();
  }

  noter(s, texte) {
    s.journal = Array.isArray(s.journal) ? s.journal : [];
    s.journal.push({ t: this.maintenant(), texte, par: 'serveur' });
    if (s.journal.length > 200) s.journal.splice(0, s.journal.length - 200);
    s.maj = this.maintenant();
  }
  publier(s) {
    s.rev = ++this.d.rev;
    s.par = 'serveur';
    s.recu = this.maintenant();
    this.sauver();
  }

  incident(s, texte, grave) {
    if (!Array.isArray(s.rodage.incidents)) s.rodage.incidents = [];
    s.rodage.incidents.push({ t: this.maintenant(), texte, grave: !!grave, par: 'serveur' });
    if (s.rodage.incidents.length > 100) s.rodage.incidents.splice(0, s.rodage.incidents.length - 100);
    this.noter(s, `Rodage : ${texte}`);
    this.publier(s);
    if (grave) this.alertes.signaler({ socle: s.id, type: 'incident', grave: true, texte: `${texte} pendant le rodage` });
  }

  // Ce que le serveur sait d'un socle : sa dernière santé et quand elle est venue.
  etatSocle(id) {
    const f = (this.broker && this.broker.flotte[id]) || null;
    if (!f) return { enLigne: false };
    const recue = f.santeRecue || 0;
    const maintenant = this.maintenant();
    return {
      enLigne: f.statut === 'en ligne' && !!f.sante && maintenant - recue < SANTE_FRAICHE_MS,
      uptime: f.sante && typeof f.sante.uptime === 'number' ? f.sante.uptime + (maintenant - recue) / 1000 : null,
      zones: Object.entries(f.zones || {}).sort((a, b) => a[0] - b[0]).map(([, z]) => z),
      vu: f.vu || null
    };
  }

  // Les rodages arrivés à terme : verdict du serveur. Appelé chaque minute.
  tourner() {
    const maintenant = this.maintenant();
    for (const s of Object.values(this.d.socles)) {
      if (!this.surveille(s) || maintenant < s.rodage.fin) continue;
      const e = this.etatSocle(s.id);
      let ok, texte;
      if (!e.enLigne) {
        if (maintenant - s.rodage.fin < ATTENTE_FIN_MS) continue;     // il reviendra peut-être
        ok = false;
        texte = `hors ligne à la fin du rodage${e.vu ? ` (dernier signe il y a ${duree(maintenant - e.vu)})` : ''}`;
      } else {
        const ecouleS = (maintenant - s.rodage.debut) / 1000;
        const redemarre = !(e.uptime >= ecouleS - 90);
        const defauts = e.zones.map((z, i) => (defautDe(z) ? `zone ${i + 1} : ${defautDe(z)}` : '')).filter(Boolean);
        const graves = (s.rodage.incidents || []).filter(i => i && i.grave).map(i => String(i.texte));
        const problemes = [...new Set([...(redemarre ? [`a redémarré pendant le rodage (en marche depuis ${duree(e.uptime * 1000)})`] : []), ...defauts, ...graves])];
        ok = !problemes.length;
        texte = ok ? `En marche depuis ${duree(e.uptime * 1000)}, sans redémarrage ni défaut` : problemes.join(' ; ');
      }
      s.rodage.verdict = { ok, texte, t: maintenant, par: 'serveur' };
      this.noter(s, `Rodage : ${ok ? 'réussi' : 'échoué'} — ${texte} (verdict du serveur)`);
      if (ok) { s.etat = 'pret'; s.etape = 5; s.echec = null; } else s.echec = { etape: 4, texte, t: maintenant };
      this.publier(s);
      this.oublierAbsence(s.id);
      this.alertes.signaler({ socle: s.id, type: ok ? 'pret' : 'echec', grave: !ok,
        texte: ok ? 'rodage réussi, prêt pour l\'étiquette' : `rodage échoué — ${texte}` });
    }
  }

  // --- routes /api/atelier/… (administrateurs et rôle atelier) --------------------------
  async traiter(api, req, res, methode, chemin, url, qui) {
    if (methode === 'GET' && chemin === '/api/atelier/registre') {
      const u = qui.login ? this.comptes.utilisateur(qui.login) : null;
      return api.json(res, 200, { ...this.vue(url.searchParams.get('depuis')),
        moi: { login: qui.login, role: qui.role, alertes: u ? this.comptes.alertesAtelier(u) : null } });
    }
    const mS = /^\/api\/atelier\/socles\/(terra[0-9A-Za-z]{6})$/.exec(chemin);
    if (mS && methode === 'PUT') {
      const d = await api.lireJson(req);
      let r;
      try { r = this.ecrireSocle(mS[1], d.socle, d.base, qui.qui); }
      catch (e) { return api.erreur(res, 400, e.message); }
      if (r.conflit) return api.json(res, 409, { erreur: 'fiche changée entre-temps par un autre poste ou par le serveur', socle: r.socle });
      return api.json(res, 200, { socle: r.socle, rev: this.d.rev });
    }
    const mL = /^\/api\/atelier\/lots\/([^/]+)$/.exec(chemin);
    if (mL && methode === 'PUT') {
      const d = await api.lireJson(req);
      try { return api.json(res, 200, { lot: this.ecrireLot(mL[1], d, qui.qui), rev: this.d.rev }); }
      catch (e) { return api.erreur(res, 400, e.message); }
    }
    if (chemin === '/api/atelier/wifi') {
      if (methode === 'PUT') {
        const d = await api.lireJson(req);
        try { return api.json(res, 200, { wifi: this.ecrireWifi(d, qui.qui), rev: this.d.rev }); }
        catch (e) { return api.erreur(res, 400, e.message); }
      }
      if (methode === 'DELETE') return api.json(res, 200, { oublie: this.oublierWifi(qui.qui), rev: this.d.rev });
    }
    if (methode === 'POST' && chemin === '/api/atelier/alertes') {
      if (!qui.login) return api.erreur(res, 400, 'alertes : propres à un compte (pas au jeton d\'administration)');
      const d = await api.lireJson(req);
      if (typeof d.email !== 'boolean') return api.erreur(res, 400, 'email : true ou false');
      return api.json(res, 200, { alertes: this.comptes.definirAlertesAtelier(qui.login, d.email) });
    }
    return api.erreur(res, 404, 'route inconnue');
  }
}

// --- alertes de l'atelier -------------------------------------------------------------
// Ce qui arrive en quelques minutes part ensemble : un rodage de dix socles
// lancés ensemble donne un e-mail, pas dix.
class AlertesAtelier {
  constructor({ comptes, notifications, courriel, journal, lien, delaiMs }) {
    Object.assign(this, { comptes, notifications, courriel, journal, lien, delaiMs });
    this.file = [];
    this.minuteur = null;
    this.envoyees = 0;
  }
  signaler(e) {
    this.file.push({ ...e, t: Date.now() });
    if (!this.minuteur) {
      this.minuteur = setTimeout(() => { this.vider().catch(err => this.journal(`atelier : alertes non envoyées (${err.message})`)); }, this.delaiMs);
      if (this.minuteur.unref) this.minuteur.unref();
    }
  }
  arreter() { clearTimeout(this.minuteur); this.minuteur = null; }

  static resume(evts) {
    const n = t => evts.filter(e => e.type === t).length;
    const pret = n('pret'), echec = n('echec'), incident = n('incident') + n('horsligne');
    const parts = [];
    if (pret) parts.push(`${pret} rodage${pret > 1 ? 's' : ''} réussi${pret > 1 ? 's' : ''}`);
    if (echec) parts.push(`${echec} rodage${echec > 1 ? 's' : ''} échoué${echec > 1 ? 's' : ''}`);
    if (incident) parts.push(`${incident} incident${incident > 1 ? 's' : ''}`);
    return parts.join(', ');
  }

  async vider() {
    clearTimeout(this.minuteur);
    this.minuteur = null;
    const evts = this.file.splice(0);
    if (!evts.length || !this.comptes) return 0;
    const lignes = evts.map(e => `- ${e.socle} : ${e.texte}`);
    const un = evts.length === 1 ? evts[0] : null;
    const sujet = un ? `Atelier : ${un.socle}, ${un.type === 'pret' ? 'prêt pour l\'étiquette' : un.type === 'echec' ? 'rodage échoué' : 'incident de rodage'}`
      : `Atelier : ${AlertesAtelier.resume(evts)}`;
    const texte = 'Bonjour,\n\nDu nouveau à l\'atelier :\n\n' + lignes.join('\n') + '\n\n'
      + (this.lien ? `Ouvrir l'atelier : ${this.lien}\n\n` : '')
      + 'Ces e-mails se coupent dans les réglages de la page Atelier (Alertes).\n\n— Terrariums\n';
    let n = 0;
    for (const u of this.comptes.equipeAtelier()) {
      if (u.email && this.courriel && this.comptes.alertesAtelier(u).email) {
        try { await this.courriel.envoyer({ a: u.email, sujet, texte }); n++; }
        catch (e) { this.journal(`atelier : e-mail d'alerte non envoyé (${e.message})`); }
      }
      if (this.notifications && this.comptes.abonnementsPush(u.login).length) {
        await this.notifications.notifier(this.comptes, u.login, { titre: 'Atelier',
          corps: un ? `${un.socle} : ${un.texte}` : `${AlertesAtelier.resume(evts)} — ${evts.map(e => e.socle).join(', ')}`,
          tag: 'atelier', page: 'atelier', socle: un ? un.socle : null, urgent: evts.some(e => e.grave), genre: 'atelier' }).catch(() => 0);
      }
    }
    this.envoyees += evts.length;
    this.journal(`atelier : ${evts.length} alerte(s) envoyée(s) à l'équipe (${n} e-mail(s))`);
    return evts.length;
  }
}

module.exports = { Atelier, AlertesAtelier, defautDe };
