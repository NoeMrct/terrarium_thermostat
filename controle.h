/* =============================================================================
   controle.h — CŒUR DE RÉGULATION
   -----------------------------------------------------------------------------
   Ce fichier et son .cpp ne dépendent PAS d'Arduino : pas de millis(), pas de
   Serial, pas de GPIO. Tout entre par des paramètres et sort par des accesseurs.

   Conséquence : le même code tourne dans le firmware ET dans le banc de
   simulation sur PC (dossier sim/), où l'on peut rejouer une nuit froide en
   quelques secondes et vérifier le partage entre zones, l'autotune ou le
   comportement en cas de sonde débranchée — sans toucher au terrarium.
   ============================================================================= */
#ifndef CONTROLE_H
#define CONTROLE_H

#include <stdint.h>
#include <stddef.h>
#include <math.h>

static const uint8_t NB_ZONES = 2;
static const uint8_t NB_TAPIS = 2;

// Quel tapis chauffe quelle zone (défini dans controle.cpp).
// Une zone peut en compter plusieurs : l'ordonnanceur les alterne. Ici un seul
// par zone, c'est ce qui est physiquement câblé.
extern const uint8_t ZONE_DE_TAPIS[NB_TAPIS];

// Fenêtre glissante du taux de charge : 20 seaux de 30 s = 10 min
static const uint8_t  NB_SEAUX      = 20;
static const uint32_t SEAU_MS       = 30000;
static const uint32_t CRENEAU_MS    = 30000;   // durée d'un créneau d'ordonnancement
static const uint32_t MIN_OFF_MS    = 30000;   // repos souhaité entre 2 allumages d'un tapis

// Bornes de sécurité, appliquées d'où que viennent les réglages
static const float CONSIGNE_MIN = 10.0f, CONSIGNE_MAX = 45.0f;
static const float BANDE_MIN    = 0.2f,  BANDE_MAX    = 10.0f;
static const float TEMPMAX_MIN  = 20.0f, TEMPMAX_MAX  = 55.0f;
static const float OFFSET_ABS   = 5.0f;

// Limite de puissance : nombre maximal de zones alimentées en même temps.
// Déduit de l'ampérage déclaré de l'alimentation ; 1 reproduit le comportement
// d'origine (un seul tapis à la fois, ~1,7 A).
static const uint8_t MAX_ZONES_DEFAUT = 1;

// Diagnostics capteur
static const float    VALEUR_RESET_DS18B20  = 85.0f;  // registre non initialisé
static const uint8_t  MAX_LECTURES_INVALIDES = 3;
static const float    TEMP_MIN_PLAUSIBLE    = 0.0f;
static const float    TEMP_MAX_PLAUSIBLE    = 60.0f;
static const uint32_t FIGE_ALERTE_MS        = 900000;   // 15 min -> avertissement
static const uint32_t FIGE_DEFAUT_MS        = 1800000;  // 30 min -> coupure

// Autotune. Le relais bascule avec une hystérésis nettement supérieure au pas
// de quantification du DS18B20 (0,0625 °C) : sans elle, il commuterait sur le
// bruit de mesure et identifierait un gain ultime absurdement élevé.
static const float AUTOTUNE_HYST      = 0.30f;  // °C de part et d'autre de la consigne
static const float AUTOTUNE_BANDE_MIN = 0.50f;  // plancher, pour éviter le chattering
static const float AUTOTUNE_KI_MAX    = 0.005f;
static const float AUTOTUNE_MARGE_KP  = 0.35f;  // plus prudent que les 0,45 de Ziegler-Nichols

// ---------------------------------------------------------------------------
// DEF_INEFFICACE n'est plus déclenché : le diagnostic « chauffe sans effet »
// est devenu une alerte. La valeur reste définie pour pouvoir relire un défaut
// enregistré par une version antérieure.
enum Defaut : uint8_t {
  DEF_AUCUN = 0, DEF_SONDE, DEF_SURCHAUFFE, DEF_FIGE, DEF_INEFFICACE
};
const char* nomDefaut(Defaut d);

enum EtatAutotune : uint8_t { AT_INACTIF = 0, AT_ATTENTE, AT_OSCILLE, AT_FINI, AT_ECHEC };

