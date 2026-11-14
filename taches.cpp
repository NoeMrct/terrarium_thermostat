#include "taches.h"
#include "reseau.h"
#include "soleil.h"
#include "stockage.h"
#include <time.h>

namespace {

uint32_t g_epochSauvegarde = 0;
volatile bool g_ntpFrais = false;  // écrit par la tâche SNTP, lu par la boucle
bool g_coupureTraitee = false;
uint32_t g_derniereMinute = 0;
bool g_serieRemiseAZero = false;

// Mémoire : alerte quand le plus grand bloc libre reste petit (fragmentation).
uint8_t g_memoireBasse = 0;
bool g_memoireSignalee = false;
const uint32_t BLOC_MIN = 16384, BLOC_RETABLI = 32768;

// Jour courant (année × 400 + jour de l'année), pour ne faire chaque chose
// qu'une fois par jour. 0 = pas encore connu.
uint32_t g_jour = 0;
uint32_t g_epochRapport = 0;         // dernier rapport envoyé
const uint16_t FENETRE_RAPPORT = 5;  // minutes : une boucle retardée ne fait pas sauter le rapport
int16_t g_leverApplique = -1, g_coucherApplique = -1;

// Base du rapport : cumuls au rapport précédent (ou au démarrage).
uint32_t g_baseSecondes[NB_ZONES] = { 0, 0 };
uint16_t g_baseDefauts[NB_ZONES] = { 0, 0 };
bool g_baseDepuisRapport = false;

uint16_t defautsCumules(uint8_t z) {
  uint32_t n = 0;
  for (uint8_t d = DEF_SONDE; d <= DEF_INEFFICACE; d++) n += ctrl.zone[z].nbDefauts[d];
  return n > 65535 ? 65535 : (uint16_t)n;
}

bool visite(const Echantillon &e, void *ctx) {
  Taches::Stats *s = (Taches::Stats *)ctx;
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    if (e.t[z] == -32768) continue;
    const float t = e.t[z] / 100.0f;
    if (s->n[z] == 0 || t < s->mini[z]) s->mini[z] = t;
    if (s->n[z] == 0 || t > s->maxi[z]) s->maxi[z] = t;
    s->somme[z] += t;
    s->n[z]++;
    if (e.c[z] != -32768 && fabsf(t - e.c[z] / 100.0f) > 1.0f) s->horsPlage[z]++;
  }
  return true;
}

uint32_t cleJour(const struct tm &t) { return (uint32_t)(t.tm_year + 1900) * 400u + (uint32_t)t.tm_yday; }

String duree(uint32_t s) {
  char b[24];
  if (s >= 3600)
    snprintf(b, sizeof b, "%lu h %02lu", (unsigned long)(s / 3600), (unsigned long)((s % 3600) / 60));
  else
    snprintf(b, sizeof b, "%lu min", (unsigned long)(s / 60));
  return String(b);
}

String hhmm(uint16_t m) {
  char b[8];
  snprintf(b, sizeof b, "%02u:%02u", (unsigned)(m / 60), (unsigned)(m % 60));
  return String(b);
}

// Une coupure de courant se lit au retour de l'heure réseau : l'heure n'est
// mise en flash que toutes les PERIODE_EPOCH_MS, la durée est donc donnée dans
// une fourchette.
void signalerCoupure() {
  g_coupureTraitee = true;
  const esp_reset_reason_t r = esp_reset_reason();
  if (r != ESP_RST_POWERON && r != ESP_RST_BROWNOUT) return;
  if (g_epochSauvegarde < 1700000000UL) return;
  const uint32_t maintenant = (uint32_t)time(nullptr);
  const uint32_t demarrage = maintenant - millis() / 1000;
  if (demarrage <= g_epochSauvegarde) return;
  const uint32_t auPlus = demarrage - g_epochSauvegarde;
  const uint32_t periode = PERIODE_EPOCH_MS / 1000;
  const uint32_t auMoins = auPlus > periode ? auPlus - periode : 0;
  if (auMoins < 300) return;  // quelques minutes : un débranchement volontaire
  time_t td = (time_t)demarrage;
  struct tm tm;
  localtime_r(&td, &tm);
  char texte[160];
  snprintf(texte, sizeof texte,
           "Coupure de courant de %s a %s, retour a %02d:%02d : chauffage arrete pendant ce temps.",
           duree(auMoins).c_str(), duree(auPlus).c_str(), tm.tm_hour, tm.tm_min);
  journal("%s", texte);
  Reseau::alerter(NOTIF_INFO, NB_ZONES, String(texte));
}

