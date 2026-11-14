#include "affichage.h"
#include "essai.h"
#include "liaisons.h"
#include "reseau.h"
#include "sondes.h"
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
bool g_attenue = false;
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

// Pages du bouton BOOT, et avis temporaire.
uint8_t g_page = 0;
const uint8_t NB_PAGES = 5;  // zones, courbes 6 h, réseau, sondes, système
uint32_t g_pageDepuis = 0;
const uint32_t PAGE_RETOUR_MS = 30000;
char g_avis1[24] = "", g_avis2[24] = "";
uint32_t g_avisFin = 0;

// Courbes des 6 dernières heures : un point toutes les 3 min, relu dans
// l'historique en flash au plus une fois par minute, et seulement quand la
// page est affichée.
const uint8_t COURBE_POINTS = 120;
const uint32_t COURBE_MINUTES = 360;
int16_t g_courbe[NB_ZONES][COURBE_POINTS];
uint8_t g_courbeN = 0;
uint32_t g_courbeCalculee = 0;

// Tendance : température de chaque zone il y a ~5 min.
float g_tendanceRef[NB_ZONES] = { NAN, NAN };
uint32_t g_tendanceDepuis = 0;
const uint32_t TENDANCE_MS = 300000;
const float TENDANCE_SEUIL = 0.3f;

// Minutes restantes avant le prochain basculement jour/nuit, ou -1 si l'heure
// n'est pas connue.
int prochaineTransition() {
  if (!heureFiable()) return -1;
  const uint16_t m = minutesDuJour();
  int meilleur = -1;
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    const uint16_t a = (uint16_t)((ctrl.debutJour(z) + 1440 - m) % 1440);
    const uint16_t b = (uint16_t)((ctrl.debutNuit(z) + 1440 - m) % 1440);
    const int p = (a < b) ? a : b;
    if (meilleur < 0 || p < meilleur) meilleur = p;
  }
  return meilleur;
}

// La nuit de la zone 1 décide de l'atténuation de l'écran.
bool cestLaNuit() {
  if (!heureFiable()) return false;
  const uint16_t m = minutesDuJour(), j = ctrl.debutJour(0), n = ctrl.debutNuit(0);
  return (j < n) ? (m < j || m >= n) : (m >= n && m < j);
}

bool echu(uint32_t fin) { return fin == 0 || (int32_t)(millis() - fin) >= 0; }

void entete(const char *titre) {
  ecran.clearDisplay();
  ecran.setTextColor(SSD1306_WHITE);
  ecran.setTextSize(1);
  ecran.setCursor(0, 0);
  ecran.print(titre);
  ecran.drawFastHLine(0, 9, OLED_L, SSD1306_WHITE);
  ecran.setCursor(0, 12);
}

// Coupe un texte long sur deux lignes de 21 caractères.
void ligneLongue(const String &s) {
  ecran.println(s.substring(0, 21));
  if (s.length() > 21) ecran.println(s.substring(21, 42));
}

void pageReseau() {
  entete("RESEAU");
  ecran.setCursor(54, 0);
  ecran.print(Reseau::identifiant());
  ecran.setCursor(0, 12);
  if (Reseau::modePointAcces()) {
    // Tout ce qu'il faut pour rejoindre le socle depuis un téléphone. Le MQTT
    // n'a pas de sens sans réseau : sa ligne laisse la place au mot de passe.
    ecran.println(F("Point d'acces ouvert"));
    ecran.println(Reseau::ssidConfiguration());  // 23 caracteres : deux lignes
    ecran.println(F("Mot de passe :"));
    ecran.println(Stockage::reseau().apMotDePasse);
  } else {
    if (Reseau::connecte()) {
      ecran.print(F("WiFi "));
      ecran.println(Reseau::ssidConnecte());
      ecran.printf("%d dBm  ", Reseau::rssi());
      ecran.println(Reseau::adresse());
    } else {
      ecran.println(F("WiFi : non connecte"));
      ecran.println(Stockage::reseau().ssid);
    }
    ligneLongue("MQTT " + Reseau::etatMqtt());
  }
  ecran.print(F("Web : "));
  ecran.println(Stockage::reseau().webUtilisateur[0] ? F("protege") : F("mdp a creer"));
}

