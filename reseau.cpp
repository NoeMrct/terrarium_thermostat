#include "reseau.h"
#include "stockage.h"
#include "page_web.h"
#include "sondes.h"
#include "format.h"

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WebServer.h>
#include <HTTPClient.h>
#include <ArduinoOTA.h>
#include <Update.h>
#include <ESPmDNS.h>
#include <PubSubClient.h>
#include <time.h>
#include <mbedtls/sha256.h>
#include <mbedtls/base64.h>
#include <ArduinoJson.h>

// Magasin d'autorités de certification fourni par le paquet ESP32.
extern const uint8_t rootca_crt_bundle_start[] asm("_binary_x509_crt_bundle_start");
extern const uint8_t rootca_crt_bundle_end[]   asm("_binary_x509_crt_bundle_end");

namespace {

WebServer        serveur(80);
WiFiClient       clientMqttClair;
WiFiClientSecure clientMqttTls;
PubSubClient     mqtt(clientMqttClair);

bool     g_connecte = false, g_ap = false, g_servicesLances = false, g_haPublie = false;
bool     g_otaLancee = false;
uint8_t  g_echecsAuth = 0;
uint32_t g_blocageAuth = 0;
uint32_t g_dernierEssai = 0, g_debutConnexion = 0, g_dernierHeartbeat = 0;
uint32_t g_dernierMqtt = 0, g_dernierEssaiMqtt = 0;
String   g_id;

// Anti-répétition des alertes : une même nature d'alerte sur une même zone
// n'est renvoyée qu'après ANTISPAM_MS.
// Une case par type : avec un simple « type % 8 », NOTIF_INFO (valeur 8)
// retombait sur la case de NOTIF_DEFAUT — les messages d'entretien étaient
// étouffés pendant 30 min après un défaut, et ils repoussaient au passage
// l'horodatage de ce dernier.
const uint8_t NB_TYPES_NOTIF = (uint8_t)NOTIF_INFO + 1;
uint32_t g_derniereAlerte[NB_ZONES + 1][NB_TYPES_NOTIF] = { { 0 } };

// Temporisation des envois : sans elle, un serveur d'alertes injoignable était
// réessayé à chaque tour de boucle, avec 4 s de délai d'attente à chaque fois —
// la régulation tombait à un cycle toutes les 4 s tant que la panne durait.
uint8_t  g_echecsAlerte    = 0;
uint32_t g_prochaineAlerte = 0;
// Drapeau explicite plutôt qu'une comparaison à une date jamais remise à jour :
// après 24,8 jours de fonctionnement sans échec, (int32_t)(millis() - 0) devient
// négatif et la file d'alertes serait restée bloquée pour toujours.
bool     g_attenteAlerte   = false;
const uint8_t MAX_ECHECS_ALERTE = 8;

bool texteEnRom(const String &s, uint8_t rom[8]) {
  if (s.length() != 16) return false;
  for (uint8_t i = 0; i < 8; i++) {
    char h[3] = { s[i * 2], s[i * 2 + 1], 0 };
    char *fin = nullptr;
    const long v = strtol(h, &fin, 16);
    if (fin != h + 2) return false;
    rom[i] = (uint8_t)v;
  }
  return true;
}

// --------------------------- authentification -------------------------------
// Les requêtes qui modifient quelque chose doivent porter un entête maison. Un
// navigateur ne l'ajoute pas sur une requête déclenchée depuis un autre site
// sans passer par un contrôle préalable, qui échoue ici : cela suffit à écarter
// les requêtes forgées depuis une page tierce. Pour un appel manuel :
//   curl -X POST -H 'X-Terrarium: 1' http://terrarium.local/api/reset
bool origineSure() {
  if (serveur.hasHeader("X-Terrarium")) return true;
  serveur.send(403, "text/plain", "Requete refusee : entete X-Terrarium manquant");
  return false;
}

// Le mot de passe n'est jamais stocké en clair : seule son empreinte SHA-256
// l'est. Quelqu'un qui lirait la mémoire flash n'y trouverait rien de
// réutilisable ailleurs.
String hacher(const String &texte) {
  uint8_t sortie[32];
  mbedtls_sha256_context ctx;
  mbedtls_sha256_init(&ctx);
  mbedtls_sha256_starts(&ctx, 0);
  mbedtls_sha256_update(&ctx, (const unsigned char *)texte.c_str(), texte.length());
  mbedtls_sha256_finish(&ctx, sortie);
  mbedtls_sha256_free(&ctx);
  char hex[65];
  for (int i = 0; i < 32; i++) snprintf(hex + i * 2, 3, "%02x", sortie[i]);
  hex[64] = '\0';
  return String(hex);
}

// Comparaison à durée constante : une comparaison qui s'arrête au premier
// octet différent laisse deviner le secret octet par octet.
bool memeEmpreinte(const char *a, const char *b) {
  if (strlen(a) != 64 || strlen(b) != 64) return false;
  uint8_t diff = 0;
  for (int i = 0; i < 64; i++) diff |= (uint8_t)(a[i] ^ b[i]);
  return diff == 0;
}

enum VerdictAuth : uint8_t { AUTH_OK = 0, AUTH_REFUSE, AUTH_EN_PAUSE };

// Vérifie les identifiants SANS rien émettre. Séparé de autorise() parce que le
// téléversement d'une mise à jour doit pouvoir se prononcer dès le premier
// fragment, alors qu'émettre une réponse au milieu d'un envoi en cours
// couperait la connexion avant que le navigateur ait fini de parler.
VerdictAuth verdictAuth() {
  const ReglagesReseau &r = Stockage::reseau();
  if (r.webUtilisateur[0] == '\0' || r.webHachage[0] == '\0') return AUTH_OK;  // accès libre assumé

  // Après cinq échecs, une minute de pause : sans cela un mot de passe court
  // se retrouve par force brute en quelques minutes sur un réseau local.
  const uint32_t maintenant = millis();
  if (g_blocageAuth != 0) {
    if ((int32_t)(maintenant - g_blocageAuth) < 0) return AUTH_EN_PAUSE;
    // Remis a zero une fois la pause ecoulee : laisser une date figee aurait
    // rendu la comparaison a nouveau negative apres 24,8 jours de service, et
    // reintroduit des blocages d'une minute sans aucune tentative ratee.
    g_blocageAuth = 0;
  }

  const String entete = serveur.header("Authorization");
  if (entete.startsWith("Basic ")) {
    const String b64 = entete.substring(6);
    unsigned char clair[96];
    size_t taille = 0;
    if (mbedtls_base64_decode(clair, sizeof clair - 1, &taille,
                              (const unsigned char *)b64.c_str(), b64.length()) == 0) {
      clair[taille] = '\0';
      if (memeEmpreinte(hacher(String((char *)clair)).c_str(), r.webHachage)) {
        g_echecsAuth = 0;
        return AUTH_OK;
      }
    }
    if (++g_echecsAuth >= 5) {
      g_blocageAuth = maintenant + 60000UL;
      g_echecsAuth = 0;
      journal("Interface web : trop de tentatives d'authentification, pause d'une minute");
    }
  }
  return AUTH_REFUSE;
}

bool autorise() {
  switch (verdictAuth()) {
    case AUTH_OK: return true;
    case AUTH_EN_PAUSE:
      serveur.send(429, "text/plain", "Trop de tentatives, reessayez dans une minute");
      return false;
    default:
      serveur.sendHeader("WWW-Authenticate", "Basic realm=\"Terrarium\"");
      serveur.send(401, "text/plain", "Authentification requise");
      return false;
  }
}

// Ces trois fonctions ne sont que l'habillage String des primitives testées sur
// PC (format.h) : la logique délicate — échappement JSON, analyse d'horaire —
// vit à un seul endroit, exercée par sim/test-format.cpp.
String hhmm(uint16_t minutes) {
  char b[8];
  formatHHMM(minutes, b, sizeof b);
  return String(b);
}

bool parseHHMM(const String &s, uint16_t &out) {
  return formatParseHHMM(s.c_str(), out);
}

String echapperJson(const char *s) {
  // Le plus long champ échappable est une URL (161 octets) : deux fois cela
  // couvre le pire cas, où chaque octet devrait être préfixé.
  char b[336];
  formatEchapperJson(s, b, sizeof b);
  return String(b);
}

// --------------------------- routes ----------------------------------------
void routeRacine() {
  if (!autorise()) return;
  serveur.send_P(200, "text/html; charset=utf-8", PAGE_HTML);
}

void routeStatus() {
  if (!autorise()) return;
  String j;
  j.reserve(1400);                       // évite une dizaine de réallocations
  j += "{\"uptime\":" + String(millis() / 1000) +
             ",\"tapisActif\":" + String(ctrl.tapisActif()) +
             ",\"alertesEnAttente\":" + String(Stockage::alertesEnAttente()) +
             ",\"histHeures\":" + String(Stockage::histCapacite() / 60) +
             ",\"version\":\"" FW_VERSION "\"" +
             ",\"otaProtegee\":" + String(Stockage::reseau().otaMotDePasse[0] ? "true" : "false") +
             ",\"maintenanceS\":" + String(ctrl.maintenanceRestanteMs(millis()) / 1000) +
             ",\"heure\":\"" + (heureFiable() ? horodatage() + (heureApproximative() ? " (approx.)" : "")
                                              : String("heure inconnue")) + "\",\"zones\":[";
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    const ZoneEtat &s = ctrl.zone[z];
    const ReglagesZone &c = ctrl.cfg[z];
    if (z) j += ",";
    j += "{\"nom\":\"" + echapperJson(c.nom) + "\"";
    j += ",\"temp\":" + String(isnan(s.temperature) ? 0.0f : s.temperature, 2);
    j += ",\"consigne\":" + String(isnan(s.consigneEff) ? c.consigneJour : s.consigneEff, 2);
    j += ",\"demande\":" + String((int)lroundf(s.demande * 100));
    j += ",\"duty\":" + String((int)lroundf(ctrl.duty(z)));
    j += ",\"chauffe\":" + String((ctrl.tapisActif() >= 0 && ZONE_DE_TAPIS[ctrl.tapisActif()] == z) ? "true" : "false");
    j += ",\"derive\":" + String(s.deriveActive ? "true" : "false");
    j += ",\"autotune\":" + String((s.autotune == AT_ATTENTE || s.autotune == AT_OSCILLE) ? "true" : "false");
    j += ",\"defaut\":" + (s.defaut == DEF_AUCUN ? String("null") : "\"" + String(nomDefaut(s.defaut)) + "\"");
    j += ",\"jour\":" + String(c.consigneJour, 1) + ",\"nuit\":" + String(c.consigneNuit, 1);
    j += ",\"bande\":" + String(c.bande, 2) + ",\"ki\":" + String(c.ki, 5);
    j += ",\"max\":" + String(c.tempMax, 1) + ",\"offset\":" + String(c.offset, 2);
    j += ",\"debutJour\":\"" + hhmm(c.debutJour) + "\",\"debutNuit\":\"" + hhmm(c.debutNuit) + "\"";
    j += ",\"rampe\":" + String(c.rampeMinutes);
    j += ",\"inefficaceMin\":" + String(c.inefficaceMinutes) + ",\"inefficaceDelta\":" + String(c.inefficaceDelta, 2);
    j += ",\"deriveSeuil\":" + String(c.deriveSeuil, 1) + ",\"deriveMin\":" + String(c.deriveMinutes);
    j += ",\"chuteSeuil\":" + String(c.chuteSeuil, 1) + ",\"chuteSecondes\":" + String(c.chuteSecondes) + "}";
  }
  j += "]}";
  serveur.send(200, "application/json", j);
}

