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
static const uint8_t NB_SEAUX = 20;
static const uint32_t SEAU_MS = 30000;
static const uint32_t CRENEAU_MS = 30000;  // durée d'un créneau d'ordonnancement
static const uint32_t MIN_OFF_MS = 30000;  // repos souhaité entre 2 allumages d'un tapis

// Bornes de sécurité, appliquées d'où que viennent les réglages
static const float CONSIGNE_MIN = 10.0f, CONSIGNE_MAX = 45.0f;
static const float BANDE_MIN = 0.2f, BANDE_MAX = 10.0f;
static const float TEMPMAX_MIN = 20.0f, TEMPMAX_MAX = 55.0f;
static const float OFFSET_ABS = 5.0f;

// Limite de puissance : nombre maximal de zones alimentées en même temps.
// Déduit de l'ampérage déclaré de l'alimentation ; 1 reproduit le comportement
// d'origine (un seul tapis à la fois, ~1,7 A).
static const uint8_t MAX_ZONES_DEFAUT = 1;

// Diagnostics capteur
static const float VALEUR_RESET_DS18B20 = 85.0f;  // registre non initialisé
static const uint8_t MAX_LECTURES_INVALIDES = 3;
static const float TEMP_MIN_PLAUSIBLE = 0.0f;
static const float TEMP_MAX_PLAUSIBLE = 60.0f;
static const uint32_t FIGE_ALERTE_MS = 900000;   // 15 min -> avertissement
static const uint32_t FIGE_DEFAUT_MS = 1800000;  // 30 min -> coupure
// Saut aberrant : une sonde posée sur une plaque ne gagne ni ne perd 4 °C en
// 2 s. Une lecture isolée de ce genre (bit faux sur un long câble) est ignorée ;
// répétée SAUT_CONFIRMATIONS fois, elle devient la nouvelle mesure.
static const float SAUT_MAX = 4.0f;
static const uint8_t SAUT_CONFIRMATIONS = 3;

// Autotune. Le relais bascule avec une hystérésis nettement supérieure au pas
// de quantification du DS18B20 (0,0625 °C) : sans elle, il commuterait sur le
// bruit de mesure et identifierait un gain ultime absurdement élevé.
static const float AUTOTUNE_HYST = 0.30f;       // °C de part et d'autre de la consigne
static const float AUTOTUNE_BANDE_MIN = 0.50f;  // plancher, pour éviter le chattering
static const float AUTOTUNE_KI_MAX = 0.005f;
static const float AUTOTUNE_MARGE_KP = 0.35f;  // plus prudent que les 0,45 de Ziegler-Nichols

// Contrôle croisé des sondes. Une seule zone chauffe à la fois la plupart du
// temps : la chaleur d'un tapis doit donc arriver sur la sonde de SA zone. Si
// une zone pousse à fond sans que sa sonde bouge, pendant que la sonde d'une
// zone qui ne chauffe pas prend de la chaleur, les sondes sont inversées (ou
// posées sur la mauvaise plaque) : le tapis chaufferait alors sans limite,
// jusqu'au bilame.
static const uint32_t CROISE_CHAUFFE_MS = 360000;  // 6 min de chauffe effective
static const float CROISE_DEMANDE_MIN = 0.9f;      // la zone demande toute la puissance
static const float CROISE_ECART_MIN = 0.5f;        // °C sous sa consigne
static const float CROISE_REPONSE = 0.5f;          // sa sonde gagne autant : le tapis agit
static const float CROISE_HAUSSE_AUTRE = 1.5f;     // ce que prend la sonde de l'autre zone

// ---------------------------------------------------------------------------
// DEF_INEFFICACE : la chauffe d'une zone n'agit pas sur sa sonde mais sur celle
// d'une autre (contrôle croisé ci-dessus). Le simple constat « je chauffe et ça
// ne monte pas » reste une alerte (NOTIF_SANS_EFFET) : seul, il ne prouve rien.
enum Defaut : uint8_t { DEF_AUCUN = 0, DEF_SONDE, DEF_SURCHAUFFE, DEF_FIGE, DEF_INEFFICACE };
const char *nomDefaut(Defaut d);

enum EtatAutotune : uint8_t { AT_INACTIF = 0, AT_ATTENTE, AT_OSCILLE, AT_FINI, AT_ECHEC };

