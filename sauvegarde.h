/* sauvegarde.h — sauvegarde et restauration de la configuration du socle :
   remplacer une carte en une minute. Le fichier contient les réglages des
   zones, les réglages généraux, les sondes liées et les réglages réseau qui ne
   sont pas des secrets (fuseau, NTP, alertes). Jamais de mot de passe ni de
   jeton : le Wi-Fi et MQTT se ressaisissent sur la nouvelle carte. */
#ifndef SAUVEGARDE_H
#define SAUVEGARDE_H

#include "config.h"

namespace Sauvegarde {

// pourLeBroker : compacte, et sans les URL d'alerte et de heartbeat (leur
// chemin vaut secret) ; restaurée, elle garde celles du socle.
String json(bool pourLeBroker = false);
// Tout ou rien : un seul réglage refusé, et rien n'est appliqué.
bool restaurer(const char *texte, size_t longueur, char *message, size_t taille);

}  // namespace Sauvegarde

#endif  // SAUVEGARDE_H
