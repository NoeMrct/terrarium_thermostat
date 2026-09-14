/* =============================================================================
   test-anneau.cpp — L'ANNEAU D'HISTORIQUE, VÉRIFIÉ EXHAUSTIVEMENT SUR PC
   -----------------------------------------------------------------------------
   Le firmware ne réécrit pas d'entête à chaque échantillon : il retrouve la tête
   de l'anneau au démarrage par recherche dichotomique sur les numéros de
   séquence. C'est la partie la plus délicate de stockage.cpp, et celle dont une
   erreur coûte le plus cher — un historique lu à l'envers, ou perdu.

   Ce test rejoue TOUTES les combinaisons capacité × remplissage sur un tableau
   en mémoire, et compare à la vérité connue.

       make test-anneau
   ============================================================================= */

#include "../anneau.h"
#include <stdio.h>
#include <string.h>
#include <vector>

static int echecs = 0, verifs = 0;
static void verifier(const char *quoi, bool ok, const char *detail = "") {
  verifs++;
  printf("   %s %-56s %s\n", ok ? "[ OK ]" : "[ECHEC]", quoi, detail);
  if (!ok) echecs++;
}
static void titre(const char *t) { printf("\n== %s\n", t); }

// ---------------------------------------------------------------------------
// Support de test : un tableau d'emplacements, exactement ce que le fichier
// contiendrait. `lu` compte les lectures pour vérifier que la recherche reste
// bien dichotomique.
struct Support {
  std::vector<uint32_t> seq;
  std::vector<bool>     ecrit;
  mutable int           lu = 0;
  bool                  panne = false;   // simule un fichier illisible
};

static bool lireSupport(uint32_t emplacement, uint32_t &seq, void *ctx) {
  Support *s = (Support *)ctx;
  s->lu++;
  if (s->panne) return false;
  if (emplacement >= s->seq.size()) return false;
  seq = s->seq[emplacement];
  return true;
}

// Remplit le support comme le ferait le firmware : `ecrits` échantillons
// consécutifs, numérotés à partir de 1.
static void remplir(Support &s, uint32_t capacite, uint32_t ecrits) {
  s.seq.assign(capacite, 0);
  s.ecrit.assign(capacite, false);
  for (uint32_t i = 0; i < ecrits; i++) {
    s.seq[i % capacite] = i + 1;
    s.ecrit[i % capacite] = true;
  }
}

// ---------------------------------------------------------------------------
static void scenarioExhaustif() {
  titre("1. Toutes les combinaisons capacite x remplissage");
  bool toutBon = true;
  char premierEcart[160] = "";

  for (uint32_t cap = 1; cap <= 64 && toutBon; cap++) {
    // De l'anneau vide a deux tours complets et demi.
    for (uint32_t ecrits = 0; ecrits <= cap * 2 + cap / 2 + 3; ecrits++) {
      Support s;
      remplir(s, cap, ecrits);
      const uint32_t presents = (ecrits < cap) ? ecrits : cap;

      Anneau a;
      anneauReconstruire(a, cap, presents, lireSupport, &s);

      const uint32_t attenduRemplis = presents;
      const uint32_t attenduIndex   = ecrits % cap;
      const uint32_t attenduSeq     = ecrits + 1;

      if (a.remplis != attenduRemplis || a.index != attenduIndex || a.seq != attenduSeq) {
        snprintf(premierEcart, sizeof premierEcart,
                 "cap=%u ecrits=%u -> index %u (attendu %u), remplis %u (attendu %u), seq %u (attendu %u)",
                 cap, ecrits, a.index, attenduIndex, a.remplis, attenduRemplis, a.seq, attenduSeq);
        toutBon = false;
        break;
      }

      // Les rangs doivent ressortir du plus ancien au plus recent, sans trou.
      uint32_t precedente = 0;
      for (uint32_t rang = 0; rang < a.remplis; rang++) {
        uint32_t emplacement = 0;
        if (!anneauEmplacementDuRang(a, rang, emplacement)) { toutBon = false; break; }
        const uint32_t seq = s.seq[emplacement];
        if (rang > 0 && seq != precedente + 1) {
          snprintf(premierEcart, sizeof premierEcart,
                   "cap=%u ecrits=%u : rang %u donne la seq %u apres %u",
                   cap, ecrits, rang, seq, precedente);
          toutBon = false;
          break;
        }
        precedente = seq;
      }
      if (!toutBon) break;

      // Un rang hors bornes doit etre refuse.
      uint32_t inutile = 0;
      if (anneauEmplacementDuRang(a, a.remplis, inutile)) {
        snprintf(premierEcart, sizeof premierEcart, "cap=%u : rang %u accepte a tort", cap, a.remplis);
        toutBon = false;
        break;
      }
    }
  }
  verifier("index, remplissage et sequence exacts dans tous les cas", toutBon, premierEcart);
  verifier("le plus ancien ressort en premier, sans trou de sequence", toutBon);
}

