#include "protocole.h"
#include "format.h"
#include "signature.h"
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

// Commande intérieure d'une enveloppe signée (protocole 4), relue à part : la
// chaîne `c` appartient au document qu'on réutilise. Assez grande pour une
// sauvegarde complète à restaurer (action « restaurer »).
char g_interieur[4096];
// Au-delà de cet écart avec l'heure du socle, une commande signée est périmée :
// c'est ce qui borne le rejeu d'une commande captée sur le broker.
const uint32_t ECART_MAX_S = 300;

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

// Réponse d'une action qui rend un message : « message » si elle a réussi,
// « erreur » sinon.
void resultat(Socle &socle, const char *req, bool ok, const char *texte) {
  char esc[300];
  formatEchapperJson(texte, esc, sizeof esc);
  char corps[340];
  snprintf(corps, sizeof corps, "\"%s\":\"%s\"", ok ? "message" : "erreur", esc);
  repondre(socle, req, ok, corps);
}

// Copie bornée d'un champ texte de la requête ; faux s'il ne tient pas.
bool copierTexte(char *dest, size_t taille, const char *src) {
  if (strlen(src) >= taille) return false;
  memcpy(dest, src, strlen(src) + 1);
  return true;
}

bool urlPlausible(const char *u) { return !u[0] || !strncmp(u, "https://", 8) || !strncmp(u, "http://", 7); }

// Hôte d'une URL d'alerte, seul relu à distance : le chemin d'une URL ntfy ou
// healthchecks est le secret, et des identifiants peuvent précéder « @ ».
void hoteUrl(const char *url, char *out, size_t taille) {
  out[0] = '\0';
  if (!url[0] || taille < 2) return;
  const char *d = strstr(url, "://");
  d = d ? d + 3 : url;
  const char *const f = d + strcspn(d, "/?#");  // fin de l'autorité
  for (const char *c = d; c < f; c++)
    if (*c == '@') d = c + 1;  // identifiants : jamais relus
  size_t n = d[0] == '[' ? strcspn(d, "]") + 1 : strcspn(d, ":/?#");
  if (n > (size_t)(f - d)) n = (size_t)(f - d);
  if (n == 0) {
    snprintf(out, taille, "%s", "definie");
    return;
  }
  if (n > taille - 1) n = taille - 1;
  memcpy(out, d, n);
  out[n] = '\0';
}

char g_tampon[4096];  // sauvegarde à restaurer, resérialisée

void erreur(Socle &socle, const char *req, const char *texte) {
  char esc[160];
  formatEchapperJson(texte, esc, sizeof esc);
  char corps[200];
  snprintf(corps, sizeof corps, "\"erreur\":\"%s\"", esc);
  repondre(socle, req, false, corps);
}

bool zoneValide(int z) { return z >= 0 && z < (int)NB_ZONES; }

// Réglages globaux, lus et écrits. Sans champ, c'est une simple lecture ;
// l'action reste protégée par le jeton, puisqu'elle peut décider de la
// puissance appelée.
void traiterGlobaux(Socle &socle, JsonDocument &doc, const char *req) {
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
  // 3.5, à distance depuis le protocole 4 : prix, position, soleil, écran,
  // LED, rapport, zone prioritaire. globauxValides() garde les bornes.
  CHAMP("prixKwh", prixKwh, float)
  CHAMP("latitude", latitude, float)
  CHAMP("longitude", longitude, float)
  CHAMP("rapportActif", rapportActif, bool)
  CHAMP("ledEteinte", ledEteinte, bool)
  CHAMP("soleilActif", soleilActif, bool)
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
  CHAMP16("rapportMinutes", rapportMinutes)
#undef CHAMP16
#define CHAMP8(cle, membre)                                  \
  if (doc[cle].is<int>()) {                                  \
    const long v = doc[cle].as<long>();                      \
    n.membre = (uint8_t)(v < 0 ? 255 : (v > 255 ? 255 : v)); \
    ecriture = true;                                         \
  }
  CHAMP8("ecranNuit", ecranNuit)
  CHAMP8("zonePrioritaire", zonePrioritaire)
#undef CHAMP8
  if (doc["soleilDecalageMin"].is<int>()) {
    const long v = doc["soleilDecalageMin"].as<long>();
    n.soleilDecalageMin = (int16_t)(v < -720 ? -720 : (v > 720 ? 720 : v));
    ecriture = true;
  }

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
}

