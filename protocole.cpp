#include "protocole.h"
#include "format.h"
#include <ArduinoJson.h>
#include <stdio.h>
#include <string.h>

namespace Protocole {

namespace {

// L'application envoie ses commandes en QoS 1 : sur une liaison hachée, le
// broker peut livrer deux fois la même. Les dernières réponses courtes sont
// gardées en mémoire : une requête déjà vue reçoit la même réponse sans être
// rejouée — un « redemarrer » ne redémarre pas deux fois, un « autotune » ne
// se voit pas refuser sa propre relance.
struct ReponseRecente {
  char req[24];
  bool ok;
  char corps[160];
};
ReponseRecente g_recentes[8];
uint8_t g_recenteSuivante = 0;

char g_corps[TAILLE_CORPS];
char g_reponse[TAILLE_REPONSE];

void emettre(Socle &socle, const char *req, bool ok, const char *corps) {
  char reqEsc[64];
  formatEchapperJson(req, reqEsc, sizeof reqEsc);
  snprintf(g_reponse, sizeof g_reponse, "{\"req\":\"%s\",\"ok\":%s%s%s}", reqEsc, ok ? "true" : "false",
           corps[0] ? "," : "", corps);
  socle.repondre(g_reponse);
}

void repondre(Socle &socle, const char *req, bool ok, const char *corps) {
  emettre(socle, req, ok, corps);
  const size_t lr = strlen(req), lc = strlen(corps);
  if (lr && lr < sizeof g_recentes[0].req && lc < sizeof g_recentes[0].corps) {
    ReponseRecente &r = g_recentes[g_recenteSuivante];
    g_recenteSuivante = (uint8_t)((g_recenteSuivante + 1) % (sizeof g_recentes / sizeof g_recentes[0]));
    snprintf(r.req, sizeof r.req, "%s", req);
    snprintf(r.corps, sizeof r.corps, "%s", corps);
    r.ok = ok;
  }
}

bool rejouerSiConnue(Socle &socle, const char *req) {
  if (!req[0]) return false;
  for (const ReponseRecente &r : g_recentes) {
    if (r.req[0] && strcmp(req, r.req) == 0) {
      emettre(socle, req, r.ok, r.corps);
      return true;
    }
  }
  return false;
}

// Comparaison à durée constante : une comparaison qui s'arrête au premier
// octet différent laisse deviner le secret octet par octet.
bool memeJeton(const char *a, const char *b) {
  const size_t la = strlen(a), lb = strlen(b);
  uint8_t diff = (uint8_t)(la != lb);
  for (size_t i = 0; i < la && i < lb; i++) diff |= (uint8_t)(a[i] ^ b[i]);
  return diff == 0;
}

void erreur(Socle &socle, const char *req, const char *texte) {
  char esc[160];
  formatEchapperJson(texte, esc, sizeof esc);
  char corps[200];
  snprintf(corps, sizeof corps, "\"erreur\":\"%s\"", esc);
  repondre(socle, req, false, corps);
}

bool zoneValide(int z) { return z >= 0 && z < (int)NB_ZONES; }

}  // namespace

bool actionLectureSeule(const char *action) {
  return strcmp(action, "etat") == 0 || strcmp(action, "stats") == 0 || strcmp(action, "version") == 0 ||
         strcmp(action, "historique") == 0;
}

void oublierReponses() {
  memset(g_recentes, 0, sizeof g_recentes);
  g_recenteSuivante = 0;
}

void traiterCommande(Socle &socle, const char *charge, size_t taille) {
  JsonDocument doc;
  if (!charge || deserializeJson(doc, charge, taille) || !doc.is<JsonObject>()) {
    repondre(socle, "", false, "\"erreur\":\"JSON invalide\"");
    return;
  }

  const char *req = doc["req"] | "";
  const char *action = doc["action"] | "";
  const char *jeton = doc["jeton"] | "";

  if (rejouerSiConnue(socle, req)) return;  // doublon livré par le broker

  if (!actionLectureSeule(action) && !memeJeton(jeton, socle.jeton())) {
    repondre(socle, req, false, "\"erreur\":\"jeton invalide\"");
    char t[80];
    snprintf(t, sizeof t, "Commande MQTT refusee : jeton invalide (%.24s)", action);
    socle.journal(t);
    return;
  }

  if (strcmp(action, "version") == 0) {
    socle.corpsVersion(g_corps, sizeof g_corps);
    repondre(socle, req, true, g_corps);
    return;
  }

  if (strcmp(action, "etat") == 0) {
    socle.corpsEtat(g_corps, sizeof g_corps);
    repondre(socle, req, true, g_corps);
    return;
  }

  if (strcmp(action, "zone") == 0) {
    const int z = doc["z"] | -1;
    if (!zoneValide(z)) {
      erreur(socle, req, "zone invalide");
      return;
    }
    ReglagesZone n = socle.zone((uint8_t)z);
    if (doc["nom"].is<const char *>()) snprintf(n.nom, sizeof n.nom, "%s", doc["nom"].as<const char *>());
    if (doc["jour"].is<float>()) n.consigneJour = doc["jour"];
    if (doc["nuit"].is<float>()) n.consigneNuit = doc["nuit"];
    if (doc["bande"].is<float>()) n.bande = doc["bande"];
    if (doc["ki"].is<float>()) n.ki = doc["ki"];
    if (doc["max"].is<float>()) n.tempMax = doc["max"];
    if (doc["offset"].is<float>()) n.offset = doc["offset"];
    if (doc["rampe"].is<int>())
      n.rampeMinutes = (uint16_t)(doc["rampe"].as<int>() < 0 ? 0 : doc["rampe"].as<int>());
    if (doc["debutJour"].is<int>())
      n.debutJour = (uint16_t)(doc["debutJour"].as<int>() < 0 ? 0 : doc["debutJour"].as<int>());
    if (doc["debutNuit"].is<int>())
      n.debutNuit = (uint16_t)(doc["debutNuit"].as<int>() < 0 ? 0 : doc["debutNuit"].as<int>());
    // Les diagnostics se règlent aussi de loin : ce sont eux qui décident
    // quand une alerte part, et leur bon réglage dépend du terrarium.
    if (doc["deriveSeuil"].is<float>()) n.deriveSeuil = doc["deriveSeuil"];
    if (doc["deriveMin"].is<int>())
      n.deriveMinutes = (uint16_t)(doc["deriveMin"].as<int>() < 0 ? 0 : doc["deriveMin"].as<int>());
    if (doc["inefficaceMin"].is<int>())
      n.inefficaceMinutes = (uint16_t)(doc["inefficaceMin"].as<int>() < 0 ? 0
                                                                          : doc["inefficaceMin"].as<int>());
    if (doc["inefficaceDelta"].is<float>()) n.inefficaceDelta = doc["inefficaceDelta"];
    if (doc["chuteSeuil"].is<float>()) n.chuteSeuil = doc["chuteSeuil"];
    if (doc["chuteSecondes"].is<int>())
      n.chuteSecondes = (uint16_t)(doc["chuteSecondes"].as<int>() < 0 ? 0 : doc["chuteSecondes"].as<int>());
    char err[100];
    // Mêmes règles que partout ailleurs : la validation vit dans le cœur de
    // régulation, elle n'est pas réécrite pour chaque interface.
    if (!reglagesValides(n, err, sizeof err)) {
      erreur(socle, req, err);
      return;
    }
    socle.zone((uint8_t)z) = n;
    socle.sauverZone((uint8_t)z);
    repondre(socle, req, true, "");
    return;
  }

  if (strcmp(action, "stats") == 0) {
    socle.corpsStats(g_corps, sizeof g_corps);
    repondre(socle, req, true, g_corps);
    return;
  }

  if (strcmp(action, "historique") == 0) {
    long heures = doc["heures"] | 24L;
    if (heures <= 0 || heures > 400) heures = 24;
    long maxi = doc["max"] | 120L;
    if (maxi <= 0 || maxi > 200) maxi = 120;
    socle.corpsHistorique((uint32_t)heures, (uint16_t)maxi, g_corps, sizeof g_corps);
    repondre(socle, req, true, g_corps);
    return;
  }

  if (strcmp(action, "stop-autotune") == 0) {
    const int z = doc["z"] | -1;
    if (!zoneValide(z)) {
      erreur(socle, req, "zone invalide");
      return;
    }
    socle.arreterAutotune((uint8_t)z);
    repondre(socle, req, true, "");
    return;
  }

  if (strcmp(action, "effacer-historique") == 0) {
    socle.effacerHistorique();
    socle.journal("Historique efface via le canal de commande");
    repondre(socle, req, true, "");
    return;
  }

  // Lecture et écriture des réglages globaux. Sans champ, c'est une simple
  // lecture ; l'action reste protégée par le jeton, puisqu'elle peut décider
  // de la puissance appelée.
  if (strcmp(action, "globaux") == 0) {
    ReglagesGlobaux n = socle.globaux();
    bool ecriture = false;
#define CHAMP(cle, membre, type)    \
  if (doc[cle].is<type>()) {        \
    n.membre = doc[cle].as<type>(); \
    ecriture = true;                \
  }
    CHAMP("amperes", courantAlimA, float)
    CHAMP("watts", puissanceTapisW, float)
    CHAMP("volts", tensionV, float)
    CHAMP("saisonDelta", saisonDelta, float)
#undef CHAMP
#define CHAMP16(cle, membre)                                    \
  if (doc[cle].is<int>()) {                                     \
    const long v = doc[cle].as<long>();                         \
    n.membre = (uint16_t)(v < 0 ? 0 : (v > 65535 ? 65535 : v)); \
    ecriture = true;                                            \
  }
    CHAMP16("entretienMin", maintenanceMin)
    CHAMP16("ecranVeilleMin", ecranVeilleMin)
    CHAMP16("saisonDescenteJ", saisonDescenteJ)
    CHAMP16("saisonPlateauJ", saisonPlateauJ)
    CHAMP16("saisonRemonteeJ", saisonRemonteeJ)
#undef CHAMP16

    if (doc["saisonActive"].is<bool>()) {
      const bool actif = doc["saisonActive"];
      if (actif && !socle.heureFiable()) {
        erreur(socle, req, "heure inconnue : cycle saisonnier indatable");
        return;
      }
      if (actif && !n.saisonActive) n.saisonDebutEpoch = socle.epoch();
      n.saisonActive = actif;
      ecriture = true;
    }

    if (ecriture) {
      char err[100];
      if (!Stockage::globauxValides(n, err, sizeof err)) {
        erreur(socle, req, err);
        return;
      }
      socle.globaux() = n;
      socle.sauverGlobaux();
      socle.journal("Reglages globaux modifies via le canal de commande");
    }
    socle.corpsGlobaux(g_corps, sizeof g_corps);
    repondre(socle, req, true, g_corps);
    return;
  }

  if (strcmp(action, "reset") == 0) {
    socle.leverDefauts();
    socle.journal("Defauts leves via le canal de commande");
    repondre(socle, req, true, "");
    return;
  }

  if (strcmp(action, "entretien") == 0) {
    const long minutes = doc["minutes"] | (long)socle.globaux().maintenanceMin;
    if (minutes < 0 || minutes > 240) {
      erreur(socle, req, "duree hors 0-240 min");
      return;
    }
    socle.entretien((uint16_t)minutes);
    repondre(socle, req, true, "");
    return;
  }

  if (strcmp(action, "autotune") == 0) {
    const int z = doc["z"] | -1;
    char err[80] = "";
    if (!zoneValide(z) || !socle.lancerAutotune((uint8_t)z, err, sizeof err)) {
      erreur(socle, req, err[0] ? err : "zone invalide");
      return;
    }
    repondre(socle, req, true, "");
    return;
  }

  if (strcmp(action, "alim") == 0) {
    ReglagesGlobaux &g = socle.globaux();
    const float a = doc["amperes"] | g.courantAlimA;
    if (!(a >= 0.5f && a <= 40.0f)) {
      erreur(socle, req, "amperage hors 0.5-40 A");
      return;
    }
    ReglagesGlobaux n = g;
    n.courantAlimA = a;
    if (doc["watts"].is<float>()) n.puissanceTapisW = doc["watts"];
    char err[100];
    if (!Stockage::globauxValides(n, err, sizeof err)) {
      erreur(socle, req, err);
      return;
    }
    g = n;
    socle.sauverGlobaux();
    char corps[48];
    snprintf(corps, sizeof corps, "\"zonesSimultanees\":%u", (unsigned)socle.limiteZones());
    repondre(socle, req, true, corps);
    return;
  }

  if (strcmp(action, "redemarrer") == 0) {
    repondre(socle, req, true, "");
    socle.redemarrer();
    return;
  }

  // Mise à jour tirée : {"action":"maj","version":"3.4.0"} ou {"url":"https://…"}.
  // La réponse part tout de suite ; la progression suit sur le sujet « maj »,
  // puis le socle redémarre et « sante » raconte la suite.
  if (strcmp(action, "maj") == 0) {
    const char *url = doc["url"] | "";
    const char *version = doc["version"] | "";
    const bool forcer = doc["forcer"].as<bool>();  // absent : false
    if (!url[0] && !version[0]) {
      erreur(socle, req, "url ou version attendue");
      return;
    }
    char err[96];
    if (!socle.majAcceptable(url, version, forcer, err, sizeof err)) {
      erreur(socle, req, err);
      return;
    }
    repondre(socle, req, true, "\"maj\":\"telechargement\"");
    socle.lancerMaj(url[0] ? url : version);  // ne revient qu'en cas de refus
    return;
  }

  erreur(socle, req, "action inconnue");
}

}  // namespace Protocole
