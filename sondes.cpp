#include "sondes.h"
#include "liaisons.h"
#include "format.h"
#include "stockage.h"
#include <OneWire.h>
#include <DallasTemperature.h>

namespace {

OneWire oneWire(PIN_ONEWIRE);
DallasTemperature bus(&oneWire);

using Liaisons::MAX_SONDES;

DeviceAddress g_liee[NB_ZONES];
bool g_liaisonValide[NB_ZONES] = { false, false };
uint32_t g_debutConversion = 0;
bool g_enCours = false;

// Sondes vues au dernier balayage : getAddress() refait une recherche complète
// sur le bus à chaque appel, la liste est donc gardée ici.
uint8_t g_presentes[MAX_SONDES][8];
uint8_t g_nb = 0;
uint32_t g_dernierBalayage = 0;
const uint32_t BALAYAGE_AUTO_MS = 300000;  // 5 min, seulement s'il manque quelque chose

// Un message par situation, pas un par mesure (toutes les 2 s).
bool g_signaleNonLiee[NB_ZONES] = { false, false };
bool g_signaleMuette[NB_ZONES] = { false, false };
bool g_zoneSansMesure[NB_ZONES] = { false, false };

// Identification en cours
int8_t g_identZone = -1;
uint32_t g_identDebut = 0;
float g_identAvant[MAX_SONDES];
bool g_identSuspend = false;  // c'est l'identification qui a suspendu la chauffe
char g_identResultat[220] = "";

String romTexte(const uint8_t *r) {
  char b[20];
  Liaisons::romTexte(r, b, sizeof b);
  return String(b);
}

// Valeur exploitable d'une conversion, NAN sinon (muette, CRC, 85 °C de reset).
float valeur(const uint8_t *rom) {
  const float t = bus.getTempC(rom);
  if (t == DEVICE_DISCONNECTED_C || fabsf(t - VALEUR_RESET_DS18B20) < 0.01f) return NAN;
  return t;
}

uint8_t (&liees())[NB_ZONES][8] { return Stockage::reseau().sondeRom; }

void enumerer() {
  bus.begin();
  g_nb = 0;
  const uint8_t n = bus.getDeviceCount();
  DeviceAddress a;
  for (uint8_t i = 0; i < n && g_nb < MAX_SONDES; i++)
    if (bus.getAddress(a, i)) memcpy(g_presentes[g_nb++], a, 8);
  g_dernierBalayage = millis();
}

bool presente(const uint8_t *rom) {
  for (uint8_t i = 0; i < g_nb; i++)
    if (Liaisons::memeRom(g_presentes[i], rom)) return true;
  return false;
}

// Liaisons automatiques sans ambiguïté (voir liaisons.h), journalisées.
void lierAutomatiquement(const char *contexte) {
  const uint8_t nouvelles = Liaisons::lierAutomatiquement(liees(), g_presentes, g_nb);
  if (!nouvelles) return;
  Stockage::sauverReseau();
  Sondes::rechargerLiaisons();
  for (uint8_t z = 0; z < NB_ZONES; z++)
    if (nouvelles & (1u << z))
      journal("Sonde %s liee automatiquement a la zone %u (%s) : verifiez avec `identifier %u`",
              romTexte(liees()[z]).c_str(), z + 1, contexte, z + 1);
}

void terminerIdentification() {
  g_identZone = -1;
  if (g_identSuspend && !otaEnCours) ctrl.suspendre(false);
  g_identSuspend = false;
  // La sonde chauffée dans la main va redescendre : ce n'est ni une chute
  // brutale, ni une inversion.
  ctrl.oublierMesures();
}

}  // namespace

namespace Sondes {

void rechargerLiaisons() {
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    memcpy(g_liee[z], liees()[z], 8);
    g_liaisonValide[z] = !Liaisons::romNulle(liees()[z]);
    if (g_liaisonValide[z]) g_signaleNonLiee[z] = false;
    g_signaleMuette[z] = false;
  }
}

