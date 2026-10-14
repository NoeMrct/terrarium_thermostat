/* courant.h — mesure de courant des tapis par un INA219 (facultatif).
   Avec INA219_ACTIF à 0 dans config.h, tout ici est inerte et ne coûte rien. */
#ifndef COURANT_H
#define COURANT_H

#include "config.h"

namespace Courant {

void demarrer();  // après Wire.begin() (écran)
void boucle(uint32_t maintenant, uint8_t masqueAlimente);

bool actif();            // module présent et répondant
float amperes();         // dernière mesure, NAN si absent
float lireMaintenant();  // mesure instantanée (test usine), NAN si absent
float volts();           // tension côté tapis
double wattheures();     // énergie réellement mesurée depuis le démarrage
const char *anomalie();  // "" ou le diagnostic en cours

}  // namespace Courant

#endif  // COURANT_H
