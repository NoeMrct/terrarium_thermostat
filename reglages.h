/* =============================================================================
   reglages.h — STRUCTURES DE RÉGLAGES ET LEURS RÈGLES
   -----------------------------------------------------------------------------
   Sans dépendance Arduino, comme controle.h : ce qui est écrit dans la NVS, les
   bornes qui le valident, la relecture tolérante d'une structure écrite par une
   autre version du firmware. Le même code tourne dans le firmware (stockage.cpp
   l'enveloppe de Preferences/LittleFS) et dans les bancs d'essai sur PC
   (sim/test-migration.cpp, sim/test-protocole.cpp).
   ============================================================================= */
#ifndef REGLAGES_H
#define REGLAGES_H

#include <stdint.h>
#include <stddef.h>
#include "controle.h"

// Réglages qui ne concernent pas une zone en particulier.
struct ReglagesGlobaux {
  float courantAlimA;       // ampérage de l'alimentation dédiée aux tapis
  float puissanceTapisW;    // puissance d'un tapis
  float tensionV;           // tension d'alimentation des tapis
  uint16_t maintenanceMin;  // durée par défaut d'une coupure d'entretien
  uint16_t ecranVeilleMin;  // extinction de l'écran (0 = jamais)
  // Cyclage saisonnier : descente progressive des consignes, plateau, remontée.
  bool saisonActive;
  float saisonDelta;  // abaissement total, en °C
  uint16_t saisonDescenteJ;
  uint16_t saisonPlateauJ;
  uint16_t saisonRemonteeJ;
  uint32_t saisonDebutEpoch;
};

struct StatsZone {
  uint32_t secondesChauffe;  // cumul depuis toujours, pour l'énergie
  uint16_t nbDefauts[5];
};

struct ReglagesReseau {
  char ssid[33];
  char motDePasse[65];
  char webUtilisateur[17];  // vide = interface web sans authentification
  char webHachage[65];      // SHA-256 de "utilisateur:mot de passe"
  bool verifierTls;         // vérifier les certificats des envois HTTPS
  char otaMotDePasse[33];
  char apMotDePasse[33];  // point d'accès de secours
  char urlAlertes[161];
  char urlHeartbeat[161];
  uint16_t heartbeatMinutes;
  char mqttHote[65];
  uint16_t mqttPort;
  char mqttUtilisateur[33];
  char mqttMotDePasse[65];
  char mqttPrefixe[33];
  bool mqttActif;
  bool mqttTls;  // MQTT chiffré (port 8883 par défaut)
  bool decouverteHA;
  // Secret tiré au hasard au premier démarrage. Sert d'identité de l'appareil
  // et de preuve de propriété lors de l'appairage à un compte.
  char jeton[25];
  char fuseau[48];
  char ntp[49];
  uint8_t sondeRom[NB_ZONES][8];  // adresses 1-Wire liées à chaque zone
  // ------------------------------------------------------------------------
  // TOUT AJOUT SE FAIT ICI, EN FIN DE STRUCTURE. La relecture est tolérante
  // (voir lireStructure() dans stockage.cpp) : un champ ajouté après coup
  // revient à zéro sur une mémoire écrite par une version antérieure, au lieu
  // de faire échouer la lecture entière et de tout réinitialiser.
  // ------------------------------------------------------------------------
  char alerteJeton[65];  // envoyé en « Authorization: Bearer … »
  // Forme des alertes envoyées à urlAlertes : 0 = JSON (serveur maison, Home
  // Assistant…), 1 = texte lisible avec en-têtes Title/Priority/Tags, ce que
  // lisent ntfy et les services de notification du même genre.
  uint8_t formatAlertes;
};

enum FormatAlertes : uint8_t { ALERTES_JSON = 0, ALERTES_TEXTE = 1 };

// Dernière mise à jour du firmware, telle que le socle s'en souvient d'un
// redémarrage à l'autre : c'est ce que lisent le sujet « sante », le diagnostic
// de l'application et la console. Une image téléchargée passe par
// EN_VALIDATION au premier démarrage, puis VALIDEE ; si elle plante avant, le
// chargeur relance l'ancienne, qui constate le RETOUR_ARRIERE.
enum EtapeMaj : uint8_t {
  MAJ_AUCUNE = 0,
  MAJ_EN_VALIDATION = 1,
  MAJ_VALIDEE = 2,
  MAJ_RETOUR_ARRIERE = 3,
  MAJ_ECHEC = 4
};
struct EtatMaj {
  uint8_t etape;
  char version[16];  // version visée, ou installée
  char detail[80];   // raison d'un échec, date de validation…
};
const char *nomEtapeMaj(uint8_t etape);

namespace Stockage {

void reglagesGlobauxParDefaut(ReglagesGlobaux &g);
// Validation stricte, pour refuser une saisie sans rien modifier — même règle
// que reglagesValides() pour les zones : les contrôles vivent à un seul endroit
// et servent l'interface web, la console et le canal MQTT.
bool globauxValides(const ReglagesGlobaux &g, char *erreur, size_t taille);
// Corrige en place toute valeur aberrante (mémoire abîmée). true si corrigé.
bool assainirGlobaux(ReglagesGlobaux &g);
// Nombre de zones pouvant chauffer en même temps, déduit de l'alimentation.
uint8_t zonesSimultanees(const ReglagesGlobaux &g);
// Décalage de consigne du jour, en °C (négatif). 0 si le cyclage est inactif.
float decalageSaisonnier(const ReglagesGlobaux &g, uint32_t maintenantEpoch);

// Relecture tolérante d'une structure persistée. Règle du projet : ces
// structures ne s'agrandissent QUE par la fin. Un firmware plus récent relit
// alors sans peine une mémoire écrite par l'ancien — les champs ajoutés restent
// à zéro, puis reçoivent leur valeur par défaut. Une mémoire écrite par un
// firmware PLUS récent (retour en arrière) n'est lue que sur le préfixe connu.
// `dest` est d'abord mis à zéro. Renvoie le nombre d'octets utiles copiés
// (0 : rien d'exploitable).
size_t relireTolerant(const uint8_t *source, size_t disponible, void *dest, size_t taille);

}  // namespace Stockage

#endif  // REGLAGES_H
