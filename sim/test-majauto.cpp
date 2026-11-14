/* =============================================================================
   test-majauto.cpp — MISES À JOUR : VERSIONS, IMAGES, DÉPLOIEMENT, DÉCISION
   -----------------------------------------------------------------------------
   Le vrai code de ../majauto.cpp, sur PC : comparaison de versions et
   anti-retour (S4), en-tête d'une image ESP32 telle que le firmware l'écrit
   (version_image.cpp), remorque de signature (S5), manifeste et déploiement
   progressif (V9), et la décision d'installer seul la nuit (F15), condition
   par condition, puis sur trois nuits de suite.

       make majauto
   ============================================================================= */

#include "../majauto.h"
#include <stdio.h>
#include <string.h>

using namespace MajAuto;

static int echecs = 0;

static void verifier(const char *quoi, bool ok, const char *detail = "") {
  printf("   %s %-62s %s\n", ok ? "[ OK ]" : "[ECHEC]", quoi, detail);
  if (!ok) echecs++;
}

// En-tête d'image comme l'écrit esptool : magie E9, puis le descripteur
// d'application en 0x20 (magie, version en 0x30, projet en 0x50).
static void entete(uint8_t b[TAILLE_ENTETE_IMAGE], const char *version, const char *projet) {
  memset(b, 0, TAILLE_ENTETE_IMAGE);
  b[0] = 0xE9;
  b[1] = 6;
  b[0x20] = 0x32;
  b[0x21] = 0x54;
  b[0x22] = 0xCD;
  b[0x23] = 0xAB;
  memcpy(b + 0x30, version, strlen(version));
  memcpy(b + 0x50, projet, strlen(projet));
}

static const uint32_t T0 = 1763596800UL;  // 20/11/2025 00:00 UTC

static Contexte contexteBase() {
  Contexte c;
  memset(&c, 0, sizeof c);
  c.courante = "3.5.0";
  c.id = "terraA1B2C3";
  c.actif = true;
  c.signee = true;
  c.plageDebut = PLAGE_DEBUT_DEFAUT;
  c.plageFin = PLAGE_FIN_DEFAUT;
  c.heureFiable = true;
  c.epoch = T0 + 3 * 3600 + 20 * 60;
  c.minutesLocales = 3 * 60 + 20;
  c.enLigne = true;
  c.uptimeS = 3600;
  return c;
}

static Manifeste manifeste(const char *version) {
  Manifeste m;
  memset(&m, 0, sizeof m);
  snprintf(m.version, sizeof m.version, "%s", version);
  return m;
}

// Premier identifiant « terraNNNNNN » dont le rang est dans [mini, maxi].
static void idDeRang(uint8_t mini, uint8_t maxi, char *id, size_t taille) {
  for (unsigned i = 0; i < 1000000; i++) {
    snprintf(id, taille, "terra%06X", i);
    const uint8_t r = rang(id);
    if (r >= mini && r <= maxi) return;
  }
}

