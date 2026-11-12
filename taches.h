/* taches.h — tâches de fond, une fois par minute : rapport quotidien, résumés
   journaliers, jour et nuit calés sur le soleil, mémoire, durée des coupures de
   courant, redémarrages anormaux en série. */
#ifndef TACHES_H
#define TACHES_H

#include "config.h"

namespace Taches {

// Statistiques des `points` derniers échantillons d'historique (un par
// minute). Partagées par la page locale, le canal MQTT et le rapport : une
// seule façon de calculer, pour que tous montrent les mêmes chiffres.
struct Stats {
  float mini[NB_ZONES], maxi[NB_ZONES], somme[NB_ZONES];
  uint32_t n[NB_ZONES], horsPlage[NB_ZONES];
};
void statistiques(uint32_t points, Stats &s);

// Au démarrage, statistiques chargées : `epochSauvegarde` est la dernière heure
// mise en flash avant l'arrêt (sert à estimer la durée d'une coupure).
void demarrer(uint32_t epochSauvegarde);
void heureSynchronisee();  // depuis le rappel SNTP (autre tâche) : un drapeau, rien de plus
void boucle(uint32_t maintenant);

String rapport();       // texte du rapport quotidien, à la demande
void envoyerRapport();  // tout de suite, vers les alertes et le sujet MQTT « rapport »

String joursJson(uint16_t n);   // résumés journaliers, du plus récent au plus ancien
String joursTexte(uint16_t n);  // idem, pour la console

float kwh(uint32_t secondes);    // énergie des tapis pour ce temps de chauffe
float euros(uint32_t secondes);  // son coût ; 0 si le prix du kWh est inconnu

void appliquerSoleil();  // recalcule lever et coucher du jour (réglages modifiés)

}  // namespace Taches

#endif  // TACHES_H
