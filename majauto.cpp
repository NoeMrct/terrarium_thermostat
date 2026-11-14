/* majauto.cpp — versions, en-tête d'image, manifeste, déploiement progressif et
   décision des mises à jour automatiques. Voir majauto.h. */
#include "majauto.h"

#include <stdio.h>
#include <string.h>
#include <ArduinoJson.h>

namespace MajAuto {

namespace {

// Trois nombres sans zéro de tête, de 0 à 65535, séparés par des points.
bool lireVersion(const char *v, uint32_t n[3]) {
  if (!v) return false;
  const size_t longueur = strlen(v);
  if (longueur < 5 || longueur > 15) return false;
  const char *p = v;
  for (int i = 0; i < 3; i++) {
    if (*p < '0' || *p > '9') return false;
    if (*p == '0' && p[1] >= '0' && p[1] <= '9') return false;  // « 03 »
    uint32_t x = 0;
    int chiffres = 0;
    while (*p >= '0' && *p <= '9') {
      x = x * 10 + (uint32_t)(*p - '0');
      if (++chiffres > 5) return false;
      p++;
    }
    if (x > 65535) return false;
    n[i] = x;
    if (i < 2) {
      if (*p != '.') return false;
      p++;
    }
  }
  return *p == '\0';
}

// Copie une chaîne de longueur bornée si elle est entièrement imprimable
// (ASCII 0x20-0x7E) ; sinon la sortie est vide.
void copierImprimable(const uint8_t *src, size_t maxi, char *dst, size_t taille) {
  if (!dst || taille == 0) return;
  dst[0] = '\0';
  size_t n = 0;
  while (n < maxi && src[n]) {
    if (src[n] < 0x20 || src[n] > 0x7e) return;
    n++;
  }
  if (n >= taille) n = taille - 1;
  memcpy(dst, src, n);
  dst[n] = '\0';
}

// Copie du texte UTF-8 en le coupant sur une frontière de caractère ; les
// caractères de contrôle deviennent des espaces (une ligne de notification).
void copierTexte(const char *src, char *dst, size_t taille) {
  if (taille == 0) return;
  size_t n = 0;
  if (src) {
    while (n < taille - 1 && src[n]) n++;
    // Coupé au milieu d'un caractère multi-octet : on recule à son début.
    if (src[n] && n > 0) {
      size_t debut = n;
      while (debut > 0 && ((unsigned char)src[debut] & 0xC0) == 0x80) debut--;
      n = debut;
    }
    memcpy(dst, src, n);
  }
  dst[n] = '\0';
  for (size_t i = 0; i < n; i++)
    if ((unsigned char)dst[i] < 0x20 || dst[i] == 0x7f) dst[i] = ' ';
}

void ecrire(char *erreur, size_t taille, const char *texte) {
  if (erreur && taille) snprintf(erreur, taille, "%s", texte);
}

bool memeVersion(const char *a, const char *b) { return a[0] && strcmp(a, b) == 0; }

}  // namespace

// ------------------------------- versions ----------------------------------
bool versionValide(const char *v) {
  uint32_t n[3];
  return lireVersion(v, n);
}

int comparerVersions(const char *a, const char *b) {
  uint32_t x[3], y[3];
  const bool va = lireVersion(a, x), vb = lireVersion(b, y);
  if (!va || !vb) return (int)va - (int)vb;
  for (int i = 0; i < 3; i++)
    if (x[i] != y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

bool versionDepuisUrl(const char *url, char *version, size_t taille) {
  if (!version || taille == 0) return false;
  version[0] = '\0';
  if (!url) return false;
  const char *p = strstr(url, "/download/v");
  if (!p) return false;
  p += strlen("/download/v");
  const char *fin = strchr(p, '/');
  const size_t n = fin ? (size_t)(fin - p) : strlen(p);
  char v[16];
  if (n == 0 || n >= sizeof v) return false;
  memcpy(v, p, n);
  v[n] = '\0';
  if (!versionValide(v) || n >= taille) return false;
  memcpy(version, v, n + 1);
  return true;
}

bool cibleAcceptable(const char *url, const char *version, const char *courante, bool forcer, char *erreur,
                     size_t taille) {
  char v[16] = "";
  if (version && version[0]) {
    if (!versionValide(version)) {
      ecrire(erreur, taille, "version X.Y.Z attendue");
      return false;
    }
    snprintf(v, sizeof v, "%s", version);
  } else {
    versionDepuisUrl(url, v, sizeof v);
  }
  if (!v[0]) return true;
  const int c = comparerVersions(v, courante);
  if (c < 0) {
    if (erreur && taille) snprintf(erreur, taille, "%s plus ancienne que %s : retour refuse", v, courante);
    return false;
  }
  if (c == 0 && !forcer) {
    if (erreur && taille) snprintf(erreur, taille, "deja en %s", courante);
    return false;
  }
  return true;
}

// ---------------------------- en-tête d'image --------------------------------
bool lireEnteteImage(const uint8_t *b, size_t n, char *version, size_t tailleVersion, char *projet,
                     size_t tailleProjet) {
  if (version && tailleVersion) version[0] = '\0';
  if (projet && tailleProjet) projet[0] = '\0';
  if (!b || n < TAILLE_ENTETE_IMAGE || b[0] != 0xE9) return false;
  const uint32_t magie = (uint32_t)b[0x20] | ((uint32_t)b[0x21] << 8) | ((uint32_t)b[0x22] << 16) |
                         ((uint32_t)b[0x23] << 24);
  if (magie != 0xABCD5432UL) return false;
  copierImprimable(b + 0x30, 32, version, tailleVersion);
  copierImprimable(b + 0x50, 32, projet, tailleProjet);
  return true;
}

bool imageAcceptable(const char *version, const char *projet, const char *courante, bool memeAutorisee,
                     bool retourAutorise, char *erreur, size_t taille) {
  if (retourAutorise) return true;
  if (!projet || strcmp(projet, MAJAUTO_PROJET) != 0) {
    // Descripteur générique du cœur Arduino : une image d'avant version_image.cpp
    // (ou un autre croquis), sans version exploitable.
    const bool generique = !projet || !projet[0] || strcmp(projet, "arduino-lib-builder") == 0;
    if (erreur && taille)
      snprintf(erreur, taille, "%s : refusee (autoriser le retour pour l'installer)",
               generique ? "image sans version (avant 3.5.0 ?)" : "image d'un autre firmware");
    return false;
  }
  if (!versionValide(version)) {
    ecrire(erreur, taille, "version de l'image illisible : refusee");
    return false;
  }
  const int c = comparerVersions(version, courante);
  if (c < 0) {
    if (erreur && taille)
      snprintf(erreur, taille, "%s plus ancienne que %s : retour refuse", version, courante);
    return false;
  }
  if (c == 0 && !memeAutorisee) {
    if (erreur && taille) snprintf(erreur, taille, "deja en %s", courante);
    return false;
  }
  return true;
}

// -------------------------- remorque de signature ----------------------------
size_t lireRemorque(const uint8_t *fin, size_t n, const char **raison) {
  static const char *const nonSignee = "image non signee : refusee (cle publique compilee)";
  static const char *const malformee = "signature malformee";
  if (!fin || n < 10 || memcmp(fin + n - 8, "TERRASIG", 8) != 0) {
    if (raison) *raison = nonSignee;
    return 0;
  }
  const size_t t = (size_t)fin[n - 10] | ((size_t)fin[n - 9] << 8);
  if (t < 8 || t > 80 || t + 10 > n) {
    if (raison) *raison = malformee;
    return 0;
  }
  if (raison) *raison = nullptr;
  return t;
}

// -------------------------------- manifeste ----------------------------------
bool lireManifeste(const char *json, size_t taille, Manifeste &m, char *erreur, size_t tailleErreur) {
  memset(&m, 0, sizeof m);
  JsonDocument doc;
  const DeserializationError vide(DeserializationError::EmptyInput);
  // Même faux positif de l'analyseur de clang que dans protocole.cpp (placement
  // new de VariantData, ArduinoJson 7.4.2) : le document libère tout dans son
  // destructeur. Tout le chemin signalé tient sur la ligne suivante, qui le tait.
  // NOLINTNEXTLINE(clang-analyzer-cplusplus.NewDeleteLeaks)
  const DeserializationError e = json && taille ? deserializeJson(doc, json, taille) : vide;
  if (e || !doc.is<JsonObject>()) {
    if (erreur && tailleErreur) {
      if (e)
        snprintf(erreur, tailleErreur, "manifeste illisible : %s", e.c_str());
      else
        snprintf(erreur, tailleErreur, "manifeste : objet JSON attendu");
    }
    return false;
  }
  const char *v = doc["version"] | "";
  if (!versionValide(v)) {
    ecrire(erreur, tailleErreur, "manifeste : version absente ou invalide");
    return false;
  }
  snprintf(m.version, sizeof m.version, "%s", v);
  copierTexte(doc["notes"] | "", m.notes, sizeof m.notes);
  m.securite = doc["securite"].is<bool>() && doc["securite"].as<bool>();
  JsonVariantConst d = doc["deploiement"];
  if (d.is<JsonObjectConst>()) {
    if (d["debut"].is<uint32_t>()) m.debut = d["debut"].as<uint32_t>();
    if (d["jours"].is<long>()) {
      const long j = d["jours"].as<long>();
      m.jours = (uint8_t)(j < 0 ? 0 : (j > 60 ? 60 : j));
    }
    m.pause = d["pause"].is<bool>() && d["pause"].as<bool>();
  }
  return true;
}

// ------------------------- déploiement progressif ----------------------------
uint8_t rang(const char *id) {
  uint32_t h = 2166136261UL;
  for (const char *p = id ? id : ""; *p; p++) {
    h ^= (uint8_t)*p;
    h *= 16777619UL;
  }
  return (uint8_t)(h % 100);
}

uint8_t pourcentageOuvert(const Manifeste &m, uint32_t maintenant) {
  if (m.pause) return 0;
  if (m.debut == 0) return 100;
  if (maintenant < m.debut) return 0;
  if (m.jours == 0) return 100;
  const uint32_t jour = (maintenant - m.debut) / 86400UL;
  if (jour >= m.jours) return 100;
  return (uint8_t)((jour + 1) * 100 / ((uint32_t)m.jours + 1));
}

// ------------------------------ plage horaire --------------------------------
bool dansPlage(uint16_t minutes, uint16_t debut, uint16_t fin) {
  if (debut == fin) return false;
  if (debut < fin) return minutes >= debut && minutes < fin;
  return minutes >= debut || minutes < fin;
}

// -------------------------------- décision -----------------------------------
Attente decider(const Contexte &c, const Manifeste &m, const Etat &e) {
  if (!versionValide(m.version) || comparerVersions(m.version, c.courante) <= 0) return A_JOUR;
  if (memeVersion(e.versionRefusee, m.version)) return REFUSEE;
  if (!c.actif) return DESACTIVEE;
  if (!c.signee) return NON_SIGNEE;
  const bool memeEssai = memeVersion(e.versionEssayee, m.version);
  if (memeEssai && e.essais >= ESSAIS_MAX) return ECHECS;
  if (!c.heureFiable) return HEURE;
  if (e.reporteeJusqua > c.epoch) return REPORTEE;
  if (m.pause) return PAUSE;
  if (rang(c.id) >= pourcentageOuvert(m, c.epoch)) return DEPLOIEMENT;
  if (memeEssai && e.derniereTentative && c.epoch >= e.derniereTentative &&
      c.epoch - e.derniereTentative < ENTRE_TENTATIVES_S)
    return TENTEE;
  if (!dansPlage(c.minutesLocales, c.plageDebut, c.plageFin)) return PLAGE;
  if (!c.enLigne) return HORS_LIGNE;
  if (c.uptimeS < DEMARRAGE_MIN_S) return DEMARRAGE;
  if (c.validation) return VALIDATION;
  if (c.defaut) return DEFAUT;
  if (c.autotune) return AUTOTUNE;
  if (c.essai) return ESSAI;
  if (c.entretien) return ENTRETIEN;
  if (c.support) return SUPPORT;
  return PRETE;
}

const char *codeAttente(Attente a) {
  switch (a) {
    case PRETE: return "prete";
    case A_JOUR: return "a-jour";
    case REFUSEE: return "refusee";
    case DESACTIVEE: return "desactivee";
    case NON_SIGNEE: return "non-signee";
    case ECHECS: return "echecs";
    case HEURE: return "heure";
    case REPORTEE: return "reportee";
    case PAUSE: return "pause";
    case DEPLOIEMENT: return "deploiement";
    case TENTEE: return "tentee";
    case PLAGE: return "plage";
    case HORS_LIGNE: return "hors-ligne";
    case DEMARRAGE: return "demarrage";
    case VALIDATION: return "validation";
    case DEFAUT: return "defaut";
    case AUTOTUNE: return "autotune";
    case ESSAI: return "essai";
    case ENTRETIEN: return "entretien";
    case SUPPORT: return "support";
  }
  return "inconnue";
}

const char *texteAttente(Attente a) {
  switch (a) {
    case PRETE: return "installation maintenant";
    case A_JOUR: return "a jour";
    case REFUSEE: return "revenue en arriere sur ce socle : installation manuelle seulement";
    case DESACTIVEE: return "mises a jour automatiques desactivees";
    case NON_SIGNEE: return "images non signees (aucune cle compilee) : installation manuelle";
    case ECHECS: return "trois tentatives ratees : installation manuelle";
    case HEURE: return "heure inconnue";
    case REPORTEE: return "reportee par le proprietaire";
    case PAUSE: return "deploiement suspendu par le mainteneur";
    case DEPLOIEMENT: return "deploiement progressif : pas encore le tour de ce socle";
    case TENTEE: return "deja tentee cette nuit";
    case PLAGE: return "en attente de la plage horaire";
    case HORS_LIGNE: return "hors ligne";
    case DEMARRAGE: return "socle demarre depuis moins de 10 min";
    case VALIDATION: return "image courante pas encore validee";
    case DEFAUT: return "une zone est en defaut";
    case AUTOTUNE: return "autotune en cours";
    case ESSAI: return "essai ou identification en cours";
    case ENTRETIEN: return "entretien en cours";
    case SUPPORT: return "acces support ouvert";
  }
  return "?";
}

bool aAnnoncer(const Contexte &c, const Manifeste &m, const Etat &e) {
  if (!versionValide(m.version) || comparerVersions(m.version, c.courante) <= 0) return false;
  if (memeVersion(e.versionAnnoncee, m.version) || memeVersion(e.versionRefusee, m.version)) return false;
  // Annoncée quand c'est le tour de ce socle : une version suspendue ou pas
  // encore ouverte ici ne fait pas sonner le téléphone.
  return c.heureFiable && rang(c.id) < pourcentageOuvert(m, c.epoch);
}

void noterAnnonce(Etat &e, const Manifeste &m) {
  snprintf(e.versionAnnoncee, sizeof e.versionAnnoncee, "%s", m.version);
}

void noterTentative(Etat &e, const char *version, uint32_t maintenant) {
  if (!memeVersion(e.versionEssayee, version)) {
    snprintf(e.versionEssayee, sizeof e.versionEssayee, "%s", version);
    e.essais = 0;
  }
  if (e.essais < 255) e.essais++;
  e.derniereTentative = maintenant;
}

void noterRetourArriere(Etat &e, const char *version) {
  snprintf(e.versionRefusee, sizeof e.versionRefusee, "%s", version);
  if (memeVersion(e.versionEssayee, version)) {
    e.versionEssayee[0] = '\0';
    e.essais = 0;
    e.derniereTentative = 0;
  }
}

bool noterValidation(Etat &e, const char *courante) {
  // Installée à la main puis validée : elle n'est plus « refusée » ici.
  if (memeVersion(e.versionRefusee, courante)) e.versionRefusee[0] = '\0';
  if (!memeVersion(e.versionEssayee, courante)) return false;
  e.versionEssayee[0] = '\0';
  e.essais = 0;
  e.derniereTentative = 0;
  return true;
}

bool reporter(Etat &e, uint32_t maintenant, long jours) {
  if (jours == 0) {
    e.reporteeJusqua = 0;
    return true;
  }
  if (jours < 1 || jours > REPORT_MAX_J) return false;
  e.reporteeJusqua = maintenant + (uint32_t)jours * 86400UL;
  return true;
}

}  // namespace MajAuto