void enregistrerJour() {
  Taches::Stats st;
  Taches::statistiques(1440, st);
  ResumeJour j;
  memset(&j, 0, sizeof j);
  j.epoch = (uint32_t)time(nullptr);
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    if (st.n[z]) {
      j.mini[z] = (int16_t)lroundf(st.mini[z] * 100.0f);
      j.maxi[z] = (int16_t)lroundf(st.maxi[z] * 100.0f);
      j.moyenne[z] = (int16_t)lroundf(st.somme[z] / st.n[z] * 100.0f);
    } else {
      j.mini[z] = j.maxi[z] = j.moyenne[z] = -32768;
    }
    j.secondesChauffe[z] = secondesChauffeTotales(z);
    j.defauts[z] = defautsCumules(z);
  }
  Stockage::joursAjouter(j);
}

void surNouveauJour(const struct tm &t) {
  const uint32_t cle = cleJour(t);
  if (g_jour != 0 && cle != g_jour) enregistrerJour();  // minuit passé : la veille est complète
  if (cle != g_jour) {
    g_jour = cle;
    Taches::appliquerSoleil();
  }
}

String temperature(int16_t c) { return c == -32768 ? String("null") : String(c / 100.0f, 2); }

}  // namespace

namespace Taches {

void statistiques(uint32_t points, Stats &s) {
  memset(&s, 0, sizeof s);
  const uint32_t total = Stockage::histNombre();
  const uint32_t debut = (total > points) ? total - points : 0;
  Stockage::histParcourir(debut, 1, visite, &s);
}

void demarrer(uint32_t epochSauvegarde) {
  g_epochSauvegarde = epochSauvegarde;
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    g_baseSecondes[z] = secondesChauffeTotales(z);
    g_baseDefauts[z] = defautsCumules(z);
  }
  // Redémarrages anormaux en série : un seul se comprend (une panique, une
  // chute de tension), trois de suite disent qu'il faut intervenir.
  if (redemarrageAnormal()) {
    const uint8_t serie = (uint8_t)(Stockage::lireCompteur("serie") + 1);
    Stockage::ecrireCompteur("serie", serie);
    if (serie >= 3) {
      char texte[160];
      snprintf(texte, sizeof texte,
               "%u redemarrages anormaux de suite (dernier : %s) : alimentation trop faible, cablage ou "
               "plantage a corriger.",
               serie, raisonRedemarrage());
      journal("%s", texte);
      Reseau::alerter(NOTIF_INFO, NB_ZONES, String(texte));
    }
  } else if (Stockage::lireCompteur("serie") != 0) {
    Stockage::ecrireCompteur("serie", 0);
  }
}

void heureSynchronisee() { g_ntpFrais = true; }

void boucle(uint32_t maintenant) {
  if (g_ntpFrais && !g_coupureTraitee) signalerCoupure();
  if (g_derniereMinute != 0 && maintenant - g_derniereMinute < 60000) return;
  g_derniereMinute = maintenant ? maintenant : 1;

  // Dix minutes sans plantage : la série est rompue.
  if (!g_serieRemiseAZero && maintenant > 600000UL) {
    g_serieRemiseAZero = true;
    if (Stockage::lireCompteur("serie") != 0) Stockage::ecrireCompteur("serie", 0);
  }

  // Mémoire fragmentée : le tas total peut sembler confortable alors qu'aucun
  // bloc ne suffit plus à une réponse TLS ou à un gros JSON.
  const uint32_t bloc = ESP.getMaxAllocHeap();
  if (bloc < BLOC_MIN) {
    if (++g_memoireBasse >= 3 && !g_memoireSignalee) {
      g_memoireSignalee = true;
      char texte[140];
      snprintf(texte, sizeof texte,
               "Memoire fragmentee : plus grand bloc libre %lu Ko. Un redemarrage la remettra a neuf.",
               (unsigned long)(bloc / 1024));
      journal("%s", texte);
      Reseau::alerter(NOTIF_INFO, NB_ZONES, String(texte));
    }
  } else {
    g_memoireBasse = 0;
    if (bloc > BLOC_RETABLI) g_memoireSignalee = false;
  }

  // Une heure restaurée de la flash (non resynchronisée) peut être fausse de
  // la durée d'une coupure : on attend l'heure réseau pour dater les journées.
  if (!heureFiable() || heureApproximative()) return;
  time_t t = time(nullptr);
  struct tm tm;
  localtime_r(&t, &tm);
  surNouveauJour(tm);

  const ReglagesGlobaux &g = Stockage::globaux();
  const uint16_t ecart = (uint16_t)((tm.tm_hour * 60 + tm.tm_min + 1440 - g.rapportMinutes) % 1440);
  if (g.rapportActif && ecart < FENETRE_RAPPORT && (uint32_t)t - g_epochRapport > 6UL * 3600UL) {
    g_epochRapport = (uint32_t)t;
    envoyerRapport();
  }
}

