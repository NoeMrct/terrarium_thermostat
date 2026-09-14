/* config.h — brochage, cadences et déclarations partagées entre modules. */
#ifndef CONFIG_H
#define CONFIG_H

#include <Arduino.h>
#include <esp_task_wdt.h>
#include "controle.h"

// Version du firmware. Affichée partout : après quelques mises à jour sans fil,
// c'est le seul moyen de savoir ce qui tourne réellement sur la carte.
#define FW_VERSION "3.2.0"
#define FW_BUILD   __DATE__ " " __TIME__

// ------------------------------ Brochage ------------------------------------
static const uint8_t PIN_TAPIS[NB_TAPIS] = { 16, 17 };
#define PIN_ONEWIRE   4
#define PIN_SDA      21
#define PIN_SCL      22
#define OLED_ADDR  0x3C
#define OLED_L      128
#define OLED_H       64

// ------------------------------ Cadences ------------------------------------
static const uint32_t PERIODE_MESURE_MS = 2000;    // lecture des sondes
static const uint32_t CONVERSION_MS     = 800;     // conversion DS18B20 12 bits
static const uint32_t PERIODE_LOG_MS    = 30000;
static const uint32_t PERIODE_HIST_MS   = 60000;   // 1 point d'historique/minute
static const uint32_t PERIODE_EPOCH_MS  = 600000;  // sauvegarde de l'heure
static const uint32_t PERIODE_MQTT_MS   = 20000;
static const uint32_t ANTISPAM_MS       = 1800000; // 30 min entre 2 alertes identiques
static const uint8_t  WDT_SECONDES      = 15;

// Point d'historique tel qu'il est stocké sur le système de fichiers.
// Le numéro de séquence permet de retrouver la tête de l'anneau au démarrage
// sans réécrire un entête à chaque échantillon (voir stockage.cpp).
struct Echantillon {
  uint32_t seq;
  uint32_t epoch;
  int16_t  t[NB_ZONES];      // température en centièmes de °C, -32768 = inconnue
  int16_t  c[NB_ZONES];      // consigne en centièmes de °C
  uint8_t  d[NB_ZONES];      // demande en %
  uint8_t  defauts;          // 2 bits par zone
  uint8_t  reserve;
};

// ------------------------ Services partagés ---------------------------------
extern Controleur ctrl;
extern bool       otaEnCours;

void   journal(const char *fmt, ...);      // trace horodatée persistante
String horodatage();                       // "2026-09-03 18:57:12" ou "----"
bool   heureFiable();                      // heure NTP ou restaurée
bool   heureApproximative();               // restaurée depuis la flash, non resynchronisée
uint16_t minutesDuJour();
uint32_t secondesChauffeTotales(uint8_t zone);   // cumul, y compris avant reboot
void     appliquerReglagesGlobaux();             // puissance disponible et saison

#endif // CONFIG_H
