/* =============================================================================
   simulateur.cpp — BANC D'ESSAI SUR PC
   -----------------------------------------------------------------------------
   Compile le VRAI cœur de régulation (../controle.cpp) avec un modèle thermique
   simplifié de terrarium, et rejoue des scénarios en accéléré. Permet de tester
   l'ordonnanceur, le PI, l'autotune et les diagnostics sans toucher au matériel
   ni attendre des heures.

       make && ./simulateur            (tous les scenarios, verdicts)
       ./simulateur --csv 2 > run.csv  (trace detaillee du scenario 2)

   Modèle : dT/dt = (P_chauffe − k·(T − T_ambiante)) / C
   Volontairement grossier — il sert à valider la LOGIQUE de commande, pas à
   prédire une température réelle. Un scénario qui passe ici reste à vérifier
   sur le matériel.
   ============================================================================= */

#include "../controle.h"
#include <stdio.h>
#include <string.h>
#include <math.h>
#include <stdlib.h>

// ------------------------- Modèle thermique ---------------------------------
/*  Deux masses thermiques : le tapis avec son substrat, et la sonde couplée à
    lui. Ce retard entre l'apport de chaleur et sa lecture est ce qui fait la
    difficulté réelle de la régulation — un modèle à une seule masse réagirait
    instantanément et donnerait une image trop flatteuse du comportement, en
    plus de rendre l'autotune par relais impossible à identifier.             */
struct Terrarium {
  float Tcoeur     = 20.0f;   // tapis + substrat
  float T          = 20.0f;   // sonde : ce que lit réellement le DS18B20
  float Tambiante  = 20.0f;
  float puissance  = 20.0f;   // W du tapis
  float capaciteCoeur = 900.0f;  // J/K
  float capaciteSonde = 120.0f;  // J/K
  float couplage   = 0.9f;    // W/K entre le substrat et la sonde
  float pertes     = 0.55f;   // W/K vers la pièce
  float rendement  = 1.0f;    // 1.0 = tapis sain, 0.0 = tapis mort

  void regle(float t) { T = Tcoeur = t; }

  void pas(bool chauffe, float dtSec) {
    const float entree    = chauffe ? puissance * rendement : 0.0f;
    const float versSonde = couplage * (Tcoeur - T);
    Tcoeur += (entree - pertes * (Tcoeur - Tambiante) - versSonde) * dtSec / capaciteCoeur;
    T      += versSonde * dtSec / capaciteSonde;
  }
};

// ------------------------- Contexte de simulation ---------------------------
struct Sim {
  Controleur   ctrl;
  Terrarium    terra[NB_ZONES];
  uint32_t     ms = 0;
  bool         sondeDebranchee[NB_ZONES] = { false, false };
  bool         sondeFigee[NB_ZONES]      = { false, false };
  float        valeurFigee[NB_ZONES]     = { 0, 0 };
  bool         traceCsv = false;

  int  nbDefauts = 0, nbDerives = 0, nbAutotunes = 0, nbChutes = 0, nbSansEffet = 0;
  char dernierTexte[200] = "";

  void init(float tDepart, float tAmbiante) {
    for (uint8_t z = 0; z < NB_ZONES; z++) {
      reglagesParDefaut(ctrl.cfg[z], z);
      terra[z].regle(tDepart);
      terra[z].Tambiante = tAmbiante;
    }
    ctrl.demarrer(0);
    ctrl.horloge(true, 12 * 60);   // plein jour par défaut
  }

  // Bruit de mesure : un DS18B20 reel ne rend jamais deux fois exactement la
  // meme valeur, sa repetabilite a court terme est de l'ordre de +/-0,05 C.
  // Sans ce bruit, un plateau thermique parfaitement plat serait pris pour une
  // sonde bloquee — un artefact du modele, pas du firmware.
  uint32_t alea = 12345;
  float bruit() {
    alea = alea * 1103515245u + 12345u;                 // suite reproductible
    return ((float)((alea >> 16) & 0xFFFF) / 65535.0f - 0.5f) * 0.08f;
  }