// Historique diffusé par morceaux : construire la réponse entière en RAM
// saturerait le tas dès quelques heures de données. Le parcours garde le
// fichier ouvert du début à la fin.
struct CtxHist { String bloc; bool premier; bool csv; };

bool visiteJson(const Echantillon &e, void *ctx) {
  CtxHist *c = (CtxHist *)ctx;
  if (e.epoch == 0) return true;      // point enregistré sans horloge : il
                                      // casserait l'axe temporel du graphique
  if (!c->premier) c->bloc += ",";
  c->premier = false;
  c->bloc += "{\"e\":" + String(e.epoch);
  c->bloc += ",\"t0\":" + String(e.t[0] == -32768 ? -999.0f : e.t[0] / 100.0f, 2);
  c->bloc += ",\"t1\":" + String(e.t[1] == -32768 ? -999.0f : e.t[1] / 100.0f, 2);
  c->bloc += ",\"c0\":" + String(e.c[0] == -32768 ? -999.0f : e.c[0] / 100.0f, 2);
  c->bloc += ",\"c1\":" + String(e.c[1] == -32768 ? -999.0f : e.c[1] / 100.0f, 2) + "}";
  if (c->bloc.length() > 1200) { serveur.sendContent(c->bloc); c->bloc = ""; }
  return true;
}

bool visiteCsv(const Echantillon &e, void *ctx) {
  CtxHist *c = (CtxHist *)ctx;
  char date[24] = "";
  if (e.epoch) {
    const time_t tt = (time_t)e.epoch;
    struct tm tm;
    localtime_r(&tt, &tm);
    strftime(date, sizeof date, "%Y-%m-%d %H:%M:%S", &tm);
  }
  c->bloc += String(e.epoch) + "," + date;
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    c->bloc += ",";
    if (e.t[z] != -32768) c->bloc += String(e.t[z] / 100.0f, 2);
    c->bloc += ",";
    if (e.c[z] != -32768) c->bloc += String(e.c[z] / 100.0f, 2);
    c->bloc += "," + String(e.d[z]);
  }
  c->bloc += "\n";
  if (c->bloc.length() > 1200) { serveur.sendContent(c->bloc); c->bloc = ""; }
  return true;
}

void routeHistory() {
  if (!autorise()) return;
  uint32_t heures = serveur.hasArg("heures") ? (uint32_t)serveur.arg("heures").toInt() : 24;
  if (heures == 0 || heures > 400) heures = 24;
  const uint32_t total = Stockage::histNombre();
  const uint32_t voulus = heures * 60;
  const uint32_t debut = (total > voulus) ? total - voulus : 0;
  const uint32_t dispo = total - debut;
  const uint32_t pas = (dispo > 900) ? (dispo / 900) : 1;   // ~900 points à l'écran

  serveur.setContentLength(CONTENT_LENGTH_UNKNOWN);
  serveur.send(200, "application/json", "");
  serveur.sendContent("{\"points\":[");
  CtxHist c; c.premier = true; c.csv = false; c.bloc.reserve(1500);
  Stockage::histParcourir(debut, pas, visiteJson, &c);
  c.bloc += "]}";
  serveur.sendContent(c.bloc);
  serveur.sendContent("");
}

void routeHistoryCsv() {
  if (!autorise()) return;
  serveur.setContentLength(CONTENT_LENGTH_UNKNOWN);
  serveur.sendHeader("Content-Disposition", "attachment; filename=terrarium.csv");
  serveur.send(200, "text/csv", "");
  serveur.sendContent("epoch,date,zone1_temp,zone1_consigne,zone1_demande,zone2_temp,zone2_consigne,zone2_demande\n");
  CtxHist c; c.premier = true; c.csv = true; c.bloc.reserve(1500);
  Stockage::histParcourir(0, 1, visiteCsv, &c);
  serveur.sendContent(c.bloc);
  serveur.sendContent("");
}

// Statistiques sur 24 h, calculées à la volée depuis l'historique : min, max,
// moyenne et temps passé hors de la plage visée. C'est ce qui permet de juger
// si un terrarium tient réellement ses valeurs, plutôt qu'un instantané.
struct Stats24 {
  float mini[NB_ZONES], maxi[NB_ZONES], somme[NB_ZONES];
  uint32_t n[NB_ZONES], horsPlage[NB_ZONES];
};

bool visiteStats(const Echantillon &e, void *ctx) {
  Stats24 *s = (Stats24 *)ctx;
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    if (e.t[z] == -32768) continue;
    const float t = e.t[z] / 100.0f;
    if (s->n[z] == 0 || t < s->mini[z]) s->mini[z] = t;
    if (s->n[z] == 0 || t > s->maxi[z]) s->maxi[z] = t;
    s->somme[z] += t;
    s->n[z]++;
    if (e.c[z] != -32768 && fabsf(t - e.c[z] / 100.0f) > 1.0f) s->horsPlage[z]++;
  }
  return true;
}

// Le même corps sert l'interface web et le canal de commande : une application
// distante doit voir exactement les mêmes chiffres que la page locale, sinon
// c'est un deuxième calcul à maintenir — et à faire diverger.
String corpsStats() {
  Stats24 st;
  memset(&st, 0, sizeof st);
  const uint32_t total = Stockage::histNombre();
  const uint32_t debut = (total > 1440) ? total - 1440 : 0;
  Stockage::histParcourir(debut, 1, visiteStats, &st);

  const ReglagesGlobaux &g = Stockage::globaux();
  String j;
  j.reserve(900);
  j += "\"version\":\"" FW_VERSION "\",\"compile\":\"" FW_BUILD "\"";
  j += ",\"zonesSimultanees\":" + String(ctrl.limiteZones());
  j += ",\"saison\":" + String(ctrl.decalageSaison(), 2);
  j += ",\"maintenanceRestanteS\":" + String(ctrl.maintenanceRestanteMs(millis()) / 1000);
  j += ",\"zones\":[";
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    if (z) j += ",";
    const uint32_t sec = secondesChauffeTotales(z);
    const float kwh = sec / 3600.0f * g.puissanceTapisW / 1000.0f;
    j += "{\"nom\":\"" + echapperJson(ctrl.cfg[z].nom) + "\"";
    if (st.n[z]) {
      j += ",\"min\":" + String(st.mini[z], 2) + ",\"max\":" + String(st.maxi[z], 2);
      j += ",\"moyenne\":" + String(st.somme[z] / st.n[z], 2);
      j += ",\"horsPlagePct\":" + String((int)lroundf(100.0f * st.horsPlage[z] / st.n[z]));
      j += ",\"points\":" + String(st.n[z]);
    } else {
      j += ",\"points\":0";
    }
    j += ",\"heuresChauffe\":" + String(sec / 3600.0f, 1);
    j += ",\"kWh\":" + String(kwh, 3);
    j += ",\"defauts\":{\"sonde\":" + String(ctrl.zone[z].nbDefauts[DEF_SONDE]) +
         ",\"surchauffe\":" + String(ctrl.zone[z].nbDefauts[DEF_SURCHAUFFE]) +
         ",\"figee\":" + String(ctrl.zone[z].nbDefauts[DEF_FIGE]) + "}}";
  }
  j += "]";
  return j;
}

void routeStats() {
  if (!autorise()) return;
  serveur.send(200, "application/json", "{" + corpsStats() + "}");
}

// Historique compacté pour le canal MQTT : un tableau de tableaux
// [epoch, t1, consigne1, t2, consigne2] en centièmes de degré, `null` pour une
// mesure absente. Une clé par point aurait triplé la taille, et le tampon d'un
// message MQTT n'est pas extensible comme une réponse HTTP diffusée par
// morceaux — c'est pour cela que ce format diffère de /api/history.
struct CtxHistMqtt { String bloc; uint16_t n; uint16_t maxi; size_t limite; };

bool visiteHistMqtt(const Echantillon &e, void *ctx) {
  CtxHistMqtt *c = (CtxHistMqtt *)ctx;
  if (e.epoch == 0) return true;                 // point sans horloge : inexploitable
  if (c->n >= c->maxi || c->bloc.length() >= c->limite) return false;
  if (c->n) c->bloc += ",";
  c->bloc += "[" + String(e.epoch);
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    c->bloc += ",";
    c->bloc += (e.t[z] == -32768) ? String("null") : String(e.t[z]);
    c->bloc += ",";
    c->bloc += (e.c[z] == -32768) ? String("null") : String(e.c[z]);
  }
  c->bloc += "]";
  c->n++;
  return true;
}

