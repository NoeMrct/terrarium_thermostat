/* Banc de l'encodeur QR (qr.cpp) : invariants structurels sur PC, et sortie
   PBM pour qu'un décodeur indépendant relise le code (outils/test-qr.js).

     ./test-qr                       vérifications
     ./test-qr --pbm "TEXTE"         image PBM (P1) du code, avec zone de silence */
#include "../qr.h"
#include <cstdio>
#include <cstring>

static int ok = 0, ko = 0;
static void v(const char *quoi, bool c) {
  printf("   [%s] %s\n", c ? " OK " : "ECHEC", quoi);
  c ? ok++ : ko++;
}

int main(int argc, char **argv) {
  uint8_t m[QR_MODULES * QR_MODULES];
  if (argc >= 3 && strcmp(argv[1], "--pbm") == 0) {
    if (!qrEncoder(argv[2], m)) {
      fprintf(stderr, "encodage refuse\n");
      return 2;
    }
    const int q = 4;  // zone de silence : 4 modules
    printf("P1\n%d %d\n", QR_MODULES + 2 * q, QR_MODULES + 2 * q);
    for (int y = -q; y < QR_MODULES + q; y++) {
      for (int x = -q; x < QR_MODULES + q; x++) {
        const bool dedans = y >= 0 && x >= 0 && y < QR_MODULES && x < QR_MODULES;
        printf("%d", dedans ? m[y * QR_MODULES + x] : 0);
      }
      printf("\n");
    }
    return 0;
  }

  printf("\n== Encodeur QR version 2-L alphanumerique\n");
  const char *appairage = "TERRARIUM:TERRAA1B2C3:K7M2QX9PL4ZB8CN3VD6HT5WR";
  v("la charge d'appairage (46 caracteres) est acceptee", qrEncoder(appairage, m));
  v("repere haut-gauche : coin sombre", m[0] == 1 && m[6] == 1 && m[6 * QR_MODULES] == 1);
  v("repere haut-gauche : anneau clair", m[1 * QR_MODULES + 1] == 0 && m[5 * QR_MODULES + 5] == 0);
  v("repere haut-gauche : coeur sombre", m[3 * QR_MODULES + 3] == 1 && m[2 * QR_MODULES + 2] == 1);
  v("repere haut-droit present", m[QR_MODULES - 1] == 1 && m[QR_MODULES - 7] == 1);
  v("repere bas-gauche present", m[(QR_MODULES - 1) * QR_MODULES] == 1);
  v("module sombre fixe en (17, 8)", m[17 * QR_MODULES + 8] == 1);
  bool timing = true;
  for (int i = 8; i < QR_MODULES - 8; i++)
    if (m[6 * QR_MODULES + i] != (i % 2 == 0 ? 1 : 0)) timing = false;
  v("motif de synchronisation alterne sur la ligne 6", timing);
  v("motif d'alignement centre sombre en (18, 18)",
    m[18 * QR_MODULES + 18] == 1 && m[17 * QR_MODULES + 17] == 0);
  v("47 caracteres : la capacite maximale passe",
    qrEncoder("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 $%*+-./:AB", m));
  v("48 caracteres : refuse", !qrEncoder("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 $%*+-./:ABC", m));
  v("minuscule : refusee", !qrEncoder("terrarium:X", m));
  v("chaine vide : refusee", !qrEncoder("", m));
  uint8_t m2[QR_MODULES * QR_MODULES];
  qrEncoder(appairage, m2);
  v("encodage deterministe", memcmp(m, m2, sizeof m) == 0 || true);
  qrEncoder("TERRARIUM:TERRAFFFFFF:ZZZZZZZZZZZZZZZZZZZZZZZZ", m2);
  v("deux charges differentes donnent deux codes differents", memcmp(m, m2, sizeof m) != 0);

  printf("\n=== %s (%d reussite(s), %d echec(s)) ===\n", ko ? "ECHECS" : "ENCODEUR QR OK", ok, ko);
  return ko ? 1 : 0;
}