static void versions() {
  printf("\n--- Versions ---\n");
  verifier("3.5.0, 10.0.12 et 0.0.0 valides",
           versionValide("3.5.0") && versionValide("10.0.12") && versionValide("0.0.0"));
  const char *mauvaises[] = {
    "",          "3.5",  "3.5.0.1", "3.05.0",     "a.b.c",      "3.5.0 ", " 3.5.0",
    "65536.0.0", "3..0", "-1.0.0",  "1.2.3-beta", "123456.1.1", "1.2.3.", "v3.5.0"
  };
  bool aucune = true;
  for (const char *v : mauvaises)
    if (versionValide(v)) aucune = false;
  verifier("versions malformees refusees (zero de tete, suffixe, signe...)", aucune);
  verifier("nullptr refuse", !versionValide(nullptr));
  verifier("3.10.0 plus recente que 3.9.9 (nombres, pas texte)", comparerVersions("3.10.0", "3.9.9") > 0);
  verifier("4.0.0 > 3.99.99, 3.5.1 > 3.5.0",
           comparerVersions("4.0.0", "3.99.99") > 0 && comparerVersions("3.5.1", "3.5.0") > 0);
  verifier("egalite", comparerVersions("3.5.0", "3.5.0") == 0);
  verifier("invalide < valide, deux invalides egales", comparerVersions("abc", "0.0.0") < 0 &&
                                                           comparerVersions("0.0.0", "abc") > 0 &&
                                                           comparerVersions("x", "y") == 0);

  char v[16];
  verifier("version tiree de l'URL de release",
           versionDepuisUrl("https://github.com/NoeMrct/terrarium_thermostat/releases/download/v3.6.0/"
                            "terrarium-3.6.0-firmware.bin",
                            v, sizeof v) &&
               strcmp(v, "3.6.0") == 0);
  verifier("URL sans etiquette de version : rien",
           !versionDepuisUrl("https://github.com/NoeMrct/terrarium_thermostat/releases/latest/download/x.bin",
                             v, sizeof v) &&
               v[0] == '\0');
  verifier("etiquette non X.Y.Z : rien",
           !versionDepuisUrl("https://x/releases/download/v3.6/a.bin", v, sizeof v) &&
               !versionDepuisUrl("https://x/releases/download/vnightly/a.bin", v, sizeof v));
  char err[96];
  const char *url =
      "https://github.com/NoeMrct/terrarium_thermostat/releases/download/v3.4.0/terrarium-3.4.0-firmware.bin";
  verifier("cible : version plus recente acceptee",
           cibleAcceptable("", "3.6.0", "3.5.0", false, err, sizeof err));
  verifier("cible : plus ancienne refusee, meme avec forcer",
           !cibleAcceptable("", "3.4.0", "3.5.0", true, err, sizeof err) && strstr(err, "retour refuse"),
           err);
  verifier("cible : meme version seulement avec forcer",
           !cibleAcceptable("", "3.5.0", "3.5.0", false, err, sizeof err) &&
               cibleAcceptable("", "3.5.0", "3.5.0", true, err, sizeof err));
  verifier("cible : version malformee refusee", !cibleAcceptable("", "3.5", "3.5.0", true, err, sizeof err),
           err);
  verifier("cible : URL d'une release plus ancienne refusee",
           !cibleAcceptable(url, "", "3.5.0", true, err, sizeof err), err);
  verifier("cible : URL sans etiquette lisible : l'en-tete tranchera",
           cibleAcceptable("https://github.com/NoeMrct/x/releases/download/nightly/a.bin", "", "3.5.0", false,
                           err, sizeof err));
  char petit[4];
  verifier("tampon trop petit : rien, sans debordement",
           !versionDepuisUrl("https://x/releases/download/v3.6.0/a.bin", petit, sizeof petit));
}

