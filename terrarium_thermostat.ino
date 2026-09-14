/* =============================================================================
   THERMOSTAT DE TERRARIUM — ESP32 — v3
   2 zones · 2 tapis · un seul tapis alimenté à la fois
   =============================================================================

   ORGANISATION DU PROJET
     controle.h/.cpp   cœur de régulation, sans aucune dépendance Arduino
     anneau.h/.cpp     index du journal circulaire d'historique — idem, testable sur PC
     format.h/.cpp     échappement JSON et horaires, partagés — idem
     stockage.h/.cpp   NVS (réglages, défauts) + LittleFS (historique, journal)
     sondes.h/.cpp     bus 1-Wire, liaison sonde <-> zone
     reseau.h/.cpp     WiFi/AP, web authentifié, OTA, MQTT, alertes, métriques
     affichage.h/.cpp  écran OLED
     console.h/.cpp    commandes série
     page_web.h        interface web embarquée
     sim/              bancs d'essai qui tournent sur PC (make test)
     outils/           socle simulé, tests de protocole, d'application et d'interface

   MATÉRIEL
     ESP32 DevKitC · 2x DS18B20 sur GPIO4 · 2x tapis 12V 20W · 2x IRLZ44N
     OLED SSD1306 (GPIO21/22) · 4,7 kΩ pull-up 1-Wire · 2x 10 kΩ pull-down
     grille · 2x 100 Ω en série sur les grilles · 2x bilame KSD9700 70 °C NC
     en série avec chaque tapis · LM2596 réglé à 5 V (12 V -> VIN de la carte)
     alimentation 12 V 3 A pour l'ensemble

   BIBLIOTHÈQUES À INSTALLER
     OneWire · DallasTemperature · Adafruit GFX · Adafruit SSD1306 · PubSubClient
     ArduinoJson (v7, utilisee par le canal de commande MQTT)

   PREMIER DÉMARRAGE
     1) Téléverser. Aucun réseau n'est configuré : l'ESP32 ouvre un point d'accès
        « terrarium-config » (mot de passe terrarium1234). S'y connecter et
        ouvrir http://192.168.4.1 pour saisir le WiFi, ou passer par la console
        série : `wifi <ssid> <mot de passe>` puis `redemarrer`.
     2) Protéger l'accès : `motdepasse web <mdp>` et `motdepasse ota <mdp>`.
     3) `scan` puis `lier <index> <zone>` pour figer quelle sonde régule quoi.
        (Fait automatiquement au premier démarrage si le compte tombe juste.)
     4) Régler les consignes depuis l'interface web ou la console.
     5) `autotune 1` une fois le terrarium en place et stabilisé.

   RAPPEL QUI NE RELÈVE PAS DU CODE
     La sonde va au point chaud, sous le substrat, contre le tapis — jamais dans
     l'air. Vérifier au thermomètre IR avant d'installer un animal.
   ============================================================================= */

#include "config.h"
#include "stockage.h"
#include "sondes.h"
#include "reseau.h"
#include "affichage.h"
#include "console.h"

#include <time.h>
#include <sys/time.h>
#include <stdarg.h>
#include <esp_sntp.h>

Controleur ctrl;
bool       otaEnCours = false;

// Prototypes déclarés à la main : l'IDE Arduino en génère automatiquement pour
// tout ce qu'il trouve dans un .ino, ce qui entre en conflit avec des fonctions
// `static` ou placées dans un espace de noms anonyme.
void        appliquerSorties(uint8_t masque);
void        resynchroniserSorties();
const char *raisonRedemarrage();
void        surSynchroNtp(struct timeval *tv);
void        restaurerHeure();
void        traiterNotifications();
void        enregistrerHistorique();
void        journaliserEtat();

uint8_t  g_masqueAlimente = 0;       // état réel des broches de puissance
StatsZone g_stats[NB_ZONES];
uint32_t  g_secondesBase[NB_ZONES] = { 0, 0 };
bool     g_heureFiable = false;      // une heure est disponible
bool     g_heureApprox = false;      // ...mais restaurée depuis la flash, pas resynchronisée
uint8_t  g_defautsPersistes[NB_ZONES] = { DEF_AUCUN, DEF_AUCUN };
float    g_biaisPersistes[NB_ZONES] = { 0.0f, 0.0f };

uint32_t tMesure = 0, tLog = 0, tHist = 0, tEpoch = 0, tAffichage = 0, tBiais = 0, tResync = 0;
bool     conversionDemandee = false;

