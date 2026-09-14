/* stockage.h — persistance : NVS pour les réglages, LittleFS pour l'historique,
   le journal et la file d'alertes en attente d'envoi. */
#ifndef STOCKAGE_H
#define STOCKAGE_H

#include "config.h"

// Réglages qui ne concernent pas une zone en particulier.
struct ReglagesGlobaux {
  float    courantAlimA;      // ampérage de l'alimentation dédiée aux tapis
  float    puissanceTapisW;   // puissance d'un tapis
  float    tensionV;          // tension d'alimentation des tapis
  uint16_t maintenanceMin;    // durée par défaut d'une coupure d'entretien
  uint16_t ecranVeilleMin;    // extinction de l'écran (0 = jamais)
  // Cyclage saisonnier : descente progressive des consignes, plateau, remontée.
  bool     saisonActive;
  float    saisonDelta;       // abaissement total, en °C
  uint16_t saisonDescenteJ;
  uint16_t saisonPlateauJ;
  uint16_t saisonRemonteeJ;
  uint32_t saisonDebutEpoch;
};

struct StatsZone {
  uint32_t secondesChauffe;   // cumul depuis toujours, pour l'énergie
  uint16_t nbDefauts[5];
};

struct ReglagesReseau {
  char     ssid[33];
  char     motDePasse[65];
  char     webUtilisateur[17];      // vide = interface web sans authentification
  char     webHachage[65];          // SHA-256 de "utilisateur:mot de passe"
  bool     verifierTls;             // vérifier les certificats des envois HTTPS
  char     otaMotDePasse[33];
  char     apMotDePasse[33];        // point d'accès de secours
  char     urlAlertes[161];
  char     urlHeartbeat[161];
  uint16_t heartbeatMinutes;
  char     mqttHote[65];
  uint16_t mqttPort;
  char     mqttUtilisateur[33];
  char     mqttMotDePasse[65];
  char     mqttPrefixe[33];
  bool     mqttActif;
  bool     mqttTls;                 // MQTT chiffré (port 8883 par défaut)
  bool     decouverteHA;
  // Secret tiré au hasard au premier démarrage. Sert d'identité de l'appareil
  // et de preuve de propriété lors de l'appairage à un compte.
  char     jeton[25];
  char     fuseau[48];
  char     ntp[49];
  uint8_t  sondeRom[NB_ZONES][8];   // adresses 1-Wire liées à chaque zone
  // ------------------------------------------------------------------------
  // TOUT AJOUT SE FAIT ICI, EN FIN DE STRUCTURE. La relecture est tolérante
  // (voir lireStructure() dans stockage.cpp) : un champ ajouté après coup
  // revient à zéro sur une mémoire écrite par une version antérieure, au lieu
  // de faire échouer la lecture entière et de tout réinitialiser.
  // ------------------------------------------------------------------------
  char     alerteJeton[65];         // envoyé en « Authorization: Bearer … »
};

namespace Stockage {

void demarrer();                                     // monte LittleFS, ouvre la NVS
bool systemeFichiersPret();

// --- réglages de zones ---
void chargerZones(ReglagesZone cfg[NB_ZONES], String &rapportCorrections);
void sauverZone(uint8_t z, const ReglagesZone &r);

// --- défauts verrouillés : ils doivent survivre à un redémarrage ---
void chargerDefauts(uint8_t d[NB_ZONES]);
void sauverDefauts(const uint8_t d[NB_ZONES]);

// --- point de fonctionnement appris ---
float lireBiais(uint8_t z);
void  sauverBiais(uint8_t z, float b);

// --- horloge de secours ---
uint32_t lireEpoch();
void     sauverEpoch(uint32_t e);

// --- réglages réseau et globaux ---
ReglagesReseau &reseau();
void sauverReseau();
ReglagesGlobaux &globaux();
void sauverGlobaux();
void reglagesGlobauxParDefaut(ReglagesGlobaux &g);
// Validation stricte, pour refuser une saisie sans rien modifier — même règle
// que reglagesValides() pour les zones : les contrôles vivent à un seul endroit
// et servent l'interface web, la console et le canal MQTT.
bool globauxValides(const ReglagesGlobaux &g, char *erreur, size_t taille);
// Corrige en place toute valeur aberrante (mémoire abîmée). true si corrigé.
bool assainirGlobaux(ReglagesGlobaux &g);
// Génère un jeton s'il n'en existe pas encore. Renvoie true si un nouveau a
// été créé (c'est alors le premier démarrage de cet appareil).
bool assurerJeton();
void regenererJeton();
// Nombre de zones pouvant chauffer en même temps, déduit de l'alimentation.
uint8_t zonesSimultanees(const ReglagesGlobaux &g);
// Décalage de consigne du jour, en °C (négatif). 0 si le cyclage est inactif.
float   decalageSaisonnier(const ReglagesGlobaux &g, uint32_t maintenantEpoch);

// --- statistiques cumulées ---
void chargerStats(StatsZone s[NB_ZONES]);
void sauverStats(const StatsZone s[NB_ZONES]);

// --- historique circulaire ---
void     histAjouter(const Echantillon &e);
uint32_t histNombre();
uint32_t histCapacite();
void     histEffacer();

// Parcours en gardant le fichier ouvert : indispensable pour l'export, où
// rouvrir le fichier à chaque point coûtait une ouverture LittleFS par
// échantillon (plusieurs milliers pour un export complet).
typedef bool (*VisiteurHist)(const Echantillon &e, void *contexte);
void     histParcourir(uint32_t rangDebut, uint32_t pas, VisiteurHist visiteur, void *contexte);

// --- journal d'événements ---
void   journalAjouter(const String &ligne);
String journalQueue(size_t maxOctets);              // fin du fichier
void   journalEffacer();

// --- file d'alertes persistante ---
void   alerteEmpiler(const String &texte);
bool   alerteTete(String &texte);
void   alerteDefiler();
uint16_t alertesEnAttente();

} // namespace Stockage

#endif // STOCKAGE_H