void demarrer() {
  bus.setWaitForConversion(false);
  enumerer();
  bus.setResolution(12);
  rechargerLiaisons();
  journal("Bus 1-Wire : %u sonde(s) detectee(s)", g_nb);
  lierAutomatiquement("demarrage");
  for (uint8_t z = 0; z < NB_ZONES; z++)
    if (g_liaisonValide[z] && !presente(g_liee[z]))
      journal("Zone %u : sa sonde %s ne repond pas", z + 1, romTexte(g_liee[z]).c_str());
}

void rescanner() {
  uint8_t avant[MAX_SONDES][8];
  const uint8_t nAvant = g_nb;
  memcpy(avant, g_presentes, sizeof avant);
  enumerer();
  bus.setResolution(12);  // une sonde neuve est déjà en 12 bits, mais rien ne le garantit
  for (uint8_t i = 0; i < g_nb; i++) {
    bool connue = false;
    for (uint8_t k = 0; k < nAvant && !connue; k++) connue = Liaisons::memeRom(avant[k], g_presentes[i]);
    if (!connue) journal("Nouvelle sonde sur le bus : %s", romTexte(g_presentes[i]).c_str());
  }
  for (uint8_t k = 0; k < nAvant; k++)
    if (!presente(avant[k])) {
      const int8_t z = Liaisons::zoneDe(liees(), avant[k]);
      if (z >= 0)
        journal("Sonde %s disparue du bus (zone %d)", romTexte(avant[k]).c_str(), z + 1);
      else
        journal("Sonde %s disparue du bus", romTexte(avant[k]).c_str());
    }
  lierAutomatiquement("balayage");
}

void demanderConversion() {
  bus.requestTemperatures();
  g_debutConversion = millis();
  g_enCours = true;
}

bool conversionPrete(uint32_t maintenant) {
  if (!g_enCours) return false;
  if (maintenant - g_debutConversion < CONVERSION_MS) return false;
  g_enCours = false;
  return true;
}

float lire(uint8_t zone) {
  if (zone >= NB_ZONES) return DEVICE_DISCONNECTED_C;
  if (!g_liaisonValide[zone]) {
    // Plus de repli sur « la n-ième sonde du bus » : avec deux sondes, c'était
    // parfois celle de l'autre zone, et le tapis chauffait sans rien mesurer.
    if (!g_signaleNonLiee[zone]) {
      g_signaleNonLiee[zone] = true;
      journal("Zone %u : aucune sonde liee (`scan`, puis `identifier %u` ou `lier <index> %u`)", zone + 1,
              zone + 1, zone + 1);
    }
    g_zoneSansMesure[zone] = true;
    return DEVICE_DISCONNECTED_C;
  }
  // getTempC vérifie déjà la présence et le CRC, et renvoie
  // DEVICE_DISCONNECTED_C en cas de problème : un isConnected() préalable
  // relirait les neuf octets du scratchpad pour rien.
  const float t = bus.getTempC(g_liee[zone]);
  if (t == DEVICE_DISCONNECTED_C) {
    if (!g_signaleMuette[zone]) {
      g_signaleMuette[zone] = true;
      journal("Zone %u : sa sonde %s ne repond plus (cable, bornier ou sonde)", zone + 1,
              romTexte(g_liee[zone]).c_str());
    }
    g_zoneSansMesure[zone] = true;
  } else {
    if (g_signaleMuette[zone]) journal("Zone %u : sa sonde repond de nouveau", zone + 1);
    g_signaleMuette[zone] = false;
    g_zoneSansMesure[zone] = false;
  }
  return t;
}

