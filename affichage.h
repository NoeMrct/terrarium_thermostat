/* affichage.h — écran OLED local : température, état, réseau. */
#ifndef AFFICHAGE_H
#define AFFICHAGE_H

#include "config.h"

namespace Affichage {
void demarrer();
bool present();
void rafraichir();
void message(const String &ligne1, const String &ligne2);
void reveiller();          // sort l'écran de veille (activité, défaut, commande)
// Affiche le code d'appairage pendant `secondes`. NE BLOQUE PAS : l'écran est
// rendu par rafraichir(), la régulation, le réseau et la console continuent de
// tourner pendant ce temps.
void appairage(const char *jeton, uint32_t secondes);
bool appairageEnCours();
}

#endif // AFFICHAGE_H