// Réglages persistants d'une zone. Copiés tels quels en NVS (putBytes).
struct ReglagesZone {
  char nom[18];
  float consigneJour;
  float consigneNuit;
  float bande;         // bande proportionnelle (°C)
  float ki;            // gain intégral (par seconde et par °C)
  float tempMax;       // coupure absolue
  float offset;        // calibration de la sonde (°C ajoutés)
  uint16_t debutJour;  // minutes depuis minuit
  uint16_t debutNuit;
  uint16_t rampeMinutes;       // transition douce jour <-> nuit
  uint16_t inefficaceMinutes;  // chauffe cumulée sans effet -> défaut
  float inefficaceDelta;       // hausse minimale attendue pendant ce délai (°C)
  float deriveSeuil;           // écart sous consigne considéré comme dérive
  uint16_t deriveMinutes;      // durée avant alerte de dérive
  float chuteSeuil;            // chute brutale (°C) considérée comme anormale
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
  NOTIF_DEFAUT = 0,
  NOTIF_RETABLI,
  NOTIF_DERIVE,
  NOTIF_DERIVE_FIN,
  NOTIF_SONDE_FIGEE,
  NOTIF_AUTOTUNE,
  NOTIF_CHUTE,
  NOTIF_SANS_EFFET,
  NOTIF_INFO,
  NOTIF_RAPPORT,    // rapport quotidien : priorité basse, jamais étouffé par une autre info
  NOTIF_TROP_CHAUD  // au-dessus de la consigne sans chauffer : la chauffe n'y peut rien
};

struct Notification {
  TypeNotif type;
  uint8_t zone;  // 0xFF = système
  char texte[176];
};

// Étiquette courte d'un type de notification, telle qu'elle part dans les
// alertes sortantes : elle permet à un serveur de trier sans analyser le texte.
const char *nomNotification(TypeNotif t);

// ---------------------------------------------------------------------------
struct ZoneEtat {
  float brute = NAN;        // lecture capteur telle quelle
  float temperature = NAN;  // après offset de calibration
  float consigneEff = NAN;  // consigne courante (rampe incluse)
  float demande = 0.0f;     // 0..1, part de temps de chauffe demandée
  float integrale = 0.0f;
  float biais = 0.0f;  // point de fonctionnement appris
  Defaut defaut = DEF_AUCUN;
  bool heureConnue = false;

  // ordonnancement
  float credit = 0.0f;
  uint8_t prochainTapis = 0;
  uint32_t seaux[NB_SEAUX] = { 0 };
  uint32_t indexSeau = 0;

  // diagnostic sonde figée
  float derniereBrute = NAN;
  uint32_t msFigee = 0;
  bool figeSignale = false;

  // diagnostic chauffe sans effet — alerte, jamais coupure (voir controle.cpp)
  bool episodeActif = false;
  float tempRefEpisode = NAN;
  uint32_t msChauffeEpisode = 0;
  bool sansEffetSignale = false;

  // contrôle croisé : fenêtre ouverte quand la zone pousse à fond
  bool croiseOuvert = false;
  float croiseRef[NB_ZONES] = { NAN, NAN };     // températures des zones à l'ouverture
  uint32_t croiseMsChauffe = 0;                 // chauffe de cette zone depuis
  uint32_t croiseMsAutre[NB_ZONES] = { 0, 0 };  // chauffe des autres zones depuis

  // dérive douce
  uint32_t msDerive = 0;
  bool deriveActive = false;

  uint8_t lecturesInvalides = 0;
  uint8_t sautsConsecutifs = 0;  // lectures écartées pour saut aberrant
  bool cfgModifie = false;       // l'autotune a réécrit les gains : à sauvegarder

  // trop chaud sans chauffer (canicule, soleil, lampe) : alerte seulement
  uint32_t msTropChaud = 0;
  bool tropChaudActif = false;

  // détection de chute brutale (porte ouverte, tapis débranché)
  float tempChute = NAN;
  uint32_t msChute = 0;
  bool chuteSignalee = false;

  // compteurs cumulés, pour distinguer un incident isolé d'un problème récurrent
  uint16_t nbDefauts[5] = { 0, 0, 0, 0, 0 };
  uint32_t secondesChauffe = 0;  // cumul, sert au calcul d'énergie
  uint32_t msChauffeReste = 0;   // millisecondes pas encore converties en
                                 // secondes (voir comptabiliser())

  // autotune (relais d'Åström-Hägglund)
  EtatAutotune autotune = AT_INACTIF;
  bool relaisHaut = false;
  uint32_t atDebut = 0, atDernierPassage = 0;
  float atMax = 0, atMin = 0;
  float atSommePeriodes = 0, atSommeAmplitudes = 0;
  uint8_t atCycles = 0;
};

// ---------------------------------------------------------------------------
class Controleur {
public:
  ReglagesZone cfg[NB_ZONES];
  ZoneEtat zone[NB_ZONES];

  void demarrer(uint32_t nowMs);

  // Horloge murale : sert au cycle jour/nuit. heureConnue=false -> consigne de jour.
  void horloge(bool connue, uint16_t minutes);

  // Une mesure brute de sonde (°C), dtSec = temps depuis la mesure précédente.
  void mesure(uint8_t z, float brute, uint32_t nowMs, float dtSec);

  // À appeler à chaque tour de boucle : comptabilise la chauffe puis ordonnance.
  void avancer(uint32_t nowMs);

  // Un tapis au plus par zone (la puissance vue par la régulation reste
  // constante), et au plus `maxZones` zones simultanément.
  bool tapisAllume(uint8_t tapis) const;
  uint8_t masqueTapis() const;  // un bit par tapis
  int8_t tapisActif() const;    // premier tapis allumé, ou -1
  int8_t tapisDeZone(uint8_t z) const { return m_tapisDeZone[z]; }
  void limiterZones(uint8_t maxZones);
  uint8_t limiteZones() const { return m_maxZones; }