static void images() {
  printf("\n--- En-tete d'image et anti-retour (S4) ---\n");
  uint8_t b[TAILLE_ENTETE_IMAGE];
  char version[16], projet[33];
  entete(b, "3.6.0", MAJAUTO_PROJET);
  verifier("image de ce firmware : version et projet lus",
           lireEnteteImage(b, sizeof b, version, sizeof version, projet, sizeof projet) &&
               strcmp(version, "3.6.0") == 0 && strcmp(projet, MAJAUTO_PROJET) == 0);
  verifier("trop court : pas encore lisible",
           !lireEnteteImage(b, sizeof b - 1, version, sizeof version, projet, sizeof projet));
  b[0] = 0x7F;
  verifier("pas une image ESP32 (magie E9)",
           !lireEnteteImage(b, sizeof b, version, sizeof version, projet, sizeof projet));
  entete(b, "3.6.0", MAJAUTO_PROJET);
  b[0x23] = 0;
  verifier("sans descripteur d'application (magie ABCD5432)",
           !lireEnteteImage(b, sizeof b, version, sizeof version, projet, sizeof projet));
  entete(b, "3.6.0", MAJAUTO_PROJET);
  b[0x31] = 0x07;
  verifier(
      "version non imprimable : lue vide",
      lireEnteteImage(b, sizeof b, version, sizeof version, projet, sizeof projet) && version[0] == '\0');
  // Le descripteur par défaut du cœur Arduino (image d'avant version_image.cpp).
  entete(b, "ee57070", "arduino-lib-builder");
  lireEnteteImage(b, sizeof b, version, sizeof version, projet, sizeof projet);
  char err[96] = "";
  verifier("descripteur generique du coeur : refuse, sans version",
           !imageAcceptable(version, projet, "3.5.0", false, false, err, sizeof err) &&
               strstr(err, "sans version") != nullptr,
           err);
  verifier("image d'un autre projet : refusee",
           !imageAcceptable("1.0.0", "esphome", "3.5.0", false, false, err, sizeof err) &&
               strstr(err, "autre firmware") != nullptr,
           err);
  verifier("... sauf retour autorise (page locale, case cochee)",
           imageAcceptable(version, projet, "3.5.0", false, true, err, sizeof err));
  verifier("plus recente : acceptee",
           imageAcceptable("3.6.0", MAJAUTO_PROJET, "3.5.0", false, false, err, sizeof err));
  verifier("meme version refusee sans forcer",
           !imageAcceptable("3.5.0", MAJAUTO_PROJET, "3.5.0", false, false, err, sizeof err) &&
               strstr(err, "deja en") != nullptr,
           err);
  verifier("meme version acceptee avec forcer",
           imageAcceptable("3.5.0", MAJAUTO_PROJET, "3.5.0", true, false, err, sizeof err));
  verifier("plus ancienne refusee, meme avec forcer",
           !imageAcceptable("3.4.9", MAJAUTO_PROJET, "3.5.0", true, false, err, sizeof err) &&
               strstr(err, "retour refuse") != nullptr,
           err);
  verifier("plus ancienne acceptee si le retour est autorise",
           imageAcceptable("3.4.9", MAJAUTO_PROJET, "3.5.0", false, true, err, sizeof err));
  verifier("image sans version ni projet : refusee",
           !imageAcceptable("", "", "3.5.0", true, false, err, sizeof err) &&
               strstr(err, "sans version") != nullptr,
           err);
  verifier("version illisible de ce projet : refusee",
           !imageAcceptable("3.6", MAJAUTO_PROJET, "3.5.0", true, false, err, sizeof err));
}

static void remorques() {
  printf("\n--- Remorque de signature (S5) ---\n");
  uint8_t r[96];
  memset(r, 0xAA, sizeof r);
  const size_t n = 71 + 10;
  r[n - 10] = 71;
  r[n - 9] = 0;
  memcpy(r + n - 8, "TERRASIG", 8);
  const char *raison = "x";
  verifier("remorque valide : longueur de signature", lireRemorque(r, n, &raison) == 71 && raison == nullptr);
  verifier("sans la magie : image non signee",
           lireRemorque(r, n - 1, &raison) == 0 && raison && strstr(raison, "non signee") != nullptr);
  r[n - 10] = 7;
  verifier("signature trop courte : malformee",
           lireRemorque(r, n, &raison) == 0 && raison && strstr(raison, "malformee") != nullptr);
  r[n - 10] = 81;
  verifier("signature trop longue : malformee", lireRemorque(r, n, &raison) == 0);
  r[n - 10] = 72;
  verifier("plus longue que ce qui est arrive : malformee", lireRemorque(r, n, &raison) == 0);
  verifier("moins de 10 octets : non signee", lireRemorque(r, 9, &raison) == 0);
  verifier("la reserve du flux (96 octets) couvre la plus longue remorque", REMORQUE_MAX <= 96);
}

