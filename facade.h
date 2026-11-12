/* facade.h — ce qui se voit et se touche sans câble : le bouton BOOT de la
   carte et sa LED bleue.

   Bouton (GPIO0, lu seulement après le démarrage) :
     appui court        page suivante de l'écran (zones, courbes 6 h, réseau,
                        sondes, système)
     appui de 3 à 10 s  QR et code d'appairage
     appui de 10 s      point d'accès de configuration (changer de box sans USB)
   LED (GPIO2), de la plus importante à la plus banale :
     clignotement rapide         une zone en défaut
     allumée fixe                identification de sonde ou essai de chauffe
     clignotement lent (1 s)     point d'accès de configuration ouvert
     éclair chaque seconde       Wi-Fi absent
     double éclair (2 s)         MQTT configuré mais refusé ou injoignable
     bref éclair toutes les 5 s  tout va bien
*/
#ifndef FACADE_H
#define FACADE_H

#include "config.h"

namespace Facade {

void demarrer();
void boucle(uint32_t maintenant);

}  // namespace Facade

#endif  // FACADE_H
