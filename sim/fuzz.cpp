/* Fuzzing (libFuzzer) des modules sans Arduino : l'échappement JSON et les
   horaires (format.cpp), l'index d'anneau (anneau.cpp), l'encodeur QR (qr.cpp)
   et le cœur de régulation (controle.cpp) nourri de mesures arbitraires — NaN,
   infinis, dents de scie — et de réglages tirés au hasard.

   Ce que l'on cherche : un plantage, un débordement, un comportement indéfini
   (AddressSanitizer et UndefinedBehaviorSanitizer sont actifs), ou une
   invariante violée (deux tapis allumés à la fois, une zone en défaut qui
   chauffe). Pas un test de logique : les bancs s'en chargent.

     make fuzz            # 60 s par cible, échoue au premier problème
     make fuzz DUREE=600  # plus longtemps */
#include "../format.h"
#include "../anneau.h"
#include "../qr.h"
#include "../controle.h"
#include "socle-factice.h"
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <cmath>
#include <cstdlib>

#define ECHEC(m)                                                               \
  do {                                                                         \
    fprintf(stderr, "INVARIANT VIOLEE : %s (%s:%d)\n", m, __FILE__, __LINE__); \
    abort();                                                                   \
  } while (0)

namespace {

struct Lecteur {
  const uint8_t *d;
  size_t n;
  size_t i;
  Lecteur(const uint8_t *dd, size_t nn) : d(dd), n(nn), i(0) {}
  uint8_t octet() { return i < n ? d[i++] : 0; }
  uint32_t u32() {
    uint32_t v = 0;
    for (int k = 0; k < 4; k++) v = (v << 8) | octet();
    return v;
  }
  float flottant() {
    uint32_t v = u32();
    float f;
    memcpy(&f, &v, 4);
    return f;
  }
};

// --- format ---------------------------------------------------------------
void fuzzFormat(const uint8_t *d, size_t n) {
  char texte[512];
  const size_t l = n < sizeof texte - 1 ? n : sizeof texte - 1;
  memcpy(texte, d, l);
  texte[l] = '\0';
  for (size_t taille = 0; taille <= 40; taille++) {
    char sortie[48];
    memset(sortie, 0x7E, sizeof sortie);
    const size_t ecrit = formatEchapperJson(texte, sortie, taille);
    if (taille && ecrit >= taille) ECHEC("débordement annoncé");  // débordement annoncé
    if (taille && sortie[ecrit] != '\0') ECHEC("non terminé");    // non terminé
    if (taille && ecrit && sortie[ecrit - 1] == '\\' && (ecrit < 2 || sortie[ecrit - 2] != '\\'))
      ECHEC("antislash orphelin");  // antislash orphelin
    if (sortie[taille < 48 ? taille : 47] != 0x7E && taille < 47)
      ECHEC("a écrit au-delà du tampon");  // a écrit au-delà du tampon
  }
  uint16_t minutes = 0;
  if (formatParseHHMM(texte, minutes) && minutes >= 1440)
    ECHEC("if (formatParseHHMM(texte, minutes) && minutes >= 1440) abort();");
  char hh[8];
  formatHHMM((uint16_t)(n * 37), hh, sizeof hh);
}

// --- anneau ---------------------------------------------------------------
struct Flash {
  uint32_t seqs[64];
  uint32_t n;
};
bool lireSeq(uint32_t e, uint32_t &seq, void *ctx) {
  Flash *f = (Flash *)ctx;
  if (e >= f->n) return false;
  seq = f->seqs[e];
  return seq != 0xFFFFFFFFu;  // emplacement illisible simulé
}
void fuzzAnneau(const uint8_t *d, size_t n) {
  Lecteur r(d, n);
  Flash f;
  f.n = r.octet() % 64 + 1;
  for (uint32_t i = 0; i < f.n; i++) f.seqs[i] = r.u32();
  const uint32_t capacite = r.octet() % 64 + 1;
  Anneau a;
  anneauReconstruire(a, capacite, f.n < capacite ? f.n : capacite, lireSeq, &f);
  if (a.remplis > a.capacite || a.index >= a.capacite)
    ECHEC("if (a.remplis > a.capacite || a.index >= a.capacite) abort();");
  for (uint32_t k = 0; k < 70; k++) {
    uint32_t e;
    if (anneauEmplacementDuRang(a, k, e) && e >= a.capacite)
      ECHEC("for (uint32_t k = 0; k < 70; k++) { uint32_t e; if (anneauEmplacementD");
  }
  if (anneauEmplacementEcriture(a) >= a.capacite)
    ECHEC("if (anneauEmplacementEcriture(a) >= a.capacite) abort();");
  anneauAvancer(a);
  if (a.remplis > a.capacite || a.index >= a.capacite)
    ECHEC("if (a.remplis > a.capacite || a.index >= a.capacite) abort();");
  anneauVider(a);
  if (a.remplis != 0) ECHEC("if (a.remplis != 0) abort();");
}

// --- qr --------------------------------------------------------------------
void fuzzQr(const uint8_t *d, size_t n) {
  char texte[64];
  const size_t l = n < 63 ? n : 63;
  memcpy(texte, d, l);
  texte[l] = '\0';
  uint8_t m[QR_MODULES * QR_MODULES];
  if (qrEncoder(texte, m)) {
    // Un code produit a toujours ses trois repères et son module sombre.
    if (m[0] != 1 || m[QR_MODULES - 1] != 1 || m[(QR_MODULES - 1) * QR_MODULES] != 1 ||
        m[17 * QR_MODULES + 8] != 1)
      ECHEC("if (m[0] != 1 || m[QR_MODULES - 1] != 1 || m[(QR_MODULES - 1) * QR_MOD");
  }
}

// --- régulation ------------------------------------------------------------
void fuzzControle(const uint8_t *d, size_t n) {
  Lecteur r(d, n);
  static Controleur c;  // gros objet : pas sur la pile
  c = Controleur();
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    ReglagesZone rz;
    reglagesParDefaut(rz, z);
    rz.consigneJour = r.flottant();
    rz.consigneNuit = r.flottant();
    rz.tempMax = r.flottant();
    rz.bande = r.flottant();
    rz.ki = r.flottant();
    rz.offset = r.flottant();
    rz.debutJour = (uint16_t)r.u32();
    rz.debutNuit = (uint16_t)r.u32();
    rz.rampeMinutes = (uint16_t)r.u32();
    char err[100];
    if (!reglagesValides(rz, err, sizeof err)) { reglagesParDefaut(rz, z); }  // sinon, réglages d'usine
    c.cfg[z] = rz;
  }
  c.limiterZones(r.octet() % 3);
  c.decalageSaison(r.flottant());
  uint32_t t = 1000;
  c.demarrer(t);
  const uint16_t pas = (uint16_t)(r.octet() % 20 + 1);
  for (int k = 0; k < 400 && r.i < n + 8; k++) {
    t += pas * 500u;
    c.horloge(r.octet() & 1, (uint16_t)(r.u32() % 1500));
    for (uint8_t z = 0; z < NB_ZONES; z++) c.mesure(z, r.flottant(), t, pas * 0.5f);
    if ((r.octet() & 15) == 0) c.maintenance(t, (uint16_t)(r.octet() % 300));
    if ((r.octet() & 31) == 0) {
      char e[80];
      c.lancerAutotune(r.octet() % NB_ZONES, t, e, sizeof e);
    }
    if ((r.octet() & 31) == 1) c.leverDefauts(t);
    c.avancer(t);
    // Invariants : jamais plus de tapis que la limite, jamais une zone en
    // défaut qui chauffe, un duty toujours dans [0, 100].
    int allumes = 0;
    for (uint8_t i = 0; i < NB_TAPIS; i++)
      if (c.tapisAllume(i)) allumes++;
    if (allumes > c.limiteZones()) ECHEC("if (allumes > c.limiteZones()) abort();");
    for (uint8_t z = 0; z < NB_ZONES; z++) {
      if (c.zone[z].defaut != DEF_AUCUN && c.tapisDeZone(z) >= 0)
        ECHEC("if (c.zone[z].defaut != DEF_AUCUN && c.tapisDeZone(z) >= 0) abort();");
      const float dty = c.duty(z);
      if (!(dty >= 0.0f && dty <= 100.0f)) {
        fprintf(stderr, "duty=%f pas=%u k=%d t=%u\n", (double)dty, pas, k, t);
        ECHEC("duty hors [0, 100]");
      }
      if (!(c.zone[z].demande >= 0.0f && c.zone[z].demande <= 1.0f))
        ECHEC("if (!(c.zone[z].demande >= 0.0f && c.zone[z].demande <= 1.0f)) abort()");
    }
    Notification notif;
    while (c.prendreNotification(notif)) {
      if (strlen(notif.texte) >= sizeof notif.texte)
        ECHEC("while (c.prendreNotification(notif)) { if (strlen(notif.texte) >= size");
    }
  }
}