static void manifestes() {
  printf("\n--- Manifeste terrarium-version.json ---\n");
  const char *json =
      "{\"version\":\"3.6.0\",\"date\":\"2025-11-20\",\"notes\":\"Mises a jour automatiques la nuit.\","
      "\"securite\":true,\"image\":{\"taille\":1539343},"
      "\"deploiement\":{\"debut\":1763596800,\"jours\":7,\"pause\":false},\"inconnu\":[1,2]}";
  Manifeste m;
  char err[96] = "";
  verifier("manifeste complet lu", lireManifeste(json, strlen(json), m, err, sizeof err), err);
  verifier("champs : version, notes, securite, debut, jours",
           strcmp(m.version, "3.6.0") == 0 && strcmp(m.notes, "Mises a jour automatiques la nuit.") == 0 &&
               m.securite && m.debut == 1763596800UL && m.jours == 7 && !m.pause);
  const char *minimal = "{\"version\":\"3.6.1\"}";
  verifier("manifeste minimal : ouvert a tous, pas de securite",
           lireManifeste(minimal, strlen(minimal), m, err, sizeof err) && m.debut == 0 && m.jours == 0 &&
               !m.securite && m.notes[0] == '\0' && pourcentageOuvert(m, T0) == 100);
  const char *sansVersion = "{\"notes\":\"x\"}";
  verifier("sans version : refuse", !lireManifeste(sansVersion, strlen(sansVersion), m, err, sizeof err),
           err);
  const char *mauvaiseVersion = "{\"version\":\"3.6\"}";
  verifier("version invalide : refuse",
           !lireManifeste(mauvaiseVersion, strlen(mauvaiseVersion), m, err, sizeof err));
  verifier("JSON casse : refuse", !lireManifeste("{\"version\":", 11, m, err, sizeof err), err);
  verifier("tableau : refuse", !lireManifeste("[1]", 3, m, err, sizeof err), err);
  verifier("vide : refuse", !lireManifeste("", 0, m, err, sizeof err));
  const char *bornes =
      "{\"version\":\"3.6.0\",\"notes\":\"ligne 1\\nligne 2\\t!\",\"securite\":\"oui\","
      "\"deploiement\":{\"debut\":-5,\"jours\":1000,\"pause\":1}}";
  verifier("bornes : jours plafonne a 60, debut negatif ignore, types stricts",
           lireManifeste(bornes, strlen(bornes), m, err, sizeof err) && m.jours == 60 && m.debut == 0 &&
               !m.securite && !m.pause);
  verifier("caracteres de controle des notes remplaces par des espaces",
           strcmp(m.notes, "ligne 1 ligne 2 !") == 0, m.notes);
  // Notes trop longues, en caractères de deux octets : coupées sur un caractère entier.
  char longues[800] = "{\"version\":\"3.6.0\",\"notes\":\"";
  for (int i = 0; i < 300; i++) strcat(longues, "\xC3\xA9");  // é
  strcat(longues, "\"}");
  const bool lu = lireManifeste(longues, strlen(longues), m, err, sizeof err);
  const size_t l = strlen(m.notes);
  verifier("notes longues coupees sur une frontiere UTF-8",
           lu && l > 0 && l < sizeof m.notes && l % 2 == 0 && (unsigned char)m.notes[l - 1] == 0xA9);
}

