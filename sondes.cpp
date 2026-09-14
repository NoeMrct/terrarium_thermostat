#include "sondes.h"
#include "stockage.h"
#include <OneWire.h>
#include <DallasTemperature.h>

namespace {

OneWire oneWire(PIN_ONEWIRE);
DallasTemperature bus(&oneWire);

DeviceAddress g_liee[NB_ZONES];
bool     g_liaisonValide[NB_ZONES] = { false, false };
uint32_t g_debutConversion = 0;
bool     g_enCours = false;

bool romNonNulle(const uint8_t *r) {
  for (uint8_t i = 0; i < 8; i++) if (r[i]) return true;
  return false;
}

String romTexte(const uint8_t *r) {
  char b[20];
  snprintf(b, sizeof b, "%02X%02X%02X%02X%02X%02X%02X%02X",
           r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7]);
  return String(b);
}

int8_t zoneDeRom(const uint8_t *rom) {
  for (uint8_t z = 0; z < NB_ZONES; z++)
    if (g_liaisonValide[z] && memcmp(g_liee[z], rom, 8) == 0) return (int8_t)z;
  return -1;
}

} // namespace

namespace Sondes {

void rechargerLiaisons() {
  const ReglagesReseau &r = Stockage::reseau();
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    memcpy(g_liee[z], r.sondeRom[z], 8);
    g_liaisonValide[z] = romNonNulle(r.sondeRom[z]);
  }
}

void demarrer() {
  bus.begin();
  bus.setResolution(12);
  bus.setWaitForConversion(false);
  rechargerLiaisons();

  const uint8_t n = bus.getDeviceCount();
  journal("Bus 1-Wire : %u sonde(s) detectee(s)", n);

  // Aucune liaison enregistrée et exactement le bon nombre de sondes : on
  // associe automatiquement, puis on l'inscrit en flash. L'ordre de découverte
  // n'est stable qu'une fois figé de cette façon — sans quoi les zones
  // pourraient s'inverser au redémarrage suivant.
  bool aucuneLiaison = true;
  for (uint8_t z = 0; z < NB_ZONES; z++) if (g_liaisonValide[z]) aucuneLiaison = false;
  if (aucuneLiaison && n >= NB_ZONES) {
    ReglagesReseau &r = Stockage::reseau();
    for (uint8_t z = 0; z < NB_ZONES; z++) {
      DeviceAddress a;
      if (bus.getAddress(a, z)) memcpy(r.sondeRom[z], a, 8);
    }
    Stockage::sauverReseau();
    rechargerLiaisons();
    journal("Liaisons sondes<->zones figees automatiquement au premier demarrage");
  }
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
  // getTempC vérifie déjà la présence et le CRC, et renvoie
  // DEVICE_DISCONNECTED_C en cas de problème : un isConnected() préalable
  // relirait les neuf octets du scratchpad pour rien, soit ~14 ms de bus
  // gaspillées par cycle de mesure.
  if (g_liaisonValide[zone]) return bus.getTempC(g_liee[zone]);
  return bus.getTempCByIndex(zone);   // repli tant qu'aucune liaison n'est figée
}

uint8_t nombreDetecte() { return bus.getDeviceCount(); }

String inventaireJson() {
  String j = "{\"sondes\":[";
  const uint8_t n = bus.getDeviceCount();
  DeviceAddress a;
  bool premier = true;
  for (uint8_t i = 0; i < n; i++) {
    if (!bus.getAddress(a, i)) continue;
    if (!premier) j += ",";
    premier = false;
    j += "{\"rom\":\"" + romTexte(a) + "\",\"temp\":" + String(bus.getTempC(a), 2) +
         ",\"zone\":" + String(zoneDeRom(a)) + "}";
  }
  j += "],\"parasite\":" + String(bus.isParasitePowerMode() ? "true" : "false") + "}";
  return j;
}

String inventaireTexte() {
  String s = "Sondes detectees : " + String(bus.getDeviceCount()) + "\n";
  DeviceAddress a;
  for (uint8_t i = 0; i < bus.getDeviceCount(); i++) {
    if (!bus.getAddress(a, i)) continue;
    const int8_t z = zoneDeRom(a);
    s += "  #" + String(i) + "  " + romTexte(a) + "  " + String(bus.getTempC(a), 2) + " C  " +
         (z >= 0 ? "-> zone " + String(z + 1) : "(non liee)") + "\n";
  }
  s += "Alimentation parasite : " + String(bus.isParasitePowerMode() ? "oui" : "non") + "\n";
  s += "Lier une sonde : `lier <index> <zone>`\n";
  return s;
}

bool lierParIndex(uint8_t indexBus, uint8_t zone) {
  if (zone >= NB_ZONES) return false;
  DeviceAddress a;
  if (!bus.getAddress(a, indexBus)) return false;
  ReglagesReseau &r = Stockage::reseau();
  memcpy(r.sondeRom[zone], a, 8);
  Stockage::sauverReseau();
  rechargerLiaisons();
  journal("Sonde %s liee a la zone %u", romTexte(a).c_str(), zone + 1);
  return true;
}

} // namespace Sondes