// ---------------------------------------------------------------------------
// UNIQUE fonction qui pilote les GPIO de puissance : elle éteint les sorties
// puis n'en rallume au plus qu'une. L'exclusion mutuelle est structurelle et ne
// dépend d'aucun enchaînement de conditions ailleurs.
//
// Les broches ne sont écrites que sur changement d'état. Réécrire à chaque tour
// de boucle faisait retomber la grille du tapis actif pendant deux à trois
// microsecondes des milliers de fois par seconde : avec 100 Ω et les ~3 nF du
// IRLZ44N, le transistor repassait brièvement en zone linéaire à chaque fois,
// ce qui l'échauffe pour rien et génère des parasites.
void appliquerSorties(uint8_t masque) {
  if (otaEnCours) masque = 0;
  for (uint8_t i = 0; i < NB_TAPIS; i++)                        // ceinture et bretelles
    if (ctrl.zone[ZONE_DE_TAPIS[i]].defaut != DEF_AUCUN) masque &= (uint8_t)~(1u << i);

  if (masque == g_masqueAlimente) return;

  // Toujours couper avant d'allumer : à aucun instant on ne dépasse le nombre
  // de tapis que l'alimentation peut tenir.
  for (uint8_t i = 0; i < NB_TAPIS; i++)
    if ((g_masqueAlimente & (1u << i)) && !(masque & (1u << i))) digitalWrite(PIN_TAPIS[i], LOW);
  for (uint8_t i = 0; i < NB_TAPIS; i++)
    if (!(g_masqueAlimente & (1u << i)) && (masque & (1u << i))) digitalWrite(PIN_TAPIS[i], HIGH);
  g_masqueAlimente = masque;
}

// Réaffirme périodiquement l'état attendu des broches de puissance. N'écrire que sur
// changement laisse la sortie à la merci d'un registre GPIO altéré par un
// parasite ; réécrire une valeur déjà présente ne provoque aucune coupure, donc
// cette vérification ne coûte rien et restaure la garantie perdue.
void resynchroniserSorties() {
  for (uint8_t i = 0; i < NB_TAPIS; i++)
    digitalWrite(PIN_TAPIS[i], (g_masqueAlimente & (1u << i)) ? HIGH : LOW);
}

const char *raisonRedemarrage() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON:  return "mise sous tension";
    case ESP_RST_SW:       return "redemarrage logiciel";
    case ESP_RST_PANIC:    return "PANIQUE logicielle";
    case ESP_RST_INT_WDT:  return "WATCHDOG d'interruption";
    case ESP_RST_TASK_WDT: return "WATCHDOG de tache";
    case ESP_RST_WDT:      return "WATCHDOG";
    case ESP_RST_BROWNOUT: return "CHUTE D'ALIMENTATION";
    case ESP_RST_DEEPSLEEP:return "sortie de veille";
    case ESP_RST_EXT:      return "reset externe";
    default:               return "cause inconnue";
  }
}

void surSynchroNtp(struct timeval *tv) {
  (void)tv;
  g_heureFiable = true;
  g_heureApprox = false;
  journal("Heure synchronisee par NTP : %s", horodatage().c_str());
}

void restaurerHeure() {
  const uint32_t e = Stockage::lireEpoch();
  if (e < 1700000000UL) return;          // rien de crédible en mémoire
  struct timeval tv = { (time_t)e, 0 };
  settimeofday(&tv, nullptr);
  g_heureFiable = true;
  g_heureApprox = true;
  // Volontairement signalé comme approximatif : cette heure est celle de la
  // dernière sauvegarde, donc en retard de toute la durée de la coupure.
  journal("Heure restauree depuis la flash (approximative) : %s", horodatage().c_str());
}

void traiterNotifications() {
  Notification n;
  while (ctrl.prendreNotification(n)) {
    journal("%s", n.texte);
    Reseau::alerter(n.type, n.zone, String(n.texte));
  }

  // L'autotune réécrit la bande et le gain intégral : sans cette sauvegarde,
  // une heure d'oscillation serait perdue au premier redémarrage.
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    if (!ctrl.zone[z].cfgModifie) continue;
    ctrl.zone[z].cfgModifie = false;
    Stockage::sauverZone(z, ctrl.cfg[z]);
    journal("Gains de %s enregistres : bande %.2f C, ki %.5f",
            ctrl.cfg[z].nom, ctrl.cfg[z].bande, ctrl.cfg[z].ki);
  }

  // Les défauts doivent survivre à un redémarrage : sans cela, un reset
  // watchdog relancerait le chauffage d'une zone dont la cause de coupure est
  // toujours présente.
  bool change = false;
  uint8_t actuels[NB_ZONES];
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    actuels[z] = (uint8_t)ctrl.zone[z].defaut;
    if (actuels[z] != g_defautsPersistes[z]) change = true;
  }
  if (change) {
    memcpy(g_defautsPersistes, actuels, NB_ZONES);
    Stockage::sauverDefauts(g_defautsPersistes);
  }
}

