#include "liaisons.h"
#include <math.h>
#include <stdio.h>
#include <string.h>

namespace Liaisons {

bool romNulle(const uint8_t *rom) {
  for (uint8_t i = 0; i < 8; i++)
    if (rom[i]) return false;
  return true;
}

bool memeRom(const uint8_t *a, const uint8_t *b) { return memcmp(a, b, 8) == 0; }

int8_t zoneDe(const uint8_t liees[NB_ZONES][8], const uint8_t *rom) {
  if (romNulle(rom)) return -1;
  for (uint8_t z = 0; z < NB_ZONES; z++)
    if (memeRom(liees[z], rom)) return (int8_t)z;
  return -1;
}

uint8_t lier(uint8_t liees[NB_ZONES][8], const uint8_t *rom, uint8_t zone) {
  if (zone >= NB_ZONES || romNulle(rom)) return 0;
  uint8_t perdues = 0;
  for (uint8_t z = 0; z < NB_ZONES; z++)
    if (z != zone && memeRom(liees[z], rom)) {
      memset(liees[z], 0, 8);
      perdues |= (uint8_t)(1u << z);
    }
  memcpy(liees[zone], rom, 8);
  return perdues;
}

uint8_t lierAutomatiquement(uint8_t liees[NB_ZONES][8], const uint8_t presentes[][8], uint8_t nb) {
  uint8_t libres = 0, zoneLibre = 0;
  for (uint8_t z = 0; z < NB_ZONES; z++)
    if (romNulle(liees[z])) {
      libres++;
      zoneLibre = z;
    }
  if (libres == 0 || nb == 0) return 0;

  if (libres == NB_ZONES) {  // premier démarrage : rien n'est encore lié
    uint8_t nouvelles = 0;
    for (uint8_t z = 0; z < NB_ZONES && z < nb; z++) {
      if (romNulle(presentes[z]) || zoneDe(liees, presentes[z]) >= 0) continue;
      memcpy(liees[z], presentes[z], 8);
      nouvelles |= (uint8_t)(1u << z);
    }
    return nouvelles;
  }

  // Une seule zone libre et une seule sonde orpheline : aucune ambiguïté...
  if (libres != 1) return 0;
  // ...à condition que les sondes déjà liées soient toutes là. Sinon la
  // nouvelle venue remplace peut-être une sonde morte : la lier à la zone libre
  // ferait mesurer à celle-ci la plaque d'une autre.
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    if (romNulle(liees[z])) continue;
    bool presente = false;
    for (uint8_t i = 0; i < nb && !presente; i++) presente = memeRom(presentes[i], liees[z]);
    if (!presente) return 0;
  }
  int8_t orpheline = -1;
  for (uint8_t i = 0; i < nb; i++) {
    if (romNulle(presentes[i]) || zoneDe(liees, presentes[i]) >= 0) continue;
    if (orpheline >= 0) return 0;  // deux candidates : on ne choisit pas au hasard
    orpheline = (int8_t)i;
  }
  if (orpheline < 0) return 0;
  memcpy(liees[zoneLibre], presentes[orpheline], 8);
  return (uint8_t)(1u << zoneLibre);
}

int8_t sondeManipulee(const float *avant, const float *apres, uint8_t nb) {
  int8_t meilleure = -1;
  float premier = 0.0f, second = 0.0f;
  for (uint8_t i = 0; i < nb; i++) {
    if (!isfinite(avant[i]) || !isfinite(apres[i])) continue;
    const float ecart = fabsf(apres[i] - avant[i]);
    if (ecart > premier) {
      second = premier;
      premier = ecart;
      meilleure = (int8_t)i;
    } else if (ecart > second) {
      second = ecart;
    }
  }
  if (meilleure < 0 || premier < IDENT_ECART || premier - second < IDENT_MARGE) return -1;
  return meilleure;
}

void romTexte(const uint8_t *rom, char *sortie, size_t taille) {
  snprintf(sortie, taille, "%02X%02X%02X%02X%02X%02X%02X%02X", rom[0], rom[1], rom[2], rom[3], rom[4], rom[5],
           rom[6], rom[7]);
}

bool romDepuisTexte(const char *texte, uint8_t *rom) {
  if (!texte || strlen(texte) != 16) return false;
  for (uint8_t i = 0; i < 8; i++) {
    unsigned v = 0;
    for (uint8_t k = 0; k < 2; k++) {
      const char c = texte[i * 2 + k];
      unsigned n;
      if (c >= '0' && c <= '9')
        n = (unsigned)(c - '0');
      else if (c >= 'A' && c <= 'F')
        n = (unsigned)(c - 'A' + 10);
      else if (c >= 'a' && c <= 'f')
        n = (unsigned)(c - 'a' + 10);
      else
        return false;
      v = v * 16 + n;
    }
    rom[i] = (uint8_t)v;
  }
  return true;
}

}  // namespace Liaisons
