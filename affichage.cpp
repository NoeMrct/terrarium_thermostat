#include "affichage.h"
#include "reseau.h"
#include "stockage.h"
#include "qr.h"
#include <Wire.h>
#include <ctype.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <string.h>

namespace {
Adafruit_SSD1306 ecran(OLED_L, OLED_H, &Wire, -1);
bool g_present = false;
bool g_allume = true;
uint32_t g_derniereActivite = 0;

// Écran d'appairage : mémorisé, puis redessiné par rafraichir() jusqu'à
// l'échéance. L'ancienne version tournait sur place pendant 15 à 20 secondes,
// pendant lesquelles ni la régulation, ni le serveur web, ni la console
// n'avançaient — et un tapis allumé le restait.
char g_jetonAffiche[25] = { 0 };
char g_idAffiche[16] = { 0 };
uint8_t g_qr[QR_MODULES * QR_MODULES];
bool g_qrPret = false;
uint32_t g_appairageFin = 0;

// Minutes restantes avant le prochain basculement jour/nuit, ou -1 si l'heure
// n'est pas connue.
int prochaineTransition() {
  if (!heureFiable()) return -1;
  const uint16_t m = minutesDuJour();
  int meilleur = -1;
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    const uint16_t a = (uint16_t)((ctrl.cfg[z].debutJour + 1440 - m) % 1440);
    const uint16_t b = (uint16_t)((ctrl.cfg[z].debutNuit + 1440 - m) % 1440);
    const int p = (a < b) ? a : b;
    if (meilleur < 0 || p < meilleur) meilleur = p;
  }
  return meilleur;
}
}  // namespace