// Réseau à distance : la surveillance seulement (alertes, heartbeat). Aucun
// identifiant Wi-Fi ne passe par le broker : le réseau principal et celui de
// secours se règlent sur la page locale. Les URL s'écrivent mais ne se relisent
// pas : seul leur hôte revient.
void traiterReseau(Socle &socle, JsonDocument &doc, const char *req) {
  if (!doc["ssid"].isNull() || !doc["ssid2"].isNull() || !doc["wifiPass"].isNull() ||
      !doc["wifiPass2"].isNull()) {
    erreur(socle, req, "Wi-Fi : a regler sur la page locale du socle");
    return;
  }
  ReglagesReseau n = socle.reseau();
  bool ecriture = false, ok = true;
  // n est une copie : rien n'est gardé si un seul champ est refusé.
  if (doc["urlAlertes"].is<const char *>()) {
    if (!urlPlausible(doc["urlAlertes"]) ||
        !copierTexte(n.urlAlertes, sizeof n.urlAlertes, doc["urlAlertes"]))
      ok = false;
    ecriture = true;
  }
  if (doc["urlHeartbeat"].is<const char *>()) {
    if (!urlPlausible(doc["urlHeartbeat"]) ||
        !copierTexte(n.urlHeartbeat, sizeof n.urlHeartbeat, doc["urlHeartbeat"]))
      ok = false;
    ecriture = true;
  }
  if (doc["heartbeatMinutes"].is<int>()) {
    const long m = doc["heartbeatMinutes"].as<long>();
    if (m >= 1 && m <= 1440)
      n.heartbeatMinutes = (uint16_t)m;
    else
      ok = false;
    ecriture = true;
  }
  if (doc["formatAlertes"].is<int>()) {
    const long f = doc["formatAlertes"].as<long>();
    if (f == 0 || f == 1)
      n.formatAlertes = (uint8_t)f;
    else
      ok = false;
    ecriture = true;
  }
  if (!ok) {
    erreur(socle, req, "reseau : valeur invalide (URL http(s)://, 1-1440 min, format 0 ou 1)");
    return;
  }
  if (ecriture) {
    socle.reseau() = n;
    socle.sauverReseau();
    socle.journal("Surveillance (alertes, heartbeat) modifiee via le canal de commande");
  }
  char s1[70], s2[70], ha[70], hh[70], ea[80], eh[80];
  formatEchapperJson(n.ssid, s1, sizeof s1);
  formatEchapperJson(n.ssid2, s2, sizeof s2);
  hoteUrl(n.urlAlertes, ha, sizeof ha);
  hoteUrl(n.urlHeartbeat, hh, sizeof hh);
  formatEchapperJson(ha, ea, sizeof ea);
  formatEchapperJson(hh, eh, sizeof eh);
  snprintf(g_corps, sizeof g_corps,
           "\"ssid\":\"%s\",\"ssid2\":\"%s\",\"alertes\":\"%s\",\"heartbeat\":\"%s\","
           "\"heartbeatMinutes\":%u,\"formatAlertes\":%u",
           s1, s2, ea, eh, (unsigned)n.heartbeatMinutes, (unsigned)n.formatAlertes);
  repondre(socle, req, true, g_corps);
}