void routeGlobauxGet() {
  if (!autorise()) return;
  const ReglagesGlobaux &g = Stockage::globaux();
  String j = "{";
  j += "\"courantAlimA\":" + String(g.courantAlimA, 1);
  j += ",\"puissanceTapisW\":" + String(g.puissanceTapisW, 0);
  j += ",\"tensionV\":" + String(g.tensionV, 1);
  j += ",\"zonesSimultanees\":" + String(ctrl.limiteZones());
  j += ",\"maintenanceMin\":" + String(g.maintenanceMin);
  j += ",\"ecranVeilleMin\":" + String(g.ecranVeilleMin);
  j += ",\"saisonActive\":" + String(g.saisonActive ? "true" : "false");
  j += ",\"saisonDelta\":" + String(g.saisonDelta, 1);
  j += ",\"saisonDescenteJ\":" + String(g.saisonDescenteJ);
  j += ",\"saisonPlateauJ\":" + String(g.saisonPlateauJ);
  j += ",\"saisonRemonteeJ\":" + String(g.saisonRemonteeJ);
  j += ",\"saisonDebutEpoch\":" + String(g.saisonDebutEpoch);
  j += ",\"decalageActuel\":" + String(ctrl.decalageSaison(), 2);
  j += ",\"heureFiable\":" + String(heureFiable() ? "true" : "false") + "}";
  serveur.send(200, "application/json", j);
}

void routeGlobauxPost() {
  if (!autorise()) return;
  if (!origineSure()) return;

  // On travaille sur une copie : un seul champ hors bornes ne doit pas laisser
  // les autres a moitie appliques.
  ReglagesGlobaux n = Stockage::globaux();
  if (serveur.hasArg("courantAlimA"))    n.courantAlimA    = serveur.arg("courantAlimA").toFloat();
  if (serveur.hasArg("puissanceTapisW")) n.puissanceTapisW = serveur.arg("puissanceTapisW").toFloat();
  if (serveur.hasArg("tensionV"))        n.tensionV        = serveur.arg("tensionV").toFloat();
  if (serveur.hasArg("maintenanceMin"))  n.maintenanceMin  = (uint16_t)serveur.arg("maintenanceMin").toInt();
  if (serveur.hasArg("ecranVeilleMin"))  n.ecranVeilleMin  = (uint16_t)serveur.arg("ecranVeilleMin").toInt();
  if (serveur.hasArg("saisonDelta"))     n.saisonDelta     = serveur.arg("saisonDelta").toFloat();
  if (serveur.hasArg("saisonDescenteJ")) n.saisonDescenteJ = (uint16_t)serveur.arg("saisonDescenteJ").toInt();
  if (serveur.hasArg("saisonPlateauJ"))  n.saisonPlateauJ  = (uint16_t)serveur.arg("saisonPlateauJ").toInt();
  if (serveur.hasArg("saisonRemonteeJ")) n.saisonRemonteeJ = (uint16_t)serveur.arg("saisonRemonteeJ").toInt();

  char erreur[100];
  if (!Stockage::globauxValides(n, erreur, sizeof erreur)) {
    serveur.send(400, "text/plain", erreur); return;
  }

  // Le cyclage saisonnier a besoin d'une date de depart : sans horloge fiable,
  // il n'y a aucun moyen de savoir ou l'on en est dans le cycle.
  if (serveur.hasArg("saisonActive")) {
    const bool actif = serveur.arg("saisonActive").toInt() != 0;
    if (actif && !heureFiable()) {
      serveur.send(409, "text/plain",
                   "Heure inconnue : impossible de dater le debut du cycle saisonnier"); return;
    }
    if (actif && !n.saisonActive) n.saisonDebutEpoch = (uint32_t)time(nullptr);
    n.saisonActive = actif;
  }
  if (serveur.hasArg("saisonRedemarrer") && serveur.arg("saisonRedemarrer").toInt() != 0) {
    if (!heureFiable()) { serveur.send(409, "text/plain", "Heure inconnue"); return; }
    n.saisonDebutEpoch = (uint32_t)time(nullptr);
  }

  Stockage::globaux() = n;
  Stockage::sauverGlobaux();
  appliquerReglagesGlobaux();
  journal("Reglages globaux modifies via l'interface web : %.1f A -> %u zone(s), saison %s",
          n.courantAlimA, ctrl.limiteZones(), n.saisonActive ? "active" : "inactive");
  serveur.send(200, "text/plain",
               "Enregistre : " + String(ctrl.limiteZones()) + " zone(s) simultanee(s).");
}

void routeHistoryDelete() {
  if (!autorise()) return;
  if (!origineSure()) return;
  Stockage::histEffacer();
  journal("Historique efface via l'interface web");
  serveur.send(200, "text/plain", "Historique efface");
}

void routeRedemarrer() {
  if (!autorise()) return;
  if (!origineSure()) return;
  journal("Redemarrage demande via l'interface web");
  serveur.send(200, "text/plain", "Redemarrage en cours, la page reviendra dans ~15 s.");
  delay(300);
  ESP.restart();
}

// Mise à jour du firmware par le navigateur : un simple envoi de fichier .bin,
// sans espota ni IDE. Le mot de passe OTA ne s'applique pas ici — c'est
// l'authentification de l'interface web qui protège la route, exactement comme
// /api/reseau, qui permet déjà de changer ce mot de passe et de redémarrer.
char g_majErreur[80] = "";
bool g_majAutorisee = false;

void routeMajFin() {
  if (!g_majAutorisee) {
    serveur.sendHeader("WWW-Authenticate", "Basic realm=\"Terrarium\"");
    serveur.send(401, "text/plain", g_majErreur[0] ? g_majErreur : "Authentification requise");
    return;
  }
  if (Update.hasError() || g_majErreur[0]) {
    otaEnCours = false; ctrl.suspendre(false);
    journal("Mise a jour par le navigateur en echec : %s",
            g_majErreur[0] ? g_majErreur : "ecriture refusee");
    serveur.send(500, "text/plain",
                 String("Mise a jour refusee : ") + (g_majErreur[0] ? g_majErreur : "ecriture refusee"));
    return;
  }
  journal("Mise a jour par le navigateur ecrite, redemarrage");
  serveur.send(200, "text/plain", "Mise a jour ecrite. Redemarrage, la page reviendra dans ~20 s.");
  delay(400);
  ESP.restart();
}

void routeMajFragment() {
  HTTPUpload &u = serveur.upload();

  if (u.status == UPLOAD_FILE_START) {
    g_majAutorisee = false;
    g_majErreur[0] = '\0';
    const VerdictAuth v = verdictAuth();
    if (v == AUTH_EN_PAUSE) { snprintf(g_majErreur, sizeof g_majErreur, "Trop de tentatives"); return; }
    if (v != AUTH_OK)       { snprintf(g_majErreur, sizeof g_majErreur, "Authentification requise"); return; }
    if (!serveur.hasHeader("X-Terrarium")) {
      snprintf(g_majErreur, sizeof g_majErreur, "Entete X-Terrarium manquant"); return;
    }
    g_majAutorisee = true;

    // Le chauffage est coupé pendant toute l'écriture : une mise à jour
    // interrompue laisserait sinon un tapis alimenté sans régulation derrière.
    otaEnCours = true;
    ctrl.suspendre(true);
    journal("Mise a jour par le navigateur : reception de %s", u.filename.c_str());
    if (!Update.begin(UPDATE_SIZE_UNKNOWN)) {
      snprintf(g_majErreur, sizeof g_majErreur, "%s", Update.errorString());
      otaEnCours = false; ctrl.suspendre(false);
    }
    return;
  }

  if (!g_majAutorisee || g_majErreur[0]) return;

  if (u.status == UPLOAD_FILE_WRITE) {
    // Écrire un mégaoctet prend plusieurs secondes : sans cela le chien de garde
    // redémarrerait la carte au milieu de la mise à jour.
    esp_task_wdt_reset();
    if (Update.write(u.buf, u.currentSize) != u.currentSize)
      snprintf(g_majErreur, sizeof g_majErreur, "%s", Update.errorString());
  } else if (u.status == UPLOAD_FILE_END) {
    if (!Update.end(true)) snprintf(g_majErreur, sizeof g_majErreur, "%s", Update.errorString());
  } else if (u.status == UPLOAD_FILE_ABORTED) {
    Update.abort();
    snprintf(g_majErreur, sizeof g_majErreur, "Envoi interrompu");
    otaEnCours = false; ctrl.suspendre(false);
  }
}

void routeMaintenance() {
  if (!autorise()) return;
  if (!origineSure()) return;
  const uint16_t minutes = serveur.hasArg("minutes")
                             ? (uint16_t)serveur.arg("minutes").toInt()
                             : Stockage::globaux().maintenanceMin;
  if (minutes > 240) { serveur.send(400, "text/plain", "Duree limitee a 240 min"); return; }
  ctrl.maintenance(millis(), minutes);
  serveur.send(200, "text/plain", minutes ? "Chauffage coupe temporairement" : "Maintenance annulee");
}

