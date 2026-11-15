'use strict';
/* =============================================================================
   Plages horaires (F5), vacances (F6), préchauffage (F7) et hiver du
   calendrier (F9), tels que le firmware les calcule (controle.cpp,
   reglages.cpp) : pour le socle simulé (socle-simule.js) et la démonstration
   (construire-demo.js, qui recopie cette fonction dans la page par
   toString()). D'où une fonction autonome, sans rien autour, qui rend ses
   outils.
   ============================================================================= */
function programmeSocle() {
  const NB_PLAGES = 4, ECART = 15, AVANCE_MAX = 180;
  const ecart = (de, vers) => (((vers - de) % 1440) + 1440) % 1440;
  const borne = (v, a, b) => Math.min(b, Math.max(a, v));
  const octets = s => new TextEncoder().encode(s).length;

  // Deux plages tirées du jour et de la nuit des zones (programmeParDefaut).
  function parDefaut(zones) {
    const jeu = () => {
      const jour = { debut: zones[0].debutJour, nom: 'Jour', consignes: zones.map(z => z.consigneJour) };
      const nuit = { debut: zones[0].debutNuit, nom: 'Nuit', consignes: zones.map(z => z.consigneNuit) };
      return zones[0].debutJour < zones[0].debutNuit ? [jour, nuit] : [nuit, jour];
    };
    return { actif: false, weekend: false, semaine: jeu(), weekEnd: jeu() };
  }

  // Un nom coupé à 17 octets, jamais au milieu d'un caractère (copierUtf8).
  function couperNom(s) {
    let r = '';
    for (const c of String(s || '')) { if (octets(r + c) > 17) break; r += c; }
    return r;
  }

  // Relit une requête « programme » par-dessus p (remplirProgramme) ; jette
  // une erreur au texte du firmware.
  function remplir(p, d) {
    const n = JSON.parse(JSON.stringify(p));
    let ecriture = false;
    if (typeof d.actif === 'boolean') { n.actif = d.actif; ecriture = true; }
    if (typeof d.weekend === 'boolean') { n.weekend = d.weekend; ecriture = true; }
    for (const cle of ['semaine', 'weekEnd']) {
      if (d[cle] === undefined || d[cle] === null) continue;
      const l = d[cle];
      if (!Array.isArray(l) || l.length < 1 || l.length > NB_PLAGES) throw new Error('Plages : de 1 a 4 par jour');
      n[cle] = l.map((q, k) => {
        if (!q || typeof q !== 'object') throw new Error('Plages : liste illisible');
        if (!Number.isInteger(q.debut)) throw new Error(`Plage ${k + 1} : debut attendu, en minutes`);
        if (!Array.isArray(q.consignes) || q.consignes.length !== 2) throw new Error(`Plage ${k + 1} : une consigne par zone`);
        return { debut: q.debut < 0 || q.debut > 1439 ? 1440 : q.debut, nom: couperNom(q.nom),
          consignes: q.consignes.map(c => (typeof c === 'number' ? c : NaN)) };
      });
      ecriture = true;
    }
    return { programme: n, ecriture };
  }

  // programmeValide()
  function valider(p, zones) {
    for (const cle of ['semaine', 'weekEnd']) {
      const l = p[cle];
      if (!Array.isArray(l) || l.length < 1 || l.length > NB_PLAGES) throw new Error('Plages : de 1 a 4 par jour');
      l.forEach((q, k) => {
        if (!(q.debut >= 0 && q.debut <= 1439)) throw new Error(`Plage ${k + 1} : heure invalide`);
        if (k > 0 && q.debut < l[k - 1].debut + ECART) throw new Error("Plages : debuts croissants, 15 min d'ecart au moins");
        if (k === l.length - 1 && l.length > 1 && l[0].debut + 1440 < q.debut + ECART)
          throw new Error('Plages : la derniere doit finir 15 min avant la premiere du lendemain');
        q.consignes.forEach((c, z) => {
          if (!(c >= 10 && c <= 45)) throw new Error(`Plage ${k + 1}, zone ${z + 1} : consigne hors 10-45 C`);
          if (!(c < zones[z].tempMax)) throw new Error(`Plage ${k + 1}, zone ${z + 1} : consigne au-dessus de la coupure`);
        });
      });
    }
  }

  // La plus fraîche des plages d'un jeu : la nuit (-1 si une seule, ou toutes égales).
  function nuitDe(l) {
    if (l.length < 2) return -1;
    const v = l.map(q => q.consignes.reduce((a, b) => a + b, 0));
    const mini = Math.min(...v);
    return Math.max(...v) > mini ? v.indexOf(mini) : -1;
  }

  // debutPlage() : la nuit plus tôt, la plage qui la suit plus tard (hiver).
  function debutPlage(l, k, raccourci) {
    const n = l.length, d = l[k].debut, nuit = nuitDe(l);
    if (!raccourci || nuit < 0 || n < 2) return d;
    const matin = (nuit + 1) % n, demi = Math.floor(raccourci / 2);
    const marge = e => Math.min(demi, Math.floor((e > ECART ? e - ECART : 0) / (n === 2 ? 2 : 1)));
    if (k === nuit) return (d + 1440 - marge(ecart(l[(k + n - 1) % n].debut, d))) % 1440;
    if (k === matin) return (d + marge(ecart(d, l[(k + 1) % n].debut))) % 1440;
    return d;
  }

  // Où en est le programme d'une zone (Controleur::moment) : null sans heure.
  // o : { minutes, jourSemaine (0 = dimanche), raccourci }
  function moment(p, zones, z, o) {
    if (o.minutes === null || o.minutes === undefined) return null;
    const m = ((o.minutes % 1440) + 1440) % 1440, r = o.raccourci || 0;
    if (!p || !p.actif) {
      let dJ = zones[z].debutJour, dN = zones[z].debutNuit;
      if (r) {
        const jour = ecart(dJ, dN), possible = jour > 60 ? jour - 60 : 0, rr = Math.min(r, possible);
        dJ = (dJ + Math.floor(rr / 2)) % 1440;
        dN = (dN + 1440 - (rr - Math.floor(rr / 2))) % 1440;
      }
      const depuisJour = ecart(dJ, m), jour = depuisJour < ecart(dJ, dN), c = zones[z];
      return { actuelle: jour ? c.consigneJour : c.consigneNuit, avant: jour ? c.consigneNuit : c.consigneJour,
        suivante: jour ? c.consigneNuit : c.consigneJour, depuis: jour ? depuisJour : ecart(dN, m),
        dans: ecart(m, jour ? dN : dJ), nuit: !jour, nom: null };
    }
    const jeu = j => (p.weekend && (j === 0 || j === 6) ? p.weekEnd : p.semaine);
    const triees = l => {
      const nuit = nuitDe(l);
      return l.map((q, k) => ({ debut: debutPlage(l, k, r), consigne: q.consignes[z], nuit: k === nuit, nom: q.nom }))
        .sort((a, b) => a.debut - b.debut);
    };
    const j = ((o.jourSemaine % 7) + 7) % 7;
    const segs = [
      ...triees(jeu((j + 6) % 7)).map(s => ({ ...s, debut: s.debut - 1440 })),
      ...triees(jeu(j)),
      { ...triees(jeu((j + 1) % 7))[0], debut: triees(jeu((j + 1) % 7))[0].debut + 1440 }
    ];
    let i = 0;
    while (i + 1 < segs.length && segs[i + 1].debut <= m) i++;
    const s = segs[i], avant = segs[i > 0 ? i - 1 : i], suiv = segs[i + 1] || s;
    return { actuelle: s.consigne, avant: avant.consigne, suivante: suiv.consigne, depuis: m - s.debut,
      dans: segs[i + 1] ? suiv.debut - m : 0, nuit: s.nuit, nom: s.nom };
  }

  // Consigne de la zone (consigneCalculee) : rampe, préchauffage, décalage.
  // o : { minutes, jourSemaine, raccourci, decalage, prechauffage, vitesse (°C/h) }
  function consigne(p, zones, z, o) {
    const c = zones[z], mo = moment(p, zones, z, o), decalage = o.decalage || 0;
    if (!mo) return borne(c.consigneJour + decalage, 10, 45);
    let base = mo.actuelle;
    const hausse = mo.actuelle > mo.avant;
    if (c.rampe > 0 && mo.depuis < c.rampe && !(o.prechauffage && hausse))
      base = mo.avant + (mo.actuelle - mo.avant) * (mo.depuis / c.rampe);
    if (o.prechauffage && mo.suivante > mo.actuelle && mo.dans <= avance(mo.suivante - mo.actuelle, o.vitesse))
      base = mo.suivante;
    return borne(base + decalage, 10, 45);
  }

  function avance(hausse, vitesse) {
    if (!(hausse > 0)) return 0;
    const minutes = (1.2 * hausse) / borne(vitesse || 4, 0.5, 30) * 60;
    return minutes >= AVANCE_MAX ? AVANCE_MAX : Math.round(minutes);
  }

  // Hiver du calendrier (facteurHiver) et vacances (vacancesEnCours).
  const JOURS_MOIS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const dateValide = mmjj => { const m = Math.floor(mmjj / 100), j = mmjj % 100; return m >= 1 && m <= 12 && j >= 1 && j <= JOURS_MOIS[m - 1]; };
  const rang = (mois, jour) => {
    const cumul = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    const max = mois === 2 ? 28 : JOURS_MOIS[mois - 1];
    return cumul[mois - 1] + Math.min(max, Math.max(1, jour)) - 1;
  };
  function facteurHiver(g, mois, jour) {
    if (!g.saisonsActives || !dateValide(g.hiverDebut) || !dateValide(g.hiverFin)) return 0;
    const a = rang(Math.floor(g.hiverDebut / 100), g.hiverDebut % 100), b = rang(Math.floor(g.hiverFin / 100), g.hiverFin % 100);
    const x = rang(mois, jour);
    if ((x - a + 365) % 365 <= (b - a + 365) % 365) return 1;
    const t = g.saisonTransitionJ;
    if (!t) return 0;
    const av = (a - x + 365) % 365, ap = (x - b + 365) % 365;
    let f = 0;
    if (av <= t) f = 1 - av / (t + 1);
    if (ap <= t) f = Math.max(f, 1 - ap / (t + 1));
    return f;
  }
  const vacancesEnCours = (g, epoch) => epoch > 0 && g.vacancesFin > g.vacancesDebut && epoch >= g.vacancesDebut && epoch < g.vacancesFin;

  // Les bornes des nouveaux réglages globaux (globauxValides).
  function validerGlobaux(g) {
    const e = m => { throw new Error(m); };
    if (g.vacancesDebut || g.vacancesFin) {
      if (!(g.vacancesFin > g.vacancesDebut)) e('Vacances : le retour doit suivre le depart');
      if (g.vacancesFin - g.vacancesDebut > 366 * 86400) e('Vacances : un an au plus');
    }
    if (!(g.vacancesDecalage >= -10 && g.vacancesDecalage <= 0)) e('Vacances : consignes abaissees de 0 a 10 C');
    if (!dateValide(g.hiverDebut) || !dateValide(g.hiverFin)) e('Hiver : dates invalides (MMJJ)');
    if (g.hiverDebut === g.hiverFin) e('Hiver : debut et fin identiques');
    if (!(g.hiverDecalage >= 0 && g.hiverDecalage <= 10)) e('Hiver : consignes abaissees de 0 a 10 C');
    if (!(g.hiverRaccourciMin >= 0 && g.hiverRaccourciMin <= 240)) e('Hiver : journee raccourcie de 4 h au plus');
    if (!(g.saisonTransitionJ >= 0 && g.saisonTransitionJ <= 60)) e('Saisons : passage de 0 a 60 jours');
  }

  // Ce que le socle ajoute à l'état d'une zone (champsMoment dans reseau.cpp).
  function champsEtat(p, zones, z, o, vacances) {
    const mo = moment(p, zones, z, o), r = {};
    if (mo) {
      r.suivante = +borne(mo.suivante + (o.decalage || 0), 10, 45).toFixed(1);
      r.suivanteA = (o.minutes + mo.dans) % 1440;
      r.periode = mo.nuit ? 'nuit' : 'jour';
      if (mo.nom !== null) r.plage = mo.nom;
    }
    if (vacances) r.vacances = '1';
    return r;
  }

  const DEFAUTS_GLOBAUX = { vacancesDebut: 0, vacancesFin: 0, vacancesDecalage: 0, vacancesAlertes: true, prechauffage: false,
    saisonsActives: false, hiverDebut: 1201, hiverFin: 228, hiverDecalage: 2, hiverRaccourciMin: 60, saisonTransitionJ: 14 };

  return { parDefaut, remplir, valider, moment, consigne, avance, facteurHiver, vacancesEnCours, validerGlobaux, champsEtat,
    DEFAUTS_GLOBAUX };
}

if (typeof module !== 'undefined') module.exports = programmeSocle;
