/* essai.h — mise en service : essai de chauffe guidé d'une zone, et
   calibration des sondes posées côte à côte. */
#ifndef ESSAI_H
#define ESSAI_H

#include "config.h"

namespace Essai {

// La zone chauffe seule, à pleine puissance, 10 min au plus (sécurités
// actives). Verdict dès que sa sonde gagne ESSAI_HAUSSE °C — ou qu'une autre
// sonde monte à sa place (sondes inversées), ou que rien ne bouge.
static const uint32_t ESSAI_MS = 600000;
static const float ESSAI_HAUSSE = 0.5f;
bool lancer(uint8_t zone, char *message, size_t taille);
void annuler();
void suivre(uint32_t maintenant);  // après chaque lecture des sondes
int8_t zoneEnCours();              // -1 : aucun essai
uint16_t restantS();
const char *dernierResultat();

// Sondes côte à côte depuis quelques minutes : les zones 2 et suivantes sont
// alignées sur la zone 1 (décalage de calibration enregistré).
bool calibrer(char *message, size_t taille);

}  // namespace Essai

#endif  // ESSAI_H