  float lecture(uint8_t z) {
    if (sondeDebranchee[z]) return -127.0f;             // DEVICE_DISCONNECTED_C
    if (sondeFigee[z])      return valeurFigee[z];      // vraie sonde bloquee
    return roundf((terra[z].T + bruit()) * 16.0f) / 16.0f;   // quantification 12 bits
  }

  void videNotifs() {
    Notification n;
    while (ctrl.prendreNotification(n)) {
      snprintf(dernierTexte, sizeof dernierTexte, "%s", n.texte);
      if (n.type == NOTIF_DEFAUT)   nbDefauts++;
      if (n.type == NOTIF_DERIVE)   nbDerives++;
      if (n.type == NOTIF_AUTOTUNE) nbAutotunes++;
      if (n.type == NOTIF_CHUTE)    nbChutes++;
      if (n.type == NOTIF_SANS_EFFET) nbSansEffet++;
      if (!traceCsv) printf("      [%7lus] %s\n", (unsigned long)(ms / 1000), n.texte);
    }
  }

  // Avance la simulation de `secondes`, avec un pas de 2 s (cadence réelle des
  // mesures) — chaque pas alimente le contrôleur exactement comme le firmware.
  void avancer(float secondes) {
    const float dt = 2.0f;
    for (float t = 0; t < secondes; t += dt) {
      for (uint8_t z = 0; z < NB_ZONES; z++) ctrl.mesure(z, lecture(z), ms, dt);
      ctrl.avancer(ms);
      for (uint8_t z = 0; z < NB_ZONES; z++)
        terra[z].pas(ctrl.tapisDeZone(z) >= 0, dt);
      ms += (uint32_t)(dt * 1000.0f);
      videNotifs();
      if (traceCsv && ((uint32_t)t % 60) == 0) {
        printf("%lu", (unsigned long)(ms / 1000));
        for (uint8_t z = 0; z < NB_ZONES; z++)
          printf(",%.3f,%.3f,%.3f,%.1f", ctrl.zone[z].temperature, ctrl.zone[z].consigneEff,
                 ctrl.zone[z].demande, ctrl.duty(z));
        printf(",%d\n", ctrl.tapisActif());
      }
    }
  }
};

// ------------------------- Utilitaires de test ------------------------------
static int echecs = 0;

static void verifier(const char *quoi, bool ok, const char *detail = "") {
  printf("   %s %-58s %s\n", ok ? "[ OK ]" : "[ECHEC]", quoi, detail);
  if (!ok) echecs++;
}

static void titre(const char *t) { printf("\n== %s\n", t); }

// ============================ SCÉNARIOS =====================================

// 1. Montée en température et stabilisation d'une seule zone
static void scenarioStabilisation(bool csv) {
  titre("1. Stabilisation d'une zone (depart 20 C, cible 32 C)");
  Sim s; s.traceCsv = csv; s.init(20.0f, 20.0f);
  s.ctrl.cfg[1].consigneJour = 20.0f;             // zone 2 neutralisée
  s.avancer(3.0f * 3600.0f);
  const float T = s.ctrl.zone[0].temperature;
  char d[64]; snprintf(d, sizeof d, "T=%.2f C, duty=%.0f%%", T, s.ctrl.duty(0));
  verifier("consigne atteinte a +/-0,4 C", fabsf(T - 32.0f) < 0.4f, d);
  verifier("aucun defaut declenche", s.nbDefauts == 0);
}

// 2. Les deux zones réclament en même temps : le multiplexage doit partager
static void scenarioPartage(bool csv) {
  titre("2. Deux zones en demande simultanee (partage des creneaux)");
  Sim s; s.traceCsv = csv; s.init(20.0f, 18.0f);
  s.avancer(4.0f * 3600.0f);
  const float d0 = s.ctrl.duty(0), d1 = s.ctrl.duty(1);
  char d[96]; snprintf(d, sizeof d, "duty Z1=%.0f%% Z2=%.0f%% (T=%.1f / %.1f)",
                       d0, d1, s.ctrl.zone[0].temperature, s.ctrl.zone[1].temperature);
  verifier("les deux zones recoivent du temps de chauffe", d0 > 5 && d1 > 5, d);
  verifier("jamais plus de 100 % de temps distribue", d0 + d1 <= 101.0f);
  verifier("les deux zones approchent leur consigne",
           fabsf(s.ctrl.zone[0].temperature - 32.0f) < 1.0f &&
           fabsf(s.ctrl.zone[1].temperature - 28.0f) < 1.0f);
}