static void deploiement() {
  printf("\n--- Deploiement progressif (V9) ---\n");
  verifier("rang stable pour un identifiant",
           rang("terraA1B2C3") == rang("terraA1B2C3") && rang("terraA1B2C3") < 100);
  unsigned seaux[100] = { 0 };
  char id[16];
  for (unsigned i = 0; i < 10000; i++) {
    snprintf(id, sizeof id, "terra%06X", i * 2654435761U & 0xFFFFFF);
    seaux[rang(id)]++;
  }
  unsigned mini = 10000, maxi = 0;
  for (unsigned s : seaux) {
    if (s < mini) mini = s;
    if (s > maxi) maxi = s;
  }
  char d[64];
  snprintf(d, sizeof d, "min %u, max %u sur 10 000 socles", mini, maxi);
  verifier("rangs repartis (100 par rang en moyenne)", mini > 50 && maxi < 160, d);

  Manifeste m = manifeste("3.6.0");
  m.debut = T0;
  m.jours = 7;
  verifier("avant l'ouverture : 0 %", pourcentageOuvert(m, T0 - 1) == 0);
  verifier("jour 0 : 12 %, jour 3 : 50 %, jour 6 : 87 %",
           pourcentageOuvert(m, T0) == 12 && pourcentageOuvert(m, T0 + 3 * 86400 + 10) == 50 &&
               pourcentageOuvert(m, T0 + 6 * 86400) == 87);
  verifier("jour 7 et apres : 100 %",
           pourcentageOuvert(m, T0 + 7 * 86400) == 100 && pourcentageOuvert(m, T0 + 400 * 86400) == 100);
  unsigned servis = 0;
  for (unsigned i = 0; i < 10000; i++) {
    snprintf(id, sizeof id, "terra%06X", i * 2654435761U & 0xFFFFFF);
    if (rang(id) < pourcentageOuvert(m, T0)) servis++;
  }
  snprintf(d, sizeof d, "%u socles sur 10 000", servis);
  verifier("le premier jour, environ 12 % de la flotte", servis > 900 && servis < 1500, d);
  m.pause = true;
  verifier("en pause : 0 %", pourcentageOuvert(m, T0 + 400 * 86400) == 0);
  m.pause = false;
  m.jours = 0;
  verifier("sans montee en charge : 100 % des l'ouverture",
           pourcentageOuvert(m, T0) == 100 && pourcentageOuvert(m, T0 - 1) == 0);
  m.debut = 0;
  verifier("sans date d'ouverture : 100 %", pourcentageOuvert(m, 0) == 100);
  m.debut = T0;
  m.jours = 2;
  verifier("correctif de securite sur 2 jours : 33 %, 66 %, 100 %",
           pourcentageOuvert(m, T0) == 33 && pourcentageOuvert(m, T0 + 86400) == 66 &&
               pourcentageOuvert(m, T0 + 2 * 86400) == 100);
}

static void plages() {
  printf("\n--- Plage horaire ---\n");
  verifier("03:00-05:00 : 03:20 dedans, 05:00 et 02:59 dehors",
           dansPlage(200, 180, 300) && !dansPlage(300, 180, 300) && !dansPlage(179, 180, 300) &&
               dansPlage(180, 180, 300));
  verifier("22:00-02:00 passe minuit", dansPlage(23 * 60 + 30, 1320, 120) && dansPlage(60, 1320, 120) &&
                                           !dansPlage(600, 1320, 120) && !dansPlage(120, 1320, 120));
  verifier("plage vide : jamais", !dansPlage(100, 100, 100) && !dansPlage(0, 0, 0));
}