bool visiteCourbe(const Echantillon &e, void *ctx) {
  uint8_t *n = (uint8_t *)ctx;
  if (*n >= COURBE_POINTS) return false;
  for (uint8_t z = 0; z < NB_ZONES; z++) g_courbe[z][*n] = e.t[z];
  (*n)++;
  return true;
}

void pageCourbes() {
  const uint32_t maintenant = millis();
  if (g_courbeCalculee == 0 || maintenant - g_courbeCalculee > 60000UL) {
    g_courbeCalculee = maintenant ? maintenant : 1;
    const uint32_t total = Stockage::histNombre();
    uint8_t n = 0;
    Stockage::histParcourir(total > COURBE_MINUTES ? total - COURBE_MINUTES : 0,
                            COURBE_MINUTES / COURBE_POINTS, visiteCourbe, &n);
    g_courbeN = n;
  }
  entete("6 h");
  int32_t lo = 32767, hi = -32767;
  for (uint8_t z = 0; z < NB_ZONES; z++)
    for (uint8_t i = 0; i < g_courbeN; i++) {
      const int16_t v = g_courbe[z][i];
      if (v == -32768) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  if (g_courbeN < 2 || lo > hi) {
    ecran.println(F("Pas encore assez"));
    ecran.println(F("d'historique."));
    return;
  }
  // Un demi-degré de marge et au moins 2 °C d'amplitude : une température
  // stable ne doit pas ressembler à des dents de scie.
  lo -= 50;
  hi += 50;
  if (hi - lo < 200) {
    const int32_t m = (lo + hi) / 2;
    lo = m - 100;
    hi = m + 100;
  }
  ecran.setCursor(24, 0);
  ecran.printf("%.1f-%.1f C", lo / 100.0, hi / 100.0);
  // Légende : zone 1 en trait plein, zone 2 en pointillés.
  ecran.setCursor(98, 0);
  ecran.print('1');
  ecran.drawFastHLine(104, 3, 6, SSD1306_WHITE);
  ecran.setCursor(113, 0);
  ecran.print('2');
  for (int16_t x = 119; x < OLED_L; x += 2) ecran.drawPixel(x, 3, SSD1306_WHITE);
  // Le bord droit est « maintenant » : avec moins de 6 h d'historique, la
  // courbe commence plus à droite, l'échelle de temps ne change pas.
  const int32_t haut = 12, bas = OLED_H - 1;
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    int16_t px = -1, py = -1;
    for (uint8_t i = 0; i < g_courbeN; i++) {
      const int16_t v = g_courbe[z][i];
      if (v == -32768) {
        px = -1;
        continue;
      }
      const int16_t x = (int16_t)(OLED_L - 1 -
                                  (int32_t)(g_courbeN - 1 - i) * (OLED_L - 1) / (COURBE_POINTS - 1));
      const int16_t y = (int16_t)(bas - (v - lo) * (bas - haut) / (hi - lo));
      if (z == 0 && px >= 0)
        ecran.drawLine(px, py, x, y, SSD1306_WHITE);
      else if (z == 0 || i % 2 == 0)
        ecran.drawPixel(x, y, SSD1306_WHITE);
      px = x;
      py = y;
    }
  }
}

void pageSondes() {
  Sondes::InfoSonde t[4];
  const uint8_t n = Sondes::inventaire(t, 4);
  char titre[24];
  snprintf(titre, sizeof titre, "SONDES (%u sur le bus)", (unsigned)Sondes::nombreDetecte());
  entete(titre);
  for (uint8_t i = 0; i < n; i++) {
    char rom[20];
    Liaisons::romTexte(t[i].rom, rom, sizeof rom);
    ecran.printf("..%s ", rom + 10);
    if (isnan(t[i].temperature))
      ecran.print(F("--.- "));
    else
      ecran.printf("%4.1f ", (double)t[i].temperature);
    if (t[i].zone >= 0)
      ecran.printf("Z%d\n", t[i].zone + 1);
    else
      ecran.println(F("libre"));
  }
  for (uint8_t z = 0; z < NB_ZONES; z++)
    if (isnan(ctrl.zone[z].temperature) || ctrl.zone[z].defaut == DEF_SONDE)
      ecran.printf("Z%u : pas de mesure\n", z + 1);
  ecran.setCursor(0, 56);
  ecran.print(F("BOOT 3 s : appairage"));
}