// 3. Partage proportionnel : une zone très demandeuse, une peu
static void scenarioProportionnalite(bool csv) {
  titre("3. Partage proportionnel (zone 1 froide, zone 2 deja a temperature)");
  Sim s; s.traceCsv = csv; s.init(20.0f, 20.0f);
  s.terra[1].regle(27.8f);                            // zone 2 quasi a la consigne
  s.avancer(2.0f * 3600.0f);
  const float d0 = s.ctrl.duty(0), d1 = s.ctrl.duty(1);
  char d[64]; snprintf(d, sizeof d, "duty Z1=%.0f%% Z2=%.0f%%", d0, d1);
  verifier("la zone la plus en demande recoit davantage", d0 >= d1, d);
}

// 4. Sonde débranchée -> défaut verrouillé, chauffage coupé
static void scenarioSondeDebranchee(bool csv) {
  titre("4. Sonde debranchee en cours de route");
  Sim s; s.traceCsv = csv; s.init(28.0f, 20.0f);
  s.avancer(600);
  s.sondeDebranchee[0] = true;
  s.avancer(60);
  verifier("defaut SONDE declenche", s.ctrl.zone[0].defaut == DEF_SONDE);
  s.avancer(600);
  bool jamaisChauffee = true;
  for (int i = 0; i < 200; i++) {
    s.avancer(2);
    if (s.ctrl.tapisDeZone(0) >= 0) jamaisChauffee = false;
  }
  verifier("la zone en defaut ne recoit plus aucun creneau", jamaisChauffee);
  s.sondeDebranchee[0] = false;
  s.avancer(600);
  verifier("le defaut ne se leve pas tout seul", s.ctrl.zone[0].defaut == DEF_SONDE);
  s.ctrl.leverDefauts(s.ms);
  s.avancer(60);
  verifier("il se leve sur commande explicite", s.ctrl.zone[0].defaut == DEF_AUCUN);
}

// 5. Sonde figée -> avertissement puis défaut
static void scenarioSondeFigee(bool csv) {
  titre("5. Sonde figee (valeur identique pendant 30 min)");
  Sim s; s.traceCsv = csv; s.init(25.0f, 20.0f);
  s.ctrl.cfg[0].consigneJour = 25.5f;   // ecart faible : seul le diagnostic
  s.ctrl.cfg[1].consigneJour = 20.0f;   // "sonde figee" peut se declencher
  s.sondeFigee[0] = true; s.valeurFigee[0] = 25.0f;
  s.avancer(16.0f * 60.0f);
  verifier("avertissement emis a 15 min", s.ctrl.zone[0].figeSignale);
  verifier("pas encore de coupure", s.ctrl.zone[0].defaut == DEF_AUCUN);
  s.avancer(16.0f * 60.0f);
  verifier("defaut SONDE FIGEE a 30 min", s.ctrl.zone[0].defaut == DEF_FIGE);
}

// 6. Valeur 85,00 °C isolée : ne doit surtout pas passer pour une surchauffe
static void scenario85(bool csv) {
  titre("6. Valeur de reset 85,00 C du DS18B20");
  Sim s; s.traceCsv = csv; s.init(28.0f, 20.0f);
  s.avancer(120);
  s.sondeFigee[0] = true; s.valeurFigee[0] = 85.0f;
  s.avancer(4);                                     // 2 lectures parasites
  verifier("une valeur isolee est ignoree", s.ctrl.zone[0].defaut == DEF_AUCUN);
  s.avancer(6);                                     // ca persiste
  verifier("des repetitions declenchent un defaut SONDE", s.ctrl.zone[0].defaut == DEF_SONDE);
  verifier("jamais interprete comme une surchauffe", s.ctrl.zone[0].defaut != DEF_SURCHAUFFE);
}

