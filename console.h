/* console.h — commandes série. Tout ce qui se règle par le web se règle aussi
   ici, pour rester dépannable sans réseau. */
#ifndef CONSOLE_H
#define CONSOLE_H

#include "config.h"

namespace Console {
void aide();
void boucle();                   // à appeler à chaque tour, non bloquant
void etat();                     // impression de l'état courant
void testUsine(bool puissance);  // auto-test des organes ; true = impulsion sur chaque MOSFET
}  // namespace Console

#endif  // CONSOLE_H
