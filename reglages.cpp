#include "reglages.h"
#include "majauto.h"
#include <math.h>
#include <stdio.h>
#include <string.h>

namespace Stockage {

void reglagesGlobauxParDefaut(ReglagesGlobaux &g) {
  memset(&g, 0, sizeof g);
  g.courantAlimA = 3.0f;  // le petit adaptateur 12 V d'origine
  g.puissanceTapisW = 20.0f;
  g.tensionV = 12.0f;
  g.maintenanceMin = 10;
  g.ecranVeilleMin = 10;
  g.saisonActive = false;
  g.saisonDelta = 5.0f;
  g.saisonDescenteJ = 21;
  g.saisonPlateauJ = 60;
  g.saisonRemonteeJ = 21;
  g.rapportActif = false;
  g.rapportMinutes = 20 * 60;
  g.prixKwh = 0.0f;
  g.ledEteinte = false;
  g.ecranNuit = ECRAN_NUIT_ATTENUE;
  g.soleilActif = false;
  g.soleilDecalageMin = 0;
  g.latitude = 0.0f;
  g.longitude = 0.0f;
  g.zonePrioritaire = 0;
  g.majAutoCoupee = false;  // activées par défaut (CRA, annexe I)
  g.majPlageDebut = MajAuto::PLAGE_DEBUT_DEFAUT;
  g.majPlageFin = MajAuto::PLAGE_FIN_DEFAUT;
  g.vacancesDecalage = 0.0f;
  g.vacancesAlertes = true;
  g.prechauffage = false;
  g.saisonsActives = false;
  g.hiverDebut = 1201;  // 1er décembre
  g.hiverFin = 228;     // 28 février
  g.hiverDecalage = 2.0f;
  g.hiverRaccourciMin = 60;
  g.saisonTransitionJ = 14;
}

static const uint8_t JOURS_MOIS[12] = { 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };

bool dateMmjjValide(uint16_t mmjj) {
  const uint16_t m = mmjj / 100, j = mmjj % 100;
  return m >= 1 && m <= 12 && j >= 1 && j <= JOURS_MOIS[m - 1];
}

// Rang dans une année de 365 jours (le 29 février vaut le 28).
static int rangAnnee(uint8_t mois, uint8_t jour) {
  static const int16_t cumul[12] = { 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334 };
  if (mois < 1 || mois > 12) return 0;
  const int max = mois == 2 ? 28 : JOURS_MOIS[mois - 1];
  return cumul[mois - 1] + (jour < 1 ? 1 : (jour > max ? max : jour)) - 1;
}

bool vacancesEnCours(const ReglagesGlobaux &g, uint32_t maintenantEpoch) {
  return maintenantEpoch != 0 && g.vacancesFin > g.vacancesDebut && maintenantEpoch >= g.vacancesDebut &&
         maintenantEpoch < g.vacancesFin;
}

float facteurHiver(const ReglagesGlobaux &g, uint8_t mois, uint8_t jour) {
  if (!g.saisonsActives || !dateMmjjValide(g.hiverDebut) || !dateMmjjValide(g.hiverFin)) return 0.0f;
  const int a = rangAnnee((uint8_t)(g.hiverDebut / 100), (uint8_t)(g.hiverDebut % 100));
  const int b = rangAnnee((uint8_t)(g.hiverFin / 100), (uint8_t)(g.hiverFin % 100));
  const int x = rangAnnee(mois, jour);
  if ((x - a + 365) % 365 <= (b - a + 365) % 365) return 1.0f;  // plein hiver, sur l'anneau de l'année
  const int t = g.saisonTransitionJ;
  if (t == 0) return 0.0f;
  const int avant = (a - x + 365) % 365, apres = (x - b + 365) % 365;
  float f = 0.0f;
  if (avant <= t) f = 1.0f - (float)avant / (float)(t + 1);
  if (apres <= t && 1.0f - (float)apres / (float)(t + 1) > f) f = 1.0f - (float)apres / (float)(t + 1);
  return f;
}

bool globauxValides(const ReglagesGlobaux &g, char *erreur, size_t taille) {
#define ECHEC(msg)                             \
  do {                                         \
    if (erreur) snprintf(erreur, taille, msg); \
    return false;                              \
  } while (0)
  if (!(isfinite(g.courantAlimA) && g.courantAlimA >= 0.5f && g.courantAlimA <= 40.0f))
    ECHEC("Amperage de l'alimentation hors 0.5-40 A");
  if (!(isfinite(g.puissanceTapisW) && g.puissanceTapisW >= 1.0f && g.puissanceTapisW <= 200.0f))
    ECHEC("Puissance d'un tapis hors 1-200 W");
  if (!(isfinite(g.tensionV) && g.tensionV >= 3.0f && g.tensionV <= 60.0f)) ECHEC("Tension hors 3-60 V");
  if (g.maintenanceMin == 0 || g.maintenanceMin > 240) ECHEC("Duree d'entretien hors 1-240 min");
  if (g.ecranVeilleMin > 1440) ECHEC("Veille de l'ecran hors 0-1440 min");
  if (!(isfinite(g.saisonDelta) && g.saisonDelta >= 0.0f && g.saisonDelta <= 15.0f))
    ECHEC("Abaissement saisonnier hors 0-15 C");
  if (g.saisonDescenteJ > 365 || g.saisonPlateauJ > 365 || g.saisonRemonteeJ > 365)
    ECHEC("Duree de phase saisonniere hors 0-365 jours");
  if (g.saisonActive && g.saisonDescenteJ + g.saisonPlateauJ + g.saisonRemonteeJ == 0)
    ECHEC("Un cycle saisonnier doit durer au moins un jour");
  if (g.rapportMinutes > 1439) ECHEC("Heure du rapport invalide");
  if (!(isfinite(g.prixKwh) && g.prixKwh >= 0.0f && g.prixKwh <= 5.0f)) ECHEC("Prix du kWh hors 0-5 EUR");
  if (g.ecranNuit > ECRAN_NUIT_ETEINT) ECHEC("Mode nuit de l'ecran inconnu");
  if (g.soleilDecalageMin < -180 || g.soleilDecalageMin > 180) ECHEC("Decalage solaire hors -180..180 min");
  // Au-delà des cercles polaires, le soleil peut ne pas se lever ou ne pas se
  // coucher de la journée : les horaires fixes conviennent mieux.
  if (!(isfinite(g.latitude) && g.latitude >= -65.0f && g.latitude <= 65.0f)) ECHEC("Latitude hors -65..65");
  if (!(isfinite(g.longitude) && g.longitude >= -180.0f && g.longitude <= 180.0f))
    ECHEC("Longitude hors -180..180");
  if (g.soleilActif && g.latitude == 0.0f && g.longitude == 0.0f)
    ECHEC("Position inconnue : renseigner latitude et longitude");
  if (g.zonePrioritaire > NB_ZONES) ECHEC("Zone prioritaire inconnue");
  if (g.majPlageDebut > 1439 || g.majPlageFin > 1439) ECHEC("Plage de mise a jour : heures de 00:00 a 23:59");
  if (g.majPlageDebut == g.majPlageFin && g.majPlageDebut != 0)
    ECHEC("Plage de mise a jour vide : debut et fin identiques");
  if (g.vacancesDebut || g.vacancesFin) {
    if (g.vacancesFin <= g.vacancesDebut) ECHEC("Vacances : le retour doit suivre le depart");
    if (g.vacancesFin - g.vacancesDebut > 366UL * 86400UL) ECHEC("Vacances : un an au plus");
  }
  if (!(isfinite(g.vacancesDecalage) && g.vacancesDecalage >= -10.0f && g.vacancesDecalage <= 0.0f))
    ECHEC("Vacances : consignes abaissees de 0 a 10 C");
  if (!dateMmjjValide(g.hiverDebut) || !dateMmjjValide(g.hiverFin)) ECHEC("Hiver : dates invalides (MMJJ)");
  if (g.hiverDebut == g.hiverFin) ECHEC("Hiver : debut et fin identiques");
  if (!(isfinite(g.hiverDecalage) && g.hiverDecalage >= 0.0f && g.hiverDecalage <= 10.0f))
    ECHEC("Hiver : consignes abaissees de 0 a 10 C");
  if (g.hiverRaccourciMin > 240) ECHEC("Hiver : journee raccourcie de 4 h au plus");
  if (g.saisonTransitionJ > 60) ECHEC("Saisons : passage de 0 a 60 jours");
#undef ECHEC
  return true;
}

bool assainirGlobaux(ReglagesGlobaux &g) {
  ReglagesGlobaux d;
  reglagesGlobauxParDefaut(d);
  bool corrige = false;
#define REPARE(champ, cond) \
  if (!(cond)) {            \
    g.champ = d.champ;      \
    corrige = true;         \
  }
  REPARE(courantAlimA, isfinite(g.courantAlimA) && g.courantAlimA >= 0.5f && g.courantAlimA <= 40.0f)
  REPARE(puissanceTapisW,
         isfinite(g.puissanceTapisW) && g.puissanceTapisW >= 1.0f && g.puissanceTapisW <= 200.0f)
  REPARE(tensionV, isfinite(g.tensionV) && g.tensionV >= 3.0f && g.tensionV <= 60.0f)
  REPARE(maintenanceMin, g.maintenanceMin >= 1 && g.maintenanceMin <= 240)
  REPARE(ecranVeilleMin, g.ecranVeilleMin <= 1440)
  REPARE(saisonDelta, isfinite(g.saisonDelta) && g.saisonDelta >= 0.0f && g.saisonDelta <= 15.0f)
  REPARE(saisonDescenteJ, g.saisonDescenteJ <= 365)
  REPARE(saisonPlateauJ, g.saisonPlateauJ <= 365)
  REPARE(saisonRemonteeJ, g.saisonRemonteeJ <= 365)
  REPARE(rapportMinutes, g.rapportMinutes <= 1439)
  REPARE(prixKwh, isfinite(g.prixKwh) && g.prixKwh >= 0.0f && g.prixKwh <= 5.0f)
  REPARE(ecranNuit, g.ecranNuit <= ECRAN_NUIT_ETEINT)
  REPARE(soleilDecalageMin, g.soleilDecalageMin >= -180 && g.soleilDecalageMin <= 180)
  REPARE(latitude, isfinite(g.latitude) && g.latitude >= -65.0f && g.latitude <= 65.0f)
  REPARE(longitude, isfinite(g.longitude) && g.longitude >= -180.0f && g.longitude <= 180.0f)
  REPARE(zonePrioritaire, g.zonePrioritaire <= NB_ZONES)
  if (g.majPlageDebut > 1439 || g.majPlageFin > 1439 ||
      (g.majPlageDebut == g.majPlageFin && g.majPlageDebut)) {
    g.majPlageDebut = d.majPlageDebut;  // plage abîmée : celle par défaut
    g.majPlageFin = d.majPlageFin;
    corrige = true;
  }
  REPARE(vacancesDecalage,
         isfinite(g.vacancesDecalage) && g.vacancesDecalage >= -10.0f && g.vacancesDecalage <= 0.0f)
  REPARE(hiverDecalage, isfinite(g.hiverDecalage) && g.hiverDecalage >= 0.0f && g.hiverDecalage <= 10.0f)
  REPARE(hiverRaccourciMin, g.hiverRaccourciMin <= 240)
  REPARE(saisonTransitionJ, g.saisonTransitionJ <= 60)
#undef REPARE
  // Mémoire d'avant les saisons du calendrier (3.4, début de la 3.5) : leurs
  // réglages par défaut, sans parler de correction — rien n'était abîmé.
  if (g.hiverDebut == 0 && g.hiverFin == 0) {
    g.hiverDebut = d.hiverDebut;
    g.hiverFin = d.hiverFin;
    g.hiverDecalage = d.hiverDecalage;
    g.hiverRaccourciMin = d.hiverRaccourciMin;
    g.saisonTransitionJ = d.saisonTransitionJ;
    g.vacancesAlertes = d.vacancesAlertes;
  } else if (!dateMmjjValide(g.hiverDebut) || !dateMmjjValide(g.hiverFin) || g.hiverDebut == g.hiverFin) {
    g.hiverDebut = d.hiverDebut;
    g.hiverFin = d.hiverFin;
    g.saisonsActives = false;
    corrige = true;
  }
  if ((g.vacancesDebut || g.vacancesFin) &&
      (g.vacancesFin <= g.vacancesDebut || g.vacancesFin - g.vacancesDebut > 366UL * 86400UL)) {
    g.vacancesDebut = g.vacancesFin = 0;  // dates abîmées : pas de vacances
    corrige = true;
  }
  if (g.soleilActif && g.latitude == 0.0f && g.longitude == 0.0f) {
    g.soleilActif = false;  // position perdue : retour aux horaires fixes
    corrige = true;
  }
  if (g.saisonActive &&
      (g.saisonDebutEpoch < 1700000000UL || g.saisonDescenteJ + g.saisonPlateauJ + g.saisonRemonteeJ == 0)) {
    g.saisonActive = false;  // cycle indatable : on ne l'applique pas
    corrige = true;
  }
  return corrige;
}

// Combien de zones peuvent chauffer en même temps sans dépasser l'ampérage
// déclaré. Un tapis de 20 W sous 12 V tire 1,7 A : une alimentation de 3 A n'en
// supporte qu'un, une de 5 A en supporte deux.
uint8_t zonesSimultanees(const ReglagesGlobaux &g) {
  const float parTapis = (g.tensionV > 1.0f) ? g.puissanceTapisW / g.tensionV : 1.7f;
  if (parTapis <= 0.01f) return 1;
  // Marge de 20 % : une alimentation annoncée pour 5 A ne les tient pas
  // forcément en continu, et l'électronique consomme aussi.
  int n = (int)((g.courantAlimA * 0.8f) / parTapis);
  if (n < 1) n = 1;
  if (n > NB_ZONES) n = NB_ZONES;
  return (uint8_t)n;
}

float decalageSaisonnier(const ReglagesGlobaux &g, uint32_t maintenantEpoch) {
  if (!g.saisonActive || g.saisonDebutEpoch == 0 || maintenantEpoch < g.saisonDebutEpoch) return 0.0f;
  const uint32_t jours = (maintenantEpoch - g.saisonDebutEpoch) / 86400UL;
  const uint32_t d = g.saisonDescenteJ, p = g.saisonPlateauJ, r = g.saisonRemonteeJ;
  if (d > 0 && jours < d) return -g.saisonDelta * ((float)jours / d);
  if (jours < d + p) return -g.saisonDelta;
  if (r > 0 && jours < d + p + r) return -g.saisonDelta * (1.0f - (float)(jours - d - p) / r);
  return 0.0f;  // cycle terminé
}

void plageMaj(const ReglagesGlobaux &g, uint16_t &debut, uint16_t &fin) {
  debut = g.majPlageDebut;
  fin = g.majPlageFin;
  if (debut == fin) {  // 0 et 0 : mémoire d'avant la plage réglable
    debut = MajAuto::PLAGE_DEBUT_DEFAUT;
    fin = MajAuto::PLAGE_FIN_DEFAUT;
  }
}

void genererMotDePasseAp(char *dest, size_t taille, uint32_t (*alea)()) {
  static const char alphabet[] = "abcdefghjkmnpqrstuvwxyz23456789";  // sans i, l, o, 0, 1
  if (!dest || taille == 0) return;
  size_t n = taille - 1;
  if (n > LONGUEUR_MDP_AP) n = LONGUEUR_MDP_AP;
  for (size_t i = 0; i < n; i++) dest[i] = alphabet[alea() % (sizeof(alphabet) - 1)];
  dest[n] = '\0';
}

bool motDePasseApARenouveler(const char *mdp) {
  // Le mot de passe commun des firmwares jusqu'à la 3.5 : public, donc à remplacer.
  return !mdp || strlen(mdp) < 8 || strcmp(mdp, "terrarium1234") == 0;
}

size_t relireTolerant(const uint8_t *source, size_t disponible, void *dest, size_t taille) {
  memset(dest, 0, taille);
  if (!source || disponible == 0) return 0;
  if (disponible <= taille) {  // écrite par cette version ou une plus ancienne
    memcpy(dest, source, disponible);
    return disponible;
  }
  memcpy(dest, source, taille);  // plus récente : on garde le préfixe connu
  return taille;
}

}  // namespace Stockage

const char *nomEtapeMaj(uint8_t etape) {
  switch (etape) {
    case MAJ_EN_VALIDATION: return "en validation";
    case MAJ_VALIDEE: return "validee";
    case MAJ_RETOUR_ARRIERE: return "retour arriere";
    case MAJ_ECHEC: return "echec";
    default: return "aucune";
  }
}