// Réglages persistants d'une zone. Copiés tels quels en NVS (putBytes).
struct ReglagesZone {
  char     nom[18];
  float    consigneJour;
  float    consigneNuit;
  float    bande;              // bande proportionnelle (°C)
  float    ki;                 // gain intégral (par seconde et par °C)
  float    tempMax;            // coupure absolue
  float    offset;             // calibration de la sonde (°C ajoutés)
  uint16_t debutJour;          // minutes depuis minuit
  uint16_t debutNuit;
  uint16_t rampeMinutes;       // transition douce jour <-> nuit
  uint16_t inefficaceMinutes;  // chauffe cumulée sans effet -> défaut
  float    inefficaceDelta;    // hausse minimale attendue pendant ce délai (°C)
  float    deriveSeuil;        // écart sous consigne considéré comme dérive
  uint16_t deriveMinutes;      // durée avant alerte de dérive
  float    chuteSeuil;         // chute brutale (°C) considérée comme anormale
  uint16_t chuteSecondes;      // fenêtre d'observation de la chute
};

void reglagesParDefaut(ReglagesZone &r, uint8_t zone);
// Corrige en place toute valeur aberrante (NVS corrompue, saisie douteuse).
// Renvoie true si quelque chose a dû être corrigé.
bool assainirReglages(ReglagesZone &r, uint8_t zone, char *rapport, size_t taille);
// Validation stricte, pour refuser une saisie utilisateur sans rien modifier.
bool reglagesValides(const ReglagesZone &r, char *erreur, size_t taille);

// ---------------------------------------------------------------------------
enum TypeNotif : uint8_t {
  NOTIF_DEFAUT = 0, NOTIF_RETABLI, NOTIF_DERIVE, NOTIF_DERIVE_FIN,
  NOTIF_SONDE_FIGEE, NOTIF_AUTOTUNE, NOTIF_CHUTE, NOTIF_SANS_EFFET, NOTIF_INFO
};

struct Notification {
  TypeNotif type;
  uint8_t   zone;          // 0xFF = système
  char      texte[176];
};

// Étiquette courte d'un type de notification, telle qu'elle part dans les
// alertes sortantes : elle permet à un serveur de trier sans analyser le texte.
const char* nomNotification(TypeNotif t);

// ---------------------------------------------------------------------------
struct ZoneEtat {
  float  brute        = NAN;   // lecture capteur telle quelle
  float  temperature  = NAN;   // après offset de calibration
  float  consigneEff  = NAN;   // consigne courante (rampe incluse)
  float  demande      = 0.0f;          // 0..1, part de temps de chauffe demandée
  float  integrale    = 0.0f;
  float  biais        = 0.0f;          // point de fonctionnement appris
  Defaut defaut       = DEF_AUCUN;
  bool   heureConnue  = false;

  // ordonnancement
  float    credit        = 0.0f;
  uint8_t  prochainTapis = 0;
  uint32_t seaux[NB_SEAUX] = { 0 };
  uint32_t indexSeau     = 0;

  // diagnostic sonde figée
  float    derniereBrute = NAN;
  uint32_t msFigee       = 0;
  bool     figeSignale   = false;

  // diagnostic chauffe sans effet — alerte, jamais coupure (voir controle.cpp)
  bool     episodeActif      = false;
  float    tempRefEpisode    = NAN;
  uint32_t msChauffeEpisode  = 0;
  bool     sansEffetSignale  = false;

  // dérive douce
  uint32_t msDerive     = 0;
  bool     deriveActive = false;

  uint8_t  lecturesInvalides = 0;
  bool     cfgModifie        = false;   // l'autotune a réécrit les gains : à sauvegarder

  // détection de chute brutale (porte ouverte, tapis débranché)
  float    tempChute     = NAN;
  uint32_t msChute       = 0;
  bool     chuteSignalee = false;

  // compteurs cumulés, pour distinguer un incident isolé d'un problème récurrent
  uint16_t nbDefauts[5] = { 0, 0, 0, 0, 0 };
  uint32_t secondesChauffe = 0;         // cumul, sert au calcul d'énergie
  uint32_t msChauffeReste  = 0;         // millisecondes pas encore converties en
                                        // secondes (voir comptabiliser())

