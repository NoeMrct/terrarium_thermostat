'use strict';
/* Carnet du mois par e-mail (F16) : le 1er de chaque mois au matin, chaque
   compte qui l'a demandé reçoit un résumé du mois écoulé. Pour chaque socle :
   les températures de chaque zone (moyenne, extrêmes datés, temps passé près
   de la consigne), les jours où des mesures sont arrivées, les alertes vues
   par le serveur. Du texte seul : il se lit partout, sans image ni lien de
   suivi. Le carnet complet (courbes, consommation, journal du socle) reste le
   PDF que crée l'application.
   Les jours et les mois suivent le fuseau du serveur (variable TZ, par
   exemple TZ=Europe/Paris). */

const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const HEURE_ENVOI = 8;          // le 1er, pas avant 8 h
const ESSAIS_PAR_MOIS = 3;      // une adresse refusée n'est pas relancée sans fin
const PROCHE = 100;             // « près de la consigne » : à 1 °C au plus (centièmes)
const NB_ZONES = 2;
const ESP = ' ';           // espace insécable : « 28,3 °C », « 6 h 10 »

const cleMois = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const deMois = i => (/^[aeiou]/.test(MOIS[i]) ? 'd’' : 'de ') + MOIS[i];
const degres = c => `${(c / 100).toFixed(1).replace('.', ',')}${ESP}°C`;
const quantieme = j => (j === 1 ? '1er' : String(j));
const quand = epoch => {
  const d = new Date(epoch * 1000);
  return `le ${quantieme(d.getDate())} à ${d.getHours()}${ESP}h${ESP}${String(d.getMinutes()).padStart(2, '0')}`;
};
const nombre = (n, un, plusieurs) => `${n}${ESP}${n > 1 ? plusieurs : un}`;
// Dans le journal : « no…@exemple.fr », jamais l'adresse entière.
const masquer = e => String(e || '').replace(/^(.{0,2})[^@]*/, '$1…');
// Ce qui compte comme alerte dans le carnet, dans l'ordre où il le dit.
const ALERTES = [['defaut', 'défaut', 'défauts'], ['trop_chaud', 'excès de chaleur', 'excès de chaleur'],
  ['derive', 'dérive', 'dérives'], ['hors ligne', 'passage hors ligne', 'passages hors ligne']];

// Le mois que couvre un carnet envoyé à l'instant `maintenant` : le précédent.
function moisCouvert(maintenant = Date.now()) {
  const d = new Date(maintenant);
  const debut = new Date(d.getFullYear(), d.getMonth() - 1, 1), fin = new Date(d.getFullYear(), d.getMonth(), 1);
  return { cle: cleMois(debut), index: debut.getMonth(), annee: debut.getFullYear(), debut: debut.getTime(), fin: fin.getTime(),
    jours: new Date(d.getFullYear(), d.getMonth(), 0).getDate() };
}
// Le prochain envoi : le 1er du mois suivant (AAAA-MM-JJ).
function prochainEnvoi(maintenant = Date.now()) {
  const d = new Date(maintenant), p = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return `${cleMois(p)}-01`;
}

class Carnets {
  constructor({ comptes, historique, evenements = null, courriel = null, journal = () => {}, nomZone = null }) {
    this.comptes = comptes; this.historique = historique; this.evenements = evenements;
    this.courriel = courriel; this.journal = journal;
    this.nomZone = nomZone || ((id, z) => `Zone ${z + 1}`);
    this.echecs = new Map();      // login -> { cle, n } : essais ratés du mois
  }

  // Ce que le serveur sait d'un socle sur le mois : mesures et événements.
  resumeSocle(id, m) {
    const points = this.historique.lire(id, Math.floor(m.debut / 1000), Math.floor(m.fin / 1000) - 1, 60, Infinity);
    const zones = Array.from({ length: NB_ZONES }, () => ({ n: 0, somme: 0, min: null, max: null, avecConsigne: 0, proches: 0 }));
    const jours = new Set();
    for (const p of points) {
      let mesure = false;
      for (let z = 0; z < NB_ZONES; z++) {
        const t = p[1 + 2 * z], c = p[2 + 2 * z];
        if (typeof t !== 'number' || !isFinite(t)) continue;
        const s = zones[z];
        mesure = true;
        s.n++; s.somme += t;
        if (!s.min || t < s.min.v) s.min = { v: t, e: p[0] };
        if (!s.max || t > s.max.v) s.max = { v: t, e: p[0] };
        if (typeof c === 'number' && isFinite(c)) { s.avecConsigne++; if (Math.abs(t - c) <= PROCHE) s.proches++; }
      }
      if (mesure) jours.add(new Date(p[0] * 1000).getDate());
    }
    const alertes = {};
    if (this.evenements) {
      const debut = new Date(m.debut).toISOString(), fin = new Date(m.fin).toISOString();
      for (const e of this.evenements.lire(id, { depuis: debut, limite: 20000 })) {
        if (e.t >= fin) continue;
        alertes[e.type] = (alertes[e.type] || 0) + 1;
      }
    }
    return { id, jours: jours.size, zones, alertes };
  }

