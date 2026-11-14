#include "reglages.h"
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
#undef REPARE
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