// 7. Tapis mort : la chauffe est commandee mais la temperature descend.
static void scenarioTapisMort(bool csv) {
  titre("7. Tapis grille en cours de route (terrarium chaud qui refroidit)");
  Sim s; s.traceCsv = csv; s.init(32.0f, 20.0f);
  s.ctrl.cfg[1].consigneJour = 20.0f;
  s.avancer(300);
  s.terra[0].rendement = 0.0f;                    // le tapis lache
  s.avancer(30.0f * 60.0f);
  verifier("alerte de derive emise avant le defaut", s.nbDerives >= 1);
  s.avancer(45.0f * 60.0f);
  verifier("alerte de chauffe sans effet emise", s.nbSansEffet >= 1);
  verifier("mais le chauffage n'est PAS coupe : ce diagnostic ne tranche pas",
           s.ctrl.zone[0].defaut == DEF_AUCUN);
}

// 7 bis. Cas limite assume : un tapis deja mort au demarrage, dans un terrarium
// deja a la temperature ambiante, ne fait rien descendre — il n'y a donc rien a
// observer. Seule l'alerte de derive peut le signaler.
static void scenarioTapisMortDepart(bool) {
  titre("7 bis. Tapis mort des le depart, terrarium deja a l'ambiante");
  Sim s; s.init(20.0f, 20.0f);
  s.terra[0].rendement = 0.0f;
  s.ctrl.cfg[1].consigneJour = 20.0f;
  s.avancer(40.0f * 60.0f);
  verifier("l'alerte de derive previent quand meme", s.nbDerives >= 1);
  // Le bruit de mesure suffit a ecarter le diagnostic « sonde bloquee », et
  // rien ne descend : aucune coupure n'est justifiee ici.
  verifier("pas de coupure : rien ne prouve la panne ici",
           s.ctrl.zone[0].defaut == DEF_AUCUN, nomDefaut(s.ctrl.zone[0].defaut));
}

// 8. Surchauffe : coupure absolue même si la régulation ne demande rien
static void scenarioSurchauffe(bool csv) {
  titre("8. Surchauffe (source de chaleur externe)");
  Sim s; s.traceCsv = csv; s.init(30.0f, 20.0f);
  s.avancer(60);
  s.terra[0].Tambiante = 50.0f;                     // piece qui devient un four
  s.avancer(3.0f * 3600.0f);
  verifier("defaut SURCHAUFFE declenche", s.ctrl.zone[0].defaut == DEF_SURCHAUFFE);
  verifier("declenche sous le seuil configure",
           s.ctrl.zone[0].temperature >= s.ctrl.cfg[0].tempMax - 0.5f);
}

// 9. Cycle jour/nuit avec rampe
static void scenarioJourNuit(bool csv) {
  titre("9. Cycle jour/nuit et rampe de transition");
  Sim s; s.traceCsv = csv; s.init(32.0f, 22.0f);
  s.ctrl.horloge(true, 12 * 60);
  s.avancer(4);
  const float cJour = s.ctrl.zone[0].consigneEff;
  s.ctrl.horloge(true, 20 * 60 + 22);               // ~mi-rampe du soir (45 min)
  s.avancer(4);
  const float cRampe = s.ctrl.zone[0].consigneEff;
  s.ctrl.horloge(true, 23 * 60);
  s.avancer(4);
  const float cNuit = s.ctrl.zone[0].consigneEff;
  char d[80]; snprintf(d, sizeof d, "jour %.1f -> rampe %.1f -> nuit %.1f", cJour, cRampe, cNuit);
  verifier("consignes jour et nuit distinctes", fabsf(cJour - 32.0f) < 0.01f && fabsf(cNuit - 26.0f) < 0.01f, d);
  verifier("la rampe interpole entre les deux", cRampe < cJour && cRampe > cNuit);
  s.ctrl.horloge(false, 0);
  s.avancer(4);
  verifier("sans heure fiable, repli sur la consigne de jour",
           fabsf(s.ctrl.zone[0].consigneEff - 32.0f) < 0.01f);
}