namespace Affichage {

void demarrer() {
  g_derniereActivite = millis();
  Wire.begin(PIN_SDA, PIN_SCL);
  // 400 kHz : à 100 kHz, le transfert du tampon complet immobilise le bus
  // près de 90 ms à chaque rafraîchissement, soit 9 % du temps de la boucle.
  Wire.setClock(400000);
  g_present = ecran.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  if (!g_present) {
    journal("OLED absent — fonctionnement sans affichage local");
    return;
  }
  ecran.clearDisplay();
  ecran.setTextColor(SSD1306_WHITE);
  ecran.setTextSize(1);
  ecran.setCursor(0, 0);
  ecran.println(F("Thermostat terrarium"));
  ecran.display();
}

bool present() { return g_present; }

void message(const String &l1, const String &l2) {
  if (!g_present) return;
  ecran.clearDisplay();
  ecran.setTextColor(SSD1306_WHITE);
  ecran.setTextSize(1);
  ecran.setCursor(0, 20);
  ecran.print(l1);
  ecran.setCursor(0, 34);
  ecran.print(l2);
  ecran.display();
}

void reveiller() {
  g_derniereActivite = millis();
  if (!g_allume) {
    g_allume = true;
    ecran.ssd1306_command(SSD1306_DISPLAYON);
  }
}

// Affiche le jeton d'appairage : QR code pour l'application, et texte par blocs
// de six pour qu'il soit recopiable sans erreur. Le QR est encodé une fois ici,
// en majuscules (mode alphanumérique, le seul qui tienne sur l'écran) ; l'application
// remet l'identifiant dans sa casse « terraXXXXXX ».
void appairage(const char *identifiant, const char *jeton, uint32_t secondes) {
  if (!jeton || strlen(jeton) < 24) return;
  memcpy(g_jetonAffiche, jeton, 24);
  g_jetonAffiche[24] = '\0';
  snprintf(g_idAffiche, sizeof g_idAffiche, "%s", identifiant ? identifiant : "");
  char charge[64];
  snprintf(charge, sizeof charge, "TERRARIUM:%s:%s", g_idAffiche, g_jetonAffiche);
  for (char *c = charge; *c; c++) *c = (char)toupper((unsigned char)*c);
  g_qrPret = qrEncoder(charge, g_qr);
  g_appairageFin = millis() + secondes * 1000UL;
  if (g_appairageFin == 0) g_appairageFin = 1;  // 0 signifie « pas d'appairage »
  reveiller();
  rafraichir();  // visible sans attendre la seconde suivante
}

bool appairageEnCours() { return g_appairageFin != 0; }

// Mire du test usine : tout allumé, puis un damier — un pixel mort ou une
// colonne absente se voit à l'œil nu. Bloquant le temps indiqué.
bool mire(uint32_t ms) {
  if (!g_present) return false;
  reveiller();
  ecran.fillRect(0, 0, OLED_L, OLED_H, SSD1306_WHITE);
  ecran.display();
  delay(ms / 2);
  ecran.clearDisplay();
  for (int16_t y = 0; y < OLED_H; y += 8)
    for (int16_t x = 0; x < OLED_L; x += 8)
      if (((x + y) / 8) % 2 == 0) ecran.fillRect(x, y, 8, 8, SSD1306_WHITE);
  ecran.display();
  delay(ms - ms / 2);
  rafraichir();
  return true;
}

void rafraichir() {
  if (!g_present) return;

  // Écran d'appairage : il passe avant tout le reste tant qu'il n'a pas expiré.
  if (g_appairageFin != 0) {
    if ((int32_t)(millis() - g_appairageFin) >= 0) {
      g_appairageFin = 0;
      g_derniereActivite = millis();
    } else {
      ecran.clearDisplay();
      ecran.setTextColor(SSD1306_WHITE);
      ecran.setTextSize(1);
      if (g_qrPret) {
        // QR à gauche : fond blanc de 64 px (zone de silence comprise), modules
        // sombres de 2 × 2 px. Polarité normale, celle que tout lecteur accepte.
        ecran.fillRect(0, 0, 64, 64, SSD1306_WHITE);
        for (int y = 0; y < QR_MODULES; y++)
          for (int x = 0; x < QR_MODULES; x++)
            if (g_qr[y * QR_MODULES + x]) ecran.fillRect(7 + x * 2, 7 + y * 2, 2, 2, SSD1306_BLACK);
      }
      const int16_t gauche = g_qrPret ? 68 : 2;
      ecran.setCursor(gauche, 0);
      ecran.print(F("Appairage"));
      ecran.setCursor(gauche, 10);
      ecran.print(g_idAffiche);
      // Le jeton par blocs de six : lisible et recopiable sans erreur.
      for (uint8_t l = 0; l < 4; l++) {
        ecran.setCursor(gauche, 28 + l * 9);
        for (uint8_t k = 0; k < 6; k++) ecran.print(g_jetonAffiche[l * 6 + k]);
      }
      ecran.display();
      return;
    }
  }

  // Un défaut rallume toujours l'écran : c'est le moment où l'on veut le lire.
  bool alerte = false;
  for (uint8_t z = 0; z < NB_ZONES; z++)
    if (ctrl.zone[z].defaut != DEF_AUCUN || ctrl.zone[z].deriveActive) alerte = true;
  if (alerte) reveiller();

  // Ces dalles marquent quand elles affichent la même image en permanence.
  const uint16_t veille = Stockage::globaux().ecranVeilleMin;
  if (g_allume && veille > 0 && !alerte && millis() - g_derniereActivite > (uint32_t)veille * 60000UL) {
    g_allume = false;
    ecran.ssd1306_command(SSD1306_DISPLAYOFF);
  }
  if (!g_allume) return;
  ecran.clearDisplay();
  ecran.setTextColor(SSD1306_WHITE);

  for (uint8_t z = 0; z < NB_ZONES; z++) {
    const int y = z * 27;
    const ZoneEtat &s = ctrl.zone[z];
    ecran.setTextSize(1);
    ecran.setCursor(0, y);

    if (s.defaut != DEF_AUCUN) {
      ecran.print(ctrl.cfg[z].nom);
      ecran.setCursor(0, y + 11);
      ecran.print(F("! "));
      ecran.print(nomDefaut(s.defaut));
      continue;
    }

    ecran.printf("%.10s %.1f", ctrl.cfg[z].nom, (double)s.consigneEff);
    if (s.autotune == AT_ATTENTE || s.autotune == AT_OSCILLE)
      ecran.print(F(" AT"));
    else
      ecran.printf(" %d%%", (int)lroundf(s.demande * 100));

    ecran.setTextSize(2);
    ecran.setCursor(0, y + 10);
    if (isnan(s.temperature))
      ecran.print(F("--.-"));
    else
      ecran.printf("%.1f", (double)s.temperature);
    ecran.setTextSize(1);
    ecran.print(F("C"));

    if (ctrl.tapisActif() >= 0 && ZONE_DE_TAPIS[ctrl.tapisActif()] == z) {
      ecran.setCursor(78, y + 14);
      ecran.printf("T%d ON", ctrl.tapisActif() + 1);
    } else if (s.deriveActive) {
      ecran.setCursor(78, y + 14);
      ecran.print(F("derive"));
    }
  }

  ecran.drawFastHLine(0, 25, OLED_L, SSD1306_WHITE);
  ecran.setTextSize(1);
  ecran.setCursor(0, 56);
  ecran.print(heureFiable() ? horodatage().substring(11, 16) : String("--:--"));
  const int p = prochaineTransition();
  if (p >= 0) {
    ecran.print(F(" >"));
    ecran.printf("%dh%02d", p / 60, p % 60);
  }
  ecran.print(' ');
  if (ctrl.enMaintenance())
    ecran.print(F("ENTRETIEN"));
  else if (Reseau::modePointAcces())
    ecran.print(F("AP"));
  else
    ecran.print(Reseau::adresse());
  ecran.display();
}

}  // namespace Affichage
