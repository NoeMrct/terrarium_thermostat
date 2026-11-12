#include "essai.h"
#include "sondes.h"
#include "stockage.h"

namespace {

int8_t g_zone = -1;
uint32_t g_debut = 0;
float g_ref[NB_ZONES];
char g_resultat[220] = "";

void terminer(const char *texte) {
  snprintf(g_resultat, sizeof g_resultat, "%s", texte);
  journal("Essai de chauffe : %s", g_resultat);
  g_zone = -1;
  ctrl.arreterForcage();
}

}  // namespace

namespace Essai {

bool lancer(uint8_t zone, char *message, size_t taille) {
  if (zone >= NB_ZONES) {
    snprintf(message, taille, "Zone invalide");
    return false;
  }
  if (g_zone >= 0) {
    snprintf(message, taille, "Essai deja en cours (zone %d)", g_zone + 1);
    return false;
  }
  if (Sondes::zoneEnIdentification() >= 0) {
    snprintf(message, taille, "Identification de sonde en cours : attendre qu'elle se termine");
    return false;
  }
  if (!isfinite(ctrl.zone[zone].temperature) || ctrl.zone[zone].defaut != DEF_AUCUN) {
    snprintf(message, taille,
             "Zone %u sans mesure valide ou en defaut : `scan`, `identifier %u`, puis `reset`", zone + 1,
             zone + 1);
    return false;
  }
  if (ctrl.zone[zone].temperature >= ctrl.consignePour(zone) + 1.0f) {
    snprintf(message, taille,
             "Zone %u deja au-dessus de sa consigne : essai inutile et risque, attendre qu'elle refroidisse",
             zone + 1);
    return false;
  }
  if (!ctrl.forcerChauffe(zone, millis(), ESSAI_MS)) {
    snprintf(message, taille, "Chauffe impossible maintenant (entretien, mise a jour ou defaut)");
    return false;
  }
  for (uint8_t k = 0; k < NB_ZONES; k++) g_ref[k] = ctrl.zone[k].temperature;
  g_zone = (int8_t)zone;
  g_debut = millis();
  g_resultat[0] = '\0';
  snprintf(
      message, taille,
      "Zone %u : chauffe seule a pleine puissance, verdict des que sa sonde gagne %.1f C (10 min au plus). "
      "Ne pas laisser sans surveillance.",
      zone + 1, (double)ESSAI_HAUSSE);
  journal("Essai de chauffe lance sur la zone %u (%.2f C)", zone + 1, (double)g_ref[zone]);
  return true;
}

void annuler() {
  if (g_zone < 0) return;
  char t[60];
  snprintf(t, sizeof t, "zone %d : essai arrete a la demande", g_zone + 1);
  terminer(t);
}

void suivre(uint32_t maintenant) {
  if (g_zone < 0) return;
  const uint8_t z = (uint8_t)g_zone;
  const ZoneEtat &s = ctrl.zone[z];
  const uint32_t secondes = (maintenant - g_debut) / 1000;
  char t[220];

  if (s.defaut != DEF_AUCUN) {
    snprintf(t, sizeof t, "zone %u : essai interrompu, la zone est passee en defaut %s", z + 1,
             nomDefaut(s.defaut));
    terminer(t);
    return;
  }
  const float propre = s.temperature - g_ref[z];
  float autre = 0.0f;
  int8_t laquelle = -1;
  for (uint8_t k = 0; k < NB_ZONES; k++) {
    if (k == z || !isfinite(ctrl.zone[k].temperature) || !isfinite(g_ref[k])) continue;
    const float h = ctrl.zone[k].temperature - g_ref[k];
    if (h > autre) {
      autre = h;
      laquelle = (int8_t)k;
    }
  }

  // Sécurité : l'essai pousse sans régulation, il s'arrête bien avant la coupure.
  if (s.temperature >= ctrl.consignePour(z) + 2.0f || s.temperature >= ctrl.cfg[z].tempMax - 3.0f) {
    snprintf(t, sizeof t, "zone %u : essai arrete, %.1f C atteints (consigne %.1f)", z + 1,
             (double)s.temperature, (double)ctrl.consignePour(z));
    terminer(t);
    return;
  }
  if (propre >= ESSAI_HAUSSE) {
    snprintf(t, sizeof t,
             "zone %u OK : sa sonde a pris %+.1f C en %lu min %02lu s%s. Tapis, MOSFET et sonde de cette "
             "zone sont "
             "bien associes.",
             z + 1, (double)propre, (unsigned long)(secondes / 60), (unsigned long)(secondes % 60),
             laquelle >= 0 && autre >= 0.2f ? ", l'autre un peu (meme terrarium ?)" : ", l'autre rien");
    terminer(t);
    return;
  }
  if (laquelle >= 0 && autre >= ESSAI_HAUSSE && propre < 0.2f) {
    snprintf(t, sizeof t,
             "zone %u : ECHEC, c'est la sonde de la zone %d qui monte (%+.1f C) et pas la sienne : sondes "
             "inversees. "
             "`identifier` puis `reset`.",
             z + 1, laquelle + 1, (double)autre);
    terminer(t);
    return;
  }
  if (secondes * 1000UL >= ESSAI_MS || ctrl.zoneForcee() < 0) {
    snprintf(t, sizeof t,
             "zone %u : ECHEC, %+.1f C en 10 min. Verifier le 12 V, le tapis, son bilame, le MOSFET (D%u), "
             "et que la "
             "sonde est bien sur la plaque.",
             z + 1, (double)propre, (unsigned)PIN_TAPIS[ctrl.tapisDeZone(z) >= 0 ? ctrl.tapisDeZone(z) : z]);
    terminer(t);
  }
}

int8_t zoneEnCours() { return g_zone; }

uint16_t restantS() {
  if (g_zone < 0) return 0;
  const uint32_t ecoule = (millis() - g_debut) / 1000UL;
  return ecoule >= ESSAI_MS / 1000 ? 0 : (uint16_t)(ESSAI_MS / 1000 - ecoule);
}

const char *dernierResultat() { return g_resultat; }

bool calibrer(char *message, size_t taille) {
  const ZoneEtat &ref = ctrl.zone[0];
  if (!isfinite(ref.brute) || ref.defaut == DEF_SONDE) {
    snprintf(message, taille, "Zone 1 sans mesure : elle sert de reference");
    return false;
  }
  String detail;
  for (uint8_t z = 1; z < NB_ZONES; z++) {
    const ZoneEtat &s = ctrl.zone[z];
    if (!isfinite(s.brute)) {
      snprintf(message, taille, "Zone %u sans mesure : rien n'a ete change", z + 1);
      return false;
    }
    if (fabsf(s.brute - ref.brute) > 2.0f) {
      snprintf(message, taille,
               "Ecart de %.2f C entre les sondes : sont-elles cote a cote depuis 5 min ? Rien n'a ete change",
               (double)(s.brute - ref.brute));
      return false;
    }
  }
  for (uint8_t z = 1; z < NB_ZONES; z++) {
    ReglagesZone c = ctrl.cfg[z];
    const float avant = c.offset;
    c.offset = ref.brute + ctrl.cfg[0].offset - ctrl.zone[z].brute;
    char erreur[100];
    if (!reglagesValides(c, erreur, sizeof erreur)) {
      snprintf(message, taille, "Refuse : %s", erreur);
      return false;
    }
    ctrl.cfg[z] = c;
    Stockage::sauverZone(z, c);
    detail += " zone " + String(z + 1) + " : " + String(avant, 2) + " -> " + String(c.offset, 2) + " C";
  }
  ctrl.oublierMesures();
  snprintf(message, taille, "Sondes alignees sur la zone 1 :%s", detail.c_str());
  journal("%s", message);
  return true;
}

}  // namespace Essai