// 10. Autotune
static void scenarioAutotune(bool csv) {
  titre("10. Autotune par relais (identification de la bande)");
  Sim s; s.traceCsv = csv; s.init(31.0f, 20.0f);
  s.ctrl.cfg[1].consigneJour = 20.0f;
  s.avancer(60);                                  // premieres mesures valides
  char err[64];
  const bool lance = s.ctrl.lancerAutotune(0, s.ms, err, sizeof err);
  verifier("autotune accepte", lance, lance ? "" : err);
  const float bandeAvant = s.ctrl.cfg[0].bande;
  s.avancer(2.0f * 3600.0f);
  char d[96]; snprintf(d, sizeof d, "bande %.2f -> %.2f C, ki %.5f",
                       bandeAvant, s.ctrl.cfg[0].bande, s.ctrl.cfg[0].ki);
  verifier("autotune abouti", s.ctrl.zone[0].autotune == AT_FINI, d);
  verifier("bande dans les bornes de securite",
           s.ctrl.cfg[0].bande >= BANDE_MIN && s.ctrl.cfg[0].bande <= BANDE_MAX);
  if (s.ctrl.zone[0].autotune == AT_FINI) {
    s.avancer(3.0f * 3600.0f);
    char e[64]; snprintf(e, sizeof e, "T=%.2f C", s.ctrl.zone[0].temperature);
    verifier("regulation stable avec les gains identifies",
             fabsf(s.ctrl.zone[0].temperature - 32.0f) < 0.6f, e);
  }
}

// 11. Réglages corrompus : rien d'aberrant ne doit pouvoir s'appliquer
static void scenarioReglagesCorrompus(bool) {
  titre("11. Reglages corrompus en memoire");
  ReglagesZone r;
  memset(&r, 0xA5, sizeof r);                       // NVS illisible
  char rapport[160] = "";
  const bool corrige = assainirReglages(r, 0, rapport, sizeof rapport);
  verifier("corruption detectee", corrige, rapport);
  char err[80];
  verifier("reglages assainis desormais valides", reglagesValides(r, err, sizeof err), err);

  ReglagesZone b; reglagesParDefaut(b, 0);
  b.tempMax = 30.0f; b.consigneJour = 35.0f;        // consigne au-dessus du seuil
  verifier("consigne au-dessus du seuil max refusee", !reglagesValides(b, err, sizeof err), err);
  assainirReglages(b, 0, rapport, sizeof rapport);
  verifier("puis corrigee automatiquement", reglagesValides(b, err, sizeof err));
}

// 12. Exclusion mutuelle : invariant central de tout le projet
static void scenarioExclusion(bool) {
  titre("12. Invariant : jamais deux tapis alimentes a la fois");
  Sim s; s.init(15.0f, 12.0f);                      // conditions dures, forte demande
  bool ok = true;
  for (int i = 0; i < 5000; i++) {
    s.avancer(2);
    uint8_t n = 0, m = s.ctrl.masqueTapis();
    for (uint8_t b = 0; b < NB_TAPIS; b++) if (m & (1u << b)) n++;
    if (n > s.ctrl.limiteZones()) { ok = false; break; }
  }
  verifier("jamais plus de tapis allumes que la limite de puissance", ok);
  verifier("les deux zones ont bien ete servies", s.ctrl.duty(0) > 0 && s.ctrl.duty(1) > 0);
  s.ctrl.suspendre(true);
  s.avancer(120);
  verifier("mode suspendu (OTA) : tout coupe", s.ctrl.tapisActif() == -1);
}


