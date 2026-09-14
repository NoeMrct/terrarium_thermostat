#include "format.h"
#include <stdio.h>

size_t formatEchapperJson(const char *src, char *dst, size_t taille) {
  if (!dst || taille == 0) return 0;
  size_t n = 0;
  if (!src) { dst[0] = '\0'; return 0; }

  for (const unsigned char *p = reinterpret_cast<const unsigned char *>(src); *p; p++) {
    if (*p == '"' || *p == '\\') {
      // Deux octets ou rien : un antislash seul en fin de tampon ferait fuir la
      // chaîne sur le reste du document.
      if (n + 2 >= taille) break;
      dst[n++] = '\\';
      dst[n++] = (char)*p;
    } else {
      if (n + 1 >= taille) break;
      dst[n++] = (*p < 32 || *p == 127) ? ' ' : (char)*p;
    }
  }
  dst[n] = '\0';
  return n;
}

bool formatHHMM(uint16_t minutes, char *dst, size_t taille) {
  if (!dst || taille < 6) return false;
  minutes = (uint16_t)(minutes % 1440);
  snprintf(dst, taille, "%02u:%02u", (unsigned)(minutes / 60), (unsigned)(minutes % 60));
  return true;
}

bool formatParseHHMM(const char *texte, uint16_t &minutes) {
  if (!texte) return false;

  int h = 0, m = 0, chiffres = 0;
  const char *p = texte;
  while (*p == ' ') p++;
  for (; *p >= '0' && *p <= '9'; p++) { h = h * 10 + (*p - '0'); if (++chiffres > 2) return false; }
  if (chiffres == 0 || *p != ':') return false;
  p++;
  chiffres = 0;
  for (; *p >= '0' && *p <= '9'; p++) { m = m * 10 + (*p - '0'); if (++chiffres > 2) return false; }
  if (chiffres == 0) return false;
  while (*p == ' ') p++;
  if (*p != '\0') return false;                 // « 08:00abc » n'est pas une heure

  if (h > 23 || m > 59) return false;
  minutes = (uint16_t)(h * 60 + m);
  return true;
}
