/* =============================================================================
   test-soleil.cpp — LEVER ET COUCHER DU SOLEIL, SUR PC
   -----------------------------------------------------------------------------
   Compare ../soleil.cpp aux éphémérides de Paris (48,857° N, 2,352° E) à
   quelques dates, et vérifie les cas limites (jour polaire, valeurs absurdes).

       make soleil
   ============================================================================= */

#include "../soleil.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

static int echecs = 0;

static void verifier(const char *quoi, bool ok, const char *detail = "") {
  printf("   %s %-58s %s\n", ok ? "[ OK ]" : "[ECHEC]", quoi, detail);
  if (!ok) echecs++;
}

// Heures UTC attendues (éphémérides), tolérance de 5 minutes.
static void cas(const char *date, uint16_t jour, int leverH, int leverM, int coucherH, int coucherM) {
  int16_t lever = 0, coucher = 0;
  const bool ok = Soleil::horairesUtc(jour, 48.857f, 2.352f, lever, coucher);
  const int attenduL = leverH * 60 + leverM, attenduC = coucherH * 60 + coucherM;
  char d[96];
  snprintf(d, sizeof d, "lever %02d:%02d UTC (attendu %02d:%02d), coucher %02d:%02d (attendu %02d:%02d)",
           lever / 60, lever % 60, leverH, leverM, coucher / 60, coucher % 60, coucherH, coucherM);
  char quoi[64];
  snprintf(quoi, sizeof quoi, "Paris, %s, a 5 min pres", date);
  verifier(quoi, ok && abs(lever - attenduL) <= 5 && abs(coucher - attenduC) <= 5, d);
}

int main() {
  printf("=== Lever et coucher du soleil ===\n");
  cas("21 juin", 172, 3, 47, 19, 58);
  cas("21 decembre", 355, 7, 42, 15, 56);
  cas("20 mars", 79, 5, 55, 18, 5);
  cas("23 septembre", 266, 5, 32, 17, 47);

  int16_t l = 0, c = 0;
  verifier("jour polaire a 75 N le 21 juin : pas d'horaire", !Soleil::horairesUtc(172, 75.0f, 15.0f, l, c));
  verifier("nuit polaire a 75 N le 21 decembre : pas d'horaire",
           !Soleil::horairesUtc(355, 75.0f, 15.0f, l, c));
  verifier("jour de l'annee 0 refuse", !Soleil::horairesUtc(0, 48.0f, 2.0f, l, c));
  verifier("jour 367 refuse", !Soleil::horairesUtc(367, 48.0f, 2.0f, l, c));
  verifier("latitude non finie refusee", !Soleil::horairesUtc(100, NAN, 2.0f, l, c));
  verifier("plus a l'est, le soleil se leve plus tot (UTC)", [] {
    int16_t l1 = 0, c1 = 0, l2 = 0, c2 = 0;
    Soleil::horairesUtc(100, 45.0f, 0.0f, l1, c1);
    Soleil::horairesUtc(100, 45.0f, 15.0f, l2, c2);
    return l2 < l1 && abs((l1 - l2) - 60) <= 1;
  }());
  verifier("minutes ramenees dans la journee",
           Soleil::dansLaJournee(-30) == 1410 && Soleil::dansLaJournee(1500) == 60 &&
               Soleil::dansLaJournee(0) == 0 && Soleil::dansLaJournee(1440) == 0);

  printf("\n=== %s (%d echec%s) ===\n", echecs ? "DES TESTS ONT ECHOUE" : "TOUS LES TESTS PASSENT", echecs,
         echecs > 1 ? "s" : "");
  return echecs ? 1 : 0;
}