  // Décalage saisonnier appliqué à toutes les consignes (valeur négative pour
  // une descente progressive). Calculé à l'extérieur, où l'on connaît la date.
  // Borné et fini quoi qu'il arrive : une valeur aberrante venue de la flash ne
  // doit pas pouvoir déplacer les consignes hors de toute raison.
  void decalageSaison(float degres) {
    m_saison = !(degres == degres) ? 0.0f : (degres < -20.0f ? -20.0f : (degres > 20.0f ? 20.0f : degres));
  }
  float decalageSaison() const { return m_saison; }

  // Arrêt temporaire pour intervention : reprise automatique à l'échéance.
  void maintenance(uint32_t nowMs, uint16_t minutes);
  bool enMaintenance() const { return m_maintenanceFin != 0; }
  uint32_t maintenanceRestanteMs(uint32_t nowMs) const;
  float duty(uint8_t z) const;                // % sur fenêtre glissante
  bool prendreNotification(Notification &n);  // file FIFO à vider

  // `compter` = false pour un verrouillage volontaire (commande `off`) : il ne
  // doit pas grossir les compteurs de pannes des statistiques. `detail` complète
  // la notification quand le nom du défaut ne suffit pas à comprendre.
  void declencherDefaut(uint8_t z, Defaut d, uint32_t nowMs, bool compter = true,
                        const char *detail = nullptr);
  void leverDefauts(uint32_t nowMs);
  void appliquerDefautsRestaures(const uint8_t d[NB_ZONES]);
  // Les sondes viennent d'être manipulées volontairement (identification,
  // nouvelle liaison) : les diagnostics qui comparent une mesure à une mesure
  // antérieure repartent de zéro, au lieu d'y voir une chute ou une inversion.
  void oublierMesures();
  void suspendre(bool actif) { m_suspendu = actif; }  // OTA, arrêt manuel

  bool lancerAutotune(uint8_t z, uint32_t nowMs, char *erreur, size_t taille);
  void arreterAutotune(uint8_t z);

  float consignePour(uint8_t z) const;  // consigne courante calculée

  // Jour et nuit calés sur le soleil : lever et coucher du jour (minutes
  // locales), qui remplacent les horaires fixes de toutes les zones. Les
  // réglages enregistrés ne sont pas touchés : désactiver rend les horaires fixes.
  void horairesSoleil(bool actif, uint16_t lever, uint16_t coucher);
  bool soleilActif() const { return m_soleilActif; }
  uint16_t debutJour(uint8_t z) const { return m_soleilActif ? m_lever : cfg[z].debutJour; }
  uint16_t debutNuit(uint8_t z) const { return m_soleilActif ? m_coucher : cfg[z].debutNuit; }

  // Zone servie en priorité quand l'alimentation n'alimente pas tout le monde :
  // elle gagne ses créneaux deux fois plus vite. -1 = aucune.
  void zonePrioritaire(int8_t z) { m_prioritaire = (z >= 0 && z < (int8_t)NB_ZONES) ? z : -1; }
  int8_t zonePrioritaire() const { return m_prioritaire; }

  // Essai de chauffe (mise en service) : la zone chauffe seule, à pleine
  // puissance, pendant `ms` au plus. Les coupures de sécurité restent actives.
  bool forcerChauffe(uint8_t z, uint32_t nowMs, uint32_t ms);
  void arreterForcage() { m_forcee = -1; }
  int8_t zoneForcee() const { return m_forcee; }

private:
  void notifier(TypeNotif t, uint8_t z, const char *fmt, ...);
  void comptabiliser(uint32_t nowMs, uint32_t delta);
  void ordonnancer(uint32_t nowMs);
  int8_t choisirTapis(uint8_t z, uint32_t nowMs);
  void majAutotune(uint8_t z, uint32_t nowMs);
  void ouvrirCroisement(uint8_t z);
  void verifierCroisement(uint8_t z, uint32_t nowMs);

  int8_t m_tapisDeZone[NB_ZONES] = { -1, -1 };
  uint8_t m_maxZones = MAX_ZONES_DEFAUT;
  float m_saison = 0.0f;
  uint32_t m_maintenanceFin = 0;
  uint32_t m_debutCreneau = 0;
  bool m_soleilActif = false;
  uint16_t m_lever = 8 * 60, m_coucher = 20 * 60;
  int8_t m_prioritaire = -1;
  int8_t m_forcee = -1;
  uint32_t m_forceFin = 0;
  uint32_t m_dernierAvance = 0;
  uint32_t m_dernierOff[NB_TAPIS] = { 0 };
  bool m_suspendu = false;
  bool m_heureConnue = false;
  uint16_t m_minutes = 0;

  Notification m_file[10] = {};
  uint8_t m_nbNotifs = 0;
};

#endif  // CONTROLE_H
