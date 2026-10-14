#include "reseau.h"
#include "stockage.h"
#include "page_web_gz.h"  // page embarquée, compressée par outils/compresser-page.js
#include "sondes.h"
#include "format.h"
#include "courant.h"
#include "protocole.h"

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WebServer.h>
#include <HTTPClient.h>
#include <ArduinoOTA.h>
#include <Update.h>
#include <ESPmDNS.h>
#include <DNSServer.h>
#include <PubSubClient.h>
#include <time.h>
#include <mbedtls/sha256.h>
#include <mbedtls/base64.h>
#include <mbedtls/pk.h>
#include <ArduinoJson.h>
#include <esp_partition.h>
#if __has_include(<esp_core_dump.h>)
#include <esp_core_dump.h>
#define AVEC_COREDUMP 1
#endif

// Le cœur ESP32 valide une image fraîchement installée dès son premier
// démarrage. En lui disant ici qu'on s'en charge, c'est le sketch qui valide
// après OTA_VALIDATION_MS de fonctionnement : une mise à jour qui plante n'est
// jamais confirmée, et le chargeur revient de lui-même à la précédente.
// (Fonction C du cœur : liaison C obligatoire, d'où sa place dans un .cpp.)
extern "C" bool verifyRollbackLater() { return true; }

// Magasin d'autorités de certification fourni par le paquet ESP32.
extern const uint8_t rootca_crt_bundle_start[] asm("_binary_x509_crt_bundle_start");
extern const uint8_t rootca_crt_bundle_end[] asm("_binary_x509_crt_bundle_end");

namespace {

WebServer serveur(80);
DNSServer g_dns;  // portail captif du point d'accès de configuration
WiFiClient clientMqttClair;
WiFiClientSecure clientMqttTls;
PubSubClient mqtt(clientMqttClair);

bool g_connecte = false, g_ap = false, g_servicesLances = false, g_haPublie = false;
bool g_otaLancee = false;
uint8_t g_echecsAuth = 0;
uint32_t g_blocageAuth = 0;
uint32_t g_dernierEssai = 0, g_debutConnexion = 0, g_dernierHeartbeat = 0;
uint32_t g_dernierMqtt = 0, g_dernierEssaiMqtt = 0;
String g_id;

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
uint8_t g_echecsAlerte = 0;
uint32_t g_prochaineAlerte = 0;
// Drapeau explicite plutôt qu'une comparaison à une date jamais remise à jour :
// après 24,8 jours de fonctionnement sans échec, (int32_t)(millis() - 0) devient
// négatif et la file d'alertes serait restée bloquée pour toujours.
bool g_attenteAlerte = false;
const uint8_t MAX_ECHECS_ALERTE = 8;

String ssidPointAcces();
String echapperJson(const char *s);

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

// --- sessions -----------------------------------------------------------
// L'interface locale parle en HTTP clair sur le réseau de la maison : avec
// l'authentification Basic, le mot de passe passait en clair à chaque requête.
// Désormais la page se connecte par défi/réponse — le navigateur prouve qu'il
// connaît SHA-256(utilisateur:mot de passe) sans jamais l'envoyer — et reçoit
// un cookie de session (HttpOnly, SameSite=Strict, 24 h glissantes). Basic
// reste accepté pour curl et les scripts.
struct Session {
  char jeton[33];
  uint32_t expire;
};
struct Defi {
  char valeur[33];
  uint32_t expire;
};
Session g_sessions[4];
Defi g_defis[4];
const uint32_t SESSION_MS = 86400000UL;
const uint32_t DEFI_MS = 120000UL;

void aleatoireHex(char *out, size_t octets) {
  for (size_t i = 0; i < octets; i++) {
    const uint32_t r = esp_random();
    snprintf(out + i * 2, 3, "%02x", (unsigned)(r & 0xFF));
  }
  out[octets * 2] = '\0';
}

bool expiree(uint32_t expire, uint32_t maintenant) { return (int32_t)(maintenant - expire) >= 0; }

// Valeur du cookie « session », ou chaîne vide.
String cookieSession() {
  const String c = serveur.header("Cookie");
  int i = c.indexOf("session=");
  while (i >= 0) {
    if (i == 0 || c[i - 1] == ' ' || c[i - 1] == ';') {
      int fin = c.indexOf(';', i);
      if (fin < 0) fin = c.length();
      return c.substring(i + 8, fin);
    }
    i = c.indexOf("session=", i + 1);
  }
  return "";
}

bool sessionValide(const String &jeton, uint32_t maintenant) {
  if (jeton.length() != 32) return false;
  for (Session &se : g_sessions) {
    if (!se.jeton[0]) continue;
    if (expiree(se.expire, maintenant)) {
      se.jeton[0] = '\0';
      continue;
    }
    if (memeEmpreinte(jeton.c_str(), se.jeton)) {
      se.expire = maintenant + SESSION_MS;
      return true;
    }
  }
  return false;
}

Session &nouvelleSession(uint32_t maintenant) {
  Session *cible = &g_sessions[0];
  for (Session &se : g_sessions) {
    if (!se.jeton[0] || expiree(se.expire, maintenant)) {
      cible = &se;
      break;
    }
    if ((int32_t)(se.expire - cible->expire) < 0) cible = &se;  // la plus ancienne
  }
  aleatoireHex(cible->jeton, 16);
  cible->expire = maintenant + SESSION_MS;
  return *cible;
}

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

  if (sessionValide(cookieSession(), maintenant)) return AUTH_OK;

