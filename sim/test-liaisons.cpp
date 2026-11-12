/* =============================================================================
   test-liaisons.cpp — RÈGLES DE LIAISON SONDE <-> ZONE, SUR PC
   -----------------------------------------------------------------------------
   Compile le vrai ../liaisons.cpp. Une erreur ici, c'est un tapis qui chauffe
   en lisant la sonde d'une autre zone : chaque règle a son cas.

       make liaisons
   ============================================================================= */

#include "../liaisons.h"
#include <math.h>
#include <stdio.h>
#include <string.h>

static int echecs = 0;

#define VERIFIE(cond, quoi)                                 \
  do {                                                      \
    const bool ok_ = (cond);                                \
    printf("   %s %s\n", ok_ ? "[ OK ]" : "[ECHEC]", quoi); \
    if (!ok_) echecs++;                                     \
  } while (0)

static const uint8_t A[8] = { 0x28, 0xCA, 0xBC, 0x79, 0x11, 0x00, 0x00, 0xFA };
static const uint8_t B[8] = { 0x28, 0xA0, 0xB2, 0x7A, 0x11, 0x00, 0x00, 0xDC };
static const uint8_t C[8] = { 0x28, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77 };

static void vider(uint8_t l[NB_ZONES][8]) { memset(l, 0, NB_ZONES * 8); }

static void testLier() {
  printf("\n== Liaison explicite\n");
  uint8_t l[NB_ZONES][8];
  vider(l);
  VERIFIE(Liaisons::lier(l, A, 0) == 0 && Liaisons::zoneDe(l, A) == 0, "A liee a la zone 1");
  const uint8_t perdues = Liaisons::lier(l, A, 1);
  VERIFIE(perdues == 0x01, "relier A a la zone 2 la retire de la zone 1 (et le dit)");
  VERIFIE(Liaisons::romNulle(l[0]) && Liaisons::zoneDe(l, A) == 1, "A ne mesure plus qu'une zone");
  VERIFIE(Liaisons::lier(l, B, 0) == 0 && Liaisons::zoneDe(l, B) == 0, "B liee a la zone 1");
  Liaisons::lier(l, B, 1);
  VERIFIE(Liaisons::zoneDe(l, A) == -1 && Liaisons::zoneDe(l, B) == 1 && Liaisons::romNulle(l[0]),
          "B remplace A sur la zone 2 et quitte la zone 1");
  const uint8_t nul[8] = { 0 };
  VERIFIE(Liaisons::lier(l, nul, 0) == 0 && Liaisons::romNulle(l[0]), "une adresse nulle ne lie rien");
  VERIFIE(Liaisons::lier(l, C, NB_ZONES) == 0 && Liaisons::zoneDe(l, C) == -1, "zone hors bornes refusee");
  VERIFIE(Liaisons::zoneDe(l, nul) == -1, "l'adresse nulle n'appartient a aucune zone");
}