void routeConfig() {
  if (!autorise()) return;
  if (!origineSure()) return;
  const int z = serveur.arg("z").toInt();
  if (z < 0 || z >= (int)NB_ZONES) { serveur.send(400, "text/plain", "Zone invalide"); return; }

  ReglagesZone n = ctrl.cfg[z];
  if (serveur.hasArg("nom") && serveur.arg("nom").length() > 0)
    snprintf(n.nom, sizeof n.nom, "%s", serveur.arg("nom").c_str());
  if (serveur.hasArg("jour"))            n.consigneJour = serveur.arg("jour").toFloat();
  if (serveur.hasArg("nuit"))            n.consigneNuit = serveur.arg("nuit").toFloat();
  if (serveur.hasArg("bande"))           n.bande = serveur.arg("bande").toFloat();
  if (serveur.hasArg("ki"))              n.ki = serveur.arg("ki").toFloat();
  if (serveur.hasArg("max"))             n.tempMax = serveur.arg("max").toFloat();
  if (serveur.hasArg("offset"))          n.offset = serveur.arg("offset").toFloat();
  if (serveur.hasArg("rampe"))           n.rampeMinutes = (uint16_t)serveur.arg("rampe").toInt();
  if (serveur.hasArg("inefficaceMin"))   n.inefficaceMinutes = (uint16_t)serveur.arg("inefficaceMin").toInt();
  if (serveur.hasArg("inefficaceDelta")) n.inefficaceDelta = serveur.arg("inefficaceDelta").toFloat();
  if (serveur.hasArg("deriveSeuil"))     n.deriveSeuil = serveur.arg("deriveSeuil").toFloat();
  if (serveur.hasArg("deriveMin"))       n.deriveMinutes = (uint16_t)serveur.arg("deriveMin").toInt();
  if (serveur.hasArg("chuteSeuil"))      n.chuteSeuil = serveur.arg("chuteSeuil").toFloat();
  if (serveur.hasArg("chuteSecondes"))   n.chuteSecondes = (uint16_t)serveur.arg("chuteSecondes").toInt();
  if (serveur.hasArg("debutJour") && !parseHHMM(serveur.arg("debutJour"), n.debutJour)) {
    serveur.send(400, "text/plain", "Debut de jour invalide (HH:MM)"); return;
  }
  if (serveur.hasArg("debutNuit") && !parseHHMM(serveur.arg("debutNuit"), n.debutNuit)) {
    serveur.send(400, "text/plain", "Debut de nuit invalide (HH:MM)"); return;
  }

  // Mêmes règles que partout ailleurs : la validation vit dans le cœur de
  // régulation, pas dupliquée dans chaque interface.
  char erreur[100];
  if (!reglagesValides(n, erreur, sizeof erreur)) { serveur.send(400, "text/plain", erreur); return; }

  ctrl.cfg[z] = n;
  Stockage::sauverZone((uint8_t)z, n);
  journal("Reglages zone %d modifies via l'interface web", z + 1);
  serveur.send(200, "text/plain", "Reglages enregistres");
}

void routeReset() {
  if (!autorise()) return;
  if (!origineSure()) return;
  ctrl.leverDefauts(millis());
  uint8_t d[NB_ZONES] = { DEF_AUCUN, DEF_AUCUN };
  Stockage::sauverDefauts(d);
  journal("Defauts leves via l'interface web");
  serveur.send(200, "text/plain", "Defauts leves");
}

void routeAutotune() {
  if (!autorise()) return;
  if (!origineSure()) return;
  const int z = serveur.arg("z").toInt();
  char erreur[80] = "";
  if (z < 0 || z >= (int)NB_ZONES) { serveur.send(400, "text/plain", "Zone invalide"); return; }
  if (!ctrl.lancerAutotune((uint8_t)z, millis(), erreur, sizeof erreur)) {
    serveur.send(409, "text/plain", erreur); return;
  }
  serveur.send(200, "text/plain", "Autotune lance : la zone va osciller volontairement pendant ~1 h.");
}

void routeAutotuneStop() {
  if (!autorise()) return;
  if (!origineSure()) return;
  const int z = serveur.arg("z").toInt();
  if (z < 0 || z >= (int)NB_ZONES) { serveur.send(400, "text/plain", "Zone invalide"); return; }
  ctrl.arreterAutotune((uint8_t)z);
  serveur.send(200, "text/plain", "Autotune interrompu, regulation normale reprise.");
}

void routeSondesGet() {
  if (!autorise()) return;
  serveur.send(200, "application/json", Sondes::inventaireJson());
}

void routeSondesPost() {
  if (!autorise()) return;
  if (!origineSure()) return;
  uint8_t rom[8];
  const int z = serveur.arg("z").toInt();
  if (z < 0 || z >= (int)NB_ZONES || !texteEnRom(serveur.arg("rom"), rom)) {
    serveur.send(400, "text/plain", "Parametres invalides"); return;
  }
  memcpy(Stockage::reseau().sondeRom[z], rom, 8);
  Stockage::sauverReseau();
  Sondes::rechargerLiaisons();
  journal("Sonde %s liee a la zone %d", serveur.arg("rom").c_str(), z + 1);
  serveur.send(200, "text/plain", "Sonde liee a la zone");
}

void routeReseauGet() {
  if (!autorise()) return;
  const ReglagesReseau &r = Stockage::reseau();
  String j = "{";
  j += "\"ssid\":\"" + echapperJson(r.ssid) + "\"";
  j += ",\"webUtilisateur\":\"" + echapperJson(r.webUtilisateur) + "\"";
  j += ",\"urlAlertes\":\"" + echapperJson(r.urlAlertes) + "\"";
  j += ",\"urlHeartbeat\":\"" + echapperJson(r.urlHeartbeat) + "\"";
  j += ",\"heartbeatMinutes\":" + String(r.heartbeatMinutes);
  j += ",\"mqttHote\":\"" + echapperJson(r.mqttHote) + "\"";
  j += ",\"mqttPort\":" + String(r.mqttPort);
  j += ",\"mqttPrefixe\":\"" + echapperJson(r.mqttPrefixe) + "\"";
  j += ",\"mqttUtilisateur\":\"" + echapperJson(r.mqttUtilisateur) + "\"";
  j += ",\"decouverteHA\":" + String(r.decouverteHA ? "true" : "false");
  j += ",\"mqttTls\":" + String(r.mqttTls ? "true" : "false");
  j += ",\"verifierTls\":" + String(r.verifierTls ? "true" : "false");
  j += ",\"jeton\":\"" + echapperJson(r.jeton) + "\"";
  j += ",\"appareil\":\"" + g_id + "\"";
  // Le jeton d'alerte est un secret : on ne dit que s'il est renseigné.
  j += ",\"alerteJetonDefini\":" + String(r.alerteJeton[0] ? "true" : "false");
  j += ",\"otaProtegee\":" + String(r.otaMotDePasse[0] ? "true" : "false");
  j += ",\"otaActive\":" + String(g_otaLancee ? "true" : "false");
  j += ",\"fuseau\":\"" + echapperJson(r.fuseau) + "\"";
  j += ",\"ntp\":\"" + echapperJson(r.ntp) + "\"}";
  serveur.send(200, "application/json", j);
}

void routeReseauPost() {
  if (!autorise()) return;
  if (!origineSure()) return;
  ReglagesReseau &r = Stockage::reseau();
  // Le parametre s'appelle `cle` et non `arg` : `arg` serait aussi substitue
  // dans `serveur.arg(...)`, ce qui casse la macro.
  #define TXT(cle, champ) if (serveur.hasArg(cle)) snprintf(r.champ, sizeof r.champ, "%s", serveur.arg(cle).c_str())
  // Les mots de passe vides signifient « inchangé » : sans cette règle,
  // enregistrer le formulaire effacerait des secrets qu'il n'affiche pas.
  #define SECRET(cle, champ) if (serveur.hasArg(cle) && serveur.arg(cle).length() > 0) \
                               snprintf(r.champ, sizeof r.champ, "%s", serveur.arg(cle).c_str())
  TXT("ssid", ssid);
  SECRET("wifiPass", motDePasse);
  TXT("webUser", webUtilisateur);
  if (serveur.hasArg("webPass") && serveur.arg("webPass").length() > 0) {
    const String u = serveur.hasArg("webUser") && serveur.arg("webUser").length()
                       ? serveur.arg("webUser") : String(r.webUtilisateur);
    snprintf(r.webHachage, sizeof r.webHachage, "%s",
             hacher(u + ":" + serveur.arg("webPass")).c_str());
  }
  SECRET("otaPass", otaMotDePasse);
  if (serveur.hasArg("apPass") && serveur.arg("apPass").length() >= 8)
    snprintf(r.apMotDePasse, sizeof r.apMotDePasse, "%s", serveur.arg("apPass").c_str());
  TXT("urlAlertes", urlAlertes);
  TXT("urlHeartbeat", urlHeartbeat);
  TXT("mqttHote", mqttHote);
  TXT("mqttPrefixe", mqttPrefixe);
  TXT("mqttUser", mqttUtilisateur);
  SECRET("mqttPass", mqttMotDePasse);
  SECRET("alerteJeton", alerteJeton);
  TXT("fuseau", fuseau);
  TXT("ntp", ntp);
  #undef TXT
  #undef SECRET
  // Les champs secrets se contentent d'ignorer une saisie vide, sinon le
  // formulaire les effacerait à chaque enregistrement. Il faut donc un geste
  // explicite pour en retirer un.
  if (serveur.hasArg("alerteJetonVide") && serveur.arg("alerteJetonVide").toInt() != 0)
    r.alerteJeton[0] = '\0';
  if (serveur.hasArg("mqttPort"))     r.mqttPort = (uint16_t)serveur.arg("mqttPort").toInt();
  if (serveur.hasArg("heartbeatMin")) r.heartbeatMinutes = (uint16_t)serveur.arg("heartbeatMin").toInt();
  if (serveur.hasArg("ha"))           r.decouverteHA = serveur.arg("ha").toInt() != 0;
  if (serveur.hasArg("mqttTls"))      r.mqttTls = serveur.arg("mqttTls").toInt() != 0;
  if (serveur.hasArg("verifierTls"))  r.verifierTls = serveur.arg("verifierTls").toInt() != 0;
  if (r.mqttPort == 0) r.mqttPort = 1883;
  if (r.heartbeatMinutes == 0 || r.heartbeatMinutes > 1440) r.heartbeatMinutes = 5;
  r.mqttActif = r.mqttHote[0] != '\0';
  if (r.mqttPrefixe[0] == '\0') snprintf(r.mqttPrefixe, sizeof r.mqttPrefixe, "terrarium");

  Stockage::sauverReseau();
  journal("Reglages reseau modifies, redemarrage demande");
  serveur.send(200, "text/plain", "Enregistre. Redemarrage dans 2 s.");
  delay(300);
  ESP.restart();
}

void routeJournalGet() {
  if (!autorise()) return;
  serveur.send(200, "text/plain; charset=utf-8", Stockage::journalQueue(12000));
}