// --- canal de commande ------------------------------------------------------
// La charge arbitraire est d'abord envoyée telle quelle (JSON ou non), puis
// enveloppée dans une commande plausible avec le bon jeton pour atteindre les
// branches profondes : action tirée dans la liste, champ tiré dans la liste,
// valeur = les octets restants. Invariants : toujours exactement une réponse,
// plus courte que le tampon, et des réglages de zone qui restent valides.
void fuzzProtocole(const uint8_t *d, size_t n) {
  static SocleFactice socle;
  socle.vider();
  Protocole::traiterCommande(socle, (const char *)d, n);
  if (socle.reponses.size() != 1) ECHEC("une commande, une réponse");
  if (socle.reponses[0].size() >= Protocole::TAILLE_REPONSE) ECHEC("réponse trop longue");

  static const char *const ACTIONS[] = { "etat",      "version",    "zone",          "globaux", "alim",
                                         "entretien", "autotune",   "stop-autotune", "maj",     "historique",
                                         "reset",     "redemarrer", "stats" };
  static const char *const CHAMPS[] = {
    "z",       "jour",      "nuit",   "bande",        "ki",           "max",         "offset",
    "rampe",   "debutJour", "nom",    "amperes",      "watts",        "minutes",     "heures",
    "version", "url",       "forcer", "saisonActive", "entretienMin", "deriveSeuil", "chuteSecondes"
  };
  Lecteur l(d, n);
  const char *action = ACTIONS[l.octet() % (sizeof ACTIONS / sizeof ACTIONS[0])];
  const char *champ = CHAMPS[l.octet() % (sizeof CHAMPS / sizeof CHAMPS[0])];
  const bool chaine = l.octet() & 1;
  std::string valeur;
  for (size_t i = l.i; i < n && valeur.size() < 300; i++) valeur += (char)d[i];
  std::string json = "{\"req\":\"f\",\"action\":\"" + std::string(action) + "\",\"jeton\":\"" +
                     socle.jetonSecret + "\",\"" + champ + "\":";
  if (chaine) {
    char esc[700];
    formatEchapperJson(valeur.c_str(), esc, sizeof esc);
    json += "\"" + std::string(esc) + "\"";
  } else {
    json += valeur.empty() ? "0" : valeur;
  }
  json += "}";
  socle.vider();
  Protocole::oublierReponses();
  Protocole::traiterCommande(socle, json.c_str(), json.size());
  if (socle.reponses.size() != 1) ECHEC("une commande enveloppée, une réponse");
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    char err[100];
    if (!reglagesValides(socle.zones[z], err, sizeof err))
      ECHEC("réglages de zone invalides après une commande");
    if (strlen(socle.zones[z].nom) >= sizeof socle.zones[z].nom) ECHEC("nom de zone non terminé");
  }
  if (!Stockage::globauxValides(socle.glob, nullptr, 0))
    ECHEC("réglages globaux invalides après une commande");
}

}  // namespace

extern "C" int LLVMFuzzerTestOneInput(const uint8_t *d, size_t n) {
  if (n == 0) return 0;
  switch (d[0] % 5) {
    case 0: fuzzFormat(d + 1, n - 1); break;
    case 1: fuzzAnneau(d + 1, n - 1); break;
    case 2: fuzzQr(d + 1, n - 1); break;
    case 3: fuzzProtocole(d + 1, n - 1); break;
    default: fuzzControle(d + 1, n - 1); break;
  }
  return 0;
}
