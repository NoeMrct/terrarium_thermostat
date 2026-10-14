/* Banc d'essai du canal de commande (protocole.cpp), contre le VRAI code du
   firmware et non une maquette : jeton exigé ou non selon l'action, bornes des
   réglages, réponses rejouées sans effet, charges hostiles (JSON tronqué,
   nombres absurdes, chaînes trop longues), action « maj ».

     make protocole */
#include "socle-factice.h"
#include <cmath>
#include <cstdlib>

static int g_echecs = 0, g_total = 0;

#define VERIFIE(cond, nom)                                        \
  do {                                                            \
    g_total++;                                                    \
    if (cond)                                                     \
      printf("   [ OK ] %s\n", nom);                              \
    else {                                                        \
      printf("   [ECHEC] %s (%s:%d)\n", nom, __FILE__, __LINE__); \
      g_echecs++;                                                 \
    }                                                             \
  } while (0)

static bool contient(const std::string &s, const char *m) { return s.find(m) != std::string::npos; }

static void cmd(SocleFactice &s, const char *json) { Protocole::traiterCommande(s, json, strlen(json)); }

int main() {
  printf("=== Canal de commande ===\n");
  SocleFactice s;

  // --- lecture sans jeton -------------------------------------------------
  cmd(s, "{\"req\":\"1\",\"action\":\"version\"}");
  VERIFIE(contient(s.derniere(), "\"ok\":true") && contient(s.derniere(), "\"proto\":3"),
          "version se lit sans jeton");
  cmd(s, "{\"req\":\"2\",\"action\":\"etat\"}");
  VERIFIE(contient(s.derniere(), "\"zones\":[") && contient(s.derniere(), "\"req\":\"2\""),
          "etat se lit sans jeton");
  cmd(s, "{\"req\":\"3\",\"action\":\"stats\"}");
  VERIFIE(contient(s.derniere(), "\"ok\":true"), "stats se lit sans jeton");
  cmd(s, "{\"req\":\"4\",\"action\":\"historique\",\"heures\":48,\"max\":50}");
  VERIFIE(contient(s.derniere(), "\"heures\":48") && contient(s.derniere(), "\"n\":50"),
          "historique transmet heures et max");
  cmd(s, "{\"req\":\"5\",\"action\":\"historique\",\"heures\":-3,\"max\":100000}");
  VERIFIE(contient(s.derniere(), "\"heures\":24") && contient(s.derniere(), "\"n\":120"),
          "historique : bornes absurdes ramenées aux valeurs par défaut");

  // --- jeton --------------------------------------------------------------
  s.vider();
  cmd(s, "{\"req\":\"10\",\"action\":\"reset\"}");
  VERIFIE(
      contient(s.derniere(), "jeton invalide") && s.actions.size() == 1 && contient(s.actions[0], "journal"),
      "action modifiante sans jeton : refusée et journalisée");
  cmd(s, "{\"req\":\"11\",\"action\":\"reset\",\"jeton\":\"SIMULATIONTESTJETON0000X\"}");
  VERIFIE(contient(s.derniere(), "jeton invalide"), "jeton d'un caractère faux : refusé");
  cmd(s, "{\"req\":\"12\",\"action\":\"reset\",\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "\"ok\":true") &&
              s.actions.back() == "journal Defauts leves via le canal de commande",
          "bon jeton : défauts levés");

  // --- rejouée sans effet --------------------------------------------------
  s.vider();
  cmd(s, "{\"req\":\"20\",\"action\":\"redemarrer\",\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  cmd(s, "{\"req\":\"20\",\"action\":\"redemarrer\",\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  int redemarrages = 0;
  for (const auto &a : s.actions)
    if (a == "redemarrer") redemarrages++;
  VERIFIE(redemarrages == 1 && s.reponses.size() == 2 && s.reponses[0] == s.reponses[1],
          "même req livrée deux fois : une seule exécution, même réponse");
  cmd(s, "{\"action\":\"version\"}");
  cmd(s, "{\"action\":\"version\"}");
  VERIFIE(s.reponses.size() == 4, "sans req : jamais considérée comme un doublon");
  Protocole::oublierReponses();
  s.vider();
  for (int i = 0; i < 9; i++) {
    char j[80];
    snprintf(j, sizeof j, "{\"req\":\"r%d\",\"action\":\"version\"}", i);
    cmd(s, j);
  }
  s.vider();
  cmd(s, "{\"req\":\"r0\",\"action\":\"etat\"}");
  VERIFIE(contient(s.derniere(), "\"zones\""),
          "la mémoire des réponses ne garde que les 8 dernières (r0 oubliée, donc rejouée)");

  // --- zone ----------------------------------------------------------------
  s.vider();
  cmd(s,
      "{\"req\":\"30\",\"action\":\"zone\",\"z\":0,\"jour\":31.5,\"nuit\":26,\"nom\":\"Point "
      "chaud\",\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "\"ok\":true") && fabsf(s.zones[0].consigneJour - 31.5f) < 1e-4f &&
              strcmp(s.zones[0].nom, "Point chaud") == 0 && s.zonesSauvees == 1,
          "zone : consignes et nom écrits puis sauvés");
  cmd(s, "{\"req\":\"31\",\"action\":\"zone\",\"z\":0,\"jour\":80,\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "\"ok\":false") && fabsf(s.zones[0].consigneJour - 31.5f) < 1e-4f,
          "zone : consigne hors bornes refusée, rien n'est modifié");
  cmd(s, "{\"req\":\"32\",\"action\":\"zone\",\"z\":7,\"jour\":30,\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "zone invalide"), "zone : index hors de la carte refusé");
  cmd(s,
      "{\"req\":\"33\",\"action\":\"zone\",\"z\":1,\"nom\":\"Nom beaucoup trop long pour tenir dans le champ "
      "prevu a cet effet\",\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(strlen(s.zones[1].nom) < sizeof s.zones[1].nom, "zone : nom trop long tronqué sans débordement");
  cmd(s, "{\"req\":\"34\",\"action\":\"zone\",\"z\":1,\"rampe\":-5,\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(s.zones[1].rampeMinutes == 0 || contient(s.derniere(), "\"ok\":false"),
          "zone : rampe négative ne déborde pas en 65531");
  cmd(s,
      "{\"req\":\"35\",\"action\":\"zone\",\"z\":0,\"jour\":\"trente\",\"jeton\":"
      "\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "\"ok\":true") && fabsf(s.zones[0].consigneJour - 31.5f) < 1e-4f,
          "zone : champ du mauvais type ignoré");

  // --- globaux et alim -----------------------------------------------------
  s.vider();
  cmd(s, "{\"req\":\"40\",\"action\":\"globaux\",\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "\"amperes\":3.0") && s.globauxSauves == 0,
          "globaux sans champ : lecture seule");
  cmd(s,
      "{\"req\":\"41\",\"action\":\"globaux\",\"amperes\":5,\"entretienMin\":30,\"jeton\":"
      "\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "\"amperes\":5.0") && contient(s.derniere(), "\"zonesSimultanees\":2") &&
              s.globauxSauves == 1,
          "globaux : 5 A → deux zones simultanées");
  cmd(s, "{\"req\":\"42\",\"action\":\"globaux\",\"amperes\":500,\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "\"ok\":false") && fabsf(s.glob.courantAlimA - 5.0f) < 1e-4f,
          "globaux : ampérage absurde refusé");
  cmd(s,
      "{\"req\":\"43\",\"action\":\"globaux\",\"entretienMin\":-1,\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "\"ok\":false"),
          "globaux : entretien négatif refusé (pas de débordement silencieux)");
  s.heure = false;
  cmd(s,
      "{\"req\":\"44\",\"action\":\"globaux\",\"saisonActive\":true,\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "heure inconnue"), "globaux : cycle saisonnier refusé sans heure");
  s.heure = true;
  cmd(s,
      "{\"req\":\"45\",\"action\":\"globaux\",\"saisonActive\":true,\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(s.glob.saisonActive && s.glob.saisonDebutEpoch == 1760000000u,
          "globaux : cycle saisonnier daté au moment de l'activation");
  cmd(s,
      "{\"req\":\"46\",\"action\":\"alim\",\"amperes\":3,\"watts\":20,\"jeton\":"
      "\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "\"zonesSimultanees\":1"), "alim : 3 A → une zone");
  cmd(s, "{\"req\":\"47\",\"action\":\"alim\",\"amperes\":0.1,\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "amperage hors"), "alim : 0,1 A refusé");

  // --- actions simples -------------------------------------------------------
  s.vider();
  cmd(s, "{\"req\":\"50\",\"action\":\"entretien\",\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(s.actions.back() == "entretien 30", "entretien sans durée : durée par défaut des réglages globaux");
  cmd(s, "{\"req\":\"51\",\"action\":\"entretien\",\"minutes\":999,\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "hors 0-240"), "entretien : 999 min refusées");
  cmd(s, "{\"req\":\"52\",\"action\":\"autotune\",\"z\":1,\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(s.actions.back() == "autotune 1", "autotune lancé sur la zone 2");
  s.autotuneRefuse = true;
  cmd(s, "{\"req\":\"53\",\"action\":\"autotune\",\"z\":1,\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "sonde en defaut"),
          "autotune : le refus du cœur de régulation est transmis tel quel");
  cmd(s, "{\"req\":\"54\",\"action\":\"stop-autotune\",\"z\":0,\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(s.actions.back() == "stop-autotune 0", "stop-autotune");
  cmd(s, "{\"req\":\"55\",\"action\":\"effacer-historique\",\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(s.actions[s.actions.size() - 2] == "effacerHistorique", "effacer-historique");
  cmd(s, "{\"req\":\"56\",\"action\":\"nimporte\",\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "action inconnue"), "action inconnue");

  // --- maj -------------------------------------------------------------------
  s.vider();
  cmd(s, "{\"req\":\"60\",\"action\":\"maj\",\"version\":\"9.9.9\",\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "deja en 9.9.9") && s.actions.empty(),
          "maj : version déjà installée refusée");
  cmd(s,
      "{\"req\":\"61\",\"action\":\"maj\",\"version\":\"9.9.9\",\"forcer\":true,\"jeton\":"
      "\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "\"maj\":\"telechargement\"") && s.actions.back() == "maj 9.9.9",
          "maj : forcer réinstalle la même version");
  cmd(s,
      "{\"req\":\"62\",\"action\":\"maj\",\"url\":\"https://pirate.example/"
      "fw.bin\",\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "hote non autorise"), "maj : URL hors des hôtes autorisés refusée");
  cmd(s,
      "{\"req\":\"63\",\"action\":\"maj\",\"url\":\"https://github.com/NoeMrct/terrarium_thermostat/releases/"
      "download/v3.4.1/terrarium-3.4.1-firmware.bin\",\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.actions.back(), "maj https://github.com/"), "maj : URL GitHub acceptée");
  cmd(s, "{\"req\":\"64\",\"action\":\"maj\",\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "url ou version attendue"), "maj : sans cible");
  cmd(s, "{\"req\":\"65\",\"action\":\"maj\",\"version\":\"3.5.0\"}");
  VERIFIE(contient(s.derniere(), "jeton invalide"), "maj : exige le jeton");

  // --- charges hostiles --------------------------------------------------------
  s.vider();
  cmd(s, "{\"req\":\"70\",\"action\":\"etat\"");
  VERIFIE(contient(s.derniere(), "JSON invalide") && contient(s.derniere(), "\"req\":\"\""),
          "JSON tronqué : réponse d'erreur sans req");
  cmd(s, "[1,2,3]");
  VERIFIE(contient(s.derniere(), "JSON invalide"), "tableau à la place d'un objet");
  cmd(s, "");
  VERIFIE(contient(s.derniere(), "JSON invalide"), "charge vide");
  Protocole::traiterCommande(s, nullptr, 0);
  VERIFIE(contient(s.derniere(), "JSON invalide"), "pointeur nul");
  std::string longue = "{\"req\":\"";
  longue.append(500, 'x');
  longue += "\",\"action\":\"version\"}";
  cmd(s, longue.c_str());
  VERIFIE(contient(s.derniere(), "\"ok\":true") && s.derniere().size() < Protocole::TAILLE_REPONSE,
          "req de 500 caractères : réponse tronquée proprement, pas de débordement");
  cmd(s, "{\"req\":\"a\\\"b\",\"action\":\"version\"}");
  VERIFIE(contient(s.derniere(), "\"req\":\"a\\\"b\""), "req avec guillemet : échappée dans la réponse");
  cmd(s,
      "{\"req\":\"71\",\"action\":\"zone\",\"z\":1e30,\"jour\":30,\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "\"ok\":false"), "zone : index 1e30 refusé");
  cmd(s,
      "{\"req\":\"72\",\"action\":\"zone\",\"z\":0,\"jour\":1e308,\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "\"ok\":false"), "zone : consigne 1e308 refusée");
  cmd(s, "{\"req\":\"73\",\"action\":\"zone\",\"z\":0,\"jour\":null,\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "\"ok\":true"), "zone : null ignoré");

  printf("\n=== %s : %d/%d ===\n", g_echecs ? "ECHEC" : "CANAL DE COMMANDE OK", g_total - g_echecs, g_total);
  return g_echecs ? 1 : 0;
}