static void scenarioGrandeCapacite() {
  titre("2. Capacite reelle (20 160 points, soit 14 jours)");
  const uint32_t cap = 20160;
  Support s;
  remplir(s, cap, cap + 7777);          // largement replie
  s.lu = 0;

  Anneau a;
  anneauReconstruire(a, cap, cap, lireSupport, &s);

  char d[80];
  snprintf(d, sizeof d, "index %u, %d lecture(s)", a.index, s.lu);
  verifier("tete retrouvee au bon endroit", a.index == (cap + 7777) % cap, d);
  verifier("sequence suivante correcte", a.seq == cap + 7777 + 1);
  // log2(20160) ~ 14,3 : on tolere large, mais surement pas 20 160 lectures.
  verifier("recherche bien dichotomique (moins de 40 lectures)", s.lu < 40, d);
}

static void scenarioEcriture() {
  titre("3. Ecriture : la tete avance et le plus ancien est ecrase");
  const uint32_t cap = 5;
  Anneau a; a.capacite = cap; anneauVider(a);

  Support s; remplir(s, cap, 0);
  for (uint32_t i = 0; i < 12; i++) {
    const uint32_t ou = anneauEmplacementEcriture(a);
    s.seq[ou] = a.seq;
    anneauAvancer(a);
  }
  verifier("l'anneau se declare plein", a.remplis == cap);
  verifier("la tete est au bon emplacement", a.index == 12 % cap);
  verifier("la prochaine sequence suit", a.seq == 13);

  uint32_t e = 0;
  anneauEmplacementDuRang(a, 0, e);
  char d[64]; snprintf(d, sizeof d, "plus ancien = seq %u", s.seq[e]);
  verifier("le plus ancien est bien le 8e ecrit (12 - 5 + 1)", s.seq[e] == 8, d);
  anneauEmplacementDuRang(a, cap - 1, e);
  verifier("le plus recent est le 12e", s.seq[e] == 12);
}

static void scenarioCasLimites() {
  titre("4. Cas limites et lectures en echec");
  Anneau a;
  Support s; remplir(s, 1, 1);
  anneauReconstruire(a, 1, 1, lireSupport, &s);
  verifier("capacite 1 : un seul point, toujours le plus recent",
           a.remplis == 1 && a.index == 0 && a.seq == 2);

  Anneau vide;
  anneauReconstruire(vide, 0, 0, lireSupport, &s);
  uint32_t e = 0;
  verifier("capacite nulle ne fait rien exploser",
           vide.remplis == 0 && vide.seq == 1 && !anneauEmplacementDuRang(vide, 0, e));

  Support ko; remplir(ko, 32, 64); ko.panne = true;
  Anneau b;
  anneauReconstruire(b, 32, 32, lireSupport, &ko);
  verifier("fichier illisible : repli sur le debut, sans boucle infinie",
           b.index == 0 && b.remplis == 32 && b.seq == 1);

  // Sequences trafiquees (memoire abimee) : on n'exige pas le bon resultat,
  // seulement de rester dans les bornes et de rendre la main.
  Support fou; remplir(fou, 16, 40);
  fou.seq[3] = 0xFFFFFFFFu; fou.seq[9] = 1; fou.seq[12] = 7;
  Anneau c;
  anneauReconstruire(c, 16, 16, lireSupport, &fou);
  verifier("sequences incoherentes : index reste dans les bornes", c.index < 16);
  verifier("...et le remplissage aussi", c.remplis == 16);
}

int main() {
  printf("=== Anneau d'historique ===\n");
  scenarioExhaustif();
  scenarioGrandeCapacite();
  scenarioEcriture();
  scenarioCasLimites();
  printf("\n=== %s (%d verification(s), %d echec(s)) ===\n",
         echecs ? "DES TESTS ONT ECHOUE" : "TOUS LES TESTS PASSENT", verifs, echecs);
  return echecs ? 1 : 0;
}