void suivre(uint32_t maintenant) {
  // --- identification ------------------------------------------------------
  if (g_identZone >= 0) {
    float apres[MAX_SONDES];
    for (uint8_t i = 0; i < g_nb; i++) apres[i] = valeur(g_presentes[i]);
    const int8_t i = Liaisons::sondeManipulee(g_identAvant, apres, g_nb);
    const uint8_t z = (uint8_t)g_identZone;
    if (i >= 0) {
      char message[120];
      lierRom(g_presentes[i], z, message, sizeof message);
      snprintf(g_identResultat, sizeof g_identResultat, "Zone %u : sonde %s identifiee (%+.1f C). %s", z + 1,
               romTexte(g_presentes[i]).c_str(), (double)(apres[i] - g_identAvant[i]), message);
      journal("%s", g_identResultat);
      terminerIdentification();
    } else if (maintenant - g_identDebut >= (uint32_t)IDENTIFICATION_S * 1000UL) {
      snprintf(g_identResultat, sizeof g_identResultat,
               "Zone %u : identification abandonnee, aucune sonde n'a varie d'1 C a elle seule", z + 1);
      journal("%s", g_identResultat);
      terminerIdentification();
    }
  }

  // --- balayage automatique, seulement s'il manque une mesure ----------------
  bool manque = false;
  for (uint8_t z = 0; z < NB_ZONES; z++)
    if (g_zoneSansMesure[z]) manque = true;
  if (manque && g_identZone < 0 && maintenant - g_dernierBalayage >= BALAYAGE_AUTO_MS) rescanner();
}

uint8_t nombreDetecte() { return g_nb; }

uint8_t inventaire(InfoSonde *t, uint8_t max) {
  uint8_t n = 0;
  for (uint8_t i = 0; i < g_nb && n < max; i++, n++) {
    memcpy(t[n].rom, g_presentes[i], 8);
    t[n].temperature = valeur(g_presentes[i]);
    t[n].zone = Liaisons::zoneDe(liees(), g_presentes[i]);
  }
  return n;
}

String inventaireJson() {
  String j = "{\"sondes\":[";
  for (uint8_t i = 0; i < g_nb; i++) {
    if (i) j += ",";
    const float t = valeur(g_presentes[i]);
    j += "{\"rom\":\"" + romTexte(g_presentes[i]) +
         "\",\"temp\":" + (isnan(t) ? String("null") : String(t, 2)) +
         ",\"zone\":" + String(Liaisons::zoneDe(liees(), g_presentes[i])) + "}";
  }
  j += "],\"parasite\":" + String(bus.isParasitePowerMode() ? "true" : "false");
  // Zones liées à une sonde absente du bus : à voir d'un coup d'œil.
  j += ",\"liaisons\":[";
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    if (z) j += ",";
    if (!g_liaisonValide[z])
      j += "null";
    else
      j += "{\"rom\":\"" + romTexte(g_liee[z]) +
           "\",\"presente\":" + String(presente(g_liee[z]) ? "true" : "false") + "}";
  }
  j += "],\"identification\":";
  if (g_identZone >= 0)
    j += "{\"zone\":" + String(g_identZone + 1) + ",\"restantS\":" + String(identificationRestanteS()) + "}";
  else
    j += "null";
  char echappe[sizeof g_identResultat * 2];
  formatEchapperJson(g_identResultat, echappe, sizeof echappe);
  j += ",\"resultat\":\"" + String(echappe) + "\"}";
  return j;
}

String inventaireTexte() {
  String s = "Sondes detectees : " + String(g_nb) + "\n";
  for (uint8_t i = 0; i < g_nb; i++) {
    const int8_t z = Liaisons::zoneDe(liees(), g_presentes[i]);
    const float t = valeur(g_presentes[i]);
    s += "  #" + String(i) + "  " + romTexte(g_presentes[i]) + "  " +
         (isnan(t) ? String("--.--") : String(t, 2)) + " C  " +
         (z >= 0 ? "-> zone " + String(z + 1) : "(non liee)") + "\n";
  }
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    if (!g_liaisonValide[z])
      s += "  Zone " + String(z + 1) + " : aucune sonde liee\n";
    else if (!presente(g_liee[z]))
      s += "  Zone " + String(z + 1) + " : sa sonde " + romTexte(g_liee[z]) + " est absente du bus\n";
  }
  s += "Alimentation parasite : " + String(bus.isParasitePowerMode() ? "oui" : "non") + "\n";
  s += "Lier : `identifier <zone>` (sonde serree dans la main) ou `lier <index> <zone>`\n";
  return s;
}