  // autotune (relais d'Åström-Hägglund)
  EtatAutotune autotune = AT_INACTIF;
  bool     relaisHaut   = false;
  uint32_t atDebut = 0, atDernierPassage = 0;
  float    atMax = 0, atMin = 0;
  float    atSommePeriodes = 0, atSommeAmplitudes = 0;
  uint8_t  atCycles = 0;
};

// ---------------------------------------------------------------------------
class Controleur {
public:
  ReglagesZone cfg[NB_ZONES];
  ZoneEtat     zone[NB_ZONES];

  void     demarrer(uint32_t nowMs);

  // Horloge murale : sert au cycle jour/nuit. heureConnue=false -> consigne de jour.
  void     horloge(bool connue, uint16_t minutes);

  // Une mesure brute de sonde (°C), dtSec = temps depuis la mesure précédente.
  void     mesure(uint8_t z, float brute, uint32_t nowMs, float dtSec);

  // À appeler à chaque tour de boucle : comptabilise la chauffe puis ordonnance.
  void     avancer(uint32_t nowMs);

  // Un tapis au plus par zone (la puissance vue par la régulation reste
  // constante), et au plus `maxZones` zones simultanément.
  bool     tapisAllume(uint8_t tapis) const;
  uint8_t  masqueTapis() const;                    // un bit par tapis
  int8_t   tapisActif() const;                     // premier tapis allumé, ou -1
  int8_t   tapisDeZone(uint8_t z) const { return m_tapisDeZone[z]; }
  void     limiterZones(uint8_t maxZones);
  uint8_t  limiteZones() const { return m_maxZones; }

  // Décalage saisonnier appliqué à toutes les consignes (valeur négative pour
  // une descente progressive). Calculé à l'extérieur, où l'on connaît la date.
  void     decalageSaison(float degres) { m_saison = degres; }
  float    decalageSaison() const { return m_saison; }

  // Arrêt temporaire pour intervention : reprise automatique à l'échéance.
  void     maintenance(uint32_t nowMs, uint16_t minutes);
  bool     enMaintenance() const { return m_maintenanceFin != 0; }
  uint32_t maintenanceRestanteMs(uint32_t nowMs) const;
  float    duty(uint8_t z) const;                 // % sur fenêtre glissante
  bool     prendreNotification(Notification &n);  // file FIFO à vider

  // `compter` = false pour un verrouillage volontaire (commande `off`) : il ne
  // doit pas grossir les compteurs de pannes des statistiques.
  void     declencherDefaut(uint8_t z, Defaut d, uint32_t nowMs, bool compter = true);
  void     leverDefauts(uint32_t nowMs);
  void     appliquerDefautsRestaures(const uint8_t d[NB_ZONES]);
  void     suspendre(bool actif) { m_suspendu = actif; }   // OTA, arrêt manuel

  bool     lancerAutotune(uint8_t z, uint32_t nowMs, char *erreur, size_t taille);
  void     arreterAutotune(uint8_t z);

  float    consignePour(uint8_t z) const;         // consigne courante calculée

private:
  void     notifier(TypeNotif t, uint8_t z, const char *fmt, ...);
  void     comptabiliser(uint32_t nowMs, uint32_t delta);
  void     ordonnancer(uint32_t nowMs);
  int8_t   choisirTapis(uint8_t z, uint32_t nowMs);
  void     majAutotune(uint8_t z, uint32_t nowMs);

  int8_t   m_tapisDeZone[NB_ZONES] = { -1, -1 };
  uint8_t  m_maxZones     = MAX_ZONES_DEFAUT;
  float    m_saison       = 0.0f;
  uint32_t m_maintenanceFin = 0;
  uint32_t m_debutCreneau = 0;
  uint32_t m_dernierAvance = 0;
  uint32_t m_dernierOff[NB_TAPIS] = { 0 };
  bool     m_suspendu     = false;
  bool     m_heureConnue  = false;
  uint16_t m_minutes      = 0;

  Notification m_file[10] = {};
  uint8_t  m_nbNotifs = 0;
};

#endif // CONTROLE_H