void routeJournalDelete() {
  if (!autorise()) return;
  if (!origineSure()) return;
  Stockage::journalEffacer();
  journal("Journal efface");
  serveur.send(200, "text/plain", "Journal efface");
}

// Prometheus : exposition brute, volontairement sans authentification pour
// rester scrapable, et sans aucune donnée sensible.
void routeMetrics() {
  String m;
  m.reserve(1100);
  m += "# HELP terrarium_temperature_celsius Temperature mesuree\n# TYPE terrarium_temperature_celsius gauge\n";
  for (uint8_t z = 0; z < NB_ZONES; z++)
    if (!isnan(ctrl.zone[z].temperature))
      m += "terrarium_temperature_celsius{zone=\"" + String(z + 1) + "\"} " + String(ctrl.zone[z].temperature, 2) + "\n";
  m += "# TYPE terrarium_consigne_celsius gauge\n";
  for (uint8_t z = 0; z < NB_ZONES; z++)
    if (!isnan(ctrl.zone[z].consigneEff))
      m += "terrarium_consigne_celsius{zone=\"" + String(z + 1) + "\"} " + String(ctrl.zone[z].consigneEff, 2) + "\n";
  m += "# TYPE terrarium_demande_ratio gauge\n";
  for (uint8_t z = 0; z < NB_ZONES; z++)
    m += "terrarium_demande_ratio{zone=\"" + String(z + 1) + "\"} " + String(ctrl.zone[z].demande, 3) + "\n";
  m += "# TYPE terrarium_charge_ratio gauge\n";
  for (uint8_t z = 0; z < NB_ZONES; z++)
    m += "terrarium_charge_ratio{zone=\"" + String(z + 1) + "\"} " + String(ctrl.duty(z) / 100.0f, 3) + "\n";
  m += "# TYPE terrarium_defaut gauge\n";
  for (uint8_t z = 0; z < NB_ZONES; z++)
    m += "terrarium_defaut{zone=\"" + String(z + 1) + "\"} " + String((int)ctrl.zone[z].defaut) + "\n";
  m += "# TYPE terrarium_tapis_actif gauge\nterrarium_tapis_actif " + String(ctrl.tapisActif()) + "\n";
  m += "# TYPE terrarium_energie_kwh counter\n";
  for (uint8_t z = 0; z < NB_ZONES; z++)
    m += "terrarium_energie_kwh{zone=\"" + String(z + 1) + "\"} " +
         String(secondesChauffeTotales(z) / 3600.0f * Stockage::globaux().puissanceTapisW / 1000.0f, 4) + "\n";
  m += "# TYPE terrarium_info gauge\nterrarium_info{version=\"" FW_VERSION "\"} 1\n";
  m += "# TYPE terrarium_uptime_seconds counter\nterrarium_uptime_seconds " + String(millis() / 1000) + "\n";
  m += "# TYPE terrarium_heap_libre_octets gauge\nterrarium_heap_libre_octets " + String(ESP.getFreeHeap()) + "\n";
  serveur.send(200, "text/plain; version=0.0.4", m);
}

// --------------------------- MQTT ------------------------------------------
String sujetBase() { return String(Stockage::reseau().mqttPrefixe) + "/" + g_id; }

void repondre(const String &req, bool ok, const String &corps) {
  String j = "{\"req\":\"" + echapperJson(req.c_str()) + "\",\"ok\":" + (ok ? "true" : "false");
  if (corps.length()) j += "," + corps;
  j += "}";
  mqtt.publish((sujetBase() + "/reponse").c_str(), j.c_str());
}

