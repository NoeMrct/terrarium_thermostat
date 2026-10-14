#include "courant.h"
#include "stockage.h"
#include "reseau.h"
#include <Wire.h>
#include <math.h>

/* Le convertisseur mesure la tension aux bornes d'une résistance de shunt sur
   le 12 V des tapis. On lit directement le registre de tension de shunt
   (10 µV par pas) et on divise par la résistance : pas de calibration à
   écrire, pas de dépendance à une bibliothèque. */
namespace {

bool g_present = false;
float g_amperes = NAN, g_volts = NAN;
double g_wattheures = 0;
char g_anomalie[64] = "";

#if INA219_ACTIF
uint32_t g_derniereMesure = 0;
uint32_t g_debutAnomalie = 0;
bool g_alerteEmise = false;

bool lireRegistre(uint8_t reg, int16_t &valeur) {
  Wire.beginTransmission(INA219_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission() != 0) return false;
  if (Wire.requestFrom((int)INA219_ADDR, 2) != 2) return false;
  const uint8_t h = (uint8_t)Wire.read(), l = (uint8_t)Wire.read();
  valeur = (int16_t)((h << 8) | l);
  return true;
}

bool ecrireRegistre(uint8_t reg, uint16_t valeur) {
  Wire.beginTransmission(INA219_ADDR);
  Wire.write(reg);
  Wire.write((uint8_t)(valeur >> 8));
  Wire.write((uint8_t)(valeur & 0xFF));
  return Wire.endTransmission() == 0;
}

void signaler(const char *texte, uint8_t zone) {
  if (g_alerteEmise) return;
  g_alerteEmise = true;
  snprintf(g_anomalie, sizeof g_anomalie, "%s", texte);
  journal("Courant : %s (%.2f A mesures)", texte, (double)g_amperes);
  Reseau::alerter(NOTIF_DEFAUT, zone, String("Mesure de courant : ") + texte);
}
#endif

}  // namespace

namespace Courant {

void demarrer() {
#if INA219_ACTIF
  // Plage 32 V, gain /8 (±320 mV soit ±3,2 A avec 0,1 Ω), 12 bits, mesure continue.
  g_present = ecrireRegistre(0x00, 0x399F);
  journal(g_present ? "INA219 detecte : mesure de courant active"
                    : "INA219 absent : mesure de courant desactivee");
#endif
}

void boucle(uint32_t maintenant, uint8_t masqueAlimente) {
#if INA219_ACTIF
  if (!g_present || maintenant - g_derniereMesure < 1000) return;
  const float dtH = g_derniereMesure ? (maintenant - g_derniereMesure) / 3600000.0f : 0;
  g_derniereMesure = maintenant;
  int16_t shunt = 0, bus = 0;
  if (!lireRegistre(0x01, shunt) || !lireRegistre(0x02, bus)) {
    g_present = false;
    journal("INA219 : plus de reponse");
    return;
  }
  g_amperes = shunt * 0.00001f / INA219_SHUNT_OHM;
  g_volts = (bus >> 3) * 0.004f;
  if (g_amperes > 0 && g_volts > 0) g_wattheures += (double)(g_amperes * g_volts * dtH);

  // Diagnostic : ce qui devrait consommer consomme-t-il, et seulement lui ?
  const ReglagesGlobaux &g = Stockage::globaux();
  const float attendu = g.tensionV > 0 ? g.puissanceTapisW / g.tensionV : 1.6f;
  bool anormal = false;
  if (masqueAlimente == 0 && g_amperes > 0.3f) {
    if (!g_debutAnomalie)
      g_debutAnomalie = maintenant;
    else if (maintenant - g_debutAnomalie > 5000) {
      signaler("courant alors que tout est coupe : MOSFET passant ?", NB_ZONES);
    }
    anormal = true;
  } else if (masqueAlimente != 0 && g_amperes < attendu * 0.25f) {
    if (!g_debutAnomalie)
      g_debutAnomalie = maintenant;
    else if (maintenant - g_debutAnomalie > 15000) {
      uint8_t zone = NB_ZONES;
      for (uint8_t i = 0; i < NB_TAPIS; i++)
        if (masqueAlimente & (1u << i)) zone = ZONE_DE_TAPIS[i];
      signaler("tapis alimente mais sans consommation : fil coupe, bilame ouvert ou fusible", zone);
    }
    anormal = true;
  }
  if (!anormal) {
    if (g_alerteEmise) journal("Courant : consommation redevenue normale (%.2f A)", (double)g_amperes);
    g_debutAnomalie = 0;
    g_alerteEmise = false;
    g_anomalie[0] = '\0';
  }
#else
  (void)maintenant;
  (void)masqueAlimente;
#endif
}

// Lecture immédiate, pour le test usine : la boucle n'échantillonne qu'une fois
// par seconde, trop lent pour une impulsion de 400 ms sur un MOSFET.
float lireMaintenant() {
#if INA219_ACTIF
  int16_t shunt = 0;
  if (!g_present || !lireRegistre(0x01, shunt)) return NAN;
  return shunt * 0.00001f / INA219_SHUNT_OHM;
#else
  return NAN;
#endif
}

bool actif() { return g_present; }
float amperes() { return g_amperes; }
float volts() { return g_volts; }
double wattheures() { return g_wattheures; }
const char *anomalie() { return g_anomalie; }

}  // namespace Courant
