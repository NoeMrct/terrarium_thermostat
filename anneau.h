/* =============================================================================
   anneau.h — INDEX D'UN JOURNAL CIRCULAIRE À ENREGISTREMENTS DE TAILLE FIXE
   -----------------------------------------------------------------------------
   Comme controle.h, ce module ne dépend PAS d'Arduino : ni fichier, ni Serial,
   ni millis(). Il ne connaît que des numéros d'emplacement et des numéros de
   séquence, lus par une fonction fournie par l'appelant.

   Conséquence : la partie réellement délicate de stockage.cpp — retrouver la
   tête de l'anneau au démarrage, sans entête mobile, par recherche dichotomique
   sur les numéros de séquence — se teste sur PC, exhaustivement, sans flash ni
   système de fichiers (voir sim/test-anneau.cpp).
   ============================================================================= */
#ifndef ANNEAU_H
#define ANNEAU_H

#include <stdint.h>
#include <stddef.h>

struct Anneau {
  uint32_t capacite = 0;   // nombre d'emplacements du fichier
  uint32_t index    = 0;   // prochaine position d'écriture
  uint32_t remplis  = 0;   // enregistrements valides, au plus `capacite`
  uint32_t seq      = 1;   // numéro de séquence du prochain enregistrement
};

// Lit le numéro de séquence d'un emplacement. Renvoie false s'il est illisible.
typedef bool (*LecteurSeq)(uint32_t emplacement, uint32_t &seq, void *contexte);

// Position de l'enregistrement le plus ancien dans un anneau PLEIN, c'est-à-dire
// le point de rupture de la suite croissante des numéros de séquence — et donc
// la prochaine position d'écriture. Une quinzaine de lectures pour 20 000
// emplacements, au lieu de 20 000. Renvoie 0 s'il n'y a pas encore eu de
// repliement, ou si une lecture échoue.
uint32_t anneauRupture(uint32_t capacite, LecteurSeq lire, void *contexte);

// Reconstitue l'état complet. `enregistres` est le nombre d'emplacements
// réellement présents dans le fichier, entête déduite.
void anneauReconstruire(Anneau &a, uint32_t capacite, uint32_t enregistres,
                        LecteurSeq lire, void *contexte);

// Emplacement où écrire le prochain enregistrement.
uint32_t anneauEmplacementEcriture(const Anneau &a);

// À appeler après une écriture réussie : avance la tête et le numéro de séquence.
void anneauAvancer(Anneau &a);

// Emplacement du rang demandé, rang 0 = le plus ancien. false si hors bornes.
bool anneauEmplacementDuRang(const Anneau &a, uint32_t rang, uint32_t &emplacement);

// Remet l'anneau à vide, en conservant la capacité.
void anneauVider(Anneau &a);

#endif // ANNEAU_H