// Canal de commande générique : une seule paire de sujets transporte du JSON,
// plutôt qu'un sujet par réglage. La surface exposée est celle de l'API web, ce
// qui permet à une application distante de tout piloter sans que le firmware
// ait à connaître cette application.
//
//   requête  -> <prefixe>/<id>/cmd      {"req":"42","action":"...","jeton":"..."}
//   réponse  -> <prefixe>/<id>/reponse  {"req":"42","ok":true,...}
//
// Le jeton de l'appareil est exigé pour toute action modifiante : même si le
// broker est partagé ou mal cloisonné, personne ne pilote un socle sans le
// secret imprimé dessus.
void traiterCommande(const String &charge) {
  JsonDocument doc;
  if (deserializeJson(doc, charge)) { repondre("", false, "\"erreur\":\"JSON invalide\""); return; }

  const String req    = doc["req"]    | "";
  const String action = doc["action"] | "";
  const String jeton  = doc["jeton"]  | "";

  const bool lectureSeule = (action == "etat" || action == "stats" || action == "version" ||
                             action == "historique");
  if (!lectureSeule && jeton != Stockage::reseau().jeton) {
    repondre(req, false, "\"erreur\":\"jeton invalide\"");
    journal("Commande MQTT refusee : jeton invalide (%s)", action.c_str());
    return;
  }

  if (action == "version") {
    repondre(req, true, "\"version\":\"" FW_VERSION "\",\"compile\":\"" FW_BUILD "\"");
    return;
  }

  if (action == "etat") {
    String d = "\"zones\":[";
    for (uint8_t z = 0; z < NB_ZONES; z++) {
      if (z) d += ",";
      d += "{\"nom\":\"" + echapperJson(ctrl.cfg[z].nom) + "\"";
      d += ",\"temp\":" + String(isnan(ctrl.zone[z].temperature) ? 0.0f : ctrl.zone[z].temperature, 2);
      d += ",\"consigne\":" + String(isnan(ctrl.zone[z].consigneEff) ? 0.0f : ctrl.zone[z].consigneEff, 2);
      d += ",\"demande\":" + String((int)lroundf(ctrl.zone[z].demande * 100));
      d += ",\"charge\":" + String((int)lroundf(ctrl.duty(z)));
      d += ",\"chauffe\":" + String(ctrl.tapisDeZone(z) >= 0 ? "true" : "false");
      d += ",\"autotune\":" + String((ctrl.zone[z].autotune == AT_ATTENTE ||
                                       ctrl.zone[z].autotune == AT_OSCILLE) ? "true" : "false");
      d += ",\"derive\":" + String(ctrl.zone[z].deriveActive ? "true" : "false");
      // Consignes de référence : sans elles, une application distante ne peut
      // que réafficher la consigne du moment (rampe et saison comprises), et
      // l'enregistrer telle quelle écraserait le vrai réglage.
      d += ",\"jour\":" + String(ctrl.cfg[z].consigneJour, 1);
      d += ",\"nuit\":" + String(ctrl.cfg[z].consigneNuit, 1);
      d += ",\"bande\":" + String(ctrl.cfg[z].bande, 2);
      d += ",\"max\":" + String(ctrl.cfg[z].tempMax, 1);
      d += ",\"offset\":" + String(ctrl.cfg[z].offset, 2);
      d += ",\"rampe\":" + String(ctrl.cfg[z].rampeMinutes);
      d += ",\"debutJour\":" + String(ctrl.cfg[z].debutJour);
      d += ",\"debutNuit\":" + String(ctrl.cfg[z].debutNuit);
      d += ",\"defaut\":" + (ctrl.zone[z].defaut == DEF_AUCUN ? String("null")
                              : "\"" + String(nomDefaut(ctrl.zone[z].defaut)) + "\"") + "}";
    }
    d += "],\"uptime\":" + String(millis() / 1000);
    d += ",\"entretienS\":" + String(ctrl.maintenanceRestanteMs(millis()) / 1000);
    d += ",\"heure\":\"" + (heureFiable() ? horodatage() : String("")) + "\"";
    d += ",\"zonesSimultanees\":" + String(ctrl.limiteZones());
    d += ",\"saison\":" + String(ctrl.decalageSaison(), 2);
    d += ",\"alertesEnAttente\":" + String(Stockage::alertesEnAttente());
    repondre(req, true, d);
    return;
  }

  if (action == "zone") {
    const int z = doc["z"] | -1;
    if (z < 0 || z >= (int)NB_ZONES) { repondre(req, false, "\"erreur\":\"zone invalide\""); return; }
    ReglagesZone n = ctrl.cfg[z];
    if (doc["nom"].is<const char *>())  snprintf(n.nom, sizeof n.nom, "%s", doc["nom"].as<const char *>());
    if (doc["jour"].is<float>())        n.consigneJour = doc["jour"];
    if (doc["nuit"].is<float>())        n.consigneNuit = doc["nuit"];
    if (doc["bande"].is<float>())       n.bande        = doc["bande"];
    if (doc["ki"].is<float>())          n.ki           = doc["ki"];
    if (doc["max"].is<float>())         n.tempMax      = doc["max"];
    if (doc["offset"].is<float>())      n.offset       = doc["offset"];
    if (doc["rampe"].is<int>())         n.rampeMinutes = doc["rampe"];
    if (doc["debutJour"].is<int>())     n.debutJour    = doc["debutJour"];
    if (doc["debutNuit"].is<int>())     n.debutNuit    = doc["debutNuit"];
    // Les diagnostics se règlent aussi de loin : ce sont eux qui décident
    // quand une alerte part, et leur bon réglage dépend du terrarium.
    if (doc["deriveSeuil"].is<float>())      n.deriveSeuil       = doc["deriveSeuil"];
    if (doc["deriveMin"].is<int>())          n.deriveMinutes     = doc["deriveMin"];
    if (doc["inefficaceMin"].is<int>())      n.inefficaceMinutes = doc["inefficaceMin"];
    if (doc["inefficaceDelta"].is<float>())  n.inefficaceDelta   = doc["inefficaceDelta"];
    if (doc["chuteSeuil"].is<float>())       n.chuteSeuil        = doc["chuteSeuil"];
    if (doc["chuteSecondes"].is<int>())      n.chuteSecondes     = doc["chuteSecondes"];
    char err[100];
    // Mêmes règles que partout ailleurs : la validation vit dans le cœur de
    // régulation, elle n'est pas réécrite pour chaque interface.
    if (!reglagesValides(n, err, sizeof err)) {
      repondre(req, false, "\"erreur\":\"" + echapperJson(err) + "\"");
      return;
    }
    ctrl.cfg[z] = n;
    Stockage::sauverZone((uint8_t)z, n);
    journal("Zone %d modifiee via le canal de commande", z + 1);
    Reseau::publierMqtt(true);
    repondre(req, true, "");
    return;
  }

  // Ces deux actions étaient annoncées comme lectures autorisées sans jeton
  // (et documentées comme telles) mais aucune branche ne les traitait : elles
  // répondaient « action inconnue ». Une application distante n'avait donc ni
  // statistiques ni courbes.
  if (action == "stats") {
    repondre(req, true, corpsStats());
    return;
  }

  if (action == "historique") {
    uint32_t heures = doc["heures"] | 24;
    if (heures == 0 || heures > 400) heures = 24;
    uint16_t maxi = (uint16_t)(doc["max"] | 120);
    if (maxi == 0 || maxi > 200) maxi = 120;

    const uint32_t total   = Stockage::histNombre();
    const uint32_t voulus  = heures * 60;
    const uint32_t debut   = (total > voulus) ? total - voulus : 0;
    const uint32_t dispo   = total - debut;
    const uint32_t pas     = (dispo > maxi) ? (dispo / maxi) : 1;

    CtxHistMqtt c;
    c.n = 0; c.maxi = maxi;
    // Marge sous la taille du tampon MQTT pour l'enveloppe de la réponse.
    c.limite = 6500;
    c.bloc.reserve(1600);
    Stockage::histParcourir(debut, pas, visiteHistMqtt, &c);

    String d = "\"format\":[\"epoch\",\"t1\",\"consigne1\",\"t2\",\"consigne2\"]";
    d += ",\"unite\":\"centiemes de degre\"";
    d += ",\"pas\":" + String(pas) + ",\"heures\":" + String(heures);
    d += ",\"n\":" + String(c.n);
    d += ",\"points\":[" + c.bloc + "]";
    repondre(req, true, d);
    return;
  }

  if (action == "stop-autotune") {
    const int z = doc["z"] | -1;
    if (z < 0 || z >= (int)NB_ZONES) { repondre(req, false, "\"erreur\":\"zone invalide\""); return; }
    ctrl.arreterAutotune((uint8_t)z);
    repondre(req, true, "");
    return;
  }

  if (action == "effacer-historique") {
    Stockage::histEffacer();
    journal("Historique efface via le canal de commande");
    repondre(req, true, "");
    return;
  }

  // Lecture et écriture des réglages globaux. Sans champ, c'est une simple
  // lecture ; l'action reste protégée par le jeton, puisqu'elle peut décider
  // de la puissance appelée.
  if (action == "globaux") {
    ReglagesGlobaux n = Stockage::globaux();
    bool ecriture = false;
    #define CHAMP(cle, membre, type) \
      if (doc[cle].is<type>()) { n.membre = doc[cle]; ecriture = true; }
    CHAMP("amperes",         courantAlimA,    float)
    CHAMP("watts",           puissanceTapisW, float)
    CHAMP("volts",           tensionV,        float)
    CHAMP("entretienMin",    maintenanceMin,  int)
    CHAMP("ecranVeilleMin",  ecranVeilleMin,  int)
    CHAMP("saisonDelta",     saisonDelta,     float)
    CHAMP("saisonDescenteJ", saisonDescenteJ, int)
    CHAMP("saisonPlateauJ",  saisonPlateauJ,  int)
    CHAMP("saisonRemonteeJ", saisonRemonteeJ, int)
    #undef CHAMP

    if (doc["saisonActive"].is<bool>()) {
      const bool actif = doc["saisonActive"];
      if (actif && !heureFiable()) {
        repondre(req, false, "\"erreur\":\"heure inconnue : cycle saisonnier indatable\"");
        return;
      }
      if (actif && !n.saisonActive) n.saisonDebutEpoch = (uint32_t)time(nullptr);
      n.saisonActive = actif;
      ecriture = true;
    }

    if (ecriture) {
      char err[100];
      if (!Stockage::globauxValides(n, err, sizeof err)) {
        repondre(req, false, "\"erreur\":\"" + echapperJson(err) + "\"");
        return;
      }
      Stockage::globaux() = n;
      Stockage::sauverGlobaux();
      appliquerReglagesGlobaux();
      journal("Reglages globaux modifies via le canal de commande");
    }

    const ReglagesGlobaux &g = Stockage::globaux();
    String d = "\"amperes\":" + String(g.courantAlimA, 1);
    d += ",\"watts\":" + String(g.puissanceTapisW, 0);
    d += ",\"volts\":" + String(g.tensionV, 1);
    d += ",\"zonesSimultanees\":" + String(ctrl.limiteZones());
    d += ",\"entretienMin\":" + String(g.maintenanceMin);
    d += ",\"ecranVeilleMin\":" + String(g.ecranVeilleMin);
    d += ",\"saisonActive\":" + String(g.saisonActive ? "true" : "false");
    d += ",\"saisonDelta\":" + String(g.saisonDelta, 1);
    d += ",\"saisonDescenteJ\":" + String(g.saisonDescenteJ);
    d += ",\"saisonPlateauJ\":" + String(g.saisonPlateauJ);
    d += ",\"saisonRemonteeJ\":" + String(g.saisonRemonteeJ);
    d += ",\"decalageActuel\":" + String(ctrl.decalageSaison(), 2);
    repondre(req, true, d);
    return;
  }

  if (action == "reset") {
    ctrl.leverDefauts(millis());
    uint8_t d[NB_ZONES] = { DEF_AUCUN, DEF_AUCUN };
    Stockage::sauverDefauts(d);
    journal("Defauts leves via le canal de commande");
    repondre(req, true, "");
    return;
  }

  if (action == "entretien") {
    const int minutes = doc["minutes"] | (int)Stockage::globaux().maintenanceMin;
    if (minutes < 0 || minutes > 240) { repondre(req, false, "\"erreur\":\"duree hors 0-240 min\""); return; }
    ctrl.maintenance(millis(), (uint16_t)minutes);
    repondre(req, true, "");
    return;
  }

  if (action == "autotune") {
    const int z = doc["z"] | -1;
    char err[80] = "";
    if (z < 0 || z >= (int)NB_ZONES || !ctrl.lancerAutotune((uint8_t)z, millis(), err, sizeof err)) {
      repondre(req, false, "\"erreur\":\"" + echapperJson(err[0] ? err : "zone invalide") + "\"");
      return;
    }
    repondre(req, true, "");
    return;
  }

  if (action == "alim") {
    ReglagesGlobaux &g = Stockage::globaux();
    const float a = doc["amperes"] | g.courantAlimA;
    if (!(a >= 0.5f && a <= 40.0f)) { repondre(req, false, "\"erreur\":\"amperage hors 0.5-40 A\""); return; }
    g.courantAlimA = a;
    if (doc["watts"].is<float>()) g.puissanceTapisW = doc["watts"];
    Stockage::sauverGlobaux();
    appliquerReglagesGlobaux();
    repondre(req, true, "\"zonesSimultanees\":" + String(ctrl.limiteZones()));
    return;
  }

  if (action == "redemarrer") { repondre(req, true, ""); mqtt.loop(); delay(200); ESP.restart(); return; }

  repondre(req, false, "\"erreur\":\"action inconnue\"");
}

void rappelMqtt(char *sujet, uint8_t *charge, unsigned int taille) {
  const String s(sujet);
  String v;
  v.reserve(taille + 1);
  for (unsigned int i = 0; i < taille; i++) v += (char)charge[i];

  if (s == sujetBase() + "/cmd") { traiterCommande(v); return; }

  // Sujets simples conservés pour la découverte Home Assistant.
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    const String prefixe = sujetBase() + "/zone" + String(z + 1);
    ReglagesZone n = ctrl.cfg[z];
    bool touche = false;
    if (s == prefixe + "/consigne_jour/set") { n.consigneJour = v.toFloat(); touche = true; }
    if (s == prefixe + "/consigne_nuit/set") { n.consigneNuit = v.toFloat(); touche = true; }
    if (!touche) continue;
    char err[100];
    if (!reglagesValides(n, err, sizeof err)) { journal("MQTT refuse pour zone %u : %s", z + 1, err); return; }
    ctrl.cfg[z] = n;
    Stockage::sauverZone(z, n);
    journal("Consigne zone %u modifiee via MQTT", z + 1);
    Reseau::publierMqtt(true);
  }
}