  // Le texte du carnet, et son objet.
  rediger(u, m, resumes) {
    const noms = (u.carnet && u.carnet.noms) || {};
    const l = ['Bonjour,', '', `Voici le carnet ${deMois(m.index)} ${m.annee} de vos socles.`];
    for (const r of resumes) {
      l.push('', noms[r.id] || r.id);
      const zones = r.zones.map((s, z) => ({ s, z })).filter(x => x.s.n);
      if (!zones.length) {
        l.push(`· Aucune mesure reçue en ${MOIS[m.index]} : le socle est peut-être resté hors ligne, ou relié à un autre serveur.`);
      } else {
        for (const { s, z } of zones) {
          const pres = s.avecConsigne ? ` ; à ±1${ESP}°C de la consigne ${Math.round(100 * s.proches / s.avecConsigne)}${ESP}% du temps` : '';
          l.push(`· ${this.nomZone(r.id, z)} : moyenne ${degres(s.somme / s.n)}, de ${degres(s.min.v)} (${quand(s.min.e)}) à ${degres(s.max.v)} (${quand(s.max.e)})${pres}.`);
        }
        l.push(`· Mesures reçues ${r.jours === m.jours ? `chaque jour du mois` : `${nombre(r.jours, 'jour', 'jours')} sur ${m.jours}`}.`);
      }
      const vues = ALERTES.filter(([k]) => r.alertes[k]).map(([k, un, plusieurs]) => nombre(r.alertes[k], un, plusieurs));
      if (vues.length) l.push(`· Alertes vues par le serveur : ${vues.join(', ')}.`);
      else if (zones.length) l.push('· Aucune alerte vue par le serveur.');
    }
    l.push('', 'Le carnet complet (courbes, consommation, journal du socle) se crée dans l\u2019application : Réglages, puis Exports.',
      '', 'Vous recevez ce message parce que le carnet par e-mail est activé sur votre compte. Pour ne plus le recevoir : Réglages, puis Exports, dans l\u2019application.',
      '', '— Terrariums', '');
    return { sujet: `Carnet ${deMois(m.index)} ${m.annee} · Terrariums`, texte: l.join('\n') };
  }

  // Un carnet, tout de suite (le 1er du mois, ou à l'activation).
  async envoyer(u, m) {
    if (!this.courriel) throw new Error('e-mail non configuré sur ce serveur');
    if (!u.email) throw new Error('compte sans adresse e-mail');
    const resumes = u.socles.map(id => this.resumeSocle(id, m));
    const { sujet, texte } = this.rediger(u, m, resumes);
    await this.courriel.envoyer({ a: u.email, sujet, texte });
  }

  // Appelé toutes les heures : le 1er à partir de 8 h (ou plus tard si le
  // serveur était arrêté), chaque abonné qui n'a pas reçu le mois écoulé.
  // Un échec est retenté à l'heure suivante, trois fois par mois au plus.
  async tourner(maintenant = Date.now()) {
    if (!this.courriel) return 0;
    const d = new Date(maintenant);
    if (d.getDate() === 1 && d.getHours() < HEURE_ENVOI) return 0;
    const m = moisCouvert(maintenant);
    let n = 0;
    for (const u of this.comptes.abonnesCarnet()) {
      if (u.carnet.dernier && u.carnet.dernier >= m.cle) continue;
      if (!u.socles.length) continue;
      const e = this.echecs.get(u.login);
      if (e && e.cle === m.cle && e.n >= ESSAIS_PAR_MOIS) continue;
      try {
        await this.envoyer(u, m);
        this.comptes.noterCarnetEnvoye(u.login, m.cle);
        this.echecs.delete(u.login);
        n++;
      } catch (err) {
        this.echecs.set(u.login, { cle: m.cle, n: (e && e.cle === m.cle ? e.n : 0) + 1 });
        this.journal(`carnet ${m.cle} non envoyé à ${masquer(u.email)} : ${err.message}`);
      }
    }
    if (n) this.journal(`carnet ${m.cle} envoyé à ${n} compte(s)`);
    return n;
  }
}

module.exports = { Carnets, moisCouvert, prochainEnvoi, deMois, MOIS };