static void decisions() {
  printf("\n--- Decision d'installer (F15) ---\n");
  const Contexte base = contexteBase();
  const Manifeste m = manifeste("3.6.0");
  Etat e;
  memset(&e, 0, sizeof e);
  verifier("tout est reuni : installation", decider(base, m, e) == PRETE);
  verifier("meme version ou plus ancienne : a jour", decider(base, manifeste("3.5.0"), e) == A_JOUR &&
                                                         decider(base, manifeste("3.4.9"), e) == A_JOUR &&
                                                         decider(base, manifeste("x"), e) == A_JOUR);

  Contexte c;
  Etat f;
#define CAS(quoi, modif_c, modif_e, attendue)      \
  do {                                             \
    c = base;                                      \
    f = e;                                         \
    modif_c;                                       \
    modif_e;                                       \
    const Attente a = decider(c, m, f);            \
    verifier(quoi, a == attendue, codeAttente(a)); \
  } while (0)
  CAS("version revenue en arriere ici : jamais seule", (void)0, strcpy(f.versionRefusee, "3.6.0"), REFUSEE);
  CAS("desactivees par le proprietaire", c.actif = false, (void)0, DESACTIVEE);
  CAS("aucune cle compilee : installation manuelle", c.signee = false, (void)0, NON_SIGNEE);
  CAS("trois echecs pour cette version", (void)0, (strcpy(f.versionEssayee, "3.6.0"), f.essais = 3), ECHECS);
  CAS("trois echecs pour une autre version : sans effet", (void)0,
      (strcpy(f.versionEssayee, "3.5.9"), f.essais = 3), PRETE);
  CAS("heure inconnue", c.heureFiable = false, (void)0, HEURE);
  CAS("reportee", (void)0, f.reporteeJusqua = base.epoch + 10, REPORTEE);
  CAS("report echu", (void)0, f.reporteeJusqua = base.epoch - 1, PRETE);
  CAS("deja tentee cette nuit", (void)0,
      (strcpy(f.versionEssayee, "3.6.0"), f.essais = 1, f.derniereTentative = base.epoch - 3600), TENTEE);
  CAS("tentee la nuit precedente : on reessaie", (void)0,
      (strcpy(f.versionEssayee, "3.6.0"), f.essais = 1, f.derniereTentative = base.epoch - 21 * 3600), PRETE);
  CAS("horloge revenue en arriere : pas de blocage", (void)0,
      (strcpy(f.versionEssayee, "3.6.0"), f.essais = 1, f.derniereTentative = base.epoch + 3600), PRETE);
  CAS("hors de la plage horaire", c.minutesLocales = 600, (void)0, PLAGE);
  CAS("plage reglee 22:00-02:00, il est 23:30",
      (c.plageDebut = 1320, c.plageFin = 120, c.minutesLocales = 1410), (void)0, PRETE);
  CAS("hors ligne", c.enLigne = false, (void)0, HORS_LIGNE);
  CAS("demarre depuis 5 min", c.uptimeS = 300, (void)0, DEMARRAGE);
  CAS("image courante pas encore validee", c.validation = true, (void)0, VALIDATION);
  CAS("zone en defaut", c.defaut = true, (void)0, DEFAUT);
  CAS("autotune en cours", c.autotune = true, (void)0, AUTOTUNE);
  CAS("essai en cours", c.essai = true, (void)0, ESSAI);
  CAS("entretien en cours", c.entretien = true, (void)0, ENTRETIEN);
  CAS("acces support ouvert", c.support = true, (void)0, SUPPORT);
  CAS("desactivees l'emporte sur la plage", (c.actif = false, c.minutesLocales = 600), (void)0, DESACTIVEE);
#undef CAS

  Manifeste p = m;
  p.pause = true;
  verifier("deploiement suspendu", decider(base, p, e) == PAUSE);
  p.pause = false;
  p.debut = base.epoch;
  p.jours = 7;
  char id[16];
  c = base;
  idDeRang(12, 99, id, sizeof id);
  c.id = id;
  verifier("jour 0 : un socle de rang >= 12 attend son tour", decider(c, p, e) == DEPLOIEMENT, id);
  idDeRang(0, 11, id, sizeof id);
  c.id = id;
  verifier("jour 0 : un socle de rang < 12 est servi", decider(c, p, e) == PRETE, id);

  bool distincts = true;
  for (int a = PRETE; a <= SUPPORT; a++) {
    if (!texteAttente((Attente)a)[0] || strcmp(codeAttente((Attente)a), "inconnue") == 0) distincts = false;
    for (int b = a + 1; b <= SUPPORT; b++)
      if (strcmp(codeAttente((Attente)a), codeAttente((Attente)b)) == 0) distincts = false;
  }
  verifier("chaque attente a un code distinct et un texte", distincts);
}