void publierDecouverteHA() {
  const ReglagesReseau &r = Stockage::reseau();
  if (!r.decouverteHA) return;
  const String base = sujetBase();
  const String dev = "\"device\":{\"identifiers\":[\"" + g_id + "\"],\"name\":\"Terrarium\","
                     "\"manufacturer\":\"DIY\",\"model\":\"ESP32 thermostat\"},"
                     "\"availability_topic\":\"" + base + "/statut\"";
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    const String zt = base + "/zone" + String(z + 1);
    const String uid = g_id + "_z" + String(z + 1);
    String cfg;

    cfg = "{\"name\":\"Temperature zone " + String(z + 1) + "\",\"unique_id\":\"" + uid + "_temp\","
          "\"state_topic\":\"" + zt + "/etat\",\"value_template\":\"{{ value_json.temp }}\","
          "\"unit_of_measurement\":\"°C\",\"device_class\":\"temperature\"," + dev + "}";
    mqtt.publish(("homeassistant/sensor/" + uid + "_temp/config").c_str(), cfg.c_str(), true);

    cfg = "{\"name\":\"Consigne zone " + String(z + 1) + "\",\"unique_id\":\"" + uid + "_cons\","
          "\"state_topic\":\"" + zt + "/etat\",\"value_template\":\"{{ value_json.consigne }}\","
          "\"unit_of_measurement\":\"°C\",\"device_class\":\"temperature\"," + dev + "}";
    mqtt.publish(("homeassistant/sensor/" + uid + "_cons/config").c_str(), cfg.c_str(), true);

    cfg = "{\"name\":\"Chauffage zone " + String(z + 1) + "\",\"unique_id\":\"" + uid + "_heat\","
          "\"state_topic\":\"" + zt + "/etat\",\"value_template\":\"{{ value_json.chauffe }}\","
          "\"payload_on\":\"1\",\"payload_off\":\"0\",\"device_class\":\"heat\"," + dev + "}";
    mqtt.publish(("homeassistant/binary_sensor/" + uid + "_heat/config").c_str(), cfg.c_str(), true);

    cfg = "{\"name\":\"Defaut zone " + String(z + 1) + "\",\"unique_id\":\"" + uid + "_pb\","
          "\"state_topic\":\"" + zt + "/etat\",\"value_template\":\"{{ value_json.defaut }}\","
          "\"payload_on\":\"1\",\"payload_off\":\"0\",\"device_class\":\"problem\"," + dev + "}";
    mqtt.publish(("homeassistant/binary_sensor/" + uid + "_pb/config").c_str(), cfg.c_str(), true);

    cfg = "{\"name\":\"Consigne jour zone " + String(z + 1) + "\",\"unique_id\":\"" + uid + "_setj\","
          "\"state_topic\":\"" + zt + "/etat\",\"value_template\":\"{{ value_json.jour }}\","
          "\"command_topic\":\"" + zt + "/consigne_jour/set\",\"min\":10,\"max\":45,\"step\":0.5,"
          "\"unit_of_measurement\":\"°C\",\"mode\":\"box\"," + dev + "}";
    mqtt.publish(("homeassistant/number/" + uid + "_setj/config").c_str(), cfg.c_str(), true);

    mqtt.subscribe((zt + "/consigne_jour/set").c_str());
    mqtt.subscribe((zt + "/consigne_nuit/set").c_str());
  }
  g_haPublie = true;
}

void gererMqtt(uint32_t maintenant) {
  ReglagesReseau &r = Stockage::reseau();
  if (!r.mqttActif || r.mqttHote[0] == '\0' || !g_connecte || g_ap) return;

  if (!mqtt.connected()) {
    if (maintenant - g_dernierEssaiMqtt < 15000) return;
    g_dernierEssaiMqtt = maintenant;
    // Vers un serveur distant, le trafic MQTT doit être chiffré : il transporte
    // les identifiants de l'appareil et permet de le piloter.
    if (r.mqttTls) {
      if (r.verifierTls)
        clientMqttTls.setCACertBundle(rootca_crt_bundle_start,
                                      (size_t)(rootca_crt_bundle_end - rootca_crt_bundle_start));
      else clientMqttTls.setInsecure();
      clientMqttTls.setTimeout(6);
      mqtt.setClient(clientMqttTls);
    } else {
      mqtt.setClient(clientMqttClair);
    }
    mqtt.setServer(r.mqttHote, r.mqttPort);
    // L'historique compacté est le plus gros message que le socle émette :
    // 120 points de cinq nombres, plus l'enveloppe. 4 Ko n'y suffisaient pas.
    mqtt.setBufferSize(8192);
    // Par défaut PubSubClient attend 15 s sur la socket, soit exactement la
    // durée du watchdog : un broker injoignable faisait redémarrer l'appareil.
    mqtt.setSocketTimeout(4);
    mqtt.setKeepAlive(30);
    mqtt.setCallback(rappelMqtt);
    const String statut = sujetBase() + "/statut";
    const bool ok = r.mqttUtilisateur[0]
      ? mqtt.connect(g_id.c_str(), r.mqttUtilisateur, r.mqttMotDePasse, statut.c_str(), 0, true, "hors ligne")
      : mqtt.connect(g_id.c_str(), statut.c_str(), 0, true, "hors ligne");
    if (!ok) return;
    mqtt.publish(statut.c_str(), "en ligne", true);
    mqtt.subscribe((sujetBase() + "/cmd").c_str());
    g_haPublie = false;
    journal("MQTT connecte a %s", r.mqttHote);
  }
  mqtt.loop();
  if (!g_haPublie) publierDecouverteHA();
  if (maintenant - g_dernierMqtt >= PERIODE_MQTT_MS) { g_dernierMqtt = maintenant; Reseau::publierMqtt(); }
}

// --------------------------- envois HTTP ------------------------------------
// Gère http et https : sans client TLS explicite, toute URL https échouerait
// silencieusement — c'est-à-dire précisément les webhooks les plus courants.
bool envoyerHttp(const char *url, const String &corps, bool post,
                 const char *typeContenu = "text/plain; charset=utf-8") {
  if (!g_connecte || g_ap || url == nullptr || url[0] == '\0') return false;
  HTTPClient http;
  http.setConnectTimeout(4000);
  http.setTimeout(4000);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  bool ouvert = false;
  WiFiClientSecure securise;
  WiFiClient clair;
  if (strncmp(url, "https://", 8) == 0) {
    // Le magasin d'autorités de certification embarqué dans le paquet ESP32
    // permet de vérifier l'interlocuteur. Désactivable si l'on vise un serveur
    // local à certificat auto-signé.
    if (Stockage::reseau().verifierTls)
      securise.setCACertBundle(rootca_crt_bundle_start,
                               (size_t)(rootca_crt_bundle_end - rootca_crt_bundle_start));
    else                                securise.setInsecure();
    securise.setTimeout(4);
    ouvert = http.begin(securise, url);
  } else {
    ouvert = http.begin(clair, url);
  }
  if (!ouvert) return false;
  if (post) http.addHeader("Content-Type", typeContenu);
  // Jeton partagé, facultatif : sans lui, l'URL d'alerte est le seul secret, et
  // n'importe qui la connaissant peut inonder le serveur de fausses alertes.
  const char *jeton = Stockage::reseau().alerteJeton;
  if (jeton[0]) http.addHeader("Authorization", String("Bearer ") + jeton);
  http.addHeader("X-Terrarium-Appareil", g_id);
  const int code = post ? http.POST(corps) : http.GET();
  http.end();
  return code > 0 && code < 400;
}

void gererEnvois(uint32_t maintenant) {
  if (!g_connecte || g_ap) return;

  String alerte;
  const bool aEnvoyer = Stockage::alerteTete(alerte);
  const bool tempoEcoulee = !g_attenteAlerte ||
                            (int32_t)(maintenant - g_prochaineAlerte) >= 0;
  if (tempoEcoulee) g_attenteAlerte = false;

  if (aEnvoyer && tempoEcoulee) {
    if (Stockage::reseau().urlAlertes[0] == '\0') {
      Stockage::alerteDefiler();               // alertes désactivées : on purge
    } else if (envoyerHttp(Stockage::reseau().urlAlertes, alerte, true, "application/json; charset=utf-8")) {
      Stockage::alerteDefiler();
      g_echecsAlerte = 0;
    } else if (++g_echecsAlerte >= MAX_ECHECS_ALERTE) {
      // On abandonne cette alerte plutôt que de bloquer indéfiniment la file
      // derrière elle. L'abandon est tracé : il ne disparaît pas en silence.
      Stockage::alerteDefiler();
      g_echecsAlerte = 0;
      journal("Alerte abandonnee apres %u tentatives : %s",
              (unsigned)MAX_ECHECS_ALERTE, alerte.c_str());
    } else {
      // 5 s, 10 s, 20 s… plafonné à 5 min
      uint32_t attente = 5000UL << (g_echecsAlerte - 1);
      if (attente > 300000UL) attente = 300000UL;
      g_prochaineAlerte = maintenant + attente;
      g_attenteAlerte = true;
    }
    return;
  }

  // Le heartbeat continue même quand la file d'alertes patiente : c'est lui qui
  // signale que l'appareil est vivant, il ne doit pas dépendre du webhook.
  const uint32_t periode = (uint32_t)Stockage::reseau().heartbeatMinutes * 60000UL;
  if (maintenant - g_dernierHeartbeat >= periode) {
    g_dernierHeartbeat = maintenant;
    const char *url = Stockage::reseau().urlHeartbeat;
    if (url[0] == '\0') return;
    // Un GET nu ne disait pas quel socle battait : avec plusieurs appareils, le
    // serveur ne pouvait pas savoir lequel s'était tu. On joint l'identité et
    // l'essentiel de l'état, en paramètres d'URL pour rester lisible par
    // n'importe quel service de surveillance.
    String q = String(url);
    q += (q.indexOf('?') >= 0) ? "&" : "?";
    q += "id=" + g_id + "&v=" FW_VERSION "&uptime=" + String(millis() / 1000);
    uint8_t enDefaut = 0;
    for (uint8_t z = 0; z < NB_ZONES; z++) {
      if (ctrl.zone[z].defaut != DEF_AUCUN) enDefaut++;
      q += "&t" + String(z + 1) + "=" +
           (isnan(ctrl.zone[z].temperature) ? String("") : String(ctrl.zone[z].temperature, 2));
    }
    q += "&defauts=" + String(enDefaut);
    q += "&alertes=" + String(Stockage::alertesEnAttente());
    envoyerHttp(q.c_str(), "", false);
  }
}

