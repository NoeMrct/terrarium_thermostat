// Signature des commandes du protocole 4 : HMAC-SHA256 avec le code
// d'appairage pour clé. Le code ne circule plus en clair sur le broker : un
// tiers qui lit les commandes ne peut ni le voler ni en forger d'autres, au
// plus rejouer une commande récente (bornée par l'heure et la mémoire des
// requêtes du canal de commande).
//
// Implémentation autonome, sans mbedtls : la même tourne sur le socle et sur
// PC (sim/test-protocole.cpp, vecteurs de la RFC 4231).
#ifndef SIGNATURE_H
#define SIGNATURE_H

#include <stddef.h>
#include <stdint.h>

namespace Signature {

void sha256(const uint8_t *donnees, size_t taille, uint8_t sortie[32]);
void hmacSha256(const uint8_t *cle, size_t tailleCle, const uint8_t *message, size_t tailleMessage,
                uint8_t sortie[32]);
// Écrit 64 chiffres hexadécimaux minuscules et un zéro final (65 octets).
void hex(const uint8_t empreinte[32], char sortie[65]);
// Vrai si `sigHex` est le HMAC hexadécimal (minuscules) de `message` sous
// `cle`. Comparaison à durée constante.
bool verifier(const char *cle, const char *message, size_t tailleMessage, const char *sigHex);

}  // namespace Signature

#endif  // SIGNATURE_H