static void testAutomatique() {
  printf("\n== Liaisons automatiques\n");
  uint8_t l[NB_ZONES][8];
  uint8_t p[3][8];

  vider(l);
  memcpy(p[0], A, 8);
  memcpy(p[1], B, 8);
  VERIFIE(Liaisons::lierAutomatiquement(l, p, 2) == 0x03 && Liaisons::zoneDe(l, A) == 0 &&
              Liaisons::zoneDe(l, B) == 1,
          "premier demarrage, deux sondes : liees dans l'ordre du bus");

  vider(l);
  VERIFIE(Liaisons::lierAutomatiquement(l, p, 1) == 0x01 && Liaisons::zoneDe(l, A) == 0 &&
              Liaisons::romNulle(l[1]),
          "premier demarrage, une sonde : zone 1 seulement");

  // Le cas du 11/11 : une sonde liée à la zone 1, on branche la deuxième.
  vider(l);
  Liaisons::lier(l, A, 0);
  memcpy(p[0], B, 8);  // l'ordre du bus ne compte pas
  memcpy(p[1], A, 8);
  VERIFIE(Liaisons::lierAutomatiquement(l, p, 2) == 0x02 && Liaisons::zoneDe(l, B) == 1 &&
              Liaisons::zoneDe(l, A) == 0,
          "deuxieme sonde ajoutee : seule candidate, seule zone libre");

  vider(l);
  Liaisons::lier(l, A, 0);
  memcpy(p[0], A, 8);
  memcpy(p[1], B, 8);
  memcpy(p[2], C, 8);
  VERIFIE(Liaisons::lierAutomatiquement(l, p, 3) == 0 && Liaisons::romNulle(l[1]),
          "deux sondes orphelines pour une zone : on ne choisit pas au hasard");

  vider(l);
  Liaisons::lier(l, A, 0);
  memcpy(p[0], B, 8);
  VERIFIE(Liaisons::lierAutomatiquement(l, p, 1) == 0 && Liaisons::romNulle(l[1]),
          "sonde liee absente + nouvelle sonde : peut-etre un remplacement, rien d'automatique");

  vider(l);
  Liaisons::lier(l, A, 0);
  Liaisons::lier(l, B, 1);
  memcpy(p[0], A, 8);
  memcpy(p[1], B, 8);
  memcpy(p[2], C, 8);
  VERIFIE(Liaisons::lierAutomatiquement(l, p, 3) == 0 && Liaisons::zoneDe(l, C) == -1,
          "toutes les zones liees : une sonde en plus reste libre");

  vider(l);
  VERIFIE(Liaisons::lierAutomatiquement(l, p, 0) == 0, "aucune sonde : rien");
}

static void testIdentification() {
  printf("\n== Assistant d'identification\n");
  const float avant[3] = { 24.0f, 23.5f, 25.0f };
  float apres[3] = { 24.1f, 27.2f, 25.0f };
  VERIFIE(Liaisons::sondeManipulee(avant, apres, 3) == 1, "la sonde rechauffee dans la main est reconnue");
  apres[1] = 21.0f;
  VERIFIE(Liaisons::sondeManipulee(avant, apres, 3) == 1, "...ou refroidie");
  apres[1] = 24.3f;
  VERIFIE(Liaisons::sondeManipulee(avant, apres, 3) == -1, "moins d'1 C : on attend encore");
  apres[0] = 25.6f;
  apres[1] = 25.2f;
  VERIFIE(Liaisons::sondeManipulee(avant, apres, 3) == -1, "deux sondes qui bougent ensemble : ambigu");
  apres[0] = NAN;
  apres[1] = 26.0f;
  VERIFIE(Liaisons::sondeManipulee(avant, apres, 3) == 1, "une sonde muette est ignoree");
  const float seule[1] = { 22.0f }, seuleApres[1] = { 23.5f };
  VERIFIE(Liaisons::sondeManipulee(seule, seuleApres, 1) == 0, "une seule sonde sur le bus");
}

static void testTexte() {
  printf("\n== Forme texte des adresses\n");
  char t[17];
  Liaisons::romTexte(A, t, sizeof t);
  VERIFIE(strcmp(t, "28CABC79110000FA") == 0, "16 chiffres hexadecimaux");
  uint8_t r[8];
  VERIFIE(Liaisons::romDepuisTexte(t, r) && Liaisons::memeRom(r, A), "aller-retour exact");
  VERIFIE(Liaisons::romDepuisTexte("28cabc79110000fa", r) && Liaisons::memeRom(r, A), "minuscules acceptees");
  VERIFIE(!Liaisons::romDepuisTexte("28CABC79110000F", r), "trop court : refuse");
  VERIFIE(!Liaisons::romDepuisTexte("28CABC79110000FG", r), "caractere invalide : refuse");
  VERIFIE(!Liaisons::romDepuisTexte(nullptr, r), "absent : refuse");
}

int main() {
  printf("=== Liaisons sonde <-> zone ===\n");
  testLier();
  testAutomatique();
  testIdentification();
  testTexte();
  printf("\n=== %s (%d echec%s) ===\n", echecs ? "DES TESTS ONT ECHOUE" : "TOUS LES TESTS PASSENT", echecs,
         echecs > 1 ? "s" : "");
  return echecs ? 1 : 0;
}