// --------------------------- démarrage des services -------------------------
void lancerServices() {
  const ReglagesReseau &r = Stockage::reseau();

  MDNS.begin("terrarium");
  MDNS.addService("http", "tcp", 80);

  serveur.on("/",                 HTTP_GET,    routeRacine);
  serveur.on("/api/status",       HTTP_GET,    routeStatus);
  serveur.on("/api/history",      HTTP_GET,    routeHistory);
  serveur.on("/api/history.csv",  HTTP_GET,    routeHistoryCsv);
  serveur.on("/api/history",      HTTP_DELETE, routeHistoryDelete);
  serveur.on("/api/config",       HTTP_POST,   routeConfig);
  serveur.on("/api/reset",        HTTP_POST,   routeReset);
  serveur.on("/api/autotune",     HTTP_POST,   routeAutotune);
  serveur.on("/api/autotune",     HTTP_DELETE, routeAutotuneStop);
  serveur.on("/api/globaux",      HTTP_GET,    routeGlobauxGet);
  serveur.on("/api/globaux",      HTTP_POST,   routeGlobauxPost);
  serveur.on("/api/redemarrer",   HTTP_POST,   routeRedemarrer);
  serveur.on("/api/maj",          HTTP_POST,   routeMajFin, routeMajFragment);
  serveur.on("/api/sondes",       HTTP_GET,    routeSondesGet);
  serveur.on("/api/sondes",       HTTP_POST,   routeSondesPost);
  serveur.on("/api/reseau",       HTTP_GET,    routeReseauGet);
  serveur.on("/api/reseau",       HTTP_POST,   routeReseauPost);
  serveur.on("/api/journal",      HTTP_GET,    routeJournalGet);
  serveur.on("/api/journal",      HTTP_DELETE, routeJournalDelete);
  serveur.on("/api/stats",        HTTP_GET,    routeStats);
  serveur.on("/api/maintenance",  HTTP_POST,   routeMaintenance);
  serveur.on("/metrics",          HTTP_GET,    routeMetrics);
  // Application installable : manifeste et agent de service minimal.
  serveur.on("/manifest.json", HTTP_GET, []() {
    serveur.send(200, "application/manifest+json",
      "{\"name\":\"Thermostat terrarium\",\"short_name\":\"Terrarium\","
      "\"start_url\":\"/\",\"display\":\"standalone\",\"background_color\":\"#111\","
      "\"theme_color\":\"#111\",\"icons\":[{\"src\":\"/icone.svg\",\"sizes\":\"any\","
      "\"type\":\"image/svg+xml\",\"purpose\":\"any\"}]}");
  });
  serveur.on("/icone.svg", HTTP_GET, []() {
    serveur.send(200, "image/svg+xml",
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>"
      "<rect width='64' height='64' rx='12' fill='#111'/>"
      "<rect x='27' y='10' width='10' height='30' rx='5' fill='#2a6'/>"
      "<circle cx='32' cy='46' r='10' fill='#2a6'/>"
      "<rect x='30' y='16' width='4' height='26' fill='#5cf'/></svg>");
  });
  serveur.on("/sw.js", HTTP_GET, []() {
    serveur.send(200, "application/javascript",
      "self.addEventListener('fetch',function(e){});");
  });
  serveur.onNotFound([]() { serveur.send(404, "text/plain", "Page inconnue"); });
  const char *entetes[] = { "X-Terrarium", "Authorization" };
  serveur.collectHeaders(entetes, 2);
  serveur.begin();

  // L'OTA réseau n'est démarrée QUE si elle est protégée. Sans mot de passe,
  // n'importe qui sur le réseau local peut réécrire le firmware d'un appareil
  // dont dépend un animal vivant — un simple invité du WiFi, une caméra
  // compromise. Il reste toujours un chemin pour la remettre en service sans
  // câble : /api/maj téléverse un firmware depuis le navigateur, protégé par
  // l'authentification de l'interface web.
  g_otaLancee = false;
  if (r.otaMotDePasse[0]) {
    ArduinoOTA.setHostname("terrarium");
    ArduinoOTA.setPassword(r.otaMotDePasse);
    // Une mise à jour interrompue laisserait sinon un tapis alimenté sans
    // aucune régulation derrière.
    ArduinoOTA.onStart([]() { otaEnCours = true; ctrl.suspendre(true); journal("OTA demarree"); });
    ArduinoOTA.onEnd([]()   { otaEnCours = false; ctrl.suspendre(false); journal("OTA terminee"); });
    ArduinoOTA.onError([](ota_error_t e) {
      otaEnCours = false; ctrl.suspendre(false);
      journal("OTA en echec (code %d)", (int)e);
    });
    ArduinoOTA.onProgress([](unsigned int, unsigned int) { esp_task_wdt_reset(); });
    ArduinoOTA.begin();
    g_otaLancee = true;
  } else {
    journal("OTA reseau desactivee : aucun mot de passe. `motdepasse ota <mdp>` ou "
            "onglet Reseau pour l'activer. La mise a jour par le navigateur reste disponible.");
  }

  if (!g_ap) configTzTime(r.fuseau, r.ntp, "pool.ntp.org");
  g_servicesLances = true;
}

} // namespace

// ============================================================================
namespace Reseau {

String identifiant() { return g_id; }

void demarrer() {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char b[16];
  snprintf(b, sizeof b, "terra%02X%02X%02X", mac[3], mac[4], mac[5]);
  g_id = String(b);

  ReglagesReseau &r = Stockage::reseau();
  r.mqttActif = r.mqttHote[0] != '\0';

  if (r.ssid[0] == '\0') {
    // Aucun réseau configuré : on ouvre un point d'accès pour permettre la
    // configuration depuis un téléphone, sans câble ni recompilation.
    WiFi.mode(WIFI_AP);
    WiFi.softAP("terrarium-config", r.apMotDePasse);
    g_ap = true; g_connecte = true;
    journal("Point d'acces de configuration ouvert (SSID terrarium-config)");
    lancerServices();
    return;
  }

  WiFi.mode(WIFI_STA);
  WiFi.setHostname("terrarium");
  WiFi.setAutoReconnect(true);
  WiFi.begin(r.ssid, r.motDePasse);
  g_debutConnexion = millis();
}

void boucle(uint32_t maintenant) {
  if (!g_ap) {
    const bool ok = WiFi.status() == WL_CONNECTED;
    if (ok && !g_connecte) {
      g_connecte = true;
      journal("WiFi connecte, adresse %s", WiFi.localIP().toString().c_str());
      if (!g_servicesLances) lancerServices();
    } else if (!ok && g_connecte) {
      g_connecte = false;
      journal("WiFi perdu — la regulation continue en autonome");
    }
    if (!ok && maintenant - g_dernierEssai > 20000) {
      g_dernierEssai = maintenant;
      WiFi.disconnect();
      WiFi.begin(Stockage::reseau().ssid, Stockage::reseau().motDePasse);
    }
    // Jamais connecté après 3 min : le SSID est probablement faux, on ouvre le
    // point d'accès de secours plutôt que de rester inaccessible.
    if (!g_servicesLances && !ok && maintenant - g_debutConnexion > 180000) {
      WiFi.mode(WIFI_AP);
      WiFi.softAP("terrarium-config", Stockage::reseau().apMotDePasse);
      g_ap = true; g_connecte = true;
      journal("Connexion impossible : point d'acces de secours ouvert");
      lancerServices();
    }
  }

  if (g_servicesLances) {
    serveur.handleClient();
    if (g_otaLancee) ArduinoOTA.handle();
  }
  gererMqtt(maintenant);
  gererEnvois(maintenant);
}

bool connecte() { return g_connecte && !g_ap; }
bool modePointAcces() { return g_ap; }
bool otaActive() { return g_otaLancee; }

String adresse() {
  if (g_ap) return WiFi.softAPIP().toString();
  return g_connecte ? WiFi.localIP().toString() : String("hors ligne");
}

void alerter(TypeNotif type, uint8_t zone, const String &texte) {
  const uint8_t iz = (zone < NB_ZONES) ? zone : NB_ZONES;
  const uint8_t it = (type <= NOTIF_INFO) ? (uint8_t)type : (uint8_t)NOTIF_INFO;
  const uint32_t maintenant = millis();
  // Un défaut ou un rétablissement passe toujours : ce sont les seuls messages
  // qu'on ne peut pas se permettre de perdre. Le reste est limité en cadence.
  const bool prioritaire = (type == NOTIF_DEFAUT || type == NOTIF_RETABLI);
  if (!prioritaire && g_derniereAlerte[iz][it] != 0 &&
      maintenant - g_derniereAlerte[iz][it] < ANTISPAM_MS) return;
  g_derniereAlerte[iz][it] = maintenant;

  // Charge JSON plutôt qu'une ligne de texte : un serveur peut trier par
  // appareil, par zone et par nature sans avoir à analyser une phrase, et
  // plusieurs socles deviennent distinguables. Le texte lisible reste dedans.
  String j = "{\"appareil\":\"" + g_id + "\"";
  j += ",\"version\":\"" FW_VERSION "\"";
  j += ",\"horodatage\":\"" + (heureFiable() ? horodatage() : String("")) + "\"";
  j += ",\"heureFiable\":" + String(heureFiable() ? "true" : "false");
  j += ",\"type\":\"" + String(nomNotification(type)) + "\"";
  j += ",\"zone\":" + (zone < NB_ZONES ? String(zone + 1) : String("null"));
  if (zone < NB_ZONES) j += ",\"nomZone\":\"" + echapperJson(ctrl.cfg[zone].nom) + "\"";
  j += ",\"texte\":\"" + echapperJson(texte.c_str()) + "\"}";
  Stockage::alerteEmpiler(j);
}

String empreinte(const String &texte) { return hacher(texte); }

void publierMqtt(bool forcer) {
  if (!mqtt.connected()) return;
  (void)forcer;
  const String base = sujetBase();
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    const ZoneEtat &s = ctrl.zone[z];
    String j = "{\"temp\":" + String(isnan(s.temperature) ? 0.0f : s.temperature, 2);
    j += ",\"consigne\":" + String(isnan(s.consigneEff) ? ctrl.cfg[z].consigneJour : s.consigneEff, 2);
    j += ",\"demande\":" + String((int)lroundf(s.demande * 100));
    j += ",\"charge\":" + String((int)lroundf(ctrl.duty(z)));
    j += ",\"chauffe\":\"" + String((ctrl.tapisActif() >= 0 && ZONE_DE_TAPIS[ctrl.tapisActif()] == z) ? "1" : "0") + "\"";
    j += ",\"defaut\":\"" + String(s.defaut != DEF_AUCUN ? "1" : "0") + "\"";
    j += ",\"defaut_libelle\":\"" + String(nomDefaut(s.defaut)) + "\"";
    j += ",\"jour\":" + String(ctrl.cfg[z].consigneJour, 1);
    j += ",\"nuit\":" + String(ctrl.cfg[z].consigneNuit, 1) + "}";
    mqtt.publish((base + "/zone" + String(z + 1) + "/etat").c_str(), j.c_str(), true);
  }
}

} // namespace Reseau
