/* config.h — brochage, cadences et déclarations partagées entre modules. */
#ifndef CONFIG_H
#define CONFIG_H

#include <Arduino.h>
#include <esp_task_wdt.h>
#include "controle.h"

// Version du firmware. Affichée partout : après quelques mises à jour sans fil,
// c'est le seul moyen de savoir ce qui tourne réellement sur la carte.
#define FW_VERSION "3.4.0"
// Identifiant de compilation. La CI passe le commit (-DFW_COMMIT="abc1234") et
// fige la date par SOURCE_DATE_EPOCH : deux compilations du même commit donnent
// alors le même binaire, octet pour octet, ce qui prouve qu'une release
// correspond à ses sources (docs/publication.md). Sous l'IDE : date réelle, « local ».
#ifndef FW_COMMIT
#define FW_COMMIT "local"
#endif
#define FW_BUILD __DATE__ " " __TIME__ " " FW_COMMIT

// Version du protocole de pilotage (sujets et champs MQTT, canal de commande).
// Incrémentée à chaque changement qu'une application plus ancienne ne saurait
// pas interpréter ; l'application compare et dit lequel des deux mettre à jour.
//   1 : 3.0 à 3.2 — sujets zone<n>/etat, cmd/reponse
//   2 : 3.3 — sujet « sante », champs proto et sante dans la réponse « etat »,
//       commandes rejouées sans effet (identifiant de requête mémorisé)
//   3 : 3.4 — action « maj » (mise à jour tirée depuis une URL), sujet « maj »
//       (progression), champs hote et maj dans « sante »
#define PROTO_VERSION 3

// Mise à jour à distance : l'action MQTT « maj » reçoit soit une URL complète,
// soit un numéro de version, auquel cas l'URL est déduite de ce modèle (%s est
// remplacé deux fois par la version). Le socle télécharge en HTTPS avec le
// magasin d'autorités du paquet ESP32, suit les redirections de GitHub, vérifie
// la signature si OTA_CLE_PUBLIQUE est renseignée, puis redémarre sur la
// nouvelle image — qui n'est validée qu'après OTA_VALIDATION_MS (retour arrière
// automatique sinon). Vide : l'action n'accepte que des URL explicites.
#define MAJ_URL_MODELE \
  "https://github.com/NoeMrct/terrarium_thermostat/releases/download/v%s/terrarium-%s-firmware.bin"
// Même modèle quand OTA_CLE_PUBLIQUE est renseignée : l'image signée publiée
// par le workflow (terrarium-X.Y.Z-firmware.signe.bin).
#define MAJ_URL_MODELE_SIGNE \
  "https://github.com/NoeMrct/terrarium_thermostat/releases/download/v%s/terrarium-%s-firmware.signe.bin"
// Une URL explicite (action « maj », console, /api/maj-distante) doit commencer
// par l'un de ces préfixes (séparés par des virgules) : les releases du dépôt,
// rien d'autre. Un jeton d'appairage volé ne doit pas suffire à faire charger
// un firmware hébergé n'importe où — pas même sur les serveurs d'objets de
// GitHub, où n'importe qui publie.
#define MAJ_ORIGINES_AUTORISEES "https://github.com/NoeMrct/terrarium_thermostat/releases/download/"
// GitHub redirige le téléchargement vers ses serveurs d'objets : les
// redirections (cinq au plus) ne sont suivies que vers ces préfixes.
#define MAJ_HOTES_AUTORISES                                                     \
  "https://github.com/NoeMrct/,https://objects.githubusercontent.com/,https://" \
  "release-assets.githubusercontent.com/"

// ------------------------------ Brochage ------------------------------------
static const uint8_t PIN_TAPIS[NB_TAPIS] = { 16, 17 };
#define PIN_ONEWIRE 4
#define PIN_SDA 21
#define PIN_SCL 22
#define OLED_ADDR 0x3C
#define OLED_L 128
#define OLED_H 64

// Mesure de courant facultative : un module INA219 sur le bus I2C de l'écran,
// en série sur le 12 V des tapis. Elle détecte un tapis coupé (il devrait
// consommer et ne consomme pas) et un MOSFET resté passant (ça consomme alors
// que tout est coupé), et compte de vrais kWh. 0 = absent, rien n'est compilé.
#define INA219_ACTIF 0
#define INA219_ADDR 0x40
#define INA219_SHUNT_OHM 0.1f

// Clé publique ECDSA P-256 (PEM) qui doit avoir signé toute image envoyée par
// /api/maj (téléversement depuis le navigateur). Vide : aucune signature exigée.
// Générer la paire et signer : outils/signer-firmware.js.
#define OTA_CLE_PUBLIQUE ""

// ------------------------------ Cadences ------------------------------------
static const uint32_t PERIODE_MESURE_MS = 2000;  // lecture des sondes
static const uint32_t CONVERSION_MS = 800;       // conversion DS18B20 12 bits
static const uint32_t PERIODE_LOG_MS = 30000;
static const uint32_t PERIODE_HIST_MS = 60000;    // 1 point d'historique/minute
static const uint32_t PERIODE_EPOCH_MS = 600000;  // sauvegarde de l'heure
// MQTT : l'état d'une zone part dès qu'il change (au plus toutes les MIN), et
// de toute façon toutes les MAX pour que l'application sache que le socle vit.
static const uint32_t PERIODE_MQTT_MIN_MS = 2000;
static const uint32_t PERIODE_MQTT_MAX_MS = 60000;
static const uint32_t PERIODE_SANTE_MS = 60000;  // signal, mémoire, uptime…
static const uint32_t ANTISPAM_MS = 1800000;     // 30 min entre 2 alertes identiques
static const uint8_t WDT_SECONDES = 15;
// Une mise à jour fraîchement installée doit tenir ce temps sans planter pour
// être validée ; sinon le chargeur revient de lui-même à l'image précédente.
static const uint32_t OTA_VALIDATION_MS = 90000;

// Point d'historique tel qu'il est stocké sur le système de fichiers.
// Le numéro de séquence permet de retrouver la tête de l'anneau au démarrage
// sans réécrire un entête à chaque échantillon (voir stockage.cpp).
struct Echantillon {
  uint32_t seq;
  uint32_t epoch;
  int16_t t[NB_ZONES];  // température en centièmes de °C, -32768 = inconnue
  int16_t c[NB_ZONES];  // consigne en centièmes de °C
  uint8_t d[NB_ZONES];  // demande en %
  uint8_t defauts;      // 2 bits par zone
  uint8_t reserve;
};

// ------------------------ Services partagés ---------------------------------
extern Controleur ctrl;
extern bool otaEnCours;

void journal(const char *fmt, ...);  // trace horodatée persistante
String horodatage();                 // "2026-09-03 18:57:12" ou "----"
bool heureFiable();                  // heure NTP ou restaurée
bool heureApproximative();           // restaurée depuis la flash, non resynchronisée
uint16_t minutesDuJour();
uint32_t secondesChauffeTotales(uint8_t zone);  // cumul, y compris avant reboot
void appliquerReglagesGlobaux();                // puissance disponible et saison
const char *raisonRedemarrage();                // « mise sous tension », « PANIQUE »…
bool redemarrageAnormal();                      // panique, watchdog, chute d'alimentation
const char *resumePlantage();                   // résumé du dernier coredump, ou ""
bool otaEnAttenteValidation();                  // image neuve pas encore confirmée
void couperChauffagePourMaj(bool actif);        // sorties coupées tout de suite, pas au prochain tour

#endif  // CONFIG_H