  const String entete = serveur.header("Authorization");
  if (entete.startsWith("Basic ")) {
    const String b64 = entete.substring(6);
    unsigned char clair[96];
    size_t taille = 0;
    if (mbedtls_base64_decode(clair, sizeof clair - 1, &taille, (const unsigned char *)b64.c_str(),
                              b64.length()) == 0) {
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
      // La page embarquée s'annonce par X-Terrarium et gère sa propre
      // connexion : lui renvoyer le défi Basic ferait surgir le dialogue du
      // navigateur par-dessus son formulaire. curl et les scripts, eux, l'ont.
      if (!serveur.hasHeader("X-Terrarium"))
        serveur.sendHeader("WWW-Authenticate", "Basic realm=\"Terrarium\"");
      serveur.send(401, "text/plain", "Authentification requise");
      return false;
  }
}

// GET /api/defi : un nonce à usage unique, valable deux minutes.
void routeDefi() {
  const ReglagesReseau &r = Stockage::reseau();
  if (r.webUtilisateur[0] == '\0' || r.webHachage[0] == '\0') {
    serveur.send(200, "application/json", "{\"libre\":true}");
    return;
  }
  const uint32_t maintenant = millis();
  Defi *cible = &g_defis[0];
  for (Defi &d : g_defis) {
    if (!d.valeur[0] || expiree(d.expire, maintenant)) {
      cible = &d;
      break;
    }
    if ((int32_t)(d.expire - cible->expire) < 0) cible = &d;
  }
  aleatoireHex(cible->valeur, 16);
  cible->expire = maintenant + DEFI_MS;
  serveur.send(200, "application/json",
               String("{\"libre\":false,\"defi\":\"") + cible->valeur + "\",\"utilisateur\":\"" +
                   echapperJson(r.webUtilisateur) + "\"}");
}

// POST /api/session : defi=<nonce>&preuve=<SHA-256(nonce:SHA-256(utilisateur:mot de passe))>
void routeSession() {
  const ReglagesReseau &r = Stockage::reseau();
  const uint32_t maintenant = millis();
  if (g_blocageAuth != 0 && (int32_t)(maintenant - g_blocageAuth) < 0) {
    serveur.send(429, "text/plain", "Trop de tentatives, reessayez dans une minute");
    return;
  }
  const String defi = serveur.arg("defi");
  String preuve = serveur.arg("preuve");
  preuve.toLowerCase();
  bool defiConnu = false;
  for (Defi &d : g_defis) {
    if (d.valeur[0] && !expiree(d.expire, maintenant) && defi == d.valeur) {
      defiConnu = true;
      d.valeur[0] = '\0';
      break;
    }
  }
  const bool ok = defiConnu && r.webHachage[0] &&
                  memeEmpreinte(hacher(defi + ":" + r.webHachage).c_str(), preuve.c_str());
  if (!ok) {
    if (++g_echecsAuth >= 5) {
      g_blocageAuth = maintenant + 60000UL;
      g_echecsAuth = 0;
      journal("Interface web : trop de tentatives de connexion, pause d'une minute");
    }
    serveur.send(401, "text/plain",
                 defiConnu ? "Identifiants refuses" : "Defi inconnu ou expire : recommencer");
    return;
  }
  g_echecsAuth = 0;
  const Session &se = nouvelleSession(maintenant);
  serveur.sendHeader("Set-Cookie",
                     String("session=") + se.jeton + "; Path=/; Max-Age=86400; HttpOnly; SameSite=Strict");
  serveur.send(200, "application/json", "{\"ok\":true}");
  journal("Interface web : session ouverte pour %s", r.webUtilisateur);
}

void routeDeconnexion() {
  const String j = cookieSession();
  for (Session &se : g_sessions)
    if (se.jeton[0] && j == se.jeton) se.jeton[0] = '\0';
  serveur.sendHeader("Set-Cookie", "session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict");
  serveur.send(200, "text/plain", "Deconnecte");
}

// Ces trois fonctions ne sont que l'habillage String des primitives testées sur
// PC (format.h) : la logique délicate — échappement JSON, analyse d'horaire —
// vit à un seul endroit, exercée par sim/test-format.cpp.
String hhmm(uint16_t minutes) {
  char b[8];
  formatHHMM(minutes, b, sizeof b);
  return String(b);
}

bool parseHHMM(const String &s, uint16_t &out) { return formatParseHHMM(s.c_str(), out); }

String echapperJson(const char *s) {
  // Le plus long champ échappable est une URL (161 octets) : deux fois cela
  // couvre le pire cas, où chaque octet devrait être préfixé.
  char b[336];
  formatEchapperJson(s, b, sizeof b);
  return String(b);
}

// Santé du socle : ce qui permet, à distance, de comprendre un comportement
// bizarre avant qu'il ne devienne une panne. Même corps pour /api/status, la
// réponse « etat » du canal de commande et le sujet MQTT « sante ».
String corpsSante() {
  String j;
  j.reserve(360);
  j += "\"proto\":" + String(PROTO_VERSION);
  j += ",\"version\":\"" FW_VERSION "\"";
  j += ",\"uptime\":" + String(millis() / 1000);
  j += ",\"rssi\":" + String(WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0);
  j += ",\"heap\":" + String(ESP.getFreeHeap());
  j += ",\"heapMin\":" + String(ESP.getMinFreeHeap());
  j += ",\"blocMax\":" + String(ESP.getMaxAllocHeap());
  j += ",\"reset\":\"" + echapperJson(raisonRedemarrage()) + "\"";
  j += ",\"otaEnAttente\":" + String(otaEnAttenteValidation() ? "true" : "false");
  j += ",\"signatureOta\":" + String(OTA_CLE_PUBLIQUE[0] ? "true" : "false");
  // Où joindre l'interface locale : le nom mDNS est propre à chaque socle, et
  // l'adresse IP sert quand le réseau bloque le mDNS.
  j += ",\"hote\":\"" + g_id + ".local\"";
  j += ",\"ip\":\"" + (g_connecte ? (g_ap ? WiFi.softAPIP() : WiFi.localIP()).toString() : String("")) + "\"";
  const EtatMaj &m = Stockage::etatMaj();
  if (m.etape != MAJ_AUCUNE) {
    j += ",\"maj\":{\"etape\":\"" + String(nomEtapeMaj(m.etape)) + "\",\"version\":\"" +
         echapperJson(m.version) + "\",\"detail\":\"" + echapperJson(m.detail) + "\"}";
  }
  if (resumePlantage()[0]) j += ",\"plantage\":\"" + echapperJson(resumePlantage()) + "\"";
  if (Courant::actif()) {
    j += ",\"courantA\":" + String(Courant::amperes(), 2);
    j += ",\"tensionV\":" + String(Courant::volts(), 1);
    j += ",\"energieWh\":" + String(Courant::wattheures(), 1);
    if (Courant::anomalie()[0]) j += ",\"anomalieCourant\":\"" + echapperJson(Courant::anomalie()) + "\"";
  }
  return j;
}

// --------------------------- routes ----------------------------------------
void routeRacine() {
  // La page est stockée compressée : trois fois moins de flash programme, et
  // un envoi d'autant plus court sur le WiFi. Tous les navigateurs décompressent.
  serveur.sendHeader("Content-Encoding", "gzip");
  serveur.send_P(200, "text/html; charset=utf-8", (PGM_P)PAGE_HTML_GZ, PAGE_HTML_GZ_LEN);
}

void routeStatus() {
  if (!autorise()) return;
  String j;
  j.reserve(1400);  // évite une dizaine de réallocations
  j += "{\"uptime\":" + String(millis() / 1000) + ",\"tapisActif\":" + String(ctrl.tapisActif()) +
       ",\"alertesEnAttente\":" + String(Stockage::alertesEnAttente()) +
       ",\"histHeures\":" + String(Stockage::histCapacite() / 60) + ",\"version\":\"" FW_VERSION "\"" +
       ",\"sante\":{" + corpsSante() + "}" +
       ",\"otaProtegee\":" + String(Stockage::reseau().otaMotDePasse[0] ? "true" : "false") +
       ",\"maintenanceS\":" + String(ctrl.maintenanceRestanteMs(millis()) / 1000) + ",\"heure\":\"" +
       (heureFiable() ? horodatage() + (heureApproximative() ? " (approx.)" : "")
                      : String("heure inconnue")) +
       "\",\"zones\":[";
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    const ZoneEtat &s = ctrl.zone[z];
    const ReglagesZone &c = ctrl.cfg[z];
    if (z) j += ",";
    j += "{\"nom\":\"" + echapperJson(c.nom) + "\"";
    j += ",\"temp\":" + String(isnan(s.temperature) ? 0.0f : s.temperature, 2);
    j += ",\"consigne\":" + String(isnan(s.consigneEff) ? c.consigneJour : s.consigneEff, 2);
    j += ",\"demande\":" + String((int)lroundf(s.demande * 100));
    j += ",\"duty\":" + String((int)lroundf(ctrl.duty(z)));
    j += ",\"chauffe\":" +
         String((ctrl.tapisActif() >= 0 && ZONE_DE_TAPIS[ctrl.tapisActif()] == z) ? "true" : "false");
    j += ",\"derive\":" + String(s.deriveActive ? "true" : "false");
    j += ",\"autotune\":" + String((s.autotune == AT_ATTENTE || s.autotune == AT_OSCILLE) ? "true" : "false");
    j += ",\"defaut\":" +
         (s.defaut == DEF_AUCUN ? String("null") : "\"" + String(nomDefaut(s.defaut)) + "\"");
    j += ",\"jour\":" + String(c.consigneJour, 1) + ",\"nuit\":" + String(c.consigneNuit, 1);
    j += ",\"bande\":" + String(c.bande, 2) + ",\"ki\":" + String(c.ki, 5);
    j += ",\"max\":" + String(c.tempMax, 1) + ",\"offset\":" + String(c.offset, 2);
    j += ",\"debutJour\":\"" + hhmm(c.debutJour) + "\",\"debutNuit\":\"" + hhmm(c.debutNuit) + "\"";
    j += ",\"rampe\":" + String(c.rampeMinutes);
    j += ",\"inefficaceMin\":" + String(c.inefficaceMinutes) +
         ",\"inefficaceDelta\":" + String(c.inefficaceDelta, 2);
    j += ",\"deriveSeuil\":" + String(c.deriveSeuil, 1) + ",\"deriveMin\":" + String(c.deriveMinutes);
    j += ",\"chuteSeuil\":" + String(c.chuteSeuil, 1) + ",\"chuteSecondes\":" + String(c.chuteSecondes) + "}";
  }
  j += "]}";
  serveur.send(200, "application/json", j);
}

// Historique diffusé par morceaux : construire la réponse entière en RAM
// saturerait le tas dès quelques heures de données. Le parcours garde le
// fichier ouvert du début à la fin.
struct CtxHist {
  String bloc;
  bool premier;
  bool csv;
};

