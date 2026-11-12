/* sondes.h — bus 1-Wire DS18B20, liaison durable entre une adresse ROM et une
   zone (stockée en flash : plus besoin de recompiler pour changer de sonde).
   Les règles de liaison elles-mêmes sont dans liaisons.h, testées sur PC. */
#ifndef SONDES_H
#define SONDES_H

#include "config.h"

namespace Sondes {

void demarrer();
void rechargerLiaisons();  // après modification des ROM en flash

// Relit le bus : une sonde branchée ou retirée depuis le démarrage devient
// visible, les liaisons automatiques sans ambiguïté sont faites, et ce qui a
// changé est journalisé. Fait aussi tout seul toutes les 5 min tant qu'une
// zone n'a pas de sonde qui répond.
void rescanner();

// Lecture en deux temps pour ne jamais bloquer la boucle principale :
// demanderConversion() puis, ~800 ms plus tard, conversionPrete() et lire().
void demanderConversion();
bool conversionPrete(uint32_t maintenant);
// °C brut de la sonde liée à la zone, ou DEVICE_DISCONNECTED_C — y compris
// quand aucune sonde n'est liée : la zone passe alors en défaut SONDE au lieu
// de lire une sonde au hasard.
float lire(uint8_t zone);
// Après chaque lecture du bus : identification en cours, présence des sondes.
void suivre(uint32_t maintenant);

struct InfoSonde {
  uint8_t rom[8];
  float temperature;  // dernière conversion, NAN si muette
  int8_t zone;        // -1 : liée à aucune zone
};
uint8_t nombreDetecte();
uint8_t inventaire(InfoSonde *t, uint8_t max);  // sondes vues au dernier balayage
String inventaireJson();                        // pour l'interface web
String inventaireTexte();                       // pour la console série

// Liaisons explicites. Une sonde n'est jamais liée à deux zones : la lier à
// l'une la retire de l'autre, et le message le dit.
bool lierParIndex(uint8_t indexBus, uint8_t zone, char *message, size_t taille);
bool lierRom(const uint8_t *rom, uint8_t zone, char *message, size_t taille);

// Assistant d'identification : la chauffe est suspendue, on serre la sonde de
// la zone dans la main (ou on la refroidit), et celle qui varie nettement est
// liée à la zone. Abandon au bout de IDENTIFICATION_S secondes.
static const uint16_t IDENTIFICATION_S = 120;
bool lancerIdentification(uint8_t zone, char *message, size_t taille);
void annulerIdentification();
int8_t zoneEnIdentification();  // -1 : aucune en cours
uint16_t identificationRestanteS();
const char *dernierResultatIdentification();

}  // namespace Sondes

#endif  // SONDES_H