// 13. L'autotune doit rester exploitable meme quand l'autre zone reclame de la
//     chaleur en meme temps : son relais a besoin de la pleine puissance.
static void scenarioAutotuneConcurrence(bool csv) {
  titre("13. Autotune pendant que l'autre zone reclame aussi");
  Sim s; s.traceCsv = csv; s.init(31.0f, 18.0f);
  s.terra[1].regle(20.0f);                        // zone 2 tres froide : demande max
  s.avancer(60);
  char err[64];
  const bool lance = s.ctrl.lancerAutotune(0, s.ms, err, sizeof err);
  verifier("autotune accepte", lance, lance ? "" : err);
  s.avancer(2.0f * 3600.0f);
  char d[110];
  snprintf(d, sizeof d, "bande %.2f C, ki %.5f, zone 2 a %.1f C",
           s.ctrl.cfg[0].bande, s.ctrl.cfg[0].ki, s.ctrl.zone[1].temperature);
  verifier("autotune abouti malgre la concurrence", s.ctrl.zone[0].autotune == AT_FINI, d);
  verifier("gains identifies plausibles",
           s.ctrl.cfg[0].bande >= 1.0f && s.ctrl.cfg[0].bande <= 6.0f);
  verifier("les gains sont signales comme a sauvegarder", s.ctrl.zone[0].cfgModifie);
  verifier("la zone 2 a quand meme ete chauffee", s.ctrl.duty(1) > 0.0f);
}

// 14. Un defaut doit faire demarrer le temps de repos du tapis coupe.
static void scenarioReposApresDefaut(bool) {
  titre("14. Repos du tapis apres une coupure sur defaut");
  Sim s; s.init(20.0f, 18.0f);
  s.avancer(300);
  s.sondeDebranchee[0] = true;
  s.avancer(30);
  verifier("zone 1 en defaut", s.ctrl.zone[0].defaut == DEF_SONDE);
  bool exclusif = true;
  for (int i = 0; i < 600; i++) {
    s.avancer(2);
    if (s.ctrl.tapisDeZone(0) >= 0) exclusif = false;
  }
  verifier("plus aucun tapis de la zone en defaut n'est alimente", exclusif);
  verifier("la zone saine continue de reguler", s.ctrl.duty(1) > 0.0f);
}


// 15. Avec une alimentation plus grosse, la limite des ~50 % par zone doit
//     disparaitre : les deux zones peuvent chauffer en meme temps.
static void scenarioLimitePuissance(bool csv) {
  titre("15. Limite de puissance relevee a deux zones simultanees");
  // Piece a 0 C : tenir 32 et 28 C demande environ 88 % et 77 % du temps de
  // chauffe, soit 165 % au total — impossible avec une seule zone a la fois.
  Sim a; a.traceCsv = csv; a.init(20.0f, 0.0f);
  a.avancer(4.0f * 3600.0f);
  Sim b; b.traceCsv = csv; b.init(20.0f, 0.0f);
  b.ctrl.limiterZones(2);
  b.avancer(4.0f * 3600.0f);
  char d[120];
  snprintf(d, sizeof d, "1 zone : %.2f/%.2f C — 2 zones : %.2f/%.2f C",
           a.ctrl.zone[0].temperature, a.ctrl.zone[1].temperature,
           b.ctrl.zone[0].temperature, b.ctrl.zone[1].temperature);
  verifier("les deux zones montent plus haut avec la limite relevee",
           b.ctrl.zone[0].temperature > a.ctrl.zone[0].temperature &&
           b.ctrl.zone[1].temperature > a.ctrl.zone[1].temperature, d);
  char e[110];
  snprintf(e, sizeof e, "1 zone : %.0f%%+%.0f%% — 2 zones : %.0f%%+%.0f%%",
           a.ctrl.duty(0), a.ctrl.duty(1), b.ctrl.duty(0), b.ctrl.duty(1));
  verifier("le total depasse 100 %, ce qu'une seule zone ne permet pas",
           a.ctrl.duty(0) + a.ctrl.duty(1) <= 101.0f &&
           b.ctrl.duty(0) + b.ctrl.duty(1) > 120.0f, e);
  verifier("la limite par defaut reste a une seule zone", a.ctrl.limiteZones() == 1);
  verifier("un montage sous-dimensionne n'est jamais verrouille en panne",
           a.ctrl.zone[0].defaut == DEF_AUCUN && a.ctrl.zone[1].defaut == DEF_AUCUN);
  verifier("mais il est signale par une alerte de derive", a.nbDerives >= 1);
}

