/* reseau.h — WiFi (station ou point d'accès de secours), interface web
   authentifiée, OTA, MQTT/Home Assistant, alertes sortantes et heartbeat. */
#ifndef RESEAU_H
#define RESEAU_H

#include "config.h"

namespace Reseau {

void demarrer();
void boucle(uint32_t maintenant);

bool connecte();
bool modePointAcces();
String adresse();
// L'OTA réseau ne démarre que si elle est protégée par un mot de passe.
bool otaActive();

// Empile une alerte : elle est persistée puis envoyée dès que le réseau revient.
// L'anti-répétition évite qu'une sonde instable n'inonde le webhook.
void alerter(TypeNotif type, uint8_t zone, const String &texte);

void publierMqtt(bool forcer = false);

// Empreinte SHA-256, utilisée pour ne jamais stocker de mot de passe en clair.
String empreinte(const String &texte);

} // namespace Reseau

#endif // RESEAU_H
