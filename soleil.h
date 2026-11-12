/* =============================================================================
   soleil.h — LEVER ET COUCHER DU SOLEIL
   -----------------------------------------------------------------------------
   Sans dépendance Arduino. Algorithme simplifié de la NOAA (équation du temps
   et déclinaison en séries de Fourier) : quelques minutes d'écart au plus avec
   les éphémérides, bien assez pour caler un cycle jour/nuit qui suit les
   saisons. Vérifié sur PC par sim/test-soleil.cpp.
   ============================================================================= */
#ifndef SOLEIL_H
#define SOLEIL_H

#include <stdint.h>

namespace Soleil {

// Lever et coucher du jour `jourAnnee` (1 = 1er janvier), en minutes après
// minuit UTC (éventuellement négatives ou au-delà de 1440 : à ramener dans la
// journée après ajout du fuseau). Latitude positive au nord, longitude positive
// à l'est. false quand le soleil ne se lève pas ou ne se couche pas ce jour-là.
bool horairesUtc(uint16_t jourAnnee, float latitude, float longitude, int16_t &lever, int16_t &coucher);

// Ramène des minutes quelconques dans [0, 1440).
uint16_t dansLaJournee(int32_t minutes);

}  // namespace Soleil

#endif  // SOLEIL_H