bool visiteJson(const Echantillon &e, void *ctx) {
  CtxHist *c = (CtxHist *)ctx;
  if (e.epoch == 0)
    return true;  // point enregistré sans horloge : il
                  // casserait l'axe temporel du graphique
  if (!c->premier) c->bloc += ",";
  c->premier = false;
  c->bloc += "{\"e\":" + String(e.epoch);
  c->bloc += ",\"t0\":" + String(e.t[0] == -32768 ? -999.0f : e.t[0] / 100.0f, 2);
  c->bloc += ",\"t1\":" + String(e.t[1] == -32768 ? -999.0f : e.t[1] / 100.0f, 2);
  c->bloc += ",\"c0\":" + String(e.c[0] == -32768 ? -999.0f : e.c[0] / 100.0f, 2);
  c->bloc += ",\"c1\":" + String(e.c[1] == -32768 ? -999.0f : e.c[1] / 100.0f, 2) + "}";
  if (c->bloc.length() > 1200) {
    serveur.sendContent(c->bloc);
    c->bloc = "";
  }
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
  if (c->bloc.length() > 1200) {
    serveur.sendContent(c->bloc);
    c->bloc = "";
  }
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
  const uint32_t pas = (dispo > 900) ? (dispo / 900) : 1;  // ~900 points à l'écran

  serveur.setContentLength(CONTENT_LENGTH_UNKNOWN);
  serveur.send(200, "application/json", "");
  serveur.sendContent("{\"points\":[");
  CtxHist c;
  c.premier = true;
  c.csv = false;
  c.bloc.reserve(1500);
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
  serveur.sendContent(
      "epoch,date,zone1_temp,zone1_consigne,zone1_demande,zone2_temp,zone2_consigne,zone2_demande\n");
  CtxHist c;
  c.premier = true;
  c.csv = true;
  c.bloc.reserve(1500);
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
struct CtxHistMqtt {
  String bloc;
  uint16_t n;
  uint16_t maxi;
  size_t limite;
};

bool visiteHistMqtt(const Echantillon &e, void *ctx) {
  CtxHistMqtt *c = (CtxHistMqtt *)ctx;
  if (e.epoch == 0) return true;  // point sans horloge : inexploitable
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
  if (serveur.hasArg("courantAlimA")) n.courantAlimA = serveur.arg("courantAlimA").toFloat();
  if (serveur.hasArg("puissanceTapisW")) n.puissanceTapisW = serveur.arg("puissanceTapisW").toFloat();
  if (serveur.hasArg("tensionV")) n.tensionV = serveur.arg("tensionV").toFloat();
  if (serveur.hasArg("maintenanceMin")) n.maintenanceMin = (uint16_t)serveur.arg("maintenanceMin").toInt();
  if (serveur.hasArg("ecranVeilleMin")) n.ecranVeilleMin = (uint16_t)serveur.arg("ecranVeilleMin").toInt();
  if (serveur.hasArg("saisonDelta")) n.saisonDelta = serveur.arg("saisonDelta").toFloat();
  if (serveur.hasArg("saisonDescenteJ")) n.saisonDescenteJ = (uint16_t)serveur.arg("saisonDescenteJ").toInt();
  if (serveur.hasArg("saisonPlateauJ")) n.saisonPlateauJ = (uint16_t)serveur.arg("saisonPlateauJ").toInt();
  if (serveur.hasArg("saisonRemonteeJ")) n.saisonRemonteeJ = (uint16_t)serveur.arg("saisonRemonteeJ").toInt();

  char erreur[100];
  if (!Stockage::globauxValides(n, erreur, sizeof erreur)) {
    serveur.send(400, "text/plain", erreur);
    return;
  }

  // Le cyclage saisonnier a besoin d'une date de depart : sans horloge fiable,
  // il n'y a aucun moyen de savoir ou l'on en est dans le cycle.
  if (serveur.hasArg("saisonActive")) {
    const bool actif = serveur.arg("saisonActive").toInt() != 0;
    if (actif && !heureFiable()) {
      serveur.send(409, "text/plain", "Heure inconnue : impossible de dater le debut du cycle saisonnier");
      return;
    }
    if (actif && !n.saisonActive) n.saisonDebutEpoch = (uint32_t)time(nullptr);
    n.saisonActive = actif;
  }
  if (serveur.hasArg("saisonRedemarrer") && serveur.arg("saisonRedemarrer").toInt() != 0) {
    if (!heureFiable()) {
      serveur.send(409, "text/plain", "Heure inconnue");
      return;
    }
    n.saisonDebutEpoch = (uint32_t)time(nullptr);
  }

  Stockage::globaux() = n;
  Stockage::sauverGlobaux();
  appliquerReglagesGlobaux();
  journal("Reglages globaux modifies via l'interface web : %.1f A -> %u zone(s), saison %s", n.courantAlimA,
          ctrl.limiteZones(), n.saisonActive ? "active" : "inactive");
  serveur.send(200, "text/plain", "Enregistre : " + String(ctrl.limiteZones()) + " zone(s) simultanee(s).");
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

// --- signature des images -------------------------------------------------
// Quand une clé publique est compilée (config.h), /api/maj n'accepte qu'une
// image signée par la clé privée correspondante : <firmware><signature DER>
// <2 octets : longueur de la signature><"TERRASIG">, produite par
// outils/signer-firmware.js. Le flux arrive sans qu'on en connaisse la taille :
// on garde les derniers octets en réserve, on écrit et hache le reste au fil de
// l'eau, et c'est à la fin que la réserve révèle la signature.
const size_t RESERVE_SIG = 96;
struct VerifSignature {
  bool active = false;
  mbedtls_sha256_context sha;
  uint8_t reserve[RESERVE_SIG];
  size_t nReserve = 0;
} g_sig;

void signatureDebut() {
  g_sig.active = OTA_CLE_PUBLIQUE[0] != '\0';
  g_sig.nReserve = 0;
  if (!g_sig.active) return;
  mbedtls_sha256_init(&g_sig.sha);
  mbedtls_sha256_starts(&g_sig.sha, 0);
}

bool ecrireEtHacher(const uint8_t *b, size_t n) {
  if (n == 0) return true;
  if (g_sig.active) mbedtls_sha256_update(&g_sig.sha, b, n);
  return Update.write((uint8_t *)b, n) == n;
}

// Écrit tout sauf les RESERVE_SIG derniers octets vus jusqu'ici.
bool signatureEcrire(const uint8_t *b, size_t n) {
  if (!g_sig.active) return Update.write((uint8_t *)b, n) == n;
  const size_t total = g_sig.nReserve + n;
  if (total <= RESERVE_SIG) {
    memcpy(g_sig.reserve + g_sig.nReserve, b, n);
    g_sig.nReserve = total;
    return true;
  }
  size_t aVider = total - RESERVE_SIG;
  const size_t depuisReserve = aVider < g_sig.nReserve ? aVider : g_sig.nReserve;
  if (!ecrireEtHacher(g_sig.reserve, depuisReserve)) return false;
  memmove(g_sig.reserve, g_sig.reserve + depuisReserve, g_sig.nReserve - depuisReserve);
  g_sig.nReserve -= depuisReserve;
  aVider -= depuisReserve;
  if (!ecrireEtHacher(b, aVider)) return false;
  memcpy(g_sig.reserve + g_sig.nReserve, b + aVider, n - aVider);
  g_sig.nReserve += n - aVider;
  return true;
}

// Renvoie nullptr si l'image est acceptée (et écrite), sinon la raison du refus.
const char *signatureFin() {
  if (!g_sig.active) return Update.end(true) ? nullptr : Update.errorString();
  const uint8_t *r = g_sig.reserve;
  const size_t n = g_sig.nReserve;
  if (n < 10 || memcmp(r + n - 8, "TERRASIG", 8) != 0) {
    Update.abort();
    return "image non signee : refusee (cle publique compilee)";
  }
  const size_t tailleSig = (size_t)r[n - 10] | ((size_t)r[n - 9] << 8);
  const size_t remorque = tailleSig + 10;
  if (tailleSig < 8 || tailleSig > 80 || remorque > n) {
    Update.abort();
    return "signature malformee";
  }
  if (!ecrireEtHacher(r, n - remorque)) {
    Update.abort();
    return Update.errorString();
  }
  uint8_t empreinte[32];
  mbedtls_sha256_finish(&g_sig.sha, empreinte);
  mbedtls_sha256_free(&g_sig.sha);
  mbedtls_pk_context cle;
  mbedtls_pk_init(&cle);
  const char *verdict = nullptr;
  if (mbedtls_pk_parse_public_key(&cle, (const unsigned char *)OTA_CLE_PUBLIQUE,
                                  strlen(OTA_CLE_PUBLIQUE) + 1) != 0)
    verdict = "cle publique compilee illisible";
  else if (mbedtls_pk_verify(&cle, MBEDTLS_MD_SHA256, empreinte, sizeof empreinte, r + n - remorque,
                             tailleSig) != 0)
    verdict = "signature invalide : image refusee";
  mbedtls_pk_free(&cle);
  if (verdict) {
    Update.abort();
    return verdict;
  }
  return Update.end(true) ? nullptr : Update.errorString();
}

void routeMajFin() {
  if (!g_majAutorisee) {
    serveur.sendHeader("WWW-Authenticate", "Basic realm=\"Terrarium\"");
    serveur.send(401, "text/plain", g_majErreur[0] ? g_majErreur : "Authentification requise");
    return;
  }
  if (Update.hasError() || g_majErreur[0]) {
    couperChauffagePourMaj(false);
    journal("Mise a jour par le navigateur en echec : %s", g_majErreur[0] ? g_majErreur : "ecriture refusee");
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
    if (v == AUTH_EN_PAUSE) {
      snprintf(g_majErreur, sizeof g_majErreur, "Trop de tentatives");
      return;
    }
    if (v != AUTH_OK) {
      snprintf(g_majErreur, sizeof g_majErreur, "Authentification requise");
      return;
    }
    if (!serveur.hasHeader("X-Terrarium")) {
      snprintf(g_majErreur, sizeof g_majErreur, "Entete X-Terrarium manquant");
      return;
    }
    g_majAutorisee = true;

    // Le chauffage est coupé pendant toute l'écriture, broches comprises : une
    // mise à jour interrompue laisserait sinon un tapis alimenté sans
    // régulation derrière.
    couperChauffagePourMaj(true);
    journal("Mise a jour par le navigateur : reception de %s", u.filename.c_str());
    if (!Update.begin(UPDATE_SIZE_UNKNOWN)) {
      snprintf(g_majErreur, sizeof g_majErreur, "%s", Update.errorString());
      couperChauffagePourMaj(false);
    }
    signatureDebut();
    return;
  }

  if (!g_majAutorisee || g_majErreur[0]) return;

  if (u.status == UPLOAD_FILE_WRITE) {
    // Écrire un mégaoctet prend plusieurs secondes : sans cela le chien de garde
    // redémarrerait la carte au milieu de la mise à jour.
    esp_task_wdt_reset();
    if (!signatureEcrire(u.buf, u.currentSize))
      snprintf(g_majErreur, sizeof g_majErreur, "%s", Update.errorString());
  } else if (u.status == UPLOAD_FILE_END) {
    const char *refus = signatureFin();
    if (refus) snprintf(g_majErreur, sizeof g_majErreur, "%s", refus);
  } else if (u.status == UPLOAD_FILE_ABORTED) {
    Update.abort();
    snprintf(g_majErreur, sizeof g_majErreur, "Envoi interrompu");
    couperChauffagePourMaj(false);
  }
}

// Le coredump complet (format ELF) : à charger dans esp-coredump ou à joindre
// à un rapport de bogue. Lu directement dans la partition, par morceaux.
void routeCoredumpGet() {
  if (!autorise()) return;
#if AVEC_COREDUMP
  size_t adresse = 0, taille = 0;
  if (esp_core_dump_image_check() != ESP_OK || esp_core_dump_image_get(&adresse, &taille) != ESP_OK ||
      taille == 0) {
    serveur.send(404, "text/plain", "Aucun coredump en flash");
    return;
  }
  const esp_partition_t *part = esp_partition_find_first(ESP_PARTITION_TYPE_DATA,
                                                         ESP_PARTITION_SUBTYPE_DATA_COREDUMP, NULL);
  if (!part) {
    serveur.send(500, "text/plain", "Partition coredump absente");
    return;
  }
  serveur.setContentLength(taille);
  serveur.sendHeader("Content-Disposition", "attachment; filename=coredump.elf");
  serveur.send(200, "application/octet-stream", "");
  uint8_t bloc[512];
  for (size_t lu = 0; lu < taille; lu += sizeof bloc) {
    const size_t n = (taille - lu < sizeof bloc) ? taille - lu : sizeof bloc;
    if (esp_partition_read(part, lu, bloc, n) != ESP_OK) break;
    serveur.client().write(bloc, n);
    esp_task_wdt_reset();
  }
#else
  serveur.send(404, "text/plain", "Coredump non disponible sur cette compilation");
#endif
}

void routeCoredumpDelete() {
  if (!autorise()) return;
  if (!origineSure()) return;
#if AVEC_COREDUMP
  esp_core_dump_image_erase();
  journal("Coredump efface via l'interface web");
  serveur.send(200, "text/plain", "Coredump efface");
#else
  serveur.send(404, "text/plain", "Coredump non disponible");
#endif
}

void routeMaintenance() {
  if (!autorise()) return;
  if (!origineSure()) return;
  const uint16_t minutes = serveur.hasArg("minutes") ? (uint16_t)serveur.arg("minutes").toInt()
                                                     : Stockage::globaux().maintenanceMin;
  if (minutes > 240) {
    serveur.send(400, "text/plain", "Duree limitee a 240 min");
    return;
  }
  ctrl.maintenance(millis(), minutes);
  serveur.send(200, "text/plain", minutes ? "Chauffage coupe temporairement" : "Maintenance annulee");
}

void routeConfig() {
  if (!autorise()) return;
  if (!origineSure()) return;
  const int z = serveur.arg("z").toInt();
  if (z < 0 || z >= (int)NB_ZONES) {
    serveur.send(400, "text/plain", "Zone invalide");
    return;
  }

  ReglagesZone n = ctrl.cfg[z];
  if (serveur.hasArg("nom") && serveur.arg("nom").length() > 0)
    snprintf(n.nom, sizeof n.nom, "%s", serveur.arg("nom").c_str());
  if (serveur.hasArg("jour")) n.consigneJour = serveur.arg("jour").toFloat();
  if (serveur.hasArg("nuit")) n.consigneNuit = serveur.arg("nuit").toFloat();
  if (serveur.hasArg("bande")) n.bande = serveur.arg("bande").toFloat();
  if (serveur.hasArg("ki")) n.ki = serveur.arg("ki").toFloat();
  if (serveur.hasArg("max")) n.tempMax = serveur.arg("max").toFloat();
  if (serveur.hasArg("offset")) n.offset = serveur.arg("offset").toFloat();
  if (serveur.hasArg("rampe")) n.rampeMinutes = (uint16_t)serveur.arg("rampe").toInt();
  if (serveur.hasArg("inefficaceMin")) n.inefficaceMinutes = (uint16_t)serveur.arg("inefficaceMin").toInt();
  if (serveur.hasArg("inefficaceDelta")) n.inefficaceDelta = serveur.arg("inefficaceDelta").toFloat();
  if (serveur.hasArg("deriveSeuil")) n.deriveSeuil = serveur.arg("deriveSeuil").toFloat();
  if (serveur.hasArg("deriveMin")) n.deriveMinutes = (uint16_t)serveur.arg("deriveMin").toInt();
  if (serveur.hasArg("chuteSeuil")) n.chuteSeuil = serveur.arg("chuteSeuil").toFloat();
  if (serveur.hasArg("chuteSecondes")) n.chuteSecondes = (uint16_t)serveur.arg("chuteSecondes").toInt();
  if (serveur.hasArg("debutJour") && !parseHHMM(serveur.arg("debutJour"), n.debutJour)) {
    serveur.send(400, "text/plain", "Debut de jour invalide (HH:MM)");
    return;
  }
  if (serveur.hasArg("debutNuit") && !parseHHMM(serveur.arg("debutNuit"), n.debutNuit)) {
    serveur.send(400, "text/plain", "Debut de nuit invalide (HH:MM)");
    return;
  }

  // Mêmes règles que partout ailleurs : la validation vit dans le cœur de
  // régulation, pas dupliquée dans chaque interface.
  char erreur[100];
  if (!reglagesValides(n, erreur, sizeof erreur)) {
    serveur.send(400, "text/plain", erreur);
    return;
  }

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
  if (z < 0 || z >= (int)NB_ZONES) {
    serveur.send(400, "text/plain", "Zone invalide");
    return;
  }
  if (!ctrl.lancerAutotune((uint8_t)z, millis(), erreur, sizeof erreur)) {
    serveur.send(409, "text/plain", erreur);
    return;
  }
  serveur.send(200, "text/plain", "Autotune lance : la zone va osciller volontairement pendant ~1 h.");
}

void routeAutotuneStop() {
  if (!autorise()) return;
  if (!origineSure()) return;
  const int z = serveur.arg("z").toInt();
  if (z < 0 || z >= (int)NB_ZONES) {
    serveur.send(400, "text/plain", "Zone invalide");
    return;
  }
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
    serveur.send(400, "text/plain", "Parametres invalides");
    return;
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
  j += ",\"ntp\":\"" + echapperJson(r.ntp) + "\"";
  j += ",\"formatAlertes\":" + String(r.formatAlertes);
  j += ",\"signatureOta\":" + String(OTA_CLE_PUBLIQUE[0] ? "true" : "false");
  j += ",\"hote\":\"" + g_id + ".local\"";
  j += ",\"ssidPointAcces\":\"" + ssidPointAcces() + "\"";
  j += ",\"majModele\":" + String(MAJ_URL_MODELE[0] ? "true" : "false") + "}";
  serveur.send(200, "application/json", j);
}

void routeReseauPost() {
  if (!autorise()) return;
  if (!origineSure()) return;
  ReglagesReseau &r = Stockage::reseau();
// Le parametre s'appelle `cle` et non `arg` : `arg` serait aussi substitue
// dans `serveur.arg(...)`, ce qui casse la macro.
#define TXT(cle, champ) \
  if (serveur.hasArg(cle)) snprintf(r.champ, sizeof r.champ, "%s", serveur.arg(cle).c_str())
// Les mots de passe vides signifient « inchangé » : sans cette règle,
// enregistrer le formulaire effacerait des secrets qu'il n'affiche pas.
#define SECRET(cle, champ)                                  \
  if (serveur.hasArg(cle) && serveur.arg(cle).length() > 0) \
  snprintf(r.champ, sizeof r.champ, "%s", serveur.arg(cle).c_str())
  TXT("ssid", ssid);
  SECRET("wifiPass", motDePasse);
  TXT("webUser", webUtilisateur);
  if (serveur.hasArg("webPass") && serveur.arg("webPass").length() > 0) {
    const String u = serveur.hasArg("webUser") && serveur.arg("webUser").length() ? serveur.arg("webUser")
                                                                                  : String(r.webUtilisateur);
    snprintf(r.webHachage, sizeof r.webHachage, "%s", hacher(u + ":" + serveur.arg("webPass")).c_str());
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
  if (serveur.hasArg("mqttPort")) r.mqttPort = (uint16_t)serveur.arg("mqttPort").toInt();
  if (serveur.hasArg("heartbeatMin")) r.heartbeatMinutes = (uint16_t)serveur.arg("heartbeatMin").toInt();
  if (serveur.hasArg("ha")) r.decouverteHA = serveur.arg("ha").toInt() != 0;
  if (serveur.hasArg("mqttTls")) r.mqttTls = serveur.arg("mqttTls").toInt() != 0;
  if (serveur.hasArg("verifierTls")) r.verifierTls = serveur.arg("verifierTls").toInt() != 0;
  if (serveur.hasArg("formatAlertes"))
    r.formatAlertes = serveur.arg("formatAlertes").toInt() == ALERTES_TEXTE ? ALERTES_TEXTE : ALERTES_JSON;
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
  m += "# HELP terrarium_temperature_celsius Temperature mesuree\n# TYPE terrarium_temperature_celsius "
       "gauge\n";
  for (uint8_t z = 0; z < NB_ZONES; z++)
    if (!isnan(ctrl.zone[z].temperature))
      m += "terrarium_temperature_celsius{zone=\"" + String(z + 1) + "\"} " +
           String(ctrl.zone[z].temperature, 2) + "\n";
  m += "# TYPE terrarium_consigne_celsius gauge\n";
  for (uint8_t z = 0; z < NB_ZONES; z++)
    if (!isnan(ctrl.zone[z].consigneEff))
      m += "terrarium_consigne_celsius{zone=\"" + String(z + 1) + "\"} " +
           String(ctrl.zone[z].consigneEff, 2) + "\n";
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
         String(secondesChauffeTotales(z) / 3600.0f * Stockage::globaux().puissanceTapisW / 1000.0f, 4) +
         "\n";
  m += "# TYPE terrarium_info gauge\nterrarium_info{version=\"" FW_VERSION "\"} 1\n";
  m += "# TYPE terrarium_uptime_seconds counter\nterrarium_uptime_seconds " + String(millis() / 1000) + "\n";
  m += "# TYPE terrarium_heap_libre_octets gauge\nterrarium_heap_libre_octets " + String(ESP.getFreeHeap()) +
       "\n";
  serveur.send(200, "text/plain; version=0.0.4", m);
}

// --------------------------- MQTT ------------------------------------------
String sujetBase() { return String(Stockage::reseau().mqttPrefixe) + "/" + g_id; }

// --------------------------- mise à jour tirée depuis une URL ----------------
// L'action « maj » du canal de commande (ou la console, ou /api/maj-distante)
// fait télécharger une image par le socle lui-même : HTTPS avec le magasin
// d'autorités du paquet ESP32, redirections de GitHub suivies, signature
// vérifiée si une clé est compilée, puis redémarrage sur la nouvelle image —
// qui ne sera validée qu'après OTA_VALIDATION_MS (retour arrière sinon). C'est
// ce qui permet de mettre à jour un parc entier depuis l'application, socle par
// socle, sans câble ni réseau local.

void publierMaj(const char *etat, int pct, const char *detail) {
  if (!mqtt.connected()) return;
  String j = "{\"etat\":\"" + String(etat) + "\"";
  if (pct >= 0) j += ",\"pct\":" + String(pct);
  if (detail && detail[0]) j += ",\"detail\":\"" + echapperJson(detail) + "\"";
  j += ",\"version\":\"" FW_VERSION "\"}";
  mqtt.publish((sujetBase() + "/maj").c_str(), j.c_str());
  mqtt.loop();
}

// Un jeton d'appairage volé ne doit pas suffire à faire charger un firmware
// hébergé n'importe où : l'URL demandée doit commencer par un préfixe de
// MAJ_ORIGINES_AUTORISEES, et chaque redirection par un de MAJ_HOTES_AUTORISES.
bool hoteAutorise(const String &url, const char *liste) {
  while (*liste) {
    const char *fin = strchr(liste, ',');
    const size_t n = fin ? (size_t)(fin - liste) : strlen(liste);
    if (n && url.length() >= n && strncmp(url.c_str(), liste, n) == 0) return true;
    if (!fin) break;
    liste = fin + 1;
  }
  return false;
}

// Chiffres et points seulement : c'est ce qui est injecté dans MAJ_URL_MODELE.
bool versionValide(const String &v) {
  if (v.length() < 5 || v.length() > 15) return false;
  uint8_t points = 0;
  for (unsigned i = 0; i < v.length(); i++) {
    const char c = v[i];
    if (c == '.') {
      points++;
      continue;
    }
    if (c < '0' || c > '9') return false;
  }
  return points == 2 && v[0] != '.' && v[v.length() - 1] != '.';
}

void noterMaj(uint8_t etape, const char *version, const char *detail) {
  EtatMaj &m = Stockage::etatMaj();
  m.etape = etape;
  snprintf(m.version, sizeof m.version, "%s", version);
  snprintf(m.detail, sizeof m.detail, "%s", detail);
  Stockage::sauverEtatMaj();
}

// Télécharge et écrit une image. Bloquant (quelques dizaines de secondes, le
// chien de garde est nourri à chaque bloc) : le chauffage est coupé avant,
// l'appareil redémarre après. false et `erreur` renseignée en cas de refus.
bool majDepuisUrl(const String &url, char *erreur, size_t taille) {
  erreur[0] = '\0';
  if (!g_connecte || g_ap) {
    snprintf(erreur, taille, "hors ligne");
    return false;
  }
  if (otaEnCours) {
    snprintf(erreur, taille, "mise a jour deja en cours");
    return false;
  }
  if (!url.startsWith("https://")) {
    snprintf(erreur, taille, "URL https exigee");
    return false;
  }
  if (!hoteAutorise(url, MAJ_ORIGINES_AUTORISEES)) {
    snprintf(erreur, taille, "hote non autorise (MAJ_ORIGINES_AUTORISEES)");
    return false;
  }

  WiFiClientSecure securise;
  if (Stockage::reseau().verifierTls)
    securise.setCACertBundle(rootca_crt_bundle_start,
                             (size_t)(rootca_crt_bundle_end - rootca_crt_bundle_start));
  else
    securise.setInsecure();
  securise.setTimeout(10);
  HTTPClient http;
  http.setConnectTimeout(8000);
  http.setTimeout(10000);
  // Les redirections sont suivies à la main : HTTPClient irait n'importe où,
  // alors que seuls les serveurs d'objets de GitHub sont admis.
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
  const char *entetesSuivis[] = { "Location" };
  http.collectHeaders(entetesSuivis, 1);
  http.setUserAgent("terrarium/" FW_VERSION);

  journal("Mise a jour distante : %s", url.c_str());
  publierMaj("telechargement", 0, nullptr);
  String courante = url;
  int code = 0;
  for (uint8_t saut = 0;; saut++) {
    if (!http.begin(securise, courante)) {
      snprintf(erreur, taille, "URL illisible");
      return false;
    }
    code = http.GET();
    const bool redirection = code == HTTP_CODE_MOVED_PERMANENTLY || code == HTTP_CODE_FOUND ||
                             code == HTTP_CODE_SEE_OTHER || code == HTTP_CODE_TEMPORARY_REDIRECT ||
                             code == HTTP_CODE_PERMANENT_REDIRECT;
    if (!redirection) break;
    const String suivante = http.header("Location");
    http.end();
    if (saut >= 5) {
      snprintf(erreur, taille, "trop de redirections");
      return false;
    }
    if (!suivante.startsWith("https://") || !hoteAutorise(suivante, MAJ_HOTES_AUTORISES)) {
      snprintf(erreur, taille, "redirection hors des hotes autorises");
      return false;
    }
    courante = suivante;
  }
  if (code != HTTP_CODE_OK) {
    http.end();
    snprintf(erreur, taille, "HTTP %d", code);
    return false;
  }
  const int longueur = http.getSize();  // -1 si le serveur ne la donne pas

  couperChauffagePourMaj(true);
  if (!Update.begin(longueur > 0 ? (size_t)longueur : UPDATE_SIZE_UNKNOWN)) {
    snprintf(erreur, taille, "%s", Update.errorString());
    http.end();
    couperChauffagePourMaj(false);
    return false;
  }
  signatureDebut();

  WiFiClient *flux = http.getStreamPtr();
  uint8_t tampon[2048];
  size_t recu = 0;
  int dernierDizaine = -1;
  uint32_t dernierOctet = millis();
  while (http.connected() && (longueur < 0 || recu < (size_t)longueur)) {
    esp_task_wdt_reset();
    const size_t dispo = flux->available();
    if (!dispo) {
      if (millis() - dernierOctet > 15000) {
        snprintf(erreur, taille, "telechargement interrompu");
        break;
      }
      delay(5);
      continue;
    }
    const size_t n = flux->readBytes(tampon, dispo < sizeof tampon ? dispo : sizeof tampon);
    if (!n) continue;
    dernierOctet = millis();
    if (!signatureEcrire(tampon, n)) {
      snprintf(erreur, taille, "%s", Update.errorString());
      break;
    }
    recu += n;
    if (longueur > 0) {
      const int dizaine = (int)(recu * 10 / (size_t)longueur);
      if (dizaine != dernierDizaine) {
        dernierDizaine = dizaine;
        publierMaj("telechargement", dizaine * 10, nullptr);
      }
    }
  }
  http.end();

  if (erreur[0]) {
    Update.abort();
    couperChauffagePourMaj(false);
    return false;
  }
  if (longueur > 0 && recu != (size_t)longueur) {
    Update.abort();
    couperChauffagePourMaj(false);
    snprintf(erreur, taille, "image incomplete (%u/%d octets)", (unsigned)recu, longueur);
    return false;
  }
  const char *refus = signatureFin();
  if (refus) {
    couperChauffagePourMaj(false);
    snprintf(erreur, taille, "%s", refus);
    return false;
  }
  journal("Mise a jour distante ecrite (%u octets), redemarrage", (unsigned)recu);
  return true;
}

// Point d'entrée commun aux trois chemins (commande MQTT, console, route HTTP).
// Ne revient que si la mise à jour est refusée : sinon l'appareil redémarre.
void lancerMaj(const String &urlOuVersion, char *erreur, size_t taille) {
  String url = urlOuVersion;
  String version = "";
  if (!url.startsWith("https://")) {
    version = url;
    if (!versionValide(version)) {
      snprintf(erreur, taille, "url https ou version X.Y.Z attendue");
      return;
    }
    if (!MAJ_URL_MODELE[0]) {
      snprintf(erreur, taille, "aucun modele d'URL compile (MAJ_URL_MODELE)");
      return;
    }
    char b[240];
    // Socle exigeant des images signées : l'asset .signe.bin de la release.
    snprintf(b, sizeof b, OTA_CLE_PUBLIQUE[0] ? MAJ_URL_MODELE_SIGNE : MAJ_URL_MODELE, version.c_str(),
             version.c_str());
    url = b;
  }
  noterMaj(MAJ_EN_VALIDATION, version.length() ? version.c_str() : "?", "telechargement en cours");
  if (!majDepuisUrl(url, erreur, taille)) {
    noterMaj(MAJ_ECHEC, version.length() ? version.c_str() : "?", erreur);
    journal("Mise a jour distante refusee : %s", erreur);
    publierMaj("erreur", -1, erreur);
    return;
  }
  noterMaj(MAJ_EN_VALIDATION, version.length() ? version.c_str() : "?", "image ecrite, redemarrage");
  publierMaj("redemarrage", 100, nullptr);
  delay(300);
  ESP.restart();
}

void routeMajDistante() {
  if (!autorise()) return;
  if (!origineSure()) return;
  const String cible = serveur.hasArg("url") ? serveur.arg("url") : serveur.arg("version");
  if (!cible.length()) {
    serveur.send(400, "text/plain", "Parametre url ou version attendu");
    return;
  }
  // La réponse part avant le téléchargement, qui bloque jusqu'au redémarrage ;
  // un refus se lit ensuite dans /api/status (sante.maj).
  serveur.send(200, "text/plain",
               "Telechargement lance. Si tout va bien, la page revient dans ~1 min ; sinon, l'onglet "
               "Appareil dit pourquoi.");
  serveur.client().flush();
  delay(50);
  char erreur[96];
  lancerMaj(cible, erreur, sizeof erreur);
}

// Canal de commande générique : une seule paire de sujets transporte du JSON,
// plutôt qu'un sujet par réglage. La surface exposée est celle de l'API web, ce
// qui permet à une application distante de tout piloter sans que le firmware
// ait à connaître cette application.
//
//   requête  -> <prefixe>/<id>/cmd      {"req":"42","action":"...","jeton":"..."}
//   réponse  -> <prefixe>/<id>/reponse  {"req":"42","ok":true,...}
//
// L'analyse, le jeton, les bornes et la mémoire des réponses récentes vivent
// dans protocole.cpp, sans Arduino, testés et fuzzés sur PC. Ce qui suit est
// l'implémentation de ce que le canal demande au reste du firmware.
void copier(char *out, size_t taille, const String &s) { snprintf(out, taille, "%s", s.c_str()); }

class SocleReel : public Protocole::Socle {
public:
  const char *jeton() override { return Stockage::reseau().jeton; }
  void repondre(const char *json) override { mqtt.publish((sujetBase() + "/reponse").c_str(), json); }

  void corpsVersion(char *out, size_t taille) override {
    snprintf(out, taille, "\"version\":\"" FW_VERSION "\",\"compile\":\"" FW_BUILD "\",\"proto\":%d",
             PROTO_VERSION);
  }

  void corpsEtat(char *out, size_t taille) override {
    String d = "\"zones\":[";
    for (uint8_t z = 0; z < NB_ZONES; z++) {
      if (z) d += ",";
      d += "{\"nom\":\"" + echapperJson(ctrl.cfg[z].nom) + "\"";
      d += ",\"temp\":" + String(isnan(ctrl.zone[z].temperature) ? 0.0f : ctrl.zone[z].temperature, 2);
      d += ",\"consigne\":" + String(isnan(ctrl.zone[z].consigneEff) ? 0.0f : ctrl.zone[z].consigneEff, 2);
      d += ",\"demande\":" + String((int)lroundf(ctrl.zone[z].demande * 100));
      d += ",\"charge\":" + String((int)lroundf(ctrl.duty(z)));
      d += ",\"chauffe\":" + String(ctrl.tapisDeZone(z) >= 0 ? "true" : "false");
      d += ",\"autotune\":" +
           String((ctrl.zone[z].autotune == AT_ATTENTE || ctrl.zone[z].autotune == AT_OSCILLE) ? "true"
                                                                                               : "false");
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
      d += ",\"defaut\":" +
           (ctrl.zone[z].defaut == DEF_AUCUN ? String("null")
                                             : "\"" + String(nomDefaut(ctrl.zone[z].defaut)) + "\"") +
           "}";
    }
    d += "],\"uptime\":" + String(millis() / 1000);
    d += ",\"entretienS\":" + String(ctrl.maintenanceRestanteMs(millis()) / 1000);
    d += ",\"heure\":\"" + (::heureFiable() ? horodatage() : String("")) + "\"";
    d += ",\"zonesSimultanees\":" + String(ctrl.limiteZones());
    d += ",\"saison\":" + String(ctrl.decalageSaison(), 2);
    d += ",\"alertesEnAttente\":" + String(Stockage::alertesEnAttente());
    d += ",\"proto\":" + String(PROTO_VERSION);
    d += ",\"sante\":{" + corpsSante() + "}";
    copier(out, taille, d);
  }

  void corpsStats(char *out, size_t taille) override { copier(out, taille, ::corpsStats()); }

  void corpsHistorique(uint32_t heures, uint16_t maxi, char *out, size_t taille) override {
    const uint32_t total = Stockage::histNombre();
    const uint32_t voulus = heures * 60;
    const uint32_t debut = (total > voulus) ? total - voulus : 0;
    const uint32_t dispo = total - debut;
    const uint32_t pas = (dispo > maxi) ? (dispo / maxi) : 1;
    CtxHistMqtt c;
    c.n = 0;
    c.maxi = maxi;
    // Marge sous la taille du tampon MQTT pour l'enveloppe de la réponse.
    c.limite = 6500;
    c.bloc.reserve(1600);
    Stockage::histParcourir(debut, pas, visiteHistMqtt, &c);
    String d = "\"format\":[\"epoch\",\"t1\",\"consigne1\",\"t2\",\"consigne2\"]";
    d += ",\"unite\":\"centiemes de degre\"";
    d += ",\"pas\":" + String(pas) + ",\"heures\":" + String(heures);
    d += ",\"n\":" + String(c.n);
    d += ",\"points\":[" + c.bloc + "]";
    copier(out, taille, d);
  }

  void corpsGlobaux(char *out, size_t taille) override {
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
    copier(out, taille, d);
  }

  ReglagesZone &zone(uint8_t z) override { return ctrl.cfg[z]; }
  void sauverZone(uint8_t z) override {
    Stockage::sauverZone(z, ctrl.cfg[z]);
    ::journal("Zone %d modifiee via le canal de commande", z + 1);
    Reseau::publierMqtt(true);
  }
  ReglagesGlobaux &globaux() override { return Stockage::globaux(); }
  void sauverGlobaux() override {
    Stockage::sauverGlobaux();
    appliquerReglagesGlobaux();
  }
  bool heureFiable() override { return ::heureFiable(); }
  uint32_t epoch() override { return (uint32_t)time(nullptr); }
  uint8_t limiteZones() override { return ctrl.limiteZones(); }

  void leverDefauts() override {
    ctrl.leverDefauts(millis());
    uint8_t d[NB_ZONES] = { DEF_AUCUN, DEF_AUCUN };
    Stockage::sauverDefauts(d);
  }
  void entretien(uint16_t minutes) override { ctrl.maintenance(millis(), minutes); }
  bool lancerAutotune(uint8_t z, char *erreur, size_t taille) override {
    return ctrl.lancerAutotune(z, millis(), erreur, taille);
  }
  void arreterAutotune(uint8_t z) override { ctrl.arreterAutotune(z); }
  void effacerHistorique() override { Stockage::histEffacer(); }
  void redemarrer() override {
    mqtt.loop();
    delay(200);
    ESP.restart();
  }

  bool majAcceptable(const char *url, const char *version, bool forcer, char *erreur,
                     size_t taille) override {
    if (version[0] && strcmp(version, FW_VERSION) == 0 && !forcer) {
      snprintf(erreur, taille, "deja en " FW_VERSION);
      return false;
    }
    if (!url[0] && !versionValide(version)) {
      snprintf(erreur, taille, "version invalide");
      return false;
    }
    if (url[0] && !hoteAutorise(url, MAJ_ORIGINES_AUTORISEES)) {
      snprintf(erreur, taille, "hote non autorise");
      return false;
    }
    if (!g_connecte || g_ap) {
      snprintf(erreur, taille, "hors ligne");
      return false;
    }
    return true;
  }
  void lancerMaj(const char *cible) override {
    mqtt.loop();
    char erreur[96];
    ::lancerMaj(String(cible), erreur, sizeof erreur);  // ne revient qu'en cas de refus
  }
  void journal(const char *texte) override { ::journal("%s", texte); }
};
SocleReel g_socle;

void rappelMqtt(char *sujet, uint8_t *charge, unsigned int taille) {
  const String s(sujet);
  String v;
  v.reserve(taille + 1);
  for (unsigned int i = 0; i < taille; i++) v += (char)charge[i];

  if (s == sujetBase() + "/cmd") {
    Protocole::traiterCommande(g_socle, (const char *)charge, taille);
    return;
  }

  // Sujets simples conservés pour la découverte Home Assistant.
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    const String prefixe = sujetBase() + "/zone" + String(z + 1);
    ReglagesZone n = ctrl.cfg[z];
    bool touche = false;
    if (s == prefixe + "/consigne_jour/set") {
      n.consigneJour = v.toFloat();
      touche = true;
    }
    if (s == prefixe + "/consigne_nuit/set") {
      n.consigneNuit = v.toFloat();
      touche = true;
    }
    if (!touche) continue;
    char err[100];
    if (!reglagesValides(n, err, sizeof err)) {
      journal("MQTT refuse pour zone %u : %s", z + 1, err);
      return;
    }
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
  const String dev = "\"device\":{\"identifiers\":[\"" + g_id +
                     "\"],\"name\":\"Terrarium\","
                     "\"manufacturer\":\"DIY\",\"model\":\"ESP32 thermostat\"},"
                     "\"availability_topic\":\"" +
                     base + "/statut\"";
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    const String zt = base + "/zone" + String(z + 1);
    const String uid = g_id + "_z" + String(z + 1);
    String cfg;

    cfg = "{\"name\":\"Temperature zone " + String(z + 1) + "\",\"unique_id\":\"" + uid +
          "_temp\","
          "\"state_topic\":\"" +
          zt +
          "/etat\",\"value_template\":\"{{ value_json.temp }}\","
          "\"unit_of_measurement\":\"°C\",\"device_class\":\"temperature\"," +
          dev + "}";
    mqtt.publish(("homeassistant/sensor/" + uid + "_temp/config").c_str(), cfg.c_str(), true);

    cfg = "{\"name\":\"Consigne zone " + String(z + 1) + "\",\"unique_id\":\"" + uid +
          "_cons\","
          "\"state_topic\":\"" +
          zt +
          "/etat\",\"value_template\":\"{{ value_json.consigne }}\","
          "\"unit_of_measurement\":\"°C\",\"device_class\":\"temperature\"," +
          dev + "}";
    mqtt.publish(("homeassistant/sensor/" + uid + "_cons/config").c_str(), cfg.c_str(), true);

    cfg = "{\"name\":\"Chauffage zone " + String(z + 1) + "\",\"unique_id\":\"" + uid +
          "_heat\","
          "\"state_topic\":\"" +
          zt +
          "/etat\",\"value_template\":\"{{ value_json.chauffe }}\","
          "\"payload_on\":\"1\",\"payload_off\":\"0\",\"device_class\":\"heat\"," +
          dev + "}";
    mqtt.publish(("homeassistant/binary_sensor/" + uid + "_heat/config").c_str(), cfg.c_str(), true);

    cfg = "{\"name\":\"Defaut zone " + String(z + 1) + "\",\"unique_id\":\"" + uid +
          "_pb\","
          "\"state_topic\":\"" +
          zt +
          "/etat\",\"value_template\":\"{{ value_json.defaut }}\","
          "\"payload_on\":\"1\",\"payload_off\":\"0\",\"device_class\":\"problem\"," +
          dev + "}";
    mqtt.publish(("homeassistant/binary_sensor/" + uid + "_pb/config").c_str(), cfg.c_str(), true);

    cfg = "{\"name\":\"Consigne jour zone " + String(z + 1) + "\",\"unique_id\":\"" + uid +
          "_setj\","
          "\"state_topic\":\"" +
          zt +
          "/etat\",\"value_template\":\"{{ value_json.jour }}\","
          "\"command_topic\":\"" +
          zt +
          "/consigne_jour/set\",\"min\":10,\"max\":45,\"step\":0.5,"
          "\"unit_of_measurement\":\"°C\",\"mode\":\"box\"," +
          dev + "}";
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
      else
        clientMqttTls.setInsecure();
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
    const bool ok = r.mqttUtilisateur[0] ? mqtt.connect(g_id.c_str(), r.mqttUtilisateur, r.mqttMotDePasse,
                                                        statut.c_str(), 0, true, "hors ligne")
                                         : mqtt.connect(g_id.c_str(), statut.c_str(), 0, true, "hors ligne");
    if (!ok) return;
    mqtt.publish(statut.c_str(), "en ligne", true);
    mqtt.subscribe((sujetBase() + "/cmd").c_str());
    g_haPublie = false;
    journal("MQTT connecte a %s", r.mqttHote);
  }
  mqtt.loop();
  if (!g_haPublie) publierDecouverteHA();
  Reseau::publierMqtt();  // ne publie que ce qui a changé
  if (maintenant - g_dernierMqtt >= PERIODE_SANTE_MS) {
    g_dernierMqtt = maintenant;
    mqtt.publish((sujetBase() + "/sante").c_str(), ("{" + corpsSante() + "}").c_str(), true);
  }
}

// --------------------------- envois HTTP ------------------------------------
// Extrait un champ texte « "cle":"valeur" » d'une alerte JSON écrite par alerter().
String champAlerte(const String &json, const char *cle) {
  const String motif = String("\"") + cle + "\":\"";
  const int debut = json.indexOf(motif);
  if (debut < 0) return "";
  const int apres = debut + motif.length();
  String v;
  for (unsigned i = apres; i < json.length(); i++) {
    const char c = json[i];
    if (c == '\\' && i + 1 < json.length()) {
      v += json[++i];
      continue;
    }
    if (c == '"') break;
    v += c;
  }
  return v;
}

// Gère http et https : sans client TLS explicite, toute URL https échouerait
// silencieusement — c'est-à-dire précisément les webhooks les plus courants.
bool envoyerHttp(const char *url, const String &corps, bool post,
                 const char *typeContenu = "text/plain; charset=utf-8", const char *titre = nullptr,
                 const char *priorite = nullptr) {
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
    else
      securise.setInsecure();
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
  // En-têtes compris par ntfy et consorts : titre, priorité, étiquette. Les
  // serveurs qui ne les connaissent pas les ignorent.
  if (titre) http.addHeader("Title", titre);
  if (priorite) {
    http.addHeader("Priority", priorite);
    http.addHeader("Tags", strcmp(priorite, "high") == 0 ? "warning" : "information_source");
  }
  const int code = post ? http.POST(corps) : http.GET();
  http.end();
  return code > 0 && code < 400;
}

void gererEnvois(uint32_t maintenant) {
  if (!g_connecte || g_ap) return;

  String alerte;
  const bool aEnvoyer = Stockage::alerteTete(alerte);
  const bool tempoEcoulee = !g_attenteAlerte || (int32_t)(maintenant - g_prochaineAlerte) >= 0;
  if (tempoEcoulee) g_attenteAlerte = false;

  if (aEnvoyer && tempoEcoulee) {
    bool envoye;
    if (Stockage::reseau().urlAlertes[0] == '\0') {
      Stockage::alerteDefiler();  // alertes désactivées : on purge
      return;
    } else if (Stockage::reseau().formatAlertes == ALERTES_TEXTE) {
      // Lisible tel quel sur un téléphone : « [Point chaud] Sonde absente… »
      const String type = champAlerte(alerte, "type"), zone = champAlerte(alerte, "nomZone");
      const bool urgent = (type == "DEFAUT" || type == "CHUTE" || type == "SANS_EFFET" ||
                           type == "SONDE_FIGEE");
      String corps = (zone.length() ? "[" + zone + "] " : String("")) + champAlerte(alerte, "texte");
      const String titre = String("Terrarium ") + g_id + (urgent ? " — alerte" : "");
      envoye = envoyerHttp(Stockage::reseau().urlAlertes, corps, true, "text/plain; charset=utf-8",
                           titre.c_str(), urgent ? "high" : "default");
    } else {
      envoye = envoyerHttp(Stockage::reseau().urlAlertes, alerte, true, "application/json; charset=utf-8");
    }
    if (envoye) {
      Stockage::alerteDefiler();
      g_echecsAlerte = 0;
    } else if (++g_echecsAlerte >= MAX_ECHECS_ALERTE) {
      // On abandonne cette alerte plutôt que de bloquer indéfiniment la file
      // derrière elle. L'abandon est tracé : il ne disparaît pas en silence.
      Stockage::alerteDefiler();
      g_echecsAlerte = 0;
      journal("Alerte abandonnee apres %u tentatives : %s", (unsigned)MAX_ECHECS_ALERTE, alerte.c_str());
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

// --------------------------- point d'accès de configuration -----------------
// Un SSID par socle : deux appareils neufs allumés côte à côte doivent rester
// distinguables. Le suffixe est celui de l'identifiant (terraA1B2C3 → A1B2C3).
String ssidPointAcces() { return "terrarium-config-" + g_id.substring(5); }

void ouvrirPointAcces() {
  WiFi.mode(WIFI_AP);
  WiFi.softAP(ssidPointAcces().c_str(), Stockage::reseau().apMotDePasse);
  // Toute résolution de nom renvoie vers le socle : c'est ce qui fait apparaître
  // la page de configuration toute seule sur le téléphone (portail captif).
  g_dns.setErrorReplyCode(DNSReplyCode::NoError);
  g_dns.start(53, "*", WiFi.softAPIP());
  g_ap = true;
  g_connecte = true;
}

// --------------------------- démarrage des services -------------------------
void lancerServices() {
  const ReglagesReseau &r = Stockage::reseau();

  // Un nom par socle (terraA1B2C3.local) : avec « terrarium.local » pour tous,
  // deux socles sur le même réseau se masquaient l'un l'autre.
  MDNS.begin(g_id.c_str());
  MDNS.addService("http", "tcp", 80);
  MDNS.addServiceTxt("http", "tcp", "modele", "socle-chauffant");
  MDNS.addServiceTxt("http", "tcp", "version", FW_VERSION);

  serveur.on("/", HTTP_GET, routeRacine);
  serveur.on("/api/defi", HTTP_GET, routeDefi);
  serveur.on("/api/session", HTTP_POST, routeSession);
  serveur.on("/api/deconnexion", HTTP_POST, routeDeconnexion);
  serveur.on("/api/status", HTTP_GET, routeStatus);
  serveur.on("/api/history", HTTP_GET, routeHistory);
  serveur.on("/api/history.csv", HTTP_GET, routeHistoryCsv);
  serveur.on("/api/history", HTTP_DELETE, routeHistoryDelete);
  serveur.on("/api/config", HTTP_POST, routeConfig);
  serveur.on("/api/reset", HTTP_POST, routeReset);
  serveur.on("/api/autotune", HTTP_POST, routeAutotune);
  serveur.on("/api/autotune", HTTP_DELETE, routeAutotuneStop);
  serveur.on("/api/globaux", HTTP_GET, routeGlobauxGet);
  serveur.on("/api/globaux", HTTP_POST, routeGlobauxPost);
  serveur.on("/api/redemarrer", HTTP_POST, routeRedemarrer);
  serveur.on("/api/maj", HTTP_POST, routeMajFin, routeMajFragment);
  serveur.on("/api/maj-distante", HTTP_POST, routeMajDistante);
  serveur.on("/api/sondes", HTTP_GET, routeSondesGet);
  serveur.on("/api/sondes", HTTP_POST, routeSondesPost);
  serveur.on("/api/reseau", HTTP_GET, routeReseauGet);
  serveur.on("/api/reseau", HTTP_POST, routeReseauPost);
  serveur.on("/api/journal", HTTP_GET, routeJournalGet);
  serveur.on("/api/journal", HTTP_DELETE, routeJournalDelete);
  serveur.on("/api/stats", HTTP_GET, routeStats);
  serveur.on("/api/maintenance", HTTP_POST, routeMaintenance);
  serveur.on("/api/coredump", HTTP_GET, routeCoredumpGet);
  serveur.on("/api/coredump", HTTP_DELETE, routeCoredumpDelete);
  serveur.on("/metrics", HTTP_GET, routeMetrics);
  // Application installable : manifeste et agent de service minimal.
  serveur.on("/manifest.json", HTTP_GET, []() {
    serveur.send(200, "application/manifest+json",
                 "{\"name\":\"Thermostat terrarium\",\"short_name\":\"Terrarium\","
                 "\"start_url\":\"/\",\"display\":\"standalone\",\"background_color\":\"#f3f5f7\","
                 "\"theme_color\":\"#f3f5f7\",\"icons\":[{\"src\":\"/icone.svg\",\"sizes\":\"any\","
                 "\"type\":\"image/svg+xml\",\"purpose\":\"any\"}]}");
  });
  serveur.on("/icone.svg", HTTP_GET, []() {
    serveur.send(200, "image/svg+xml",
                 "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'>"
                 "<rect width='512' height='512' rx='112' fill='#15803d'/>"
                 "<rect x='206' y='60' width='100' height='280' rx='50' fill='#fff' fill-opacity='.94'/>"
                 "<circle cx='256' cy='376' r='94' fill='#fff' fill-opacity='.94'/>"
                 "<rect x='237' y='128' width='38' height='224' fill='#f59e0b'/>"
                 "<circle cx='256' cy='376' r='54' fill='#f59e0b'/></svg>");
  });
  serveur.on("/sw.js", HTTP_GET, []() {
    serveur.send(200, "application/javascript", "self.addEventListener('fetch',function(e){});");
  });
  serveur.onNotFound([]() {
    // Portail captif : en mode point d'accès, les sondes de connectivité du
    // téléphone (/generate_204, /hotspot-detect.html, /connecttest.txt…)
    // tombent ici et sont renvoyées vers la page de configuration, que le
    // système ouvre alors de lui-même.
    if (g_ap) {
      serveur.sendHeader("Location", "http://" + WiFi.softAPIP().toString() + "/", true);
      serveur.send(302, "text/plain", "");
      return;
    }
    serveur.send(404, "text/plain", "Page inconnue");
  });
  const char *entetes[] = { "X-Terrarium", "Authorization", "Cookie" };
  serveur.collectHeaders(entetes, 3);
  serveur.begin();

  // L'OTA réseau n'est démarrée QUE si elle est protégée. Sans mot de passe,
  // n'importe qui sur le réseau local peut réécrire le firmware d'un appareil
  // dont dépend un animal vivant — un simple invité du WiFi, une caméra
  // compromise. Il reste toujours un chemin pour la remettre en service sans
  // câble : /api/maj téléverse un firmware depuis le navigateur, protégé par
  // l'authentification de l'interface web.
  g_otaLancee = false;
  if (r.otaMotDePasse[0]) {
    ArduinoOTA.setHostname(g_id.c_str());
    ArduinoOTA.setPassword(r.otaMotDePasse);
    // Une mise à jour interrompue laisserait sinon un tapis alimenté sans
    // aucune régulation derrière.
    ArduinoOTA.onStart([]() {
      otaEnCours = true;
      ctrl.suspendre(true);
      journal("OTA demarree");
    });
    ArduinoOTA.onEnd([]() {
      otaEnCours = false;
      ctrl.suspendre(false);
      journal("OTA terminee");
    });
    ArduinoOTA.onError([](ota_error_t e) {
      otaEnCours = false;
      ctrl.suspendre(false);
      journal("OTA en echec (code %d)", (int)e);
    });
    ArduinoOTA.onProgress([](unsigned int, unsigned int) { esp_task_wdt_reset(); });
    ArduinoOTA.begin();
    g_otaLancee = true;
  } else {
    journal(
        "OTA reseau desactivee : aucun mot de passe. `motdepasse ota <mdp>` ou "
        "onglet Reseau pour l'activer. La mise a jour par le navigateur reste disponible.");
  }

  if (!g_ap) configTzTime(r.fuseau, r.ntp, "pool.ntp.org");
  g_servicesLances = true;
}

}  // namespace

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
    ouvrirPointAcces();
    journal("Point d'acces de configuration ouvert (SSID %s)", ssidPointAcces().c_str());
    lancerServices();
    return;
  }

  WiFi.mode(WIFI_STA);
  WiFi.setHostname(g_id.c_str());
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
      ouvrirPointAcces();
      journal("Connexion impossible : point d'acces de secours ouvert (SSID %s)", ssidPointAcces().c_str());
      lancerServices();
    }
  }

  if (g_servicesLances) {
    if (g_ap) g_dns.processNextRequest();
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

String nomHote() { return g_id + ".local"; }
String ssidConfiguration() { return ssidPointAcces(); }

void mettreAJour(const String &cible, char *erreur, size_t taille) { lancerMaj(cible, erreur, taille); }

// Improv Wi-Fi et commande « wifi » : on tente la connexion tout de suite, en
// gardant le point d'accès ouvert s'il l'était (AP+STA), pour pouvoir dire si
// les identifiants sont bons avant de les enregistrer.
bool essayerWifi(const char *ssid, const char *motDePasse, uint32_t delaiMs) {
  if (!ssid || !ssid[0]) return false;
  WiFi.mode(g_ap ? WIFI_AP_STA : WIFI_STA);
  WiFi.setHostname(g_id.c_str());
  WiFi.begin(ssid, motDePasse);
  const uint32_t debut = millis();
  while (millis() - debut < delaiMs) {
    esp_task_wdt_reset();
    const wl_status_t etat = WiFi.status();
    if (etat == WL_CONNECTED) {
      ReglagesReseau &r = Stockage::reseau();
      snprintf(r.ssid, sizeof r.ssid, "%s", ssid);
      snprintf(r.motDePasse, sizeof r.motDePasse, "%s", motDePasse ? motDePasse : "");
      Stockage::sauverReseau();
      journal("WiFi '%s' verifie et enregistre (adresse %s)", ssid, WiFi.localIP().toString().c_str());
      return true;
    }
    if (etat == WL_CONNECT_FAILED || etat == WL_NO_SSID_AVAIL) break;
    delay(100);
  }
  WiFi.disconnect(false, false);
  if (g_ap)
    WiFi.mode(WIFI_AP);
  else if (Stockage::reseau().ssid[0])
    WiFi.begin(Stockage::reseau().ssid, Stockage::reseau().motDePasse);
  return false;
}

void alerter(TypeNotif type, uint8_t zone, const String &texte) {
  const uint8_t iz = (zone < NB_ZONES) ? zone : NB_ZONES;
  const uint8_t it = (type <= NOTIF_INFO) ? (uint8_t)type : (uint8_t)NOTIF_INFO;
  const uint32_t maintenant = millis();
  // Un défaut ou un rétablissement passe toujours : ce sont les seuls messages
  // qu'on ne peut pas se permettre de perdre. Le reste est limité en cadence.
  const bool prioritaire = (type == NOTIF_DEFAUT || type == NOTIF_RETABLI);
  if (!prioritaire && g_derniereAlerte[iz][it] != 0 && maintenant - g_derniereAlerte[iz][it] < ANTISPAM_MS)
    return;
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

String sante() { return corpsSante(); }

bool effacerCoredump() {
#if AVEC_COREDUMP
  if (esp_core_dump_image_check() != ESP_OK) return false;
  return esp_core_dump_image_erase() == ESP_OK;
#else
  return false;
#endif
}

// Publication « sur changement » : chaque zone est republiée dès que ce qu'on
// affiche a bougé (température au vingtième de degré, consigne, demande, tapis,
// défaut…), au plus toutes les PERIODE_MQTT_MIN_MS ; et de toute façon toutes
// les PERIODE_MQTT_MAX_MS, pour que l'application sache que le socle vit. Sur
// un broker facturé au trafic, c'est cinq à dix fois moins de messages qu'une
// cadence fixe, et l'application réagit en deux secondes au lieu de vingt.
void publierMqtt(bool forcer) {
  if (!mqtt.connected()) return;
  static uint32_t empreintes[NB_ZONES] = { 0 };
  static uint32_t dernieres[NB_ZONES] = { 0 };
  const uint32_t maintenant = millis();
  const String base = sujetBase();
  for (uint8_t z = 0; z < NB_ZONES; z++) {
    const ZoneEtat &s = ctrl.zone[z];
    const bool chauffe = ctrl.tapisActif() >= 0 && ZONE_DE_TAPIS[ctrl.tapisActif()] == z;
    // Empreinte de ce qui est publié, arrondi comme à l'affichage.
    uint32_t e = 2166136261u;
    auto melanger = [&](uint32_t v) { e = (e ^ v) * 16777619u; };
    melanger((uint32_t)(int32_t)lroundf((isnan(s.temperature) ? -1000.0f : s.temperature) * 20));
    melanger((uint32_t)(int32_t)lroundf((isnan(s.consigneEff) ? -1000.0f : s.consigneEff) * 10));
    melanger((uint32_t)lroundf(s.demande * 50));
    melanger((uint32_t)lroundf(ctrl.duty(z) / 5));
    melanger((uint32_t)(chauffe ? 1 : 0) | ((uint32_t)s.defaut << 1) | ((uint32_t)s.autotune << 5) |
             ((uint32_t)(s.deriveActive ? 1 : 0) << 8));
    melanger((uint32_t)lroundf(ctrl.cfg[z].consigneJour * 10) ^
             ((uint32_t)lroundf(ctrl.cfg[z].consigneNuit * 10) << 16));
    const bool change = e != empreintes[z];
    const uint32_t depuis = maintenant - dernieres[z];
    if (!forcer && !(change && depuis >= PERIODE_MQTT_MIN_MS) && depuis < PERIODE_MQTT_MAX_MS &&
        dernieres[z] != 0)
      continue;
    empreintes[z] = e;
    dernieres[z] = maintenant ? maintenant : 1;
    String j = "{\"temp\":" + String(isnan(s.temperature) ? 0.0f : s.temperature, 2);
    j += ",\"consigne\":" + String(isnan(s.consigneEff) ? ctrl.cfg[z].consigneJour : s.consigneEff, 2);
    j += ",\"demande\":" + String((int)lroundf(s.demande * 100));
    j += ",\"charge\":" + String((int)lroundf(ctrl.duty(z)));
    j += ",\"chauffe\":\"" + String(chauffe ? "1" : "0") + "\"";
    j += ",\"defaut\":\"" + String(s.defaut != DEF_AUCUN ? "1" : "0") + "\"";
    j += ",\"defaut_libelle\":\"" + String(nomDefaut(s.defaut)) + "\"";
    j += ",\"jour\":" + String(ctrl.cfg[z].consigneJour, 1);
    j += ",\"nuit\":" + String(ctrl.cfg[z].consigneNuit, 1) + "}";
    mqtt.publish((base + "/zone" + String(z + 1) + "/etat").c_str(), j.c_str(), true);
  }
}

}  // namespace Reseau
