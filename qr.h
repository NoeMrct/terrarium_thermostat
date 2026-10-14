/* =============================================================================
   qr.h — ENCODEUR QR MINIMAL POUR L'ÉCRAN D'APPAIRAGE
   -----------------------------------------------------------------------------
   Un seul format : version 2 (25 × 25 modules), niveau de correction L, mode
   alphanumérique, 47 caractères au plus. C'est exactement ce qu'il faut pour
   « TERRARIUM:TERRAA1B2C3:<code de 24 caractères> » (46 caractères), et c'est
   la plus grande taille qui tienne, à 2 pixels par module, sur les 64 pixels de
   haut de l'écran OLED.

   Sans dépendance Arduino : le banc sim/test-qr.cpp le vérifie sur PC en
   faisant relire le code produit par un décodeur indépendant.

   Alphabet alphanumérique du standard : 0-9, A-Z, espace, $ % * + - . / :
   (les minuscules sont refusées — l'application remet « terra » en minuscules).
   ============================================================================= */
#ifndef QR_H
#define QR_H

#include <stdint.h>
#include <stddef.h>

#define QR_MODULES 25

// Encode `texte` ; `modules` reçoit 25 × 25 octets (1 = module sombre), ligne
// par ligne. Renvoie false si le texte est trop long ou contient un caractère
// hors alphabet. Le masque choisi est celui de pénalité minimale.
bool qrEncoder(const char *texte, uint8_t modules[QR_MODULES * QR_MODULES]);

#endif  // QR_H