// 16. Mode maintenance : coupure temporaire avec reprise automatique.
static void scenarioMaintenance(bool) {
  titre("16. Mode maintenance temporise");
  Sim s; s.init(20.0f, 15.0f);
  s.avancer(600);
  verifier("le chauffage fonctionne avant", s.ctrl.duty(0) > 0);
  s.ctrl.maintenance(s.ms, 5);
  bool coupe = true;
  for (int i = 0; i < 120; i++) { s.avancer(2); if (s.ctrl.masqueTapis()) coupe = false; }
  verifier("tout est coupe pendant la maintenance", coupe);
  verifier("l'etat de maintenance est visible", s.ctrl.enMaintenance());
  s.avancer(6.0f * 60.0f);
  verifier("reprise automatique a l'echeance", !s.ctrl.enMaintenance());
  s.avancer(300);
  verifier("le chauffage est reparti", s.ctrl.masqueTapis() != 0 || s.ctrl.zone[0].demande > 0);
}

// 17. Chute brutale : terrarium ouvert en cours de regulation.
static void scenarioChuteBrutale(bool) {
  titre("17. Chute brutale de temperature");
  Sim s; s.init(32.0f, 22.0f);
  s.avancer(600);
  verifier("aucune alerte de chute au repos", s.nbChutes == 0);
  s.terra[0].pertes = 4.0f;                      // porte grande ouverte
  s.avancer(400);
  verifier("chute detectee", s.nbChutes >= 1);
  verifier("aucun defaut declenche pour autant", s.ctrl.zone[0].defaut == DEF_AUCUN);
}

// 18. Decalage saisonnier applique aux consignes.
static void scenarioSaison(bool) {
  titre("18. Cyclage saisonnier");
  Sim s; s.init(30.0f, 22.0f);
  s.avancer(4);
  const float avant = s.ctrl.zone[0].consigneEff;
  s.ctrl.decalageSaison(-5.0f);
  s.avancer(4);
  const float apres = s.ctrl.zone[0].consigneEff;
  char d[64]; snprintf(d, sizeof d, "%.1f -> %.1f C", avant, apres);
  verifier("les consignes descendent de 5 C", fabsf((avant - apres) - 5.0f) < 0.01f, d);
  s.ctrl.decalageSaison(-40.0f);                 // reglage aberrant
  s.avancer(4);
  verifier("le decalage reste borne par les limites de securite",
           s.ctrl.zone[0].consigneEff >= CONSIGNE_MIN);
  s.ctrl.decalageSaison(0.0f);
}

// ============================ POINT D'ENTRÉE =================================

int main(int argc, char **argv) {
  bool csv = false; int seul = 0;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--csv") && i + 1 < argc) { csv = true; seul = atoi(argv[++i]); }
  }

  void (*scenarios[])(bool) = {
    scenarioStabilisation, scenarioPartage, scenarioProportionnalite,
    scenarioSondeDebranchee, scenarioSondeFigee, scenario85,
    scenarioTapisMort, scenarioTapisMortDepart, scenarioSurchauffe, scenarioJourNuit,
    scenarioAutotune, scenarioReglagesCorrompus, scenarioExclusion,
    scenarioAutotuneConcurrence, scenarioReposApresDefaut,
    scenarioLimitePuissance, scenarioMaintenance, scenarioChuteBrutale, scenarioSaison
  };
  const int n = sizeof(scenarios) / sizeof(scenarios[0]);

  if (csv) {
    if (seul < 1 || seul > n) { fprintf(stderr, "Scenario 1..%d\n", n); return 2; }
    printf("t_s,T1,cible1,demande1,duty1,T2,cible2,demande2,duty2,tapis\n");
    scenarios[seul - 1](true);
    return 0;
  }

  printf("=== Banc d'essai du thermostat de terrarium ===\n");
  for (int i = 0; i < n; i++) scenarios[i](false);

  printf("\n=== %s (%d echec%s) ===\n", echecs ? "DES TESTS ONT ECHOUE" : "TOUS LES TESTS PASSENT",
         echecs, echecs > 1 ? "s" : "");
  return echecs ? 1 : 0;
}
