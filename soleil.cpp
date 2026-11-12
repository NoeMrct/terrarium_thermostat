#include "soleil.h"
#include <math.h>

namespace Soleil {

bool horairesUtc(uint16_t jourAnnee, float latitude, float longitude, int16_t &lever, int16_t &coucher) {
  if (jourAnnee < 1 || jourAnnee > 366 || !isfinite(latitude) || !isfinite(longitude)) return false;
  const double PI_ = 3.14159265358979323846;
  const double rad = PI_ / 180.0;
  // Fraction de l'année, à midi.
  const double g = 2.0 * PI_ / 365.0 * (jourAnnee - 1);
  const double eqTemps = 229.18 * (0.000075 + 0.001868 * cos(g) - 0.032077 * sin(g) - 0.014615 * cos(2 * g) -
                                   0.040849 * sin(2 * g));  // minutes
  const double decl = 0.006918 - 0.399912 * cos(g) + 0.070257 * sin(g) - 0.006758 * cos(2 * g) +
                      0.000907 * sin(2 * g) - 0.002697 * cos(3 * g) + 0.00148 * sin(3 * g);  // radians
  const double lat = latitude * rad;
  // 90,833° : réfraction atmosphérique et rayon apparent du disque solaire.
  const double c = cos(90.833 * rad) / (cos(lat) * cos(decl)) - tan(lat) * tan(decl);
  if (c < -1.0 || c > 1.0) return false;      // jour polaire ou nuit polaire
  const double angleHoraire = acos(c) / rad;  // degrés
  const double midi = 720.0 - 4.0 * longitude - eqTemps;
  lever = (int16_t)lround(midi - 4.0 * angleHoraire);
  coucher = (int16_t)lround(midi + 4.0 * angleHoraire);
  return true;
}

uint16_t dansLaJournee(int32_t minutes) {
  int32_t m = minutes % 1440;
  if (m < 0) m += 1440;
  return (uint16_t)m;
}

}  // namespace Soleil