float kwh(uint32_t secondes) { return secondes / 3600.0f * Stockage::globaux().puissanceTapisW / 1000.0f; }

float euros(uint32_t secondes) { return kwh(secondes) * Stockage::globaux().prixKwh; }

String rapport() {
  Stats st;
  statistiques(1440, st);
  const ReglagesGlobaux &g = Stockage::globaux();
  String s = "Rapport";
  if (heureFiable()) s += " du " + horodatage().substring(8, 10) + "/" + horodatage().substring(5, 7);
  s += " (temperatures sur 24 h, chauffe " +
       String(g_baseDepuisRapport ? "depuis le rapport precedent" : "depuis le demarrage") + ")";
  uint32_t totalSec = 0;
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    const uint32_t sec = secondesChauffeTotales(z) - g_baseSecondes[z];
    const uint16_t def = defautsCumules(z) - g_baseDefauts[z];
    totalSec += sec;
    s += ". " + String(ctrl.cfg[z].nom) + " : ";
    if (st.n[z])
      s += String(st.mini[z], 1) + " a " + String(st.maxi[z], 1) + " C (moy. " +
           String(st.somme[z] / st.n[z], 1) + ", hors plage " +
           String((int)lroundf(100.0f * st.horsPlage[z] / st.n[z])) + " %)";
    else
      s += "pas de mesure";
    s += ", chauffe " + String(sec / 3600.0f, 1) + " h = " + String(kwh(sec), 2) + " kWh";
    if (g.prixKwh > 0.0f) s += " (" + String(euros(sec), 2) + " EUR)";
    s += ", " + String(def) + " defaut" + (def > 1 ? "s" : "");
    if (ctrl.zone[z].defaut != DEF_AUCUN) s += " — EN DEFAUT : " + String(nomDefaut(ctrl.zone[z].defaut));
  }
  s += ". Total " + String(kwh(totalSec), 2) + " kWh";
  if (g.prixKwh > 0.0f) s += " = " + String(euros(totalSec), 2) + " EUR";
  s += ".";
  return s;
}

void envoyerRapport() {
  const String texte = rapport();
  journal("Rapport quotidien : %s", texte.c_str());
  Reseau::alerter(NOTIF_RAPPORT, NB_ZONES, texte);
  Reseau::publierRapport(texte);
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    g_baseSecondes[z] = secondesChauffeTotales(z);
    g_baseDefauts[z] = defautsCumules(z);
  }
  g_baseDepuisRapport = true;
}

String joursJson(uint16_t n, size_t maxOctets) {
  const uint16_t total = Stockage::joursNombre();
  if (n > total) n = total;
  String j = "{\"prixKwh\":" + String(Stockage::globaux().prixKwh, 4) + ",\"jours\":[";
  ResumeJour r, avant;
  for (uint16_t i = 0; i < n; i++) {
    if (!Stockage::joursLire(i, r)) break;
    const bool precedent = Stockage::joursLire(i + 1, avant);
    // Le résumé est écrit juste après minuit : la journée résumée est la veille.
    time_t td = (time_t)(r.epoch - 3600);
    struct tm tm;
    localtime_r(&td, &tm);
    char date[12];
    strftime(date, sizeof date, "%Y-%m-%d", &tm);
    String jour = "{\"date\":\"" + String(date) + "\",\"zones\":[";
    for (uint8_t z = 0; z < NB_ZONES; z++) {
      if (z) jour += ",";
      jour += "{\"min\":" + temperature(r.mini[z]) + ",\"max\":" + temperature(r.maxi[z]) +
              ",\"moyenne\":" + temperature(r.moyenne[z]);
      if (precedent && r.secondesChauffe[z] >= avant.secondesChauffe[z]) {
        const uint32_t sec = r.secondesChauffe[z] - avant.secondesChauffe[z];
        jour += ",\"heures\":" + String(sec / 3600.0f, 2) + ",\"kWh\":" + String(kwh(sec), 3) +
                ",\"euros\":" + String(euros(sec), 3) + ",\"defauts\":" +
                String(r.defauts[z] >= avant.defauts[z] ? r.defauts[z] - avant.defauts[z] : 0);
      } else {
        jour += ",\"heures\":null,\"kWh\":null,\"euros\":null,\"defauts\":null";
      }
      jour += "}";
    }
    jour += "]}";
    // Un message MQTT a une taille : les jours les plus anciens restent alors
    // sur le socle (la page locale, elle, n'a pas de limite).
    if (maxOctets && j.length() + jour.length() + 3 > maxOctets) break;
    if (i) j += ",";
    j += jour;
  }
  j += "]}";
  return j;
}