void pageSysteme() {
  entete("SYSTEME  v" FW_VERSION);
  const uint32_t s = millis() / 1000;
  ecran.printf("Allume %lu j %02lu h %02lu\n", (unsigned long)(s / 86400), (unsigned long)(s % 86400 / 3600),
               (unsigned long)(s % 3600 / 60));
  ecran.printf("Memoire %lu Ko (bloc %lu)\n", (unsigned long)(ESP.getFreeHeap() / 1024),
               (unsigned long)(ESP.getMaxAllocHeap() / 1024));
  ligneLongue(String("Redemarrage : ") + raisonRedemarrage());
  const ReglagesGlobaux &g = Stockage::globaux();
  ecran.printf("Alim %.1f A : %u zone%s\n", (double)g.courantAlimA, ctrl.limiteZones(),
               ctrl.limiteZones() > 1 ? "s" : "");
  if (g.rapportActif)
    ecran.printf("Rapport a %02u:%02u\n", g.rapportMinutes / 60, g.rapportMinutes % 60);
  else
    ecran.println(F("Rapport : desactive"));
}

// Écran d'un essai en cours (identification de sonde, essai de chauffe).
bool ecranEssai() {
  const int8_t zi = Sondes::zoneEnIdentification();
  if (zi >= 0) {
    entete("IDENTIFICATION");
    ecran.setTextSize(2);
    ecran.printf("Zone %d\n", zi + 1);
    ecran.setTextSize(1);
    ecran.println(F("Serrez sa sonde dans"));
    ecran.println(F("la main (ou refroidir)"));
    ecran.printf("Chauffe coupee  %u s", Sondes::identificationRestanteS());
    return true;
  }
  const int8_t ze = Essai::zoneEnCours();
  if (ze >= 0) {
    entete("ESSAI DE CHAUFFE");
    ecran.setTextSize(2);
    ecran.printf("Zone %d\n", ze + 1);
    ecran.setTextSize(1);
    ecran.printf("%.2f C\n", (double)ctrl.zone[ze].temperature);
    ecran.println(F("Pleine puissance"));
    ecran.printf("Reste %u s", Essai::restantS());
    return true;
  }
  return false;
}

