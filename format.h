/* =============================================================================
   format.h — CONVERSIONS DE TEXTE PARTAGÉES
   -----------------------------------------------------------------------------
   Sans dépendance Arduino, pour les mêmes raisons que controle.h et anneau.h :
   l'échappement JSON et l'analyse des horaires sont utilisés par l'interface
   web, la console série et le canal MQTT, et une erreur ici casse discrètement
   une réponse d'API (un nom de zone contenant un guillemet suffisait). Le banc
   d'essai les exerce sur PC (sim/test-format.cpp).
   ============================================================================= */
#ifndef FORMAT_H
#define FORMAT_H

#include <stdint.h>
#include <stddef.h>

// Recopie `src` dans `dst` en échappant ce que JSON interdit dans une chaîne :
// guillemet et antislash sont préfixés, les caractères de contrôle deviennent
// des espaces. Tronque proprement plutôt que de déborder, et n'écrit jamais un
// antislash orphelin en fin de tampon — ce qui produirait un JSON invalide.
// Renvoie le nombre d'octets écrits, terminaison exclue.
size_t formatEchapperJson(const char *src, char *dst, size_t taille);

// "08:05" à partir de 485. false si le tampon est trop court.
bool formatHHMM(uint16_t minutes, char *dst, size_t taille);

// "08:05" -> 485. false si le format est invalide ou l'heure impossible.
bool formatParseHHMM(const char *texte, uint16_t &minutes);

#endif // FORMAT_H