bool lierRom(const uint8_t *rom, uint8_t zone, char *message, size_t taille) {
  if (zone >= NB_ZONES) {
    snprintf(message, taille, "Zone invalide");
    return false;
  }
  if (Liaisons::romNulle(rom) || !presente(rom)) {
    snprintf(message, taille, "Sonde absente du bus (`scan` pour relire le bus)");
    return false;
  }
  const uint8_t perdues = Liaisons::lier(liees(), rom, zone);
  Stockage::sauverReseau();
  rechargerLiaisons();
  ctrl.oublierMesures();
  const String r = romTexte(rom);
  if (perdues) {
    uint8_t ancienne = 0;
    while (ancienne < NB_ZONES && !(perdues & (1u << ancienne))) ancienne++;
    snprintf(message, taille, "Sonde %s liee a la zone %u (retiree de la zone %u, qui n'a plus de sonde)",
             r.c_str(), zone + 1, ancienne + 1);
  } else {
    snprintf(message, taille, "Sonde %s liee a la zone %u", r.c_str(), zone + 1);
  }
  journal("%s", message);
  return true;
}

bool lierParIndex(uint8_t indexBus, uint8_t zone, char *message, size_t taille) {
  if (indexBus >= g_nb) {
    snprintf(message, taille, "Index de sonde introuvable (`scan` les liste)");
    return false;
  }
  return lierRom(g_presentes[indexBus], zone, message, taille);
}

bool lancerIdentification(uint8_t zone, char *message, size_t taille) {
  if (zone >= NB_ZONES) {
    snprintf(message, taille, "Zone invalide");
    return false;
  }
  if (g_identZone >= 0) {
    snprintf(message, taille, "Identification deja en cours (zone %d)", g_identZone + 1);
    return false;
  }
  if (otaEnCours) {
    snprintf(message, taille, "Mise a jour en cours");
    return false;
  }
  rescanner();
  if (g_nb == 0) {
    snprintf(message, taille, "Aucune sonde sur le bus");
    return false;
  }
  for (uint8_t i = 0; i < g_nb; i++) g_identAvant[i] = valeur(g_presentes[i]);
  g_identZone = (int8_t)zone;
  g_identDebut = millis();
  g_identResultat[0] = '\0';
  // Chauffe suspendue le temps de l'essai : une plaque qui chauffe ferait
  // bouger sa sonde, et l'on ne saurait plus laquelle on tient dans la main.
  g_identSuspend = true;
  ctrl.suspendre(true);
  snprintf(message, taille,
           "Zone %u : serrez sa sonde dans la main (ou refroidissez-la) ; chauffe suspendue, %u s maximum",
           zone + 1, IDENTIFICATION_S);
  journal("Identification lancee pour la zone %u (%u sonde(s) sur le bus)", zone + 1, g_nb);
  return true;
}

void annulerIdentification() {
  if (g_identZone < 0) return;
  snprintf(g_identResultat, sizeof g_identResultat, "Zone %d : identification annulee", g_identZone + 1);
  journal("%s", g_identResultat);
  terminerIdentification();
}

int8_t zoneEnIdentification() { return g_identZone; }

uint16_t identificationRestanteS() {
  if (g_identZone < 0) return 0;
  const uint32_t ecoule = (millis() - g_identDebut) / 1000UL;
  return ecoule >= IDENTIFICATION_S ? 0 : (uint16_t)(IDENTIFICATION_S - ecoule);
}

const char *dernierResultatIdentification() { return g_identResultat; }

}  // namespace Sondes