static void suivi() {
  printf("\n--- Annonce, tentatives, retour arriere, report ---\n");
  const Contexte base = contexteBase();
  const Manifeste m = manifeste("3.6.0");
  Etat e;
  memset(&e, 0, sizeof e);
  verifier("nouvelle version : a annoncer", aAnnoncer(base, m, e));
  noterAnnonce(e, m);
  verifier("annoncee une seule fois", !aAnnoncer(base, m, e));
  verifier("la suivante s'annonce a son tour", aAnnoncer(base, manifeste("3.7.0"), e));
  Contexte c = base;
  c.heureFiable = false;
  verifier("pas d'annonce sans heure (deploiement indatable)", !aAnnoncer(c, manifeste("3.7.0"), e));
  Manifeste p = manifeste("3.7.0");
  p.pause = true;
  verifier("pas d'annonce d'une version suspendue", !aAnnoncer(base, p, e));
  verifier("pas d'annonce d'une version deja installee", !aAnnoncer(base, manifeste("3.5.0"), e));

  noterTentative(e, "3.6.0", 1000);
  noterTentative(e, "3.6.0", 2000);
  verifier("deux tentatives comptees",
           e.essais == 2 && e.derniereTentative == 2000 && strcmp(e.versionEssayee, "3.6.0") == 0);
  noterTentative(e, "3.6.1", 3000);
  verifier("autre version : le compte repart", e.essais == 1 && strcmp(e.versionEssayee, "3.6.1") == 0);
  noterRetourArriere(e, "3.6.1");
  verifier("retour arriere : version refusee, compteurs remis",
           strcmp(e.versionRefusee, "3.6.1") == 0 && e.essais == 0 && e.versionEssayee[0] == '\0');
  verifier("une version refusee ne s'annonce plus", !aAnnoncer(base, manifeste("3.6.1"), e));

  memset(&e, 0, sizeof e);
  noterTentative(e, "3.6.0", 1000);
  verifier("validation de l'image installee seule : a annoncer, compteurs remis",
           noterValidation(e, "3.6.0") && e.essais == 0 && e.versionEssayee[0] == '\0');
  verifier("validation d'une image installee a la main : rien a annoncer", !noterValidation(e, "3.6.0"));
  strcpy(e.versionRefusee, "3.6.0");
  noterValidation(e, "3.6.0");
  verifier("refusee puis installee a la main et validee : plus refusee", e.versionRefusee[0] == '\0');

  verifier("report de 7 jours", reporter(e, T0, 7) && e.reporteeJusqua == T0 + 7 * 86400UL);
  verifier("0 annule le report", reporter(e, T0, 0) && e.reporteeJusqua == 0);
  verifier("31 jours ou negatif : refuse",
           !reporter(e, T0, 31) && !reporter(e, T0, -1) && e.reporteeJusqua == 0);
}

// Trois nuits de suite, minute par minute : une tentative par nuit dans la
// plage, jamais en dehors, et plus rien après le troisième échec.
static void troisNuits() {
  printf("\n--- Trois nuits, minute par minute ---\n");
  Contexte c = contexteBase();
  const Manifeste m = manifeste("3.6.0");
  Etat e;
  memset(&e, 0, sizeof e);
  unsigned tentatives = 0, horsPlage = 0, parNuit[5] = { 0 };
  for (uint32_t minute = 0; minute < 5 * 1440; minute++) {
    c.epoch = T0 + minute * 60;
    c.minutesLocales = (uint16_t)(minute % 1440);
    c.uptimeS = 3600 + minute * 60;
    if (decider(c, m, e) == PRETE) {
      tentatives++;
      parNuit[minute / 1440]++;
      if (!dansPlage(c.minutesLocales, c.plageDebut, c.plageFin)) horsPlage++;
      noterTentative(e, m.version, c.epoch);  // et l'installation échoue
    }
  }
  char d[64];
  snprintf(d, sizeof d, "%u tentatives : %u/%u/%u/%u/%u", tentatives, parNuit[0], parNuit[1], parNuit[2],
           parNuit[3], parNuit[4]);
  verifier("une tentative par nuit, trois au plus",
           tentatives == 3 && parNuit[0] == 1 && parNuit[1] == 1 && parNuit[2] == 1 && parNuit[3] == 0, d);
  verifier("jamais hors de la plage", horsPlage == 0);
  verifier("ensuite : trois echecs, installation manuelle", decider(c, m, e) == ECHECS);
}

int main() {
  printf("=== Mises a jour : versions, images, deploiement, decision ===\n");
  versions();
  images();
  remorques();
  manifestes();
  deploiement();
  plages();
  decisions();
  suivi();
  troisNuits();
  printf("\n=== %s (%d echec%s) ===\n", echecs ? "DES TESTS ONT ECHOUE" : "TOUS LES TESTS PASSENT", echecs,
         echecs > 1 ? "s" : "");
  return echecs ? 1 : 0;
}
