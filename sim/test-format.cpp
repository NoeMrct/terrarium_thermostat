/* =============================================================================
   test-format.cpp — ÉCHAPPEMENT JSON ET HORAIRES
   -----------------------------------------------------------------------------
   Un nom de zone contenant un guillemet suffit à produire un JSON invalide, et
   l'interface web se retrouve muette sans le moindre message d'erreur. Ces
   fonctions sont partagées par l'interface web, la console et le canal MQTT :
   elles méritent d'être exercées, y compris sur les tampons trop courts.

       make test-format
   ============================================================================= */

#include "../format.h"
#include <stdio.h>
#include <string.h>
#include <initializer_list>

static int echecs = 0, verifs = 0;
static void verifier(const char *quoi, bool ok, const char *detail = "") {
  verifs++;
  printf("   %s %-56s %s\n", ok ? "[ OK ]" : "[ECHEC]", quoi, detail);
  if (!ok) echecs++;
}
static void titre(const char *t) { printf("\n== %s\n", t); }

// Analyseur JSON minimal, juste ce qu'il faut pour dire si une chaîne échappée
// se relit correctement : lit "…" et rend le contenu décodé.
static bool relireChaineJson(const char *json, char *sortie, size_t taille) {
  if (*json != '"') return false;
  const char *p = json + 1;
  size_t n = 0;
  while (*p && *p != '"') {
    if (*p == '\\') {
      p++;
      if (*p != '"' && *p != '\\') return false;    // aucune autre sequence attendue
    }
    if (n + 1 >= taille) return false;
    sortie[n++] = *p++;
  }
  if (*p != '"') return false;                       // chaine non terminee
  sortie[n] = '\0';
  return *(p + 1) == '\0';
}

static void scenarioEchappement() {
  titre("1. Echappement JSON");
  char b[128], relu[128], doc[160];

  struct { const char *entree; const char *attendu; const char *quoi; } cas[] = {
    { "Zone 1",              "Zone 1",                 "texte ordinaire inchange" },
    { "Point \"chaud\"",     "Point \\\"chaud\\\"",    "guillemets echappes" },
    { "C:\\terra",           "C:\\\\terra",            "antislash echappe" },
    { "\"\\\"\\",            "\\\"\\\\\\\"\\\\",       "guillemets et antislashs melanges" },
    { "avant\tapres",        "avant apres",            "tabulation remplacee par une espace" },
    { "ligne1\nligne2",      "ligne1 ligne2",          "retour a la ligne neutralise" },
    { "",                    "",                       "chaine vide" },
    { "accentue : eeaa",     "accentue : eeaa",        "texte courant" },
  };
  for (size_t i = 0; i < sizeof cas / sizeof cas[0]; i++) {
    formatEchapperJson(cas[i].entree, b, sizeof b);
    char d[264]; snprintf(d, sizeof d, "\"%s\"", b);
    verifier(cas[i].quoi, strcmp(b, cas[i].attendu) == 0, d);
  }

  // Le vrai critere : ce qui sort doit se relire comme la valeur d'origine.
  const char *pieges[] = { "Pogona \"Bob\"", "a\\b\"c", "\\\\\\", "\x01\x02 fin", "\"" };
  bool tout = true;
  for (size_t i = 0; i < sizeof pieges / sizeof pieges[0]; i++) {
    formatEchapperJson(pieges[i], b, sizeof b);
    snprintf(doc, sizeof doc, "\"%s\"", b);
    if (!relireChaineJson(doc, relu, sizeof relu)) { tout = false; break; }
  }
  verifier("le JSON produit se relit dans tous les cas pieges", tout);

  // Un nom de zone fait 17 caracteres utiles : la troncature ne doit jamais
  // laisser un antislash orphelin, qui ferait fuir la chaine sur tout le reste
  // du document.
  bool troncatureSaine = true;
  char courte[8];
  for (size_t t = 2; t <= sizeof courte; t++) {
    for (const char *src : { "\\\\\\\\\\\\\\\\", "\"\"\"\"\"\"\"\"", "ab\\cd\"ef", "aaaaaaaa" }) {
      char petit[16];
      memset(petit, '#', sizeof petit);
      formatEchapperJson(src, petit, t);
      const size_t n = strlen(petit);
      if (n >= t) { troncatureSaine = false; break; }
      // nombre d'antislashs consecutifs en fin : doit etre pair
      size_t k = 0;
      while (k < n && petit[n - 1 - k] == '\\') k++;
      if (k % 2) { troncatureSaine = false; break; }
      snprintf(doc, sizeof doc, "\"%s\"", petit);
      if (!relireChaineJson(doc, relu, sizeof relu)) { troncatureSaine = false; break; }
    }
    if (!troncatureSaine) break;
  }
  verifier("tampon trop court : troncature propre, jamais d'antislash orphelin", troncatureSaine);

  formatEchapperJson("Zone", b, 1);
  verifier("tampon d'un octet : chaine vide, pas de debordement", b[0] == '\0');
  verifier("source nulle toleree", formatEchapperJson(nullptr, b, sizeof b) == 0 && b[0] == '\0');
}

