/* =============================================================================
   liaisons.h — QUELLE SONDE MESURE QUELLE ZONE
   -----------------------------------------------------------------------------
   Sans dépendance Arduino, comme controle.h : les règles qui associent une
   adresse 1-Wire (ROM de 8 octets) à une zone vivent ici, et tournent à
   l'identique sur PC, où sim/test-liaisons.cpp les vérifie. sondes.cpp n'y
   ajoute que le bus et la mémoire flash.

   Une sonde qui mesure la mauvaise zone est le seul scénario où un tapis chauffe
   sans limite (jusqu'au bilame) : d'où des règles strictes.
   - Une sonde n'est jamais liée à deux zones.
   - Une zone sans sonde liée ne lit rien (défaut SONDE, chauffe coupée) : elle
     ne prend plus « la n-ième sonde du bus », qui pouvait être celle de l'autre.
   - Une liaison automatique n'est faite que lorsqu'elle ne laisse aucun doute.
   ============================================================================= */
#ifndef LIAISONS_H
#define LIAISONS_H

#include <stdint.h>
#include <stddef.h>
#include "controle.h"

namespace Liaisons {

static const uint8_t MAX_SONDES = 8;  // sondes suivies sur le bus

bool romNulle(const uint8_t *rom);
bool memeRom(const uint8_t *a, const uint8_t *b);

// Zone à laquelle cette adresse est liée, ou -1.
int8_t zoneDe(const uint8_t liees[NB_ZONES][8], const uint8_t *rom);

// Lie `rom` à `zone` et la retire de toute autre zone. Renvoie le masque des
// zones qui l'ont perdue (bit z = zone z), pour pouvoir le dire.
uint8_t lier(uint8_t liees[NB_ZONES][8], const uint8_t *rom, uint8_t zone);

// Liaisons automatiques, seulement quand elles ne laissent aucun doute :
// - aucune zone liée (premier démarrage) : les sondes présentes, dans l'ordre
//   du bus — l'assistant d'identification et le contrôle croisé de la
//   régulation rattrapent un ordre qui ne correspondrait pas aux plaques ;
// - une seule zone libre, une seule sonde présente qui n'est liée à rien, et
//   toutes les sondes déjà liées présentes (on vient d'ajouter la deuxième
//   sonde, pas de remplacer une sonde morte) : on les associe.
// Dans tous les autres cas, rien n'est fait. Renvoie le masque des zones
// nouvellement liées.
uint8_t lierAutomatiquement(uint8_t liees[NB_ZONES][8], const uint8_t presentes[][8], uint8_t nb);

// Assistant d'identification : on réchauffe dans la main (ou on refroidit) la
// sonde d'une zone. Renvoie l'indice de celle qui a varié d'au moins
// IDENT_ECART °C, et d'au moins IDENT_MARGE de plus que toutes les autres ; -1
// tant que rien n'est net. Une valeur non finie (sonde muette) est ignorée.
static const float IDENT_ECART = 1.0f;
static const float IDENT_MARGE = 0.7f;
int8_t sondeManipulee(const float *avant, const float *apres, uint8_t nb);

// Forme lisible d'une adresse : 16 chiffres hexadécimaux, et sa forme courte
// (les 4 derniers) pour l'écran. `sortie` doit faire au moins 17 octets.
void romTexte(const uint8_t *rom, char *sortie, size_t taille);
bool romDepuisTexte(const char *texte, uint8_t *rom);

}  // namespace Liaisons

#endif  // LIAISONS_H
