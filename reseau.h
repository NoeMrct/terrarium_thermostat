/* reseau.h — WiFi (station ou point d'accès de secours), interface web
   authentifiée, OTA, MQTT/Home Assistant, alertes sortantes et heartbeat. */
#ifndef RESEAU_H
#define RESEAU_H

#include "config.h"

namespace Reseau {

void demarrer();
void boucle(uint32_t maintenant);

// Identifiant de cet appareil, derive de l'adresse MAC : « terraA1B2C3 ».
// C'est la racine de ses sujets MQTT, et ce que l'application demande pour
// l'appairer. Stable pour une carte donnee, y compris apres effacement.
String identifiant();

bool connecte();
bool modePointAcces();
String adresse();
String nomHote();            // « terraA1B2C3.local » : l'interface locale de CE socle
String ssidConfiguration();  // SSID du point d'accès de configuration de ce socle
// Mise à jour tirée depuis une URL https (ou une version X.Y.Z, résolue par
// MAJ_URL_MODELE). Ne revient qu'en cas de refus, avec `erreur` renseignée :
// sinon l'image est écrite et l'appareil redémarre.
void mettreAJour(const String &cible, char *erreur, size_t taille);
// Tentative de connexion bloquante à un réseau (Improv Wi-Fi, console) : true si
// connecté dans le délai, les identifiants sont alors enregistrés.
bool essayerWifi(const char *ssid, const char *motDePasse, uint32_t delaiMs);
// L'OTA réseau ne démarre que si elle est protégée par un mot de passe.
bool otaActive();

// Empile une alerte : elle est persistée puis envoyée dès que le réseau revient.
// L'anti-répétition évite qu'une sonde instable n'inonde le webhook.
void alerter(TypeNotif type, uint8_t zone, const String &texte);

void publierMqtt(bool forcer = false);

// Santé de l'appareil (signal, mémoire, uptime, dernier redémarrage…), en JSON
// sans accolades : la même chose que publie le sujet MQTT « sante ».
String sante();
// Efface le coredump en flash. false s'il n'y en avait pas ou si c'est impossible.
bool effacerCoredump();

// Empreinte SHA-256, utilisée pour ne jamais stocker de mot de passe en clair.
String empreinte(const String &texte);

}  // namespace Reseau

#endif  // RESEAU_H
