/* stockage.h — persistance : NVS pour les réglages, LittleFS pour l'historique,
   le journal et la file d'alertes en attente d'envoi. */
#ifndef STOCKAGE_H
#define STOCKAGE_H

#include "config.h"
#include "reglages.h"  // structures de réglages et leurs règles, testables sur PC

namespace Stockage {

void demarrer();  // monte LittleFS, ouvre la NVS
bool systemeFichiersPret();
size_t espaceLibreFichiers();  // octets libres du système de fichiers
bool testNvs();                // écriture + relecture (test usine)

// --- réglages de zones ---
void chargerZones(ReglagesZone cfg[NB_ZONES], String &rapportCorrections);
void sauverZone(uint8_t z, const ReglagesZone &r);

// --- défauts verrouillés : ils doivent survivre à un redémarrage ---
void chargerDefauts(uint8_t d[NB_ZONES]);
void sauverDefauts(const uint8_t d[NB_ZONES]);

// --- point de fonctionnement appris ---
float lireBiais(uint8_t z);
void sauverBiais(uint8_t z, float b);

// --- horloge de secours ---
uint32_t lireEpoch();
void sauverEpoch(uint32_t e);

// --- réglages réseau et globaux ---
ReglagesReseau &reseau();
void sauverReseau();
ReglagesGlobaux &globaux();
void sauverGlobaux();
// Génère un jeton s'il n'en existe pas encore. Renvoie true si un nouveau a
// été créé (c'est alors le premier démarrage de cet appareil).
bool assurerJeton();
void regenererJeton();

// --- dernière mise à jour du firmware (NVS) ---
EtatMaj &etatMaj();
void sauverEtatMaj();

// --- statistiques cumulées ---
void chargerStats(StatsZone s[NB_ZONES]);
void sauverStats(const StatsZone s[NB_ZONES]);

// --- historique circulaire ---
void histAjouter(const Echantillon &e);
uint32_t histNombre();
uint32_t histCapacite();
void histEffacer();

// Parcours en gardant le fichier ouvert : indispensable pour l'export, où
// rouvrir le fichier à chaque point coûtait une ouverture LittleFS par
// échantillon (plusieurs milliers pour un export complet).
typedef bool (*VisiteurHist)(const Echantillon &e, void *contexte);
void histParcourir(uint32_t rangDebut, uint32_t pas, VisiteurHist visiteur, void *contexte);

// --- journal d'événements ---
void journalAjouter(const String &ligne);
String journalQueue(size_t maxOctets);  // fin du fichier
void journalEffacer();

// --- file d'alertes persistante ---
void alerteEmpiler(const String &texte);
bool alerteTete(String &texte);
void alerteDefiler();
uint16_t alertesEnAttente();

}  // namespace Stockage

#endif  // STOCKAGE_H