// Protocole 4 (F1) : sondes, essai, calibration, rapport, journal, résumés
// journaliers, sauvegarde et surveillance. Faux si l'action n'est pas de ce
// groupe.
bool traiterDistant(Socle &socle, JsonDocument &doc, const char *req, const char *action) {
  char message[200];
  const int z = doc["z"] | -1;
  if (strcmp(action, "sondes") == 0) {
    socle.corpsSondes(doc["relire"].as<bool>(), g_corps, sizeof g_corps);
    repondre(socle, req, true, g_corps);
    return true;
  }
  if (strcmp(action, "lier") == 0 || strcmp(action, "identifier") == 0 || strcmp(action, "essai") == 0) {
    if (strcmp(action, "essai") == 0 && doc["z"].isNull()) {  // sans zone : où en est l'essai
      socle.corpsEssai(g_corps, sizeof g_corps);
      repondre(socle, req, true, g_corps);
      return true;
    }
    if (!zoneValide(z)) {
      erreur(socle, req, "zone invalide");
      return true;
    }
    bool ok;
    if (strcmp(action, "lier") == 0)
      ok = socle.lierSonde((uint8_t)z, doc["rom"] | "", message, sizeof message);
    else if (strcmp(action, "identifier") == 0)
      ok = socle.identifierSonde((uint8_t)z, message, sizeof message);
    else
      ok = socle.lancerEssai((uint8_t)z, message, sizeof message);
    resultat(socle, req, ok, message);
    return true;
  }
  if (strcmp(action, "stop-identifier") == 0 || strcmp(action, "stop-essai") == 0) {
    if (action[5] == 'i')
      socle.annulerIdentification();
    else
      socle.annulerEssai();
    resultat(socle, req, true, action[5] == 'i' ? "Identification annulee" : "Essai arrete");
    return true;
  }
  if (strcmp(action, "calibrer") == 0) {
    const bool ok = socle.calibrer(message, sizeof message);
    resultat(socle, req, ok, message);
    return true;
  }
  if (strcmp(action, "rapport") == 0) {
    if (doc["envoyer"].as<bool>()) {
      socle.envoyerRapport();
      resultat(socle, req, true, "Rapport envoye vers les alertes");
      return true;
    }
    socle.corpsRapport(g_corps, sizeof g_corps);
    repondre(socle, req, true, g_corps);
    return true;
  }
  if (strcmp(action, "jours") == 0) {
    const long n = doc["n"] | 7L;  // autant que le message en tient (une trentaine)
    socle.corpsJours((uint16_t)(n < 1 ? 1 : (n > 400 ? 400 : n)), g_corps, sizeof g_corps);
    repondre(socle, req, true, g_corps);
    return true;
  }
  if (strcmp(action, "journal") == 0) {
    socle.corpsJournal(g_corps, sizeof g_corps);
    repondre(socle, req, true, g_corps);
    return true;
  }
  if (strcmp(action, "sauvegarde") == 0) {
    socle.corpsSauvegarde(g_corps, sizeof g_corps);
    repondre(socle, req, true, g_corps);
    return true;
  }
  if (strcmp(action, "restaurer") == 0) {
    if (!doc["sauvegarde"].is<JsonObject>()) {
      erreur(socle, req, "sauvegarde attendue");
      return true;
    }
    const size_t n = serializeJson(doc["sauvegarde"], g_tampon, sizeof g_tampon);
    if (n == 0 || n >= sizeof g_tampon - 1) {
      erreur(socle, req, "sauvegarde trop grande");
      return true;
    }
    const bool ok = socle.restaurer(g_tampon, n, message, sizeof message);
    resultat(socle, req, ok, message);
    return true;
  }
  if (strcmp(action, "reseau") == 0) {
    traiterReseau(socle, doc, req);
    return true;
  }
  return false;
}

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
  // L'analyseur de clang prend le placement new de VariantData::toObject
  // (ArduinoJson 7.4.2) pour une fuite et rattache le diagnostic à cet appel :
  // faux positif connu, le document libère tout dans son destructeur.
  // NOLINTNEXTLINE(clang-analyzer-cplusplus.NewDeleteLeaks)
  if (!charge || deserializeJson(doc, charge, taille) || !doc.is<JsonObject>()) {
    repondre(socle, "", false, "\"erreur\":\"JSON invalide\"");
    return;
  }

  // Protocole 4 : {"c":"<commande JSON>","sig":"<HMAC-SHA256 hexadécimal>"},
  // signée avec le code d'appairage, qui ne circule donc plus. La commande en
  // clair avec "jeton" reste acceptée (applications d'avant le protocole 4).
  bool signee = false;
  if (doc["c"].is<const char *>()) {
    const char *c = doc["c"];
    const size_t n = strlen(c);
    const bool valide = n < sizeof g_interieur && Signature::verifier(socle.jeton(), c, n, doc["sig"] | "");
    if (n < sizeof g_interieur) memcpy(g_interieur, c, n + 1);
    // Relue même refusée : la réponse d'erreur porte alors le bon "req", et
    // l'application l'affiche au lieu d'attendre en vain.
    const bool lisible = n < sizeof g_interieur && !deserializeJson(doc, g_interieur, n) &&
                         doc.is<JsonObject>();
    if (!valide) {
      repondre(socle, lisible ? (doc["req"] | "") : "", false, "\"erreur\":\"signature invalide\"");
      socle.journal("Commande MQTT refusee : signature invalide");
      return;
    }
    if (!lisible) {
      repondre(socle, "", false, "\"erreur\":\"JSON invalide\"");
      return;
    }
    const uint32_t ts = doc["ts"].as<uint32_t>(), maintenant = socle.epoch();
    const uint32_t ecart = ts > maintenant ? ts - maintenant : maintenant - ts;
    if (socle.heureFiable() && ecart > ECART_MAX_S) {
      repondre(socle, doc["req"] | "", false, "\"erreur\":\"commande perimee (heure du telephone ?)\"");
      socle.journal("Commande MQTT refusee : signee mais perimee");
      return;
    }
    signee = true;
  }

  const char *req = doc["req"] | "";
  const char *action = doc["action"] | "";
  const char *jeton = doc["jeton"] | "";

  if (rejouerSiConnue(socle, req)) return;  // doublon livré par le broker

  if (!actionLectureSeule(action) && !signee && !memeJeton(jeton, socle.jeton())) {
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

  if (strcmp(action, "globaux") == 0) {
    traiterGlobaux(socle, doc, req);
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

  if (traiterDistant(socle, doc, req, action)) return;

  erreur(socle, req, "action inconnue");
}

}  // namespace Protocole