void enregistrerHistorique() {
  // 4 bits de defaut par zone : sur 2 bits, DEF_INEFFICACE (valeur 4) etait
  // enregistre comme « aucun defaut ». La verification casse la compilation si
  // le nombre de zones augmente sans que ce champ soit elargi.
  static_assert(NB_ZONES * 4 <= 8, "Echantillon::defauts trop etroit");
  Echantillon e;
  memset(&e, 0, sizeof e);
  e.epoch = g_heureFiable ? (uint32_t)time(nullptr) : 0;
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    const ZoneEtat &s = ctrl.zone[z];
    e.t[z] = isnan(s.temperature) ? -32768 : (int16_t)lroundf(s.temperature * 100);
    e.c[z] = isnan(s.consigneEff) ? -32768 : (int16_t)lroundf(s.consigneEff * 100);
    e.d[z] = (uint8_t)lroundf(s.demande * 100);
    e.defauts |= (uint8_t)((s.defaut & 0x0F) << (z * 4));
  }
  Stockage::histAjouter(e);
}

void journaliserEtat() {
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    const ZoneEtat &s = ctrl.zone[z];
    Serial.printf("  %-12s %6.2f C -> %5.2f C  demande %3d%%  charge %3.0f%%  %s\n",
                  ctrl.cfg[z].nom, s.temperature, s.consigneEff,
                  (int)lroundf(s.demande * 100), ctrl.duty(z), nomDefaut(s.defaut));
  }
}

uint32_t secondesChauffeTotales(uint8_t z) { return g_secondesBase[z] + ctrl.zone[z].secondesChauffe; }

// Reporte les réglages globaux sur le contrôleur : puissance disponible et
// décalage saisonnier du jour.
void appliquerReglagesGlobaux() {
  const ReglagesGlobaux &g = Stockage::globaux();
  ctrl.limiterZones(Stockage::zonesSimultanees(g));
  ctrl.decalageSaison(g_heureFiable ? Stockage::decalageSaisonnier(g, (uint32_t)time(nullptr)) : 0.0f);
}

// ============================ SERVICES PARTAGÉS ==============================

String horodatage() {
  if (!g_heureFiable) return String("--------- --:--:--");
  time_t t = time(nullptr);
  struct tm tm;
  localtime_r(&t, &tm);
  char b[24];
  strftime(b, sizeof b, "%Y-%m-%d %H:%M:%S", &tm);
  return String(b);
}

bool heureFiable() { return g_heureFiable; }
bool heureApproximative() { return g_heureApprox; }

uint16_t minutesDuJour() {
  if (!g_heureFiable) return 0;
  time_t t = time(nullptr);
  struct tm tm;
  localtime_r(&t, &tm);
  return (uint16_t)(tm.tm_hour * 60 + tm.tm_min);
}

void journal(const char *fmt, ...) {
  char texte[220];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(texte, sizeof texte, fmt, ap);
  va_end(ap);
  const String ligne = horodatage() + " | " + texte;
  Serial.println(ligne);
  Stockage::journalAjouter(ligne);
}

// ============================ SETUP ==========================================

