#include "facade.h"
#include "affichage.h"
#include "essai.h"
#include "reseau.h"
#include "sondes.h"
#include "stockage.h"

namespace {

bool g_appuye = false;
uint32_t g_debutAppui = 0, g_dernierChangement = 0;
uint8_t g_etape = 0;  // 0 : rien, 1 : seuil du QR passé, 2 : seuil du point d'accès passé
bool g_ledAllumee = false;

const uint32_t ANTIREBOND_MS = 40;
const uint32_t APPUI_QR_MS = 3000;
const uint32_t APPUI_AP_MS = 10000;

void led(bool allumee) {
  if (allumee == g_ledAllumee) return;
  g_ledAllumee = allumee;
  digitalWrite(PIN_LED, allumee ? HIGH : LOW);
}

// Motif de la LED selon l'état, du plus important au plus banal.
bool motif(uint32_t t) {
  for (uint8_t z = 0; z < NB_ZONES; z++)
    if (ctrl.zone[z].defaut != DEF_AUCUN) return (t / 125) % 2 == 0;  // 4 Hz
  if (Sondes::zoneEnIdentification() >= 0 || Essai::zoneEnCours() >= 0) return true;
  if (Reseau::modePointAcces()) return (t / 1000) % 2 == 0;
  if (!Reseau::connecte()) return t % 1000 < 150;
  if (Reseau::etatCourtMqtt()[0]) {
    const uint32_t p = t % 2000;
    return p < 100 || (p >= 250 && p < 350);
  }
  return t % 5000 < 40;
}

}  // namespace

namespace Facade {

void demarrer() {
  pinMode(PIN_BOUTON, INPUT_PULLUP);
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, LOW);
}

void boucle(uint32_t maintenant) {
  // --- LED -------------------------------------------------------------------
  led(!Stockage::globaux().ledEteinte && motif(maintenant));

  // --- bouton ----------------------------------------------------------------
  const bool bas = digitalRead(PIN_BOUTON) == LOW;
  if (bas != g_appuye) {
    if (maintenant - g_dernierChangement < ANTIREBOND_MS) return;
    g_dernierChangement = maintenant;
    g_appuye = bas;
    if (bas) {
      g_debutAppui = maintenant;
      g_etape = 0;
      return;
    }
    // Relâché : l'action dépend de la durée.
    const uint32_t duree = maintenant - g_debutAppui;
    if (g_etape == 2) {
      Reseau::modeConfiguration();
      Affichage::avis("Point d'acces ouvert :", Reseau::ssidConfiguration(), 15000);
    } else if (g_etape == 1) {
      Affichage::appairage(Reseau::identifiant().c_str(), Stockage::reseau().jeton, 60);
    } else if (duree >= ANTIREBOND_MS) {
      Affichage::pageSuivante();
    }
    g_etape = 0;
    return;
  }
  if (!g_appuye) return;
  const uint32_t tenu = maintenant - g_debutAppui;
  if (g_etape == 0 && tenu >= APPUI_QR_MS) {
    g_etape = 1;
    Affichage::avis("Relacher : QR", "Tenir 10 s : config WiFi", 8000);
  } else if (g_etape == 1 && tenu >= APPUI_AP_MS) {
    g_etape = 2;
    Affichage::avis("Relacher : point", "d'acces de config WiFi", 10000);
  }
}

}  // namespace Facade
