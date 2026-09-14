#include "anneau.h"

uint32_t anneauRupture(uint32_t capacite, LecteurSeq lire, void *contexte) {
  if (capacite == 0 || lire == 0) return 0;
  if (capacite == 1) return 0;

  uint32_t premiere = 0, derniere = 0;
  if (!lire(0, premiere, contexte)) return 0;
  if (!lire(capacite - 1, derniere, contexte)) return 0;

  // Suite encore croissante d'un bout à l'autre : le plus ancien est en tête,
  // l'anneau n'a pas encore fait le tour.
  if (premiere < derniere) return 0;

  // Tableau trié puis pivoté : tout ce qui précède la rupture est supérieur au
  // dernier élément, tout ce qui la suit lui est inférieur ou égal. La borne est
  // donc fixe, inutile de relire la fin à chaque itération.
  const uint32_t borne = derniere;
  uint32_t lo = 0, hi = capacite - 1;
  while (lo < hi) {
    const uint32_t mid = lo + (hi - lo) / 2;
    uint32_t s = 0;
    if (!lire(mid, s, contexte)) return 0;
    if (s > borne) lo = mid + 1;
    else           hi = mid;
  }
  return lo;
}

void anneauReconstruire(Anneau &a, uint32_t capacite, uint32_t enregistres,
                        LecteurSeq lire, void *contexte) {
  a.capacite = capacite;
  if (capacite == 0) { a.index = 0; a.remplis = 0; a.seq = 1; return; }
  if (enregistres > capacite) enregistres = capacite;

  if (enregistres < capacite) {
    // Anneau pas encore rempli : l'écriture est restée linéaire.
    a.index   = enregistres;
    a.remplis = enregistres;
  } else {
    a.index   = anneauRupture(capacite, lire, contexte);
    a.remplis = capacite;
  }

  uint32_t derniere = 0;
  if (a.remplis > 0 && lire)
    lire((a.index + capacite - 1) % capacite, derniere, contexte);
  a.seq = derniere + 1;
}

uint32_t anneauEmplacementEcriture(const Anneau &a) {
  return (a.capacite == 0) ? 0 : (a.index % a.capacite);
}

void anneauAvancer(Anneau &a) {
  if (a.capacite == 0) return;
  a.seq++;
  a.index = (a.index + 1) % a.capacite;
  if (a.remplis < a.capacite) a.remplis++;
}

bool anneauEmplacementDuRang(const Anneau &a, uint32_t rang, uint32_t &emplacement) {
  if (a.capacite == 0 || rang >= a.remplis) return false;
  const uint32_t debut = (a.index + a.capacite - a.remplis) % a.capacite;
  emplacement = (debut + rang) % a.capacite;
  return true;
}

void anneauVider(Anneau &a) {
  a.index = 0;
  a.remplis = 0;
  a.seq = 1;
}
