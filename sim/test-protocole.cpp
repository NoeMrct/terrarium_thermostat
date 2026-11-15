/* Banc d'essai du canal de commande (protocole.cpp), contre le VRAI code du
   firmware et non une maquette : jeton exigé ou non selon l'action, bornes des
   réglages, réponses rejouées sans effet, charges hostiles (JSON tronqué,
   nombres absurdes, chaînes trop longues), action « maj ».

     make protocole */
#include "socle-factice.h"
#include "../signature.h"
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

// Enveloppe signée du protocole 4, telle que l'application la construit.
static std::string signe(const std::string &commande, const char *cle = "SIMULATIONTESTJETON00001") {
  uint8_t mac[32];
  Signature::hmacSha256((const uint8_t *)cle, strlen(cle), (const uint8_t *)commande.data(), commande.size(),
                        mac);
  char hex[65];
  Signature::hex(mac, hex);
  std::string echappee;
  for (char c : commande) {
    if (c == '"' || c == '\\') echappee += '\\';
    echappee += c;
  }
  return std::string("{\"c\":\"") + echappee + "\",\"sig\":\"" + hex + "\"}";
}
static std::string hexDe(const char *texte) {
  uint8_t e[32];
  Signature::sha256((const uint8_t *)texte, strlen(texte), e);
  char h[65];
  Signature::hex(e, h);
  return h;
}

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
  VERIFIE(contient(s.derniere(), "\"heures\":24") && contient(s.derniere(), "\"n\":120") &&
              contient(s.derniere(), "\"decalage\":0"),
          "historique : bornes absurdes ramenées aux valeurs par défaut");
  cmd(s, "{\"req\":\"5b\",\"action\":\"historique\",\"heures\":15,\"max\":180,\"decalage\":30}");
  VERIFIE(contient(s.derniere(), "\"decalage\":30"), "historique : fenêtre plus ancienne (decalage)");
  cmd(s, "{\"req\":\"5c\",\"action\":\"historique\",\"decalage\":9999}");
  VERIFIE(contient(s.derniere(), "\"decalage\":0"), "historique : decalage absurde ramené à 0");

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

  // --- protocole 4 : commandes signées -------------------------------------
  {
    VERIFIE(hexDe("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            "SHA-256(« abc ») : vecteur de la FIPS 180-2");
    uint8_t mac[32];
    char h[65];
    Signature::hmacSha256((const uint8_t *)"Jefe", 4, (const uint8_t *)"what do ya want for nothing?", 28,
                          mac);
    Signature::hex(mac, h);
    VERIFIE(std::string(h) == "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
            "HMAC-SHA256 : cas 2 de la RFC 4231");
    uint8_t longue[131];
    memset(longue, 0xaa, sizeof longue);
    const char *m6 = "Test Using Larger Than Block-Size Key - Hash Key First";
    Signature::hmacSha256(longue, sizeof longue, (const uint8_t *)m6, strlen(m6), mac);
    Signature::hex(mac, h);
    VERIFIE(std::string(h) == "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
            "HMAC-SHA256 : clé plus longue qu'un bloc (cas 6 de la RFC 4231)");

    s.vider();
    s.heure = true;
    std::string e = signe("{\"req\":\"s1\",\"action\":\"reset\",\"ts\":1760000030}");
    cmd(s, e.c_str());
    VERIFIE(contient(s.derniere(), "\"ok\":true") && contient(s.derniere(), "\"req\":\"s1\"") &&
                s.actions.back() == "journal Defauts leves via le canal de commande",
            "commande signée, sans le code en clair : acceptée");
    e = signe("{\"req\":\"s2\",\"action\":\"reset\",\"ts\":1760000030}", "SIMULATIONTESTJETON0000X");
    cmd(s, e.c_str());
    VERIFIE(contient(s.derniere(), "signature invalide") && contient(s.derniere(), "\"req\":\"s2\"") &&
                contient(s.actions.back(), "signature invalide"),
            "signée avec un autre code : refusée, journalisée, avec son req");
    e = signe("{\"req\":\"s3\",\"action\":\"reset\",\"ts\":1760000030}");
    e[e.size() - 3] = e[e.size() - 3] == 'a' ? 'b' : 'a';
    cmd(s, e.c_str());
    VERIFIE(contient(s.derniere(), "signature invalide"), "signature altérée d'un chiffre : refusée");
    e = signe("{\"req\":\"s4\",\"action\":\"reset\",\"ts\":1759990000}");
    cmd(s, e.c_str());
    VERIFIE(contient(s.derniere(), "perimee"), "signée mais vieille de 3 h : refusée (rejeu)");
    e = signe("{\"req\":\"s5\",\"action\":\"reset\"}");
    cmd(s, e.c_str());
    VERIFIE(contient(s.derniere(), "perimee"),
            "signée sans heure alors que le socle est à l'heure : refusée");
    s.heure = false;
    e = signe("{\"req\":\"s6\",\"action\":\"reset\",\"ts\":1759990000}");
    cmd(s, e.c_str());
    VERIFIE(contient(s.derniere(), "\"ok\":true"), "socle sans heure fiable : l'heure n'est pas exigée");
    s.heure = true;
    cmd(s, "{\"c\":\"{\\\"req\\\":\\\"s7\\\"\",\"sig\":\"00\"}");
    VERIFIE(contient(s.derniere(), "signature invalide"), "enveloppe mal formée : refusée sans planter");
    e = signe("{\"req\":\"s8\",\"action\":\"version\",\"ts\":1760000000}");
    cmd(s, e.c_str());
    VERIFIE(contient(s.derniere(), "\"proto\":"), "une lecture signée passe aussi");
  }

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
  VERIFIE(contient(s.derniere(), "\"maj\":\"telechargement\"") && s.actions.back() == "maj 9.9.9 forcer",
          "maj : forcer réinstalle la même version");
  s.vider();
  cmd(s,
      "{\"req\":\"66\",\"action\":\"maj\",\"version\":\"9.9.8\",\"forcer\":true,\"jeton\":"
      "\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "plus ancienne que 9.9.9 : retour refuse") && s.actions.empty(),
          "maj : version plus ancienne refusée, même avec forcer (anti-retour)");
  cmd(s, "{\"req\":\"67\",\"action\":\"maj\",\"version\":\"9.9\",\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "version X.Y.Z attendue") && s.actions.empty(),
          "maj : version malformée refusée");
  cmd(s,
      "{\"req\":\"68\",\"action\":\"maj\",\"url\":\"https://github.com/NoeMrct/terrarium_thermostat/releases/"
      "download/v3.4.1/"
      "terrarium-3.4.1-firmware.bin\",\"forcer\":true,\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "3.4.1 plus ancienne") && s.actions.empty(),
          "maj : URL d'une release plus ancienne refusée (étiquette lue)");
  cmd(s,
      "{\"req\":\"62\",\"action\":\"maj\",\"url\":\"https://pirate.example/"
      "fw.bin\",\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "hote non autorise"), "maj : URL hors des hôtes autorisés refusée");
  cmd(s,
      "{\"req\":\"63\",\"action\":\"maj\",\"url\":\"https://github.com/NoeMrct/terrarium_thermostat/releases/"
      "download/v10.0.0/terrarium-10.0.0-firmware.bin\",\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(!s.actions.empty() && contient(s.actions.back(), "maj https://github.com/"),
          "maj : URL GitHub d'une release plus récente acceptée");
  cmd(s, "{\"req\":\"64\",\"action\":\"maj\",\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "url ou version attendue"), "maj : sans cible");
  cmd(s, "{\"req\":\"65\",\"action\":\"maj\",\"version\":\"3.5.0\"}");
  VERIFIE(contient(s.derniere(), "jeton invalide"), "maj : exige le jeton");

  // --- mises à jour automatiques (F15) ---------------------------------------
  s.vider();
  cmd(s, "{\"req\":\"90\",\"action\":\"majauto\",\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "\"majAuto\":{\"actif\":true") && s.actions.empty(),
          "majauto : état, actives par défaut");
  cmd(s, "{\"req\":\"91\",\"action\":\"majauto\"}");
  VERIFIE(contient(s.derniere(), "jeton invalide"), "majauto : exige le jeton");
  cmd(s,
      "{\"req\":\"92\",\"action\":\"majauto\",\"op\":\"verifier\",\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(s.verifications == 1 && contient(s.derniere(), "\"verifications\":1"),
          "majauto verifier : lecture du manifeste demandée");
  cmd(s,
      "{\"req\":\"93\",\"action\":\"majauto\",\"op\":\"reporter\",\"jours\":7,\"jeton\":"
      "\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(s.majAuto.reporteeJusqua == s.maintenant + 7 * 86400u && s.majAutoSauves == 1 &&
              contient(s.derniere(), "\"ok\":true"),
          "majauto reporter 7 : report enregistré");
  cmd(s,
      "{\"req\":\"94\",\"action\":\"majauto\",\"op\":\"reporter\",\"jours\":31,\"jeton\":"
      "\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "0 (annuler) a 30") && s.majAuto.reporteeJusqua == s.maintenant + 7 * 86400u,
          "majauto reporter 31 : refusé, report inchangé");
  cmd(s,
      "{\"req\":\"95\",\"action\":\"majauto\",\"op\":\"reporter\",\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "0 (annuler) a 30"), "majauto reporter sans durée : refusé");
  cmd(s,
      "{\"req\":\"96\",\"action\":\"majauto\",\"op\":\"reporter\",\"jours\":0,\"jeton\":"
      "\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(s.majAuto.reporteeJusqua == 0, "majauto reporter 0 : report annulé");
  s.heure = false;
  cmd(s,
      "{\"req\":\"97\",\"action\":\"majauto\",\"op\":\"reporter\",\"jours\":3,\"jeton\":"
      "\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "heure inconnue") && s.majAuto.reporteeJusqua == 0,
          "majauto reporter sans heure fiable : refusé");
  s.heure = true;
  cmd(s,
      "{\"req\":\"98\",\"action\":\"majauto\",\"op\":\"installer\",\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "op : etat, verifier ou reporter"), "majauto : op inconnue refusée");
  cmd(s,
      "{\"req\":\"99\",\"action\":\"globaux\",\"majAuto\":false,\"majPlageDebut\":1320,\"majPlageFin\":120,"
      "\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(s.glob.majAutoCoupee && s.glob.majPlageDebut == 1320 && s.glob.majPlageFin == 120 &&
              contient(s.derniere(), "\"majAuto\":false"),
          "globaux : mises à jour automatiques coupées, plage 22:00-02:00");
  cmd(s,
      "{\"req\":\"100\",\"action\":\"globaux\",\"majPlageDebut\":120,\"jeton\":"
      "\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(contient(s.derniere(), "Plage de mise a jour vide") && s.glob.majPlageDebut == 1320,
          "globaux : plage vide refusée, rien de changé");
  cmd(s, "{\"req\":\"101\",\"action\":\"globaux\",\"majAuto\":true,\"jeton\":\"SIMULATIONTESTJETON00001\"}");
  VERIFIE(!s.glob.majAutoCoupee, "globaux : mises à jour automatiques réactivées");

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

  // --- protocole 4 : à distance, ce que la page locale savait faire (F1) ---
  {
    auto c = [&](const std::string &corps) {
      const std::string j = "{" + corps + ",\"jeton\":\"SIMULATIONTESTJETON00001\"}";
      cmd(s, j.c_str());
    };
    s.vider();
    c("\"req\":\"f1\",\"action\":\"sondes\",\"relire\":true");
    VERIFIE(contient(s.derniere(), "28FF0000000000A1") && s.actions.back() == "relire",
            "sondes : inventaire, bus relu sur demande");
    c("\"req\":\"f2\",\"action\":\"lier\",\"z\":1,\"rom\":\"28FF0000000000A1\"");
    VERIFIE(contient(s.derniere(), "\"ok\":true") && contient(s.derniere(), "liee a la zone 2"),
            "lier : une sonde présente se lie, message rendu");
    c("\"req\":\"f3\",\"action\":\"lier\",\"z\":5,\"rom\":\"28FF0000000000A1\"");
    VERIFIE(contient(s.derniere(), "zone invalide"), "lier : zone inexistante refusée");
    s.sondeAbsente = true;
    c("\"req\":\"f4\",\"action\":\"lier\",\"z\":0,\"rom\":\"28FF0000000000B2\"");
    VERIFIE(contient(s.derniere(), "\"ok\":false") && contient(s.derniere(), "absente"),
            "lier : sonde absente refusée avec la raison");
    s.sondeAbsente = false;
    c("\"req\":\"f5\",\"action\":\"identifier\",\"z\":0");
    c("\"req\":\"f6\",\"action\":\"stop-identifier\"");
    VERIFIE(s.actions.back() == "stop-identifier" && contient(s.reponses[s.reponses.size() - 2], "Serrez"),
            "identifier puis annuler");
    c("\"req\":\"f7\",\"action\":\"essai\",\"z\":1");
    VERIFIE(contient(s.derniere(), "Essai lance"), "essai : lancé sur une zone");
    c("\"req\":\"f8\",\"action\":\"essai\"");
    VERIFIE(contient(s.derniere(), "\"essai\":{"), "essai sans zone : où il en est");
    c("\"req\":\"f9\",\"action\":\"stop-essai\"");
    VERIFIE(s.actions.back() == "stop-essai", "essai arrêté");
    c("\"req\":\"f10\",\"action\":\"calibrer\"");
    VERIFIE(contient(s.derniere(), "decalee"), "calibrer");
    c("\"req\":\"f11\",\"action\":\"rapport\"");
    VERIFIE(contient(s.derniere(), "\"texte\":\"Rapport"), "rapport : texte lisible à distance");
    c("\"req\":\"f12\",\"action\":\"rapport\",\"envoyer\":true");
    VERIFIE(s.actions.back() == "envoyerRapport", "rapport : envoi immédiat");
    c("\"req\":\"f13\",\"action\":\"jours\",\"n\":5000");
    VERIFIE(contient(s.derniere(), "\"n\":400") && contient(s.derniere(), "\"depuis\":0"),
            "jours : nombre borné");
    c("\"req\":\"f13b\",\"action\":\"jours\",\"n\":30,\"depuis\":30");
    VERIFIE(contient(s.derniere(), "\"depuis\":30"), "jours : page suivante (depuis)");
    c("\"req\":\"f14\",\"action\":\"journal\"");
    VERIFIE(contient(s.derniere(), "Demarrage"), "journal : la fin du journal");
    c("\"req\":\"f15\",\"action\":\"sauvegarde\"");
    VERIFIE(contient(s.derniere(), "terrarium-sauvegarde"), "sauvegarde : export");
    c("\"req\":\"f16\",\"action\":\"restaurer\",\"sauvegarde\":{\"format\":\"terrarium-sauvegarde\","
      "\"zones\":[]}");
    VERIFIE(contient(s.derniere(), "restauree") &&
                contient(s.actions.back(), "\"format\":\"terrarium-sauvegarde\""),
            "restaurer : la sauvegarde passe telle quelle");
    c("\"req\":\"f17\",\"action\":\"restaurer\"");
    VERIFIE(contient(s.derniere(), "sauvegarde attendue"), "restaurer sans sauvegarde : refusé");
    c("\"req\":\"f18\",\"action\":\"reseau\",\"urlAlertes\":\"https://moi:cle@ntfy.sh:443/sujet-secret\","
      "\"heartbeatMinutes\":10,\"formatAlertes\":1");
    VERIFIE(contient(s.derniere(), "\"alertes\":\"ntfy.sh\"") && !contient(s.derniere(), "sujet-secret") &&
                !contient(s.derniere(), "cle") &&
                strcmp(s.res.urlAlertes, "https://moi:cle@ntfy.sh:443/sujet-secret") == 0 &&
                s.res.formatAlertes == 1 && s.res.heartbeatMinutes == 10,
            "reseau : alertes réglées, seul l'hôte de l'URL revient");
    c("\"req\":\"f18e\",\"action\":\"reseau\",\"essai\":true");
    VERIFIE(contient(s.derniere(), "\"essai\":true") && s.actions.back() == "alerteEssai",
            "reseau : une alerte de test part par l'adresse enregistrée (F18)");
    c("\"req\":\"f18b\",\"action\":\"reseau\",\"urlHeartbeat\":\"http://[2001:db8::1]:8080/ping/abc\"");
    VERIFIE(contient(s.derniere(), "\"heartbeat\":\"[2001:db8::1]\"") && !contient(s.derniere(), "abc"),
            "reseau : hôte IPv6 rendu sans le chemin");
    c("\"req\":\"f19\",\"action\":\"reseau\",\"urlAlertes\":\"ftp://x\"");
    VERIFIE(contient(s.derniere(), "valeur invalide") &&
                strcmp(s.res.urlAlertes, "https://moi:cle@ntfy.sh:443/sujet-secret") == 0,
            "reseau : URL non http(s) refusée sans rien changer");
    {
      char garde[sizeof s.res.urlAlertes];
      snprintf(garde, sizeof garde, "%s", s.res.urlAlertes);
      s.res.urlAlertes[0] = '\0';
      const size_t avant = s.actions.size();
      c("\"req\":\"f18f\",\"action\":\"reseau\",\"essai\":true");
      VERIFIE(contient(s.derniere(), "aucune adresse") && s.actions.size() == avant,
              "reseau : sans adresse d'alerte, l'essai est refusé");
      snprintf(s.res.urlAlertes, sizeof s.res.urlAlertes, "%s", garde);
    }
    c("\"req\":\"f20\",\"action\":\"reseau\",\"ssid2\":\"Secours\",\"wifiPass2\":\"motdepasse2\"");
    VERIFIE(contient(s.derniere(), "page locale") && s.res.ssid2[0] == '\0' && s.res.motDePasse2[0] == '\0',
            "reseau : aucun identifiant Wi-Fi ne passe par le broker");
    c("\"req\":\"f21\",\"action\":\"globaux\",\"prixKwh\":0.2516,\"ecranNuit\":2,\"zonePrioritaire\":1,"
      "\"soleilDecalageMin\":-30,\"ledEteinte\":true");
    VERIFIE(contient(s.derniere(), "\"ok\":true") && s.glob.ecranNuit == 2 && s.glob.zonePrioritaire == 1 &&
                s.glob.soleilDecalageMin == -30 && s.glob.ledEteinte,
            "globaux : réglages 3.5 à distance");
    c("\"req\":\"f22\",\"action\":\"globaux\",\"ecranNuit\":9");
    VERIFIE(contient(s.derniere(), "\"ok\":false") && s.glob.ecranNuit == 2,
            "globaux : mode d'écran inconnu refusé");
    cmd(s, "{\"req\":\"f23\",\"action\":\"journal\"}");
    VERIFIE(contient(s.derniere(), "jeton invalide"),
            "les actions du protocole 4 exigent le code (ou la signature)");

    // Plages horaires (F5).
    c("\"req\":\"p1\",\"action\":\"programme\"");
    VERIFIE(contient(s.derniere(),
                     "\"actif\":false,\"weekend\":false,\"semaine\":[{\"debut\":480,\"nom\":\"Jour\","
                     "\"consignes\":[32.0,28.0]},{\"debut\":1200,\"nom\":\"Nuit\"") &&
                s.programmesSauves == 0,
            "programme : lecture, jour et nuit des zones par défaut");
    c("\"req\":\"p2\",\"action\":\"programme\",\"actif\":true,\"semaine\":["
      "{\"debut\":480,\"nom\":\"Matin\",\"consignes\":[30,27]},{\"debut\":660,\"nom\":\"Pic de chaleur\","
      "\"consignes\":[34,28]},{\"debut\":960,\"nom\":\"Apr\u00e8s-midi\",\"consignes\":[32,28]},"
      "{\"debut\":1200,\"nom\":\"Nuit\",\"consignes\":[26,24]}]");
    VERIFIE(contient(s.derniere(), "\"ok\":true") && s.prog.actif && s.prog.nb[0] == 4 &&
                s.prog.plages[0][1].consigne[0] == 34.0f &&
                strcmp(s.prog.plages[0][2].nom, "Après-midi") == 0 && s.programmesSauves == 1 &&
                s.prog.nb[1] == 2,
            "programme : quatre plages en semaine, le week-end inchangé");
    c("\"req\":\"p3\",\"action\":\"programme\",\"semaine\":[{\"debut\":480,\"consignes\":[30,27]},"
      "{\"debut\":485,\"consignes\":[34,28]}]");
    VERIFIE(contient(s.derniere(), "15 min") && s.prog.nb[0] == 4 && s.programmesSauves == 1,
            "programme : débuts trop proches refusés, rien de changé");
    c("\"req\":\"p4\",\"action\":\"programme\",\"weekEnd\":[{\"debut\":540,\"consignes\":[41,27]}]");
    VERIFIE(contient(s.derniere(), "coupure") && s.programmesSauves == 1,
            "programme : consigne au-dessus de la coupure refusée");
    c("\"req\":\"p5\",\"action\":\"programme\",\"weekEnd\":[{\"debut\":540,\"consignes\":[31]}]");
    VERIFIE(contient(s.derniere(), "une consigne par zone"), "programme : une consigne par zone exigée");
    c("\"req\":\"p6\",\"action\":\"programme\",\"semaine\":[1,2,3,4,5]");
    VERIFIE(contient(s.derniere(), "de 1 a 4"), "programme : cinq plages refusées");
    c("\"req\":\"p7\",\"action\":\"programme\",\"weekend\":true,\"weekEnd\":[{\"debut\":540,"
      "\"nom\":\"Un nom bien trop long pour "
      "tenir\",\"consignes\":[31,27]},{\"debut\":1260,\"consignes\":[25,23]}]");
    VERIFIE(contient(s.derniere(), "\"ok\":true") && s.prog.weekend && s.prog.nb[1] == 2 &&
                strlen(s.prog.plages[1][0].nom) == sizeof s.prog.plages[1][0].nom - 1 &&
                contient(s.derniere(), "\"weekEnd\":[{\"debut\":540"),
            "programme : week-end distinct, nom trop long coupé");
    c("\"req\":\"p7b\",\"action\":\"programme\",\"semaine\":[{\"debut\":480,\"nom\":"
      "\"\u00e9\u00e9\u00e9\u00e9\u00e9"
      "\u00e9\u00e9\u00e9\u00e9\u00e9\",\"consignes\":[30,27]}]");
    VERIFIE(contient(s.derniere(), "\"ok\":true") && strlen(s.prog.plages[0][0].nom) == 16,
            "programme : un nom coupé ne coupe jamais un caractère en deux");
    c("\"req\":\"p8a\",\"action\":\"programme\",\"semaine\":[{\"debut\":480,\"consignes\":[36,27]}]");
    c("\"req\":\"p8\",\"action\":\"zone\",\"z\":0,\"max\":35");
    VERIFIE(contient(s.derniere(), "au-dessus de la coupure") && s.zones[0].tempMax == 40.0f,
            "zone : coupure abaissée sous une plage refusée");
    {
      Programme lu;
      programmeParDefaut(lu, s.zones);
      char e[100] = "", corps[1200];
      Protocole::corpsProgramme(s.prog, corps, sizeof corps);
      const std::string json = "{" + std::string(corps) + "}";
      VERIFIE(Protocole::lireProgramme(json.c_str(), json.size(), lu, e, sizeof e) && lu.actif &&
                  lu.weekend && lu.nb[0] == 1 && lu.nb[1] == 2 && lu.plages[1][1].debut == 1260 &&
                  programmeValide(lu, s.zones, e, sizeof e),
              "programme : relu tel qu'écrit (sauvegarde)");
      VERIFIE(!Protocole::lireProgramme("[", 1, lu, e, sizeof e) && contient(e, "illisible"),
              "programme : JSON illisible refusé");
      char petit[40];
      Protocole::corpsProgramme(s.prog, petit, sizeof petit);
      VERIFIE(strlen(petit) == sizeof petit - 1, "programme : sortie tronquée sans débordement");
    }
    c("\"req\":\"p9\",\"action\":\"programme\",\"actif\":false");
    VERIFIE(!s.prog.actif && contient(s.actions.back(), "coupees"), "programme : plages coupées");

    // Vacances, préchauffage, saisons (F6, F7, F9).
    c("\"req\":\"g1\",\"action\":\"globaux\",\"vacancesDebut\":1766102400,\"vacancesFin\":1767484800,"
      "\"vacancesDecalage\":-2,\"vacancesAlertes\":true,\"prechauffage\":true,\"saisonsActives\":true,"
      "\"hiverDebut\":1215,\"hiverFin\":215,\"hiverDecalage\":3,\"hiverRaccourciMin\":90,"
      "\"saisonTransitionJ\":21");
    VERIFIE(contient(s.derniere(), "\"ok\":true") && s.glob.vacancesDebut == 1766102400u &&
                s.glob.vacancesFin == 1767484800u && s.glob.vacancesDecalage == -2.0f &&
                s.glob.prechauffage && s.glob.saisonsActives && s.glob.hiverDebut == 1215 &&
                s.glob.hiverFin == 215 && s.glob.hiverDecalage == 3.0f && s.glob.hiverRaccourciMin == 90 &&
                s.glob.saisonTransitionJ == 21,
            "globaux : vacances, préchauffage et saisons à distance");
    c("\"req\":\"g2\",\"action\":\"globaux\",\"vacancesFin\":1766000000");
    VERIFIE(contient(s.derniere(), "retour") && s.glob.vacancesFin == 1767484800u,
            "globaux : retour avant le départ refusé");
    c("\"req\":\"g3\",\"action\":\"globaux\",\"vacancesDebut\":0,\"vacancesFin\":0");
    VERIFIE(contient(s.derniere(), "\"ok\":true") && s.glob.vacancesDebut == 0 && s.glob.vacancesFin == 0,
            "globaux : vacances annulées");
    c("\"req\":\"g4\",\"action\":\"globaux\",\"hiverDebut\":1340");
    VERIFIE(contient(s.derniere(), "MMJJ") && s.glob.hiverDebut == 1215,
            "globaux : date d'hiver invalide refusée");
  }

  // --- Accès support (V11) : une clé de session, donnée par le propriétaire.
  {
    Protocole::oublierReponses();
    SocleFactice s;
    const char *CLE = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const std::string ouvrir = std::string(
                                   "{\"req\":\"v1\",\"action\":\"service\",\"op\":\"ouvrir\",\"cle\":\"") +
                               CLE + "\",\"heures\":24,\"ts\":1760000000}";
    // Avant toute session, la clé ne signe rien.
    std::string e = signe("{\"req\":\"v0\",\"action\":\"reset\",\"ts\":1760000000}", CLE);
    cmd(s, e.c_str());
    VERIFIE(contient(s.derniere(), "signature invalide") && !Protocole::serviceActif(s),
            "service : sans session ouverte, la clé du support ne signe rien");
    cmd(s, signe(ouvrir).c_str());
    VERIFIE(contient(s.derniere(), "\"ok\":true") && contient(s.derniere(), "\"actif\":true") &&
                contient(s.derniere(), "\"jusqua\":1760086400") && strcmp(s.session.cle, CLE) == 0 &&
                s.servicesSauves == 1 && Protocole::serviceActif(s),
            "service : le propriétaire ouvre 24 h (signé avec le code), la session est gardée");
    e = signe("{\"req\":\"v2\",\"action\":\"reset\",\"ts\":1760000000}", CLE);
    s.vider();
    cmd(s, e.c_str());
    bool journalSupport = false, reset = false;
    for (const std::string &a : s.actions) {
      if (a == "journal Support : reset") journalSupport = true;
      if (a == "leverDefauts") reset = true;
    }
    VERIFIE(contient(s.derniere(), "\"ok\":true") && reset && journalSupport,
            "service : la clé signe une action, notée « Support : » au journal du socle");
    s.vider();
    cmd(s, signe("{\"req\":\"v2b\",\"action\":\"etat\",\"ts\":1760000000}", CLE).c_str());
    bool rienAuJournal = true;
    for (const std::string &a : s.actions)
      if (a.rfind("journal", 0) == 0) rienAuJournal = false;
    VERIFIE(contient(s.derniere(), "\"ok\":true") && rienAuJournal,
            "service : une lecture du support n'entre pas au journal");
    const std::string autre =
        std::string("{\"req\":\"v3\",\"action\":\"service\",\"op\":\"ouvrir\",\"cle\":\"") +
        "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210" + "\",\"ts\":1760000000}";
    cmd(s, signe(autre, CLE).c_str());
    VERIFIE(contient(s.derniere(), "seul le proprietaire") && strcmp(s.session.cle, CLE) == 0,
            "service : le support ne s'ouvre pas une autre session");
    cmd(s,
        signe("{\"req\":\"v4\",\"action\":\"service\",\"op\":\"prolonger\",\"heures\":72,\"ts\":1760000000}",
              CLE)
            .c_str());
    VERIFIE(contient(s.derniere(), "\"ok\":true") && s.session.jusqua == 1760000000u + 72u * 3600u &&
                contient(s.derniere(), "\"par\":\"support\""),
            "service : le support prolonge (72 h)");
    cmd(s,
        signe("{\"req\":\"v5\",\"action\":\"service\",\"op\":\"prolonger\",\"heures\":168,\"ts\":1760000000}",
              CLE)
            .c_str());
    s.maintenant = 1760000000u + 6u * 86400u;
    cmd(s,
        signe("{\"req\":\"v6\",\"action\":\"service\",\"op\":\"prolonger\",\"heures\":168,\"ts\":1760518400}",
              CLE)
            .c_str());
    VERIFIE(
        contient(s.derniere(), "\"ok\":true") && s.session.jusqua == 1760000000u + Protocole::SERVICE_MAX_S,
        "service : jamais plus de 7 jours après l'ouverture");
    s.maintenant = 1760000000u + Protocole::SERVICE_MAX_S;
    cmd(s, signe("{\"req\":\"v7\",\"action\":\"reset\",\"ts\":1760604800}", CLE).c_str());
    VERIFIE(contient(s.derniere(), "signature invalide") && !Protocole::serviceActif(s),
            "service : à l'échéance, la clé ne signe plus rien");
    s.maintenant = 1760000000u;
    cmd(s, signe(ouvrir).c_str());
    s.heure = false;
    cmd(s, signe("{\"req\":\"v8\",\"action\":\"reset\",\"ts\":1760000000}", CLE).c_str());
    VERIFIE(contient(s.derniere(), "signature invalide"),
            "service : sans heure fiable, rien du support n'est accepté");
    cmd(s, signe("{\"req\":\"v9\",\"action\":\"service\",\"op\":\"ouvrir\",\"cle\":"
                 "\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\",\"ts\":1760000000}")
               .c_str());
    VERIFIE(contient(s.derniere(), "heure inconnue"), "service : pas d'ouverture sans heure fiable");
    s.heure = true;
    cmd(s,
        signe("{\"req\":\"v10\",\"action\":\"service\",\"op\":\"ouvrir\",\"cle\":\"ABC\",\"ts\":1760000000}")
            .c_str());
    VERIFIE(contient(s.derniere(), "64 caracteres"), "service : clé mal formée refusée");
    cmd(s, signe("{\"req\":\"v11\",\"action\":\"service\",\"op\":\"ouvrir\",\"cle\":"
                 "\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\",\"heures\":500,\"ts\":"
                 "1760000000}")
               .c_str());
    VERIFIE(contient(s.derniere(), "1 a 168 h"), "service : durée bornée à 168 h");
    s.vider();
    cmd(s,
        signe("{\"req\":\"v12\",\"action\":\"service\",\"op\":\"fermer\",\"ts\":1760000000}", CLE).c_str());
    bool fermeParSupport = false;
    for (const std::string &a : s.actions)
      if (a == "journal Acces support ferme par le support") fermeParSupport = true;
    VERIFIE(contient(s.derniere(), "\"actif\":false") && s.session.cle[0] == '\0' && fermeParSupport,
            "service : le support ferme, le journal le dit");
    cmd(s, signe("{\"req\":\"v13\",\"action\":\"reset\",\"ts\":1760000000}", CLE).c_str());
    VERIFIE(contient(s.derniere(), "signature invalide"), "service : fermée, la clé ne vaut plus");
    cmd(s, signe(ouvrir).c_str());
    cmd(s, signe("{\"req\":\"v14\",\"action\":\"service\",\"op\":\"fermer\",\"ts\":1760000000}").c_str());
    VERIFIE(contient(s.derniere(), "\"par\":\"proprietaire\"") && !Protocole::serviceActif(s),
            "service : le propriétaire ferme à tout moment");
    cmd(s, "{\"req\":\"v15\",\"action\":\"service\"}");
    VERIFIE(contient(s.derniere(), "jeton invalide"), "service : l'état lui-même exige une signature");
    cmd(s, signe("{\"req\":\"v16\",\"action\":\"service\",\"op\":\"pirater\",\"ts\":1760000000}").c_str());
    VERIFIE(contient(s.derniere(), "op :"), "service : opération inconnue refusée");
  }

  printf("\n=== %s : %d/%d ===\n", g_echecs ? "ECHEC" : "CANAL DE COMMANDE OK", g_total - g_echecs, g_total);
  return g_echecs ? 1 : 0;
}