// Dernière ligne de la page principale : ce qui ne va pas, sinon l'adresse.
String statut() {
  if (ctrl.enMaintenance()) return F("ENTRETIEN");
  // Point d'accès : « AP config » et son mot de passe en alternance, toutes les
  // 4 s — c'est ce qu'il faut lire pour configurer le socle depuis un téléphone.
  if (Reseau::modePointAcces())
    return (millis() / 4000) % 2 ? String("mdp ") + Stockage::reseau().apMotDePasse : String(F("AP config"));
  if (!Reseau::connecte()) return F("WIFI --");
  const char *m = Reseau::etatCourtMqtt();
  if (m[0]) return String(m);
  return Reseau::adresse();
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
  ecran.cp437(true);  // vraies flèches ↑ ↓ (0x18, 0x19)
  ecran.clearDisplay();
  ecran.setTextColor(SSD1306_WHITE);
  ecran.setTextSize(1);
  ecran.setCursor(0, 0);
  ecran.println(F("Thermostat terrarium"));
  ecran.println(F("v" FW_VERSION));
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

void pageSuivante() {
  // Premier appui sur un écran éteint : on le rallume, sans changer de page.
  const bool etaitEteint = !g_allume;
  reveiller();
  if (!etaitEteint) g_page = (uint8_t)((g_page + 1) % NB_PAGES);
  g_pageDepuis = millis();
  rafraichir();
}

void avis(const String &l1, const String &l2, uint32_t ms) {
  snprintf(g_avis1, sizeof g_avis1, "%s", l1.c_str());
  snprintf(g_avis2, sizeof g_avis2, "%s", l2.c_str());
  g_avisFin = millis() + ms;
  if (g_avisFin == 0) g_avisFin = 1;
  reveiller();
  rafraichir();
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
  g_avisFin = 0;
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
  const uint32_t maintenant = millis();

  // Tendances : une référence toutes les 5 min.
  if (g_tendanceDepuis == 0 || maintenant - g_tendanceDepuis >= TENDANCE_MS) {
    g_tendanceDepuis = maintenant ? maintenant : 1;
    for (uint8_t z = 0; z < NB_ZONES; z++) g_tendanceRef[z] = ctrl.zone[z].temperature;
  }

  // Écran d'appairage : il passe avant tout le reste tant qu'il n'a pas expiré.
  if (g_appairageFin != 0) {
    if (echu(g_appairageFin)) {
      g_appairageFin = 0;
      g_derniereActivite = maintenant;
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
    if (ctrl.zone[z].defaut != DEF_AUCUN || ctrl.zone[z].deriveActive || ctrl.zone[z].tropChaudActif)
      alerte = true;
  const bool essai = Sondes::zoneEnIdentification() >= 0 || Essai::zoneEnCours() >= 0;
  if (alerte || essai) reveiller();

  // La nuit : écran atténué (défaut), normal ou éteint selon le réglage. Un
  // appui sur BOOT ou un défaut le rallume quand même.
  const ReglagesGlobaux &g = Stockage::globaux();
  const bool nuit = cestLaNuit();
  const bool attenuer = nuit && g.ecranNuit == ECRAN_NUIT_ATTENUE;
  if (attenuer != g_attenue) {
    g_attenue = attenuer;
    ecran.dim(attenuer);
  }
  // Ces dalles marquent quand elles affichent la même image en permanence.
  const uint16_t veille = g.ecranVeilleMin;
  const bool eteindreNuit = nuit && g.ecranNuit == ECRAN_NUIT_ETEINT &&
                            maintenant - g_derniereActivite > 60000UL;
  if (g_allume && !alerte && !essai &&
      ((veille > 0 && maintenant - g_derniereActivite > (uint32_t)veille * 60000UL) || eteindreNuit)) {
    g_allume = false;
    ecran.ssd1306_command(SSD1306_DISPLAYOFF);
  }
  if (!g_allume) return;

  if (!echu(g_avisFin)) {
    entete("");
    ecran.setCursor(0, 20);
    ecran.print(g_avis1);
    ecran.setCursor(0, 34);
    ecran.print(g_avis2);
    ecran.display();
    return;
  }
  g_avisFin = 0;

  if (ecranEssai()) {
    ecran.display();
    return;
  }

  if (g_page != 0 && maintenant - g_pageDepuis > PAGE_RETOUR_MS) g_page = 0;
  if (g_page != 0) {
    if (g_page == 1)
      pageCourbes();
    else if (g_page == 2)
      pageReseau();
    else if (g_page == 3)
      pageSondes();
    else
      pageSysteme();
    ecran.display();
    return;
  }

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
    if (isfinite(s.temperature) && isfinite(g_tendanceRef[z])) {
      const float d = s.temperature - g_tendanceRef[z];
      if (d >= TENDANCE_SEUIL)
        ecran.write(0x18);  // ↑
      else if (d <= -TENDANCE_SEUIL)
        ecran.write(0x19);  // ↓
    }

    if (ctrl.tapisActif() >= 0 && ZONE_DE_TAPIS[ctrl.tapisActif()] == z) {
      ecran.setCursor(78, y + 14);
      ecran.printf("T%d ON", ctrl.tapisActif() + 1);
    } else if (s.tropChaudActif) {
      ecran.setCursor(78, y + 14);
      ecran.print(F("CHAUD"));
    } else if (s.deriveActive) {
      ecran.setCursor(78, y + 14);
      ecran.print(F("derive"));
    }
  }

  ecran.drawFastHLine(0, 25, OLED_L, SSD1306_WHITE);
  ecran.setTextSize(1);
  ecran.setCursor(0, 56);
  ecran.print(heureFiable() ? horodatage().substring(11, 16) : String("--:--"));
  const String etat = statut();
  const int p = prochaineTransition();
  // 21 caractères par ligne : l'adresse IP ne laisse pas la place au compte à
  // rebours ; un problème, lui, s'affiche toujours.
  if (p >= 0 && 6 + 7 + etat.length() <= 21) ecran.printf(" >%dh%02d", p / 60, p % 60);
  ecran.print(' ');
  ecran.print(etat);
  ecran.display();
}

}  // namespace Affichage