static void scenarioHoraires() {
  titre("2. Horaires HH:MM");
  char b[8];
  formatHHMM(0, b, sizeof b);     verifier("minuit s'ecrit 00:00", strcmp(b, "00:00") == 0, b);
  formatHHMM(485, b, sizeof b);   verifier("485 minutes = 08:05", strcmp(b, "08:05") == 0, b);
  formatHHMM(1439, b, sizeof b);  verifier("1439 = 23:59", strcmp(b, "23:59") == 0, b);
  formatHHMM(1440, b, sizeof b);  verifier("1440 repasse a 00:00", strcmp(b, "00:00") == 0, b);
  verifier("tampon trop court refuse", !formatHHMM(600, b, 4));

  uint16_t m = 0xFFFF;
  verifier("« 08:00 » se relit",          formatParseHHMM("08:00", m) && m == 480);
  verifier("« 8:5 » tolere",              formatParseHHMM("8:5", m) && m == 485);
  verifier("« 23:59 » se relit",          formatParseHHMM("23:59", m) && m == 1439);
  verifier("« 00:00 » se relit",          formatParseHHMM("00:00", m) && m == 0);
  verifier("espaces autour toleres",      formatParseHHMM("  7:30 ", m) && m == 450);

  const char *invalides[] = { "24:00", "12:60", "abc", "", ":", "12", "12:", ":30",
                              "08:00abc", "1:2:3", "999:00", "-1:00" };
  bool tousRefuses = true;
  const char *passe = "";
  for (size_t i = 0; i < sizeof invalides / sizeof invalides[0]; i++)
    if (formatParseHHMM(invalides[i], m)) { tousRefuses = false; passe = invalides[i]; break; }
  verifier("toutes les saisies invalides sont refusees", tousRefuses, passe);

  verifier("texte nul tolere", !formatParseHHMM(nullptr, m));

  // Aller-retour complet : tout ce qui s'affiche doit se relire a l'identique.
  bool allerRetour = true;
  for (uint16_t v = 0; v < 1440; v++) {
    char t[8]; uint16_t r = 0;
    formatHHMM(v, t, sizeof t);
    if (!formatParseHHMM(t, r) || r != v) { allerRetour = false; break; }
  }
  verifier("aller-retour exact sur les 1440 minutes du jour", allerRetour);
}

int main() {
  printf("=== Formatage partage (JSON, horaires) ===\n");
  scenarioEchappement();
  scenarioHoraires();
  printf("\n=== %s (%d verification(s), %d echec(s)) ===\n",
         echecs ? "DES TESTS ONT ECHOUE" : "TOUS LES TESTS PASSENT", verifs, echecs);
  return echecs ? 1 : 0;
}