void setup() {
  // Couper toutes les sorties avant absolument tout le reste.
  for (uint8_t i = 0; i < NB_TAPIS; i++) {
    pinMode(PIN_TAPIS[i], OUTPUT);
    digitalWrite(PIN_TAPIS[i], LOW);
  }

  Serial.begin(115200);
  delay(300);
  Serial.println(F("\n=== Thermostat terrarium v3 — un seul tapis alimente a la fois ==="));

  Stockage::demarrer();
  if (!Stockage::systemeFichiersPret())
    Serial.println(F("LittleFS indisponible : ni historique, ni journal, ni file d'alertes."));

  sntp_set_time_sync_notification_cb(surSynchroNtp);
  restaurerHeure();
  journal("Demarrage — %s", raisonRedemarrage());

  String rapport;
  Stockage::chargerZones(ctrl.cfg, rapport);
  if (rapport.length()) journal("Reglages assainis au chargement : %s", rapport.c_str());
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    g_biaisPersistes[z] = Stockage::lireBiais(z);
    ctrl.zone[z].biais = g_biaisPersistes[z];
  }

  ctrl.demarrer(millis());
  ctrl.horloge(g_heureFiable, minutesDuJour());

  Stockage::chargerStats(g_stats);
  for (uint8_t z = 0; z < NB_ZONES; z++) g_secondesBase[z] = g_stats[z].secondesChauffe;
  appliquerReglagesGlobaux();
  journal("Firmware %s (%s) — %u zone(s) simultanee(s) pour %.1f A declares",
          FW_VERSION, FW_BUILD, ctrl.limiteZones(), Stockage::globaux().courantAlimA);

  Stockage::chargerDefauts(g_defautsPersistes);
  ctrl.appliquerDefautsRestaures(g_defautsPersistes);

  Sondes::demarrer();
  Affichage::demarrer();

  // Premier démarrage de cet appareil : on tire son secret et on l'affiche, car
  // c'est la seule preuve de propriété permettant de le rattacher à un compte.
  const bool premierDemarrage = Stockage::assurerJeton();
  if (premierDemarrage) {
    journal("Premier demarrage : code d'appairage genere");
    Serial.printf("\n=== CODE D'APPAIRAGE : %s ===\n"
                  "A noter maintenant. Retrouvable ensuite par la commande `jeton`.\n\n",
                  Stockage::reseau().jeton);
    Affichage::appairage(Stockage::reseau().jeton, 20);
  }

  Reseau::demarrer();

  // Watchdog : si loop() se fige, l'ESP32 redemarre, les GPIO repassent en
  // haute impedance et les pull-down de grille coupent les tapis.
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  esp_task_wdt_config_t wdt = {
    .timeout_ms     = (uint32_t)WDT_SECONDES * 1000,
    .idle_core_mask = 0,
    .trigger_panic  = true
  };
  esp_task_wdt_reconfigure(&wdt);
#else
  esp_task_wdt_init(WDT_SECONDES, true);
#endif
  esp_task_wdt_add(NULL);

  const uint32_t now = millis();
  tMesure = tLog = tHist = tEpoch = tAffichage = tBiais = tResync = now;
  traiterNotifications();
  Console::aide();
}

// ============================ LOOP ===========================================

void loop() {
  esp_task_wdt_reset();
  const uint32_t maintenant = millis();

  Console::boucle();
  Reseau::boucle(maintenant);   // jamais bloquant : la régulation tient sans réseau

  // --- mesures, en deux temps pour ne pas bloquer sur la conversion ---
  if (!conversionDemandee && maintenant - tMesure >= PERIODE_MESURE_MS) {
    Sondes::demanderConversion();
    conversionDemandee = true;
  }
  if (conversionDemandee && Sondes::conversionPrete(maintenant)) {
    conversionDemandee = false;
    const float dt = (maintenant - tMesure) / 1000.0f;
    tMesure = maintenant;
    ctrl.horloge(g_heureFiable, minutesDuJour());
    for (uint8_t z = 0; z < NB_ZONES; z++) ctrl.mesure(z, Sondes::lire(z), maintenant, dt);
  }

  // --- puissance ---
  ctrl.avancer(maintenant);
  appliquerSorties(ctrl.masqueTapis());

  traiterNotifications();

  // --- persistances périodiques ---
  if (maintenant - tHist >= PERIODE_HIST_MS)  { tHist = maintenant; enregistrerHistorique(); }
  if (maintenant - tEpoch >= PERIODE_EPOCH_MS) {
    tEpoch = maintenant;
    if (g_heureFiable) Stockage::sauverEpoch((uint32_t)time(nullptr));
  }
  if (maintenant - tBiais >= 1800000UL) {      // point de fonctionnement appris
    tBiais = maintenant;
    appliquerReglagesGlobaux();                // le décalage saisonnier évolue chaque jour
    for (uint8_t z = 0; z < NB_ZONES; z++) {
      g_stats[z].secondesChauffe = secondesChauffeTotales(z);
      for (uint8_t d = 0; d < 5; d++) g_stats[z].nbDefauts[d] = ctrl.zone[z].nbDefauts[d];
    }
    Stockage::sauverStats(g_stats);
    for (uint8_t z = 0; z < NB_ZONES; z++)
      if (fabsf(ctrl.zone[z].biais - g_biaisPersistes[z]) > 0.02f) {
        g_biaisPersistes[z] = ctrl.zone[z].biais;
        Stockage::sauverBiais(z, g_biaisPersistes[z]);
      }
  }

  if (maintenant - tResync >= 5000)          { tResync = maintenant; resynchroniserSorties(); }
  if (maintenant - tAffichage >= 1000)        { tAffichage = maintenant; Affichage::rafraichir(); }
  if (maintenant - tLog >= PERIODE_LOG_MS)    { tLog = maintenant; journaliserEtat(); }
}
