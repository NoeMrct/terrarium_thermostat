/* sondes.h — bus 1-Wire DS18B20, liaison durable entre une adresse ROM et une
   zone (stockée en flash : plus besoin de recompiler pour changer de sonde). */
#ifndef SONDES_H
#define SONDES_H

#include "config.h"

namespace Sondes {

void demarrer();
void rechargerLiaisons();          // après modification des ROM en flash

// Lecture en deux temps pour ne jamais bloquer la boucle principale :
// demanderConversion() puis, ~800 ms plus tard, conversionPrete() et lire().
void  demanderConversion();
bool  conversionPrete(uint32_t maintenant);
float lire(uint8_t zone);          // °C brut, ou DEVICE_DISCONNECTED_C

uint8_t nombreDetecte();
String  inventaireJson();          // pour l'interface web
String  inventaireTexte();         // pour la console série
bool    lierParIndex(uint8_t indexBus, uint8_t zone);

} // namespace Sondes

#endif // SONDES_H