String joursTexte(uint16_t n) {
  const uint16_t total = Stockage::joursNombre();
  if (total == 0) return String("Aucun resume journalier pour l'instant (le premier s'ecrit a minuit).\n");
  if (n > total) n = total;
  String s = String(total) + " jour(s) en memoire (un an au plus) :\n";
  ResumeJour r, avant;
  for (uint16_t i = 0; i < n; i++) {
    if (!Stockage::joursLire(i, r)) break;
    const bool precedent = Stockage::joursLire(i + 1, avant);
    time_t td = (time_t)(r.epoch - 3600);
    struct tm tm;
    localtime_r(&td, &tm);
    char date[12];
    strftime(date, sizeof date, "%Y-%m-%d", &tm);
    s += String("  ") + date;
    for (uint8_t z = 0; z < NB_ZONES; z++) {
      s += "  Z" + String(z + 1) + " ";
      s += r.mini[z] == -32768 ? String("--")
                               : String(r.mini[z] / 100.0f, 1) + "-" + String(r.maxi[z] / 100.0f, 1);
      if (precedent && r.secondesChauffe[z] >= avant.secondesChauffe[z]) {
        const uint32_t sec = r.secondesChauffe[z] - avant.secondesChauffe[z];
        s += " " + String(sec / 3600.0f, 1) + "h " + String(kwh(sec), 2) + "kWh";
        if (Stockage::globaux().prixKwh > 0.0f) s += " " + String(euros(sec), 2) + "EUR";
      }
    }
    s += "\n";
  }
  return s;
}

void appliquerSoleil() {
  const ReglagesGlobaux &g = Stockage::globaux();
  if (!g.soleilActif || !heureFiable()) {
    if (ctrl.soleilActif()) journal("Jour et nuit : retour aux horaires fixes de chaque zone");
    ctrl.horairesSoleil(false, 0, 0);
    g_leverApplique = g_coucherApplique = -1;
    return;
  }
  const time_t t = time(nullptr);
  struct tm lt, ut;
  localtime_r(&t, &lt);
  gmtime_r(&t, &ut);
  // Décalage du fuseau (heure d'été comprise), en minutes.
  int32_t decalage = (lt.tm_hour * 60 + lt.tm_min) - (ut.tm_hour * 60 + ut.tm_min);
  const int32_t jl = (lt.tm_year + 1900) * 400 + lt.tm_yday, ju = (ut.tm_year + 1900) * 400 + ut.tm_yday;
  if (jl > ju) decalage += 1440;
  if (jl < ju) decalage -= 1440;
  int16_t lever = 0, coucher = 0;
  if (!Soleil::horairesUtc((uint16_t)(lt.tm_yday + 1), g.latitude, g.longitude, lever, coucher)) {
    ctrl.horairesSoleil(false, 0, 0);
    journal(
        "Jour et nuit : pas de lever ou de coucher du soleil a cette latitude aujourd'hui, horaires fixes");
    return;
  }
  const uint16_t l = Soleil::dansLaJournee(lever + decalage + g.soleilDecalageMin);
  const uint16_t c = Soleil::dansLaJournee(coucher + decalage + g.soleilDecalageMin);
  ctrl.horairesSoleil(true, l, c);
  if ((int16_t)l != g_leverApplique || (int16_t)c != g_coucherApplique) {
    g_leverApplique = (int16_t)l;
    g_coucherApplique = (int16_t)c;
    journal("Jour et nuit cales sur le soleil : jour a %s, nuit a %s", hhmm(l).c_str(), hhmm(c).c_str());
  }
}

}  // namespace Taches
